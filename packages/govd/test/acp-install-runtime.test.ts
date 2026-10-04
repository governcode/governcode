// Inert fixtures only. Every created tree and mutation location is retained.
// Builtin interception supplies deterministic failure seams, never production options.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpInstaller } from "../src/acp-install.ts";
import type { AcpInstallRequest } from "../src/acp-install-contract.ts";
import { installFingerprint } from "../src/acp-install-plan.ts";
import { ACP_REGISTRY_URL, decodeAcpRegistry, planAcpInstall } from "../src/acp-registry.ts";

const supported = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
const evidence = await fs.mkdtemp(join(tmpdir(), "acp-runtime-retained-"));
const manifest = join(evidence, "manifest.json");
type RecordEntry = { test: string; status: string; trees: string[]; locations: string[]; injections: string[] };
const records: RecordEntry[] = [];
const sourceHashes = Object.fromEntries(await Promise.all([
  "../src/acp-install.ts", "../src/acp-artifact-runtime.ts", "./acp-install-runtime.test.ts", "./acp-artifact-runtime.test.ts",
].map(async path => [path, createHash("sha256").update(await fs.readFile(new URL(path, import.meta.url))).digest("hex")])));
console.log(`ACP runtime retained evidence: ${evidence}; manifest: ${manifest}`);
function retained(name: string, run: (t: TestContext, record: RecordEntry) => Promise<void>) {
  test(name, { skip: !supported }, async t => {
    const record: RecordEntry = { test: name, status: "running", trees: [], locations: [], injections: [] };
    records.push(record);
    try { await run(t, record); record.status = "passed"; }
    catch (error) { record.status = "failed"; throw error; }
    finally { await fs.writeFile(manifest, JSON.stringify({ evidence, sourceHashes, records, nativeLaunches: 0,
      cleanup: false, unrun: ["legacy installer suites", "probe-context suite", "native/provider acceptance"] }, null, 2)); }
  });
}
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",") + "}";
  return JSON.stringify(value);
}
function elf(tag = 1, size = 192): Buffer {
  // Header/program tables without instructions or executable payload.
  const bytes = Buffer.alloc(size);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
  bytes.writeUInt32LE(1, 20); bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(tag === 1 ? 1 : 2, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeBigUInt64LE(1n, 96); bytes.writeBigUInt64LE(1n, 104);
  if (tag !== 1) bytes.writeUInt32LE(tag, 120);
  return bytes;
}
function request(bytes: Buffer, suffix = ""): AcpInstallRequest {
  const platform = process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  const catalog = { source: ACP_REGISTRY_URL, sha256: "a".repeat(64), fetchedAt: "2026-01-01T00:00:00.000Z" };
  const registry = decodeAcpRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: "inert-runtime" + suffix,
    name: "Inert Runtime", version: "1.0.0", description: "Invented inert bytes", license_url: "https://example.com/license",
    distribution: { binary: { [platform]: { archive: "https://example.com/inert" + suffix, sha256: hash(bytes), cmd: "inert" } } } }] }));
  const planned = planAcpInstall(registry.agents[0], platform, "binary"); assert.ok(planned.supported);
  return { operation: "I-1", catalog, plan: planned.plan, fingerprint: installFingerprint(catalog, planned.plan) };
}
async function fixture(record: RecordEntry, bytes = elf()) {
  const base = await fs.mkdtemp(join(evidence, "case-")), root = join(base, "store");
  record.trees.push(base);
  const input = request(bytes);
  const installer = new AcpInstaller(root, { download: async (_plan, file) => {
    await file.writeFile(bytes); return { bytes: bytes.length, sha256: hash(bytes) };
  } });
  const receipt = await installer.install(input, { signal: new AbortController().signal,
    gate: async () => ({ id: "G-1", allowed: true }) });
  const dir = join(root, input.fingerprint), artifact = join(dir, "artifact"), receiptPath = join(dir, "receipt.json");
  // Preserve the initial bytes/modes even in legacy same-inode mutation cases.
  const original = join(base, "original-store");
  record.locations.push(root, dir, artifact, receiptPath, original);
  await fs.cp(root, original, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  return { base, root, dir, artifact, receiptPath, input, installer, receipt, bytes };
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve };
}
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

retained("private receiver/primitive IDs reject trap-free before filesystem work", async (t, record) => {
  const f = await fixture(record); let traps = 0;
  const proxy = new Proxy({}, { get() { traps++; throw Error("trap"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const coerced = { toString() { traps++; return f.input.fingerprint; }, get valueOf() { traps++; throw Error("trap"); } };
  const hooks = intercept(t, () => { throw Error("unexpected filesystem activity"); });
  for (const id of [null, undefined, 1, Symbol("id"), {}, coerced, proxy, revoked.proxy, "", "A".repeat(64)])
    await assert.rejects(f.installer.inspectVerifiedRuntime(id as string), /installation ID/u);
  for (const receiver of [{}, Object.create(AcpInstaller.prototype), new Proxy(f.installer, {
    get() { traps++; throw Error("receiver trap"); }
  }), revoked.proxy]) await assert.rejects(AcpInstaller.prototype.inspectVerifiedRuntime.call(receiver, f.input.fingerprint), TypeError);
  assert.equal(traps, 0); assert.equal(hooks.events.length, 0);
});

retained("receipt-bound observed/refused results are frozen exact two-key evidence; legacy reuse preserved", async (_t, record) => {
  for (const tag of [1, 2, 3]) {
    const f = await fixture(record, elf(tag)), result = await f.installer.inspectVerifiedRuntime(f.input.fingerprint);
    assert.deepEqual(Object.keys(result), ["receipt", "inspection"]);
    assert.deepEqual(result.receipt, f.receipt);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.inspection));
    assert.ok(Object.isFrozen(result.receipt.plan.command) && Object.isFrozen(result.receipt.plan.checksum));
    assert.equal(result.inspection.status, tag === 1 ? "observed" : "refused");
    if (result.inspection.status === "refused") assert.equal(result.inspection.reason, tag === 2 ? "dynamic-segment" : "interpreter-segment");
    assert.deepEqual(await f.installer.inspectVerifiedRuntime(f.input.fingerprint), result);
    assert.equal((await f.installer.inspectVerified(f.input.fingerprint)).path, f.artifact);
    assert.deepEqual(await f.installer.installed(1), [f.receipt]);
    assert.deepEqual(await f.installer.install(f.input, { signal: new AbortController().signal,
      gate: async () => { throw Error("reuse must not gate/download"); } }), f.receipt);
    assert.deepEqual(await fs.readFile(f.artifact), f.bytes);
    await f.installer.stop(); await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint), /stopped/u);
  }
});

retained("actual receipt corruption rejects without destroying any installation", async (_t, record) => {
  const mutations: [string, (receipt: any, envelope: any) => void, boolean][] = [
    ["ID", r => { r.installationId = "0".repeat(64); }, true],
    ["envelope digest", (_r, e) => { e.sha256 = "0".repeat(64); }, false],
    ["fingerprint", r => { r.plan.command.push("changed"); }, true],
    ["receipt hash", r => { r.sha256 = "0".repeat(64); }, true],
    ["plan hash", r => { r.plan.checksum.value = "0".repeat(64); }, true],
    ["byte count", r => { r.bytes++; }, true],
    ["platform", r => { r.plan.platform = "unsupported"; }, true],
    ["gate", r => { r.gate = "G-forged"; }, true],
  ];
  for (const [label, mutate, rehash] of mutations) {
    const f = await fixture(record), envelope = JSON.parse(await fs.readFile(f.receiptPath, "utf8"));
    mutate(envelope.receipt, envelope); if (rehash) envelope.sha256 = hash(canonical(envelope.receipt));
    await fs.writeFile(f.receiptPath, canonical(envelope));
    await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint), Error, label);
    assert.deepEqual(await fs.readFile(f.artifact), f.bytes); assert.ok(await fs.stat(f.receiptPath));
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.from("{}"), Buffer.alloc(16 * 1024 + 1, 32)]) {
    const f = await fixture(record); await fs.writeFile(f.receiptPath, bytes);
    await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint));
    assert.deepEqual(await fs.readFile(f.receiptPath), bytes);
  }
});

retained("actual lock/sibling/symlink/hardlink/mode/missing/size failures retain mutations", async (_t, record) => {
  const actions: [string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>][] = [
    ["lock", f => fs.mkdir(join(f.root, ".lock"), { mode: 0o700 })],
    ["unexpected", f => fs.writeFile(join(f.root, "unexpected"), "inert")],
    ["sibling", f => fs.mkdir(join(f.root, "f".repeat(64)), { mode: 0o700 })],
    ["artifact mode", f => fs.chmod(f.artifact, 0o600)],
    ["receipt mode", f => fs.chmod(f.receiptPath, 0o644)],
    ["directory mode", f => fs.chmod(f.dir, 0o755)],
    ["root mode", f => fs.chmod(f.root, 0o755)],
    ["hardlink", f => fs.link(f.artifact, join(f.base, "hardlink"))],
    ["receipt hardlink", f => fs.link(f.receiptPath, join(f.base, "hardlink"))],
    ["missing", f => fs.rename(f.artifact, join(f.base, "original"))],
    ["symlink", async f => { await fs.rename(f.artifact, join(f.base, "original")); await fs.symlink(join(f.base, "original"), f.artifact); }],
    ["oversize", f => fs.truncate(f.artifact, 128 * 1024 * 1024 + 1)],
    ["truncate", f => fs.truncate(f.artifact, 63)],
  ];
  for (const [label, action] of actions) {
    const f = await fixture(record); record.locations.push(join(f.root, ".lock"), join(f.root, "unexpected"),
      join(f.root, "f".repeat(64)), join(f.base, "original"), join(f.base, "hardlink"));
    await action(f); await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint), Error, label);
    assert.ok(await fs.stat(f.base));
  }
});

retained("bounded positive short reads and all handles close once with two siblings", async (t, record) => {
  const f = await fixture(record, elf(1, 65539));
  const input = request(f.bytes, "-sibling");
  await f.installer.install(input, { signal: new AbortController().signal, gate: async () => ({ id: "G-2", allowed: true }) });
  record.locations.push(join(f.root, input.fingerprint), join(f.root, input.fingerprint, "artifact"), join(f.root, input.fingerprint, "receipt.json"));
  const hooks = intercept(t, e => {
    if (e.kind === "read" && e.phase === "before" && e.path.endsWith("/artifact"))
      e.args[2] = Math.min(e.args[2] as number, 37);
  });
  assert.equal((await f.installer.inspectVerifiedRuntime(f.input.fingerprint)).inspection.status, "observed");
  hooks.assertClosed(); hooks.restore();
});

retained("actual held artifact/receipt/directory/root replacements at captured-read seams reject", async (t, record) => {
  for (const mutation of ["same-size", "truncate", "grow", "artifact", "receipt", "directory", "root"]) {
    const f = await fixture(record); let fileOpens = 0, changed = false;
    const detached = join(f.base, "detached-" + mutation); record.locations.push(detached);
    const hooks = intercept(t, async e => {
      if (e.kind === "open" && e.phase === "after" && e.path.endsWith("/artifact")) fileOpens++;
      if (fileOpens !== 3 || changed || e.kind !== "read" || e.phase !== "after" || !e.path.endsWith("/artifact")) return;
      changed = true;
      if (mutation === "same-size") { const b = Buffer.from(f.bytes); b[191] = 7; await fs.writeFile(f.artifact, b); }
      else if (mutation === "truncate") await fs.truncate(f.artifact, 64);
      else if (mutation === "grow") await fs.appendFile(f.artifact, "x");
      else if (mutation === "artifact" || mutation === "receipt") {
        const path = mutation === "artifact" ? f.artifact : f.receiptPath;
        await fs.rename(path, detached); await fs.copyFile(detached, path); await fs.chmod(path, mutation === "artifact" ? 0o700 : 0o600);
      } else {
        const path = mutation === "directory" ? f.dir : f.root;
        await fs.rename(path, detached); await fs.cp(detached, path, { recursive: true, preserveTimestamps: true });
      }
    });
    await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint), Error, mutation);
    assert.ok(changed); hooks.assertClosed(); hooks.restore();
  }
});

retained("zero/invalid counts and injected read/stat/enumeration/open failures reject and close", async (t, record) => {
  for (const fault of ["zero", "negative", "fraction", "overcount", "nan", "read", "stat", "enumeration", "open", "owner", "metadata"]) {
    const f = await fixture(record); let injected = false;
    const hooks = intercept(t, e => {
      if (injected || e.phase !== "after") return;
      const read = e.kind === "read" && e.path.endsWith("/artifact");
      if (read && ["zero", "negative", "fraction", "overcount", "nan"].includes(fault)) {
        injected = true; return { ...e.result, bytesRead: { zero: 0, negative: -1, fraction: 0.5,
          overcount: (e.args[2] as number) + 1, nan: NaN }[fault] };
      }
      if ((fault === "read" && read) || (fault === "stat" && e.kind === "stat") ||
          (fault === "enumeration" && e.kind === "read" && e.args.length === 0)) { injected = true; throw Error("injected " + fault); }
      // Open failures occur before acquisition; no handle is deliberately abandoned by this hook.
      if (fault === "owner" && e.kind === "stat" && e.path.endsWith("/artifact")) {
        injected = true; return Object.assign(Object.create(Object.getPrototypeOf(e.result)), e.result, { uid: e.result.uid + 1n });
      }
      if (fault === "metadata" && e.kind === "stat" && e.path.endsWith("/artifact")) {
        injected = true; return Object.assign(Object.create(Object.getPrototypeOf(e.result)), e.result, { ctimeNs: e.result.ctimeNs + 1n });
      }
    });
    if (fault === "open") {
      hooks.restore();
      const original = fs.open; t.mock.method(fs, "open", async () => { injected = true; throw Error("injected open"); });
      syncBuiltinESMExports();
      await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint));
      t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal(typeof original, "function");
    } else {
      await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint)); hooks.assertClosed(); hooks.restore();
    }
    assert.ok(injected); record.injections.push(fault);
  }
});

retained("process-wide admission and shutdown await delayed open plus checked closure", async (t, record) => {
  const f = await fixture(record), other = new AcpInstaller(f.root), entered = deferred(), settle = deferred();
  let delayed = false;
  const hooks = intercept(t, async e => {
    if (e.kind === "open" && e.phase === "after" && !delayed) { delayed = true; entered.resolve(); await settle.promise; }
  });
  const task = f.installer.inspectVerifiedRuntime(f.input.fingerprint), rejected = assert.rejects(task, /stopped/u);
  await entered.promise;
  await assert.rejects(other.inspectVerifiedRuntime(f.input.fingerprint), /already active/u);
  let stopped = false; const stopping = f.installer.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  await assert.rejects(other.inspectVerifiedRuntime(f.input.fingerprint), /already active/u);
  settle.resolve(); await rejected; await stopping; hooks.assertClosed(); hooks.restore();
  assert.equal((await other.inspectVerifiedRuntime(f.input.fingerprint)).inspection.status, "observed");
});

retained("private constructed root/lifecycle cannot be replaced through public properties", async (_t, record) => {
  const f = await fixture(record), bad = join(f.base, "missing"); record.locations.push(bad);
  Object.assign(f.installer, { root: bad, stopped: false, active: new Map() });
  assert.equal((await f.installer.inspectVerifiedRuntime(f.input.fingerprint)).inspection.status, "observed");
  await f.installer.stop(); Object.assign(f.installer, { stopped: false });
  await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint), /stopped/u);
  const root = "/" + "a".repeat(256); await assert.rejects(new AcpInstaller(root).inspectVerifiedRuntime(f.input.fingerprint), /path limit/u);
  const longRoot = "/" + Array(20).fill("a".repeat(200)).join("/");
  await assert.rejects(new AcpInstaller(longRoot).inspectVerifiedRuntime(f.input.fingerprint), /path limit/u);
});

retained("all observed async seams refuse stop/absolute expiry; final close included", async (t, record) => {
  const f = await fixture(record);
  const traced = intercept(t, () => {});
  await f.installer.inspectVerifiedRuntime(f.input.fingerprint); traced.assertClosed();
  const count = traced.events.filter(e => e.phase === "after").length; traced.restore();
  for (const mode of ["stop", "deadline"]) {
    for (let seam = 0; seam < count; seam++) {
      const reader = new AcpInstaller(f.root); let index = 0, injected = false, stopping: Promise<void> | undefined;
      let now = 100; t.mock.method(performance, "now", () => now);
      const hooks = intercept(t, e => {
        if (e.phase !== "after" || index++ !== seam) return;
        injected = true;
        if (mode === "stop") stopping = reader.stop(); else now = 2100;
      });
      await assert.rejects(reader.inspectVerifiedRuntime(f.input.fingerprint));
      await stopping; assert.ok(injected, `${mode} seam ${seam}`); hooks.assertClosed(); hooks.restore();
      record.injections.push(`${mode}:after-seam:${seam}/${count}`);
    }
  }
  // Cumulative elapsed work, rather than a renewed per-operation clock.
  let now = 0; t.mock.method(performance, "now", () => now);
  const hooks = intercept(t, e => { if (e.phase === "after") now += 25; });
  await assert.rejects(new AcpInstaller(f.root).inspectVerifiedRuntime(f.input.fingerprint), /deadline/u);
  assert.ok(now >= 2000); hooks.assertClosed(); hooks.restore(); record.injections.push("cumulative absolute deadline");
});

retained("multiple close errors consume every responsibility once; no raw descriptor reuse close", async (t, record) => {
  const f = await fixture(record); let selectedOpened = false, failures = 0;
  const hooks = intercept(t, e => {
    if (e.kind === "open" && e.phase === "after" && e.path.endsWith("/artifact")) selectedOpened = true;
    if (selectedOpened && e.kind === "close" && e.phase === "after") { failures++; throw Error("injected close failure after actual close"); }
  });
  await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint));
  assert.ok(failures >= 3); hooks.assertClosed(); hooks.restore(); record.injections.push(`${failures} checked close failures after real close`);
  assert.equal((await new AcpInstaller(f.root).inspectVerifiedRuntime(f.input.fingerprint)).inspection.status, "observed");
});

retained("late malformed sibling, finite inventory limit, root/receipt symlinks and noncanonical bytes refuse", async (_t, record) => {
  const f = await fixture(record), sibling = join(f.root, "f".repeat(64)); record.locations.push(sibling);
  assert.ok(f.input.fingerprint < "f".repeat(64));
  await fs.mkdir(sibling, { mode: 0o700 });
  await assert.rejects(f.installer.installed(1));
  await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint));
  const bounded = await fixture(record);
  for (let i = 0; i < 256; i++) {
    const path = join(bounded.root, i.toString(16).padStart(64, "0")); record.locations.push(path);
    await fs.mkdir(path, { mode: 0o700 });
  }
  await assert.rejects(bounded.installer.inspectVerifiedRuntime(bounded.input.fingerprint), /entry limit/u);
  for (const kind of ["root", "directory", "receipt"]) {
    const f = await fixture(record), path = kind === "root" ? f.root : kind === "directory" ? f.dir : f.receiptPath;
    const moved = join(f.base, "original-" + kind); record.locations.push(moved);
    await fs.rename(path, moved); await fs.symlink(moved, path);
    await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint));
  }
  const noncanonical = await fixture(record);
  await fs.appendFile(noncanonical.receiptPath, "\n");
  await assert.rejects(noncanonical.installer.inspectVerifiedRuntime(noncanonical.input.fingerprint), /receipt bytes/u);
  await assert.rejects(new AcpInstaller(join(f.base, "absent-store")).inspectVerifiedRuntime(f.input.fingerprint));
  record.locations.push(join(f.base, "absent-store"));
});

retained("all acquisition failures and before-work stop retain ownership; no first-I/O race", async (t, record) => {
  const f = await fixture(record), baseline = intercept(t, () => {});
  await f.installer.inspectVerifiedRuntime(f.input.fingerprint);
  const acquisitions = baseline.events.filter(e => e.phase === "before" && ["open", "opendir"].includes(e.kind)).length;
  baseline.assertClosed(); baseline.restore();
  for (let seam = 0; seam < acquisitions; seam++) {
    let index = 0, injected = false;
    const hooks = intercept(t, e => {
      if (e.phase === "before" && ["open", "opendir"].includes(e.kind) && index++ === seam) {
        injected = true; throw Error("injected acquisition failure");
      }
    });
    await assert.rejects(new AcpInstaller(f.root).inspectVerifiedRuntime(f.input.fingerprint));
    assert.ok(injected); hooks.assertClosed(); hooks.restore(); record.injections.push(`acquisition:${seam}/${acquisitions}`);
  }
  const reader = new AcpInstaller(f.root), hooks = intercept(t, () => { throw Error("unexpected first I/O"); });
  const pending = reader.inspectVerifiedRuntime(f.input.fingerprint), rejected = assert.rejects(pending, /stopped/u);
  await reader.stop(); await rejected; assert.equal(hooks.events.length, 0); hooks.restore();
});

retained("failed consuming FileHandle close does not close a reused raw FD", async (t, record) => {
  const f = await fixture(record), reusedPath = join(f.base, "reused-fd"); record.locations.push(reusedPath);
  await fs.writeFile(reusedPath, "retained inert FD reuse sentinel", { mode: 0o600 });
  const originalOpen = fs.open; let reused: fs.FileHandle | undefined, injected = false, reusedFd = -1;
  const hooks = intercept(t, async e => {
    if (e.kind === "close" && e.phase === "before" && !injected) reusedFd = (e.object as fs.FileHandle).fd;
    if (e.kind === "close" && e.phase === "after" && !injected) {
      injected = true;
      reused = await originalOpen(reusedPath, "r");
      assert.equal(reused.fd, reusedFd, "actual kernel FD reuse at the checked-close seam");
      throw Error("injected close failure after FD reuse");
    }
  });
  try {
    await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint)); hooks.assertClosed();
    assert.ok(reused); assert.equal((await reused.stat()).size, 32);
    assert.equal(await reused.readFile("utf8"), "retained inert FD reuse sentinel");
    record.injections.push("checked close failure after actual kernel FD reuse");
  } finally { hooks.restore(); await reused?.close(); }
});

retained("shared reader preserves passive shape and exact internal-only binding export boundary", async (_t, record) => {
  const source = await fs.readFile(new URL("../src/acp-install.ts", import.meta.url), "utf8");
  const reader = source.slice(source.indexOf("class StoredRuntimeReader"), source.indexOf("export class AcpInstaller"));
  assert.doesNotMatch(reader, /\b(?:spawn|exec|fork|fetch|setTimeout|setInterval|rename|unlink|rmdir|mkdir)\s*\(/u);
  assert.doesNotMatch(source, /from "[^"\n]*(?:probe-context|probe-termination|probe-artifact|child_process)[^"\n]*"/u);
  const method = source.slice(source.indexOf("  async inspectVerifiedRuntime("), source.indexOf("  async inspectVerified(id:"));
  assert.match(method, /const root = this\.#runtimeRoot/u);
  assert.doesNotMatch(method, /this\.(?:root|stopped|active|download|fault)\b/u);
  assert.doesNotMatch(method + reader, /\bPromise\.race\b|\bcloseSync\b|\btoken\s*:/u);
  assert.deepEqual([...source.matchAll(/^export (?:type|interface|class|function) (\w+)/gmu)].map(m => m[1]),
    ["AcpInstallFaultPoint", "AcpInstallerOptions", "AcpStoredRuntimeObservation", "AcpStoredFixtureBinding",
      "bindAcpStoredFixtureInstaller", "AcpInstaller"]);
  assert.match(method, /new StoredRuntimeReader\(root, id, abort\.signal, performance\.now\(\) \+ 2000, "passive"\)/u);
  assert.match(reader, /observation = Object\.freeze\(\{ receipt: selected\.receipt, inspection \}\)/u);
  assert.match(reader, /if \(capture && this\.completion === "fixture" && before\.size > BigInt\(MAX_FIXTURE_CAPTURE\)\)/u);
  assert.ok(reader.indexOf('fail("fixture capture byte limit exceeded")') < reader.indexOf("Buffer.allocUnsafeSlow(size)"));
  assert.ok(reader.indexOf("await this.closeMany([...this.owned].reverse())") < reader.indexOf("Object.freeze({ bytes: captured!"));
  assert.match(source, /const MAX_FIXTURE_CAPTURE = 4 \* 1024 \* 1024/u);
  assert.match(source, /readonly #runtimeActive = new Map<Promise<unknown>, AbortController>/u);
  const binding = source.slice(source.indexOf("  static {"), source.indexOf("  constructor(root: string, opts:"));
  assert.doesNotMatch(binding, /(?:installer|owner|this)\.(?:root|stopped|active|download|fault|inspectVerifiedRuntime|inspectVerified)\b/u);
  assert.doesNotMatch(binding, /\b(?:open|opendir|spawn|exec|fork|fetch|rename|unlink|rmdir|mkdir|setTimeout|setInterval)\s*\(/u);
  assert.match(binding, /#runtimeRoot in installer/u);
  assert.match(binding, /fixtureBindings\.get\(this as object\)/u);
  assert.match(binding, /releasedFixtureBindings\.has\(receiver\)/u);
  assert.match(binding, /state\.task = task\.then\(\(\) => \{\}, \(\) => \{\}\)/u);
  assert.match(binding, /state\.installer = undefined; state\.root = undefined; state\.id = undefined/u);
  const stop = source.slice(source.indexOf("  async stop():"));
  assert.ok(stop.indexOf("this.#runtimeStopped = true") < stop.indexOf("this.stopped = true"));
  assert.ok(stop.indexOf("for (const abort of this.#fixtureBindings)") < stop.indexOf("const readers = [...this.#runtimeActive]"));
  assert.ok(stop.indexOf("const readers = [...this.#runtimeActive]") < stop.indexOf("this.stopped = true"));
  record.injections.push("static public API/import/launch boundary checks");
});

retained("nullish I/O and closure rejections cannot be mistaken for successful settlement", async (t, record) => {
  for (const kind of ["read", "close"]) for (const rejection of [undefined, null]) {
    const f = await fixture(record); let injected = false;
    const hooks = intercept(t, e => {
      if (!injected && e.kind === kind && e.phase === "after") { injected = true; throw rejection; }
    });
    let rejected = false;
    try { await f.installer.inspectVerifiedRuntime(f.input.fingerprint); }
    catch { rejected = true; }
    assert.ok(rejected && injected); hooks.assertClosed(); hooks.restore();
    record.injections.push(`${kind}:throw:${String(rejection)}`);
    assert.equal((await new AcpInstaller(f.root).inspectVerifiedRuntime(f.input.fingerprint)).inspection.status, "observed");
  }
});

retained("private shutdown settles a reader even when legacy lifecycle setters throw", async (t, record) => {
  const f = await fixture(record), entered = deferred(), settle = deferred(); let delayed = false;
  const hooks = intercept(t, async e => {
    if (!delayed && e.kind === "open" && e.phase === "after") { delayed = true; entered.resolve(); await settle.promise; }
  });
  const pending = f.installer.inspectVerifiedRuntime(f.input.fingerprint), rejected = assert.rejects(pending, /stopped/u);
  await entered.promise;
  Object.defineProperty(f.installer, "stopped", { set() { throw Error("injected legacy setter failure"); } });
  let stopped = false;
  const stopping = f.installer.stop();
  const checked = assert.rejects(stopping, /legacy setter/u).then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  settle.resolve(); await rejected; await checked; hooks.assertClosed(); hooks.restore();
  await assert.rejects(f.installer.inspectVerifiedRuntime(f.input.fingerprint), /stopped/u);
  record.injections.push("legacy lifecycle setter failure with owned delayed open");
});
