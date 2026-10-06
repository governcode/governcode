// Allowance (the Limits screen): each Runner's measured usage windows against its reserve, and whether a Spec may
// start on it now. Measuring starts the tool briefly, so it happens on open and on request,
// never on a timer; the Trace still refreshes what is shown.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Place } from "./Sidebar.tsx";
import { call, clock, useWatch } from "../api.ts";
import { ago, until, when } from "../../shared/time.ts";
import { Empty, Pill, Ring } from "../ui.tsx";
import { ProviderMark, providerName } from "../brand.tsx";
import { Icon } from "../icons.tsx";

// counted: GovernCode's own count against a budget the user set (it cannot see use outside GovernCode).
type Reading = { window: string; usedPercent: number; resetsAt: string | null; reservePercent?: number;
  counted?: { unit: "tokens" | "turns"; used: number; cap: number } };
export type ProviderLimit = {
  provider: string; unmetered: boolean; counted?: string | null; local?: { maxRunning: number; maxMinutes: number } | null; reservePercent: number; reserves?: Record<string, number>; measuredAt: number | null; readings: Reading[];
  reservedPercent: number; owedPercent: number; needsBudget?: boolean;
  verdict: { ok: true; note?: string } | { ok: false; reason: string; resetsAt: string | null };
  // At this pace (an older govd sends none): from readings govd took since it started.
  forecasts?: Array<{ window: string; perHour: number; reachesReserveAt: string | null; resetsFirst: boolean; since: string }>;
};

export function Limits({ onMeasured, onPlace }: { onMeasured?: () => void; onPlace?: (p: Place) => void } = {}) {
  const measured = useRef(onMeasured);
  measured.current = onMeasured;
  const [providers, setProviders] = useState<ProviderLimit[] | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (measure: boolean) => {
    if (measure) setMeasuring(true);
    try {
      setProviders((await call<{ providers: ProviderLimit[] }>("limits.list", { measure })).providers);
      setError(null);
      if (measure) measured.current?.();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { if (measure) setMeasuring(false); }
  }, []);

  useEffect(() => { void load(true); }, [load]);
  useWatch((w) => { if (w.kind === "trace" && w.event.kind.startsWith("spec.")) void load(false); });

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="vh">Allowance</h1>
        <span className="dim">A measured hold, not a billing ceiling: usage reports lag, so a run can overshoot a little.</span>
        <span className="spacer" />
        <button className="btn" disabled={measuring} onClick={() => load(true)}>{measuring ? "Measuring…" : "Measure now"}</button>
      </div>
      {error && <div className="error pad">{error}</div>}
      {providers && !providers.length ? <Empty title="No measured Runners" icon="gauge"><p className="dim">GovernCode can delegate only to Runners that report their usage or have a budget.</p></Empty> : (
        <div className="page"><div className="page-inner">
          <div className="page-head"><h1>Allowance</h1>
            <p>What each AI has left in its usage windows, and the share you keep back. A Spec that would reach into the reserve is held, never started.
              Unknown or stale usage (over 5 minutes) holds too. Paid API billing is never switched on.</p></div>
          <div className="prov-grid">
            {providers?.map((p) => <ProviderCard key={p.provider} p={p} onPlace={onPlace} />)}
          </div>
          <ResetTimeline providers={providers ?? []} />
        </div></div>
      )}
    </section>
  );
}

const keepOf = (p: ProviderLimit, r: Reading) => r.reservePercent ?? p.reserves?.[r.window] ?? p.reservePercent;
/** One AI: its rings (the window closest to the reserve outside, the next inside), each window's bar
 *  with the reserve hatched, and when each resets. */
function ProviderCard({ p, onPlace }: { p: ProviderLimit; onPlace?: (p: Place) => void }) {
  const held = !p.verdict.ok;
  const color = held ? "var(--violet)" : "var(--accent)";
  const readings = [...p.readings].sort((a, b) => (100 - keepOf(p, a) - a.usedPercent) - (100 - keepOf(p, b) - b.usedPercent));
  const [outer, inner] = readings;
  return (
    <div className="card prov">
      <div className="prov-ring">
        {p.local || p.unmetered || !outer ? <ProviderMark id={p.provider} size={64} /> : <>
          <Ring size={112} stroke={10} percent={outer.usedPercent} reserve={keepOf(p, outer)} color={color} />
          {inner && <span className="inner"><Ring size={84} stroke={8} percent={inner.usedPercent} reserve={keepOf(p, inner)} color="var(--accent)" /></span>}
          <span className="center"><b>{outer.counted ? outer.counted.used : `${Math.round(outer.usedPercent)}%`}</b>
            <small>{outer.counted ? `of ${outer.counted.cap} ${outer.counted.unit}` : `${outer.window} used`}</small></span>
        </>}
      </div>
      <div className="prov-body">
        <div className="prov-title"><ProviderMark id={p.provider} size={20} /><b>{providerName(p.provider)}</b>
          { p.needsBudget ? <Pill tone="violet" title="Needs a budget">needs budget</Pill>
            : p.unmetered ? <Pill tone="info" title="nothing counted, no Limit">unmetered (your opt-in)</Pill>
            : p.verdict.ok ? <Pill tone="ok">available</Pill>
            : <Pill tone="violet" title={p.verdict.reason}>holding new Specs{p.verdict.resetsAt ? ` until ${clock(p.verdict.resetsAt).replace(/:\d{2}$/, "")}` : ""}</Pill>}</div>
        <div className="prov-sub">
          {p.needsBudget ? <>{providerName(p.provider)} reports no usage, so GovernCode counts its turns or tokens against a budget you set. Until then it takes no Specs. {onPlace && <button className="linkish" onClick={() => onPlace({ kind: "global", id: "settings", section: "budget" })}>Set a budget</button>}</>
            : p.local ? `A local model: your machine's Limit is at most ${p.local.maxRunning} at once, ${p.local.maxMinutes} min each.`
            : inner ? `Outer ring: ${outer.window} · inner ring: ${inner.window}.` : p.counted ? `GovernCode counts against the budget you set (${p.counted}).` : ""}
          {!p.verdict.ok && !p.needsBudget ? ` ${p.verdict.reason}.` : ""}</div>
        {readings.map((r) => {
          const keep = keepOf(p, r), inside = r.usedPercent > 100 - keep;
          return (
            <div key={`${r.window}${r.counted ? "-counted" : ""}`} className="win">
              <div className="top"><b>{r.window}{r.counted ? " · budget" : ""}</b>
                <span className="dim tnum">{r.counted ? `${r.counted.used} of ${r.counted.cap} ${r.counted.unit}` : `${Math.round(r.usedPercent)}% used`} · keeps {keep}% back</span>
                <span className="reset tnum">{r.resetsAt ? `resets ${when(r.resetsAt)} · ${until(r.resetsAt)}` : "reset time unknown"}</span></div>
              {r.counted && r.counted.unit === "turns" && r.counted.cap <= 60
                ? <div className="turns" role="meter" aria-label={`${p.provider} ${r.window}`} aria-valuemin={0} aria-valuemax={r.counted.cap} aria-valuenow={r.counted.used}>
                    {Array.from({ length: r.counted.cap }, (_, i) => <i key={i} className={i < r.counted!.used ? "u" : i >= r.counted!.cap - Math.round(r.counted!.cap * keep / 100) ? "r" : ""} />)}</div>
                : <div className="meter" role="meter" aria-label={`${p.provider} ${r.window}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.usedPercent}>
                    <span className="kept" style={{ width: `${keep}%` }} />
                    <i className={inside ? "held" : ""} style={{ width: `${Math.min(100, r.usedPercent)}%` }} />
                    <span className="notch" style={{ left: `${100 - keep}%` }} /></div>}
            </div>
          );
        })}
        {(p.forecasts ?? []).filter((f) => f.perHour > 0 && (f.reachesReserveAt || f.resetsFirst)).slice(0, 2).map((f) => (
          <div key={f.window} className="forecast" title={`From readings since ${clock(f.since)}: about ${f.perHour}% an hour`}>
            <Icon name="sparkle" size={12} />
            {f.reachesReserveAt ? <>At this pace the {f.window} window reaches its reserve around {when(f.reachesReserveAt)}.</>
              : f.resetsFirst ? <>At this pace the {f.window} window lasts until it resets.</> : null}
          </div>
        ))}
        <div className="prov-foot">
          {p.measuredAt ? `${p.local ? "Answered" : "Measured"} ${ago(p.measuredAt)}` : p.local ? "Not checked yet" : "Never measured"}
          {p.reservedPercent ? ` · ${p.reservedPercent}% set aside by running Specs` : ""}
          {p.owedPercent ? ` · ${p.owedPercent}% held for finished Specs until the usage report catches up` : ""}
        </div>
      </div>
    </div>
  );
}

/** The next 12 hours: when each window resets. */
function ResetTimeline({ providers }: { providers: ProviderLimit[] }) {
  const now = Date.now(), span = 12 * 3_600_000;
  const pins = providers.flatMap((p) => p.readings.filter((r) => r.resetsAt).map((r) => ({ p, r, at: Date.parse(r.resetsAt!) })))
    .filter((x) => x.at > now && x.at <= now + span).sort((a, b) => a.at - b.at);
  if (!providers.some((p) => p.readings.length)) return null;
  // Ticks on the even hours after now; "Now" itself marks the start.
  const first = new Date(now); first.setMinutes(0, 0, 0); first.setHours(first.getHours() + 1 + (first.getHours() + 1) % 2);
  const ticks = Array.from({ length: 6 }, (_, i) => first.getTime() + i * 2 * 3_600_000).filter((t) => t <= now + span);
  const x = (t: number) => `${Math.max(0, Math.min(100, ((t - now) / span) * 100))}%`;
  return (
    <div className="card timeline">
      <div className="section-bar" style={{ margin: 0 }}><h2 className="section-title">Next 12 hours</h2><span className="dim small">when each window resets</span></div>
      {!pins.length ? <p className="dim small" style={{ margin: "10px 0 0" }}>No window resets in the next 12 hours.</p> : (
        <div className="tl">
          <div className="axis" />
          <div className="now" style={{ left: 0 }} />
          {ticks.map((t) => <span key={t} className="tick" style={{ left: x(t) }}>{new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</span>)}
          {pins.map(({ p, r, at }, i) => (
            <div key={`${p.provider}-${r.window}${r.counted ? "-counted" : ""}`} className="ev" style={{ left: x(at) }} title={`${providerName(p.provider)} ${r.window} resets ${clock(r.resetsAt!)}`}>
              <span className={`lab ${i % 2 ? "low" : ""}`}><ProviderMark id={p.provider} size={14} />{providerName(p.provider)} · {r.window}</span>
              <span className="pin" style={{ background: p.verdict.ok ? "var(--accent)" : "var(--violet)" }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
