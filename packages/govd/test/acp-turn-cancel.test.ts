// Manually controlled in-memory RPCs only; no agent processes or filesystem fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_INFO, runAcpTurn, type AcpRpc } from "../src/acp.ts";
import type { TurnHooks } from "../src/claude.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const methods = ["initialize", "session/new", "session/prompt"] as const;
type Method = typeof methods[number];
const sessionId = "invented-session";
const usage = { totalTokens: 7, inputTokens: 4, outputTokens: 3 };
const permission = {
  sessionId, toolCall: { kind: "execute", rawInput: { command: "invented-command" } },
  options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }],
};
const denied = { outcome: { outcome: "selected", optionId: "no" } };

function fixture(signal?: AbortSignal) {
  const replies = Object.fromEntries(methods.map((m) => [m, deferred<any>()])) as Record<Method, ReturnType<typeof deferred<any>>>;
  const entered = Object.fromEntries(methods.map((m) => [m, deferred<void>()])) as Record<Method, ReturnType<typeof deferred<void>>>;
  const calls: { method: string; params: unknown; timeoutMs?: number }[] = [];
  const notifications: { method: string; params: unknown }[] = [];
  const events: unknown[] = [];
  const gateAnswer = deferred<"allow" | "deny">();
  const closing = deferred<number | null>();
  let handleRequest!: (method: string, params: any) => Promise<unknown>;
  let handleNotify!: (method: string, params: any) => void;
  let closes = 0;
  const rpc: AcpRpc = {
    request(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      assert.ok(methods.includes(method as Method));
      entered[method as Method].resolve();
      return replies[method as Method].promise;
    },
    notify(method, params) { notifications.push({ method, params }); },
    onRequest(f) { handleRequest = f; },
    onNotify(f) { handleNotify = f; },
    close() { closes++; },
    closed: closing.promise, exited: deferred<string>().promise,
  };
  const hooks: TurnHooks = {
    text(text) { events.push(["text", text]); },
    tool(name, input) { events.push(["tool", name, input]); },
    gate(req) { events.push(["gate", req]); return gateAnswer.promise; },
    done(result) { events.push(["done", result]); },
  };
  return {
    rpc, hooks, replies, entered, calls, notifications, events, gateAnswer,
    get closes() { return closes; },
    start: () => runAcpTurn({ rpc, hooks, signal, agent: "invented", cwd: "/invented/work", prompt: "invented prompt", promptTimeoutMs: 1234 }),
    ask: (params: unknown = permission) => handleRequest("session/request_permission", params),
    note: (update: unknown) => handleNotify("session/update", { sessionId, update }),
  };
}

async function reachSession(f: ReturnType<typeof fixture>) {
  f.replies.initialize.resolve({ protocolVersion: 1 });
  await f.entered["session/new"].promise;
}

async function reachPrompt(f: ReturnType<typeof fixture>) {
  await reachSession(f);
  f.replies["session/new"].resolve({ sessionId });
  await f.entered["session/prompt"].promise;
}

function assertStopped(result: Awaited<ReturnType<typeof runAcpTurn>>) {
  assert.deepEqual(result, { ok: false, summary: "stopped: invented stop", usage: null });
}

test("pre-aborted entry sends zero requests, opens zero Gates and requests closure", async () => {
  const controller = new AbortController();
  controller.abort("invented stop");
  const f = fixture(controller.signal);
  const result = f.start();
  assert.deepEqual(f.calls, []);
  assertStopped(await result);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.notifications, []);
  assert.deepEqual(await f.ask(), denied);
  assert.deepEqual(f.events, []);
});

for (const stage of ["initialize", "session/new"] as const) {
  test(`abort during pending ${stage} returns without reply or transport closure`, async () => {
    const controller = new AbortController();
    const f = fixture(controller.signal);
    const result = f.start();
    if (stage === "session/new") await reachSession(f);
    let denial!: Promise<unknown>;
    f.rpc.close = () => { denial = f.ask(); };
    controller.abort("invented stop");
    assertStopped(await result);
    assert.deepEqual(await denial, denied);
    assert.deepEqual(f.calls.map((c) => c.method), stage === "initialize" ? [stage] : ["initialize", stage]);
    assert.deepEqual(f.notifications, []);
    assert.deepEqual(f.events, []);
  });

  for (const settlement of ["fulfill", "reject"] as const) {
    for (const order of ["abort first", "reply first", "after return"] as const) {
      test(`${stage} ${settlement}: cancellation wins with settlement ${order}`, async () => {
        const controller = new AbortController();
        const f = fixture(controller.signal);
        const result = f.start();
        if (stage === "session/new") await reachSession(f);
        const settle = () => settlement === "fulfill"
          ? f.replies[stage].resolve(stage === "initialize" ? { protocolVersion: 1 } : { sessionId })
          : f.replies[stage].reject(new Error("invented late failure"));
        if (order === "reply first") settle();
        controller.abort("invented stop");
        if (order === "abort first") settle();
        assertStopped(await result);
        if (order === "after return") settle();
        // Drain queued continuations without attaching a fixture-side rejection handler:
        // the request must remain observed by the turn after logical cancellation.
        await Promise.resolve();
        await Promise.resolve();
        f.note({ sessionUpdate: "tool_call", title: "late tool" });
        f.note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late words" } });
        assert.deepEqual(await f.ask(), denied);
        assert.deepEqual(await f.ask({ ...permission, options: [permission.options[0]] }), { outcome: { outcome: "cancelled" } });
        f.gateAnswer.resolve("allow");
        assert.deepEqual(f.calls.map((c) => c.method), stage === "initialize" ? [stage] : ["initialize", stage]);
        assert.equal(f.closes, 1);
        assert.deepEqual(f.notifications, []);
        assert.deepEqual(f.events, []);
      });
    }
  }
}

test("abort in the session reply continuation prevents prompt dispatch", async () => {
  const controller = new AbortController();
  const f = fixture(controller.signal);
  const result = f.start();
  await reachSession(f);
  const aborting = f.replies["session/new"].promise.then(() => controller.abort("invented stop"));
  f.replies["session/new"].resolve({ sessionId });
  await aborting;
  assertStopped(await result);
  assert.deepEqual(f.calls.map((c) => c.method), ["initialize", "session/new"]);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.notifications, []);
});

test("final prompt admission rechecks cancellation during session interpretation", async () => {
  const controller = new AbortController();
  const f = fixture(controller.signal);
  const result = f.start();
  await reachSession(f);
  f.replies["session/new"].resolve({ get sessionId() { controller.abort("invented stop"); return sessionId; } });
  assertStopped(await result);
  f.note({ sessionUpdate: "tool_call", title: "late tool" });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.calls.map((c) => c.method), ["initialize", "session/new"]);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.notifications, []);
});

test("cancellation before initialization interpretation does not read the late reply", async () => {
  const controller = new AbortController();
  const f = fixture(controller.signal);
  const result = f.start();
  f.replies.initialize.resolve({ get protocolVersion() { return assert.fail("cancelled reply must not be interpreted"); } });
  controller.abort("invented stop");
  assertStopped(await result);
  assert.deepEqual(f.calls.map((c) => c.method), ["initialize"]);
});

test("abort during prompting sends graceful cancel, drains Gates and retains close backstop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const f = fixture(controller.signal);
  const result = f.start();
  await reachPrompt(f);
  const waiting = f.ask();
  assert.equal(f.events.length, 1);
  let reentrantDenial!: Promise<unknown>;
  f.rpc.notify = (method, params) => {
    f.notifications.push({ method, params });
    reentrantDenial = f.ask();
    f.gateAnswer.resolve("allow");
  };
  controller.abort("invented stop");
  controller.signal.dispatchEvent(new Event("abort"));
  assert.deepEqual(await waiting, denied);
  assert.deepEqual(await reentrantDenial, denied);
  assert.deepEqual(f.notifications, [{ method: "session/cancel", params: { sessionId } }]);
  assert.equal(f.closes, 0);
  t.mock.timers.tick(9999);
  assert.equal(f.closes, 0);
  t.mock.timers.tick(1);
  assert.equal(f.closes, 1);
  f.replies["session/prompt"].resolve({ stopReason: "cancelled", usage });
  assert.deepEqual(await result, { ok: false, summary: "stopped: invented stop", usage: { ...usage, complete: false } });
  assert.equal(f.events.length, 1);
});

test("prompt settlement clears the cancellation backstop and removes the listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  const f = fixture(controller.signal);
  const result = f.start();
  await reachPrompt(f);
  controller.abort("invented stop");
  f.replies["session/prompt"].resolve({ stopReason: "cancelled" });
  assertStopped(await result);
  assert.equal(remove.mock.callCount(), 1);
  t.mock.timers.tick(10_000);
  assert.equal(f.closes, 0);
  controller.signal.dispatchEvent(new Event("abort"));
  assert.equal(f.notifications.length, 1);
});

for (const stage of ["entry", "initialize", "session/new"] as const) {
  test(`throwing close at ${stage} cancellation returns a fixed local diagnostic`, async () => {
    const controller = new AbortController();
    if (stage === "entry") controller.abort("invented stop");
    const f = fixture(controller.signal);
    f.rpc.close = () => { throw new Error("invented private exception content"); };
    const result = f.start();
    if (stage === "session/new") await reachSession(f);
    if (stage !== "entry") assert.doesNotThrow(() => controller.abort("invented stop"));
    assert.deepEqual(await result, { ok: false, summary: "stopped: ACP close request failed", usage: null });
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.notifications, []);
    assert.equal(f.calls.length, stage === "entry" ? 0 : stage === "initialize" ? 1 : 2);
  });
}

for (const withSignal of [false, true]) {
  test(`successful sequence, payloads, hooks, Gates and usage (${withSignal ? "non-aborted signal" : "no signal"})`, async () => {
    const controller = new AbortController();
    const f = fixture(withSignal ? controller.signal : undefined);
    const result = f.start();
    await reachPrompt(f);
    f.note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "invented words" } });
    f.note({ sessionUpdate: "tool_call", kind: "execute", title: "invented step" });
    const allowed = f.ask();
    f.gateAnswer.resolve("allow");
    assert.deepEqual(await allowed, { outcome: { outcome: "selected", optionId: "yes" } });
    f.replies["session/prompt"].resolve({ stopReason: "end_turn", usage });
    assert.deepEqual(await result, { ok: true, summary: "done", usage: { ...usage, complete: true } });
    assert.deepEqual(f.calls, [
      { method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO }, timeoutMs: 60_000 },
      { method: "session/new", params: { cwd: "/invented/work", mcpServers: [] }, timeoutMs: 60_000 },
      { method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "invented prompt" }] }, timeoutMs: 1234 },
    ]);
    assert.deepEqual(f.events.slice(0, 2), [["text", "invented words"], ["tool", "invented execute: invented step", {}]]);
    assert.equal(f.events.length, 3);
    assert.deepEqual(await f.ask(), denied);
    controller.abort("after completion");
    assert.equal(f.closes, 0);
    assert.deepEqual(f.notifications, []);
  });
}

test("ordinary protocol and session ID validation remains in place", async () => {
  for (const stage of ["initialize", "session/new"] as const) {
    const f = fixture();
    const result = f.start();
    if (stage === "session/new") await reachSession(f);
    f.replies[stage].resolve(stage === "initialize" ? { protocolVersion: 2 } : { sessionId: "" });
    assert.deepEqual(await result, { ok: false, summary: stage === "initialize"
      ? "invented: the agent speaks ACP version 2, not 1" : "invented: the agent opened no session", usage: null });
    assert.equal(f.calls.length, stage === "initialize" ? 1 : 2);
  }
});

test("ordinary prompt rate-limit interpretation remains in place", async () => {
  const f = fixture();
  const result = f.start();
  await reachPrompt(f);
  f.replies["session/prompt"].reject(Object.assign(new Error("invented rate limit"), { code: -32003 }));
  assert.deepEqual(await result, { ok: false, summary: "invented hit its rate limit", limit: { resetsAt: null }, usage: null });
  assert.equal(f.closes, 1);
  assert.deepEqual(f.notifications, [{ method: "session/cancel", params: { sessionId } }]);
});
