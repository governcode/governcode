import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Agent, globalAgent } from "node:https";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable, PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { ACP_DOWNLOAD_LIMITS, downloadVerifiedBinary, isPublicAddress } from "../src/acp-download.ts";
import type { AcpDownloadOptions } from "../src/acp-download.ts";

const source = "https://artifacts.example.org/agent.bin?version=1";
const body = Buffer.from("invented binary fixture");
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const sha256 = digest(body);
const publicDNS = [{ address: "93.184.216.34", family: 4 }];

class FakeResponse extends Readable {
  statusCode = 200;
  headers: IncomingHttpHeaders = {};
  complete = true;
  private readonly chunks: Buffer[] | undefined;
  private readonly closeDelay: number;
  constructor(chunks: Buffer[] | undefined = [body], closeDelay = 0) {
    super({ highWaterMark: 1024 });
    this.chunks = chunks;
    this.closeDelay = closeDelay;
  }
  _read() {
    if (this.chunks) this.push(this.chunks.length ? this.chunks.shift()! : null);
  }
  _destroy(error: Error | null, callback: (error: Error | null) => void) {
    setTimeout(() => callback(error), this.closeDelay);
  }
}

function fakeTransport(response = new FakeResponse(), options: { noResponse?: boolean; closeDelay?: number } = {}) {
  let req: Writable;
  let socket: PassThrough;
  let calls = 0;
  let pinned: { address: string; family: number } | undefined;
  let requestOptions: Parameters<NonNullable<AcpDownloadOptions["request"]>>[0];
  const request: NonNullable<AcpDownloadOptions["request"]> = (input, callback) => {
    calls++;
    requestOptions = input;
    assert.ok(input.agent instanceof Agent);
    assert.notEqual(input.agent, globalAgent);
    assert.equal(input.agent.options.keepAlive, false);
    assert.equal(input.agent.options.rejectUnauthorized, true);
    assert.deepEqual(input.agent.options.proxyEnv, {});
    assert.equal(input.rejectUnauthorized, true);
    assert.equal(input.servername, "artifacts.example.org");
    assert.equal(input.hostname, input.servername);
    assert.equal(input.port, 443);
    assert.equal(input.method, "GET");
    assert.deepEqual(input.headers, { "accept-encoding": "identity", connection: "close" });
    assert.equal((input as typeof input & { autoSelectFamily: boolean }).autoSelectFamily, false);
    assert.equal(input.agent.options.lookup, input.lookup);
    req = new Writable({ autoDestroy: false, write(_chunk, _encoding, done) { done(); },
      final(done) {
        done();
        queueMicrotask(() => {
          socket = new PassThrough();
          socket.on("error", () => {});
          req.emit("socket", socket);
          if (req.destroyed) { socket.destroy(); return; }
          (input.lookup as LookupFunction)(String(input.hostname), { all: false }, (error, address, family) => {
            if (error) { req.destroy(error); return; }
            pinned = { address: address as string, family: family! };
            if (!req.destroyed && !options.noResponse) {
              callback(response as unknown as IncomingMessage);
              response.once("close", () => { req.destroy(); socket.destroy(); });
            }
          });
        });
      },
      destroy(error, done) { setTimeout(() => done(error), options.closeDelay ?? 0); },
    });
    return req as unknown as ClientRequest;
  };
  return { request, response, get req() { return req; }, get socket() { return socket; },
    get calls() { return calls; }, get pinned() { return pinned; }, get requestOptions() { return requestOptions; } };
}

function fakeFile(partial = Infinity, writeDelay = 0) {
  const parts: Buffer[] = [];
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let lastPosition = 0;
  const target = { async write(buffer: Buffer, offset: number, length: number, position: number) {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    assert.equal(position, lastPosition);
    if (writeDelay) await delay(writeDelay);
    const bytesWritten = Math.min(partial, length);
    parts.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
    lastPosition += bytesWritten;
    active--;
    return { bytesWritten, buffer };
  } } as unknown as FileHandle;
  return { target, get bytes() { return Buffer.concat(parts); }, get active() { return active; },
    get maxActive() { return maxActive; }, get calls() { return calls; } };
}

async function attempt(response = new FakeResponse(), extra: AcpDownloadOptions = {}, expected = sha256) {
  const transport = fakeTransport(response);
  const file = fakeFile();
  const result = await downloadVerifiedBinary(source, expected, file.target, new AbortController().signal,
    { request: transport.request, resolve: async () => publicDNS, ...extra });
  assert.equal(transport.req.closed, true);
  assert.equal(transport.socket.closed, true);
  assert.equal(response.closed, true);
  return { result, file, transport };
}

test("production limits and global address classifications are conservative", () => {
  assert.deepEqual(ACP_DOWNLOAD_LIMITS, { bytes: 134217728, totalMs: 60000, inactivityMs: 10000 });
  for (const address of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111",
    "::ffff:8.8.8.8", "::ffff:808:808"]) assert.equal(isPublicAddress(address), true, address);
  for (const address of ["", "hostname", "1.2.3", "010.1.2.3", "0.0.0.0", "0.1.2.3", "10.2.3.4", [100, 64, 0, 1].join("."),
    [100, 127, 255, 255].join("."), "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.9", "192.0.2.1",
    "192.31.196.1", "192.52.193.1", "192.88.99.1", [192, 168, 0, 1].join("."), "192.175.48.1", "198.18.1.2", "198.19.255.255",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.1.2.3", "240.0.0.1", "255.255.255.255", "::", "::1",
    "::8.8.8.8", "::ffff:127.0.0.1", "::ffff:c0a8:101", "fc00::1", "fe80::1", "fe80::1%eth0", "ff02::1",
    "64:ff9b::808:808", "64:ff9b:1::1", "100::1", "2001::1", "2001:2::1", "2001:10::1", "2001:20::1",
    "2001:db8::1", "2002:808:808::1", "2620:4f:8000::1", "3ffe::1", "3fff::1", "4000::1",
    "2001:4860::5efe:127.0.0.1", "2001:4860::200:5efe:808:808"])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ["100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "223.255.255.255"])
    assert.equal(isPublicAddress(address), true, address);
});

test("rejects credentials, non-HTTPS, non-443, literal IPs and private hostnames before transport", async () => {
  const transport = fakeTransport();
  for (const url of ["http://artifacts.example.org/file", "https://user:password@artifacts.example.org/file", "https://@artifacts.example.org/file",
    "https://artifacts.example.org:444/file", "https://127.1/file", "https://2130706433/file", "https://8.8.8.8/file",
    "https://[2001:4860::1]/file", "https://localhost/file", "https://machine.local/file", "https://machine.internal/file",
    "https://machine.home.arpa/file", "https://machine.invalid/file", "https://machine.localdomain/file", "https://machine/file", "https://artifacts.example.org./file",
    "https:artifacts.example.org/file", "https://artifacts.example.org/file#",
    "https://artifacts.example.org/file#fragment", " https://artifacts.example.org/file", "https://artifacts.example.org\\file"])
    await assert.rejects(downloadVerifiedBinary(url, sha256, fakeFile().target, new AbortController().signal,
      { request: transport.request }), /source is invalid/u);
  assert.equal(transport.calls, 0);
});

test("validates digest, lowered limits and pre-aborted signals before transport", async () => {
  const transport = fakeTransport();
  for (const expected of ["", "abc", "z".repeat(64)])
    await assert.rejects(downloadVerifiedBinary(source, expected, fakeFile().target, new AbortController().signal,
      { request: transport.request }), /SHA-256 is invalid/u);
  for (const limits of [{ bytes: 0 }, { totalMs: -1 }, { inactivityMs: Infinity }, { bytes: ACP_DOWNLOAD_LIMITS.bytes + 1 }])
    await assert.rejects(downloadVerifiedBinary(source, sha256, fakeFile().target, new AbortController().signal,
      { request: transport.request, limits }), /limits are invalid/u);
  await assert.rejects(downloadVerifiedBinary(source, sha256, fakeFile().target, AbortSignal.abort("secret"),
    { request: transport.request }), { message: "ACP download aborted" });
  assert.equal(transport.calls, 0);
});

test("streams, hashes, handles partial file writes and preserves caller file ownership", async () => {
  const response = new FakeResponse([body.subarray(0, 7), body.subarray(7)]);
  response.headers["content-length"] = String(body.length);
  const transport = fakeTransport(response);
  const file = fakeFile(3);
  assert.deepEqual(await downloadVerifiedBinary(source, sha256.toUpperCase(), file.target, new AbortController().signal,
    { request: transport.request, resolve: async () => publicDNS }), { bytes: body.length, sha256 });
  assert.deepEqual(file.bytes, body);
  assert.equal(file.maxActive, 1);
  assert.ok(file.calls > 1);
  assert.equal(transport.req.closed, true);
  assert.equal(transport.socket.closed, true);
  assert.equal(response.closed, true);
});

test("writes a real caller-owned FileHandle and leaves it open for storage finalization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-download-test-"));
  const path = join(directory, "fixture.part");
  const file = await open(path, "wx", 0o600);
  try {
    const transport = fakeTransport();
    assert.deepEqual(await downloadVerifiedBinary(source, sha256, file, new AbortController().signal,
      { request: transport.request, resolve: async () => publicDNS }), { bytes: body.length, sha256 });
    assert.deepEqual(await readFile(path), body);
    assert.equal((await file.stat()).size, body.length);
  } finally {
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("checks every DNS answer, including mixed and mapped IPv6 answers", async () => {
  for (const addresses of [[], [{ address: "127.0.0.1", family: 4 }], [...publicDNS, { address: "10.0.0.1", family: 4 }],
    [...publicDNS, { address: "::ffff:127.0.0.1", family: 6 }], [{ address: "2001:db8::1", family: 6 }],
    [{ address: "93.184.216.34", family: 6 }], [{ address: "no-address", family: 4 }]]) {
    const transport = fakeTransport();
    const file = fakeFile();
    await assert.rejects(downloadVerifiedBinary(source, sha256, file.target, new AbortController().signal,
      { request: transport.request, resolve: async () => addresses }), /DNS/u);
    assert.equal(transport.pinned, undefined);
    assert.equal(file.calls, 0);
    assert.equal(transport.req.closed, true);
    assert.equal(transport.socket.closed, true);
  }
  for (const address of ["2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    const { transport } = await attempt(undefined, { resolve: async () => [{ address, family: 6 }] });
    assert.deepEqual(transport.pinned, { address, family: 6 });
  }
});

test("connection lookup pins a checked address with original TLS hostname, no second DNS lookup", async () => {
  let resolutions = 0;
  const { transport } = await attempt(undefined, { resolve: async hostname => {
    assert.equal(hostname, "artifacts.example.org");
    return ++resolutions === 1 ? [...publicDNS, { address: "1.1.1.1", family: 4 }] : [{ address: "127.0.0.1", family: 4 }];
  } });
  assert.equal(resolutions, 1);
  assert.deepEqual(transport.pinned, publicDNS[0]);
  assert.equal(transport.requestOptions.servername, "artifacts.example.org");
});

test("uses its dedicated agent despite environment and global proxy settings", async () => {
  const oldProxy = process.env.HTTPS_PROXY;
  const oldNodeProxy = process.env.NODE_USE_ENV_PROXY;
  const oldLookup = globalAgent.options.lookup;
  try {
    process.env.HTTPS_PROXY = "http://proxy.invalid:8080";
    process.env.NODE_USE_ENV_PROXY = "1";
    globalAgent.options.lookup = () => { throw new Error("global agent must be unused"); };
    await attempt();
  } finally {
    if (oldProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldProxy;
    if (oldNodeProxy === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = oldNodeProxy;
    globalAgent.options.lookup = oldLookup;
  }
});

test("rejects redirects, partial and non-200 responses without following them", async () => {
  for (const status of [206, 301, 302, 307, 308, 404, 500]) {
    const response = new FakeResponse(undefined, 5);
    response.statusCode = status;
    response.headers.location = "https://user:secret@private.invalid/hidden";
    const transport = fakeTransport(response);
    await assert.rejects(downloadVerifiedBinary(source, sha256, fakeFile().target, new AbortController().signal,
      { request: transport.request, resolve: async () => publicDNS }), { message: "ACP download requires HTTP 200 without redirects" });
    assert.equal(transport.calls, 1);
    assert.equal(response.closed, true);
    assert.equal(transport.req.closed, true);
    assert.equal(transport.socket.closed, true);
  }
});

test("rejects encoded, ranged or ambiguous framed content before writing", async () => {
  for (const headers of [{ "content-encoding": "gzip" }, { "content-encoding": "identity, gzip" },
    { "content-encoding": ["identity"] }, { "content-range": "bytes 0-1/2" },
    { "content-length": "1", "transfer-encoding": "chunked" }]) {
    const response = new FakeResponse(undefined);
    response.headers = headers as unknown as IncomingHttpHeaders;
    const transport = fakeTransport(response);
    const file = fakeFile();
    await assert.rejects(downloadVerifiedBinary(source, sha256, file.target, new AbortController().signal,
      { request: transport.request, resolve: async () => publicDNS }), /encoding|partial|framing/u);
    assert.equal(file.calls, 0);
    assert.equal(response.closed, true);
  }
  const identity = new FakeResponse();
  identity.headers["content-encoding"] = "identity";
  await attempt(identity);
});

test("rejects invalid, excessive or empty declared lengths before writing", async () => {
  for (const length of ["-1", "+1", " 1", "1.0", "01", "no", "1, 1", ["1", "1"],
    "99999999999999999999999", String(ACP_DOWNLOAD_LIMITS.bytes + 1), "0"]) {
    const response = new FakeResponse(undefined);
    // Exercise malformed values that a real HTTP parser normally rejects first.
    response.headers["content-length"] = length as unknown as string;
    const file = fakeFile();
    const transport = fakeTransport(response);
    await assert.rejects(downloadVerifiedBinary(source, sha256, file.target, new AbortController().signal,
      { request: transport.request, resolve: async () => publicDNS }), /length|byte limit|empty/u);
    assert.equal(file.calls, 0);
    assert.equal(response.closed, true);
  }
});

test("rejects streamed overflow at the known bound, truncation, empty and digest mismatch", async () => {
  const overflow = new FakeResponse([body]);
  overflow.headers["content-length"] = "1";
  await assert.rejects(attempt(overflow), /byte limit/u);
  await assert.rejects(attempt(new FakeResponse([body]), { limits: { bytes: body.length - 1 } }), /byte limit/u);
  const truncated = new FakeResponse([body]);
  truncated.headers["content-length"] = String(body.length + 1);
  await assert.rejects(attempt(truncated), /truncated/u);
  const incomplete = new FakeResponse([body]);
  incomplete.complete = false;
  await assert.rejects(attempt(incomplete), /truncated/u);
  await assert.rejects(attempt(new FakeResponse([]), {}, digest(Buffer.alloc(0))), /empty/u);
  await assert.rejects(attempt(undefined, {}, "0".repeat(64)), /SHA-256 mismatch/u);
});

test("abort waits for pending writes and asynchronous transport closure", async () => {
  const controller = new AbortController();
  const response = new FakeResponse([body], 20);
  const transport = fakeTransport(response, { closeDelay: 20 });
  const file = fakeFile(Infinity, 50);
  const pending = downloadVerifiedBinary(source, sha256, file.target, controller.signal,
    { request: transport.request, resolve: async () => publicDNS });
  while (!file.active) await delay(1);
  controller.abort("https://user:secret@private.invalid");
  await assert.rejects(pending, { message: "ACP download aborted" });
  assert.equal(file.active, 0);
  assert.equal(file.calls, 1);
  assert.equal(response.closed, true);
  assert.equal(transport.req.closed, true);
  assert.equal(transport.socket.closed, true);
});

test("delayed timer callbacks cannot turn overdue DNS or file writes into success", async () => {
  const stall = () => new Promise<void>((ok) => setImmediate(() => {
    const until = performance.now() + 40;
    while (performance.now() < until) { /* Deliberately delay deadline timer execution. */ }
    ok();
  }));
  for (const bound of ["totalMs", "inactivityMs"] as const) {
    for (const stage of ["dns", "write"]) {
      const transport = fakeTransport(), file = fakeFile();
      const write = file.target.write.bind(file.target);
      if (stage === "write") file.target.write = (async (...args: Parameters<FileHandle["write"]>) => {
        await stall(); return write(...args);
      }) as FileHandle["write"];
      await assert.rejects(downloadVerifiedBinary(source, sha256, file.target, new AbortController().signal,
        { request: transport.request, limits: { [bound]: 10 }, resolve: async () => {
          if (stage === "dns") await stall(); return publicDNS;
        } }), bound === "totalMs" ? /total deadline/u : /inactivity deadline/u);
      assert.equal(transport.req.closed, true);
      assert.equal(transport.socket.closed, true);
      if (stage === "write") assert.equal(transport.response.closed, true);
    }
  }
});

test("abort during DNS cancels and awaits the resolver without starting a response", async () => {
  const controller = new AbortController();
  const transport = fakeTransport();
  let resolving = false;
  let settled = false;
  const pending = downloadVerifiedBinary(source, sha256, fakeFile().target, controller.signal,
    { request: transport.request, resolve: async (_hostname, signal) => {
      resolving = true;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { setTimeout(resolve, 15); }, { once: true }));
      settled = true;
      return publicDNS;
    } });
  while (!resolving) await delay(1);
  controller.abort();
  await assert.rejects(pending, /aborted/u);
  assert.equal(settled, true);
  assert.equal(transport.pinned, undefined);
  assert.equal(transport.req.closed, true);
  assert.equal(transport.socket.closed, true);
});

test("inactivity bounds DNS, missing responses and stalled bodies with complete cleanup", async () => {
  for (const stage of ["dns", "response", "body"]) {
    const response = new FakeResponse(undefined);
    // An explicitly absent chunk list leaves the body open and silent.
    response._read = () => {};
    const transport = fakeTransport(response, { noResponse: stage === "response", closeDelay: 5 });
    let dnsSettled = stage !== "dns";
    await assert.rejects(downloadVerifiedBinary(source, sha256, fakeFile().target, new AbortController().signal,
      { request: transport.request, limits: { inactivityMs: 20 }, resolve: async (_hostname, signal) => {
        if (stage === "dns") await new Promise<void>(resolve => signal.addEventListener("abort", () => {
          setTimeout(() => { dnsSettled = true; resolve(); }, 10);
        }, { once: true }));
        return publicDNS;
      } }), /inactivity deadline/u);
    assert.equal(dnsSettled, true);
    assert.equal(transport.req.closed, true);
    assert.equal(transport.socket.closed, true);
    if (stage === "body") assert.equal(response.closed, true);
  }
});

test("total deadline bounds a progressing body", async () => {
  const response = new FakeResponse();
  let timer: ReturnType<typeof setTimeout>;
  response._read = () => { timer = setTimeout(() => response.push(Buffer.from("x")), 5); };
  response.once("close", () => clearTimeout(timer));
  await assert.rejects(attempt(response, { limits: { totalMs: 35, inactivityMs: 25 } }), /total deadline/u);
  assert.equal(response.closed, true);
});

test("transport, resolver and file diagnostics never echo untrusted data", async () => {
  const secret = new Error("https://user:secret@private.invalid/hidden");
  await assert.rejects(attempt(undefined, { resolve: async () => { throw secret; } }),
    { message: "ACP download DNS resolution failed or address is not public" });
  await assert.rejects(attempt(undefined, { request: () => { throw secret; } }),
    { message: "ACP download transport or file write failed" });
  const transport = fakeTransport();
  const target = { write: async () => { throw secret; } } as unknown as FileHandle;
  await assert.rejects(downloadVerifiedBinary(source, sha256, target, new AbortController().signal,
    { request: transport.request, resolve: async () => publicDNS }),
    { message: "ACP download transport or file write failed" });
  assert.equal(transport.req.closed, true);
  assert.equal(transport.socket.closed, true);
});

test("request and response errors and response-free closure settle all transport resources", async () => {
  for (const mode of ["request-error", "response-error", "request-close"]) {
    const response = new FakeResponse();
    response._read = () => {};
    const transport = fakeTransport(response, { noResponse: mode !== "response-error", closeDelay: 10 });
    const pending = downloadVerifiedBinary(source, sha256, fakeFile().target, new AbortController().signal,
      { request: transport.request, resolve: async () => publicDNS });
    queueMicrotask(() => {
      if (mode === "response-error") setTimeout(() => response.destroy(new Error("private diagnostic")), 1);
      else if (mode === "request-error") transport.req.destroy(new Error("private diagnostic"));
      else transport.req.destroy();
    });
    await assert.rejects(pending, /ACP download transport (?:failed|closed without a response)/u);
    assert.equal(transport.req.closed, true);
    assert.equal(transport.socket.closed, true);
    if (mode === "response-error") assert.equal(response.closed, true);
  }
});

test("an oversized chunk is rejected before any file write, including declared bounds", async () => {
  for (const declared of [false, true]) {
    const response = new FakeResponse([body]);
    if (declared) response.headers["content-length"] = String(body.length - 1);
    const file = fakeFile();
    const transport = fakeTransport(response);
    await assert.rejects(downloadVerifiedBinary(source, sha256, file.target, new AbortController().signal,
      { request: transport.request, resolve: async () => publicDNS,
        limits: declared ? {} : { bytes: body.length - 1 } }), /byte limit/u);
    assert.equal(file.calls, 0);
    assert.equal(response.closed, true);
    assert.equal(transport.req.closed, true);
  }
});

test("zero or invalid partial writes fail and release the stream", async () => {
  for (const bytesWritten of [0, -1, NaN, body.length + 1]) {
    const transport = fakeTransport();
    const target = { write: async () => ({ bytesWritten }) } as unknown as FileHandle;
    await assert.rejects(downloadVerifiedBinary(source, sha256, target, new AbortController().signal,
      { request: transport.request, resolve: async () => publicDNS }), /file write failed/u);
    assert.equal(transport.response.closed, true);
    assert.equal(transport.req.closed, true);
  }
});

test("streaming backpressure bounds buffered memory independently of artifact size", async () => {
  const chunk = Buffer.alloc(1024, 42);
  const count = 256;
  const expected = createHash("sha256");
  for (let i = 0; i < count; i++) expected.update(chunk);
  const response = new FakeResponse();
  let produced = 0;
  let consumed = 0;
  let maxAhead = 0;
  response._read = () => {
    if (produced === count) { response.push(null); return; }
    produced++;
    maxAhead = Math.max(maxAhead, produced - consumed);
    response.push(chunk);
  };
  const target = { async write(buffer: Buffer, offset: number, length: number) {
    await delay(1);
    consumed += length / chunk.length;
    return { bytesWritten: length, buffer };
  } } as unknown as FileHandle;
  const transport = fakeTransport(response);
  const result = await downloadVerifiedBinary(source, expected.digest("hex"), target, new AbortController().signal,
    { request: transport.request, resolve: async () => publicDNS });
  assert.equal(result.bytes, count * chunk.length);
  assert.equal(consumed, count);
  assert.ok(maxAhead <= 3, `buffered ${maxAhead} chunks`);
  assert.equal(response.closed, true);
});
