// The Spec store: workspace from HEAD, filter-free snapshots, exact apply, symlink refusals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ss from "../src/specstore.ts";
import { LimitGate } from "../src/limits.ts";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "gc-proj-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/b.txt"), "bee\n");
  // A filter a hostile repo might configure: must never run for GovernCode.
  writeFileSync(join(dir, ".gitattributes"), "*.txt filter=evil\n");
  g("config", "filter.evil.clean", `sh -c 'touch ${dir}/PWNED; cat'`);
  g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  return dir;
}

test("workspace, snapshots, diff and apply run no repo filter and apply exactly the after-state", () => {
  const proj = project();
  const state = mkdtempSync(join(tmpdir(), "gc-state-"));
  execFileSync("rm", ["-f", join(proj, "PWNED")]);          // the setup commit itself ran it once
  const p = ss.specPaths(state, "S-0001");
  ss.createWorkspace(proj, p);
  assert.equal(readFileSync(join(p.work, "a.txt"), "utf8"), "one\n");
  const before = ss.snapshot(p, "before");
  writeFileSync(join(p.work, "a.txt"), "two\n");
  writeFileSync(join(p.work, "src/new.txt"), "fresh\n");
  const after = ss.snapshot(p, "after", before);
  assert.deepEqual(ss.changedFiles(p, before, after).sort(), ["a.txt", "src/new.txt"]);
  assert.match(ss.diff(p, before, after), /\+two/);
  assert.deepEqual(ss.applyToProject(p, proj, before, after).sort(), ["a.txt", "src/new.txt"]);
  assert.equal(readFileSync(join(proj, "a.txt"), "utf8"), "two\n");
  assert.equal(readFileSync(join(proj, "src/new.txt"), "utf8"), "fresh\n");
  assert.ok(!existsSync(join(proj, "PWNED")), "the repo's filter never ran");
});

test("apply refuses when the project changed since the Spec started, and changes nothing", () => {
  const proj = project();
  const p = ss.specPaths(mkdtempSync(join(tmpdir(), "gc-state-")), "S-0002");
  ss.createWorkspace(proj, p);
  const before = ss.snapshot(p, "before");
  writeFileSync(join(p.work, "a.txt"), "runner\n");
  writeFileSync(join(p.work, "src/b.txt"), "runner too\n");
  const after = ss.snapshot(p, "after", before);
  writeFileSync(join(proj, "a.txt"), "the user edited this\n");
  assert.throws(() => ss.applyToProject(p, proj, before, after), /project changed since this Spec started.*a\.txt/);
  assert.equal(readFileSync(join(proj, "src/b.txt"), "utf8"), "bee\n", "all or nothing");
});

test("paths through symlinks are refused for scope and for apply", () => {
  const proj = project();
  const outside = mkdtempSync(join(tmpdir(), "gc-outside-"));
  symlinkSync(outside, join(proj, "escape"));
  assert.throws(() => ss.safeTarget(proj, "escape/owned"), /symlink/);
  assert.throws(() => ss.safeTarget(proj, "../x"), /unsafe/);
  assert.throws(() => ss.safeTarget(proj, "/etc/passwd"), /unsafe/);
  assert.equal(ss.safeTarget(proj, "src/b.txt"), join(proj, "src/b.txt"));
});

test("limits: a failed reading holds, and finished Specs keep counting until the counter catches up", () => {
  let now = 1_000_000;
  const gate = new LimitGate({ maxSpecPercent: 25 }, () => now);
  gate.record({ provider: "codex", measuredAt: now, readings: [{ window: "weekly", usedPercent: 40, resetsAt: null }] });
  assert.ok(gate.admit("S-1", "codex", 25).ok);
  gate.release("S-1");
  assert.ok(gate.admit("S-2", "codex", 15).ok, "40 + 25 still owed + 15 = 80");
  gate.release("S-2");
  assert.equal(gate.admit("S-3", "codex", 11).ok, false, "40 + 40 owed + 11 = 91: held until measured");
  now += 1000;
  gate.record({ provider: "codex", measuredAt: now, readings: [{ window: "weekly", usedPercent: 60, resetsAt: null }] });
  assert.equal(gate.admit("S-3", "codex", 11).ok, false, "rose 20 of the 40 owed: 60 + 20 + 11 = 91");
  assert.ok(gate.admit("S-4", "codex", 10).ok, "60 + 20 + 10 = 90");
  gate.forget("codex");
  assert.equal(gate.admit("S-5", "codex", 1).ok, false, "forgotten means held");
});
