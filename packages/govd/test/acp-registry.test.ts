import { test } from "node:test";
import assert from "node:assert/strict";
import { ACP_REGISTRY_LIMITS, ACP_REGISTRY_URL, ACP_PLATFORMS, ACP_SAFETY_PROFILES,
  decodeAcpRegistry, inspectAcpAgent, searchAcpRegistry, acpPlatform, planAcpInstall, acpRunnerEligibility } from "../src/acp-registry.ts";
import type { AcpSafetyProfile, AcpEligibilityContext, AcpRegistryAgent } from "../src/acp-registry.ts";

// Invented data only. No fixture commands are executed and no network is used by tests.
const digest = "ab".repeat(32);
const binary = (changes = {}) => ({ archive: "https://downloads.example.org/v1.2.3/fixture.tar.gz",
  sha256: digest, cmd: "./bin/fixture", args: ["acp"], ...changes });
const entry = (changes = {}) => ({ id: "fixture-agent", name: "Fixture Agent", version: "1.2.3",
  description: "Invented editor assistant", license_url: "https://example.org/LICENSE",
  distribution: { binary: { "linux-x86_64": binary() } }, ...changes });
const document = (agents: unknown[] = [entry()], changes = {}) => JSON.stringify({ version: "1.0.0", agents, extensions: [], ...changes });
const agent = (changes = {}): AcpRegistryAgent => decodeAcpRegistry(document([entry(changes)])).agents[0];
const linux = "linux-x86_64" as const;
const context: AcpEligibilityContext = { platform: linux, authentication: "subscription", connected: true,
  countedBudgetReady: true, providerUsageReady: false };
const profile: AcpSafetyProfile = { agentId: "fixture-agent", version: "1.2.3", platforms: [linux],
  status: "audited", authentication: "subscription", usage: "counted", blockers: [],
  checks: { noBind: true, isolatedHome: true, projectConfigRefused: true, delegationDisabled: true,
    freshSessions: true, emptyRunnerMcp: true, allowOnceOnly: true } };

test("published stable v1 shape is decoded, copied and recursively immutable", () => {
  const input = entry({ authors: ["Fixture Author"], repository: "https://example.org/source", website: "https://example.org",
    icon: "https://example.org/icon.svg", license: "MIT" });
  const r = decodeAcpRegistry(document([input]));
  assert.equal(r.version, "1.0.0");
  assert.equal(ACP_REGISTRY_URL, "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json");
  assert.equal(r.agents[0].id, input.id);
  assert.throws(() => (r.agents as AcpRegistryAgent[]).push(r.agents[0]), TypeError);
  assert.throws(() => Object.assign(r.agents[0], { version: "9.9.9" }), TypeError);
  assert.throws(() => Object.assign(r.agents[0].distribution.binary![linux]!, { sha256: "00" }), TypeError);
  assert.throws(() => (r.agents[0].distribution.binary![linux]!.args as string[]).push("changed"), TypeError);
  assert.throws(() => Object.assign(r.agents[0].authors!, { 0: "changed" }), TypeError);
  assert.equal(agent({ version: "2026.10.01" }).version, "2026.10.01"); // schema encoding, not npm semver inference
});

test("decoder rejects malformed JSON, roots, versions, extensions and oversized documents", () => {
  for (const bad of ["{", "null", "[]", document([], { version: "2.0.0" }), document([], { version: 1 }),
    document([], { agents: {} }), document([], { extensions: [{}] }), document([], { extensions: {} }),
    document([], { preview: true }), " ".repeat(ACP_REGISTRY_LIMITS.bytes + 1),
    document([entry({ description: "é".repeat(ACP_REGISTRY_LIMITS.bytes / 2) })])])
    assert.throws(() => decodeAcpRegistry(bad), /ACP registry/);
  assert.throws(() => decodeAcpRegistry(document(Array.from({ length: ACP_REGISTRY_LIMITS.agents + 1 }, (_, i) => entry({ id: `fixture-${i}` })))), /oversized/);
});

test("identity validation refuses duplicate, malformed and oversized IDs and versions", () => {
  assert.throws(() => decodeAcpRegistry(document([entry(), entry({ version: "2.3.4" })])), /duplicate/);
  for (const id of ["", "Fixture", "9fixture", "../fixture", "fixture_agent", "fixture\n", "a".repeat(ACP_REGISTRY_LIMITS.id + 1), null])
    assert.throws(() => agent({ id }), /ACP registry/);
  for (const version of ["", "latest", "v1.2.3", "1.2", "1.2.3-beta.1", "1.2.3+build", "1.2.3\n", "1".repeat(65), 123])
    assert.throws(() => agent({ version }), /ACP registry/);
});

test("required metadata and known recipe structures are strict; unknown encodings are refused", () => {
  for (const changes of [{ name: "" }, { description: "" }, { license_url: undefined }, { license_url: "relative" },
    { authors: [12] }, { safetyProfile: profile }, { distribution: {} }, { distribution: { npm: { package: "fixture@1.2.3" } } },
    { distribution: { binary: {} } }, { distribution: { binary: { "linux-arm64": binary() } } },
    { distribution: { binary: { [linux]: binary({ extra: true }) } } },
    { distribution: { binary: { [linux]: binary({ archive: null }) } } },
    { distribution: { binary: { [linux]: binary({ args: "acp" }) } } },
    { distribution: { binary: { [linux]: binary({ args: [3] }) } } },
    { distribution: { npx: { package: "fixture@1.2.3", command: "fixture" } } },
    { distribution: { uvx: { args: [] } } }]) assert.throws(() => agent(changes), /ACP registry/);
  // The published schema explicitly exempts this ID from the license URL requirement.
  assert.equal(agent({ id: "dimcode", license_url: undefined }).id, "dimcode");
});

test("all scalar and recipe collection limits are enforced", () => {
  for (const changes of [{ name: "x".repeat(257) }, { description: "x".repeat(ACP_REGISTRY_LIMITS.text + 1) },
    { repository: `https://example.org/${"x".repeat(ACP_REGISTRY_LIMITS.url)}` },
    { authors: Array(65).fill("Author") },
    { distribution: { npx: { package: "x".repeat(1025) } } },
    { distribution: { binary: { [linux]: binary({ args: Array(65).fill("arg") }) } } },
    { distribution: { binary: { [linux]: binary({ args: ["x".repeat(1025)] }) } } },
    { distribution: { npx: { package: "fixture@1.2.3", env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`VAR_${i}`, "x"])) } } },
    { distribution: { npx: { package: "fixture@1.2.3", env: { "bad-key": "x" } } } },
    { distribution: { npx: { package: "fixture@1.2.3", env: { KEY: 5 } } } }]) assert.throws(() => agent(changes), /ACP registry/);
});

test("search and inspection are bounded, case-insensitive data operations", () => {
  const r = decodeAcpRegistry(document([entry(), entry({ id: "second", name: "Other", description: "A search fixture" })]));
  assert.equal(inspectAcpAgent(r, "fixture-agent"), r.agents[0]);
  assert.equal(inspectAcpAgent(r, "Fixture-agent"), undefined);
  assert.equal(inspectAcpAgent(r, "missing"), undefined);
  assert.deepEqual(searchAcpRegistry(r, " EDITOR "), [r.agents[0]]);
  assert.equal(searchAcpRegistry(r, "fixture", 1).length, 1);
  assert.deepEqual(searchAcpRegistry(r, "absent"), []);
  assert.equal(searchAcpRegistry(r, "").length, 2);
  assert.ok(Object.isFrozen(searchAcpRegistry(r, "")));
  for (const limit of [0, 101, NaN, 1.5]) assert.throws(() => searchAcpRegistry(r, "", limit), /limit/);
  assert.throws(() => searchAcpRegistry(r, "x".repeat(257)), /oversized/);
});

test("platform mapping uses exact OS and architecture without fallback", () => {
  assert.equal(acpPlatform("linux", "x64"), linux);
  assert.equal(acpPlatform("darwin", "arm64"), "darwin-aarch64");
  assert.equal(acpPlatform("win32", "x64"), "windows-x86_64");
  assert.equal(acpPlatform("windows", "aarch64"), "windows-aarch64");
  for (const [os, arch] of [["linux", "ia32"], ["linux", "arm"], ["freebsd", "x64"], ["macos", "arm64"]])
    assert.equal(acpPlatform(os, arch), undefined);
  assert.equal(planAcpInstall(agent(), "linux-aarch64").supported, false);
  assert.equal(planAcpInstall(agent(), "windows-x86_64").supported, false);
});

test("binary plans preserve exact metadata, checksum and argv and cannot mutate decoded data", () => {
  const a = agent(), result = planAcpInstall(a, linux);
  assert.equal(result.supported, true);
  if (!result.supported) return;
  assert.deepEqual(result.plan, { agentId: "fixture-agent", name: "Fixture Agent", version: "1.2.3", kind: "binary", platform: linux,
    source: "https://downloads.example.org/v1.2.3/fixture.tar.gz", checksum: { algorithm: "sha256", value: digest },
    integrity: "sha256", archiveFormat: "tar.gz", packageName: null, packageSpec: null, command: ["./bin/fixture", "acp"] });
  assert.throws(() => Object.assign(result.plan, { source: "https://other.example.org" }), TypeError);
  assert.throws(() => Object.assign(result.plan.checksum!, { value: "00" }), TypeError);
  assert.throws(() => (result.plan.command as string[]).push("--other"), TypeError);
  assert.ok(Object.isFrozen(result));
});

test("missing and malformed binary checksums fail closed with explicit reasons", () => {
  const missing = planAcpInstall(agent({ distribution: { binary: { [linux]: binary({ sha256: undefined }) } } }), linux);
  assert.equal(missing.supported, false);
  if (!missing.supported) assert.match(missing.reason, /SHA-256/);
  for (const sha256 of ["", "ab".repeat(31), "ab".repeat(33), "z".repeat(64), 64])
    assert.throws(() => agent({ distribution: { binary: { [linux]: binary({ sha256 }) } } }), /ACP registry/);
  const upper = planAcpInstall(agent({ distribution: { binary: { [linux]: binary({ sha256: digest.toUpperCase() }) } } }), linux);
  assert.equal(upper.supported, true);
});

test("unsafe sources and unsupported archive formats remain inspectable without plans", () => {
  for (const archive of ["http://example.org/fixture.zip", "file:///fixture.zip", "https://user:pass@example.org/fixture.zip",
    "https://example.org:8443/fixture.zip", "https://example.org/fixture.zip#fragment", "https://localhost/fixture.zip",
    "https://127.0.0.1/fixture.zip", "https://203.0.113.10/fixture.zip", "https://[::1]/fixture.zip",
    "https://agent.local/fixture.zip", "https://agent.local./fixture.zip", "https://localhost./fixture.zip",
    "https://localhost.localdomain/fixture.zip", "https://example.org/latest/fixture.zip", "https://example.org/%6catest/fixture.zip",
    "https://example.org/releases/download/v9.9.9/fixture.zip", "https://example.org/fixture.dmg",
    "https://example.org/fixture.msi", "https://example.org/fixture.7z", "https://example.org/fixture.tar.zst"])
    assert.equal(planAcpInstall(agent({ distribution: { binary: { [linux]: binary({ archive }) } } }), linux).supported, false, archive);
  for (const suffix of ["zip", "tar.gz", "tgz", "tar.bz2", "tbz2"])
    assert.equal(planAcpInstall(agent({ distribution: { binary: { [linux]: binary({ archive: `https://example.org/fixture.${suffix}` }) } } }), linux).supported, true);
  assert.equal(planAcpInstall(agent({ distribution: { binary: { [linux]: binary({ archive: "https://example.org/fixture" }) } } }), linux).supported, true);
  assert.equal(planAcpInstall(agent({ distribution: { binary: { "windows-x86_64": binary({ cmd: "fixture.exe", archive: "https://example.org/fixture.exe" }) } } }), "windows-x86_64").supported, true);
});

test("commands are executable paths and argument data, never parsed shell commands", () => {
  for (const cmd of ["/usr/bin/fixture", "../fixture", "./bin/../fixture", "./fixture;id", "sh -c id", "C:\\fixture.exe", "./bin\\fixture.exe", "fixture.cmd"])
    assert.equal(planAcpInstall(agent({ distribution: { binary: { [linux]: binary({ cmd }) } } }), linux).supported, false, cmd);
  const r = planAcpInstall(agent({ distribution: { binary: { [linux]: binary({ args: ["acp", "literal;$(ignored)"] }) } } }), linux);
  assert.equal(r.supported, true);
  if (r.supported) assert.deepEqual(r.plan.command, ["./bin/fixture", "acp", "literal;$(ignored)"]);
});

test("npm and uv plans require explicit package pins exactly matching the agent version", () => {
  for (const [kind, spec, name, source] of [["npx", "@fixture/agent@1.2.3", "@fixture/agent", "https://registry.npmjs.org/"],
    ["npx", "fixture-agent@1.2.3", "fixture-agent", "https://registry.npmjs.org/"],
    ["uvx", "fixture-agent==1.2.3", "fixture-agent", "https://pypi.org/simple/"],
    ["uvx", "fixture-agent@1.2.3", "fixture-agent", "https://pypi.org/simple/"]] as const) {
    const r = planAcpInstall(agent({ distribution: { [kind]: { package: spec, args: ["--acp"] } } }), linux);
    assert.equal(r.supported, true);
    if (!r.supported) continue;
    assert.equal(r.plan.packageName, name); assert.equal(r.plan.packageSpec, spec); assert.equal(r.plan.source, source);
    assert.equal(r.plan.checksum, null); assert.equal(r.plan.integrity, "exact-version"); assert.equal(r.plan.archiveFormat, null);
    assert.deepEqual(r.plan.command, [kind, spec, "--acp"]);
  }
  for (const spec of ["fixture", "fixture@latest", "fixture@^1.2.3", "fixture@~1.2.3", "fixture@*", "fixture@2.3.4",
    "fixture@1.2.3-beta", "fixture@1.2.03", "npm:fixture@1.2.3", "file:./fixture", "git+https://example.org/fixture",
    "https://example.org/fixture.tgz", "--package=fixture@1.2.3", "fixture@1.2.3 --yes"])
    assert.equal(planAcpInstall(agent({ distribution: { npx: { package: spec } } }), linux).supported, false, spec);
  for (const spec of ["fixture", "fixture@latest", "fixture@2.3.4", "fixture>=1.2.3", "fixture~=1.2.3", "fixture==1.*", "fixture==2.3.4",
    "fixture[extra]==1.2.3", "fixture==1.2.3;python_version>3", "fixture @ https://example.org/fixture.whl"])
    assert.equal(planAcpInstall(agent({ distribution: { uvx: { package: spec } } }), linux).supported, false, spec);
});

test("package-manager selection is explicit when multiple advertised recipes match", () => {
  const a = agent({ distribution: { binary: { [linux]: binary() }, npx: { package: "fixture@1.2.3" }, uvx: { package: "fixture==1.2.3" } } });
  const r = planAcpInstall(a, linux);
  assert.equal(r.supported, false); if (!r.supported) assert.match(r.reason, /choose/);
  for (const kind of ["binary", "npx", "uvx"] as const) assert.equal(planAcpInstall(a, linux, kind).supported, true);
  assert.equal(planAcpInstall(a, "darwin-aarch64", "binary").supported, false);
  assert.equal(planAcpInstall(agent(), linux, "uvx").supported, false);
});

test("registry environment data is immutable and unsupported for installation plans", () => {
  for (const distribution of [{ binary: { [linux]: binary({ env: { FIXTURE_MODE: "readonly" } }) } },
    { npx: { package: "fixture@1.2.3", env: { NODE_OPTIONS: "placeholder" } } },
    { uvx: { package: "fixture==1.2.3", env: { FIXTURE_MODE: "readonly" } } }]) {
    const a = agent({ distribution }), r = planAcpInstall(a, linux);
    assert.equal(r.supported, false); if (!r.supported) assert.match(r.reason, /environment/);
  }
});

test("registry membership and supported plans grant no Runner eligibility", () => {
  const a = agent(); assert.equal(planAcpInstall(a, linux).supported, true);
  assert.equal(acpRunnerEligibility(a, context).eligible, false);
  assert.match(acpRunnerEligibility(a, context).reasons.join(" "), /exact agent version/);
  assert.equal(acpRunnerEligibility(a, context, [profile]).eligible, true);
  assert.equal(acpRunnerEligibility({ ...a, version: "1.2.4" }, context, [profile]).eligible, false);
  assert.equal(acpRunnerEligibility(a, context, [profile, profile]).eligible, false);
  assert.equal(acpRunnerEligibility(a, { ...context, platform: "linux-aarch64" }, [profile]).eligible, false);
});

test("profile blockers, readiness, authentication and usage are independent fail-closed requirements", () => {
  for (const p of [{ ...profile, status: "blocked" as const }, { ...profile, blockers: ["Unverified isolation"] },
    { ...profile, authentication: "env_var" as const }]) assert.equal(acpRunnerEligibility(agent(), context, [p]).eligible, false);
  for (const key of Object.keys(profile.checks) as (keyof AcpSafetyProfile["checks"])[])
    assert.equal(acpRunnerEligibility(agent(), context, [{ ...profile, checks: { ...profile.checks, [key]: false } }]).eligible, false, key);
  for (const c of [{ ...context, authentication: "env_var" as const }, { ...context, connected: false },
    { ...context, countedBudgetReady: false }]) assert.equal(acpRunnerEligibility(agent(), c, [profile]).eligible, false);
  const measured = { ...profile, usage: "provider" as const };
  assert.equal(acpRunnerEligibility(agent(), context, [measured]).eligible, false);
  assert.equal(acpRunnerEligibility(agent(), { ...context, providerUsageReady: true }, [measured]).eligible, true);
  assert.ok(Object.isFrozen(acpRunnerEligibility(agent(), context).reasons));
});

test("OpenCode has only a blocked version-bound descriptor, including its no-bind conflict", () => {
  const blocked = acpRunnerEligibility({ id: "opencode", version: "1.18.34" }, context);
  assert.equal(blocked.eligible, false); assert.match(blocked.reasons.join(" "), /HTTP listener.*no-bind/);
  assert.equal(acpRunnerEligibility({ id: "opencode", version: "1.18.35" }, context).eligible, false);
  assert.ok(ACP_SAFETY_PROFILES.every(p => p.status === "blocked"));
  assert.ok(Object.isFrozen(ACP_SAFETY_PROFILES)); assert.ok(Object.isFrozen(ACP_SAFETY_PROFILES[0].checks));
  assert.ok(Object.isFrozen(ACP_PLATFORMS));
});
