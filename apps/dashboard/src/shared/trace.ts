// The Trace as the Dashboard shows it: a short plain label per event kind, and a one-line summary.
// The raw kind stays what the filters, the search and `gov trace --jsonl` use; the screen shows it
// as the label's tooltip. No Node or Electron here: the renderer and the tests share it.
import type { TraceEvent as ProtocolTraceEvent } from "@governcode/protocol";
import type { TraceEvent } from "./contract.ts";

/** One label for every kind the protocol lists (the type checks that none is missing). */
export const KIND_LABEL: Record<ProtocolTraceEvent["kind"], string> = {
  "project.created": "Project created", "project.opened": "Project opened", "project.proposed": "Project proposed",
  "project.declined": "Project declined", "controller.set": "Controller chosen", "settings.changed": "Settings changed",
  "allow.added": "Allow remembered", "allow.revoked": "Allow revoked",
  "turn.started": "Turn started", "turn.text": "Turn text", "turn.tool": "Turn step", "turn.completed": "Turn done", "turn.failed": "Turn failed",
  "gate.opened": "Gate opened", "gate.allowed": "Gate allowed", "gate.denied": "Gate denied", "sandbox.refused": "Sandbox refused",
  "git.scrubbed": ".git restored", "git.guard_failed": ".git guard failed", "conversation.reset": "New conversation",
  "checkpoint.taken": "Checkpoint taken", "checkpoint.failed": "Checkpoint failed", "checkpoint.undone": "Checkpoint undone",
  "spec.created": "Spec created", "spec.held": "Spec held", "spec.started": "Spec started", "spec.done": "Spec done",
  "spec.failed": "Spec failed", "spec.accepted": "Spec accepted", "spec.discarded": "Spec discarded",
  "spec.undone": "Spec discarded",   // what older records call a discarded Spec
  "tool.connected": "Tool connected", "tool.disconnected": "Tool disconnected", "notes.updated": "Notes updated",
  "context.shared": "Context shared", "crew.set": "Crew card saved", "plan.proposed": "Plan proposed", "plan.answered": "Plan answered",
  "spec.step": "Spec step",
};

/** The event's label; a kind this Dashboard does not know reads as itself. */
export function eventLabel(e: Pick<TraceEvent, "kind" | "data">): string {
  if (e.kind === "context.shared" && e.data?.share === false) return "Context not shared";
  return Object.hasOwn(KIND_LABEL, e.kind) ? KIND_LABEL[e.kind as ProtocolTraceEvent["kind"]] : e.kind;
}

/** One line: the Gate, Spec or id it is about, then its text, else its other fields (empty ones left out). */
export function summary(e: TraceEvent): string {
  const d = e.data ?? {};
  const pick = d.text ?? d.summary ?? d.prompt ?? d.note ?? d.reason ?? d.brief ?? d.name ?? d.tool ?? null;
  const tag = [d.gate, d.id, d.spec].filter((x) => typeof x === "string").join(" ");
  const rest = Object.entries(d).filter(([k, v]) => !["gate", "id", "spec"].includes(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
  const text = pick === null ? rest : String(pick);
  return `${tag ? tag + "  " : ""}${text}`.replace(/\s+/g, " ").slice(0, 240);
}
