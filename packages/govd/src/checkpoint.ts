// Checkpoints: the whole working tree (tracked + untracked, .gitignore respected) recorded as
// a commit under refs/governcode/specs/<spec>/{before,after}, through a throwaway index, so
// the user's index, branch, stashes and files are never touched. Undo restores the files and
// refuses if anything changed after the Spec ended; redo reverses an undo.
// ponytail: refs are never pruned. Upgrade when `git for-each-ref refs/governcode` gets slow.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const PREFIX = "refs/governcode/specs";
const IDENTITY = { GIT_AUTHOR_NAME: "governcode", GIT_AUTHOR_EMAIL: "governcode@localhost",
  GIT_COMMITTER_NAME: "governcode", GIT_COMMITTER_EMAIL: "governcode@localhost" };

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
}

export function toplevel(cwd: string): string | null {
  try { return git(cwd, ["rev-parse", "--show-toplevel"]) || null; } catch { return null; }
}

/** The working tree as a tree object, via a copy of the real index (only changes rehash). */
function tree(root: string): string {
  let index = git(root, ["rev-parse", "--git-path", "index"]);
  if (!isAbsolute(index)) index = join(root, index);
  const tmp = mkdtempSync(join(tmpdir(), "governcode-index-"));
  try {
    const scratch = join(tmp, "index");
    if (existsSync(index)) copyFileSync(index, scratch);
    git(root, ["add", "-A"], { GIT_INDEX_FILE: scratch });
    return git(root, ["write-tree"], { GIT_INDEX_FILE: scratch });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Record the tree as refs/governcode/specs/<spec>/<label>; the commit id, or null outside git. */
export function take(cwd: string, spec: string, label: "before" | "after"): string | null {
  const root = toplevel(cwd);
  if (!root) return null;
  try {
    const t = tree(root);
    let head = "";
    try { head = git(root, ["rev-parse", "-q", "--verify", "HEAD"]); } catch { /* unborn branch */ }
    const commit = git(root, ["commit-tree", t, ...(head ? ["-p", head] : []), "-m", `governcode ${spec} ${label}`], IDENTITY);
    git(root, ["update-ref", `${PREFIX}/${spec}/${label}`, commit]);
    return commit;
  } catch {
    return null;
  }
}

export function changed(cwd: string, a: string, b: string): string[] {
  return git(cwd, ["diff", "--name-only", "--no-renames", a, b]).split("\n").filter(Boolean);
}

export function diff(cwd: string, spec: string): string {
  return git(cwd, ["diff", `${PREFIX}/${spec}/before`, `${PREFIX}/${spec}/after`]);
}

const ref = (root: string, spec: string, label: string) => git(root, ["rev-parse", "--verify", `${PREFIX}/${spec}/${label}^{commit}`]);
const treeOf = (root: string, commit: string) => git(root, ["rev-parse", `${commit}^{tree}`]);

/** Make the files match `source` for every path that differs from `current`. */
function restore(root: string, source: string, current: string): string[] {
  const paths = changed(root, current, source);
  const present = new Set(git(root, ["ls-tree", "-r", "--name-only", source]).split("\n").filter(Boolean));
  const keep = paths.filter((p) => present.has(p));
  if (keep.length) git(root, ["restore", `--source=${source}`, "--worktree", "--", ...keep]);
  for (const p of paths) {
    if (present.has(p)) continue;
    const target = join(root, p);
    try { if (lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) unlinkSync(target); } catch { /* already gone */ }
  }
  return paths;
}

export function undo(cwd: string, spec: string): string[] {
  const root = toplevel(cwd);
  if (!root) throw new Error("not inside a git work tree");
  const before = ref(root, spec, "before"), after = ref(root, spec, "after");
  if (tree(root) !== treeOf(root, after)) throw new Error(`files changed after ${spec} ended; undo refused (see gov diff ${spec})`);
  return restore(root, before, after);
}

export function redo(cwd: string, spec: string): string[] {
  const root = toplevel(cwd);
  if (!root) throw new Error("not inside a git work tree");
  const before = ref(root, spec, "before"), after = ref(root, spec, "after");
  if (tree(root) !== treeOf(root, before)) throw new Error(`files are not at ${spec}'s starting point; redo refused`);
  return restore(root, after, before);
}
