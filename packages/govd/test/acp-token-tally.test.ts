import assert from "node:assert/strict";
import test from "node:test";
import { acpTokenTally } from "../src/acp.ts";
import { MAX_RUN_TOKENS } from "../src/codex.ts";
import { CountedStore, LimitGate, reportedTokens, usageComplete, withBudget } from "../src/limits.ts";

// Direct helpers only: no transport, driver execution or persistent store.
type Source = "notification" | "usage" | "_meta";
const sources: Source[] = ["notification", "usage", "_meta"];
const components = { inputTokens: 3, outputTokens: 2 };
const valid = { ...components, totalTokens: 5 };
const floor = (complete: boolean, totalTokens = 5, inputTokens = 3, outputTokens = 2) =>
  ({ totalTokens, inputTokens, outputTokens, complete });
function feed(t: ReturnType<typeof acpTokenTally>, source: Source, usage: unknown) {
  if (source === "notification") t.add({ prompt_id: "p", usage });
  else t.prompt({ [source]: usage });
}
function report(source: Source, usage: unknown) {
  const t = acpTokenTally();
  feed(t, source, usage);
  return t.usage(true);
}

const jsonInvalid: Array<[string, unknown]> = [
  ["negative", -1], ["string", "5"], ["null", null], ["boolean", true], ["object", {}], ["array", []],
];
for (const source of sources) {
  for (const [label, totalTokens] of jsonInvalid) {
    test(`${source}: JSON ${label} total retains an incomplete component floor`, () => {
      const usage = JSON.parse(JSON.stringify({ ...components, totalTokens }));
      assert.deepEqual(report(source, usage), floor(false));
    });
  }
  for (const [label, totalTokens] of [["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity]] as const) {
    test(`${source}: non-JSON ${label} total is incomplete`, () => {
      assert.deepEqual(report(source, { ...components, totalTokens }), floor(false));
    });
  }
  for (const literal of ["1e309", "-1e309"]) {
    test(`${source}: JSON exponent overflow ${literal} is incomplete`, () => {
      const usage = JSON.parse(`{"inputTokens":3,"outputTokens":2,"totalTokens":${literal}}`);
      assert.equal(Number.isFinite(usage.totalTokens), false);
      assert.deepEqual(report(source, usage), floor(false));
    });
  }
}

for (const source of ["notification", "usage"] as const) {
  for (const [label, usage] of [["omitted", components], ["undefined", { ...components, totalTokens: undefined }]] as const) {
    test(`${source}: ${label} total permits complete component fallback`, () => {
      assert.deepEqual(report(source, usage), floor(true));
    });
  }
}

test("prompt selection preserves usage precedence and nullish _meta fallback", () => {
  const t = acpTokenTally();
  t.prompt({ usage: { ...components, totalTokens: null }, _meta: { inputTokens: 9, outputTokens: 1, totalTokens: 10 } });
  assert.deepEqual(t.usage(true), floor(false));
  const fallback = acpTokenTally();
  fallback.prompt({ usage: null, _meta: valid });
  assert.deepEqual(fallback.usage(true), floor(true));
});

test("absent reports and _meta without a total remain no report", () => {
  for (const result of [{}, { usage: null }, { _meta: components }, { usage: null, _meta: components }]) {
    const t = acpTokenTally();
    assert.equal(t.usage(true), null);
    t.prompt(result);
    assert.equal(t.usage(true), null);
    assert.equal(t.usage(false), null);
  }
});

test("_meta with an undefined total retains existing selection and component fallback", () => {
  assert.deepEqual(report("_meta", { ...components, totalTokens: undefined }), floor(true));
});

for (const source of sources) {
  test(`${source}: malformed total latch survives later valid notifications and answers`, () => {
    const t = acpTokenTally();
    feed(t, source, { ...components, totalTokens: null });
    t.add({ prompt_id: "later", usage: valid });
    t.prompt({ usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
    t.prompt({ usage: { inputTokens: 15, outputTokens: 9, totalTokens: 24 } });
    assert.deepEqual(t.usage(true), floor(false, 24, 15, 9));
  });
}

test("malformed normalized duplicate latches before deduplication", () => {
  const t = acpTokenTally();
  t.add({ prompt_id: "p", usage: components });
  t.add({ prompt_id: "p", usage: { ...components, totalTokens: null } });
  assert.deepEqual(t.usage(true), floor(false));
  t.add({ prompt_id: "p", usage: valid });
  assert.deepEqual(t.usage(true), floor(false));
});

test("notification deduplication counts changed figures and different prompt IDs", () => {
  const t = acpTokenTally();
  t.add({ prompt_id: "p", usage: valid });
  t.add({ prompt_id: "p", usage: valid });
  assert.deepEqual(t.usage(true), floor(true));
  t.add({ prompt_id: "p", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
  t.add({ prompt_id: "q", usage: valid });
  assert.deepEqual(t.usage(true), floor(true, 16, 10, 6));
});

test("notifications without a prompt ID retain additive behavior", () => {
  const t = acpTokenTally();
  t.add({ usage: valid }); t.add({ usage: valid });
  assert.deepEqual(t.usage(true), floor(true, 10, 6, 4));
});

for (const malformedSource of ["neither", "notification", "prompt"] as const) {
  test(`notification/prompt merge uses per-figure maxima (${malformedSource} malformed)`, () => {
    const t = acpTokenTally();
    t.add({ usage: { ...components, totalTokens: malformedSource === "notification" ? null : 5 } });
    t.prompt({ usage: { inputTokens: 2, outputTokens: 6, totalTokens: malformedSource === "prompt" ? null : 8 } });
    assert.deepEqual(t.usage(true), floor(malformedSource === "neither", 8, 3, 6));
    assert.deepEqual(t.usage(false), floor(false, 8, 3, 6));
  });
}

for (const source of sources) {
  test(`${source}: valid declared totals remain authoritative, including fractions`, () => {
    for (const totalTokens of [1, 2.5, 9]) {
      assert.deepEqual(report(source, { inputTokens: 3.25, outputTokens: 2.5, totalTokens }), floor(true, totalTokens, 3.25, 2.5));
    }
  });
  test(`${source}: unreadable components discard the report and preserve earlier counts`, () => {
    for (const usage of [{ totalTokens: null }, { ...valid, inputTokens: "bad" }, { ...valid, outputTokens: -1 },
      { ...components, inputTokens: null, totalTokens: null }]) {
      assert.deepEqual(report(source, usage), floor(false, 0, 0, 0));
      const t = acpTokenTally();
      t.add({ usage: valid });
      feed(t, source, usage);
      assert.deepEqual(t.usage(true), floor(false));
    }
  });
  test(`${source}: empty report latch survives a later valid answer`, () => {
    for (const totalTokens of [0, -0]) {
      const t = acpTokenTally();
      feed(t, source, { inputTokens: 0, outputTokens: 0, totalTokens });
      assert.deepEqual(t.usage(true), floor(false, 0, 0, 0));
      t.prompt({ usage: valid });
      assert.deepEqual(t.usage(true), floor(false));
    }
    assert.deepEqual(report(source, { ...components, totalTokens: 0 }), floor(false, 0));
  });
  test(`${source}: finite explicit figures clamp to the existing cap`, () => {
    assert.deepEqual(report(source, { inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE, totalTokens: Number.MAX_VALUE }),
      floor(true, MAX_RUN_TOKENS, MAX_RUN_TOKENS, MAX_RUN_TOKENS));
  });
}

test("component fallback preserves notification cap and prompt double-cap asymmetry", () => {
  const huge = { inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE };
  assert.deepEqual(report("notification", huge), floor(true, MAX_RUN_TOKENS, MAX_RUN_TOKENS, MAX_RUN_TOKENS));
  assert.deepEqual(report("usage", huge), floor(true, 2 * MAX_RUN_TOKENS, MAX_RUN_TOKENS, MAX_RUN_TOKENS));
  const t = acpTokenTally();
  t.add({ usage: { ...huge, totalTokens: MAX_RUN_TOKENS } });
  t.add({ usage: valid });
  assert.deepEqual(t.usage(true), floor(true, MAX_RUN_TOKENS, MAX_RUN_TOKENS, MAX_RUN_TOKENS));
});

test("abnormal end retains the valid observed floor as incomplete", () => {
  const t = acpTokenTally();
  t.prompt({ usage: valid });
  assert.deepEqual(t.usage(false), floor(false));
});

async function accounting(usage: ReturnType<ReturnType<typeof acpTokenTally>["usage"]>, expectedAdmission: boolean) {
  const now = () => Date.parse("2026-01-05T08:00:00Z");
  const store = new CountedStore(null, now), gate = new LimitGate({}, now);
  const source = withBudget("invented", undefined, store, () => ({ unit: "tokens", windows: { daily: 1000 } }));
  const initial = await source.read();
  assert.ok(initial);
  gate.record(initial);
  assert.equal(gate.admit("run", "invented", 1).ok, true);
  store.begin("run", "invented");
  assert.equal(reportedTokens(usage), 5);
  store.settle("run", reportedTokens(usage), usageComplete(usage));
  store.settle("run", 999, false); // A second settlement must not change tokens, turns or completeness.
  gate.release("run");
  const measured = await source.read();
  if (measured) gate.record(measured); else gate.forget("invented", source.why?.());
  const next = gate.admit("next", "invented", 1);
  assert.equal(next.ok, expectedAdmission);
  if (expectedAdmission) {
    assert.ok(measured);
    assert.deepEqual(measured.readings[0].counted, { unit: "tokens", used: 5, cap: 1000 });
  } else {
    assert.equal(measured, null);
    assert.match(source.why?.() ?? "", /did not report tokens/);
    assert.equal(next.ok, false);
    if (!next.ok) assert.match(next.reason, /did not report tokens/);
  }
  const turns = store.measure("invented", { unit: "turns", windows: { daily: 10 } });
  assert.ok(turns.m);
  assert.deepEqual(turns.m.readings[0].counted, { unit: "turns", used: 1, cap: 10 });
  gate.record(turns.m);
  assert.equal(gate.admit("next-turn", "invented", 1).ok, true);
}

for (const source of sources) {
  test(`${source}: actual malformed tally settlement holds the next token admission`, async () => {
    await accounting(report(source, { ...components, totalTokens: null }), false);
  });
  test(`${source}: valid tally settlement permits admission within budget`, async () => {
    await accounting(report(source, valid), true);
  });
}
for (const source of ["notification", "usage"] as const) {
  test(`${source}: omitted-total tally settlement permits admission within budget`, async () => {
    await accounting(report(source, components), true);
  });
}
