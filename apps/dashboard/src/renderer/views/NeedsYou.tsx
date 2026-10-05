// Needs you: everything waiting on a decision, from every project. Gates are answered here in full
// (Allow runs exactly the request shown); finished and held Specs open in their project.
import { useState } from "react";
import { clock, type Gate, type RecoveryItem, type Spec } from "../api.ts";
import { ProviderMark, providerName } from "../brand.tsx";
import { Icon } from "../icons.tsx";
import { Empty, GateCard, Glyph } from "../ui.tsx";
import type { Place } from "./Sidebar.tsx";

export function NeedsYou({ gates, specs, held, onAnswered, onPlace }: { gates: Gate[]; specs: Spec[]; held: RecoveryItem[];
  onAnswered: () => void; onPlace: (p: Place) => void }) {
  const [answered, setAnswered] = useState<Record<string, "allow" | "deny">>({});

  const reviews = specs.filter((s) => s.status === "needs-review");
  const none = !gates.length && !reviews.length && !held.length;
  const open = (project: string) => onPlace({ kind: "project", name: project, tab: "specs" });

  return (
    <section className="view">
      <div className="view-head">
        <h1>Needs you</h1>
        <span className="dim">Gates to answer, finished work to review, and work held by a Limit, from every project.</span>
      </div>
      <div className="scroll">
        <div style={{ maxWidth: 860, width: "100%", margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>
          {none && <Empty title="All clear"><p>When a Controller or Runner needs approval, a Spec finishes, or work waits for a reset, it shows up here.</p></Empty>}
          {gates.length > 0 && <h3>Gates · Allow runs exactly the request shown</h3>}
          {gates.map((g) => (
            <GateCard key={g.id} id={g.id} tool={g.tool} canonical={g.canonical} project={g.project} opened={g.opened} covers={g.covers} scopes={g.scopes} suggest={g.suggest}
              state={answered[g.id] ?? "waiting"} onAnswered={(a) => { setAnswered((m) => ({ ...m, [g.id]: a })); onAnswered(); }} />
          ))}
          {reviews.length > 0 && <h3>Ready for review</h3>}
          {reviews.map((s) => (
            <div key={s.id} className="card need need-review">
              <span className="tile"><Icon name="branch" /></span>
              <div style={{ minWidth: 0 }}>
                <div className="t ellipsis">{s.brief}</div>
                <div className="s"><ProviderMark id={s.to} size={16} />{providerName(s.to)} · {s.id} · {s.files.length} file{s.files.length === 1 ? "" : "s"} · <Glyph name={s.project} size={14} />{s.project}</div>
              </div>
              <div className="acts"><button className="btn" onClick={() => open(s.project)}>Review changes</button></div>
            </div>
          ))}
          {held.length > 0 && <h3>Held by a Limit</h3>}
          {held.map((h) => (
            <div key={h.target} className="card need need-held">
              <span className="tile"><Icon name="hourglass" /></span>
              <div style={{ minWidth: 0 }}>
                <div className="t ellipsis">{h.target} · {h.why}</div>
                <div className="s"><ProviderMark id={h.provider} size={16} />{h.resetsAt ? `${providerName(h.provider)} resets ${clock(h.resetsAt).replace(/:\d{2}$/, "")}` : "Reset time unknown"}
                  {h.atReset ? " · resumes then" : ""} · {h.project}</div>
              </div>
              <div className="acts"><button className="btn" onClick={() => open(h.project)}>Open</button></div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
