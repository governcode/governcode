// Specs (the Pipeline): every Spec, its status, and for one Spec its details, its diff, and the choice
// to accept it into the project or discard it.
import { useCallback, useEffect, useRef, useState } from "react";
import { SpecCheckpoints, SpecDiff } from "@governcode/protocol";
import { call, clock, dotted, modelLabel, useFallbackPoll, useWatch, type RecoveryItem, type Spec } from "../api.ts";
import { ConfirmButton, DiffView, Empty, SpecPill } from "../ui.tsx";

export function Pipeline({ project, live, recoveryEnabled }: { project: string | null; live: boolean; recoveryEnabled: boolean }) {
  const [specs, setSpecs] = useState<Spec[] | null>(null);
  const [recoveries, setRecoveries] = useState<RecoveryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [listed, recovery] = await Promise.all([
        call<{ specs: Spec[] }>("spec.list", project ? { project } : {}),
        recoveryEnabled ? call<{ items: RecoveryItem[] }>("recovery.list", project ? { project } : {}).catch(() => ({ items: [] as RecoveryItem[] }))
          : Promise.resolve({ items: [] as RecoveryItem[] }),
      ]);
      setSpecs([...listed.specs].reverse());
      setRecoveries(recovery.items);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [project, recoveryEnabled]);

  useEffect(() => { void load(); }, [load]);
  useFallbackPoll(live, load);
  useWatch((w) => {
    if (w.kind === "trace" && (w.event.kind.startsWith("spec.") || w.event.kind.startsWith("recovery."))
        && (!project || w.event.project === project)) void load();
  });

  const spec = specs?.find((s) => s.id === selected) ?? null;
  // The review queue: Specs waiting for a decision, oldest first, to step through.
  const queue = (specs ?? []).filter((s) => s.status === "needs-review").reverse();
  const at = spec ? queue.findIndex((s) => s.id === spec.id) : -1;

  return (
    <section className="view">
      <div className="view-head">
        <h1>Specs</h1>
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
            {/* A new round keeps its Spec id. Reset the diff and any pending confirmation when
                its snapshots change, so the review always starts from the new result. */}
            {spec ? <SpecDetail key={JSON.stringify([spec.id, spec.checkpoints.before, spec.checkpoints.after])} spec={spec} recovery={recoveryEnabled ? recoveries.find((r) => r.target === spec.id) : undefined} onChanged={load} />
              : <div className="dim pad">Select a Spec to see its details and diff.</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function SpecDetail({ spec, recovery, onChanged }: { spec: Spec; recovery?: RecoveryItem; onChanged: () => void }) {
  const [review, setReview] = useState<(SpecDiff & { id: string; request: number }) | null>(null);
  const request = useRef(0);
  const currentSpec = useRef(spec);
  currentSpec.current = spec;
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const reviewable = spec.status === "needs-review";
  const matches = (s: Spec, r: NonNullable<typeof review>) => s.id === r.id
    && s.checkpoints.before === r.checkpoints.before && s.checkpoints.after === r.checkpoints.after;
  const canAccept = reviewable && review !== null && review.request === request.current
    && SpecCheckpoints.safeParse(review.checkpoints).success && matches(spec, review);

  const showDiff = async () => {
    const n = ++request.current;
    const requested = spec;
    // A reload withdraws the previous review and its confirmation immediately.
    setReview(null);
    setMsg(null);
    const isCurrent = () => n === request.current && currentSpec.current.id === requested.id
      && currentSpec.current.checkpoints.before === requested.checkpoints.before
      && currentSpec.current.checkpoints.after === requested.checkpoints.after;
    try {
      const result = await call<unknown>("spec.diff", { id: requested.id });
      if (!isCurrent()) return;
      const parsed = SpecDiff.safeParse(result);
      if (!parsed.success) throw new Error("govd returned no valid review checkpoints (update GovernCode).");
      const loaded = { ...parsed.data, id: requested.id, request: n };
      if (!matches(currentSpec.current, loaded)) {
        setMsg({ ok: false, text: "The Spec's snapshots changed. Reload its diff to review the new result." });
        onChanged();
        return;
      }
      setReview(loaded);
    } catch (e) { if (isCurrent()) setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  useEffect(() => {
    if (spec.checkpoints.after) void showDiff();
    return () => { ++request.current; };   // an unmounted or replaced review cannot receive a late diff
  }, [spec.id, spec.checkpoints.before, spec.checkpoints.after]);

  const act = async (method: "spec.accept" | "spec.discard" | "spec.cancel") => {
    if (method === "spec.accept" && (!canAccept || !review || review.request !== request.current
        || currentSpec.current.status !== "needs-review" || !matches(currentSpec.current, review))) return;
    if (method === "spec.cancel") setMsg({ ok: true, text: "Cancelling…" });   // its Runner may take a few seconds to stop
    try {
      const r = await call<{ applied?: string[]; status?: string; files?: string[] }>(method,
        { id: spec.id, ...(method === "spec.accept" ? { checkpoints: review!.checkpoints } : {}) });
      setMsg({ ok: true, text: method === "spec.accept" ? `Applied ${r.applied?.length ?? 0} file(s): ${(r.applied ?? []).join(", ")}`
        : method === "spec.discard" ? "Discarded."
        // A cancelled Spec's changed files stay reviewable: accept or discard them like any other.
        : r.status === "needs-review" ? `Cancelled. Its ${r.files?.length ?? 0} changed file(s) wait for your review.`
        : r.status === "running" ? "Cancelling: the Runner has not stopped yet." : "Cancelled. Nothing had changed." });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };

  const resume = async () => {
    if (!recovery) return;
    try {
      const r = await call<{ id: string; status: string }>("recovery.resume", { id: spec.id, since: recovery.since });
      setMsg({ ok: true, text: `Resumed. ${r.id} is ${r.status}.` });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); onChanged(); }
  };
  const setAtReset = async (atReset: boolean) => {
    if (!recovery) return;
    try {
      await call("recovery.set", { target: recovery.target, since: recovery.since, atReset });
      setMsg({ ok: true, text: atReset ? "Will resume at the reset time." : "Resume at reset is off." });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); onChanged(); }
  };
  const clear = async () => {
    if (!recovery) return;
    try {
      await call("recovery.clear", { target: recovery.target, since: recovery.since });
      setMsg({ ok: true, text: "Forgot the recovery choice. The Spec stays." });
      onChanged();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); onChanged(); }
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
        {spec.status === "running" && <ConfirmButton label="Cancel Spec" tone="danger" confirm={`Stop ${spec.id}'s Runner? Work it already did stays for review.`} onConfirm={() => act("spec.cancel")} />}
        <ConfirmButton key={JSON.stringify([spec.id, spec.status, request.current, review?.request])} label="Accept" tone="ok" disabled={!canAccept} confirm={`Apply ${spec.id}'s displayed changes to ${spec.project}?`} onConfirm={() => act("spec.accept")} />
        <ConfirmButton label="Discard" tone="danger" disabled={!(reviewable || ["failed", "cancelled", "held"].includes(spec.status))} confirm={`Throw away ${spec.id}'s work?`} onConfirm={() => act("spec.discard")} />
      </div>
      {spec.limited && (
        <div className="checkpoint">
          <div><b>{spec.status === "held" ? `Held by its Limit: ${spec.limited.why}` : "Its Runner hit its usage limit"}</b>
            <span className="dim"> · {resetLabel(recovery?.resetsAt ?? spec.limited.resetsAt)}</span></div>
          {recovery && <div className="row wrap">
            <button className="btn btn-accent" onClick={resume}>Resume now</button>
            <label className="check" title={recovery.resetsAt === null ? "The reset time is unknown" : undefined}>
              <input type="checkbox" checked={recovery.atReset} disabled={recovery.resetsAt === null}
                onChange={(e) => void setAtReset(e.target.checked)} />
              <span>Resume at reset</span>
            </label>
            <button className="btn" title="The Spec itself stays" onClick={clear}>Forget it</button>
            {recovery.note && <span className="dim small">{recovery.note}</span>}
          </div>}
        </div>
      )}
      {msg && <div className={msg.ok ? "ok pad" : "error pad"}>{msg.text}</div>}
      <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <h3>Brief</h3>
      <pre className="code wrap">{spec.brief}</pre>
      <h3>Files ({spec.files.length})</h3>
      <div className="mono small">{spec.files.length ? spec.files.join("  ") : <span className="dim">none</span>}</div>
      <div className="row"><h3>Diff</h3><span className="spacer" /><button className="btn" onClick={showDiff}>{review === null ? "Show diff" : "Reload diff"}</button></div>
      {review !== null && matches(spec, review) && <DiffView diff={review.diff} />}
    </div>
  );
}

function resetLabel(at: string | null): string {
  if (at === null) return "reset time unknown";
  const d = new Date(at), now = new Date();
  if (Number.isNaN(d.getTime())) return `resets ${at}`;
  const minutes = Math.max(0, Math.ceil((d.getTime() - now.getTime()) / 60_000));
  return `resets ${clock(at, now).replace(/:\d{2}$/, "")} (in ${Math.floor(minutes / 60)} h ${minutes % 60} min)`;
}
