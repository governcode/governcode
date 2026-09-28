// The .git guard. A sandboxed tool may write its project, and so its .git: a hook, a config key
// such as core.fsmonitor, an include, or git attributes could make git run a program later,
// OUTSIDE the sandbox, when the user runs git. Before a turn we record, byte for byte,
// everything in the repository that can make git run something; after the turn we put back
// whatever changed, except a short allowlist of harmless settings (branch tracking, remotes,
// author name), and read it all again to prove it. A guard that cannot restore or verify
// fails loudly: it never reports a clean repository it could not check (security review
// 2026-09-27: the old denylist missed includes, attributes and a replaced .git).
import { execFileSync } from "node:child_process";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// The only config keys a turn may add or change. Anything else that changed is reverted.
const SAFE = /^(branch\.[^\n]+\.(remote|merge|rebase|description|pushremote)|remote\.[^\n]+\.(url|pushurl|fetch)|user\.(name|email))$/i;

type Node = { kind: "file"; mode: number; body: Buffer } | { kind: "link"; target: string } | { kind: "dir" };
type Snap = Map<string, Node>;   // absolute path -> what was there (absent paths are not keys)

function git(project: string, args: string[]): string | null {
  try { return execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

function read(p: string): Node | null {
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return { kind: "link", target: readlinkSync(p) };
  if (st.isDirectory()) return { kind: "dir" };
  if (st.isFile()) return { kind: "file", mode: st.mode & 0o777, body: readFileSync(p) };
  return { kind: "file", mode: 0, body: Buffer.from(`<${st.mode.toString(8)}>`) };   // a FIFO or device: never equal
}

function same(a: Node | null | undefined, b: Node | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.mode === b.mode && a.body.equals(b.body);
  if (a.kind === "link" && b.kind === "link") return a.target === b.target;
  return true;
}

/** The config entries of a file, as "key=value" lines (NUL-separated, so values can't fake keys). */
function entries(file: string): string[] | null {
  try {
    return execFileSync("git", ["config", "--file", file, "--list", "-z"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString().split("\0").filter(Boolean).map((e) => { const i = e.indexOf("\n"); return i < 0 ? `${e}=` : `${e.slice(0, i)}=${e.slice(i + 1)}`; });
  } catch { return null; }
}

/** Only harmless keys differ between two config files' contents? */
function onlySafeChanges(before: Buffer | null, after: Buffer | null, scratch: string): boolean {
  const list = (body: Buffer | null): string[] | null => {
    if (!body) return [];
    const f = join(scratch, `cfg-${Math.random().toString(36).slice(2)}`);
    mkdirSync(scratch, { recursive: true });
    const fd = openSync(f, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeSync(fd, body); } finally { closeSync(fd); }
    try { return entries(f); } finally { rmSync(f, { force: true }); }
  };
  const a = list(before), b = list(after);
  if (!a || !b) return false;
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ca = count(a), cb = count(b);
  for (const x of new Set([...a, ...b])) {
    if ((ca.get(x) ?? 0) !== (cb.get(x) ?? 0) && !SAFE.test(x.slice(0, x.indexOf("=")))) return false;
  }
  return true;
}

/** Everything that decides what git runs: .git itself, config files, attributes, hooks and
 *  project-local include targets and hook folders. */
function watchedPaths(project: string, common: string, gitdir: string): { files: string[]; dirs: string[] } {
  const files = [join(project, ".git"), join(common, "config"), join(gitdir, "config.worktree"), join(common, "info", "attributes")];
  const dirs = [join(common, "hooks")];
  for (const cfg of [join(common, "config"), join(gitdir, "config.worktree")]) {
    for (const e of entries(cfg) ?? []) {
      const i = e.indexOf("="), k = e.slice(0, i).toLowerCase(), v = e.slice(i + 1);
      if (!v) continue;
      const abs = isAbsolute(v) ? v : resolve(dirname(cfg), v);
      if (k === "include.path" || (k.startsWith("includeif.") && k.endsWith(".path")) || k === "core.attributesfile") files.push(abs);
      if (k === "core.hookspath") dirs.push(isAbsolute(v) ? v : resolve(project, v));
    }
  }
  return { files, dirs };
}

// The names git runs from a hooks folder. In .git/hooks every entry is watched; in a hooks
// folder inside the project (core.hooksPath) only these, so ordinary project files are never
// touched.
const HOOKS = new Set(["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push",
  "pre-receive", "update", "proc-receive", "post-receive", "post-update", "reference-transaction",
  "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change"]);

type Watch = { files: string[]; dirs: string[]; ownDir: string };

/** What is there now, for exactly the paths chosen before the turn (a turn's new include or
 *  hooksPath is not followed: it is reverted with the config change that added it). */
function snap(w: Watch): Snap {
  const out: Snap = new Map();
  for (const f of w.files) { const n = read(f); if (n) out.set(f, n); }
  for (const d of w.dirs) {
    const n = read(d);
    if (!n) continue;
    out.set(d, n);
    if (n.kind !== "dir") continue;
    for (const name of readdirSync(d)) {
      if (d !== w.ownDir && !HOOKS.has(name)) continue;
      const c = read(join(d, name));
      if (c) out.set(join(d, name), c);
    }
  }
  return out;
}

/** Puts `node` at `p` without following any link at `p`: the old entry is removed first
 *  (a link is unlinked, never written through), a file is written to a temporary name and
 *  renamed into place. */
function put(p: string, node: Node | undefined): void {
  const now = read(p);
  if (node && same(now, node)) return;
  if (now) rmSync(p, { recursive: now.kind === "dir", force: true });
  if (!node) return;
  if (node.kind === "dir") { mkdirSync(p, { mode: 0o755 }); return; }
  if (node.kind === "link") { symlinkSync(node.target, p); return; }
  const tmp = `${p}.governcode-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, node.mode || 0o644);
  try { writeSync(fd, node.body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, p);
}

export function gitGuard(project: string, scratch: string): { restore(): string[] } | null {
  const common0 = git(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitdir0 = git(project, ["rev-parse", "--absolute-git-dir"]);
  if (!common0 || !gitdir0) return null;
  const common = common0, gitdir = gitdir0;
  const w: Watch = { ...watchedPaths(project, common, gitdir), ownDir: join(common, "hooks") };
  const before = snap(w);
  return {
    restore(): string[] {
      const changed: string[] = [];
      const now = snap(w);
      const label = (p: string) => relative(project, p) || p;
      // .git itself replaced (a gitfile or link pointing at another repository): put the
      // original back where it was, then check everything else against the original repo.
      const dotgit = join(project, ".git");
      if (!same(before.get(dotgit), now.get(dotgit))) {
        const was = before.get(dotgit);
        if (was?.kind === "dir") {
          const cur = read(dotgit);
          if (cur && cur.kind !== "dir") { put(dotgit, undefined); }
          if (!read(dotgit)) throw new Error("the project's .git folder was moved away during the turn; check the repository before running git");
        } else put(dotgit, was);
        changed.push(".git");
      }
      for (const p of new Set([...before.keys(), ...now.keys()])) {
        if (p === dotgit) continue;
        const was = before.get(p), is = now.get(p);
        if (same(was, is)) continue;
        const isConfig = p === join(common, "config") || p === join(gitdir, "config.worktree");
        if (isConfig && (!was || was.kind === "file") && (!is || is.kind === "file")
            && onlySafeChanges(was?.kind === "file" ? was.body : null, is?.kind === "file" ? is.body : null, scratch)) continue;
        changed.push(label(p));
      }
      // Restore: folders first (so their entries have somewhere to go), then everything else.
      const order = [...new Set([...before.keys(), ...now.keys()])].filter((p) => p !== dotgit && changed.includes(label(p)))
        .sort((a, b) => a.length - b.length);
      for (const p of order) put(p, before.get(p));
      // Verify: read it all again. Anything still different is a failure, never a clean report.
      const after = snap(w);
      const still = [...new Set([...before.keys(), ...after.keys()])].filter((p) =>
        changed.includes(label(p)) && !same(before.get(p), after.get(p)));
      if (still.length) throw new Error(`could not restore ${still.map(label).join(", ")}; check the repository before running git`);
      return changed;
    },
  };
}
