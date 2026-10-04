import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { startAcp, AcpOutputBudgetError, type AcpOutputBudget } from "../src/acp.ts";
import { fakeNative, fixture, options, message, turn } from "./fixtures/acp-output-budget.ts";

const rejectsBudget = (promise: Promise<unknown>, f: ReturnType<typeof fixture>) =>
  assert.rejects(promise, (error) => error === f.rpc.outputBudget!.failure && error instanceof AcpOutputBudgetError);

test("budget validation refuses shapes, accessors and proxies without spawning or calling getters", () => {
  const getter = Object.defineProperty({}, "maxBytes", { get() { assert.fail("getter executed"); } });
  const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("private fixture detail"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const invalid of [null, [], true, "100", {}, { maxBytes: "1" }, { maxBytes: false },
    ...[0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 1_048_577].map((maxBytes) => ({ maxBytes })),
    { maxBytes: 1, extra: 0 }, { maxBytes: 1, [Symbol()]: 0 }, getter, proxy, revoked.proxy, new Date(),
    Object.create({ maxBytes: 1 })]) {
    const f = fakeNative();
    assert.throws(() => startAcp({ ...options, outputBudget: invalid as AcpOutputBudget }, f.native),
      (e) => e instanceof Error && e.message === "Invalid ACP output budget configuration" && !("cause" in e));
    assert.equal(f.spawns, 0); assert.equal(f.signals.length, 0);
  }
  const f = fakeNative();
  const accessor = Object.defineProperty({ ...options }, "outputBudget", { get() { assert.fail("option getter executed"); } });
  assert.throws(() => startAcp(accessor, f.native), /Invalid ACP output budget configuration/);
  assert.equal(f.spawns, 0);
});

test("accepted caps are copied before spawn, including null-prototype records and hard maximum", async () => {
  for (const budget of [{ maxBytes: 1 }, Object.assign(Object.create(null), { maxBytes: 1_048_576 })]) {
    const f = fakeNative(), original = budget.maxBytes;
    const rpc = startAcp({ ...options, outputBudget: budget }, f.native);
    budget.maxBytes = 1_048_576 * 2;
    f.err(Buffer.alloc(original)); assert.equal(rpc.outputBudget!.failure, null);
    f.err("x"); assert.equal(rpc.outputBudget!.failure!.limitBytes, original);
    f.finish(); await rpc.closed;
  }
});

test("an ordinary options object with an inherited proxy is rejected without any traps", () => {
  let traps = 0;
  const trap = () => { traps++; throw new Error("private proxy detail"); };
  const proxy = new Proxy({}, { has: trap, get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  // Build own options without invoking a setter on the proxy prototype.
  for (const prototype of [proxy, Object.create(proxy)]) {
    const input = Object.create(prototype, Object.getOwnPropertyDescriptors(options));
    const f = fakeNative();
    assert.throws(() => startAcp(input, f.native),
      (e) => e instanceof Error && e.message === "Invalid ACP output budget configuration" && !("cause" in e));
    assert.equal(traps, 0); assert.equal(f.spawns, 0); assert.equal(f.signals.length, 0);
  }
  const f = fakeNative(), inherited = Object.create({ outputBudget: { maxBytes: 1 } }, Object.getOwnPropertyDescriptors(options));
  assert.throws(() => startAcp(inherited, f.native), /Invalid ACP output budget configuration/);
  assert.equal(f.spawns, 0);
});

test("combined raw equality admits whole chunks and the next byte on either stream breaches", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const f = fixture(10); f.out("noise\n"); f.err("1234");
    assert.equal(f.rpc.outputBudget!.failure, null);
    (stream === "stdout" ? f.out : f.err)("x");
    const error = f.rpc.outputBudget!.failure!;
    assert.equal(error.stream, stream); assert.equal(error.limitBytes, 10);
    assert.equal(error.code, "ACP_OUTPUT_BUDGET_EXCEEDED");
    assert.equal(error.message, "ACP output byte budget exceeded");
    assert.equal(await f.rpc.outputBudget!.settled, error);
    assert.equal(f.child.stdout.destroyed, true); assert.equal(f.child.stderr.destroyed, true); assert.equal(f.child.stdin.destroyed, true);
    f.child.stdout.emit("error", new Error("fixture")); f.child.stderr.emit("error", new Error("fixture"));
    f.finish(); assert.equal(await f.rpc.exited, error.message);
  }
});

test("responses, invalid UTF-8, malformed lines, ignored envelopes and tail eviction consume lifetime bytes", async () => {
  const f = fixture(5000), pending = f.rpc.request("fixture", {});
  const response = Buffer.from(message({ id: 1, result: "ok" }));
  f.out(response); assert.equal(await pending, "ok");
  const noise = Buffer.from([0xff, 0xfe, 10, 123, 10]); f.out(noise);
  const ignored = Buffer.from('{"jsonrpc":"1.0"}\n'); f.out(ignored);
  f.err(Buffer.alloc(5000 - response.length - noise.length - ignored.length, 120));
  assert.equal(f.rpc.outputBudget!.failure, null);
  f.err("x"); assert.ok(f.rpc.outputBudget!.failure); f.finish();
});

test("breaching chunks do no decoding, parsing or tail copying, even above the old line cap", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const f = fixture(64), huge = Buffer.alloc(8 * 1024 * 1024 + 1, 120);
    const decode = mock.method(StringDecoder.prototype, "write"), parse = mock.method(JSON, "parse"), copy = mock.method(Buffer, "from"), concat = mock.method(Buffer, "concat");
    try {
      (stream === "stdout" ? f.out : f.err)(huge);
      assert.equal(decode.mock.callCount(), 0); assert.equal(parse.mock.callCount(), 0); assert.equal(copy.mock.callCount(), 0); assert.equal(concat.mock.callCount(), 0);
    } finally { decode.mock.restore(); parse.mock.restore(); copy.mock.restore(); concat.mock.restore(); f.finish(); }
  }
});

test("split two- and four-byte UTF-8 decodes at every boundary; unterminated lines remain ignored", async () => {
  for (const char of ["é", "😀"]) for (let split = 1; split < Buffer.byteLength(char); split++) {
    const line = Buffer.from(message({ method: "fixture", params: { text: char } }));
    const at = line.indexOf(Buffer.from(char)) + split, f = fixture(line.length);
    const notes: unknown[] = []; f.rpc.onNotify((_m, p) => notes.push(p));
    f.out(line.subarray(0, at)); f.out(line.subarray(at));
    assert.deepEqual(notes, [{ text: char }]); assert.equal(f.rpc.outputBudget!.failure, null);
    f.out("x"); assert.ok(f.rpc.outputBudget!.failure); f.finish();
  }
  const f = fixture(200), notes: unknown[] = [];
  f.rpc.onNotify((_m, p) => notes.push(p));
  f.out(Buffer.from(message({ method: "fixture", params: {} }).trimEnd()));
  f.finish(); assert.deepEqual(notes, []); assert.equal(await f.rpc.outputBudget!.settled, null);
});

test("same breaching chunk delivers no responses, requests or notifications", async () => {
  const chunk = message({ id: 1, result: "ok" }) + message({ id: "peer", method: "fixture" }) + message({ method: "fixture" });
  const f = fixture(Buffer.byteLength(chunk) - 1);
  let callbacks = 0; f.rpc.onNotify(() => callbacks++); f.rpc.onRequest(async () => { callbacks++; return null; });
  const pending = f.rpc.request("fixture", {}), rejected = rejectsBudget(pending, f);
  f.out(chunk); await rejected; await turn();
  assert.equal(callbacks, 0); assert.equal(f.writes.length, 1); f.finish();
});

test("reentrant stderr breach stops the remainder of an already admitted stdout chunk", async () => {
  const chunk = message({ method: "first" }) + message({ id: "peer", method: "second" }) + message({ method: "third" });
  const f = fixture(Buffer.byteLength(chunk)); const calls: string[] = [];
  f.rpc.onNotify((m) => { calls.push(m); f.err("x"); });
  f.rpc.onRequest(async (m) => { calls.push(m); return null; });
  f.out(chunk); await turn(); assert.deepEqual(calls, ["first"]); assert.equal(f.writes.length, 0); f.finish();
});

test("pending timers clear, future work is inert and later lifecycle errors cannot replace the latch", async () => {
  const f = fixture(1), clear = mock.method(globalThis, "clearTimeout"), timers = mock.method(globalThis, "setTimeout");
  try {
    const first = f.rpc.request("one", {}, 30_000), second = f.rpc.request("two", {}, 30_000);
    const rejected = Promise.all([rejectsBudget(first, f), rejectsBudget(second, f)]);
    f.err("xx"); await rejected; assert.equal(clear.mock.callCount(), 2); assert.equal(timers.mock.callCount(), 3);
    const writes = f.writes.length;
    const circular: any = {}; circular.self = circular;
    await rejectsBudget(f.rpc.request("future", circular, 30_000), f);
    f.rpc.notify("future", circular); assert.equal(f.writes.length, writes);
    assert.equal(clear.mock.callCount(), 2); assert.equal(timers.mock.callCount(), 3);
    let closed = false; void f.rpc.closed.then(() => { closed = true; }); await turn(); assert.equal(closed, false);
    f.child.emit("error", new Error("private peer detail")); f.finish(1);
    await rejectsBudget(f.rpc.request("after exit", {}), f);
    assert.equal(await f.rpc.exited, "ACP output byte budget exceeded");
  } finally { clear.mock.restore(); timers.mock.restore(); f.finish(); }
});

test("late request fulfillments and rejections skip result serialization and error formatting", async () => {
  for (const reject of [false, true]) {
    const f = fixture(100); let done!: (v: any) => void;
    f.rpc.onRequest(() => new Promise((ok, fail) => { done = reject ? fail : ok; }));
    f.out(message({ id: "peer", method: "fixture" })); f.err(Buffer.alloc(100));
    const dangerous: any = Object.defineProperty({}, "toJSON", { get() { assert.fail("late serialization"); } });
    dangerous.self = dangerous;
    if (reject) Object.defineProperty(dangerous, "toString", { get() { assert.fail("late error formatting"); } });
    done(dangerous); await turn(); assert.equal(f.writes.length, 0); f.finish();
  }
});

test("a post-breach child error cannot confirm native closure or cancel escalation", async () => {
  const f = fixture(1); mock.timers.enable({ apis: ["setTimeout"] });
  let exited = false, closed = false;
  void f.rpc.exited.then(() => { exited = true; }); void f.rpc.closed.then(() => { closed = true; });
  try {
    f.err("xx");
    const failure = f.rpc.outputBudget!.failure;
    f.child.emit("error", new Error("private fixture error")); await turn();
    assert.equal(exited, false); assert.equal(closed, false);
    assert.equal(await f.rpc.outputBudget!.settled, failure);
    assert.deepEqual(f.signals.map((s) => s.signal), ["SIGTERM"]);
    mock.timers.tick(60_000);
    assert.deepEqual(f.signals.map((s) => s.signal), ["SIGTERM", "SIGKILL"]);
    assert.equal(exited, false); assert.equal(closed, false);
    f.child.emit("exit", null); await turn();
    assert.equal(exited, true); assert.equal(closed, false);
    assert.equal(await f.rpc.exited, "ACP output byte budget exceeded");
    f.child.emit("close", null); await f.rpc.closed; await turn();
    assert.equal(closed, true);
  } finally { mock.timers.reset(); f.finish(); }
});

test("send rechecks the latch after serialization triggers a reentrant breach", async () => {
  const f = fixture(1);
  f.rpc.notify("fixture", { toJSON() { f.err("xx"); return {}; } });
  assert.equal(f.writes.length, 0); assert.ok(f.rpc.outputBudget!.failure); f.finish();
});

test("budget stop owns one termination and escalation; a prior close preserves its timer", async () => {
  for (const prior of [false, true]) {
    const f = fixture(1); mock.timers.enable({ apis: ["setTimeout"] });
    try {
      if (prior) f.rpc.close(100);
      f.err("xx"); f.out("again"); f.rpc.close(1); f.rpc.close(100);
      assert.deepEqual(f.signals.map((s) => s.signal), ["SIGTERM"]);
      mock.timers.tick(prior ? 99 : 59_999); assert.equal(f.signals.length, 1);
      mock.timers.tick(1); assert.deepEqual(f.signals.map((s) => s.signal), ["SIGTERM", "SIGKILL"]);
      f.finish(); await f.rpc.closed; await turn(); mock.timers.tick(60_000); assert.equal(f.signals.length, 2);
    } finally { mock.timers.reset(); f.finish(); }
  }
});

test("copied stderr tail is bounded to 4096 raw bytes and a UTF-8 cut can begin with replacement", async () => {
  const f = fixture(10_000), bytes = Buffer.concat([Buffer.from("😀"), Buffer.alloc(4095, 120)]);
  f.err(bytes); bytes.fill(121); f.finish();
  assert.equal(await f.rpc.exited, "�" + "x".repeat(4095));
  assert.equal(await f.rpc.outputBudget!.settled, null);
  const small = fixture(3); small.err("abc"); small.finish(); assert.equal(await small.rpc.exited, "abc");
});

test("ordinary opted-in responses, errors, timeouts and native closure keep lifecycle semantics", async () => {
  const f = fixture(1000), p = f.rpc.request("fixture", {});
  f.out(message({ id: "1", result: 42 })); assert.equal(await p, 42);
  const q = f.rpc.request("fixture", {}); f.out(message({ id: 2, error: { code: -32601, message: "fixture error" } }));
  await assert.rejects(q, /fixture error/);
  await assert.rejects(f.rpc.request("fixture", {}, 5), /no answer/);
  f.err("fixture diagnostic"); f.finish(2); assert.equal(await f.rpc.exited, "fixture diagnostic");
  assert.equal(await f.rpc.outputBudget!.settled, null); await assert.rejects(f.rpc.request("gone", {}), /gone/);
  const failed = fixture(50), pending = failed.rpc.request("fixture", {});
  failed.child.emit("error", new Error("fixture spawn failure"));
  await assert.rejects(pending, /did not start/); assert.equal(await failed.rpc.closed, null);
  assert.equal(await failed.rpc.outputBudget!.settled, null);
});

test("omitted budget preserves text encoding, old line drop, stderr retention and repeated close", async () => {
  const f = fixture(); assert.equal("outputBudget" in f.rpc, false); assert.equal(f.child.stdout.readableEncoding, "utf8");
  const notes: string[] = []; f.rpc.onNotify((m) => notes.push(m));
  f.child.stdout.emit("data", "x".repeat(8 * 1024 * 1024 + 1));
  f.child.stdout.emit("data", "discarded\n" + message({ method: "fixture" }));
  assert.deepEqual(notes, ["fixture"]);
  const pending = f.rpc.request("fixture", {}); f.child.stdout.emit("data", message({ id: 1, result: "ok" }));
  assert.equal(await pending, "ok"); f.err("é".repeat(5000));
  f.rpc.close(100); f.rpc.close(100); assert.equal(f.signals.length, 2);
  f.finish(); assert.equal(await f.rpc.exited, "é".repeat(4000));
});

test("independent parent watchdog bounds a separate finite fake-stream worker", async () => {
  const worker = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/acp-output-budget-worker.ts", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  worker.stdout.on("data", (b) => { stdout += b; }); worker.stderr.on("data", (b) => { stderr += b; });
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const result = await new Promise<number | null>((resolve, reject) => {
      watchdog = setTimeout(() => { worker.kill("SIGKILL"); reject(new Error("fixture worker exceeded independent 5s watchdog")); }, 5000);
      worker.on("error", reject); worker.on("close", resolve);
    });
    assert.equal(result, 0, stderr); assert.equal(stdout, "fixture-enforced\n");
  } finally { clearTimeout(watchdog); if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); }
});


test("explicit undefined also selects legacy behavior; invalid UTF-8 keeps replacement decoding", async () => {
  const legacy = fakeNative(), rpc = startAcp({ ...options, outputBudget: undefined }, legacy.native);
  assert.equal("outputBudget" in rpc, false); assert.equal(legacy.child.stdout.readableEncoding, "utf8");
  legacy.finish(); await rpc.closed;
  const prefix = Buffer.from('{"jsonrpc":"2.0","method":"fixture","params":{"text":"');
  const suffix = Buffer.from('"}}\n');
  const f = fixture(prefix.length + 1 + suffix.length), notes: any[] = [];
  f.rpc.onNotify((_m, p) => notes.push(p)); f.out(Buffer.concat([prefix, Buffer.from([0xff]), suffix]));
  assert.deepEqual(notes, [{ text: "�" }]); assert.equal(f.rpc.outputBudget!.failure, null);
  f.err("x"); assert.ok(f.rpc.outputBudget!.failure); f.finish();
});

test("a breached split decoder is discarded without flushing or dispatching queued data", async () => {
  const f = fixture(1), end = mock.method(StringDecoder.prototype, "end");
  let callbacks = 0; f.rpc.onNotify(() => callbacks++);
  try {
    f.out(Buffer.from([0xf0])); f.err("x");
    f.out(Buffer.from([0x9f, 0x98, 0x80, 10])); f.finish();
    assert.equal(end.mock.callCount(), 0); assert.equal(callbacks, 0);
  } finally { end.mock.restore(); }
});
