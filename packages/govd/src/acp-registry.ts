// Registry data describes distributions, never permission to run a Runner.
// Format: https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md
// Schema: https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json
// No downloads, extraction, installation, authentication, or process execution here.
import { isIP } from "node:net";

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export const ACP_REGISTRY_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, agents: 512, id: 96,
  version: 64, text: 8192, url: 2048, args: 64, argument: 1024, env: 32 });
export const ACP_PLATFORMS = Object.freeze(["darwin-aarch64", "darwin-x86_64", "linux-aarch64",
  "linux-x86_64", "windows-aarch64", "windows-x86_64"] as const);
export type AcpPlatform = typeof ACP_PLATFORMS[number];
export type AcpRecipeKind = "binary" | "npx" | "uvx";
export interface AcpPackageRecipe {
  readonly package: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export interface AcpBinaryRecipe {
  readonly archive: string;
  readonly sha256?: string;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
export interface AcpDistribution {
  readonly binary?: Readonly<Partial<Record<AcpPlatform, AcpBinaryRecipe>>>;
  readonly npx?: AcpPackageRecipe;
  readonly uvx?: AcpPackageRecipe;
}
export interface AcpRegistryAgent {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly repository?: string;
  readonly website?: string;
  readonly authors?: readonly string[];
  readonly license?: string;
  readonly license_url?: string;
  readonly icon?: string;
  readonly distribution: AcpDistribution;
}
export interface AcpRegistry {
  readonly version: "1.0.0";
  readonly agents: readonly AcpRegistryAgent[];
}

function fail(path: string, reason: string): never { throw new Error(`ACP registry ${path}: ${reason}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  if (Object.keys(value).some(k => !allowed.includes(k))) fail(path, "unsupported field");
}
function text(value: unknown, path: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) ||
      /[\u0000-\u001f\u007f]/u.test(value)) fail(path, "invalid or oversized string");
  return value;
}
// Match the registry schema literally, including date-style versions with leading zeros.
const stableVersion = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const packageVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
function version(value: unknown, path: string): string {
  const v = text(value, path, ACP_REGISTRY_LIMITS.version);
  if (!stableVersion.test(v)) fail(path, "expected exact stable X.Y.Z version");
  return v;
}
function uri(value: unknown, path: string): string {
  const s = text(value, path, ACP_REGISTRY_LIMITS.url);
  try { new URL(s); } catch { fail(path, "expected absolute URI"); }
  return s;
}
function strings(value: unknown, path: string, count: number, length: number): readonly string[] {
  if (!Array.isArray(value) || value.length > count) fail(path, "invalid or oversized array");
  return Object.freeze(value.map((v, i) => text(v, `${path}[${i}]`, length, true)));
}
function environment(value: unknown, path: string): Readonly<Record<string, string>> {
  const input = value === undefined ? {} : object(value, path);
  if (Object.keys(input).length > ACP_REGISTRY_LIMITS.env) fail(path, "too many environment variables");
  const env: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(input)) {
    if (k.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(k) || k === "__proto__") fail(path, "invalid environment key");
    env[k] = text(v, path, ACP_REGISTRY_LIMITS.argument, true);
  }
  return Object.freeze(env);
}
function recipe(value: unknown, path: string, binary: true): AcpBinaryRecipe;
function recipe(value: unknown, path: string, binary: false): AcpPackageRecipe;
function recipe(value: unknown, path: string, binary: boolean): AcpBinaryRecipe | AcpPackageRecipe {
  const o = object(value, path);
  keys(o, binary ? ["archive", "cmd", "sha256", "args", "env"] : ["package", "args", "env"], path);
  const args = o.args === undefined ? Object.freeze([] as string[]) :
    strings(o.args, `${path}.args`, ACP_REGISTRY_LIMITS.args, ACP_REGISTRY_LIMITS.argument);
  const env = environment(o.env, `${path}.env`);
  if (!binary) return Object.freeze({ package: text(o.package, `${path}.package`, ACP_REGISTRY_LIMITS.argument), args, env });
  const sha256 = o.sha256 === undefined ? undefined : text(o.sha256, `${path}.sha256`, 64);
  if (sha256 !== undefined && !/^[a-fA-F0-9]{64}$/u.test(sha256)) fail(path, "invalid SHA-256");
  return Object.freeze({ archive: uri(o.archive, `${path}.archive`),
    cmd: text(o.cmd, `${path}.cmd`, ACP_REGISTRY_LIMITS.argument), sha256, args, env });
}
function distribution(value: unknown, path: string): AcpDistribution {
  const o = object(value, path);
  keys(o, ["binary", "npx", "uvx"], path);
  if (!Object.keys(o).length) fail(path, "empty distribution");
  const out: { binary?: Partial<Record<AcpPlatform, AcpBinaryRecipe>>; npx?: AcpPackageRecipe; uvx?: AcpPackageRecipe } = {};
  if (o.binary !== undefined) {
    const b = object(o.binary, `${path}.binary`);
    keys(b, ACP_PLATFORMS, `${path}.binary`);
    if (!Object.keys(b).length) fail(path, "empty binary targets");
    const targets: Partial<Record<AcpPlatform, AcpBinaryRecipe>> = {};
    for (const p of ACP_PLATFORMS) if (b[p] !== undefined) targets[p] = recipe(b[p], `${path}.binary.${p}`, true);
    out.binary = Object.freeze(targets);
  }
  if (o.npx !== undefined) out.npx = recipe(o.npx, `${path}.npx`, false);
  if (o.uvx !== undefined) out.uvx = recipe(o.uvx, `${path}.uvx`, false);
  return Object.freeze(out);
}

/** Decode only the published stable v1 JSON encoding. Errors never echo untrusted values. */
export function decodeAcpRegistry(json: string): AcpRegistry {
  if (typeof json !== "string" || json.length > ACP_REGISTRY_LIMITS.bytes ||
      Buffer.byteLength(json, "utf8") > ACP_REGISTRY_LIMITS.bytes) fail("document", "byte limit exceeded");
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { fail("document", "invalid JSON"); }
  const root = object(parsed, "document");
  keys(root, ["version", "agents", "extensions"], "document");
  if (root.version !== "1.0.0") fail("version", "unsupported registry version");
  // The official builder currently emits extensions: []. No extension encoding is enabled.
  if (root.extensions !== undefined && (!Array.isArray(root.extensions) || root.extensions.length))
    fail("extensions", "unsupported extensions");
  if (!Array.isArray(root.agents) || root.agents.length > ACP_REGISTRY_LIMITS.agents) fail("agents", "invalid or oversized array");
  const seen = new Set<string>();
  const agents = root.agents.map((value, i): AcpRegistryAgent => {
    const path = `agents[${i}]`, o = object(value, path);
    keys(o, ["id", "name", "version", "description", "repository", "website", "authors", "license",
      "license_url", "icon", "distribution"], path);
    const id = text(o.id, `${path}.id`, ACP_REGISTRY_LIMITS.id);
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) fail(path, "invalid agent ID");
    if (seen.has(id)) fail(path, "duplicate agent ID");
    seen.add(id);
    const agent: AcpRegistryAgent = {
      id, name: text(o.name, `${path}.name`, 256), version: version(o.version, `${path}.version`),
      description: text(o.description, `${path}.description`, ACP_REGISTRY_LIMITS.text),
      distribution: distribution(o.distribution, `${path}.distribution`),
      ...(o.authors === undefined ? {} : { authors: strings(o.authors, `${path}.authors`, 64, 256) }),
      ...(o.license === undefined ? {} : { license: text(o.license, `${path}.license`, 256) }),
      ...Object.fromEntries(["repository", "website", "license_url", "icon"].filter(k => o[k] !== undefined)
        .map(k => [k, uri(o[k], `${path}.${k}`)])),
    };
    if (id !== "dimcode" && !agent.license_url) fail(path, "missing license_url");
    return Object.freeze(agent);
  });
  return Object.freeze({ version: "1.0.0", agents: Object.freeze(agents) });
}

export function inspectAcpAgent(registry: AcpRegistry, id: string): AcpRegistryAgent | undefined {
  return registry.agents.find(agent => agent.id === id);
}
export function searchAcpRegistry(registry: AcpRegistry, query: string, limit = 50): readonly AcpRegistryAgent[] {
  const q = text(query, "query", 256, true).trim().toLowerCase();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("search", "limit must be 1..100");
  return Object.freeze(registry.agents.filter(a => [a.id, a.name, a.description].some(v => v.toLowerCase().includes(q))).slice(0, limit));
}
/** Node arch names map only to their exact advertised targets; no emulation or OS fallback. */
export function acpPlatform(platform: string, arch: string): AcpPlatform | undefined {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  const target = `${os}-${cpu}`;
  return ACP_PLATFORMS.find(p => p === target);
}

export interface AcpInstallPlan {
  readonly agentId: string;
  readonly name: string;
  readonly version: string;
  readonly kind: AcpRecipeKind;
  readonly platform: AcpPlatform;
  readonly packageName: string | null;
  readonly packageSpec: string | null;
  readonly source: string;
  readonly checksum: Readonly<{ algorithm: "sha256"; value: string }> | null;
  readonly integrity: "sha256" | "exact-version";
  readonly archiveFormat: "zip" | "tar.gz" | "tar.bz2" | "raw" | null;
  /** Advertised distribution invocation as argv, never shell text or install authorization. */
  readonly command: readonly string[];
}
export type AcpPlanResult = Readonly<{ supported: true; plan: AcpInstallPlan }> |
  Readonly<{ supported: false; reason: string }>;
function unsupported(reason: string): AcpPlanResult { return Object.freeze({ supported: false, reason }); }
function publicHttps(source: string): boolean {
  try {
    const u = new URL(source), host = u.hostname.replace(/\.$/u, "");
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443") &&
      !/\s/u.test(source) && host.includes(".") && !isIP(host) && !host.startsWith("[") &&
      !/(^|\.)(localhost|localhost\.localdomain|local|internal|test|invalid)$/iu.test(host);
  } catch { return false; }
}

/** Pure Gate presentation data. Success does not authorize installation or Runner execution. */
export function planAcpInstall(agent: AcpRegistryAgent, platform: AcpPlatform, kind?: AcpRecipeKind): AcpPlanResult {
  if (!ACP_PLATFORMS.includes(platform)) return unsupported("Unsupported platform/architecture");
  const available = (["binary", "npx", "uvx"] as const).filter(k => k === "binary" ? agent.distribution.binary?.[platform] : agent.distribution[k]);
  if (kind === undefined && available.length > 1) return unsupported("Multiple recipes available; choose a distribution explicitly");
  const selected = kind ?? available[0];
  if (!selected || !available.includes(selected)) return unsupported("No advertised recipe for the exact platform and distribution");
  const base = { agentId: agent.id, name: agent.name, version: agent.version, kind: selected, platform };
  let plan: AcpInstallPlan;
  if (selected === "binary") {
    const r = agent.distribution.binary![platform]!;
    if (!r.sha256) return unsupported("Binary recipe requires SHA-256 integrity");
    if (!publicHttps(r.archive)) return unsupported("Binary source must be a public HTTPS URL without credentials or fragments");
    const url = new URL(r.archive);
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { return unsupported("Unsupported binary URL encoding"); }
    if (/(^|\/)latest(\/|$)/iu.test(path)) return unsupported("Binary source must not use a latest release URL");
    const leaf = path.slice(path.lastIndexOf("/") + 1);
    const archiveFormat = /\.zip$/iu.test(leaf) ? "zip" : /\.(tar\.gz|tgz)$/iu.test(leaf) ? "tar.gz" :
      /\.(tar\.bz2|tbz2)$/iu.test(leaf) ? "tar.bz2" : /^[A-Za-z0-9_-]+(?:\.exe)?$/u.test(leaf) ? "raw" : undefined;
    if (!archiveFormat) return unsupported("Unsupported or unclear binary archive format");
    const release = path.match(/\/(?:download|releases)\/v?([0-9]+\.[0-9]+\.[0-9]+)\//u);
    if (release && release[1] !== agent.version) return unsupported("Binary source version differs from the agent version");
    if (!/^(?:\.\/)?[A-Za-z0-9_+-][A-Za-z0-9_.+-]*(?:\/[A-Za-z0-9_.+-]+)*$/u.test(r.cmd) ||
        r.cmd.split("/").some(p => p === "..") || /\.(cmd|bat|ps1)$/iu.test(r.cmd))
      return unsupported("Binary command must be a relative executable path; shell and Windows script recipes are unsupported");
    if (Object.keys(r.env).length) return unsupported("Registry environment overrides require an audited policy and are unsupported");
    plan = { ...base, packageName: null, packageSpec: null, source: r.archive,
      checksum: Object.freeze({ algorithm: "sha256", value: r.sha256 }), integrity: "sha256",
      archiveFormat,
      command: Object.freeze([r.cmd, ...r.args]) };
  } else {
    const r = agent.distribution[selected]!;
    if (Object.keys(r.env).length) return unsupported("Registry environment overrides require an audited policy and are unsupported");
    // No git/URL/path specs, ranges, tags, extras or inferred versions. uv supports both
    // exact pins: https://docs.astral.sh/uv/guides/tools/#requesting-specific-versions
    const m = selected === "npx" ? r.package.match(/^((?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*)@([0-9]+\.[0-9]+\.[0-9]+)$/u) :
      r.package.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:==|@)([0-9]+\.[0-9]+\.[0-9]+)$/u);
    if (!m || !packageVersion.test(m[2])) return unsupported("Package recipe must use an explicit exact version (npm name@X.Y.Z or uv name==X.Y.Z/name@X.Y.Z)");
    if (m[2] !== agent.version) return unsupported("Package version differs from the agent version");
    const source = selected === "npx" ? "https://registry.npmjs.org/" : "https://pypi.org/simple/";
    plan = { ...base, packageName: m[1], packageSpec: r.package, source, checksum: null, integrity: "exact-version", archiveFormat: null,
      command: Object.freeze([selected, r.package, ...r.args]) };
  }
  return Object.freeze({ supported: true, plan: Object.freeze(plan) });
}

export interface AcpSafetyProfile {
  readonly agentId: string;
  readonly version: string;
  readonly platforms: readonly AcpPlatform[];
  readonly status: "blocked" | "audited";
  readonly authentication: "subscription" | "env_var";
  readonly blockers: readonly string[];
  readonly checks: Readonly<{ noBind: boolean; isolatedHome: boolean; projectConfigRefused: boolean;
    delegationDisabled: boolean; freshSessions: boolean; emptyRunnerMcp: boolean; allowOnceOnly: boolean }>;
  readonly usage: "counted" | "provider";
}
export const ACP_SAFETY_PROFILES: readonly AcpSafetyProfile[] = Object.freeze([Object.freeze({
  agentId: "opencode", version: "1.18.34", platforms: ACP_PLATFORMS, status: "blocked" as const,
  authentication: "subscription" as const, usage: "counted" as const,
  blockers: Object.freeze(["ACP starts an internal HTTP listener, conflicting with Runner no-bind",
    "Sandbox isolation, subscription connection, metering and process cleanup are not live-verified"]),
  checks: Object.freeze({ noBind: false, isolatedHome: false, projectConfigRefused: false,
    delegationDisabled: false, freshSessions: false, emptyRunnerMcp: false, allowOnceOnly: false }),
})]);
export interface AcpEligibilityContext {
  readonly platform: AcpPlatform;
  readonly authentication: "subscription" | "env_var";
  readonly connected: boolean;
  readonly countedBudgetReady: boolean;
  readonly providerUsageReady: boolean;
}
export type AcpRunnerEligibility = Readonly<{ eligible: boolean; reasons: readonly string[] }>;
/** Profiles are trusted local policy, never a field decoded from registry data. No default eligible agents. */
export function acpRunnerEligibility(agent: Pick<AcpRegistryAgent, "id" | "version">, context: AcpEligibilityContext,
  profiles: readonly AcpSafetyProfile[] = ACP_SAFETY_PROFILES): AcpRunnerEligibility {
  const matches = profiles.filter(p => p.agentId === agent.id && p.version === agent.version);
  const reasons: string[] = [];
  if (matches.length !== 1) reasons.push(matches.length ? "Ambiguous safety profiles" : "No safety profile for this exact agent version");
  else {
    const p = matches[0];
    if (p.status !== "audited") reasons.push("Safety profile is blocked or unaudited");
    reasons.push(...p.blockers);
    if (!p.platforms.includes(context.platform)) reasons.push("Safety profile does not cover this exact platform");
    if (p.authentication !== "subscription") reasons.push("Profile requires unsupported API-key authentication");
    const required = ["noBind", "isolatedHome", "projectConfigRefused", "delegationDisabled", "freshSessions", "emptyRunnerMcp", "allowOnceOnly"] as const;
    for (const check of required) if (p.checks[check] !== true) reasons.push(`Safety profile check is unverified: ${check}`);
    if (p.usage === "counted" ? context.countedBudgetReady !== true : p.usage === "provider" ? context.providerUsageReady !== true : true)
      reasons.push("Required usage budget/measurement is not ready");
  }
  if (context.authentication !== "subscription") reasons.push("API-key authentication is not supported");
  if (context.connected !== true) reasons.push("Subscription connection is not verified");
  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}
