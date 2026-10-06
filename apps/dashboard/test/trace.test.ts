// The Trace screen's labels and summaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, eventLabel, KIND_LABEL, summary } from "../src/shared/trace.ts";

const ev = (kind: string, data: Record<string, unknown> = {}) => ({ seq: 1, ts: "2026-09-30T20:00:00Z", project: "p", kind, actor: "user", data });

test("every event kind the protocol lists has a plain label", () => {
  const src = readFileSync(new URL("../../../packages/protocol/src/index.ts", import.meta.url), "utf8");
  const union = /export type TraceEvent = \{[\s\S]*?kind:([\s\S]*?);\s*actor:/.exec(src)?.[1] ?? "";
  const kinds = [...union.matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]);
  assert.ok(kinds.length > 30, "the protocol's kind list was found");
  for (const k of kinds) {
    const label = eventLabel(ev(k));
    assert.notEqual(label, k, `${k} has a label`);
    assert.match(label, /^[.A-Z][^.]*$/, `${k}: "${label}" is a short phrase, not a raw kind`);
  }
  assert.deepEqual(Object.keys(KIND_LABEL).sort(), [...new Set(kinds)].sort(), "no label for a kind the protocol does not have");
});

test("labels: a discarded Spec reads the same in old and new records; an unknown kind reads as itself", () => {
  assert.equal(eventLabel(ev("spec.discarded")), "Spec discarded");
  assert.equal(eventLabel(ev("spec.undone")), "Spec discarded");
  assert.equal(eventLabel(ev("turn.completed")), "Turn done");
  assert.equal(eventLabel(ev("gate.allowed")), "Gate allowed");
  assert.equal(eventLabel(ev("checkpoint.undone")), "Checkpoint undone");
  assert.equal(eventLabel(ev("something.new")), "something.new");
  assert.equal(eventLabel(ev("toString")), "toString");
  assert.equal(eventLabel(ev("context.shared", { provider: "codex", share: true })), "Context shared");
  assert.equal(eventLabel(ev("context.shared", { provider: "codex", share: false })), "Context not shared");
});

test("summaries leave out empty fields instead of printing null", () => {
  assert.equal(summary(ev("controller.set", { provider: "codex", model: "gpt-5.5", effort: null })), "provider codex · model gpt-5.5");
  assert.equal(summary(ev("gate.allowed", { gate: "G-3", tool: "Bash", spec: null })), "G-3 Bash");
  assert.equal(summary(ev("conversation.reset")), "");
});

test("the timeline describes events from what govd records, and never guesses", () => {
  const ev = (kind: string, data: Record<string, unknown>, actor = "govd") => ({ seq: 1, ts: "2026-10-05T10:00:00.000Z", kind, project: "p", actor, data });
  assert.deepEqual(describe(ev("gate.allowed", { gate: "G-1", tool: "Bash", by: "user" }, "user")), { text: "You allowed Bash (Gate G-1)", tone: "ok", icon: "check" });
  // govd settles a Gate with actor "user" even when it, not you, denied it (a timeout, a turn ending).
  assert.equal(describe(ev("gate.denied", { gate: "G-3", tool: "Bash", by: "nobody answered within the hour" }, "user")).text, "Bash denied (Gate G-3) · nobody answered within the hour");
  assert.equal(describe(ev("gate.denied", { gate: "G-4", tool: "Bash", by: "user" }, "user")).text, "You denied Bash (Gate G-4)");
  assert.equal(describe(ev("gate.allowed", { tool: "Read", by: "quiet read" })).text, "Read ran without asking · quiet read");
  assert.equal(describe(ev("gate.denied", { tool: "Bash", by: "the Spec ended" })).text, "Bash denied · the Spec ended");
  assert.equal(describe(ev("turn.failed", { limit: { provider: "claude-code", resetsAt: null } })).text, "Turn stopped: claude-code hit its usage limit");
  assert.equal(describe(ev("spec.done", { spec: "S-0001", files: 2 })).text, "S-0001 finished · 2 files");
  assert.equal(describe(ev("checkpoint.undone", { turn: "T-9", files: ["a", "b", "c"] }, "user")).text, "You undid T-9 · 3 files");
  assert.equal(describe(ev("sandbox.refused", { reason: "Landlock missing" })).text, "Refused to run: the sandbox is not verified (Landlock missing)");
  assert.equal(describe(ev("turn.started", { prompt: "x".repeat(200) }, "user")).text.length < 110, true, "a long prompt is shortened");
  assert.equal(describe(ev("acp.install.started", { name: "agent" })).text, "Artifact install started · agent", "unknown sentences fall back to the label");
});
