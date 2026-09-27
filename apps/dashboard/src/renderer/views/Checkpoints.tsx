// Checkpoints: each Controller turn that changed the project, newest first, with its files
// and an Undo that restores exactly those files (govd refuses if any changed since).
import { useCallback, useEffect, useState } from "react";
import { call, clock, useFallbackPoll, useWatch, type Turn } from "../api.ts";
import { Empty, Pill, UndoCheckpoint } from "../ui.tsx";

export function Checkpoints({ project, live }: { project: string | null; live: boolean }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    if (!project) return;
    try {
      setTurns([...(await call<{ turns: Turn[] }>("turn.list", { project })).turns].reverse());
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [project]);

  useEffect(() => { void load(); }, [load]);
  useFallbackPoll(live || !project, load);
  useWatch((w) => {
    if (w.kind === "trace" && w.event.project === project && w.event.kind.startsWith("checkpoint.")) void load();
  });

  return (
    <section className="view">
      <div className="view-head">
        <h1>Checkpoints</h1>
        <span className="dim">{project ? `Controller turns that changed ${project}` : "Checkpoints belong to a project"}</span>
        <span className="spacer" />
        {project && <button className="btn" onClick={load}>Refresh</button>}
      </div>
      {error && <div className="error pad">{error}</div>}
      {!project ? <Empty title="No project selected"><p className="dim">Home turns cannot write anything, so they have no Checkpoints. Pick a project above.</p></Empty>
        : turns && !turns.length ? <Empty title="No Checkpoints yet"><p className="dim">When a Controller turn changes files in {project}, it is recorded here and can be undone.</p></Empty>
        : (
          <div className="scroll">
            {turns?.map((t) => (
              <div key={t.id} className="checkpoint">
                <div className="row">
                  <b className="mono">{t.id}</b>
                  <span className="dim mono">{clock(t.at)}</span>
                  <span className="dim">{t.files.length} file{t.files.length === 1 ? "" : "s"}</span>
                  <span className="spacer" />
                  {t.undone || restored[t.id] ? <Pill tone="dim">undone</Pill>
                    : <UndoCheckpoint id={t.id} files={t.files} onUndone={(r) => { setRestored((m) => ({ ...m, [t.id]: r })); void load(); }} />}
                </div>
                <div className="mono small files">{t.files.join("  ")}</div>
                {restored[t.id] && <div className="ok small">Restored {restored[t.id].length} file(s): {restored[t.id].join(", ")}</div>}
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
