// The Dashboard shell: top bar (project switcher, govd and sandbox status), left nav, the
// current screen, and the status bar. Holds what outlives a screen: connection status,
// projects, open Gates and the Terminal's conversations.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AskEvent, Status } from "../shared/contract.ts";
import { api, call, controllerLabel, START_GOVD, useFallbackPoll, useWatch, type Gate, type Project } from "./api.ts";
import { Empty, Pill } from "./ui.tsx";
import { PersonalDialog } from "./views/PersonalDialog.tsx";
import { Terminal, type Entry, type Thread } from "./views/Terminal.tsx";
import { Pipeline } from "./views/Pipeline.tsx";
import { Gates } from "./views/Gates.tsx";
import { Trace } from "./views/Trace.tsx";
import { Checkpoints } from "./views/Checkpoints.tsx";
import { Notes } from "./views/Notes.tsx";
import { CrewView } from "./views/Crew.tsx";
import { Limits } from "./views/Limits.tsx";
import { HomePanel } from "./views/HomePanel.tsx";
import { Settings } from "./views/Settings.tsx";
import { ControllerPicker, NewProject, OpenFolder } from "./views/ProjectDialogs.tsx";
import mark from "../../../../docs/brand/governcode-mark.svg";

type View = "terminal" | "crew" | "pipeline" | "checkpoints" | "notes" | "gates" | "limits" | "trace" | "settings";
const VIEWS: Array<[View, string]> = [["terminal", "Terminal"], ["crew", "Crew"], ["pipeline", "Pipeline"], ["checkpoints", "Checkpoints"], ["notes", "Notes"], ["gates", "Gates"], ["limits", "Limits"], ["trace", "Trace"], ["settings", "Settings"]];
const HOME = "";


export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<string>(HOME);
  const [view, setView] = useState<View>("terminal");
  const [gates, setGates] = useState<Gate[]>([]);
  const [gatesAt, setGatesAt] = useState(0);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [dialog, setDialog] = useState<"new" | "open" | "controller" | null>(null);
  const askThread = useRef(new Map<string, string>());

  const up = status?.state === "up";
  const hello = status?.state === "up" ? status.hello : null;
  const live = !!hello?.features.includes("watch");

  useEffect(() => {
    void api().status().then(setStatus);
    return api().onStatus(setStatus);
  }, []);

  const loadProjects = useCallback(async () => {
    try { setProjects((await call<{ projects: Project[] }>("project.list")).projects); } catch { /* status shows govd down */ }
  }, []);

  const refreshGates = useCallback(async () => {
    const at = Date.now();
    try {
      const r = await call<{ gates: Gate[] }>("gate.list");
      setGates(r.gates);
      setGatesAt(at);
    } catch { /* status handles govd going away */ }
  }, []);

  // Reload whenever govd (re)connects; after that, govd's watch stream says when to.
  useEffect(() => {
    if (!up) return;
    void loadProjects();
    void refreshGates();
  }, [up, status, loadProjects, refreshGates]);
  useFallbackPoll(live || !up, refreshGates);
  useWatch((w) => {
    if (w.kind === "gates") void refreshGates();
    else if (w.event.kind.startsWith("project.") || w.event.kind === "controller.set") void loadProjects();
    else if (w.event.project && (w.event.kind === "checkpoint.taken" || w.event.kind === "checkpoint.undone")) {
      // A Controller turn's Checkpoint, shown in that project's Terminal (and marked when undone).
      const d = w.event.data, turn = String(d.turn), files = Array.isArray(d.files) ? d.files.map(String) : [];
      push(w.event.project, (t) => w.event.kind === "checkpoint.taken"
        ? { ...t, entries: [...t.entries, { t: "checkpoint", id: turn, files }] }
        : { ...t, entries: t.entries.map((e) => e.t === "checkpoint" && e.id === turn ? { ...e, undone: true } : e) });
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

  // The first message to a Controller asks once whether the user's own instructions come along.
  const [personalAsk, setPersonalAsk] = useState<{ provider: "claude" | "codex"; prompt: string } | null>(null);
  const send = useCallback(async (prompt: string) => {
    const provider = projects.find((p) => p.name === project)?.controller.provider === "codex" ? "codex" : "claude";
    const s = await call<{ settings: { personal?: Record<string, boolean | null> } }>("settings.get").catch(() => null);
    if (s && s.settings.personal && s.settings.personal[provider] === null) { setPersonalAsk({ provider, prompt }); return; }
    await sendNow(prompt);
  }, [project, projects]); // eslint-disable-line react-hooks/exhaustive-deps

  const choosePersonal = useCallback(async (use: boolean) => {
    const ask = personalAsk;
    if (!ask) return;
    const s = await call<{ settings: Record<string, any> }>("settings.get");
    await call("settings.set", { ...s.settings, personal: { ...s.settings.personal, [ask.provider]: use } });
    setPersonalAsk(null);
    await sendNow(ask.prompt);
  }, [personalAsk]); // eslint-disable-line react-hooks/exhaustive-deps

  const newConversation = useCallback(async () => {
    const key = project;
    await call("conversation.reset", { project: key === HOME ? null : key });
    push(key, () => ({ entries: [], busy: false }));
  }, [project, push]);

  const sendNow = useCallback(async (prompt: string) => {
    const key = project;
    const askId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    askThread.current.set(askId, key);
    push(key, (t) => ({ entries: [...t.entries, { t: "you", text: prompt }], busy: true }));
    const r = await api().ask(askId, key === HOME ? null : key, prompt);
    askThread.current.delete(askId);
    push(key, (t) => ({ busy: false, entries: [...t.entries, r.ok
      ? { t: "done", ok: r.value.ok, summary: r.value.summary }
      : { t: "error", text: r.error }] }));
  }, [project, push]);

  const markGate = useCallback((key: string, id: string, a: "allow" | "deny") => {
    push(key, (t) => ({ ...t, entries: t.entries.map((e) => e.t === "gate" && e.id === id ? { ...e, answered: a } : e) }));
    void refreshGates();
  }, [push, refreshGates]);

  const current = projects.find((p) => p.name === project);
  const opened = (p: Project) => { setDialog(null); void loadProjects(); setProject(p.name); };

  return (
    <div className="app">
      <header className="topbar">
        <img src={mark} className="mark" alt="" />
        <span className="brand">GovernCode</span>
        <label className="switcher">
          <span className="dim">Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} disabled={!up} title={project === HOME ? "No project (Home)" : project}>
            <option value={HOME}>No project (Home)</option>
            {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        <button className="btn btn-quiet" disabled={!up} onClick={() => setDialog("new")}>New project</button>
        <button className="btn btn-quiet" disabled={!up} onClick={() => setDialog("open")}>Open folder</button>
        <button className="btn btn-quiet" disabled={!up || !current} onClick={() => setDialog("controller")}
          title={current ? controllerLabel(current.controller) : "Home uses the most recently chosen Controller"}>Controller</button>
        <span className="spacer" />
        {/* A narrow window may shorten a pill; its tooltip always has the whole text. */}
        {status === null || status.state === "connecting" ? <Pill tone="dim" title="govd: connecting">govd: connecting</Pill>
          : status.state === "down" ? <Pill tone="danger" title={`govd: not running (${status.error})`}>govd: not running</Pill>
          : <Pill tone="ok" title={`govd ${status.hello.version} · protocol ${status.hello.protocol}`}>govd {status.hello.version}</Pill>}
        {hello && (hello.sandbox.ok
          ? <Pill tone="ok" title={`sandbox enforced: ${hello.sandbox.reason}`}>sandbox enforced</Pill>
          : <Pill tone="danger" title={`sandbox NOT verified: ${hello.sandbox.reason}`}>sandbox NOT verified</Pill>)}
      </header>

      <nav className="nav">
        {VIEWS.map(([id, label]) => (
          <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => setView(id)}>
            <span>{label}</span>
            {id === "gates" && gates.length > 0 && <span className="badge">{gates.length}</span>}
          </button>
        ))}
      </nav>

      <main className="main">
        {!up ? <Down status={status} /> : (
          <>
            {view === "terminal" && (
              <div className={project === HOME ? "home" : "contents"}>
                <Terminal key={project} project={current ?? null}
                  thread={threads[project] ?? { entries: [], busy: false }} openGates={gates} gatesAt={gatesAt}
                  onSend={send} onGate={(id, a) => markGate(project, id, a)} onOpenProject={setProject} onNewConversation={newConversation} />
                {project === HOME && <HomePanel projects={projects} gates={gates} onOpen={setProject} onGates={() => setView("gates")} />}
              </div>
            )}
            {view === "pipeline" && <Pipeline project={current?.name ?? null} live={live} />}
            {view === "checkpoints" && <Checkpoints project={current?.name ?? null} live={live} />}
            {view === "crew" && <CrewView key={current?.name ?? "home"} project={current?.name ?? null} />}
            {view === "notes" && <Notes key={current?.name ?? "home"} project={current?.name ?? null} />}
            {view === "limits" && <Limits />}
            {view === "settings" && <Settings projects={projects} hello={hello} onChangeController={(name) => { setProject(name); setDialog("controller"); }} />}
            {view === "gates" && <Gates gates={gates} onAnswered={() => void refreshGates()} />}
            {view === "trace" && <Trace project={current?.name ?? null} live={live} />}
          </>
        )}
      </main>

      {up && dialog === "new" && <NewProject onClose={() => setDialog(null)} onDone={opened} />}
      {up && dialog === "open" && <OpenFolder onClose={() => setDialog(null)} onDone={opened} />}
      {up && personalAsk && <PersonalDialog provider={personalAsk.provider} onChoose={(use) => void choosePersonal(use)} onClose={() => setPersonalAsk(null)} />}
      {up && dialog === "controller" && current && <ControllerPicker project={current} onClose={() => setDialog(null)}
        onDone={() => { setDialog(null); void loadProjects(); }} />}

      <footer className="statusbar">
        <span>{current ? `${current.name} · ${current.path}` : "Home (read-only)"}</span>
        {current && <span className="dim">Controller: {controllerLabel(current.controller)}</span>}
        <span className="spacer" />
        {hello && <span className="dim">protocol {hello.protocol} · {live ? "live" : "polling"}</span>}
        <span className={`gate-count ${gates.length ? "warn" : "dim"}`}>{gates.length} Gate{gates.length === 1 ? "" : "s"} waiting</span>
        <span className="dim mono">{status?.socketPath}</span>
      </footer>
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
