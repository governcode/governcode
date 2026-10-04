import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AcpInstaller, type AcpInstallFaultPoint } from "../src/acp-install.ts";
import type { AcpArtifactDownloader, AcpInstallHooks, AcpInstallRequest } from "../src/acp-install-contract.ts";
import { installFingerprint } from "../src/acp-install-plan.ts";
import { ACP_REGISTRY_URL, decodeAcpRegistry, planAcpInstall } from "../src/acp-registry.ts";

const supportedHost = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function elf(): Buffer {
  // Invented header bytes only: no instructions, code, or provider binary.
  const b = Buffer.alloc(128);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  b.writeUInt16LE(2, 16); b.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
  b.writeUInt32LE(1, 20); b.writeUInt16LE(64, 52);
  return b;
}
function request(bytes = elf(), change: Partial<AcpInstallRequest["plan"]> = {}): AcpInstallRequest {
  const platform = process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
  const registry = decodeAcpRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: "fixture-agent",
    name: "Fixture Agent", version: "1.2.3", description: "Invented fixture", license_url: "https://example.com/license",
    distribution: { binary: { [platform]: { archive: "https://example.com/releases/1.2.3/fixture-agent",
      sha256: hash(bytes), cmd: "fixture-agent", args: ["--acp"] } } } }] }));
  const result = planAcpInstall(registry.agents[0], platform, "binary");
  assert.ok(result.supported);
  const plan = { ...result.plan, ...change };
  const catalog = { source: ACP_REGISTRY_URL, sha256: "a".repeat(64), fetchedAt: "2026-01-01T00:00:00.000Z" };
  return { operation: "I-1", catalog, plan, fingerprint: installFingerprint(catalog, plan) };
}
function hooks(signal = new AbortController().signal): AcpInstallHooks {
  return { signal, gate: async () => ({ id: "G-1", allowed: true }) };
}
function fakeDownload(bytes = elf()): AcpArtifactDownloader {
  return async (_plan, file, signal) => {
    signal.throwIfAborted(); await file.writeFile(bytes);
    return { bytes: bytes.length, sha256: hash(bytes) };
  };
}
async function fixture(t: TestContext): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), "acp-install-fixture-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root: join(base, "store") };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function stagePath(root: string): Promise<string> {
  const stages = (await readdir(root)).filter(n => n.startsWith(".stage-"));
  assert.equal(stages.length, 1); return join(root, stages[0]);
}

// Intercept the actual standard-library call, after installer ownership checks.
// Refresh builtin ESM bindings on both setup and teardown; no production seam or
// native harness is needed to deterministically exercise the pathname race.
async function interceptRename(t: TestContext, action: (source: string, target: string) => Promise<void>): Promise<void> {
  const original = fsPromises.rename;
  t.mock.method(fsPromises, "rename", async (source: string, target: string) => {
    await action(source, target);
    return original(source, target);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("approved raw artifact is atomic, private, bound, reverified and registry-advertised", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), r = request();
  let gates = 0, downloads = 0;
  const installer = new AcpInstaller(root, { download: async (plan, file, signal) => {
    assert.equal(gates, 1); downloads++;
    assert.equal(Object.isFrozen(plan), true);
    assert.deepEqual((await readdir(root)).filter(n => /^[a-f0-9]{64}$/u.test(n)), []);
    return fakeDownload()(plan, file, signal);
  } });
  const receipt = await installer.install(r, { ...hooks(), gate: async reviewed => {
    gates++; assert.deepEqual(reviewed, r); assert.ok(Object.isFrozen(reviewed.catalog));
    assert.ok(Object.isFrozen(reviewed.plan.command)); return { id: "G-12", allowed: true };
  } });
  assert.equal(receipt.installationId, r.fingerprint); assert.equal(receipt.gate, "G-12");
  assert.equal(receipt.versionEvidence, "registry-advertised"); assert.equal(receipt.bytes, 128);
  const inspected = await installer.inspectVerified(r.fingerprint);
  assert.deepEqual(inspected.receipt, receipt); assert.equal(inspected.path, join(root, r.fingerprint, "artifact"));
  assert.deepEqual(await readFile(inspected.path), elf());
  assert.equal((await stat(root)).mode & 0o7777, 0o700);
  assert.equal((await stat(join(root, r.fingerprint))).mode & 0o7777, 0o700);
  assert.equal((await stat(inspected.path)).mode & 0o7777, 0o700);
  assert.equal((await stat(join(root, r.fingerprint, "receipt.json"))).mode & 0o7777, 0o600);
  assert.deepEqual(await readdir(join(root, r.fingerprint)), ["artifact", "receipt.json"]);
  assert.deepEqual(await installer.installed(), [receipt]); assert.equal(downloads, 1);
});

test("denied, invalid and pre-cancelled approval paths never download or create store state", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  let downloads = 0;
  const installer = new AcpInstaller(root, { download: async () => { downloads++; throw new Error("unexpected download"); } });
  for (const answer of [{ id: "G-1", allowed: false }, { id: "G-1", allowed: "true" },
    { id: "invalid", allowed: true }, { id: "G-1", allowed: true, remember: true },
    { id: "G-" + "1".repeat(17), allowed: true }]) {
    await assert.rejects(installer.install(request(), { ...hooks(), gate: async () => answer as never }), /approval/u);
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(installer.install(request(), { signal: abort.signal, gate: async () => { throw new Error("unexpected gate"); } }));
  assert.equal(downloads, 0); await assert.rejects(stat(root), { code: "ENOENT" });
});

test("stale fingerprint and malformed runtime contracts refuse before Gate", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), r = request(); let gates = 0;
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  for (const bad of [
    { ...r, fingerprint: "0".repeat(64) }, { ...r, operation: "unknown" }, { ...r, extra: true },
    { ...r, plan: { ...r.plan, source: "https://example.com/releases/1.2.3/changed" } },
    { ...r, catalog: { ...r.catalog, source: "https://example.com/catalog" } },
    { ...r, plan: { ...r.plan, command: ["../../agent"] } },
    { ...r, plan: { ...r.plan, name: "x".repeat(257) } },
  ]) await assert.rejects(installer.install(bad as AcpInstallRequest, { ...hooks(), gate: async () => {
    gates++; return { id: "G-1", allowed: true };
  } }));
  assert.equal(gates, 0); await assert.rejects(stat(root), { code: "ENOENT" });
});

test("request mutation during Gate cannot change approved download or receipt", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), r = structuredClone(request()), reviewed = structuredClone(r);
  const installer = new AcpInstaller(root, { download: async (plan, file, signal) => {
    assert.deepEqual(plan, reviewed.plan); return fakeDownload()(plan, file, signal);
  } });
  const receipt = await installer.install(r, { ...hooks(), gate: async fixed => {
    (r.plan as { source: string }).source = "https://example.com/changed";
    (r.plan.command as string[])[0] = "changed";
    (r.catalog as { sha256: string }).sha256 = "b".repeat(64);
    assert.deepEqual(fixed, reviewed); return { id: "G-1", allowed: true };
  } });
  assert.deepEqual(receipt.plan, reviewed.plan); assert.deepEqual(receipt.catalog, reviewed.catalog);
});

test("matching verified artifact reuses receipt without Gate, write or download", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), r = request();
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  const receipt = await installer.install(r, hooks());
  const before = await stat(join(root, r.fingerprint, "receipt.json"));
  const reuse = new AcpInstaller(root, { download: async () => { throw new Error("unexpected download"); } });
  const next = { ...r, operation: "I-2", catalog: { ...r.catalog, fetchedAt: "2026-02-01T00:00:00.000Z" } };
  assert.equal(installFingerprint(next.catalog, next.plan), r.fingerprint);
  assert.deepEqual(await reuse.install(next, { ...hooks(), gate: async () => { throw new Error("unexpected gate"); } }), receipt);
  const after = await stat(join(root, r.fingerprint, "receipt.json"));
  assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ino, before.ino);
});

test("changed source, checksum, argv or catalog digest creates distinct installations and new Gates", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t); let gates = 0, downloads = 0;
  const changedBytes = elf(); changedBytes[100] = 1;
  const installer = new AcpInstaller(root, { download: async (plan, file, signal) => {
    downloads++; return fakeDownload(plan.checksum!.value === hash(changedBytes) ? changedBytes : elf())(plan, file, signal);
  } });
  const base = request(), changedCatalog = { ...base.catalog, sha256: "b".repeat(64) };
  const requests = [base, request(elf(), { source: "https://example.com/releases/1.2.3/other-agent" }),
    request(changedBytes), request(elf(), { command: ["fixture-agent", "--changed"] }),
    { ...base, catalog: changedCatalog, fingerprint: installFingerprint(changedCatalog, base.plan) }];
  for (const r of requests) await installer.install(r, { ...hooks(), gate: async () => ({ id: `G-${++gates}`, allowed: true }) });
  assert.equal(gates, 5); assert.equal(downloads, 5); assert.equal((await installer.installed()).length, 5);
  assert.equal((await installer.installed(2)).length, 2);
});

test("invalid ELF headers, architecture, scripts and checksums are never published", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  const variants: Buffer[] = [];
  for (const [offset, value] of [[0, 0], [4, 1], [5, 2], [6, 2], [7, 9], [16, 1], [18, 0], [20, 0], [52, 0]]) {
    const b = elf(); b[offset] = value; variants.push(b);
  }
  variants.push(Buffer.from("#!/bin/sh\nexit 0\n"), Buffer.alloc(63));
  for (const b of variants) {
    const installer = new AcpInstaller(root, { download: fakeDownload(b) });
    await assert.rejects(installer.install(request(b), hooks()), /ELF64|artifact size/u);
    assert.deepEqual(await readdir(root), []);
  }
  const installer = new AcpInstaller(root, { download: fakeDownload(Buffer.concat([elf(), Buffer.from("changed")])) });
  await assert.rejects(installer.install(request(), hooks()), /checksum mismatch/u);
  assert.deepEqual(await readdir(root), []);
});

test("cancellation in download cleans owned staging and stop awaits settlement", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), entered = deferred(); let settled = false;
  const installer = new AcpInstaller(root, { download: async (_plan, file, signal) => {
    await file.writeFile(Buffer.alloc(16)); entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      const cancelled = () => { settled = true; reject(signal.reason); };
      signal.addEventListener("abort", cancelled, { once: true }); if (signal.aborted) cancelled();
    });
    throw new Error("unexpected continuation");
  } });
  const pending = installer.install(request(), hooks()); const rejected = assert.rejects(pending, /stopped/u);
  await entered.promise; await installer.stop(); await rejected;
  assert.equal(settled, true); assert.deepEqual(await readdir(root), []);
  await assert.rejects(installer.install(request(), hooks()), /stopped/u);
});

test("stop cancels an unresolved Gate without download or store creation", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), entered = deferred(), answer = deferred<{ id: string; allowed: boolean }>();
  const installer = new AcpInstaller(root, { download: async () => { throw new Error("unexpected download"); } });
  const pending = installer.install(request(), { ...hooks(), gate: () => { entered.resolve(); return answer.promise; } });
  const rejected = assert.rejects(pending, /stopped/u); await entered.promise;
  await installer.stop(); await rejected; answer.resolve({ id: "G-1", allowed: true });
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("cancellation at publication boundary keeps installation invisible", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), abort = new AbortController();
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: async point => {
    if (point !== "before-publish") return;
    assert.equal((await readdir(root)).some(n => /^[a-f0-9]{64}$/u.test(n)), false);
    abort.abort(new Error("fixture cancellation"));
  } });
  await assert.rejects(installer.install(request(), hooks(abort.signal)), /fixture cancellation/u);
  assert.deepEqual(await readdir(root), []);
});

test("failures at each durable boundary clean staging; post-publication fault leaves verified receipt", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  const points: AcpInstallFaultPoint[] = ["after-lock", "after-download", "after-artifact-sync", "after-receipt-sync", "before-publish"];
  for (const target of points) {
    const installer = new AcpInstaller(root, { download: fakeDownload(), fault: point => {
      if (point === target) throw new Error("fixture fault");
    } });
    await assert.rejects(installer.install(request(), hooks()), /fixture fault/u);
    assert.deepEqual(await readdir(root), []);
  }
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: point => {
    if (point === "after-publish") throw new Error("fixture post-publication fault");
  } });
  await assert.rejects(installer.install(request(), hooks()), /fixture post-publication fault/u);
  assert.equal((await installer.inspectVerified(request().fingerprint)).receipt.bytes, 128);
  assert.deepEqual(await readdir(root), [request().fingerprint]);
});

test("concurrent installer instances refuse while one owns the store lock", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), entered = deferred(), release = deferred();
  const first = new AcpInstaller(root, { download: async (plan, file, signal) => {
    entered.resolve(); await release.promise; return fakeDownload()(plan, file, signal);
  } });
  const pending = first.install(request(), hooks()); await entered.promise;
  const second = new AcpInstaller(root, { download: async () => { throw new Error("unexpected download"); } });
  await assert.rejects(second.install(request(), hooks()), /locked/u);
  await assert.rejects(second.installed(), /locked/u);
  release.resolve(); await pending;
  assert.equal((await second.inspectVerified(request().fingerprint)).receipt.bytes, 128);
});

test("another installer process owns the lock; a crash leaves blocked lock and staging", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  // A fake installer process writes only invented ELF bytes and stops before publication.
  const installerUrl = new URL("../src/acp-install.ts", import.meta.url).href;
  const script = `import {AcpInstaller} from ${JSON.stringify(installerUrl)};
    const [root,requestJson,bytesBase64]=process.argv.slice(1);
    const bytes=Buffer.from(bytesBase64,'base64');
    const installer=new AcpInstaller(root,{download:async(_plan,file,signal)=>{
      signal.throwIfAborted(); await file.writeFile(bytes); return {bytes:bytes.length,sha256:'unused'};
    },fault:async(point)=>{if(point==='before-publish'){
      process.stdout.write('ready'); await new Promise(()=>{setInterval(()=>{},1000);});
    }}});
    await installer.install(JSON.parse(requestJson),{signal:new AbortController().signal,
      gate:async()=>({id:'G-1',allowed:true})});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    script, root, JSON.stringify(request()), elf().toString("base64")],
  { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve()); child.once("error", reject);
    child.once("exit", () => reject(new Error("fixture process exited before holding lock")));
  });
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.install(request(), hooks()), /locked/u);
  child.kill(); await exited;
  await assert.rejects(installer.install(request(), hooks()), /locked/u);
  assert.equal((await readdir(root)).includes(".lock"), true);
  const stage = await stagePath(root);
  assert.deepEqual(await readdir(stage), ["artifact", "receipt.json"]);
});

test("pending Gate performs no download or store writes, and approval values are copied", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), entered = deferred(), release = deferred<{ id: string; allowed: boolean }>();
  let downloads = 0;
  const answer = { id: "G-7", allowed: true };
  const installer = new AcpInstaller(root, { download: async (plan, file, signal) => {
    downloads++; answer.id = "invalid"; answer.allowed = false; return fakeDownload()(plan, file, signal);
  } });
  const pending = installer.install(request(), { ...hooks(), gate: () => { entered.resolve(); return release.promise; } });
  await entered.promise; assert.equal(downloads, 0); await assert.rejects(stat(root), { code: "ENOENT" });
  release.resolve(answer); assert.equal((await pending).gate, "G-7");
});

test("shutdown at the final publication boundary prevents publication", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t); let shutdown: Promise<void> | undefined;
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: point => {
    if (point === "before-publish") shutdown = installer.stop();
  } });
  await assert.rejects(installer.install(request(), hooks()), /stopped/u); await shutdown;
  assert.deepEqual(await readdir(root), []);
});

test("lock replacement before publication refuses and preserves the other owner's lock", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), oldLock = join(base, "detached-lock");
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: async point => {
    if (point === "before-publish") {
      await rename(join(root, ".lock"), oldLock); await mkdir(join(root, ".lock"), { mode: 0o700 });
    }
  } });
  await assert.rejects(installer.install(request(), hooks()), /lock ownership changed/u);
  assert.deepEqual(await readdir(root), [".lock"]); assert.ok((await stat(oldLock)).isDirectory());
});

test("receipt size is checked before requesting approval or downloading", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), r = request(elf(), { command: ["fixture-agent", ...Array(16).fill("a".repeat(1024))] });
  const installer = new AcpInstaller(root, { download: async () => { throw new Error("unexpected download"); } });
  await assert.rejects(installer.install(r, { ...hooks(), gate: async () => { throw new Error("unexpected Gate"); } }), /receipt limit/u);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("uppercase advertised digests and UTC catalog times without milliseconds remain valid", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), base = request();
  const catalog = { ...base.catalog, sha256: base.catalog.sha256.toUpperCase(), fetchedAt: "2026-01-01T00:00:00Z" };
  const plan = { ...base.plan, checksum: { algorithm: "sha256" as const, value: base.plan.checksum!.value.toUpperCase() } };
  const r = { ...base, catalog, plan, fingerprint: installFingerprint(catalog, plan) };
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  const receipt = await installer.install(r, hooks());
  assert.equal(receipt.sha256, hash(elf())); assert.equal(receipt.catalog.fetchedAt, catalog.fetchedAt);
  assert.equal((await installer.inspectVerified(r.fingerprint)).receipt.gate, "G-1");
});

test("ambiguous crash leftovers and excessive directory entries are blocked without cleanup", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t); await mkdir(root, { mode: 0o700 });
  const leftover = join(root, ".stage-leftover"); await mkdir(leftover, { mode: 0o700 });
  await writeFile(join(leftover, "unknown"), "fixture", { mode: 0o600 });
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.installed(), /ambiguous/u);
  await assert.rejects(installer.install(request(), hooks()), /ambiguous/u);
  assert.equal(await readFile(join(leftover, "unknown"), "utf8"), "fixture");
  await rm(leftover, { recursive: true });
  for (let i = 0; i < 258; i++) await mkdir(join(root, i.toString(16).padStart(64, "0")), { mode: 0o700 });
  await assert.rejects(installer.installed(), /entry limit/u);
  assert.equal((await readdir(root)).length, 258);
});

test("receipt and artifact tampering, extra files, links, types and unsafe permissions refuse reuse", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), r = request();
  const changes: ((dir: string) => Promise<void>)[] = [
    async dir => { const p = join(dir, "artifact"); const b = await readFile(p); b[100] ^= 1; await writeFile(p, b); },
    async dir => { const p = join(dir, "receipt.json"); await writeFile(p, (await readFile(p, "utf8")) + "\n"); },
    async dir => { const p = join(dir, "receipt.json"); const v = JSON.parse(await readFile(p, "utf8")); v.receipt.gate = "G-2"; await writeFile(p, JSON.stringify(v)); },
    async dir => { await writeFile(join(dir, "unexpected"), "fixture", { mode: 0o600 }); },
    async dir => { await chmod(join(dir, "artifact"), 0o755); },
    async dir => { await chmod(join(dir, "receipt.json"), 0o644); },
    async dir => { await chmod(dir, 0o755); },
    async dir => { await link(join(dir, "artifact"), join(base, "hardlink")); },
    async dir => { await link(join(dir, "receipt.json"), join(base, "hardlink")); },
    async dir => { const p = join(dir, "artifact"); await unlink(p); await symlink(join(base, "outside"), p); },
    async dir => { const p = join(dir, "receipt.json"); await unlink(p); await symlink(join(base, "outside"), p); },
    async dir => { const p = join(dir, "artifact"); await unlink(p); await mkdir(p, { mode: 0o700 }); },
    async dir => { const p = join(dir, "receipt.json"); await unlink(p); await mkdir(p, { mode: 0o700 }); },
  ];
  await writeFile(join(base, "outside"), "outside fixture", { mode: 0o600 });
  for (const change of changes) {
    await rm(root, { force: true, recursive: true }); await rm(join(base, "hardlink"), { force: true });
    const installer = new AcpInstaller(root, { download: fakeDownload() });
    await installer.install(r, hooks()); await change(join(root, r.fingerprint));
    await assert.rejects(installer.inspectVerified(r.fingerprint));
    await assert.rejects(installer.install(r, { ...hooks(), gate: async () => { throw new Error("unexpected Gate"); } }));
    assert.equal(await readFile(join(base, "outside"), "utf8"), "outside fixture");
  }
});

test("symlinked ancestors, store roots and installation directories are refused", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t); const actual = join(base, "actual");
  await mkdir(actual, { mode: 0o700 }); await symlink(actual, root);
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.install(request(), hooks())); assert.deepEqual(await readdir(actual), []);
  await assert.rejects(new AcpInstaller(join(root, "nested"), { download: fakeDownload() }).install(request(), hooks()));
  await unlink(root); await mkdir(root, { mode: 0o700 });
  await symlink(actual, join(root, request().fingerprint));
  await assert.rejects(installer.inspectVerified(request().fingerprint));
});

test("unsafe root and invalid root/installation/list contracts are refused", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  for (const invalid of ["relative", "/", root + "/", root + "/../store"]) assert.throws(() => new AcpInstaller(invalid));
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  assert.deepEqual(await installer.installed(), []);
  for (const limit of [0, 101, -1, 1.5, NaN]) await assert.rejects(installer.installed(limit), /list limit/u);
  for (const id of ["../outside", "abc", "a".repeat(65)]) await assert.rejects(installer.inspectVerified(id), /installation ID/u);
  await mkdir(root, { mode: 0o755 });
  await assert.rejects(installer.install(request(), hooks()), /unsafe store directory/u);
});

test("oversized receipts refuse bounded reads", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), r = request(); const installer = new AcpInstaller(root, { download: fakeDownload() });
  await installer.install(r, hooks()); await writeFile(join(root, r.fingerprint, "receipt.json"), Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(installer.inspectVerified(r.fingerprint), /receipt byte limit/u);
});

test("unexpected staging files are left for manual recovery instead of recursive cleanup", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: async point => {
    if (point === "after-download") {
      await writeFile(join(await stagePath(root), "unexpected"), "fixture", { mode: 0o600 });
      throw new Error("fixture interruption");
    }
  } });
  await assert.rejects(installer.install(request(), hooks()), /ambiguous staging/u);
  const stage = await stagePath(root); assert.equal(await readFile(join(stage, "unexpected"), "utf8"), "fixture");
  assert.ok((await readdir(root)).includes(".lock"));
  await assert.rejects(new AcpInstaller(root, { download: fakeDownload() }).install(request(), hooks()), /locked/u);
});

test("root identity replacement at publication cannot redirect writes", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), detached = join(base, "detached");
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: async point => {
    if (point === "before-publish") { await rename(root, detached); await mkdir(root, { mode: 0o700 }); }
  } });
  await assert.rejects(installer.install(request(), hooks()), /root identity changed/u);
  assert.deepEqual(await readdir(root), []); assert.deepEqual(await readdir(detached), []);
});

test("staging file replacement at publication is rejected and ambiguous replacement is retained", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: async point => {
    if (point === "before-publish") {
      const file = join(await stagePath(root), "artifact"); await unlink(file);
      await writeFile(file, Buffer.alloc(128), { mode: 0o700 });
    }
  } });
  await assert.rejects(installer.install(request(), hooks()));
  assert.equal((await readdir(root)).some(n => /^[a-f0-9]{64}$/u.test(n)), false);
});

test("stage replacement inside the publication rename cannot return a verified receipt", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), r = request(), detached = join(base, "original-stage");
  const originalRename = fsPromises.rename;
  let raced = false;
  await interceptRename(t, async (source, target) => {
    if (!source.split("/").at(-1)?.startsWith(".stage-") || !target.endsWith(`/${r.fingerprint}`)) return;
    raced = true;
    const receipt = await readFile(join(source, "receipt.json"));
    await originalRename(source, detached);
    await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, "artifact"), Buffer.alloc(128), { mode: 0o700 });
    await writeFile(join(source, "receipt.json"), receipt, { mode: 0o600 });
  });
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.install(r, hooks()), /ownership changed/u);
  assert.ok(raced);
  assert.deepEqual(await readFile(join(root, r.fingerprint, "artifact")), Buffer.alloc(128));
  assert.deepEqual(await readFile(join(detached, "artifact")), elf());
  assert.ok((await readdir(root)).includes(".lock"));
  await assert.rejects(installer.installed(), /locked/u);
});

test("artifact replacement inside publication rename is detected even when bytes and receipt match", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), r = request(), detached = join(base, "original-artifact");
  const originalRename = fsPromises.rename;
  let raced = false;
  await interceptRename(t, async (source, target) => {
    if (!source.split("/").at(-1)?.startsWith(".stage-") || !target.endsWith(`/${r.fingerprint}`)) return;
    raced = true;
    await originalRename(join(source, "artifact"), detached);
    await writeFile(join(source, "artifact"), elf(), { mode: 0o700 });
  });
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.install(r, hooks()), /artifact ownership changed/u);
  assert.ok(raced);
  assert.notEqual((await stat(detached)).ino, (await stat(join(root, r.fingerprint, "artifact"))).ino);
  assert.ok((await readdir(root)).includes(".lock"));
});

test("post-publication evidence is rechecked before success and uncertain state is retained", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), r = request();
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: async point => {
    if (point === "after-publish") {
      const bytes = elf(); bytes[100] = 1;
      await writeFile(join(root, r.fingerprint, "artifact"), bytes);
    }
  } });
  await assert.rejects(installer.install(r, hooks()), /checksum mismatch/u);
  assert.deepEqual(await readdir(root), [".lock", r.fingerprint]);
});

test("cleanup captures a raced artifact and retains every entry before any deletion", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), detached = join(base, "original-artifact");
  const originalRename = fsPromises.rename;
  let raced = false;
  await interceptRename(t, async (source, target) => {
    if (!source.endsWith("/artifact") || !target.endsWith("/artifact")) return;
    raced = true;
    await originalRename(source, detached);
    await writeFile(source, "replacement fixture", { mode: 0o700 });
  });
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: point => {
    if (point === "before-publish") throw new Error("fixture cleanup trigger");
  } });
  await assert.rejects(installer.install(request(), hooks()), /staging file ownership changed/u);
  assert.ok(raced);
  const entries = await readdir(root), captured = entries.find(n => n.startsWith(".cleanup-"));
  assert.ok(captured); assert.ok(entries.includes(".lock"));
  assert.equal(await readFile(join(root, captured, ".captured", "artifact"), "utf8"), "replacement fixture");
  assert.deepEqual(await readFile(detached), elf());
  assert.ok((await readFile(join(root, captured, ".captured", "receipt.json"))).length);
  await assert.rejects(installer.installed(), /ambiguous|locked/u);
});

test("cleanup stage capture retains a replacement directory instead of removing it", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), detached = join(base, "original-stage");
  const originalRename = fsPromises.rename;
  let raced = false;
  await interceptRename(t, async (source, target) => {
    if (!source.split("/").at(-1)?.startsWith(".stage-") || !target.split("/").at(-1)?.startsWith(".cleanup-")) return;
    raced = true;
    await originalRename(source, detached);
    await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, "replacement"), "replacement fixture", { mode: 0o600 });
  });
  const installer = new AcpInstaller(root, { download: fakeDownload(), fault: point => {
    if (point === "before-publish") throw new Error("fixture cleanup trigger");
  } });
  await assert.rejects(installer.install(request(), hooks()), /ownership changed/u);
  assert.ok(raced);
  const entries = await readdir(root), captured = entries.find(n => n.startsWith(".cleanup-"));
  assert.ok(captured); assert.ok(entries.includes(".lock"));
  assert.equal(await readFile(join(root, captured, "replacement"), "utf8"), "replacement fixture");
  assert.deepEqual(await readdir(detached), ["artifact", "receipt.json"]);
});

test("lock release captures a replacement and refuses without deleting it", { skip: !supportedHost }, async t => {
  const { root, base } = await fixture(t), detached = join(base, "original-lock");
  const originalRename = fsPromises.rename;
  let raced = false;
  await interceptRename(t, async (source, target) => {
    if (!source.endsWith("/.lock") || !target.split("/").at(-1)?.startsWith(".unlock-")) return;
    raced = true;
    await originalRename(source, detached);
    await mkdir(source, { mode: 0o700 });
  });
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.install(request(), hooks()), /ownership changed/u);
  assert.ok(raced);
  const captured = (await readdir(root)).find(n => n.startsWith(".unlock-"));
  assert.ok(captured);
  assert.ok((await stat(join(root, captured))).isDirectory());
  assert.ok((await stat(detached)).isDirectory());
  await assert.rejects(installer.installed(), /ambiguous/u);
});

test("lock release never removes a new owner's lock created at the rmdir boundary", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  const originalRmdir = fsPromises.rmdir;
  let newOwner: Awaited<ReturnType<typeof stat>> | undefined;
  t.mock.method(fsPromises, "rmdir", async (path: string) => {
    if (path.split("/").at(-1)?.startsWith(".unlock-")) {
      await mkdir(join(root, ".lock"), { mode: 0o700 });
      newOwner = await stat(join(root, ".lock"));
    }
    return originalRmdir(path);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  assert.equal((await installer.install(request(), hooks())).installationId, request().fingerprint);
  assert.ok(newOwner);
  assert.equal((await stat(join(root, ".lock"))).ino, newOwner.ino);
  assert.deepEqual(await readdir(root), [".lock", request().fingerprint]);
});

test("malformed siblings beyond installed(1) are validated and block reuse, install and inspection", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  const requests = [request(), request(elf(), { command: ["fixture-agent", "--other"] })]
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const good = requests[0], bad = requests[1];
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await installer.install(good, hooks()); await installer.install(bad, hooks());
  await writeFile(join(root, bad.fingerprint, "receipt.json"), "{}");
  const before = await readdir(root); let gates = 0, downloads = 0;
  const reader = new AcpInstaller(root, { download: async () => { downloads++; throw new Error("unexpected download"); } });
  const guardedHooks = { ...hooks(), gate: async () => { gates++; return { id: "G-1", allowed: true }; } };
  await assert.rejects(reader.installed(1), /invalid contract shape/u);
  await assert.rejects(reader.inspectVerified(good.fingerprint), /invalid contract shape/u);
  await assert.rejects(reader.install(good, guardedHooks), /invalid contract shape/u);
  await assert.rejects(reader.install(request(elf(), { command: ["fixture-agent", "--third"] }), guardedHooks), /invalid contract shape/u);
  assert.equal(gates, 0); assert.equal(downloads, 0);
  assert.deepEqual(await readdir(root), before);
  assert.equal(await readFile(join(root, bad.fingerprint, "receipt.json"), "utf8"), "{}");
});

test("sibling byte limits and ELF evidence apply beyond a low result limit", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t);
  const requests = [request(), request(elf(), { command: ["fixture-agent", "--other"] })]
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  for (const r of requests) await installer.install(r, hooks());
  const dir = join(root, requests[1].fingerprint), manifest = join(dir, "receipt.json");
  const original = await readFile(manifest);
  await writeFile(manifest, Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(installer.installed(1), /receipt byte limit/u);
  await writeFile(manifest, original);
  await writeFile(join(dir, "artifact"), Buffer.alloc(128));
  await assert.rejects(installer.installed(1), /ELF64/u);
  const file = await fsPromises.open(join(dir, "artifact"), "r+");
  try { await file.truncate(128 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(installer.installed(1), /artifact size/u);
});

test("stop waits for a cancelled downloader to actually settle before removing staging", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), entered = deferred(), cancelled = deferred(), settle = deferred();
  const installer = new AcpInstaller(root, { download: async (_plan, file, signal) => {
    await file.writeFile(elf());
    signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
    entered.resolve();
    await settle.promise; signal.throwIfAborted();
    throw new Error("unexpected continuation");
  } });
  const pending = installer.install(request(), hooks()), rejected = assert.rejects(pending, /stopped/u);
  await entered.promise;
  let stopped = false;
  const stopping = installer.stop().then(() => { stopped = true; });
  await cancelled.promise;
  assert.equal(stopped, false);
  assert.deepEqual(await readFile(join(await stagePath(root), "artifact")), elf());
  settle.resolve(); await stopping; await rejected;
  assert.equal(stopped, true); assert.deepEqual(await readdir(root), []);
});

test("cancellation during lock release cannot return installation success", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), abort = new AbortController();
  await interceptRename(t, async source => {
    if (source.endsWith("/.lock")) abort.abort(new Error("fixture release cancellation"));
  });
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.install(request(), hooks(abort.signal)), /fixture release cancellation/u);
  assert.deepEqual(await readdir(root), [request().fingerprint]);
  assert.deepEqual((await installer.inspectVerified(request().fingerprint)).receipt.plan, request().plan);
});

test("abort and stop during the final reuse FD close cannot return a successful receipt", { skip: !supportedHost }, async t => {
  const originalOpen = fsPromises.open;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const action of ["abort", "stop"]) {
    const { root } = await fixture(t), installer = new AcpInstaller(root, { download: fakeDownload() });
    await installer.install(request(), hooks());
    const identity = await stat(root), abort = new AbortController();
    let closes = 0, stopping: Promise<void> | undefined;
    t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
      const file = await originalOpen(...args), opened = await file.stat();
      if (opened.dev === identity.dev && opened.ino === identity.ino) {
        const originalClose = file.close.bind(file);
        t.mock.method(file, "close", async () => {
          await originalClose();
          if (++closes === 2) {
            if (action === "abort") abort.abort();
            else stopping = installer.stop();
          }
        });
      }
      return file;
    });
    syncBuiltinESMExports();
    await assert.rejects(installer.install(request(), hooks(abort.signal)), action === "abort" ? /aborted/u : /stopped/u);
    assert.equal(closes, 2, action);
    await stopping;
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test("new directory FD is closed when parent sync fails before ownership transfer", { skip: !supportedHost }, async t => {
  const { root } = await fixture(t), originalOpen = fsPromises.open;
  let next: FileHandle | undefined, injected = false;
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (next && next.fd !== -1) await next.close();
  });
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args), originalSync = file.sync.bind(file);
    if (String(args[0]).endsWith("/store")) next = file;
    t.mock.method(file, "sync", async () => {
      if (next && file !== next && !injected) {
        injected = true;
        throw new Error("fixture parent sync failure");
      }
      await originalSync();
    });
    return file;
  });
  syncBuiltinESMExports();
  const installer = new AcpInstaller(root, { download: fakeDownload() });
  await assert.rejects(installer.install(request(), hooks()), /fixture parent sync failure/u);
  assert.equal(injected, true); assert.ok(next);
  assert.equal(next.fd, -1, "failed ownership transfer must close the newly opened descriptor");
  await assert.rejects(next.stat(), /closed/u);
});

test("stage or lock close failure still attempts every other owned FD close", { skip: !supportedHost }, async t => {
  const originalOpen = fsPromises.open;
  for (const failed of ["stage", "lock"]) {
    const { root } = await fixture(t), held = new Map<string, FileHandle>();
    const close = new Map<string, () => Promise<void>>(), attempts: string[] = [];
    t.mock.method(fsPromises, "open", async (...args: Parameters<typeof originalOpen>) => {
      const file = await originalOpen(...args), name = String(args[0]).split("/").at(-1)!;
      const label = name === "store" ? "root" : name === ".lock" ? "lock" : name.startsWith(".stage-") ? "stage" : undefined;
      if (label && !held.has(label)) {
        held.set(label, file); close.set(label, file.close.bind(file));
        t.mock.method(file, "close", async () => {
          attempts.push(label);
          if (label === failed) throw new Error(`fixture ${failed} close failure`);
          await close.get(label)!();
        });
      }
      return file;
    });
    syncBuiltinESMExports();
    try {
      const installer = new AcpInstaller(root, { download: fakeDownload() });
      await assert.rejects(installer.install(request(), hooks()), new RegExp(`fixture ${failed} close failure`, "u"));
      await installer.stop();
      assert.deepEqual(attempts, ["stage", "lock", "root"]);
      for (const [label, file] of held) if (label !== failed) assert.equal(file.fd, -1, label);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      for (const [label, file] of held) if (file.fd !== -1) await close.get(label)!();
    }
  }
});
