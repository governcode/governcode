import { test } from "node:test";
import assert from "node:assert/strict";
import { ACP_REGISTRY_URL, decodeAcpRegistry, planAcpInstall, type AcpInstallPlan } from "../src/acp-registry.ts";
import { executableInstallSupport, installFingerprint, snapshotInstallRequest } from "../src/acp-install-plan.ts";

const catalog = { source: ACP_REGISTRY_URL, sha256: "ab".repeat(32), fetchedAt: "2026-01-02T03:04:05Z" };
const recipe = (): AcpInstallPlan => ({ agentId: "fixture-agent", name: "Fixture Agent", version: "1.2.3", kind: "binary",
  platform: "linux-x86_64", packageName: null, packageSpec: null, source: "https://downloads.example.org/v1.2.3/fixture",
  checksum: { algorithm: "sha256", value: "cd".repeat(32) }, integrity: "sha256", archiveFormat: "raw", command: ["./fixture", "acp"] });

test("executor supports only checksummed raw binaries for the actual Linux architecture", () => {
  const plan = recipe();
  assert.equal(executableInstallSupport(plan, "linux", "x64").supported, true);
  for (const changed of [{ platform: "linux-aarch64" }, { archiveFormat: "tar.gz" }, { kind: "npx" },
    { checksum: null }, { integrity: "exact-version" }, { command: ["./bin/fixture"] },
    { source: "https://user:pass@example.org/fixture" }, { source: "https://127.0.0.1/fixture" }])
    assert.equal(executableInstallSupport({ ...plan, ...changed } as AcpInstallPlan, "linux", "x64").supported, false);
  assert.equal(executableInstallSupport(plan, "darwin", "x64").supported, false);
});

test("review fingerprint binds catalog and every distribution value, independent of refresh time", () => {
  const plan = recipe(), original = installFingerprint(catalog, plan);
  assert.equal(installFingerprint({ ...catalog, fetchedAt: "2026-01-03T03:04:05Z" }, plan), original);
  assert.notEqual(installFingerprint({ ...catalog, sha256: "ef".repeat(32) }, plan), original);
  for (const changed of [{ source: "https://downloads.example.org/other" }, { name: "Other Name" },
    { version: "2.0.0" }, { command: ["./fixture", "--other"] }, { checksum: { algorithm: "sha256", value: "ef".repeat(32) } }])
    assert.notEqual(installFingerprint(catalog, { ...plan, ...changed } as AcpInstallPlan), original);
});

test("empty command arguments remain inspectable and participate in the reviewed binding", () => {
  const plan = { ...recipe(), command: ["./fixture", ""] };
  assert.equal(executableInstallSupport(plan, "linux", "x64").supported, true);
  const fingerprint = installFingerprint(catalog, plan);
  assert.notEqual(fingerprint, installFingerprint(catalog, { ...plan, command: ["./fixture"] }));
  assert.deepEqual(snapshotInstallRequest({ operation: "I-1", catalog, plan, fingerprint }).plan.command, ["./fixture", ""]);
});

test("full package launcher and 64 arguments remain fingerprintable for passive inspection", () => {
  for (const kind of ["npx", "uvx"] as const) {
    const registry = decodeAcpRegistry(JSON.stringify({ version: "1.0.0", agents: [{ id: "fixture-agent",
      name: "Fixture Agent", version: "1.2.3", description: "Invented fixture", license_url: "https://example.org/LICENSE",
      distribution: { [kind]: { package: kind === "npx" ? "fixture-agent@1.2.3" : "fixture-agent==1.2.3", args: Array(64).fill("") } },
    }] }));
    const result = planAcpInstall(registry.agents[0], "linux-x86_64", kind);
    assert.ok(result.supported);
    assert.equal(result.plan.command.length, 66);
    assert.match(installFingerprint(catalog, result.plan), /^[a-f0-9]{64}$/);
  }
});

test("review request owns its values across approval and refuses stale or malformed bindings", () => {
  const plan = recipe(), source = { operation: "I-1", catalog: { ...catalog }, plan, fingerprint: installFingerprint(catalog, plan) };
  const frozen = snapshotInstallRequest(source);
  (plan.command as string[])[1] = "changed";
  source.catalog.sha256 = "00".repeat(32);
  assert.deepEqual(frozen.plan.command, ["./fixture", "acp"]);
  assert.equal(frozen.catalog.sha256, catalog.sha256);
  assert.throws(() => Object.assign(frozen.plan, { source: "changed" }));
  assert.throws(() => snapshotInstallRequest(source), /changed since inspection/);
  assert.throws(() => snapshotInstallRequest({ ...source, operation: "../outside" }));
});
