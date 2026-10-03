// Settings: the Controller of each project, each Runner's Limits (the share of every usage
// window held back for you), and the sandbox. Settings live in govd's state, out of every
// AI tool's reach; the renderer only asks govd to change them.
import { useCallback, useEffect, useState } from "react";
import { call, controllerLabel, type Project } from "../api.ts";
import type { Hello } from "../../shared/contract.ts";
import { Pill } from "../ui.tsx";
import { Tools } from "./Tools.tsx";
import type { ProviderLimit } from "./Limits.tsx";

type Reserves = Record<string, Record<string, number>>;
type Effort = "low" | "medium" | "high" | "max" | null;
type SettingsValue = { reserves: Reserves; runners: Record<string, { model: string; effort: Effort }>; specModels: "free" | "within" | "defaults";
  gates: { quietReads: boolean; level: "relaxed" | "balanced" | "strict" }; local: { maxRunning: number; maxMinutes: number };
  memory: { conversationChars: number }; specs: { maxPerProject: number; maxPerRunner: number };
  personal: { claude: boolean | null; codex: boolean | null }; budgets: Record<string, Budget>; recovery: { autoResume: boolean } };
type Budget = { unit: "tokens" | "turns"; windows: Partial<Record<BudgetWindow, number>> };
type BudgetWindow = "5-hour" | "daily" | "weekly" | "monthly";
const BUDGET_WINDOWS: BudgetWindow[] = ["5-hour", "daily", "weekly", "monthly"];
const EMPTY: SettingsValue = { reserves: {}, runners: {}, specModels: "free", gates: { quietReads: true, level: "balanced" },
  local: { maxRunning: 1, maxMinutes: 10 }, memory: { conversationChars: 16_000 }, specs: { maxPerProject: 3, maxPerRunner: 2 },
  personal: { claude: null, codex: null }, budgets: {}, recovery: { autoResume: false } };
const LEVELS: Array<[SettingsValue["gates"]["level"], string, string]> = [
  ["relaxed", "Relaxed", "Only risky steps ask: deleting, git commands that change the repository, installing packages, network tools, sudo, interpreters, and handing work to a paid Runner. Everything else runs and is recorded in the Trace."],
  ["balanced", "Balanced (default)", "Each new kind of command asks once; answer \u201cAllow for this project\u201d and that kind stops asking here. Risky steps always ask."],
  ["strict", "Strict", "Every step asks, except plain reads (if quiet reads are on) and rules you made. For demos, audits, or when you want to watch everything."],
];
type AllowRule = { id: string; project: string | null; label: string; created: string };
const POLICIES: Array<[SettingsValue["specModels"], string, string]> = [
  ["free", "Controller picks", "It chooses the model and effort for each Spec."],
  ["within", "Within the defaults", "The default model; a lower effort than the default is fine, never a higher one."],
  ["defaults", "Always the defaults", "Every Spec uses the Runner's default model and effort."],
];
const WINDOWS = ["weekly", "5-hour"];      // shown before a Runner has been measured

export function Settings(props: { projects: Project[]; hello: Hello | null; onChangeController: (project: string) => void }) {
  const [providers, setProviders] = useState<ProviderLimit[]>([]);
  const [saved, setSaved] = useState<SettingsValue>(EMPTY);
  const [draft, setDraft] = useState<SettingsValue>(EMPTY);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rules, setRules] = useState<AllowRule[]>([]);
  const loadRules = useCallback(async () => {
    try { setRules((await call<{ rules: AllowRule[] }>("allows.list", {})).rules); } catch { /* shown by the status bar */ }
  }, []);
  useEffect(() => { void loadRules(); }, [loadRules]);
  const revoke = async (id: string) => {
    try { await call("allows.revoke", { id }); await loadRules(); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };

  const load = useCallback(async () => {
    try {
      const [l, s] = await Promise.all([call<{ providers: ProviderLimit[] }>("limits.list", { measure: false }),
        call<{ settings: SettingsValue }>("settings.get", {})]);
      // An older govd (over a tunnel) may not know a newer setting: the defaults fill it in.
      const value = { ...EMPTY, ...s.settings };
      setProviders(l.providers); setSaved(value); setDraft(value);
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  }, []);
  useEffect(() => {
    // Shown at once; then measured once, as the Limits view does: right after govd starts nothing is
    // measured yet, and every Runner would read "held" until something measured it.
    void load().then(async () => {
      try { setProviders((await call<{ providers: ProviderLimit[] }>("limits.list", { measure: true })).providers); } catch { /* the first reading stays */ }
    });
  }, [load]);

  const value = (provider: string, window: string) => draft.reserves[provider]?.[window] ?? 10;
  const set = (provider: string, window: string, n: number) =>
    setDraft((d) => ({ ...d, reserves: { ...d.reserves, [provider]: { ...(d.reserves[provider] ?? {}), [window]: n } } }));
  const setDefault = (provider: string, model: string, effort: Effort) =>
    setDraft((d) => {
      const runners = { ...d.runners };
      if (model.trim()) runners[provider] = { model: model.trim(), effort }; else delete runners[provider];
      return { ...d, runners };
    });
  // A budget cap per window (empty: none; no caps at all: no budget). Switching the unit drops caps set in the other one.
  const setBudget = (provider: string, unit: Budget["unit"], window: BudgetWindow | null, cap: number | null) =>
    setDraft((d) => {
      const old = d.budgets[provider];
      const windows = { ...(old && old.unit === unit ? old.windows : {}) };
      if (window) { if (cap === null) delete windows[window]; else windows[window] = cap; }
      const budgets = { ...d.budgets };
      if (Object.keys(windows).length || window === null) budgets[provider] = { unit, windows }; else delete budgets[provider];
      return { ...d, budgets };
    });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const valid = Object.values(draft.reserves).every((w) => Object.values(w).every((n) => Number.isInteger(n) && n >= 0 && n <= 90))
    && Object.values(draft.budgets).every((b) => Object.values(b.windows).every((n) => Number.isInteger(n) && n! >= 1))
    && Object.values(draft.runners).every((r) => r.model.length <= 80);
  const save = async () => {
    try {
      const r = await call<{ settings: SettingsValue }>("settings.set", draft);   // the whole object: set replaces it
      const value = { ...EMPTY, ...r.settings };
      setSaved(value); setDraft(value);
      setMsg({ ok: true, text: "Saved. New Specs and Limit checks use these." });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <section className="view">
      <div className="view-head"><h1>Settings</h1><span className="dim">kept by govd, where no AI tool can change them</span></div>
      <div className="scroll settings">
        <Tools />

        <h2>Controller per project</h2>
        <p className="dim small">Each project's lead model. It keeps its own subagents and gets GovernCode's delegate tool.</p>
        {!props.projects.length && <p className="dim small">No projects yet.</p>}
        <div className="table">
          {props.projects.map((p) => (
            <div key={p.name} className="tr">
              <b>{p.name}</b><span className="mono small dim">{p.path}</span><span className="mono small">{controllerLabel(p.controller)}</span>
              <button className="btn" onClick={() => props.onChangeController(p.name)}>Change</button>
            </div>
          ))}
        </div>

        <h2>Runners · Limits</h2>
        <p className="dim small">The share of each usage window kept back for you: a Spec never starts if it would reach into it. Unknown or stale usage always holds.</p>
        {!providers.length && <p className="dim small">No Runners with a usage source yet.</p>}
        {providers.map((p) => {
          const measured = p.readings.filter((r) => !r.counted).map((r) => r.window);
          const windows = measured.length ? measured : WINDOWS;
          const budget = draft.budgets[p.provider];
          return (
            <div key={p.provider} className="checkpoint">
              <div className="row"><b>{p.provider}</b><span className="spacer" />{p.verdict.ok ? <Pill tone="ok">available</Pill> : <Pill tone="warn">held</Pill>}</div>
              <div className="row reserve-row">
                <label className="field inline">
                  <span className="dim small">default model</span>
                  <input className="model-input" value={draft.runners[p.provider]?.model ?? ""} placeholder="(Controller picks)" aria-label={`${p.provider} default model`}
                    onChange={(e) => setDefault(p.provider, e.target.value, draft.runners[p.provider]?.effort ?? null)} />
                </label>
                {!p.local && <label className="field inline">
                  <span className="dim small">effort</span>
                  <select value={draft.runners[p.provider]?.effort ?? ""} disabled={!draft.runners[p.provider]} aria-label={`${p.provider} default effort`}
                    onChange={(e) => setDefault(p.provider, draft.runners[p.provider]?.model ?? "", (e.target.value || null) as Effort)}>
                    <option value="">default</option>{["low", "medium", "high", "max"].map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </label>}
              </div>
              {p.local ? <div className="dim small">A local model: no usage window to keep back. Its Limit is under Local models below.</div> : <div className="row reserve-row">
                {windows.map((w) => (
                  <label key={w} className="field inline">
                    <span className="dim small">{w} · keep back</span>
                    <input type="number" min={0} max={90} step={1} value={value(p.provider, w)} aria-label={`${p.provider} ${w} reserve percent`}
                      onChange={(e) => set(p.provider, w, Math.round(Number(e.target.value)))} />
                    <span className="dim small">%</span>
                  </label>
                ))}
              </div>}
              {!p.local && <div className="row reserve-row">
                <label className="field inline">
                  <span className="dim small">budget in</span>
                  <select value={budget?.unit ?? "turns"} aria-label={`${p.provider} budget unit`}
                    onChange={(e) => setBudget(p.provider, e.target.value as Budget["unit"], null, null)}>
                    <option value="turns">turns</option><option value="tokens">tokens</option>
                  </select>
                </label>
                {BUDGET_WINDOWS.map((w) => (
                  <label key={w} className="field inline">
                    <span className="dim small">{w}</span>
                    <input type="number" min={1} step={1} value={budget?.windows[w] ?? ""} placeholder="none" aria-label={`${p.provider} ${w} budget`}
                      onChange={(e) => setBudget(p.provider, budget?.unit ?? "turns", w, e.target.value === "" ? null : Number(e.target.value))} />
                  </label>
                ))}
              </div>}
              {!p.local && <div className="dim small">Budget: optional, counted by GovernCode only. It counts only what its own Runners use (not your own sessions or other apps), so set it below your real plan. Both it and the tool's own report are checked; the stricter one decides.</div>}
            </div>
          );
        })}
        <h2>Specs at once</h2>
        <p className="dim small">How many Specs may run at the same time in one project, and for one Runner across all projects, on top of each Runner's Limits. Past that, a new handoff is refused and the Controller is told to wait for one to finish.</p>
        <div className="row reserve-row">
          {([["maxPerProject", "per project"], ["maxPerRunner", "per Runner"]] as const).map(([k, label]) => (
            <label key={k} className="field inline">
              <span className="dim small">at most</span>
              <input type="number" min={1} max={10} step={1} value={draft.specs[k]} aria-label={`Specs at once ${label}`}
                onChange={(e) => setDraft((d) => ({ ...d, specs: { ...d.specs, [k]: Math.round(Number(e.target.value)) || 0 } }))}
                onBlur={() => setDraft((d) => ({ ...d, specs: { ...d.specs, [k]: Math.min(10, Math.max(1, d.specs[k])) } }))} />
              <span className="dim small">{label}</span>
            </label>
          ))}
        </div>

        {props.hello?.features.includes("recovery") && <>
          <h2>Usage limits</h2>
          <label className="policy-option">
            <input type="checkbox" checked={draft.recovery.autoResume}
              onChange={(e) => setDraft((d) => ({ ...d, recovery: { autoResume: e.target.checked } }))} />
            <span><b>Resume at the reset time by default</b><span className="dim small"> · Resume now is always available. A resume measures usage again first. Unattended resumes run only while the Dashboard is open, and a reset time is never guessed.</span></span>
          </label>
        </>}

        <h2>Local models</h2>
        <p className="dim small">A local model has no usage to measure, so its Limit is your machine's. It runs no commands: it proposes whole files, GovernCode checks them against the Spec's scope, and you review them like any other Spec.</p>
        <div className="row reserve-row">
          <label className="field inline">
            <span className="dim small">at most</span>
            <input type="number" min={1} max={8} step={1} value={draft.local.maxRunning} aria-label="local Specs at once"
              onChange={(e) => setDraft((d) => ({ ...d, local: { ...d.local, maxRunning: Math.min(8, Math.max(1, Math.round(Number(e.target.value)))) } }))} />
            <span className="dim small">at once</span>
          </label>
          <label className="field inline">
            <span className="dim small">each stopped after</span>
            <input type="number" min={1} max={120} step={1} value={draft.local.maxMinutes} aria-label="minutes per local Spec"
              onChange={(e) => setDraft((d) => ({ ...d, local: { ...d.local, maxMinutes: Math.min(120, Math.max(1, Math.round(Number(e.target.value)))) } }))} />
            <span className="dim small">min</span>
          </label>
        </div>

        <h2>Project memory</h2>
        <p className="dim small">How much of the recent conversation each Controller turn gets. Whole messages only, never cut: the rest is left out whole, and the Controller can read it with GovernCode's conversation_read tool.</p>
        <div className="row reserve-row">
          <label className="field inline">
            <span className="dim small">up to</span>
            <input type="number" min={2000} max={48000} step={1000} value={draft.memory.conversationChars} aria-label="recent conversation characters"
              onChange={(e) => setDraft((d) => ({ ...d, memory: { conversationChars: Math.round(Number(e.target.value)) || 0 } }))}
              onBlur={() => setDraft((d) => ({ ...d, memory: { conversationChars: Math.min(48000, Math.max(2000, d.memory.conversationChars)) } }))} />
            <span className="dim small">characters per turn</span>
          </label>
        </div>

        <h2>Personal instructions</h2>
        <p className="dim small">Whether a Controller brings the instructions you set up for it outside GovernCode. Off: it starts clean, the same for everyone. On: your own setup comes along. The sandbox and Gates apply the same either way.</p>
        {([["claude", "Claude Code", "CLAUDE.md, skills, agents, commands, plugins and hooks"], ["codex", "Codex", "AGENTS.md"]] as const).map(([k, tool, files]) => (
          <label key={k} className="policy-option">
            <input type="checkbox" checked={draft.personal[k] === true} onChange={(e) => setDraft((d) => ({ ...d, personal: { ...d.personal, [k]: e.target.checked } }))} />
            <span><b>{tool}: use my instructions</b><span className="dim small"> · {files}{draft.personal[k] === null ? " (not chosen yet: off, and asked the first time)" : ""}</span></span>
          </label>
        ))}

        <h2>Gates</h2>
        <p className="dim small">The sandbox applies to every step at every level: it is what keeps the AI inside the project. These settings only decide which steps stop to ask you first.</p>
        {LEVELS.map(([v, title, text]) => (
          <label key={v} className="policy-option">
            <input type="radio" name="gate-level" checked={draft.gates.level === v} onChange={() => setDraft((d) => ({ ...d, gates: { ...d.gates, level: v } }))} />
            <span><b>{title}</b><span className="dim small"> · {text}</span></span>
          </label>
        ))}
        <label className="policy-option">
          <input type="checkbox" checked={draft.gates.quietReads} onChange={(e) => setDraft((d) => ({ ...d, gates: { ...d.gates, quietReads: e.target.checked } }))} />
          <span><b>Quiet reads</b><span className="dim small"> · plain read-only commands (ls, cat, grep, rg…) run without asking. Everything else still asks.</span></span>
        </label>
        <div className="small"><b>Remembered for projects</b> <span className="dim">· made with “Allow for this project” on a Gate</span></div>
        {!rules.length && <p className="dim small">None. Turn and Spec allows end on their own and aren't listed.</p>}
        <div className="table">
          {rules.map((r) => (
            <div key={r.id} className="tr rule">
              <b className="mono">{r.id}</b><span>{r.project}</span><span className="small">{r.label}</span>
              <button className="btn" onClick={() => revoke(r.id)}>Revoke</button>
            </div>
          ))}
        </div>

        <h2>Model and effort per Spec</h2>
        <div className="policy" role="radiogroup" aria-label="Model and effort per Spec">
          {POLICIES.map(([id, label, help]) => (
            <label key={id} className={`policy-option ${draft.specModels === id ? "on" : ""}`}>
              <input type="radio" name="specModels" checked={draft.specModels === id} onChange={() => setDraft((d) => ({ ...d, specModels: id }))} />
              <span><b>{label}</b><span className="dim small"> · {help}</span></span>
            </label>
          ))}
        </div>
        <p className="dim small">The Controller's pick is a request. When your setting changes it, the Spec says so.</p>
        <div className="row">
          <button className="btn btn-accent" disabled={!dirty || !valid} onClick={save}>Save settings</button>
          {!valid && <span className="error small">Reserves must be whole numbers from 0 to 90; budgets whole numbers of 1 or more.</span>}
          {msg && <span className={msg.ok ? "ok small" : "error small"}>{msg.text}</span>}
        </div>

        <h2>Sandbox</h2>
        <div className="row">
          {props.hello?.sandbox.ok ? <Pill tone="ok">sandbox enforced</Pill> : <Pill tone="danger">sandbox not verified</Pill>}
          <span className="dim small">{props.hello?.sandbox.reason ?? "govd not connected"}</span>
        </div>
        <p className="dim small">Always on and fails closed: there is no off switch, per project or otherwise. On Linux every AI tool runs under Landlock (files and TCP ports) and seccomp, started only by govern-sup after its self-test passes on this machine.</p>
      </div>
    </section>
  );
}
