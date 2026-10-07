// Watch: what your crew is doing right now, live. Each Controller at work with its latest step,
// each Runner in its lane, what waits for you, the allowance, and a feed of everything as it
// happens. Read-only: decisions are made in Needs you. Also its own window (Pop out).
import { useCallback, useEffect, useMemo, useState } from "react";
import { applyLiveEvent, buildWatch, combineTotals, MARKS, mergeEvents, type WatchState, type WatchToday } from "../../shared/watch.ts";
import { describe } from "../../shared/trace.ts";
import { providerUsage } from "../../shared/status.ts";
import { api, call, clock, useWatch, type Gate, type Spec, type TraceEvent } from "../api.ts";
import { ProviderMark, providerName } from "../brand.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { Glyph, Ring } from "../ui.tsx";
import type { ProviderLimit } from "./Limits.tsx";

const KEEP = 600;
const since = (iso: string | null, now: number) => {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
};

export function Watch({ popout = false, onNeeds }: { popout?: boolean; onNeeds?: () => void }) {
  const [state, setState] = useState<WatchState>({ events: [], marks: [], live: [], totals: null });
  const { events, marks, totals } = state;
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [limits, setLimits] = useState<ProviderLimit[]>([]);
  const [opened] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<number>(0);   // the newest seq when the feed last changed, to animate arrivals

  const loadSpecs = useCallback(async () => { try { setSpecs((await call<{ specs: Spec[] }>("spec.list", {})).specs); } catch { /* shown as quiet */ } }, []);
  const loadGates = useCallback(async () => { try { setGates((await call<{ gates: Gate[] }>("gate.list")).gates); } catch { /* shown as quiet */ } }, []);
  const loadLimits = useCallback(async () => { try { setLimits((await call<{ providers: ProviderLimit[] }>("limits.list", { measure: false })).providers); } catch { /* shown as quiet */ } }, []);
  useEffect(() => {
    // Merged, not replaced: live events can arrive before these replies.
    void (async () => { try { const got = (await call<{ events: TraceEvent[] }>("trace.list", { limit: 400 })).events; setState((s) => ({ ...s, events: mergeEvents(got, s.events).slice(-KEEP) })); } catch { /* shown as quiet */ } })();
    void (async () => { try { const got = (await call<{ events: TraceEvent[] }>("trace.list", { limit: 200, kinds: MARKS })).events; setState((s) => ({ ...s, marks: mergeEvents(got, s.marks).slice(-KEEP) })); } catch { /* shown as quiet */ } })();
    void loadSpecs(); void loadGates(); void loadLimits();
  }, [loadSpecs, loadGates, loadLimits]);
  // The main window keeps govd's usage readings fresh; Watch only reads them again now and then.
  useEffect(() => { const t = setInterval(() => void loadLimits(), 60_000); return () => clearInterval(t); }, [loadLimits]);
  useWatch((w) => {
    if (w.kind === "gates") { void loadGates(); return; }
    const e = w.event;
    setState((s) => applyLiveEvent(s, e, KEEP, new Date()));
    setFresh(w.event.seq);
    if (w.event.kind.startsWith("spec.") && w.event.kind !== "spec.step") { void loadSpecs(); void loadLimits(); }
    if (w.event.kind === "settings.changed") void loadLimits();
  });
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const day = new Date(now).toDateString();
  useEffect(() => {
    // From local midnight; again when the day turns. An older govd has no count: Today then comes from the feed.
    setState((s) => ({ ...s, totals: null }));
    void (async () => {
      try {
        const { totals: t } = await call<{ totals: WatchToday & { seq: number } }>("trace.totals", { since: new Date(new Date().setHours(0, 0, 0, 0)).toISOString() });
        const { seq, ...counted } = t;
        setState((s) => combineTotals(s, { today: counted, seq }, new Date()));
      } catch { /* an older govd */ }
    })();
  }, [day]);

  const w = useMemo(() => buildWatch(mergeEvents(marks, events), specs, new Date(now)), [marks, events, specs, Math.floor(now / 60_000)]);   // the clock matters to the minute only
  const today = totals?.today ?? w.today;
  const feed = [...events].reverse().slice(0, 40);
  const reviews = specs.filter((s) => s.status === "needs-review");
  const busy = w.turns.length + w.runners.filter((r) => r.status === "running").length;   // queued is not working yet
  const popOut = () => { void api().openWatch(); };

  return (
    <section className={`view watch ${popout ? "popout" : ""}`}>
      <div className="w-aurora" aria-hidden="true"><i /><i /><i /></div>
      <header className="w-head">
        <div>
          <h1>Watch</h1>
          <span className="w-sub">{busy ? `${busy === 1 ? "One AI is" : `${busy} AIs are`} working right now` : "Quiet right now"} · watching for {since(new Date(opened).toISOString(), now)}</span>
        </div>
        <span className="spacer" />
        <span className="w-live"><span className="beat" />live</span>
        {!popout && <button className="btn" onClick={popOut} title="Open Watch in its own window"><Icon name="layers" size={14} />Pop out</button>}
      </header>

      <div className="w-grid">
        <div className="w-main">
          {!w.turns.length && !w.runners.length && (
            <div className="w-card w-idle"><span className="w-orbit small" aria-hidden="true"><i /></span>
              <div><b>Nothing is running.</b><p>When a Controller or a Runner starts working, you will see it here as it happens.</p></div></div>
          )}
          {w.turns.map((t) => (
            <div key={t.project ?? "home"} className="w-card w-now">
              <span className="w-orbit" aria-hidden="true"><i /></span>
              <div className="w-now-body">
                <div className="w-eyebrow">{t.origin === "wake" ? "Reporting finished work" : t.origin === "continuation" ? "Continuing after a reset" : "Working now"}
                  <span>· {t.project ?? "Home"} · {since(t.since, now)}</span></div>
                <div className="w-who"><ProviderMark id={t.provider} size={22} /><b>{providerName(t.provider)}</b><span>Controller</span></div>
                <h2>{t.prompt || "(no prompt recorded)"}</h2>
                {t.lastStep && <div className="w-step mono">{t.lastStep}</div>}
              </div>
            </div>
          ))}
          {w.runners.length > 0 && <>
            <h3>Runners</h3>
            <div className="w-lanes">
              {w.runners.map((r) => (
                <div key={r.id} className="w-card w-lane">
                  <ProviderMark id={r.to} size={30} />
                  <div className="grow">
                    <div className="w-lane-top"><b>{r.id} · {providerName(r.to)}</b><span className="dim">{r.project}</span><span className="spacer" />
                      <span className="mono dim">{r.status === "queued" ? "queued" : since(r.since, now)}</span></div>
                    <div className="w-brief">{r.brief}</div>
                    {r.lastStep && <div className="w-step mono">{r.lastStep}</div>}
                  </div>
                  <span className="w-sweep" aria-hidden="true" />
                </div>
              ))}
            </div>
          </>}
          <h3>As it happens</h3>
          <div className="w-card w-feed" aria-live="polite">
            {!feed.length && <div className="dim">Nothing recorded yet.</div>}
            {feed.map((e) => {
              const d = describe(e);
              return (
                <div key={e.seq} className={`w-entry ${e.seq === fresh ? "fresh" : ""}`}>
                  <time className="mono">{clock(e.ts).slice(-8, -3)}</time>
                  <span className={`w-dot ${d.tone}`}><Icon name={d.icon as IconName} size={11} /></span>
                  <span className="w-text">{d.text}</span>
                  {e.project && <span className="w-proj"><Glyph name={e.project} size={14} />{e.project}</span>}
                </div>
              );
            })}
          </div>
        </div>

        <aside className="w-side">
          <div className={`w-card w-wait ${gates.length + reviews.length ? "on" : ""}`}>
            <h3>Waiting for you</h3>
            <div className="w-big">{gates.length + reviews.length}</div>
            <p>{gates.length} Gate{gates.length === 1 ? "" : "s"} · {reviews.length} Spec{reviews.length === 1 ? "" : "s"} to review</p>
            {gates.slice(0, 3).map((g) => <div key={g.id} className="w-gate"><Icon name="lock" size={12} /><span className="mono">{g.id}</span><span className="dim ellipsis">{g.project ?? "Home"} · {g.tool}</span></div>)}
            {onNeeds && gates.length + reviews.length > 0 && <button className="btn" onClick={onNeeds}>Answer in Needs you</button>}
            {!onNeeds && gates.length + reviews.length > 0 && <p className="dim small">Answer them in the Dashboard's Needs you.</p>}
          </div>
          <div className="w-card">
            <h3>Allowance</h3>
            {!limits.length && <p className="dim small">No Runners with a usage source yet.</p>}
            <div className="w-rings">
              {limits.filter((p) => !p.local && !p.unmetered).map((p) => {
                const u = providerUsage(p);
                return (
                  <div key={p.provider} className="w-ring" title={`${providerName(p.provider)} · ${u.window ?? "not measured"}`}>
                    <span className="r"><Ring size={58} stroke={6} percent={u.percent} reserve={u.reserve} color={!p.verdict.ok ? "var(--violet)" : w.runners.some((r) => r.to === p.provider) ? "var(--blue)" : "var(--accent)"} />
                      <b>{u.counted ? u.counted.used : `${Math.round(u.percent)}`}</b></span>
                    <span className="n"><ProviderMark id={p.provider} size={14} />{providerName(p.provider)}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="w-card w-today">
            <h3>Today</h3>
            <div><b>{today.turns}</b><span>turns</span></div>
            <div><b>{today.specsFinished}</b><span>Specs finished</span></div>
            <div><b>{today.answeredByYou}</b><span>Gates you answered</span></div>
            <div><b>{today.letThrough}</b><span>steps let through</span></div>
          </div>
        </aside>
      </div>
    </section>
  );
}
