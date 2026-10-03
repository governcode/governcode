// Terminal: chat with the Controller of the selected project (or Home). Events stream in as
// they happen; a Gate appears inline with the exact request and waits for an answer.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { call, clock, controllerLabel, useWatch, type Gate, type Project, type RecoveryItem } from "../api.ts";
import { GateCard, Pill, UndoCheckpoint, type GateState } from "../ui.tsx";

export type Entry =
  | { t: "you"; text: string }
  | { t: "text"; text: string }
  | { t: "tool"; name: string }
  | { t: "gate"; id: string; tool: string; canonical: string; arrived: number; answered?: "allow" | "deny"; covers?: string | null; scopes?: string[]; suggest?: string | null }
  | { t: "allowed"; tool: string; why: string }
  | { t: "spec"; id: string; to: string; brief: string; lines: string[] }
  | { t: "checkpoint"; id: string; files: string[]; undone?: boolean }
  | { t: "proposal"; id: string; name: string; path: string; git: boolean; reason: string }
  | { t: "plan"; id: string; items: Array<{ who: string; what: string; scope?: string[] }>; note: string; handoff: string }
  | { t: "wake"; specs: string[] }   // a turn GovernCode started to report finished Specs
  | { t: "continuation"; turn: string } // a turn GovernCode continued after its usage limit reset
  | { t: "done"; ok: boolean; summary: string }
  | { t: "error"; text: string };
export type Thread = { entries: Entry[]; busy: boolean };

export function Terminal(props: { project: Project | null; thread: Thread; openGates: Gate[]; gatesAt: number;
  recoveryEnabled: boolean;
  onSend: (prompt: string, continuationOf?: string) => void; onGate: (id: string, a: "allow" | "deny") => void; onOpenProject?: (name: string) => void;
  onNewConversation?: () => void }) {
  const [draft, setDraft] = useState("");
  const [recovery, setRecovery] = useState<RecoveryItem | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const open = new Set(props.openGates.map((g) => g.id));

  const loadRecovery = useCallback(async () => {
    if (!props.recoveryEnabled || !props.project) { setRecovery(null); setRecoveryError(null); return; }
    try {
      const r = await call<{ items: RecoveryItem[] }>("recovery.list", { project: props.project.name });
      setRecovery(r.items.find((x) => x.kind === "turn") ?? null);
      setRecoveryError(null);
    } catch { setRecovery(null); }   // an older govd has no recovery: no bar
  }, [props.project, props.recoveryEnabled]);
  useEffect(() => { void loadRecovery(); }, [loadRecovery]);
  useWatch((w) => {
    if (props.project && w.kind === "trace" && w.event.project === props.project.name
        && (w.event.kind.startsWith("turn.") || w.event.kind.startsWith("recovery."))) void loadRecovery();
  });

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [props.thread.entries.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text || props.thread.busy) return;
    setDraft("");
    props.onSend(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  const gateState = (e: Extract<Entry, { t: "gate" }>): GateState =>
    e.answered ?? (open.has(e.id) || props.gatesAt < e.arrived ? "waiting" : "settled");
  const setAtReset = async (atReset: boolean) => {
    if (!recovery) return;
    setRecoveryBusy(true);
    try { await call("recovery.set", { target: recovery.target, since: recovery.since, atReset }); await loadRecovery(); }
    catch (e) { const message = e instanceof Error ? e.message : String(e); await loadRecovery(); setRecoveryError(message); }
    finally { setRecoveryBusy(false); }
  };
  const clearRecovery = async () => {
    if (!recovery) return;
    setRecoveryBusy(true);
    try { await call("recovery.clear", { target: recovery.target, since: recovery.since }); await loadRecovery(); }
    catch (e) { const message = e instanceof Error ? e.message : String(e); await loadRecovery(); setRecoveryError(message); }
    finally { setRecoveryBusy(false); }
  };

  return (
    <section className="view terminal">
      <div className="view-head">
        <h1>Terminal</h1>
        <span className="dim head-note">{props.project ? `Controller for ${props.project.name}: ${controllerLabel(props.project.controller)}`
          : "Home: the Controller can read and plan but cannot write anything."}</span>
        <span className="spacer" />
        {props.thread.busy && <Pill tone="accent">working</Pill>}
        {props.onNewConversation && (
          <button className="btn btn-quiet" disabled={props.thread.busy} title="The Controller forgets this conversation and starts fresh (the Trace keeps everything)"
            onClick={props.onNewConversation}>New conversation</button>
        )}
      </div>
      <div className="log" ref={log}>
        {!props.thread.entries.length && <div className="dim pad">Ask the Controller something, in plain words. It remembers this conversation until you start a new one.
          Steps that need your say stop here as a Gate; how often depends on Settings › Gates.</div>}
        {props.thread.entries.map((e, i) => {
          switch (e.t) {
            case "you": return <div key={i} className="msg you"><span className="who">you</span><div className="body">{e.text}</div></div>;
            case "text": return <div key={i} className="msg ctl"><span className="who">Controller</span><div className="body">{e.text}</div></div>;
            case "tool": return <div key={i} className="tool dim mono">· {e.name}</div>;
            case "allowed": return <div key={i} className="tool dim mono">· {e.tool}: allowed without asking ({e.why}); the sandbox still applies</div>;
            case "gate": return <GateCard key={i} id={e.id} tool={e.tool} canonical={e.canonical} covers={e.covers} scopes={e.scopes} suggest={e.suggest} state={gateState(e)}
              onAnswered={(a) => props.onGate(e.id, a)} />;
            case "spec": return (
              <div key={i} className="spec-card">
                <div className="spec-head"><b className="mono">{e.id}</b> <span className="dim">→ Runner{e.to && " ·"}</span> {e.to && <b>{e.to}</b>} <span className="dim">{e.brief.slice(0, 160)}</span></div>
                {e.lines.slice(-12).map((l, j) => <div key={j} className="spec-line mono dim">{l.slice(0, 300)}</div>)}
              </div>
            );
            case "checkpoint": return (
              <div key={i} className="checkpoint-line">
                <span className="mono">Checkpoint {e.id}</span> <span className="dim">· {e.files.length} file{e.files.length === 1 ? "" : "s"} ·</span>{" "}
                {e.undone ? <span className="dim">undone</span> : <UndoCheckpoint id={e.id} files={e.files} compact onUndone={() => {}} />}
              </div>
            );
            case "proposal": return <ProposalCard key={i} {...e} onOpen={props.onOpenProject} />;
            case "plan": return <PlanCard key={i} {...e} />;
            case "wake": return <div key={i} className="checkpoint-line dim">GovernCode told the Controller that {listed(e.specs)} finished:</div>;
            case "continuation": return <div key={i} className="checkpoint-line dim">GovernCode continued {e.turn} after its usage limit reset:</div>;
            case "done": return <div key={i} className={`done ${e.ok ? "dim" : "error"}`}>{e.ok ? "— done" : `— failed: ${e.summary}`}</div>;
            case "error": return <div key={i} className="done error">— {e.text}</div>;
          }
        })}
      </div>
      {props.recoveryEnabled && recovery && (
        <div className="recovery-bar row small">
          <span><b>{recovery.provider}</b> hit its usage limit ({recovery.resetsAt ? `resets ${clock(recovery.resetsAt).replace(/:\d{2}$/, "")}` : "reset time unknown"}).</span>
          <span className="spacer" />
          {recovery.note && <span className="dim">{recovery.note}</span>}
          <button className="btn" disabled={props.thread.busy || recoveryBusy} onClick={() => props.onSend("Continue where you left off.", recovery.target)}>Continue now</button>
          <label className="check" title={recovery.resetsAt === null ? "The reset time is unknown" : undefined}>
            <input type="checkbox" checked={recovery.atReset} disabled={recoveryBusy || recovery.resetsAt === null}
              onChange={(e) => void setAtReset(e.target.checked)} />
            <span>Continue at reset</span>
          </label>
          <button className="btn" title="The turn itself stays" disabled={recoveryBusy} onClick={() => void clearRecovery()}>Forget it</button>
        </div>
      )}
      {props.recoveryEnabled && recoveryError && <div className="recovery-bar error small">{recoveryError}</div>}
      <div className="composer">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={3}
          placeholder={props.thread.busy ? "The Controller is working…" : "Ask the Controller (Enter to send, Shift+Enter for a new line)"} />
        <button className="btn btn-accent" disabled={props.thread.busy || !draft.trim()} onClick={submit}>Send</button>
      </div>
    </section>
  );
}

/** "S-0001", "S-0001 and S-0002", "S-0001, S-0002 and S-0003". */
function listed(ids: string[]): string {
  return ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}` : ids[0] ?? "a Spec";
}

/** A project the Home Controller proposed. govd creates it only when you choose Create. */
/** The Controller's game plan: approve all or some items, "just you", or reject. */
function PlanCard(p: { id: string; items: Array<{ who: string; what: string; scope?: string[] }>; note: string; handoff: string }) {
  const [picked, setPicked] = useState<boolean[]>(() => p.items.map(() => true));
  const [state, setState] = useState<"waiting" | "busy" | "approve" | "just-you" | "reject">("waiting");
  const [error, setError] = useState<string | null>(null);
  const answer = async (a: "approve" | "just-you" | "reject") => {
    setState("busy");
    const items = picked.map((on, i) => (on ? i + 1 : 0)).filter(Boolean);
    try { await call("plan.answer", { id: p.id, answer: a, ...(a === "approve" && items.length < p.items.length ? { items } : {}) }); setState(a); setError(null); }
    catch (e) { setState("waiting"); setError(e instanceof Error ? e.message : String(e)); }
  };
  const some = picked.some(Boolean);
  return (
    <div className="proposal">
      <div className="row"><Pill tone="accent">game plan</Pill><b>Who does what</b><span className="spacer" /><span className="dim mono small">{p.id}</span></div>
      {p.items.map((it, i) => (
        <label key={i} className="policy-option">
          <input type="checkbox" checked={picked[i]} disabled={state !== "waiting"} onChange={(e) => setPicked((x) => x.map((v, j) => (j === i ? e.target.checked : v)))} />
          <span><b>{it.who === "me" ? "Controller" : it.who}</b><span className="dim small"> · {it.what}{it.scope?.length ? ` · ${it.scope.join(", ")}` : ""}</span></span>
        </label>
      ))}
      {p.note && <div className="small">{p.note}</div>}
      <div className="dim small">{p.handoff === "plan" ? "Each approved handoff runs once without asking again; anything else still asks." : "Handoffs still ask at a Gate (Crew card: ask each time)."} Just you: the Controller does it all itself this turn.</div>
      {error && <div className="error small">{error}</div>}
      <div className="row end wrap">
        {state === "approve" ? <span className="ok small">Approved.</span> : state === "just-you" ? <span className="small">Just the Controller.</span>
          : state === "reject" ? <span className="dim small">Rejected.</span>
          : <><button className="btn" disabled={state === "busy"} onClick={() => answer("reject")}>Reject</button>
              <button className="btn" disabled={state === "busy"} onClick={() => answer("just-you")}>Just you</button>
              <button className="btn btn-accent" disabled={state === "busy" || !some} onClick={() => answer("approve")}>{picked.every(Boolean) ? "Approve" : "Approve selected"}</button></>}
      </div>
    </div>
  );
}

function ProposalCard(p: { id: string; name: string; path: string; git: boolean; reason: string; onOpen?: (name: string) => void }) {
  const [state, setState] = useState<"waiting" | "busy" | "created" | "cancelled">("waiting");
  const [error, setError] = useState<string | null>(null);
  const answer = async (a: "create" | "cancel") => {
    setState("busy");
    try {
      const r = await call<{ created: Project | null }>("proposal.answer", { id: p.id, answer: a });
      setState(r.created ? "created" : "cancelled"); setError(null);
    } catch (e) { setState("waiting"); setError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="proposal">
      <div className="row"><Pill tone="accent">proposal</Pill><b>New project from the Controller</b><span className="spacer" /><span className="dim mono small">{p.id}</span></div>
      <div className="kv"><span className="dim">name</span><b className="mono">{p.name}</b>
        <span className="dim">location</span><span className="mono">{p.path}</span>
        <span className="dim">git</span><span>{p.git ? "git init · branch main" : "no git"}</span></div>
      {p.reason && <div className="small">{p.reason}</div>}
      <div className="dim small">Created by govd after you confirm; the Controller cannot create folders itself.</div>
      {error && <div className="error small">{error}</div>}
      <div className="row end wrap">
        {state === "created" ? <><span className="ok small">Created.</span>{p.onOpen && <button className="btn btn-accent" onClick={() => p.onOpen?.(p.name)}>Open {p.name}</button>}</>
          : state === "cancelled" ? <span className="dim small">Cancelled; nothing was created.</span>
          : <><button className="btn" disabled={state === "busy"} onClick={() => answer("cancel")}>Cancel</button>
              <button className="btn btn-accent" disabled={state === "busy"} onClick={() => answer("create")}>Create</button></>}
      </div>
    </div>
  );
}
