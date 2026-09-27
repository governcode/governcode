// Fixes from the phase-0 red-team: .git guard, project paths, the tool's environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { gitGuard } from "../src/gitguard.ts";
import { toolEnv, claudePolicy } from "../src/claude.ts";
import { Daemon } from "../src/daemon.ts";

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

test("git guard: new hooks and dangerous config are removed after a turn; the user's own stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-guard-"));
  git(dir, "init", "-q");
  git(dir, "config", "core.pager", "less");                 // the user's own, before the turn
  writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\necho mine\n");
  const guard = gitGuard(dir)!;
  // what a tool might do during the turn:
  writeFileSync(join(dir, ".git/hooks/post-checkout"), "#!/bin/sh\nexfiltrate\n");
  writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nevil\n");
  git(dir, "config", "core.fsmonitor", "./run-me");
  git(dir, "config", "core.pager", "./also-me");
  git(dir, "config", "user.name", "harmless");
  const removed = guard.restore().sort();
  assert.deepEqual(removed, ["config core.fsmonitor", "config core.pager", "hook post-checkout", "hook pre-commit"]);
  assert.ok(!existsSync(join(dir, ".git/hooks/post-checkout")));
  assert.equal(readFileSync(join(dir, ".git/hooks/pre-commit"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal(git(dir, "config", "core.pager"), "less");
  assert.throws(() => git(dir, "config", "core.fsmonitor"));
  assert.equal(git(dir, "config", "user.name"), "harmless");   // not dangerous, left alone
});

test("project paths: home, dot-folders, govd's own dirs and symlinks to them are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "gc-paths-"));
  const d = new Daemon({ socketPath: join(root, "run/govd.sock"), ledgerPath: join(root, "state/trace.sqlite"),
    policyDir: join(root, "state/p"), homeDir: join(root, "state/home"), supervisor: "/bin/false", version: "t" });
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

test("git guard: config.worktree, core.worktree and remote upload-pack are scrubbed too", () => {
  const dir = mkdtempSync(join(tmpdir(), "gc-guard2-"));
  git(dir, "init", "-q");
  const guard = gitGuard(dir)!;
  git(dir, "config", "extensions.worktreeConfig", "true");
  git(dir, "config", "--worktree", "core.fsmonitor", "./evil");
  git(dir, "config", "core.worktree", "/tmp");
  git(dir, "config", "remote.origin.uploadpack", "./evil");
  const removed = guard.restore().sort();
  assert.ok(removed.includes("config extensions.worktreeconfig"), removed.join());
  assert.ok(removed.includes("config.worktree core.fsmonitor"), removed.join());
  assert.ok(removed.includes("config core.worktree") && removed.includes("config remote.origin.uploadpack"), removed.join());
});
