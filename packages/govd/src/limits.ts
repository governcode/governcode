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
}

export type Verdict =
  | { ok: true; provider: string; note?: string }
  | { ok: false; provider: string; reason: string; resetsAt: string | null };

export type LimitsConfig = {
  reservePercent: Record<string, number>; // per provider; default 10
  unmetered: string[];                    // providers the user opted in to run without a source
  ttlMs: number;                          // a measurement older than this is stale
  maxSpecPercent: number;                 // cap on what one Spec may reserve
};

export const DEFAULTS: LimitsConfig = { reservePercent: {}, unmetered: [], ttlMs: 5 * 60_000, maxSpecPercent: 25 };

export class LimitGate {
  private config: LimitsConfig;
  private latest = new Map<string, Measurement>();
  private inflight = new Map<string, { provider: string; percent: number }>();
  private now: () => number;

  constructor(config: Partial<LimitsConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULTS, ...config };
    this.now = now;
  }

  record(m: Measurement): void {
    this.latest.set(m.provider, m);
  }

  private reserve(provider: string): number {
    return this.config.reservePercent[provider] ?? 10;
  }

  /** May a Spec reserving `requested` percent start on `provider`? Reserves it if so. */
  admit(spec: string, provider: string, requested: number): Verdict {
    const percent = Math.min(Math.max(requested, 1), this.config.maxSpecPercent); // clamp: a request, not authority
    if (this.config.unmetered.includes(provider)) {
      this.inflight.set(spec, { provider, percent: 0 });
      return { ok: true, provider, note: "unmetered (opt-in): spend not tracked" };
    }
    const m = this.latest.get(provider);
    if (!m || !m.readings.length) return { ok: false, provider, reason: "no usage source · held", resetsAt: null };
    if (this.now() - m.measuredAt > this.config.ttlMs) {
      return { ok: false, provider, reason: `usage stale (measured ${Math.round((this.now() - m.measuredAt) / 1000)} s ago) · held`, resetsAt: null };
    }
    const pending = [...this.inflight.values()].filter((f) => f.provider === provider).reduce((a, f) => a + f.percent, 0);
    const ceiling = 100 - this.reserve(provider);
    for (const r of m.readings) {
      if (r.usedPercent + pending + percent > ceiling) {
        return { ok: false, provider, resetsAt: r.resetsAt,
          reason: `inside its ${this.reserve(provider)}% ${r.window} Limit (${r.usedPercent}% used${pending ? `, ${pending}% reserved by running Specs` : ""})` };
      }
    }
    this.inflight.set(spec, { provider, percent });
    return { ok: true, provider };
  }

  /** While a Spec runs: has its provider crossed the line? Unknown now also means stop. */
  stillWithin(spec: string): Verdict {
    const f = this.inflight.get(spec);
    if (!f) return { ok: false, provider: "?", reason: "not admitted", resetsAt: null };
    if (this.config.unmetered.includes(f.provider)) return { ok: true, provider: f.provider };
    const m = this.latest.get(f.provider);
    if (!m || this.now() - m.measuredAt > this.config.ttlMs) return { ok: false, provider: f.provider, reason: "usage no longer measured · stop", resetsAt: null };
    const over = m.readings.find((r) => r.usedPercent > 100 - this.reserve(f.provider));
    return over ? { ok: false, provider: f.provider, reason: `crossed its ${over.window} Limit (${over.usedPercent}% used)`, resetsAt: over.resetsAt }
                : { ok: true, provider: f.provider };
  }

  release(spec: string): void {
    this.inflight.delete(spec);
  }
}
