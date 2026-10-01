// Fixes from the phase-0 red-team: .git guard, project paths, the tool's environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync, renameSync, rmSync, lstatSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { gitGuard } from "../src/gitguard.ts";
import { toolEnv, claudePolicy, toolchainDirs, claudeRunHome } from "../src/claude.ts";
import { codexPolicy } from "../src/codex.ts";
import { Daemon } from "../src/daemon.ts";
import { scratch, markConnected } from "./scratch.ts";

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

test("git guard: hooks and config a turn changed are put back exactly; harmless settings stay", () => {
  const dir = scratch("gc-guard-");
  git(dir, "init", "-q");
  git(dir, "config", "core.pager", "less");                 // the user's own, before the turn
  writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\necho mine\n");
  const guard = gitGuard(dir, join(dir, "..", "scratch-guard"))!;
  // what a tool might do during the turn:
  writeFileSync(join(dir, ".git/hooks/post-checkout"), "#!/bin/sh\nexfiltrate\n");
  writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nevil\n");
  git(dir, "config", "core.fsmonitor", "./run-me");
  git(dir, "config", "core.pager", "./also-me");
  const changed = guard.restore().sort();
  assert.deepEqual(changed, [".git/config", ".git/hooks/post-checkout", ".git/hooks/pre-commit"]);
  assert.ok(!existsSync(join(dir, ".git/hooks/post-checkout")));
  assert.equal(readFileSync(join(dir, ".git/hooks/pre-commit"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(git(dir, "config", "core.pager"), "less");
  assert.throws(() => git(dir, "config", "core.fsmonitor"));
  // Only harmless keys changed (branch tracking, author): left as the turn made them.
  const g2 = gitGuard(dir, join(dir, "..", "scratch-guard"))!;
  git(dir, "config", "user.name", "harmless");
  git(dir, "config", "branch.main.remote", "origin");
  assert.deepEqual(g2.restore(), []);
  assert.equal(git(dir, "config", "user.name"), "harmless");
});

test("git guard (security review): a lock file, a replaced .git, include targets, planted links, attributes", () => {
  // A config.lock no longer makes the clean-up fail quietly: the file is replaced directly.
  const a = scratch("gc-guard-lock-");
  git(a, "init", "-q");
  const ga = gitGuard(a, join(a, "..", "s"))!;
  git(a, "config", "core.fsmonitor", "./evil");
  writeFileSync(join(a, ".git/config.lock"), "");
  ga.restore();
  assert.throws(() => git(a, "config", "core.fsmonitor"));

  // .git replaced by a gitfile pointing at a repository the tool built: put back.
  const b = scratch("gc-guard-gitfile-");
  git(b, "init", "-q");
  const gb = gitGuard(b, join(b, "..", "s"))!;
  renameSync(join(b, ".git"), join(b, "moved"));
  git(b, "init", "-q", "--separate-git-dir", join(b, "evil-repo"));
  assert.throws(() => gb.restore(), /moved away/);

  // An existing include inside the project, edited to add a program: its bytes are restored.
  const c = scratch("gc-guard-include-");
  git(c, "init", "-q");
  writeFileSync(join(c, "team.gitconfig"), "[user]\n\tname = team\n");
  git(c, "config", "include.path", "../team.gitconfig");
  const gc = gitGuard(c, join(c, "..", "s"))!;
  writeFileSync(join(c, "team.gitconfig"), "[core]\n\tfsmonitor = ./evil\n");
  assert.ok(gc.restore().includes("team.gitconfig"));
  assert.equal(readFileSync(join(c, "team.gitconfig"), "utf8"), "[user]\n\tname = team\n");

  // A hook replaced by a link to a file outside: the link is removed, never written through.
  const d = scratch("gc-guard-link-");
  git(d, "init", "-q");
  writeFileSync(join(d, ".git/hooks/pre-commit"), "#!/bin/sh\necho mine\n");
  const outside = join(d, "..", `outside-${Date.now()}.txt`);
  writeFileSync(outside, "untouched");
  const gd = gitGuard(d, join(d, "..", "s"))!;
  rmSync(join(d, ".git/hooks/pre-commit"));
  symlinkSync(outside, join(d, ".git/hooks/pre-commit"));
  gd.restore();
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  assert.ok(!lstatSync(join(d, ".git/hooks/pre-commit")).isSymbolicLink());

  // Attributes, and a new include aimed at an ordinary project file: the config change is
  // reverted, and the project file is left alone (never deleted).
  const e = scratch("gc-guard-attr-");
  git(e, "init", "-q");
  writeFileSync(join(e, "notes.md"), "mine");
  const ge = gitGuard(e, join(e, "..", "s"))!;
  mkdirSync(join(e, ".git/info"), { recursive: true });
  writeFileSync(join(e, ".git/info/attributes"), "* filter=evil\n");
  git(e, "config", "include.path", "../notes.md");
  const changed = ge.restore();
  assert.ok(changed.includes(".git/info/attributes") && changed.includes(".git/config"), changed.join());
  assert.ok(!existsSync(join(e, ".git/info/attributes")));
  assert.equal(readFileSync(join(e, "notes.md"), "utf8"), "mine");
});

test("project paths: home, dot-folders, govd's own dirs and symlinks to them are refused", async () => {
  const root = scratch("gc-paths-");
  const d = new Daemon({ socketPath: join(root, "run/govd.sock"), ledgerPath: join(root, "state/trace.sqlite"),
    policyDir: join(root, "state/p"), homeDir: join(root, "state/home"), supervisor: "/bin/false", version: "t" });
  markConnected(d);
  const call = (d as any).call.bind(d);
  for (const path of [homedir(), join(homedir(), ".ssh"), join(root, "state"), join(root, "run"), "/"]) {
    await assert.rejects(call("project.open", { path }, () => {}, null), /cannot be a project|not a folder/, path);
  }
  mkdirSync(join(root, "run"), { recursive: true });
  symlinkSync(join(root, "run"), join(root, "innocent"));
  await assert.rejects(call("project.open", { path: join(root, "innocent") }, () => {}, null), /cannot be a project/);
  mkdirSync(join(root, "ok-project"));
  const r = await call("project.open", { path: join(root, "ok-project") }, () => {}, null);
  assert.equal(r.project.name, "ok-project");
  // Opening it again is not an error: the same project comes back (first fresh-install test).
  const again = await call("project.open", { path: join(root, "ok-project") }, () => {}, null);
  assert.equal(again.project.name, "ok-project");
  assert.equal(again.existing, true);
  // A name already in use says so plainly, never as a database error.
  mkdirSync(join(root, "other"));
  await assert.rejects(call("project.open", { path: join(root, "other"), name: "ok-project" }, () => {}, null), /already a project called ok-project/);
  d.close();
});

test("the tool gets a clean environment and a narrow view of its own config", () => {
  process.env.GOVERNCODE_SECRET_TEST = "x";
  const env = toolEnv("/tmp/t");
  assert.equal(env.TMPDIR, "/tmp/t");
  assert.ok(env.PATH && env.HOME);
  assert.equal(env.GOVERNCODE_SECRET_TEST, undefined);
  delete process.env.GOVERNCODE_SECRET_TEST;
  try {
    const p = claudePolicy("/tmp/wt", "/tmp/t");
    const cfg = join(homedir(), ".claude");
    assert.ok(!p.write.includes(join(homedir(), ".claude.json")), "~/.claude.json is never writable");
    assert.ok(!p.write.some((w) => w.endsWith(".credentials.json")));
    assert.ok(![...p.read, ...p.write].includes(join(cfg, "projects")), "other projects' transcripts stay out");
    assert.ok(!p.read.includes("/dev") && !p.write.includes("/dev/tty"));
  } catch (e) {
    if (!(e instanceof Error && /claude not found/.test(e.message))) throw e;   // CI has no Claude Code
  }
});

test("git guard: config.worktree, core.worktree and remote upload-pack are reverted too", () => {
  const dir = scratch("gc-guard2-");
  git(dir, "init", "-q");
  const guard = gitGuard(dir, join(dir, "..", "scratch-guard2"))!;
  git(dir, "config", "extensions.worktreeConfig", "true");
  git(dir, "config", "--worktree", "core.fsmonitor", "./evil");
  git(dir, "config", "core.worktree", "/tmp");
  git(dir, "config", "remote.origin.uploadpack", "./evil");
  const changed = guard.restore().sort();
  assert.deepEqual(changed, [".git/config", ".git/config.worktree"]);
  for (const k of ["extensions.worktreeConfig", "core.worktree", "remote.origin.uploadpack"]) assert.throws(() => git(dir, "config", k), k);
  assert.ok(!existsSync(join(dir, ".git/config.worktree")));
});

test("toolchains from a version manager can run in the sandbox; home and ~/.dot folders are never granted", () => {
  const home = scratch("gc-home-");
  const node = join(home, ".local/share/mise/installs/node/26.7.0");
  mkdirSync(join(node, "bin"), { recursive: true });
  writeFileSync(join(node, "bin/node"), "");
  mkdirSync(join(home, ".cargo/bin"), { recursive: true });
  writeFileSync(join(home, ".cargo/bin/cargo"), "");          // a rustup proxy: ~/.cargo holds credentials
  writeFileSync(join(home, "python3"), "");                    // straight in home
  const dirs = toolchainDirs([join(node, "bin"), join(home, ".cargo/bin"), home, "/usr/bin"].join(":"), home);
  assert.deepEqual(dirs, [node]);
  assert.equal(toolEnv("/t").npm_config_cache, "/t/npm-cache", "npm keeps its cache in the run's scratch");
});

test("personal instructions: off, the Controller cannot even read them; on, it can", () => {
  const cfg = join(homedir(), ".claude");
  try {
    const off = claudePolicy("/tmp/wt", "/tmp/t");
    assert.ok(![...off.read].some((p) => p.startsWith(join(cfg, "CLAUDE.md")) || p.startsWith(join(cfg, "skills")) || p.startsWith(join(cfg, "hooks"))), off.read.join());
    const on = claudePolicy("/tmp/wt", "/tmp/t", false, undefined, true);
    for (const f of ["CLAUDE.md", "hooks"]) if (existsSync(join(cfg, f))) assert.ok(on.read.includes(join(cfg, f)), f);
  } catch (e) {
    if (!(e instanceof Error && /claude not found/.test(e.message))) throw e;   // CI has no Claude Code
  }
  const user = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  assert.ok(!codexPolicy("/tmp/wt", "/tmp/t", "/tmp/ch", "/usr/bin/true").read.includes(join(user, "AGENTS.md")));
  const codexOn = codexPolicy("/tmp/wt", "/tmp/t", "/tmp/ch", "/usr/bin/true", false, undefined, undefined, true);
  if (existsSync(join(user, "AGENTS.md"))) assert.ok(codexOn.read.includes(join(user, "AGENTS.md")));
});

test("tool homes: every run starts empty but for the login link, leaves nothing behind, and a replaced login goes back", async () => {
  const { runHome, toolHome, setConnected, isConnected } = await import("../src/homes.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, lstatSync, rmSync, existsSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const state = mkdtempSync(join(tmpdir(), "gc-runhome-"));
  const shared = join(toolHome(state, "codex"), "auth.json");
  mkdirSync(toolHome(state, "codex"), { recursive: true });
  writeFileSync(shared, "login-1");
  setConnected(state, "codex", true);
  assert.ok(isConnected(state, "codex"));
  assert.ok(!readdirSync(toolHome(state, "codex")).includes("connected"), "the mark is outside the tool's home");
  const replace = (home: string, body: string) => { rmSync(join(home, "auth.json")); writeFileSync(join(home, "auth.json"), body); };

  const a = runHome(state, "codex", "auth.json");
  assert.deepEqual(readdirSync(a.home), ["auth.json"]);
  assert.ok(lstatSync(join(a.home, "auth.json")).isSymbolicLink());
  mkdirSync(join(a.home, "rules")); writeFileSync(join(a.home, "rules", "allow.rules"), "x");
  const b = runHome(state, "codex", "auth.json");
  assert.deepEqual(readdirSync(b.home), ["auth.json"], "a run overlapping another starts clean");
  // A refresh written by rename goes back to the shared home, in place.
  replace(a.home, "login-2");
  a.finish();
  assert.equal(readFileSync(shared, "utf8"), "login-2");
  assert.ok(!existsSync(a.home));
  // b started before that refresh: its own refresh is older, and is not put back over it.
  replace(b.home, "login-stale");
  b.finish();
  assert.equal(readFileSync(shared, "utf8"), "login-2");

  // A run that swaps its login for a link to a private file: govd does not follow it.
  const secret = join(state, "private-key"); writeFileSync(secret, "SECRET");
  const c = runHome(state, "codex", "auth.json");
  rmSync(join(c.home, "auth.json")); symlinkSync(secret, join(c.home, "auth.json"));
  c.finish();
  assert.equal(readFileSync(shared, "utf8"), "login-2");

  // A run from before a reconnect never writes back over the new login.
  const d = runHome(state, "codex", "auth.json");
  setConnected(state, "codex", true);   // a new Connect: a new generation
  replace(d.home, "login-old-connection");
  d.finish();
  assert.equal(readFileSync(shared, "utf8"), "login-2");
});

test("tool homes: a run that chmods what it shares, or its own folders, cannot break the next run or govd", async () => {
  const { runHome, toolHome } = await import("../src/homes.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const state = mkdtempSync(join(tmpdir(), "gc-runhome-modes-"));
  const home = toolHome(state, "agy");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "helper"), "#!/bin/sh\n"); chmodSync(join(home, "bin", "helper"), 0o755);
  writeFileSync(join(home, "token"), "login");
  const a = runHome(state, "agy", "token", ["bin"]);
  // What a run can do with ownership alone: lock the shared files, and leave a locked folder.
  chmodSync(join(home, "token"), 0o000); chmodSync(join(home, "bin", "helper"), 0o000); chmodSync(join(home, "bin"), 0o000);
  mkdirSync(join(a.home, "trap", "inner"), { recursive: true }); writeFileSync(join(a.home, "trap", "inner", "f"), "x");
  chmodSync(join(a.home, "trap", "inner"), 0o000); chmodSync(join(a.home, "trap"), 0o000);
  assert.doesNotThrow(() => a.finish());
  assert.ok(!existsSync(a.home), "the locked run home is still removed");
  const b = runHome(state, "agy", "token", ["bin"]);
  assert.equal(statSync(join(home, "token")).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "bin")).mode & 0o777, 0o755);
  assert.equal(statSync(join(home, "bin", "helper")).mode & 0o777, 0o755, "the helper is readable and runnable again");
  assert.equal(readFileSync(join(b.home, "token"), "utf8"), "login");
  b.finish();
});

test("a Claude turn's home links the user's ~/.claude for their hooks, and removing it never touches the user's files", () => {
  const user = scratch("gc-user-claude-");
  mkdirSync(join(user, "hooks"));
  writeFileSync(join(user, "CLAUDE.md"), "mine\n");
  writeFileSync(join(user, "hooks", "check.sh"), "#!/bin/sh\n");
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = user;
  try {
    const rh = claudeRunHome(scratch("gc-state-home-"), true);
    assert.ok(lstatSync(join(rh.home, ".claude")).isSymbolicLink());
    assert.ok(existsSync(join(rh.home, ".claude", "hooks", "check.sh")), "~/.claude/hooks/... resolves as before");
    rh.finish();
    assert.ok(!existsSync(rh.home), "the run's home is gone");
    assert.equal(readFileSync(join(user, "CLAUDE.md"), "utf8"), "mine\n", "the user's own files are untouched");
    assert.ok(existsSync(join(user, "hooks", "check.sh")));
    const plain = claudeRunHome(scratch("gc-state-home-"), false);
    assert.ok(!existsSync(join(plain.home, ".claude")), "without personal instructions there is no link");
    plain.finish();
  } finally { if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was; }
});
