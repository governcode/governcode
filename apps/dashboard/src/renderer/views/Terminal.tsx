// Terminal: chat with the Controller of the selected project (or Home). Events stream in as
// they happen; a Gate appears inline with the exact request and waits for an answer.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { controllerLabel, type Gate, type Project } from "../api.ts";
import { GateCard, Pill, UndoCheckpoint, type GateState } from "../ui.tsx";

export type Entry =
  | { t: "you"; text: string }
  | { t: "text"; text: string }
  | { t: "tool"; name: string }
  | { t: "gate"; id: string; tool: string; canonical: string; arrived: number; answered?: "allow" | "deny" }
  | { t: "spec"; id: string; to: string; brief: string; lines: string[] }
  | { t: "checkpoint"; id: string; files: string[]; undone?: boolean }
  | { t: "done"; ok: boolean; summary: string }
  | { t: "error"; text: string };
export type Thread = { entries: Entry[]; busy: boolean };

export function Terminal(props: { project: Project | null; thread: Thread; openGates: Gate[]; gatesAt: number;
  onSend: (prompt: string) => void; onGate: (id: string, a: "allow" | "deny") => void }) {
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const open = new Set(props.openGates.map((g) => g.id));

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

  return (
    <section className="view terminal">
      <div className="view-head">
        <h1>Terminal</h1>
        <span className="dim">{props.project ? `Controller for ${props.project.name}: ${controllerLabel(props.project.controller)}`
          : "Home: the Controller can read and plan but cannot write anything."}</span>
        <span className="spacer" />
        {props.thread.busy && <Pill tone="accent">working</Pill>}
      </div>
      <div className="log" ref={log}>
        {!props.thread.entries.length && <div className="dim pad">Ask the Controller something. Every step it takes that needs approval stops here as a Gate.</div>}
        {props.thread.entries.map((e, i) => {
          switch (e.t) {
            case "you": return <div key={i} className="msg you"><span className="who">you</span><div className="body">{e.text}</div></div>;
            case "text": return <div key={i} className="msg ctl"><span className="who">Controller</span><div className="body">{e.text}</div></div>;
            case "tool": return <div key={i} className="tool dim mono">· {e.name}</div>;
            case "gate": return <GateCard key={i} id={e.id} tool={e.tool} canonical={e.canonical} state={gateState(e)}
              onAnswered={(a) => props.onGate(e.id, a)} />;
            case "spec": return (
              <div key={i} className="spec-card">
                <div className="spec-head"><b className="mono">{e.id}</b> <span className="dim">→ Runner ·</span> <b>{e.to}</b> <span className="dim">{e.brief.slice(0, 160)}</span></div>
                {e.lines.slice(-12).map((l, j) => <div key={j} className="spec-line mono dim">{l.slice(0, 300)}</div>)}
              </div>
            );
            case "checkpoint": return (
              <div key={i} className="checkpoint-line">
                <span className="mono">Checkpoint {e.id}</span> <span className="dim">· {e.files.length} file{e.files.length === 1 ? "" : "s"} ·</span>{" "}
                {e.undone ? <span className="dim">undone</span> : <UndoCheckpoint id={e.id} files={e.files} compact onUndone={() => {}} />}
              </div>
            );
            case "done": return <div key={i} className={`done ${e.ok ? "dim" : "error"}`}>{e.ok ? "— done" : `— failed: ${e.summary}`}</div>;
            case "error": return <div key={i} className="done error">— {e.text}</div>;
          }
        })}
      </div>
      <div className="composer">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} rows={3}
          placeholder={props.thread.busy ? "The Controller is working…" : "Ask the Controller (Enter to send, Shift+Enter for a new line)"} />
        <button className="btn btn-accent" disabled={props.thread.busy || !draft.trim()} onClick={submit}>Send</button>
      </div>
    </section>
  );
}
