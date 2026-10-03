// Small shared pieces: status pills, the Gate card, a two-step confirm, the diff view.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { call, clock } from "./api.ts";
import { parseDiff, sideBySide, type DiffLine } from "../shared/diff.ts";

export function Pill({ tone, children, title }: { tone: "ok" | "warn" | "danger" | "info" | "accent" | "dim"; children: ReactNode; title?: string }) {
  return <span className={`pill pill-${tone}`} title={title}>{children}</span>;
}

const SPEC_TONE = { queued: "info", held: "warn", running: "accent", "needs-review": "warn", accepted: "ok", discarded: "dim", failed: "danger", cancelled: "dim" } as const;
export function SpecPill({ status }: { status: keyof typeof SPEC_TONE }) {
  return <Pill tone={SPEC_TONE[status] ?? "dim"}>{status}</Pill>;
}

export type GateState = "waiting" | "allow" | "deny" | "settled";

/**
 * A Gate: the exact canonical request that will run if allowed, and the two answers.
 * Shown inline in the Terminal and in the Gates list.
 */
const SCOPE_LABEL: Record<string, string> = { turn: "this turn", spec: "this Spec", project: "this project" };

export function GateCard(props: { id: string; tool: string; canonical: string; project?: string | null; opened?: string;
  covers?: string | null; scopes?: string[]; suggest?: string | null; state: GateState; onAnswered: (a: "allow" | "deny") => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<string | null>(null);
  const answer = async (a: "allow" | "deny", remember?: string) => {
    setBusy(true);
    setError(null);
    try {
      await call("gate.answer", { id: props.id, answer: a, ...(remember ? { remember } : {}) });
      if (remember) setRemembered(remember);
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
        {props.state === "allow" && <Pill tone="ok">{remembered ? `allowed for ${SCOPE_LABEL[remembered]}` : "allowed once"}</Pill>}
        {props.state === "deny" && <Pill tone="danger">denied</Pill>}
        {props.state === "settled" && <Pill tone="dim">settled</Pill>}
        {props.state === "waiting" && <Pill tone="warn">waiting for you</Pill>}
      </div>
      <div className="gate-label dim">Exactly this will run:</div>
      <pre className="code">{props.canonical}</pre>
      {props.state === "waiting" && (
        <div className="row wrap">
          {/* Balanced: the suggested answer first, so the next similar step does not ask again. */}
          {props.suggest && (props.scopes ?? []).includes(props.suggest) && (
            <button className="btn btn-accent" disabled={busy} onClick={() => answer("allow", props.suggest!)}>Allow for {SCOPE_LABEL[props.suggest] ?? props.suggest}</button>
          )}
          <button className="btn btn-ok" disabled={busy} onClick={() => answer("allow")}>Allow once</button>
          {(props.scopes ?? []).filter((s) => s !== props.suggest).map((s) => (
            <button key={s} className="btn btn-ok" disabled={busy} onClick={() => answer("allow", s)}>Allow for {SCOPE_LABEL[s] ?? s}</button>
          ))}
          <button className="btn btn-danger" disabled={busy} onClick={() => answer("deny")}>Deny</button>
          {error && <span className="error">{error}</span>}
        </div>
      )}
      {props.state === "waiting" && (
        <div className="gate-note small dim">
          {props.covers
            ? <>“Allow for…” also covers {props.covers} until then. It only skips the question: the sandbox still applies to every step.</>
            : <>This kind of step always asks.</>}
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

/** The review diff: a summary per file (jumps to it), then each file Unified or Side by side. */
export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [mode, setMode] = useState<"unified" | "split">("split");
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  if (!files.length) return <div className="dim pad">(no changes)</div>;
  const num = (n: number | null) => <span className="ln">{n ?? ""}</span>;
  const cls = (l: DiffLine | null) => !l ? "d-empty" : l.kind === "add" ? "d-add" : l.kind === "del" ? "d-del" : "";
  return (
    <div className="review">
      <div className="row review-bar">
        <div className="file-chips">
          {files.map((f) => (
            <button key={f.path} className="chip mono" onClick={() => refs.current[f.path]?.scrollIntoView({ block: "start" })}>
              {f.path.split("/").pop()} {f.binary ? <span className="dim">binary</span> : <><span className="ok">+{f.added}</span> <span className="danger">−{f.removed}</span></>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Diff layout">
          <button className={mode === "split" ? "on" : ""} aria-pressed={mode === "split"} onClick={() => setMode("split")}>Side by side</button>
          <button className={mode === "unified" ? "on" : ""} aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>Unified</button>
        </div>
      </div>
      {files.map((f) => (
        <div key={f.path} className="diff-file" ref={(el) => { refs.current[f.path] = el; }}>
          <div className="diff-file-head mono"><b>{f.path}</b> {!f.binary && <><span className="ok">+{f.added}</span> <span className="danger">−{f.removed}</span></>}</div>
          {f.binary ? <div className="dim pad">Binary file changed; not shown.</div>
            : mode === "unified" || f.added === 0 || f.removed === 0 ? (   // one-sided changes read best unified
              <pre className="code diff">
                {f.hunks.map((h, i) => [
                  <div key={`h${i}`} className="d-hunk">{h.header}</div>,
                  ...h.lines.map((l, j) => <div key={`${i}.${j}`} className={cls(l)}>{num(l.old)}{num(l.new)}<span>{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}{l.text}</span></div>),
                ])}
              </pre>
            ) : (
              <pre className="code diff diff-split">
                {sideBySide(f).map((r, i) => "hunk" in r
                  ? <div key={i} className="d-hunk full">{r.hunk}</div>
                  : <div key={i} className="pair">
                      <div className={cls(r.left)}>{num(r.left?.old ?? null)}<span>{r.left?.text ?? ""}</span></div>
                      <div className={cls(r.right)}>{num(r.right?.new ?? null)}<span>{r.right?.text ?? ""}</span></div>
                    </div>)}
              </pre>
            )}
        </div>
      ))}
    </div>
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
