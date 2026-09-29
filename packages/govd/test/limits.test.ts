// Counted budgets (#185 A) and local caps (#185 C): a fake provider with no usage report of its
// own, a fake clock, and the real Limit gate. delegate.test.ts runs the whole path with a budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTED_LABEL, COUNTED_WINDOWS, setBudget, type BudgetValue } from "@governcode/protocol";
import { CountedStore, LimitGate, reportedTokens, withBudget, type Measurement, type UsageSource } from "../src/limits.ts";
import { scratch } from "./scratch.ts";

const H = 3_600_000;
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

test("counted: reported tokens in the common shapes, null when a driver reports none", () => {
  assert.equal(reportedTokens({ total_tokens: 42 }), 42);
  assert.equal(reportedTokens({ input_tokens: 300, output_tokens: 40 }), 340);
  assert.equal(reportedTokens({ inputTokens: 5, outputTokens: 6 }), 11);
  assert.equal(reportedTokens({ totalTokens: 7 }), 7);
  for (const none of [undefined, null, {}, { total_tokens: -1 }, { total_tokens: "9" }]) assert.equal(reportedTokens(none), null);
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
  assert.ok(!next.ok && /10% weekly Limit \(70% used, 20% reserved/.test(next.reason), "70 + 20 owed + 1 is past the 90% line");
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
