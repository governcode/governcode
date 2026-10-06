// Overview: the first thing you see. What needs you (answerable here), every project at a glance,
// what each AI has left, the sandbox, and the latest things that happened. Read from govd; the only
// actions are the ones you take (allow or deny a Gate exactly as shown, open something).
import { useCallback, useEffect, useMemo, useState } from "react";
import { greeting } from "../../shared/greeting.ts";
import { gateFitsInline, projectStatus, providerUsage } from "../../shared/status.ts";
import { eventLabel, summary } from "../../shared/trace.ts";
import type { Hello } from "../../shared/contract.ts";
import { call, clock, useWatch, type Gate, type Project, type RecoveryItem, type Spec, type TraceEvent } from "../api.ts";
import { ProviderMark, providerName } from "../brand.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { Glyph, Ring } from "../ui.tsx";
import type { ProviderLimit } from "./Limits.tsx";
import type { Place } from "./Sidebar.tsx";

const QUIET = new Set(["turn.text", "turn.tool", "spec.step", "context.shared", "tool.connected"]);
// At most 20 kinds (govd's limit for one trace.list).
const SHOWN = ["turn.started", "turn.completed", "turn.failed", "gate.opened", "gate.allowed", "gate.denied", "spec.started", "spec.done",
  "spec.failed", "spec.held", "spec.accepted", "spec.discarded", "spec.cancelled", "sandbox.refused", "checkpoint.taken", "checkpoint.undone",
  "recovery.resumed", "crew.set", "notes.updated", "project.created"];
// A Gate is answered here only when its whole request fits on the card; anything longer opens in Needs you.
const fitsInline = (g: Gate) => gateFitsInline(g.canonical);
const TONE: Record<string, [IconName, string]> = {
  "gate.opened": ["lock", "warn"], "gate.allowed": ["check", "ok"], "gate.denied": ["x", "danger"], "spec.done": ["branch", "info"],
  "spec.accepted": ["check", "ok"], "spec.failed": ["x", "danger"], "spec.held": ["hourglass", "held"], "spec.started": ["play", "info"],
  "sandbox.refused": ["shieldX", "danger"], "checkpoint.taken": ["undo", ""], "turn.started": ["chat", ""], "turn.failed": ["x", "danger"],
  "recovery.resumed": ["play", "info"], "crew.set": ["people", ""], "notes.updated": ["note", ""],
};

function gateAsker(g: Gate, projects: Project[]): string {
  const runner = /^Runner · ([^·]+)/.exec(g.tool)?.[1]?.trim();
  if (runner) return providerName(runner);
  const p = projects.find((x) => x.name === g.project);
  return p ? providerName(p.controller.provider) : "The Controller";
}

export function Overview(props: { projects: Project[]; specs: Spec[]; gates: Gate[]; limits: ProviderLimit[]; hello: Hello | null; held: RecoveryItem[];
  onPlace: (p: Place) => void; onGatesChanged: () => void; onNewProject: () => void; onOpenFolder: () => void }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  // Only the kinds worth showing, so a busy day's text and steps do not crowd out the last 24 hours.
  const load = useCallback(async () => {
    try { setEvents((await call<{ events: TraceEvent[] }>("trace.list", { limit: 500, kinds: SHOWN })).events); }
    catch { /* the sidebar shows govd down */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useWatch((w) => { if (w.kind === "trace" && !QUIET.has(w.event.kind)) void load(); });
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  const answer = async (g: Gate, a: "allow" | "deny") => {
    setBusy(g.id); setError(null);
    try { await call("gate.answer", { id: g.id, answer: a }); props.onGatesChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const reviews = props.specs.filter((s) => s.status === "needs-review");
  const running = props.specs.filter((s) => s.status === "running").length;
  const held = props.held;
  const needs = props.gates.length + reviews.length + held.length;
  const projectTab = (name: string, tab: "conversation" | "specs") => props.onPlace({ kind: "project", name, tab });

  // Each project's activity over the last 24 hours, in hourly bars.
  const sparks = useMemo(() => {
    const out = new Map<string, number[]>();
    const end = now.getTime();
    for (const e of events) {
      if (!e.project || QUIET.has(e.kind)) continue;
      const age = Math.floor((end - Date.parse(e.ts)) / 3_600_000);
      if (age < 0 || age > 23) continue;
      const bars = out.get(e.project) ?? Array(24).fill(0);
      bars[23 - age] += 1;
      out.set(e.project, bars);
    }
    return out;
  }, [events, now]);
  const recent = [...events].reverse().filter((e) => !QUIET.has(e.kind)).slice(0, 6);
  const date = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const sandboxOk = props.hello?.sandbox.ok ?? false;

  return (
    <section className="view">
      <header className="toolbar">
        <div className="title"><b>Overview</b><span>{props.projects.length} project{props.projects.length === 1 ? "" : "s"} · {running === 1 ? "1 Spec" : `${running} Specs`} running</span></div>
        <span className="spacer" />
        <div className="end">
          <button className="btn btn-quiet" onClick={props.onOpenFolder}><Icon name="folder" size={14} />Open folder</button>
          <button className="btn btn-quiet" onClick={props.onNewProject}><Icon name="plus" size={14} />New project</button>
          <button className="btn btn-quiet" onClick={() => props.onPlace({ kind: "global", id: "watch" })}><Icon name="eye" size={14} />Watch</button>
          <button className="btn" onClick={() => props.onPlace({ kind: "global", id: "home" })}><Icon name="chat" size={14} />Ask Home</button>
        </div>
      </header>
      <div className="page"><div className="page-inner">
        <div className="page-head">
          <h1>{greeting(now)}</h1>
          <p>{date} · {needs ? `${needs === 1 ? "One thing is" : `${needs} things are`} waiting for you.` : "Nothing needs you right now."}
            {sandboxOk ? " Everything runs inside the sandbox." : " The sandbox is not verified: nothing will run until it is."}</p>
        </div>
        <div className="ov-grid">
          <div className="ov-main">
            <section>
              <div className="section-bar"><h2 className="section-title">Needs you <span className="count">{needs}</span></h2>
                {needs > 0 && <button className="linkish" onClick={() => props.onPlace({ kind: "global", id: "needs" })}>Open all</button>}</div>
              {error && <div className="error small" style={{ marginBottom: 8 }}>{error}</div>}
              <div className="needs">
                {!needs && <div className="card all-clear"><span className="tile"><Icon name="check" /></span><span>All clear. Gates, finished Specs and held work will show up here.</span></div>}
                {props.gates.slice(0, 4).map((g) => (
                  <div key={g.id} className="card need">
                    <span className="tile"><Icon name="lock" /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t">{gateAsker(g, props.projects)} wants to use {g.tool.replace(/^Runner · [^·]+ · /, "")}{g.project ? ` in ${g.project}` : " at Home"}</div>
                      {fitsInline(g)
                        ? <div className="s"><code className="cmd full">{g.canonical}</code><span className="dim nowrap">· {clock(g.opened).replace(/:\d{2}$/, "")}</span></div>
                        : <div className="s"><span className="dim">A longer request: read all of it before answering · {clock(g.opened).replace(/:\d{2}$/, "")}</span></div>}
                    </div>
                    <div className="acts">
                      {fitsInline(g) ? <>
                        <button className="btn btn-quiet" disabled={busy === g.id} onClick={() => answer(g, "deny")}>Deny</button>
                        <button className="btn btn-accent" disabled={busy === g.id} title="Runs exactly the request shown, once" onClick={() => answer(g, "allow")}>Allow once</button>
                      </> : <button className="btn" onClick={() => props.onPlace({ kind: "global", id: "needs" })}>Read and answer</button>}
                    </div>
                  </div>
                ))}
                {reviews.slice(0, 3).map((s) => (
                  <div key={s.id} className="card need need-review">
                    <span className="tile"><Icon name="branch" /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t ellipsis">{providerName(s.to)} finished {s.id} · {s.brief}</div>
                      <div className="s">{s.files.length} file{s.files.length === 1 ? "" : "s"} changed · {s.project}</div>
                    </div>
                    <div className="acts"><button className="btn" onClick={() => projectTab(s.project, "specs")}>Review changes</button></div>
                  </div>
                ))}
                {held.slice(0, 3).map((h) => (
                  <div key={h.target} className="card need need-held">
                    <span className="tile"><Icon name="hourglass" /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t ellipsis">{h.target} is {h.kind === "held" ? "held" : "limited"}: {h.why}</div>
                      <div className="s">{h.resetsAt ? `${providerName(h.provider)} resets ${clock(h.resetsAt).replace(/:\d{2}$/, "")}` : "Reset time unknown"}{h.atReset ? " · resumes then" : ""} · {h.project}</div>
                    </div>
                    <div className="acts"><button className="btn" onClick={() => projectTab(h.project, "specs")}>Open</button></div>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="section-bar"><h2 className="section-title">Projects <span className="count">{props.projects.length}</span></h2></div>
              {!props.projects.length ? <div className="card all-clear"><span className="tile" style={{ background: "var(--accent-tint)", color: "var(--accent)" }}><Icon name="plus" /></span>
                <span>No projects yet. <button className="linkish" onClick={props.onNewProject}>Create one</button> or <button className="linkish" onClick={props.onOpenFolder}>open a folder</button>, or ask at Home.</span></div> : (
                <div className="projects">
                  {props.projects.map((p) => {
                    const st = projectStatus(p.name, props.specs, props.gates);
                    const bars = sparks.get(p.name) ?? Array(24).fill(0);
                    const max = Math.max(1, ...bars);
                    const crew = [...new Set([p.controller.provider, ...props.specs.filter((s) => s.project === p.name).map((s) => s.to)])].slice(0, 4);
                    const color = st.dot === "held" ? "var(--violet)" : st.dot === "needs" ? "var(--amber-solid)" : "var(--blue)";
                    return (
                      <button key={p.name} className="card proj" onClick={() => projectTab(p.name, "conversation")}>
                        <div className="top"><Glyph name={p.name} size={30} /><b>{p.name}</b></div>
                        <div className="state"><span className={`dot ${st.dot ?? ""}`} /><span>{st.text}</span></div>
                        <svg className="spark" viewBox="0 0 240 34" preserveAspectRatio="none" aria-hidden="true">
                          {bars.map((v, i) => <rect key={i} x={i * 10 + 1} y={34 - Math.max(2, (v / max) * 34)} width={7.5} height={Math.max(2, (v / max) * 34)} rx={1.5}
                            fill={v ? color : "var(--fill-2)"} opacity={v ? 0.35 + 0.65 * (v / max) : 1} />)}
                        </svg>
                        <div className="foot"><span className="marks">{crew.map((c) => <ProviderMark key={c} id={c} size={20} />)}</span>
                          <span className="names">{crew.map(providerName).join(", ")}</span></div>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <div className="section-bar"><h2 className="section-title">Recent</h2>
                <button className="linkish" onClick={() => props.onPlace({ kind: "global", id: "trace" })}>Open Trace</button></div>
              <div className="card activity">
                {!recent.length && <div className="act"><span /><span className="dim">Nothing yet.</span><span /></div>}
                {recent.map((e) => {
                  const [icon, tone] = TONE[e.kind] ?? ["clock", ""];
                  return (
                    <div key={e.seq} className="act">
                      <span className={`ic ${tone}`}><Icon name={icon} size={12} /></span>
                      <span className="what" title={summary(e)}><b>{eventLabel(e)}</b> <span className="dim">{e.project ?? "Home"} · {summary(e)}</span></span>
                      <time>{clock(e.ts).replace(/:\d{2}$/, "")}</time>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <div className="ov-side">
            <div className="card side-card">
              <div className="section-bar" style={{ margin: 0 }}><h2 className="section-title">Allowance</h2>
                <button className="linkish" onClick={() => props.onPlace({ kind: "global", id: "allowance" })}>Details</button></div>
              {!props.limits.length && <p className="dim small" style={{ margin: "8px 0 0" }}>No Runners with a usage source yet.</p>}
              {props.limits.map((p) => {
                const u = providerUsage(p);
                const color = !p.verdict.ok ? "var(--violet)" : props.specs.some((s) => s.to === p.provider && s.status === "running") ? "var(--blue)" : "var(--accent)";
                return (
                  <div key={p.provider} className="allow-row">
                    {p.local || p.unmetered ? <ProviderMark id={p.provider} size={36} /> : <Ring size={40} stroke={5} percent={u.percent} reserve={u.reserve} color={color} />}
                    <div style={{ minWidth: 0 }}>
                      <div className="n"><ProviderMark id={p.provider} size={16} />{providerName(p.provider)}</div>
                      <div className="s">{p.local ? "Local model on this machine" : !p.verdict.ok ? p.verdict.reason : "Available"}</div>
                    </div>
                    <div className="pct">{p.local ? "" : u.counted ? `${u.counted.used}/${u.counted.cap}` : u.window ? `${Math.round(u.percent)}%` : "–"}
                      <small>{u.counted ? u.counted.unit : u.window ?? (p.local ? "" : "not measured")}</small></div>
                  </div>
                );
              })}
            </div>
            <div className={`card note-card ${sandboxOk ? "" : "bad"}`}>
              <span className="tile"><Icon name={sandboxOk ? "shield" : "shieldX"} /></span>
              <div><b>{sandboxOk ? "Sandbox enforced" : "Sandbox not verified"}</b>
                <p>{sandboxOk ? `Every step runs inside the sandbox (${props.hello?.sandbox.reason}). Gates decide what it may do beyond that.` : `${props.hello?.sandbox.reason ?? "govd is not connected"}. GovernCode runs nothing until the sandbox is verified.`}</p></div>
            </div>
          </div>
        </div>
      </div></div>
    </section>
  );
}
