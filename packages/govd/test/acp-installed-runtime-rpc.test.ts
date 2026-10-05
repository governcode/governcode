// Actual user/Controller sockets and retained inert stores; no artifact/provider launches.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { AcpCatalog } from "../src/acp-catalog.ts";
import { AcpInstaller } from "../src/acp-install.ts";
import { installFingerprint } from "../src/acp-install-plan.ts";
import { ACP_REGISTRY_URL, decodeAcpRegistry, planAcpInstall } from "../src/acp-registry.ts";
import { openControllerSocket, type DelegationContext } from "../src/delegate.ts";

const supported = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
const evidence = await fs.mkdtemp(join(tmpdir(), "acp-installed-rpc-retained-"));
const manifest = join(evidence, "manifest.json");
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = Object.fromEntries(await Promise.all([
  "../src/daemon.ts", "../src/acp-install.ts", "../src/acp-artifact-runtime.ts", "../src/delegate.ts",
  "../src/mcp-controller.ts", "../src/codex.ts", "./acp-installed-runtime-rpc.test.ts",
  "../../protocol/src/index.ts",
].map(async path => [path, hash(await fs.readFile(new URL(path, import.meta.url)))])));
type RecordEntry = { test: string; status: string; trees: string[]; locations: string[]; seams: string[]; closures: unknown[] };
const records: RecordEntry[] = [];
const unrun = ["dynamic Home socket (callback is inside provider turn startup)", "fresh kernel sandbox enforcement",
  "native/artifact/provider execution", "network/auth", "broad root/legacy installer/context suites"];
if (!supported) unrun.push("all actual-store/socket cases: unsupported host");
async function save() {
  await fs.writeFile(manifest, JSON.stringify({ evidence, sourceHashes, records, unrun,
    launches: 0, cleanup: false, host: { platform: process.platform, arch: process.arch, node: process.version } }, null, 2));
}
await save();
console.log(`ACP installed RPC retained evidence: ${evidence}; manifest: ${manifest}`);
function retained(name: string, run: (t: TestContext, record: RecordEntry) => Promise<void>) {
  test(name, { skip: !supported }, async t => {
    const record: RecordEntry = { test: name, status: "running", trees: [], locations: [], seams: [], closures: [] };
    records.push(record);
    try { await run(t, record); record.status = "passed"; }
    catch (error) { record.status = "failed"; throw error; }
    finally { await save(); }
  });
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve };
}
function elf(tag = 1, index = 1, type = 2): Buffer {
  // Only a header and program table. No instructions or agent payload.
  const bytes = Buffer.alloc(192);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(type, 16); bytes.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
  bytes.writeUInt32LE(1, 20); bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(tag === 1 ? 1 : 2, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(1n, 96); bytes.writeBigUInt64LE(1n, 104);
  if (tag !== 1) bytes.writeUInt32LE(tag, 64 + index * 56);
  return bytes;
}
function client(path: string) {
  const socket = connect(path), messages: any[] = [], events: any[] = [];
  const waiting = new Map<number, (message: any) => void>(); let seq = 0;
  socket.on("error", () => socket.destroy());
  const lines = createInterface({ input: socket }); lines.on("error", () => {});
  lines.on("line", line => {
    const message = JSON.parse(line); messages.push(message);
    if (message.method === "event") events.push(message.params);
    else { waiting.get(message.id)?.(message); waiting.delete(message.id); }
  });
  socket.on("close", () => { for (const resolve of waiting.values()) resolve(undefined); waiting.clear(); lines.close(); });
  const call = (method: string, params: unknown = {}) => new Promise<any>(resolve => {
    const id = ++seq; waiting.set(id, resolve);
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { socket, call, messages, events };
}
async function inventory(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  async function visit(path: string) {
    const stat = await fs.lstat(path, { bigint: true });
    entries.push({ path, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
      size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      ...(stat.isFile() ? { sha256: hash(await fs.readFile(path)) } : {}) });
    if (stat.isDirectory()) for (const child of (await fs.readdir(path)).sort()) await visit(join(path, child));
  }
  await visit(root); return entries;
}
async function fixture(t: TestContext, record: RecordEntry, bytes = elf()) {
  const base = await fs.mkdtemp(join(evidence, "case-")), state = join(base, "state"), root = join(state, "acp-artifacts");
  record.trees.push(base);
  const platform = process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  const catalog = { source: ACP_REGISTRY_URL, sha256: "a".repeat(64), fetchedAt: "2026-01-01T00:00:00.000Z" };
  const registry = decodeAcpRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: "inert-runtime",
    name: "Inert Runtime", version: "1.2.3", description: "Invented header-only fixture", license_url: "https://example.com/license",
    distribution: { binary: { [platform]: { archive: "https://example.com/inert-runtime", sha256: hash(bytes),
      cmd: "inert-runtime", args: ["--acp"] } } } }] }));
  const planned = planAcpInstall(registry.agents[0], platform, "binary"); assert.ok(planned.supported);
  const input = { operation: "I-1", catalog, plan: planned.plan, fingerprint: installFingerprint(catalog, planned.plan) };
  const counters = { catalog: 0, download: 0, gate: 0, auth: 0, provider: 0 };
  const installer = new AcpInstaller(root, { download: async (_plan, file) => {
    counters.download++; await file.writeFile(bytes); return { bytes: bytes.length, sha256: hash(bytes) };
  } });
  // Bootstrap is deliberately separate from the route being measured.
  const receipt = await installer.install(input, { signal: new AbortController().signal,
    gate: async () => { counters.gate++; return { id: "G-1", allowed: true }; } });
  const dir = join(root, input.fingerprint), artifact = join(dir, "artifact"), receiptPath = join(dir, "receipt.json");
  const originals = join(base, "original-store");
  await fs.cp(root, originals, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  record.locations.push(root, dir, artifact, receiptPath, originals);
  const daemon = new Daemon({ socketPath: join(base, "run/govd.sock"), ledgerPath: join(state, "trace.sqlite"),
    policyDir: join(state, "policies"), homeDir: join(state, "home"), supervisor: "unused-inert-supervisor", version: "test" });
  const sockets: Socket[] = [];
  t.after(async () => { for (const socket of sockets) socket.destroy(); await daemon.stop(); });
  (daemon as any).installer = installer;
  (daemon as any).catalog = new AcpCatalog(async () => { counters.catalog++; throw Error("unexpected catalog access"); });
  // A forbidden side path fails without invoking an external process or real provider.
  t.mock.method((daemon as any).connector, "start", async () => { counters.auth++; throw Error("unexpected auth"); });
  for (const usage of Object.values((daemon as any).usage) as any[])
    t.mock.method(usage, "read", async () => { counters.provider++; throw Error("unexpected provider accounting"); });
  t.mock.method(daemon as any, "artifactGate", async () => { counters.gate++; throw Error("unexpected Gate"); });
  const tasks: Promise<{ result?: unknown; error?: unknown }>[] = [], ids: string[] = [];
  const dispatchSockets: Socket[] = [], originalCall = (daemon as any).call;
  t.mock.method(daemon as any, "call", (...args: any[]) => {
    if (args[0] === "acp.installed.inspect") dispatchSockets.push(args[3]);
    return Reflect.apply(originalCall, daemon, args);
  });
  const originalRead = installer.inspectVerifiedRuntime;
  t.mock.method(installer, "inspectVerifiedRuntime", (id: string) => {
    ids.push(id); const task = originalRead.call(installer, id);
    tasks.push(task.then(result => ({ result }), error => ({ error }))); return task;
  });
  await daemon.listen();
  const owner = client(join(base, "run/govd.sock")), other = client(join(base, "run/govd.sock"));
  await Promise.all([once(owner.socket, "connect"), once(other.socket, "connect")]);
  sockets.push(owner.socket, other.socket);
  const baseline = { counters: { ...counters }, events: daemon.ledger.events(undefined, 100),
    specs: daemon.ledger.specs(), projects: daemon.ledger.projects(), settings: (daemon as any).settings(),
    files: await inventory(root), stateFiles: await inventory(state) };
  await fs.writeFile(join(base, "baseline.json"), JSON.stringify(baseline, null, 2));
  record.locations.push(join(base, "baseline.json"));
  async function noSideEffects() {
    assert.deepEqual(counters, baseline.counters);
    assert.deepEqual(daemon.ledger.events(undefined, 100), baseline.events);
    assert.deepEqual(daemon.ledger.specs(), baseline.specs); assert.deepEqual(daemon.ledger.projects(), baseline.projects);
    assert.deepEqual((daemon as any).settings(), baseline.settings);
    assert.deepEqual(await inventory(root), baseline.files);
    assert.deepEqual(await inventory(state), baseline.stateFiles);
    assert.deepEqual(owner.events, []); assert.deepEqual(other.events, []);
  }
  return { base, root, dir, artifact, receiptPath, originals, daemon, installer, receipt, input, bytes,
    owner, other, sockets, counters, baseline, tasks, ids, dispatchSockets, noSideEffects,
    inspect: () => owner.call("acp.installed.inspect", { id: input.fingerprint }) };
}
function failure(response: any, message = "stored runtime inspection did not complete; no verified observation returned") {
  assert.ok(response); assert.equal(Object.hasOwn(response, "result"), false);
  assert.deepEqual(response.error, { code: 1001, message });
}

function closureEvidence(record: RecordEntry, hooks: ReturnType<typeof intercept>) {
  hooks.assertClosed();
  record.closures.push(...hooks.acquired.map(object => ({
    path: hooks.events.find(e => e.object === object && e.phase === "after" && ["open", "opendir"].includes(e.kind))?.path,
    attempts: hooks.closes.get(object),
    completed: hooks.events.filter(e => e.object === object && e.kind === "close" && e.phase === "after").length,
  })));
}

retained("user inspection returns the exact passive observation with independent repeated reads and no side effects", async (t, record) => {
  for (const type of [2, 3]) {
    const f = await fixture(t, record, elf(1, 1, type));
    const expected = { receipt: f.receipt, inspection: { status: "observed", evidence: "no-interpreter-or-dynamic-segments",
      format: "elf64-le-v1", platform: f.input.plan.platform, machine: process.arch === "arm64" ? 183 : 62,
      osabi: 0, elfType: type === 2 ? "ET_EXEC" : "ET_DYN", bytes: f.bytes.length,
      programHeaderOffset: 64, programHeaders: 1, loadSegments: 1 } };
    const first = await f.inspect(), second = await f.inspect();
    assert.equal(first.error, undefined); assert.equal(second.error, undefined);
    assert.deepEqual(first.result, expected); assert.deepEqual(second.result, expected);
    assert.notEqual(first.result, second.result);
    assert.deepEqual(Object.keys(first.result).sort(), ["inspection", "receipt"]);
    assert.deepEqual(f.ids, [f.input.fingerprint, f.input.fingerprint]);
    const data = first.result;
    const forbidden = ["path", "buffer", "fd", "descriptor", "token", "binding", "capability", "eligible", "observedAt"];
    function check(value: any) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.includes(key), key); check(child); }
    }
    check(data); assert.equal(data.receipt.bytes, f.bytes.length); assert.equal(data.inspection.bytes, f.bytes.length);
    assert.equal(data.receipt.plan.source, "https://example.com/inert-runtime");
    assert.deepEqual(data.receipt.plan.command, ["inert-runtime", "--acp"]);
    await f.noSideEffects();
  }
});

retained("interpreter and dynamic parser refusals are completed observations including header index zero", async (t, record) => {
  for (const [tag, reason] of [[3, "interpreter-segment"], [2, "dynamic-segment"]] as const) {
    for (const index of [0, 1]) {
      const f = await fixture(t, record, elf(tag, index)), response = await f.inspect();
      assert.equal(response.error, undefined);
      assert.deepEqual(response.result, { receipt: f.receipt,
        inspection: { status: "refused", reason, programHeaderIndex: index } });
      await f.noSideEffects();
      assert.deepEqual(await fs.readFile(f.artifact), f.bytes);
      assert.deepEqual(await fs.readFile(f.receiptPath), await fs.readFile(join(f.originals, f.input.fingerprint, "receipt.json")));
    }
  }
});

retained("invalid new-method parameters refuse statically before installer access; exact ID reaches the reader once", async (t, record) => {
  const f = await fixture(t, record);
  let accesses = 0;
  const original = (f.daemon as any).artifactInstaller;
  t.mock.method(f.daemon as any, "artifactInstaller", () => { accesses++; return original.call(f.daemon); });
  const invalid: unknown[] = [{}, null, [], [f.input.fingerprint], { id: 1 }, { id: false },
    { id: f.input.fingerprint.toUpperCase() }, { id: "a".repeat(63) }, { id: "a".repeat(65) },
    { id: " " + f.input.fingerprint }, { id: f.input.fingerprint + "\n" },
    { id: "inert-runtime" }, { id: "I-1" }];
  for (const field of ["path", "receipt", "checksum", "bytes", "platform", "catalog", "refresh", "limit", "signal", "binding", "validated", "role"])
    invalid.push({ id: f.input.fingerprint, [field]: "invented" });
  for (const params of invalid) {
    const response = await f.owner.call("acp.installed.inspect", params);
    assert.deepEqual(response.error, { code: -32602,
      message: "expected exactly one lowercase 64-character installation ID in id" });
    assert.equal(Object.hasOwn(response, "result"), false);
  }
  assert.equal(accesses, 0); assert.deepEqual(f.ids, []);
  assert.equal((await f.inspect()).result.inspection.status, "observed");
  assert.equal(accesses, 1); assert.deepEqual(f.ids, [f.input.fingerprint]);
  // All-zero hex is syntactically valid, but the installation is absent.
  failure(await f.owner.call("acp.installed.inspect", { id: "0".repeat(64) }));
  assert.equal(accesses, 2); assert.deepEqual(f.ids, [f.input.fingerprint, "0".repeat(64)]);
  await f.noSideEffects();
});

retained("receipt corruption, same-size artifact mutation, and malformed unrelated sibling yield errors with retained originals", async (t, record) => {
  for (const mutation of ["receipt", "artifact", "sibling"]) {
    const f = await fixture(t, record);
    if (mutation === "receipt") await fs.writeFile(f.receiptPath, "{corrupt}");
    if (mutation === "artifact") { const bytes = Buffer.from(f.bytes); bytes[191] = 7; await fs.writeFile(f.artifact, bytes); }
    if (mutation === "sibling") {
      const sibling = join(f.root, "f".repeat(64)); record.locations.push(sibling);
      await fs.mkdir(sibling, { mode: 0o700 });
    }
    record.seams.push(`preserved-before-mutation:${mutation}`);
    failure(await f.inspect());
    assert.deepEqual(await fs.readFile(join(f.originals, f.input.fingerprint, "artifact")), f.bytes);
    assert.deepEqual(f.counters, f.baseline.counters);
    assert.deepEqual(f.daemon.ledger.events(undefined, 100), f.baseline.events);
    await fs.writeFile(join(f.base, "mutated-inventory.json"), JSON.stringify(await inventory(f.root), null, 2));
    record.locations.push(join(f.base, "mutated-inventory.json"));
  }
});

retained("unknown filesystem and lazy-construction errors expose only static messages", async (t, record) => {
  const f = await fixture(t, record), sentinel = "private-path-sentinel/never-expose";
  let injected = false;
  const hooks = intercept(t, e => {
    if (!injected && e.kind === "read" && e.phase === "after" && e.path.endsWith("/artifact")) {
      injected = true; throw Error(`EIO: ${sentinel}`);
    }
  });
  const response = await f.inspect(); failure(response);
  assert.ok(injected); assert.ok(!JSON.stringify(response).includes(sentinel));
  closureEvidence(record, hooks); hooks.restore();
  t.mock.method(f.daemon as any, "artifactInstaller", () => { throw Error(sentinel); });
  failure(await f.inspect());
  record.seams.push("held-artifact-read:after:private-error", "lazy-installer-construction:private-error");
  await f.noSideEffects();
});

retained("only exact known reader failures receive specific static messages", async (t, record) => {
  const f = await fixture(t, record);
  for (const [error, message] of [
    ["ACP install: runtime inspection already active", "stored runtime inspection already active; no request was queued"],
    ["ACP install: runtime inspection deadline exceeded", "stored runtime inspection deadline exceeded; no observation returned"],
    ["ACP install: installer is stopped", "stored runtime inspection unavailable: installer stopped"],
    ["ACP install: runtime inspection already active private-path-sentinel", "stored runtime inspection did not complete; no verified observation returned"],
    ["runtime inspection already active", "stored runtime inspection did not complete; no verified observation returned"],
  ]) {
    t.mock.method(f.installer, "inspectVerifiedRuntime", async () => { throw Error(error); });
    failure(await f.inspect(), message);
  }
  for (const error of [undefined, null, "private-path-sentinel"])
    { t.mock.method(f.installer, "inspectVerifiedRuntime", async () => { throw error; }); failure(await f.inspect()); }
  const unusual = new Error();
  Object.defineProperty(unusual, "message", { get() { throw Error("private-path-sentinel"); } });
  t.mock.method(f.installer, "inspectVerifiedRuntime", async () => { throw unusual; }); failure(await f.inspect());
  await f.noSideEffects(); record.seams.push("exact-error-mapping controls (no reader admission)");
});

retained("busy rejects on a second user socket without queued work; admission succeeds after actual closure", async (t, record) => {
  const f = await fixture(t, record), entered = deferred(), resume = deferred(); let held = false;
  const hooks = intercept(t, async e => {
    if (!held && e.kind === "read" && e.phase === "after" && e.path.endsWith("/artifact")) {
      held = true; entered.resolve(); await resume.promise;
    }
  });
  const pending = f.inspect();
  try {
    await entered.promise;
    const at = hooks.events.length;
    failure(await f.other.call("acp.installed.inspect", { id: f.input.fingerprint }),
      "stored runtime inspection already active; no request was queued");
    assert.equal(hooks.events.length, at, "busy request does not acquire/read/queue");
    resume.resolve(); assert.equal((await pending).result.inspection.status, "observed");
    closureEvidence(record, hooks);
    assert.equal((await f.inspect()).result.inspection.status, "observed");
    closureEvidence(record, hooks); hooks.restore(); await f.noSideEffects();
  } finally { resume.resolve(); await pending; }
  record.seams.push("held-artifact-read:after:busy");
});

retained("disconnect retains ownership through delayed I/O and final closure without a reply or global stop", async (t, record) => {
  const f = await fixture(t, record), entered = deferred(), resume = deferred(), closing = deferred(), finishClose = deferred();
  let held = false, closureHeld = false, afterRead = false, stops = 0;
  const stop = f.installer.stop;
  t.mock.method(f.installer, "stop", function () { stops++; return stop.call(f.installer); });
  const hooks = intercept(t, async e => {
    if (!held && e.kind === "read" && e.phase === "after" && e.path.endsWith("/artifact")) {
      held = true; entered.resolve(); await resume.promise; afterRead = true;
    }
    if (afterRead && !closureHeld && e.kind === "close" && e.phase === "before") {
      closureHeld = true; closing.resolve(); await finishClose.promise;
    }
  });
  const pending = f.inspect();
  try {
    await entered.promise;
    const serverSocket = f.dispatchSockets[0];
    // The real dispatch captured this request's accepted socket; await its close.
    const serverGone = once(serverSocket, "close");
    f.owner.socket.destroy(); await serverGone; assert.equal(await pending, undefined);
    const busy = () => f.other.call("acp.installed.inspect", { id: f.input.fingerprint });
    failure(await busy(), "stored runtime inspection already active; no request was queued");
    assert.equal(stops, 0); resume.resolve(); await closing.promise;
    failure(await busy(), "stored runtime inspection already active; no request was queued");
    finishClose.resolve(); assert.ok((await f.tasks[0]).result);
    assert.equal(stops, 0); assert.deepEqual(f.owner.messages, []);
    closureEvidence(record, hooks);
    assert.equal((await busy()).result.inspection.status, "observed");
    closureEvidence(record, hooks); hooks.restore(); await f.noSideEffects();
  } finally { resume.resolve(); finishClose.resolve(); await f.tasks[0]; }
  record.seams.push("held-artifact-read:after:disconnect", "owned-close:before:disconnect");
});

retained("graceful stop waits for held I/O and closures and rejects new socket requests before access", async (t, record) => {
  const f = await fixture(t, record), entered = deferred(), resume = deferred(); let held = false, stopped = false;
  const hooks = intercept(t, async e => {
    if (!held && e.kind === "read" && e.phase === "after" && e.path.endsWith("/artifact")) {
      held = true; entered.resolve(); await resume.promise;
    }
  });
  const pending = f.inspect(); let stopping: Promise<void> | undefined;
  try {
    await entered.promise;
    stopping = f.daemon.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    const count = hooks.events.length, admitted = f.ids.length;
    failure(await f.other.call("acp.installed.inspect", { id: f.input.fingerprint }),
      "stored runtime inspection unavailable: govd is stopping");
    assert.equal(hooks.events.length, count); assert.equal(f.ids.length, admitted);
    resume.resolve(); const response = await pending;
    if (response) failure(response, "stored runtime inspection unavailable: govd is stopping");
    assert.ok((await f.tasks[0]).error); await stopping; assert.equal(stopped, true);
    closureEvidence(record, hooks); hooks.restore();
    assert.deepEqual(f.counters, f.baseline.counters); assert.deepEqual(await inventory(f.root), f.baseline.files);
  } finally { resume.resolve(); await pending; await stopping; }
  record.seams.push("held-artifact-read:after:graceful-stop (stop awaited outside callback)");
});

retained("stopped, closed, and already disconnected dispatch rejects before lazy construction", async (t, record) => {
  const f = await fixture(t, record); let accesses = 0;
  t.mock.method(f.daemon as any, "artifactInstaller", () => { accesses++; throw Error("unexpected installer construction"); });
  const call = (socket: Socket) => (f.daemon as any).call("acp.installed.inspect", { id: f.input.fingerprint }, () => {}, socket);
  const disconnected = new (await import("node:net")).Socket(); disconnected.destroy();
  await assert.rejects(call(disconnected), { code: 1001, message: "stored runtime inspection unavailable: requester disconnected" });
  await f.daemon.stop();
  await assert.rejects(call(f.owner.socket), { code: 1001, message: "stored runtime inspection unavailable: govd is stopping" });
  assert.equal(accesses, 0); assert.equal(f.ids.length, 0);
  record.seams.push("direct dispatch lifecycle guards; request schema separately exercised over socket");
});

retained("real installer stop and post-read requester/shutdown checks suppress publication", async (t, record) => {
  const f = await fixture(t, record);
  await f.installer.stop();
  failure(await f.inspect(), "stored runtime inspection unavailable: installer stopped");
  await f.noSideEffects();
  for (const lifecycle of ["disconnect", "stop"]) {
    const current = await fixture(t, record), ready = deferred(), publish = deferred();
    const socket = new (await import("node:net")).Socket();
    // A scripted completed result isolates the dispatcher publication seam. Actual
    // reader closure under stop/disconnect is exercised independently above.
    t.mock.method(current.installer, "inspectVerifiedRuntime", async () => {
      ready.resolve(); await publish.promise; return { receipt: current.receipt, inspection: { status: "refused",
        reason: "elf-header", programHeaderIndex: null } };
    });
    const pending = (current.daemon as any).call("acp.installed.inspect", { id: current.input.fingerprint }, () => {}, socket);
    const rejected = assert.rejects(pending, { code: 1001, message: lifecycle === "disconnect"
      ? "stored runtime inspection unavailable: requester disconnected" : "stored runtime inspection unavailable: govd is stopping" });
    try {
      await ready.promise;
      if (lifecycle === "disconnect") socket.destroy(); else await current.daemon.stop();
      publish.resolve(); await rejected;
    } finally { socket.destroy(); publish.resolve(); await rejected; }
    record.seams.push(`dispatcher-post-read:${lifecycle}:scripted-completion`);
  }
});

retained("original absolute deadline and failed actual final close suppress RPC observations", async (t, record) => {
  for (const mode of ["deadline", "close"]) {
    const f = await fixture(t, record); let injected = false, now = 100, artifactOpens = 0;
    let storeRoot: object | undefined;
    if (mode === "deadline") t.mock.method(performance, "now", () => now);
    const hooks = intercept(t, e => {
      if (injected || e.phase !== "after") return;
      if (e.kind === "open" && e.path.endsWith("/artifact")) artifactOpens++;
      if (!storeRoot && e.kind === "open" && e.path.endsWith("/acp-artifacts")) storeRoot = e.object;
      // Inventory verification opens the artifact and its named binding; the third
      // acquisition is the held selected snapshot, outside inventory's finally block.
      if (mode === "deadline" && artifactOpens === 3 && e.kind === "read" && e.path.endsWith("/artifact")) {
        injected = true; now = 2100;
      }
      // The last owned object is the original held store root. Consume
      // its actual close first; never reopen or close a raw descriptor by number.
      if (mode === "close" && e.kind === "close" && e.object === storeRoot) {
        injected = true; throw Error("private-path-sentinel: failed after actual final close");
      }
    });
    failure(await f.inspect(), mode === "deadline"
      ? "stored runtime inspection deadline exceeded; no observation returned"
      : "stored runtime inspection did not complete; no verified observation returned");
    assert.ok(injected); closureEvidence(record, hooks); hooks.restore(); await f.noSideEffects();
    assert.equal((await f.inspect()).result.inspection.status, "observed");
    record.seams.push(mode === "deadline" ? "held-selected-artifact-read:after:admission-clock+2000ms" : "held-store-root-final-close:after:actual-close");
  }
});

retained("real Controller socket refuses installed inspection and aliases without touching context; Home/MCP/Runner source stays bounded", async (t, record) => {
  const f = await fixture(t, record); let accessed = 0;
  const forbidden = new Proxy({}, { get() { accessed++; throw Error("unexpected context authority"); } });
  const ctx = { runtimeDir: join(f.base, "controller-run"), ledger: forbidden, limits: forbidden, usage: forbidden,
    project: forbidden, gate: () => { accessed++; throw Error("unexpected Gate"); },
    notify: () => { accessed++; }, supervisor: "unused-inert-supervisor", policyDir: "unused", stateDir: "unused" } as unknown as DelegationContext;
  const controller = openControllerSocket(ctx), caller = client(controller.path); f.sockets.push(caller.socket);
  t.after(() => controller.close());
  await once(caller.socket, "connect");
  for (const method of ["acp.installed.inspect", "controller.acp.installed.inspect", "controller.installed.inspect",
    "mcp__governcode__acp.installed.inspect", "controller.inspect-installed"]) {
    failure(await caller.call(method, { id: f.input.fingerprint }), `not offered to the Controller: ${method}`);
  }
  assert.equal(accessed, 0); assert.equal(f.ids.length, 0); await f.noSideEffects();
  const source = await fs.readFile(new URL("../src/daemon.ts", import.meta.url), "utf8");
  const home = source.slice(source.indexOf(': openTurnSocket(resolve(this.opts.socketPath'), source.indexOf("const mcp ="));
  assert.match(home, /if \(method !== "controller\.propose_project"\) throw new Error/u);
  assert.doesNotMatch(home, /acp\.installed\.inspect|artifactInstaller|inspectVerifiedRuntime/u);
  for (const path of ["../src/mcp-controller.ts", "../src/codex.ts", "../src/delegate.ts"]) {
    const text = await fs.readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(text, /acp\.installed\.inspect|inspect-installed|inspectVerifiedRuntime/u);
  }
  record.locations.push(controller.path);
  record.seams.push("actual Controller per-turn socket refusal", "Home/MCP/Runner source-only access boundary; dynamic Home unrun");
});

type Event = { kind: string; phase: "before" | "after"; path: string; object?: object; args: unknown[]; result?: any };
type Handler = (event: Event) => Promise<any> | any;
function intercept(t: TestContext, handler: Handler) {
  const originalOpen = fs.open, originalOpendir = fs.opendir;
  const events: Event[] = [], acquired: object[] = [], closes = new Map<object, number>();
  let live = 0, peak = 0;
  async function event(value: Event) { events.push(value); return handler(value); }
  function wrap(target: any, kind: string, path: string) {
    const original = target[kind];
    t.mock.method(target, kind, async (...args: unknown[]) => {
      if (kind === "close") { closes.set(target, (closes.get(target) ?? 0) + 1); live--; }
      const before = await event({ kind, phase: "before", path, object: target, args });
      const result = before !== undefined ? before : await Reflect.apply(original, target, args);
      const after = await event({ kind, phase: "after", path, object: target, args, result });
      return after !== undefined ? after : result;
    });
  }
  t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const path = String(args[0]);
    if (path !== "/" && !path.startsWith("/proc/self/fd/")) return originalOpen(...args);
    await event({ kind: "open", phase: "before", path, args });
    const handle = await originalOpen(...args);
    acquired.push(handle); live++; peak = Math.max(peak, live);
    for (const method of ["stat", "read", "close"]) wrap(handle, method, path);
    await event({ kind: "open", phase: "after", path, object: handle, args, result: handle });
    return handle;
  });
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof originalOpendir>) => {
    const path = String(args[0]);
    if (!path.startsWith("/proc/self/fd/")) return originalOpendir(...args);
    await event({ kind: "opendir", phase: "before", path, args });
    const dir = await originalOpendir(...args);
    acquired.push(dir); live++; peak = Math.max(peak, live);
    for (const method of ["read", "close"]) wrap(dir, method === "read" ? "read" : "close", path);
    await event({ kind: "opendir", phase: "after", path, object: dir, args, result: dir });
    return dir;
  });
  syncBuiltinESMExports();
  function restore() { t.mock.restoreAll(); syncBuiltinESMExports(); }
  t.after(restore);
  return { events, acquired, closes, restore, assertClosed() {
    assert.ok(peak <= 8, `peak owned handles: ${peak}`);
    assert.equal(live, 0);
    for (const object of acquired) assert.equal(closes.get(object), 1);
  } };
}
