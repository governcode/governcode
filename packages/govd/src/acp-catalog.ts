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
    const deadline = performance.now() + TIMEOUT_MS;
    const abort = new AbortController();
    let timedOut = false;
    const expired = () => timedOut || performance.now() >= deadline;
    const check = () => {
      if (expired()) {
        timedOut = true;
        throw new Error("ACP catalog request timed out");
      }
    };
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, Math.max(0, deadline - performance.now()));
    // Publication and cleanup belong to the promise shared by every reader, including refreshes.
    const pending = this.load(abort.signal, check).then(snapshot => {
      const fetchedAt = Date.now();
      check();
      this.cached = snapshot;
      this.fetchedAt = fetchedAt;
      return snapshot;
    }).catch(error => {
      const timeout = expired();
      abort.abort();
      this.cached = undefined;
      this.fetchedAt = 0;
      if (timeout) throw new Error("ACP catalog request timed out");
      // Fetch errors can contain untrusted addresses. Decoder messages contain paths/reasons only.
      if (error instanceof Error && /^(?:official catalog|ACP registry)/u.test(error.message)) throw error;
      throw new Error("ACP catalog could not be read");
    }).finally(() => {
      clearTimeout(timer);
      this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async load(signal: AbortSignal, check: () => void): Promise<AcpCatalogSnapshot> {
    let response: Response | undefined;
    let readerOwned = false;
    try {
      check();
      response = await this.fetcher(ACP_REGISTRY_URL, { redirect: "error", credentials: "omit",
        headers: { Accept: "application/json" }, signal });
      check();
      if (!response.ok) {
        throw new Error(`official catalog returned HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("official catalog returned no body");
      const announced = response.headers.get("content-length");
      if (announced && (!/^\d+$/u.test(announced) || Number(announced) > ACP_REGISTRY_LIMITS.bytes)) {
        throw new Error("official catalog exceeds the byte limit");
      }
      const reader = response.body.getReader();
      readerOwned = true;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let ended = false;
      try {
        for (;;) {
          check();
          const { done, value } = await reader.read();
          check();
          if (done) { ended = true; break; }
          bytes += value.byteLength;
          if (bytes > ACP_REGISTRY_LIMITS.bytes) {
            throw new Error("official catalog exceeds the byte limit");
          }
          chunks.push(value);
        }
      } finally {
        // Cancellation is best-effort: an unfinished cancellation must not delay failure.
        if (!ended) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      check();
      const body = Buffer.concat(chunks, bytes);
      // Invalid UTF-8 must not be silently replaced before schema validation or hashing.
      check();
      const json = new TextDecoder("utf-8", { fatal: true }).decode(body);
      check();
      const registry = decodeAcpRegistry(json);
      check();
      const sha256 = createHash("sha256").update(body).digest("hex");
      check();
      const snapshot = Object.freeze({ source: ACP_REGISTRY_URL, sha256,
        fetchedAt: new Date().toISOString(), registry });
      check();
      return snapshot;
    } finally {
      // Before reader acquisition, the response owns cleanup; never cancel through both owners.
      if (!readerOwned) void response?.body?.cancel().catch(() => {});
    }
  }
}
