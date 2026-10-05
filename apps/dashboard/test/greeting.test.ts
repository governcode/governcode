import { test } from "node:test";
import assert from "node:assert/strict";
import { dayPart, greeting, GREETINGS } from "../src/shared/greeting.ts";

const at = (h: number, m = 0, day = 5) => new Date(2026, 9, day, h, m);

test("the part of the day follows the local clock", () => {
  assert.equal(dayPart(at(4, 59)), "night");
  assert.equal(dayPart(at(5)), "morning");
  assert.equal(dayPart(at(11, 59)), "morning");
  assert.equal(dayPart(at(12)), "afternoon");
  assert.equal(dayPart(at(17)), "evening");
  assert.equal(dayPart(at(21, 59)), "evening");
  assert.equal(dayPart(at(22)), "night");
  assert.equal(dayPart(at(0, 30)), "night");
});

test("a greeting comes from its part of the day and stays put while that part lasts", () => {
  for (const [h, part] of [[8, "morning"], [14, "afternoon"], [19, "evening"], [23, "night"]] as const) {
    assert.ok(GREETINGS[part].includes(greeting(at(h))), `${h}:00`);
    assert.equal(greeting(at(h)), greeting(at(h, 45)));
  }
  // 23:30 and 01:30 the next day are the same night.
  assert.equal(greeting(at(23, 30, 5)), greeting(at(1, 30, 6)));
});

test("different days get different greetings, so the list is actually used", () => {
  const seen = new Set(Array.from({ length: 30 }, (_, d) => greeting(at(9, 0, d + 1))));
  assert.ok(seen.size >= 3, `only ${seen.size} morning greetings in a month`);
});
