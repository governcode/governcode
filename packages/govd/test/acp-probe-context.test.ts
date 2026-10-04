import { test, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { allocateAcpProbeContext, createAcpProbeAbortController, AcpProbeContextError, type ProbeContextFaultPoint } from "../src/acp-probe-context.ts";

const leaves = ["cwd", "home", "config", "cache", "data", "state", "runtime", "tmp", "empty"] as const;
const supported = process.platform === "linux" && typeof process.getuid === "function";
const expectedEnv = (root: string) => ({ HOME: `${root}/home`, XDG_CONFIG_HOME: `${root}/config`,
  XDG_CACHE_HOME: `${root}/cache`, XDG_DATA_HOME: `${root}/data`, XDG_STATE_HOME: `${root}/state`,
  XDG_RUNTIME_DIR: `${root}/runtime`, XDG_CONFIG_DIRS: `${root}/empty`, XDG_DATA_DIRS: `${root}/empty`,
  TMPDIR: `${root}/tmp`, TMP: `${root}/tmp`, TEMP: `${root}/tmp`, PATH: `${root}/empty`, LANG: "C", LC_ALL: "C" });

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "probe-context-fixture-")), parent = join(base, "scratch");
  await mkdir(parent, { mode: 0o700 });
  t.after(async () => {
    // Only this finite invented fixture tree, after its worker/allocation settles.
    // Fixed depth and entry ceilings; no recursive removal or sibling sweep.
    let current = [base]; const dirs: string[] = [];
    for (let depth = 0; depth < 6 && current.length; depth++) {
      const next: string[] = [];
      for (const path of current) {
        await chmod(path, 0o700); dirs.push(path);
        const entries = await readdir(path); assert.ok(entries.length <= 64);
        for (const entry of entries) {
          const child = join(path, entry), s = await lstat(child);
          if (s.isDirectory()) next.push(child); else await unlink(child);
        }
      }
      current = next;
    }
    assert.equal(current.length, 0);
    for (const path of dirs.toReversed()) await rmdir(path);
  });
  return { base, parent };
}
async function onlyRoot(parent: string) {
  const entries = await readdir(parent); assert.equal(entries.length, 1); return join(parent, entries[0]);
}
async function rejected(promise: Promise<unknown>, reason?: string, cleanup?: string): Promise<AcpProbeContextError> {
  let caught: unknown;
  await assert.rejects(promise, error => { caught = error; return error instanceof AcpProbeContextError; });
  const error = caught as AcpProbeContextError;
  assert.equal(error.code, "ACP_PROBE_CONTEXT_FAILED"); assert.equal(error.message, "ACP probe context allocation failed");
  assert.equal("cause" in error, false);
  if (reason) assert.equal(error.reason, reason);
  if (cleanup) assert.equal(error.cleanup, cleanup);
  assert.ok(error.allocationName === null || /^probe-(?:capture-)?[a-f0-9-]{36}$/u.test(error.allocationName));
  return error;
}
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve };
}
async function worker(parent: string, mask: number) {
  const path = fileURLToPath(new URL("./fixtures/acp-probe-context-worker.ts", import.meta.url));
  const child = spawn(process.execPath, [path, parent, String(mask)], { env: {
    HOME: "/invented-fixture-home", PATH: "/invented-fixture-path", USER: "invented-fixture-user",
    XDG_CONFIG_HOME: "/invented-fixture-config", XDG_CONFIG_DIRS: "/invented-fixture-search",
    XDG_DATA_DIRS: "/invented-fixture-search", TMPDIR: "/invented-fixture-temp",
    HTTP_PROXY: "http://192.0.2.1:9", HTTPS_PROXY: "http://192.0.2.2:9", ALL_PROXY: "http://192.0.2.3:9",
    NO_PROXY: "example.com", SSH_AUTH_SOCK: "/invented-fixture-socket", SSH_AGENT_PID: "123",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/invented-fixture-bus", "ANTHROPIC_API_KEY": "invented-fixture-token",
    "OPENAI_API_KEY": "invented-fixture-token", "AWS_SECRET_ACCESS_KEY": "invented-fixture-token",
    CODEX_HOME: "/invented-fixture-config", LANG: "invented-fixture-locale", LC_ALL: "invented-fixture-locale",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[] = [], err: Buffer[] = [];
  // This trusted finite worker launches no descendants. The parent bounds wall
  // time and output, kills it on failure, and waits for native stdio closure.
  let bytes = 0, failure: Error | undefined;
  const stop = (message: string) => {
    failure ??= new Error(message);
    child.kill("SIGKILL");
  };
  const collect = (destination: Buffer[], b: Buffer) => {
    bytes += b.length;
    if (bytes > 16_384) stop("fixture worker output exceeded limit");
    else destination.push(b);
  };
  child.stdout.on("data", b => collect(out, b)); child.stderr.on("data", b => collect(err, b));
  const watchdog = setTimeout(() => stop("fixture worker watchdog expired"), 5_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", () => { failure ??= new Error("fixture worker failed to start"); });
      child.on("close", code => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new Error("fixture worker failed"));
      });
    });
  } finally { clearTimeout(watchdog); }
  assert.equal(Buffer.concat(err).toString(), "");
  return JSON.parse(Buffer.concat(out).toString());
}

test("invalid input shapes and paths reject without getters, proxy traps, or mutations", { skip: !supported }, async t => {
  const { parent } = await fixture(t); let calls = 0;
  const trap = () => { calls++; throw new Error("invented fixture detail"); };
  const proxy = new Proxy({ parent }, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable({ parent }, {}); revoked.revoke();
  const accessor = Object.defineProperty({}, "parent", { get: trap });
  for (const input of [null, undefined, [], true, 1, parent, {}, { parent, extra: 0 }, { parent, [Symbol()]: 1 },
    accessor, proxy, revoked.proxy, new Date(), Object.create({ parent }),
    Object.create(proxy, { parent: { value: parent } }), Object.create(Object.create(proxy), { parent: { value: parent } }),
    ...["/", "relative", "//scratch", "/scratch/", "/scratch//leaf", "/scratch/./leaf", "/scratch/../leaf",
      "/scratch:leaf", "/scratch\nleaf", "/scratch\u0085leaf", "/scratch\ud800", "/" + "a".repeat(256),
      "/" + "é".repeat(128), "/" + Array(16).fill("a".repeat(200)).join("/")].map(parent => ({ parent }))]) {
    await rejected(allocateAcpProbeContext(input as { parent: string }, undefined, { fault: trap }), "invalid-input", "not-needed");
    assert.deepEqual(await readdir(parent), []);
  }
  assert.equal(calls, 0);
});

test("signal validation rejects spoofs, unregistered native signals, proxies and accessor slots without execution", { skip: !supported }, async t => {
  const { parent } = await fixture(t); let calls = 0;
  const trap = () => { calls++; assert.fail("signal override executed"); };
  const genuine = createAcpProbeAbortController().signal;
  const revoked = Proxy.revocable(genuine, {}); revoked.revoke();
  const slotAccessor = Object.create(AbortSignal.prototype, Object.getOwnPropertyDescriptors(genuine));
  for (const symbol of Object.getOwnPropertySymbols(genuine)) Object.defineProperty(slotAccessor, symbol, { get: trap });
  for (const signal of [null, new AbortController().signal, {}, { aborted: false }, Object.create(AbortSignal.prototype),
    new Proxy(genuine, { get: trap, getPrototypeOf: trap }), revoked.proxy, slotAccessor, AbortSignal.any([genuine])]) {
    await rejected(allocateAcpProbeContext({ parent }, signal as AbortSignal), "invalid-input", "not-needed");
    assert.deepEqual(await readdir(parent), []);
  }
  const controller = createAcpProbeAbortController(); controller.abort({ get detail() { return trap(); } });
  Object.defineProperty(controller.signal, "reason", { get: trap });
  await rejected(allocateAcpProbeContext({ parent }, controller.signal), "invalid-input", "not-needed");
  assert.equal(calls, 0);
});

test("snapshot, null-prototype input, valid Unicode and intrinsic signal access", { skip: !supported }, async t => {
  const { parent } = await fixture(t), controller = createAcpProbeAbortController();
  // Data overrides must not replace the intrinsic aborted accessor.
  Object.defineProperty(controller.signal, "aborted", { value: true });
  Object.defineProperty(controller.signal, "reason", { value: "invented reason" });
  const input = Object.assign(Object.create(null), { parent });
  const pending = allocateAcpProbeContext(input, controller.signal); input.parent = "/invented-unavailable";
  const context = await pending; assert.equal(context.root.startsWith(`${parent}/`), true);
  const unicode = join(parent, "é😀"); await mkdir(unicode, { mode: 0o700 });
  assert.ok((await allocateAcpProbeContext({ parent: unicode })).root.startsWith(`${unicode}/`));
});

test("private signal registration rejects copies of native slots without mutation", { skip: !supported }, async t => {
  const { parent } = await fixture(t), native = createAcpProbeAbortController().signal;
  const forged = Object.create(AbortSignal.prototype, Object.getOwnPropertyDescriptors(native));
  await rejected(allocateAcpProbeContext({ parent }, forged), "invalid-input", "not-needed");
  assert.deepEqual(await readdir(parent), []);
});

test("signal-slot getters introduced after an await are rejected without executing them", { skip: !supported }, async t => {
  const { parent } = await fixture(t), controller = createAcpProbeAbortController(); let calls = 0;
  await rejected(allocateAcpProbeContext({ parent }, controller.signal, { fault(point) {
    if (point !== "after-root-created") return;
    for (const symbol of Object.getOwnPropertySymbols(controller.signal)) {
      Object.defineProperty(controller.signal, symbol, { get() { calls++; throw new Error("invented slot getter"); } });
    }
  } }), "invalid-input", "removed");
  assert.equal(calls, 0); assert.deepEqual(await readdir(parent), []);
});

test("fresh frozen context has exact private directories, environment and narrow policy inputs", { skip: !supported }, async t => {
  const { parent } = await fixture(t), context = await allocateAcpProbeContext({ parent });
  assert.deepEqual(Object.keys(context).sort(), ["directories", "env", "filesystem", "identities", "root"]);
  assert.deepEqual((await readdir(context.root)).sort(), [...leaves].sort());
  const paths = [context.root, ...Object.values(context.directories)], identities: string[] = [];
  assert.equal(new Set(paths).size, 10);
  for (const [key, id] of Object.entries(context.identities)) {
    const path = key === "root" ? context.root : context.directories[key as typeof leaves[number]];
    const s = await lstat(path, { bigint: true });
    assert.equal(s.isDirectory(), true); assert.equal(s.uid, BigInt(process.getuid!())); assert.equal(s.mode & 0o7777n, 0o700n);
    assert.deepEqual(id, { dev: s.dev, ino: s.ino }); identities.push(`${s.dev}:${s.ino}`); assert.ok(Object.isFrozen(id));
    if (key !== "root") assert.deepEqual(await readdir(path), []);
  }
  assert.equal(new Set(identities).size, 10); assert.deepEqual(context.env, expectedEnv(context.root));
  assert.deepEqual(context.filesystem, { cwd: context.directories.cwd, read: [context.directories.empty],
    write: leaves.slice(0, -1).map(name => context.directories[name]), exec: [] });
  for (const value of [context, context.directories, context.identities, context.env, context.filesystem,
    context.filesystem.read, context.filesystem.write, context.filesystem.exec]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { (context.env as Record<string, string>).PATH = parent; }, TypeError);
});

test("invented environment is never read; isolated worker preserves ordinary umasks", { skip: !supported }, async t => {
  for (const mask of [0o000, 0o077]) {
    const { parent } = await fixture(t), result = await worker(parent, mask);
    assert.equal(result.error, undefined); assert.equal(result.reads, 0); assert.equal(result.mask, mask);
    assert.deepEqual(result.env, expectedEnv(result.root)); assert.deepEqual(result.modes, Array(10).fill(0o700));
  }
});

test("unusual worker umask refuses and retains without repairing permissions", { skip: !supported }, async t => {
  const { parent } = await fixture(t), result = await worker(parent, 0o700);
  assert.equal(result.mask, 0o700); assert.equal(result.reads, 0);
  assert.equal(result.error.reason, "unsafe-directory"); assert.equal(result.error.cleanup, "retained");
  assert.equal((await lstat(await onlyRoot(parent))).mode & 0o7777, 0);
});

test("unsafe parents, symlinks, writable ancestry and missing ancestors are never repaired", { skip: !supported }, async t => {
  const { base, parent } = await fixture(t);
  for (const mode of [0o755, 0o770, 0o777, 0o1700]) {
    await chmod(parent, mode); await rejected(allocateAcpProbeContext({ parent }), "unsafe-directory", "not-needed");
    assert.equal((await lstat(parent)).mode & 0o7777, mode); assert.deepEqual(await readdir(parent), []);
  }
  await chmod(parent, 0o700);
  const link = join(base, "link"); await symlink(parent, link);
  await rejected(allocateAcpProbeContext({ parent: link }), "filesystem-error", "not-needed");
  await rejected(allocateAcpProbeContext({ parent: join(link, "missing") }), "filesystem-error", "not-needed");
  await rejected(allocateAcpProbeContext({ parent: join(parent, "missing") }), "filesystem-error", "not-needed");
  await assert.rejects(lstat(join(parent, "missing")), { code: "ENOENT" });
  await chmod(base, 0o777); await rejected(allocateAcpProbeContext({ parent }), "unsafe-directory", "not-needed");
  assert.equal((await lstat(base)).mode & 0o7777, 0o777);
});

test("faults at every creation and verification boundary remove only owned empty setup", { skip: !supported }, async t => {
  const points: ProbeContextFaultPoint[] = ["before-root-created", "after-root-created",
    ...leaves.map(name => `after-leaf-created:${name}` as const), "before-verify", "after-verify"];
  for (const target of points) {
    const { parent } = await fixture(t);
    const error = await rejected(allocateAcpProbeContext({ parent }, undefined, { fault(point) {
      if (point === target) throw new Error("invented fault /invented-private-path");
    } }), "filesystem-error", target === "before-root-created" ? "not-needed" : "removed");
    assert.deepEqual(await readdir(parent), []);
    assert.equal(JSON.stringify(error).includes("invented"), false);
    assert.equal(error.stack!.includes("invented-private-path"), false);
  }
});

test("allocation-name collisions are bounded to four and never adopt existing contents", { skip: !supported }, async t => {
  const { parent } = await fixture(t), originalMkdir = fs.mkdir; const collisions: string[] = [];
  const patched = mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    await originalMkdir(...args); collisions.push(basename(String(args[0])));
    await writeFile(`${String(args[0])}/collision`, "invented existing contents");
    throw Object.assign(new Error("invented collision"), { code: "EEXIST" });
  });
  syncBuiltinESMExports();
  try {
    await rejected(allocateAcpProbeContext({ parent }), "filesystem-error", "not-needed");
    assert.equal(collisions.length, 4); assert.equal(new Set(collisions).size, 4);
    for (const name of collisions) assert.equal(await readFile(join(parent, name, "collision"), "utf8"), "invented existing contents");
  } finally { patched.mock.restore(); syncBuiltinESMExports(); }
});

test("rollback hook failures retain bounded setup", { skip: !supported }, async t => {
  for (const target of ["rollback-entry", "before-root-capture", "after-root-capture", "rollback-before-remove",
    ...leaves.flatMap(name => [`before-leaf-capture:${name}`, `after-leaf-capture:${name}`])] as ProbeContextFaultPoint[]) {
    const { parent } = await fixture(t);
    await rejected(allocateAcpProbeContext({ parent }, undefined, { fault(point) {
      if (point === "before-verify" || point === target) throw new Error("invented fault");
    } }), "filesystem-error", "retained");
    assert.equal((await readdir(parent)).length, 1);
  }
});

test("unknown file, symlink, nested directory or excessive entries retain setup without traversal", { skip: !supported }, async t => {
  for (const location of ["root", "home"]) for (const kind of ["file", "symlink", "nested", "excessive"]) {
    const { parent } = await fixture(t); let target = "";
    await rejected(allocateAcpProbeContext({ parent }, undefined, { async fault(point) {
      if (point !== "before-verify") return;
      const root = await onlyRoot(parent); target = location === "root" ? root : join(root, "home");
      if (kind === "file") await writeFile(join(target, "unknown"), "invented contents");
      if (kind === "symlink") await symlink("/invented-missing-target", join(target, "unknown"));
      if (kind === "nested") { await mkdir(join(target, "unknown")); await writeFile(join(target, "unknown", "nested"), "invented contents"); }
      if (kind === "excessive") for (let i = 0; i < 32; i++) await writeFile(join(target, `unknown-${i}`), "invented contents");
    } }), "unexpected-content", "retained");
    assert.ok((await readdir(target)).some(name => name.startsWith("unknown")));
  }
});

test("parent replacement rejects and preserves both detached allocation and replacement contents", { skip: !supported }, async t => {
  const { base, parent } = await fixture(t), detached = join(base, "original");
  await rejected(allocateAcpProbeContext({ parent }, undefined, { async fault(point) {
    if (point !== "before-verify") return;
    await rename(parent, detached); await mkdir(parent, { mode: 0o700 }); await writeFile(join(parent, "replacement"), "invented contents");
  } }), "identity-changed", "retained");
  assert.equal(await readFile(join(parent, "replacement"), "utf8"), "invented contents");
  assert.equal((await readdir(await onlyRoot(detached))).length, 9);
});

test("root replacement at verification or capture preserves detected replacements", { skip: !supported }, async t => {
  for (const target of ["before-verify", "before-root-capture", "after-root-capture"] as const) {
    const { base, parent } = await fixture(t), detached = join(base, "original");
    const error = await rejected(allocateAcpProbeContext({ parent }, undefined, { async fault(point) {
      if (target !== "before-verify" && point === "before-verify") throw new Error("invented setup fault");
      if (point !== target) return;
      const root = await onlyRoot(parent); await rename(root, detached); await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, "replacement"), "invented contents");
    } }), target === "before-verify" ? "identity-changed" : "filesystem-error", "retained");
    assert.equal(await readFile(join(await onlyRoot(parent), "replacement"), "utf8"), "invented contents");
    assert.equal((await readdir(detached)).length, 9);
    assert.equal(basename(await onlyRoot(parent)), error.allocationName);
  }
});

test("leaf replacements before verification, during capture and after capture remain present", { skip: !supported }, async t => {
  for (const target of ["before-verify", "before-leaf-capture:home", "after-leaf-capture:home"] as const) {
    const { base, parent } = await fixture(t), detached = join(base, "original-leaf");
    let cwdCapture: string | undefined;
    await rejected(allocateAcpProbeContext({ parent }, undefined, { async fault(point) {
      if (target !== "before-verify" && point === "before-verify") throw new Error("invented setup fault");
      if (point === "after-leaf-capture:cwd") {
        cwdCapture = (await readdir(await onlyRoot(parent))).find(name => name.startsWith("capture-"));
      }
      if (point !== target) return;
      const root = await onlyRoot(parent);
      let selected = join(root, "home");
      if (target === "after-leaf-capture:home") {
        const captures = (await readdir(root)).filter(name => name.startsWith("capture-"));
        // The cwd capture was observed earlier by the hook below.
        selected = join(root, captures.find(name => name !== cwdCapture)!);
      }
      await rename(selected, detached); await mkdir(selected, { mode: 0o700 }); await writeFile(join(selected, "replacement"), "invented contents");
    } }), target === "before-verify" ? "identity-changed" : "filesystem-error", "retained");
    const root = await onlyRoot(parent), entries = await readdir(root);
    const markers = await Promise.all(entries.map(async name => {
      try { return await readFile(join(root, name, "replacement"), "utf8"); } catch { return null; }
    }));
    assert.ok(markers.includes("invented contents")); assert.deepEqual(await readdir(detached), []);
  }
});

test("unknown contents injected after capture or closure stop fixed-depth rollback", { skip: !supported }, async t => {
  for (const target of ["after-root-capture", "after-leaf-capture:home", "after-close:root"] as const) {
    const { parent } = await fixture(t); let marker = "";
    await rejected(allocateAcpProbeContext({ parent }, undefined, { async fault(point) {
      if (point === "before-verify") throw new Error("invented setup fault");
      if (point !== target) return;
      marker = join(await onlyRoot(parent), "unknown"); await writeFile(marker, "invented contents");
    } }), "filesystem-error", "retained");
    assert.equal(await readFile(marker, "utf8"), "invented contents");
  }
});

test("an in-flight mkdir is awaited before cancellation rollback", { skip: !supported }, async t => {
  const { parent } = await fixture(t), controller = createAcpProbeAbortController(), entered = deferred(), release = deferred();
  const originalMkdir = fs.mkdir; let settled = false;
  const patched = mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await originalMkdir(...args);
    if (String(args[0]).endsWith("/home")) { entered.resolve(); await release.promise; }
    return result;
  });
  syncBuiltinESMExports();
  try {
    const pending = allocateAcpProbeContext({ parent }, controller.signal);
    const result = rejected(pending, "cancelled", "removed").then(() => { settled = true; });
    await entered.promise; controller.abort(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.deepEqual((await readdir(await onlyRoot(parent))).sort(), ["cwd", "home"]);
    release.resolve(); await result; assert.deepEqual(await readdir(parent), []);
  } finally { release.resolve(); patched.mock.restore(); syncBuiltinESMExports(); }
});

test("cancellation before setup or after an awaited mutation gives bounded cleanup", { skip: !supported }, async t => {
  const { parent } = await fixture(t), pre = createAcpProbeAbortController(); pre.abort("invented private reason");
  const e = await rejected(allocateAcpProbeContext({ parent }, pre.signal), "cancelled", "not-needed");
  assert.equal(JSON.stringify(e).includes("invented"), false); assert.deepEqual(await readdir(parent), []);
  const controller = createAcpProbeAbortController(), entered = deferred(), release = deferred(); let settled = false;
  const pending = allocateAcpProbeContext({ parent }, controller.signal, { async fault(point) {
    if (point === "after-leaf-created:home") { entered.resolve(); await release.promise; }
  } });
  const result = rejected(pending, "cancelled", "removed").then(() => { settled = true; });
  await entered.promise; controller.abort({ get message(): never { return assert.fail("abort reason read"); } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  assert.ok((await readdir(parent)).length); release.resolve(); await result; assert.deepEqual(await readdir(parent), []);
});

test("abort during final descriptor closure retains and attempts every close", { skip: !supported }, async t => {
  const { parent } = await fixture(t), controller = createAcpProbeAbortController(); const before: string[] = [], after: string[] = [];
  await rejected(allocateAcpProbeContext({ parent }, controller.signal, { fault(point) {
    if (point.startsWith("before-close:")) { before.push(point); controller.abort("invented cancellation"); }
    if (point.startsWith("after-close:")) after.push(point);
  } }), "cancelled", "retained");
  assert.equal(before.length, after.length); assert.ok(before.length >= 12);
  assert.equal((await readdir(await onlyRoot(parent))).length, 9);
});

test("actual descriptor close failures attempt all handles and retain on success or setup failure", { skip: !supported }, async t => {
  for (const setupFailure of [false, true]) for (const failedLabel of ["ancestor", "root", "home"]) {
    const { parent } = await fixture(t), originalOpen = fs.open;
    const opened: { close: () => Promise<void>; attempts: number; label: string }[] = [];
    const patched = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args), close = handle.close.bind(handle), path = String(args[0]);
      const label = path === "/" ? "ancestor" : basename(path).startsWith("probe-") ? "root" : basename(path);
      const record = { close, attempts: 0, label };
      opened.push(record);
      handle.close = async () => { record.attempts++; if (record.label === failedLabel) throw new Error("invented close failure"); await close(); };
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await rejected(allocateAcpProbeContext({ parent }, undefined, { fault(point) {
        if (setupFailure && point === "before-verify") throw new Error("invented setup failure");
      } }), "filesystem-error", "retained");
      assert.ok(opened.length >= 12); assert.ok(opened.every(record => record.attempts === 1));
      assert.equal((await readdir(await onlyRoot(parent))).length, 9);
    } finally { patched.mock.restore(); syncBuiltinESMExports(); for (const record of opened) await record.close(); }
  }
});

test("directory iterator close failure retains and emits no raw filesystem error", { skip: !supported }, async t => {
  const { parent } = await fixture(t), originalOpendir = fs.opendir; const closes: (() => Promise<void>)[] = [];
  let injected = false;
  const patched = mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
    const dir = await originalOpendir(...args), close = dir.close.bind(dir); closes.push(close);
    dir.close = async () => {
      if (!injected) { injected = true; throw new Error("invented error /invented-private-path"); }
      await close();
    };
    return dir;
  });
  syncBuiltinESMExports();
  try {
    const error = await rejected(allocateAcpProbeContext({ parent }), "filesystem-error", "retained");
    assert.ok(injected); assert.equal(JSON.stringify(error).includes("invented"), false);
    assert.equal((await readdir(await onlyRoot(parent))).length, 9);
  } finally {
    patched.mock.restore(); syncBuiltinESMExports();
    for (const close of closes) try { await close(); } catch { /* already closed fixture iterator */ }
  }
});

test("a created leaf with no captured identity is retained without pathname adoption", { skip: !supported }, async t => {
  const { parent } = await fixture(t), originalLstat = fs.lstat;
  const patched = mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]).endsWith("/home")) throw new Error("invented stat failure");
    return originalLstat(...args);
  });
  syncBuiltinESMExports();
  try {
    await rejected(allocateAcpProbeContext({ parent }), "filesystem-error", "retained");
    assert.deepEqual((await readdir(await onlyRoot(parent))).sort(), ["cwd", "home"]);
  } finally { patched.mock.restore(); syncBuiltinESMExports(); }
});

test("parallel success, fault and cancellation touch only invocation-local allocations", { skip: !supported }, async t => {
  const { parent } = await fixture(t), controller = createAcpProbeAbortController();
  const fault = allocateAcpProbeContext({ parent }, undefined, { fault(point) {
    if (point === "after-leaf-created:cwd") throw new Error("invented failure");
  } });
  const cancelled = allocateAcpProbeContext({ parent }, controller.signal, { fault(point) {
    if (point === "after-leaf-created:home") controller.abort();
  } });
  const [a, b] = await Promise.all([allocateAcpProbeContext({ parent }), allocateAcpProbeContext({ parent }),
    rejected(fault, "filesystem-error", "removed"), rejected(cancelled, "cancelled", "removed")]);
  assert.notEqual(a.root, b.root); assert.deepEqual((await readdir(parent)).sort(), [basename(a.root), basename(b.root)].sort());
});

test("successful allocations survive later abort and invented transport closure without a cleanup API", { skip: !supported }, async t => {
  const { parent } = await fixture(t), controller = createAcpProbeAbortController();
  const context = await allocateAcpProbeContext({ parent }, controller.signal), transport = new EventEmitter();
  controller.abort(); transport.emit("closed"); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readdir(context.root)).length, 9);
  assert.ok(Object.values(context).every(value => typeof value !== "function"));
});

test("allocator dependencies and filesystem surface remain passive and credential independent", async () => {
  const source = await readFile(new URL("../src/acp-probe-context.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/gu)].map(match => match[1]);
  assert.deepEqual(imports, ["node:crypto", "node:fs", "node:fs/promises", "node:util"]);
  assert.doesNotMatch(source, /process\.env|homedir\(|tmpdir\(|chmod\(|copyFile\(|link\(|readFile\(|removeTree\(|recursive\s*:/u);
  assert.doesNotMatch(source, /child_process|fetch\(|spawn\(|execFile\(/u);
});
