// Shared installer contracts. Artifact installation stores verified bytes; it grants no
// permission to probe, authenticate, run a prompt, or become a Runner.
import type { FileHandle } from "node:fs/promises";
import type { AcpInstallPlan } from "./acp-registry.ts";

export interface AcpCatalogIdentity {
  readonly source: string;
  readonly sha256: string;
  readonly fetchedAt: string;
}
export interface AcpInstallRequest {
  readonly operation: string;
  readonly catalog: AcpCatalogIdentity;
  readonly plan: AcpInstallPlan;
  readonly fingerprint: string;
}
export type AcpArtifactDownloader = (plan: AcpInstallPlan, target: FileHandle, signal: AbortSignal) =>
  Promise<{ bytes: number; sha256: string }>;
export interface AcpInstallApproval {
  readonly id: string;
  readonly allowed: boolean;
}
export interface AcpInstallReceipt {
  readonly schema: 1;
  readonly installationId: string;
  readonly operation: string;
  readonly gate: string;
  readonly installedAt: string;
  readonly catalog: AcpCatalogIdentity;
  readonly plan: AcpInstallPlan;
  readonly bytes: number;
  readonly sha256: string;
  readonly versionEvidence: "registry-advertised";
}
export type AcpInstallHooks = {
  gate(request: AcpInstallRequest): Promise<AcpInstallApproval>;
  signal: AbortSignal;
};
