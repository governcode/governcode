// Limits: whether a Spec may start on a provider, decided outside any model.
// A measured hold, not a billing ceiling: vendor usage reports lag, so a running Spec can
// overshoot a little; in-flight polling (phase 1) interrupts a Spec that crosses the line.
// Rules: unknown or stale usage holds; in-flight Specs count against the same window
// (atomic reservation); the Controller's own budget number is a request, never authority.
import fs, { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { COUNTED_LABEL, COUNTED_WINDOWS, type BudgetValue, type CountedWindow } from "@governcode/protocol";

// counted: this reading is govd's own count against a budget the user set (not the vendor's).
export type Reading = { window: string; usedPercent: number; resetsAt: string | null;
  counted?: { unit: BudgetValue["unit"]; used: number; cap: number } };
// recount: the counted part again, from govd's own count at this moment (see LimitGate.current).
export type Measurement = { provider: string; measuredAt: number; readings: Reading[]; recount?: () => Counted };
export type Counted = { m: Measurement | null; why: string | null };

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
  // baselines: each of the provider's own windows (not counted ones) as it stood at admission.
  private inflight = new Map<string, { provider: string; percent: number; baselines: Record<string, number> }>();
  // Finished Specs keep counting until the provider's own counter catches up: usage reports lag,
  // so without this, back-to-back Specs could each be admitted against the same reading. Only the
  // provider's own windows owe this: govd's own count already includes every finished Spec.
  private debits: Array<{ provider: string; percent: number; baselines: Record<string, number> }> = [];
  private now: () => number;

  constructor(config: Partial<LimitsConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULTS, ...config };
    this.now = now;
  }

  record(m: Measurement): void {
    this.latest.set(m.provider, m);
    this.whyNot.delete(m.provider);
    if (this.owedMax(m.provider) === 0) this.debits = this.debits.filter((d) => d.provider !== m.provider);
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
    const { verdict, percent, baselines } = this.decide(provider, requested);
    if (verdict.ok) this.inflight.set(spec, { provider, percent, baselines });
    return verdict;
  }

  /** The verdict admit would give, reserving nothing (a probe must not leave a debit behind). */
  check(provider: string, requested = 1): Verdict {
    return this.decide(provider, requested).verdict;
  }

  /** The readings to decide on now. A counted part is read again from govd's own count, in the
   *  same synchronous step as the decision, so a run counted while the provider's own report was
   *  being read cannot be missed. */
  private current(provider: string): { measuredAt: number; readings: Reading[] } | { why: string } | null {
    const m = this.latest.get(provider);
    if (!m || !m.recount) return m ?? null;
    const own = m.readings.filter((r) => !r.counted);
    const c = m.recount();
    if (!c.m) return { why: c.why ?? "the count could not be read" };
    // govd's own count is always fresh; the provider's report is as old as it is.
    return { measuredAt: own.length ? m.measuredAt : this.now(), readings: [...own, ...c.m.readings] };
  }

  private decide(provider: string, requested: number): { verdict: Verdict; percent: number; baselines: Record<string, number> } {
    const percent = Math.min(Math.max(requested, 1), this.config.maxSpecPercent); // clamp: a request, not authority
    const no = (reason: string, resetsAt: string | null = null) => ({ verdict: { ok: false as const, provider, reason, resetsAt }, percent, baselines: {} });
    const local = this.localRule(provider);
    if (local) {
      if (!this.latest.has(provider)) return no(`${this.whyNot.get(provider) ?? "not answering"} · held`);
      const running = [...this.inflight.values()].filter((f) => f.provider === provider).length;
      if (running >= local.maxRunning) return no(`already running ${running} local Spec${running === 1 ? "" : "s"} (at most ${local.maxRunning} at once) · held`);
      return { verdict: { ok: true, provider, note: `local: at most ${local.maxRunning} at once, ${local.maxMinutes} min each` }, percent: 0, baselines: {} };
    }
    if (this.config.unmetered.includes(provider)) {
      return { verdict: { ok: true, provider, note: "unmetered (your opt-in): nothing counted, no Limit" }, percent: 0, baselines: {} };
    }
    const m = this.current(provider);
    if (m && "why" in m) return no(`${m.why} · held`);
    if (!m || !m.readings.length) return no(`${this.whyNot.get(provider) ?? "no usage source"} · held`);
    if (this.now() - m.measuredAt > this.config.ttlMs) {
      return no(`usage stale (measured ${Math.round((this.now() - m.measuredAt) / 1000)} s ago) · held`);
    }
    const reserved = this.reserved(provider);
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
        // Running Specs only: finished ones are already in the count.
        if ((c.used / c.cap) * 100 + reserved + percent > 100 - keep) {
          return no(`inside its ${r.window} budget (${c.used} of ${c.cap} tokens used${reserved ? `, ${reserved}% reserved by running Specs` : ""}${keep ? `, ${keep}% kept back` : ""}; ${COUNTED_LABEL})`, r.resetsAt);
        }
      } else {
        const pending = reserved + this.owed(provider, r.window);
        if (r.usedPercent + pending + percent > 100 - keep) {
          return no(`inside its ${keep}% ${r.window} Limit (${r.usedPercent}% used${pending ? `, ${pending}% reserved by running Specs` : ""})`, r.resetsAt);
        }
      }
    }
    return { verdict: { ok: true, provider }, percent,
      baselines: Object.fromEntries(m.readings.filter((r) => !r.counted).map((r) => [r.window, r.usedPercent])) };
  }

  private reserved(provider: string): number {
    return [...this.inflight.values()].filter((f) => f.provider === provider).reduce((a, f) => a + f.percent, 0);
  }

  /** What a Limits screen shows for one provider: the reading, the reserve, what is held back. */
  view(provider: string) {
    const cur = this.current(provider);
    const m = cur && "why" in cur ? { measuredAt: this.latest.get(provider)!.measuredAt, readings: this.latest.get(provider)!.readings.filter((r) => !r.counted) } : cur;
    const readings = (m?.readings ?? []).map((r) => ({ ...r, reservePercent: this.reserve(provider, r.window, !!r.counted) }));
    return { provider, unmetered: this.config.unmetered.includes(provider), local: this.localRule(provider), reservePercent: this.reserve(provider),
      reserves: Object.fromEntries(readings.filter((r) => !r.counted).map((r) => [r.window, r.reservePercent])),
      counted: readings.some((r) => r.counted) ? COUNTED_LABEL : null,
      measuredAt: m?.measuredAt ?? null, readings, reservedPercent: this.reserved(provider),
      owedPercent: this.owedMax(provider), verdict: this.check(provider) };
  }

  /** While a Spec runs: has its provider crossed the line? Unknown now also means stop. */
  stillWithin(spec: string): Verdict {
    const f = this.inflight.get(spec);
    if (!f) return { ok: false, provider: "?", reason: "not admitted", resetsAt: null };
    if (this.config.unmetered.includes(f.provider) || this.localRule(f.provider)) return { ok: true, provider: f.provider };  // local: its minutes cap stops it
    const m = this.current(f.provider);
    if (!m || "why" in m || this.now() - m.measuredAt > this.config.ttlMs) return { ok: false, provider: f.provider, reason: "usage no longer measured · stop", resetsAt: null };
    // A counted budget is compared in its own unit, never in a rounded percent.
    const over = m.readings.find((r) => {
      const keep = this.reserve(f.provider, r.window, !!r.counted);
      return r.counted ? r.counted.used > r.counted.cap * (100 - keep) / 100 + 1e-9 : r.usedPercent > 100 - keep;
    });
    return over ? { ok: false, provider: f.provider, reason: over.counted
        ? `crossed its ${over.window} budget (${over.counted.used} of ${over.counted.cap} ${over.counted.unit}; ${COUNTED_LABEL})`
        : `crossed its ${over.window} Limit (${over.usedPercent}% used)`, resetsAt: over.resetsAt }
                : { ok: true, provider: f.provider };
  }

  /** What finished Specs may still owe in one of the provider's own windows: their reservations,
   *  minus the rise that window has shown since the earliest of them started. Each window is
   *  reconciled on its own, never against another window or a counted budget. */
  private owed(provider: string, window: string): number {
    const ds = this.debits.filter((d) => d.provider === provider && window in d.baselines);
    if (!ds.length) return 0;
    const now = this.latest.get(provider)?.readings.find((r) => !r.counted && r.window === window)?.usedPercent ?? 0;
    const risen = Math.max(0, now - Math.min(...ds.map((d) => d.baselines[window])));
    return Math.max(0, ds.reduce((a, d) => a + d.percent, 0) - risen);
  }

  private owedMax(provider: string): number {
    const windows = new Set(this.debits.filter((d) => d.provider === provider).flatMap((d) => Object.keys(d.baselines)));
    return Math.max(0, ...[...windows].map((w) => this.owed(provider, w)));
  }

  release(spec: string): void {
    const f = this.inflight.get(spec);
    this.inflight.delete(spec);
    if (f && f.percent > 0 && Object.keys(f.baselines).length) this.debits.push({ provider: f.provider, percent: f.percent, baselines: f.baselines });
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
 *  sees what that window already used. A run is written down (synced to disk) before it starts
 *  and settled when it ends; one still open when govd starts again (it stopped mid-run) is
 *  counted as a turn that reported no tokens. A count that cannot be read or trusted holds every
 *  budget it covers: it is never quietly started again from zero. */
export class CountedStore {
  private tallies: Record<string, Record<string, Tally>> = {};
  private open: Record<string, { provider: string; at: number }> = {};
  private broken: string | null = null;           // the whole file cannot be trusted: never overwritten
  // Providers whose tallies cannot be trusted, kept as they were read: written back unchanged, so
  // they stay held after any later save and restart, until the user fixes or removes them.
  private bad: Record<string, unknown> = {};
  private file: string | null;
  private now: () => number;

  constructor(file: string | null, now: () => number = Date.now) {
    this.file = file; this.now = now;
    if (!file) return;
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.broken = `could not be read (${(e as NodeJS.ErrnoException).code ?? e})`;
      return;   // none yet: counting starts here
    }
    let d: any;
    try { d = JSON.parse(raw); } catch { this.broken = "is not valid JSON"; return; }
    const obj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0;
    if (!obj(d) || d.version !== 1 || !obj(d.tallies) || !obj(d.open)) { this.broken = "is not a count GovernCode wrote"; return; }
    for (const [provider, windows] of Object.entries(d.tallies)) {
      const ok = obj(windows) && Object.entries(windows).every(([w, t]) => w in COUNTED_WINDOWS && obj(t)
        && num(t.start) && num(t.tokens) && num(t.turns) && num(t.unreported));
      if (ok) this.tallies[provider] = windows as Record<string, Tally>; else this.bad[provider] = windows;
    }
    for (const o of Object.values(d.open)) {
      if (!obj(o) || typeof o.provider !== "string" || !num(o.at)) { this.broken = "has a run it cannot read"; return; }
    }
    this.open = d.open;
    // Runs still open: govd stopped while they ran. Counted now, as turns with unknown tokens.
    for (const spec of Object.keys(this.open)) this.settle(spec, null);
  }

  /** A window's tally, or null before its first run and after it reset. */
  private live(provider: string, window: CountedWindow): Tally | null {
    const t = this.tallies[provider]?.[window];
    return t && this.now() < t.start + COUNTED_WINDOWS[window] ? t : null;
  }

  /** Before a Runner starts: written down first, so a crash cannot lose the run. required (the
   *  provider has a counted budget): throws if it cannot be written, and the run must not start.
   *  Otherwise a failed write is no reason to stop a Runner no budget depends on: it is counted
   *  in memory. */
  begin(spec: string, provider: string, required = true): void {
    this.open[spec] = { provider, at: this.now() };
    try { this.save(); } catch (e) { if (required) { delete this.open[spec]; throw e; } }
  }

  /** A Runner run ended (or was found open after a restart): count it, once. */
  settle(spec: string, tokens: number | null): void {
    const o = this.open[spec];
    if (!o) return;
    delete this.open[spec];
    this.count(o.provider, tokens);
  }

  /** One Runner run: a turn, and its tokens if the driver reported them. */
  count(provider: string, tokens: number | null): void {
    if (provider in this.bad) return;   // held until the user fixes it; its entry is kept as read
    const p = (this.tallies[provider] ??= {});
    for (const w of Object.keys(COUNTED_WINDOWS) as CountedWindow[]) {
      const t = this.live(provider, w) ?? (p[w] = { start: this.now(), tokens: 0, turns: 0, unreported: 0 });
      t.turns += 1;
      if (tokens === null) t.unreported += 1; else t.tokens += tokens;
    }
    try { this.save(); } catch (e) { this.broken ??= `could not be written (${(e as NodeJS.ErrnoException).code ?? e})`; }
  }

  /** The provider's readings against its budget; null (held) when there is none to give. */
  measure(provider: string, budget: BudgetValue | undefined): Counted {
    const windows = Object.entries(budget?.windows ?? {}) as Array<[CountedWindow, number]>;
    if (!budget || !windows.length) return { m: null, why: `no usage source and no budget (gov budget ${provider} WINDOW N tokens|turns)` };
    if (this.broken || provider in this.bad) {
      return { m: null, why: `GovernCode's count of its own use (${this.file}) ${this.broken ?? `has an entry for ${provider} it cannot read`}; fix or remove it, then restart govd` };
    }
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
    return { m: { provider, measuredAt: this.now(), readings }, why: null };
  }

  /** Written whole, synced, renamed into place, and the folder synced: it survives a power cut.
   *  A file that could not be trusted is never overwritten. */
  private save(): void {
    if (!this.file) return;
    if (this.broken) throw new Error(`the count ${this.broken}`);
    const tmp = `${this.file}.${process.pid}.tmp`, dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, "w", 0o600);
    try {
      // writeSync may write less than asked: loop until every byte is down, or fail (no rename).
      const buf = Buffer.from(JSON.stringify({ version: 1, tallies: { ...this.tallies, ...this.bad }, open: this.open }));
      for (let off = 0; off < buf.length;) {
        const n = fs.writeSync(fd, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error("the count could not be written in full");
        off += n;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  }
}

/**
 * A Runner's usage source with the user's budget applied: the native source alone when there is
 * no budget, the count alone when there is no native source, and both when there are both (every
 * reading is checked, so the stricter one decides; either failing holds). A provider plugin with
 * its own reading would join the same way. The counted part is read after the native report and
 * again at every decision (recount), so it is never older than the decision.
 */
export function withBudget(provider: string, native: UsageSource | undefined, store: CountedStore,
    budget: () => BudgetValue | undefined): UsageSource {
  let why: string | null = null;
  const has = (b: BudgetValue | undefined): b is BudgetValue => !!b && Object.keys(b.windows).length > 0;
  // With a native source, no budget means no counted readings (not a hold).
  const recount = (): Counted => { const b = budget(); return has(b) || !native ? store.measure(provider, b) : { m: { provider, measuredAt: 0, readings: [] }, why: null }; };
  return {
    provider,
    why: () => why,
    async read() {
      if (!native) { const r = recount(); why = r.why; return r.m ? { ...r.m, recount } : null; }
      const m = await native.read();
      if (!m) { why = native.why?.() ?? "no usage reading"; return null; }
      if (!has(budget())) { why = null; return m; }
      const r = recount();   // after the await: a run counted meanwhile is included
      why = r.why;
      return r.m ? { provider, measuredAt: m.measuredAt, readings: [...m.readings, ...r.m.readings], recount } : null;
    },
  };
}
