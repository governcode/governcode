// Read-only ACP discovery. Fetch the fixed official catalog; never download agent artifacts,
// install packages, start processes, or turn registry metadata into Runner permission.
import { createHash } from "node:crypto";
import { ACP_REGISTRY_LIMITS, ACP_REGISTRY_URL, decodeAcpRegistry, type AcpRegistry } from "./acp-registry.ts";

export interface AcpCatalogSnapshot {
  readonly source: string;
  readonly sha256: string;
  readonly fetchedAt: string;
  readonly registry: AcpRegistry;
}
const CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

export class AcpCatalog {
  private cached?: AcpCatalogSnapshot;
  private pending?: Promise<AcpCatalogSnapshot>;
  private fetchedAt = 0;
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }

  /** Concurrent reads share a request. A failed refresh never replaces or returns old metadata. */
  async read(refresh = false): Promise<AcpCatalogSnapshot> {
    if (this.pending) return this.pending;
    if (!refresh && this.cached && Date.now() - this.fetchedAt < CACHE_MS) return this.cached;
    const pending = this.load();
    this.pending = pending;
    try {
      const snapshot = await pending;
      this.cached = snapshot;
      this.fetchedAt = Date.now();
      return snapshot;
    } catch (error) {
      this.cached = undefined;
      this.fetchedAt = 0;
      throw error;
    } finally { this.pending = undefined; }
  }

  private async load(): Promise<AcpCatalogSnapshot> {
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, TIMEOUT_MS);
    try {
      const response = await this.fetcher(ACP_REGISTRY_URL, { redirect: "error", credentials: "omit",
        headers: { Accept: "application/json" }, signal: abort.signal });
      if (!response.ok) {
        // Release even an error body that never ends, then abort its underlying request.
        void response.body?.cancel().catch(() => {});
        throw new Error(`official catalog returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("official catalog returned no body");
      const announced = response.headers.get("content-length");
      if (announced && (!/^\d+$/u.test(announced) || Number(announced) > ACP_REGISTRY_LIMITS.bytes)) {
        await response.body.cancel();
        throw new Error("official catalog exceeds the byte limit");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > ACP_REGISTRY_LIMITS.bytes) {
            await reader.cancel();
            throw new Error("official catalog exceeds the byte limit");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body = Buffer.concat(chunks, bytes);
      // Invalid UTF-8 must not be silently replaced before schema validation or hashing.
      const json = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const registry = decodeAcpRegistry(json);
      return Object.freeze({ source: ACP_REGISTRY_URL, sha256: createHash("sha256").update(body).digest("hex"),
        fetchedAt: new Date().toISOString(), registry });
    } catch (error) {
      abort.abort();
      if (timedOut) throw new Error("ACP catalog request timed out");
      // Fetch errors can contain untrusted addresses. Decoder messages contain paths/reasons only.
      if (error instanceof Error && /^(?:official catalog|ACP registry)/u.test(error.message)) throw error;
      throw new Error("ACP catalog could not be read");
    } finally { clearTimeout(timer); }
  }
}
