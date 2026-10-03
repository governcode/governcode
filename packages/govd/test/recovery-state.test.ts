import { test } from "node:test";
import assert from "node:assert/strict";
import type { Spec, TraceEvent } from "@governcode/protocol";
import { deriveRecoveryStates } from "../src/recovery.ts";

const spec = (id: string, status: "held" | "failed", resetsAt: string | null, at: string): Spec => ({
  id, project: "p", status, created: "2026-10-03T00:00:00.000Z", to: "codex", brief: "do it", result: "done",
  scope: { read: [], write: [] }, budgetPercent: 10, workspace: "worktree", model: "", effort: null,
  reason: "the job fits", mode: "async", waitSeconds: 600, checkpoints: { before: null, after: null }, files: [],
  limited: { resetsAt, at, why: status === "held" ? "weekly reserve" : "codex hit its usage limit" },
});

const event = (seq: number, kind: TraceEvent["kind"], data: Record<string, unknown> = {}, project: string | null = "p"): TraceEvent => ({
  seq, kind, data, project, actor: "govd", ts: `2026-10-03T00:00:${String(seq).padStart(2, "0")}.000Z`,
});

test("recovery state lists limited Specs, omits running and cleared Specs, and never guesses a reset", () => {
  const held = spec("S-0001", "held", "2026-10-03T01:00:00.000Z", "2026-10-03T00:00:01.000Z");
  const failed = spec("S-0002", "failed", null, "2026-10-03T00:00:02.000Z");
  const events = [event(1, "spec.held", { spec: held.id }), event(2, "spec.failed", { spec: failed.id })];

  const states = deriveRecoveryStates([held, failed], events, new Set(), new Date("2026-10-03T02:00:00.000Z"));
  assert.deepEqual(states.map((s) => s.item), [
    { target: "S-0001", project: "p", kind: "held", provider: "codex", resetsAt: "2026-10-03T01:00:00.000Z",
      since: held.limited!.at, why: "weekly reserve", atReset: false, due: false },
    { target: "S-0002", project: "p", kind: "spec", provider: "codex", resetsAt: null,
      since: failed.limited!.at, why: "codex hit its usage limit", atReset: false, due: false },
  ]);
  assert.deepEqual(deriveRecoveryStates([held, failed], events, new Set([held.id])).map((s) => s.item.target), [failed.id]);
  assert.deepEqual(deriveRecoveryStates([held, failed], [...events, event(3, "recovery.cleared", { target: failed.id })])
    .map((s) => s.item.target), [held.id]);
});

test("the latest matching at-reset choice drives due state, and a resumed event guards only that choice", () => {
  const held = spec("S-0001", "held", "2026-10-03T01:00:00.000Z", "2026-10-03T00:00:01.000Z");
  const base = [
    event(1, "spec.held", { spec: held.id }),
    event(2, "recovery.set", { target: held.id, resetsAt: held.limited!.resetsAt, atReset: true }),
    event(3, "recovery.resumed", { target: held.id, resetsAt: held.limited!.resetsAt, by: "govd" }),
  ];
  const once = deriveRecoveryStates([held], base, new Set(), new Date("2026-10-03T02:00:00.000Z"))[0];
  assert.equal(once.item.atReset, true);
  assert.equal(once.item.due, true);
  assert.equal(once.guarded, true);

  const rearmed = deriveRecoveryStates([held], [...base,
    event(4, "recovery.set", { target: held.id, resetsAt: "2026-10-04T01:00:00.000Z", atReset: false }),
    event(5, "recovery.set", { target: held.id, resetsAt: held.limited!.resetsAt, atReset: true }),
  ], new Set(), new Date("2026-10-03T02:00:00.000Z"))[0];
  assert.equal(rearmed.item.atReset, true, "a choice for another reset time does not replace this one");
  assert.equal(rearmed.guarded, false, "choosing at-reset again arms another attempt");
});

test("a failed Spec held again after resume starts a new recovery episode", () => {
  const failed = spec("S-0001", "failed", "2026-10-03T01:00:00.000Z", "2026-10-03T00:00:04.000Z");
  const state = deriveRecoveryStates([failed], [
    event(1, "spec.failed", { spec: failed.id }),
    event(2, "recovery.set", { target: failed.id, resetsAt: failed.limited!.resetsAt, atReset: true }),
    event(3, "recovery.resumed", { target: failed.id, resetsAt: failed.limited!.resetsAt, by: "govd" }),
  ], new Set(), new Date("2026-10-03T02:00:00.000Z"))[0];
  assert.equal(state.item.atReset, false, "the old choice does not carry into the renewed limit");
  assert.equal(state.guarded, false, "the resume before the renewed limit does not guard its new choice");
});

test("only the latest project turn is recoverable, and reset or Controller changes make it stale", () => {
  const started = event(10, "turn.started", { prompt: "work", controller: { provider: "claude-code" } });
  const failed = event(11, "turn.failed", { turn: "T-10", summary: "the turn stopped", limit: {
    provider: "claude-code", resetsAt: "2026-10-03T01:00:00.000Z",
  } });
  const armed = event(12, "recovery.set", { target: "T-10", resetsAt: "2026-10-03T01:00:00.000Z", atReset: true });
  const state = deriveRecoveryStates([], [armed, failed, started], new Set(), new Date("2026-10-03T02:00:00.000Z"))[0];
  assert.deepEqual(state.item, { target: "T-10", project: "p", kind: "turn", provider: "claude-code",
    resetsAt: "2026-10-03T01:00:00.000Z", since: failed.ts, why: "the turn stopped", atReset: true, due: true });

  assert.equal(deriveRecoveryStates([], [started, failed, armed, event(13, "conversation.reset")]).length, 0);
  assert.equal(deriveRecoveryStates([], [started, failed, armed, event(13, "controller.set")]).length, 0);
  assert.equal(deriveRecoveryStates([], [started, failed, armed,
    event(13, "turn.started", { prompt: "new", controller: { provider: "claude-code" } })]).length, 0);
  assert.equal(deriveRecoveryStates([], [
    event(20, "turn.started", { controller: { provider: "claude-code" } }, null),
    event(21, "turn.failed", { turn: "T-20", summary: "stopped", limit: { provider: "claude-code", resetsAt: null } }, null),
  ]).length, 0, "Home turns are never targets");
});
