// Watch: what is happening right now, from the Trace alone. Each project's Controller turn still
// running, each Runner at work with its latest step, and today's totals. No Node or Electron here:
// the renderer and the tests share it.
import type { TraceEvent } from "./contract.ts";

type SpecLike = { id: string; project: string; status: string; to: string; brief: string };
export type WatchTurn = { project: string | null; provider: string; prompt: string; origin: string | null; since: string; lastStep: string | null };
export type WatchRunner = { id: string; project: string; to: string; brief: string; status: string; since: string | null; lastStep: string | null };
export type WatchToday = { turns: number; specsFinished: number; answeredByYou: number; letThrough: number };

const oneLine = (v: unknown, n = 140) => { const t = String(v ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const sameDay = (iso: string, now: Date) => { const d = new Date(iso); return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate(); };

export function buildWatch(events: readonly TraceEvent[], specs: readonly SpecLike[], now = new Date()) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  // A turn runs from its turn.started until a turn.completed or turn.failed in the same project.
  const open = new Map<string, { start: TraceEvent; lastStep: string | null }>();
  for (const e of ordered) {
    const key = e.project ?? "";
    if (e.kind === "turn.started") open.set(key, { start: e, lastStep: null });
    else if (e.kind === "turn.completed" || e.kind === "turn.failed") open.delete(key);
    else if (e.kind === "turn.tool" && open.has(key)) open.get(key)!.lastStep = oneLine(e.data.subagent ? `subagent: ${e.data.subagent}` : e.data.name, 100);
    else if (e.kind === "turn.text" && open.has(key)) open.get(key)!.lastStep = `“${oneLine(e.data.text, 120)}”`;
  }
  const turns: WatchTurn[] = [...open.values()].map(({ start, lastStep }) => ({
    project: start.project, provider: String((start.data.controller as { provider?: unknown } | undefined)?.provider ?? start.actor),
    prompt: oneLine(start.data.prompt, 200), origin: typeof start.data.origin === "string" ? start.data.origin : null, since: start.ts, lastStep,
  }));
  const started = new Map<string, string>(), step = new Map<string, string>();
  for (const e of ordered) {
    if (e.kind === "spec.started") started.set(String(e.data.spec), e.ts);
    if (e.kind === "spec.step") step.set(String(e.data.spec), oneLine(e.data.name, 100));
  }
  const runners: WatchRunner[] = specs.filter((s) => s.status === "running" || s.status === "queued").map((s) => ({
    id: s.id, project: s.project, to: s.to, brief: oneLine(s.brief, 160), status: s.status, since: started.get(s.id) ?? null, lastStep: step.get(s.id) ?? null,
  }));
  return { turns, runners, today: tally(ordered, now) };
}

/** Today's totals from these events alone: govd's `trace.totals` counts the same over the whole
 *  Trace, and Watch adds the events that arrive after it with this. */
export function tally(events: readonly TraceEvent[], now = new Date(), base: WatchToday = { turns: 0, specsFinished: 0, answeredByYou: 0, letThrough: 0 }): WatchToday {
  const today = { ...base };
  for (const e of events) {
    if (!sameDay(e.ts, now)) continue;
    if (e.kind === "turn.started") today.turns++;
    else if (e.kind === "spec.done") today.specsFinished++;
    else if ((e.kind === "gate.allowed" || e.kind === "gate.denied") && e.data.by === "user") today.answeredByYou++;
    else if (e.kind === "gate.allowed" && !e.data.gate) today.letThrough++;
  }
  return today;
}

/** The kinds that open and close work: Watch keeps these apart from its feed, however long ago. */
export const MARKS = ["turn.started", "turn.completed", "turn.failed", "spec.started"];

/** Two lists of events as one, each event once, oldest first. */
export function mergeEvents(a: readonly TraceEvent[], b: readonly TraceEvent[]): TraceEvent[] {
  const seen = new Map<number, TraceEvent>();
  for (const e of [...a, ...b]) seen.set(e.seq, e);
  return [...seen.values()].sort((x, y) => x.seq - y.seq);
}

/** What Watch holds: its feed, where turns and Runners began (kept apart from the feed, as a long
 *  turn's start soon leaves it), every live event as it arrived (so a totals reply can add the ones
 *  after its count), and Today from govd's count plus what came after it. */
export type WatchState = {
  events: TraceEvent[];
  marks: TraceEvent[];
  live: TraceEvent[];
  totals: { today: WatchToday; seq: number } | null;
};

/** One live event: into the feed and the marks once each, and into Today if govd's count is
 *  already in and the event came after it. (tally counts today's events only; a new day's count
 *  comes from govd again.) */
export function applyLiveEvent(state: WatchState, e: TraceEvent, keep: number, now = new Date()): WatchState {
  const has = (list: readonly TraceEvent[]) => list.some((x) => x.seq === e.seq);
  if (has(state.live)) return state;   // the same event twice: counted once, before or after govd's count
  return {
    live: [...state.live, e].slice(-keep),
    events: has(state.events) ? state.events : [...state.events, e].slice(-keep),
    marks: !MARKS.includes(e.kind) || has(state.marks) ? state.marks : [...state.marks, e].slice(-keep),
    totals: state.totals && e.seq > state.totals.seq ? { today: tally([e], now, state.totals.today), seq: e.seq } : state.totals,
  };
}

/** govd's count of today up to its `seq`, plus the live events that arrived after it, each once. */
export function combineTotals(state: WatchState, reply: { today: WatchToday; seq: number }, now = new Date()): WatchState {
  const after = state.live.filter((e) => e.seq > reply.seq);
  return { ...state, totals: { today: tally(after, now, reply.today), seq: Math.max(reply.seq, ...after.map((e) => e.seq)) } };
}
