// Explicit only: node packages/govd/test/acp-context-binding.native.ts [--release]
// Retains every allocation and every finite fixture. No automatic namespace tests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, appendFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { prepareNativeBoundFixture, prepareNativeContextBoundFixture, startNativeContextBoundFixture,
  type ContextFixtureScenario, type ContextFixtureDiagnostics, type FixtureAssets,
  type FixtureTermination, type PreparedNativeContextBoundFixture } from "./fixtures/acp-probe-termination.ts";
import { discoverAcp } from "../src/acp-probe.ts";

const self = fileURLToPath(import.meta.url), repo = fileURLToPath(new URL("../../../", import.meta.url));
const leaves = ["cwd", "home", "config", "cache", "data", "state", "runtime", "tmp", "empty"] as const;
const mutations = ["root-replace", "leaf-replace", "ancestor-replace", "root-symlink", "leaf-symlink", "ancestor-symlink",
  "root-missing", "leaf-missing", "ancestor-missing", "root-mode", "leaf-mode", "ancestor-mode", "nonempty", "extra-root"] as const;
const captureRefusals = ["ctx-stat", "ctx-deadline-capture"] as const;
const contextSetup = ["ctx-after-landlock-content", "ctx-after-landlock-symlink", "ctx-open", "ctx-fchdir", "ctx-rules", "ctx-limits",
  "ctx-close", "ctx-initial-inventory", "ctx-final-inventory", "ctx-scanner-close", "ctx-deadline-acquire", "ctx-deadline-enumeration",
  "ctx-deadline-rules", "ctx-deadline-revalidation", "ctx-deadline-closure", "ctx-deadline-exec"] as const;
const imageRefusals = ["before-copy-b", "copy-torn", "copy-truncate", "copy-grow", "copy-b", "image-mismatch", "prep-expired",
  "prep-entry-expired", "prep-validation-expired", "prep-stop", "fault-open", "fault-read", "fault-write", "fault-seal", "fault-readback",
  "fault-compare", "fault-mode", "fault-close", "writable-map"] as const;
const imageSetup = ["fault-dup", "fault-inventory", "fault-close-range", "fault-exec", "limits-failure", "map-failure", "restrict-failure",
  "exec-failure", "guard-registration-deadline", "prep-gate-expired", "prep-release-expired", "prep-exec-expired"] as const;
const proofLoss = ["death-pre-admission", "death-post-admission", "death-mid-record", "death-full-record", "death-closed-record",
  "proof-stale", "proof-extra", "proof-truncate", "proof-missing", "stale-record", "extra-record", "truncated-record", "missing-record",
  "guard-eof", "guard-registration-failure", "wait-failure", "withhold", "prep-gate-expired-unproven"] as const;
const finite: readonly ContextFixtureScenario[] = ["normal", "sandbox", "sealed-replace", "sealed-mutate", "seal-aliases",
  ...(["before-capture", "before-acquire", "after-acquire"] as const).flatMap(stage => mutations.map(mutation =>
    `ctx-${stage}-${mutation}` as ContextFixtureScenario)), ...captureRefusals, ...contextSetup, ...imageRefusals, ...imageSetup,
  "high-exit", "signal", "direct", "double", "detach", "signal-tree", "kill-init", "forge", "acp", "acp-forbidden", "acp-hang",
  "stdout-flood", "stderr-flood", "clone-failure", "pidfd-failure", "control-error", ...proofLoss];
const specials = ["poisoned-ambient", "stop", "cancel", "consumer-failure", "concurrent", "worker-watchdog"] as const;
type Case = ContextFixtureScenario | typeof specials[number];
const cases: readonly Case[] = [...finite, ...specials];
type InventoryEntry = { path: string; dev: string; ino: string; kind: "directory" | "symlink" | "file" };
type ContextReport = { diagnostics: ContextFixtureDiagnostics; actualRoot?: string; retainedPaths?: string[] };
type Report = { phase: "prepared" | "result"; name: Case; status?: FixtureTermination["status"] | "unavailable" | "watchdog";
  classification?: "context-success" | "preparation-failed" | "refusal" | "unavailable" | "setup-failed" | "unproven" | "execution-failed" | "teardown-only";
  passed?: boolean; reason?: string; discovery?: string; contexts: ContextReport[]; bootstrap: string[];
  logs: string[]; inventory?: InventoryEntry[]; contextSuccesses?: number; allocationRetainedPaths?: string[];
  results?: Array<{ status: FixtureTermination["status"]; outcome?: object; reason?: string; driverExit: number | null }>;
  watchdogWorker?: { exitObserved: boolean; closeObserved: boolean; code: number | null; signal: string | null };
  retained: true };
const inList = (list: readonly string[], name: string) => list.includes(name);
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function inventory(root: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    assert.ok(depth <= 8 && entries.length < 256, "finite retained inventory bound exceeded");
    const s = await lstat(path, { bigint: true });
    entries.push({ path, dev: s.dev.toString(), ino: s.ino.toString(), kind: s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : "file" });
    if (s.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), depth + 1);
  };
  await visit(root, 0); return entries;
}
function retainedContexts(contexts: ContextReport[], entries: InventoryEntry[]): void {
  for (const report of contexts) {
    const paths: string[] = [];
    for (const [name, id] of Object.entries(report.diagnostics.identities)) {
      const actual = entries.find(e => e.kind === "directory" && e.dev === id.dev && e.ino === id.ino);
      assert.ok(actual, `original ${name} identity was not retained: ${report.diagnostics.root}`);
      paths.push(actual.path);
      if (name === "root") report.actualRoot = actual.path;
    }
    report.retainedPaths = paths;
  }
}
async function assertMutation(name: Case, diagnostics: ContextFixtureDiagnostics): Promise<void> {
  if (!name.startsWith("ctx-before-") && !name.startsWith("ctx-after-")) return;
  const selected = name.includes("ancestor-") ? dirname(diagnostics.root) : name.includes("leaf-") ? diagnostics.directories.cwd : diagnostics.root;
  if (/-replace$|-symlink$|-missing$/.test(name) && name !== "ctx-after-landlock-symlink") {
    const old = await lstat(`${selected}.moved`, { bigint: true }); assert.ok(old.isDirectory());
    if (name.endsWith("-replace")) {
      const replacement = await lstat(selected, { bigint: true });
      assert.ok(replacement.isDirectory()); assert.equal(replacement.mode & 0o7777n, 0o700n);
      assert.notEqual(`${replacement.dev}:${replacement.ino}`, `${old.dev}:${old.ino}`);
    } else if (name.endsWith("-symlink")) {
      assert.ok((await lstat(selected)).isSymbolicLink()); assert.equal(await readlink(selected), `${selected}.moved`);
    } else await assert.rejects(lstat(selected), { code: "ENOENT" });
  } else if (name.endsWith("-mode")) assert.equal((await lstat(selected)).mode & 0o7777, 0o750);
  else if (name.endsWith("-nonempty") || name === "ctx-after-landlock-content") assert.ok((await lstat(join(diagnostics.directories.cwd, "context-fault-entry"))).isFile());
  else if (name.endsWith("-extra-root")) assert.ok((await lstat(join(diagnostics.root, "context-fault-entry"))).isFile());
  else if (name === "ctx-after-landlock-symlink") {
    const path = join(diagnostics.directories.cwd, "context-fault-link");
    assert.ok((await lstat(path)).isSymbolicLink()); assert.equal(await readlink(path), "context-fault-entry");
  }
}
async function acceptedContext(d: ContextFixtureDiagnostics): Promise<void> {
  for (const file of ["executed", "image-a-executed", "fd-closed", "context-ok"])
    assert.ok((await lstat(join(d.directories.cwd, file))).isFile(), `missing ${file}`);
  assert.equal(await exists(join(d.directories.cwd, "image-b-executed")), false);
  assert.equal(await exists(join(d.directories.cwd, "pre-restriction-fds")), false);
  for (const leaf of leaves.slice(0, -1)) assert.equal(await readFile(join(d.directories[leaf], "context-write"), "utf8"), "fixture\n");
  assert.deepEqual(await readdir(d.directories.empty), []);
  assert.equal(await exists(join(d.root, "denied-write")), false);
  assert.equal(await exists(join(d.directories.empty, "denied-write")), false);
}
function expected(name: Case): "success" | "setup" | "refused" | "unproven" | "teardown" {
  // The outside verifier may stop init before A executes. This checks the
  // owned termination join, without claiming contextual execution acceptance.
  if (name === "control-error") return "teardown";
  if (name.startsWith("ctx-before-capture-") || inList(captureRefusals, name) || inList(imageRefusals, name) ||
    ["clone-failure", "pidfd-failure"].includes(name)) return "refused";
  if (name.startsWith("ctx-before-acquire-") || name.startsWith("ctx-after-acquire-") || inList(contextSetup, name) || inList(imageSetup, name)) return "setup";
  if (inList(proofLoss, name)) return "unproven";
  return "success";
}
function expectedOutcome(name: Case): object | undefined {
  if (["normal", "poisoned-ambient", "concurrent", "sealed-replace", "sealed-mutate", "seal-aliases"].includes(name)) return { kind: "exited", code: 7 };
  if (["sandbox", "direct", "double", "detach", "forge", "acp"].includes(name)) return { kind: "exited", code: 0 };
  if (name === "high-exit") return { kind: "exited", code: 200 };
  if (["signal", "signal-tree"].includes(name)) return { kind: "signalled", signal: 15 };
  if (["stop", "cancel", "acp-hang", "control-error"].includes(name)) return { kind: "stopped" };
  if (name === "kill-init") return { kind: "signalled", signal: 9 };
  // Flood/refusal/consumer-driven stopping may race the finite A return.
  return undefined;
}
async function prepare(root: string, driver: string, suffix: string) {
  const cwd = join(root, `work${suffix}`), parent = join(root, `contexts${suffix}`);
  const assets: FixtureAssets = { driver, target: join(root, `source${suffix}`), policy: join(root, `policy${suffix}.json`), cwd,
    env: { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } };
  const image = await prepareNativeBoundFixture(assets);
  return { assets, image, parent };
}
async function worker(): Promise<void> {
  const name = process.argv[3] as Case, root = process.argv[4], driver = process.argv[5];
  assert.ok(cases.includes(name));
  const suffixes = name === "concurrent" ? ["", "-second"] : [""];
  const report: Report = { phase: "prepared", name, contexts: [], bootstrap: suffixes.map(s => join(root, `work${s}`)),
    logs: ["worker-out.log", "worker-err.log", "driver-err.log", "report.json"].map(n => join(root, n)), retained: true };
  const fixtures: PreparedNativeContextBoundFixture[] = [], assets: FixtureAssets[] = [];
  let preparationFailure = false, platformUnavailable = false;
  try {
    // Complete ALL image materialization first, then ALL allocations, before
    // either concurrent launch. Never allocate beneath a captured ancestor.
    const images = [];
    for (const suffix of suffixes) images.push(await prepare(root, driver, suffix));
    for (const item of images) {
      assets.push(item.assets);
      if (item.image.status !== "prepared") {
        preparationFailure = true;
        platformUnavailable = item.image.reason === "platform";
        throw new Error(`image preparation failed: ${item.image.reason}`);
      }
      const p = await prepareNativeContextBoundFixture(item.image.fixture, { parent: item.parent });
      if (p.diagnostics) report.contexts.push({ diagnostics: p.diagnostics });
      if (p.status !== "prepared") {
        preparationFailure = true;
        if (p.retainedRoot) (report.allocationRetainedPaths ??= []).push(p.retainedRoot);
        throw new Error(`context preparation failed: ${p.reason}; retained ${p.retainedRoot ?? p.diagnostics?.root ?? item.parent}`);
      }
      fixtures.push(p.fixture);
      assert.throws(() => startNativeContextBoundFixture(Object.freeze({ ...p.fixture }), "normal"));
      assert.throws(() => startNativeContextBoundFixture(new Proxy(p.fixture, { get() { throw new Error("trap"); } }), "normal"));
      assert.throws(() => startNativeContextBoundFixture(p.fixture, "ctx-not-a-mode" as never));
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    const scenario: ContextFixtureScenario = ["poisoned-ambient", "concurrent"].includes(name) ? "normal" :
      ["stop", "cancel", "worker-watchdog"].includes(name) ? "hold" : name === "consumer-failure" ? "acp" : name as ContextFixtureScenario;
    const invocations = fixtures.map(f => startNativeContextBoundFixture(f, scenario));
    for (const f of fixtures) assert.throws(() => startNativeContextBoundFixture(f, "normal"));
    if (name === "worker-watchdog") { for (;;) { /* Independent worker watchdog; native guard remains independent. */ } }
    const invocation = invocations[0];
    let stopping: Promise<void> | undefined;
    if (name === "stop" || name === "withhold") stopping = (async () => {
      const until = performance.now() + 1000;
      while (!(await exists(join(report.contexts[0].diagnostics.directories.cwd, "context-ok"))) && performance.now() < until) await delay(5);
      invocation.stop(); invocation.stop(); invocation.rpc.close(1);
    })();
    if (["acp", "acp-forbidden", "acp-hang", "stdout-flood", "stderr-flood", "cancel", "consumer-failure"].includes(name)) {
      const controller = new AbortController(), timer = name === "cancel" ? setTimeout(() => controller.abort(), 100) : undefined;
      try {
        const rpc = name === "consumer-failure" ? { ...invocation.rpc, request: async (method: string, params: unknown, timeout?: number) => {
          await invocation.rpc.request(method, params, timeout); throw new Error("invented consumer failure"); } } : invocation.rpc;
        report.discovery = (await discoverAcp(rpc, { cwd: report.contexts[0].diagnostics.directories.cwd, freshCwd: true,
          createSession: true, timeoutMs: 500, cleanupTimeoutMs: 5000, signal: controller.signal })).status;
        assert.equal(report.discovery, ({ acp: "reported", "acp-forbidden": "forbidden-request", "acp-hang": "timeout",
          "stdout-flood": "output-budget-exceeded", "stderr-flood": "output-budget-exceeded", cancel: "cancelled", "consumer-failure": "error" } as Record<string, string>)[name]);
      } finally { clearTimeout(timer); }
    }
    const driverExits: Array<number | null> = [];
    const terminations = await Promise.all(invocations.map(async (invocation, index) => {
      const result = await invocation.termination; driverExits[index] = await invocation.rpc.closed; return result;
    }));
    report.results = terminations.map((result, index) => ({ status: result.status, driverExit: driverExits[index],
      ...(result.status === "proven" ? { outcome: result.outcome } : { reason: result.reason }) }));
    await stopping;
    await writeFile(join(root, "driver-err.log"), (await Promise.all(invocations.map(i => i.rpc.exited))).join("\n"));
    const termination = terminations[0]; report.status = termination.status;
    report.classification = termination.status === "refused" ? termination.reason === "unsupported" ? "unavailable" : "refusal" :
      termination.status === "unproven" ? "unproven" : termination.outcome.kind === "setup-failed" ? "setup-failed" : "execution-failed";
    if (termination.status === "refused" && termination.reason === "unsupported" && name === "normal") {
      assert.equal(driverExits[0], 65, "facility refusal requires the exact verifier exit");
      report.classification = "unavailable"; report.reason = "actual contextual facilities unavailable"; report.passed = true;
    } else {
      const want = expected(name);
      for (let i = 0; i < terminations.length; i++) {
        const result = terminations[i];
        assert.equal(result.status, want === "refused" ? "refused" : want === "unproven" ? "unproven" : "proven", `${name}: ${JSON.stringify(result)}`);
        if (result.status === "proven") {
          assert.ok(Object.isFrozen(result.evidence));
          if (want === "setup") assert.deepEqual(result.outcome, { kind: "setup-failed" });
          else {
            assert.notEqual(result.outcome.kind, "setup-failed");
            const outcome = expectedOutcome(name); if (outcome) assert.deepEqual(result.outcome, outcome);
            if (["stdout-flood", "stderr-flood"].includes(name)) assert.ok(result.outcome.kind === "stopped" ||
              (result.outcome.kind === "exited" && [0, 128].includes(result.outcome.code)), "unexpected finite flood outcome");
            if (name === "acp-forbidden") assert.ok(result.outcome.kind === "stopped" ||
              (result.outcome.kind === "exited" && result.outcome.code === 0), "unexpected finite forbidden-request outcome");
            if (name === "consumer-failure") assert.ok(result.outcome.kind === "stopped" ||
              (result.outcome.kind === "exited" && result.outcome.code === 117), "unexpected finite consumer-failure outcome");
            if (want === "success") await acceptedContext(report.contexts[i].diagnostics);
          }
        } else {
          assert.equal("evidence" in result, false);
          if (result.status === "refused") assert.equal(result.reason, ["clone-failure", "pidfd-failure"].includes(name) ? "unsupported" : name === "image-mismatch" ? "invalid-input" : "admission");
        }
      }
      if (terminations.length === 2 && terminations[0].status === "proven" && terminations[1].status === "proven")
        assert.notEqual(terminations[0].evidence, terminations[1].evidence);
      report.classification = want === "teardown" ? "teardown-only" : want === "success" ? "context-success" : want === "setup" ? "setup-failed" : want === "refused" ?
        ["clone-failure", "pidfd-failure"].includes(name) ? "unavailable" : "refusal" : "unproven";
      report.contextSuccesses = want === "success" ? fixtures.length : 0;
      report.passed = true;
    }
  } catch (error) {
    if (preparationFailure) report.classification = platformUnavailable ? "unavailable" : "preparation-failed";
    if (platformUnavailable) report.status = "unavailable";
    report.passed = platformUnavailable && name === "normal";
    report.reason = String(error).slice(0, 2000); if (!report.passed) process.exitCode = 1;
  }
  report.phase = "result";
  try {
    report.inventory = await inventory(root); retainedContexts(report.contexts, report.inventory);
    if (report.passed && report.classification !== "context-success") {
      if (expected(name) === "refused" || expected(name) === "setup" || report.classification === "unavailable" ||
        ["death-pre-admission", "guard-eof", "guard-registration-failure"].includes(name)) {
        assert.equal(report.inventory.some(e => ["executed", "image-a-executed", "image-b-executed", "context-ok", "fd-closed", "descendant-ready"].includes(e.path.split("/").at(-1)!)), false);
      }
      if (report.contexts[0]) await assertMutation(name, report.contexts[0].diagnostics);
    }
    assert.equal(report.inventory.some(e => e.path.endsWith("/image-b-executed") || e.path.endsWith("/late-activity") || e.path.endsWith("/pre-restriction-fds")), false);
    for (const a of assets) assert.equal(await exists(join(a.cwd, "executed")), false, "driver bootstrap must not become A cwd");
  } catch (error) { report.passed = false; report.reason = String(error).slice(0, 2000); process.exitCode = 1; }
  await writeFile(join(root, "report.json"), `${JSON.stringify(report)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function runWorker(name: Case, root: string, driver: string): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, "--worker", name, root, driver], { cwd: root,
      env: { HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PATH: "/usr/bin", LANG: "C", LC_ALL: "C",
        ...(name === "poisoned-ambient" ? { HOME: "/invented/poison-home", TMPDIR: "/invented/poison-tmp", TMP: "/invented/poison-tmp",
          TEMP: "/invented/poison-tmp", PATH: "/invented/poison-path", LANG: "invented", LC_ALL: "invented",
          XDG_CONFIG_HOME: "/invented/poison-config", XDG_CACHE_HOME: "/invented/poison-cache", XDG_DATA_HOME: "/invented/poison-data",
          XDG_STATE_HOME: "/invented/poison-state", XDG_RUNTIME_DIR: "/invented/poison-runtime", XDG_CONFIG_DIRS: "/invented/poison-config-dirs",
          XDG_DATA_DIRS: "/invented/poison-data-dirs", POISON_FIELD: "invented ambient value", NODE_OPTIONS: "--no-warnings" } : {}) },
      detached: false, stdio: ["ignore", "pipe", "pipe"] });
    let finished = false, out = "", bytes = 0, logs: Promise<unknown> = Promise.resolve();
    let watchdogClose: (() => void) | undefined;
    const observed = { exitObserved: false, closeObserved: false, code: null as number | null, signal: null as string | null };
    const partial = (): Report | undefined => {
      let report: Report | undefined;
      for (const line of out.trim().split("\n")) try {
        const row: Report = JSON.parse(line);
        if (row.name === name && ["prepared", "result"].includes(row.phase)) report = row;
      } catch { /* only complete bounded worker reports */ }
      return report;
    };
    const timer = setTimeout(() => {
      finished = true;
      // Observe this exact ChildProcess once. No PID retry, native-proof claim,
      // or indefinite wait after the independent 13-second watchdog fires.
      const closeObservation = new Promise<void>(done => {
        const reapTimer = setTimeout(() => { watchdogClose = undefined; done(); }, 1000);
        watchdogClose = () => { clearTimeout(reapTimer); watchdogClose = undefined; done(); };
      });
      child.kill("SIGKILL"); child.stdout.destroy(); child.stderr.destroy();
      const p = partial();
      void closeObservation.then(() => logs).then(async () => {
        child.unref();
        const entries = await inventory(root), contexts = p?.contexts ?? []; retainedContexts(contexts, entries);
        resolve({ phase: "result", name, status: "watchdog", classification: "unproven", passed: name === "worker-watchdog" && observed.closeObserved,
          reason: observed.closeObserved ? "independent 13-second worker watchdog; exact worker close observed; no owned proof join" :
            "independent 13-second worker watchdog; exact worker close not observed within 1 second; failed reap observation; no owned proof join",
          watchdogWorker: { ...observed }, contexts, bootstrap: p?.bootstrap ?? [join(root, "work")],
          logs: p?.logs ?? [join(root, "worker-out.log"), join(root, "worker-err.log")], inventory: entries, retained: true });
      }).catch(reject);
    }, 13_000);
    for (const [stream, file] of [[child.stdout, "worker-out.log"], [child.stderr, "worker-err.log"]] as const) stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 65_536) {
        if (file === "worker-out.log") out += chunk.toString();
        const copy = Buffer.from(chunk); logs = logs.then(() => appendFile(join(root, file), copy));
      }
    });
    child.on("error", error => { clearTimeout(timer); if (!finished) { finished = true; reject(error); } });
    child.on("exit", (code, signal) => { observed.exitObserved = true; observed.code = code; observed.signal = signal; });
    child.on("close", (code, signal) => {
      observed.closeObserved = true; observed.code = code; observed.signal = signal;
      watchdogClose?.();
      clearTimeout(timer); if (finished) return; finished = true;
      void logs.then(async () => {
        const report = partial();
        if (!report || report.phase !== "result" || bytes > 65_536) {
          const entries = await inventory(root), contexts = report?.contexts ?? []; retainedContexts(contexts, entries);
          return resolve({ phase: "result", name, status: "unproven", classification: "unproven", passed: false,
            reason: `invalid bounded worker report; worker exit ${code}`, contexts, inventory: entries,
            bootstrap: report?.bootstrap ?? [join(root, "work")],
            logs: report?.logs ?? [join(root, "worker-out.log"), join(root, "worker-err.log")], retained: true });
        }
        if (code !== 0) report.passed = false;
        resolve(report);
      }).catch(reject);
    });
  });
}
function normalFacilityUnavailable(report: Report): boolean {
  return report.phase === "result" && report.name === "normal" && report.passed === true &&
    report.status === "refused" && report.classification === "unavailable" &&
    report.contexts.length === 1 && report.results?.length === 1 &&
    report.results[0].status === "refused" && report.results[0].reason === "unsupported" &&
    report.results[0].driverExit === 65;
}
async function main(): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") { console.log("SKIP context native: Linux x86_64 only; zero targets"); return; }
  const release = process.argv.includes("--release"), driver = join(repo, `target/${release ? "release" : "debug"}/probe-lifetime-driver`);
  if (!(await exists(driver))) { console.log("SKIP context native: missing explicit feature driver; zero targets"); return; }
  const base = await mkdtemp("/tmp/gs-acp-context-binding-");
  const manifest = join(base, "manifest.jsonl"); await writeFile(manifest, "", { flag: "wx", mode: 0o600 });
  // Controller precreates every finite worker parent, bootstrap and log before
  // any native capture. Workers materialize their own images/contexts before launch.
  for (const name of cases) {
    const root = join(base, name); await mkdir(root, { mode: 0o700 });
    for (const dir of ["home", "tmp", "work", "contexts", ...(name === "concurrent" ? ["work-second", "contexts-second"] : [])]) await mkdir(join(root, dir), { mode: 0o700 });
    for (const suffix of name === "concurrent" ? ["", "-second"] : [""])
      await writeFile(join(root, `contexts${suffix}`, "neighbor"), "fixture neighbor\n", { flag: "wx", mode: 0o600 });
    for (const file of ["worker-out.log", "worker-err.log", "driver-err.log", "report.json"])
      await writeFile(join(root, file), "", { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ retainedBase: base, manifest, cases: cases.length, profile: release ? "release" : "debug" }));
  const counts: Record<string, number> = {}; let passed = 0, failed = 0, skipped = 0, unavailable = false;
  for (const name of cases) {
    if (unavailable && name !== "worker-watchdog") { skipped++; continue; }
    const root = join(base, name);
    let report: Report;
    try { report = await runWorker(name, root, driver); }
    catch (error) {
      // Preserve any complete prepared/result metadata even if transport or
      // inventory reporting failed. The controller still appends a terminal row.
      let recovered: Report | undefined;
      try {
        const saved = await readFile(join(root, "worker-out.log"));
        assert.ok(saved.length <= 65_536);
        for (const line of saved.toString().trim().split("\n")) try {
          const row: Report = JSON.parse(line);
          if (row.name === name && ["prepared", "result"].includes(row.phase)) recovered = row;
        } catch { /* retain only complete worker metadata */ }
      } catch { /* precreated log paths remain in the report */ }
      report = { ...recovered, phase: "result", name, status: "unproven", classification: "unproven", passed: false,
        reason: `worker reporting failed: ${String(error).slice(0, 1500)}`, contexts: recovered?.contexts ?? [],
        bootstrap: recovered?.bootstrap ?? [join(root, "work")],
        logs: recovered?.logs ?? ["worker-out.log", "worker-err.log", "driver-err.log", "report.json"].map(n => join(root, n)), retained: true };
      try { report.inventory = await inventory(root); retainedContexts(report.contexts, report.inventory); }
      catch (error) { report.reason += `; retained inventory failure: ${String(error).slice(0, 500)}`; }
    }
    await writeFile(join(root, "report.json"), `${JSON.stringify(report)}\n`);
    await appendFile(manifest, `${JSON.stringify(report)}\n`); console.log(JSON.stringify(report));
    counts[report.classification ?? "failed-preparation"] = (counts[report.classification ?? "failed-preparation"] ?? 0) + 1;
    if (report.passed) passed++; else failed++;
    if (normalFacilityUnavailable(report)) unavailable = true;
  }
  console.log(JSON.stringify({ passed, failed, skipped, counts, manifest, retainedBase: base,
    acceptance: unavailable ? "unavailable; zero positive contextual acceptance" : "finite tested-host contextual fixture results only",
    limitations: "owner changes synthetic only; no continuous identity or immutable environment-path claim; worker stdout logs contain reports, ACP consumes driver stdout" }));
  if (failed) process.exitCode = 1;
}
if (process.argv[2] === "--worker") await worker(); else {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--release"));
  await main();
}
