// Store verified bytes only. Downloading grants no permission to execute an artifact.
import { createHash, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { FileHandle } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, request } from "node:https";
import type { RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction, Socket } from "node:net";

export const ACP_DOWNLOAD_LIMITS = Object.freeze({
  bytes: 128 * 1024 * 1024, totalMs: 60_000, inactivityMs: 10_000,
});

export interface AcpDownloadOptions {
  // Test transports still pass through the production URL, DNS and response checks.
  // Injected resolvers must settle when their signal is aborted.
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly LookupAddress[]>;
  request?: (options: RequestOptions, response: (message: IncomingMessage) => void) => ClientRequest;
  limits?: Partial<{ bytes: number; totalMs: number; inactivityMs: number }>;
}

class DownloadError extends Error {
  constructor(reason: string) { super(`ACP download ${reason}`); }
}
function fail(reason: string): never { throw new DownloadError(reason); }

function ipv4Number(address: string): number {
  return address.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}
function v4In(value: number, network: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(value / size) === Math.floor(ipv4Number(network) / size);
}
const nonPublicV4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], [[100, 64, 0, 0].join("."), 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24],
  [[192, 168, 0, 0].join("."), 16], ["192.175.48.0", 24], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
];
function ipv6Number(address: string): bigint {
  const dotted = address.lastIndexOf(":");
  if (address.includes(".")) {
    const v4 = ipv4Number(address.slice(dotted + 1));
    address = `${address.slice(0, dotted)}:${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return words.reduce((n: bigint, word: string) => (n << 16n) | BigInt(`0x${word}`), 0n);
}
function v6In(value: bigint, network: string, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === ipv6Number(network) >> shift;
}
const nonPublicV6: readonly (readonly [string, number])[] = [
  // IETF protocol assignments (including Teredo, benchmark and ORCHID), documentation,
  // 6to4, AS112, and the newer documentation allocation. Fail closed on special ranges.
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["2620:4f:8000::", 48], ["3ffe::", 16], ["3fff::", 20],
];

/** Public global unicast only; mapped IPv4 receives the same IPv4 checks. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !nonPublicV4.some(([network, bits]) => v4In(value, network, bits));
  }
  if (family !== 6 || address.includes("%")) return false;
  const value = ipv6Number(address);
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return !nonPublicV4.some(([network, bits]) => v4In(v4, network, bits));
  }
  // ISATAP encodes a tunneled IPv4 endpoint in the interface identifier.
  const interfacePrefix = (value >> 32n) & 0xffffffffn;
  if (interfacePrefix === 0x5efen || interfacePrefix === 0x2005efen) return false;
  return v6In(value, "2000::", 3) && !nonPublicV6.some(([network, bits]) => v6In(value, network, bits));
}

function checkedURL(source: string): URL {
  if (typeof source !== "string" || source.length > 8192 || !/^https:\/\//iu.test(source) ||
      /[\s\\\u0000-\u001f\u007f]/u.test(source)) fail("source is invalid");
  let url: URL;
  try { url = new URL(source); } catch { fail("source is invalid"); }
  const host = url.hostname;
  const authority = source.slice(source.indexOf("://") + 3).split(/[/?#]/u)[0];
  // Require an ordinary fully qualified DNS name. Reject local/reserved suffixes before DNS.
  if (url.protocol !== "https:" || url.username || url.password || authority.includes("@") || source.includes("#") ||
      (url.port && url.port !== "443") || isIP(host.replace(/^\[|\]$/gu, "")) ||
      host.length > 253 || !host.includes(".") ||
      !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label)) ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|private|corp|lan|home|test|invalid|example|onion)$/iu.test(host) ||
      /(?:^|\.)(?:home\.arpa|in-addr\.arpa|ip6\.arpa)$/iu.test(host)) fail("source is invalid");
  return url;
}

async function resolvePublic(hostname: string, signal: AbortSignal): Promise<readonly LookupAddress[]> {
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) fail("aborted");
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses: LookupAddress[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        addresses.push(...result.value.map(address => ({ address, family: i === 0 ? 4 : 6 })));
      } else if (!["ENODATA", "ENOTFOUND"].includes(result.reason?.code)) {
        fail("DNS resolution failed");
      }
    }
    return addresses;
  } finally { signal.removeEventListener("abort", cancel); }
}

function closed(resource: ClientRequest | IncomingMessage | Socket): Promise<void> {
  if (resource.closed) return Promise.resolve();
  return new Promise(resolve => resource.once("close", resolve));
}

/** Does not close the caller's file. On failure the caller discards its partial file. */
export async function downloadVerifiedBinary(source: string, expectedSha256: string,
  target: FileHandle, signal: AbortSignal, options: AcpDownloadOptions = {}): Promise<{ bytes: number; sha256: string }> {
  const url = checkedURL(source);
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/iu.test(expectedSha256)) fail("SHA-256 is invalid");
  const limits = { ...ACP_DOWNLOAD_LIMITS, ...options.limits };
  for (const key of ["bytes", "totalMs", "inactivityMs"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > ACP_DOWNLOAD_LIMITS[key]) fail("limits are invalid");
  }
  if (signal.aborted) fail("aborted");
  const controller = new AbortController();
  let failure: DownloadError | undefined;
  let req: ClientRequest | undefined;
  let res: IncomingMessage | undefined;
  let rejectResponse: ((error: Error) => void) | undefined;
  const settlements: Promise<unknown>[] = [];
  const sockets = new Set<Socket>();
  const stop = (reason: string) => {
    failure ??= new DownloadError(reason);
    controller.abort();
    rejectResponse?.(failure);
    res?.destroy();
    req?.destroy();
    for (const socket of sockets) socket.destroy();
  };
  const abort = () => stop("aborted");
  const totalDeadline = performance.now() + limits.totalMs;
  let inactivityDeadline = Infinity;
  const expired = () => {
    const now = performance.now();
    if (!failure && now >= totalDeadline) stop("total deadline exceeded");
    if (!failure && now >= inactivityDeadline) stop("inactivity deadline exceeded");
    return !!failure;
  };
  const deadline = setTimeout(() => stop("total deadline exceeded"), limits.totalMs);
  let inactivity: ReturnType<typeof setTimeout> | undefined;
  const activity = () => {
    // An overdue await cannot erase expiry by resetting a delayed timer.
    if (expired()) return;
    inactivityDeadline = performance.now() + limits.inactivityMs;
    clearTimeout(inactivity);
    inactivity = setTimeout(() => stop("inactivity deadline exceeded"), limits.inactivityMs);
  };
  const check = () => { if (expired()) throw failure!; };
  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    const pending = (async () => {
      check();
      if (hostname !== url.hostname) fail("DNS hostname mismatch");
      const addresses = await (options.resolve ?? resolvePublic)(hostname, controller.signal);
      check();
      if (!addresses.length || addresses.some(a => ![4, 6].includes(a.family) ||
          isIP(a.address) !== a.family || !isPublicAddress(a.address))) fail("DNS address is not public");
      // Return exactly one validated address to this connection; never look it up again.
      const pinned = addresses[0];
      activity();
      callback(null, lookupOptions.all ? [pinned] : pinned.address, pinned.family);
    })().catch(() => {
      stop("DNS resolution failed or address is not public");
      callback(failure!, "", 4);
    });
    settlements.push(pending);
  };
  // A dedicated native agent ignores globalAgent and environment proxy configuration.
  const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {},
    rejectUnauthorized: true, lookup, autoSelectFamily: false });
  signal.addEventListener("abort", abort, { once: true });
  activity();
  try {
    if (signal.aborted) abort();
    check();
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      rejectResponse = reject;
      const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
        protocol: "https:", hostname: url.hostname, port: 443,
        path: url.pathname + url.search, method: "GET", agent, lookup,
        autoSelectFamily: false, rejectUnauthorized: true, servername: url.hostname,
        headers: { "accept-encoding": "identity", connection: "close" },
      };
      req = (options.request ?? request)(requestOptions, message => {
        res = message;
        settlements.push(closed(message));
        message.on("error", () => stop("transport failed"));
        if (failure) message.destroy();
        else { activity(); resolve(message); }
      });
      settlements.push(closed(req));
      req.on("error", () => stop("transport failed"));
      req.on("socket", socket => {
        sockets.add(socket);
        settlements.push(closed(socket));
        if (failure) socket.destroy();
      });
      req.once("close", () => { if (!res && !failure) stop("transport closed without a response"); });
      req.end();
    });
    const message = await response;
    check();
    if (message.statusCode !== 200) fail("requires HTTP 200 without redirects");
    const encoding = message.headers["content-encoding"];
    if (encoding !== undefined && (typeof encoding !== "string" || encoding.trim().toLowerCase() !== "identity")) fail("content encoding is unsupported");
    if (message.headers["content-range"] !== undefined) fail("partial content is unsupported");
    const length = message.headers["content-length"];
    let expectedLength: number | undefined;
    if (length !== undefined) {
      if (typeof length !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(length)) fail("content length is invalid");
      expectedLength = Number(length);
      if (!Number.isSafeInteger(expectedLength) || expectedLength > limits.bytes) fail("byte limit exceeded");
      if (expectedLength === 0) fail("body is empty");
    }
    if (length !== undefined && message.headers["transfer-encoding"] !== undefined) fail("content framing is ambiguous");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of message) {
      check();
      if (!Buffer.isBuffer(chunk)) fail("transport returned invalid bytes");
      activity();
      if (chunk.length > limits.bytes - bytes || (expectedLength !== undefined && chunk.length > expectedLength - bytes)) fail("byte limit exceeded");
      let offset = 0;
      // Await each write before reading more. Partial writes must advance the whole chunk.
      while (offset < chunk.length) {
        check();
        const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset, bytes + offset);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.length - offset) fail("file write failed");
        offset += bytesWritten;
        check();
      }
      hash.update(chunk);
      bytes += chunk.length;
    }
    check();
    if (!message.complete || (expectedLength !== undefined && bytes !== expectedLength)) fail("body is truncated");
    if (!bytes) fail("body is empty");
    const digest = hash.digest();
    if (!timingSafeEqual(digest, Buffer.from(expectedSha256, "hex"))) fail("SHA-256 mismatch");
    check();
    return { bytes, sha256: digest.toString("hex") };
  } catch (error) {
    expired();
    throw failure ?? (error instanceof DownloadError ? error : new DownloadError("transport or file write failed"));
  } finally {
    clearTimeout(deadline);
    clearTimeout(inactivity);
    signal.removeEventListener("abort", abort);
    controller.abort();
    res?.destroy();
    req?.destroy();
    agent.destroy();
    for (const socket of sockets) socket.destroy();
    // Pending file writes were awaited above. DNS, request, response and sockets also
    // settle before the caller may close/discard/rename its file.
    await Promise.allSettled(settlements);
  }
}
