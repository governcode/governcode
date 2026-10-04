// Ordinary inert tests only: no driver execution, native allocation or native fixture.
// Every store, copied source, synthetic context and failed attempt stays retained.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import * as installerModule from "../src/acp-install.ts";
import { AcpInstaller, bindAcpStoredFixtureInstaller, type AcpStoredFixtureBinding } from "../src/acp-install.ts";
import type { AcpInstallRequest } from "../src/acp-install-contract.ts";
import { installFingerprint } from "../src/acp-install-plan.ts";
import { ACP_REGISTRY_URL, decodeAcpRegistry, planAcpInstall } from "../src/acp-registry.ts";

const supported = process.platform === "linux" && process.arch === "x64";
const evidence = await fs.mkdtemp(join(tmpdir(), "acp-store-binding-retained-"));
const manifest = join(evidence, "manifest.json");
type Entry = { test: string; status: string; trees: string[]; locations: string[]; injections: string[] };
const records: Entry[] = [];
console.log(`ACP store binding retained evidence: ${evidence}; manifest: ${manifest}`);
function retained(name: string, run: (t: TestContext, record: Entry) => Promise<void>, linux = true) {
  test(name, { skip: linux && !supported, timeout: 45_000 }, async t => {
    const record: Entry = { test: name, status: "running", trees: [], locations: [], injections: [] };
    records.push(record);
    try { await run(t, record); record.status = "passed"; }
    catch (error) { record.status = "failed"; throw error; }
    finally {
      await fs.writeFile(manifest, JSON.stringify({ evidence, records, cleanup: false, nativeLaunches: 0,
        syntheticWorkers: new Set(records.flatMap(r => r.locations).filter(p => p.endsWith("worker-result.json"))).size,
        unrun: ["actual driver data modes", "native store acceptance", "native embedded-A independent comparison",
          "real providers", "legacy installer suites", "probe-context suite", "broad npm test"] }, null, 2));
    }
  });
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",") + "}";
  return JSON.stringify(value);
}
function elf(size = 192, tag = 0): Buffer {
  // Passive ELF metadata, no instructions. These invented bytes are never executed.
  const bytes = Buffer.alloc(size);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56); bytes.writeUInt32LE(1, 64);
  bytes.writeBigUInt64LE(1n, 96); bytes.writeBigUInt64LE(1n, 104);
  bytes[size - 1] = tag;
  return bytes;
}
function request(bytes: Buffer, suffix = ""): AcpInstallRequest {
  const catalog = { source: ACP_REGISTRY_URL, sha256: "a".repeat(64), fetchedAt: "2026-01-01T00:00:00.000Z" };
  const registry = decodeAcpRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: "inert-stored" + suffix,
    name: "Inert Stored", version: "1.0.0", description: "Invented inert bytes", license_url: "https://example.com/license",
    distribution: { binary: { "linux-x86_64": { archive: "https://example.com/inert" + suffix, sha256: hash(bytes), cmd: "inert" } } } }] }));
  const planned = planAcpInstall(registry.agents[0], "linux-x86_64", "binary"); assert.ok(planned.supported);
  return { operation: "I-1", catalog, plan: planned.plan, fingerprint: installFingerprint(catalog, planned.plan) };
}
async function fixture(record: Entry, bytes = elf()) {
  const base = await fs.mkdtemp(join(evidence, "case-")), root = join(base, "store");
  record.trees.push(base);
  const input = request(bytes);
  let gates = 0, downloads = 0;
  const installer = new AcpInstaller(root, { download: async (_plan, file) => {
    downloads++; await file.writeFile(bytes); return { bytes: bytes.length, sha256: hash(bytes) };
  } });
  const receipt = await installer.install(input, { signal: new AbortController().signal,
    gate: async () => { gates++; return { id: "G-1", allowed: true }; } });
  assert.equal(gates, 1); assert.equal(downloads, 1);
  const dir = join(root, input.fingerprint), artifact = join(dir, "artifact"), receiptPath = join(dir, "receipt.json");
  record.locations.push(root, dir, artifact, receiptPath);
  await fs.writeFile(join(base, "installed-inventory.json"), JSON.stringify({ receipt, root, dir, artifact,
    receiptPath, bytes: bytes.length, sha256: hash(bytes), gates, downloads }, null, 2), { flag: "wx" });
  record.locations.push(join(base, "installed-inventory.json"));
  return { base, root, dir, artifact, receiptPath, input, installer, receipt, bytes };
}
function binding(installer: unknown, id: unknown): AcpStoredFixtureBinding {
  const result = bindAcpStoredFixtureInstaller(installer, id);
  assert.equal(result.status, "bound");
  if (result.status !== "bound") throw Error("Expected authentic inert binding");
  return result.binding;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve };
}
type Event = { kind: string; phase: "before" | "after"; path: string; object: any; args: any[]; result?: any; original?: (...args: any[]) => any };
// Wrap actual owned objects. Close faults occur after the real consuming close;
// no raw FD is retried and no successful context/tree is deleted.
function intercept(t: TestContext, handle: (event: Event) => unknown | Promise<unknown>) {
  const originalOpen = fs.open, originalOpendir = fs.opendir;
  const acquired: object[] = [], closes = new Map<object, number>(), events: Event[] = [];
  let live = 0, peak = 0;
  const event = async (e: Event) => { events.push(e); return handle(e); };
  function wrap(object: any, kind: string, path: string) {
    const original = object[kind];
    t.mock.method(object, kind, async (...args: any[]) => {
      if (kind === "close") { closes.set(object, (closes.get(object) ?? 0) + 1); live--; }
      const before = await event({ kind, phase: "before", path, object, args, original });
      const result = before === undefined ? await Reflect.apply(original, object, args) : before;
      const after = await event({ kind, phase: "after", path, object, args, result });
      return after === undefined ? result : after;
    });
  }
  t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const path = String(args[0]);
    if (path !== "/" && !path.startsWith("/proc/self/fd/")) return originalOpen(...args);
    await event({ kind: "open", phase: "before", path, object: undefined, args });
    const object = await originalOpen(...args); acquired.push(object); live++; peak = Math.max(peak, live);
    for (const method of ["stat", "read", "close"]) wrap(object, method, path);
    await event({ kind: "open", phase: "after", path, object, args, result: object });
    return object;
  });
  t.mock.method(fs, "opendir", async (...args: Parameters<typeof originalOpendir>) => {
    const path = String(args[0]);
    if (!path.startsWith("/proc/self/fd/")) return originalOpendir(...args);
    await event({ kind: "opendir", phase: "before", path, object: undefined, args });
    const object = await originalOpendir(...args); acquired.push(object); live++; peak = Math.max(peak, live);
    for (const method of ["read", "close"]) wrap(object, method, path);
    await event({ kind: "opendir", phase: "after", path, object, args, result: object });
    return object;
  });
  syncBuiltinESMExports();
  const restore = () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
  t.after(restore);
  return { events, restore, assertClosed() {
    assert.equal(live, 0); assert.ok(peak <= 8, `peak reader handles ${peak}`);
    for (const object of acquired) assert.equal(closes.get(object), 1, "every acquired handle closes once");
  } };
}

retained("binding authenticates installer/primitive ID trap-free before any store access", async (t, record) => {
  const f = await fixture(record); let traps = 0;
  const trap = () => { traps++; throw Error("invented trap"); };
  const proxy = new Proxy(f.installer, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable(f.installer, {}); revoked.revoke();
  const hooks = intercept(t, () => { throw Error("unexpected store activity"); });
  for (const receiver of [null, undefined, false, 1, "installer", {}, Object.create(AcpInstaller.prototype),
    { ...f.installer }, proxy, revoked.proxy]) {
    const result = bindAcpStoredFixtureInstaller(receiver, f.input.fingerprint);
    assert.deepEqual(result, { status: "refused", reason: "installer" }); assert.ok(Object.isFrozen(result));
  }
  for (const id of [null, undefined, false, 1, Symbol("id"), {}, new String(f.input.fingerprint),
    { toString: trap }, proxy, revoked.proxy, "", "A".repeat(64), "0".repeat(63), f.input.fingerprint + "\n"])
    assert.deepEqual(bindAcpStoredFixtureInstaller(f.installer, id), { status: "refused", reason: "id" });
  const b = binding(f.installer, f.input.fingerprint);
  assert.deepEqual(Object.keys(b).sort(), ["capture", "release", "signal"]); assert.ok(Object.isFrozen(b));
  await b.release(); await b.release();
  assert.equal(traps, 0); assert.equal(hooks.events.length, 0);
});

retained("binding methods reject copied/proxied/revoked receivers and capture consumes once", async (t, record) => {
  const f = await fixture(record), b = binding(f.installer, f.input.fingerprint); let traps = 0;
  const trap = () => { traps++; throw Error("invented trap"); };
  const revoked = Proxy.revocable(b, {}); revoked.revoke();
  const hooks = intercept(t, () => {});
  for (const receiver of [null, undefined, {}, Object.create(b), { ...b }, new Proxy(b, { get: trap }), revoked.proxy]) {
    await assert.rejects(async () => b.capture.call(receiver as never));
    await assert.rejects(async () => b.release.call(receiver as never));
  }
  assert.equal(traps, 0); assert.equal(hooks.events.length, 0);
  const pending = b.capture(); await assert.rejects(async () => b.capture());
  const captured = await pending;
  assert.deepEqual(Object.keys(captured).sort(), ["bytes", "observation", "path"]);
  assert.deepEqual(captured.bytes, f.bytes); assert.equal(captured.path, f.artifact);
  assert.deepEqual(Object.keys(captured.observation), ["receipt", "inspection"]);
  assert.equal(captured.observation.inspection.status, "observed");
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.observation));
  hooks.assertClosed(); await b.release(); await b.release(); await assert.rejects(async () => b.capture());
});

retained("private root and public method overrides cannot replace capture, including genuine subclass", async (_t, record) => {
  const f = await fixture(record); let overrides = 0;
  const trap = () => { overrides++; throw Error("public method called"); };
  for (const name of ["root", "stopped", "download", "fault", "inspectVerifiedRuntime", "inspectVerified", "installed"])
    Object.defineProperty(f.installer, name, { get: trap });
  const b = binding(f.installer, f.input.fingerprint), captured = await b.capture();
  assert.deepEqual(captured.bytes, f.bytes); await b.release(); assert.equal(overrides, 0);
  class Genuine extends AcpInstaller { override async inspectVerifiedRuntime(): Promise<never> { return trap(); } }
  const sub = new Genuine(f.root), subBinding = binding(sub, f.input.fingerprint);
  assert.deepEqual((await subBinding.capture()).bytes, f.bytes); await subBinding.release(); assert.equal(overrides, 0);
});

retained("binding validates the complete derived selection path without filesystem activity", async (t, record) => {
  const f = await fixture(record), id = f.input.fingerprint;
  const hooks = intercept(t, () => { throw Error("unexpected store activity"); });
  for (const root of [`/${"x".repeat(256)}`, "/invented/colon:component", "/invented/\ud800", "/invented/\ncomponent",
    "/" + Array.from({ length: 12 }, () => "x".repeat(250)).join("/")])
    assert.deepEqual(bindAcpStoredFixtureInstaller(new AcpInstaller(root), id), { status: "refused", reason: "path" });
  const root = "/" + Array.from({ length: 11 }, () => "x".repeat(250)).join("/");
  const b = binding(new AcpInstaller(root), id); await b.release(); assert.equal(hooks.events.length, 0);
});

retained("fake-gated capture shares exact passive verification and complete sibling inventories", async (t, record) => {
  const f = await fixture(record, elf(65539));
  const sibling = request(f.bytes, "-sibling");
  await f.installer.install(sibling, { signal: new AbortController().signal, gate: async () => ({ id: "G-2", allowed: true }) });
  record.locations.push(join(f.root, sibling.fingerprint));
  const passive = await f.installer.inspectVerifiedRuntime(f.input.fingerprint);
  const hooks = intercept(t, e => {
    if (e.kind === "read" && e.phase === "before" && e.path.endsWith("/artifact") && e.args[2] > 1) {
      const [buffer, offset, length, position] = e.args;
      // Split the header into tiny reads, then keep larger partial reads bounded
      // so this success fixture does not exhaust the real admission deadline.
      return Reflect.apply(e.original!, e.object, [buffer, offset, Math.min(length, position < 64 ? 7 : 4096), position]);
    }
  });
  const b = binding(f.installer, f.input.fingerprint), captured = await b.capture();
  assert.deepEqual(captured.observation, passive); assert.deepEqual(captured.bytes, f.bytes);
  assert.ok(hooks.events.filter(e => e.kind === "opendir" && e.phase === "after").length >= 6);
  hooks.assertClosed(); await b.release(); hooks.restore();
  const original = join(f.base, "sibling-receipt-original");
  const path = join(f.root, sibling.fingerprint, "receipt.json");
  await fs.rename(path, original); await fs.writeFile(path, "{}", { flag: "wx", mode: 0o600 });
  record.locations.push(original, path);
  const bad = binding(f.installer, f.input.fingerprint); await assert.rejects(bad.capture()); await bad.release();
});

retained("4 MiB selected limit precedes snapshot allocation while larger sibling remains streamed", async (t, record) => {
  const f = await fixture(record, elf(4 * 1024 * 1024 + 1));
  const selected = request(elf(), "-small");
  const smaller = new AcpInstaller(f.root, { download: async (_plan, file) => {
    const bytes = elf(); await file.writeFile(bytes); return { bytes: bytes.length, sha256: hash(bytes) };
  } });
  await smaller.install(selected, { signal: new AbortController().signal, gate: async () => ({ id: "G-2", allowed: true }) });
  record.locations.push(join(f.root, selected.fingerprint));
  const allocated: number[] = [], original = Buffer.allocUnsafeSlow;
  t.mock.method(Buffer, "allocUnsafeSlow", (size: number) => { allocated.push(size); return original(size); });
  const b = binding(f.installer, f.input.fingerprint);
  await assert.rejects(b.capture()); await b.release(); assert.ok(!allocated.includes(f.bytes.length));
  const small = binding(smaller, selected.fingerprint);
  assert.deepEqual((await small.capture()).bytes, elf()); await small.release();
  assert.ok(!allocated.includes(f.bytes.length), "sibling is never captured");
});

for (const value of [null, undefined]) for (const kind of ["read", "close"] as const)
  retained(`nullish ${kind} rejection (${String(value)}) fails capture and consumes every close`, async (t, record) => {
    const f = await fixture(record), b = binding(f.installer, f.input.fingerprint); let injected = false;
    const hooks = intercept(t, e => {
      if (!injected && e.kind === kind && e.phase === (kind === "close" ? "after" : "before")) {
        injected = true; throw value;
      }
    });
    record.injections.push(`builtin ${kind} rejection ${String(value)}`);
    await assert.rejects(async () => { await b.capture(); });
    assert.ok(injected); hooks.assertClosed(); await b.release(); await b.release();
  });

retained("capture overlap and release hold the shared reader gate through consuming close settlement", async (t, record) => {
  const f = await fixture(record), other = await fixture(record), b = binding(f.installer, f.input.fingerprint);
  const closeEntered = deferred(), closeContinue = deferred(); let delayed = false;
  const hooks = intercept(t, async e => {
    if (!delayed && e.kind === "close" && e.phase === "before") {
      delayed = true; closeEntered.resolve(); await closeContinue.promise;
    }
  });
  const capture = b.capture(); const capturedOutcome = capture.then(() => "success", () => "refused");
  await closeEntered.promise;
  let releaseSettled = false;
  const release = b.release().then(() => { releaseSettled = true; });
  await Promise.resolve(); assert.equal(releaseSettled, false);
  await assert.rejects(other.installer.inspectVerifiedRuntime(other.input.fingerprint), /active/u);
  const overlap = binding(other.installer, other.input.fingerprint);
  await assert.rejects(overlap.capture(), /active/u); await overlap.release();
  closeContinue.resolve(); assert.equal(await capturedOutcome, "refused"); await release;
  hooks.assertClosed(); hooks.restore();
  assert.equal((await other.installer.inspectVerifiedRuntime(other.input.fingerprint)).inspection.status, "observed");
});

retained("stop aborts private bindings/readers before a throwing legacy setter and awaits all closure", async (t, record) => {
  const f = await fixture(record), b = binding(f.installer, f.input.fingerprint);
  const entered = deferred(), proceed = deferred(); let delayed = false, setter = 0;
  const hooks = intercept(t, async e => {
    if (!delayed && e.kind === "read" && e.phase === "before") { delayed = true; entered.resolve(); await proceed.promise; }
  });
  const captured = b.capture().then(() => "success", () => "refused"); await entered.promise;
  Object.defineProperty(f.installer, "stopped", { set() { setter++; assert.equal(b.signal.aborted, true); throw Error("legacy setter"); } });
  let settled = false;
  const stopped = f.installer.stop().then(() => { settled = true; return "success"; }, () => { settled = true; return "failed"; });
  await Promise.resolve(); assert.equal(settled, false); assert.equal(setter, 1); assert.equal(b.signal.aborted, true);
  assert.deepEqual(bindAcpStoredFixtureInstaller(f.installer, f.input.fingerprint), { status: "refused", reason: "stopped" });
  proceed.resolve(); assert.equal(await captured, "refused"); assert.equal(await stopped, "failed");
  hooks.assertClosed(); await b.release(); await b.release();
});

for (const stage of ["read", "close"] as const)
  retained(`capture uses its original 2-second absolute clock through ${stage}`, async (t, record) => {
    const f = await fixture(record), b = binding(f.installer, f.input.fingerprint);
    let now = 100, injected = false;
    t.mock.method(performance, "now", () => now);
    const hooks = intercept(t, e => {
      if (!injected && e.kind === stage && e.phase === "after") { injected = true; now = 2100; }
    });
    record.injections.push(`synthetic clock at consuming ${stage}: admission 100, completion 2100`);
    await assert.rejects(b.capture()); assert.ok(injected); hooks.assertClosed(); await b.release();
  });

for (const seam of ["receipt", "artifact", "inventory", "artifact-replace", "directory-replace", "root-replace"])
  retained(`capture refuses retained real-filesystem ${seam} corruption`, async (t, record) => {
    const f = await fixture(record); let changed = false;
    const original = join(f.base, "mutation-original"), replacement = join(f.base, "mutation-replacement");
    record.locations.push(original, replacement); record.injections.push(seam);
    if (seam === "receipt" || seam === "artifact") {
      const path = seam === "receipt" ? f.receiptPath : f.artifact;
      await fs.rename(path, original);
      const bytes = seam === "receipt" ? Buffer.from("{}") : Buffer.from(f.bytes);
      if (seam === "artifact") bytes[bytes.length - 1] ^= 1;
      await fs.writeFile(replacement, bytes, { flag: "wx", mode: seam === "receipt" ? 0o600 : 0o700 });
      await fs.rename(replacement, path); changed = true;
    }
    const hooks = intercept(t, async e => {
      if (changed || e.kind !== "read" || e.phase !== "after" || !e.path.endsWith("/artifact")) return;
      changed = true;
      if (seam === "inventory") {
        const path = join(f.root, "unexpected"); record.locations.push(path);
        await fs.writeFile(path, "inert", { flag: "wx" });
      } else {
        const path = seam === "artifact-replace" ? f.artifact : seam === "directory-replace" ? f.dir : f.root;
        await fs.rename(path, original);
        if (seam === "artifact-replace") {
          await fs.copyFile(original, replacement, 1); await fs.chmod(replacement, 0o700);
        } else await fs.cp(original, replacement, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        await fs.rename(replacement, path);
      }
    });
    const b = binding(f.installer, f.input.fingerprint); await assert.rejects(b.capture());
    assert.ok(changed); hooks.assertClosed(); await b.release();
    assert.ok(await fs.stat(f.base));
  });

// Copies load current implementation, changing only import routing and guarded
// deterministic seam notifications. Synthetic faults never add production hooks.
const ownerUrl = new URL("./fixtures/acp-probe-termination.ts", import.meta.url);
const installerUrl = new URL("../src/acp-install.ts", import.meta.url);
const workerSource = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const { AcpInstaller } = await import(config.installer);
const realNow = performance.now.bind(performance);
let now = 0, once = false, stopped, child;
const operations = [], contexts = [], stages = [];
let releaseData;
const dataGate = new Promise(resolve => { releaseData = resolve; });
const timerRead = config.fault === "timer-capture-read";
let readEntered, releaseRead, closeEntered, releaseClose, closeHeld = false, measuringExpiry = false;
const readArrival = new Promise(resolve => { readEntered = resolve; });
const readGate = new Promise(resolve => { releaseRead = resolve; });
const closeArrival = new Promise(resolve => { closeEntered = resolve; });
const closeGate = new Promise(resolve => { releaseClose = resolve; });
const installer = new AcpInstaller(config.root);
const state = globalThis.__storeTest = { config, installer, operations, contexts, stages,
  get now() { return now; }, set now(value) { now = value; }, child: undefined,
  stop() { stopped ??= installer.stop(); return stopped; },
  async data(mode) {
    operations.push(mode);
    if (config.fault === "preparing-slot" && mode === "fixture-image-a") await dataGate;
    if (config.fault === "image-data" || config.fault.startsWith("data-channel-")) throw Error("synthetic data rejection");
    if (config.fault === "image-diagnostics") return { stdout: Buffer.from(config.a, "hex"), stderr: Buffer.from("x") };
    if (config.fault === "stop-a" && mode === "fixture-image-a") state.stop();
    if (config.fault === "stop-b" && mode === "fixture-image-b") state.stop();
    if (config.fault === "expired-a" && mode === "fixture-image-a") now = 11000;
    if (config.fault === "expired-b" && mode === "fixture-image-b") now = 11000;
    return { stdout: Buffer.from(mode === "fixture-image-a" ? config.a : config.b, "hex"), stderr: Buffer.alloc(0) };
  },
  seam(name) {
    stages.push(name);
    if (timerRead && name === "allocation") now = 10000;
    if (config.fault === "expired-" + name) now = 11000;
    if (config.fault === "stop-" + name) state.stop();
    if (config.fault === "capture-clock-" + name) now += 2000;
  }
};
Object.defineProperty(performance, "now", { value: () => now, configurable: true });
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (!state.child && delay === 11000) state.preparationTimer = callback;
  return originalSetTimeout(callback, delay, ...args);
};
const originalOpen = fs.open, originalOpendir = fs.opendir;
const acquired = [], closes = new Map();
let live = 0;
fs.open = async (...args) => {
  if (measuringExpiry) operations.push("store-open-after-prep-timer");
  const object = await originalOpen(...args), path = String(args[0]);
  if (path !== "/" && !path.startsWith("/proc/self/fd/")) return object;
  operations.push("store-open"); acquired.push(object); live++;
  const read = object.read.bind(object), close = object.close.bind(object);
  object.read = async (...values) => {
    if (measuringExpiry) operations.push("store-read-after-prep-timer");
    const pendingRead = read(...values);
    if (timerRead && !once) {
      once = true; state.seam("capture-read");
      assert.equal(now, 10000); // Capture's independent deadline is still 12000.
      now = 11000; measuringExpiry = true; state.preparationTimer();
      readEntered(); await readGate;
    }
    const result = await pendingRead;
    if (!once) { once = true; state.seam("capture-read"); }
    return result;
  };
  object.close = async () => {
    if (measuringExpiry && !closeHeld) {
      closeHeld = true; closeEntered(); await closeGate;
    }
    closes.set(object, (closes.get(object) ?? 0) + 1); live--;
    await close();
    if (!stages.includes("capture-close")) state.seam("capture-close");
  };
  return object;
};
fs.opendir = async (...args) => {
  if (measuringExpiry) operations.push("store-directory-open-after-prep-timer");
  const object = await originalOpendir(...args), path = String(args[0]);
  if (!path.startsWith("/proc/self/fd/")) return object;
  acquired.push(object); live++;
  const read = object.read.bind(object), close = object.close.bind(object);
  object.read = async (...values) => {
    if (measuringExpiry) operations.push("store-directory-read-after-prep-timer");
    return read(...values);
  };
  object.close = async () => { closes.set(object, (closes.get(object) ?? 0) + 1); live--; await close(); };
  return object;
};
syncBuiltinESMExports();
const fixture = await import(config.owner);
const bootstrap = { driver: join(config.base, "inert-driver-never-executed"), cwd: join(config.base, "bootstrap"),
  env: { HOME: join(config.base, "bootstrap"), TMPDIR: join(config.base, "bootstrap"), PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } };
const input = { parent: join(config.base, "contexts") };
const start = () => fixture.startNativeStoredContextBoundFixture(installer, config.id, bootstrap, input, "normal");
const summaries = {};
const summarize = result => ({ ...result, invocation: result.invocation ? { keys: Object.keys(result.invocation).sort() } : undefined });
let result, termination;
if (config.fault === "branding") {
  let traps = 0;
  const trap = () => { traps++; throw Error("caller reflection"); };
  const revoked = Proxy.revocable(installer, {}); revoked.revoke();
  for (const value of [{}, Object.create(AcpInstaller.prototype), { ...installer }, new Proxy(installer, { get: trap }), revoked.proxy]) {
    const r = await fixture.startNativeStoredContextBoundFixture(value, config.id, new Proxy({}, { get: trap, ownKeys: trap }), new Proxy({}, { get: trap }), "normal");
    assert.deepEqual(r, { status: "refused", reason: "installer" });
  }
  assert.equal(traps, 0); assert.deepEqual(operations, []);
  for (const id of [null, undefined, {}, Symbol("id"), new String(config.id)])
    assert.deepEqual(await fixture.startNativeStoredContextBoundFixture(installer, id, bootstrap, input, "normal"), { status: "refused", reason: "invalid-input" });
  result = { status: "checked", traps };
} else if (config.fault === "inputs") {
  let traps = 0; const trap = () => { traps++; throw Error("input trap"); };
  for (const value of [null, {}, { ...bootstrap, policy: "/invented/policy" }, { ...bootstrap, observation: {} },
    { ...bootstrap, bytes: Buffer.alloc(64) }, { ...bootstrap, driver: "relative" },
    { ...bootstrap, env: { ...bootstrap.env, XDG_DATA_HOME: "/invented/data" } },
    Object.defineProperty({}, "driver", { get: trap }), new Proxy(bootstrap, { get: trap, ownKeys: trap })])
    assert.deepEqual(await fixture.startNativeStoredContextBoundFixture(installer, config.id, value, input, "normal"), { status: "refused", reason: "invalid-input" });
  for (const scenario of ["copy-b", "before-copy-b", "sealed-replace", "sealed-mutate", "copy-torn", "forge", "invalid"])
    assert.deepEqual(await fixture.startNativeStoredContextBoundFixture(installer, config.id, bootstrap, input, scenario), { status: "refused", reason: "invalid-input" });
  assert.equal(traps, 0); assert.deepEqual(operations, []); result = { status: "checked", traps };
} else {
  const pending = start();
  if (timerRead) {
    let operationSettled = false; pending.then(() => { operationSettled = true; });
    await readArrival;
    assert.equal(operationSettled, false, "expiry cannot abandon an in-flight real read");
    summaries.duringRead = summarize(await start());
    await assert.rejects(installer.inspectVerifiedRuntime(config.id), /active/u);
    releaseRead(); await closeArrival;
    assert.equal(operationSettled, false, "expiry cannot abandon consuming close settlement");
    summaries.duringClose = summarize(await start());
    await assert.rejects(installer.inspectVerifiedRuntime(config.id), /active/u);
    releaseClose();
  }
  if (config.fault.startsWith("data-channel-")) {
    let operationSettled = false; pending.then(() => { operationSettled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(operationSettled, false, "rejected data promise does not prove its channel closed");
    summaries.pendingDataChannel = summarize(await start());
    if (config.fault === "data-channel-expiry") {
      state.preparationTimer();
      summaries.afterPreparationTimer = summarize(await start());
      assert.equal(operationSettled, false, "preparation timer does not release pending data channel");
    }
    state.dataClose();
  }
  if (config.fault === "preparing-slot") {
    await Promise.resolve();
    summaries.concurrentPreparing = summarize(await start());
    summaries.passivePreparing = await installer.inspectVerifiedRuntime(config.id);
    releaseData();
  }
  result = await pending;
  if (timerRead) {
    measuringExpiry = false;
    summaries.expiry = { captureAdmission: 10000, captureDeadline: 12000, preparationExpiry: now,
      opens: operations.filter(x => x === "store-open-after-prep-timer").length,
      reads: operations.filter(x => x === "store-read-after-prep-timer").length,
      directoryOpens: operations.filter(x => x === "store-directory-open-after-prep-timer").length,
      directoryReads: operations.filter(x => x === "store-directory-read-after-prep-timer").length,
      ownedHandles: acquired.length, live, allClosedOnce: acquired.every(x => closes.get(x) === 1) };
    summaries.passiveAfterExpiry = await installer.inspectVerifiedRuntime(config.id);
    summaries.subsequentOperation = summarize(await fixture.startNativeStoredContextBoundFixture(installer,
      config.id, {}, input, "normal"));
  }
  if (result.status === "started") {
    child = state.child;
    assert.ok(child);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.invocation) && Object.isFrozen(result.diagnostics));
    assert.ok(Object.isFrozen(result.invocation.termination) && Object.isFrozen(result.invocation.stop));
    assert.ok(Object.isFrozen(result.observation) && Object.isFrozen(result.observation.receipt) &&
      Object.isFrozen(result.observation.inspection) && Object.isFrozen(result.diagnostics.directories) &&
      Object.isFrozen(result.diagnostics.identities));
    assert.deepEqual(Object.keys(result).sort(), ["diagnostics", "invocation", "observation", "status"]);
    assert.deepEqual(Object.keys(result.invocation).sort(), ["stop", "termination"]);
    summaries.concurrentRunning = summarize(await start());
    if (!config.fault.startsWith("stop-")) summaries.passiveRunning = await installer.inspectVerifiedRuntime(config.id);
    if (config.fault === "stop-running") await state.stop();
    const proof = Buffer.alloc(32); proof.write("GPLT"); proof[4] = 1; proof[5] = 1; proof[6] = 1;
    Buffer.from(child.args.at(-1), "hex").copy(proof, 8);
    if (["stop-running", "stop-reentrant"].includes(config.fault)) { proof[6] = 3; }
    if (config.fault === "setup-failed") proof[6] = 4;
    if (config.fault === "proof-stale") proof[8] ^= 1;
    if (config.fault === "proof-forged") proof[0] ^= 1;
    if (config.fault === "endpoint-acquisition") { /* The real owner already latched channel failure. */ }
    else if (config.fault === "async-spawn") child.emit("error", Error("synthetic asynchronous spawn"));
    else if (config.fault === "stdout-error") child.stdout.emit("error", Error("synthetic stdout"));
    else if (config.fault === "control-error") child.stdio[3].emit("error", Error("synthetic control"));
    else if (config.fault === "stderr-error") child.stderr.emit("error", Error("synthetic stderr"));
    else if (config.fault === "proof-error") child.stdio[4].emit("error", Error("synthetic proof"));
    else if (config.fault === "stdin-error") child.stdin.emit("error", Error("synthetic stdin"));
    else if (config.fault === "output-overflow") { child.stdout.emit("data", Buffer.alloc(32768)); child.stderr.emit("data", Buffer.alloc(32769)); }
    else if (config.fault === "proof-deadline") {
      now = 11000; child.stdio[4].emit("data", proof);
    } else {
      if (config.fault === "output-exact") { child.stdout.emit("data", Buffer.alloc(32768)); child.stderr.emit("data", Buffer.alloc(32768)); }
      if (config.fault !== "proof-missing") child.stdio[4].emit("data", config.fault === "proof-truncate" ? proof.subarray(0, 31) : proof);
      if (config.fault === "proof-extra") child.stdio[4].emit("data", Buffer.from([1]));
      child.stdio[4].emit("end");
      child.exitCode = config.fault === "producer-exit" ? 70 : 0;
      child.emit("exit", child.exitCode, null);
      if (["normal", "post-proof-overflow", "post-proof-stdout-error", "post-proof-stderr-error", "stdout-close-before-end"].includes(config.fault)) {
        let prematurelySettled = false;
        result.invocation.termination.then(() => { prematurelySettled = true; });
        await Promise.resolve();
        assert.equal(prematurelySettled, false, "proof plus exit must wait for both output channels");
        summaries.proofWaitedForOutput = true;
      }
      if (config.fault === "post-proof-overflow") {
        child.stdout.emit("data", Buffer.alloc(32768)); child.stderr.emit("data", Buffer.alloc(32769));
      }
      if (config.fault === "post-proof-stdout-error") child.stdout.emit("error", Error("synthetic post-proof stdout"));
      if (config.fault === "post-proof-stderr-error") child.stderr.emit("error", Error("synthetic post-proof stderr"));
      if (config.fault === "stdout-close-before-end") child.stdout.emit("close");
      child.stdout.emit("end"); child.stderr.emit("end");
    }
    termination = await result.invocation.termination;
    summaries.beforeChildClose = summarize(await start());
    summaries.controlClosed = child.stdio[3].destroyed;
    child.emit("close", child.exitCode, null);
    await new Promise(resolve => setImmediate(resolve));
    summaries.afterChildClose = summarize(await fixture.startNativeStoredContextBoundFixture({}, config.id, bootstrap, input, "normal"));
    summaries.endpointListeners = child.stdio.map(s => s?.eventNames().filter(name => name !== "prefinish").map(name => [name, s.listenerCount(name)]));
    summaries.spawnSelection = { driver: bootstrap.driver, args: child.args, options: child.options };
  } else {
    summaries.afterRefusal = summarize(await fixture.startNativeStoredContextBoundFixture({}, config.id, bootstrap, input, "normal"));
  }
}
await stopped;
assert.equal(live, 0);
for (const object of acquired) assert.equal(closes.get(object), 1);
const output = { label: "synthetic Node faults; no native driver or actual allocator", result: summarize(result), termination,
  operations, contexts, stages, summaries, now, wallMs: realNow(), ownedHandles: acquired.length, live };
await fs.writeFile(config.report, JSON.stringify(output, null, 2), { flag: "wx" });
`;

const shimSource = String.raw`
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { join } from "node:path";
const state = globalThis.__storeTest;
export function execFile() { throw Error("Only synthetic promisified fixed data is allowed"); }
execFile[promisify.custom] = (_driver, args) => {
  const child = new EventEmitter(), task = state.data(args[0]);
  task.child = child;
  const close = () => {
    if (state.config.fault.startsWith("data-channel-")) state.dataClose = () => child.emit("close", 0, null);
    else setImmediate(() => child.emit("close", 0, null));
  };
  task.then(close, close); return task;
};
export function createAcpProbeAbortController() { state.seam("before-data"); return new AbortController(); }
export class AcpProbeContextError extends Error {}
export async function allocateAcpProbeContext({ parent }, signal) {
  state.operations.push("allocation");
  if (state.config.fault === "allocation-failure") throw Error("synthetic allocation failure");
  const root = join(parent, "probe-00000000-0000-0000-0000-000000000001");
  await fs.mkdir(root, { mode: 0o700 });
  const directories = {}, identities = {};
  for (const name of ["root", "cwd", "home", "config", "cache", "data", "state", "runtime", "tmp", "empty"]) {
    const path = name === "root" ? root : join(root, name);
    if (name !== "root") { await fs.mkdir(path, { mode: 0o700 }); directories[name] = path; }
    const stat = await fs.stat(path, { bigint: true }); identities[name] = { dev: stat.dev, ino: stat.ino };
  }
  const d = directories;
  const env = { HOME: d.home, XDG_CONFIG_HOME: d.config, XDG_CACHE_HOME: d.cache, XDG_DATA_HOME: d.data,
    XDG_STATE_HOME: d.state, XDG_RUNTIME_DIR: d.runtime, XDG_CONFIG_DIRS: d.empty, XDG_DATA_DIRS: d.empty,
    TMPDIR: d.tmp, TMP: d.tmp, TEMP: d.tmp, PATH: d.empty, LANG: "C", LC_ALL: "C" };
  state.contexts.push({ root, directories, identities: Object.fromEntries(Object.entries(identities).map(([k,v]) => [k, {dev:String(v.dev),ino:String(v.ino)}])) });
  await fs.appendFile(join(state.config.base, "context-index.jsonl"), JSON.stringify(state.contexts.at(-1)) + "\n");
  state.seam("allocation");
  if (state.config.fault === "selection-failure") env.LC_ALL = "invented";
  return { root, directories: Object.freeze(directories), identities: Object.freeze(identities), env: Object.freeze(env) };
}
export function spawn(driver, args, options) {
  state.operations.push("spawn-attempt");
  if (state.config.fault === "sync-spawn") throw Error("synthetic synchronous spawn");
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.pid = 12345;
  child.args = args; child.options = options;
  child.stdio = Array.from({ length: 5 }, () => new PassThrough());
  [child.stdin, child.stdout, child.stderr] = child.stdio;
  state.child = child;
  state.operations.push("spawn");
  if (state.config.fault === "stop-reentrant") state.stop();
  if (state.config.fault === "endpoint-acquisition") child.stdio[4] = null;
  return child;
}
`;

async function syntheticWorker(record: Entry, fault: string, stored = elf(), imageA = elf(), imageB = elf(192, 1)) {
  const f = await fixture(record, stored), worker = join(f.base, "worker.mjs"), shim = join(f.base, "synthetic-shim.mjs");
  const copy = join(f.base, "fixture-copy.ts"), original = join(f.base, "fixture-original.ts"), config = join(f.base, "worker-config.json");
  const report = join(f.base, "worker-result.json");
  record.locations.push(worker, shim, copy, original, config, report, join(f.base, "context-index.jsonl"), join(f.base, "worker-out.log"), join(f.base, "worker-err.log"));
  record.injections.push(`synthetic Node worker: ${fault}`);
  for (const name of ["bootstrap", "contexts"]) { await fs.mkdir(join(f.base, name), { mode: 0o700 }); record.locations.push(join(f.base, name)); }
  let source = await fs.readFile(ownerUrl, "utf8");
  await fs.writeFile(original, source, { flag: "wx" });
  const replace = (from: string, to: string) => {
    assert.equal(source.split(from).length, 2, `exact copied-source seam: ${from}`); source = source.replace(from, to);
  };
  source = source.replace(/from "(\.{1,2}\/[^"\n]+)"/gu, (_all, specifier: string) => `from ${JSON.stringify(new URL(specifier, ownerUrl).href)}`);
  replace('from "node:child_process"', `from ${JSON.stringify(pathToFileURL(shim).href)}`);
  replace(`from ${JSON.stringify(new URL("../../src/acp-probe-context.ts", ownerUrl).href)}`, `from ${JSON.stringify(pathToFileURL(shim).href)}`);
  replace("capture = await bound.binding.capture();", 'capture = await bound.binding.capture(); globalThis.__storeTest.seam("capture");');
  replace("const matches = capture.bytes.length", 'globalThis.__storeTest.seam("comparison"); const matches = capture.bytes.length');
  replace("if (stored) storedAdmission(stored);", 'globalThis.__storeTest.seam("final"); if (stored) storedAdmission(stored);');
  await fs.writeFile(copy, source, { flag: "wx" });
  await fs.writeFile(shim, shimSource, { flag: "wx" }); await fs.writeFile(worker, workerSource, { flag: "wx" });
  await fs.writeFile(config, JSON.stringify({ fault, root: f.root, base: f.base, id: f.input.fingerprint,
    a: imageA.toString("hex"), b: imageB.toString("hex"), owner: pathToFileURL(copy).href, installer: installerUrl.href, report,
    originalSourceSha256: hash(await fs.readFile(original)), copiedSourceSha256: hash(source) }, null, 2), { flag: "wx" });
  const run = spawnSync(process.execPath, [worker, config], { encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 });
  await fs.writeFile(join(f.base, "worker-out.log"), run.stdout ?? "", { flag: "wx" });
  await fs.writeFile(join(f.base, "worker-err.log"), run.stderr ?? "", { flag: "wx" });
  // Inventory before checking worker status: even failed/timed-out attempts keep
  // their complete tree and every successfully created synthetic context.
  const inventory: string[] = [];
  async function walk(path: string) {
    inventory.push(path);
    for (const child of await fs.readdir(path, { withFileTypes: true })) {
      const selected = join(path, child.name);
      if (child.isDirectory()) await walk(selected); else inventory.push(selected);
    }
  }
  await walk(f.base);
  const inventoryPath = join(f.base, "retained-inventory.json");
  await fs.writeFile(inventoryPath, JSON.stringify({ fault, status: run.status, signal: run.signal,
    error: run.error?.message, paths: inventory }, null, 2), { flag: "wx" });
  record.locations.push(inventoryPath, ...inventory);
  assert.equal(run.signal, null, `${fault}: bounded synthetic worker ${run.error ?? ""}`);
  assert.equal(run.status, 0, `${fault}: ${run.stderr}`);
  const output = JSON.parse(await fs.readFile(report, "utf8"));
  for (const context of output.contexts) {
    record.trees.push(context.root); record.locations.push(...Object.values(context.directories) as string[]);
    assert.ok(await fs.stat(context.root));
  }
  assert.deepEqual(await fs.readFile(f.artifact), stored, "installed inert artifact preserved");
  assert.ok(!(await fs.readdir(join(f.base, "bootstrap"))).length, "no target/policy materialization");
  assert.equal(output.live, 0);
  return output;
}

for (const fault of ["branding", "inputs"])
  retained(`isolated operation ${fault} rejects before driver/allocation/store activity`, async (_t, record) => {
    const row = await syntheticWorker(record, fault);
    assert.equal(row.result.status, "checked"); assert.deepEqual(row.operations, []); assert.deepEqual(row.contexts, []);
  });

for (const fault of ["data-channel-rejection", "data-channel-expiry"])
  retained(`synthetic rejected data task retains operation slot until channel settlement: ${fault}`, async (_t, record) => {
    const row = await syntheticWorker(record, fault);
    assert.deepEqual(row.summaries.pendingDataChannel, { status: "refused", reason: "admission" });
    if (fault === "data-channel-expiry") {
      assert.deepEqual(row.summaries.afterPreparationTimer, { status: "refused", reason: "admission" });
      assert.equal(row.result.status, "refused"); assert.equal(row.result.reason, "expired");
    } else { assert.equal(row.result.status, "unavailable"); assert.equal(row.result.reason, "image-data"); }
    assert.deepEqual(row.summaries.afterRefusal, { status: "refused", reason: "installer" });
    assert.ok(!row.operations.includes("allocation")); assert.ok(!row.operations.includes("store-open"));
  });

retained("preparation timer aborts capture at the real read seam and retains both ownership gates", async (_t, record) => {
  const row = await syntheticWorker(record, "timer-capture-read");
  assert.equal(row.result.status, "refused"); assert.equal(row.result.reason, "expired");
  assert.ok(!row.operations.includes("spawn-attempt") && !row.operations.includes("spawn"));
  assert.deepEqual(row.summaries.duringRead, { status: "refused", reason: "admission" });
  assert.deepEqual(row.summaries.duringClose, { status: "refused", reason: "admission" });
  const expiry = row.summaries.expiry;
  assert.equal(expiry.captureAdmission, 10000); assert.equal(expiry.captureDeadline, 12000);
  assert.equal(expiry.preparationExpiry, 11000);
  assert.equal(expiry.live, 0); assert.equal(expiry.allClosedOnce, true);
  assert.equal(expiry.opens, 0); assert.equal(expiry.reads, 0);
  assert.equal(expiry.directoryOpens, 0); assert.equal(expiry.directoryReads, 0);
  assert.equal(row.summaries.passiveAfterExpiry.inspection.status, "observed");
  assert.deepEqual(row.summaries.subsequentOperation, { status: "refused", reason: "invalid-input" });
});

for (const fault of ["expired-before-data", "expired-a", "expired-b", "expired-allocation", "expired-capture-read",
  "expired-capture-close", "expired-capture", "expired-comparison", "expired-final", "stop-a", "stop-b", "stop-allocation",
  "stop-capture-read", "stop-capture-close", "stop-capture", "stop-comparison", "stop-final"])
  retained(`synthetic operation absolute deadline/cancellation: ${fault}`, async (_t, record) => {
    const row = await syntheticWorker(record, fault);
    assert.equal(row.result.status, "refused"); assert.equal(row.result.reason, fault.startsWith("expired-") ? "expired" : "cancelled");
    assert.ok(!row.operations.includes("spawn-attempt"));
    assert.deepEqual(row.summaries.afterRefusal, { status: "refused", reason: "installer" });
    if (fault === "expired-a" || fault === "stop-a") assert.ok(!row.operations.includes("fixture-image-b"));
  });

for (const [fault, reason, status] of [["capture-clock-capture-read", "store", "refused"],
  ["capture-clock-capture-close", "store", "refused"], ["allocation-failure", "allocation", "unavailable"],
  ["selection-failure", "selection", "refused"], ["image-data", "image-data", "unavailable"],
  ["image-diagnostics", "image-data", "unavailable"], ["sync-spawn", "spawn", "refused"]])
  retained(`synthetic operation refusal/unavailable settlement: ${fault}`, async (_t, record) => {
    const row = await syntheticWorker(record, fault); assert.equal(row.result.status, status); assert.equal(row.result.reason, reason);
    assert.deepEqual(row.summaries.afterRefusal, { status: "refused", reason: "installer" });
  });

for (const [label, bytes] of [["valid B", elf(192, 1)], ["different final byte", elf(192, 2)], ["different complete length", elf(193)]] as const)
  retained(`synthetic association rejects ${label} store using complete equality`, async (_t, record) => {
    const row = await syntheticWorker(record, "mismatch", bytes);
    assert.equal(row.result.status, "refused"); assert.equal(row.result.reason, "image-mismatch");
    assert.ok(!row.operations.includes("spawn")); assert.equal(row.contexts.length, 1);
  });

for (const fault of ["normal", "preparing-slot", "output-exact", "setup-failed", "stop-reentrant", "stop-running",
  "async-spawn", "endpoint-acquisition", "stdout-error", "stderr-error", "control-error", "proof-error", "stdin-error",
  "output-overflow", "post-proof-overflow", "post-proof-stdout-error", "post-proof-stderr-error", "stdout-close-before-end",
  "proof-forged", "proof-stale", "proof-extra", "proof-truncate", "proof-missing", "producer-exit", "proof-deadline"])
  retained(`synthetic owned launch/proof/channel settlement: ${fault}`, async (_t, record) => {
    const row = await syntheticWorker(record, fault);
    assert.equal(row.result.status, "started"); assert.equal(row.contexts.length, 1);
    assert.deepEqual(row.summaries.concurrentRunning, { status: "refused", reason: "admission" });
    assert.deepEqual(row.summaries.beforeChildClose, { status: "refused", reason: "admission" }, "proof/timer result does not release channel slot");
    assert.deepEqual(row.summaries.afterChildClose, { status: "refused", reason: "installer" });
    assert.equal(row.summaries.controlClosed, true);
    if (fault.startsWith("post-proof-") || fault === "stdout-close-before-end") assert.equal(row.summaries.proofWaitedForOutput, true);
    if (fault === "preparing-slot") {
      assert.deepEqual(row.summaries.concurrentPreparing, { status: "refused", reason: "admission" });
      assert.equal(row.summaries.passivePreparing.inspection.status, "observed");
    }
    if (row.summaries.passiveRunning) assert.equal(row.summaries.passiveRunning.inspection.status, "observed");
    assert.equal(row.summaries.spawnSelection.args[0], "context-bound-transport-v1");
    assert.ok(row.summaries.spawnSelection.args[1].endsWith("/artifact"));
    assert.equal(row.summaries.spawnSelection.args[4], row.contexts[0].root);
    assert.deepEqual(Object.keys(row.summaries.spawnSelection.options.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP",
      "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_DIRS", "XDG_CONFIG_HOME", "XDG_DATA_DIRS", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"].sort());
    if (["normal", "preparing-slot", "output-exact", "setup-failed", "stop-reentrant", "stop-running"].includes(fault)) {
      assert.equal(row.termination.status, "proven");
      assert.equal(row.termination.outcome.kind, fault === "setup-failed" ? "setup-failed" : fault.startsWith("stop-") ? "stopped" : "exited");
    } else {
      assert.equal(row.termination.status, "unproven");
      assert.equal(row.termination.reason, fault === "async-spawn" ? "spawn" : fault === "producer-exit" ? "producer" :
        fault === "proof-deadline" ? "deadline" : fault.startsWith("proof-") && fault !== "proof-error" ? "record" : "channel");
    }
  });

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) result.push(path);
  }
  return result;
}
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const imports = (source: string) => [...source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/gu)];
retained("exact installer/fixture exports, trusted importers and production exclusion stay closed", async (_t, record) => {
  const owner = await fs.readFile(ownerUrl, "utf8"), installer = await fs.readFile(installerUrl, "utf8");
  assert.deepEqual(Object.keys(installerModule).sort(), ["AcpInstaller", "bindAcpStoredFixtureInstaller"]);
  assert.deepEqual([...installer.matchAll(/^export\s+(?:type|interface)\s+(\w+)/gmu)].map(m => m[1]).sort(),
    ["AcpInstallFaultPoint", "AcpInstallerOptions", "AcpStoredFixtureBinding", "AcpStoredRuntimeObservation"]);
  assert.deepEqual([...owner.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gmu)].map(m => m[1]).sort(),
    ["prepareNativeBoundFixture", "prepareNativeContextBoundFixture", "startNativeBoundFixture", "startNativeContextBoundFixture",
      "startNativeLifetimeFixture", "startNativeStoredContextBoundFixture", "syntheticBoundFixtureChecks",
      "syntheticContextFixtureChecks", "syntheticLifetimeChecks"].sort());
  assert.deepEqual(imports(owner).filter(m => m[1].startsWith("../../src/")).map(m => m[1]).sort(),
    ["../../src/acp.ts", "../../src/acp-artifact-runtime.ts", "../../src/acp-probe-context.ts", "../../src/acp-install.ts"].sort());
  assert.equal((owner.match(/class Join \{/gu) ?? []).length, 1);
  assert.equal((owner.match(/associations\.set\(/gu) ?? []).length, 1);
  assert.doesNotMatch(owner, /process\.env|JSON\.parse|process\.kill\(|child\.kill\(/u);
  const bindingName = "bindAcpStoredFixtureInstaller";
  const trusted = ["packages/govd/test/fixtures/acp-probe-termination.ts", "packages/govd/test/acp-store-binding.test.ts",
    "packages/govd/test/acp-store-binding.native.ts"];
  const actualImporters: string[] = [], parserImporters: string[] = [], sourceHashes: Record<string, string> = {};
  const roots = [join(repo, "packages"), join(repo, "apps")];
  for (const root of roots) for (const path of await sourceFiles(root)) {
    const name = relative(repo, path), source = await fs.readFile(path, "utf8");
    if (!name.includes("/src/") && !name.includes("/test/")) continue;
    if (name.includes("/src/")) {
      if (path !== fileURLToPath(installerUrl)) assert.ok(!source.includes(bindingName), `production binding caller/importer: ${name}`);
      if (imports(source).some(m => /acp-artifact-runtime\.[cm]?[jt]s$/u.test(m[1]))) parserImporters.push(name);
      assert.doesNotMatch(source, /startNativeStoredContextBoundFixture|acp-store-binding\.native/u, name);
    }
    for (const statement of imports(source)) if (statement[0].includes(bindingName)) {
      assert.ok(trusted.includes(name), `unexpected trusted binding importer: ${name}`); actualImporters.push(name);
    }
    if (trusted.includes(name) || path === fileURLToPath(installerUrl)) sourceHashes[name] = hash(source);
  }
  assert.deepEqual([...new Set(actualImporters)].sort(), trusted.slice(0, 2).sort());
  assert.deepEqual(parserImporters, ["packages/govd/src/acp-install.ts"]);
  const index = join(evidence, "source-boundary-index.json"); record.locations.push(index);
  await fs.writeFile(index, JSON.stringify({ trustedImporters: trusted, actualImporters, parserImporters, sourceHashes,
    internalImports: "trusted-process boundary; not arbitrary-import secrecy", soleJoin: 1, soleEvidenceFactory: 1 }, null, 2), { flag: "wx" });
}, false);
