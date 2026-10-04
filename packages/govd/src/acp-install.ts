// Verified artifact storage only. Nothing in this module executes an agent or grants
// permission to probe, authenticate, or become a Runner.
// The 0700 store must be inaccessible to untrusted actors, including the AI.
// Checksums are evidence, not authentication against its same-user owner. Node
// has no rename/unlink-by-inode: capture-then-check retains detected replacements,
// but even private capture names can be raced by a malicious same-user process.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { Stats } from "node:fs";
import { downloadVerifiedBinary } from "./acp-download.ts";
import type { AcpArtifactDownloader, AcpInstallHooks, AcpInstallReceipt, AcpInstallRequest } from "./acp-install-contract.ts";
import { executableInstallSupport, installFingerprint } from "./acp-install-plan.ts";
import { ACP_REGISTRY_URL, decodeAcpRegistry, planAcpInstall, type AcpInstallPlan } from "./acp-registry.ts";

const MAX_RECEIPT = 16 * 1024;
const MAX_ARTIFACT = 128 * 1024 * 1024;
const MAX_INSTALLATIONS = 256;
const ID = /^[a-f0-9]{64}$/u;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const ARTIFACT = "artifact";
const RECEIPT = "receipt.json";
const LOCK = ".lock";

export type AcpInstallFaultPoint = "after-lock" | "after-download" | "after-artifact-sync" |
  "after-receipt-sync" | "before-publish" | "after-publish";
export interface AcpInstallerOptions {
  download?: AcpArtifactDownloader;
  /** Test seam; production callers leave this unset. No filesystem path is supplied. */
  fault?: (point: AcpInstallFaultPoint) => void | Promise<void>;
}

function fail(reason: string): never { throw new Error(`ACP install: ${reason}`); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function fdPath(handle: FileHandle, name?: string): string {
  return `/proc/self/fd/${handle.fd}${name === undefined ? "" : `/${name}`}`;
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateDir(s: Stats): void {
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700) fail("unsafe store directory");
}
function privateFile(s: Stats, mode: number): void {
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o7777) !== mode)
    fail("unsafe store file");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",") + "}";
  return JSON.stringify(value);
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail("invalid contract shape");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f\u007f]/u.test(value))
    fail("invalid contract string");
}
function timestamp(value: unknown): void {
  text(value, 24);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== (value.length === 20 ? value.slice(0, -1) + ".000Z" : value))
    fail("invalid contract timestamp");
}
function validateRequest(value: unknown): asserts value is AcpInstallRequest {
  const r = object(value, ["operation", "catalog", "plan", "fingerprint"]);
  text(r.operation, 128);
  if (!/^I-\d{1,16}$/u.test(r.operation)) fail("invalid operation ID");
  const c = object(r.catalog, ["source", "sha256", "fetchedAt"]);
  if (c.source !== ACP_REGISTRY_URL || typeof c.sha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(c.sha256)) fail("invalid catalog identity");
  timestamp(c.fetchedAt);
  const p = object(r.plan, ["agentId", "name", "version", "kind", "platform", "packageName", "packageSpec",
    "source", "checksum", "integrity", "archiveFormat", "command"]);
  if (p.kind !== "binary" || p.packageName !== null || p.packageSpec !== null || p.integrity !== "sha256" ||
      p.archiveFormat !== "raw") fail("unsupported executable recipe");
  const sum = object(p.checksum, ["algorithm", "value"]);
  if (sum.algorithm !== "sha256" || typeof sum.value !== "string" || !/^[a-f0-9]{64}$/iu.test(sum.value)) fail("invalid artifact checksum");
  if (!Array.isArray(p.command) || !p.command.length || p.command.length > 65) fail("invalid command");
  text(p.source, 2048);
  text(p.agentId, 96); text(p.name, 256); text(p.version, 64);
  for (const arg of p.command) {
    if (typeof arg !== "string" || arg.length > 1024 || /[\u0000-\u001f\u007f]/u.test(arg)) fail("invalid command argument");
  }
  // Reuse the registry decoder/planner rather than accepting a second, looser recipe schema.
  const registry = decodeAcpRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: p.agentId, name: p.name,
    version: p.version, description: "Verified artifact", license_url: "https://example.com/license",
    distribution: { binary: { [String(p.platform)]: { archive: p.source, sha256: sum.value,
      cmd: p.command[0], args: p.command.slice(1) } } } }] }));
  const result = planAcpInstall(registry.agents[0], p.platform as AcpInstallPlan["platform"], "binary");
  if (!result.supported || canonical(result.plan) !== canonical(p)) fail("noncanonical executable plan");
  const support = executableInstallSupport(r.plan as AcpInstallPlan);
  if (!support.supported) fail(support.reason);
  if (typeof r.fingerprint !== "string" || !ID.test(r.fingerprint) ||
      installFingerprint(r.catalog as AcpInstallRequest["catalog"], r.plan as AcpInstallPlan) !== r.fingerprint)
    fail("request fingerprint mismatch");
}
function snapshot(request: AcpInstallRequest): AcpInstallRequest {
  let json: string;
  try { json = JSON.stringify(request); } catch { fail("invalid request"); }
  if (!json! || Buffer.byteLength(json!) > MAX_RECEIPT) fail("request exceeds receipt limit");
  const copied: unknown = JSON.parse(json!);
  validateRequest(copied);
  const bound = { schema: 1, installationId: copied.fingerprint, operation: copied.operation,
    gate: "G-" + "9".repeat(16), installedAt: "2026-01-01T00:00:00.000Z", catalog: copied.catalog,
    plan: copied.plan, bytes: MAX_ARTIFACT, sha256: "0".repeat(64), versionEvidence: "registry-advertised" };
  if (Buffer.byteLength(canonical({ receipt: bound, sha256: "0".repeat(64) })) > MAX_RECEIPT)
    fail("request exceeds receipt limit");
  return freeze(copied);
}

/** All components are opened without following symlinks; mutations use the held root FD. */
async function rootHandle(root: string, create: boolean): Promise<FileHandle> {
  const parts = root.split(sep).filter(Boolean);
  let handle = await open(sep, DIR_FLAGS);
  try {
    for (let i = 0; i < parts.length; i++) {
      const path = fdPath(handle, parts[i]);
      let next: FileHandle | undefined;
      try {
        try { next = await open(path, DIR_FLAGS); }
        catch (error) {
          if (!create || !missing(error)) throw error;
          try { await mkdir(path, { mode: 0o700 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          next = await open(path, DIR_FLAGS);
          await handle.sync();
        }
        await handle.close();
        handle = next;
        next = undefined;
      } finally { await next?.close(); }
    }
    privateDir(await handle.stat());
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function names(handle: FileHandle, limit: number): Promise<string[]> {
  const out: string[] = [];
  const dir = await opendir(fdPath(handle));
  try {
    for (;;) {
      const entry = await dir.read();
      if (!entry) return out.sort();
      if (out.length >= limit) fail("store entry limit exceeded");
      out.push(entry.name);
    }
  } finally { await dir.close(); }
}
async function inventory(handle: FileHandle, ownedLock = false, ownedStage?: string,
  signal?: AbortSignal): Promise<Map<string, AcpInstallReceipt>> {
  const entries = await names(handle, MAX_INSTALLATIONS + Number(ownedLock) + Number(ownedStage !== undefined));
  const installations = new Map<string, AcpInstallReceipt>();
  for (const name of entries) {
    signal?.throwIfAborted();
    if (name === LOCK && ownedLock) continue;
    if (name === ownedStage) continue;
    if (!ID.test(name)) fail(name === LOCK ? "store is locked; manual recovery required for abandoned locks" :
      "ambiguous or unexpected store entry; manual recovery required");
    if (installations.size >= MAX_INSTALLATIONS) fail("installation limit exceeded");
    // Validate every sibling, including those beyond an installed() result limit.
    // Sequential reads bound memory and each scan to 256 * (128 MiB + 16 KiB).
    installations.set(name, await verified(handle, name, signal));
  }
  return installations;
}
async function safeFile(dir: FileHandle, name: string, mode: number): Promise<FileHandle> {
  const file = await open(fdPath(dir, name), FILE_FLAGS);
  try { privateFile(await file.stat(), mode); return file; }
  catch (error) { await file.close(); throw error; }
}
async function binaryEvidence(file: FileHandle, plan: AcpInstallPlan, signal?: AbortSignal): Promise<{ bytes: number; sha256: string }> {
  const size = (await file.stat()).size;
  if (!Number.isSafeInteger(size) || size < 64 || size > MAX_ARTIFACT) fail("invalid artifact size");
  const header = Buffer.alloc(64);
  const read = await file.read(header, 0, header.length, 0);
  const machine = plan.platform === "linux-x86_64" ? 62 : 183;
  if (read.bytesRead !== 64 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 || header[5] !== 1 || header[6] !== 1 || ![0, 3].includes(header[7]) ||
      ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== machine ||
      header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64) fail("artifact must be a raw native ELF64 executable");
  const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - position), position);
    if (!bytesRead) fail("artifact changed while reading");
    hash.update(chunk.subarray(0, bytesRead)); position += bytesRead;
  }
  if ((await file.stat()).size !== size) fail("artifact changed while reading");
  const sha256 = hash.digest("hex");
  if (sha256 !== plan.checksum?.value.toLowerCase()) fail("artifact checksum mismatch");
  return { bytes: size, sha256 };
}
async function verified(root: FileHandle, id: string, signal?: AbortSignal): Promise<AcpInstallReceipt> {
  if (!ID.test(id)) fail("invalid installation ID");
  const dir = await open(fdPath(root, id), DIR_FLAGS);
  try {
    const receipt = await verifiedDirectory(dir, id, signal);
    await assertDirectoryIdentity(root, id, dir);
    return receipt;
  }
  finally { await dir.close(); }
}
async function assertDirectoryIdentity(parent: FileHandle, name: string, held: FileHandle): Promise<void> {
  const current = await open(fdPath(parent, name), DIR_FLAGS);
  try {
    privateDir(await current.stat());
    if (!same(await current.stat(), await held.stat())) fail("directory ownership changed; manual recovery required");
  } finally { await current.close(); }
}
async function verifiedDirectory(dir: FileHandle, id: string, signal?: AbortSignal,
  ownedFiles?: Map<string, Stats>): Promise<AcpInstallReceipt> {
    privateDir(await dir.stat());
    if (canonical(await names(dir, 2)) !== canonical([ARTIFACT, RECEIPT])) fail("unexpected artifact directory contents");
    const manifest = await safeFile(dir, RECEIPT, 0o600);
    let body: Buffer;
    try {
      if (ownedFiles && !same(await manifest.stat(), ownedFiles.get(RECEIPT)!)) fail("receipt ownership changed");
      const size = (await manifest.stat()).size;
      if (size < 1 || size > MAX_RECEIPT) fail("receipt byte limit exceeded");
      body = Buffer.alloc(size + 1);
      const { bytesRead } = await manifest.read(body, 0, body.length, 0);
      if (bytesRead !== size) fail("receipt changed while reading");
      body = body.subarray(0, size);
    } finally { await manifest.close(); }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { fail("invalid receipt encoding"); }
    const envelope = object(parsed, ["receipt", "sha256"]);
    if (canonical(envelope) !== body.toString("utf8") || envelope.sha256 !== digest(canonical(envelope.receipt)))
      fail("receipt bytes were changed");
    const r = object(envelope.receipt, ["schema", "installationId", "operation", "gate", "installedAt", "catalog", "plan",
      "bytes", "sha256", "versionEvidence"]);
    if (r.schema !== 1 || r.installationId !== id || r.versionEvidence !== "registry-advertised" ||
        typeof r.gate !== "string" || !/^G-\d{1,16}$/u.test(r.gate) ||
        !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 64 || (r.bytes as number) > MAX_ARTIFACT)
      fail("invalid receipt contract");
    timestamp(r.installedAt);
    validateRequest({ operation: r.operation, catalog: r.catalog, plan: r.plan, fingerprint: id });
    const file = await safeFile(dir, ARTIFACT, 0o700);
    try {
      if (ownedFiles && !same(await file.stat(), ownedFiles.get(ARTIFACT)!)) fail("artifact ownership changed");
      const actual = await binaryEvidence(file, r.plan as AcpInstallPlan, signal);
      if (actual.bytes !== r.bytes || actual.sha256 !== r.sha256) fail("receipt evidence mismatch");
    } finally { await file.close(); }
    return freeze(r as unknown as AcpInstallReceipt);
}

export class AcpInstaller {
  private readonly root: string;
  private readonly download: AcpArtifactDownloader;
  private readonly fault?: AcpInstallerOptions["fault"];
  private readonly active = new Map<Promise<AcpInstallReceipt>, AbortController>();
  private stopped = false;

  constructor(root: string, opts: AcpInstallerOptions = {}) {
    if (!isAbsolute(root) || resolve(root) !== root || root === sep) fail("store root must be a canonical absolute directory");
    this.root = root;
    this.download = opts.download ?? ((plan, file, signal) => downloadVerifiedBinary(plan.source, plan.checksum!.value, file, signal));
    this.fault = opts.fault;
  }

  install(request: AcpInstallRequest, hooks: AcpInstallHooks): Promise<AcpInstallReceipt> {
    const abort = new AbortController();
    const signal = AbortSignal.any([hooks.signal, abort.signal]);
    const task = this.perform(request, hooks, signal);
    this.active.set(task, abort);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }

  private check(signal: AbortSignal): void {
    if (this.stopped) fail("installer is stopped");
    signal.throwIfAborted();
  }
  private async reachable(root: FileHandle): Promise<void> {
    const current = await rootHandle(this.root, false);
    try { if (!same(await current.stat(), await root.stat())) fail("store root identity changed"); }
    finally { await current.close(); }
  }

  private async perform(input: AcpInstallRequest, hooks: AcpInstallHooks, signal: AbortSignal): Promise<AcpInstallReceipt> {
    this.check(signal);
    const request = snapshot(input);
    // Reuse performs only reads, and never silently trusts a broken existing store.
    let existing: FileHandle | undefined;
    try { existing = await rootHandle(this.root, false); }
    catch (error) { if (!missing(error)) throw error; }
    if (existing) {
      let reused: AcpInstallReceipt | undefined;
      try {
        const ids = await inventory(existing, false, undefined, signal);
        if (ids.has(request.fingerprint)) {
          const receipt = (await inventory(existing, false, undefined, signal)).get(request.fingerprint);
          if (!receipt) fail("store contents changed during reuse");
          await this.reachable(existing); this.check(signal);
          reused = receipt;
        }
      } finally { await existing.close(); }
      if (reused) { this.check(signal); return reused; }
    }
    this.check(signal);
    // Gate implementations own their persistence/cancellation. A pending Gate cannot
    // keep installer shutdown waiting after the installer signal has been cancelled.
    const approval = await this.awaitGate(hooks.gate(request), signal);
    this.check(signal);
    if (!approval || approval.allowed !== true || typeof approval.id !== "string" || !/^G-\d{1,16}$/u.test(approval.id) ||
        Object.keys(approval).some(k => k !== "id" && k !== "allowed")) fail("installation approval denied or invalid");
    const gateId = approval.id;
    const root = await rootHandle(this.root, true);
    let lock: FileHandle | undefined, stage: FileHandle | undefined, stageName: string | undefined;
    const ownedFiles = new Map<string, Stats>();
    let published = false, uncertain = false, returning = false;
    try {
      this.check(signal);
      try { await mkdir(fdPath(root, LOCK), { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("store is locked; manual recovery required for abandoned locks");
        throw error;
      }
      lock = await open(fdPath(root, LOCK), DIR_FLAGS); privateDir(await lock.stat());
      await root.sync();
      await this.fault?.("after-lock"); this.check(signal);
      const ids = await inventory(root, true, undefined, signal);
      if (ids.has(request.fingerprint)) {
        const receipt = ids.get(request.fingerprint)!;
        await this.reachable(root); this.check(signal);
        returning = true;
        return receipt;
      }
      if (ids.size >= MAX_INSTALLATIONS) fail("installation limit exceeded");
      stageName = `.stage-${randomUUID()}`;
      await mkdir(fdPath(root, stageName), { mode: 0o700 });
      stage = await open(fdPath(root, stageName), DIR_FLAGS); privateDir(await stage.stat());
      const binary = await open(fdPath(stage, ARTIFACT), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR |
        constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      let evidence: { bytes: number; sha256: string };
      try {
        privateFile(await binary.stat(), 0o600);
        ownedFiles.set(ARTIFACT, await binary.stat());
        this.check(signal);
        await this.download(request.plan, binary, signal);
        await this.fault?.("after-download"); this.check(signal);
        privateFile(await binary.stat(), 0o600);
        evidence = await binaryEvidence(binary, request.plan, signal);
        await binary.chmod(0o700); privateFile(await binary.stat(), 0o700);
        await binary.sync();
        await this.fault?.("after-artifact-sync"); this.check(signal);
      } finally { await binary.close(); }
      const receipt: AcpInstallReceipt = freeze({ schema: 1, installationId: request.fingerprint,
        operation: request.operation, gate: gateId, installedAt: new Date().toISOString(),
        catalog: request.catalog, plan: request.plan, ...evidence!, versionEvidence: "registry-advertised" });
      const body = canonical({ receipt, sha256: digest(canonical(receipt)) });
      if (Buffer.byteLength(body) > MAX_RECEIPT) fail("receipt byte limit exceeded");
      const manifest = await open(fdPath(stage, RECEIPT), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
        constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        privateFile(await manifest.stat(), 0o600); ownedFiles.set(RECEIPT, await manifest.stat());
        await manifest.writeFile(body); await manifest.sync();
      }
      finally { await manifest.close(); }
      await this.fault?.("after-receipt-sync"); this.check(signal);
      await stage.sync(); await root.sync();
      await this.fault?.("before-publish");
      await verifiedDirectory(stage, request.fingerprint, signal, ownedFiles);
      await this.assertOwnedLock(root, lock);
      const currentIds = await inventory(root, true, stageName, signal);
      if (currentIds.has(request.fingerprint) || canonical([...currentIds]) !== canonical([...ids]))
        fail("store contents changed before publication");
      await this.reachable(root);
      privateDir(await stage.stat());
      const staged = await open(fdPath(root, stageName), DIR_FLAGS);
      try { if (!same(await stage.stat(), await staged.stat())) fail("staging identity changed"); }
      finally { await staged.close(); }
      // Atomic visibility does not make rename conditional on the checked inode.
      // Verify the actual published directory/evidence before reporting success.
      this.check(signal);
      await rename(fdPath(root, stageName), fdPath(root, request.fingerprint));
      published = true;
      uncertain = true;
      await root.sync();
      await this.verifyPublished(root, stage, request.fingerprint, receipt, ownedFiles, signal);
      uncertain = false;
      await this.fault?.("after-publish");
      uncertain = true;
      await this.verifyPublished(root, stage, request.fingerprint, receipt, ownedFiles, signal);
      await this.assertOwnedLock(root, lock);
      await this.reachable(root); this.check(signal);
      uncertain = false;
      returning = true;
      return receipt;
    } finally {
      try {
        if (stage && stageName && !published) {
          try { await this.cleanStage(root, stage, stageName, ownedFiles); }
          catch (error) { uncertain = true; throw error; }
        }
      } finally {
        try {
          await stage?.close();
        } finally {
          try {
            if (lock && !uncertain) await this.releaseLock(root, lock);
          } finally {
            try { await lock?.close(); }
            finally { await root.close(); }
          }
        }
        // Shutdown also covers asynchronous lock release and FD closure.
        if (returning) this.check(signal);
      }
    }
  }

  private async assertOwnedLock(root: FileHandle, lock: FileHandle): Promise<void> {
    const current = await open(fdPath(root, LOCK), DIR_FLAGS);
    try {
      privateDir(await current.stat());
      if (!same(await current.stat(), await lock.stat()) || (await names(current, 1)).length)
        fail("lock ownership changed; manual recovery required");
    } finally { await current.close(); }
  }

  private async verifyPublished(root: FileHandle, stage: FileHandle, id: string, receipt: AcpInstallReceipt,
    ownedFiles: Map<string, Stats>, signal: AbortSignal): Promise<void> {
    await assertDirectoryIdentity(root, id, stage);
    const dir = await open(fdPath(root, id), DIR_FLAGS);
    try {
      if (!same(await dir.stat(), await stage.stat())) fail("published ownership changed; manual recovery required");
      const actual = await verifiedDirectory(dir, id, signal, ownedFiles);
      if (canonical(actual) !== canonical(receipt)) fail("published evidence changed; manual recovery required");
      await assertDirectoryIdentity(root, id, stage);
    } finally { await dir.close(); }
  }

  private async releaseLock(root: FileHandle, lock: FileHandle): Promise<void> {
    await this.assertOwnedLock(root, lock);
    // Retire the name before checking the captured inode. A new cooperative
    // owner's .lock is never the target of rmdir. A mismatched capture is retained.
    const retired = `.unlock-${randomUUID()}`;
    await rename(fdPath(root, LOCK), fdPath(root, retired));
    await root.sync();
    await assertDirectoryIdentity(root, retired, lock);
    if ((await names(lock, 1)).length) fail("lock contents changed; manual recovery required");
    // This private random name is safe against cooperative owners, not malicious
    // same-user mutation between this check and rmdir (Node has no conditional rmdir).
    await rmdir(fdPath(root, retired)); await root.sync();
  }

  private async awaitGate<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason ?? new Error("ACP install: cancelled"));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      })]);
    } finally { if (cancel) signal.removeEventListener("abort", cancel); }
  }

  private async cleanStage(root: FileHandle, stage: FileHandle, name: string, ownedFiles: Map<string, Stats>): Promise<void> {
    const current = await open(fdPath(root, name), DIR_FLAGS);
    try {
      privateDir(await current.stat());
      if (!same(await current.stat(), await stage.stat())) fail("staging ownership changed; manual recovery required");
      const entries = await names(stage, 2);
      for (const entry of entries) {
        if (entry !== ARTIFACT && entry !== RECEIPT) fail("ambiguous staging files; manual recovery required");
        const file = await open(fdPath(stage, entry), FILE_FLAGS);
        try {
          const s = await file.stat();
          privateFile(s, entry === RECEIPT ? 0o600 : (s.mode & 0o7777) === 0o700 ? 0o700 : 0o600);
          const owned = ownedFiles.get(entry);
          if (!owned || !same(s, owned)) fail("staging file ownership changed; manual recovery required");
        } finally { await file.close(); }
      }
      // Capture first, then verify. Path replacement during capture is retained,
      // never deleted using the pre-capture ownership check. Any detected loss
      // keeps the lock and all remaining evidence for manual recovery.
      const capturedName = `.cleanup-${randomUUID()}`;
      await rename(fdPath(root, name), fdPath(root, capturedName));
      await root.sync();
      await assertDirectoryIdentity(root, capturedName, stage);
      if ((await names(root, MAX_INSTALLATIONS + 2)).includes(name)) fail("staging ownership changed; manual recovery required");
      const captureName = ".captured";
      await mkdir(fdPath(stage, captureName), { mode: 0o700 });
      const capture = await open(fdPath(stage, captureName), DIR_FLAGS);
      try {
        privateDir(await capture.stat());
        for (const entry of entries) await rename(fdPath(stage, entry), fdPath(capture, entry));
        await capture.sync(); await stage.sync();
        // Validate every captured entry before deleting any of them.
        for (const entry of entries) {
          const file = await open(fdPath(capture, entry), FILE_FLAGS);
          try {
            const s = await file.stat(), owned = ownedFiles.get(entry);
            privateFile(s, entry === RECEIPT ? 0o600 : (s.mode & 0o7777) === 0o700 ? 0o700 : 0o600);
            if (!owned || !same(s, owned)) fail("staging file ownership changed; manual recovery required");
          } finally { await file.close(); }
        }
        if (canonical(await names(capture, 2)) !== canonical(entries))
          fail("ambiguous captured files; manual recovery required");
        if (canonical(await names(stage, 3)) !== canonical([captureName]))
          fail("ambiguous staging files; manual recovery required");
        await assertDirectoryIdentity(root, capturedName, stage);
        await assertDirectoryIdentity(stage, captureName, capture);
        // No pathname deletion can exclude a malicious same-user replacement
        // here. The capture directory is private; that actor is outside the trust
        // boundary. Do not describe these operations as unlink-by-inode.
        for (const entry of entries) await unlink(fdPath(capture, entry));
        await capture.sync(); await rmdir(fdPath(stage, captureName));
      } finally { await capture.close(); }
      await stage.sync(); await rmdir(fdPath(root, capturedName)); await root.sync();
    } finally { await current.close(); }
  }

  async inspectVerified(id: string): Promise<{ receipt: AcpInstallReceipt; path: string }> {
    if (!ID.test(id)) fail("invalid installation ID");
    const root = await rootHandle(this.root, false);
    try {
      if (!(await inventory(root)).has(id)) fail("installation not found");
      const receipt = (await inventory(root)).get(id);
      if (!receipt) fail("installation not found");
      await this.reachable(root);
      return { receipt, path: `${this.root}/${id}/${ARTIFACT}` };
    } finally { await root.close(); }
  }

  /** Bounded receipts only (1..100); every listed artifact is independently reverified. */
  async installed(limit = 50): Promise<readonly AcpInstallReceipt[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("list limit must be 1..100");
    let root: FileHandle;
    try { root = await rootHandle(this.root, false); }
    catch (error) { if (missing(error)) return Object.freeze([]); throw error; }
    try {
      await inventory(root);
      const records = [...(await inventory(root)).values()].slice(0, limit);
      await this.reachable(root);
      return Object.freeze(records);
    } finally { await root.close(); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const active = [...this.active];
    for (const [, abort] of active) abort.abort(new Error("ACP install: installer is stopped"));
    await Promise.allSettled(active.map(([task]) => task));
  }
}
