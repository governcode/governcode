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
export function notesHistory(L: Ledger, project: string, limit = 50) {
  return L.eventsOfKind(project, ["notes.updated"], limit)
    .map((e) => ({ seq: e.seq, ts: e.ts, actor: e.actor, text: String(e.data.text ?? "") }));
}

export function setNotes(L: Ledger, project: string, text: string, actor: string): { chars: number } {
  if (text.length > NOTES_MAX) throw new Error(`the notes are limited to ${NOTES_MAX} characters (${text.length} given); keep them short`);
  L.append(project, "notes.updated", actor, { text });
  return { chars: text.length };
}

/** The project record, from the Trace alone: recent Specs, Checkpoints and standing rules. */
export function projectRecord(L: Ledger, project: string, rules: string[]): string {
  const specs = L.specs(project).slice(-15).map((s) => ({ id: s.id, runner: s.to, brief: s.brief.slice(0, 200), status: s.status,
    files: s.files.slice(0, 10), ...(s.note ? { note: String(s.note).slice(0, 200) } : {}) }));
  const cp = L.eventsOfKind(project, ["checkpoint.taken", "checkpoint.undone"], 200);
  const undone = new Set(cp.filter((e) => e.kind === "checkpoint.undone").map((e) => e.data.turn));
  const turns = cp.filter((e) => e.kind === "checkpoint.taken").slice(-8)
    .map((e) => ({ turn: e.data.turn, at: e.ts, files: (e.data.files as string[] ?? []).slice(0, 10), ...(undone.has(e.data.turn) ? { undone: true } : {}) }));
  if (!specs.length && !turns.length && !rules.length) return "";
  return JSON.stringify({ specs, checkpoints: turns, allowedForThisProject: rules.slice(0, 20) }, null, 1).slice(0, 4000);
}

/** Providers whose turns this project has had, and those the user agreed may see its context. */
export function contextState(L: Ledger, project: string): { providers: string[]; shared: Record<string, boolean> } {
  const turns = L.eventsOfKind(project, ["turn.started"], 2000);
  const providers = [...new Set(turns.map((e) => String((e.data.controller as { provider?: string })?.provider ?? "")).filter(Boolean))];
  const shared: Record<string, boolean> = {};
  for (const e of L.eventsOfKind(project, ["context.shared"], 200)) shared[String(e.data.provider)] = e.data.share === true;
  return { providers, shared };
}

/** May this provider see the project's context (conversation, record, notes)? Yes when it is the
 *  only provider the project has used, or when the user said yes for it. */
export function mayShare(L: Ledger, project: string, provider: string): boolean {
  const { providers, shared } = contextState(L, project);
  if (shared[provider] !== undefined) return shared[provider];
  return providers.every((p) => p === provider);
}
