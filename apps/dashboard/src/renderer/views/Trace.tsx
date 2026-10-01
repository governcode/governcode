// Trace: the append-only history, newest first, in local 24-hour time, filterable by kind. Each
// kind shows as a short plain label, with the raw kind as its tooltip.
import { useCallback, useEffect, useState } from "react";
import { call, clock, useFallbackPoll, useWatch, type TraceEvent } from "../api.ts";
import { Empty } from "../ui.tsx";
import { eventLabel, summary } from "../../shared/trace.ts";

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
const TONE: Record<string, string> = { "gate.opened": "warn", "gate.allowed": "ok", "gate.denied": "danger", "turn.failed": "danger",
  "sandbox.refused": "danger", "spec.failed": "danger", "spec.held": "warn", "spec.accepted": "ok", "turn.completed": "ok", "git.scrubbed": "warn",
  "git.guard_failed": "danger", "checkpoint.failed": "warn" };

const KEEP = 1000;

export function Trace({ project, live }: { project: string | null; live: boolean }) {
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [filter, setFilter] = useState("All");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<{ events: TraceEvent[] }>("trace.list", { ...(project ? { project } : {}), limit: 300 });
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
  const shown = (events ?? []).filter((e) => test(e.kind)
    && (!needle || `${e.actor} ${e.kind} ${eventLabel(e)} ${e.project ?? ""} ${JSON.stringify(e.data ?? {})}`.toLowerCase().includes(needle)));

  return (
    <section className="view">
      <div className="view-head">
        <h1>Trace</h1>
        <span className="dim">{project ? `History of ${project}` : "History of every project and Home"}</span>
        <span className="spacer" />
        <button className="btn" onClick={load}>Refresh</button>
      </div>
      <div className="chips">
        {FILTERS.map(([name]) => (
          <button key={name} className={`chip ${filter === name ? "active" : ""}`} onClick={() => setFilter(name)}>{name}</button>
        ))}
        <input className="trace-filter" placeholder="filter: actor, Spec, Gate, text…" aria-label="Filter the Trace" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {error && <div className="error pad">{error}</div>}
      <div className="scroll">
        {events && !shown.length ? <Empty title="Nothing here yet" /> : (
          <table className="trace">
            <tbody>
              {shown.map((e) => (
                <tr key={e.seq}>
                  <td className="mono dim nowrap">{clock(e.ts)}</td>
                  <td className={`nowrap ${TONE[e.kind] ?? ""}`} title={e.kind}>{eventLabel(e)}</td>
                  <td className="nowrap">{e.project ?? <span className="dim">Home</span>}</td>
                  <td className="dim nowrap">{e.actor}</td>
                  <td className="dim ellipsis-cell">{summary(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
