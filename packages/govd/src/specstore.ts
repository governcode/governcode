// A Spec's workspace, history and snapshots live in govd's own state directory, which no AI
// tool can reach: the Controller cannot plant symlinks in the Runner's workspace, edit its
// snapshots, or set git config that govd then runs (a Grok red-team review of delegation). Every git
// call here uses a git directory govd created, plumbing that never runs filters, hooks or
// external diff drivers, and a config that turns off anything that could run a program.
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync,
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

// A new file that looks like a secret never reaches a Runner's copy (its provider sees the copy),
// whatever the rules below allow; nor does one holding a private key, whatever its name.
const SECRET_FILE = /(^|\/)(\.env.*|.*\.env|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|credentials(\.json)?|secrets?\.(ya?ml|json)|kubeconfig(\.ya?ml)?|.*(service.?account|client_secret).*\.json|id_(rsa|dsa|ecdsa|ed25519)\w*|.*\.(pem|key|p8|p12|pfx|jks|keystore|ppk|kdbx|tfvars|tfvars\.json|tfstate(\.backup)?))$|(^|\/)\.(ssh|aws|kube|docker|gnupg|terraform)\//i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Make the Runner's workspace from the project as the user has it now, so a Spec builds on what
 * they see: every file in the last commit, with the user's uncommitted edits (a file git is told
 * to skip or assume unchanged, which often holds local settings, as committed). A new file, one
 * not in the last commit (untracked and not ignored, or only staged), comes in only if `keepNew`
 * says so, never one that looks like a secret or holds a private key, and never one larger than
 * a snapshot takes. Read without following any link (see copyIn); a file that cannot be read that
 * way is skipped. Returns the new files left out and the files skipped. A project over
 * MAX_COPY_BYTES or MAX_COPY_FILES is refused, never cut short. Only `ls-files`, `ls-tree` and
 * `cat-file` run on the project, with every program-running option off and a time limit.
 */
export function createWorkspace(projectPath: string, p: SpecPaths, keepNew: (rel: string) => boolean = () => false): { left: string[]; skipped: string[] } {
  mkdirSync(p.work, { recursive: true, mode: 0o700 });
  chmodSync(p.root, 0o700);
  execFileSync("git", ["init", "-q", "--bare", p.gitDir], { env: { ...process.env, ...ENV }, stdio: "ignore" });
  if (lstatSync(projectPath).isSymbolicLink()) throw new Error(`the project folder ${projectPath} is now a symlink; refused`);
  const index = listFiles(projectPath, ["-v", "--cached"]), fresh = listFiles(projectPath, ["--others", "--exclude-standard"]);
  if (!index || !fresh) throw new Error("git could not list the project's files");
  const head = headEntries(projectPath);
  const root = realpathSync(projectPath);
  const rootFd = openSync(root, DIR);
  const left: string[] = [], skipped: string[] = [];
  const budget = { bytes: 0, files: 0 };
  try {
    const copy = (rel: string, maxSize?: number, noKeys?: boolean) => {
      const r = rel.includes("\uFFFD") ? "skipped" : copyIn(rootFd, root, p.work, rel, budget, maxSize, noKeys);   // a name that is not UTF-8
      if (r === "skipped") skipped.push(rel);
      return r;
    };
    const addNew = (rel: string) => {
      if (keepNew(rel) && !SECRET_FILE.test(rel) && copy(rel, MAX_SNAPSHOT_FILE, true) === "copied") return;
      if (lstatOrNull(join(root, rel)) && !skipped.includes(rel)) left.push(rel);
    };
    const seen = new Set<string>();
    for (const line of index) {
      const tag = line[0], rel = line.slice(2);
      if (seen.has(rel)) continue;
      seen.add(rel);
      const committed = head.get(rel);
      if (!committed) addNew(rel);
      // (one a sparse checkout leaves out is not on disk: left out here too)
      else if (tag === "S" || tag !== tag.toUpperCase()) { if (lstatOrNull(join(root, rel)) && !fromHead(root, p.work, rel, committed, budget)) skipped.push(rel); }
      else copy(rel);
    }
    for (const rel of fresh) if (!seen.has(rel)) addNew(rel);
  } finally { closeSync(rootFd); }
  return { left, skipped };
}

// A Spec's copy is refused above this, never cut short (git archive held at most 1 GB before).
const MAX_COPY_BYTES = 2 * 1024 ** 3, MAX_COPY_FILES = 200_000;
function spend(budget: { bytes: number; files: number }, bytes: number): void {
  budget.bytes += bytes; budget.files++;
  if (budget.bytes > MAX_COPY_BYTES || budget.files > MAX_COPY_FILES) throw new Error("the project is too large for a Spec's copy (over 2 GB or 200,000 files)");
}
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NOCTTY;
const GIT_LIMIT = { timeout: 120_000, killSignal: "SIGKILL" as const };   // a FIFO a Controller planted at .gitignore must not hang govd

/** Whether the project has a commit yet. */
export function hasCommit(projectPath: string): boolean {
  try { execFileSync("git", [...SAFE, "-C", projectPath, "rev-parse", "--verify", "-q", "HEAD"], { env: { ...process.env, ...ENV }, stdio: "ignore", ...GIT_LIMIT }); return true; }
  catch { return false; }
}

/** The last commit's files and their modes (none before the first commit). */
function headEntries(projectPath: string): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const out = execFileSync("git", [...SAFE, "-C", projectPath, "ls-tree", "-r", "-z", "HEAD"],
      { env: { ...process.env, ...ENV }, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...GIT_LIMIT }).toString();
    for (const rec of out.split("\0")) { const t = rec.indexOf("\t"); if (t > 0) m.set(rec.slice(t + 1), rec.slice(0, t).split(" ")[0]); }
  } catch { /* no commit yet */ }
  return m;
}

/** A file as the last commit has it, read from git's objects (no filter runs). False if it could not be. */
function fromHead(projectPath: string, work: string, rel: string, mode: string, budget: { bytes: number; files: number }): boolean {
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") return true;   // a submodule: nothing to copy
  try {
    const dest = safeTarget(work, rel);
    const blob = execFileSync("git", [...SAFE, "-C", projectPath, "cat-file", "blob", `HEAD:${rel}`],
      { env: { ...process.env, ...ENV }, maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...GIT_LIMIT });
    spend(budget, blob.length);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    if (mode === "120000") { symlinkSync(blob.toString(), dest); return true; }
    const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { for (let off = 0; off < blob.length;) off += writeSync(fd, blob, off, blob.length - off); fchmodSync(fd, mode === "100755" ? 0o755 : 0o644); } finally { closeSync(fd); }
    return true;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("the project is too large")) throw e;
    return false;
  }
}

/**
 * One project file into the workspace. Never through a link: its folder is opened one folder at a
 * time from the project's root, each step relative to the last through /proc/self/fd with
 * O_NOFOLLOW (a folder swapped for a link meanwhile fails, it is never followed), and the file
 * itself is opened O_NOFOLLOW, non-blocking, never as a terminal; a link is copied as a link.
 * Only a regular file is read, at most the size it had when checked (a file still growing does
 * not run on), and it must still be the file at that path in the real project folder. "absent":
 * not there (deleted, or not a file or link); "skipped": there, but not safely readable or over
 * `maxSize`, or holding a private key when `noKeys`.
 * ponytail: Linux only (/proc); macOS needs openat through another route. This relies on Landlock's
 * REFER rule too: a sandboxed tool cannot hard-link a file it may not read into the project.
 */
function copyIn(rootFd: number, root: string, work: string, rel: string, budget: { bytes: number; files: number }, maxSize = Infinity, noKeys = false): "copied" | "absent" | "skipped" {
  const parts = rel.split("/");
  if (parts.some((c) => c === "" || c === "." || c === "..")) return "skipped";
  let dirFd = rootFd, fd: number | null = null;
  try {
    for (const name of parts.slice(0, -1)) { const next = openSync(`/proc/self/fd/${dirFd}/${name}`, DIR); if (dirFd !== rootFd) closeSync(dirFd); dirFd = next; }
    const at = `/proc/self/fd/${dirFd}/${parts[parts.length - 1]}`;
    const st = lstatOrNull(at);
    if (!st || !(st.isSymbolicLink() || st.isFile())) return "absent";
    const dest = safeTarget(work, rel);
    if (st.isSymbolicLink()) {
      const text = readlinkSync(at);
      spend(budget, text.length);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      symlinkSync(text, dest);
      return "copied";
    }
    fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
    const f = fstatSync(fd);
    if (!f.isFile() || f.size > maxSize || readlinkSync(`/proc/self/fd/${fd}`) !== join(root, rel)) return "skipped";
    spend(budget, f.size);
    const buf = Buffer.allocUnsafe(1 << 20);
    let rest = f.size, n = readSync(fd, buf, 0, Math.min(buf.length, rest), null);
    if (noKeys && PRIVATE_KEY.test(buf.subarray(0, n).toString("latin1"))) return "skipped";
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const out = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      for (; n > 0; rest -= n, n = rest > 0 ? readSync(fd, buf, 0, Math.min(buf.length, rest), null) : 0) for (let off = 0; off < n;) off += writeSync(out, buf, off, n - off);
      fchmodSync(out, f.mode & 0o111 ? 0o755 : 0o644);
    } finally { closeSync(out); }
    return "copied";
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("the project is too large")) throw e;
    return "skipped";
  } finally {
    if (fd !== null) closeSync(fd);
    if (dirFd !== rootFd) closeSync(dirFd);
  }
}

/** A regular file's bytes, or null: never through a link at its end, never blocking on a FIFO or
 *  opening a terminal, and at most the size it had when opened. */
function readRegular(path: string): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    for (let n; got < buf.length && (n = readSync(fd, buf, got, buf.length - got, null)) > 0;) got += n;
    return buf.subarray(0, got);
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
      const data = readRegular(full);
      if (!data) return;
      const oid = git(p.gitDir, ["hash-object", "-w", "--no-filters", "--stdin"], data).toString().trim();
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

// The user's own global ignore file, which git would read from their config (left out with the
// rest of it here): only its path is taken, and only a regular file (a FIFO would hang git).
function globalExcludes(): string[] {
  try {
    const f = execFileSync("git", ["config", "--global", "--get", "--path", "core.excludesFile"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return f && statSync(f).isFile() ? ["-c", `core.excludesFile=${f}`] : [];
  } catch { return []; }
}

function listFiles(projectPath: string, which: string[]): string[] | null {
  try {
    const out = execFileSync("git", [...SAFE, ...globalExcludes(), "-C", projectPath, "ls-files", "-z", ...which],
      { env: { ...process.env, ...ENV }, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], ...GIT_LIMIT }).toString();
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
    const data = readRegular(target);
    if (!data) return undefined;            // swapped for one since
    const oid = git(p.gitDir, ["hash-object", "--no-filters", "--stdin"], data).toString().trim();
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
