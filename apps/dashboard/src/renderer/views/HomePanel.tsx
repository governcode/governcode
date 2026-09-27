// Home's side panel: every project at a glance, the Specs in flight across all of them, and
// the Gates waiting. Read-only; opening a project or a Gate goes through the usual screens.
import { useCallback, useEffect, useState } from "react";
import { call, clock, useWatch, type Gate, type Project, type Spec } from "../api.ts";
import { Pill, SpecPill } from "../ui.tsx";

const IN_FLIGHT = new Set(["queued", "held", "running", "needs-review"]);

export function HomePanel(props: { projects: Project[]; gates: Gate[]; onOpen: (name: string) => void; onGates: () => void }) {
  const [specs, setSpecs] = useState<Spec[]>([]);
  const load = useCallback(async () => {
    try { setSpecs((await call<{ specs: Spec[] }>("spec.list", {})).specs.filter((s) => IN_FLIGHT.has(s.status))); } catch { /* the status bar shows govd down */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useWatch((w) => { if (w.kind === "trace" && w.event.kind.startsWith("spec.")) void load(); });

  const count = (name: string) => ({
    specs: specs.filter((s) => s.project === name).length,
    gates: props.gates.filter((g) => g.project === name).length,
  });
  const projects = [...props.projects].sort((a, b) => b.created.localeCompare(a.created));

  return (
    <aside className="home-panel">
      <h2>Projects <span className="dim">{projects.length}</span></h2>
      {!projects.length && <p className="dim small">None yet: use New project or Open folder above.</p>}
      {projects.map((p) => {
        const n = count(p.name);
        return (
          <button key={p.name} className="home-card" onClick={() => props.onOpen(p.name)} title={`Open ${p.name}`}>
            <span className="row"><b>{p.name}</b><span className="spacer" />
              {n.gates ? <Pill tone="warn">{n.gates} Gate{n.gates === 1 ? "" : "s"}</Pill> : n.specs ? <Pill tone="info">{n.specs} in flight</Pill> : <Pill tone="dim">idle</Pill>}
            </span>
            <span className="mono small dim path">{p.path}</span>
          </button>
        );
      })}

      <h2>In flight across projects <span className="dim">{specs.length}</span></h2>
      {!specs.length && <p className="dim small">No Specs running or waiting for review.</p>}
      {specs.map((s) => (
        <div key={s.id} className="home-line">
          <span className="mono">{s.id}</span><span className="dim">{s.project}</span>
          <span className="small">Runner · {s.to}</span><span className="spacer" /><SpecPill status={s.status} />
        </div>
      ))}
      {specs.length > 0 && <p className="dim small">Limits are per provider account, so every project draws on the same windows.</p>}

      <h2>Gates waiting <span className="dim">{props.gates.length}</span></h2>
      {!props.gates.length && <p className="dim small">Nothing is waiting for you.</p>}
      {props.gates.map((g) => (
        <div key={g.id} className="home-line">
          <span className="mono">{g.id}</span><span className="dim">{g.project ?? "Home"}</span>
          <span className="small">{g.tool}</span><span className="spacer" /><span className="dim small">{clock(g.opened)}</span>
        </div>
      ))}
      {props.gates.length > 0 && <button className="btn" onClick={props.onGates}>Answer in Gates</button>}
    </aside>
  );
}
