// Counted budgets (#185 A) and local caps (#185 C): a fake provider with no usage report of its
// own, a fake clock, and the real Limit gate. delegate.test.ts runs the whole path with a budget.
import { test } from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTED_LABEL, COUNTED_WINDOWS, setBudget, type BudgetValue } from "@governcode/protocol";
import { CountedStore, LimitGate, REPORT_FALLBACK_MS, REPORT_LAG_MS, reportedTokens, usageComplete, withBudget, type Measurement, type UsageSource } from "../src/limits.ts";
import { scratch } from "./scratch.ts";

const H = 3_600_000, MIN = 60_000;
function clock(start = Date.parse("2026-01-05T08:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
/** A fake cloud provider's own report (or none: null). */
function native(provider: string, reading: () => Measurement | null): UsageSource {
  return { provider, read: async () => reading(), why: () => "the fake did not answer" };
}
async function measured(gate: LimitGate, src: UsageSource) {
  const m = await src.read();
  if (m) gate.record(m); else gate.forget(src.provider, src.why?.());
}
/** A fake cloud provider's own report, taken now: [window, used %, resets at]. */
function report(c: { now: () => number }, ...windows: Array<[string, number, number | null]>): Measurement {
  return { provider: "fakecloud", measuredAt: c.now(), readings: windows.map(([window, usedPercent, resets]) =>
    ({ window, usedPercent, resetsAt: resets === null ? null : new Date(resets).toISOString() })) };
}

test("counted: reported tokens in the common shapes, null when a driver reports none", () => {
  assert.equal(reportedTokens({ total_tokens: 42 }), 42);
  assert.equal(reportedTokens({ input_tokens: 300, output_tokens: 40 }), 340);
  assert.equal(reportedTokens({ inputTokens: 5, outputTokens: 6 }), 11);
  assert.equal(reportedTokens({ totalTokens: 7 }), 7);
  for (const none of [undefined, null, {}, { total_tokens: -1 }, { total_tokens: "9" }]) assert.equal(reportedTokens(none), null);
  // Only an explicit complete: false marks a report as partial.
  assert.equal(usageComplete({ totalTokens: 7, complete: false }), false);
  for (const whole of [undefined, null, {}, { totalTokens: 7 }, { complete: true }]) assert.equal(usageComplete(whole), true);
});

test("counted: a partial report adds its tokens as a floor and counts the run as unreported", () => {
  const store = new CountedStore(null);
  store.begin("S-1", "fakecloud"); store.settle("S-1", 120, false);
  const m = store.measure("fakecloud", { unit: "tokens", windows: { daily: 1000 } });
  assert.equal(m.m, null);
  assert.match(m.why!, /did not report tokens/);
  const turns = store.measure("fakecloud", { unit: "turns", windows: { daily: 10 } });
  assert.equal(turns.m!.readings[0].usedPercent, 10);
});

test("counted: a provider with no source and no budget is held, and says how to set one", async () => {
  const gate = new LimitGate();
  await measured(gate, withBudget("fakecloud", undefined, new CountedStore(null), () => undefined));
  const v = gate.check("fakecloud");
  assert.ok(!v.ok && /no usage source and no budget \(gov budget fakecloud/.test(v.reason) && /held$/.test(v.reason));
});

test("counted: turns are counted per window and become percent readings; a turn budget admits exactly its cap", async () => {
  const c = clock();
  const store = new CountedStore(null, c.now);
  const budget: BudgetValue = { unit: "turns", windows: { daily: 3, weekly: 10 } };
  const src = withBudget("fakecloud", undefined, store, () => budget);
  const gate = new LimitGate({}, c.now);
  for (let i = 1; i <= 3; i++) {
    await measured(gate, src);
    const v = gate.admit(`S-${i}`, "fakecloud", 25);
    assert.ok(v.ok, `turn ${i} of 3 is admitted`);
    store.count("fakecloud", null);
    gate.release(`S-${i}`);
  }
  await measured(gate, src);
  const view = gate.view("fakecloud");
  assert.deepEqual(view.readings.map((r) => [r.window, r.usedPercent, r.counted?.used, r.counted?.cap]), [["daily", 100, 3, 3], ["weekly", 30, 3, 10]]);
  assert.equal(view.owedPercent, 0, "govd's own count is exact: nothing is owed after a run");
  const held = gate.check("fakecloud");
  assert.ok(!held.ok && /inside its daily budget \(3 of 3 turns used; counted by GovernCode only\)/.test(held.reason));
  assert.equal(held.ok ? null : held.resetsAt, new Date(Date.parse("2026-01-06T08:00:00Z")).toISOString());
});

test("counted: running Specs hold their turn, so two at once cannot both take the last one", async () => {
  const store = new CountedStore(null);
  const gate = new LimitGate();
  await measured(gate, withBudget("fakecloud", undefined, store, () => ({ unit: "turns", windows: { daily: 2 } })));
  assert.ok(gate.admit("S-1", "fakecloud", 1).ok);
  assert.ok(gate.admit("S-2", "fakecloud", 1).ok);
  const third = gate.admit("S-3", "fakecloud", 1);
  assert.ok(!third.ok && /0 of 2 turns used, 2 running/.test(third.reason));
});

test("counted: tokens become a percent of the cap; a run that reported no tokens holds a token budget", async () => {
  const store = new CountedStore(null);
  const budget: BudgetValue = { unit: "tokens", windows: { weekly: 1000 } };
  const src = withBudget("fakecloud", undefined, store, () => budget);
  const gate = new LimitGate();
  store.count("fakecloud", 250);
  await measured(gate, src);
  assert.equal(gate.view("fakecloud").readings[0].usedPercent, 25);
  assert.ok(gate.check("fakecloud", 25).ok);
  store.count("fakecloud", 600);
  await measured(gate, src);
  const v = gate.check("fakecloud", 25);
  assert.ok(!v.ok && /850 of 1000 tokens used/.test(v.reason) && v.reason.includes(COUNTED_LABEL));
  store.count("fakecloud", null);
  await measured(gate, src);
  const unknown = gate.check("fakecloud");
  assert.ok(!unknown.ok && /did not report tokens.*count it in turns/.test(unknown.reason));
  // The same runs, counted in turns, are known.
  budget.unit = "turns"; budget.windows = { weekly: 10 };
  await measured(gate, src);
  assert.ok(gate.check("fakecloud").ok);
});

test("counted: a window resets its length after its first run, like the vendors' windows", async () => {
  const c = clock();
  const store = new CountedStore(null, c.now);
  const budget: BudgetValue = { unit: "turns", windows: { "5-hour": 2, weekly: 5 } };
  const read = () => store.measure("fakecloud", budget).m!.readings;
  assert.deepEqual(read().map((r) => r.resetsAt), [null, null], "no window runs before the first run");
  store.count("fakecloud", null);
  c.advance(4 * H);
  store.count("fakecloud", null);
  assert.deepEqual(read().map((r) => r.counted!.used), [2, 2]);
  assert.equal(read()[0].resetsAt, new Date(Date.parse("2026-01-05T13:00:00Z")).toISOString());
  c.advance(H);   // the 5-hour window started at 08:00 is over; the weekly one is not
  assert.deepEqual(read().map((r) => r.counted!.used), [0, 2]);
  store.count("fakecloud", null);
  assert.equal(read()[0].resetsAt, new Date(Date.parse("2026-01-05T18:00:00Z")).toISOString(), "the next window starts at its first run");
  c.advance(COUNTED_WINDOWS.weekly);
  assert.deepEqual(read().map((r) => r.counted!.used), [0, 0]);
});

test("counted: the count survives a restart (kept in govd's state, private)", () => {
  const file = join(scratch("gc-counted-"), "state", "counted.json");
  const c = clock();
  const before = new CountedStore(file, c.now);
  before.count("fakecloud", 120);
  before.count("fakecloud", 80);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const after = new CountedStore(file, c.now);
  const m = after.measure("fakecloud", { unit: "tokens", windows: { daily: 1000 } }).m!;
  assert.deepEqual(m.readings[0].counted, { unit: "tokens", used: 200, cap: 1000 });
  assert.equal(m.readings[0].usedPercent, 20);
});

test("counted (review 1): a count that cannot be read or trusted holds its budgets, and is never overwritten", () => {
  const budget: BudgetValue = { unit: "turns", windows: { daily: 5 } };
  const dir = scratch("gc-counted-");
  const damaged = join(dir, "counted.json");
  writeFileSync(damaged, "{not json");
  const store = new CountedStore(damaged);
  assert.match(store.measure("fakecloud", budget).why!, /is not valid JSON; fix or remove it, then restart govd/);
  store.count("fakecloud", 1);
  assert.equal(readFileSync(damaged, "utf8"), "{not json", "the evidence is kept, not replaced by a fresh zero");
  assert.throws(() => store.begin("S-1", "fakecloud"), /not valid JSON/, "a run that cannot be written down does not start");
  // Readable JSON of another shape, and a tally that is not numbers.
  writeFileSync(damaged, JSON.stringify({ fakecloud: { daily: { start: 0, tokens: 0, turns: 9, unreported: 0 } } }));
  assert.match(new CountedStore(damaged).measure("fakecloud", budget).why!, /is not a count GovernCode wrote/);
  writeFileSync(damaged, JSON.stringify({ version: 1, open: {}, tallies: {
    fakecloud: { daily: { start: Date.now(), tokens: 0, turns: "9", unreported: 0 } },
    other: { daily: { start: Date.now(), tokens: 0, turns: 2, unreported: 0 } } } }));
  const partly = new CountedStore(damaged);
  assert.match(partly.measure("fakecloud", budget).why!, /has an entry for fakecloud it cannot read/);
  assert.equal(partly.measure("other", budget).m!.readings[0].counted!.used, 2, "other providers' counts still stand");
  // A file govd may not read is not "no file yet".
  if (process.getuid?.() !== 0) {
    const locked = join(dir, "locked.json");
    writeFileSync(locked, "{}", { mode: 0o000 });
    assert.match(new CountedStore(locked).measure("fakecloud", budget).why!, /could not be read \(EACCES\)/);
  }
});

test("counted (re-review N1): a provider's unreadable entry stays held after another provider saves and govd restarts", () => {
  const file = join(scratch("gc-counted-"), "counted.json");
  const budget: BudgetValue = { unit: "turns", windows: { daily: 5 } };
  writeFileSync(file, JSON.stringify({ version: 1, open: {}, tallies: {
    fakecloud: { daily: { start: Date.now(), tokens: 0, turns: "9", unreported: 0 } } } }));
  const first = new CountedStore(file);
  first.begin("S-1", "other"); first.settle("S-1", null);     // another provider saves
  first.count("fakecloud", null);                            // and a run of the held one is not mixed in
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tallies.fakecloud.daily.turns, "9", "kept exactly as read");
  const restarted = new CountedStore(file);
  assert.match(restarted.measure("fakecloud", budget).why!, /has an entry for fakecloud it cannot read/);
  assert.equal(restarted.measure("other", budget).m!.readings[0].counted!.used, 1);
});

test("counted (re-review N2): a short write is completed before the rename; a write that stalls renames nothing", (t) => {
  const file = join(scratch("gc-counted-"), "counted.json");
  const real = fs.writeSync;
  // At most 12 bytes per call: the loop must finish the file.
  t.mock.method(fs, "writeSync", (fd: number, buf: Buffer, off: number, len: number) => real(fd, buf, off, Math.min(len, 12)));
  const store = new CountedStore(file);
  store.begin("S-1", "fakecloud");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).open), ["S-1"]);
  // A write that makes no progress fails the begin, and the good file stays in place.
  t.mock.method(fs, "writeSync", () => 0);
  assert.throws(() => store.begin("S-2", "fakecloud"), /could not be written in full/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).open), ["S-1"]);
});

test("counted (re-review N3): a broken count stops only Runners with a budget; others run and are counted in memory", () => {
  const file = join(scratch("gc-counted-"), "counted.json");
  writeFileSync(file, "{not json");
  const store = new CountedStore(file);
  assert.throws(() => store.begin("S-1", "budgeted", true), /not valid JSON/);
  assert.doesNotThrow(() => store.begin("S-2", "unbudgeted", false));
  store.settle("S-2", 10);
  assert.equal(readFileSync(file, "utf8"), "{not json", "still never overwritten");
});

test("counted (review 2): a run is on disk before it starts; one left open by a crash counts on restart", () => {
  const file = join(scratch("gc-counted-"), "counted.json");
  const budget: BudgetValue = { unit: "turns", windows: { daily: 5 } };
  const before = new CountedStore(file);
  before.begin("S-0001", "fakecloud");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).open), ["S-0001"]);
  // govd stops here (no settle). The next govd counts the run, as a turn with unknown tokens.
  const after = new CountedStore(file);
  assert.equal(after.measure("fakecloud", budget).m!.readings[0].counted!.used, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).open, {});
  assert.match(after.measure("fakecloud", { unit: "tokens", windows: { daily: 1000 } }).why!, /did not report tokens/);
  // A settled run counts once, however often it is settled.
  after.begin("S-0002", "fakecloud");
  after.settle("S-0002", 40);
  after.settle("S-0002", 40);
  assert.equal(new CountedStore(file).measure("fakecloud", budget).m!.readings[0].counted!.used, 2);
});

test("counted (review 3): a run counted while the provider's report was being read is not missed", async () => {
  const store = new CountedStore(null);
  let answer!: (m: Measurement) => void;
  const slow = { provider: "fakecloud", read: () => new Promise<Measurement>((ok) => { answer = ok; }) };
  const src = withBudget("fakecloud", slow, store, () => ({ unit: "turns", windows: { daily: 1 } }));
  const gate = new LimitGate();
  const reading = src.read();                        // B starts measuring, before A has finished
  store.begin("S-A", "fakecloud"); store.settle("S-A", null);   // A takes the last turn and ends
  answer({ provider: "fakecloud", measuredAt: Date.now(), readings: [{ window: "weekly", usedPercent: 0, resetsAt: null }] });
  gate.record((await reading)!);
  const b = gate.admit("S-B", "fakecloud", 1);
  assert.ok(!b.ok && /1 of 1 turns used/.test(b.reason));
  // And one counted after the reading was recorded, before the decision, is seen too.
  const gate2 = new LimitGate();
  gate2.record({ provider: "fakecloud", measuredAt: Date.now(), readings: [], recount: () => store.measure("fakecloud", { unit: "turns", windows: { daily: 2 } }) });
  assert.ok(gate2.check("fakecloud").ok);
  store.count("fakecloud", null);
  assert.ok(!gate2.check("fakecloud").ok, "decided on the count as it is now");
});

test("counted (review 4): a counted budget rising does not pay off what finished Specs owe the provider's own window", async () => {
  const store = new CountedStore(null);
  const src = withBudget("fakecloud", native("fakecloud", () => ({ provider: "fakecloud", measuredAt: Date.now(),
    readings: [{ window: "weekly", usedPercent: 70, resetsAt: null }] })), store, () => ({ unit: "tokens", windows: { daily: 1000 } }));
  const gate = new LimitGate();
  await measured(gate, src);
  assert.ok(gate.admit("S-A", "fakecloud", 20).ok);
  gate.release("S-A");                               // the provider's report has not caught up: still 70%
  store.count("fakecloud", 950);
  await measured(gate, src);
  assert.equal(gate.view("fakecloud").owedPercent, 20);
  const next = gate.check("fakecloud", 1);
  assert.ok(!next.ok && /10% weekly Limit \(70% used, 20% held for finished Specs/.test(next.reason), "70 + 20 owed + 1 is past the 90% line");
});

test("counted (review 5): finished runs are in the count, so what they owe the provider's window is not added to it", async () => {
  const store = new CountedStore(null);
  const src = withBudget("fakecloud", native("fakecloud", () => ({ provider: "fakecloud", measuredAt: Date.now(),
    readings: [{ window: "weekly", usedPercent: 0, resetsAt: null }] })), store, () => ({ unit: "tokens", windows: { daily: 1000 } }));
  const gate = new LimitGate({ reservePercent: { fakecloud: { daily: 10 } } });
  await measured(gate, src);
  assert.ok(gate.admit("S-A", "fakecloud", 10).ok);
  gate.release("S-A");
  store.count("fakecloud", 600);
  await measured(gate, src);
  assert.ok(gate.check("fakecloud", 25).ok, "60% counted + 25% fits the 90% budget line; the 10% owed is the weekly window's");
});

test("counted (review 6): a running Spec is stopped on the raw count, not a rounded percent", async () => {
  const store = new CountedStore(null);
  const src = withBudget("fakecloud", undefined, store, () => ({ unit: "tokens", windows: { daily: 10_000 } }));
  const gate = new LimitGate();
  await measured(gate, src);
  assert.ok(gate.admit("S-1", "fakecloud", 1).ok);
  store.count("fakecloud", 10_004);
  await measured(gate, src);
  assert.equal(gate.view("fakecloud").readings[0].usedPercent, 100, "shown rounded");
  const v = gate.stillWithin("S-1");
  assert.ok(!v.ok && /10004 of 10000 tokens/.test(v.reason));
});

test("counted: with the provider's own report too, both are checked and the stricter decides", async () => {
  let used = 10, answers = true;
  const store = new CountedStore(null);
  let budget: BudgetValue | undefined = { unit: "turns", windows: { daily: 1 } };
  const src = withBudget("fakecloud", native("fakecloud", () => answers ? { provider: "fakecloud", measuredAt: Date.now(),
    readings: [{ window: "weekly", usedPercent: used, resetsAt: null }] } : null), store, () => budget);
  const gate = new LimitGate();
  await measured(gate, src);
  assert.ok(gate.check("fakecloud").ok, "both readings leave room");
  assert.deepEqual(gate.view("fakecloud").readings.map((r) => [r.window, !!r.counted, r.reservePercent]), [["weekly", false, 10], ["daily", true, 0]]);
  store.count("fakecloud", null);
  await measured(gate, src);
  const byCount = gate.check("fakecloud");
  assert.ok(!byCount.ok && /daily budget/.test(byCount.reason), "the provider says 10%, the budget is spent: held");
  budget = { unit: "turns", windows: { daily: 50 } }; used = 95;
  await measured(gate, src);
  const byVendor = gate.check("fakecloud");
  assert.ok(!byVendor.ok && /10% weekly Limit \(95% used\)/.test(byVendor.reason), "the budget has room, the provider does not: held");
  used = 10; answers = false;
  await measured(gate, src);
  const unknown = gate.check("fakecloud");
  assert.ok(!unknown.ok && /the fake did not answer · held/.test(unknown.reason), "one source unknown: held, whatever the other says");
  budget = undefined; answers = true;
  await measured(gate, src);
  assert.equal(gate.view("fakecloud").counted, null, "no budget: the provider's own report alone");
});

test("counted: labelled as counted by GovernCode only; a counted run over its cap stops a running Spec", async () => {
  const store = new CountedStore(null);
  const src = withBudget("fakecloud", undefined, store, () => ({ unit: "tokens", windows: { daily: 100 } }));
  const gate = new LimitGate();
  await measured(gate, src);
  assert.equal(gate.view("fakecloud").counted, "counted by GovernCode only");
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  store.count("fakecloud", 150);          // another Spec finished far over
  await measured(gate, src);
  const v = gate.stillWithin("S-1");
  assert.ok(!v.ok && /crossed its daily budget \(150 of 100 tokens; counted by GovernCode only\)/.test(v.reason));
});

// Finished Specs hold what they reserved only until the provider's report has caught up (found
// live: a Spec reserved 10% and used 1%, and 9% stayed held until govd restarted).
test("limits: a finished Spec that used less than it reserved stops holding 15 minutes on, once its window has moved", () => {
  const c = clock(), week = c.now() + 72 * H;
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 60, week]));
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  c.advance(10 * MIN);
  gate.release("S-1");                                   // it used 1% of the 10% it reserved
  gate.record(report(c, ["weekly", 61, week]));
  assert.equal(gate.view("fakecloud").owedPercent, 9);
  assert.ok(gate.admit("S-2", "fakecloud", 10).ok, "61 + 9 + 10 = 80");
  const v = gate.check("fakecloud", 11);
  assert.ok(!v.ok && v.reason.includes("(61% used, 10% reserved by running Specs, 9% held for finished Specs until the usage report catches up)"),
    "61 + 10 + 9 + 11 = 91, and each part is named for what it is");
  c.advance(REPORT_LAG_MS);
  gate.record(report(c, ["weekly", 61, week]));
  assert.equal(gate.view("fakecloud").owedPercent, 0, "the report has caught up with S-1");
  assert.ok(gate.check("fakecloud", 19).ok, "61 + 10 running + 19 = 90");
});

test("limits: inside the lag allowance a finished Spec stays held, whatever the reading says", () => {
  const c = clock();
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 45, null]));
  assert.ok(gate.admit("S-1", "fakecloud", 25).ok);
  gate.release("S-1");
  c.advance(REPORT_LAG_MS - 1);
  gate.record(report(c, ["weekly", 45, null]));
  assert.equal(gate.view("fakecloud").owedPercent, 25, "nothing shown yet: its use may still be on the way");
  assert.equal(gate.check("fakecloud", 21).ok, false, "45 + 25 + 21 = 91");
  gate.record(report(c, ["weekly", 0, null]));
  assert.equal(gate.view("fakecloud").owedPercent, 25, "a reading that fell does not say when the window reset");
  gate.record(report(c, ["weekly", 55, null]));
  assert.equal(gate.view("fakecloud").owedPercent, 15, "risen 10: paid down, not settled");
  c.advance(1);
  gate.record(report(c, ["weekly", 55, null]));
  assert.equal(gate.view("fakecloud").owedPercent, 0, "15 minutes on, and the window has moved");
});

test("limits: a held amount is shown rounded up to a tenth, so a hold that still counts never shows as 0%", () => {
  const c = clock();
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 70.1, null]));
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  gate.release("S-1");
  gate.record(report(c, ["weekly", 71.3, null]));
  assert.equal(gate.view("fakecloud").owedPercent, 8.8, "not 8.799999999999997");
  gate.record(report(c, ["weekly", 80.06, null]));
  assert.equal(gate.view("fakecloud").owedPercent, 0.1);
  const v = gate.check("fakecloud", 10);
  assert.ok(!v.ok && v.reason.includes("(80.06% used, 0.1% held for finished Specs"), "0.04 still counts");
});

test("limits: a report that never moved holds a finished Spec past 15 minutes, until the fallback", () => {
  const c = clock(), week = c.now() + 72 * H;
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 13, week]));
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  gate.release("S-1");
  c.advance(REPORT_LAG_MS);
  gate.record(report(c, ["weekly", 13, week]));
  assert.equal(gate.view("fakecloud").owedPercent, 10, "15 minutes on, but the report has not moved: it may be lagging further");
  c.advance(REPORT_FALLBACK_MS - REPORT_LAG_MS - 1);
  gate.record(report(c, ["weekly", 13, week]));
  assert.equal(gate.view("fakecloud").owedPercent, 10);
  c.advance(1);
  gate.record(report(c, ["weekly", 13, week]));
  assert.equal(gate.view("fakecloud").owedPercent, 0, "held 2 hours at most");
});

test("limits: a window the vendor confirms has reset since a Spec finished stops holding it at once", () => {
  const c = clock(), reset = c.now() + 10 * MIN;
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 60, reset]));
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  c.advance(5 * MIN);
  gate.release("S-1");
  c.advance(6 * MIN);
  gate.record(report(c, ["weekly", 1, reset]));
  assert.equal(gate.view("fakecloud").owedPercent, 10, "past the reset time by govd's clock, but the vendor still gives the old one");
  gate.record(report(c, ["weekly", 1, reset + 168 * H]));
  assert.equal(gate.view("fakecloud").owedPercent, 0, "the vendor confirms a new window; S-1 ran wholly in the old one");
});

test("limits: a missing or unreadable reset time never confirms a reset", () => {
  const cases: Array<[string | null, string | null]> = [[null, null], ["soon", "later"], ["2026-01-05T08:05:00Z", "garbage"], ["2026-01-05T08:05:00Z", null]];
  for (const [was, now] of cases) {
    const c = clock();
    const gate = new LimitGate({}, c.now);
    gate.record({ provider: "fakecloud", measuredAt: c.now(), readings: [{ window: "weekly", usedPercent: 60, resetsAt: was }] });
    assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
    gate.release("S-1");
    c.advance(10 * MIN);
    gate.record({ provider: "fakecloud", measuredAt: c.now(), readings: [{ window: "weekly", usedPercent: 0, resetsAt: now }] });
    assert.equal(gate.view("fakecloud").owedPercent, 10, `reset time ${was}, then ${now}: still held`);
  }
});

test("limits: a reset time already past when the Spec was admitted settles nothing", () => {
  const c = clock(), next = c.now() + MIN + 168 * H;
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 60, c.now() + MIN]));   // read a minute before its window reset
  c.advance(3 * MIN);
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok, "the reading is 3 minutes old: still fresh");
  c.advance(5 * MIN);
  gate.release("S-1");
  gate.record(report(c, ["weekly", 2, next]));
  assert.equal(gate.view("fakecloud").owedPercent, 10, "it ran in the new window, which may not show it yet");
  c.advance(REPORT_LAG_MS);
  gate.record(report(c, ["weekly", 2, next]));
  assert.equal(gate.view("fakecloud").owedPercent, 10, "nor is the new window's 2% a rise over the 60% it was admitted against");
});

test("limits: a reading without the window settles nothing there until the fallback", () => {
  const c = clock();
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["5-hour", 30, null], ["weekly", 50, null]));
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  gate.release("S-1");
  c.advance(REPORT_LAG_MS);
  gate.record(report(c, ["weekly", 55, null]));          // no 5-hour window this time
  assert.equal(gate.view("fakecloud").owedPercent, 10, "weekly moved and is settled; the 5-hour claim stands");
  c.advance(REPORT_FALLBACK_MS - REPORT_LAG_MS);
  gate.record(report(c, ["weekly", 55, null]));
  assert.equal(gate.view("fakecloud").owedPercent, 0);
});

test("limits: when one claim ends on a reading that fell, the claims still open keep their baseline", () => {
  const c = clock();
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 50, null]));
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  gate.release("S-1");
  c.advance(10 * MIN);
  gate.record(report(c, ["weekly", 50, null]));
  assert.ok(gate.admit("S-2", "fakecloud", 10).ok);
  gate.release("S-2");
  c.advance(REPORT_FALLBACK_MS - 10 * MIN);              // S-1 reaches the fallback, S-2 not yet
  gate.record(report(c, ["weekly", 40, null]));          // on a reading that fell
  assert.equal(gate.view("fakecloud").owedPercent, 10);
  gate.record(report(c, ["weekly", 50, null]));          // back where S-2 started
  assert.equal(gate.view("fakecloud").owedPercent, 10, "the dip and recovery are not S-2's use");
});

test("limits: one Spec's overrun pays no other Spec's hold", () => {
  const c = clock();
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["weekly", 40, null]));
  assert.ok(gate.admit("A", "fakecloud", 5).ok);
  assert.ok(gate.admit("B", "fakecloud", 10).ok);
  gate.release("A");
  gate.release("B");
  c.advance(MIN);
  gate.record(report(c, ["weekly", 60, null]));          // A used 20; B's use is not reported yet
  assert.equal(gate.view("fakecloud").owedPercent, 10, "the rise of 20 pays one claim at most, so B's 10 still holds");
  const v = gate.check("fakecloud", 21);
  assert.ok(!v.ok && v.reason.includes("(60% used, 10% held for finished Specs"), "60 + 10 + 21 = 91");
  // Nor a Spec admitted after the overrun (A's own 5 counts until its report catches up).
  const later = new LimitGate({}, c.now);
  later.record(report(c, ["weekly", 40, null]));
  assert.ok(later.admit("A", "fakecloud", 5).ok);
  later.release("A");
  c.advance(MIN);
  later.record(report(c, ["weekly", 60, null]));
  assert.ok(later.admit("C", "fakecloud", 10).ok);
  later.release("C");
  assert.equal(later.view("fakecloud").owedPercent, 15);
});

test("limits: overlapping reads: an older answer arriving late never replaces a newer one", () => {
  const c = clock();
  const gate = new LimitGate({}, c.now);
  const asked = report(c, ["weekly", 20, null]);
  c.advance(MIN);
  const newer = report(c, ["weekly", 85, null]);
  gate.record(newer);
  gate.record(asked);                                    // asked first, answered last
  assert.equal(gate.view("fakecloud").measuredAt, newer.measuredAt);
  assert.equal(gate.check("fakecloud", 6).ok, false, "decided on 85%, not 20%");
});

test("limits: finished Specs across two windows: each claim ends on its own, each window is reconciled on its own", () => {
  const c = clock(), t0 = c.now(), reset = t0 + 15 * MIN, week = t0 + 120 * H;
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["5-hour", 20, reset], ["weekly", 60, week]));
  assert.ok(gate.admit("S-1", "fakecloud", 10).ok);
  c.advance(5 * MIN);
  gate.release("S-1");
  c.advance(5 * MIN);
  gate.record(report(c, ["5-hour", 20, reset], ["weekly", 60, week]));
  assert.ok(gate.admit("S-2", "fakecloud", 10).ok);
  c.advance(6 * MIN);
  gate.release("S-2");                                   // it ran across the 5-hour reset
  gate.record(report(c, ["5-hour", 3, reset + 5 * H], ["weekly", 72, week]));
  assert.equal(gate.view("fakecloud").owedPercent, 10, "5-hour: S-1 finished before the reset and is settled; S-2 holds its 10");
  const a = gate.check("fakecloud", 25);
  assert.ok(!a.ok && a.reason.includes("weekly Limit (72% used, 10% held for finished Specs"), "weekly: 20 held, and the rise of 12 pays one claim at most");
  c.advance(4 * MIN);                                    // S-1 finished 15 minutes ago, and weekly has moved
  gate.record(report(c, ["5-hour", 4, reset + 5 * H], ["weekly", 72, week]));
  const b = gate.check("fakecloud", 25);
  assert.ok(!b.ok && b.reason.includes("weekly Limit (72% used, 10% held for finished Specs"), "S-1 is settled; the rise so far may be its own, so none of it pays S-2");
  c.advance(11 * MIN);                                   // S-2 finished 15 minutes ago
  gate.record(report(c, ["5-hour", 4, reset + 5 * H], ["weekly", 72, week]));
  assert.ok(gate.check("fakecloud", 18).ok, "weekly is settled: 72 + 18 = 90");
  assert.equal(gate.view("fakecloud").owedPercent, 10, "5-hour: S-2 ran across the reset, and the new window has not passed where it was admitted");
  c.advance(REPORT_FALLBACK_MS - REPORT_LAG_MS);
  gate.record(report(c, ["5-hour", 4, reset + 5 * H], ["weekly", 72, week]));
  assert.equal(gate.view("fakecloud").owedPercent, 0);
});

test("unmetered stays an explicit opt-in, labelled as nothing counted", () => {
  const gate = new LimitGate({ unmetered: ["fakecloud"] });
  const v = gate.check("fakecloud");
  assert.ok(v.ok && v.note === "unmetered (your opt-in): nothing counted, no Limit");
  assert.equal(gate.view("fakecloud").unmetered, true);
});

// The minutes cap stopping a real (fake) model is in local.test.ts.
test("local caps: at most N running at once, and the rule the Runner is given names both caps", () => {
  const gate = new LimitGate({ local: { providers: ["ollama"], maxRunning: 2, maxMinutes: 7 } });
  gate.record({ provider: "ollama", measuredAt: Date.now(), readings: [] });
  assert.ok(gate.admit("S-1", "ollama", 5).ok);
  const second = gate.admit("S-2", "ollama", 5);
  assert.ok(second.ok && second.note === "local: at most 2 at once, 7 min each");
  const third = gate.admit("S-3", "ollama", 5);
  assert.ok(!third.ok && /already running 2 local Specs \(at most 2 at once\)/.test(third.reason));
  assert.deepEqual(gate.localRule("ollama"), { maxRunning: 2, maxMinutes: 7 });
});

test("setBudget: one window at a time; switching the unit drops the other unit's caps; off removes", () => {
  let b = setBudget({}, "fakecloud", "daily", 20);
  assert.deepEqual(b, { fakecloud: { unit: "turns", windows: { daily: 20 } } });
  b = setBudget(b, "fakecloud", "weekly", 80);
  assert.deepEqual(b.fakecloud.windows, { daily: 20, weekly: 80 });
  b = setBudget(b, "fakecloud", "weekly", 2_000_000, "tokens");
  assert.deepEqual(b.fakecloud, { unit: "tokens", windows: { weekly: 2_000_000 } });
  b = setBudget(b, "fakecloud", "weekly", null);
  assert.deepEqual(b, {});
});

test("a reservation dropped before its Runner started owes nothing (abandon), unlike a finished one (release)", async () => {
  const src = native("fakecloud", () => ({ provider: "fakecloud", measuredAt: Date.now(), readings: [{ window: "weekly", usedPercent: 50, resetsAt: null }] }));
  const gate = new LimitGate();
  await measured(gate, src);
  assert.ok(gate.admit("S-A", "fakecloud", 20).ok);
  gate.abandon("S-A");                                // its copy could not be made: nothing ran
  assert.equal(gate.view("fakecloud").owedPercent, 0);
  assert.ok(gate.admit("S-B", "fakecloud", 20).ok);
  gate.release("S-B");                                // it ran: owed until the provider's report catches up
  assert.equal(gate.view("fakecloud").owedPercent, 20);
});

test("limits: a hold uses the latest reset of every blocking window, or none if one is unknown", () => {
  const c = clock(), sooner = c.now() + H, later = c.now() + 2 * H;
  const gate = new LimitGate({}, c.now);
  gate.record(report(c, ["5-hour", 95, sooner], ["weekly", 95, later]));
  const both = gate.check("fakecloud");
  assert.ok(!both.ok);
  assert.match(both.reason, /5-hour Limit/, "the first blocking reading still supplies the reason");
  assert.equal(both.resetsAt, new Date(later).toISOString());
  gate.record(report(c, ["5-hour", 95, sooner], ["weekly", 95, null]));
  const unknown = gate.check("fakecloud");
  assert.ok(!unknown.ok);
  assert.equal(unknown.resetsAt, null);
});

test("limits: owed amounts survive restart, expire at the fallback, and a broken file is ignored", () => {
  const dir = scratch("gc-owed-"), file = join(dir, "owed.json"), c = clock();
  const before = new LimitGate({}, c.now, file);
  before.record(report(c, ["weekly", 40, null]));
  assert.ok(before.admit("S-1", "fakecloud", 20).ok);
  before.release("S-1");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const restarted = new LimitGate({}, c.now, file);
  restarted.record(report(c, ["weekly", 40, null]));
  assert.equal(restarted.view("fakecloud").owedPercent, 20);

  c.advance(REPORT_FALLBACK_MS + 1);
  const expired = new LimitGate({}, c.now, file);
  expired.record(report(c, ["weekly", 40, null]));
  assert.equal(expired.view("fakecloud").owedPercent, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).debits, []);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{not json");
  const ignored = new LimitGate({}, c.now, broken);
  ignored.record(report(c, ["weekly", 40, null]));
  assert.equal(ignored.view("fakecloud").owedPercent, 0);
});
