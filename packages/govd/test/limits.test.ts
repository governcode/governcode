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
  // A damaged file starts counting again rather than stopping govd.
  const damaged = join(scratch("gc-counted-"), "counted.json");
  writeFileSync(damaged, "{not json");
  new CountedStore(damaged).count("x", 1);
  assert.equal(JSON.parse(readFileSync(damaged, "utf8")).x.daily.turns, 1);
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

test("local caps: at most N running whatever budget is set, M minutes each", async () => {
  const store = new CountedStore(null);
  const gate = new LimitGate({ local: { providers: ["ollama"], maxRunning: 2, maxMinutes: 7 } });
  gate.record({ provider: "ollama", measuredAt: Date.now(), readings: [] });
  assert.ok(gate.admit("S-1", "ollama", 5).ok);
  const second = gate.admit("S-2", "ollama", 5);
  assert.ok(second.ok && second.note === "local: at most 2 at once, 7 min each");
  const third = gate.admit("S-3", "ollama", 5);
  assert.ok(!third.ok && /already running 2 local Specs \(at most 2 at once\)/.test(third.reason));
  store.count("ollama", 10);
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
