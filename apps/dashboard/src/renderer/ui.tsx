// Small shared pieces: status pills, the Gate card, a two-step confirm, the diff view.
import { useState, type ReactNode } from "react";
import { call, clock } from "./api.ts";

export function Pill({ tone, children, title }: { tone: "ok" | "warn" | "danger" | "info" | "accent" | "dim"; children: ReactNode; title?: string }) {
  return <span className={`pill pill-${tone}`} title={title}>{children}</span>;
}

const SPEC_TONE = { queued: "info", held: "warn", running: "accent", "needs-review": "warn", accepted: "ok", undone: "dim", failed: "danger" } as const;
export function SpecPill({ status }: { status: keyof typeof SPEC_TONE }) {
  return <Pill tone={SPEC_TONE[status] ?? "dim"}>{status}</Pill>;
}

export type GateState = "waiting" | "allow" | "deny" | "settled";

/**
 * A Gate: the exact canonical request that will run if allowed, and the two answers.
 * Shown inline in the Terminal and in the Gates list.
 */
export function GateCard(props: { id: string; tool: string; canonical: string; project?: string | null; opened?: string;
  state: GateState; onAnswered: (a: "allow" | "deny") => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = async (a: "allow" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      await call("gate.answer", { id: props.id, answer: a });
      props.onAnswered(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`gate gate-${props.state}`}>
      <div className="gate-head">
        <span className="gate-title">Gate {props.id}</span>
        <span className="dim">
          {props.project !== undefined && <>{props.project ?? "Home"} · </>}
          wants <b className="mono">{props.tool}</b>
          {props.opened && <> · opened {clock(props.opened)}</>}
        </span>
        <span className="spacer" />
        {props.state === "allow" && <Pill tone="ok">allowed once</Pill>}
        {props.state === "deny" && <Pill tone="danger">denied</Pill>}
        {props.state === "settled" && <Pill tone="dim">settled</Pill>}
        {props.state === "waiting" && <Pill tone="warn">waiting for you</Pill>}
      </div>
      <div className="gate-label dim">Exactly this will run:</div>
      <pre className="code">{props.canonical}</pre>
      {props.state === "waiting" && (
        <div className="row">
          <button className="btn btn-ok" disabled={busy} onClick={() => answer("allow")}>Allow once</button>
          <button className="btn btn-danger" disabled={busy} onClick={() => answer("deny")}>Deny</button>
          {error && <span className="error">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** A button that asks once more before it acts. */
export function ConfirmButton(props: { label: string; confirm: ReactNode; tone: "ok" | "danger"; disabled?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className={`btn btn-${props.tone}`} disabled={props.disabled} onClick={() => setAsking(true)}>{props.label}</button>;
  return (
    <span className="confirm">
      <span>{props.confirm}</span>
      <button className={`btn btn-${props.tone} btn-solid`} onClick={() => { setAsking(false); props.onConfirm(); }}>Yes, {props.label.toLowerCase()}</button>
      <button className="btn" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="dim pad">(no changes)</div>;
  return (
    <pre className="code diff">
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("+++") || line.startsWith("---") || /^(diff |index |new file mode|deleted file mode|similarity |rename )/.test(line) ? "d-head"
          : line.startsWith("@@") ? "d-hunk" : line.startsWith("+") ? "d-add" : line.startsWith("-") ? "d-del" : "";
        return <div key={i} className={cls}>{line || " "}</div>;
      })}
    </pre>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children}
    </div>
  );
}

/**
 * Undo of one Controller turn: a two-step confirm that names exactly the files govd will
 * restore, and govd's refusal (a file changed since, already undone) shown inline.
 */
export function UndoCheckpoint({ id, files, compact, onUndone }: { id: string; files: string[]; compact?: boolean; onUndone: (restored: string[]) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ id: string; restored: string[] }>("turn.undo", { id });
      setAsking(false);
      onUndone(r.restored);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (!asking) {
    return <span className="undo">
      {compact ? <button className="linkish" onClick={() => setAsking(true)}>Undo</button>
        : <button className="btn btn-danger" onClick={() => setAsking(true)}>Undo</button>}
      {error && <span className="error"> {error}</span>}
    </span>;
  }
  return (
    <div className="undo-confirm">
      <div>Restore {files.length === 1 ? "this file" : `these ${files.length} files`} to how they were before {id}:</div>
      <div className="mono small">{files.join("  ")}</div>
      <div className="dim small">Nothing is restored if any of them changed since {id}.</div>
      <div className="row">
        <button className="btn btn-danger btn-solid" disabled={busy} onClick={undo}>Yes, undo {id}</button>
        <button className="btn" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>Cancel</button>
        {error && <span className="error">{error}</span>}
      </div>
    </div>
  );
}
