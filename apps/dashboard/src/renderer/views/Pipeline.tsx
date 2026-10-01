// Pipeline: the Specs, their status, and for one Spec its details, its diff, and the choice
// to accept it into the project or discard it.
import { useCallback, useEffect, useState } from "react";
import { call, clock, dotted, modelLabel, useFallbackPoll, useWatch, type Spec } from "../api.ts";
import { ConfirmButton, DiffView, Empty, SpecPill } from "../ui.tsx";

export function Pipeline({ project, live }: { project: string | null; live: boolean }) {
  const [specs, setSpecs] = useState<Spec[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<{ specs: Spec[] }>("spec.list", project ? { project } : {});
      setSpecs([...r.specs].reverse());
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [project]);

  useEffect(() => { void load(); }, [load]);
  useFallbackPoll(live, load);
  useWatch((w) => {
    if (w.kind === "trace" && w.event.kind.startsWith("spec.") && (!project || w.event.project === project)) void load();
  });

  const spec = specs?.find((s) => s.id === selected) ?? null;
  // The review queue: Specs waiting for a decision, oldest first, to step through.
  const queue = (specs ?? []).filter((s) => s.status === "needs-review").reverse();
  const at = spec ? queue.findIndex((s) => s.id === spec.id) : -1;

  return (
    <section className="view">
      <div className="view-head">
        <h1>Pipeline</h1>
        <span className="dim">{project ? `Specs for ${project}` : "Specs in every project"}</span>
        <span className="spacer" />
        {queue.length > 0 && (
          <span className="row small">
            <span className="dim">{at >= 0 ? `${at + 1} of ${queue.length} waiting for review` : `${queue.length} waiting for review`}</span>
            <button className="btn" disabled={at <= 0 && at !== -1} onClick={() => setSelected(queue[at <= 0 ? 0 : at - 1].id)}>{at === -1 ? "Review" : "Prev"}</button>
            {at !== -1 && <button className="btn" disabled={at >= queue.length - 1} onClick={() => setSelected(queue[at + 1].id)}>Next</button>}
          </span>
        )}
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      {error && <div className="error pad">{error}</div>}
      {specs && !specs.length ? (
        <Empty title="No Specs yet"><p className="dim">When the Controller delegates a job to a Runner, the Spec appears here.</p></Empty>
      ) : (
        <div className="split">
          <div className="list">
            {specs?.map((s) => (
              <button key={s.id} className={`list-row ${s.id === selected ? "active" : ""}`} onClick={() => setSelected(s.id)}>
                <div className="row"><b className="mono">{s.id}</b><span className="dim">{s.to}</span><span className="spacer" /><SpecPill status={s.status} /></div>
                <div className="dim ellipsis">{s.brief}</div>
                <div className="dim small">{dotted(s.project, modelLabel(s.model, s.effort), `${s.files.length} file${s.files.length === 1 ? "" : "s"}`, clock(s.created))}</div>
              </button>
            ))}
          </div>
          <div className="detail">
            {spec ? <SpecDetail key={spec.id} spec={spec} onChanged={load} /> : <div className="dim pad">Select a Spec to see its details and diff.</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function SpecDetail({ spec, onChanged }: { spec: Spec; onChanged: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const reviewable = spec.status === "needs-review";

  const showDiff = async () => {
    try { setDiff((await call<{ diff: string }>("spec.diff", { id: spec.id })).diff); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  useEffect(() => { if (spec.checkpoints.after) void showDiff(); }, [spec.id]);

  const act = async (method: "spec.accept" | "spec.discard") => {
    try {
      const r = await call<{ applied?: string[] }>(method, { id: spec.id });
      setMsg({ ok: true, text: method === "spec.accept" ? `Applied ${r.applied?.length ?? 0} file(s): ${(r.applied ?? []).join(", ")}` : "Discarded." });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };

  const rows: Array<[string, string]> = [
    ["Status", spec.status + (spec.note ? ` (${spec.note})` : "")],
    ["Project", spec.project],
    ["Runner", spec.to],
    ["Model", dotted(spec.model.trim() || "default model", spec.effort && `effort ${spec.effort}`)],
    ["Limit budget", `${spec.budgetPercent}%`],
    ["Workspace", spec.workspace],
    ["Scope", `read ${JSON.stringify(spec.scope.read)} · write ${JSON.stringify(spec.scope.write)}`],
    ["Checkpoints", `${spec.checkpoints.before?.slice(0, 12) ?? "-"} → ${spec.checkpoints.after?.slice(0, 12) ?? "-"}`],
    ["Created", clock(spec.created)],
    ["Why this Runner", spec.reason],
    ["Done means", spec.result],
  ];
  return (
    <div className="spec-detail">
      <div className="row wrap"><h2 className="mono">{spec.id}</h2><SpecPill status={spec.status} /><span className="spacer" />
        <ConfirmButton label="Accept" tone="ok" disabled={!reviewable} confirm={`Apply ${spec.id}'s changes to ${spec.project}?`} onConfirm={() => act("spec.accept")} />
        <ConfirmButton label="Discard" tone="danger" disabled={!(reviewable || spec.status === "failed")} confirm={`Throw away ${spec.id}'s work?`} onConfirm={() => act("spec.discard")} />
      </div>
      {msg && <div className={msg.ok ? "ok pad" : "error pad"}>{msg.text}</div>}
      <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <h3>Brief</h3>
      <pre className="code wrap">{spec.brief}</pre>
      <h3>Files ({spec.files.length})</h3>
      <div className="mono small">{spec.files.length ? spec.files.join("  ") : <span className="dim">none</span>}</div>
      <div className="row"><h3>Diff</h3><span className="spacer" /><button className="btn" onClick={showDiff}>{diff === null ? "Show diff" : "Reload diff"}</button></div>
      {diff !== null && <DiffView diff={diff} />}
    </div>
  );
}
