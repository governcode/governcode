// Limits: whether a Spec may start on a provider, decided outside any model.
// A measured hold, not a billing ceiling: vendor usage reports lag, so a running Spec can
// overshoot a little; in-flight polling (phase 1) interrupts a Spec that crosses the line.
// Rules: unknown or stale usage holds; in-flight Specs count against the same window
// (atomic reservation); the Controller's own budget number is a request, never authority.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COUNTED_LABEL, COUNTED_WINDOWS, type BudgetValue, type CountedWindow } from "@governcode/protocol";

// counted: this reading is govd's own count against a budget the user set (not the vendor's).
export type Reading = { window: string; usedPercent: number; resetsAt: string | null;
  counted?: { unit: BudgetValue["unit"]; used: number; cap: number } };
// exact: every reading is govd's own count, which already includes every finished Spec.
export type Measurement = { provider: string; measuredAt: number; readings: Reading[]; exact?: boolean };

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
    if (m.exact || this.debitFor(m.provider) === 0) this.debits = this.debits.filter((d) => d.provider !== m.provider);
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

  /** The share of a window held back for the user: per window if set, else per provider, else 10.
   *  A counted budget is already the user's own line (set below the plan), so it keeps 0 unless set. */
  private reserve(provider: string, window?: string, counted = false): number {
    const r = this.config.reservePercent[provider];
    if (typeof r === "number") return r;
    return (window !== undefined ? r?.[window] : undefined) ?? (counted ? 0 : 10);
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
      return { verdict: { ok: true, provider, note: "unmetered (your opt-in): nothing counted, no Limit" }, percent: 0, baseline: 0 };
    }
    const m = this.latest.get(provider);
    if (!m || !m.readings.length) return no(`${this.whyNot.get(provider) ?? "no usage source"} · held`);
    if (this.now() - m.measuredAt > this.config.ttlMs) {
      return no(`usage stale (measured ${Math.round((this.now() - m.measuredAt) / 1000)} s ago) · held`);
    }
    const pending = this.reserved(provider) + this.debitFor(provider);
    const running = [...this.inflight.values()].filter((f) => f.provider === provider).length;
    // Every reading of every source is checked, so the stricter one decides.
    for (const r of m.readings) {
      const c = r.counted, keep = this.reserve(provider, r.window, !!c);
      if (c?.unit === "turns") {
        // A Spec is exactly one turn: counted in turns, not in a requested percent.
        if (c.used + running + 1 > c.cap * (100 - keep) / 100 + 1e-9) {
          return no(`inside its ${r.window} budget (${c.used} of ${c.cap} turns used${running ? `, ${running} running` : ""}${keep ? `, ${keep}% kept back` : ""}; ${COUNTED_LABEL})`, r.resetsAt);
        }
      } else if (c) {
        if ((c.used / c.cap) * 100 + pending + percent > 100 - keep) {
          return no(`inside its ${r.window} budget (${c.used} of ${c.cap} tokens used${pending ? `, ${pending}% reserved by running Specs` : ""}${keep ? `, ${keep}% kept back` : ""}; ${COUNTED_LABEL})`, r.resetsAt);
        }
      } else if (r.usedPercent + pending + percent > 100 - keep) {
        return no(`inside its ${keep}% ${r.window} Limit (${r.usedPercent}% used${pending ? `, ${pending}% reserved by running Specs` : ""})`, r.resetsAt);
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
    const readings = (m?.readings ?? []).map((r) => ({ ...r, reservePercent: this.reserve(provider, r.window, !!r.counted) }));
    return { provider, unmetered: this.config.unmetered.includes(provider), local: this.localRule(provider), reservePercent: this.reserve(provider),
      reserves: Object.fromEntries(readings.filter((r) => !r.counted).map((r) => [r.window, r.reservePercent])),
      counted: readings.some((r) => r.counted) ? COUNTED_LABEL : null,
      measuredAt: m?.measuredAt ?? null, readings, reservedPercent: this.reserved(provider),
      owedPercent: this.debitFor(provider), verdict: this.check(provider) };
  }

  /** While a Spec runs: has its provider crossed the line? Unknown now also means stop. */
  stillWithin(spec: string): Verdict {
    const f = this.inflight.get(spec);
    if (!f) return { ok: false, provider: "?", reason: "not admitted", resetsAt: null };
    if (this.config.unmetered.includes(f.provider) || this.localRule(f.provider)) return { ok: true, provider: f.provider };  // local: its minutes cap stops it
    const m = this.latest.get(f.provider);
    if (!m || this.now() - m.measuredAt > this.config.ttlMs) return { ok: false, provider: f.provider, reason: "usage no longer measured · stop", resetsAt: null };
    const over = m.readings.find((r) => r.usedPercent > 100 - this.reserve(f.provider, r.window, !!r.counted));
    return over ? { ok: false, provider: f.provider, reason: over.counted
        ? `crossed its ${over.window} budget (${over.counted.used} of ${over.counted.cap} ${over.counted.unit}; ${COUNTED_LABEL})`
        : `crossed its ${over.window} Limit (${over.usedPercent}% used)`, resetsAt: over.resetsAt }
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

// Counted budgets (#185 A): a cloud provider with no usage report of its own gets a budget the
// user sets, per window, in the provider's unit; govd counts what its own Runners report and
// turns it into the same percent readings, so the Limit, reserves and in-flight holds work
// unchanged. Always fresh (govd is the source), and blind to use outside GovernCode.

type Tally = { start: number; tokens: number; turns: number; unreported: number };

/** The token count a driver reported for a run, or null if it reported none. */
export function reportedTokens(usage: unknown): number | null {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" && Number.isFinite(u[k]) && (u[k] as number) >= 0 ? u[k] as number : null);
  const total = n("total_tokens") ?? n("totalTokens");
  if (total !== null) return total;
  const inp = n("input_tokens") ?? n("inputTokens"), out = n("output_tokens") ?? n("outputTokens");
  return inp !== null || out !== null ? (inp ?? 0) + (out ?? 0) : null;
}

/** What govd's own Runners used, per provider and window, kept in govd's state so a restart
 *  does not forget it. Every cloud Runner is counted in every window, so a budget set mid-window
 *  sees what that window already used. */
export class CountedStore {
  private data: Record<string, Record<string, Tally>> = {};
  private file: string | null;
  private now: () => number;

  constructor(file: string | null, now: () => number = Date.now) {
    this.file = file; this.now = now;
    if (!file) return;
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      if (d && typeof d === "object" && !Array.isArray(d)) this.data = d;
    } catch { /* none yet (or unreadable: counting starts again, never blocks) */ }
  }

  /** A window's tally, or null before its first run and after it reset. */
  private live(provider: string, window: CountedWindow): Tally | null {
    const t = this.data[provider]?.[window];
    return t && typeof t.start === "number" && this.now() < t.start + COUNTED_WINDOWS[window] ? t : null;
  }

  /** One finished Runner run: a turn, and its tokens if the driver reported them. */
  count(provider: string, tokens: number | null): void {
    const p = (this.data[provider] ??= {});
    for (const w of Object.keys(COUNTED_WINDOWS) as CountedWindow[]) {
      const t = this.live(provider, w) ?? (p[w] = { start: this.now(), tokens: 0, turns: 0, unreported: 0 });
      t.turns += 1;
      if (tokens === null) t.unreported += 1; else t.tokens += tokens;
    }
    this.save();
  }

  /** The provider's readings against its budget; null (held) when there is none to give. */
  measure(provider: string, budget: BudgetValue | undefined): { m: Measurement | null; why: string | null } {
    const windows = Object.entries(budget?.windows ?? {}) as Array<[CountedWindow, number]>;
    if (!budget || !windows.length) return { m: null, why: `no usage source and no budget (gov budget ${provider} WINDOW N tokens|turns)` };
    const readings: Reading[] = [];
    for (const [w, cap] of windows) {
      const t = this.live(provider, w);
      if (budget.unit === "tokens" && t?.unreported) {
        return { m: null, why: `a run in its ${w} window did not report tokens, so a token budget cannot be counted (count it in turns)` };
      }
      const used = t?.[budget.unit] ?? 0;
      readings.push({ window: w, usedPercent: Math.round((used / cap) * 1000) / 10,
        resetsAt: t ? new Date(t.start + COUNTED_WINDOWS[w]).toISOString() : null, counted: { unit: budget.unit, used, cap } });
    }
    return { m: { provider, measuredAt: this.now(), readings, exact: true }, why: null };
  }

  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * A Runner's usage source with the user's budget applied: the native source alone when there is
 * no budget, the count alone when there is no native source, and both when there are both (every
 * reading is checked, so the stricter one decides; either failing holds). A provider plugin with
 * its own reading would join the same way.
 */
export function withBudget(provider: string, native: UsageSource | undefined, store: CountedStore,
    budget: () => BudgetValue | undefined): UsageSource {
  let why: string | null = null;
  return {
    provider,
    why: () => why,
    async read() {
      const b = budget();
      const counted = b && Object.keys(b.windows).length ? store.measure(provider, b) : null;
      if (!native) { const r = counted ?? store.measure(provider, undefined); why = r.why; return r.m; }
      const m = await native.read();
      why = m ? counted?.why ?? null : native.why?.() ?? "no usage reading";
      if (!m || !counted) return m;
      return counted.m ? { provider, measuredAt: m.measuredAt, readings: [...m.readings, ...counted.m.readings] } : null;
    },
  };
}
