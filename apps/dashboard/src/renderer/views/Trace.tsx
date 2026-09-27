// Trace: the append-only history, newest first, in local 24-hour time, filterable by kind.
import { useCallback, useEffect, useState } from "react";
import { call, clock, type TraceEvent } from "../api.ts";
import { Empty } from "../ui.tsx";

const FILTERS: Array<[string, (k: string) => boolean]> = [
  ["All", () => true],
  ["Turns", (k) => k.startsWith("turn.")],
  ["Gates", (k) => k.startsWith("gate.")],
  ["Specs", (k) => k.startsWith("spec.")],
  ["Projects", (k) => k.startsWith("project.") || k === "controller.set"],
  ["Sandbox", (k) => k === "sandbox.refused" || k === "git.scrubbed"],
];
const TONE: Record<string, string> = { "gate.opened": "warn", "gate.allowed": "ok", "gate.denied": "danger", "turn.failed": "danger",
  "sandbox.refused": "danger", "spec.failed": "danger", "spec.held": "warn", "spec.accepted": "ok", "turn.completed": "ok", "git.scrubbed": "warn" };

// ponytail: polled every 4 s while open; upgrade when govd streams the Trace to watchers.
const POLL_MS = 4000;

function summary(e: TraceEvent): string {
  const d = e.data ?? {};
  const pick = d.text ?? d.summary ?? d.prompt ?? d.note ?? d.reason ?? d.brief ?? d.name ?? d.tool ?? null;
  const tag = [d.gate, d.id, d.spec].filter((x) => typeof x === "string").join(" ");
  const rest = Object.entries(d).filter(([k]) => !["gate", "id", "spec"].includes(k))
    .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
  const text = pick === null ? rest : String(pick);
  return `${tag ? tag + "  " : ""}${text}`.replace(/\s+/g, " ").slice(0, 240);
}

export function Trace({ project }: { project: string | null }) {
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [filter, setFilter] = useState("All");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await call<{ events: TraceEvent[] }>("trace.list", { ...(project ? { project } : {}), limit: 300 });
      setEvents([...r.events].reverse());
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [project]);

  useEffect(() => {
    void load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const test = FILTERS.find(([n]) => n === filter)![1];
  const shown = (events ?? []).filter((e) => test(e.kind));

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
      </div>
      {error && <div className="error pad">{error}</div>}
      <div className="scroll">
        {events && !shown.length ? <Empty title="Nothing here yet" /> : (
          <table className="trace">
            <tbody>
              {shown.map((e) => (
                <tr key={e.seq}>
                  <td className="mono dim nowrap">{clock(e.ts)}</td>
                  <td className={`mono nowrap ${TONE[e.kind] ?? ""}`}>{e.kind}</td>
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
