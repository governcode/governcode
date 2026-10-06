// "At this pace": from a usage window's recent readings, how fast it is rising and whether, at that
// pace, it would reach the reserve before the window resets. Only what was measured is used: the
// readings govd took since it started (kept in memory, never written down), within the window's
// current period. With too little to go on, there is no forecast rather than a guess.

export type Point = { at: number; used: number; resetsAt: string | null };
export type Forecast = { window: string; perHour: number; reachesReserveAt: string | null; resetsFirst: boolean; since: string };

/** Readings older than this say little about the pace now. */
export const PACE_SPAN_MS = 6 * 3_600_000;
/** Two readings closer than this are too near to tell a pace from noise. */
export const MIN_SPAN_MS = 20 * 60_000;

export function forecast(window: string, points: readonly Point[], reservePercent: number, now: number): Forecast | null {
  const last = points.at(-1);
  if (!last) return null;
  // The current period only: a window that reset has a new resetsAt, and its old readings do not count.
  const period = points.filter((p) => p.resetsAt === last.resetsAt && p.at >= now - PACE_SPAN_MS && p.at <= now);
  const first = period[0];
  if (!first || last.at - first.at < MIN_SPAN_MS) return null;
  const perHour = Math.max(0, (last.used - first.used) / ((last.at - first.at) / 3_600_000));
  const base = { window, perHour: Math.round(perHour * 10) / 10, since: new Date(first.at).toISOString() };
  const left = 100 - reservePercent - last.used;
  const reset = last.resetsAt === null ? NaN : Date.parse(last.resetsAt);
  if (perHour <= 0 || left <= 0) return { ...base, reachesReserveAt: null, resetsFirst: perHour <= 0 && Number.isFinite(reset) };
  const reaches = last.at + (left / perHour) * 3_600_000;
  if (Number.isFinite(reset) && reaches >= reset) return { ...base, reachesReserveAt: null, resetsFirst: true };
  return { ...base, reachesReserveAt: new Date(reaches).toISOString(), resetsFirst: false };
}
