// The Dashboard shell: the sidebar (Overview, Needs you, projects, the Crew's allowance, the
// sandbox), and the current place: a global screen, or a project with its tabs. Holds what outlives
// a screen: connection status, projects, Specs, open Gates, Limits and the conversations.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AskEvent, Status, TraceEvent } from "../shared/contract.ts";
import { api, call, modelLabel, personalKey, START_GOVD, useFallbackPoll, useWatch, type Controller, type Gate, type Project, type RecoveryItem, type Spec } from "./api.ts";
import { Empty, Glyph } from "./ui.tsx";
import { Icon } from "./icons.tsx";
import { ProviderMark, providerName } from "./brand.tsx";
import { useTheme } from "./theme.ts";
import { PersonalDialog } from "./views/PersonalDialog.tsx";
import { Terminal, type Entry, type Thread } from "./views/Terminal.tsx";
import { Pipeline } from "./views/Pipeline.tsx";
import { Trace } from "./views/Trace.tsx";
import { Checkpoints } from "./views/Checkpoints.tsx";
import { Notes } from "./views/Notes.tsx";
import { CrewView } from "./views/Crew.tsx";
import { Limits, type ProviderLimit } from "./views/Limits.tsx";
import { Overview } from "./views/Overview.tsx";
import { NeedsYou } from "./views/NeedsYou.tsx";
import { Settings } from "./views/Settings.tsx";
import { Sidebar, type Place, type Tab } from "./views/Sidebar.tsx";
import { ControllerPicker, NewProject, OpenFolder } from "./views/ProjectDialogs.tsx";
import { hasActiveAsk } from "../shared/pending.ts";

const HOME = "";
const TABS: Array<[Tab, string]> = [["conversation", "Conversation"], ["specs", "Specs"], ["checkpoints", "Checkpoints"], ["notes", "Notes"], ["trace", "Trace"], ["crew", "Crew card"]];
const IN_FLIGHT = new Set(["queued", "held", "running", "needs-review"]);

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [homeController, setHomeController] = useState<Controller | null>(null);   // what a turn at Home runs now
  const [place, setPlace] = useState<Place>({ kind: "global", id: "overview" });
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [limits, setLimits] = useState<ProviderLimit[]>([]);
  const [held, setHeld] = useState<RecoveryItem[]>([]);   // limited Specs (not turns), as recovery.list has them
  const [gates, setGates] = useState<Gate[]>([]);
  const [gatesAt, setGatesAt] = useState(0);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [dialog, setDialog] = useState<"new" | "open" | "controller" | null>(null);
  const askThread = useRef(new Map<string, string>());
  const waking = useRef(new Set<string>());   // projects whose Controller is in a wake turn now

  useTheme();
  // A project's key in the conversations; Home's is "". Global screens other than Home have none.
  const project = place.kind === "project" ? place.name : HOME;
  const setProject = useCallback((name: string) => setPlace(name === HOME ? { kind: "global", id: "home" } : { kind: "project", name, tab: "conversation" }), []);
  const up = status?.state === "up";
  const hello = status?.state === "up" ? status.hello : null;
  const live = !!hello?.features.includes("watch");
  const recovery = !!hello?.features.includes("recovery");

  useEffect(() => {
    void api().status().then(setStatus);
    return api().onStatus(setStatus);
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const r = await call<{ projects: Project[]; home?: { controller: Controller } }>("project.list");
      setProjects(r.projects);
      setHomeController(r.home?.controller ?? null);
    } catch { /* status shows govd down */ }
  }, []);

  const refreshGates = useCallback(async () => {
    const at = Date.now();
    try {
      const r = await call<{ gates: Gate[] }>("gate.list");
      setGates(r.gates);
      setGatesAt(at);
    } catch { /* status handles govd going away */ }
  }, []);

  // Specs and Limits for the sidebar and the Overview: the readings govd already has (measuring
  // starts a tool, so only the Allowance screen does that, on open or when asked).
  const refreshSpecs = useCallback(async () => {
    try { setSpecs((await call<{ specs: Spec[] }>("spec.list", {})).specs); } catch { /* status shows govd down */ }
  }, []);
  const refreshLimits = useCallback(async () => {
    try { setLimits((await call<{ providers: ProviderLimit[] }>("limits.list", { measure: false })).providers); } catch { /* status shows govd down */ }
  }, []);
  const refreshHeld = useCallback(async () => {
    if (!recovery) { setHeld([]); return; }
    try { setHeld((await call<{ items: RecoveryItem[] }>("recovery.list", {})).items.filter((i) => i.kind !== "turn")); } catch { /* an older govd: nothing held to show */ }
  }, [recovery]);

  // Reload whenever govd (re)connects; after that, govd's watch stream says when to.
  useEffect(() => {
    if (!up) return;
    void loadProjects();
    void refreshGates();
    void refreshSpecs();
    void refreshLimits();
    void refreshHeld();
  }, [up, status, loadProjects, refreshGates, refreshSpecs, refreshLimits, refreshHeld]);
  useFallbackPoll(live || !up, refreshGates);
  useFallbackPoll(live || !up, refreshSpecs);
  useWatch((w) => {
    if (w.kind === "trace" && w.event.kind.startsWith("spec.") && w.event.kind !== "spec.step") { void refreshSpecs(); void refreshLimits(); void refreshHeld(); }
    if (w.kind === "trace" && w.event.kind.startsWith("recovery.")) void refreshHeld();
    if (w.kind === "trace" && w.event.kind === "settings.changed") void refreshLimits();
    if (w.kind === "gates") void refreshGates();
    else if (w.event.kind.startsWith("project.") || w.event.kind === "controller.set") void loadProjects();
    else if (w.event.project && (w.event.kind === "checkpoint.taken" || w.event.kind === "checkpoint.undone")) {
      // A Controller turn's Checkpoint, shown in that project's Terminal (and marked when undone).
      const d = w.event.data, turn = String(d.turn), files = Array.isArray(d.files) ? d.files.map(String) : [];
      push(w.event.project, (t) => w.event.kind === "checkpoint.taken"
        ? { ...t, entries: [...t.entries, { t: "checkpoint", id: turn, files }] }
        : { ...t, entries: t.entries.map((e) => e.t === "checkpoint" && e.id === turn ? { ...e, undone: true } : e) });
    } else if (w.event.project && w.event.kind.startsWith("turn.")) {
      const entry = wakeEntry(w.event, waking.current);
      if (entry) push(w.event.project, (t) => ({ ...t, entries: [...t.entries, entry] }));
    }
  });

  const push = useCallback((key: string, f: (t: Thread) => Thread) => {
    setThreads((all) => ({ ...all, [key]: f(all[key] ?? { entries: [], busy: false }) }));
  }, []);

  useEffect(() => api().onEvent((askId, ev: AskEvent) => {
    const key = askThread.current.get(askId);
    if (key === undefined) return;
    push(key, (t) => ({ ...t, entries: addEvent(t.entries, ev) }));
    if (ev.kind === "gate" && !live) void refreshGates();
  }), [push, refreshGates, live]);

  // The first message to a Controller asks once whether the user's own instructions come along:
  // about the tool this turn runs (the project's Controller, or Home's), and only once that tool
  // is connected (otherwise govd refuses the turn and says how to connect), as gov ask does.
  const [personalAsk, setPersonalAsk] = useState<{ askId: string; key: string; provider: "claude" | "codex";
    prompt: string; home: boolean; continuationOf?: string } | null>(null);

  const newConversation = useCallback(async () => {
    const key = project;
    await call("conversation.reset", { project: key === HOME ? null : key });
    push(key, () => ({ entries: [], busy: false }));
  }, [project, push]);

  const finishAsk = useCallback((askId: string, entry?: Entry) => {
    const key = askThread.current.get(askId);
    if (key === undefined) return;
    askThread.current.delete(askId);
    push(key, (t) => ({ ...t, busy: hasActiveAsk(askThread.current, key), entries: entry ? [...t.entries, entry] : t.entries }));
  }, [push]);

  const beginAsk = useCallback((key: string): string | null => {
    if (hasActiveAsk(askThread.current, key)) return null;
    const askId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    askThread.current.set(askId, key);
    push(key, (t) => ({ ...t, busy: true }));
    return askId;
  }, [push]);

  const sendNow = useCallback(async (askId: string, key: string, prompt: string, continuationOf?: string) => {
    push(key, (t) => ({ ...t, entries: [...t.entries, { t: "you", text: prompt }] }));
    try {
      const r = await api().ask(askId, key === HOME ? null : key, prompt, continuationOf);
      finishAsk(askId, r.ok ? { t: "done", ok: r.value.ok, summary: r.value.summary } : { t: "error", text: r.error });
    } catch (e) { finishAsk(askId, { t: "error", text: e instanceof Error ? e.message : String(e) }); }
  }, [finishAsk, push]);

  const send = useCallback(async (prompt: string, continuationOf?: string) => {
    const key = project;
    const askId = beginAsk(key);
    if (!askId) return;
    try {
      const provider = personalKey(key === HOME ? homeController : projects.find((p) => p.name === key)?.controller);
      const s = await call<{ settings: { personal?: Record<string, boolean | null> } }>("settings.get").catch(() => null);
      if (s?.settings.personal?.[provider] === null) {
        const t = await call<{ tools: Array<{ tool: string; connected: boolean }> }>("tools.list", {}).catch(() => null);
        if (t?.tools.some((x) => x.tool === provider && x.connected)) {
          setPersonalAsk({ askId, key, provider, prompt, home: key === HOME, continuationOf });
          return;
        }
      }
      await sendNow(askId, key, prompt, continuationOf);
    } catch (e) { finishAsk(askId, { t: "error", text: e instanceof Error ? e.message : String(e) }); }
  }, [beginAsk, finishAsk, homeController, project, projects, sendNow]);

  const choosePersonal = useCallback(async (use: boolean) => {
    const ask = personalAsk;
    if (!ask) return;
    setPersonalAsk(null);
    try {
      const s = await call<{ settings: Record<string, any> }>("settings.get");
      await call("settings.set", { ...s.settings, personal: { ...s.settings.personal, [ask.provider]: use } });
      await sendNow(ask.askId, ask.key, ask.prompt, ask.continuationOf);
    } catch (e) {
      finishAsk(ask.askId, { t: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }, [finishAsk, personalAsk, sendNow]);

  const closePersonal = useCallback(() => {
    if (personalAsk) finishAsk(personalAsk.askId);
    setPersonalAsk(null);
  }, [finishAsk, personalAsk]);

  const markGate = useCallback((key: string, id: string, a: "allow" | "deny") => {
    push(key, (t) => ({ ...t, entries: t.entries.map((e) => e.t === "gate" && e.id === id ? { ...e, answered: a } : e) }));
    void refreshGates();
  }, [push, refreshGates]);

  const current = projects.find((p) => p.name === project);
  // The new project is listed at once, so the fallback below does not mistake it for a missing one.
  const opened = (p: Project) => { setDialog(null); setProjects((ps) => ps.some((x) => x.name === p.name) ? ps : [...ps, p]); void loadProjects(); setProject(p.name); };
  // A project that went away (or never loaded) falls back to the Overview.
  useEffect(() => {
    if (place.kind === "project" && projects.length && !projects.some((p) => p.name === place.name)) setPlace({ kind: "global", id: "overview" });
  }, [place, projects]);
  const needs = gates.length + specs.filter((s) => s.status === "needs-review").length + held.length;
  const reviewCount = (name: string) => specs.filter((s) => s.project === name && s.status === "needs-review").length;
  const conversation = (key: string) => (
    <Terminal key={key} project={key === HOME ? null : current ?? null}
      thread={threads[key] ?? { entries: [], busy: false }} openGates={gates} gatesAt={gatesAt}
      recoveryEnabled={recovery} controller={key === HOME ? homeController : current?.controller ?? null}
      onSend={send} onGate={(id, a) => markGate(key, id, a)} onOpenProject={setProject} onNewConversation={newConversation} />
  );

  return (
    <div className="app">
      <Sidebar place={place} onPlace={setPlace} projects={projects} specs={specs} gates={gates} limits={limits} needs={needs}
        status={status} hello={hello} up={up} live={live} socketPath={status?.socketPath} onNewProject={() => setDialog("new")} onOpenFolder={() => setDialog("open")} />

      <main className="main">
        {!up ? <Down status={status} /> : place.kind === "project" && current ? (
          <div className="view in-project">
            <header className="toolbar">
              <Glyph name={current.name} size={24} />
              <div className="title">
                <b>{current.name}</b>
                <button className="sub" title={`${current.path} · change the Controller`} onClick={() => setDialog("controller")}>
                  <ProviderMark id={current.controller.provider} size={14} />{providerName(current.controller.provider)}{current.controller.model.trim() ? ` · ${modelLabel(current.controller.model, current.controller.effort)}` : ""} · Controller<Icon name="chevronDown" size={11} />
                </button>
              </div>
              <div className="tabs seg" role="tablist" aria-label={`${current.name} views`}>
                {TABS.map(([id, label]) => {
                  const n = id === "specs" ? reviewCount(current.name) : 0;
                  return (
                    <button key={id} role="tab" aria-selected={place.tab === id} className={place.tab === id ? "on" : ""}
                      onClick={() => setPlace({ kind: "project", name: current.name, tab: id })}>
                      {label}{n > 0 && <span className="n amber">{n}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="end" />
            </header>
            <div className="content">
              {place.tab === "conversation" && conversation(current.name)}
              {place.tab === "specs" && <Pipeline key={current.name} project={current.name} live={live} recoveryEnabled={recovery} />}
              {place.tab === "checkpoints" && <Checkpoints project={current.name} live={live} />}
              {place.tab === "notes" && <Notes key={current.name} project={current.name} />}
              {place.tab === "trace" && <Trace key={current.name} project={current.name} live={live} />}
              {place.tab === "crew" && <CrewView key={current.name} project={current.name} />}
            </div>
          </div>
        ) : place.kind === "global" && place.id === "home" ? (
          <div className="view in-project">
            <header className="toolbar">
              <span className="glyph" style={{ background: "var(--fill-3)", color: "var(--label-2)", width: 24, height: 24, borderRadius: 7 }}><Icon name="home" size={14} /></span>
              <div className="title"><b>Home</b><span>No project: the Controller can read and plan, and propose a project, but cannot write anything</span></div>
            </header>
            <div className="content">{conversation(HOME)}</div>
          </div>
        ) : place.kind === "global" && place.id === "needs" ? (
          <NeedsYou gates={gates} specs={specs} held={held} onAnswered={() => void refreshGates()} onPlace={setPlace} />
        ) : place.kind === "global" && place.id === "allowance" ? <Limits onMeasured={() => void refreshLimits()} />
          : place.kind === "global" && place.id === "trace" ? <Trace project={null} live={live} />
          : place.kind === "global" && place.id === "settings" ? <Settings projects={projects} hello={hello} onChangeController={(name) => { setProject(name); setDialog("controller"); }} />
          : <Overview projects={projects} specs={specs.filter((s) => IN_FLIGHT.has(s.status))} gates={gates} limits={limits} hello={hello} held={held}
              onPlace={setPlace} onGatesChanged={() => void refreshGates()} onNewProject={() => setDialog("new")} onOpenFolder={() => setDialog("open")} />}
      </main>

      {up && dialog === "new" && <NewProject onClose={() => setDialog(null)} onDone={opened} />}
      {up && dialog === "open" && <OpenFolder onClose={() => setDialog(null)} onDone={opened} />}
      {up && personalAsk && <PersonalDialog provider={personalAsk.provider} home={personalAsk.home} onChoose={(use) => void choosePersonal(use)} onClose={closePersonal} />}
      {up && dialog === "controller" && current && <ControllerPicker project={current} onClose={() => setDialog(null)}
        onDone={() => { setDialog(null); void loadProjects(); }} />}
    </div>
  );
}

function addEvent(entries: Entry[], ev: AskEvent): Entry[] {
  const e = ev as Record<string, any>;
  switch (ev.kind) {
    case "text": return [...entries, { t: "text", text: String(e.text) }];
    case "tool": return [...entries, { t: "tool", name: String(e.name) }];
    case "gate": return [...entries, { t: "gate", id: String(e.id), tool: String(e.tool), canonical: String(e.canonical), arrived: Date.now(),
      covers: typeof e.covers === "string" ? e.covers : null, scopes: Array.isArray(e.scopes) ? e.scopes.map(String) : [],
      suggest: typeof e.suggest === "string" ? e.suggest : null }];
    case "allowed": return [...entries, { t: "allowed", tool: String(e.tool), why: String(e.why) }];
    case "spec": return [...entries, { t: "spec", id: String(e.id), to: String(e.to), brief: String(e.brief), lines: [] }];
    case "proposal": return [...entries, { t: "proposal", id: String(e.id), name: String(e.name), path: String(e.path), git: e.git === true, reason: String(e.reason ?? "") }];
    case "plan": return [...entries, { t: "plan", id: String(e.id), note: String(e.note ?? ""), handoff: String(e.handoff ?? "ask"),
      items: Array.isArray(e.items) ? e.items.slice(0, 12).map((x: any) => ({ who: String(x?.who ?? ""), what: String(x?.what ?? ""), ...(Array.isArray(x?.scope) ? { scope: x.scope.map(String) } : {}) })) : [] }];
    case "spec.text":
    case "spec.tool": {
      const line = ev.kind === "spec.text" ? String(e.text) : `· ${String(e.name)}`;
      let found = false;
      const next = entries.map((x) => x.t === "spec" && x.id === e.id ? (found = true, { ...x, lines: [...x.lines, line] }) : x);
      return found ? next : [...entries, { t: "spec", id: String(e.id), to: "", brief: "", lines: [line] }];
    }
    default: return entries;
  }
}

/**
 * A wake or automatic continuation turn has no ask stream: GovernCode started it itself. Its
 * Controller's words reach that project's Terminal from the Trace, from turn.started to its end;
 * other turns' events are left to their own ask streams.
 */
function wakeEntry(ev: TraceEvent, waking: Set<string>): Entry | null {
  const key = ev.project!, d = ev.data;
  if (ev.kind === "turn.started") {
    if (d.origin !== "wake" && d.origin !== "continuation") { waking.delete(key); return null; }
    waking.add(key);
    return d.origin === "wake" ? { t: "wake", specs: Array.isArray(d.specs) ? d.specs.map(String) : [] }
      : { t: "continuation", turn: String(d.continuationOf) };
  }
  if (!waking.has(key)) return null;
  switch (ev.kind) {
    case "turn.text": return { t: "text", text: String(d.text) };
    case "turn.tool": return { t: "tool", name: String(d.name) };
    case "turn.completed":
    case "turn.failed": waking.delete(key); return { t: "done", ok: ev.kind === "turn.completed", summary: String(d.summary ?? "") };
    default: return null;
  }
}

function Down({ status }: { status: Status | null }) {
  const [trying, setTrying] = useState(false);
  if (!status || status.state === "connecting") return <Empty title="Connecting to govd…" />;
  const retry = async () => { setTrying(true); await api().retry(); setTrying(false); };
  return (
    <Empty title="govd is not running">
      <p className="dim">The Dashboard is a client of govd, the GovernCode daemon. Start it from the repository:</p>
      <pre className="code cmd">{START_GOVD}</pre>
      <p className="dim">Retrying every 3 seconds. {status.state === "down" && <span className="mono">({status.error})</span>}</p>
      <button className="btn" disabled={trying} onClick={retry}>{trying ? "Trying…" : "Retry now"}</button>
    </Empty>
  );
}
