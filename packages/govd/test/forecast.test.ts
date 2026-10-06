import { test } from "node:test";
import assert from "node:assert/strict";
import { forecast, type Point } from "../src/forecast.ts";

const H = 3_600_000, MIN = 60_000;
const T = Date.parse("2026-10-05T10:00:00Z");
const reset = (h: number) => new Date(T + h * H).toISOString();

test("a steady rise reaches the reserve at its pace, before the reset", () => {
  const pts: Point[] = [{ at: T - 2 * H, used: 40, resetsAt: reset(48) }, { at: T, used: 50, resetsAt: reset(48) }];
  const f = forecast("weekly", pts, 10, T)!;
  assert.equal(f.perHour, 5);
  assert.equal(f.reachesReserveAt, new Date(T + 8 * H).toISOString(), "40 points left at 5 an hour");
  assert.equal(f.resetsFirst, false);
});

test("when the reset comes first, the window lasts until it", () => {
  const pts: Point[] = [{ at: T - H, used: 20, resetsAt: reset(2) }, { at: T, used: 22, resetsAt: reset(2) }];
  assert.deepEqual(forecast("5h", pts, 10, T), { window: "5h", perHour: 2, reachesReserveAt: null, resetsFirst: true, since: new Date(T - H).toISOString() });
});

test("no forecast from too little: one reading, readings too close, or only a previous period", () => {
  assert.equal(forecast("5h", [{ at: T, used: 20, resetsAt: reset(2) }], 10, T), null);
  assert.equal(forecast("5h", [{ at: T - 5 * MIN, used: 20, resetsAt: reset(2) }, { at: T, used: 30, resetsAt: reset(2) }], 10, T), null);
  // The window reset in between: the old period's readings say nothing about this one.
  assert.equal(forecast("5h", [{ at: T - 2 * H, used: 80, resetsAt: reset(-1) }, { at: T, used: 5, resetsAt: reset(4) }], 10, T), null);
  // Readings older than the pace span are left out.
  assert.equal(forecast("weekly", [{ at: T - 10 * H, used: 10, resetsAt: reset(48) }, { at: T, used: 30, resetsAt: reset(48) }], 10, T), null);
});

test("no rise, or already inside the reserve: no time to reach it", () => {
  const flat: Point[] = [{ at: T - H, used: 30, resetsAt: reset(5) }, { at: T, used: 30, resetsAt: reset(5) }];
  assert.deepEqual({ ...forecast("5h", flat, 10, T)!, since: "" }, { window: "5h", perHour: 0, reachesReserveAt: null, resetsFirst: true, since: "" });
  const inside: Point[] = [{ at: T - H, used: 85, resetsAt: reset(5) }, { at: T, used: 95, resetsAt: reset(5) }];
  assert.equal(forecast("5h", inside, 10, T)!.reachesReserveAt, null);
});

test("a reset is seen by its time (whatever the text) or, with none given, by a drop in use", () => {
  const sameTimeOtherText: Point[] = [{ at: T - H, used: 20, resetsAt: "2026-10-05T12:00:00Z" }, { at: T, used: 24, resetsAt: "2026-10-05T12:00:00.000Z" }];
  assert.equal(forecast("5h", sameTimeOtherText, 10, T)?.perHour, 4);
  const droppedWithoutTime: Point[] = [{ at: T - 3 * H, used: 80, resetsAt: null }, { at: T - 2 * H, used: 5, resetsAt: null }, { at: T, used: 15, resetsAt: null }];
  assert.equal(forecast("5h", droppedWithoutTime, 10, T)?.perHour, 5, "only the readings after the drop count");
});

test("a time already past is not shown as the future", () => {
  const stale: Point[] = [{ at: T - 5 * H, used: 40, resetsAt: reset(48) }, { at: T - 4 * H, used: 80, resetsAt: reset(48) }];
  assert.equal(forecast("weekly", stale, 10, T)?.reachesReserveAt, null);
});
