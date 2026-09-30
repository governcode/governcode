// Crew: how this project's crew works (the Crew card, enforced by govd), and, below it, who is
// doing what right now. The card is the user's; the AI is told it and cannot change it.
import { useCallback, useEffect, useState } from "react";
import { call, clock, useWatch, type Gate, type Spec, type TraceEvent } from "../api.ts";
import { Empty, Pill, SpecPill } from "../ui.tsx";
import { buildBoard, type Board } from "../../shared/board.ts";

type Crew = { controllerWorks: boolean; handoff: "ask" | "plan" | "off"; runners: string[] | null;
  maxPercent: Record<string, number>; subagents: { controller: boolean; runners: boolean } };
const HANDOFF: Array<[Crew["handoff"], string, string]> = [
  ["ask", "Ask me each time (default)", "Each handoff to a paid Runner waits for your yes at a Gate. A local model is a kind of step you can allow for the project."],
  ["plan", "Follow the approved plan", "The Controller posts a game plan first; handoffs you approve there run without asking again. Anything not in the plan asks."],
  ["off", "Off", "The Controller works alone: no Runners for this project."],
];

/** Who is doing what right now, from the Trace: the Controller, its subagents, each Spec and its Runner. */
function CrewBoard({ project }: { project: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  const load = useCallback(async () => {
    try {
      // The latest turn's boundaries on their own (a long turn has more events than the window),
      // merged with the recent events.
      const [t, b, s, g] = await Promise.all([call<{ events: TraceEvent[] }>("trace.list", { project, limit: 400 }),
        call<{ events: TraceEvent[] }>("trace.list", { project, limit: 4, kinds: ["turn.started", "turn.completed", "turn.failed"] }),
        call<{ specs: Spec[] }>("spec.list", { project }), call<{ gates: Gate[] }>("gate.list", {})]);
      const seen = new Set(t.events.map((e) => e.seq));
      const events = [...b.events.filter((e) => !seen.has(e.seq)), ...t.events].sort((x, y) => x.seq - y.seq);
      setBoard(buildBoard(events, s.specs, g.gates.filter((x) => x.project === project)));
    } catch { /* shown by the status bar */ }
  }, [project]);
  useEffect(() => { void load(); }, [load]);
  useWatch((w) => { if (w.kind === "gates" || (w.kind === "trace" && w.event.project === project)) void load(); });
  if (!board) return null;
  const waiting = (n: number) => n ? <Pill tone="warn">{n} Gate{n === 1 ? "" : "s"} waiting</Pill> : null;
  return (
    <>
      <h2>Now</h2>
      {!board.controller && !board.specs.length ? <p className="dim small">Nothing yet: ask the Controller something in the Terminal.</p> : (
        <div className="crew-board">
          {board.controller && <div className="crew-node">
            <b>Controller</b> <span className="mono small">{board.controller.provider}</span>{" "}
            {board.controller.working ? <Pill tone="accent">working</Pill> : <span className="dim small">idle since {clock(board.controller.since)}</span>}{" "}
            {waiting(board.controller.gates.length)}
          </div>}
          {board.subagents.map((a, i) => (
            <div key={i} className="crew-node child"><span className="dim small">subagent</span> {a.what} <span className="dim small">· {clock(a.at)}</span></div>
          ))}
          {board.specs.map((s) => (
            <div key={s.id} className="crew-node child">
              <b className="mono">{s.id}</b> <span className="dim">→</span> <b>{s.to}</b> <SpecPill status={s.status as never} /> {waiting(s.gates.length)}
              <div className="dim small">{s.brief.slice(0, 160)}{s.lastStep ? ` · latest step: ${s.lastStep}` : ""}</div>
            </div>
          ))}
          {!board.specs.length && !board.subagents.length && <div className="crew-node child dim small">No subagents or Runners in this turn.</div>}
        </div>
      )}
    </>
  );
}

export function CrewView({ project }: { project: string | null }) {
  const [saved, setSaved] = useState<Crew | null>(null);
  const [draft, setDraft] = useState<Crew | null>(null);
  const [known, setKnown] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const [c, l] = await Promise.all([call<{ crew: Crew }>("crew.get", { project }), call<{ providers: Array<{ provider: string }> }>("limits.list", { measure: false })]);
      setSaved(c.crew); setDraft(c.crew); setKnown(l.providers.map((p) => p.provider));
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  }, [project]);
  useEffect(() => { void load(); }, [load]);
  useWatch((w) => { if (w.kind === "trace" && w.event.project === project && w.event.kind === "crew.set") void load(); });

  if (!project) return <section className="view"><div className="view-head"><h1>Crew</h1></div><Empty title="No project selected"><p className="dim">The Crew card belongs to a project. Pick one above.</p></Empty></section>;
  if (!draft || !saved) return <section className="view"><div className="view-head"><h1>Crew</h1></div></section>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const allowed = (r: string) => draft.runners === null || draft.runners.includes(r);
  const toggleRunner = (r: string) => setDraft((d) => {
    const list = d!.runners ?? known;
    const next = list.includes(r) ? list.filter((x) => x !== r) : [...list, r];
    return { ...d!, runners: next.length === known.length && known.every((k) => next.includes(k)) ? null : next };
  });
  const save = async () => {
    try { const r = await call<{ crew: Crew }>("crew.set", { project, crew: draft }); setSaved(r.crew); setDraft(r.crew); setMsg({ ok: true, text: "Saved. The next turn follows it." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <section className="view">
      <div className="view-head"><h1>Crew</h1><span className="dim">how {project}'s crew works · enforced by GovernCode, not asked of the AI</span></div>
      <div className="scroll settings">
        <CrewBoard project={project} />

        <h2>The Controller</h2>
        <label className="policy-option"><input type="radio" checked={draft.controllerWorks} onChange={() => setDraft({ ...draft, controllerWorks: true })} />
          <span><b>Works itself and hands off</b><span className="dim small"> · it changes the project under the usual Gates, and gives jobs to Runners.</span></span></label>
        <label className="policy-option"><input type="radio" checked={!draft.controllerWorks} onChange={() => setDraft({ ...draft, controllerWorks: false })} />
          <span><b>Plans and hands off only</b><span className="dim small"> · it reads the project, plans and gives jobs to Runners; the project is read-only for it.</span></span></label>

        <h2>Handing off</h2>
        {HANDOFF.map(([v, title, text]) => (
          <label key={v} className="policy-option"><input type="radio" checked={draft.handoff === v} onChange={() => setDraft({ ...draft, handoff: v })} />
            <span><b>{title}</b><span className="dim small"> · {text}</span></span></label>
        ))}

        {draft.handoff !== "off" && <>
          <h2>Runners</h2>
          <p className="dim small">Which Runners this project may use, and the most one job may reserve of each one's usage window.</p>
          <div className="table">
            {known.map((r) => (
              <div key={r} className="tr">
                <label className="row"><input type="checkbox" checked={allowed(r)} onChange={() => toggleRunner(r)} /><b>{r}</b></label>
                <label className="field inline"><span className="dim small">most per job</span>
                  <input type="number" min={1} max={25} value={draft.maxPercent[r] ?? ""} placeholder="25" disabled={!allowed(r)} aria-label={`${r} most per job`}
                    onChange={(e) => { const n = Math.round(Number(e.target.value)); const m = { ...draft.maxPercent }; if (!e.target.value) delete m[r]; else m[r] = Math.min(25, Math.max(1, n)); setDraft({ ...draft, maxPercent: m }); }} />
                  <span className="dim small">%</span></label>
                <span />
              </div>
            ))}
          </div>
        </>}

        <h2>Subagents</h2>
        <p className="dim small">An AI tool's own helpers: they work inside that tool's sandbox and Gates and spend its allowance, so they multiply spend.</p>
        <label className="policy-option"><input type="checkbox" checked={draft.subagents.controller} onChange={(e) => setDraft({ ...draft, subagents: { ...draft.subagents, controller: e.target.checked } })} />
          <span><b>The Controller may start subagents</b><span className="dim small"> · off: Claude Code's subagent tool is removed, and Codex's multi-agent features are switched off. Starting another AI program from a command always asks, either way.</span></span></label>
        <label className="policy-option"><input type="checkbox" checked={draft.subagents.runners} onChange={(e) => setDraft({ ...draft, subagents: { ...draft.subagents, runners: e.target.checked } })} />
          <span><b>Runners may start subagents</b><span className="dim small"> · off: Antigravity's subagent tools are refused, Codex's multi-agent features and Grok's subagents are switched off. Local models have none.</span></span></label>

        <div className="row">
          <button className="btn btn-accent" disabled={!dirty} onClick={save}>Save the Crew card</button>
          {dirty && <button className="btn" onClick={() => setDraft(saved)}>Discard changes</button>}
          {msg && <span className={msg.ok ? "ok small" : "error small"}>{msg.text}</span>}
        </div>
      </div>
    </section>
  );
}
