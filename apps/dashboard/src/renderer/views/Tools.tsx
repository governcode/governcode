// Settings › Tools: every tool joins GovernCode the same way. Connect runs the tool's own sign-in
// inside GovernCode's sandbox, in a home that belongs to GovernCode (not the user's own setup);
// the user opens the link it gives, signs in, and pastes the code back. GovernCode never reads
// the login the tool keeps there.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, call } from "../api.ts";
import type { AskEvent } from "../../shared/contract.ts";
import { Pill } from "../ui.tsx";

type Reading = { window: string; usedPercent: number };
type Tool = { tool: string; name: string; flow: "paste" | "device"; installed: boolean; connected: boolean; problem: string | null;
  usage: { readings: Reading[] } | null };
type SignIn = { streamId: string; flow: "paste" | "device"; name: string; id: string | null; url: string | null; lines: string[]; code: string; sent: boolean };

export function Tools() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [checking, setChecking] = useState(false);
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const stream = useRef<string | null>(null);

  const load = useCallback(async (measure: boolean) => {
    setChecking(measure);
    try { setTools((await call<{ tools: Tool[] }>("tools.list", { measure })).tools); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void load(true); }, [load]);

  // The sign-in's events: its link, its lines, and its id (for the pasted code).
  useEffect(() => api().onEvent((streamId: string, e: AskEvent) => {
    if (streamId !== stream.current || e.kind !== "connect") return;
    const ev = e as { id?: string; url?: string; text?: string };
    setSignIn((s) => s && s.streamId === streamId ? { ...s, id: ev.id ?? s.id, url: ev.url ?? s.url,
      lines: ev.text ? [...s.lines, ev.text].slice(-8) : s.lines } : s);
  }), []);

  const connect = async (tool: Tool) => {
    const streamId = `connect-${tool.tool}-${Date.now()}`;
    stream.current = streamId;
    setMsg(null);
    setSignIn({ streamId, flow: tool.flow, name: tool.name, id: null, url: null, lines: [], code: "", sent: false });
    const r = await api().connect(streamId, tool.tool);
    stream.current = null;
    setSignIn(null);
    setMsg(r.ok ? { ok: r.value.connected, text: r.value.note } : { ok: false, text: r.error });
    await load(false);
  };
  const sendCode = async () => {
    if (!signIn?.id || !signIn.code.trim()) return;
    try { await call("connect.input", { id: signIn.id, text: signIn.code.trim() }); setSignIn((s) => s && { ...s, sent: true, code: "" }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };
  const cancel = async () => { if (signIn?.id) await call("connect.cancel", { id: signIn.id }).catch(() => {}); };
  const disconnect = async (tool: Tool) => {
    try { setMsg({ ok: true, text: (await call<{ note: string }>("tools.disconnect", { tool: tool.tool })).note }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    await load(false);
  };

  return (
    <>
      <h2>Tools</h2>
      <p className="dim small">Each AI tool signs in for GovernCode once, with its own sign-in, in a home that belongs to GovernCode: your own setup, keyring and settings are never used. GovernCode never reads the login the tool keeps there. Disconnect removes it.</p>
      <div className="table">
        {tools.map((t) => {
          const use = t.connected && t.usage?.readings?.length ? t.usage.readings.map((r) => `${r.window} ${r.usedPercent}% used`).join(" · ") : "";
          return (
            <div key={t.tool} className="tr">
              <b>{t.name}</b>
              <span>{!t.installed ? <Pill tone="dim">not installed</Pill> : !t.connected ? <Pill tone="warn">not connected</Pill>
                : t.problem ? <Pill tone="danger" title={t.problem}>needs attention</Pill> : <Pill tone="ok">connected</Pill>}</span>
              <span className="small dim">{t.problem ?? use}</span>
              {t.installed && (t.connected
                ? <span className="row">{t.problem && <button className="btn" disabled={!!signIn} onClick={() => connect(t)}>Reconnect</button>}
                    <button className="btn" disabled={!!signIn} onClick={() => disconnect(t)}>Disconnect</button></span>
                : <button className="btn btn-accent" disabled={!!signIn} onClick={() => connect(t)}>Connect</button>)}
            </div>
          );
        })}
      </div>
      {checking && <p className="dim small">Checking each connected tool…</p>}

      {signIn && (
        <div className="checkpoint" role="dialog" aria-label="Sign in">
          <div className="row"><b>Signing in</b><span className="spacer" /><button className="btn" onClick={cancel} disabled={!signIn.id}>Cancel</button></div>
          {!signIn.url && <p className="dim small">Starting the tool's sign-in inside the sandbox…</p>}
          {signIn.url && signIn.flow === "device" && <>
            <p className="small">1. Open the sign-in page and sign in with the account {signIn.name} should use.</p>
            <div className="row">
              <button className="btn btn-accent" onClick={() => void api().openSignIn(signIn.url!)}>Open sign-in page</button>
              <button className="btn" onClick={() => void navigator.clipboard.writeText(signIn.url!)}>Copy link</button>
            </div>
            <p className="small">2. Enter the one-time code shown below on that page. This screen finishes by itself when you are done.</p>
          </>}
          {signIn.url && signIn.flow === "paste" && !signIn.sent && <>
            <p className="small">1. Open the sign-in page and sign in with the account {signIn.name} should use. Go straight through: some tools wait only about a minute; if it runs out, choose Connect again.</p>
            <div className="row">
              <button className="btn btn-accent" onClick={() => void api().openSignIn(signIn.url!)}>Open sign-in page</button>
              <button className="btn" onClick={() => void navigator.clipboard.writeText(signIn.url!)}>Copy link</button>
            </div>
            <p className="small">2. Paste the code it shows you:</p>
            <div className="row">
              <input className="model-input mono" value={signIn.code} placeholder="code" aria-label="sign-in code" autoFocus
                onChange={(e) => setSignIn((s) => s && { ...s, code: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void sendCode(); }} />
              <button className="btn btn-accent" disabled={!signIn.code.trim() || !signIn.id} onClick={sendCode}>Finish</button>
            </div>
          </>}
          {signIn.sent && <p className="dim small">Checking the sign-in…</p>}
          {!!signIn.lines.length && <pre className="mono small dim">{signIn.lines.join("\n")}</pre>}
        </div>
      )}
      {msg && <p className={msg.ok ? "ok small" : "error small"}>{msg.text}</p>}
    </>
  );
}
