// Passive scratch allocation only: no execution, credential access, or lifetime claim.
// Successful allocations are retained. Rollback is limited to unpublished setup.
// Node has no inode-conditional rename/rmdir; hostile same-user races are outside
// this private, trusted-local-storage boundary, even after capture and checks.
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rmdir, type FileHandle } from "node:fs/promises";
import { types } from "node:util";

const LEAVES = ["cwd", "home", "config", "cache", "data", "state", "runtime", "tmp", "empty"] as const;
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const nativeSignal = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal")!.get!;
const NativeAbortController = AbortController;
const SIGNAL_PROTOTYPE = AbortSignal.prototype;
// Node's copyable signal slots cannot authenticate native signals. This private
// identity set only admits signals made by our trusted native-controller factory.
const trustedSignals = new WeakSet<AbortSignal>();
const signalSlots = Object.getOwnPropertyDescriptors(nativeSignal.call(new NativeAbortController()));
const compositeSlot = Reflect.ownKeys(signalSlots).find(key => String(key) === "Symbol(kComposite)");

/** Native cancellation controller for this allocator; grants no cleanup authority. */
export function createAcpProbeAbortController(): AbortController {
  const controller = new NativeAbortController();
  trustedSignals.add(nativeSignal.call(controller));
  return controller;
}

export type ProbeDirectory = typeof LEAVES[number];
export type DirectoryIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type AcpProbeContext = Readonly<{
  root: string;
  directories: Readonly<Record<ProbeDirectory, string>>;
  identities: Readonly<Record<"root" | ProbeDirectory, DirectoryIdentity>>;
  env: Readonly<Record<string, string>>;
  /** Incomplete policy fragment; supplies no executable or runtime access. */
  filesystem: Readonly<{ cwd: string; read: readonly string[]; write: readonly string[]; exec: readonly [] }>;
}>;
export type ProbeContextFaultPoint = "before-root-created" | "after-root-created" |
  `after-leaf-created:${ProbeDirectory}` | "before-verify" | "after-verify" |
  `before-close:${"ancestor" | "root" | ProbeDirectory}` |
  `after-close:${"ancestor" | "root" | ProbeDirectory}` |
  "rollback-entry" | "before-root-capture" | "after-root-capture" |
  `before-leaf-capture:${ProbeDirectory}` | `after-leaf-capture:${ProbeDirectory}` | "rollback-before-remove";
type Reason = "invalid-input" | "unsafe-directory" | "identity-changed" |
  "unexpected-content" | "cancelled" | "filesystem-error";
type Cleanup = "not-needed" | "removed" | "retained";

export class AcpProbeContextError extends Error {
  readonly code = "ACP_PROBE_CONTEXT_FAILED";
  readonly reason: Reason;
  readonly cleanup: Cleanup;
  readonly allocationName: string | null;
  constructor(reason: Reason, cleanup: Cleanup, allocationName: string | null) {
    super("ACP probe context allocation failed");
    this.name = "AcpProbeContextError";
    this.reason = reason; this.cleanup = cleanup; this.allocationName = allocationName;
  }
  toJSON(): object {
    return { code: this.code, reason: this.reason, cleanup: this.cleanup, allocationName: this.allocationName };
  }
}
function fail(reason: Reason): never { throw new AcpProbeContextError(reason, "not-needed", null); }
function parentInput(input: unknown): string {
  if (!input || typeof input !== "object" || types.isProxy(input)) fail("invalid-input");
  const proto = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Object.prototype) fail("invalid-input");
  const keys = Reflect.ownKeys(input), property = Object.getOwnPropertyDescriptor(input, "parent");
  if (keys.length !== 1 || keys[0] !== "parent" || !property || !("value" in property)) fail("invalid-input");
  const value: unknown = property.value;
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > 3072 ||
      !value.startsWith("/") || value === "/" || /[\p{Cc}:]/u.test(value)) fail("invalid-input");
  for (const part of value.slice(1).split("/")) {
    if (!part || part === "." || part === ".." || Buffer.byteLength(part) > 255) fail("invalid-input");
  }
  return value;
}
function validateSignal(signal: unknown): asserts signal is AbortSignal | undefined {
  if (signal === undefined) return;
  if (!signal || typeof signal !== "object" || types.isProxy(signal) ||
      !trustedSignals.has(signal as AbortSignal) || Object.getPrototypeOf(signal) !== SIGNAL_PROTOTYPE) fail("invalid-input");
  const descriptors = Object.getOwnPropertyDescriptors(signal);
  // Never invoke user getters (including symbol-slot getters) during brand checks.
  for (const key of Reflect.ownKeys(descriptors)) {
    if (!("value" in descriptors[key as keyof typeof descriptors])) fail("invalid-input");
  }
  for (const key of Reflect.ownKeys(signalSlots)) {
    if (!Object.hasOwn(descriptors, key)) fail("invalid-input");
  }
  if (compositeSlot === undefined || descriptors[compositeSlot as keyof typeof descriptors].value !== false)
    fail("invalid-input");
  try { if (typeof aborted.call(signal) !== "boolean") fail("invalid-input"); }
  catch { fail("invalid-input"); }
}
function check(signal?: AbortSignal): void {
  // Recheck descriptors after awaits too; later mutation cannot introduce getters.
  validateSignal(signal);
  if (signal && aborted.call(signal)) fail("cancelled");
}
function same(a: DirectoryIdentity, b: DirectoryIdentity): boolean { return a.dev === b.dev && a.ino === b.ino; }
function identity(s: BigIntStats): DirectoryIdentity { return Object.freeze({ dev: s.dev, ino: s.ino }); }
function privateDir(s: BigIntStats, uid: bigint): void {
  if (!s.isDirectory() || s.uid !== uid || (s.mode & 0o7777n) !== 0o700n) fail("unsafe-directory");
}
function safeAncestor(s: BigIntStats, uid: bigint): void {
  if (!s.isDirectory() || (s.uid !== 0n && s.uid !== uid) ||
      ((s.mode & 0o022n) !== 0n && !(s.uid === 0n && (s.mode & 0o1000n) !== 0n))) fail("unsafe-directory");
}
function fdPath(handle: FileHandle, name?: string): string {
  return `/proc/self/fd/${handle.fd}${name === undefined ? "" : `/${name}`}`;
}
type Owned = { label: "ancestor" | "root" | ProbeDirectory; handle: FileHandle; id: DirectoryIdentity; name: string };

/** Creates fresh private scratch data. No successful-context cleanup API exists.
 * The optional fault hook is trusted fixture code only; it receives no paths.
 * Signals must come from createAcpProbeAbortController(). Node's symbol-based
 * native brand alone cannot reject a forged copy of native signal slots.
 */
export async function allocateAcpProbeContext(input: { parent: string }, signal?: AbortSignal,
  fixture?: { fault(point: ProbeContextFaultPoint): void | Promise<void> }): Promise<AcpProbeContext> {
  let parent: string;
  try { parent = parentInput(input); validateSignal(signal); check(signal); }
  catch (error) { throw new AcpProbeContextError(error instanceof AcpProbeContextError ? error.reason : "invalid-input", "not-needed", null); }
  const handles: Owned[] = [], ancestry: Owned[] = [], leaves: Owned[] = [];
  let root: Owned | undefined, allocationName: string | null = null;
  let created = false, closing = false, closeFailed = false;
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : undefined;
  const fault = async (point: ProbeContextFaultPoint) => { await fixture?.fault(point); };
  const pathNames = async (path: string, limit: number): Promise<string[]> => {
    const dir = await opendir(path), out: string[] = [];
    try {
      for (;;) {
        const entry = await dir.read();
        if (!entry) return out.sort();
        if (out.length === limit) fail("unexpected-content");
        out.push(entry.name);
      }
    } finally {
      try { await dir.close(); } catch { closeFailed = true; fail("filesystem-error"); }
    }
  };
  const names = (handle: FileHandle, limit: number) => pathNames(fdPath(handle), limit);
  const held = async (path: string, label: Owned["label"], name: string, expected?: DirectoryIdentity): Promise<Owned> => {
    const handle = await open(path, DIR_FLAGS);
    // Track before stat: even a stat failure must attempt this descriptor's close.
    const entry: Owned = { label, name, handle, id: { dev: -1n, ino: -1n } }; handles.push(entry);
    const s = await handle.stat({ bigint: true }); entry.id = identity(s);
    if (expected && !same(expected, entry.id)) fail("identity-changed");
    if (label !== "ancestor") privateDir(s, uid!);
    return entry;
  };
  const verifyAncestry = async () => {
    for (let i = 0; i < ancestry.length; i++) {
      const a = ancestry[i], s = await a.handle.stat({ bigint: true });
      if (i === ancestry.length - 1) privateDir(s, uid!); else safeAncestor(s, uid!);
      const named = await lstat(i === 0 ? "/" : fdPath(ancestry[i - 1].handle, a.name), { bigint: true });
      if (!same(named, a.id)) fail("identity-changed");
    }
    if (!same(await lstat(parent, { bigint: true }), ancestry.at(-1)!.id)) fail("identity-changed");
  };
  const verifyRoot = async () => {
    await verifyAncestry();
    const s = await lstat(fdPath(ancestry.at(-1)!.handle, allocationName!), { bigint: true });
    if (!same(s, root!.id)) fail("identity-changed"); privateDir(s, uid!);
    if (!same(await lstat(`${parent}/${allocationName}`, { bigint: true }), root!.id)) fail("identity-changed");
  };
  const verifyLeaves = async () => {
    await verifyRoot();
    const entries = await names(root!.handle, LEAVES.length), expected = leaves.map(l => l.name).sort();
    if (entries.length !== expected.length || entries.some((name, i) => name !== expected[i])) fail("unexpected-content");
    for (const leaf of leaves) {
      const s = await lstat(fdPath(root!.handle, leaf.name), { bigint: true });
      if (!same(s, leaf.id)) fail("identity-changed"); privateDir(s, uid!);
      privateDir(await leaf.handle.stat({ bigint: true }), uid!);
      if ((await names(leaf.handle, 0)).length) fail("unexpected-content");
    }
  };
  const unusedName = async (handle: FileHandle, name: string) => {
    try { await lstat(fdPath(handle, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    fail("identity-changed");
  };
  const captureRollback = async (): Promise<Cleanup> => {
    if (!created) return "not-needed";
    if (!root || leaves.length !== handles.filter(h => h.label !== "ancestor" && h.label !== "root").length || closeFailed)
      return "retained";
    try {
      await fault("rollback-entry"); await verifyLeaves();
      const capture = `probe-capture-${randomUUID()}`;
      await unusedName(ancestry.at(-1)!.handle, capture);
      await fault("before-root-capture");
      await rename(fdPath(ancestry.at(-1)!.handle, allocationName!), fdPath(ancestry.at(-1)!.handle, capture));
      allocationName = capture;
      await fault("after-root-capture"); await verifyLeaves();
      for (const leaf of leaves) {
        const captureLeaf = `capture-${randomUUID()}`;
        await unusedName(root.handle, captureLeaf); await fault(`before-leaf-capture:${leaf.label as ProbeDirectory}`);
        await rename(fdPath(root.handle, leaf.name), fdPath(root.handle, captureLeaf));
        leaf.name = captureLeaf;
        await fault(`after-leaf-capture:${leaf.label as ProbeDirectory}`); await verifyLeaves();
      }
      await fault("rollback-before-remove"); await verifyLeaves();
      // Deletion waits until every owned descriptor has closed successfully.
      return "removed";
    } catch { return "retained"; }
  };
  const removeCaptured = async (): Promise<Cleanup> => {
    // The original walk and captures were held through verification. After close,
    // recheck the fixed known names by absolute path; never discover/adopt children.
    const verify = async () => {
      let path = "";
      for (let i = 0; i < ancestry.length; i++) {
        path = i === 0 ? "/" : `${path === "/" ? "" : path}/${ancestry[i].name}`;
        const s = await lstat(path, { bigint: true });
        if (!same(s, ancestry[i].id)) fail("identity-changed");
        if (i === ancestry.length - 1) privateDir(s, uid!); else safeAncestor(s, uid!);
      }
      const capturedRoot = `${parent}/${allocationName}`;
      const s = await lstat(capturedRoot, { bigint: true });
      if (!same(s, root!.id)) fail("identity-changed"); privateDir(s, uid!);
      const entries = await pathNames(capturedRoot, LEAVES.length), expected = leaves.map(l => l.name).sort();
      if (entries.length !== expected.length || entries.some((name, i) => name !== expected[i])) fail("unexpected-content");
      for (const leaf of leaves) {
        const path = `${capturedRoot}/${leaf.name}`, s = await lstat(path, { bigint: true });
        if (!same(s, leaf.id)) fail("identity-changed"); privateDir(s, uid!);
        await pathNames(path, 0);
      }
    };
    try {
      while (leaves.length) {
        await verify(); await rmdir(`${parent}/${allocationName}/${leaves[0].name}`); leaves.shift();
      }
      await verify(); await rmdir(`${parent}/${allocationName}`);
      return "removed";
    } catch { return "retained"; }
  };
  const closeAll = async () => {
    for (const entry of handles.toReversed()) {
      try { await fault(`before-close:${entry.label}`); } catch { closeFailed = true; }
      try { await entry.handle.close(); } catch { closeFailed = true; }
      try { await fault(`after-close:${entry.label}`); } catch { closeFailed = true; }
    }
  };
  try {
    if (uid === undefined || process.platform !== "linux") fail("unsafe-directory");
    ancestry.push(await held("/", "ancestor", "")); safeAncestor(await ancestry[0].handle.stat({ bigint: true }), uid);
    for (const part of parent.slice(1).split("/")) {
      check(signal);
      const a = await held(fdPath(ancestry.at(-1)!.handle, part), "ancestor", part);
      ancestry.push(a); safeAncestor(await a.handle.stat({ bigint: true }), uid);
    }
    privateDir(await ancestry.at(-1)!.handle.stat({ bigint: true }), uid);
    await verifyAncestry(); check(signal); await fault("before-root-created"); check(signal);
    for (let attempt = 0; attempt < 4; attempt++) {
      check(signal);
      allocationName = `probe-${randomUUID()}`;
      try { await mkdir(fdPath(ancestry.at(-1)!.handle, allocationName), { mode: 0o700 }); created = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (!created) { allocationName = null; fail("filesystem-error"); }
    const rootPath = fdPath(ancestry.at(-1)!.handle, allocationName!);
    const rootStat = await lstat(rootPath, { bigint: true }); privateDir(rootStat, uid);
    root = await held(rootPath, "root", allocationName!, identity(rootStat));
    await fault("after-root-created"); check(signal);
    for (const name of LEAVES) {
      const path = fdPath(root.handle, name);
      await mkdir(path, { mode: 0o700 });
      const s = await lstat(path, { bigint: true }); privateDir(s, uid);
      leaves.push(await held(path, name, name, identity(s)));
      await fault(`after-leaf-created:${name}`); check(signal);
    }
    await fault("before-verify"); check(signal); await verifyLeaves();
    if (new Set([root, ...leaves].map(l => `${l.id.dev}:${l.id.ino}`)).size !== 10) fail("identity-changed");
    await fault("after-verify"); check(signal); await verifyLeaves();
    const absoluteRoot = `${parent}/${allocationName}`;
    const directories = Object.freeze(Object.fromEntries(LEAVES.map(name => [name, `${absoluteRoot}/${name}`]))) as AcpProbeContext["directories"];
    const identities = Object.freeze(Object.fromEntries([root, ...leaves].map(l => [l.label, l.id]))) as AcpProbeContext["identities"];
    const env = Object.freeze({ HOME: directories.home, XDG_CONFIG_HOME: directories.config,
      XDG_CACHE_HOME: directories.cache, XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state,
      XDG_RUNTIME_DIR: directories.runtime, XDG_CONFIG_DIRS: directories.empty, XDG_DATA_DIRS: directories.empty,
      TMPDIR: directories.tmp, TMP: directories.tmp, TEMP: directories.tmp, PATH: directories.empty, LANG: "C", LC_ALL: "C" });
    const context: AcpProbeContext = Object.freeze({ root: absoluteRoot, directories, identities, env,
      filesystem: Object.freeze({ cwd: directories.cwd, read: Object.freeze([directories.empty]),
        write: Object.freeze(LEAVES.slice(0, -1).map(name => directories[name])), exec: Object.freeze([]) as readonly [] }) });
    closing = true; await closeAll();
    if (closeFailed) fail("filesystem-error"); check(signal);
    return context;
  } catch (error) {
    const reason = error instanceof AcpProbeContextError ? error.reason : "filesystem-error";
    let cleanup: Cleanup = closing || closeFailed ? (created ? "retained" : "not-needed") : await captureRollback();
    if (!closing) await closeAll();
    if (closeFailed && created) cleanup = "retained";
    else if (cleanup === "removed") cleanup = await removeCaptured();
    throw new AcpProbeContextError(reason, cleanup, allocationName);
  }
}
