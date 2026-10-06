import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWatch } from "../src/shared/watch.ts";
import { describe } from "../src/shared/trace.ts";

let seq = 0;
const ev = (kind: string, project: string | null, data: Record<string, unknown> = {}, actor = "govd", ts = "2026-10-05T10:00:00.000Z") =>
  ({ seq: ++seq, ts, kind, project, actor, data });
const now = new Date("2026-10-05T12:00:00.000Z");

test("a Controller turn is watched from its start until it ends, with its latest step", () => {
  const events = [
    ev("turn.started", "a", { prompt: "Add pagination", controller: { provider: "claude-code" } }, "user"),
    ev("turn.tool", "a", { name: "Read src/routes.ts" }, "controller · claude-code"),
    ev("turn.text", "a", { text: "Codex will write it." }, "controller · claude-code"),
    ev("turn.started", "b", { prompt: "Done already", controller: { provider: "codex" } }, "user"),
    ev("turn.completed", "b", { summary: "ok" }),
  ];
  const w = buildWatch(events, [], now);
  assert.deepEqual(w.turns, [{ project: "a", provider: "claude-code", prompt: "Add pagination", origin: null, since: events[0].ts, lastStep: "“Codex will write it.”" }]);
});

test("Runners at work come from the Specs, with when they started and their latest step", () => {
  const events = [ev("spec.started", "a", { spec: "S-1" }, "govd", "2026-10-05T11:00:00.000Z"), ev("spec.step", "a", { spec: "S-1", name: "apply_patch x.ts" })];
  const specs = [{ id: "S-1", project: "a", status: "running", to: "grok", brief: "Rate limiter" }, { id: "S-2", project: "a", status: "accepted", to: "codex", brief: "Old" }];
  assert.deepEqual(buildWatch(events, specs, now).runners, [{ id: "S-1", project: "a", to: "grok", brief: "Rate limiter", status: "running", since: "2026-10-05T11:00:00.000Z", lastStep: "apply_patch x.ts" }]);
});

test("today counts only today's events, and only your own answers as yours", () => {
  const events = [
    ev("turn.started", "a", {}, "user"), ev("spec.done", "a", { spec: "S-1" }),
    ev("gate.allowed", "a", { gate: "G-1", tool: "Bash", by: "user" }, "user"),
    ev("gate.denied", "a", { gate: "G-2", tool: "Bash", by: "nobody answered within the hour" }, "user"),
    ev("gate.allowed", "a", { tool: "Read", by: "quiet read" }),
    ev("turn.started", "a", {}, "user", "2026-10-04T10:00:00.000Z"),
  ];
  assert.deepEqual(buildWatch(events, [], now).today, { turns: 1, specsFinished: 1, answeredByYou: 1, letThrough: 1 });
});

test("the moment-to-moment events read as sentences too", () => {
  assert.equal(describe(ev("turn.text", "a", { text: "Codex will   write it." }, "controller · claude-code")).text, "controller · claude-code: “Codex will write it.”");
  assert.equal(describe(ev("spec.step", "a", { spec: "S-1", name: "apply_patch x.ts" })).text, "S-1 · apply_patch x.ts");
  assert.equal(describe(ev("turn.tool", "a", { name: "Task", subagent: "find the tests" }, "controller · claude-code")).text, "controller · claude-code started a subagent: “find the tests”");
});
