// The Crew board, from the Trace alone: the Controller's latest turn, the subagents it started,
// each Spec of that turn (and any still running) with its Runner's latest step, and the Gates
// waiting on the user. No Node or Electron here: the renderer and the tests share it.
import type { TraceEvent } from "./contract.ts";

export type BoardSpec = { id: string; to: string; brief: string; status: string; lastStep: string | null; gates: string[] };
export type Board = {
  controller: { provider: string; working: boolean; since: string; gates: string[] } | null;
  subagents: Array<{ what: string; at: string }>;
  specs: BoardSpec[];
};

type SpecLike = { id: string; to: string; brief: string; status: string };
type GateLike = { id: string; tool: string };

export function buildBoard(events: TraceEvent[], specs: SpecLike[], gates: GateLike[]): Board {
  const start = events.map((e) => e.kind).lastIndexOf("turn.started");
  const turn = start >= 0 ? events.slice(start) : [];
  const ended = turn.find((e) => e.kind === "turn.completed" || e.kind === "turn.failed");
  const runnerGate = (g: GateLike) => /\(Runner · [^,]+, (S-\d+)\)$/.exec(g.tool)?.[1] ?? null;
  const controller = start >= 0 ? {
    provider: String((events[start].data.controller as { provider?: string } | undefined)?.provider ?? "?"),
    working: !ended, since: (ended ?? events[start]).ts,
    gates: gates.filter((g) => !runnerGate(g)).map((g) => g.id),
  } : null;
  const subagents = turn.filter((e) => e.kind === "turn.tool" && typeof e.data.subagent === "string")
    .map((e) => ({ what: String(e.data.subagent) || "(no description)", at: e.ts }));
  const ids = new Set(turn.filter((e) => e.kind === "spec.created").map((e) => String(e.data.spec)));
  for (const s of specs) if (s.status === "running" || s.status === "queued") ids.add(s.id);
  const lastStep = new Map<string, string>();
  for (const e of events) if (e.kind === "spec.step") lastStep.set(String(e.data.spec), String(e.data.name));
  const board: BoardSpec[] = specs.filter((s) => ids.has(s.id)).map((s) => ({ id: s.id, to: s.to, brief: s.brief, status: s.status,
    lastStep: lastStep.get(s.id) ?? null, gates: gates.filter((g) => runnerGate(g) === s.id).map((g) => g.id) }));
  return { controller, subagents, specs: board };
}
