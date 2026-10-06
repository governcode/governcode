import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWatch, MARKS, mergeEvents, tally } from "../src/shared/watch.ts";
import { describe } from "../src/shared/trace.ts";

let seq = 0;
const ev = (kind: string, project: string | null, data: Record<string, unknown> = {}, actor = "govd", ts = "2026-10-05T10:00:00.000Z") =>
  ({ seq: ++seq, ts, kind, project, actor, data });
const now = new Date("2026-10-05T12:00:00.000Z");

test("a Controller turn is watched from its start until it ends, with its latest step", () => {
  const events = [
    ev("turn.started", "a", { prompt: "Add pagination", controller: { provider: "claude-code" } }, "user"),
    ev("turn.tool", "a", { name: "Read" }, "controller · claude-code"),
    ev("turn.text", "a", { text: "Codex will write it." }, "controller · claude-code"),
    ev("turn.started", "b", { prompt: "Done already", controller: { provider: "codex" } }, "user"),
    ev("turn.completed", "b", { summary: "ok" }),
  ];
  const w = buildWatch(events, [], now);
  assert.deepEqual(w.turns, [{ project: "a", provider: "claude-code", prompt: "Add pagination", origin: null, since: events[0].ts, lastStep: "“Codex will write it.”" }]);
});

test("Runners at work come from the Specs, with when they started and their latest step", () => {
  const events = [ev("spec.started", "a", { spec: "S-1" }, "govd", "2026-10-05T11:00:00.000Z"), ev("spec.step", "a", { spec: "S-1", name: "apply_patch x.ts" })];
  const specs = [{ id: "S-1", project: "a", status: "running", to: "grok", brief: "Rate limiter" }, { id: "S-2", project: "a", status: "accepted", to: "codex", brief: "Old" }];
  assert.deepEqual(buildWatch(events, specs, now).runners, [{ id: "S-1", project: "a", to: "grok", brief: "Rate limiter", status: "running", since: "2026-10-05T11:00:00.000Z", lastStep: "apply_patch x.ts" }]);
});

test("today counts only today's events, and only your own answers as yours", () => {
  const events = [
    ev("turn.started", "a", {}, "user"), ev("spec.done", "a", { spec: "S-1" }),
    ev("gate.allowed", "a", { gate: "G-1", tool: "Bash", by: "user" }, "user"),
    ev("gate.denied", "a", { gate: "G-2", tool: "Bash", by: "nobody answered within the hour" }, "user"),
    ev("gate.allowed", "a", { tool: "Read", by: "quiet read" }),
    ev("turn.started", "a", {}, "user", "2026-10-04T10:00:00.000Z"),
  ];
  assert.deepEqual(buildWatch(events, [], now).today, { turns: 1, specsFinished: 1, answeredByYou: 1, letThrough: 1 });
});

test("the moment-to-moment events read as sentences too", () => {
  assert.equal(describe(ev("turn.text", "a", { text: "Codex will   write it." }, "controller · claude-code")).text, "controller · claude-code: “Codex will write it.”");
  assert.equal(describe(ev("spec.step", "a", { spec: "S-1", name: "apply_patch x.ts" })).text, "S-1 · apply_patch x.ts");
  assert.equal(describe(ev("turn.tool", "a", { name: "Task", subagent: "find the tests" }, "controller · claude-code")).text, "controller · claude-code started a subagent: “find the tests”");
});

test("a long turn stays on Watch when its start is older than the feed: the marks are kept apart", () => {
  const start = ev("turn.started", "a", { prompt: "Long one", controller: { provider: "claude-code" } }, "user");
  const steps = Array.from({ length: 700 }, () => ev("turn.tool", "a", { name: "Bash" }, "controller · claude-code"));
  const feed = steps.slice(-600);   // what the feed still holds: the start has gone
  assert.equal(buildWatch(feed, [], now).turns.length, 0, "the feed alone loses it");
  const marks = [start].filter((e) => MARKS.includes(e.kind));
  const w = buildWatch(mergeEvents(marks, feed), [], now);
  assert.deepEqual(w.turns.map((t) => [t.prompt, t.lastStep]), [["Long one", "Bash"]]);
  assert.equal(mergeEvents(feed, feed).length, 600, "each event once");
});

test("today: govd's totals, plus what arrives after them, never counted twice", () => {
  const base = { turns: 40, specsFinished: 3, answeredByYou: 7, letThrough: 900 };
  const later = [ev("turn.started", "a", {}, "user"), ev("gate.allowed", "a", { tool: "Read", by: "quiet read" }), ev("turn.started", "a", {}, "user", "2026-10-04T23:00:00.000Z")];
  assert.deepEqual(tally(later, now, base), { turns: 41, specsFinished: 3, answeredByYou: 7, letThrough: 901 });
  assert.deepEqual(base.turns, 40, "the base itself is left alone");
});

import { applyLiveEvent, combineTotals, type WatchState } from "../src/shared/watch.ts";

test("live logic: a live event before the initial load reply is kept", () => {
  let state: WatchState = { events: [], marks: [], live: [], totals: null };
  const e1 = ev("turn.started", "a");
  state = applyLiveEvent(state, e1, 600, now);
  // initial load arrives now (say with the same event and some others)
  const e0 = ev("spec.done", "a");
  e0.seq = e1.seq - 1; // e0 is older
  state.events = mergeEvents([e0, e1], state.events).slice(-600);
  assert.equal(state.events.length, 2);
  assert.equal(state.live.length, 1);
});

test("live logic: the totals reply arriving after some live events", () => {
  let state: WatchState = { events: [], marks: [], live: [], totals: null };
  const e1 = ev("turn.started", "a", {}, "user");
  const e2 = ev("turn.started", "a", {}, "user");
  e1.seq = 100;
  e2.seq = 105;
  state = applyLiveEvent(state, e1, 600, now);
  state = applyLiveEvent(state, e2, 600, now);

  // totals reply arrives up to seq 102
  const reply = { today: { turns: 10, specsFinished: 0, answeredByYou: 0, letThrough: 0 }, seq: 102 };
  state = combineTotals(state, reply, now);

  // totals should include e2 (turn.started) but not e1 (since e1.seq <= 102)
  assert.deepEqual(state.totals?.today, { turns: 11, specsFinished: 0, answeredByYou: 0, letThrough: 0 });
  assert.equal(state.totals?.seq, 105);
});

test("live logic: a live event with seq <= totals.seq is not counted again", () => {
  let state: WatchState = { events: [], marks: [], live: [], totals: { today: { turns: 10, specsFinished: 0, answeredByYou: 0, letThrough: 0 }, seq: 100 } };
  const e = ev("turn.started", "a", {}, "user");
  e.seq = 99; // arrived late, already in totals
  state = applyLiveEvent(state, e, 600, now);
  assert.equal(state.totals?.today.turns, 10); // not counted
});

test("live logic: the same event delivered twice", () => {
  let state: WatchState = { events: [], marks: [], live: [], totals: { today: { turns: 0, specsFinished: 0, answeredByYou: 0, letThrough: 0 }, seq: 100 } };
  const e = ev("turn.started", "a", {}, "user");
  e.seq = 101;
  state = applyLiveEvent(state, e, 600, now);
  assert.equal(state.totals?.today.turns, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.marks.length, 1);

  // deliver again
  state = applyLiveEvent(state, e, 600, now);
  assert.equal(state.totals?.today.turns, 1, "totals should not increment on identical seq");
  assert.equal(state.events.length, 1, "events should not duplicate");
  assert.equal(state.marks.length, 1, "marks should not duplicate");
});

test("live logic: the marks and feed caps", () => {
  let state: WatchState = { events: [], marks: [], live: [], totals: null };
  for (let i = 0; i < 605; i++) {
    state = applyLiveEvent(state, ev("turn.started", "a"), 600, now);
  }
  assert.equal(state.events.length, 600);
  assert.equal(state.marks.length, 600);
  assert.equal(state.live.length, 600);
});

test("live logic: a day change starts counting again from zero for the new day", () => {
  let state: WatchState = { events: [], marks: [], live: [], totals: { today: { turns: 10, specsFinished: 0, answeredByYou: 0, letThrough: 0 }, seq: 100 } };

  // day turns (Watch.tsx sets totals to null)
  state = { ...state, totals: null };
  const nextDay = new Date("2026-10-06T00:00:01.000Z");

  // a live event arrives before totals reply
  const e1 = ev("turn.started", "a", {}, "user", nextDay.toISOString());
  e1.seq = 101;
  state = applyLiveEvent(state, e1, 600, nextDay);

  // new day's totals reply arrives
  const reply = { today: { turns: 0, specsFinished: 0, answeredByYou: 0, letThrough: 0 }, seq: 100 };
  state = combineTotals(state, reply, nextDay);

  assert.equal(state.totals?.today.turns, 1, "previous day's turns should be reset");
  assert.equal(state.totals?.seq, 101);
});

test("live logic: a late event stamped yesterday neither counts nor clears today's totals", () => {
  const now = new Date(2026, 9, 6, 0, 0, 5);   // (local time: Today follows the user's clock)
  let state: WatchState = { events: [], marks: [], live: [], totals: { today: { turns: 3, specsFinished: 1, answeredByYou: 0, letThrough: 0 }, seq: 200 } };
  const late = ev("turn.started", "a", {}, "user", new Date(2026, 9, 5, 23, 59, 59).toISOString());
  late.seq = 201;
  state = applyLiveEvent(state, late, 600, now);
  assert.deepEqual(state.totals?.today, { turns: 3, specsFinished: 1, answeredByYou: 0, letThrough: 0 });
  assert.equal(state.totals?.seq, 201, "counted up to it, so it is not counted again");
});

test("live logic: the same event twice before govd's count is in is counted once", () => {
  const now = new Date();
  let state: WatchState = { events: [], marks: [], live: [], totals: null };
  const e = ev("turn.started", "a", {}, "user", now.toISOString());
  e.seq = 101;
  state = applyLiveEvent(state, e, 600, now);
  state = applyLiveEvent(state, e, 600, now);
  state = combineTotals(state, { today: { turns: 0, specsFinished: 0, answeredByYou: 0, letThrough: 0 }, seq: 100 }, now);
  assert.equal(state.totals?.today.turns, 1);
  assert.equal(state.live.length, 1);
});
