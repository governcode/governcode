// A Spec's workspace, history and snapshots live in govd's own state directory, which no AI
// tool can reach: the Controller cannot plant symlinks in the Runner's workspace, edit its
// snapshots, or set git config that govd then runs (a Grok red-team review of delegation). Every git
// call here uses a git directory govd created, plumbing that never runs filters, hooks or
// external diff drivers, and a config that turns off anything that could run a program.
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, mkdtempSync, writeSync } from "node:fs";
import { join, relative, resolve, sep, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

// Anything in any config that could make git run a program is switched off for our calls.
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=",
  "-c", "core.pager=cat", "-c", "core.sshCommand=false", "-c", "core.askPass=", "-c", "credential.helper=",
  "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", "-c", "safe.directory=*"];
const ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(gitDir: string, args: string[], input?: string | Buffer, extraEnv: Record<string, string> = {}): Buffer {
  return execFileSync("git", [...SAFE, `--git-dir=${gitDir}`, ...args], { input, env: { ...process.env, ...ENV, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
}

export type SpecPaths = { root: string; work: string; gitDir: string };

// ponytail: files over 100 MB are left out of snapshots (not diffed, not undone). Raise, or
// stream them, when a real project needs it.
const MAX_SNAPSHOT_FILE = 100 * 1024 * 1024;

export function specPaths(stateDir: string, specId: string): SpecPaths {
  const root = join(stateDir, "specs", specId);
  return { root, work: join(root, "work"), gitDir: join(root, "git") };
}

// New files the user has not committed that look like secrets stay out of a Runner's copy (its
// provider sees the copy); files git tracks are already in the project's history.
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$|\.(pem|key|p12|pfx|jks|keystore)$/i;

/** Make the Runner's workspace: the project as the user has it now, so a Spec builds on what they
 *  see (uncommitted changes and accepted Specs included): what git tracks, plus new files it does
 *  not ignore. Read without following any link: a link is copied as a link (as `git archive`
 *  would), and a path through one, or anything but a file, is left out. No git program runs on the
 *  project but `ls-files`, with every program-running option off. */
export function createWorkspace(projectPath: string, p: SpecPaths): void {
  mkdirSync(p.work, { recursive: true, mode: 0o700 });
  chmodSync(p.root, 0o700);
  execFileSync("git", ["init", "-q", "--bare", p.gitDir], { env: { ...process.env, ...ENV }, stdio: "ignore" });
  const tracked = listFiles(projectPath, ["--cached"]), fresh = listFiles(projectPath, ["--others", "--exclude-standard"]);
  if (!tracked || !fresh) throw new Error("git could not list the project's files");
  const root = realpathSync(projectPath);
  const known = new Set(tracked);
  for (const rel of tracked) copyIn(projectPath, root, p.work, rel);
  // New files are left out, too, when larger than a snapshot takes (they could not be reviewed).
  for (const rel of fresh) if (!SECRET_FILE.test(rel) && !known.has(rel)) copyIn(projectPath, root, p.work, rel, MAX_SNAPSHOT_FILE);
}

/** One project file into the workspace, or nothing: never through a link, never anything but a
 *  file or a link (a FIFO could block, a device never end), skipped if it is gone. The file opened
 *  must be the one at that path in the real project folder (/proc/self/fd), so a folder swapped
 *  for a link meanwhile cannot bring in a file from elsewhere.
 *  ponytail: Linux only (/proc); macOS needs F_GETPATH. */
function copyIn(projectPath: string, root: string, work: string, rel: string, maxSize = Infinity): void {
  const src = join(projectPath, rel), dir = dirname(rel);
  try {
    if (dir === ".") { if (lstatSync(projectPath).isSymbolicLink()) return; }
    else safeTarget(projectPath, dir);
  } catch { return; }
  const st = lstatOrNull(src);
  if (!st || !(st.isSymbolicLink() || (st.isFile() && st.size <= maxSize))) return;
  let dest: string;
  try { dest = safeTarget(work, rel); } catch { return; }   // under a link copied a moment ago
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(src), dest); return; }
  let fd: number;
  try { fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return; }   // a link by now
  try {
    const f = fstatSync(fd);
    if (!f.isFile() || f.size > maxSize || readlinkSync(`/proc/self/fd/${fd}`) !== join(root, rel)) return;
    const out = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) for (let off = 0; off < n;) off += writeSync(out, buf, off, n - off);
      fchmodSync(out, f.mode & 0o111 ? 0o755 : 0o644);
    } finally { closeSync(out); }
  } finally { closeSync(fd); }
}

/** Snapshot a directory as a commit in the spec's own git dir, hashing raw bytes (no filters). */
export function snapshot(p: SpecPaths, label: string, parent?: string | null, only?: string[]): string {
  const entries: string[] = [];
  const add = (full: string) => {
    const rel = relative(p.work, full).split(sep).join("/");
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      const oid = git(p.gitDir, ["hash-object", "-w", "--stdin"], readlinkSync(full)).toString().trim();
      entries.push(`120000 ${oid}\t${rel}`);
    } else if (st.isFile() && st.size <= MAX_SNAPSHOT_FILE) {
      // Regular files only (never a FIFO or device, which could block or never end), and
      // not huge ones, which would be read whole into memory.
      const oid = git(p.gitDir, ["hash-object", "-w", "--no-filters", "--stdin"], readFileSync(full)).toString().trim();
      entries.push(`${st.mode & 0o111 ? "100755" : "100644"} ${oid}\t${rel}`);
    }
  };
  if (only) {
    for (const rel of only) { const full = join(p.work, rel); if (lstatExists(full)) add(full); }
  }
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const full = join(dir, name);
      if (lstatSync(full).isDirectory()) walk(full); else add(full);
    }
  };
  if (!only) walk(p.work);
  const tmp = mkdtempSync(join(tmpdir(), "governcode-idx-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    // NUL-separated: a file name may contain a newline, which must never read as a second
    // record (security review 2026-09-27).
    git(p.gitDir, ["update-index", "-z", "--add", "--index-info"], entries.map((e) => e + "\0").join(""), env);
    const tree = git(p.gitDir, ["write-tree"], undefined, env).toString().trim();
    const idEnv = { GIT_AUTHOR_NAME: "governcode", GIT_AUTHOR_EMAIL: "governcode@localhost", GIT_COMMITTER_NAME: "governcode", GIT_COMMITTER_EMAIL: "governcode@localhost" };
    const commit = git(p.gitDir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", label], undefined, idEnv).toString().trim();
    git(p.gitDir, ["update-ref", `refs/${label}`, commit]);
    return commit;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function lstatExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

/**
 * The files of a project worth snapshotting: what git tracks plus untracked files it does not
 * ignore, listed by git with every program-running option off. Null if not a git project.
 */
export function projectFiles(projectPath: string): string[] | null {
  return listFiles(projectPath, ["--cached", "--others", "--exclude-standard"]);
}

function listFiles(projectPath: string, which: string[]): string[] | null {
  try {
    const out = execFileSync("git", [...SAFE, "-C", projectPath, "ls-files", "-z", ...which],
      { env: { ...process.env, ...ENV }, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString();
    return [...new Set(out.split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

/** The per-project store for Controller turn Checkpoints (in govd's state, like Specs). */
export function turnStore(stateDir: string, project: string, projectPath: string): SpecPaths {
  const root = join(stateDir, "turns", project);
  const gitDir = join(root, "git");
  if (!existsSync(gitDir)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    execFileSync("git", ["init", "-q", "--bare", gitDir], { env: { ...process.env, ...ENV }, stdio: "ignore" });
  }
  return { root, work: projectPath, gitDir };
}

export function changedFiles(p: SpecPaths, before: string, after: string): string[] {
  return git(p.gitDir, ["diff", "--name-only", "--no-renames", "-z", before, after]).toString().split("\0").filter(Boolean);
}

/** The review diff: exactly the bytes between the two stored snapshots. */
export function diff(p: SpecPaths, before: string, after: string): string {
  return git(p.gitDir, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", before, after]).toString();
}

type Entry = { mode: string; oid: string } | null;
function entryAt(p: SpecPaths, commit: string, path: string): Entry {
  const out = git(p.gitDir, ["ls-tree", "-z", commit, "--", path]).toString();
  const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(out);
  return m ? { mode: m[1], oid: m[2] } : null;
}

/** Refuse any path that leaves the root or passes through a symlink, dangling ones included. */
export function safeTarget(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split("/").some((c) => c === ".." || c === "")) throw new Error(`unsafe path ${rel}`);
  if (lstatSync(root).isSymbolicLink()) throw new Error(`the project folder ${root} is now a symlink; refused`);
  const target = resolve(root, rel);
  let cur = root;
  for (const part of relative(root, target).split(sep)) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (!st) break;                          // nothing further down exists yet
    if (st.isSymbolicLink()) throw new Error(`${rel} passes through a symlink; refused`);
  }
  return target;
}

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * Apply a reviewed Spec to the project: for each changed file, the project must still hold the
 * `before` content (or not exist where before had nothing); then it gets exactly the `after`
 * bytes. Symlinks are never written or followed. Every new file is staged first and the
 * project re-checked, so a change that lands meanwhile stops the whole apply, not half of it.
 */
export function applyToProject(p: SpecPaths, projectPath: string, before: string, after: string, since = "this Spec started"): string[] {
  const files = changedFiles(p, before, after);
  const plan: Array<{ path: string; target: string; from: Entry; to: Entry; staged?: string }> = [];
  const conflicts: string[] = [];
  // Content AND the executable bit: a permission change made since is an edit too, and
  // must stop the apply rather than be reset (security review 2026-09-27).
  const current = (target: string): string | null | undefined => {
    const st = lstatOrNull(target);
    if (!st) return null;
    if (!st.isFile()) return undefined;      // a symlink, folder or device: never overwritten
    const oid = git(p.gitDir, ["hash-object", "--no-filters", "--stdin"], readFileSync(target)).toString().trim();
    return `${st.mode & 0o111 ? "100755" : "100644"} ${oid}`;
  };
  const was = (e: Entry): string | null => (e ? `${e.mode} ${e.oid}` : null);
  for (const f of files) {
    const target = safeTarget(projectPath, f);
    const from = entryAt(p, before, f), to = entryAt(p, after, f);
    if (to?.mode === "120000" || from?.mode === "120000") throw new Error(`${f}: symlinks are not applied; review by hand`);
    const now = current(target);
    if (now === undefined) { conflicts.push(`${f} (not a regular file in the project)`); continue; }
    if (was(from) !== now) { conflicts.push(f); continue; }
    plan.push({ path: f, target, from, to });
  }
  if (conflicts.length) throw new Error(`the project changed since ${since}, so nothing was applied: ${conflicts.join(", ")}`);
  try {
    for (const item of plan) {
      if (!item.to) continue;
      safeTarget(projectPath, item.path);
      mkdirSync(dirname(item.target), { recursive: true });
      safeTarget(projectPath, item.path);   // mkdir must not have gone through a link planted meanwhile
      const staged = `${item.target}.governcode-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, item.to.mode === "100755" ? 0o755 : 0o644);
      item.staged = staged;
      try {
        writeSync(fd, git(p.gitDir, ["cat-file", "blob", item.to.oid]));
        fchmodSync(fd, item.to.mode === "100755" ? 0o755 : 0o644);   // exactly, whatever the umask
      } finally { closeSync(fd); }
    }
    const moved = plan.filter((item) => safeTargetOk(projectPath, item.path) && was(item.from) !== current(item.target)).map((item) => item.path);
    if (moved.length) throw new Error(`the project changed while applying, so nothing was applied: ${moved.join(", ")}`);
    for (const item of plan) {
      if (item.staged) renameSync(item.staged, item.target);   // replaces, never follows
      else unlinkSync(item.target);                            // removes a link itself, never its target
      item.staged = undefined;
    }
  } finally {
    for (const item of plan) if (item.staged) rmSync(item.staged, { force: true });
  }
  return files;
}

function safeTargetOk(root: string, rel: string): boolean {
  safeTarget(root, rel);   // throws on a link planted since the plan
  return true;
}

export function removeWorkspace(p: SpecPaths): void {
  rmSync(p.work, { recursive: true, force: true });
}
