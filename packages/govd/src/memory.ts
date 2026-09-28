// Project memory (design 2026-09-28): what a Controller knows about a project, owned by
// GovernCode, so any Controller can pick up where another left off. Three layers, all in the
// Trace: the recent conversation (daemon.ts), the project record (built here from the Trace,
// no AI), and the project notes (a short brief the Controller keeps with project_notes, and the
// user reads, edits and rolls back). Everything goes into the user's message as information,
// never into the system prompt.
import type { Ledger } from "./ledger.ts";

export const NOTES_MAX = 4000;

/** The project's current notes, and who last changed them. */
export function notesOf(L: Ledger, project: string): { text: string; seq: number | null; actor: string | null } {
  const last = L.eventsOfKind(project, ["notes.updated"], 1).at(-1);
  return last ? { text: String(last.data.text ?? ""), seq: last.seq, actor: last.actor } : { text: "", seq: null, actor: null };
}

/** Every version of the notes, newest last (the Trace keeps them all). */
export function notesHistory(L: Ledger, project: string, limit = 50) {   // every version stays in the Trace
  return L.eventsOfKind(project, ["notes.updated"], limit)
    .map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, text: String(e.data.text ?? "") }));
}

export function setNotes(L: Ledger, project: string, text: string, actor: string): { chars: number } {
  if (text.length > NOTES_MAX) throw new Error(`the notes are limited to ${NOTES_MAX} characters (${text.length} given); keep them short`);
  L.append(project, "notes.updated", actor, { text });
  return { chars: text.length };
}

/** The project record, from the Trace alone: recent Specs, Checkpoints and standing rules,
 *  trimmed item by item (oldest first) to fit the budget, so it is always valid JSON. */
export function projectRecord(L: Ledger, project: string, rules: string[], budget = 4000): string {
  const specs = L.recentSpecs(project, 15).map((s) => ({ id: s.id, runner: s.to, brief: s.brief.slice(0, 200), status: s.status,
    files: s.files.slice(0, 10), ...(s.note ? { note: String(s.note).slice(0, 200) } : {}) }));
  const cp = L.eventsOfKind(project, ["checkpoint.taken", "checkpoint.undone"], 200);
  const undone = new Set(cp.filter((e) => e.kind === "checkpoint.undone").map((e) => e.data.turn));
  const checkpoints = cp.filter((e) => e.kind === "checkpoint.taken").slice(-8)
    .map((e) => ({ turn: e.data.turn, at: e.ts, files: (e.data.files as string[] ?? []).slice(0, 10), ...(undone.has(e.data.turn) ? { undone: true } : {}) }));
  const allowed = rules.slice(0, 20).map((r) => r.slice(0, 200));
  if (!specs.length && !checkpoints.length && !allowed.length) return "";
  const rec = { specs, checkpoints, allowedForThisProject: allowed };
  let out = JSON.stringify(rec, null, 1);
  while (out.length > budget && (rec.specs.length || rec.checkpoints.length || rec.allowedForThisProject.length)) {
    if (rec.specs.length) rec.specs.shift(); else if (rec.checkpoints.length) rec.checkpoints.shift(); else rec.allowedForThisProject.pop();
    out = JSON.stringify(rec, null, 1);
  }
  return out;
}

/** Providers whose turns this project has had, and the user's latest answer for each. */
export function contextState(L: Ledger, project: string): { providers: string[]; shared: Record<string, boolean> } {
  return { providers: L.turnProviders(project), shared: L.latestShares(project) };
}

/** May this provider see the project's context (conversation, record, notes, earlier Specs)? Yes
 *  when it is the only provider the project has used, or when the user's latest answer is yes. */
export function mayShare(L: Ledger, project: string, provider: string): boolean {
  const { providers, shared } = contextState(L, project);
  if (shared[provider] !== undefined) return shared[provider];
  return providers.every((p) => p === provider);
}
