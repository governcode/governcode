// The sidebar: where you are (Overview, Needs you, a project), what each AI has left (Crew), and
// whether the sandbox is on. Everything here is read from govd; nothing in it acts on its own.
import type { ReactNode } from "react";
import type { Hello, Status } from "../../shared/contract.ts";
import { projectStatus, providerUsage } from "../../shared/status.ts";
import { clock, type Gate, type Project, type Spec } from "../api.ts";
import { ProviderMark, providerName } from "../brand.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { Glyph, Ring } from "../ui.tsx";
import type { ProviderLimit } from "./Limits.tsx";
import mark from "../../../../../docs/brand/governcode-mark.svg";
import markLight from "../../../../../docs/brand/governcode-mark-mono.svg";

export type Global = "overview" | "needs" | "watch" | "home" | "allowance" | "trace" | "settings";
export type Tab = "conversation" | "specs" | "checkpoints" | "notes" | "trace" | "crew";
export type Place = { kind: "global"; id: Global } | { kind: "project"; name: string; tab: Tab };

export function Sidebar(props: { place: Place; onPlace: (p: Place) => void; projects: Project[]; specs: Spec[]; gates: Gate[];
  limits: ProviderLimit[]; needs: number; status: Status | null; hello: Hello | null; up: boolean; live: boolean; socketPath?: string; onSearch: () => void; onNewProject: () => void; onOpenFolder: () => void }) {
  const at = (id: Global) => props.place.kind === "global" && props.place.id === id;
  const item = (id: Global, icon: IconName, label: string, tail?: ReactNode) => (
    <button className={`side-item ${at(id) ? "on" : ""}`} onClick={() => props.onPlace({ kind: "global", id })} aria-current={at(id) ? "page" : undefined}>
      <Icon name={icon} /><span className="label">{label}</span>{tail}
    </button>
  );
  const running = (provider: string) => props.specs.filter((s) => s.to === provider && s.status === "running").length;

  return (
    <aside className="sidebar">
      <div className="brandbar">
        <img src={mark} className="only-dark" alt="" />
        <img src={markLight} className="only-light" alt="" />
        <span className="name">GovernCode</span>
        {props.hello && <span className="ver" title={`govd ${props.hello.version} · protocol ${props.hello.protocol}`}>{props.hello.version.replace(/-.*$/, "")}</span>}
      </div>
      <button className="search" disabled={!props.up} onClick={props.onSearch} title="Jump anywhere or answer a Gate">
        <Icon name="search" size={14} /><span>Search or jump to…</span><kbd>Ctrl K</kbd></button>
      <nav className="side-scroll" aria-label="GovernCode">
        {item("overview", "overview", "Overview")}
        {item("needs", "inbox", "Needs you", props.needs > 0 && <span className="badge">{props.needs}</span>)}
        {item("watch", "eye", "Watch")}
        {item("home", "home", "Home", <span className="meta" title="Ask without a project: the Controller can read and plan, not write">no project</span>)}
        {item("allowance", "gauge", "Allowance")}
        {item("trace", "clock", "Trace")}

        <div className="side-head">
          <span className="grow">Projects</span>
          <button className="side-act" title="Open a folder as a project" aria-label="Open folder" disabled={!props.up} onClick={props.onOpenFolder}><Icon name="folder" size={13} /></button>
          <button className="side-act" title="New project" aria-label="New project" disabled={!props.up} onClick={props.onNewProject}><Icon name="plus" size={13} /></button>
        </div>
        {!props.projects.length && <div className="side-item dim" style={{ cursor: "default" }}>None yet</div>}
        {props.projects.map((p) => {
          const st = projectStatus(p.name, props.specs, props.gates);
          const on = props.place.kind === "project" && props.place.name === p.name;
          return (
            <button key={p.name} className={`side-item ${on ? "on" : ""}`} title={`${p.name} · ${st.text}`} aria-current={on ? "page" : undefined}
              onClick={() => props.onPlace({ kind: "project", name: p.name, tab: on && props.place.kind === "project" ? props.place.tab : "conversation" })}>
              <Glyph name={p.name} /><span className="label">{p.name}</span>{st.dot && <span className={`dot ${st.dot}`} aria-label={st.text} />}
            </button>
          );
        })}

        {props.limits.length > 0 && <>
          <div className="side-head"><span className="grow">Crew</span></div>
          {props.limits.map((p) => {
            const u = providerUsage(p);
            const n = running(p.provider);
            const sub = p.local ? "Local model" : p.unmetered ? "Unmetered" : !p.verdict.ok
              ? (p.verdict.resetsAt ? `Held until ${clock(p.verdict.resetsAt).replace(/:\d{2}$/, "")}` : "Held") : n ? `${n} running` : "Available";
            const color = !p.verdict.ok ? "var(--violet)" : n ? "var(--blue)" : "var(--accent)";
            return (
              <button key={p.provider} className="side-item crew-item" title={`${providerName(p.provider)} · ${sub}`} onClick={() => props.onPlace({ kind: "global", id: "allowance" })}>
                {p.local || p.unmetered ? <ProviderMark id={p.provider} size={20} /> : <Ring size={20} stroke={3} percent={u.percent} reserve={u.reserve} color={color} />}
                <span className="who"><span className="ellipsis">{providerName(p.provider)}</span><small>{sub}</small></span>
                <span className="meta">{p.local ? "" : u.counted ? `${u.counted.used}/${u.counted.cap}` : u.window ? `${Math.round(u.percent)}%` : "–"}</span>
              </button>
            );
          })}
        </>}
      </nav>
      <div className="side-foot">
        {props.status?.state !== "up" ? <span className="shield bad"><Icon name="shieldX" size={14} />{props.status?.state === "down" ? "govd is not running" : "Connecting…"}</span>
          : props.hello?.sandbox.ok ? <span className="shield ok" title={`Sandbox enforced: ${props.hello.sandbox.reason}`}><Icon name="shield" size={14} />Sandbox enforced</span>
          : <span className="shield bad" title={`Sandbox NOT verified: ${props.hello?.sandbox.reason}`}><Icon name="shieldX" size={14} />Sandbox NOT verified</span>}
        <span className="spacer" />
        {props.hello && <span className="meta" title={`govd ${props.hello.version} · protocol ${props.hello.protocol} · ${props.live ? "live updates" : "polling every 10 s"}${props.socketPath ? ` · ${props.socketPath}` : ""}`}>{props.live ? "live" : "polling"}</span>}
        <button className={`icon-btn ${at("settings") ? "on" : ""}`} title="Settings" aria-label="Settings" onClick={() => props.onPlace({ kind: "global", id: "settings" })}><Icon name="gear" /></button>
      </div>
    </aside>
  );
}
