// The renderer's side of the bridge, plus the few shapes and helpers the screens share.
import { useEffect, useRef } from "react";
import type { Callable, DashboardApi, TraceEvent, WatchEvent } from "../shared/contract.ts";
export type { TraceEvent, WatchEvent };

declare global {
  interface Window { governcode: DashboardApi }
}

export const api = (): DashboardApi => window.governcode;

/** Calls govd and throws govd's own message on failure. */
export async function call<T>(method: Callable, params?: Record<string, unknown>): Promise<T> {
  const r = await api().call<T>(method, params);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

export type Controller = { provider: string; model: string; effort: string | null };
export type Project = { name: string; path: string; created: string; controller: Controller };
export type Turn = { id: string; at: string; files: string[]; undone?: boolean };
export type Gate = { id: string; project: string | null; tool: string; canonical: string; opened: string; covers?: string | null; scopes?: string[]; suggest?: string | null };
export type SpecStatus = "queued" | "held" | "running" | "needs-review" | "accepted" | "discarded" | "failed" | "cancelled";
export type Spec = {
  id: string; project: string; status: SpecStatus; created: string; to: string; brief: string; result: string;
  scope: { read: string[]; write: string[] }; budgetPercent: number; workspace: string; model: string;
  effort: string | null; reason: string; checkpoints: { before: string | null; after: string | null };
  files: string[]; note?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");

/** Local 24-hour time; the date too when it is not today. */
export function clock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export { controllerLabel, dotted, modelLabel, personalKey } from "../shared/labels.ts";

export const START_GOVD = "node packages/gov/src/main.ts daemon start";

/** When govd offers `watch`, screens update from its stream; otherwise they poll this slowly. */
export const FALLBACK_POLL_MS = 10_000;

const watchers = new Set<(w: WatchEvent) => void>();
let bridged = false;

/** Runs `f` for every event on govd's live stream while the component is mounted. */
export function useWatch(f: (w: WatchEvent) => void): void {
  const latest = useRef(f);
  latest.current = f;
  useEffect(() => {
    if (!bridged) { bridged = true; api().onWatch((w) => { for (const g of watchers) g(w); }); }
    const g = (w: WatchEvent) => latest.current(w);
    watchers.add(g);
    return () => { watchers.delete(g); };
  }, []);
}

/** Polls `f` only when there is no live stream to update from. */
export function useFallbackPoll(live: boolean, f: () => void): void {
  useEffect(() => {
    if (live) return;
    const t = setInterval(f, FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [live, f]);
}

export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
