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
import type { BigIntStats, Dir, Stats } from "node:fs";
import { inspectAcpArtifactRuntime, type AcpArtifactRuntimeInspection, type AcpElfPlatform } from "./acp-artifact-runtime.ts";
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
  if (read.bytesRead !== 64) fail("artifact must be a raw native ELF64 executable");
  rawRuntimeHeader(header, plan.platform);
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
    const r = decodeReceipt(body, id);
    const file = await safeFile(dir, ARTIFACT, 0o700);
    try {
      if (ownedFiles && !same(await file.stat(), ownedFiles.get(ARTIFACT)!)) fail("artifact ownership changed");
      const actual = await binaryEvidence(file, r.plan as AcpInstallPlan, signal);
      if (actual.bytes !== r.bytes || actual.sha256 !== r.sha256) fail("receipt evidence mismatch");
    } finally { await file.close(); }
    return r;
}

// Only actual bounded store reads supply this decoder. It accepts no public evidence.
function decodeReceipt(body: Buffer, id: string): AcpInstallReceipt {
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
  return freeze(r as unknown as AcpInstallReceipt);
}

export type AcpStoredRuntimeObservation = Readonly<{
  receipt: AcpInstallReceipt;
  inspection: AcpArtifactRuntimeInspection;
}>;

/** Trusted package-internal fixture ownership; never returned by a public probe. */
export type AcpStoredFixtureBinding = Readonly<{
  signal: AbortSignal;
  capture(): Promise<Readonly<{ bytes: Buffer; path: string; observation: AcpStoredRuntimeObservation }>>;
  release(): Promise<void>;
}>;
type StoredFixtureCapture = Awaited<ReturnType<AcpStoredFixtureBinding["capture"]>>;
type StoredFixtureBindResult = Readonly<
  | { status: "bound"; binding: AcpStoredFixtureBinding }
  | { status: "refused"; reason: "installer" | "id" | "stopped" | "path" }
>;
// Initialized in the installer's lexical private-field scope. No public dispatch.
let bindStoredFixture: (installer: unknown, id: unknown) => StoredFixtureBindResult;
export function bindAcpStoredFixtureInstaller(installer: unknown, id: unknown): StoredFixtureBindResult {
  return bindStoredFixture(installer, id);
}
type StoredFixtureBindingState = {
  installer?: AcpInstaller; root?: string; id?: string; abort?: AbortController;
  attempted: boolean; released: boolean; task?: Promise<void>; releasing?: Promise<void>;
};
const fixtureBindings = new WeakMap<object, StoredFixtureBindingState>();
// Only identity remains after release; no installer, root or fulfilled buffer.
const releasedFixtureBindings = new WeakSet<object>();
const MAX_FIXTURE_CAPTURE = 4 * 1024 * 1024;

// One process-wide slot; held through settled I/O and every consuming close attempt.
let runtimeReaderActive = false;
const RUNTIME_CHUNK = 64 * 1024;
const FINGERPRINT_FIELDS = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"] as const;
function runtimeSame(a: BigIntStats, b: BigIntStats): boolean {
  return FINGERPRINT_FIELDS.every(key => a[key] === b[key]);
}
function runtimePrivate(s: BigIntStats, directory: boolean, mode: bigint): void {
  if (!(directory ? s.isDirectory() : s.isFile()) || s.uid !== BigInt(process.getuid!()) ||
      (s.mode & 0o7777n) !== mode || (!directory && s.nlink !== 1n)) fail("unsafe runtime store object");
}
function rawRuntimeHeader(header: Buffer, platform: AcpInstallPlan["platform"]): void {
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      header[4] !== 2 || header[5] !== 1 || header[6] !== 1 || ![0, 3].includes(header[7]) ||
      ![2, 3].includes(header.readUInt16LE(16)) ||
      header.readUInt16LE(18) !== (platform === "linux-x86_64" ? 62 : 183) ||
      header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64)
    fail("artifact must be a raw native ELF64 executable");
}

// Shared by passive observation and internal fixture capture. Own objects, never raw
// FD close responsibilities. Trusted runtime/kernel/storage administration required:
// finite observations cannot exclude hostile same-user changes or inode reuse.
class StoredRuntimeReader<Completion extends "passive" | "fixture"> {
  private readonly owned = new Set<FileHandle | Dir>();
  private readonly root: string;
  private readonly id: string;
  private readonly signal: AbortSignal;
  private readonly deadline: number;
  private readonly completion: Completion;
  constructor(root: string, id: string, signal: AbortSignal, deadline: number, completion: Completion) {
    this.root = root; this.id = id; this.signal = signal; this.deadline = deadline;
    this.completion = completion;
  }

  private check(): void {
    this.signal.throwIfAborted();
    if (performance.now() >= this.deadline) fail("runtime inspection deadline exceeded");
  }
  private async io<T>(operation: () => Promise<T>): Promise<T> {
    this.check(); const result = await operation(); this.check(); return result;
  }
  private async acquire<T extends FileHandle | Dir>(operation: () => Promise<T>): Promise<T> {
    this.check();
    if (this.owned.size >= 8) fail("runtime reader handle limit exceeded");
    const handle = await operation();
    this.owned.add(handle); // Ownership precedes the post-await cancellation/deadline check.
    this.check(); return handle;
  }
  private async close(handle: FileHandle | Dir): Promise<void> {
    if (!this.owned.delete(handle)) fail("runtime close responsibility already consumed");
    const failures: unknown[] = [];
    try { this.check(); } catch (error) { failures.push(error); }
    try { await handle.close(); } catch (error) { failures.push(error); }
    try { this.check(); } catch (error) { failures.push(error); }
    if (failures.length) throw failures[0];
  }
  private async closeMany(handles: readonly (FileHandle | Dir)[]): Promise<void> {
    const failures: unknown[] = [];
    for (const handle of handles) {
      try { await this.close(handle); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "ACP install: runtime closure failed");
  }
  private async stat(handle: FileHandle): Promise<BigIntStats> {
    return this.io(() => handle.stat({ bigint: true }));
  }
  private async open(path: string, directory: boolean): Promise<FileHandle> {
    return this.acquire(() => open(path, directory ? DIR_FLAGS : FILE_FLAGS));
  }
  private async walk(): Promise<FileHandle> {
    let current = await this.open(sep, true);
    for (const part of this.root.split(sep).filter(Boolean)) {
      const next = await this.open(fdPath(current, part), true);
      await this.close(current); current = next;
    }
    runtimePrivate(await this.stat(current), true, 0o700n);
    return current;
  }
  private async names(handle: FileHandle, limit: number): Promise<string[]> {
    const dir = await this.acquire(() => opendir(fdPath(handle)));
    const entries: string[] = [];
    try {
      for (;;) {
        const entry = await this.io(() => dir.read());
        if (!entry) break;
        if (entries.length >= limit) fail("runtime store entry limit exceeded");
        entries.push(entry.name);
      }
      this.check(); entries.sort(); this.check(); return entries;
    } finally { await this.close(dir); }
  }
  private async unchanged(handle: FileHandle, before: BigIntStats): Promise<void> {
    if (!runtimeSame(before, await this.stat(handle))) fail("runtime store metadata changed");
  }
  private async binding(parent: FileHandle, name: string, before: BigIntStats, directory: boolean): Promise<void> {
    const current = await this.open(fdPath(parent, name), directory);
    try {
      if (!runtimeSame(before, await this.stat(current))) fail("runtime named binding changed");
    } finally { await this.close(current); }
  }
  private async read(file: FileHandle, target: Buffer, offset: number, length: number, position: number): Promise<number> {
    const result = await this.io(() => file.read(target, offset, length, position));
    if (!Number.isInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > length)
      fail("invalid runtime read count");
    return result.bytesRead;
  }
  private async eof(file: FileHandle, size: number): Promise<void> {
    if (await this.read(file, Buffer.alloc(1), 0, 1, size) !== 0) fail("runtime file grew while reading");
  }
  private async receipt(file: FileHandle, before: BigIntStats, id: string): Promise<{ receipt: AcpInstallReceipt; body: Buffer }> {
    if (before.size < 1n || before.size > BigInt(MAX_RECEIPT)) fail("receipt byte limit exceeded");
    const body = Buffer.allocUnsafeSlow(Number(before.size));
    let position = 0;
    while (position < body.length) {
      const count = await this.read(file, body, position, body.length - position, position);
      if (!count) fail("receipt changed while reading");
      position += count;
    }
    await this.eof(file, body.length); await this.unchanged(file, before);
    this.check(); const receipt = decodeReceipt(body, id); this.check();
    return { receipt, body };
  }
  private async artifact(file: FileHandle, before: BigIntStats, receipt: AcpInstallReceipt,
    capture: boolean): Promise<Buffer | undefined> {
    if (before.size < 64n || before.size > BigInt(MAX_ARTIFACT) || before.size !== BigInt(receipt.bytes))
      fail("invalid artifact size or receipt byte count");
    if (capture && this.completion === "fixture" && before.size > BigInt(MAX_FIXTURE_CAPTURE))
      fail("fixture capture byte limit exceeded");
    const size = Number(before.size), bytes = capture ? Buffer.allocUnsafeSlow(size) : undefined;
    const chunk = Buffer.alloc(RUNTIME_CHUNK), header = Buffer.alloc(64), hash = createHash("sha256");
    let position = 0;
    while (position < size) {
      const length = Math.min(RUNTIME_CHUNK, size - position);
      const count = await this.read(file, bytes ?? chunk, bytes ? position : 0, length, position);
      if (!count) fail("artifact changed while reading");
      const part = bytes ? bytes.subarray(position, position + count) : chunk.subarray(0, count);
      if (position < 64) part.copy(header, position, 0, Math.min(count, 64 - position));
      this.check(); hash.update(part); this.check(); position += count;
    }
    await this.eof(file, size); await this.unchanged(file, before);
    this.check(); rawRuntimeHeader(header, receipt.plan.platform);
    const sha256 = hash.digest("hex");
    if (sha256 !== receipt.sha256 || sha256 !== receipt.plan.checksum!.value.toLowerCase())
      fail("receipt artifact checksum mismatch");
    this.check(); return bytes;
  }
  private async reread(file: FileHandle, bytes: Buffer, before: BigIntStats): Promise<void> {
    const chunk = Buffer.alloc(RUNTIME_CHUNK);
    let position = 0;
    while (position < bytes.length) {
      const count = await this.read(file, chunk, 0, Math.min(chunk.length, bytes.length - position), position);
      if (!count || !chunk.subarray(0, count).equals(bytes.subarray(position, position + count)))
        fail("runtime reread mismatch");
      this.check(); position += count;
    }
    await this.eof(file, bytes.length); await this.unchanged(file, before);
  }
  private async selected(root: FileHandle, id: string): Promise<{
    dir: FileHandle; manifest: FileHandle; file: FileHandle;
    dirStat: BigIntStats; receiptStat: BigIntStats; artifactStat: BigIntStats;
    receipt: AcpInstallReceipt; body: Buffer;
  }> {
    const dir = await this.open(fdPath(root, id), true), dirStat = await this.stat(dir);
    runtimePrivate(dirStat, true, 0o700n);
    if (canonical(await this.names(dir, 2)) !== canonical([ARTIFACT, RECEIPT])) fail("unexpected artifact directory contents");
    const manifest = await this.open(fdPath(dir, RECEIPT), false), receiptStat = await this.stat(manifest);
    runtimePrivate(receiptStat, false, 0o600n);
    // Sibling ID is selected solely from the complete store inventory.
    const body = await this.receipt(manifest, receiptStat, id);
    const file = await this.open(fdPath(dir, ARTIFACT), false), artifactStat = await this.stat(file);
    runtimePrivate(artifactStat, false, 0o700n);
    return { dir, manifest, file, dirStat, receiptStat, artifactStat, ...body };
  }
  private async revalidate(root: FileHandle, id: string, selected: Awaited<ReturnType<StoredRuntimeReader<Completion>["selected"]>>) {
    const { dir, manifest, file, dirStat, receiptStat, artifactStat } = selected;
    if (canonical(await this.names(dir, 2)) !== canonical([ARTIFACT, RECEIPT])) fail("unexpected artifact directory contents");
    await this.unchanged(dir, dirStat); await this.unchanged(manifest, receiptStat); await this.unchanged(file, artifactStat);
    await this.binding(dir, RECEIPT, receiptStat, false); await this.binding(dir, ARTIFACT, artifactStat, false);
    await this.binding(root, id, dirStat, true);
  }
  private async inventory(root: FileHandle): Promise<Map<string, AcpInstallReceipt>> {
    const entries = await this.names(root, MAX_INSTALLATIONS), receipts: [string, AcpInstallReceipt][] = [];
    for (const id of entries) {
      this.check();
      if (!ID.test(id)) fail("ambiguous or locked runtime store");
      const selected = await this.selected(root, id);
      try {
        await this.artifact(selected.file, selected.artifactStat, selected.receipt, false);
        await this.revalidate(root, id, selected);
        receipts.push([id, selected.receipt]);
      } finally { await this.closeMany([selected.file, selected.manifest, selected.dir]); }
    }
    this.check(); const result = new Map(receipts); this.check(); return result;
  }
  async run(): Promise<Completion extends "passive" ? AcpStoredRuntimeObservation : StoredFixtureCapture> {
    let observation: AcpStoredRuntimeObservation | undefined, captured: Buffer | undefined;
    let failure: unknown, failed = false;
    try {
      this.check();
      const root = await this.walk(), rootStat = await this.stat(root);
      const first = await this.inventory(root);
      if (!first.has(this.id)) fail("installation not found");
      const selected = await this.selected(root, this.id);
      this.check();
      if (canonical(selected.receipt) !== canonical(first.get(this.id))) fail("runtime selected receipt changed");
      this.check();
      const bytes = (await this.artifact(selected.file, selected.artifactStat, selected.receipt, true))!;
      await this.reread(selected.file, bytes, selected.artifactStat);
      await this.reread(selected.manifest, selected.body, selected.receiptStat);
      const second = await this.inventory(root);
      this.check();
      if (canonical([...second]) !== canonical([...first])) fail("runtime store inventory changed");
      this.check();
      await this.unchanged(root, rootStat);
      const current = await this.walk();
      if (!runtimeSame(rootStat, await this.stat(current))) fail("store root identity changed");
      await this.close(current);
      await this.revalidate(root, this.id, selected);
      this.check();
      const inspection = inspectAcpArtifactRuntime(bytes, selected.receipt.plan.platform as AcpElfPlatform);
      this.check(); observation = Object.freeze({ receipt: selected.receipt, inspection }); this.check();
      if (this.completion === "fixture") captured = bytes;
    } catch (error) { failed = true; failure = error; }
    try { await this.closeMany([...this.owned].reverse()); }
    catch (error) { if (!failed) { failed = true; failure = error; } }
    try { this.check(); } catch (error) { if (!failed) { failed = true; failure = error; } }
    if (failed) throw failure;
    // Neither completion escapes before every consuming close and final check.
    return (this.completion === "passive" ? observation! :
      Object.freeze({ bytes: captured!, path: `${this.root}/${this.id}/${ARTIFACT}`, observation: observation! })) as
      Completion extends "passive" ? AcpStoredRuntimeObservation : StoredFixtureCapture;
  }
}

export class AcpInstaller {
  readonly #runtimeRoot: string;
  #runtimeStopped = false;
  readonly #runtimeActive = new Map<Promise<unknown>, AbortController>();
  readonly #fixtureBindings = new Set<AbortController>();
  private readonly root: string;
  private readonly download: AcpArtifactDownloader;
  private readonly fault?: AcpInstallerOptions["fault"];
  private readonly active = new Map<Promise<AcpInstallReceipt>, AbortController>();
  private stopped = false;

  static {
    async function capture(this: unknown): Promise<StoredFixtureCapture> {
      // Weak identity lookup does not invoke proxy traps or inspect properties.
      const state = fixtureBindings.get(this as object);
      if (!state) fail("invalid fixture binding receiver");
      if (state.released) fail("fixture binding is released");
      if (state.attempted) fail("fixture capture already attempted");
      state.attempted = true; // Consumed synchronously, even on admission refusal.
      const installer = state.installer!, abort = state.abort!;
      abort.signal.throwIfAborted();
      if (installer.#runtimeStopped) fail("installer is stopped");
      if (runtimeReaderActive) fail("runtime inspection already active");
      const reader = new StoredRuntimeReader(state.root!, state.id!, abort.signal, performance.now() + 2000, "fixture");
      runtimeReaderActive = true;
      const task = Promise.resolve().then(() => reader.run());
      installer.#runtimeActive.set(task, abort); // Before any filesystem work.
      // Settlement bookkeeping must not retain the fulfilled captured bytes.
      state.task = task.then(() => {}, () => {});
      void task.finally(() => {
        installer.#runtimeActive.delete(task);
        runtimeReaderActive = false;
      }).catch(() => {});
      return task;
    }
    function release(this: unknown): Promise<void> {
      const receiver = this as object, state = fixtureBindings.get(receiver);
      if (!state) {
        if (releasedFixtureBindings.has(receiver)) return Promise.resolve();
        return Promise.reject(new Error("ACP install: invalid fixture binding receiver"));
      }
      if (state.releasing) return state.releasing;
      state.released = true;
      const task = Promise.resolve().then(async () => {
        try { await state.task; }
        finally {
          state.installer!.#fixtureBindings.delete(state.abort!);
          fixtureBindings.delete(receiver); releasedFixtureBindings.add(receiver);
          state.installer = undefined; state.root = undefined; state.id = undefined;
          state.abort = undefined; state.task = undefined; state.releasing = undefined;
        }
      });
      state.releasing = task;
      // Publish the shared settlement before synchronous abort listeners run.
      state.abort!.abort(new Error("ACP install: fixture binding is released"));
      return task;
    }
    bindStoredFixture = (installer, id) => {
      const refuse = (reason: "installer" | "id" | "stopped" | "path") => Object.freeze({ status: "refused" as const, reason });
      if (installer === null || (typeof installer !== "object" && typeof installer !== "function") ||
          !(#runtimeRoot in installer)) return refuse("installer");
      const owner = installer as AcpInstaller, root = owner.#runtimeRoot;
      if (typeof id !== "string" || !ID.test(id)) return refuse("id");
      if (owner.#runtimeStopped) return refuse("stopped");
      const path = `${root}/${id}/${ARTIFACT}`;
      if (!path.isWellFormed() || !isAbsolute(path) || resolve(path) !== path ||
          /[\p{Cc}:]/u.test(path) || Buffer.byteLength(path, "utf8") > 3072 ||
          path.slice(1).split(sep).some(part => !part || part === "." || part === ".." || Buffer.byteLength(part, "utf8") > 255))
        return refuse("path");
      const abort = new AbortController();
      const binding: AcpStoredFixtureBinding = Object.freeze({ signal: abort.signal, capture, release });
      fixtureBindings.set(binding, { installer: owner, root, id, abort, attempted: false, released: false });
      owner.#fixtureBindings.add(abort); // Registered before returning, without I/O.
      return Object.freeze({ status: "bound" as const, binding });
    };
  }

  constructor(root: string, opts: AcpInstallerOptions = {}) {
    if (!isAbsolute(root) || resolve(root) !== root || root === sep) fail("store root must be a canonical absolute directory");
    this.root = root;
    this.#runtimeRoot = root;
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

  /** Passive receipt-bound evidence only; no path, bytes, token or execution authority. */
  async inspectVerifiedRuntime(id: string): Promise<AcpStoredRuntimeObservation> {
    // Private branding precedes receiver property access, including on revoked proxies.
    const root = this.#runtimeRoot;
    if (typeof id !== "string" || !ID.test(id)) fail("invalid installation ID");
    if (this.#runtimeStopped) fail("installer is stopped");
    if (runtimeReaderActive) fail("runtime inspection already active");
    if (Buffer.byteLength(root, "utf8") > 3072 ||
        root.split(sep).some(part => Buffer.byteLength(part, "utf8") > 255)) fail("runtime root path limit exceeded");
    const abort = new AbortController();
    const reader = new StoredRuntimeReader(root, id, abort.signal, performance.now() + 2000, "passive");
    runtimeReaderActive = true;
    // Register before the first filesystem operation, without racing/abandoning I/O.
    const task = Promise.resolve().then(() => reader.run());
    this.#runtimeActive.set(task, abort);
    void task.finally(() => {
      this.#runtimeActive.delete(task);
      runtimeReaderActive = false;
    }).catch(() => {});
    return task;
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
    // Stop the privately bound reader even if legacy TS-private properties were
    // replaced by the caller. Their failure must not abandon reader settlement.
    this.#runtimeStopped = true;
    for (const abort of this.#fixtureBindings) abort.abort(new Error("ACP install: installer is stopped"));
    const readers = [...this.#runtimeActive];
    for (const [, abort] of readers) abort.abort(new Error("ACP install: installer is stopped"));
    try {
      this.stopped = true;
      const active = [...this.active];
      for (const [, abort] of active) abort.abort(new Error("ACP install: installer is stopped"));
      await Promise.allSettled(active.map(([task]) => task));
    } finally { await Promise.allSettled(readers.map(([task]) => task)); }
  }
}
