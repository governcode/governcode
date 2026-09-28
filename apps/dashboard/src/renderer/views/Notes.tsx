// Notes: the project's short brief (goal, decisions, open questions, next steps). The Controller
// keeps it with project_notes; every Controller of the project reads it first, so switching
// Controllers does not lose the story. Every version is kept in the Trace: edit, or restore one.
import { useCallback, useEffect, useState } from "react";
import { call, clock, useWatch } from "../api.ts";
import { Empty, Pill } from "../ui.tsx";

type Version = { seq: number; ts: string; actor: string; text: string };
const MAX = 4000;

export function Notes({ project }: { project: string | null }) {
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<Version[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const r = await call<{ text: string; history: Version[] }>("notes.get", { project });
      setSaved(r.text); setDraft((d) => (d === saved ? r.text : d)); setHistory([...r.history].reverse());
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  }, [project, saved]);
  useEffect(() => { setDraft(""); setSaved(""); setOpen(null); }, [project]);
  useEffect(() => { void load(); }, [load]);
  useWatch((w) => { if (w.kind === "trace" && w.event.project === project && w.event.kind === "notes.updated") void load(); });

  const save = async (text: string, note: string) => {
    if (!project) return;
    try { await call("notes.set", { project, text }); setSaved(text); setDraft(text); setMsg({ ok: true, text: note }); await load(); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  const dirty = draft !== saved;

  return (
    <section className="view">
      <div className="view-head"><h1>Notes</h1><span className="dim">{project ? `what every Controller of ${project} reads first` : "notes belong to a project"}</span></div>
      {!project ? <Empty title="No project selected"><p className="dim">Pick a project above.</p></Empty> : (
        <div className="scroll settings">
          <p className="dim small">The Controller keeps these current (goal, decisions, open questions, next steps). If you switch to a Controller from another provider and choose to share, it starts here. You can edit them; every version is kept in the Trace, and the latest 50 are listed below. They stay in GovernCode, never in your repository. Don't put secrets in them.</p>
          <textarea className="notes mono" value={draft} rows={14} maxLength={MAX} aria-label="project notes"
            placeholder="No notes yet. The Controller writes them as it works, or write your own." onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <button className="btn btn-accent" disabled={!dirty} onClick={() => save(draft, "Saved.")}>Save</button>
            {dirty && <button className="btn" onClick={() => setDraft(saved)}>Discard changes</button>}
            <span className="dim small">{draft.length} / {MAX}</span>
            {msg && <span className={msg.ok ? "ok small" : "error small"}>{msg.text}</span>}
          </div>

          <h2>Versions</h2>
          {!history.length && <p className="dim small">None yet.</p>}
          {history.map((v, i) => (
            <div key={v.seq} className="checkpoint">
              <div className="row">
                <span className="mono small">{clock(v.ts)}</span>
                <Pill tone={v.actor === "user" ? "info" : "accent"}>{v.actor === "user" ? "you" : v.actor}</Pill>
                <span className="dim small">{v.text.length} chars</span>
                <span className="spacer" />
                {i === 0 ? <span className="dim small">current</span> : <>
                  <button className="btn" onClick={() => setOpen(open === v.seq ? null : v.seq)}>{open === v.seq ? "Hide" : "Show"}</button>
                  <button className="btn" onClick={() => save(v.text, `Restored the version from ${clock(v.ts)}.`)}>Restore</button>
                </>}
              </div>
              {open === v.seq && <pre className="mono small">{v.text || "(empty)"}</pre>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
