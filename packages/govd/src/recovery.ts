// Usage-limit recovery is a projection of Specs and the Trace. Nothing here schedules work:
// callers use the public item for display, and `guarded` to avoid running one choice twice.
import type { Spec, TraceEvent } from "@governcode/protocol";
import type { Ledger } from "./ledger.ts";

export type RecoveryItem = {
  target: string;
  project: string;
  kind: "held" | "spec" | "turn";
  provider: string;
  resetsAt: string | null;
  since: string;
  why: string;
  atReset: boolean;
  due: boolean;
  note?: string;
};

/** `guarded` means a recovery.resumed was written after the current at-reset choice. */
export type RecoveryState = { item: RecoveryItem; guarded: boolean; choiceSeq: number | null };
export type RunningSpecs = { has(id: string): boolean };

// Read whole: few of them (one per Spec state change or choice). Turn events are read only from the
// project's latest turn on (only it can be continued), so a sweep never reads all of history.
const SPEC_KINDS: TraceEvent["kind"][] = ["spec.held", "spec.failed", "recovery.set", "recovery.resumed", "recovery.cleared"];
const TURN_KINDS: TraceEvent["kind"][] = ["turn.started", "turn.completed", "turn.failed", "conversation.reset", "controller.set"];

const targetOf = (e: TraceEvent): string => String(e.data.target ?? "");
const resetOf = (e: TraceEvent): string | null | undefined =>
  e.data.resetsAt === null || typeof e.data.resetsAt === "string" ? e.data.resetsAt : undefined;
const isDue = (resetsAt: string | null, atReset: boolean, now: Date): boolean => {
  const reset = resetsAt === null ? NaN : Date.parse(resetsAt);
  return atReset && Number.isFinite(reset) && reset <= now.getTime();
};

function choiceOf(events: TraceEvent[], target: string, resetsAt: string | null, sinceSeq: number, since: string):
    { atReset: boolean; seq: number | null } {
  const choices = events.filter((e) => e.kind === "recovery.set" && targetOf(e) === target && resetOf(e) === resetsAt
    && (sinceSeq ? e.seq > sinceSeq : e.ts >= since));
  const choice = choices.at(-1);
  return { atReset: choice?.data.atReset === true, seq: choice?.seq ?? null };
}

function wasCleared(events: TraceEvent[], target: string, sinceSeq: number, since: string): boolean {
  return events.some((e) => e.kind === "recovery.cleared" && targetOf(e) === target
    && (sinceSeq ? e.seq > sinceSeq : e.ts >= since));
}

function stateOf(item: Omit<RecoveryItem, "atReset" | "due">, events: TraceEvent[], sinceSeq: number, now: Date): RecoveryState {
  const choice = choiceOf(events, item.target, item.resetsAt, sinceSeq, item.since);
  const guarded = choice.seq !== null && events.some((e) => e.kind === "recovery.resumed"
    && targetOf(e) === item.target && e.seq > choice.seq!);
  return { item: { ...item, atReset: choice.atReset, due: isDue(item.resetsAt, choice.atReset, now) }, guarded, choiceSeq: choice.seq };
}

/** Derive recovery state from already-read projections. Inputs are not changed. */
export function deriveRecoveryStates(specs: readonly Spec[], events: readonly TraceEvent[],
    running: RunningSpecs = new Set(), now = new Date()): RecoveryState[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const out: RecoveryState[] = [];

  for (const spec of specs) {
    if (running.has(spec.id) || !spec.limited || (spec.status !== "held" && spec.status !== "failed")) continue;
    const transition = ordered.filter((e) => e.project === spec.project && e.data.spec === spec.id
      && e.kind === (spec.status === "held" ? "spec.held" : "spec.failed")).at(-1);
    // A Runner-limited failed Spec that is retried but still held stays failed, so it has no new
    // spec.failed event. Its recovery.resumed is the boundary of the new limited episode: an old
    // choice or clear must not carry across it.
    const retried = ordered.filter((e) => e.kind === "recovery.resumed" && targetOf(e) === spec.id && e.ts <= spec.limited!.at).at(-1);
    const sinceSeq = Math.max(transition?.seq ?? 0, retried?.seq ?? 0);
    if (wasCleared(ordered, spec.id, sinceSeq, spec.limited.at)) continue;
    out.push(stateOf({ target: spec.id, project: spec.project, kind: spec.status === "held" ? "held" : "spec",
      provider: spec.to, resetsAt: spec.limited.resetsAt, since: spec.limited.at, why: spec.limited.why },
    ordered, sinceSeq, now));
  }

  const projects = new Set(specs.map((s) => s.project));
  for (const e of ordered) if (e.project !== null) projects.add(e.project);
  for (const project of projects) {
    const projectEvents = ordered.filter((e) => e.project === project);
    const started = projectEvents.filter((e) => e.kind === "turn.started").at(-1);
    if (!started) continue;
    if (projectEvents.some((e) => e.seq > started.seq && (e.kind === "conversation.reset" || e.kind === "controller.set"))) continue;
    const ended = projectEvents.filter((e) => e.seq > started.seq && (e.kind === "turn.completed" || e.kind === "turn.failed")).at(-1);
    if (!ended || ended.kind !== "turn.failed") continue;
    const limit = ended.data.limit as { provider?: unknown; resetsAt?: unknown } | undefined;
    if (!limit || typeof limit.provider !== "string" || !(limit.resetsAt === null || typeof limit.resetsAt === "string")) continue;
    const target = `T-${started.seq}`;
    if (typeof ended.data.turn === "string" && ended.data.turn !== target) continue;
    if (wasCleared(projectEvents, target, ended.seq, ended.ts)) continue;
    out.push(stateOf({ target, project, kind: "turn", provider: limit.provider, resetsAt: limit.resetsAt,
      since: ended.ts, why: String(ended.data.summary ?? `${limit.provider} hit its usage limit`) }, projectEvents, ended.seq, now));
  }

  return out.sort((a, b) => a.item.since.localeCompare(b.item.since) || a.item.target.localeCompare(b.item.target));
}

/** Read the current recovery projection, optionally for one project. */
export function recoveryStates(L: Ledger, options: { project?: string; running?: RunningSpecs; now?: Date } = {}): RecoveryState[] {
  const specs = L.specs(options.project);
  const projects = options.project ? [options.project] : L.projects().map((p) => p.name);
  const events = projects.flatMap((project) => {
    const latest = L.eventsOfKind(project, ["turn.started"], 1).at(-1);
    return [...L.eventsOfKind(project, SPEC_KINDS, 2_147_483_647),
      ...(latest ? L.eventsOfKindIn(project, TURN_KINDS, latest.seq - 1, Number.MAX_SAFE_INTEGER, 2_147_483_647, true) : [])];
  });
  return deriveRecoveryStates(specs, events, options.running, options.now);
}

export function recoveryState(L: Ledger, target: string, options: { running?: RunningSpecs; now?: Date } = {}): RecoveryState | undefined {
  return recoveryStates(L, options).find((state) => state.item.target === target);
}
