// Explicit offline trusted fixtures only: node packages/govd/test/acp-store-binding.native.ts [--release]
// Every installation, context, failed attempt, log and watchdog tree is retained.
import assert from "node:assert/strict";
import cp, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { AcpInstaller } from "../src/acp-install.ts";
import { installFingerprint } from "../src/acp-install-plan.ts";
import { ACP_REGISTRY_URL, decodeAcpRegistry, planAcpInstall } from "../src/acp-registry.ts";
import { startNativeStoredContextBoundFixture, type StoredFixtureScenario,
  type ContextFixtureDiagnostics } from "./fixtures/acp-probe-termination.ts";

const self = fileURLToPath(import.meta.url), repo = fileURLToPath(new URL("../../../", import.meta.url));
const scenarios: readonly StoredFixtureScenario[] = ["normal", "sandbox", "hold", "proof-stale", "proof-extra", "proof-truncate",
  "proof-missing", "ctx-open", "ctx-final-inventory", "fault-read", "fault-seal", "fault-compare", "fault-close", "prep-stop", "prep-exec-expired"];
const cases = [...scenarios, "stored-b", "same-length-different", "synthetic-node-data-b", "installer-stop", "reentrant-stop", "concurrent", "worker-watchdog"] as const;
type Case = typeof cases[number];
type Entry = { path: string; kind: string; dev: string; ino: string; bytes: string };
type Report = { name: Case; passed: boolean; classification: string; root: string; retained: true;
  result?: unknown; diagnostics?: ContextFixtureDiagnostics; reason?: string; artifact?: string; originalSha256?: string;
  finalSha256?: string; sourceUsed?: boolean; driver?: { exit: boolean; close: boolean; code: number | null; signal: string | null };
  worker?: { exit: boolean; close: boolean; code: number | null; signal: string | null }; inventory?: Entry[] };
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function exists(path: string) { try { await fs.lstat(path); return true; } catch { return false; } }
async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const walk = async (path: string) => {
    const stat = await fs.lstat(path, { bigint: true });
    entries.push({ path, kind: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
      dev: stat.dev.toString(), ino: stat.ino.toString(), bytes: stat.size.toString() });
    if (stat.isDirectory()) for (const name of (await fs.readdir(path)).sort()) await walk(join(path, name));
  };
  await walk(root); return entries;
}
async function accepted(d: ContextFixtureDiagnostics) {
  for (const name of ["executed", "image-a-executed", "fd-closed", "context-ok"])
    assert.ok((await fs.lstat(join(d.directories.cwd, name))).isFile(), name);
  for (const leaf of ["cwd", "home", "config", "cache", "data", "state", "runtime", "tmp"] as const)
    assert.equal(await fs.readFile(join(d.directories[leaf], "context-write"), "utf8"), "fixture\n");
  assert.deepEqual(await fs.readdir(d.directories.empty), []);
  for (const path of [join(d.root, "denied-write"), join(d.directories.empty, "denied-write"),
    join(d.directories.cwd, "image-b-executed"), join(d.directories.cwd, "pre-restriction-fds")]) assert.equal(await exists(path), false);
}
async function install(root: string, bytes: Buffer) {
  // The downloader is fake and gated. No registry fetch, network or real artifact.
  const catalog = { source: ACP_REGISTRY_URL, sha256: "a".repeat(64), fetchedAt: "2026-01-01T00:00:00.000Z" };
  const registry = decodeAcpRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: "trusted-fixture", name: "Trusted Fixture",
    version: "1.0.0", description: "Offline fixed fixture", license_url: "https://example.com/license", distribution: { binary: {
      "linux-x86_64": { archive: "https://example.com/fixture", sha256: hash(bytes), cmd: "fixture" } } } }] }));
  const planned = planAcpInstall(registry.agents[0], "linux-x86_64", "binary"); assert.ok(planned.supported);
  const fingerprint = installFingerprint(catalog, planned.plan);
  let downloads = 0, gates = 0;
  const installer = new AcpInstaller(join(root, "store"), { download: async (_plan, file) => {
    downloads++; await file.writeFile(bytes); return { bytes: bytes.length, sha256: hash(bytes) };
  } });
  await installer.install({ operation: "I-1", catalog, plan: planned.plan, fingerprint }, {
    signal: new AbortController().signal, gate: async () => { gates++; return { id: "G-1", allowed: true }; } });
  assert.equal(downloads, 1); assert.equal(gates, 1);
  return { installer, id: fingerprint, artifact: join(root, "store", fingerprint, "artifact") };
}
async function worker() {
  const name = process.argv[3] as Case, root = process.argv[4], driver = process.argv[5]; assert.ok(cases.includes(name));
  const report: Report = { name, root, retained: true, passed: false, classification: "failed" };
  let nativeChild: ChildProcess | undefined, close: Promise<void> | undefined;
  let installer: AcpInstaller | undefined;
  const originalSpawn = cp.spawn, originalExecFile = cp.execFile;
  let stopping: Promise<void> | undefined;
  try {
    const cwd = join(root, "bootstrap"), parent = join(root, "contexts");
    const env = { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin" as const, LANG: "C" as const, LC_ALL: "C" as const };
    const emit = promisify(originalExecFile);
    let imageA: Buffer, imageB: Buffer;
    try {
      const a = await emit(driver, ["fixture-image-a"], { cwd, env, encoding: "buffer", timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
      const b = await emit(driver, ["fixture-image-b"], { cwd, env, encoding: "buffer", timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(a.stderr.length + b.stderr.length, 0); imageA = a.stdout; imageB = b.stdout;
      assert.ok(imageA.length >= 64 && imageA.length <= 4 * 1024 * 1024 && !imageA.equals(imageB));
    } catch (error) {
      report.classification = "image-data-unavailable"; report.reason = String(error).slice(0, 1000);
      report.passed = name === "normal";
      if (name === "worker-watchdog") { process.stdout.write(`${JSON.stringify(report)}\n`); for (;;) { /* independent unavailable-data watchdog */ } }
      return;
    }
    let bytes = ["stored-b", "synthetic-node-data-b"].includes(name) ? imageB : imageA;
    if (name === "same-length-different") { bytes = Buffer.from(imageA); bytes[bytes.length - 1] ^= 1; }
    const f = await install(root, bytes); installer = f.installer;
    report.artifact = f.artifact; report.originalSha256 = hash(await fs.readFile(f.artifact));
    const passive = await installer.inspectVerifiedRuntime(f.id);
    assert.deepEqual(Object.keys(passive), ["receipt", "inspection"]); assert.ok(Object.isFrozen(passive));
    assert.equal(passive.inspection.status, "observed");
    if (name === "synthetic-node-data-b") {
      // Synthetic Node trusted-data fault only; actual driver/native embedded A is unchanged.
      const wrapper = ((...args: any[]) => Reflect.apply(originalExecFile, cp, args)) as typeof cp.execFile;
      Object.defineProperty(wrapper, promisify.custom, { value: (...args: any[]) => {
        const task = Reflect.apply(emit, cp, args);
        const mapped = task.then((result: any) => args[1]?.[0] === "fixture-image-a" ? { ...result, stdout: Buffer.from(imageB) } :
          args[1]?.[0] === "fixture-image-b" ? { ...result, stdout: Buffer.from(imageA) } : result);
        // Preserve the real execFile child/channel ownership during this synthetic byte fault.
        Object.defineProperty(mapped, "child", { value: task.child });
        return mapped;
      } });
      cp.execFile = wrapper; syncBuiltinESMExports();
    }
    cp.spawn = ((...args: Parameters<typeof cp.spawn>) => {
      const child = originalSpawn(...args);
      if (args[0] === driver && (args[1] as string[])[0] === "context-bound-transport-v1") {
        nativeChild = child;
        report.sourceUsed = (args[1] as string[])[1] === f.artifact;
        const observed: NonNullable<Report["driver"]> = { exit: false, close: false, code: null, signal: null };
        report.driver = observed;
        close = new Promise<void>(resolve => child.once("close", (code, signal) => {
          observed.close = true; observed.code = code; observed.signal = signal; resolve();
        }));
        child.once("exit", (code, signal) => { observed.exit = true; observed.code = code; observed.signal = signal; });
        if (name === "reentrant-stop") stopping = installer!.stop();
      }
      return child;
    }) as typeof cp.spawn;
    syncBuiltinESMExports();
    let scenario: StoredFixtureScenario = scenarios.includes(name as StoredFixtureScenario) ? name as StoredFixtureScenario : "normal";
    if (["installer-stop", "reentrant-stop", "concurrent", "worker-watchdog"].includes(name)) scenario = "hold";
    const start = await startNativeStoredContextBoundFixture(installer, f.id, { driver, cwd, env }, { parent }, scenario);
    report.result = start;
    if (start.diagnostics) report.diagnostics = start.diagnostics;
    if (name === "worker-watchdog") { process.stdout.write(`${JSON.stringify(report)}\n`); for (;;) { /* exact independent worker watchdog */ } }
    if (start.status !== "started") {
      assert.ok(["stored-b", "same-length-different"].includes(name), JSON.stringify(start));
      assert.equal(start.status, "refused"); assert.equal(start.reason, "image-mismatch");
      assert.equal(nativeChild, undefined); report.classification = "node-content-refusal";
    } else {
      assert.equal(report.sourceUsed, true); assert.equal("rpc" in start.invocation, false);
      assert.deepEqual(Object.keys(start.observation), ["receipt", "inspection"]);
      if (name === "concurrent") {
        const overlap = await startNativeStoredContextBoundFixture(installer, f.id, { driver, cwd, env }, { parent }, "normal");
        assert.deepEqual(overlap, { status: "refused", reason: "admission" });
      }
      if (scenario === "hold" && name !== "reentrant-stop") {
        const until = performance.now() + 1500;
        while (!(await exists(join(start.diagnostics.directories.cwd, "context-ok"))) && performance.now() < until) await delay(5);
        assert.equal((await installer.inspectVerifiedRuntime(f.id)).inspection.status, "observed", "passive reader during native run");
        if (name === "installer-stop") stopping = installer.stop(); else start.invocation.stop();
      }
      const termination = await start.invocation.termination;
      report.result = { status: start.status, observation: start.observation, termination };
      await stopping; await close;
      assert.equal(report.driver?.close, true, "actual native driver channel closure");
      if (termination.status === "refused" && termination.reason === "unsupported" && name === "normal") {
        assert.equal(report.driver?.code, 65); report.classification = "facility-unavailable";
      } else if (["proof-stale", "proof-extra", "proof-truncate", "proof-missing"].includes(name)) {
        assert.equal(termination.status, "unproven"); assert.equal("evidence" in termination, false); report.classification = "unproven-proof";
      } else if (name === "reentrant-stop") {
        if (termination.status === "refused") { assert.equal(termination.reason, "admission"); assert.equal(report.driver?.code, 66); }
        else { assert.equal(termination.status, "proven"); assert.deepEqual(termination.outcome, { kind: "stopped" }); }
        report.classification = "owned-reentrant-stop";
      } else if (["fault-read", "fault-seal", "fault-compare", "fault-close", "prep-stop", "synthetic-node-data-b"].includes(name)) {
        assert.equal(termination.status, "refused"); assert.equal(termination.reason, "admission");
        report.classification = name === "synthetic-node-data-b" ? "synthetic-node-fault-native-refusal" : "native-admission-refusal";
      } else if (["ctx-open", "ctx-final-inventory", "prep-exec-expired"].includes(name)) {
        assert.equal(termination.status, "proven"); assert.deepEqual(termination.outcome, { kind: "setup-failed" });
        report.classification = "setup-failed-proof";
      } else {
        assert.equal(termination.status, "proven");
        assert.deepEqual(termination.outcome, scenario === "normal" ? { kind: "exited", code: 7 } :
          scenario === "sandbox" ? { kind: "exited", code: 0 } : { kind: "stopped" });
        await accepted(start.diagnostics);
        report.classification = "stored-context-success";
      }
    }
    report.finalSha256 = hash(await fs.readFile(f.artifact)); assert.equal(report.finalSha256, report.originalSha256);
    assert.equal(await exists(join(cwd, "executed")), false);
    report.passed = true;
  } catch (error) { report.reason = String(error).slice(0, 2000); process.exitCode = 1; }
  finally {
    cp.spawn = originalSpawn; cp.execFile = originalExecFile; syncBuiltinESMExports();
    if (installer && !nativeChild) await installer.stop();
    try {
      if (report.artifact) { report.finalSha256 = hash(await fs.readFile(report.artifact)); assert.equal(report.finalSha256, report.originalSha256); }
      report.inventory = await inventory(root);
      assert.equal(report.inventory.some(e => /\/(image-b-executed|pre-restriction-fds|late-activity)$/.test(e.path)), false);
      if (report.diagnostics) assert.ok(report.inventory.some(e => e.path === report.diagnostics!.root && e.kind === "directory"));
    } catch (error) { report.passed = false; report.reason = String(error).slice(0, 2000); process.exitCode = 1; }
    await fs.writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
}
async function runWorker(name: Case, root: string, driver: string): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [self, "--worker", name, root, driver], { cwd: root, detached: false,
      env: { HOME: root, TMPDIR: root, PATH: "/usr/bin", LANG: "C", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    const observed = { exit: false, close: false, code: null as number | null, signal: null as string | null };
    let workerError: string | undefined;
    let out = "", bytes = 0, finished = false, watchdog = false, logs: Promise<unknown> = Promise.resolve();
    const timer = setTimeout(() => {
      watchdog = true; child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy();
      setTimeout(() => { if (!finished) finish(); }, 1000).unref();
    }, 13_000);
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(timer);
      void logs.then(async () => {
        let report: Report | undefined;
        for (const line of out.trim().split("\n")) try { const row = JSON.parse(line); if (row.name === name) report = row; } catch { /* bounded complete report only */ }
        report ??= { name, root, retained: true, passed: false, classification: "unproven", reason: "missing complete worker report" };
        if (watchdog) { report.classification = "watchdog-unproven"; report.passed = name === "worker-watchdog" && observed.close && !workerError;
          report.reason = observed.close ? "exact worker close observed; native proof/teardown unproven" : "exact worker close not observed in one second; ownership unproven"; }
        else if (observed.code !== 0 || bytes > 65_536 || workerError) { report.passed = false; if (workerError) report.reason = workerError; }
        report.worker = { ...observed }; report.inventory = await inventory(root);
        await fs.writeFile(join(root, "controller-report.json"), JSON.stringify(report, null, 2));
        child.unref(); resolve(report);
      }).catch(reject);
    };
    for (const [stream, file] of [[child.stdout, "worker-out.log"], [child.stderr, "worker-err.log"]] as const)
      stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 65_536) {
        if (file === "worker-out.log") out += chunk.toString(); const copy = Buffer.from(chunk);
        logs = logs.then(() => fs.appendFile(join(root, file), copy));
      } });
    child.on("error", error => { workerError = String(error).slice(0, 1000); });
    child.stdout.on("error", error => { workerError = String(error).slice(0, 1000); });
    child.stderr.on("error", error => { workerError = String(error).slice(0, 1000); });
    child.on("exit", (code, signal) => { observed.exit = true; observed.code = code; observed.signal = signal; });
    child.on("close", (code, signal) => { observed.close = true; observed.code = code; observed.signal = signal; finish(); });
  });
}
async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") { console.log("SKIP: Linux x86_64 only; zero fixture executions"); return; }
  const profile = process.argv.includes("--release") ? "release" : "debug", driver = join(repo, "target", profile, "probe-lifetime-driver");
  assert.ok(await exists(driver), "explicit offline fixture build required");
  const base = await fs.mkdtemp(join(tmpdir(), "acp-store-native-retained-")), manifest = join(base, "manifest.jsonl");
  await fs.writeFile(manifest, "", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ base, manifest, profile, cases: cases.length }));
  const sourcePaths = ["packages/govd/src/acp-install.ts", "packages/govd/test/fixtures/acp-probe-termination.ts", "packages/govd/test/acp-store-binding.native.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await fs.readFile(join(repo, path)))])));
  const reports: Report[] = []; let unavailable = false;
  for (const name of cases) {
    const root = join(base, name); await fs.mkdir(root, { mode: 0o700 });
    for (const dir of ["bootstrap", "contexts"]) await fs.mkdir(join(root, dir), { mode: 0o700 });
    await fs.writeFile(join(root, "contexts", "neighbor"), "fixture neighbor\n", { flag: "wx", mode: 0o600 });
    for (const file of ["report.json", "controller-report.json", "worker-out.log", "worker-err.log"])
      await fs.writeFile(join(root, file), "", { flag: "wx", mode: 0o600 });
    let report: Report;
    if (unavailable && name !== "worker-watchdog") report = { name, root, retained: true, passed: true, classification: "skipped-facility-unavailable" };
    else try { report = await runWorker(name, root, driver); } catch (error) {
      report = { name, root, retained: true, passed: false, classification: "controller-failure", reason: String(error).slice(0, 2000) };
    }
    if (name === "normal" && report.passed && ["facility-unavailable", "image-data-unavailable"].includes(report.classification)) unavailable = true;
    report.inventory = await inventory(root); reports.push(report);
    await fs.appendFile(manifest, `${JSON.stringify(report)}\n`);
    console.log(JSON.stringify({ name, passed: report.passed, classification: report.classification, reason: report.reason }));
  }
  const retainedIndex = join(base, "retention-index.json");
  await fs.writeFile(retainedIndex, JSON.stringify({ base, manifest, profile, cleanup: false, sourceHashes, reports, inventory: await inventory(base),
    limits: ["trusted Linux x86_64 fixture only", "historical completed capture", "no continuous inode/native receipt claim", "no provider eligibility"] }, null, 2));
  const afterHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await fs.readFile(join(repo, path)))])));
  assert.deepEqual(afterHashes, sourceHashes, "fixture source changed during the bounded native run; retained results need a fresh run");
  const failed = reports.filter(r => !r.passed).length;
  console.log(JSON.stringify({ profile, passed: reports.filter(r => r.passed && !r.classification.startsWith("skipped")).length,
    failed, skipped: reports.filter(r => r.classification.startsWith("skipped")).length, manifest, retainedIndex }));
  if (failed) process.exitCode = 1;
}
if (process.argv[2] === "--worker") await worker(); else await main();
