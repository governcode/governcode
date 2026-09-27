// The renderer's side of the bridge, plus the few shapes and helpers the screens share.
import type { Callable, DashboardApi } from "../shared/contract.ts";

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
export type Gate = { id: string; project: string | null; tool: string; canonical: string; opened: string };
export type SpecStatus = "queued" | "held" | "running" | "needs-review" | "accepted" | "undone" | "failed";
export type Spec = {
  id: string; project: string; status: SpecStatus; created: string; to: string; brief: string; result: string;
  scope: { read: string[]; write: string[] }; budgetPercent: number; workspace: string; model: string;
  effort: string | null; reason: string; checkpoints: { before: string | null; after: string | null };
  files: string[]; note?: string;
};
export type TraceEvent = { seq: number; ts: string; project: string | null; kind: string; actor: string; data: Record<string, unknown> };

const pad = (n: number) => String(n).padStart(2, "0");

/** Local 24-hour time; the date too when it is not today. */
export function clock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

export const controllerLabel = (c: Controller) => `${c.provider} · ${c.model} · ${c.effort ?? "n/a"}`;

export const START_GOVD = "node packages/gov/src/main.ts daemon start";
