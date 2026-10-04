// Invented metadata and in-memory RPCs only. No agent binaries or artifacts are used.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AcpRpc } from "../src/acp.ts";
import { ACP_DISCOVERY_LIMITS as limits, AcpDiscoveryCleanupError, decodeAcpInitialize,
  decodeAcpSession, discoverAcp } from "../src/acp-probe.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const initialization = () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: false }, mcpCapabilities: { http: false, sse: false } },
  agentInfo: { name: "fixture-agent", title: "Fixture Agent", version: "1.2.3" },
  authMethods: [{ id: "fixture-login", name: "Fixture Login", description: "Invented auth method" }] });
const config = (category = "model") => ({ id: category, name: "Fixture Selector", category, type: "select",
  currentValue: "fixture-a", options: [{ value: "fixture-a", name: "Fixture A" }, { value: "fixture-b", name: "Fixture B" }] });
const legacyModes = () => ({ currentModeId: "fixture-mode", availableModes: [{ id: "fixture-mode", name: "Fixture Mode" }] });
const legacyModels = () => ({ currentModelId: "fixture-model", availableModels: [{ modelId: "fixture-model", name: "Fixture Model" }] });
const freshOptions = { cwd: "/fixture/fresh", createSession: true, freshCwd: true } as const;

class FakeRpc implements AcpRpc {
  requests: { method: string; params: unknown; timeoutMs?: number }[] = [];
  notifications: { method: string; params: unknown }[] = [];
  events: string[] = [];
  closing = deferred<number | null>();
  closed = this.closing.promise;
  exited = Promise.resolve("");
  reqHandler: (method: string, params: unknown) => Promise<unknown> = async () => { throw new Error("unregistered"); };
  noteHandler: (method: string, params: unknown) => void = () => {};
  autoClose = true;
  answer: (method: string) => unknown | Promise<unknown> = (method) =>
    method === "initialize" ? initialization() : { sessionId: "fixture-session", configOptions: [config(), config("mode")] };
  async request(method: string, params: unknown, timeoutMs?: number) {
    this.requests.push({ method, params, timeoutMs }); this.events.push(method);
    return this.answer(method);
  }
  notify(method: string, params: unknown) { this.notifications.push({ method, params }); }
  onRequest(f: (method: string, params: unknown) => Promise<unknown>) { this.reqHandler = f; }
  onNotify(f: (method: string, params: unknown) => void) { this.noteHandler = f; }
  close(killAfterMs?: number) {
    this.events.push("close"); assert.equal(killAfterMs, 100);
    if (this.autoClose) queueMicrotask(() => this.finishClose());
  }
  finishClose() { this.events.push("closed"); this.closing.resolve(0); }
}

test("overdue responses cannot start another request when timer callbacks are delayed", async () => {
  const rpc = new FakeRpc();
  rpc.answer = () => new Promise((resolve) => setImmediate(() => {
    const until = performance.now() + 40;
    while (performance.now() < until) { /* Deliberately delay the timeout callback. */ }
    resolve(initialization());
  }));
  const result = await discoverAcp(rpc, { ...freshOptions, timeoutMs: 10 });
  assert.equal(result.status, "timeout");
  assert.equal(result.runtimeClosed, true);
  assert.deepEqual(rpc.requests.map((r) => r.method), ["initialize"]);
  assert.ok(rpc.requests[0].timeoutMs! <= 10);
});

test("overdue rejected initialize or session replies report timeout before protocol errors", async () => {
  for (const stage of ["initialize", "session/new"]) {
    const rpc = new FakeRpc();
    rpc.answer = (method) => method !== stage ? initialization() : new Promise((_resolve, reject) => setImmediate(() => {
      const until = performance.now() + 40;
      while (performance.now() < until) { /* Delay the timer, then reject rather than fulfill. */ }
      reject(Object.assign(new Error("invented authentication error"), { code: -32000 }));
    }));
    const result = await discoverAcp(rpc, { ...freshOptions, timeoutMs: 10 });
    assert.equal(result.status, "timeout", stage);
    assert.equal(result.runtimeClosed, true);
    assert.equal(rpc.requests.length, stage === "initialize" ? 1 : 2);
  }
});

test("initialization keeps only known bounded metadata, with no auth or eligibility assertion", () => {
  const raw = { ...initialization(), _meta: { signedIn: true, eligible: true, provider: "fixture-vendor" } };
  const decoded = decodeAcpInitialize(raw);
  assert.equal(decoded.protocolVersion, 1);
  assert.equal(decoded.agentInfo?.name, "fixture-agent");
  assert.deepEqual(decoded.authMethods, [{ id: "fixture-login", name: "Fixture Login", description: "Invented auth method", type: "agent" }]);
  assert.equal(decoded.capabilities.loadSession, true);
  assert.equal("_meta" in decoded, false);
  assert.equal("eligible" in decoded, false);
  assert.equal("signedIn" in decoded, false);
  assert.deepEqual(decodeAcpInitialize({ protocolVersion: 1, agentCapabilities: {} }), {
    protocolVersion: 1, agentInfo: null, authMethods: null, capabilities: {},
  });
});

test("strict protocol negotiation, required shapes, capabilities, and auth descriptors", () => {
  for (const value of [null, [], "reply", {}, { protocolVersion: "1", agentCapabilities: {} },
    { protocolVersion: 1.1, agentCapabilities: {} }, { protocolVersion: 1 },
    { protocolVersion: 1, agentCapabilities: [] }, { ...initialization(), agentCapabilities: { loadSession: "yes" } },
    { ...initialization(), agentInfo: { name: "fixture" } }, { ...initialization(), authMethods: [{ id: "fixture" }] },
    { ...initialization(), authMethods: [initialization().authMethods[0], initialization().authMethods[0]] }]) {
    assert.throws(() => decodeAcpInitialize(value));
  }
  assert.throws(() => decodeAcpInitialize({ protocolVersion: 2, agentCapabilities: {} }), /unsupported/);
  const terminal = decodeAcpInitialize({ ...initialization(), authMethods: [{ id: "fixture-terminal", name: "Fixture",
    type: "terminal", args: ["--fixture-login"], env: { FIXTURE_AUTH: "invented" } }] });
  assert.deepEqual(terminal.authMethods, [{ id: "fixture-terminal", name: "Fixture", type: "terminal" }]);
});

test("size fences reject oversize records, strings, arrays, depth, aggregate bytes and controls", () => {
  const nested: Record<string, unknown> = {};
  let cursor = nested;
  for (let i = 0; i < limits.depth + 1; i++) { const next = {}; cursor.child = next; cursor = next; }
  const tooManyKeys = Object.fromEntries(Array.from({ length: limits.recordKeys + 1 }, (_, n) => [`k${n}`, true]));
  const tooManyBytes = Array.from({ length: 20 }, () => "x".repeat(limits.string));
  const tooManyNodes = Array.from({ length: limits.arrayItems }, () => Array(limits.arrayItems).fill(false));
  for (const extra of [tooManyKeys, nested, tooManyBytes, tooManyNodes, Array(limits.arrayItems + 1).fill(true),
    { text: "x".repeat(limits.string + 1) }, { text: "é".repeat(limits.string) }, { text: "line\nbreak" },
    { text: "bad\u0000text" }, { text: "bad\u001btext" }, { text: "bad\u007ftext" }]) {
    assert.throws(() => decodeAcpInitialize({ ...initialization(), _meta: extra }), /malformed/);
  }
  assert.throws(() => decodeAcpInitialize({ ...initialization(), authMethods: Array(limits.authMethods + 1).fill(initialization().authMethods[0]) }));
  const cyclic: Record<string, unknown> = {}; cyclic.child = cyclic;
  assert.throws(() => decodeAcpInitialize({ ...initialization(), _meta: cyclic }), /malformed/);
  const getter = Object.defineProperty({}, "danger", { enumerable: true, get() { assert.fail("must not execute getters"); } });
  assert.throws(() => decodeAcpInitialize({ ...initialization(), _meta: getter }), /malformed/);
});

test("configOptions exclusively win over legacy modes and models; unknown categories are reported", () => {
  const decoded = decodeAcpSession({ sessionId: "fixture", configOptions: [config(), config("mode"), config("_fixture")],
    modes: legacyModes(), models: legacyModels(), _meta: { vendorModels: ["fake"] } });
  assert.equal(decoded.source, "configOptions");
  assert.equal(decoded.models?.current, "fixture-a");
  assert.equal(decoded.modes?.current, "fixture-a");
  assert.equal(decoded.configOptions[2].category, "_fixture");
  assert.equal("sessionId" in decoded, false);
  const empty = decodeAcpSession({ sessionId: "fixture", configOptions: [], modes: legacyModes(), models: legacyModels() });
  assert.equal(empty.source, "configOptions"); assert.equal(empty.modes, null); assert.equal(empty.models, null);
  assert.equal(decodeAcpSession({ sessionId: "fixture", configOptions: [], modes: { unknown: true }, models: { unknown: true } }).source, "configOptions");
});

test("grouped config schema preserves order and group names; first category wins", () => {
  const grouped = { ...config(), options: [{ group: "recommended", name: "Recommended", options: config().options }] };
  const decoded = decodeAcpSession({ sessionId: "fixture", configOptions: [grouped, { ...config(), id: "second", currentValue: "fixture-b" }] });
  assert.deepEqual(decoded.configOptions[0].options[0], { value: "fixture-a", name: "Fixture A", group: "recommended", groupName: "Recommended" });
  assert.equal(decoded.models?.current, "fixture-a");
});

test("unsupported config types are explicit and never fall back to legacy or generic data", () => {
  const result = decodeAcpSession({ sessionId: "fixture", configOptions: [
    { id: "toggle", name: "Toggle", type: "boolean", currentValue: true },
    { id: "future", name: "Future", type: "fixture-unknown", currentValue: "fake", vendor: { eligible: true } },
  ], modes: legacyModes() });
  assert.deepEqual(result.unsupportedConfigTypes, ["boolean", "fixture-unknown"]);
  assert.deepEqual(result.configOptions, []); assert.equal(result.modes, null);
});

test("malformed known config schema is rejected, rather than masked by legacy fallback", () => {
  const base = config();
  for (const option of [{ ...base, currentValue: "absent" }, { ...base, currentValue: true },
    { ...base, options: [{}] }, { ...base, options: [...base.options, base.options[0]] },
    { ...base, options: [...base.options, { group: "g", name: "G", options: base.options }] },
    { ...base, options: [{ group: "g", name: "G", options: base.options }, { group: "g", name: "G", options: [] }] },
    { ...base, id: "x".repeat(limits.id + 1) }, { ...base, category: "bad\tcategory" },
    { ...base, options: Array(limits.arrayItems + 1).fill(base.options[0]) }]) {
    assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [option], modes: legacyModes() }), /malformed/);
  }
  assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [base, base] }), /malformed/);
  assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: Array(limits.configOptions + 1).fill(base) }), /malformed/);
  assert.throws(() => decodeAcpSession({ configOptions: [] }), /missing/);
  assert.throws(() => decodeAcpSession({ sessionId: "bad\nhandle" }), /malformed/);
});

test("legacy model and mode schema is decoded only without configOptions; missing is explicit", () => {
  const legacy = decodeAcpSession({ sessionId: "fixture", modes: legacyModes(), models: legacyModels() });
  assert.equal(legacy.source, "legacy");
  assert.equal(legacy.models?.current, "fixture-model"); assert.equal(legacy.modes?.current, "fixture-mode");
  assert.equal(decodeAcpSession({ sessionId: "fixture" }).source, "missing");
  assert.throws(() => decodeAcpSession({ sessionId: "fixture", models: { currentModelId: "missing", availableModels: [] } }));
});

test("default discovery only initializes, advertises disabled clients, and closes runtime", async () => {
  const rpc = new FakeRpc();
  const result = await discoverAcp(rpc, { cwd: "/fixture/fresh" });
  assert.equal(result.status, "reported"); assert.equal(result.sessionStatus, "not-requested");
  assert.equal(result.evidence, "agent-reported"); assert.equal(result.runtimeClosed, true);
  assert.deepEqual(rpc.requests.map((v) => v.method), ["initialize"]);
  assert.deepEqual(rpc.requests[0].params, { protocolVersion: 1,
    clientInfo: { name: "governcode-discovery", version: "0.1.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } } });
  assert.deepEqual(rpc.events, ["initialize", "close", "closed"]);
  assert.deepEqual(rpc.notifications, []);
  assert.equal("eligible" in result, false); assert.equal("signedIn" in result, false);
});

test("optional discovery creates only a fresh session with no MCP servers or prompt", async () => {
  const rpc = new FakeRpc();
  const result = await discoverAcp(rpc, freshOptions);
  assert.equal(result.sessionStatus, "reported");
  assert.deepEqual(rpc.requests.map((v) => v.method), ["initialize", "session/new"]);
  assert.deepEqual(rpc.requests[1].params, { cwd: "/fixture/fresh", mcpServers: [] });
  assert.equal(result.session?.models?.current, "fixture-a");
  assert.deepEqual(rpc.notifications, []);
});

test("invalid options refuse all outbound work and still close", async () => {
  for (const options of [{ cwd: "/fixture/project", createSession: true }, { cwd: "relative" },
    { cwd: "/fixture/bad\npath" }, { cwd: "/fixture", timeoutMs: 0 }, { cwd: "/fixture", timeoutMs: 30_001 },
    { cwd: "/fixture", cleanupTimeoutMs: 0 }]) {
    const rpc = new FakeRpc();
    const result = await discoverAcp(rpc, options);
    assert.equal(result.status, "malformed"); assert.equal(rpc.requests.length, 0);
    assert.deepEqual(rpc.events, ["close", "closed"]);
  }
});

test("unsupported versions and missing or malformed initialize results never start a session", async () => {
  for (const [reply, expected] of [[{ protocolVersion: 2, agentCapabilities: {} }, "unsupported"],
    [{}, "missing"], [{ protocolVersion: "1" }, "malformed"]] as const) {
    const rpc = new FakeRpc(); rpc.answer = () => reply;
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, expected); assert.equal(result.initialization, null);
    assert.deepEqual(rpc.requests.map((v) => v.method), ["initialize"]);
    assert.equal(rpc.events.at(-1), "closed");
  }
});

test("protocol error codes report auth-required or unsupported without authentication", async () => {
  for (const [code, expected] of [[-32000, "auth-required"], [-32601, "unsupported"], [-32603, "error"]] as const) {
    const rpc = new FakeRpc(); rpc.answer = (method) => {
      if (method === "initialize") return initialization();
      throw Object.assign(new Error("Invented provider message"), { code });
    };
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, expected); assert.equal(result.sessionStatus, expected);
    assert.ok(result.initialization?.authMethods?.length);
    assert.deepEqual(rpc.requests.map((v) => v.method), ["initialize", "session/new"]);
    assert.equal(JSON.stringify(result).includes("Invented provider message"), false);
  }
  const rpc = new FakeRpc(); rpc.answer = () => { throw new Error("Authentication required"); };
  assert.equal((await discoverAcp(rpc, { cwd: "/fixture" })).status, "error");
});

test("session missing, malformed and unsupported metadata have honest statuses", async () => {
  for (const [reply, expected] of [[{ sessionId: "fixture" }, "missing"], [{}, "missing"],
    [{ sessionId: "fixture", configOptions: [{ id: "b", name: "B", type: "boolean", currentValue: false }] }, "unsupported"],
    [{ sessionId: "fixture", configOptions: [config(), config()] }, "malformed"]] as const) {
    const rpc = new FakeRpc(); rpc.answer = (method) => method === "initialize" ? initialization() : reply;
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, expected); assert.equal(result.sessionStatus, expected);
    assert.equal(result.runtimeClosed, true);
  }
});

test("every client permission, filesystem, terminal, auth, elicitation and unknown request is rejected", async () => {
  for (const method of ["session/request_permission", "fs/read_text_file", "fs/write_text_file", "terminal/create",
    "terminal/output", "terminal/release", "terminal/wait_for_exit", "terminal/kill", "authenticate",
    "auth/exec", "elicitation/create", "_fixture/vendor_call", "unknown"]) {
    const rpc = new FakeRpc();
    rpc.answer = async () => {
      await assert.rejects(rpc.reqHandler(method, { options: [{ optionId: "allow", kind: "allow_always" }] }), /rejects all/);
      return initialization();
    };
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, "forbidden-request", method);
    assert.deepEqual(rpc.requests.map((v) => v.method), ["initialize"]);
    assert.equal(rpc.events.filter((v) => v === "close").length, 1);
    assert.equal(rpc.events.at(-1), "closed");
  }
});

test("bounded notifications are ignored; a flood closes even when initialize never answers", async () => {
  const rpc = new FakeRpc(); rpc.answer = () => {
    for (let n = 0; n < limits.notifications + 50; n++) rpc.noteHandler("_fixture/update", { text: "ignored" });
    return new Promise<never>(() => {});
  };
  const result = await discoverAcp(rpc, { cwd: "/fixture", timeoutMs: 100 });
  assert.equal(result.status, "notification-flood"); assert.equal(result.runtimeClosed, true);
  assert.equal(rpc.events.filter((v) => v === "close").length, 1);
  const quiet = new FakeRpc(); quiet.answer = () => {
    for (let n = 0; n < limits.notifications; n++) quiet.noteHandler("session/update", { vendor: true });
    return initialization();
  };
  assert.equal((await discoverAcp(quiet, { cwd: "/fixture" })).status, "reported");
});

test("overall timeout independently interrupts a transport ignoring its request timeout", async () => {
  const rpc = new FakeRpc(); rpc.answer = () => new Promise<never>(() => {});
  const result = await discoverAcp(rpc, { cwd: "/fixture", timeoutMs: 10 });
  assert.equal(result.status, "timeout"); assert.equal(result.runtimeClosed, true);
  assert.deepEqual(rpc.events, ["initialize", "close", "closed"]);
});

test("one deadline covers initialize and session/new, not a fresh timeout per method", async () => {
  const rpc = new FakeRpc();
  rpc.answer = (method) => method === "initialize" ? new Promise((resolve) => setTimeout(() => resolve(initialization()), 15)) :
    new Promise<never>(() => {});
  const result = await discoverAcp(rpc, { ...freshOptions, timeoutMs: 30 });
  assert.equal(result.status, "timeout"); assert.equal(result.sessionStatus, "timeout");
  assert.equal(rpc.requests.length, 2); assert.equal(rpc.events.at(-1), "closed");
});

test("pre-cancellation sends nothing; cancellation during initialize and session closes", async () => {
  const early = new AbortController(); early.abort();
  const noWork = new FakeRpc();
  assert.equal((await discoverAcp(noWork, { cwd: "/fixture", signal: early.signal })).status, "cancelled");
  assert.equal(noWork.requests.length, 0);
  for (const cancelMethod of ["initialize", "session/new"]) {
    const controller = new AbortController(), rpc = new FakeRpc();
    rpc.answer = (method) => {
      if (method !== cancelMethod) return initialization();
      controller.abort(); return new Promise<never>(() => {});
    };
    const result = await discoverAcp(rpc, { ...freshOptions, signal: controller.signal });
    assert.equal(result.status, "cancelled"); assert.equal(result.runtimeClosed, true);
    assert.equal(rpc.events.at(-1), "closed");
  }
});

test("success, malformed reply, timeout and cancel cannot return before runtime closure or caller cleanup", async () => {
  for (const kind of ["success", "malformed", "timeout", "cancel"]) {
    const rpc = new FakeRpc(); rpc.autoClose = false;
    const controller = new AbortController();
    if (kind === "malformed") rpc.answer = () => [];
    if (kind === "timeout" || kind === "cancel") rpc.answer = () => new Promise<never>(() => {});
    let returned = false;
    const pending = discoverAcp(rpc, { cwd: "/fixture", signal: controller.signal, timeoutMs: 10, cleanupTimeoutMs: 500 })
      .then((result) => { returned = true; rpc.events.push("caller-cleanup"); return result; });
    if (kind === "cancel") controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(returned, false, kind); assert.ok(rpc.events.includes("close"));
    rpc.finishClose(); await pending;
    assert.deepEqual(rpc.events.slice(-2), ["closed", "caller-cleanup"]);
  }
});

test("broken or rejected closed promise fails within a bound and cannot claim cleanup", async () => {
  const rpc = new FakeRpc(); rpc.autoClose = false;
  await assert.rejects(discoverAcp(rpc, { cwd: "/fixture", cleanupTimeoutMs: 10 }), AcpDiscoveryCleanupError);
  assert.equal(rpc.events.at(-1), "close"); rpc.finishClose();
  const failed = new FakeRpc(); failed.autoClose = false;
  const result = discoverAcp(failed, { cwd: "/fixture" });
  failed.closing.reject(new Error("Invented closure failure"));
  await assert.rejects(result, AcpDiscoveryCleanupError);
});

test("early runtime closure interrupts hanging requests and closure rejection is observed immediately", async () => {
  const early = new FakeRpc(); early.autoClose = false;
  early.answer = () => { early.finishClose(); return new Promise<never>(() => {}); };
  assert.equal((await discoverAcp(early, { cwd: "/fixture", timeoutMs: 100 })).status, "error");
  const broken = new FakeRpc(); broken.autoClose = false;
  broken.answer = () => { broken.closing.reject(new Error("Invented runtime failure")); return new Promise<never>(() => {}); };
  await assert.rejects(discoverAcp(broken, { cwd: "/fixture", timeoutMs: 100 }), AcpDiscoveryCleanupError);
  assert.equal(broken.events.at(-1), "close");
});

test("forbidden requests, floods or cancellation during closure cannot leave a successful report", async () => {
  for (const kind of ["request", "flood", "cancel"]) {
    const rpc = new FakeRpc(); rpc.autoClose = false;
    const controller = new AbortController();
    const pending = discoverAcp(rpc, { cwd: "/fixture", cleanupTimeoutMs: 500, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    if (kind === "request") await assert.rejects(rpc.reqHandler("fs/read_text_file", {}));
    else if (kind === "cancel") controller.abort();
    else for (let n = 0; n <= limits.notifications; n++) rpc.noteHandler("unknown", {});
    rpc.finishClose(); const result = await pending;
    assert.equal(result.status, kind === "request" ? "forbidden-request" : kind === "cancel" ? "cancelled" : "notification-flood");
  }
});
