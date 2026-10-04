import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as fixture from "./fixtures/acp-probe-termination.ts";

const checks = fixture.syntheticLifetimeChecks();
for (const row of checks) test(`synthetic lifetime: ${row.name}`, () => {
  assert.equal(row.pass, true, JSON.stringify(row));
  assert.equal(row.capacity, 32);
  assert.ok(row.bytes <= 33);
  assert.equal("evidence" in row, false);
});

test("fixture owner has only fixed metadata checks and an owned-launch entry point", () => {
  assert.deepEqual(Object.keys(fixture).sort(), ["startNativeLifetimeFixture", "syntheticLifetimeChecks"]);
  assert.ok(checks.length >= 100);
});

test("assets are snapshotted without getters or proxy traps before any spawn", () => {
  let reads = 0;
  const assets = { driver: "/invented/driver", target: "/invented/target", policy: "/invented/policy", cwd: "/invented/cwd",
    env: { HOME: "/invented/home", TMPDIR: "/invented/tmp", PATH: "/usr/bin", LANG: "C", LC_ALL: "C" } } as const;
  const accessor = Object.defineProperty({ ...assets }, "driver", { get() { reads++; return "/invented/driver"; } });
  assert.throws(() => fixture.startNativeLifetimeFixture(accessor, "normal"));
  const proxy = new Proxy(assets, { get() { reads++; throw new Error("trap"); }, ownKeys() { reads++; throw new Error("trap"); } });
  assert.throws(() => fixture.startNativeLifetimeFixture(proxy, "normal"));
  assert.throws(() => fixture.startNativeLifetimeFixture({ ...assets, cwd: "relative" }, "normal"));
  assert.throws(() => fixture.startNativeLifetimeFixture({ ...assets, env: { ...assets.env, HOME: "relative" } }, "normal"));
  assert.throws(() => fixture.startNativeLifetimeFixture({ ...assets, env: { ...assets.env, PATH: "poison" } } as never, "normal"));
  assert.throws(() => fixture.startNativeLifetimeFixture(assets, "arbitrary" as never));
  assert.equal(reads, 0);
});

test("production and normal dispatch do not consume fixture evidence", async () => {
  const src = fileURLToPath(new URL("../src/", import.meta.url));
  for (const file of await readdir(src)) if (file.endsWith(".ts")) {
    const content = await readFile(`${src}/${file}`, "utf8");
    assert.doesNotMatch(content, /(?:import|export).*acp-probe-termination/);
  }
  const main = await readFile(new URL("../../../crates/govern-sup/src/main.rs", import.meta.url), "utf8");
  assert.doesNotMatch(main, /mod probe_lifetime|transport-v1/);
  const cargo = await readFile(new URL("../../../crates/govern-sup/Cargo.toml", import.meta.url), "utf8");
  assert.match(cargo, /name = "probe-lifetime-driver"[\s\S]*required-features = \["probe-lifetime-fixtures"\]/);
  const pkg = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.test, /\*\.test\.ts/);
  assert.doesNotMatch(pkg.scripts.test, /native/);
});

test("owned join is the sole evidence factory and stop only closes its private endpoint", async () => {
  const owner = await readFile(new URL("./fixtures/acp-probe-termination.ts", import.meta.url), "utf8");
  assert.equal((owner.match(/associations\.set\(/g) ?? []).length, 1);
  assert.match(owner, /child\.exitCode === 0 && child\.signalCode === null/);
  assert.match(owner, /detached: false, stdio: \["pipe", "pipe", "pipe", "pipe", "pipe"\]/);
  assert.match(owner, /randomBytes\(16\)/);
  assert.match(owner, /proof\.on\("end"/);
  assert.doesNotMatch(owner, /process\.kill\(|child\.kill\(|JSON\.parse|process\.env|cleanup\(/);
  assert.doesNotMatch(owner, /from .*acp-(?:install|catalog|registry|artifact|download)/);
  const driver = await readFile(new URL("../../../crates/govern-sup/tests/fixtures/probe_lifetime_driver.rs", import.meta.url), "utf8");
  assert.match(driver, /fn write_owned_termination\(/);
  assert.match(driver, /completion: (?:probe_lifetime::)?ProbeCompletion/);
});
