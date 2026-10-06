import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, until, when } from "../src/shared/time.ts";

const now = new Date(2026, 9, 5, 10, 0);   // Monday 5 October, 10:00 local
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();
const S = 1000, MIN = 60 * S, H = 60 * MIN;

test("ago counts seconds, then minutes, then hours, and never the future", () => {
  const t = now.getTime();
  assert.equal(ago(t - 40 * S, t), "40 s ago");
  assert.equal(ago(t - 12 * MIN, t), "12 min ago");
  assert.equal(ago(t - 3 * H, t), "3 h ago");
  assert.equal(ago(t + 5 * MIN, t), "0 s ago");
});

test("until reads minutes, then hours and minutes, then days", () => {
  const t = now.getTime();
  assert.equal(until(new Date(t + 25 * MIN).toISOString(), t), "in 25 min");
  assert.equal(until(new Date(t + 3 * H + 5 * MIN).toISOString(), t), "in 3 h 5 min");
  assert.equal(until(new Date(t + 47 * H).toISOString(), t), "in 47 h 0 min");
  assert.equal(until(new Date(t + 4 * 24 * H).toISOString(), t), "in 4 days");
  assert.equal(until(new Date(t - H).toISOString(), t), "in 0 min");
});

test("when names today by its time, then tomorrow, then the weekday, then the date", () => {
  assert.equal(when(at(5, 14, 20), now), "14:20");
  assert.equal(when(at(6, 9, 10), now), "tomorrow 09:10");
  const thu = when(at(8, 14), now);
  assert.match(thu, /14:00$/);
  assert.ok(!thu.startsWith("tomorrow") && thu !== "14:00", thu);
  const later = when(at(20, 14), now);   // two weeks on: the date, in the reader's own format
  assert.match(later, /20.*14:00$/);
});

test("when shows a vendor's own text as given", () => {
  assert.equal(when("after the weekly reset", now), "after the weekly reset");
});
