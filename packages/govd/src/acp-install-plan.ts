// A registry distribution plan and an executor's capabilities are separate. The first executor
// stores raw Linux ELF binaries only; an inspectable archive is not extractable by this installer.
import { createHash } from "node:crypto";
import { z } from "zod";
import { ACP_REGISTRY_URL, acpPlatform, type AcpInstallPlan } from "./acp-registry.ts";
import type { AcpCatalogIdentity, AcpInstallRequest } from "./acp-install-contract.ts";

const clean = (max: number) => z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/i);
const Catalog = z.object({ source: z.literal(ACP_REGISTRY_URL), sha256: digest,
  fetchedAt: clean(40).refine((value) => Number.isFinite(Date.parse(value)), "invalid catalog time") }).strict();
const Plan = z.object({
  agentId: clean(96).regex(/^[a-z][a-z0-9-]*$/), name: clean(256), version: clean(64),
  kind: z.enum(["binary", "npx", "uvx"]),
  platform: z.enum(["darwin-aarch64", "darwin-x86_64", "linux-aarch64", "linux-x86_64", "windows-aarch64", "windows-x86_64"]),
  packageName: clean(1024).nullable(), packageSpec: clean(1024).nullable(), source: clean(2048),
  checksum: z.object({ algorithm: z.literal("sha256"), value: digest }).strict().nullable(),
  integrity: z.enum(["sha256", "exact-version"]), archiveFormat: z.enum(["zip", "tar.gz", "tar.bz2", "raw"]).nullable(),
  command: z.array(z.string().max(1024).regex(/^[^\x00-\x1f\x7f]*$/)).min(1).max(66)
    .refine((command) => command[0].length > 0, "an executable name is required"),
}).strict();

export type AcpInstallSupport = { supported: true } | { supported: false; reason: string };
export function executableInstallSupport(plan: AcpInstallPlan, hostPlatform: string = process.platform,
  hostArch: string = process.arch): AcpInstallSupport {
  const refuse = (reason: string): AcpInstallSupport => ({ supported: false, reason });
  if (!Plan.safeParse(plan).success) return refuse("invalid distribution plan");
  const host = acpPlatform(hostPlatform, hostArch);
  if (hostPlatform !== "linux" || !host || plan.platform !== host) return refuse("installation supports only this Linux host's exact architecture");
  if (plan.kind !== "binary") return refuse("package-manager installation is not implemented");
  if (plan.archiveFormat !== "raw") return refuse("archive extraction is not implemented; only raw ELF binaries can be stored");
  if (!plan.checksum || plan.integrity !== "sha256" || plan.packageName !== null || plan.packageSpec !== null)
    return refuse("raw binaries require SHA-256 integrity and no package recipe");
  if (!/^(?:\.\/)?[A-Za-z0-9_+-][A-Za-z0-9_.+-]*$/u.test(plan.command[0]))
    return refuse("raw binary command must name one relative executable without directories");
  try {
    const source = new URL(plan.source), hostname = source.hostname.replace(/\.$/u, "");
    if (source.protocol !== "https:" || source.username || source.password || source.hash ||
        (source.port && source.port !== "443") || !hostname.includes(".") ||
        !/^[A-Za-z0-9.-]+$/u.test(hostname) || /^(?:\d+\.){3}\d+$/u.test(hostname) ||
        /(^|\.)(localhost|localhost\.localdomain|local|internal|test|invalid)$/iu.test(hostname))
      return refuse("raw binary source must use public HTTPS without credentials");
  } catch { return refuse("invalid binary source"); }
  return { supported: true };
}

/** Stable reviewed identity. Fetch time is provenance; refreshing identical bytes is not a new
 *  distribution. Every recipe field and the catalog source/digest participate in the binding. */
export function installFingerprint(catalog: AcpCatalogIdentity, plan: AcpInstallPlan): string {
  const c = Catalog.parse(catalog), p = Plan.parse(plan);
  return createHash("sha256").update(JSON.stringify({ source: c.source, catalogSha256: c.sha256.toLowerCase(),
    agentId: p.agentId, name: p.name, version: p.version, kind: p.kind, platform: p.platform,
    packageName: p.packageName, packageSpec: p.packageSpec, artifactSource: p.source,
    checksum: p.checksum && { algorithm: p.checksum.algorithm, value: p.checksum.value.toLowerCase() },
    integrity: p.integrity, archiveFormat: p.archiveFormat, command: p.command })).digest("hex");
}

/** Own the reviewed values across awaits: callers cannot change a source or hash after a Gate. */
export function snapshotInstallRequest(request: AcpInstallRequest): AcpInstallRequest {
  const checked = z.object({ operation: z.string().regex(/^I-\d+$/), catalog: Catalog, plan: Plan,
    fingerprint: digest }).strict().parse(request);
  if (checked.fingerprint !== installFingerprint(checked.catalog, checked.plan)) throw new Error("the installation changed since inspection; inspect it again");
  const plan = Object.freeze({ ...checked.plan, checksum: checked.plan.checksum && Object.freeze({ ...checked.plan.checksum }),
    command: Object.freeze([...checked.plan.command]) });
  return Object.freeze({ operation: checked.operation, catalog: Object.freeze({ ...checked.catalog }), plan,
    fingerprint: checked.fingerprint });
}
