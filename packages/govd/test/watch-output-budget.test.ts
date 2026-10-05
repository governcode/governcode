// Pure-memory regression coverage of the user connection's actual serve/watch/write path.
// Held Duplex callbacks create Node writableLength backpressure; no socket is listened on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { registerHooks } from "node:module";
import type { Socket } from "node:net";
import { PROTOCOL, Settings, type TraceEvent } from "@governcode/protocol";
import { Ledger } from "../src/ledger.ts";
import * as delegation from "../src/delegate.ts";
import { recoveryStates } from "../src/recovery.ts";
import { setCrew } from "../src/crew.ts";

import { Daemon } from "../src/daemon.ts";
const LIMIT = 1024 * 1024;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const hello = { client: "test", protocol: PROTOCOL };
const rpcLine = (id: number, method: string, params: unknown = method === "hello" ? hello : {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
const eventLine = (event: TraceEvent) => JSON.stringify({ jsonrpc: "2.0", method: "event", params: { kind: "trace", event } }) + "\n";

class ControlledSocket extends Duplex {
  admitted: string[] = [];
  results: boolean[] = [];
  destroyCalls = 0;
  private held: Array<() => void> = [];
  private closeCallback?: (error?: Error | null) => void;
  private stalled: boolean;
  constructor(stalled = true) { super({ writableHighWaterMark: 64, autoDestroy: false }); this.stalled = stalled; }
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    if (this.stalled) this.held.push(callback); else callback();
  }
  override write(chunk: any, encoding?: any, callback?: any): boolean {
    this.admitted.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    const result = super.write(chunk, encoding, callback);
    this.results.push(result);
    return result;
  }
  override destroy(error?: Error): this { this.destroyCalls++; return super.destroy(error); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // Destruction changes writable immediately but close deliberately waits for the test.
    this.closeCallback = () => callback(error);
  }
  release(): void { this.stalled = false; while (this.held.length) this.held.shift()!(); }
  finishClose(): void { const callback = this.closeCallback; this.closeCallback = undefined; callback?.(); }
  input(line: string): void { this.push(line); }
  messages(): any[] { return this.admitted.map((line) => JSON.parse(line)); }
}

function harness(t: { after(fn: () => void | Promise<void>): void }, prototype = Daemon.prototype, actualAsk = false) {
  const ledger = new Ledger(":memory:");
  // The constructor opens state files. Initialize only the connection and guard dependencies.
  const d: any = Object.assign(Object.create(prototype), {
    ledger, sockets: new Set(), watchers: new Map(), gates: new Map(), plans: new Map(),
    turnPlans: new Map(), wakeTurns: new Map(), recoveryRuns: new Map(), runs: new delegation.SpecRuns(),
    turning: new Map(), telling: new Map(), noWake: new Set(), waking: new Map(),
    recoveryBusy: false, stopping: false, closed: false, sandboxOk: true, sandboxReason: "test",
    allows: { list: () => [], endTurn() {} },
    opts: { version: "test", ledgerPath: "/inert/state/ledger", socketPath: "/inert/socket", supervisor: "inert", policyDir: "/inert/policy" },
  });
  d.settings = () => Settings.parse({});
  // Recorded wake starts do nothing. Recovery uses real resume preflight and measurement,
  // with an in-memory Limit stub that records attempted admission and always holds before
  // workspace preparation. No provider, state file or workspace can be reached.
  const wakeStarts: unknown[][] = [], recoveryStarts: string[] = [];
  if (!actualAsk) d.ask = async (...args: unknown[]) => { wakeStarts.push(args); return {}; };
  d.recoveryContext = () => ({ ledger, runs: d.runs, project: ledger.project("p"), settings: d.settings,
    usage: { codex: { read: async () => null } },
    limits: { forget: () => {}, admit: (id: string) => {
      recoveryStarts.push(id);
      return { ok: false, provider: "codex", reason: "test-only hold", resetsAt: null };
    } },
  });
  const sockets: ControlledSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) { if (!socket.destroyed) socket.destroy(); socket.finishClose(); }
    await tick(); // consume watch's already-queued sweep before closing the in-memory Trace
    ledger.close();
  });
  const connect = async (watch: boolean | "default" | null = false, stalled = true) => {
    const socket = new ControlledSocket(stalled); sockets.push(socket);
    d.serve(socket as unknown as Socket);
    await tick();
    if (watch !== null) {
      socket.input(rpcLine(1, "watch", watch === "default" ? {} : { wake: watch }));
      await tick();
      assert.deepEqual(socket.messages()[0], { jsonrpc: "2.0", id: 1, result: { ok: true } });
    }
    return socket;
  };
  return { d, ledger, connect, wakeStarts, recoveryStarts };
}

function trace(ledger: Ledger, text = "record"): TraceEvent { return ledger.append("p", "turn.text", "user", { text }); }
function fill(ledger: Ledger, socket: ControlledSocket, remaining = 0): TraceEvent {
  // Fixed-length timestamp/seq envelope is known from an actual previous append.
  const prior = trace(ledger, "");
  const next = { ...prior, seq: prior.seq + 1, data: { text: "" } };
  const bytes = LIMIT - socket.writableLength - Buffer.byteLength(eventLine(next), "utf8") - remaining;
  assert.ok(bytes >= 0);
  return trace(ledger, "x".repeat(bytes));
}
function gate(d: any, id: string, turn: string, owner: ControlledSocket | null = null, spec?: string, answer = (_a: string) => {}) {
  d.gates.set(id, { id, project: "p", tool: "test", canonical: "{}", opened: "2026-01-01T00:00:00.000Z",
    owner, answer, kinds: [], scopes: [], ctx: { project: "p", turn, ...(spec ? { spec } : {}) } });
}
function work(d: any) {
  const wakeAbort = new AbortController();
  let wakeStops = 0, runStops = 0;
  d.wakeTurns.set("T-wake", () => { wakeStops++; wakeAbort.abort("nobody is connected"); });
  const signals = new Map<string, AbortSignal>();
  const controllers = new Map<string, AbortController>();
  const resolves: Array<(r: delegation.SpecResult) => void> = [];
  for (const id of ["S-recovery", "S-user"]) {
    void d.runs.start(id, "p", "codex", (stop: AbortController) => {
      signals.set(id, stop.signal);
      controllers.set(id, stop);
      return new Promise<delegation.SpecResult>((resolve) => resolves.push(resolve));
    });
  }
  controllers.get("S-recovery")!.signal.addEventListener("abort", () => runStops++);
  d.recoveryRuns.set("S-recovery", { resetsAt: "2026-01-01T00:00:00.000Z", stop: controllers.get("S-recovery") });
  return { wakeAbort, signals, counts: () => ({ wakeStops, runStops }), finish: () => {
    for (const resolve of resolves) resolve({ id: "test", status: "failed", runner: "codex", files: [], summary: "stopped", diff: "", review: "" });
  } };
}
function seedDue(ledger: Ledger) {
  ledger.addProject("p", "/example/project", "project.opened");
  setCrew(ledger, "p", { controllerWorks: true, handoff: "ask", subagents: { controller: false, runners: false }, wake: "auto", maxPercent: {}, runners: null });
  const input = { to: "codex" as const, brief: "test", result: "done", scope: { read: [], write: [] }, budgetPercent: 5,
    workspace: "worktree" as const, model: "", effort: null, reason: "test", mode: "async" as const, waitSeconds: 600 };
  const pending = ledger.createSpec("p", input, "controller · claude-code");
  ledger.updateSpec(pending.id, { status: "needs-review", delivery: "pending" }, "govd");
  const limited = ledger.createSpec("p", input, "user");
  const resetsAt = "2020-01-01T00:00:00.000Z";
  ledger.updateSpec(limited.id, { status: "held", limited: { resetsAt, at: "2020-01-02T00:00:00.000Z", why: "test limit" } }, "govd");
  ledger.append("p", "recovery.set", "user", { target: limited.id, resetsAt, atReset: true });
  assert.equal(recoveryStates(ledger)[0].item.due, true);
  return limited.id;
}

test("exact UTF-8 JSON-RPC line ceiling is admitted; the next line is wholly refused", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect();
  const prior = trace(ledger, "");
  const blank = { ...prior, seq: prior.seq + 1, data: { text: "" } };
  const room = LIMIT - socket.writableLength - Buffer.byteLength(eventLine(blank), "utf8");
  const text = "é".repeat(Math.floor(room / 2)) + "x".repeat(room % 2);
  assert.ok(text.length < Buffer.byteLength(text));
  const event = trace(ledger, text);
  assert.equal(socket.admitted.at(-1), eventLine(event));
  assert.equal(socket.writableLength, LIMIT);
  assert.equal(socket.destroyCalls, 0);
  const admitted = socket.admitted.length; const refused = trace(ledger, "next");
  assert.equal(socket.admitted.length, admitted, "overflow must not call socket.write");
  assert.equal(socket.destroyCalls, 1); assert.equal(d.watchers.size, 0);
  assert.equal(ledger.events(undefined, 1)[0].seq, refused.seq);
});

test("a single oversized line is refused even with an empty Node queue", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect(false, false);
  assert.equal(socket.writableLength, 0); const admitted = socket.admitted.length;
  const event = trace(ledger, "界".repeat(Math.ceil(LIMIT / 3)));
  assert.ok(Buffer.byteLength(eventLine(event)) > LIMIT);
  assert.equal(socket.admitted.length, admitted); assert.equal(socket.destroyCalls, 1);
  assert.equal(d.watchers.size, 0); assert.equal(ledger.events(undefined, 1)[0].seq, event.seq);
});

test("write false below the ceiling retains watch; releasing callbacks permits later writes", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect();
  trace(ledger, "x".repeat(100));
  assert.equal(socket.results.at(-1), false); assert.ok(socket.writableLength < LIMIT);
  assert.equal(socket.destroyCalls, 0); assert.equal(d.watchers.size, 1);
  let drains = 0; socket.on("drain", () => drains++); socket.release(); await tick();
  assert.equal(socket.writableLength, 0); assert.equal(drains, 1);
  const event = trace(ledger, "after drain");
  assert.equal(socket.admitted.at(-1), eventLine(event)); assert.equal(socket.destroyCalls, 0);
});

test("watch RPC default wake, repeat registration, Trace, Gate refresh and ordinary reply share the writer", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect("default");
  assert.equal(d.someoneSeesWakes(), false, "public watch RPC defaults wake to false");
  socket.input(rpcLine(2, "watch", { wake: true })); await tick();
  assert.equal(d.watchers.size, 1); assert.equal(d.watchers.get(socket).wake, false);
  const before = socket.admitted.length; const event = trace(ledger); d.gatesChanged();
  socket.input(rpcLine(3, "hello")); await tick();
  assert.equal(socket.admitted[before], eventLine(event));
  assert.deepEqual(socket.messages()[before + 1], { jsonrpc: "2.0", method: "event", params: { kind: "gates" } });
  assert.equal(socket.messages()[before + 2].result.server, "govd");
  fill(ledger, socket); const count = socket.admitted.length;
  socket.input(rpcLine(4, "hello")); await tick();
  assert.equal(socket.admitted.length, count, "an ordinary reply cannot bypass the watch budget");
  assert.equal(socket.destroyCalls, 1);
});

test("Gate refresh admission counts its envelope and newline", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect();
  const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { kind: "gates" } }) + "\n";
  fill(ledger, socket, Buffer.byteLength(line)); d.gatesChanged();
  assert.equal(socket.writableLength, LIMIT); assert.equal(socket.admitted.at(-1), line);
  const count = socket.admitted.length; d.gatesChanged();
  assert.equal(socket.admitted.length, count); assert.equal(socket.destroyCalls, 1);
});

test("RPC errors and direct notifications on a watched socket cannot bypass admission", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect();
  const notify = d.watchers.get(socket).send;
  fill(ledger, socket); const count = socket.admitted.length;
  notify({ kind: "text", text: "direct" });
  assert.equal(socket.admitted.length, count); assert.equal(socket.destroyCalls, 1);
  const second = await connect(); fill(ledger, second); const secondCount = second.admitted.length;
  second.input(rpcLine(5, "unknown")); await tick();
  assert.equal(second.admitted.length, secondCount); assert.equal(second.destroyCalls, 1);
});

test("nonwatch connections preserve unbounded ordinary reply compatibility", async (t) => {
  const { d, connect } = harness(t); const socket = await connect(null);
  // A large request id is echoed in the existing hello response without watching.
  socket.input(JSON.stringify({ jsonrpc: "2.0", id: "i".repeat(LIMIT), method: "hello", params: hello }) + "\n"); await tick();
  assert.ok(socket.writableLength > LIMIT); assert.equal(socket.admitted.length, 1);
  assert.equal(socket.destroyCalls, 0); assert.equal(d.watchers.size, 0);
});

test("retirement is synchronous before delayed close; Trace persists and healthy watch still receives it", async (t) => {
  const { d, ledger, connect } = harness(t); const stalled = await connect(true); const healthy = await connect(true, false);
  fill(ledger, stalled); const callback = d.watchers.get(stalled).send; const count = stalled.admitted.length;
  let closes = 0; stalled.on("close", () => closes++); const refused = trace(ledger, "overflow");
  assert.equal(closes, 0); assert.equal(stalled.destroyCalls, 1); assert.equal(d.sockets.has(stalled), false);
  assert.equal(d.watchers.has(stalled), false); assert.equal(d.someoneSeesWakes(), true);
  assert.equal((ledger as any).listeners.size, 1);
  assert.ok(healthy.messages().some((m) => m.params?.event?.seq === refused.seq));
  trace(ledger, "later"); callback({ kind: "gates" });
  assert.equal(stalled.admitted.length, count);
  assert.equal(ledger.events(undefined, 2)[0].seq, refused.seq);
});

test("last wake viewer stops wake work and sweep-resumed Specs exactly once, preserving user Specs", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect(true); const running = work(d); t.after(running.finish);
  const answers: string[] = [];
  gate(d, "G-wake", "T-wake", null, undefined, (a) => answers.push(a));
  gate(d, "G-spec", "T-wake", null, "S-user");
  fill(ledger, socket); trace(ledger, "overflow");
  assert.equal(d.someoneSeesWakes(), false); assert.equal(running.wakeAbort.signal.reason, "nobody is connected");
  const reason = running.signals.get("S-recovery")!.reason;
  assert.equal(reason.limited.why, "stopped: nobody was connected to see it");
  assert.equal(reason.limited.resetsAt, "2026-01-01T00:00:00.000Z");
  assert.ok(Number.isFinite(Date.parse(reason.limited.at)));
  assert.equal(running.signals.get("S-user")!.aborted, false); assert.deepEqual(answers, ["deny"]);
  assert.equal(d.gates.has("G-spec"), true);
  assert.equal(ledger.eventsOfKind("p", ["gate.denied"])[0].data.by, "nobody is connected");
  socket.emit("error", new Error("test")); socket.finishClose(); await tick(); socket.emit("close");
  assert.deepEqual(running.counts(), { wakeStops: 1, runStops: 1 }); assert.equal(socket.destroyCalls, 1);
});

test("a healthy second wake watcher keeps unattended work; wake false only streams", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect(true); const healthy = await connect(true, false);
  const passive = await connect(false, false); const running = work(d); t.after(running.finish);
  fill(ledger, socket); trace(ledger, "overflow");
  assert.deepEqual(running.counts(), { wakeStops: 0, runStops: 0 });
  assert.equal(running.signals.get("S-recovery")!.aborted, false);
  healthy.destroy(); healthy.finishClose(); await tick();
  assert.equal(d.someoneSeesWakes(), false); assert.equal(d.watchers.has(passive), true);
  assert.deepEqual(running.counts(), { wakeStops: 1, runStops: 1 });
  const event = trace(ledger, "passive"); assert.equal(passive.admitted.at(-1), eventLine(event));
});

test("owner Gates and plans settle once with existing close reasons on overflow/error/close", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect(false);
  const answers: unknown[] = []; gate(d, "G-owner", "T-user", socket, undefined, (a) => answers.push(a));
  d.plans.set("GP-owner", { id: "GP-owner", project: "p", turn: "T-user", items: [], owner: socket, answer: (a: unknown) => answers.push(a) });
  fill(ledger, socket); trace(ledger, "overflow");
  assert.deepEqual(answers, ["deny", { answer: "reject", approved: [] }]);
  assert.equal(ledger.eventsOfKind("p", ["gate.denied"])[0].data.by, "asker left");
  assert.equal(ledger.eventsOfKind("p", ["plan.answered"])[0].data.by, "asker left");
  socket.emit("error", new Error("test")); socket.finishClose(); await tick(); socket.emit("close");
  assert.equal(answers.length, 2); assert.equal(socket.destroyCalls, 1);
});

test("reentrant denial cascades retire both watchers without repeated stop or subscription leaks", async (t) => {
  const { d, ledger, connect } = harness(t); const a = await connect(true); const b = await connect(true);
  const running = work(d); t.after(running.finish); let answers = 0;
  // Identical acknowledgments and fanout leave both queues with just one byte free.
  fill(ledger, a, 1); assert.equal(b.writableLength, LIMIT - 1);
  gate(d, "G-owner", "T-user", a, undefined, () => answers++);
  gate(d, "G-wake", "T-wake", null, undefined, () => answers++);
  const beforeA = a.admitted.length, beforeB = b.admitted.length;
  trace(ledger, "overflow");
  assert.equal(a.destroyCalls, 1); assert.equal(b.destroyCalls, 1);
  assert.equal(a.admitted.length, beforeA); assert.equal(b.admitted.length, beforeB);
  assert.equal(d.watchers.size, 0); assert.equal((ledger as any).listeners.size, 0);
  assert.deepEqual(running.counts(), { wakeStops: 1, runStops: 1 }); assert.equal(answers, 2);
  a.finishClose(); b.finishClose(); await tick();
  assert.deepEqual(running.counts(), { wakeStops: 1, runStops: 1 });
});

test("buffered line callbacks and stale watcher sends cannot revive a retired connection", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect(true);
  const stale = d.watchers.get(socket).send; fill(ledger, socket); const count = socket.admitted.length;
  // readline emits all buffered requests synchronously, before any async reply resumes.
  gate(d, "G-buffered", "T-user");
  socket.input(rpcLine(2, "gate.answer", { id: "G-buffered", answer: "deny" }) + rpcLine(3, "watch", { wake: true })); await tick();
  stale({ kind: "gates" }); d.watch(socket, stale, true); await tick();
  assert.equal(socket.admitted.length, count); assert.equal(d.watchers.size, 0);
  assert.equal((ledger as any).listeners.size, 0); assert.equal(socket.destroyCalls, 1);
});

test("queued wake completion and recovery sweep cannot start after last viewer retires", async (t) => {
  const { d, ledger, connect, wakeStarts, recoveryStarts } = harness(t); const socket = await connect(true);
  const due = seedDue(ledger); fill(ledger, socket);
  const recoveries = recoveryStarts.length;
  const queued = new Promise<void>((resolve) => setImmediate(() => { d.wakeIfDue("p"); void d.sweepRecovery().then(resolve); }));
  trace(ledger, "overflow"); await queued;
  assert.deepEqual({ wakeStarts: wakeStarts.length, recoveryStarts: recoveryStarts.length - recoveries },
    { wakeStarts: 0, recoveryStarts: 0 });
  assert.equal(recoveryStates(ledger).find((s) => s.item.target === due)!.item.due, true);
});

test("guard controls: healthy wake watch can reach recorded starts; wake false cannot", async (t) => {
  const { d, ledger, connect, wakeStarts, recoveryStarts } = harness(t); const passive = await connect(false, false);
  const due = seedDue(ledger); const recoveries = recoveryStarts.length;
  d.wakeIfDue("p"); await d.sweepRecovery();
  assert.equal(wakeStarts.length, 0); assert.equal(recoveryStarts.length, recoveries);
  assert.equal(d.watchers.has(passive), true);
  await connect(true, false); // watch queues the actual sweep
  d.wakeIfDue("p"); await tick();
  assert.equal(wakeStarts.length, 1); assert.ok(recoveryStarts.slice(recoveries).includes(due));
});


test("watch acknowledgment refuses an already oversized nonwatch queue on registration", async (t) => {
  const { d, connect } = harness(t); const socket = await connect(null);
  socket.input(JSON.stringify({ jsonrpc: "2.0", id: "i".repeat(LIMIT), method: "hello", params: hello }) + "\n"); await tick();
  assert.equal(socket.admitted.length, 1); assert.ok(socket.writableLength > LIMIT);
  socket.input(rpcLine(2, "watch", { wake: true })); await tick();
  assert.equal(socket.admitted.length, 1); assert.equal(socket.destroyCalls, 1);
  assert.equal(d.watchers.size, 0); assert.equal((d.ledger as any).listeners.size, 0);
});

for (const trigger of ["error", "close"] as const) {
  test(`normal ${trigger} retires once and cannot leave an unattended close-event gap`, async (t) => {
    const { d, ledger, connect } = harness(t); const socket = await connect(true);
    const running = work(d); t.after(running.finish); let answers = 0;
    gate(d, "G-wake", "T-wake", null, undefined, () => answers++);
    gate(d, "G-owner", "T-user", socket, undefined, () => answers++);
    if (trigger === "error") socket.emit("error", new Error("test"));
    else { socket.destroy(); socket.finishClose(); await tick(); }
    assert.equal(d.watchers.size, 0); assert.equal(d.sockets.size, 0);
    assert.equal((ledger as any).listeners.size, 0); assert.equal(d.someoneSeesWakes(), false);
    assert.deepEqual(running.counts(), { wakeStops: 1, runStops: 1 }); assert.equal(answers, 2);
    socket.emit("error", new Error("test")); socket.finishClose(); await tick(); socket.emit("close");
    assert.equal(socket.destroyCalls, 1); assert.equal(answers, 2);
    assert.deepEqual(running.counts(), { wakeStops: 1, runStops: 1 });
  });
}

test("Gate refresh fanout can cascade through a reentrant owner denial without duplicate cleanup", async (t) => {
  const { d, ledger, connect } = harness(t); const a = await connect(true); const b = await connect(true);
  const running = work(d); t.after(running.finish);
  fill(ledger, a, 1); assert.equal(b.writableLength, LIMIT - 1);
  let answers = 0;
  gate(d, "G-owner", "T-user", a, undefined, () => answers++);
  gate(d, "G-wake", "T-wake", null, undefined, () => answers++);
  const countA = a.admitted.length, countB = b.admitted.length;
  d.gatesChanged();
  assert.equal(a.admitted.length, countA); assert.equal(b.admitted.length, countB);
  assert.equal(a.destroyCalls, 1); assert.equal(b.destroyCalls, 1);
  assert.equal(d.watchers.size, 0); assert.equal((ledger as any).listeners.size, 0);
  assert.deepEqual(running.counts(), { wakeStops: 1, runStops: 1 }); assert.equal(answers, 2);
});

test("a Gate refresh that exceeds the queue by only its newline byte is wholly refused", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect();
  const line = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { kind: "gates" } }) + "\n";
  fill(ledger, socket, Buffer.byteLength(line) - 1);
  const count = socket.admitted.length; d.gatesChanged();
  assert.equal(socket.admitted.length, count); assert.equal(socket.destroyCalls, 1);
  assert.equal(d.watchers.size, 0);
});

test("the common writer serializes a direct notification once, including on refusal", async (t) => {
  const { d, ledger, connect } = harness(t); const socket = await connect();
  const send = d.watchers.get(socket).send; let serializations = 0;
  const notification = { toJSON: () => { serializations++; return { kind: "text", text: "once" }; } };
  send(notification);
  assert.equal(serializations, 1);
  assert.deepEqual(socket.messages().at(-1), { jsonrpc: "2.0", method: "event", params: { kind: "text", text: "once" } });
  fill(ledger, socket); const count = socket.admitted.length; send(notification);
  assert.equal(serializations, 2); assert.equal(socket.admitted.length, count); assert.equal(socket.destroyCalls, 1);
});

// A query import isolates only this daemon's runtime imports. The ordinary daemon and all
// existing writer tests keep their real modules. Hooks return in-memory module source;
// no module-mock flag, provider, runtime files, subprocess or listening socket is needed.
let startupImport = 0;
async function startupHarness(t: { after(fn: () => void | Promise<void>): void }, provider: "claude-code" | "codex") {
  const id = ++startupImport;
  const daemonURL = new URL(`../src/daemon.ts?watch-startup=${id}`, import.meta.url).href;
  const bridgeKey = `watch-startup-${id}`;
  const runtime: string[] = [], drivers: any[] = [];
  let onStart = (_o: any) => {};
  const bridge = {
    connected: () => true,
    guard: () => { runtime.push("gitGuard"); return { restore: () => { runtime.push("restore"); return []; } }; },
    files: () => { runtime.push("projectFiles"); return []; },
    store: () => { runtime.push("turnStore"); return {}; },
    snapshot: () => { runtime.push("snapshot"); return "inert-snapshot"; },
    changed: () => [],
    socket: (o: any) => { runtime.push("controllerSocket"); drivers.push({ context: o }); return { path: "inert-not-listened", close: () => runtime.push("close") }; },
    homeSocket: () => { throw new Error("unexpected Home socket"); },
    claude: (o: any) => {
      const driver = { options: o, cancellations: 0, cancel: () => {
        driver.cancellations++; o.hooks.done({ ok: false, summary: "inert cancellation" });
        o.hooks.done({ ok: false, summary: "duplicate completion" });
      } };
      drivers.push(driver); runtime.push("driver"); onStart(o); return driver;
    },
    codex: async (o: any) => {
      const driver = { options: o, cancellations: 0 };
      drivers.push(driver); runtime.push("driver");
      const cancel = () => { driver.cancellations++; o.hooks.done({ ok: false, summary: "inert cancellation" });
        o.hooks.done({ ok: false, summary: "duplicate completion" }); };
      if (o.signal.aborted) cancel(); else o.signal.addEventListener("abort", cancel, { once: true });
      onStart(o);
    },
  };
  const globals = globalThis as any;
  globals[bridgeKey] = bridge;
  const replacements: Record<string, string> = {
    "./homes.ts": "export const isConnected = b.connected;",
    "./gitguard.ts": "export const gitGuard = b.guard;",
    "./specstore.ts": "export const projectFiles = b.files, turnStore = b.store, snapshot = b.snapshot, changedFiles = b.changed;",
    "./delegate.ts": "export const openControllerSocket = b.socket, openTurnSocket = b.homeSocket;",
    "./claude.ts": "export const runTurn = b.claude;",
    "./codex.ts": "export const runCodexTurn = b.codex;",
  };
  const sources = new Map<string, string>();
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === daemonURL && specifier in replacements) {
        const original = new URL(specifier, daemonURL).href;
        const url = `${original}?watch-inert=${id}`;
        sources.set(url, `export * from ${JSON.stringify(original)}; const b = globalThis[${JSON.stringify(bridgeKey)}]; ${replacements[specifier]}`);
        return { url, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      const source = sources.get(url);
      return source === undefined ? next(url, context) : { format: "module", source, shortCircuit: true };
    },
  });
  let isolated: typeof Daemon;
  try { isolated = (await import(daemonURL)).Daemon; } finally { hooks.deregister(); delete globals[bridgeKey]; }
  let cleanup = () => {};
  t.after(() => cleanup());
  const h = harness(t, isolated.prototype, true);
  h.ledger.addProject("p", "/inert/project", "project.opened");
  h.ledger.setController("p", { provider, model: provider === "codex" ? "" : "opus", effort: "high" });
  setCrew(h.ledger, "p", { controllerWorks: true, handoff: "ask", subagents: { controller: false, runners: false }, wake: "auto", maxPercent: {}, runners: null });
  const spec = h.ledger.createSpec("p", { to: "codex", brief: "test", result: "done", scope: { read: [], write: [] }, budgetPercent: 5,
    workspace: "worktree", model: "", effort: null, reason: "test", mode: "async", waitSeconds: 600 }, `controller · ${provider}`);
  h.ledger.updateSpec(spec.id, { status: "needs-review", delivery: "pending" }, "govd");
  // Always consume a started inert driver, including when a baseline assertion fails.
  cleanup = () => { h.d.stopping = true; for (const driver of drivers) driver.options?.hooks.done({ ok: false, summary: "test teardown" }); };
  return { ...h, runtime, drivers, spec, onStart: (fn: (o: any) => void) => { onStart = fn; } };
}

function settledStartup(h: Awaited<ReturnType<typeof startupHarness>>, ok = false) {
  const starts = h.ledger.eventsOfKind("p", ["turn.started"]);
  const ends = h.ledger.eventsOfKind("p", ["turn.completed", "turn.failed"]);
  assert.equal(starts.length, 1); assert.equal(ends.length, 1, "the actual turn ends once");
  assert.equal(ends[0].data.turn, `T-${starts[0].seq}`, "completion belongs to the returned turn.started row");
  assert.equal(ends[0].kind, ok ? "turn.completed" : "turn.failed");
  assert.equal(h.d.turning.get("p") ?? 0, 0);
  for (const name of ["waking", "wakeTurns", "telling", "turnPlans", "gates", "plans"]) assert.equal(h.d[name].size, 0, name);
  assert.equal(h.ledger.spec(h.spec.id)!.delivery, ok ? "delivered" : "pending");
  if (!ok) assert.equal(h.d.noWake.has(h.spec.id), true, "failed delivery waits for the user's next message");
}

for (const provider of ["claude-code", "codex"] as const) {
  test(`actual ${provider} wake ask refuses runtime after last viewer overflows during turn.started`, async (t) => {
    const h = await startupHarness(t, provider); const socket = await h.connect(true);
    fill(h.ledger, socket); h.d.wakeIfDue("p"); await tick();
    assert.deepEqual(h.runtime, [], "no git guard, Checkpoint, socket or driver admission");
    assert.equal(socket.destroyCalls, 1); settledStartup(h);
    await h.connect(true, false); h.d.wakeIfDue("p"); await tick();
    assert.deepEqual(h.runtime, [], "a new viewer does not automatically retry failed delivery");
  });

  test(`actual ${provider} wake keeps a healthy second viewer and stable turn ID through reentrant denial`, async (t) => {
    const h = await startupHarness(t, provider); const stalled = await h.connect(true); await h.connect(true, false);
    // Retiring the stalled viewer denies its owned Gate inside turn.started fanout.
    gate(h.d, "G-start", "T-user", stalled);
    fill(h.ledger, stalled); h.d.wakeIfDue("p"); await tick();
    const start = h.ledger.eventsOfKind("p", ["turn.started"])[0];
    assert.ok(h.ledger.eventsOfKind("p", ["gate.denied"])[0].seq > start.seq);
    assert.equal(h.drivers.filter((x) => x.options).length, 1);
    assert.equal(h.drivers[0].context.turn, `T-${start.seq}`);
    assert.equal(h.d.wakeTurns.has(`T-${start.seq}`), true);
    assert.equal(h.d.telling.has(`T-${start.seq}`), true);
    assert.equal(h.ledger.spec(h.spec.id)!.delivery, "claimed");
    const driver = h.drivers.find((x) => x.options);
    if (provider === "codex") assert.equal(driver.options.signal.aborted, false);
    h.d.stopping = true; driver.options.hooks.done({ ok: true, summary: "inert report" });
    driver.options.hooks.done({ ok: true, summary: "duplicate" }); settledStartup(h, true);
  });

  for (const seam of ["recovery.resumed", "turn.started"] as const) test(`actual ${provider} automatic continuation retires during ${seam} without runtime admission`, async (t) => {
    const h = await startupHarness(t, provider); const socket = await h.connect(true);
    const old = h.ledger.append("p", "turn.started", "user", { prompt: "continue", controller: h.ledger.project("p")!.controller });
    const target = `T-${old.seq}`;
    h.ledger.append("p", "turn.failed", `controller · ${provider}`, { turn: target, summary: "limited", limit: { provider, resetsAt: "2020-01-01T00:00:00.000Z" } });
    h.ledger.append("p", "recovery.set", "user", { target, resetsAt: "2020-01-01T00:00:00.000Z", atReset: true });
    // Independent of same-ms projection: real ask still validates the saved continuation.
    assert.equal(h.d.recoveryTarget(target, "p").item.kind, "turn");
    if (seam === "recovery.resumed") fill(h.ledger, socket);
    else t.after(h.ledger.subscribe((e) => { if (e.kind === "recovery.resumed") fill(h.ledger, socket); }));
    const completion = h.d.ask("p", "continue", () => {}, null, { continuation: target, automatic: true });
    await tick();
    assert.deepEqual(h.runtime, []);
    await completion; assert.equal(socket.destroyCalls, 1);
    assert.equal(h.ledger.eventsOfKind("p", ["recovery.resumed"]).length, 1);
    const newStart = h.ledger.eventsOfKind("p", ["turn.started"]).at(-1)!;
    const end = h.ledger.eventsOfKind("p", ["turn.failed"]).at(-1)!;
    assert.equal(end.data.turn, `T-${newStart.seq}`); assert.equal(newStart.data.continuationOf, target);
    for (const name of ["waking", "wakeTurns", "telling", "turnPlans", "gates", "plans"]) assert.equal(h.d[name].size, 0);
    assert.equal(h.d.turning.get("p") ?? 0, 0);
  });

  for (const seam of ["turn.started", "claimed"] as const) test(`actual ${provider} ${seam} reentrancy cannot admit an aborted wake even if a new viewer appears`, async (t) => {
    const h = await startupHarness(t, provider); const socket = await h.connect(true); const replacement = await h.connect(null, false);
    // Delivery-only updateSpec does not append today. Preserve its real mutation and inject
    // a synchronous Gate refresh at that exact claim seam, through the actual common writer.
    if (seam === "turn.started") {
      fill(h.ledger, socket);
      t.after(h.ledger.subscribe((e) => { if (e.kind === "turn.started") h.d.watch(replacement, () => {}, true); }));
    }
    const update = h.ledger.updateSpec.bind(h.ledger);
    h.ledger.updateSpec = (id, change, actor) => {
      const result = update(id, change, actor);
      if (seam === "claimed" && change.delivery === "claimed") {
        fill(h.ledger, socket); h.d.gatesChanged();
        h.d.watch(replacement, () => {}, true);
      }
      return result;
    };
    h.d.wakeIfDue("p"); await tick();
    assert.equal(h.d.someoneSeesWakes(), true); assert.equal(socket.destroyCalls, 1);
    assert.deepEqual(h.runtime, []); settledStartup(h);
  });

  test(`actual ${provider} synchronous driver Trace retirement cancels promptly and completes once`, async (t) => {
    const h = await startupHarness(t, provider); const socket = await h.connect(true);
    h.onStart((o) => { fill(h.ledger, socket); o.hooks.text("driver startup notice"); });
    h.d.wakeIfDue("p"); await tick();
    const driver = h.drivers.find((x) => x.options);
    assert.ok(driver); assert.equal(socket.destroyCalls, 1);
    assert.equal(driver.cancellations, 1, "abort while runTurn returns cannot be missed");
    if (provider === "codex") assert.equal(driver.options.signal.aborted, true);
    assert.equal(h.runtime.filter((x) => x === "close").length, 1);
    settledStartup(h);
  });

  test(`actual ${provider} user ask remains admitted when its watching socket retires`, async (t) => {
    const h = await startupHarness(t, provider); const socket = await h.connect(false);
    gate(h.d, "G-user-start", "T-user", socket);
    fill(h.ledger, socket); const completion = h.d.ask("p", "user request", () => {}, socket);
    assert.equal(socket.destroyCalls, 1); const driver = h.drivers.find((x) => x.options);
    assert.ok(driver); assert.equal(driver.cancellations, 0); assert.equal(h.d.wakeTurns.size, 0);
    if (provider === "codex") assert.equal(driver.options.signal.aborted, false);
    h.d.stopping = true; driver.options.hooks.done({ ok: true, summary: "user control" }); await completion;
    settledStartup(h, true);
  });

  test(`actual ${provider} passive viewer cannot authorize a wake`, async (t) => {
    const h = await startupHarness(t, provider); await h.connect(false, false);
    h.d.wakeIfDue("p"); await tick();
    assert.deepEqual(h.runtime, []); assert.equal(h.ledger.eventsOfKind("p", ["turn.started"]).length, 0);
    assert.throws(() => h.d.ask("p", "wake", () => {}, null, { wake: [h.spec.id] }), /nobody is connected/);
    assert.deepEqual(h.runtime, []);
    assert.equal(h.ledger.spec(h.spec.id)!.delivery, "pending");
  });
}

for (const provider of ["claude-code", "codex"] as const) {
  test(`actual ${provider} automatic continuation retains its turn identity with a healthy second viewer`, async (t) => {
    const h = await startupHarness(t, provider); const stalled = await h.connect(true); await h.connect(true, false);
    const old = h.ledger.append("p", "turn.started", "user", { prompt: "continue", controller: h.ledger.project("p")!.controller });
    const target = `T-${old.seq}`;
    h.ledger.append("p", "turn.failed", `controller · ${provider}`, { turn: target, summary: "limited", limit: { provider, resetsAt: "2020-01-01T00:00:00.000Z" } });
    h.ledger.append("p", "recovery.set", "user", { target, resetsAt: "2020-01-01T00:00:00.000Z", atReset: true });
    gate(h.d, "G-continuation-start", "T-user", stalled);
    fill(h.ledger, stalled);
    const completion = h.d.ask("p", "continue", () => {}, null, { continuation: target, automatic: true });
    assert.equal(stalled.destroyCalls, 1); const driver = h.drivers.find((x) => x.options);
    assert.ok(driver); assert.equal(driver.cancellations, 0);
    const started = h.ledger.eventsOfKind("p", ["turn.started"]).at(-1)!;
    assert.equal(h.drivers[0].context.turn, `T-${started.seq}`);
    assert.equal(started.data.continuationOf, target);
    assert.equal(h.d.wakeTurns.has(`T-${started.seq}`), true);
    if (provider === "codex") assert.equal(driver.options.signal.aborted, false);
    h.d.stopping = true; driver.options.hooks.done({ ok: true, summary: "inert continuation control" }); await completion;
    assert.equal(h.ledger.eventsOfKind("p", ["turn.completed"]).length, 1);
    assert.equal(h.ledger.eventsOfKind("p", ["turn.completed"])[0].data.turn, `T-${started.seq}`);
    for (const name of ["waking", "wakeTurns", "telling", "turnPlans", "gates", "plans"]) assert.equal(h.d[name].size, 0);
  });
}


// Exercise the admitted recovery path itself: resumeSpec -> startRound -> runRound.
// Only runtime adapters are inert. Empty scope/placeholder lists cannot touch a file;
// delegate's filesystem and socket imports also fail closed if unexpectedly reached.
let recoveryImport = 0;
const RESET = "2020-01-01T00:00:00.000Z";
const STOPPED_UNOBSERVED = "stopped: nobody was connected to see it";
const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
async function admittedRecoveryHarness(t: { after(fn: () => void | Promise<void>): void }) {
  const id = ++recoveryImport;
  const daemonURL = new URL(`../src/daemon.ts?watch-recovery=${id}`, import.meta.url).href;
  const delegateURL = new URL(`../src/delegate.ts?watch-recovery=${id}`, import.meta.url).href;
  const key = `watch-recovery-${id}`;
  const runtime: string[] = [], drivers: any[] = [], counts: string[] = [], stops: any[] = [];
  const reservations = new Set<string>(), counted = new Set<string>();
  let workspaceError = false, partial = false, immediate = false;
  let read = async (): Promise<null> => null;
  let verdict: any = { ok: true, provider: "codex" };
  let observe = () => ({});
  const unexpected = () => { throw new Error("unexpected runtime I/O in memory test"); };
  const bridge = {
    unexpected,
    paths: () => ({ root: "inert", work: "inert/work", store: "inert/store" }),
    commit: () => { runtime.push("hasCommit"); return true; },
    workspace: () => { runtime.push("workspace"); if (workspaceError) throw new Error("inert preparation failure"); return { left: [], skipped: [] }; },
    snapshot: () => { runtime.push("snapshot"); return "inert-snapshot"; },
    changed: () => partial ? ["partial.txt"] : [],
    diff: () => "inert partial diff",
    safe: (root: string, path: string) => `${root}/${path}`,
    codex: async (o: any) => {
      const driver = { options: o, admission: { ...observe(), aborted: o.signal.aborted }, aborts: 0 };
      drivers.push(driver); runtime.push("driver");
      const finish = () => { driver.aborts++; o.hooks.done({ ok: false, summary: "inert stop" }); o.hooks.done({ ok: false, summary: "duplicate stop" }); };
      if (o.signal.aborted) finish(); else o.signal.addEventListener("abort", finish, { once: true });
      if (immediate) o.hooks.done({ ok: true, summary: "inert completion" });
    },
  };
  const globals = globalThis as any; globals[key] = bridge;
  const replacements: Record<string, string> = {
    "./specstore.ts": "export const specPaths=b.paths,hasCommit=b.commit,createWorkspace=b.workspace,snapshot=b.snapshot,changedFiles=b.changed,diff=b.diff,safeTarget=b.safe,applyToProject=b.unexpected,removeWorkspace=b.unexpected;",
    "./codex.ts": "export const runCodexTurn=b.codex;",
    "./local.ts": "export const runLocalTurn=b.unexpected;",
    "./agy.ts": "export const runAgyTurn=b.unexpected;",
    "./grok.ts": "export const runGrokTurn=b.unexpected;",
    "node:fs": "export const mkdirSync=b.unexpected,rmSync=b.unexpected,chmodSync=b.unexpected,existsSync=b.unexpected,statSync=b.unexpected,writeFileSync=b.unexpected;",
    "node:net": "export const createServer=b.unexpected;",
  };
  const sources = new Map<string, string>();
  const hooks = registerHooks({
    resolve(s, c, next) {
      if (c.parentURL === daemonURL && s === "./delegate.ts") return { url: delegateURL, shortCircuit: true };
      if (c.parentURL === delegateURL && s in replacements) {
        const url = `memory:watch-recovery-${id}/${s}`;
        sources.set(url, `const b=globalThis[${JSON.stringify(key)}];${replacements[s]}`);
        return { url, shortCircuit: true };
      }
      return next(s, c);
    },
    load(url, c, next) {
      const source = sources.get(url);
      return source === undefined ? next(url, c) : { format: "module", source, shortCircuit: true };
    },
  });
  let D: typeof Daemon, actual: typeof delegation;
  try { D = (await import(daemonURL)).Daemon; actual = await import(delegateURL); }
  finally { hooks.deregister(); delete globals[key]; }
  let cleanup = async () => {};
  t.after(() => cleanup()); // consume every inert round before harness closes the Trace
  const h = harness(t, D.prototype);
  h.d.runs = new actual.SpecRuns();
  h.ledger.addProject("p", "/inert/project", "project.opened");
  setCrew(h.ledger, "p", { controllerWorks: true, handoff: "ask", subagents: { controller: false, runners: false }, wake: "auto", maxPercent: {}, runners: null });
  const spec = h.ledger.createSpec("p", { to: "codex", brief: "inert", result: "done", scope: { read: [], write: [] }, budgetPercent: 5,
    workspace: "worktree", model: "", effort: null, reason: "inert", mode: "async", waitSeconds: 600 }, "user");
  h.ledger.updateSpec(spec.id, { status: "held", limited: { resetsAt: RESET, at: "2020-01-02T00:00:00.000Z", why: "inert limit" } }, "govd");
  // Use the real daemon recoveryContext, with explicitly memory-only stores and config.
  delete h.d.recoveryContext;
  h.d.usage = { codex: { read: () => read() } };
  h.d.limits = {
    record: () => counts.push("record"), forget: () => counts.push("forget"),
    admit: (target: string) => { counts.push("admit"); assert.equal(target, spec.id); if (verdict.ok) reservations.add(target); return verdict; },
    localRule: () => null, stillWithin: () => ({ ok: true }),
    release: (target: string) => { counts.push("release"); reservations.delete(target); },
    abandon: (target: string) => { counts.push("abandon"); reservations.delete(target); },
  };
  h.d.counted = {
    begin: (target: string) => { counts.push("begin"); counted.add(target); },
    settle: (target: string) => { counts.push("settle"); counted.delete(target); },
    drop: (target: string) => { counts.push("drop"); counted.delete(target); },
  };
  h.d.allows.endSpec = () => counts.push("endSpec");
  // Transparent recorders observe the actual registered controller and stop-by-ID calls.
  // Keep the latter too: the baseline's pre-run no-op calls must remain observable.
  const start = h.d.runs.start.bind(h.d.runs);
  h.d.runs.start = (target: string, project: string, to: string, run: any) => start(target, project, to, (controller: AbortController, cancelled: () => boolean) => {
    const abort = controller.abort.bind(controller);
    controller.abort = (reason: unknown) => {
      const running = h.d.runs.has(target), before = controller.signal.aborted;
      abort(reason);
      stops.push({ target, reason, running, result: !before && controller.signal.aborted });
    };
    return run(controller, cancelled);
  });
  const stop = h.d.runs.stop.bind(h.d.runs);
  h.d.runs.stop = (target: string, reason: unknown) => {
    const running = h.d.runs.has(target), before = stops.length, result = stop(target, reason);
    if (stops.length === before) stops.push({ target, reason, running, result });
    return result;
  };
  observe = () => ({ viewers: h.d.someoneSeesWakes(), watchers: h.d.watchers.size, owned: h.d.recoveryRuns.has(spec.id) });
  const complete = async (ok = true) => {
    const done = h.d.runs.done(spec.id);
    for (const driver of drivers) driver.options.hooks.done({ ok, summary: "inert completion" });
    await done?.catch(() => {}); await tick();
  };
  cleanup = async () => { h.d.stopping = true; await complete(false); };
  const arm = () => h.ledger.append("p", "recovery.set", "user", { target: spec.id, resetsAt: RESET, atReset: true });
  const leaveResumedRoom = (socket: ControlledSocket) => {
    const prior = h.ledger.events("p", 1)[0];
    const resumed: TraceEvent = { ...prior, seq: prior.seq + 3, kind: "recovery.resumed", actor: "govd", data: { target: spec.id, resetsAt: RESET, by: "govd" } };
    fill(h.ledger, socket, Buffer.byteLength(eventLine(resumed)));
  };
  return { ...h, actual, spec, runtime, drivers, counts, stops, reservations, counted, arm, leaveResumedRoom, complete,
    read: (fn: typeof read) => { read = fn; }, deny: () => { verdict = { ok: false, provider: "codex", reason: "inert hold", resetsAt: RESET }; },
    workspaceError: () => { workspaceError = true; }, partial: () => { partial = true; }, immediate: () => { immediate = true; } };
}

function settledRecovery(h: Awaited<ReturnType<typeof admittedRecoveryHarness>>, beforeTimers: number) {
  assert.equal(h.d.recoveryBusy, false);
  assert.equal(h.d.runs.count(), 0); assert.equal(h.d.recoveryRuns.size, 0);
  assert.equal(h.reservations.size, 0); assert.equal(h.counted.size, 0);
  for (const name of ["gates", "plans", "turnPlans", "waking", "wakeTurns", "telling"]) assert.equal(h.d[name].size, 0, name);
  assert.equal(timeouts(), beforeTimers, "the actual Limit poll and owned Gate timers are cleared");
}

for (const cascade of [false, true]) {
  test(`actual recovery spec.started retires ${cascade ? "cascading viewers" : "last viewer"} before count or driver`, async (t) => {
    const h = await admittedRecoveryHarness(t); const socket = await h.connect(true);
    if (cascade) await h.connect(true);
    h.arm(); h.leaveResumedRoom(socket);
    const timers = timeouts(); let answers = 0;
    gate(h.d, "G-spec", "", null, h.spec.id, () => answers++);
    await h.d.sweepRecovery(); await tick();
    assert.equal(h.drivers.length, 0, "real spec.started alone must stop before driver admission");
    assert.equal(socket.writableLength, LIMIT); assert.equal(socket.destroyCalls, 1);
    assert.equal(h.ledger.eventsOfKind("p", ["recovery.resumed"]).length, 1);
    assert.equal(h.ledger.eventsOfKind("p", ["spec.started"]).length, 1);
    assert.equal(h.counts.includes("begin"), false); assert.equal(h.counts.includes("abandon"), true);
    assert.equal(answers, 1); assert.equal(h.counts.filter((x) => x === "endSpec").length, 1);
    assert.equal(h.stops.length, 1); assert.equal(h.stops[0].running, true); assert.equal(h.stops[0].result, true);
    assert.equal(h.stops[0].reason.limited.resetsAt, RESET); assert.equal(h.stops[0].reason.limited.why, STOPPED_UNOBSERVED);
    assert.match(h.stops[0].reason.limited.at, /^\d{4}-/);
    const ended = h.ledger.spec(h.spec.id)!;
    assert.equal(ended.status, "failed"); assert.equal(ended.delivery, "pending");
    assert.equal(ended.limited?.why, STOPPED_UNOBSERVED); assert.equal(ended.limited?.resetsAt, RESET);
    assert.deepEqual(ended.checkpoints, { before: "inert-snapshot", after: "inert-snapshot" });
    settledRecovery(h, timers);
    socket.emit("error", new Error("late")); socket.finishClose(); await tick(); socket.emit("close");
    assert.equal(h.stops.length, 1); assert.equal(answers, 1); assert.equal(socket.destroyCalls, 1);
    await h.connect(true, false); await tick();
    assert.equal(h.drivers.length, 0, "the consumed choice is not automatically retried");
  });
}

for (const seam of ["recovery.resumed", "measurement"] as const) {
  for (const replacement of [false, true]) {
    test(`actual recovery loss during ${seam} ${replacement ? "stays cancelled with replacement viewer" : "denies pre-run admission"}`, async (t) => {
      const h = await admittedRecoveryHarness(t); const socket = await h.connect(true);
      h.arm(); if (seam === "recovery.resumed") fill(h.ledger, socket); else h.leaveResumedRoom(socket);
      const timers = timeouts();
      h.read(async () => {
        if (seam === "measurement") trace(h.ledger, "measurement fanout");
        assert.equal(socket.destroyed, true);
        if (replacement) { await h.connect(true, false); assert.equal(h.d.someoneSeesWakes(), true); }
        return null;
      });
      await h.d.sweepRecovery(); await tick();
      assert.deepEqual(h.runtime, [], "no workspace, snapshot or driver after sticky viewer loss");
      assert.equal(h.counts.includes("admit"), false);
      assert.equal(h.stops.length, 0, "a pre-run attempt must not stop an arbitrary Spec by ID");
      assert.equal(h.ledger.eventsOfKind("p", ["spec.started"]).length, 0);
      assert.equal(h.ledger.spec(h.spec.id)!.status, "held"); settledRecovery(h, timers);
    });
  }
}

test("actual recovery healthy second wake viewer preserves admission and ownership into later retirement", async (t) => {
  const h = await admittedRecoveryHarness(t); const stalled = await h.connect(true); const healthy = await h.connect(true, false);
  const passive = await h.connect(false, false); h.arm(); h.leaveResumedRoom(stalled); const timers = timeouts();
  await h.d.sweepRecovery(); await tick();
  assert.equal(stalled.destroyCalls, 1); assert.equal(h.drivers.length, 1);
  assert.deepEqual(h.drivers[0].admission, { viewers: true, watchers: 2, owned: true, aborted: false });
  assert.equal(h.stops.length, 0); assert.equal(h.d.recoveryRuns.has(h.spec.id), true);
  assert.equal(h.d.runs.count(), 1); assert.equal(h.counted.size, 1); assert.equal(h.reservations.size, 1);
  assert.equal(timeouts(), timers + 1, "actual Limit poll exists only during the run");
  h.partial(); let answers = 0;
  gate(h.d, "G-running", "", null, h.spec.id, () => answers++);
  healthy.emit("error", new Error("retire healthy")); await tick();
  assert.equal(h.d.watchers.has(passive), true); assert.equal(h.d.someoneSeesWakes(), false);
  assert.equal(h.drivers[0].aborts, 1); assert.equal(h.stops.length, 1); assert.equal(answers, 1);
  const ended = h.ledger.spec(h.spec.id)!;
  assert.equal(ended.status, "failed"); assert.equal(ended.delivery, "pending"); assert.deepEqual(ended.files, ["partial.txt"]);
  assert.equal(ended.limited?.why, STOPPED_UNOBSERVED); assert.equal(ended.limited?.resetsAt, RESET);
  settledRecovery(h, timers);
  healthy.emit("error", new Error("late")); healthy.finishClose(); await tick(); healthy.emit("close");
  assert.equal(h.stops.length, 1); assert.equal(h.drivers[0].aborts, 1);
});

for (const failure of ["denial", "measurement error", "workspace error", "no run", "preflight error"] as const) {
  test(`actual recovery early ownership cleans up after ${failure}`, async (t) => {
    const h = await admittedRecoveryHarness(t); await h.connect(true, false); h.arm(); const timers = timeouts();
    let ownedAtMeasure = false;
    h.read(async () => {
      ownedAtMeasure = h.d.recoveryRuns.has(h.spec.id);
      if (failure === "measurement error") throw new Error("inert measurement failure");
      if (failure === "no run") h.d.settings = () => Settings.parse({ runners: { codex: { model: "inert-model", effort: null } } });
      if (failure === "preflight error") h.ledger.updateSpec(h.spec.id, { status: "cancelled" }, "user");
      return null;
    });
    if (failure === "denial") h.deny(); if (failure === "workspace error") h.workspaceError();
    await h.d.sweepRecovery(); await tick();
    assert.equal(ownedAtMeasure, true, "ownership exists before measurement yields");
    assert.equal(h.drivers.length, 0); settledRecovery(h, timers);
    assert.equal(h.ledger.eventsOfKind("p", ["spec.started"]).length, 0);
    if (failure === "workspace error") assert.equal(h.counts.filter((x) => x === "abandon").length, 1);
    const stops = h.stops.length; const watcher = [...h.d.watchers.keys()][0];
    watcher.emit("error", new Error("after failure")); assert.equal(h.stops.length, stops, "no stale recovery is stopped");
  });
}

for (const immediate of [false, true]) {
  test(`actual recovery ${immediate ? "synchronous" : "ordinary"} completion removes ownership without stopping a user run`, async (t) => {
    const h = await admittedRecoveryHarness(t); const watcher = await h.connect(true, false); h.arm(); const timers = timeouts();
    if (immediate) h.immediate();
    await h.d.sweepRecovery(); await h.complete();
    assert.equal(h.drivers.length, 1); assert.equal(h.drivers[0].admission.owned, true);
    assert.equal(h.ledger.spec(h.spec.id)!.status, "needs-review"); assert.equal(h.ledger.spec(h.spec.id)!.delivery, "pending");
    assert.equal(h.counts.filter((x) => x === "settle").length, 1); settledRecovery(h, timers);
    const pending = new Promise<delegation.SpecResult>((resolve) => t.after(() => { resolve({ id: "S-user", status: "failed", runner: "codex", files: [], summary: "", diff: "", review: "" }); }));
    let userSignal!: AbortSignal;
    const done = h.d.runs.start("S-user", "p", "codex", (stop: AbortController) => { userSignal = stop.signal; return pending; });
    t.after(async () => { await done; });
    watcher.emit("error", new Error("after completion"));
    assert.equal(userSignal.aborted, false); assert.equal(h.stops.length, 0);
  });
}

test("actual recovery completion cleanup cannot delete a newer ownership record", async (t) => {
  const h = await admittedRecoveryHarness(t); await h.connect(true, false); h.arm(); const timers = timeouts();
  await h.d.sweepRecovery(); const newer = { resetsAt: RESET, cancelled: false };
  h.d.recoveryRuns.set(h.spec.id, newer); await h.complete();
  assert.equal(h.d.recoveryRuns.get(h.spec.id), newer);
  h.d.recoveryRuns.delete(h.spec.id); settledRecovery(h, timers);
});

test("actual recovery failure cleanup cannot delete a newer ownership record", async (t) => {
  const h = await admittedRecoveryHarness(t); await h.connect(true, false); h.arm(); const timers = timeouts();
  const newer = { resetsAt: RESET, cancelled: false };
  h.read(async () => { h.d.recoveryRuns.set(h.spec.id, newer); throw new Error("inert failure after replacement"); });
  await h.d.sweepRecovery();
  assert.equal(h.d.recoveryRuns.get(h.spec.id), newer);
  h.d.recoveryRuns.delete(h.spec.id); settledRecovery(h, timers);
});

test("actual user recovery keeps ordinary admission after its watch overflows spec.started", async (t) => {
  const h = await admittedRecoveryHarness(t); const socket = await h.connect(false);
  // Manual recovery writes the same real rows but is never owned by the automatic sweep.
  const prior = h.ledger.events("p", 1)[0];
  const resumed: TraceEvent = { ...prior, seq: prior.seq + 3, kind: "recovery.resumed", actor: "user", data: { target: h.spec.id, resetsAt: RESET, by: "user" } };
  fill(h.ledger, socket, Buffer.byteLength(eventLine(resumed))); const timers = timeouts();
  socket.input(rpcLine(2, "recovery.resume", { id: h.spec.id, since: h.d.recoveryTarget(h.spec.id).item.since })); await tick();
  assert.equal(socket.destroyCalls, 1); assert.equal(h.drivers.length, 1);
  assert.deepEqual(h.drivers[0].admission, { viewers: false, watchers: 0, owned: false, aborted: false });
  assert.equal(h.stops.length, 0); await h.complete(); settledRecovery(h, timers);
});

for (const loss of ["overflow", "error", "close"] as const) {
  for (const replacement of [false, true]) {
    test(`pending automatic measurement preserves same-Spec manual RPC round on ${loss}${replacement ? " with replacement viewer" : ""}`, async (t) => {
      const h = await admittedRecoveryHarness(t); const watcher = await h.connect(true);
      const manual = await h.connect(null, false); const timers = timeouts();
      let reads = 0, release!: (value: null) => void;
      const measurement = new Promise<null>((resolve) => { release = resolve; });
      h.read(async () => ++reads === 1 ? await measurement : null);
      h.arm(); const sweeping = h.d.sweepRecovery();
      t.after(async () => { release(null); await sweeping; });
      await tick(); assert.equal(reads, 1); assert.equal(h.d.recoveryRuns.has(h.spec.id), true);
      const attempt = h.d.recoveryRuns.get(h.spec.id);
      manual.input(rpcLine(90, "recovery.resume", { id: h.spec.id, since: h.d.recoveryTarget(h.spec.id).item.since }));
      await tick(); assert.equal(reads, 2); assert.equal(h.drivers.length, 1);
      assert.equal(manual.messages().find((m) => m.id === 90)?.result?.mode, "async");
      const driver = h.drivers[0], signal = driver.options.signal;
      h.partial();
      if (loss === "overflow") { fill(h.ledger, watcher); trace(h.ledger, "last viewer overflow"); }
      else if (loss === "error") watcher.emit("error", new Error("last viewer error"));
      else { watcher.destroy(); watcher.finishClose(); }
      await tick();
      assert.equal(signal.aborted, false, "last-viewer loss must preserve the user-started same-Spec round");
      assert.equal(driver.options.signal, signal); assert.equal(driver.aborts, 0);
      assert.equal(h.stops.length, 0, "a pending attempt has no authority to stop an unrelated round");
      assert.equal(manual.destroyed, false); assert.equal(h.d.sockets.has(manual), true);
      assert.equal(h.d.runs.count(), 1); assert.equal(h.ledger.spec(h.spec.id)!.status, "running");
      assert.equal(h.reservations.size, 1); assert.equal(h.counted.size, 1);
      assert.equal(h.counts.filter((x) => x === "admit").length, 1);
      assert.equal(h.counts.filter((x) => x === "begin").length, 1);
      assert.equal(h.d.recoveryBusy, true); assert.equal(attempt.cancelled, true);
      if (replacement) await h.connect(true, false);
      assert.equal(h.d.someoneSeesWakes(), replacement);
      release(null); await sweeping; await tick();
      assert.equal(h.drivers.length, 1); assert.equal(signal.aborted, false);
      assert.equal(h.d.recoveryRuns.size, 0); assert.equal(h.d.recoveryBusy, false);
      watcher.emit("error", new Error("late")); watcher.finishClose(); await tick(); watcher.emit("close");
      assert.equal(h.stops.length, 0); assert.equal(driver.aborts, 0); assert.equal(watcher.destroyCalls, 1);
      await h.complete();
      const ended = h.ledger.spec(h.spec.id)!;
      assert.equal(ended.status, "needs-review"); assert.equal(ended.delivery, "pending");
      assert.deepEqual(ended.files, ["partial.txt"]); assert.equal(ended.limited, undefined);
      settledRecovery(h, timers);
    });
  }

  test(`same-Spec manual completion before automatic measurement release stays preserved on ${loss}`, async (t) => {
    const h = await admittedRecoveryHarness(t); const watcher = await h.connect(true);
    const manual = await h.connect(null, false); const timers = timeouts();
    let reads = 0, release!: (value: null) => void;
    const measurement = new Promise<null>((resolve) => { release = resolve; });
    h.read(async () => ++reads === 1 ? await measurement : null);
    h.arm(); const sweeping = h.d.sweepRecovery();
    t.after(async () => { release(null); await sweeping; });
    await tick();
    manual.input(rpcLine(91, "recovery.resume", { id: h.spec.id, since: h.d.recoveryTarget(h.spec.id).item.since }));
    await tick(); assert.equal(manual.messages().find((m) => m.id === 91)?.result?.mode, "async");
    h.partial(); await h.complete();
    assert.equal(h.d.runs.count(), 0); assert.equal(h.d.recoveryBusy, true);
    const completed = h.ledger.spec(h.spec.id);
    if (loss === "overflow") { fill(h.ledger, watcher); trace(h.ledger, "after manual completion"); }
    else if (loss === "error") watcher.emit("error", new Error("after manual completion"));
    else { watcher.destroy(); watcher.finishClose(); }
    await tick();
    assert.equal(h.stops.length, 0, "pre-run cancellation must not even target a completed manual Spec by ID");
    await h.connect(true, false); release(null); await sweeping; await tick();
    assert.equal(h.drivers.length, 1); assert.equal(h.drivers[0].options.signal.aborted, false);
    assert.equal(manual.destroyed, false); assert.deepEqual(h.ledger.spec(h.spec.id), completed);
    assert.equal(h.counts.filter((x) => x === "admit").length, 1);
    settledRecovery(h, timers);
  });
}

test("overlapping manual measurement cannot take ownership of an admitted automatic round", async (t) => {
  const h = await admittedRecoveryHarness(t); const watcher = await h.connect(true, false);
  const healthy = await h.connect(true, false), manual = await h.connect(null, false); const timers = timeouts();
  let reads = 0, releaseAuto!: (value: null) => void, releaseManual!: (value: null) => void;
  const autoMeasure = new Promise<null>((resolve) => { releaseAuto = resolve; });
  const manualMeasure = new Promise<null>((resolve) => { releaseManual = resolve; });
  h.read(async () => ++reads === 1 ? await autoMeasure : await manualMeasure);
  h.arm(); const sweeping = h.d.sweepRecovery();
  t.after(async () => { releaseAuto(null); releaseManual(null); await sweeping; });
  await tick(); manual.input(rpcLine(92, "recovery.resume", { id: h.spec.id, since: h.d.recoveryTarget(h.spec.id).item.since }));
  await tick(); assert.equal(reads, 2);
  releaseAuto(null); await sweeping; await tick();
  assert.equal(h.drivers.length, 1); assert.equal(h.drivers[0].options.signal.aborted, false);
  releaseManual(null); await tick();
  assert.match(manual.messages().find((m) => m.id === 92)?.error?.message, /already running|no longer limited/);
  assert.equal(h.drivers.length, 1); assert.equal(h.d.recoveryRuns.has(h.spec.id), true);
  watcher.emit("error", new Error("one viewer leaves")); await tick();
  assert.equal(h.drivers[0].options.signal.aborted, false); assert.equal(h.stops.length, 0);
  healthy.emit("error", new Error("last viewer leaves")); await tick();
  assert.equal(h.drivers[0].aborts, 1); assert.equal(h.stops.length, 1);
  assert.equal(h.stops[0].reason.limited.why, STOPPED_UNOBSERVED);
  healthy.finishClose(); await tick(); healthy.emit("close"); assert.equal(h.stops.length, 1);
  assert.equal(manual.destroyed, false); settledRecovery(h, timers);
});

for (const immediate of [false, true]) {
  test(`completed ${immediate ? "synchronous" : "ordinary"} automatic round cannot stop a new same-ID user round`, async (t) => {
    const h = await admittedRecoveryHarness(t); const watcher = await h.connect(true, false); const timers = timeouts();
    if (immediate) h.immediate();
    h.arm(); await h.d.sweepRecovery(); await h.complete(); settledRecovery(h, timers);
    // Register the replacement in the real SpecRuns, with an explicitly inert user callback.
    // No injected recovery ownership entry: completion must have released the actual attempt.
    let signal!: AbortSignal, finish!: (result: delegation.SpecResult) => void;
    const pending = new Promise<delegation.SpecResult>((resolve) => { finish = resolve; });
    const done = h.d.runs.start(h.spec.id, "p", "codex", (stop: AbortController) => { signal = stop.signal; return pending; });
    try {
      assert.equal(h.d.runs.has(h.spec.id), true); assert.equal(h.d.recoveryRuns.size, 0);
      watcher.emit("error", new Error("after same-ID replacement")); watcher.finishClose(); await tick(); watcher.emit("close");
      assert.equal(signal.aborted, false); assert.equal(h.d.runs.has(h.spec.id), true);
      assert.equal(h.stops.length, 0); assert.equal(h.drivers[0].options.signal.aborted, false);
    } finally {
      finish({ id: h.spec.id, status: "needs-review", runner: "codex", files: [], summary: "inert user round", diff: "", review: "" });
      await done;
    }
  });
}

test("actual user cancellation settles automatic ownership even when completion notification is suppressed", async (t) => {
  const h = await admittedRecoveryHarness(t); const watcher = await h.connect(true, false);
  const manual = await h.connect(null, false); const timers = timeouts();
  h.arm(); await h.d.sweepRecovery(); await tick();
  assert.equal(h.d.recoveryRuns.has(h.spec.id), true);
  manual.input(rpcLine(93, "spec.cancel", { id: h.spec.id })); await tick();
  assert.equal(manual.messages().find((m) => m.id === 93)?.result?.status, "cancelled");
  assert.equal(h.drivers[0].aborts, 1); assert.equal(h.ledger.spec(h.spec.id)!.delivery, "disposed");
  settledRecovery(h, timers);
  const stops = h.stops.length; watcher.emit("error", new Error("after user cancel")); await tick();
  assert.equal(h.stops.length, stops); assert.equal(manual.destroyed, false);
});
