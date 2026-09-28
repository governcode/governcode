// Limits: whether a Spec may start on a provider, decided outside any model.
// A measured hold, not a billing ceiling: vendor usage reports lag, so a running Spec can
// overshoot a little; in-flight polling (phase 1) interrupts a Spec that crosses the line.
// Rules: unknown or stale usage holds; in-flight Specs count against the same window
// (atomic reservation); the Controller's own budget number is a request, never authority.

export type Reading = { window: string; usedPercent: number; resetsAt: string | null };
export type Measurement = { provider: string; measuredAt: number; readings: Reading[] };

/** Where a provider's usage comes from. A driver ships only with one of these (or opts out). */
export interface UsageSource {
  provider: string;
  read(): Promise<Measurement | null>;
  why?(): string | null;          // after a failed read: the reason, shown when the Limit holds
  models?(): string[];            // a local provider's installed models, for the Controller
}

export type Verdict =
  | { ok: true; provider: string; note?: string }
  | { ok: false; provider: string; reason: string; resetsAt: string | null };

export type LimitsConfig = {
  reservePercent: Record<string, number | Record<string, number>>; // per provider, or per provider and window; default 10
  unmetered: string[];                    // providers the user opted in to run without a source
  ttlMs: number;                          // a measurement older than this is stale
  maxSpecPercent: number;                 // cap on what one Spec may reserve
  // Local models have no quota: the Limit is the machine's (#185 C). At most maxRunning Specs at
  // once per local provider, each stopped after maxMinutes.
  local: { providers: string[]; maxRunning: number; maxMinutes: number };
};

export const DEFAULTS: LimitsConfig = { reservePercent: {}, unmetered: [], ttlMs: 5 * 60_000, maxSpecPercent: 25,
  local: { providers: ["ollama"], maxRunning: 1, maxMinutes: 10 } };

export class LimitGate {
  private config: LimitsConfig;
  private latest = new Map<string, Measurement>();
  private whyNot = new Map<string, string>();      // a failed reading's reason, shown when it holds
  private inflight = new Map<string, { provider: string; percent: number; baseline: number }>();
  // Finished Specs keep counting until the provider's own counter catches up: usage reports lag,
  // so without this, back-to-back Specs could each be admitted against the same reading.
  private debits: Array<{ provider: string; percent: number; baseline: number; at: number }> = [];
  private now: () => number;

  constructor(config: Partial<LimitsConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULTS, ...config };
    this.now = now;
  }

  record(m: Measurement): void {
    this.latest.set(m.provider, m);
    this.whyNot.delete(m.provider);
    if (this.debitFor(m.provider) === 0) this.debits = this.debits.filter((d) => d.provider !== m.provider);
  }

  /** Forget a provider's measurement (a failed reading): it is held until measured again. */
  forget(provider: string, why?: string | null): void {
    this.latest.delete(provider);
    if (why) this.whyNot.set(provider, why); else this.whyNot.delete(provider);
  }

  /** The machine Limit for a local provider, or null for a metered one. */
  localRule(provider: string): { maxRunning: number; maxMinutes: number } | null {
    const l = this.config.local;
    return l.providers.includes(provider) ? { maxRunning: l.maxRunning, maxMinutes: l.maxMinutes } : null;
  }

  /** Change the local-model Limit while running (Settings); takes effect for the next Spec. */
  setLocal(local: { maxRunning: number; maxMinutes: number }): void {
    this.config = { ...this.config, local: { ...this.config.local, ...local } };
  }

  /** The share of a window held back for the user: per window if set, else per provider, else 10. */
  private reserve(provider: string, window?: string): number {
    const r = this.config.reservePercent[provider];
    if (typeof r === "number") return r;
    return (window !== undefined ? r?.[window] : undefined) ?? 10;
  }

  /** Change reserves while running (Settings); takes effect for the next check. */
  setReserves(reservePercent: LimitsConfig["reservePercent"]): void {
    this.config = { ...this.config, reservePercent };
  }

  /** May a Spec reserving `requested` percent start on `provider`? Reserves it if so. */
  admit(spec: string, provider: string, requested: number): Verdict {
    const { verdict, percent, baseline } = this.decide(provider, requested);
    if (verdict.ok) this.inflight.set(spec, { provider, percent, baseline });
    return verdict;
  }

  /** The verdict admit would give, reserving nothing (a probe must not leave a debit behind). */
  check(provider: string, requested = 1): Verdict {
    return this.decide(provider, requested).verdict;
  }

  private decide(provider: string, requested: number): { verdict: Verdict; percent: number; baseline: number } {
    const percent = Math.min(Math.max(requested, 1), this.config.maxSpecPercent); // clamp: a request, not authority
    const no = (reason: string, resetsAt: string | null = null) => ({ verdict: { ok: false as const, provider, reason, resetsAt }, percent, baseline: 0 });
    const local = this.localRule(provider);
    if (local) {
      if (!this.latest.has(provider)) return no(`${this.whyNot.get(provider) ?? "not answering"} · held`);
      const running = [...this.inflight.values()].filter((f) => f.provider === provider).length;
      if (running >= local.maxRunning) return no(`already running ${running} local Spec${running === 1 ? "" : "s"} (at most ${local.maxRunning} at once) · held`);
      return { verdict: { ok: true, provider, note: `local: at most ${local.maxRunning} at once, ${local.maxMinutes} min each` }, percent: 0, baseline: 0 };
    }
    if (this.config.unmetered.includes(provider)) {
      return { verdict: { ok: true, provider, note: "unmetered (opt-in): spend not tracked" }, percent: 0, baseline: 0 };
    }
    const m = this.latest.get(provider);
    if (!m || !m.readings.length) return no(`${this.whyNot.get(provider) ?? "no usage source"} · held`);
    if (this.now() - m.measuredAt > this.config.ttlMs) {
      return no(`usage stale (measured ${Math.round((this.now() - m.measuredAt) / 1000)} s ago) · held`);
    }
    const pending = this.reserved(provider) + this.debitFor(provider);
    for (const r of m.readings) {
      if (r.usedPercent + pending + percent > 100 - this.reserve(provider, r.window)) {
        return no(`inside its ${this.reserve(provider, r.window)}% ${r.window} Limit (${r.usedPercent}% used${pending ? `, ${pending}% reserved by running Specs` : ""})`, r.resetsAt);
      }
    }
    return { verdict: { ok: true, provider }, percent, baseline: Math.max(...m.readings.map((r) => r.usedPercent)) };
  }

  private reserved(provider: string): number {
    return [...this.inflight.values()].filter((f) => f.provider === provider).reduce((a, f) => a + f.percent, 0);
  }

  /** What a Limits screen shows for one provider: the reading, the reserve, what is held back. */
  view(provider: string) {
    const m = this.latest.get(provider);
    return { provider, unmetered: this.config.unmetered.includes(provider), local: this.localRule(provider), reservePercent: this.reserve(provider),
      reserves: Object.fromEntries((m?.readings ?? []).map((r) => [r.window, this.reserve(provider, r.window)])),
      measuredAt: m?.measuredAt ?? null, readings: m?.readings ?? [], reservedPercent: this.reserved(provider),
      owedPercent: this.debitFor(provider), verdict: this.check(provider) };
  }

  /** While a Spec runs: has its provider crossed the line? Unknown now also means stop. */
  stillWithin(spec: string): Verdict {
    const f = this.inflight.get(spec);
    if (!f) return { ok: false, provider: "?", reason: "not admitted", resetsAt: null };
    if (this.config.unmetered.includes(f.provider) || this.localRule(f.provider)) return { ok: true, provider: f.provider };  // local: its minutes cap stops it
    const m = this.latest.get(f.provider);
    if (!m || this.now() - m.measuredAt > this.config.ttlMs) return { ok: false, provider: f.provider, reason: "usage no longer measured · stop", resetsAt: null };
    const over = m.readings.find((r) => r.usedPercent > 100 - this.reserve(f.provider, r.window));
    return over ? { ok: false, provider: f.provider, reason: `crossed its ${over.window} Limit (${over.usedPercent}% used)`, resetsAt: over.resetsAt }
                : { ok: true, provider: f.provider };
  }

  /** What finished Specs may still owe: their reservations, minus the rise the provider's own
   *  counter has shown since the earliest of them started. */
  private debitFor(provider: string): number {
    const ds = this.debits.filter((d) => d.provider === provider);
    if (!ds.length) return 0;
    const m = this.latest.get(provider);
    const top = m ? Math.max(...m.readings.map((r) => r.usedPercent), 0) : 0;
    const risen = Math.max(0, top - Math.min(...ds.map((d) => d.baseline)));
    return Math.max(0, ds.reduce((a, d) => a + d.percent, 0) - risen);
  }

  release(spec: string): void {
    const f = this.inflight.get(spec);
    this.inflight.delete(spec);
    if (f && f.percent > 0) this.debits.push({ provider: f.provider, percent: f.percent, baseline: f.baseline, at: this.now() });
  }
}
