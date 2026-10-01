// Phase 1 plumbing, tested with fakes: Checkpoints, Limits and the Spec record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cp from "../src/checkpoint.ts";
import { LimitGate, REPORT_LAG_MS } from "../src/limits.ts";
import { Ledger } from "../src/ledger.ts";
import { scratch } from "./scratch.ts";

function repo() {
  const dir = scratch("gc-cp-");
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "root");
  writeFileSync(join(dir, "kept.txt"), "one\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  g("add", "kept.txt", ".gitignore");
  return { dir, index: () => readFileSync(join(dir, ".git/index")) };
}

test("checkpoints: diff, undo, redo, and the user's index is never touched", () => {
  const { dir, index } = repo();
  const before = index();
  assert.ok(cp.take(dir, "S-0001", "before"));
  writeFileSync(join(dir, "kept.txt"), "two\n");
  unlinkSync(join(dir, "gone.txt"));
  writeFileSync(join(dir, "new.txt"), "fresh\n");
  writeFileSync(join(dir, "ignored.log"), "noise\n");
  cp.take(dir, "S-0001", "after");
  assert.deepEqual(cp.changed(dir, "refs/governcode/specs/S-0001/before", "refs/governcode/specs/S-0001/after").sort(), ["gone.txt", "kept.txt", "new.txt"]);
  assert.match(cp.diff(dir, "S-0001"), /\+two/);
  assert.deepEqual(index(), before);
  cp.undo(dir, "S-0001");
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "one\n");
  assert.equal(readFileSync(join(dir, "gone.txt"), "utf8"), "bye\n");
  assert.ok(!existsSync(join(dir, "new.txt")));
  assert.ok(existsSync(join(dir, "ignored.log")), "ignored files are not ours to touch");
  cp.redo(dir, "S-0001");
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "two\n");
  assert.deepEqual(index(), before);
});

test("checkpoints: undo refuses after later edits, and nothing changes", () => {
  const { dir } = repo();
  cp.take(dir, "S-0002", "before");
  writeFileSync(join(dir, "kept.txt"), "two\n");
  cp.take(dir, "S-0002", "after");
  writeFileSync(join(dir, "kept.txt"), "the user typed this\n");
  assert.throws(() => cp.undo(dir, "S-0002"), /changed after S-0002 ended/);
  assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "the user typed this\n");
});

test("checkpoints: outside git is a quiet null", () => {
  assert.equal(cp.take(scratch("gc-nogit-"), "S-0003", "before"), null);
});

test("limits: unknown and stale hold; a measured window admits and reserves", () => {
  let now = 1_000_000;
  const gate = new LimitGate({}, () => now);
  assert.deepEqual(gate.admit("S-1", "codex", 10), { ok: false, provider: "codex", reason: "no usage source · held", resetsAt: null });
  gate.record({ provider: "codex", measuredAt: now, readings: [{ window: "weekly", usedPercent: 60, resetsAt: "Tue 06:10" }] });
  assert.equal(gate.admit("S-1", "codex", 15).ok, true);
  assert.equal(gate.admit("S-2", "codex", 15).ok, true);          // 60 + 15 + 15 = 90
  const third = gate.admit("S-3", "codex", 5);                     // 95 > 90: held, naming the reset
  assert.equal(third.ok, false);
  assert.ok(!third.ok && third.resetsAt === "Tue 06:10" && /30% reserved by running Specs/.test(third.reason));
  gate.release("S-1");
  assert.equal(gate.admit("S-3", "codex", 5).ok, false, "a finished Spec keeps counting until measured");
  gate.record({ provider: "codex", measuredAt: now, readings: [{ window: "weekly", usedPercent: 75, resetsAt: "Tue 06:10" }] });
  assert.equal(gate.admit("S-3", "codex", 5).ok, false, "75 + S-2's 15 + 5 = 95: still held");
  gate.release("S-2");
  gate.record({ provider: "codex", measuredAt: now, readings: [{ window: "weekly", usedPercent: 84, resetsAt: "Tue 06:10" }] });
  assert.equal(gate.admit("S-3", "codex", 5).ok, false, "risen 24, but either Spec may have used it all: 84 + 15 + 5 = 104");
  now += REPORT_LAG_MS;
  gate.record({ provider: "codex", measuredAt: now, readings: [{ window: "weekly", usedPercent: 84, resetsAt: "Tue 06:10" }] });
  assert.equal(gate.admit("S-3", "codex", 5).ok, true, "15 minutes on, and moved: the counter has absorbed both: 84 + 5 <= 90");
  now += 10 * 60_000;
  const stale = gate.admit("S-4", "codex", 1);
  assert.ok(!stale.ok && /stale/.test(stale.reason));
  assert.ok(!gate.stillWithin("S-2").ok, "a running Spec stops when its measurement goes stale");
});

test("limits: the Controller's budget is clamped, and unmetered is an explicit opt-in", () => {
  const gate = new LimitGate({ unmetered: ["local"], maxSpecPercent: 25 });
  gate.record({ provider: "codex", measuredAt: Date.now(), readings: [{ window: "5-hour", usedPercent: 60, resetsAt: null }] });
  assert.equal(gate.admit("S-1", "codex", 90).ok, true);           // asks 90, reserves 25
  assert.equal(gate.admit("S-2", "codex", 6).ok, false);           // 60 + 25 + 6 = 91 > 90
  const local = gate.admit("S-3", "local", 50);
  assert.ok(local.ok && local.note?.includes("unmetered"));
  gate.record({ provider: "codex", measuredAt: Date.now(), readings: [{ window: "5-hour", usedPercent: 93, resetsAt: "17:55" }] });
  const crossed = gate.stillWithin("S-1");
  assert.ok(!crossed.ok && /crossed its 5-hour Limit/.test(crossed.reason));
});

test("specs: created, moved through statuses, all in the Trace", () => {
  const L = new Ledger(":memory:");
  const s = L.createSpec("tidepool", { to: "codex", brief: "write tests", result: "cargo test passes",
    scope: { read: ["crates/api"], write: ["crates/api/tests"] }, budgetPercent: 15, workspace: "worktree",
    model: "gpt-5.5", effort: "medium", reason: "idle and within its Limit" }, "controller · claude-code");
  assert.equal(s.id, "S-0001");
  L.updateSpec(s.id, { status: "running", checkpoints: { before: "abc", after: null } }, "govd");
  L.updateSpec(s.id, { status: "needs-review", files: ["crates/api/tests/t.rs"], checkpoints: { before: "abc", after: "def" } }, "govd");
  assert.equal(L.spec(s.id)?.status, "needs-review");
  assert.deepEqual(L.events("tidepool", 10).map((e) => e.kind), ["spec.created", "spec.started", "spec.done"]);
  assert.equal(L.specs("tidepool").length, 1);
  L.close();
});

