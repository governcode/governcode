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
  "recovery.set": "Resume set", "recovery.resumed": "Resumed", "recovery.cleared": "Resume cleared",
  "acp.install.started": "Artifact install started", "acp.install.completed": "Artifact stored",
  "acp.install.failed": "Artifact install failed", "acp.install.interrupted": "Artifact install interrupted",
  "tool.connected": "Tool connected", "tool.disconnected": "Tool disconnected", "notes.updated": "Notes updated",
  "context.shared": "Context shared", "crew.set": "Crew card saved", "plan.proposed": "Plan proposed", "plan.answered": "Plan answered",
  "spec.step": "Spec step", "spec.cancel": "Cancel asked", "spec.cancelled": "Spec cancelled", "spec.followup": "Spec follow-up",
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

export type Tone = "" | "ok" | "warn" | "danger" | "info" | "held" | "accent";
export type Described = { text: string; tone: Tone; icon: string };

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const quote = (v: unknown, n = 90): string => { const t = str(v).replace(/\s+/g, " ").trim(); return t.length > n ? `“${t.slice(0, n - 1)}…”` : `“${t}”`; };
const files = (v: unknown): string => { const n = Array.isArray(v) ? v.length : typeof v === "number" ? v : null; return n === null ? "" : ` · ${n} file${n === 1 ? "" : "s"}`; };

/**
 * One event as a short sentence for the timeline, from what govd records for its kind. Anything
 * not recorded is left out, never guessed; a kind without a sentence reads as its label and summary.
 */
export function describe(e: TraceEvent): Described {
  const d = e.data ?? {};
  const you = e.actor === "user";
  const spec = str(d.spec);
  switch (e.kind) {
    case "gate.opened": return { text: `Gate ${str(d.gate)} opened · ${e.actor} wants ${str(d.tool)}`, tone: "warn", icon: "lock" };
    case "gate.allowed": return you
      ? { text: `You allowed ${str(d.tool)}${d.gate ? ` (Gate ${str(d.gate)})` : ""}${d.by ? ` · ${str(d.by)}` : ""}`, tone: "ok", icon: "check" }
      : { text: `${str(d.tool)} ran without asking · ${str(d.by)}`, tone: "", icon: "check" };
    case "gate.denied": return you
      ? { text: `You denied ${str(d.tool)}${d.gate ? ` (Gate ${str(d.gate)})` : ""}`, tone: "danger", icon: "x" }
      : { text: `${str(d.tool)} denied · ${str(d.by)}`, tone: "danger", icon: "x" };
    case "turn.started":
      if (d.origin === "wake") return { text: "GovernCode started a turn to report finished Specs", tone: "accent", icon: "sparkle" };
      if (d.origin === "continuation") return { text: `GovernCode continued ${str(d.continuationOf)} after its usage limit reset`, tone: "accent", icon: "play" };
      return { text: `${you ? "You asked" : `${e.actor} asked`}: ${quote(d.prompt)}`, tone: "", icon: "chat" };
    case "turn.completed": return { text: "Turn finished", tone: "ok", icon: "check" };
    case "turn.failed": {
      const limit = d.limit as { provider?: unknown } | undefined;
      return limit ? { text: `Turn stopped: ${str(limit.provider)} hit its usage limit`, tone: "held", icon: "hourglass" }
        : { text: `Turn failed${d.summary ? ` · ${str(d.summary)}` : ""}`, tone: "danger", icon: "x" };
    }
    case "spec.created": return { text: `${spec} handed to ${str(d.to)}${d.reason ? ` · ${str(d.reason)}` : ""}`, tone: "info", icon: "layers" };
    case "spec.started": return { text: `${spec} started`, tone: "info", icon: "play" };
    case "spec.done": return { text: `${spec} finished${files(d.files)}`, tone: "info", icon: "branch" };
    case "spec.held": return { text: `${spec} held${d.note ? ` · ${str(d.note)}` : ""}`, tone: "held", icon: "hourglass" };
    case "spec.failed": return { text: `${spec} failed${d.note ? ` · ${str(d.note)}` : ""}`, tone: "danger", icon: "x" };
    case "spec.accepted": return { text: `${you ? "You applied" : "Applied"} ${spec} to the project${files(d.files)}`, tone: "ok", icon: "check" };
    case "spec.discarded": case "spec.undone": return { text: `${you ? "You discarded" : "Discarded"} ${spec}`, tone: "", icon: "x" };
    case "spec.cancel": return { text: `Cancel asked for ${spec}`, tone: "", icon: "x" };
    case "spec.cancelled": return { text: `${spec} cancelled`, tone: "", icon: "x" };
    case "spec.followup": return { text: `Follow-up for ${spec}: ${quote(d.message)}`, tone: "info", icon: "chat" };
    case "checkpoint.taken": return { text: `Checkpoint for ${str(d.turn)}${files(d.files)}`, tone: "", icon: "undo" };
    case "checkpoint.undone": return { text: `You undid ${str(d.turn)}${files(d.files)}`, tone: "warn", icon: "undo" };
    case "checkpoint.failed": return { text: `No Checkpoint for ${str(d.turn)}${d.reason ? ` · ${str(d.reason)}` : ""}`, tone: "warn", icon: "undo" };
    case "sandbox.refused": return { text: `Refused to run: the sandbox is not verified${d.reason ? ` (${str(d.reason)})` : ""}`, tone: "danger", icon: "shieldX" };
    case "recovery.set": return { text: `${d.atReset ? "Resume at reset on" : "Resume at reset off"} for ${str(d.target)}${you ? "" : " (Settings default)"}`, tone: "held", icon: "clock" };
    case "recovery.resumed": return { text: `${str(d.target)} resumed${e.actor === "govd" ? " at its reset" : " by you"}`, tone: "info", icon: "play" };
    case "recovery.cleared": return { text: `You forgot the recovery choice for ${str(d.target)}`, tone: "", icon: "x" };
    case "allow.added": return { text: `Remembered: allow ${str(d.label || d.key)} for ${str(d.scope)}`, tone: "ok", icon: "check" };
    case "allow.revoked": return { text: `Revoked the allow for ${str(d.key)}`, tone: "", icon: "x" };
    case "crew.set": return { text: "Crew card saved", tone: "", icon: "people" };
    case "notes.updated": return { text: `Notes updated${you ? " by you" : ""}`, tone: "", icon: "note" };
    case "controller.set": return { text: `Controller set to ${str(d.provider)}${d.model ? ` · ${str(d.model)}` : ""}`, tone: "accent", icon: "people" };
    case "project.created": return { text: "Project created", tone: "accent", icon: "plus" };
    case "conversation.reset": return { text: "New conversation", tone: "", icon: "chat" };
    default: return { text: `${eventLabel(e)}${summary(e) ? ` · ${summary(e)}` : ""}`, tone: "", icon: "clock" };
  }
}
