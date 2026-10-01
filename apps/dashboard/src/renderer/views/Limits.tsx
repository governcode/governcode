// Limits: each Runner's measured usage windows against its reserve, and whether a Spec may
// start on it now. Measuring starts the tool briefly, so it happens on open and on request,
// never on a timer; the Trace still refreshes what is shown.
import { useCallback, useEffect, useState } from "react";
import { call, clock, useWatch } from "../api.ts";
import { Empty, Pill } from "../ui.tsx";

// counted: GovernCode's own count against a budget the user set (it cannot see use outside GovernCode).
type Reading = { window: string; usedPercent: number; resetsAt: string | null; reservePercent?: number;
  counted?: { unit: "tokens" | "turns"; used: number; cap: number } };
export type ProviderLimit = {
  provider: string; unmetered: boolean; counted?: string | null; local?: { maxRunning: number; maxMinutes: number } | null; reservePercent: number; reserves?: Record<string, number>; measuredAt: number | null; readings: Reading[];
  reservedPercent: number; owedPercent: number;
  verdict: { ok: true; note?: string } | { ok: false; reason: string; resetsAt: string | null };
};

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export function Limits() {
  const [providers, setProviders] = useState<ProviderLimit[] | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (measure: boolean) => {
    if (measure) setMeasuring(true);
    try {
      setProviders((await call<{ providers: ProviderLimit[] }>("limits.list", { measure })).providers);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { if (measure) setMeasuring(false); }
  }, []);

  useEffect(() => { void load(true); }, [load]);
  useWatch((w) => { if (w.kind === "trace" && w.event.kind.startsWith("spec.")) void load(false); });

  return (
    <section className="view">
      <div className="view-head">
        <h1>Limits</h1>
        <span className="dim">a measured hold, not a billing ceiling: vendor reports lag, so a run can overshoot a little</span>
        <span className="spacer" />
        <button className="btn" disabled={measuring} onClick={() => load(true)}>{measuring ? "Measuring…" : "Measure now"}</button>
      </div>
      <div className="pad dim small">Unknown or stale (over 5 min) usage holds. Checked right before a Spec starts and while it runs. Paid API billing is never switched on.</div>
      {error && <div className="error pad">{error}</div>}
      {providers && !providers.length ? <Empty title="No measured Runners"><p className="dim">GovernCode can delegate only to Runners that report their usage or have a budget.</p></Empty> : (
        <div className="scroll">
          {providers?.map((p) => (
            <div key={p.provider} className="checkpoint limit">
              <div className="row">
                <b>{p.provider}</b>
                {p.local ? <span className="dim small">Local model · your machine's Limit: at most {p.local.maxRunning} at once, {p.local.maxMinutes} min each</span>
                  : <span className="dim small">Runner · keeps {Object.values(p.reserves ?? {}).every((n) => n === p.reservePercent) ? `${p.reservePercent}% of every window` : Object.entries(p.reserves ?? {}).map(([w, n]) => `${n}% of ${w}`).join(", ")} back</span>}
                <span className="spacer" />
                {p.counted && <span className="dim small">budget {p.counted}</span>}
                {p.unmetered ? <Pill tone="info" title="nothing counted, no Limit">unmetered (your opt-in)</Pill>
                  : p.verdict.ok ? <Pill tone="ok">available</Pill>
                  : <Pill tone="warn" title={p.verdict.reason}>held{p.verdict.resetsAt ? ` until ${clock(p.verdict.resetsAt)}` : ""}</Pill>}
              </div>
              {p.readings.length > 0 && <div className="windows">{p.readings.map((r) => {
                const keep = r.reservePercent ?? p.reserves?.[r.window] ?? p.reservePercent;
                const inside = r.usedPercent > 100 - keep;
                return (
                  <div key={`${r.window}${r.counted ? "-counted" : ""}`} className="window">
                    <span className="mono small label" title={r.counted ? p.counted ?? undefined : undefined}>{r.window}{r.counted ? " · budget" : ""}</span>
                    <div className="bar" role="meter" aria-label={`${p.provider} ${r.window}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.usedPercent}>
                      <div className={`fill ${inside ? "inside" : ""}`} style={{ width: `${Math.min(100, r.usedPercent)}%` }} />
                      <div className="reserve" style={{ left: `${100 - keep}%` }} />
                    </div>
                    <span className={`mono small ${inside ? "warn" : ""}`}>{r.counted ? `${r.counted.used} / ${r.counted.cap} ${r.counted.unit}` : `${r.usedPercent}%`}</span>
                    <span className="dim small">{r.resetsAt ? `resets ${clock(r.resetsAt)}` : ""}</span>
                  </div>
                );
              })}</div>}
              <div className="dim small">
                {p.measuredAt ? `${p.local ? "answered" : "measured"} ${ago(p.measuredAt)}` : p.local ? "not checked yet" : "never measured"}
                {p.reservedPercent ? ` · ${p.reservedPercent}% reserved by running Specs` : ""}
                {p.owedPercent ? ` · ${p.owedPercent}% held for finished Specs until the usage report catches up` : ""}
                {!p.verdict.ok && ` · ${p.verdict.reason}`}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
