// Invented metadata and in-memory RPCs only. No agent binaries or artifacts are used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpOutputBudgetError, type AcpRpc } from "../src/acp.ts";
import { fixture as budgetFixture, message as budgetMessage, turn as budgetTurn } from "./fixtures/acp-output-budget.ts";
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
const booleanConfig = (currentValue = true) => ({ id: "toggle", name: "Fixture Toggle", type: "boolean" as const, currentValue });
const legacyModes = () => ({ currentModeId: "fixture-mode", availableModes: [{ id: "fixture-mode", name: "Fixture Mode" }] });
const legacyModels = () => ({ currentModelId: "fixture-model", availableModels: [{ modelId: "fixture-model", name: "Fixture Model" }] });
const freshOptions = { cwd: "/fixture/fresh", createSession: true, freshCwd: true } as const;
const infoReply = () => ({ protocolVersion: 1, agentCapabilities: {},
  info: { name: "fixture-agent", version: "0" }, capabilities: { session: {} } });
const ordinaryInitializeReplies = () => [initialization(),
  { ...initialization(), _meta: { info: { name: "fixture-extension" } }, vendor: [false, "ignored"] },
  { ...initialization(), capabilities: { session: {} } }];
function refusedInitializeReplies(): { reply: unknown; expected: "unsupported" | "missing" | "malformed" }[] {
  const info = infoReply().info;
  return [
    ...[infoReply(), { protocolVersion: 1, agentCapabilities: {}, info },
      { protocolVersion: 1, info, capabilities: { session: {} } }, { protocolVersion: 1, info },
      { protocolVersion: 1, agentCapabilities: [], info },
      ...[null, {}, [], false, 0, "fixture", { name: false }].map((info) => ({ ...infoReply(), info })),
      Object.defineProperty(initialization(), "info", { value: undefined }),
      Object.defineProperty(initialization(), "info", { get() { assert.fail("must not read info"); } }),
    ].map((reply) => ({ reply, expected: "unsupported" as const })),
    { reply: { info }, expected: "missing" },
    ...[{ ...infoReply(), protocolVersion: "1" }, { ...infoReply(), protocolVersion: 1.1 },
      { ...infoReply(), info: undefined }, { ...infoReply(), info: { text: "x".repeat(limits.string + 1) } },
      { ...infoReply(), _meta: { text: "x".repeat(limits.string + 1) } },
      Object.defineProperty(infoReply(), "info", { enumerable: true, get() { assert.fail("must not read info"); } }),
    ].map((reply) => ({ reply, expected: "malformed" as const })),
  ];
}

class FakeRpc implements AcpRpc {
  requests: { method: string; params: unknown; timeoutMs?: number }[] = [];
  notifications: { method: string; params: unknown }[] = [];
  events: string[] = [];
  closing = deferred<number | null>();
  closeEntered = deferred<void>();
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
    this.closeEntered.resolve();
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

test("own top-level info refuses v1 interpretation after bounded and numeric validation", () => {
  for (const { reply, expected } of refusedInitializeReplies()) {
    assert.throws(() => decodeAcpInitialize(reply), new RegExp(`^Error: ACP discovery: ${expected}$`));
  }
  for (const reply of ordinaryInitializeReplies()) {
    assert.deepEqual(decodeAcpInitialize(reply), decodeAcpInitialize(initialization()));
  }
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
  const first = decoded.configOptions[0];
  assert.ok(first.type === "select");
  assert.deepEqual(first.options[0], { value: "fixture-a", name: "Fixture A", group: "recommended", groupName: "Recommended" });
  assert.equal(decoded.models?.current, "fixture-a");
});

test("unsupported config types are explicit and never fall back to legacy or generic data", () => {
  const result = decodeAcpSession({ sessionId: "fixture", configOptions: [
    { id: "toggle", name: "Toggle", type: "boolean", currentValue: true },
    { id: "future", name: "Future", type: "fixture-unknown", currentValue: "fake", vendor: { eligible: true } },
  ], modes: legacyModes() });
  assert.deepEqual(result.unsupportedConfigTypes, ["fixture-unknown"]);
  assert.deepEqual(result.configOptions, [{ id: "toggle", name: "Toggle", type: "boolean", currentValue: true }]);
  assert.equal(result.modes, null);
});

test("boolean true and false retain only bounded common metadata, with no choices or legacy fallback", () => {
  for (const currentValue of [true, false]) {
    const option = { ...booleanConfig(currentValue), description: "Invented toggle", category: "model" };
    const decoded = decodeAcpSession({ sessionId: "fixture", configOptions: [{ ...option,
      options: config().options, _meta: { eligible: true, signedIn: true }, vendor: { command: "invented" } }],
      models: legacyModels(), modes: legacyModes() });
    assert.deepEqual(decoded, { source: "configOptions", configOptions: [option], unsupportedConfigTypes: [], models: null, modes: null });
    const toggle = decoded.configOptions[0];
    assert.ok(toggle.type === "boolean");
    assert.equal(toggle.currentValue, currentValue);
    assert.equal("options" in toggle, false);
    assert.deepEqual(decodeAcpSession({ sessionId: "fixture", configOptions: [
      { ...booleanConfig(currentValue), category: null, description: null }], models: { unknown: true } }).configOptions,
    [booleanConfig(currentValue)]);
  }
});

test("mixed booleans and flat or grouped selects preserve order; the first select category wins", () => {
  for (const category of ["model", "mode"] as const) for (const booleanFirst of [true, false]) {
    const before = { ...booleanConfig(false), id: "before", category };
    const after = { ...booleanConfig(true), id: "after", category };
    const first = { ...config(category), options: [{ group: "g", name: "Fixture Group", options: config().options }] };
    const second = { ...config(category), id: "second", currentValue: "fixture-b" };
    const options = booleanFirst ? [before, first, after, second] : [first, before, second, after];
    const decoded = decodeAcpSession({ sessionId: "fixture", configOptions: options, models: legacyModels(), modes: legacyModes() });
    assert.deepEqual(decoded.configOptions.map((v) => v.id), options.map((v) => v.id));
    const grouped = decoded.configOptions.find((v) => v.id === category)!;
    assert.ok(grouped.type === "select");
    assert.deepEqual(grouped.options, config().options.map((v) => ({ ...v, group: "g", groupName: "Fixture Group" })));
    assert.deepEqual(decoded[category === "model" ? "models" : "modes"], {
      current: "fixture-a", available: config().options.map((v) => ({ id: v.value, name: v.name })) });
    assert.equal(decoded[category === "model" ? "modes" : "models"], null);
  }
});

test("malformed boolean values and common metadata are never coerced or masked by legacy", () => {
  const { currentValue: _value, ...missing } = booleanConfig();
  for (const option of [missing, ...[null, "true", "false", 0, 1, [], {}, [true]].map((currentValue) => ({ ...booleanConfig(), currentValue })),
    { ...booleanConfig(), id: "" }, { ...booleanConfig(), name: false }, { ...booleanConfig(), description: 0 },
    { ...booleanConfig(), category: true }]) {
    assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [option], models: legacyModels(), modes: legacyModes() }), /malformed/);
  }
  for (const key of ["currentValue", "category", "_meta"]) {
    const option = Object.defineProperty(booleanConfig(), key, { enumerable: true, get() { assert.fail("must not execute boolean getters"); } });
    assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [option] }), /malformed/);
  }
});

test("boolean payloads retain every existing size fence, including ignored extensions", () => {
  const nested: Record<string, unknown> = {}; let cursor = nested;
  for (let n = 0; n < limits.depth + 1; n++) { const next = {}; cursor.child = next; cursor = next; }
  const extra = [nested, Object.fromEntries(Array.from({ length: limits.recordKeys + 1 }, (_, n) => [`k${n}`, false])),
    Array(limits.arrayItems + 1).fill(false), Array.from({ length: limits.arrayItems }, () => Array(limits.arrayItems).fill(false)),
    Array(20).fill("x".repeat(limits.string)), { text: "x".repeat(limits.string + 1) }, { text: "bad\ntext" }];
  for (const vendor of extra) assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [
    { ...booleanConfig(), vendor }] }), /malformed/);
  for (const option of [{ ...booleanConfig(), id: "x".repeat(limits.id + 1) },
    { ...booleanConfig(), description: "é".repeat(limits.string) }, { ...booleanConfig(), category: "bad\tcategory" }]) {
    assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [option] }), /malformed/);
  }
  const options = Array.from({ length: limits.configOptions }, (_, n) => ({ ...booleanConfig(n % 2 === 0), id: `toggle-${n}` }));
  assert.equal(decodeAcpSession({ sessionId: "fixture", configOptions: options }).configOptions.length, limits.configOptions);
  assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [...options, booleanConfig()] }), /malformed/);
});

test("duplicate IDs are rejected across boolean, select and unknown types in either order", () => {
  const variants = [booleanConfig(), { ...config(), id: "toggle" }, { id: "toggle", name: "Future", type: "future" }];
  for (const first of variants) for (const second of variants) {
    assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [first, second] }), /malformed/);
  }
});

test("unknown types stay explicit, ordered and deduplicated while known boolean reports survive", () => {
  const unknown = (id: string, type: string) => ({ id, name: "Future", type, currentValue: false });
  const decoded = decodeAcpSession({ sessionId: "fixture", configOptions: [unknown("a", "future-b"), booleanConfig(false),
    unknown("b", "future-a"), unknown("c", "future-b")], models: legacyModels() });
  assert.deepEqual(decoded.unsupportedConfigTypes, ["future-b", "future-a"]);
  assert.deepEqual(decoded.configOptions, [booleanConfig(false)]);
  assert.equal(decoded.models, null);
  assert.throws(() => decodeAcpSession({ sessionId: "fixture", configOptions: [
    { ...unknown("a", "future"), description: false }] }), /malformed/);
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
  for (const reply of ordinaryInitializeReplies()) {
    const rpc = new FakeRpc();
    rpc.answer = () => reply;
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
    assert.deepEqual(result.initialization, decodeAcpInitialize(initialization()));
  }
});

test("optional discovery creates only a fresh session with no MCP servers or prompt", async () => {
  for (const reply of ordinaryInitializeReplies()) {
    const rpc = new FakeRpc();
    const answer = rpc.answer;
    rpc.answer = (method) => method === "initialize" ? reply : answer(method);
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.sessionStatus, "reported");
    assert.deepEqual(rpc.requests.map((v) => v.method), ["initialize", "session/new"]);
    assert.deepEqual(rpc.requests[1].params, { cwd: "/fixture/fresh", mcpServers: [] });
    assert.equal(result.session?.models?.current, "fixture-a");
    assert.deepEqual(rpc.notifications, []);
    assert.equal(result.status, "reported"); assert.equal(result.runtimeClosed, true);
    assert.deepEqual(result.initialization, decodeAcpInitialize(initialization()));
    assert.deepEqual(rpc.requests[0].params, { protocolVersion: 1,
      clientInfo: { name: "governcode-discovery", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } } });
  }
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
  for (const { reply, expected } of [
    { reply: { protocolVersion: 2, agentCapabilities: {} }, expected: "unsupported" },
    { reply: {}, expected: "missing" }, { reply: { protocolVersion: "1" }, expected: "malformed" },
    ...refusedInitializeReplies()]) {
    const rpc = new FakeRpc(); rpc.answer = () => reply;
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, expected); assert.equal(result.initialization, null);
    assert.deepEqual(rpc.requests.map((v) => v.method), ["initialize"]);
    assert.equal(rpc.events.at(-1), "closed");
    assert.deepEqual(result, { evidence: "agent-reported", status: expected, initialization: null,
      session: null, sessionStatus: "not-requested", runtimeClosed: true });
    assert.deepEqual(rpc.notifications, []);
    assert.equal(rpc.events.filter((v) => v === "close").length, 1);
  }
});

for (const stop of ["cancelled", "timeout"] as const) for (const shape of ["v1", "info", "malformed"] as const) {
  for (const replyFirst of [false, true]) {
    test(`deferred ${shape} initialize queued ${replyFirst ? "before" : "after"} ${stop} publishes no metadata`, async (t) => {
      let now = 100;
      if (stop === "timeout") t.mock.method(performance, "now", () => now);
      const rpc = new FakeRpc(); rpc.autoClose = false;
      const controller = new AbortController(), entered = deferred<void>(), reply = deferred<unknown>();
      rpc.answer = () => { entered.resolve(); return reply.promise; };
      let returned = false;
      const pending = discoverAcp(rpc, { ...freshOptions, signal: controller.signal, timeoutMs: 10_000 })
        .then((result) => { returned = true; return result; });
      await entered.promise;
      const settle = () => reply.resolve(shape === "v1" ? initialization() : shape === "info" ? infoReply() :
        { ...infoReply(), protocolVersion: "1" });
      if (replyFirst) settle();
      if (stop === "cancelled") controller.abort();
      else now += 10_000; // Expire the monotonic deadline without running the timer callback.
      if (!replyFirst) settle();
      await rpc.closeEntered.promise;
      await budgetTurn(); assert.equal(returned, false);
      rpc.finishClose(); const result = await pending;
      assert.deepEqual(result, { evidence: "agent-reported", status: stop, initialization: null,
        session: null, sessionStatus: "not-requested", runtimeClosed: true });
      assert.deepEqual(rpc.requests.map((r) => r.method), ["initialize"]);
      assert.deepEqual(rpc.notifications, []);
      assert.equal(rpc.events.filter((v) => v === "close").length, 1);
    });
  }
}

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
    [{ sessionId: "fixture", configOptions: [{ id: "b", name: "B", type: "boolean", currentValue: false }] }, "reported"],
    [{ sessionId: "fixture", configOptions: [{ id: "b", name: "B", type: "future", currentValue: false }] }, "unsupported"],
    [{ sessionId: "fixture", configOptions: [config(), config()] }, "malformed"]] as const) {
    const rpc = new FakeRpc(); rpc.answer = (method) => method === "initialize" ? initialization() : reply;
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, expected); assert.equal(result.sessionStatus, expected);
    assert.equal(result.runtimeClosed, true);
  }
});

test("boolean discovery reports known values and mixed unknowns without enabling client actions", async () => {
  for (const currentValue of [true, false]) for (const unknown of [false, true]) {
    const rpc = new FakeRpc();
    const options = [booleanConfig(currentValue), config(), config("mode")];
    const configOptions = unknown ? [...options, { id: "future", name: "Future", type: "future" }] : options;
    const reply = { sessionId: "fixture", configOptions, models: legacyModels() };
    rpc.answer = (method) => method === "initialize" ? initialization() : reply;
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, unknown ? "unsupported" : "reported");
    assert.equal(result.sessionStatus, result.status);
    assert.equal(result.evidence, "agent-reported"); assert.equal(result.runtimeClosed, true);
    assert.deepEqual(result.session?.configOptions, options);
    assert.deepEqual(result.session?.unsupportedConfigTypes, unknown ? ["future"] : []);
    assert.deepEqual(rpc.requests.map((r) => ({ method: r.method, params: r.params })), [
      { method: "initialize", params: { protocolVersion: 1,
        clientInfo: { name: "governcode-discovery", version: "0.1.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } } } },
      { method: "session/new", params: { cwd: "/fixture/fresh", mcpServers: [] } },
    ]);
    assert.deepEqual(rpc.notifications, []);
  }
});

test("malformed boolean discovery reports malformed with no legacy rescue or partial session", async () => {
  for (const currentValue of [null, "false", 0, [], {}]) {
    const rpc = new FakeRpc();
    rpc.answer = (method) => method === "initialize" ? initialization() : {
      sessionId: "fixture", configOptions: [config(), { ...booleanConfig(), currentValue }], models: legacyModels() };
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, "malformed"); assert.equal(result.sessionStatus, "malformed");
    assert.equal(result.session, null); assert.ok(result.initialization);
    assert.deepEqual(rpc.requests.map((r) => r.method), ["initialize", "session/new"]);
    assert.deepEqual(rpc.notifications, []);
  }
});

for (const stop of ["cancelled", "timeout"] as const) for (const malformed of [false, true]) {
  for (const replyFirst of [false, true]) {
    test(`deferred ${malformed ? "malformed" : "valid"} boolean reply ${replyFirst ? "queued before" : "after"} ${stop} cannot publish session metadata`, async (t) => {
      if (stop === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
      const rpc = new FakeRpc(); rpc.autoClose = false;
      const controller = new AbortController(), entered = deferred<void>(), reply = deferred<unknown>();
      rpc.answer = (method) => {
        if (method === "initialize") return initialization();
        entered.resolve(); return reply.promise;
      };
      let returned = false;
      const pending = discoverAcp(rpc, { ...freshOptions, signal: controller.signal, timeoutMs: 10_000 })
        .then((result) => { returned = true; return result; });
      await entered.promise;
      const settle = () => reply.resolve({ sessionId: "fixture", configOptions: [
        { ...booleanConfig(false), currentValue: malformed ? "false" : false }] });
      if (replyFirst) settle();
      if (stop === "cancelled") controller.abort();
      else t.mock.timers.tick(10_000);
      await rpc.closeEntered.promise;
      if (!replyFirst) settle();
      await budgetTurn();
      assert.equal(returned, false);
      rpc.finishClose(); const result = await pending;
      assert.equal(result.status, stop); assert.equal(result.sessionStatus, stop);
      assert.equal(result.session, null); assert.ok(result.initialization);
      assert.equal(result.evidence, "agent-reported"); assert.equal(result.runtimeClosed, true);
      assert.deepEqual(rpc.requests.map((r) => r.method), ["initialize", "session/new"]);
      assert.deepEqual(rpc.notifications, []);
      assert.equal(rpc.events.filter((v) => v === "close").length, 1);
    });
  }
}

test("a boolean session success waits for closure and cancellation there retains only reported evidence", async () => {
  for (const cancel of [false, true]) {
    const rpc = new FakeRpc(); rpc.autoClose = false;
    const controller = new AbortController(), reply = { sessionId: "fixture", configOptions: [booleanConfig(false)] };
    rpc.answer = (method) => method === "initialize" ? initialization() : reply;
    let returned = false;
    const pending = discoverAcp(rpc, { ...freshOptions, signal: controller.signal })
      .then((result) => { returned = true; return result; });
    await rpc.closeEntered.promise;
    await budgetTurn(); assert.equal(returned, false);
    if (cancel) controller.abort();
    rpc.finishClose(); const result = await pending;
    assert.equal(result.status, cancel ? "cancelled" : "reported"); assert.equal(result.sessionStatus, result.status);
    assert.deepEqual(result.session, { source: "configOptions", configOptions: [booleanConfig(false)],
      unsupportedConfigTypes: [], models: null, modes: null });
    assert.equal(result.evidence, "agent-reported"); assert.equal(result.runtimeClosed, true);
    assert.deepEqual(rpc.requests.map((r) => r.method), ["initialize", "session/new"]);
    assert.deepEqual(rpc.notifications, []);
  }
});

test("boolean reports still reject broken, rejected or throwing closure contracts", async () => {
  for (const kind of ["unconfirmed", "rejected", "throwing"]) {
    const rpc = new FakeRpc(); rpc.autoClose = false;
    rpc.answer = (method) => method === "initialize" ? initialization() : { sessionId: "fixture", configOptions: [booleanConfig()] };
    if (kind === "throwing") rpc.close = () => { rpc.closeEntered.resolve(); rpc.finishClose(); throw new Error("Invented close failure"); };
    const pending = assert.rejects(discoverAcp(rpc, { ...freshOptions, cleanupTimeoutMs: 10 }), AcpDiscoveryCleanupError);
    await rpc.closeEntered.promise;
    if (kind === "rejected") rpc.closing.reject(new Error("Invented closure failure"));
    await pending;
    if (kind !== "throwing") rpc.finishClose();
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

test("success, refused info, malformed reply, timeout and cancel cannot return before runtime closure or caller cleanup", async () => {
  for (const kind of ["success", "info", "malformed", "timeout", "cancel"]) {
    const rpc = new FakeRpc(); rpc.autoClose = false;
    const controller = new AbortController();
    if (kind === "malformed") rpc.answer = () => [];
    if (kind === "info") rpc.answer = () => infoReply();
    if (kind === "timeout" || kind === "cancel") rpc.answer = () => new Promise<never>(() => {});
    let returned = false;
    // Only the timeout case may reach the deadline; the others answer at once, even on a busy machine.
    const pending = discoverAcp(rpc, { cwd: "/fixture", signal: controller.signal, timeoutMs: kind === "timeout" ? 10 : 10_000, cleanupTimeoutMs: 500 })
      .then((result) => { returned = true; rpc.events.push("caller-cleanup"); return result; });
    if (kind === "cancel") controller.abort();
    await rpc.closeEntered.promise;
    await budgetTurn();
    assert.equal(returned, false, kind); assert.ok(rpc.events.includes("close"));
    rpc.finishClose(); const result = await pending;
    assert.deepEqual(rpc.events.slice(-2), ["closed", "caller-cleanup"]);
    assert.equal(result.status, kind === "success" ? "reported" : kind === "info" ? "unsupported" :
      kind === "cancel" ? "cancelled" : kind === "timeout" ? "timeout" : "malformed");
    assert.equal(result.runtimeClosed, true);
    if (kind === "info") assert.deepEqual(result, { evidence: "agent-reported", status: "unsupported",
      initialization: null, session: null, sessionStatus: "not-requested", runtimeClosed: true });
  }
});

test("ordinary and refused initialize results still reject unconfirmed, rejected or throwing closure", async () => {
  for (const reply of [initialization(), infoReply()]) for (const kind of ["unconfirmed", "rejected", "throwing"]) {
    const rpc = new FakeRpc(); rpc.autoClose = false; rpc.answer = () => reply;
    if (kind === "throwing") rpc.close = () => { rpc.closeEntered.resolve(); rpc.finishClose(); throw new Error("Invented close failure"); };
    const pending = assert.rejects(discoverAcp(rpc, { ...freshOptions, createSession: false, cleanupTimeoutMs: 10 }), AcpDiscoveryCleanupError);
    await rpc.closeEntered.promise;
    if (kind === "rejected") rpc.closing.reject(new Error("Invented closure failure"));
    await pending;
    if (kind !== "throwing") rpc.finishClose();
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
  for (const reply of [initialization(), infoReply()]) for (const kind of ["request", "flood", "cancel"]) {
    const rpc = new FakeRpc(); rpc.autoClose = false;
    rpc.answer = () => reply;
    const controller = new AbortController();
    const pending = discoverAcp(rpc, { cwd: "/fixture", cleanupTimeoutMs: 500, signal: controller.signal });
    await rpc.closeEntered.promise;
    if (kind === "request") await assert.rejects(rpc.reqHandler("fs/read_text_file", {}));
    else if (kind === "cancel") controller.abort();
    else for (let n = 0; n <= limits.notifications; n++) rpc.noteHandler("unknown", {});
    rpc.finishClose(); const result = await pending;
    assert.equal(result.status, kind === "request" ? "forbidden-request" : kind === "cancel" ? "cancelled" : "notification-flood");
    assert.equal(result.initialization === null, Object.hasOwn(reply, "info"));
    assert.equal(result.session, null); assert.equal(result.sessionStatus, "not-requested");
    assert.equal(result.runtimeClosed, true);
    assert.deepEqual(rpc.requests.map((r) => r.method), ["initialize"]);
    assert.deepEqual(rpc.notifications, []);
  }
});


class BudgetRpc extends FakeRpc {
  budget = deferred<AcpOutputBudgetError | null>();
  failure: AcpOutputBudgetError | null = null;
  outputBudget: NonNullable<AcpRpc["outputBudget"]>;
  constructor() {
    super();
    const owner = this;
    this.outputBudget = { get failure() { return owner.failure; }, settled: this.budget.promise };
  }
  breach() {
    this.failure ??= new AcpOutputBudgetError(128, "stderr");
    this.budget.resolve(this.failure);
  }
}

test("pre-existing local budget failure prevents all discovery requests", async () => {
  const rpc = new BudgetRpc(); rpc.breach();
  const result = await discoverAcp(rpc, freshOptions);
  assert.equal(result.status, "output-budget-exceeded"); assert.equal(result.runtimeClosed, true);
  assert.deepEqual(rpc.requests, []); assert.deepEqual(rpc.events, ["close", "closed"]);
  assert.equal(JSON.stringify(result).includes("stack"), false);
});

test("local breach interrupts initialize or session even when a supplied request ignores rejection", async () => {
  for (const stage of ["initialize", "session/new"]) {
    const rpc = new BudgetRpc();
    rpc.answer = (method) => {
      if (method !== stage) return initialization();
      rpc.breach(); return new Promise<never>(() => {});
    };
    const result = await discoverAcp(rpc, freshOptions);
    assert.equal(result.status, "output-budget-exceeded"); assert.equal(result.runtimeClosed, true);
    assert.equal(rpc.requests.length, stage === "initialize" ? 1 : 2);
    if (stage === "session/new") {
      assert.ok(result.initialization); assert.equal(result.sessionStatus, "output-budget-exceeded");
    }
    assert.equal(rpc.events.filter((e) => e === "close").length, 1);
  }
});

test("actual transport latch wins between fulfilled reply and discovery continuation", async () => {
  for (const { stage, reply } of [{ stage: "initialize", reply: initialization() },
    { stage: "initialize", reply: infoReply() }, { stage: "session/new", reply: { sessionId: "fixture", configOptions: [config()] } }]) {
    const f = budgetFixture(2000);
    const pending = discoverAcp(f.rpc, { ...freshOptions, cleanupTimeoutMs: 500 });
    await budgetTurn();
    if (stage === "session/new") {
      f.out(budgetMessage({ id: 1, result: initialization() })); await budgetTurn();
    }
    f.out(budgetMessage({ id: stage === "initialize" ? 1 : 2,
      result: reply }));
    // Fulfillment was admitted, but the awaiting metadata decoder has not run yet.
    f.err(Buffer.alloc(2001)); f.finish();
    const result = await pending;
    assert.equal(result.status, "output-budget-exceeded");
    assert.equal(result.initialization === null, stage === "initialize"); assert.equal(result.session, null);
    assert.equal(f.writes.length, stage === "initialize" ? 1 : 2);
    assert.equal(f.signals.length, 1);
    assert.equal(result.sessionStatus, stage === "initialize" ? "not-requested" : "output-budget-exceeded");
    assert.equal(result.runtimeClosed, true);
    assert.deepEqual(f.writes.map((line) => JSON.parse(line).method), stage === "initialize" ? ["initialize"] : ["initialize", "session/new"]);
  }
});

test("breach after success or info refusal during ordinary cleanup preserves partial evidence and overrides status", async () => {
  for (const reply of [initialization(), infoReply()]) {
    const f = budgetFixture(2000), pending = discoverAcp(f.rpc, { cwd: "/fixture", cleanupTimeoutMs: 500 });
    await budgetTurn(); f.out(budgetMessage({ id: 1, result: reply })); await budgetTurn();
    assert.equal(f.signals.length, 1); // discovery's ordinary close(100) has already started
    f.err(Buffer.alloc(2001)); assert.equal(f.signals.length, 1);
    let returned = false; void pending.then(() => { returned = true; });
    await budgetTurn(); assert.equal(returned, false);
    f.finish(); const result = await pending;
    assert.equal(result.status, "output-budget-exceeded");
    if (!Object.hasOwn(reply, "info")) assert.ok(result.initialization);
    else assert.equal(result.initialization, null);
    assert.equal(result.runtimeClosed, true);
    assert.equal(result.session, null); assert.equal(result.sessionStatus, "not-requested");
    assert.deepEqual(f.writes.map((line) => JSON.parse(line).method), ["initialize"]);
  }
});

test("actual transport budget failure before boolean interpretation prevents valid or malformed publication", async () => {
  for (const malformed of [false, true]) {
    const f = budgetFixture(2000), pending = discoverAcp(f.rpc, { ...freshOptions, cleanupTimeoutMs: 500 });
    await budgetTurn(); f.out(budgetMessage({ id: 1, result: initialization() })); await budgetTurn();
    f.out(budgetMessage({ id: 2, result: { sessionId: "fixture", configOptions: [
      { ...booleanConfig(), currentValue: malformed ? "true" : true }] } }));
    f.err(Buffer.alloc(2001)); f.finish(); const result = await pending;
    assert.equal(result.status, "output-budget-exceeded"); assert.equal(result.sessionStatus, result.status);
    assert.equal(result.session, null); assert.ok(result.initialization);
    assert.equal(f.writes.length, 2); assert.equal(f.signals.length, 1);
  }
});

test("actual transport budget breach during boolean report closure overrides success and preserves evidence", async () => {
  const f = budgetFixture(2000), reply = { sessionId: "fixture", configOptions: [booleanConfig(false)] };
  const pending = discoverAcp(f.rpc, { ...freshOptions, cleanupTimeoutMs: 500 });
  await budgetTurn(); f.out(budgetMessage({ id: 1, result: initialization() })); await budgetTurn();
  f.out(budgetMessage({ id: 2, result: reply })); await budgetTurn();
  assert.equal(f.signals.length, 1);
  let returned = false; void pending.then(() => { returned = true; });
  f.err(Buffer.alloc(2001)); await budgetTurn(); assert.equal(returned, false);
  f.finish(); const result = await pending;
  assert.equal(result.status, "output-budget-exceeded"); assert.equal(result.sessionStatus, result.status);
  assert.deepEqual(result.session, { source: "configOptions", configOptions: [booleanConfig(false)],
    unsupportedConfigTypes: [], models: null, modes: null });
  assert.equal(result.evidence, "agent-reported"); assert.equal(result.runtimeClosed, true);
  assert.deepEqual(f.writes.map((line) => JSON.parse(line).method), ["initialize", "session/new"]);
  assert.equal(f.signals.length, 1);
});

test("local failure during cleanup overrides timeout, protocol errors and forbidden-request status", async () => {
  for (const kind of ["timeout", "protocol", "request"]) {
    const rpc = new BudgetRpc(); rpc.autoClose = false;
    rpc.answer = () => {
      if (kind === "protocol") throw Object.assign(new Error("fixture"), { code: -32000 });
      if (kind === "request") void rpc.reqHandler("fixture", {}).catch(() => {});
      return new Promise<never>(() => {});
    };
    const pending = discoverAcp(rpc, { cwd: "/fixture", timeoutMs: 5, cleanupTimeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.ok(rpc.events.includes("close"));
    rpc.breach(); rpc.finishClose();
    assert.equal((await pending).status, "output-budget-exceeded");
  }
});

test("unconfirmed closure still throws cleanup error after a local budget breach", async () => {
  for (const reject of [false, true]) {
    const rpc = new BudgetRpc(); rpc.autoClose = false;
    rpc.answer = () => { rpc.breach(); if (reject) rpc.closing.reject(new Error("fixture closure failure")); return new Promise<never>(() => {}); };
    await assert.rejects(discoverAcp(rpc, { cwd: "/fixture", cleanupTimeoutMs: 5 }), AcpDiscoveryCleanupError);
    rpc.finishClose();
  }
});

test("peer codes, messages or error classes cannot manufacture local budget status", async () => {
  for (const error of [new AcpOutputBudgetError(128, "stdout"),
    Object.assign(new Error("ACP output byte budget exceeded"), { code: "ACP_OUTPUT_BUDGET_EXCEEDED" })]) {
    const rpc = new BudgetRpc(); rpc.answer = () => { throw error; };
    const result = await discoverAcp(rpc, { cwd: "/fixture" });
    assert.equal(result.status, "error"); assert.equal(rpc.failure, null);
  }
  const f = budgetFixture(1000), pending = discoverAcp(f.rpc, { cwd: "/fixture" });
  await budgetTurn();
  f.out(budgetMessage({ id: 1, error: { code: "ACP_OUTPUT_BUDGET_EXCEEDED", message: "ACP output byte budget exceeded" } }));
  await budgetTurn(); f.finish(); assert.equal((await pending).status, "error");
  assert.equal(await f.rpc.outputBudget!.settled, null);
});

test("post-breach child error without native closure still fails discovery cleanup", async () => {
  const f = budgetFixture(1);
  const pending = assert.rejects(discoverAcp(f.rpc, { cwd: "/fixture", cleanupTimeoutMs: 20 }), AcpDiscoveryCleanupError);
  await budgetTurn();
  f.err("xx"); f.child.emit("error", new Error("private fixture error"));
  try { await pending; }
  finally { f.finish(); await f.rpc.closed; }
});
