import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import * as fixture from "./fixtures/acp-probe-termination.ts";

// All ordinary cases are synthetic. Even a present feature binary is never run.
for (const row of fixture.syntheticBoundFixtureChecks()) test(`synthetic artifact binding: ${row.name}`, () => {
  assert.equal(row.pass, true, row.name);
  assert.deepEqual(Object.keys(row).sort(), ["name", "pass"]);
  assert.ok(Object.isFrozen(row));
});

test("bound entry point rejects caller objects without inspecting properties or launching", () => {
  let reads = 0;
  for (const candidate of [null, undefined, true, 3, "fixture", {}, Buffer.alloc(32), { verified: true, pid: 1, fd: 3, sha256: "a" },
    Object.defineProperty({}, "fixture", { get() { reads++; throw new Error("getter"); } }),
    new Proxy({}, { get() { reads++; throw new Error("proxy"); }, ownKeys() { reads++; throw new Error("proxy"); } })]) {
    assert.throws(() => fixture.startNativeBoundFixture(candidate as never, "normal"));
  }
  assert.equal(reads, 0);
});

test("bound preparation validates literal assets before any driver data launch", async () => {
  let reads = 0;
  const assets = { driver: "/invented/driver", target: "/invented/source", policy: "/invented/policy", cwd: "/invented/work",
    env: { HOME: "/invented/home", TMPDIR: "/invented/tmp", PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } } as const;
  const getter = Object.defineProperty({ ...assets }, "driver", { get() { reads++; return assets.driver; } });
  const proxy = new Proxy(assets, { get() { reads++; throw new Error("proxy"); }, ownKeys() { reads++; throw new Error("proxy"); } });
  for (const candidate of [getter, proxy, { ...assets, target: "relative" }, { ...assets, suppliedHash: "a" },
    { ...assets, env: { ...assets.env, POISON_FIELD: "fixture-value" } }, { ...assets, env: { ...assets.env, PATH: "/caller/bin" } }]) {
    await assert.rejects(fixture.prepareNativeBoundFixture(candidate as never));
  }
  assert.deepEqual(await fixture.prepareNativeBoundFixture({ ...assets, policy: assets.target }), { status: "unavailable", reason: "assets" });
  assert.equal(reads, 0);
});

test("fixed image preparation retains private bytes and launches only through identity", async () => {
  const owner = await readFile(new URL("./fixtures/acp-probe-termination.ts", import.meta.url), "utf8");
  const acquisition = owner.slice(owner.indexOf("async function acquireFixedImages"), owner.indexOf("/** Fixed trusted-driver data modes"));
  const preparation = owner.slice(owner.indexOf("export async function prepareNativeBoundFixture"), owner.indexOf("export function startNativeBoundFixture"));
  assert.match(preparation, /await acquireFixedImages\(a\)/);
  assert.match(acquisition, /imageA = await emit\("fixture-image-a"\); imageB = await emit\("fixture-image-b"\)/);
  assert.match(acquisition, /imageA\.equals\(imageB\)/);
  assert.doesNotMatch(acquisition, /writeFile|policy|preparations\.set/);
  assert.match(preparation, /await writeFile\(a\.target, imageA, \{ flag: "wx", mode: 0o700 \}\)/);
  assert.match(preparation, /await writeFile\(a\.policy/);
  assert.match(preparation, /deadline: performance\.now\(\) \+ 11_000/);
  assert.match(owner, /const preparations = new WeakMap/);
  assert.match(owner, /consumeAssociation\(preparations, fixture, scenario, now\)/);
  assert.match(owner, /map\.get\(fixture\)/);
  assert.match(owner, /p\.used = true/);
  assert.match(owner, /now >= p\.deadline/);
  assert.match(owner, /consumePrepared\(fixture, scenario, performance\.now\(\)\)/);
  assert.match(owner, /launchOwned\(prepared\.assets, scenario, "bound-transport-v1"\)/);
  assert.match(owner, /"fixture-image-a"/);
  assert.match(owner, /"fixture-image-b"/);
  assert.match(owner, /timeout: 2000/);
  assert.match(owner, /maxBuffer: 4 \* 1024 \* 1024/);
  assert.match(owner, /createHash\("sha256"\)\.update\(imageA\)/);
  assert.match(owner, /inspectAcpArtifactRuntime\(imageA, "linux-x86_64"\)/);
  assert.match(owner, /exec: \[\], tcp_connect: \[\]/);
  assert.match(owner, /flag: "wx", mode: 0o700/);
  assert.doesNotMatch(owner, /process\.env|process\.kill\(|child\.kill\(|JSON\.parse|imageSelection|cleanup\(/);
  assert.equal((owner.match(/associations\.set\(/g) ?? []).length, 1);
  assert.equal((owner.match(/function launchOwned\(a: FixtureAssets \| StoredLaunchSelection,/g) ?? []).length, 1);
});

test("bound evidence stays excluded from production and normal native dispatch", async () => {
  const source = new URL("../src/", import.meta.url);
  for (const name of await readdir(source)) if (name.endsWith(".ts")) {
    assert.doesNotMatch(await readFile(new URL(name, source), "utf8"), /acp-probe-termination|prepareNativeBoundFixture|startNativeBoundFixture/);
  }
  const main = await readFile(new URL("../../../crates/govern-sup/src/main.rs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /probe_artifact|bound-transport-v1/);
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.doesNotMatch(pkg.scripts.test, /native|artifact-binding\.native/);
});
