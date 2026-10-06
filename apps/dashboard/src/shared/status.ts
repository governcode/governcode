// What the sidebar and the Overview say about a project or a provider at a glance. Pure: the
// renderer and the tests share it. Needing you comes first, then running work, then held work.

type SpecLike = { id: string; project: string; status: string; to: string; brief: string };
type GateLike = { project: string | null };
type ReadingLike = { window: string; usedPercent: number; resetsAt: string | null; reservePercent?: number; counted?: { unit: string; used: number; cap: number } };
type LimitLike = { provider: string; unmetered: boolean; local?: unknown; reservePercent: number; reserves?: Record<string, number>; readings: ReadingLike[];
  verdict: { ok: true } | { ok: false; reason: string; resetsAt: string | null } };

export type Dot = "needs" | "running" | "held" | "failed" | null;
export type ProjectStatus = { dot: Dot; text: string; gates: number; reviews: number; running: number; held: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function projectStatus(name: string, specs: readonly SpecLike[], gates: readonly GateLike[]): ProjectStatus {
  const mine = specs.filter((s) => s.project === name);
  const g = gates.filter((x) => x.project === name).length;
  const reviews = mine.filter((s) => s.status === "needs-review").length;
  const running = mine.filter((s) => s.status === "running" || s.status === "queued");
  const held = mine.filter((s) => s.status === "held").length;
  const base = { gates: g, reviews, running: running.length, held };
  if (g) return { ...base, dot: "needs", text: `${plural(g, "Gate")} waiting for you` };
  if (reviews) return { ...base, dot: "needs", text: `${plural(reviews, "Spec")} ready for review` };
  if (running.length) {
    const one = running[0];
    return { ...base, dot: "running", text: running.length > 1 ? `${running.length} Specs running or queued`
      : one.status === "queued" ? `${one.id} is queued for ${one.to}` : `${one.to} is working on ${one.id}` };
  }
  if (held) return { ...base, dot: "held", text: `${plural(held, "Spec")} held by its Limit` };
  return { ...base, dot: null, text: "Idle" };
}

/** A Gate may be answered from a one-line row only when its whole request fits there: a single
 *  line, short enough to show in full. Anything else is answered where all of it is shown. */
export const INLINE_GATE_MAX = 140;
// Line breaks, other control characters, and invisible or direction-changing ones (zero-width,
// bidi overrides, line and paragraph separators) could hide part of a request in a one-line row.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;
export function gateFitsInline(canonical: string): boolean {
  return !HIDDEN.test(canonical) && canonical.length <= INLINE_GATE_MAX;
}

/** The window a provider is closest to its reserve in, as one number for a ring. */
/** Which AI asked for a Gate, as a provider id: the Runner named in its tool, else the project's
 *  Controller; null when neither is known (a Gate at Home, or for a project since removed). */
export function gateAsker(g: { tool: string; project: string | null }, projects: readonly { name: string; controller: { provider: string } }[]): string | null {
  const runner = /^Runner · ([^·]+)/.exec(g.tool)?.[1]?.trim();
  if (runner) return runner;
  return projects.find((x) => x.name === g.project)?.controller.provider ?? null;
}

/** What a Gate asks to use, without the Runner prefix: "Runner · codex · Bash" → "Bash". */
export const gateTool = (tool: string) => tool.replace(/^Runner · [^·]+ · /, "");

export function providerUsage(p: LimitLike): { percent: number; reserve: number; window: string | null; counted: { used: number; cap: number; unit: string } | null } {
  let best: { percent: number; reserve: number; window: string | null; counted: { used: number; cap: number; unit: string } | null } = { percent: 0, reserve: p.reservePercent, window: null, counted: null };
  let room = Infinity;
  for (const r of p.readings) {
    const reserve = r.reservePercent ?? p.reserves?.[r.window] ?? p.reservePercent;
    const left = 100 - reserve - r.usedPercent;
    if (left < room) { room = left; best = { percent: r.usedPercent, reserve, window: r.window, counted: r.counted ?? null }; }
  }
  return best;
}
