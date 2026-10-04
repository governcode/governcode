// Fixture-local owner. Endpoint ownership, not knowledge of the invocation ID,
// supplies provenance. No production caller or injected stream can create evidence.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify, types } from "node:util";
import type { Duplex, Readable } from "node:stream";
import { startAcp, type AcpRpc } from "../../src/acp.ts";
import { inspectAcpArtifactRuntime, type AcpArtifactRuntimeInspection } from "../../src/acp-artifact-runtime.ts";
import { allocateAcpProbeContext, createAcpProbeAbortController, AcpProbeContextError, type AcpProbeContext } from "../../src/acp-probe-context.ts";

import { bindAcpStoredFixtureInstaller, type AcpInstaller, type AcpStoredFixtureBinding, type AcpStoredRuntimeObservation } from "../../src/acp-install.ts";

const brand: unique symbol = Symbol("fixture namespace termination");
export type FixtureNamespaceTermination = Readonly<{ [brand]: true }>;
type Outcome = Readonly<{ kind: "exited"; code: number } | { kind: "signalled"; signal: number } |
  { kind: "stopped" } | { kind: "setup-failed" }>;
export type FixtureTermination = Readonly<
  { status: "proven"; evidence: FixtureNamespaceTermination; outcome: Outcome } |
  { status: "refused"; reason: "invalid-input" | "unsupported" | "admission" } |
  { status: "unproven"; reason: "spawn" | "record" | "channel" | "producer" | "deadline" | "native-unproven" }>;
export type FixtureInvocation = Readonly<{ rpc: AcpRpc; termination: Promise<FixtureTermination>; stop(): void }>;
// Caller precondition: these are trusted test-created assets, including the driver
// program itself. Path validation authenticates no binary and binds no receipt.
export type FixtureAssets = Readonly<{ driver: string; target: string; policy: string; cwd: string;
  env: Readonly<{ HOME: string; TMPDIR: string; PATH: "/usr/bin"; LANG: "C"; LC_ALL: "C" }> }>;
const scenarios = ["normal", "high-exit", "signal", "direct", "double", "detach", "signal-tree", "kill-init",
  "forge", "acp", "acp-forbidden", "acp-hang", "stdout-flood", "stderr-flood",
  "death-pre-admission", "death-post-admission", "death-mid-record", "death-full-record", "death-closed-record",
  "proof-stale", "proof-extra", "proof-truncate", "proof-missing",
  "stale-record", "extra-record", "truncated-record", "missing-record", "guard-eof", "guard-registration-failure", "guard-registration-deadline",
  "clone-failure", "pidfd-failure", "map-failure", "restrict-failure", "exec-failure", "wait-failure", "withhold", "control-error", "hold"] as const;
export type FixtureScenario = typeof scenarios[number];
const boundScenarios = [...scenarios, "sandbox", "sealed-replace", "sealed-mutate", "before-copy-b", "copy-torn", "copy-truncate", "copy-grow", "copy-b",
  "image-mismatch", "prep-expired", "prep-entry-expired", "prep-validation-expired", "prep-gate-expired", "prep-release-expired", "prep-exec-expired", "prep-gate-expired-unproven", "prep-stop", "fault-open", "fault-read", "fault-write", "fault-seal", "fault-readback",
  "fault-compare", "fault-mode", "fault-close", "seal-aliases", "writable-map", "fault-dup", "fault-inventory", "fault-close-range", "fault-exec", "limits-failure"] as const;
export type BoundFixtureScenario = typeof boundScenarios[number];
const preparedBrand: unique symbol = Symbol("prepared fixed fixture");
export type PreparedNativeBoundFixture = Readonly<{ [preparedBrand]: true }>;
export type BoundFixturePreparation = Readonly<{
  status: "prepared"; fixture: PreparedNativeBoundFixture;
  observation: Readonly<{ sha256: string; bytes: number; inspection: AcpArtifactRuntimeInspection }>;
} | { status: "unavailable"; reason: "platform" | "assets" | "image-data" | "image-layout" | "materialization" }>;
type Prepared = { assets: FixtureAssets; imageA: Buffer; imageB: Buffer; sha256: string;
  inspection: AcpArtifactRuntimeInspection; deadline: number; used: boolean; context?: AcpProbeContext };
const preparations = new WeakMap<PreparedNativeBoundFixture, Prepared>();
const contextLeaves = ["cwd", "home", "config", "cache", "data", "state", "runtime", "tmp", "empty"] as const;
const contextMutations = ["root-replace", "leaf-replace", "ancestor-replace", "root-symlink", "leaf-symlink", "ancestor-symlink",
  "root-missing", "leaf-missing", "ancestor-missing", "root-mode", "leaf-mode", "ancestor-mode", "nonempty", "extra-root"] as const;
type ContextMutationScenario = `ctx-${"before-capture" | "before-acquire" | "after-acquire"}-${typeof contextMutations[number]}`;
const contextFaults = ["ctx-after-landlock-content", "ctx-after-landlock-symlink", "ctx-open", "ctx-stat", "ctx-fchdir", "ctx-rules",
  "ctx-limits", "ctx-close", "ctx-initial-inventory", "ctx-final-inventory", "ctx-scanner-close", "ctx-deadline-capture",
  "ctx-deadline-acquire", "ctx-deadline-enumeration", "ctx-deadline-rules", "ctx-deadline-revalidation", "ctx-deadline-closure", "ctx-deadline-exec"] as const;
export type ContextFixtureScenario = BoundFixtureScenario | ContextMutationScenario | typeof contextFaults[number];
const contextScenarios: readonly ContextFixtureScenario[] = [...boundScenarios, ...contextFaults,
  ...(["before-capture", "before-acquire", "after-acquire"] as const).flatMap(stage => contextMutations.map(mutation =>
    `ctx-${stage}-${mutation}` as ContextMutationScenario))];
const contextBrand: unique symbol = Symbol("prepared contextual fixture");
export type PreparedNativeContextBoundFixture = Readonly<{ [contextBrand]: true }>;
export type ContextFixtureDiagnostics = Readonly<{ root: string; directories: AcpProbeContext["directories"];
  identities: Readonly<Record<"root" | typeof contextLeaves[number], Readonly<{ dev: string; ino: string }>>> }>;
export type ContextFixturePreparation = Readonly<{
  status: "prepared"; fixture: PreparedNativeContextBoundFixture; diagnostics: ContextFixtureDiagnostics;
} | { status: "unavailable"; reason: "allocation" | "expired" | "cancelled" | "selection";
  diagnostics?: ContextFixtureDiagnostics; retainedRoot?: string; allocationReason?: string }>;
type ContextLaunch = Readonly<{ context: AcpProbeContext; identities: readonly string[]; env: Readonly<Record<string, string>> }>;
type ContextPrepared = { image: Prepared; assets: FixtureAssets; launch: ContextLaunch; deadline: number; used: boolean };
const contextPreparations = new WeakMap<PreparedNativeContextBoundFixture, ContextPrepared>();
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
function imageDataAdmitted(size: number, diagnostics: number, start: number, now: number): boolean {
  return size >= 64 && size <= 4 * 1024 * 1024 && diagnostics === 0 && now < start + 2000;
}

function consumePrepared(fixture: PreparedNativeBoundFixture, scenario: BoundFixtureScenario, now: number): Prepared {
  return consumeAssociation(preparations, fixture, scenario, now);
}
function consumeAssociation<T extends { used: boolean; deadline: number }>(
  map: WeakMap<object, T>, fixture: object, scenario: ContextFixtureScenario, now: number,
  allowed: readonly ContextFixtureScenario[] = boundScenarios,
): T {
  // Never inspect caller properties, including proxies, brands or supplied bytes.
  const p = map.get(fixture);
  if (!p || p.used || now >= p.deadline || !allowed.includes(scenario)) throw new Error("Invalid or consumed bound fixture");
  p.used = true;
  return p;
}

type FixedImageData = Readonly<{ imageA: Buffer; imageB: Buffer; sha256: string; inspection: AcpArtifactRuntimeInspection }>;
function checkImagePreparation(deadline?: number, signal?: AbortSignal): void {
  if (deadline !== undefined && performance.now() >= deadline) throw new Error("Expired image preparation");
  if (signal && signalAborted.call(signal)) throw new Error("Cancelled image preparation");
}
async function acquireFixedImages(a: StoredFixtureBootstrap, signal?: AbortSignal, deadline?: number): Promise<
  Readonly<{ status: "acquired"; data: FixedImageData } | { status: "unavailable"; reason: "image-data" | "image-layout" }>> {
  const emit = async (mode: "fixture-image-a" | "fixture-image-b") => {
    checkImagePreparation(deadline, signal);
    const start = performance.now();
    const task = promisify(execFile)(a.driver, [mode], { cwd: a.cwd, env: { ...a.env },
      ...(signal ? { signal } : {}), encoding: "buffer", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 });
    // Abort can reject execFile before its child closes. The stored operation
    // keeps its admission slot until this owned data-mode channel settles too.
    const closed = signal ? new Promise<void>(resolve => { task.child.once("close", () => resolve()); }) : undefined;
    let output: Awaited<typeof task>;
    try { output = await task; } finally { if (closed) await closed; }
    const { stdout, stderr } = output;
    checkImagePreparation(deadline, signal);
    if (!imageDataAdmitted(stdout.length, stderr.length, start, performance.now()))
      throw new Error("Unavailable fixed image data");
    return Buffer.from(stdout);
  };
  let imageA: Buffer, imageB: Buffer;
  try { imageA = await emit("fixture-image-a"); imageB = await emit("fixture-image-b"); }
  catch { return Object.freeze({ status: "unavailable", reason: "image-data" }); }
  const inspection = inspectAcpArtifactRuntime(imageA, "linux-x86_64");
  const other = inspectAcpArtifactRuntime(imageB, "linux-x86_64");
  if (inspection.status !== "observed" || inspection.elfType !== "ET_EXEC" || other.status !== "observed" ||
    other.elfType !== "ET_EXEC" || imageA.equals(imageB)) return Object.freeze({ status: "unavailable", reason: "image-layout" });
  const sha256 = createHash("sha256").update(imageA).digest("hex");
  checkImagePreparation(deadline, signal);
  return Object.freeze({ status: "acquired", data: { imageA, imageB, sha256, inspection } });
}

/** Fixed trusted-driver data modes only. No namespaces or caller byte baseline. */
export async function prepareNativeBoundFixture(assets: FixtureAssets): Promise<BoundFixturePreparation> {
  const a = snapshot(assets, "normal");
  if (new Set([a.driver, a.target, a.policy, a.cwd]).size !== 4) return Object.freeze({ status: "unavailable", reason: "assets" });
  if (process.platform !== "linux" || process.arch !== "x64") return Object.freeze({ status: "unavailable", reason: "platform" });
  const acquired = await acquireFixedImages(a);
  if (acquired.status !== "acquired") return acquired;
  const { imageA, imageB, sha256, inspection } = acquired.data;
  try {
    await writeFile(a.target, imageA, { flag: "wx", mode: 0o700 });
    await writeFile(a.policy, JSON.stringify({ version: 1, read: [], write: [a.cwd], exec: [], tcp_connect: [], cwd: a.cwd,
      child_restrictions: { deny_network: true, deny_chmod: true } }), { flag: "wx", mode: 0o600 });
  } catch { return Object.freeze({ status: "unavailable", reason: "materialization" }); }
  const fixture: PreparedNativeBoundFixture = Object.freeze({ [preparedBrand]: true as const });
  preparations.set(fixture, { assets: a, imageA, imageB, sha256, inspection, deadline: performance.now() + 11_000, used: false });
  return Object.freeze({ status: "prepared", fixture, observation: Object.freeze({ sha256, bytes: imageA.length, inspection }) });
}

export function startNativeBoundFixture(fixture: PreparedNativeBoundFixture, scenario: BoundFixtureScenario): FixtureInvocation {
  const prepared = consumePrepared(fixture, scenario, performance.now());
  return launchOwned(prepared.assets, scenario, "bound-transport-v1");
}

function contextParent(input: unknown): string {
  const { parent } = plainSnapshot(input, ["parent"]);
  if (typeof parent !== "string" || !parent.isWellFormed() || !isAbsolute(parent) || parent === "/" ||
    Buffer.byteLength(parent) > 3072 || /[\p{Cc}:]/u.test(parent) ||
    parent.slice(1).split("/").some(p => !p || p === "." || p === ".." || Buffer.byteLength(p) > 255))
    throw new Error("Invalid context parent");
  return parent;
}
function contextDiagnostics(context: AcpProbeContext): ContextFixtureDiagnostics {
  const identities = Object.freeze(Object.fromEntries(["root", ...contextLeaves].map(name => {
    const id = context.identities[name as keyof typeof context.identities];
    return [name, Object.freeze({ dev: id.dev.toString(), ino: id.ino.toString() })];
  }))) as ContextFixtureDiagnostics["identities"];
  return Object.freeze({ root: context.root, directories: context.directories, identities });
}
function contextSelection(context: AcpProbeContext, parent: string): ContextLaunch {
  if (!context.root.startsWith(`${parent}/probe-`) || Buffer.byteLength(context.root) > 3115 ||
    !/^probe-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(context.root.slice(parent.length + 1)))
    throw new Error("Invalid context selection");
  for (const name of contextLeaves) if (context.directories[name] !== `${context.root}/${name}` ||
    Buffer.byteLength(context.directories[name]) > 3123) throw new Error("Invalid context leaf");
  const ids = ["root", ...contextLeaves].map(name => context.identities[name as keyof typeof context.identities]);
  if (ids.some(id => [id.dev, id.ino].some(n => typeof n !== "bigint" || n < 0n || n > 0xffffffffffffffffn)) ||
    new Set(ids.map(id => `${id.dev}:${id.ino}`)).size !== 10) throw new Error("Invalid context identities");
  const e = context.env, d = context.directories;
  // Explicit allocator copy. No ambient merge, caller overrides, or asset-validator widening.
  const env = Object.freeze({ HOME: e.HOME, XDG_CONFIG_HOME: e.XDG_CONFIG_HOME, XDG_CACHE_HOME: e.XDG_CACHE_HOME,
    XDG_DATA_HOME: e.XDG_DATA_HOME, XDG_STATE_HOME: e.XDG_STATE_HOME, XDG_RUNTIME_DIR: e.XDG_RUNTIME_DIR,
    XDG_CONFIG_DIRS: e.XDG_CONFIG_DIRS, XDG_DATA_DIRS: e.XDG_DATA_DIRS, TMPDIR: e.TMPDIR, TMP: e.TMP, TEMP: e.TEMP,
    PATH: e.PATH, LANG: e.LANG, LC_ALL: e.LC_ALL });
  const expected = { HOME: d.home, XDG_CONFIG_HOME: d.config, XDG_CACHE_HOME: d.cache, XDG_DATA_HOME: d.data,
    XDG_STATE_HOME: d.state, XDG_RUNTIME_DIR: d.runtime, XDG_CONFIG_DIRS: d.empty, XDG_DATA_DIRS: d.empty,
    TMPDIR: d.tmp, TMP: d.tmp, TEMP: d.tmp, PATH: d.empty, LANG: "C", LC_ALL: "C" };
  if (Object.keys(e).length !== 14 || Object.entries(expected).some(([k, v]) => env[k as keyof typeof env] !== v) ||
    Object.entries(env).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 2, 0) > 48 * 1024)
    throw new Error("Invalid context environment");
  return Object.freeze({ context, identities: Object.freeze(ids.flatMap(id => [id.dev.toString(), id.ino.toString()])), env });
}
function afterAllocation(deadline: number, now: number, cancelled: boolean): "expired" | "cancelled" | undefined {
  return now >= deadline ? "expired" : cancelled ? "cancelled" : undefined;
}
function contextCancelled(signal?: AbortSignal): boolean {
  if (signal === undefined) return false;
  // The allocator has already authenticated identity. Recheck data descriptors
  // after its final await: the intrinsic getter itself reads copyable symbol slots.
  if (types.isProxy(signal)) throw new Error("Invalid context signal");
  const descriptors = Object.getOwnPropertyDescriptors(signal);
  if (Reflect.ownKeys(descriptors).some(key => !("value" in descriptors[key as keyof typeof descriptors])))
    throw new Error("Invalid context signal");
  return signalAborted.call(signal);
}

type AllocatedContext = Readonly<{ status: "allocated"; launch: ContextLaunch; diagnostics: ContextFixtureDiagnostics }>;
async function prepareContextSelection(parent: string, deadline: number, signal?: AbortSignal,
  prepared?: Prepared): Promise<AllocatedContext | Exclude<ContextFixturePreparation, { status: "prepared" }>> {
  let context: AcpProbeContext;
  try { context = await allocateAcpProbeContext({ parent }, signal); }
  catch (error) {
    const retainedRoot = error instanceof AcpProbeContextError && error.cleanup === "retained" && error.allocationName ?
      `${parent}/${error.allocationName}` : undefined;
    return Object.freeze({ status: "unavailable", reason: "allocation",
      ...(retainedRoot ? { retainedRoot } : {}),
      ...(error instanceof AcpProbeContextError ? { allocationReason: error.reason } : {}) });
  }
  if (prepared) prepared.context = context;
  const diagnostics = contextDiagnostics(context);
  let launch: ContextLaunch;
  try {
    const reason = afterAllocation(deadline, performance.now(), contextCancelled(signal));
    if (reason) return Object.freeze({ status: "unavailable", reason, diagnostics, retainedRoot: context.root });
    launch = contextSelection(context, parent);
    const finalReason = afterAllocation(deadline, performance.now(), contextCancelled(signal));
    if (finalReason) return Object.freeze({ status: "unavailable", reason: finalReason, diagnostics, retainedRoot: context.root });
  }
  catch { return Object.freeze({ status: "unavailable", reason: "selection", diagnostics, retainedRoot: context.root }); }
  return Object.freeze({ status: "allocated", launch, diagnostics });
}

/** Consumes a private image once, allocates internally, and retains every success. */
export async function prepareNativeContextBoundFixture(image: PreparedNativeBoundFixture, input: { parent: string },
  signal?: AbortSignal): Promise<ContextFixturePreparation> {
  // This must precede both image consumption and the allocator's signal/filesystem work.
  const parent = contextParent(input);
  const prepared = consumePrepared(image, "normal", performance.now());
  const allocation = await prepareContextSelection(parent, prepared.deadline, signal, prepared);
  if (allocation.status !== "allocated") return allocation;
  const { launch, diagnostics } = allocation;
  const fixture: PreparedNativeContextBoundFixture = Object.freeze({ [contextBrand]: true as const });
  contextPreparations.set(fixture, { image: prepared, assets: prepared.assets, launch, deadline: prepared.deadline, used: false });
  return Object.freeze({ status: "prepared", fixture, diagnostics });
}
export function startNativeContextBoundFixture(fixture: PreparedNativeContextBoundFixture, scenario: ContextFixtureScenario): FixtureInvocation {
  const prepared = consumeAssociation(contextPreparations, fixture, scenario, performance.now(), contextScenarios);
  return launchOwned(prepared.assets, scenario, "context-bound-transport-v1", prepared.launch);
}
export type StoredFixtureBootstrap = Readonly<{ driver: string; cwd: string;
  env: Readonly<{ HOME: string; TMPDIR: string; PATH: "/usr/bin"; LANG: "C"; LC_ALL: "C" }> }>;
const storedScenarios = ["normal", "sandbox", "hold", "proof-stale", "proof-extra", "proof-truncate", "proof-missing",
  "ctx-open", "ctx-final-inventory", "fault-read", "fault-seal", "fault-compare", "fault-close", "prep-stop", "prep-exec-expired"] as const;
export type StoredFixtureScenario = typeof storedScenarios[number];
export type StoredFixtureInvocation = Readonly<{ termination: Promise<FixtureTermination>; stop(): void }>;
type StoredRefusal = "invalid-input" | "installer" | "admission" | "expired" | "cancelled" | "store" | "image-mismatch" | "selection" | "spawn";
export type StoredFixtureStart = Readonly<
  { status: "started"; invocation: StoredFixtureInvocation; observation: AcpStoredRuntimeObservation; diagnostics: ContextFixtureDiagnostics } |
  { status: "refused"; reason: StoredRefusal; diagnostics?: ContextFixtureDiagnostics; retainedRoot?: string; allocationReason?: string } |
  { status: "unavailable"; reason: "platform" | "image-data" | "image-layout" | "allocation";
    diagnostics?: ContextFixtureDiagnostics; retainedRoot?: string; allocationReason?: string }>;
type StoredLaunchSelection = Readonly<{ driver: string; source: string; cwd: string; env: StoredFixtureBootstrap["env"] }>;
type StoredOwner = { deadline: number; cancelled: boolean; expired: boolean; channelError?: boolean; stoppedAt?: number; binding?: AcpStoredFixtureBinding;
  controller?: AbortController; listener?: () => void; timer?: NodeJS.Timeout; control?: Duplex; releasing?: Promise<void> };
let storedOperationOwned = false;
class StoredPreparationFailure extends Error {
  readonly reason: StoredRefusal;
  constructor(reason: StoredRefusal) { super("Stored fixture preparation refused"); this.reason = reason; }
}
function storedAdmission(owner: StoredOwner): void {
  if (owner.expired || performance.now() >= owner.deadline) throw new StoredPreparationFailure("expired");
  if (owner.cancelled || !owner.binding || signalAborted.call(owner.binding.signal)) throw new StoredPreparationFailure("cancelled");
}
function releaseStoredBinding(owner: StoredOwner): Promise<void> {
  if (owner.releasing) return owner.releasing;
  clearTimeout(owner.timer); owner.timer = undefined;
  const binding = owner.binding;
  if (binding && owner.listener) binding.signal.removeEventListener("abort", owner.listener);
  owner.listener = undefined; owner.controller?.abort(); owner.controller = undefined;
  owner.binding = undefined; owner.control = undefined;
  // A released task must not retain a fulfilled capture buffer or installer.
  owner.releasing = binding ? binding.release() : Promise.resolve();
  return owner.releasing;
}
function storedBootstrap(input: unknown): StoredFixtureBootstrap {
  const a = plainSnapshot(input, ["driver", "cwd", "env"]);
  const e = plainSnapshot(a.env, ["HOME", "TMPDIR", "PATH", "LANG", "LC_ALL"]);
  for (const value of [a.driver, a.cwd, e.HOME, e.TMPDIR]) {
    if (typeof value !== "string" || !value.isWellFormed() || !isAbsolute(value) || value === "/" ||
      Buffer.byteLength(value) > 3072 || /[\p{Cc}:]/u.test(value) || value.slice(1).split("/").some(part =>
        !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)) throw new Error("Invalid stored bootstrap");
  }
  if (a.driver === a.cwd || e.PATH !== "/usr/bin" || e.LANG !== "C" || e.LC_ALL !== "C") throw new Error("Invalid stored bootstrap");
  return Object.freeze({ ...a, env: Object.freeze({ ...e }) }) as StoredFixtureBootstrap;
}

/** One privately owned operation; no prepared candidate, RPC or caller byte baseline. */
export async function startNativeStoredContextBoundFixture(installer: AcpInstaller, id: string,
  bootstrap: StoredFixtureBootstrap, input: { parent: string }, scenario: StoredFixtureScenario): Promise<StoredFixtureStart> {
  if (storedOperationOwned) return Object.freeze({ status: "refused", reason: "admission" });
  const deadline = performance.now() + 11_000;
  // Authenticate private installer state before any caller reflection or work.
  const bound = bindAcpStoredFixtureInstaller(installer, id);
  if (bound.status !== "bound") return Object.freeze({ status: "refused", reason:
    bound.reason === "stopped" ? "cancelled" : bound.reason === "id" ? "invalid-input" : bound.reason === "path" ? "selection" : "installer" });
  storedOperationOwned = true;
  const owner: StoredOwner = { deadline, cancelled: false, expired: false, binding: bound.binding };
  let running = false, data: FixedImageData | undefined;
  let capture: Awaited<ReturnType<AcpStoredFixtureBinding["capture"]>> | undefined;
  let diagnostics: ContextFixtureDiagnostics | undefined, retainedRoot: string | undefined, allocationReason: string | undefined;
  const retained = () => ({ ...(diagnostics ? { diagnostics } : {}),
    ...(retainedRoot ? { retainedRoot } : {}), ...(allocationReason ? { allocationReason } : {}) });
  try {
    let a: StoredFixtureBootstrap, parent: string;
    try { a = storedBootstrap(bootstrap); parent = contextParent(input);
      if (!storedScenarios.includes(scenario)) throw new Error("Invalid stored scenario"); }
    catch { return Object.freeze({ status: "refused", reason: "invalid-input" }); }
    owner.controller = createAcpProbeAbortController();
    owner.listener = () => {
      owner.cancelled = true; owner.stoppedAt ??= performance.now(); owner.controller?.abort();
      try { owner.control?.destroy(); } catch { owner.channelError = true; }
    };
    bound.binding.signal.addEventListener("abort", owner.listener, { once: true });
    if (signalAborted.call(bound.binding.signal)) owner.listener();
    owner.timer = setTimeout(() => {
      owner.expired = true; owner.controller?.abort();
      // Abort capture's separate signal now. The operation's finally still
      // awaits this idempotent release and all closes before releasing its slot.
      void bound.binding.release().catch(() => {});
    }, Math.max(1, deadline - performance.now()));
    storedAdmission(owner);
    if (process.platform !== "linux" || process.arch !== "x64") return Object.freeze({ status: "unavailable", reason: "platform" });
    let acquired: Awaited<ReturnType<typeof acquireFixedImages>> | undefined = await acquireFixedImages(a, owner.controller.signal, deadline);
    storedAdmission(owner);
    if (acquired.status !== "acquired") return acquired;
    data = acquired.data; acquired = undefined;
    const allocation = await prepareContextSelection(parent, deadline, owner.controller.signal);
    diagnostics = allocation.diagnostics;
    retainedRoot = diagnostics?.root;
    if (allocation.status !== "allocated") {
      retainedRoot = allocation.retainedRoot ?? retainedRoot; allocationReason = allocation.allocationReason;
    }
    storedAdmission(owner);
    if (allocation.status !== "allocated") {
      if (allocation.reason === "allocation") return Object.freeze({ status: "unavailable", reason: "allocation", ...retained() });
      return Object.freeze({ status: "refused", reason: allocation.reason, ...retained() });
    }
    try { capture = await bound.binding.capture(); }
    catch { storedAdmission(owner); return Object.freeze({ status: "refused", reason: "store", ...retained() }); }
    storedAdmission(owner);
    const inspection = inspectAcpArtifactRuntime(capture.bytes, "linux-x86_64");
    if (inspection.status !== "observed" || inspection.elfType !== "ET_EXEC")
      return Object.freeze({ status: "refused", reason: "selection", ...retained() });
    const matches = capture.bytes.length === data.imageA.length && capture.bytes.equals(data.imageA);
    storedAdmission(owner);
    if (!matches) return Object.freeze({ status: "refused", reason: "image-mismatch", ...retained() });
    const observation = capture.observation;
    const selected: StoredLaunchSelection = Object.freeze({ driver: a.driver, source: capture.path, cwd: a.cwd, env: a.env });
    capture = undefined; data = undefined;
    storedAdmission(owner);
    const invocation = launchOwned(selected, scenario, "context-bound-transport-v1", allocation.launch, owner);
    running = true;
    return Object.freeze({ status: "started", invocation, observation, diagnostics: allocation.diagnostics });
  } catch (error) {
    return Object.freeze({ status: "refused", reason: error instanceof StoredPreparationFailure ? error.reason : "spawn", ...retained() });
  } finally {
    capture = undefined; data = undefined;
    if (!running) { await releaseStoredBinding(owner); storedOperationOwned = false; }
  }
}

function launchArguments(a: FixtureAssets | StoredLaunchSelection, scenario: ContextFixtureScenario,
  mode: "transport-v1" | "bound-transport-v1" | "context-bound-transport-v1", id: Buffer, context?: ContextLaunch): string[] {
  if (mode === "context-bound-transport-v1") {
    if (!context) throw new Error("Missing private context association");
    return [mode, "source" in a ? a.source : a.target, scenario, a.cwd, context.context.root, ...context.identities, id.toString("hex")];
  }
  if (!("policy" in a)) throw new Error("Missing legacy assets");
  return [mode, a.target, scenario, a.cwd, a.policy, id.toString("hex")];
}
const associations = new WeakMap<FixtureNamespaceTermination, { owner: object; child: ChildProcess }>();
type Candidate = { status: "proven"; outcome: Outcome } | Exclude<FixtureTermination, { status: "proven" }>;
const unproven = (reason: Extract<FixtureTermination, { status: "unproven" }>["reason"]): Candidate => ({ status: "unproven", reason });

// This class cannot construct opaque evidence. Exactly one fixed allocation; byte
// 33 poisons immediately, including a huge first chunk. No recovery after failure.
class Join {
  readonly buffer = Buffer.alloc(32);
  bytes = 0;
  ended = false;
  exitCode: number | null | undefined;
  result: Candidate | undefined;
  deadline: number;
  readonly id: Buffer;
  constructor(id: Buffer, launch: number) { this.id = id; this.deadline = launch + 11_000; }
  fail(reason: Extract<FixtureTermination, { status: "unproven" }>["reason"]): void {
    this.result ??= unproven(reason);
  }
  time(now: number): void { if (now >= this.deadline) this.fail("deadline"); }
  stop(now: number): void { this.deadline = Math.min(this.deadline, now + 3000); this.time(now); }
  data(chunk: Buffer, now: number): void {
    this.time(now);
    if (this.result) return;
    if (this.ended || chunk.length > 32 - this.bytes) { this.bytes = 33; this.fail("record"); return; }
    chunk.copy(this.buffer, this.bytes); this.bytes += chunk.length;
    if (this.bytes === 32 && !this.decode()) this.fail("record");
    this.join(now);
  }
  end(now: number): void {
    this.time(now); if (this.result) return;
    this.ended = true;
    if (this.bytes !== 32 || !this.decode()) this.fail("record");
    this.join(now);
  }
  close(now: number): void { this.time(now); if (!this.ended) this.fail("channel"); }
  exit(code: number | null, signal: string | null, now: number): void {
    this.time(now); if (this.result) return;
    this.exitCode = signal === null ? code : null;
    if (this.exitCode === null || ![0, 64, 65, 66, 70].includes(this.exitCode)) this.fail("producer");
    this.join(now);
  }
  private decode(): Candidate | undefined {
    const b = this.buffer, kind = b[5], detail = b[6], value = b.readUInt32BE(24);
    if (!b.subarray(0, 4).equals(Buffer.from("GPLT")) || b[4] !== 1 || b[7] !== 0 ||
      !b.subarray(8, 24).equals(this.id) || b.readUInt32BE(28) !== 0) return;
    if (kind === 1) {
      if (detail === 1 && value <= 255) return { status: "proven", outcome: { kind: "exited", code: value } };
      if (detail === 2 && value >= 1 && value <= 64) return { status: "proven", outcome: { kind: "signalled", signal: value } };
      if (detail === 3 && value === 0) return { status: "proven", outcome: { kind: "stopped" } };
      if (detail === 4 && value === 0) return { status: "proven", outcome: { kind: "setup-failed" } };
    }
    if (kind === 2 && value === 0 && detail >= 1 && detail <= 3)
      return { status: "refused", reason: (["invalid-input", "unsupported", "admission"] as const)[detail - 1] };
    if (kind === 3 && detail === 1 && value === 0) return unproven("native-unproven");
  }
  private join(now: number): void {
    this.time(now);
    if (this.result || !this.ended || this.exitCode === undefined) return;
    const candidate = this.decode();
    if (!candidate) { this.fail("record"); return; }
    const expected = candidate.status === "proven" ? 0 : candidate.status === "unproven" ? 70 :
      ({ "invalid-input": 64, unsupported: 65, admission: 66 })[candidate.reason];
    this.result = this.exitCode === expected ? candidate : unproven("producer");
  }
}

function plainSnapshot(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Invalid fixture assets");
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))) throw new Error("Invalid fixture assets");
  const copy: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(input, k)!;
    if (!("value" in d)) throw new Error("Invalid fixture assets");
    copy[k] = d.value;
  }
  return copy;
}
function snapshot(assets: FixtureAssets, scenario: FixtureScenario): FixtureAssets {
  if (!scenarios.includes(scenario)) throw new Error("Invalid fixture scenario");
  const a = plainSnapshot(assets, ["driver", "target", "policy", "cwd", "env"]);
  for (const k of ["driver", "target", "policy", "cwd"]) {
    const v = a[k];
    if (typeof v !== "string" || !v.isWellFormed() || !isAbsolute(v) || v === "/" ||
      Buffer.byteLength(v) > 3072 || /[\p{Cc}:]/u.test(v) || v.slice(1).split("/").some(p => !p || p === "." || p === ".."))
      throw new Error("Invalid fixture path");
  }
  const e = plainSnapshot(a.env, ["HOME", "TMPDIR", "PATH", "LANG", "LC_ALL"]);
  if (![e.HOME, e.TMPDIR].every(v => typeof v === "string" && isAbsolute(v) && v !== "/" &&
    v.isWellFormed() && Buffer.byteLength(v) <= 3072 && !/[\p{Cc}:]/u.test(v) &&
    !v.slice(1).split("/").some(p => !p || p === "." || p === "..")) || e.PATH !== "/usr/bin" || e.LANG !== "C" || e.LC_ALL !== "C")
    throw new Error("Invalid literal fixture environment");
  return Object.freeze({ ...a, env: Object.freeze({ ...e }) }) as FixtureAssets;
}

export function startNativeLifetimeFixture(assets: FixtureAssets, scenario: FixtureScenario): FixtureInvocation {
  return launchOwned(snapshot(assets, scenario), scenario, "transport-v1");
}

function launchOwned(a: FixtureAssets, scenario: ContextFixtureScenario,
  mode: "transport-v1" | "bound-transport-v1" | "context-bound-transport-v1", context?: ContextLaunch): FixtureInvocation;
function launchOwned(a: StoredLaunchSelection, scenario: StoredFixtureScenario,
  mode: "context-bound-transport-v1", context: ContextLaunch, stored: StoredOwner): StoredFixtureInvocation;
function launchOwned(a: FixtureAssets | StoredLaunchSelection, scenario: ContextFixtureScenario,
  mode: "transport-v1" | "bound-transport-v1" | "context-bound-transport-v1", context?: ContextLaunch,
  stored?: StoredOwner): FixtureInvocation | StoredFixtureInvocation {
  const owner = Object.freeze({}), id = randomBytes(16);
  const launch = performance.now(), state = new Join(id, launch);
  let child: ChildProcess | undefined, control: Duplex | undefined;
  let resolve!: (r: FixtureTermination) => void, timer: NodeJS.Timeout | undefined, settled = false;
  const termination = new Promise<FixtureTermination>(r => { resolve = r; });
  let outputPending = stored ? 2 : 0;
  const monitors: Array<() => void> = [];
  const monitor = (endpoint: NodeJS.EventEmitter, event: string, fn: (...args: any[]) => void) => {
    endpoint.on(event, fn); monitors.push(() => endpoint.removeListener(event, fn));
  };
  const closeControl = () => {
    if (!stored) { control?.destroy(); return; }
    try { control?.destroy(); } catch { stored.channelError = true; }
  };
  const terminalStored = () => {
    if (!stored) return;
    closeControl();
    void releaseStoredBinding(stored);
  };
  const channelSettled = () => {
    if (!stored) return;
    const finished = stored;
    if (!settled) channelFailure();
    terminalStored();
    for (const detach of monitors.splice(0)) detach();
    control = undefined; context = undefined;
    void releaseStoredBinding(finished).then(() => { storedOperationOwned = false; });
    stored = undefined;
  };
  const settle = () => {
    const now = performance.now();
    if (!settled && now >= state.deadline) state.result = unproven("deadline");
    state.time(now);
    if (!settled && stored?.channelError && state.result?.status !== "unproven") state.result = unproven("channel");
    const r = state.result;
    if (settled || !r) return;
    // A valid proof cannot outrun a pending stdout/stderr overflow or error.
    // This extra direct-branch drain does not change the legacy Join.
    if (stored && r.status !== "unproven" && outputPending !== 0) return;
    settled = true; clearTimeout(timer);
    if (r.status === "proven" && child && child.exitCode === 0 && child.signalCode === null) {
      const evidence: FixtureNamespaceTermination = Object.freeze({ [brand]: true as const });
      associations.set(evidence, { owner, child });
      resolve(Object.freeze({ ...r, outcome: Object.freeze(r.outcome), evidence }));
    } else resolve(Object.freeze(r.status === "proven" ? unproven("producer") as FixtureTermination : r));
    if (r.status === "unproven") closeControl();
    terminalStored();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.time(performance.now()); settle(); if (!settled) arm(); }, Math.max(1, Math.ceil(state.deadline - performance.now())));
  };
  const stop = () => {
    if (settled) return;
    state.stop(stored?.stoppedAt ?? performance.now()); closeControl(); arm(); settle();
  };
  const channelFailure = () => {
    if (!settled && state.result?.status !== "unproven") state.result = unproven("channel");
    state.fail("channel"); closeControl(); settle();
  };
  const native = {
    spawn: (() => {
      if (child) throw new Error("Fixture spawn already owned");
      const args = launchArguments(a, scenario, mode, id, context);
      const options = { cwd: a.cwd, env: { ...(context?.env ?? a.env) }, detached: false,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe", "pipe", "pipe"] };
      const direct = stored !== undefined;
      if (stored) storedAdmission(stored);
      child = spawn(a.driver, args, options);
      // From this assignment onward this is always an owned run, even if Stop
      // arrived reentrantly in spawn or acquiring an endpoint fails.
      try {
        if (stored) {
          monitor(child, "close", channelSettled);
          clearTimeout(stored.timer); stored.timer = undefined; stored.controller = undefined;
          monitor(child, "exit", (code: number | null, signal: NodeJS.Signals | null) => { state.exit(code, signal, performance.now()); settle(); });
          monitor(child, "error", () => { state.fail("spawn"); settle(); });
        }
        control = child.stdio[3] as Duplex;
        const proof = child.stdio[4] as Readable;
        if (stored) {
          let outputBytes = 0;
          const output = (chunk: Buffer) => {
            if (settled) return;
            if (chunk.length > 65_536 - outputBytes) { channelFailure(); return; }
            outputBytes += chunk.length;
          };
          for (const endpoint of [child.stdin, child.stdout, child.stderr, control, proof]) {
            if (!endpoint) throw new Error("Missing owned endpoint");
            monitor(endpoint, "error", channelFailure);
          }
          for (const endpoint of [child.stdout!, child.stderr!]) {
            let ended = false;
            monitor(endpoint, "data", output);
            monitor(endpoint, "end", () => { if (!ended) { ended = true; outputPending--; } settle(); });
            monitor(endpoint, "close", () => { if (!ended) channelFailure(); });
          }
          monitor(control, "close", stop);
          child.stdin!.end();
          stored.control = control;
          if (stored.cancelled || (stored.binding && signalAborted.call(stored.binding.signal))) stop();
          monitor(proof, "data", (b: Buffer) => { state.data(b, performance.now()); settle(); });
          monitor(proof, "end", () => { state.end(performance.now()); settle(); });
          monitor(proof, "close", () => { state.close(performance.now()); settle(); });
        } else {
          control.on("error", stop);
          proof.on("data", (b: Buffer) => { state.data(b, performance.now()); settle(); });
          proof.on("end", () => { state.end(performance.now()); settle(); });
          proof.on("close", () => { state.close(performance.now()); settle(); });
          proof.on("error", () => { state.fail("channel"); settle(); });
          child.on("exit", (code, signal) => { state.exit(code, signal, performance.now()); settle(); });
          child.on("error", () => { state.fail("spawn"); settle(); });
        }
      } catch (error) {
        if (!direct) throw error;
        channelFailure();
      }
      return child;
    }) as typeof spawn,
    kill: ((pid: number, signal?: NodeJS.Signals | number) => {
      if (!child?.pid || pid !== -child.pid || (signal !== "SIGTERM" && signal !== "SIGKILL")) throw new Error("Unowned fixture stop");
      stop(); return true;
    }) as typeof process.kill,
  };
  if (stored) {
    native.spawn(a.driver, []);
    if (!settled) arm();
    return Object.freeze({ termination: Object.freeze(termination), stop: Object.freeze(stop) });
  }
  if (!("policy" in a)) throw new Error("Missing legacy assets");
  const rpc = startAcp({ supervisor: a.driver, policyFile: a.policy, bin: a.target, args: [],
    cwd: context?.context.directories.cwd ?? a.cwd, env: { ...(context?.env ?? a.env) }, outputBudget: { maxBytes: 65_536 } }, native);
  arm();
  return Object.freeze({ rpc, termination, stop });
}

// Finite internal association/state checks. No returned identity, byte baseline,
// proof, native seam or launch: metadata cannot be consumed by either entry point.
export function syntheticContextFixtureChecks(): ReadonlyArray<Readonly<{ name: string; pass: boolean }>> {
  const rows: Array<Readonly<{ name: string; pass: boolean }>> = [];
  const put = (name: string, pass: boolean) => rows.push(Object.freeze({ name, pass }));
  const rejects = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  // This isolated map has neither image assets nor a route to either live map.
  const states = new WeakMap<object, { used: boolean; deadline: number; selected: number }>();
  const first = Object.freeze({}), second = Object.freeze({});
  states.set(first, { used: false, deadline: 100, selected: 1 });
  states.set(second, { used: false, deadline: 100, selected: 2 });
  const consume = (key: object, scenario: ContextFixtureScenario, now: number) =>
    consumeAssociation(states, key, scenario, now, contextScenarios);
  let traps = 0;
  const proxy = new Proxy(first, { get() { traps++; throw new Error("trap"); }, ownKeys() { traps++; throw new Error("trap"); },
    getPrototypeOf() { traps++; throw new Error("trap"); }, getOwnPropertyDescriptor() { traps++; throw new Error("trap"); } });
  put("proxy-handle", rejects(() => consume(proxy, "normal", 0)) && traps === 0);
  put("copy-handle", rejects(() => consume(Object.freeze({ ...first }), "normal", 0)));
  put("forged-handle", rejects(() => consume(Object.freeze({ [contextBrand]: true }), "normal", 0)));
  put("caller-completion", rejects(() => consume({ status: "proven", evidence: {}, context: {} }, "normal", 0)));
  put("invalid-scenario", rejects(() => consume(first, "ctx-arbitrary" as never, 0)) && !states.get(first)!.used);
  put("single-use", consume(first, "normal", 1).selected === 1);
  put("reuse", rejects(() => consume(first, "normal", 2)));
  put("concurrent-reuse", rejects(() => consume(first, "ctx-open", 2)));
  put("cross-context", states.get(second)!.selected === 2 && !states.get(second)!.used);
  put("expiry-exact", rejects(() => consume(second, "normal", 100)));
  put("expiry-late", rejects(() => consume(second, "normal", 101)));
  put("expiry-not-renewed", states.get(second)!.deadline === 100);
  put("before-expiry", consume(second, "normal", 99).selected === 2);
  put("synthetic-cannot-prepare-image", rejects(() => consumePrepared(first as never, "normal", 0)));
  put("synthetic-cannot-start-context", rejects(() => consumeAssociation(contextPreparations, first, "normal", 0, contextScenarios)));
  for (const stage of ["before-capture", "before-acquire", "after-acquire"] as const) for (const mutation of contextMutations)
    put(`finite-${stage}-${mutation}`, contextScenarios.includes(`ctx-${stage}-${mutation}`));
  for (const fault of contextFaults) put(`finite-${fault}`, contextScenarios.includes(fault));
  const parent = "/invented/context-parent", root = `${parent}/probe-00000000-0000-0000-0000-000000000001`;
  const directories = Object.freeze(Object.fromEntries(contextLeaves.map(n => [n, `${root}/${n}`]))) as AcpProbeContext["directories"];
  const identities = Object.freeze(Object.fromEntries(["root", ...contextLeaves].map((n, i) =>
    [n, Object.freeze({ dev: 1n, ino: BigInt(i + 1) })]))) as AcpProbeContext["identities"];
  const env = Object.freeze({ HOME: directories.home, XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache,
    XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state, XDG_RUNTIME_DIR: directories.runtime,
    XDG_CONFIG_DIRS: directories.empty, XDG_DATA_DIRS: directories.empty, TMPDIR: directories.tmp, TMP: directories.tmp,
    TEMP: directories.tmp, PATH: directories.empty, LANG: "C", LC_ALL: "C" });
  const context: AcpProbeContext = Object.freeze({ root, directories, identities, env,
    filesystem: Object.freeze({ cwd: directories.cwd, read: Object.freeze([directories.empty]),
      write: Object.freeze(contextLeaves.slice(0, -1).map(n => directories[n])), exec: Object.freeze([]) as readonly [] }) });
  const selection = contextSelection(context, parent), diagnostics = contextDiagnostics(context);
  put("exact-environment", Object.keys(selection.env).length === 14 && Object.entries(env).every(([k, v]) => selection.env[k] === v));
  put("environment-copy", selection.env !== context.env && Object.isFrozen(selection.env));
  put("environment-extra", rejects(() => contextSelection({ ...context, env: { ...env, POISON: "invented" } }, parent)));
  put("environment-crossed", rejects(() => contextSelection({ ...context, env: { ...env, HOME: "/invented/other" } }, parent)));
  put("leaf-crossed", rejects(() => contextSelection({ ...context, directories: { ...directories, cwd: directories.home } }, parent)));
  put("root-crossed", rejects(() => contextSelection(context, "/invented/other")));
  for (const value of [-1n, 0x10000000000000000n]) put(`identity-range-${value}`, rejects(() => contextSelection({ ...context,
    identities: { ...identities, root: { dev: value, ino: 1n } } }, parent)));
  put("identity-alias", rejects(() => contextSelection({ ...context, identities: { ...identities, cwd: identities.root } }, parent)));
  put("identity-u64-maximum", contextSelection({ ...context, identities: { ...identities,
    root: { dev: 0xffffffffffffffffn, ino: 0xffffffffffffffffn } } }, parent).identities[0] === "18446744073709551615");
  put("canonical-u64", selection.identities.length === 20 && selection.identities.every(s => /^(0|[1-9][0-9]*)$/.test(s)));
  const assets: FixtureAssets = { driver: "/invented/driver", target: "/invented/image", policy: "/invented/policy", cwd: "/invented/bootstrap",
    env: { HOME: "/invented/home", TMPDIR: "/invented/tmp", PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } };
  const id = Buffer.alloc(16, 19), otherId = Buffer.alloc(16, 20);
  const args = launchArguments(assets, "normal", "context-bound-transport-v1", id, selection);
  put("fixed-argv", args.length === 26 && args[0] === "context-bound-transport-v1" && args[1] === assets.target &&
    args[3] === assets.cwd && args[4] === root && args.slice(5, 25).join() === selection.identities.join() && args[25] === id.toString("hex"));
  put("invocation-freshness", launchArguments(assets, "normal", "context-bound-transport-v1", otherId, selection)[25] !== args[25]);
  put("bootstrap-independent", args[3] !== directories.cwd);
  put("missing-association", rejects(() => launchArguments(assets, "normal", "context-bound-transport-v1", id)));
  put("legacy-argv", launchArguments(assets, "normal", "transport-v1", id).length === 6);
  for (const [name, now, cancelled, expected] of [["normal", 99, false, undefined], ["expiry", 100, false, "expired"],
    ["late-allocation", 101, false, "expired"], ["cancel", 99, true, "cancelled"], ["expired-cancel", 100, true, "expired"]] as const) {
    put(`after-allocation-${name}`, afterAllocation(100, now, cancelled) === expected && diagnostics.root === root &&
      Object.keys(diagnostics.directories).length === 9 && Object.keys(diagnostics.identities).length === 10);
  }
  const getter = Object.defineProperty({}, "parent", { get() { traps++; throw new Error("getter"); } });
  put("parent-getter", rejects(() => contextParent(getter)) && traps === 0);
  put("parent-proxy", rejects(() => contextParent(proxy)) && traps === 0);
  put("parent-extra", rejects(() => contextParent({ parent, env })));
  put("parent-byte-limit", rejects(() => contextParent({ parent: `/${"a/".repeat(1536)}a` })));
  put("parent-component-limit", rejects(() => contextParent({ parent: `/${"a".repeat(256)}` })));
  const maximumParent = `/${`${"a".repeat(255)}/`.repeat(11)}${"a".repeat(255)}`;
  put("parent-maximum", Buffer.byteLength(maximumParent) === 3072 && contextParent({ parent: maximumParent }) === maximumParent);
  const maximumRoot = `${maximumParent}/${root.slice(parent.length + 1)}`;
  const maximumDirectories = Object.freeze(Object.fromEntries(contextLeaves.map(n => [n, `${maximumRoot}/${n}`]))) as AcpProbeContext["directories"];
  const maximumEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.startsWith(root) ? maximumRoot + v.slice(root.length) : v]));
  const maximum = contextSelection({ ...context, root: maximumRoot, directories: maximumDirectories, env: maximumEnv }, maximumParent);
  put("root-leaf-maximum", Buffer.byteLength(maximum.context.root) === 3115 && Buffer.byteLength(maximum.context.directories.runtime) === 3123);
  put("environment-bounded", Object.entries(maximum.env).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 2, 0) <= 48 * 1024);
  put("failed-selection-retains-diagnostics", rejects(() => contextSelection({ ...context, env: { ...env, LC_ALL: "poison" } }, parent)) &&
    diagnostics.root === root && Object.keys(diagnostics.identities).length === 10);
  const lateSlot = Object.defineProperty({}, Symbol("invented late signal slot"), { get() { traps++; throw new Error("getter"); } });
  put("late-signal-slot-getter", rejects(() => contextCancelled(lateSlot as never)) && traps === 0 && diagnostics.root === root);
  put("late-signal-proxy", rejects(() => contextCancelled(proxy as never)) && traps === 0 && diagnostics.root === root);
  put("no-signal", contextCancelled() === false);
  return Object.freeze(rows);
}

export function syntheticBoundFixtureChecks(): ReadonlyArray<Readonly<{ name: string; pass: boolean }>> {
  // Isolated state map has no prepared assets and cannot feed the launch map.
  const states = new WeakMap<object, { used: boolean; deadline: number }>();
  const consume = (key: object, scenario: BoundFixtureScenario, now: number) => consumeAssociation(states, key, scenario, now);
  const out: Array<Readonly<{ name: string; pass: boolean }>> = [];
  const put = (name: string, pass: boolean) => out.push(Object.freeze({ name, pass }));
  const rejects = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
  for (const [name, size, diagnostics, now, accepted] of [
    ["data-empty", 0, 0, 1, false], ["data-prefix", 63, 0, 1, false], ["data-minimum", 64, 0, 1, true],
    ["data-cap", 4 * 1024 * 1024, 0, 1, true], ["data-over-cap", 4 * 1024 * 1024 + 1, 0, 1, false],
    ["data-diagnostics", 64, 1, 1, false], ["data-before-deadline", 64, 0, 1999, true],
    ["data-at-deadline", 64, 0, 2000, false], ["data-late", 64, 0, 2001, false],
  ] as const) put(name, imageDataAdmitted(size, diagnostics, 0, now) === accepted);
  const fresh = () => {
    const key = Object.freeze({});
    states.set(key, { deadline: 100, used: false });
    return key;
  };
  const first = fresh(), second = fresh();
  try {
    put("unknown-object", rejects(() => consume(Object.freeze({}), "normal", 0)));
    put("forged-brand", rejects(() => consume(Object.freeze({ [preparedBrand]: true }), "normal", 0)));
    let traps = 0;
    const proxy = new Proxy(first, { get() { traps++; throw new Error("invented trap"); } });
    put("proxy-identity", rejects(() => consume(proxy, "normal", 0)) && traps === 0);
    put("crossed-copy", rejects(() => consume(Object.freeze({ ...first }), "normal", 0)));
    put("invalid-scenario", rejects(() => consume(first, "caller-selected-mode" as never, 0)));
    put("invalid-does-not-consume", states.get(first)?.used === false);
    put("single-use", consume(first, "normal", 1).used);
    put("reuse", rejects(() => consume(first, "sealed-replace", 2)));
    put("concurrent-reuse", rejects(() => consume(first, "normal", 2)));
    put("independent-invocation", states.get(second)?.used === false);
    put("deadline-exact", rejects(() => consume(second, "normal", 100)));
    put("stale", rejects(() => consume(second, "normal", 101)));
    put("before-deadline", consume(second, "normal", 99).used);
    put("ordinary-proof-has-no-preparation", rejects(() => consume(Object.freeze({ [brand]: true }), "normal", 0)));
    put("synthetic-is-not-live-preparation", rejects(() => consumePrepared(first as never, "normal", 0)));
  } finally { states.delete(first); states.delete(second); }
  for (const row of syntheticLifetimeChecks()) put(`bound-proof-${row.name}`, row.pass);
  return Object.freeze(out);
}

// Fixed invented checks return only validation metadata. No caller bytes, process,
// identity or transport are accepted, and this path never calls the result factory.
export function syntheticLifetimeChecks(): ReadonlyArray<Readonly<{ name: string; status: string; reason?: string; bytes: number; capacity: number; pass: boolean }>> {
  const id = Buffer.alloc(16, 19), good = Buffer.alloc(32);
  good.write("GPLT"); good[4] = 1; good[5] = 1; good[6] = 1; id.copy(good, 8); good.writeUInt32BE(7, 24);
  const out: Array<{ name: string; status: string; reason?: string; bytes: number; capacity: number; pass: boolean }> = [];
  const check = (name: string, apply: (s: Join) => void, status: string, reason?: string) => {
    const s = new Join(id, 0); apply(s);
    const r = s.result;
    out.push(Object.freeze({ name, status: r?.status ?? "pending", ...(r && "reason" in r ? { reason: r.reason } : {}),
      bytes: s.bytes, capacity: s.buffer.length, pass: (r?.status ?? "pending") === status && (reason === undefined || !!(r && "reason" in r && r.reason === reason)) }));
  };
  for (let n = 0; n < 32; n++) check(`prefix-${n}`, s => { s.data(good.subarray(0, n), 1); s.end(2); s.exit(0, null, 3); }, "unproven", "record");
  for (let n = 0; n <= 32; n++) check(`split-${n}`, s => { s.data(good.subarray(0, n), 1); s.exit(0, null, 2); s.data(good.subarray(n), 3); s.end(4); }, "proven");
  for (const exitFirst of [false, true]) check(`ordering-${exitFirst}`, s => {
    if (exitFirst) s.exit(0, null, 1); s.data(good, 2); s.end(3); if (!exitFirst) s.exit(0, null, 4);
  }, "proven");
  for (const [offset, value] of [[0, 0], [0, 0xc7], [1, 0xd0], [2, 0xcc], [3, 0xd4], [4, 2], [5, 0], [5, 4], [6, 0], [6, 5], [7, 1], [8, 20], [28, 1], [31, 1], [24, 1]] as const)
    check(`invalid-${offset}-${value}`, s => { const b = Buffer.from(good); b[offset] = value; s.data(b, 1); s.end(2); s.exit(0, null, 3); }, "unproven", "record");
  for (const [detail, value, valid] of [[1, 0, true], [1, 255, true], [1, 256, false], [2, 0, false], [2, 1, true], [2, 64, true], [2, 65, false], [3, 0, true], [3, 1, false], [4, 0, true], [4, 1, false]] as const)
    check(`value-${detail}-${value}`, s => { const b = Buffer.from(good); b[6] = detail; b.writeUInt32BE(value, 24); s.data(b, 1); s.end(2); s.exit(0, null, 3); }, valid ? "proven" : "unproven");
  for (const [kind, detail, exit] of [[2, 1, 64], [2, 2, 65], [2, 3, 66], [3, 1, 70]] as const) {
    check(`classification-${kind}-${detail}`, s => { const b = Buffer.from(good); b[5] = kind; b[6] = detail; b.writeUInt32BE(0, 24); s.data(b, 1); s.end(2); s.exit(exit, null, 3); }, kind === 2 ? "refused" : "unproven");
    check(`inconsistent-${kind}-${detail}`, s => { const b = Buffer.from(good); b[5] = kind; b[6] = detail; b.writeUInt32BE(0, 24); s.data(b, 1); s.end(2); s.exit(0, null, 3); }, "unproven", "producer");
  }
  for (const [kind, detail, value] of [[2, 0, 0], [2, 4, 0], [2, 1, 1], [3, 0, 0], [3, 2, 0], [3, 1, 1]] as const)
    check(`failure-field-${kind}-${detail}-${value}`, s => { const b = Buffer.from(good); b[5] = kind; b[6] = detail; b.writeUInt32BE(value, 24); s.data(b, 1); s.end(2); s.exit(0, null, 3); }, "unproven", "record");
  check("byte-33", s => { s.data(good, 1); s.data(Buffer.alloc(1), 2); }, "unproven", "record");
  check("duplicate", s => s.data(Buffer.concat([good, good]), 1), "unproven", "record");
  check("huge-chunk", s => s.data(Buffer.alloc(100_000), 1), "unproven", "record");
  check("poison-no-recovery", s => { s.data(Buffer.alloc(33), 1); s.data(good, 2); s.end(3); s.exit(0, null, 4); }, "unproven", "record");
  check("end-only", s => s.end(1), "unproven", "record");
  check("close-not-end", s => { s.data(good, 1); s.close(2); s.exit(0, null, 3); s.end(4); }, "unproven", "channel");
  check("error-not-end", s => { s.data(good, 1); s.fail("channel"); s.exit(0, null, 3); s.end(4); }, "unproven", "channel");
  check("no-eof", s => { s.data(good, 1); s.exit(0, null, 2); s.time(11_000); }, "unproven", "deadline");
  check("no-exit", s => { s.data(good, 1); s.end(2); s.time(11_000); }, "unproven", "deadline");
  check("missing", s => { s.exit(0, null, 1); s.time(11_000); }, "unproven", "deadline");
  check("full-record-producer-death", s => { s.data(good, 1); s.end(2); s.exit(null, "SIGKILL", 3); }, "unproven", "producer");
  check("late-join", s => { s.data(good, 1); s.end(2); s.exit(0, null, 11_000); }, "unproven", "deadline");
  check("no-late-promotion", s => { s.time(11_000); s.data(good, 11_001); s.end(11_002); s.exit(0, null, 11_003); }, "unproven", "deadline");
  check("stop-deadline", s => { s.stop(10); s.stop(1000); s.data(good, 3009); s.end(3009); s.exit(0, null, 3010); }, "unproven", "deadline");
  check("launch-deadline-earlier", s => { s.stop(10_000); s.data(good, 10_999); s.end(10_999); s.exit(0, null, 11_000); }, "unproven", "deadline");
  check("pending-record", s => s.data(good, 1), "pending");
  check("pending-end", s => { s.data(good, 1); s.end(2); }, "pending");
  check("pending-exit", s => s.exit(0, null, 1), "pending");
  check("concurrent-stale", s => { const other = new Join(Buffer.alloc(16, 20), 0); other.data(good, 1); other.end(2); other.exit(0, null, 3); if (other.result?.status !== "unproven") throw new Error("stale record accepted"); s.data(good, 1); s.end(2); s.exit(0, null, 3); }, "proven");
  return Object.freeze(out);
}
