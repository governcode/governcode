import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fixture from "./fixtures/acp-probe-termination.ts";

// Ordinary tests never run the native driver, including its image-data modes.
for (const row of fixture.syntheticContextFixtureChecks()) test(`synthetic context binding: ${row.name}`, () => {
  assert.equal(row.pass, true, row.name);
  assert.deepEqual(Object.keys(row).sort(), ["name", "pass"]);
  assert.ok(Object.isFrozen(row));
});

test("context launch rejects arbitrary, copied and proxied caller records without reading them", () => {
  let traps = 0;
  const trap = () => { traps++; throw new Error("invented trap"); };
  const proxy = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  for (const candidate of [null, undefined, 1, "context", false, {}, Buffer.alloc(32),
    { status: "prepared", fixture: {}, context: {}, env: {}, identities: {}, fd: 3 },
    { status: "proven", evidence: {}, outcome: { kind: "exited", code: 7 } },
    Object.defineProperty({}, "context", { get: trap }), proxy, Proxy.revocable({}, {}).proxy]) {
    assert.throws(() => fixture.startNativeContextBoundFixture(candidate as never, "normal"));
    assert.throws(() => fixture.startNativeContextBoundFixture(candidate as never, "ctx-open"));
  }
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.throws(() => fixture.startNativeContextBoundFixture(revoked.proxy as never, "normal"));
  assert.equal(traps, 0);
});

test("parent validation is trap-free and precedes caller image and signal handling", async () => {
  let traps = 0;
  const trap = () => { traps++; throw new Error("invented trap"); };
  const image = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const signal = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
  const parent = "/invented/context-parent";
  for (const input of [null, undefined, [], "parent", { parent, env: {} }, { parent, context: {} },
    { parent, ids: [] }, { parent, proof: {} }, { parent, policy: {} }, { parent, bytes: Buffer.alloc(64) },
    { parent, sha256: "a" }, { parent, fd: 3 }, Object.create({ parent }),
    Object.defineProperty({}, "parent", { get: trap }),
    new Proxy({ parent }, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap })]) {
    await assert.rejects(fixture.prepareNativeContextBoundFixture(image as never, input as never, signal as never), /Invalid fixture assets/);
  }
  for (const value of ["relative", "/", "/invented//parent", "/invented/./parent", "/invented/../parent", "/invented/parent/",
    "/invented/colon:parent", "/invented/\nparent", "/invented/\u0000parent", "/invented/\ud800", `/${"x".repeat(256)}`,
    `/${"é/".repeat(1024)}x`, 3, {}, null]) {
    await assert.rejects(fixture.prepareNativeContextBoundFixture(image as never, { parent: value } as never, signal as never), /Invalid context parent/);
  }
  for (const input of [{ parent }, Object.assign(Object.create(null), { parent })])
    await assert.rejects(fixture.prepareNativeContextBoundFixture(image as never, input, signal as never), /Invalid or consumed bound fixture/);
  assert.equal(traps, 0);
});

test("image identity is checked before allocation and cannot come from caller completion", async () => {
  for (const image of [null, undefined, {}, { status: "proven", evidence: {}, root: "/invented/context" },
    { status: "prepared", fixture: {}, observation: { bytes: 64, sha256: "a" } }])
    await assert.rejects(fixture.prepareNativeContextBoundFixture(image as never, { parent: "/invented/missing" }), /Invalid or consumed bound fixture/);
});

test("context plumbing consumes privately, retains diagnostics and uses the single owned launch", async () => {
  const owner = await readFile(new URL("./fixtures/acp-probe-termination.ts", import.meta.url), "utf8");
  const preparation = owner.slice(owner.indexOf("export async function prepareNativeContextBoundFixture"), owner.indexOf("export function startNativeContextBoundFixture"));
  assert.ok(preparation.indexOf("contextParent(input)") < preparation.indexOf("consumePrepared(image"));
  assert.ok(preparation.indexOf("consumePrepared(image") < preparation.indexOf("await allocateAcpProbeContext"));
  assert.match(preparation, /allocateAcpProbeContext\(\{ parent \}, signal\)/);
  assert.match(preparation, /prepared\.context = context/);
  assert.match(preparation, /image: prepared, assets: prepared\.assets, launch, deadline: prepared\.deadline/);
  assert.match(preparation, /contextDiagnostics\(context\)/);
  assert.match(preparation, /deadline: prepared\.deadline/);
  assert.doesNotMatch(preparation, /performance\.now\(\) \+|rmdir|unlink|rename|remove|rollback/);
  const signalCheck = owner.slice(owner.indexOf("function contextCancelled"), owner.indexOf("export async function prepareNativeContextBoundFixture"));
  assert.ok(signalCheck.indexOf("types.isProxy(signal)") < signalCheck.indexOf("Object.getOwnPropertyDescriptors(signal)"));
  assert.ok(signalCheck.indexOf("Reflect.ownKeys(descriptors)") < signalCheck.indexOf("signalAborted.call(signal)"));
  assert.match(owner, /const contextPreparations = new WeakMap/);
  assert.match(owner, /consumeAssociation\(contextPreparations, fixture, scenario, performance\.now\(\), contextScenarios\)/);
  assert.match(owner, /launchOwned\(prepared\.assets, scenario, "context-bound-transport-v1", prepared\.launch\)/);
  assert.match(owner, /cwd: context\?\.context\.directories\.cwd \?\? a\.cwd/);
  assert.match(owner, /cwd: a\.cwd, env: \{ \.\.\.\(context\?\.env \?\? a\.env\) \}/);
  assert.equal((owner.match(/function launchOwned\(/g) ?? []).length, 1);
  assert.equal((owner.match(/associations\.set\(/g) ?? []).length, 1);
  assert.doesNotMatch(owner, /process\.env|process\.kill\(|child\.kill\(|JSON\.parse|cleanup\(/);
});

test("the five-field asset contract remains exact and excludes the contextual environment", () => {
  const env = { HOME: "/invented/home", TMPDIR: "/invented/tmp", PATH: "/usr/bin", LANG: "C", LC_ALL: "C" };
  const assets = { driver: "/invented/driver", target: "/invented/target", policy: "/invented/policy", cwd: "/invented/bootstrap", env };
  for (const field of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "XDG_CONFIG_DIRS", "XDG_DATA_DIRS", "TMP", "TEMP", "POISON"]) {
    assert.throws(() => fixture.startNativeLifetimeFixture({ ...assets, env: { ...env, [field]: "/invented/context" } } as never, "normal"));
  }
});

test("context entry points and evidence are excluded from production and automatic namespace tests", async () => {
  const source = new URL("../src/", import.meta.url);
  for (const name of await readdir(source)) if (name.endsWith(".ts"))
    assert.doesNotMatch(await readFile(new URL(name, source), "utf8"), /acp-probe-termination|prepareNativeContextBoundFixture|startNativeContextBoundFixture/);
  const main = await readFile(new URL("../../../crates/govern-sup/src/main.rs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /probe_context|context-bound-transport-v1/);
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.doesNotMatch(pkg.scripts.test, /native|context-binding\.native/);
});

// Isolated loader faults exercise the actual worker/controller without adding
// owner exports or launching a native driver. All scratch data stays retained.
test("preparation failures fail workers and controllers while retaining late allocations", {
  skip: process.platform !== "linux" || process.arch !== "x64" ? "allocator fixture requires Linux x86_64" : false,
}, async t => {
  const base = await mkdtemp("/tmp/gs-context-preparation-regression-");
  const manifest = join(base, "manifest.jsonl");
  const harness = fileURLToPath(new URL("./acp-context-binding.native.ts", import.meta.url));
  const ownerUrl = new URL("./fixtures/acp-probe-termination.ts", import.meta.url).href;
  const harnessUrl = new URL("./acp-context-binding.native.ts", import.meta.url).href;
  // Valid passive ELF metadata; these invented bytes are never executed.
  const image = Buffer.alloc(120);
  image.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  image.writeUInt16LE(2, 16); image.writeUInt16LE(62, 18); image.writeUInt32LE(1, 20);
  image.writeBigUInt64LE(64n, 32); image.writeUInt16LE(64, 52);
  image.writeUInt16LE(56, 54); image.writeUInt16LE(1, 56);
  image.writeUInt32LE(1, 64); image.writeUInt32LE(4, 68);
  image.writeBigUInt64LE(1n, 96); image.writeBigUInt64LE(1n, 104); image.writeBigUInt64LE(1n, 112);
  for (const fault of ["expired", "cancelled", "selection", "allocation", "missing-driver", "image-data", "image-layout", "materialization"]) {
    const root = join(base, fault); await mkdir(root, { mode: 0o700 });
    for (const name of ["work", "contexts"]) await mkdir(join(root, name), { mode: 0o700 });
    const driver = join(root, fault === "missing-driver" ? "absent-driver" : "image-driver.mjs");
    const driverLog = join(root, "image-driver.jsonl");
    const loader = join(root, "inject.mjs");
    if (fault !== "missing-driver") await writeFile(driver, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(driverLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (!["fixture-image-a", "fixture-image-b"].includes(process.argv[2])) process.exit(99);
const bytes = Buffer.from(${JSON.stringify(image.toString("hex"))}, "hex");
if (process.argv[2] === "fixture-image-b") bytes[24] = 1;
process.stdout.write(${fault === "image-data" ? 'Buffer.alloc(0)' : fault === "image-layout" ? 'Buffer.alloc(120)' : 'bytes'});
`, { mode: 0o700 });
    const ownerEdits: Array<[string, string]> = [];
    if (fault === "expired") ownerEdits.push(["prepared.context = context;", "prepared.context = context; prepared.deadline = performance.now() - 1;"]);
    if (fault === "cancelled") {
      ownerEdits.push(["allocateAcpProbeContext, AcpProbeContextError,", "allocateAcpProbeContext, createAcpProbeAbortController, AcpProbeContextError,"]);
      ownerEdits.push(["const parent = contextParent(input);", "const parent = contextParent(input); const cancellation = createAcpProbeAbortController(); signal = cancellation.signal;"]);
      ownerEdits.push(["prepared.context = context;", "prepared.context = context; cancellation.abort();"]);
    }
    if (fault === "selection") ownerEdits.push(["launch = contextSelection(context, parent);", 'launch = contextSelection({ ...context, env: { ...context.env, LC_ALL: "invented" } }, parent);']);
    if (fault === "allocation") ownerEdits.push(["context = await allocateAcpProbeContext({ parent }, signal);", 'throw new AcpProbeContextError("filesystem-error", "not-needed", null);']);
    if (fault === "materialization") ownerEdits.push(["await writeFile(a.target, imageA,", 'await writeFile(a.target, "collision", { flag: "wx" }); await writeFile(a.target, imageA,']);
    // The controller runs just two finite cases. Each must still run and fail.
    // Every replacement is guarded so owner drift fails the regression itself.
    await writeFile(loader, `import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const replace = (source, from, to) => { assert.equal(source.split(from).length, 2, from); return source.replace(from, to); };
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url !== ${JSON.stringify(ownerUrl)} && url !== ${JSON.stringify(harnessUrl)}) return loaded;
  let source = String(loaded.source);
  if (url === ${JSON.stringify(ownerUrl)}) for (const [from, to] of ${JSON.stringify(ownerEdits)}) source = replace(source, from, to);
  else {
    source = replace(source, 'const cases: readonly Case[] = [...finite, ...specials];', 'const cases: readonly Case[] = ["normal", "sandbox"];');
    source = replace(source, ${JSON.stringify('driver = join(repo, `target/${release ? "release" : "debug"}/probe-lifetime-driver`)')}, 'driver = ' + ${JSON.stringify(JSON.stringify(driver))});
    source = replace(source, '[self, "--worker", name, root, driver]', '["--import", ' + ${JSON.stringify(JSON.stringify(loader))} + ', self, "--worker", name, root, driver]');
    // A classification string, failed normal report, wrong verifier exit,
    // or missing exact terminal result must never enable facility skipping.
    source += '\\nfor (const row of [ {}, { passed: false }, { phase: "prepared" }, { status: "unavailable" }, { classification: "preparation-failed" }, { contexts: [] }, { results: [] }, { results: [{status:"refused",reason:"unsupported",driverExit:0}] }, { name:"sandbox" } ]) assert.equal(normalFacilityUnavailable({phase:"result",name:"normal",passed:true,status:"refused",classification:"unavailable",contexts:[{}],results:[{status:"refused",reason:"unsupported",driverExit:65}],...row}), Object.keys(row).length === 0);';
  }
  return { ...loaded, source };
} });
`);
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", loader, harness, ...args], {
      encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024,
    });
    const worker = run(["--worker", "normal", root, driver]);
    await writeFile(join(root, "worker-out.log"), worker.stdout ?? "");
    await writeFile(join(root, "worker-err.log"), worker.stderr ?? "");
    assert.equal(worker.status, 1, `${fault}: ${worker.stderr}`);
    const report = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
    assert.equal(report.passed, false, fault);
    assert.equal(report.classification, "preparation-failed", fault);
    assert.match(report.reason, new RegExp(fault === "missing-driver" ? "image-data" : fault));
    const controller = run([]);
    await writeFile(join(root, "controller-out.log"), controller.stdout ?? "");
    await writeFile(join(root, "controller-err.log"), controller.stderr ?? "");
    if (fault === "missing-driver") {
      assert.equal(controller.status, 0, controller.stderr);
      assert.match(controller.stdout, /missing explicit feature driver; zero targets/);
    } else {
      assert.equal(controller.status, 1, `${fault}: ${controller.stderr}`);
      const summary = JSON.parse(controller.stdout.trim().split("\n").at(-1)!);
      assert.equal(summary.failed, 2); assert.equal(summary.skipped, 0); assert.equal(summary.passed, 0);
      const rows = (await readFile(summary.manifest, "utf8")).trim().split("\n").map(row => JSON.parse(row));
      assert.deepEqual(rows.map(row => row.name), ["normal", "sandbox"]);
      assert.ok(rows.every(row => row.passed === false && row.classification === "preparation-failed"));
      await appendFile(manifest, `${JSON.stringify({ fault, controller: summary })}\n`);
    }
    if (["expired", "cancelled", "selection"].includes(fault)) {
      assert.equal(report.contexts.length, 1);
      const d = report.contexts[0].diagnostics;
      assert.equal(report.allocationRetainedPaths[0], d.root);
      for (const [name, id] of Object.entries(d.identities) as Array<[string, { dev: string; ino: string }]>) {
        const stat = await lstat(name === "root" ? d.root : d.directories[name], { bigint: true });
        assert.ok(stat.isDirectory()); assert.equal(stat.dev.toString(), id.dev); assert.equal(stat.ino.toString(), id.ino);
      }
    }
    if (fault !== "missing-driver") {
      const launches = (await readFile(driverLog, "utf8")).trim().split("\n").map(row => JSON.parse(row));
      assert.ok(launches.every(args => args.length === 1 && /^fixture-image-[ab]$/.test(args[0])));
    }
    await appendFile(manifest, `${JSON.stringify({ fault, workerExit: worker.status, report, command: [process.execPath, "--import", loader, harness, "--worker", "normal", root, driver] })}\n`);
  }
  t.diagnostic(`retained preparation regressions: ${manifest}`);
});
