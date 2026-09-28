// The Crew board is built from the Trace alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBoard } from "../src/shared/board.ts";

const ev = (seq: number, kind: string, data: Record<string, unknown> = {}) => ({ seq, ts: `2026-09-28T20:00:${String(seq).padStart(2, "0")}Z`, project: "p", kind, actor: "x", data });

test("the board: the latest turn's Controller, its subagents, its Specs with their latest step, and waiting Gates", () => {
  const events = [
    ev(1, "turn.started", { controller: { provider: "codex" } }), ev(2, "turn.completed"),
    ev(3, "turn.started", { controller: { provider: "claude-code" } }),
    ev(4, "turn.tool", { name: "Task", subagent: "read the parser" }), ev(5, "turn.tool", { name: "Bash" }),
    ev(6, "spec.created", { spec: "S-0002", to: "agy" }), ev(7, "spec.step", { spec: "S-0002", name: "agy view_file" }),
    ev(8, "spec.step", { spec: "S-0002", name: "agy write_to_file" }),
  ];
  const specs = [{ id: "S-0001", to: "codex", brief: "old", status: "accepted" }, { id: "S-0002", to: "agy", brief: "docs", status: "running" }];
  const gates = [{ id: "G-4", tool: "agy fileChange (Runner · agy, S-0002)" }, { id: "G-5", tool: "Bash" }];
  const b = buildBoard(events as never, specs, gates);
  assert.deepEqual(b.controller, { provider: "claude-code", working: true, since: events[2].ts, gates: ["G-5"] });
  assert.deepEqual(b.subagents, [{ what: "read the parser", at: events[3].ts }]);
  assert.deepEqual(b.specs, [{ id: "S-0002", to: "agy", brief: "docs", status: "running", lastStep: "agy write_to_file", gates: ["G-4"] }]);
});

test("the board: an idle Controller, and nothing at all before the first turn", () => {
  assert.equal(buildBoard([], [], []).controller, null);
  const b = buildBoard([ev(1, "turn.started", { controller: { provider: "codex" } }), ev(2, "turn.failed")] as never, [], []);
  assert.equal(b.controller?.working, false);
});
