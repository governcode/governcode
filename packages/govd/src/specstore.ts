// A Spec's workspace, history and snapshots live in govd's own state directory, which no AI
// tool can reach: the Controller cannot plant symlinks in the Runner's workspace, edit its
// snapshots, or set git config that govd then runs (Rattle's delegation red-team). Every git
// call here uses a git directory govd created, plumbing that never runs filters, hooks or
// external diff drivers, and a config that turns off anything that could run a program.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
  unlinkSync, mkdtempSync } from "node:fs";
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

export function specPaths(stateDir: string, specId: string): SpecPaths {
  const root = join(stateDir, "specs", specId);
  return { root, work: join(root, "work"), gitDir: join(root, "git") };
}

/** Make the Runner's workspace: the project's committed HEAD, exported without filters. */
export function createWorkspace(projectPath: string, p: SpecPaths): void {
  mkdirSync(p.work, { recursive: true, mode: 0o700 });
  chmodSync(p.root, 0o700);
  execFileSync("git", ["init", "-q", "--bare", p.gitDir], { env: { ...process.env, ...ENV }, stdio: "ignore" });
  // `git archive` of HEAD reads objects only; tar format runs no configured program.
  const tar = execFileSync("git", [...SAFE, "-C", projectPath, "archive", "--format=tar", "HEAD"],
    { env: { ...process.env, ...ENV }, maxBuffer: 1024 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("tar", ["-x", "--no-same-owner", "--no-same-permissions", "-C", p.work], { input: tar });
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
    } else if (st.isFile()) {
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
    git(p.gitDir, ["update-index", "--add", "--index-info"], entries.join("\n") + (entries.length ? "\n" : ""), env);
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
  try {
    const out = execFileSync("git", [...SAFE, "-C", projectPath, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
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

/** Refuse any path that leaves the root or passes through a symlink. */
export function safeTarget(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split("/").some((c) => c === ".." || c === "")) throw new Error(`unsafe path ${rel}`);
  const target = resolve(root, rel);
  let cur = root;
  for (const part of relative(root, target).split(sep)) {
    cur = join(cur, part);
    if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) throw new Error(`${rel} passes through a symlink; refused`);
  }
  return target;
}

/**
 * Apply a reviewed Spec to the project: for each changed file, the project must still hold the
 * `before` content (or not exist where before had nothing); then it gets exactly the `after`
 * bytes. Symlinks are never written. Nothing is changed unless every file passes.
 */
export function applyToProject(p: SpecPaths, projectPath: string, before: string, after: string): string[] {
  const files = changedFiles(p, before, after);
  const plan: Array<{ path: string; target: string; to: Entry }> = [];
  const conflicts: string[] = [];
  for (const f of files) {
    const target = safeTarget(projectPath, f);
    const from = entryAt(p, before, f), to = entryAt(p, after, f);
    if (to?.mode === "120000" || from?.mode === "120000") throw new Error(`${f}: symlinks are not applied; review by hand`);
    const exists = existsSync(target);
    if (exists && !lstatSync(target).isFile()) { conflicts.push(`${f} (not a regular file in the project)`); continue; }
    const current = exists ? git(p.gitDir, ["hash-object", "--no-filters", "--stdin"], readFileSync(target)).toString().trim() : null;
    if ((from?.oid ?? null) !== current) { conflicts.push(f); continue; }
    plan.push({ path: f, target, to });
  }
  if (conflicts.length) throw new Error(`the project changed since this Spec started, so nothing was applied: ${conflicts.join(", ")}`);
  for (const { target, to } of plan) {
    if (!to) { unlinkSync(target); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git(p.gitDir, ["cat-file", "blob", to.oid]));
    chmodSync(target, to.mode === "100755" ? 0o755 : 0o644);
  }
  return files;
}

export function removeWorkspace(p: SpecPaths): void {
  rmSync(p.work, { recursive: true, force: true });
}
