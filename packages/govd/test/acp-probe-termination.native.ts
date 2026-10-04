// Explicit live check: node packages/govd/test/acp-probe-termination.native.ts [--release]
// Ordinary npm test never selects this file. Parent owns an independent 13s
// watchdog per worker; only that exact worker can receive emergency SIGKILL.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { startNativeLifetimeFixture, type FixtureScenario } from "./fixtures/acp-probe-termination.ts";
import { discoverAcp } from "../src/acp-probe.ts";
import { allocateAcpProbeContext } from "../src/acp-probe-context.ts";

const self = fileURLToPath(import.meta.url), repo = fileURLToPath(new URL("../../../", import.meta.url));
const nativeCases = ["normal", "high-exit", "signal", "direct", "double", "detach", "signal-tree", "kill-init", "forge",
  "acp", "acp-forbidden", "acp-hang", "stdout-flood", "stderr-flood", "stop", "cancel", "consumer-failure",
  "death-pre-admission", "death-post-admission", "death-mid-record", "death-full-record", "death-closed-record",
  "proof-truncate", "proof-stale", "proof-extra", "proof-missing", "guard-eof", "guard-registration-failure", "guard-registration-deadline",
  "clone-failure", "pidfd-failure", "map-failure", "restrict-failure", "exec-failure", "wait-failure", "withhold", "control-error",
  "context-proven", "context-unproven", "concurrent", "worker-watchdog"] as const;
type Case = typeof nativeCases[number];
const finiteFiles = ["executed", "descendant-ready", "late-activity", "forge-rejected", "sandbox-ok", "fd-closed", "acp-ready", "forbidden-rejected", "pre-restriction-fds", "hung-request", "flood-ready"];
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

async function worker(): Promise<void> {
  const name = process.argv[3] as Case, root = process.argv[4], driver = process.argv[5], target = process.argv[6];
  assert.ok(nativeCases.includes(name));
  const cwd = join(root, "work");
  await mkdir(cwd, { mode: 0o700 });
  const policy = join(root, "policy.json");
  await writeFile(policy, JSON.stringify({ version: 1, read: [], write: [cwd], exec: [target], tcp_connect: [], cwd,
    child_restrictions: { deny_network: true, deny_chmod: true } }), { mode: 0o600 });
  let contextRoot: string | undefined;
  if (name.startsWith("context-")) {
    const parent = join(root, "contexts"); await mkdir(parent, { mode: 0o700 });
    contextRoot = (await allocateAcpProbeContext({ parent })).root;
  }
  const scenario: FixtureScenario = ["context-proven", "concurrent"].includes(name) ? "normal" : name === "context-unproven" ? "proof-missing" :
    ["stop", "cancel", "worker-watchdog"].includes(name) ? "hold" : name === "consumer-failure" ? "acp" : name as FixtureScenario;
  const invocation = startNativeLifetimeFixture({ driver, target, policy, cwd,
    env: { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } }, scenario);
  let concurrent: ReturnType<typeof startNativeLifetimeFixture> | undefined;
  if (name === "concurrent") {
    const second = join(root, "work-second"), secondPolicy = join(root, "policy-second.json");
    await mkdir(second, { mode: 0o700 });
    await writeFile(secondPolicy, JSON.stringify({ version: 1, read: [], write: [second], exec: [target], tcp_connect: [], cwd: second,
      child_restrictions: { deny_network: true, deny_chmod: true } }), { mode: 0o600 });
    concurrent = startNativeLifetimeFixture({ driver, target, policy: secondPolicy, cwd: second,
      env: { HOME: second, TMPDIR: second, PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } }, "normal");
  }
  let discovery: string | undefined;
  if (name === "worker-watchdog") { for (;;) { /* intentional stalled fixture worker; native guard remains independent */ } }
  if (name === "stop") { const timer = setTimeout(() => { invocation.stop(); invocation.stop(); invocation.rpc.close(1); }, 100); timer.unref(); }
  if (["acp", "acp-forbidden", "acp-hang", "stdout-flood", "stderr-flood", "cancel", "consumer-failure"].includes(name)) {
    const controller = new AbortController();
    const timer = name === "cancel" ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      const rpc = name === "consumer-failure" ? { ...invocation.rpc, request: async (method: string, params: unknown, timeout?: number) => { await invocation.rpc.request(method, params, timeout); throw new Error("invented consumer failure"); } } : invocation.rpc;
      const report = await discoverAcp(rpc, { cwd, freshCwd: true, createSession: true, timeoutMs: 500, cleanupTimeoutMs: 5000, signal: controller.signal });
      discovery = report.status;
      const expected = ({ acp: "reported", "acp-forbidden": "forbidden-request", "acp-hang": "timeout", cancel: "cancelled",
        "stdout-flood": "output-budget-exceeded", "stderr-flood": "output-budget-exceeded", "consumer-failure": "error" } as Record<string, string>)[name];
      assert.equal(discovery, expected);
    } finally { clearTimeout(timer); }
  }
  const termination = await invocation.termination;
  await invocation.rpc.closed;
  if (concurrent) {
    const other = await concurrent.termination; await concurrent.rpc.closed;
    assert.equal(other.status, termination.status);
    if (other.status === "proven" && termination.status === "proven") assert.notEqual(other.evidence, termination.evidence);
  }
  const executed = await exists(join(cwd, "executed"));
  if (name === "normal" && termination.status === "refused" && termination.reason === "unsupported") {
    assert.equal(executed, false);
    process.stdout.write(JSON.stringify({ name, skip: "actual namespace/pidfd facilities unavailable", executed: false, status: "refused", retained: true })); return;
  }
  const expectedUnproven = name.startsWith("death-") || name.startsWith("proof-") || ["wait-failure", "withhold", "context-unproven", "guard-eof", "guard-registration-failure"].includes(name);
  const expectedRefused = ["clone-failure", "pidfd-failure"].includes(name);
  assert.equal(termination.status, expectedUnproven ? "unproven" : expectedRefused ? "refused" : "proven", `${name}: ${JSON.stringify(termination)}; ${(await invocation.rpc.exited).slice(-1000)}`);
  if (termination.status === "proven") {
    assert.ok(Object.isFrozen(termination.evidence));
    if (executed) assert.equal(await readFile(join(cwd, "pre-restriction-fds"), "utf8"), "EBADF before restriction\n");
    if (name === "normal") assert.deepEqual(termination.outcome, { kind: "exited", code: 7 });
    if (name === "high-exit") assert.deepEqual(termination.outcome, { kind: "exited", code: 200 });
    if (["signal", "signal-tree"].includes(name)) assert.deepEqual(termination.outcome, { kind: "signalled", signal: 15 });
    if (["map-failure", "restrict-failure", "exec-failure", "guard-registration-deadline"].includes(name)) { assert.equal(termination.outcome.kind, "setup-failed"); assert.equal(executed, false); }
  } else assert.equal("evidence" in termination, false);
  if (expectedRefused || ["death-pre-admission", "guard-eof", "guard-registration-failure"].includes(name)) assert.equal(executed, false);
  if (["direct", "double", "detach", "signal-tree", "kill-init"].includes(name)) {
    assert.equal(await exists(join(cwd, "descendant-ready")), true);
    assert.equal(await exists(join(cwd, "late-activity")), false);
  }
  if (name === "forge") assert.equal(await exists(join(cwd, "forge-rejected")), true);
  if (contextRoot) assert.ok((await lstat(contextRoot)).isDirectory());
  process.stdout.write(JSON.stringify({ name, status: termination.status, ...(discovery ? { discovery } : {}), executed,
    retained: termination.status !== "proven", contextRetained: contextRoot !== undefined }));
}

async function runWorker(name: Case, root: string, driver: string, target: string): Promise<{ watchdog: boolean; code: number | null; report: any }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, "--worker", name, root, driver, target], {
      cwd: root, env: { HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PATH: "/usr/bin", LANG: "C", LC_ALL: "C" },
      detached: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let watchdog = false, out = "", err = "", bytes = 0;
    const timer = setTimeout(() => {
      watchdog = true; child.kill("SIGKILL");
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      // Never wait indefinitely for even the worker's close after the emergency.
      resolve({ watchdog: true, code: null, report: { name, status: "unproven", reason: "worker-watchdog", retained: true } });
    }, 13_000);
    for (const [stream, stdout] of [[child.stdout, true], [child.stderr, false]] as const) stream.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes <= 65_536) { if (stdout) out += b.toString(); else err += b.toString(); }
    });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer); if (watchdog) return;
      if (code !== 0) { reject(new Error(`${name}: worker exit ${code}: ${err.slice(-2000)}`)); return; }
      try { resolve({ watchdog: false, code, report: JSON.parse(out) }); } catch { reject(new Error(`${name}: invalid bounded worker report`)); }
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") { console.log("SKIP native transport: only current Linux x86_64 acceptance requested; zero targets"); return; }
  const debug = join(repo, "target/debug/probe-lifetime-driver"), release = join(repo, "target/release/probe-lifetime-driver");
  const driver = process.argv[2] === "--release" ? release : await exists(debug) ? debug : release;
  if (!(await exists(driver)) || !(await exists("/usr/bin/cc"))) { console.log("SKIP native transport: missing explicit feature driver or static compiler; zero targets"); return; }
  const base = await mkdtemp("/tmp/gs-acp-transport-");
  await mkdir(join(base, "home"), { mode: 0o700 }); await mkdir(join(base, "tmp"), { mode: 0o700 });
  const target = join(base, "target");
  try {
    await promisify(execFile)("/usr/bin/cc", ["-std=c11", "-D_GNU_SOURCE", "-O2", "-Wall", "-Wextra", "-Werror", "-static",
      join(repo, "crates/govern-sup/tests/fixtures/probe_lifetime.c"), "-o", target], {
      cwd: base, env: { PATH: "/usr/bin", HOME: join(base, "home"), TMPDIR: join(base, "tmp"), LANG: "C", LC_ALL: "C" }, timeout: 20_000, maxBuffer: 65_536,
    });
  } catch { console.log(`SKIP native transport: static fixture compilation unavailable; zero targets; files retained at ${base}`); return; }
  let passed = 0, skipped = 0, watchdogPassed = 0, unavailable = false;
  for (const name of nativeCases) {
    if (unavailable && name !== "worker-watchdog") { skipped++; continue; }
    const root = join(base, name); await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, "home"), { mode: 0o700 }); await mkdir(join(root, "tmp"), { mode: 0o700 });
    const result = await runWorker(name, root, driver, target);
    if (result.watchdog) assert.equal(name, "worker-watchdog", `unexpected worker watchdog: ${name}; retained ${root}`);
    if (result.report.skip) { skipped++; unavailable = true; } else if (result.watchdog) watchdogPassed++; else passed++;
    console.log(JSON.stringify(result.report));
    // Only this finite owner's files, after actual proof AND worker close. Never
    // recursively remove contents or remove a successful allocator context.
    if (!result.watchdog && result.report.status === "proven") {
      for (const file of finiteFiles) if (await exists(join(root, "work", file))) await unlink(join(root, "work", file));
      await rmdir(join(root, "work")); await unlink(join(root, "policy.json"));
      if (name === "concurrent") {
        for (const file of finiteFiles) if (await exists(join(root, "work-second", file))) await unlink(join(root, "work-second", file));
        await rmdir(join(root, "work-second")); await unlink(join(root, "policy-second.json"));
      }
      await rmdir(join(root, "home")); await rmdir(join(root, "tmp"));
      if (!result.report.contextRetained) await rmdir(root);
    }
  }
  console.log(JSON.stringify({ nativePassed: passed, nativeSkipped: skipped, watchdogPassed, retained: base,
    acceptance: unavailable ? "unavailable; no native positive acceptance" : "current Linux x86_64 only" }));
}
if (process.argv[2] === "--worker") await worker(); else {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--release"));
  await main();
}
