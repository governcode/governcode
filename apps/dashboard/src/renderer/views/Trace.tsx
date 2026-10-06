// Trace: the append-only history as a timeline, newest first, grouped by day and written as
// sentences. A row opens to the exact record (kind, sequence, actor, data); filters by kind and text.
import { useCallback, useEffect, useState } from "react";
import { call, clock, useFallbackPoll, useWatch, type TraceEvent } from "../api.ts";
import { Empty, Glyph } from "../ui.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { describe, eventLabel } from "../../shared/trace.ts";

const FILTERS: Array<[string, (k: string) => boolean]> = [
  ["All", () => true],
  ["Turns", (k) => k.startsWith("turn.")],
  ["Gates", (k) => k.startsWith("gate.")],
  ["Specs", (k) => k.startsWith("spec.")],
  ["Limits", (k) => k === "spec.held" || k === "settings.changed"],
  ["Checkpoints", (k) => k.startsWith("checkpoint.")],
  ["Projects", (k) => k.startsWith("project.") || k === "controller.set"],
  ["Sandbox", (k) => k === "sandbox.refused" || k === "git.scrubbed"],
];
const QUIET = new Set(["turn.text", "turn.tool", "spec.step"]);
const dayOf = (iso: string, now = new Date()) => {
  const d = new Date(iso), y = new Date(now); y.setDate(now.getDate() - 1);
  const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return same(d, now) ? "Today" : same(d, y) ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
};

const KEEP = 1000;

export function Trace({ project, live }: { project: string | null; live: boolean }) {
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [filter, setFilter] = useState("All");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [steps, setSteps] = useState(false);   // the Controller's words and steps, hidden unless asked for

  const load = useCallback(async () => {
    try {
      const r = await call<{ events: TraceEvent[] }>("trace.list", { ...(project ? { project } : {}), limit: 1000 });
      setEvents([...r.events].reverse());
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [project]);

  useEffect(() => { void load(); }, [load]);
  useFallbackPoll(live, load);
  useWatch((w) => {
    if (w.kind !== "trace" || (project && w.event.project !== project)) return;
    setEvents((all) => all && !all.some((e) => e.seq === w.event.seq) ? [w.event, ...all].slice(0, KEEP) : all);
  });

  const test = FILTERS.find(([n]) => n === filter)![1];
  // Text matches the actor, the kind (raw or as labelled), or anything in the event (a Spec, a Gate, a path…).
  const needle = text.trim().toLowerCase();
  const shown = (events ?? []).filter((e) => test(e.kind) && (steps || !QUIET.has(e.kind))
    && (!needle || `${e.actor} ${e.kind} ${eventLabel(e)} ${describe(e).text} ${e.project ?? ""} ${JSON.stringify(e.data ?? {})}`.toLowerCase().includes(needle)));
  const days: Array<[string, TraceEvent[]]> = [];
  for (const e of shown) {
    const day = dayOf(e.ts);
    if (days.at(-1)?.[0] !== day) days.push([day, []]);
    days.at(-1)![1].push(e);
  }

  return (
    <section className="view">
      <div className="view-head">
        <h1>Trace</h1>
        <span className="dim">{project ? `History of ${project}` : "History of every project and Home"}</span>
        <span className="spacer" />
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      <div className="chips">
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map(([name]) => (
            <button key={name} className={filter === name ? "on" : ""} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name}</button>
          ))}
        </div>
        <label className="check small"><input type="checkbox" checked={steps} onChange={(e) => setSteps(e.target.checked)} />Words and steps</label>
        <input className="trace-filter" placeholder="Filter: Spec, Gate, file, text…" aria-label="Filter the Trace" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {error && <div className="error pad">{error}</div>}
      <div className="scroll trace-scroll">
        {events && !shown.length ? <Empty title="Nothing here yet" icon="clock"><p>Every turn, Gate, Spec and change is recorded here as it happens.</p></Empty> : days.map(([day, list]) => (
          <section key={day} className="tday">
            <h3>{day}</h3>
            <ol className="tlist">
              {list.map((e) => {
                const d = describe(e);
                return (
                  <li key={e.seq} className={`tev ${open === e.seq ? "open" : ""}`}>
                    <button className="tev-row" aria-expanded={open === e.seq} onClick={() => setOpen(open === e.seq ? null : e.seq)} title={e.kind}>
                      <time className="mono">{clock(e.ts).slice(-8, -3)}</time>
                      <span className={`node ${d.tone}`}><Icon name={d.icon as IconName} size={12} /></span>
                      <span className="what">{d.text}</span>
                      {!project && <span className="pill">{e.project ? <><Glyph name={e.project} size={14} />{e.project}</> : "Home"}</span>}
                    </button>
                    {open === e.seq && (
                      <dl className="tev-detail mono">
                        <dt>kind</dt><dd>{e.kind}</dd><dt>seq</dt><dd>{e.seq}</dd><dt>at</dt><dd>{e.ts}</dd><dt>actor</dt><dd>{e.actor}</dd>
                        {Object.entries(e.data ?? {}).map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd></div>)}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </section>
  );
}
