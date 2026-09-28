// Projects from the Dashboard: create one, open an existing folder, choose its Controller.
// Paths come from a text field or the native folder picker (which runs in the main process
// and hands back only the chosen path). govd decides what may be a project.
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { api, call, PROJECT_NAME, type Controller, type Project } from "../api.ts";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id}>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function useSubmit(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await run(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

function FolderField({ label, value, onChange, hint, autoFocus }: { label: string; value: string; onChange: (v: string) => void; hint?: string; autoFocus?: boolean }) {
  const pick = async () => { const p = await api().pickFolder(); if (p) onChange(p); };
  return (
    <label className="field">
      <span>{label}</span>
      <span className="row">
        <input className="mono grow" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} autoFocus={autoFocus} />
        <button type="button" className="btn" onClick={pick}>Browse…</button>
      </span>
      {hint && <span className="hint dim">{hint}</span>}
    </label>
  );
}

export function NewProject({ onClose, onDone }: { onClose: () => void; onDone: (p: Project) => void }) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [git, setGit] = useState(true);
  const nameOk = PROJECT_NAME.test(name);
  const path = location.trim() && name ? `${location.trim().replace(/\/+$/, "")}/${name}` : "";
  const { busy, error, submit } = useSubmit(async () => {
    const r = await call<{ project: Project }>("project.new", { name, path, git });
    onDone(r.project);
  });
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Name</span>
          <input className="mono" value={name} onChange={(e) => setName(e.target.value)} autoFocus spellCheck={false} aria-invalid={!!name && !nameOk} />
          <span className={`hint ${name && !nameOk ? "error" : "dim"}`}>Lowercase letters, digits, . _ - (also the folder name)</span>
        </label>
        <FolderField label="Location" value={location} onChange={setLocation} hint="The folder to create it in" />
        <label className="check"><input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} /> Initialize a git repository</label>
        <div className="hint dim mono">{path ? `Creates ${path}` : " "}</div>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent" disabled={busy || !nameOk || !path}>Create</button>
        </div>
      </form>
    </Modal>
  );
}

export function OpenFolder({ onClose, onDone }: { onClose: () => void; onDone: (p: Project) => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const nameOk = !name || PROJECT_NAME.test(name);
  const { busy, error, submit } = useSubmit(async () => {
    const r = await call<{ project: Project }>("project.open", { path: path.trim(), ...(name ? { name } : {}) });
    onDone(r.project);
  });
  return (
    <Modal title="Open folder" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <FolderField label="Folder" value={path} onChange={setPath} autoFocus hint="An existing folder; it becomes the Controller's writable project" />
        <label className="field">
          <span>Name <span className="dim">(optional)</span></span>
          <input className="mono" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} aria-invalid={!nameOk} />
          <span className={`hint ${nameOk ? "dim" : "error"}`}>Taken from the folder name if empty</span>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent" disabled={busy || !path.trim() || !nameOk}>Open</button>
        </div>
      </form>
    </Modal>
  );
}

const PROVIDERS = ["claude-code", "codex"] as const;
const MODELS: Record<(typeof PROVIDERS)[number], string[]> = { "claude-code": ["opus", "sonnet", "haiku"], codex: ["gpt-5.5"] };
const EFFORTS = ["low", "medium", "high", "max"] as const;

export function ControllerPicker({ project, onClose, onDone }: { project: Project; onClose: () => void; onDone: () => void }) {
  const known = (PROVIDERS as readonly string[]).includes(project.controller.provider);
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>(known ? project.controller.provider as (typeof PROVIDERS)[number] : "claude-code");
  const [model, setModel] = useState(project.controller.model);
  const [effort, setEffort] = useState<string>(project.controller.effort ?? "");
  const listId = useId();
  const changeProvider = (p: (typeof PROVIDERS)[number]) => {
    setProvider(p);
    if (!MODELS[p].includes(model)) setModel(MODELS[p][0]);
  };
  // Switching to another provider: ask once whether it may see this project's context.
  const [ask, setAsk] = useState<{ notes: string; specs: number; checkpoints: number } | null>(null);
  const apply = async (share?: boolean) => {
    if (share !== undefined) await call("context.share", { project: project.name, provider, share });
    const controller: Controller = { provider, model: model.trim(), effort: effort || null };
    await call("controller.set", { project: project.name, controller });
    onDone();
  };
  const { busy, error, submit } = useSubmit(async () => {
    const st = await call<{ providers: string[]; shared: Record<string, boolean>; notes: string; specs: number; checkpoints: number }>("context.state", { project: project.name });
    if (st.providers.some((x) => x !== provider) && st.shared[provider] === undefined) { setAsk(st); return; }
    await apply();
  });
  const who = provider === "codex" ? "Codex (OpenAI)" : provider === "claude-code" ? "Claude Code (Anthropic)" : provider;
  if (ask) return (
    <Modal title={`Share ${project.name}'s context with ${who}?`} onClose={onClose}>
      <div className="form">
        <p>{who} will see this project's conversation, its record ({ask.specs} Specs, {ask.checkpoints} Checkpoints) and its notes{ask.notes ? ":" : " (none yet)."}</p>
        {ask.notes && <pre className="mono small notes-preview">{ask.notes}</pre>}
        <p className="dim small"><b>Share</b>: it picks up where the last Controller left off. <b>Start fresh</b>: it sees only its own turns here. You are asked once per project and provider.</p>
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={() => void apply(false)}>Start fresh</button>
          <button type="button" className="btn btn-accent" autoFocus onClick={() => void apply(true)}>Share and switch</button>
        </div>
      </div>
    </Modal>
  );
  return (
    <Modal title={`Controller for ${project.name}`} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => changeProvider(e.target.value as (typeof PROVIDERS)[number])} autoFocus>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Model</span>
          <input className="mono" list={listId} value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} maxLength={80} />
          <datalist id={listId}>{MODELS[provider].map((m) => <option key={m} value={m} />)}</datalist>
          <span className="hint dim">Suggestions: {MODELS[provider].join(", ")}; any model the tool accepts works</span>
        </label>
        <label className="field">
          <span>Effort</span>
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">n/a</option>
            {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-accent" disabled={busy || !model.trim()}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
