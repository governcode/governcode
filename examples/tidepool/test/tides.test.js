import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, turningPoints, range } from "../src/tides.js";

const readings = parse(readFileSync(new URL("../data/harbor.csv", import.meta.url), "utf8"));

test("parses every hour of the day", () => {
  assert.equal(readings.length, 24);
  assert.deepEqual(readings[0], { hour: 0, height: 2.31 });
});

test("finds both high waters", () => {
  assert.deepEqual(turningPoints(readings).highs.map((r) => r.hour), [10, 21]);
});

test("finds both low waters", () => {
  assert.deepEqual(turningPoints(readings).lows.map((r) => r.hour), [5, 16]);
});

test("a turning point in the second-to-last hour counts", () => {
  const tail = parse("hour,height_m\n0,1.0\n1,1.5\n2,2.0\n3,1.8\n");
  assert.deepEqual(turningPoints(tail).highs.map((r) => r.hour), [2]);
});

test("range is highest minus lowest", () => {
  assert.equal(range(readings).toFixed(2), "2.03");
});
