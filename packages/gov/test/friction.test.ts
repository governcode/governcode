// The friction report: counted from Trace events as govd writes them, and read a page at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TraceEvent } from "@governcode/protocol";
import { friction, readTrace } from "../src/friction.ts";

let seq = 0;
const at = (day: number) => new Date(Date.UTC(2026, 8, day, 12)).toISOString();
const ev = (kind: TraceEvent["kind"], data: Record<string, unknown> = {}, o: { project?: string | null; actor?: string; day?: number } = {}): TraceEvent =>
  ({ seq: ++seq, ts: at(o.day ?? 20), project: o.project === undefined ? "app" : o.project, kind, actor: o.actor ?? "govd", data });
const C = "controller · claude-code";

/** A Gate opened and answered (by you, or by govd with its reason). */
const gate = (tool: string, by: string, answer: "allow" | "deny", o: { project?: string | null; actor?: string; day?: number } = {}) => {
  const id = `G-${seq + 1}`;
  return [ev("gate.opened", { gate: id, tool }, { actor: C, ...o }),
    ev(answer === "allow" ? "gate.allowed" : "gate.denied", { gate: id, tool, by }, { actor: by === "user" ? "user" : "govd", ...o })];
};

test("a tool allowed every time is a candidate; one you denied once is not; govd's denials are its own", () => {
  const events = [
    ev("turn.started", {}, { actor: "user" }), ev("turn.completed", { turn: "T-1" }, { actor: C }),
    ev("turn.started", {}, { actor: "user" }),
    ...Array.from({ length: 5 }, () => gate("Edit", "user", "allow")).flat(),
    ...Array.from({ length: 6 }, () => gate("Bash", "user", "allow")).flat(), ...gate("Bash", "user", "deny"),
    ...gate("Write", "user", "allow"),
    ...gate("Bash", "nobody answered within the hour", "deny"), ...gate("Edit", "turn ended", "deny"),
    // Asked after its Spec ended: denied without a Gate.
    ev("gate.denied", { tool: "Bash (Runner · codex, S-0003)", by: "the Spec ended" }),
    // Let through without a Gate.
    ev("gate.allowed", { tool: "Bash", by: "quiet read" }), ev("gate.allowed", { tool: "Bash", by: "rule R-1, R-4" }), ev("gate.allowed", { tool: "Bash", by: "rule R-2" }),
    ev("turn.failed", { turn: "T-2", limit: { provider: "claude-code", resetsAt: null } }, { actor: C }),
  ];
  const r = friction(events);
  assert.deepEqual(r.turns, { started: 2, completed: 1, failed: 1, limited: 1 });
  assert.equal(r.gates.opened, 15);
  assert.equal(r.gates.byControllers, 15);
  assert.equal(r.gates.perTurn, 7.5);
  assert.equal(r.gates.allowed, 12);
  assert.equal(r.gates.denied, 1);
  assert.equal(r.gates.autoDenied, 3);
  assert.deepEqual(r.gates.autoDeniedBy, { "nobody answered within the hour": 1, "turn ended": 1, "the Spec ended": 1 });
  assert.equal(r.gates.passed, 3);
  assert.deepEqual(r.gates.passedBy, { "quiet read": 1, rule: 2 });
  const byTool = Object.fromEntries(r.tools.map((t) => [t.tool, t]));
  assert.deepEqual(byTool.Edit, { tool: "Edit", asked: 6, allowed: 5, denied: 0, autoDenied: 1, allowedEveryTime: true });
  assert.deepEqual(byTool.Bash, { tool: "Bash", asked: 8, allowed: 6, denied: 1, autoDenied: 1, allowedEveryTime: false });
  assert.equal(byTool.Write.allowedEveryTime, false, "allowed once is not enough");
  assert.equal(friction(events, { minAllowed: 1 }).tools.find((t) => t.tool === "Write")!.allowedEveryTime, true);
  // A Runner's Gates are grouped by tool and Runner, not by Spec.
  assert.deepEqual(byTool["Bash (Runner · codex)"], { tool: "Bash (Runner · codex)", asked: 0, allowed: 0, denied: 0, autoDenied: 1, allowedEveryTime: false });
  assert.deepEqual(r.tools.map((t) => t.tool).slice(0, 2), ["Bash", "Edit"], "most asked first");
});

test("Runner Gates are counted apart from Controller turns; sandbox, .git and Spec events are counted", () => {
  const runner = { actor: "runner · codex · S-0001" };
  const events = [
    ev("turn.started"), ...gate("Edit", "user", "allow"),
    ...gate("codex exec (Runner · codex, S-0001)", "user", "allow", runner), ...gate("codex exec (Runner · codex, S-0002)", "user", "allow", runner),
    ev("sandbox.refused", { reason: "bwrap missing" }, { project: null }), ev("sandbox.refused", { reason: "bwrap missing" }),
    ev("git.scrubbed", { removed: [".git/hooks/pre-commit"] }), ev("git.guard_failed", { reason: "x" }),
    ev("spec.created", { spec: "S-0001" }), ev("spec.failed", { spec: "S-0001", limited: { resetsAt: null, at: at(20), why: "limit" } }),
    ev("spec.failed", { spec: "S-0002", note: "tests failed" }), ev("spec.held", { spec: "S-0003" }),
  ];
  const r = friction(events);
  assert.equal(r.gates.opened, 3);
  assert.equal(r.gates.byRunners, 2);
  assert.equal(r.gates.perTurn, 1);
  assert.deepEqual(r.tools.find((t) => t.tool === "codex exec (Runner · codex)"), { tool: "codex exec (Runner · codex)", asked: 2, allowed: 2, denied: 0, autoDenied: 0, allowedEveryTime: false });
  assert.deepEqual(r.sandbox, { refused: 2, refusedBy: { "bwrap missing": 2 }, gitScrubbed: 1, gitGuardFailed: 1 });
  assert.deepEqual(r.specs, { created: 1, failed: 2, limited: 1, held: 1 });
  assert.equal(friction([]).gates.perTurn, null, "no turns: no average");
});

test("the project and since filters keep only the events in the window", () => {
  const events = [
    ...gate("Edit", "user", "allow", { day: 1 }), ev("turn.started", {}, { day: 1 }),
    ...gate("Edit", "user", "deny", { day: 25 }), ev("turn.started", {}, { day: 25 }),
    ...gate("Bash", "user", "allow", { project: "other", day: 25 }), ev("turn.started", {}, { project: "other", day: 25 }),
    ...gate("Read", "user", "allow", { project: null, day: 25 }),
  ];
  const since = new Date(at(10));
  const app = friction(events, { project: "app", since });
  assert.equal(app.since, since.toISOString());
  assert.equal(app.turns.started, 1);
  assert.deepEqual(app.tools.map((t) => [t.tool, t.asked, t.allowed, t.denied]), [["Edit", 1, 0, 1]]);
  assert.deepEqual(friction(events, { since }).tools.map((t) => t.tool), ["Bash", "Read", "Edit"], "most asked, then most allowed");
  assert.deepEqual(friction(events, { project: null }).tools.map((t) => t.tool), ["Read"], "null: Home only");
  assert.equal(friction(events).turns.started, 3, "no filter: everything");
});

test("readTrace finds the window's start by seq and pages from there, keeping only what is asked for", async () => {
  const all: TraceEvent[] = Array.from({ length: 3000 }, (_, i) => ({ seq: (i + 1) * 3, ts: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    project: "app", kind: i % 2 ? "turn.text" : "gate.opened", actor: "govd", data: {} }));
  const calls: Array<[number | undefined, number]> = [];
  const page = async (after: number | undefined, limit: number) => {
    calls.push([after, limit]);
    return after === undefined ? all.slice(-limit) : all.filter((e) => e.seq > after).slice(0, limit);
  };
  const since = new Date(all[1200].ts);
  const got = await readTrace(page, since);
  assert.deepEqual(got.map((e) => e.seq), all.slice(1200).map((e) => e.seq));
  // A binary search of single events, then pages of 1000 from the start: never the whole Trace.
  assert.ok(calls.filter(([, l]) => l === 1).length <= 16, `${calls.length} calls`);
  assert.deepEqual(calls.filter(([, l]) => l === 1000).map(([a]) => a), [all[1199].seq, all[2199].seq]);
  assert.equal((await readTrace(page, since, (e) => e.kind === "gate.opened")).length, 900);
  assert.equal((await readTrace(page, undefined)).length, 3000);
  assert.deepEqual(await readTrace(page, new Date(Date.UTC(2027, 0, 1))), [], "nothing that recent");
  assert.deepEqual(await readTrace(async () => [], since), [], "an empty Trace");
  // An older govd ignores `after` and repeats its newest page: the reading ends.
  const old = await readTrace(async (_after, limit) => all.slice(-limit), since);
  assert.equal(old.length, 1000);
});
