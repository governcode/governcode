// Explicit live check: node packages/govd/test/acp-artifact-binding.native.ts [--release]
// Normal tests never select this file. Each worker has an independent 13s watchdog.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prepareNativeBoundFixture, startNativeBoundFixture, type BoundFixtureScenario, type FixtureInvocation, type FixtureAssets } from "./fixtures/acp-probe-termination.ts";
import { discoverAcp } from "../src/acp-probe.ts";
import { allocateAcpProbeContext } from "../src/acp-probe-context.ts";

const self = fileURLToPath(import.meta.url), repo = fileURLToPath(new URL("../../../", import.meta.url));
const sourceCases = ["source-symlink", "source-hardlink", "source-mode", "source-small", "source-large", "source-script", "source-et-dyn",
  "source-machine", "source-interpreter", "source-dynamic", "source-table-overflow", "source-table-truncated", "source-entry"] as const;
const preparationCases = ["before-copy-b", "copy-torn", "copy-truncate", "copy-grow", "copy-b", "image-mismatch", "prep-expired", "prep-entry-expired", "prep-validation-expired", "prep-stop",
  "fault-open", "fault-read", "fault-write", "fault-seal", "fault-readback", "fault-compare", "fault-mode", "fault-close", "writable-map", ...sourceCases] as const;
const setupCases = ["fault-dup", "fault-inventory", "fault-close-range", "fault-exec", "limits-failure", "map-failure", "restrict-failure", "exec-failure", "guard-registration-deadline", "prep-gate-expired", "prep-release-expired", "prep-exec-expired"] as const;
const nativeCases = ["normal", "sealed-replace", "sealed-mutate", "seal-aliases", "sandbox", ...preparationCases, ...setupCases,
  "high-exit", "signal", "direct", "double", "detach", "signal-tree", "kill-init", "forge", "acp", "acp-forbidden", "acp-hang", "stdout-flood", "stderr-flood",
  "stop", "cancel", "consumer-failure", "death-pre-admission", "death-post-admission", "death-mid-record", "death-full-record", "death-closed-record",
  "proof-truncate", "proof-stale", "proof-extra", "proof-missing", "guard-eof", "guard-registration-failure", "clone-failure", "pidfd-failure",
  "wait-failure", "withhold", "prep-gate-expired-unproven", "control-error", "context-proven", "context-unproven", "concurrent", "worker-watchdog"] as const;
type Case = typeof nativeCases[number];
type Report = { name: Case; status: "proven" | "refused" | "unproven" | "unavailable"; executed: boolean | null;
  imageA: boolean | null; imageB: boolean | null; retained: boolean; contextRetained?: boolean; skip?: string; discovery?: string; reason?: string };
const finiteFiles = ["executed", "image-a-executed", "image-b-executed", "descendant-ready", "late-activity", "forge-rejected", "sandbox-ok", "fd-closed",
  "acp-ready", "forbidden-rejected", "pre-restriction-fds", "hung-request", "flood-ready", "sealed-aliases-ok"];
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
const includes = (list: readonly string[], name: string) => list.includes(name);

async function alterOwnedSource(name: Case, source: string): Promise<void> {
  if (!includes(sourceCases, name)) return;
  if (name === "source-symlink") { await rename(source, `${source}.original`); await symlink(`${source}.original`, source); return; }
  if (name === "source-hardlink") { await link(source, `${source}.alias`); return; }
  if (name === "source-mode") { await chmod(source, 0o600); return; }
  if (name === "source-small") { await truncate(source, 63); return; }
  if (name === "source-large") { await truncate(source, 4 * 1024 * 1024 + 1); return; }
  if (name === "source-script") { await writeFile(source, `#!/bin/sh\n${"#".repeat(128)}\n`); return; }
  const bytes = await readFile(source), table = Number(bytes.readBigUInt64LE(32));
  if (name === "source-et-dyn") bytes.writeUInt16LE(3, 16);
  if (name === "source-machine") bytes.writeUInt16LE(183, 18);
  if (name === "source-interpreter") bytes.writeUInt32LE(3, table);
  if (name === "source-dynamic") bytes.writeUInt32LE(2, table);
  if (name === "source-table-overflow") bytes.writeBigUInt64LE(0xfffffffffffffff8n, 32);
  if (name === "source-table-truncated") bytes.writeBigUInt64LE(BigInt(bytes.length - 8), 32);
  if (name === "source-entry") bytes.writeBigUInt64LE(0n, 24);
  await writeFile(source, bytes);
}

async function prepare(root: string, driver: string, suffix = "") {
  const cwd = join(root, `work${suffix}`); await mkdir(cwd, { mode: 0o700 });
  const assets: FixtureAssets = { driver, target: join(root, `source${suffix}`), policy: join(root, `policy${suffix}.json`), cwd,
    env: { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } };
  return { assets, prepared: await prepareNativeBoundFixture(assets) };
}

async function worker(): Promise<void> {
  const name = process.argv[3] as Case, root = process.argv[4], driver = process.argv[5];
  assert.ok(nativeCases.includes(name));
  const { assets, prepared } = await prepare(root, driver);
  if (prepared.status === "unavailable") {
    if (name === "worker-watchdog") { for (;;) { /* exercise independent watchdog even when data mode is unavailable */ } }
    assert.equal(name, "normal", `unexpected preparation unavailability: ${prepared.reason}; retained ${root}`);
    assert.equal(await exists(join(assets.cwd, "executed")), false);
    process.stdout.write(JSON.stringify({ name, status: "unavailable", skip: prepared.reason, executed: false, imageA: false, imageB: false, retained: true } satisfies Report)); return;
  }
  assert.ok(Object.isFrozen(prepared.fixture));
  assert.equal(prepared.observation.inspection.status, "observed");
  assert.match(prepared.observation.sha256, /^[a-f0-9]{64}$/);
  const original = await readFile(assets.target);
  assert.equal(prepared.observation.bytes, original.length);
  assert.equal(prepared.observation.sha256, createHash("sha256").update(original).digest("hex"));
  const policy = JSON.parse(await readFile(assets.policy, "utf8"));
  assert.deepEqual(policy.exec, []); assert.deepEqual(policy.tcp_connect, []); assert.deepEqual(policy.write, [assets.cwd]);
  let contextRoot: string | undefined;
  if (name.startsWith("context-")) {
    const parent = join(root, "contexts"); await mkdir(parent, { mode: 0o700 });
    contextRoot = (await allocateAcpProbeContext({ parent })).root;
  }
  await alterOwnedSource(name, assets.target);
  const scenario: BoundFixtureScenario = includes(sourceCases, name) || ["context-proven", "concurrent"].includes(name) ? "normal" :
    name === "context-unproven" ? "proof-missing" : ["stop", "cancel", "worker-watchdog"].includes(name) ? "hold" :
    name === "consumer-failure" ? "acp" : name as BoundFixtureScenario;
  const invocation = startNativeBoundFixture(prepared.fixture, scenario);
  // Synchronous consumption precedes spawning, so even concurrent reuse is refused.
  assert.throws(() => startNativeBoundFixture(prepared.fixture, "normal"));
  assert.throws(() => startNativeBoundFixture(Object.freeze({ ...prepared.fixture }), "normal"));
  let concurrent: FixtureInvocation | undefined, secondCwd: string | undefined;
  if (name === "concurrent") {
    const second = await prepare(root, driver, "-second"); assert.equal(second.prepared.status, "prepared");
    if (second.prepared.status !== "prepared") throw new Error("second preparation unavailable");
    secondCwd = second.assets.cwd; concurrent = startNativeBoundFixture(second.prepared.fixture, "normal");
  }
  if (name === "worker-watchdog") { for (;;) { /* exact owned worker only; native guard remains independent */ } }
  if (name === "stop") { const timer = setTimeout(() => { invocation.stop(); invocation.stop(); invocation.rpc.close(1); }, 100); timer.unref(); }
  let discovery: string | undefined;
  if (["acp", "acp-forbidden", "acp-hang", "stdout-flood", "stderr-flood", "cancel", "consumer-failure"].includes(name)) {
    const controller = new AbortController(), timer = name === "cancel" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      const rpc = name === "consumer-failure" ? { ...invocation.rpc, request: async (method: string, params: unknown, timeout?: number) => {
        await invocation.rpc.request(method, params, timeout); throw new Error("invented consumer failure"); } } : invocation.rpc;
      discovery = (await discoverAcp(rpc, { cwd: assets.cwd, freshCwd: true, createSession: true, timeoutMs: 500, cleanupTimeoutMs: 5000, signal: controller.signal })).status;
      assert.equal(discovery, ({ acp: "reported", "acp-forbidden": "forbidden-request", "acp-hang": "timeout", cancel: "cancelled",
        "stdout-flood": "output-budget-exceeded", "stderr-flood": "output-budget-exceeded", "consumer-failure": "error" } as Record<string, string>)[name]);
    } finally { clearTimeout(timer); }
  }
  const termination = await invocation.termination; await invocation.rpc.closed;
  if (concurrent) {
    const other = await concurrent.termination; await concurrent.rpc.closed;
    assert.equal(other.status, termination.status);
    if (other.status === "proven" && termination.status === "proven") {
      assert.notEqual(other.evidence, termination.evidence);
      assert.equal(await exists(join(secondCwd!, "image-a-executed")), true);
      assert.equal(await exists(join(secondCwd!, "image-b-executed")), false);
    }
  }
  const executed = await exists(join(assets.cwd, "executed")), imageA = await exists(join(assets.cwd, "image-a-executed")), imageB = await exists(join(assets.cwd, "image-b-executed"));
  assert.equal(imageB, false, "substitute B must never execute");
  if (name === "normal" && termination.status === "refused" && termination.reason === "unsupported") {
    assert.equal(executed, false); assert.equal(imageA, false);
    process.stdout.write(JSON.stringify({ name, status: "refused", skip: "actual executable-memfd/namespace/pidfd facilities unavailable", executed, imageA, imageB, retained: true } satisfies Report)); return;
  }
  const unproven = name.startsWith("death-") || name.startsWith("proof-") || ["wait-failure", "withhold", "prep-gate-expired-unproven", "context-unproven", "guard-eof", "guard-registration-failure"].includes(name);
  const refused = includes(preparationCases, name) || ["clone-failure", "pidfd-failure"].includes(name);
  assert.equal(termination.status, unproven ? "unproven" : refused ? "refused" : "proven", `${name}: ${JSON.stringify(termination)}; ${(await invocation.rpc.exited).slice(-1000)}`);
  if (refused || includes(setupCases, name) || ["death-pre-admission", "guard-eof", "guard-registration-failure"].includes(name)) {
    assert.equal(executed, false); assert.equal(imageA, false);
  }
  if (name.startsWith("prep-") && name !== "prep-stop" && name !== "prep-expired") {
    assert.equal(executed, false); assert.equal(imageA, false);
    assert.equal(await exists(join(assets.cwd, "descendant-ready")), false);
    assert.equal(await exists(join(assets.cwd, "late-activity")), false);
    assert.equal(await exists(join(assets.cwd, "pre-restriction-fds")), name === "prep-exec-expired");
  }
  if (termination.status === "proven") {
    assert.ok(Object.isFrozen(termination.evidence));
    if (includes(setupCases, name)) assert.equal(termination.outcome.kind, "setup-failed");
    if (["normal", "sealed-replace", "sealed-mutate", "seal-aliases", "sandbox", "context-proven", "concurrent"].includes(name)) {
      assert.deepEqual(termination.outcome, { kind: "exited", code: name === "sandbox" ? 0 : 7 }); assert.equal(executed, true); assert.equal(imageA, true);
    }
    if (name === "high-exit") assert.deepEqual(termination.outcome, { kind: "exited", code: 200 });
    if (["signal", "signal-tree"].includes(name)) assert.deepEqual(termination.outcome, { kind: "signalled", signal: 15 });
    if (executed) {
      assert.equal(await exists(join(assets.cwd, "fd-closed")), true);
      assert.equal(await readFile(join(assets.cwd, "pre-restriction-fds"), "utf8"), "owned sealed image fd3; controls closed\n");
    }
  } else assert.equal("evidence" in termination, false);
  if (["direct", "double", "detach", "signal-tree", "kill-init"].includes(name)) {
    assert.equal(await exists(join(assets.cwd, "descendant-ready")), true); assert.equal(await exists(join(assets.cwd, "late-activity")), false);
  }
  if (name === "forge") assert.equal(await exists(join(assets.cwd, "forge-rejected")), true);
  if (name === "sandbox") assert.equal(await exists(join(assets.cwd, "sandbox-ok")), true);
  if (name === "seal-aliases") assert.equal(await exists(join(assets.cwd, "sealed-aliases-ok")), true);
  if (contextRoot) assert.ok((await lstat(contextRoot)).isDirectory());
  process.stdout.write(JSON.stringify({ name, status: termination.status, executed, imageA, imageB, retained: termination.status !== "proven",
    ...(discovery ? { discovery } : {}), contextRetained: contextRoot !== undefined } satisfies Report));
}

async function runWorker(name: Case, root: string, driver: string): Promise<{ watchdog: boolean; report: Report }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, "--worker", name, root, driver], { cwd: root,
      env: { HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PATH: "/usr/bin", LANG: "C", LC_ALL: "C" }, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    let watchdog = false, out = "", err = "", bytes = 0;
    const timer = setTimeout(() => {
      watchdog = true; child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      resolve({ watchdog: true, report: { name, status: "unproven", reason: "worker-watchdog", executed: null, imageA: null, imageB: null, retained: true } });
    }, 13_000);
    for (const [stream, stdout] of [[child.stdout, true], [child.stderr, false]] as const) stream.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes <= 65_536) { if (stdout) out += b.toString(); else err += b.toString(); }
    });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer); if (watchdog) return;
      if (code !== 0 || bytes > 65_536) { reject(new Error(`${name}: worker exit ${code}: ${err.slice(-2000)}; retained ${root}`)); return; }
      try {
        const report: Report = JSON.parse(out);
        assert.equal(report.name, name); assert.ok(["proven", "refused", "unproven", "unavailable"].includes(report.status));
        resolve({ watchdog: false, report });
      } catch { reject(new Error(`${name}: invalid bounded worker report; retained ${root}`)); }
    });
  });
}

async function cleanProvenCase(root: string, name: Case): Promise<boolean> {
  // Worker has already closed and reported its strict owned proof. Finite names
  // only; any unexpected file leaves the entire case retained. Contexts stay.
  const suffixes = name === "concurrent" ? ["", "-second"] : [""];
  for (const suffix of suffixes) if ((await readdir(join(root, `work${suffix}`))).some(file => !finiteFiles.includes(file))) return false;
  const allowed = ["home", "tmp", ...suffixes.flatMap(s => [`work${s}`, `source${s}`, `policy${s}.json`]), ...(name.startsWith("context-") ? ["contexts"] : [])];
  if ((await readdir(root)).some(file => !allowed.includes(file))) return false;
  for (const suffix of suffixes) {
    const cwd = join(root, `work${suffix}`);
    for (const file of finiteFiles) if (await exists(join(cwd, file))) await unlink(join(cwd, file));
    await rmdir(cwd); await unlink(join(root, `source${suffix}`)); await unlink(join(root, `policy${suffix}.json`));
  }
  await rmdir(join(root, "home")); await rmdir(join(root, "tmp"));
  if (!name.startsWith("context-")) await rmdir(root);
  return true;
}

async function main(): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") { console.log("SKIP bound native: current Linux x86_64 only; zero targets"); return; }
  const debug = join(repo, "target/debug/probe-lifetime-driver"), release = join(repo, "target/release/probe-lifetime-driver");
  const driver = process.argv[2] === "--release" ? release : await exists(debug) ? debug : release;
  if (!(await exists(driver))) { console.log("SKIP bound native: missing explicit feature driver; zero targets"); return; }
  const base = await mkdtemp("/tmp/gs-acp-binding-");
  let passed = 0, skipped = 0, watchdogPassed = 0, unavailable = false;
  console.log(JSON.stringify({ retainedBase: base }));
  for (const name of nativeCases) {
    if (unavailable && name !== "worker-watchdog") { skipped++; continue; }
    const root = join(base, name); await mkdir(root, { mode: 0o700 }); await mkdir(join(root, "home"), { mode: 0o700 }); await mkdir(join(root, "tmp"), { mode: 0o700 });
    const result = await runWorker(name, root, driver);
    if (result.watchdog) assert.equal(name, "worker-watchdog", `unexpected watchdog; retained ${root}`);
    if (result.report.skip) { skipped++; unavailable = true; } else if (result.watchdog) watchdogPassed++; else passed++;
    let cleaned = false;
    if (!result.watchdog && result.report.status === "proven") cleaned = await cleanProvenCase(root, name);
    console.log(JSON.stringify({ ...result.report, retained: !cleaned || result.report.contextRetained, retainedPath: root }));
  }
  console.log(JSON.stringify({ nativePassed: passed, nativeSkipped: skipped, watchdogPassed, retained: base,
    acceptance: unavailable ? "unavailable; no native positive acceptance" : "current Linux x86_64 only" }));
}
if (process.argv[2] === "--worker") await worker(); else {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--release"));
  await main();
}
