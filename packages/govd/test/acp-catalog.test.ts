import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AcpCatalog } from "../src/acp-catalog.ts";
import { ACP_REGISTRY_LIMITS, ACP_REGISTRY_URL } from "../src/acp-registry.ts";

const json = JSON.stringify({ version: "1.0.0", agents: [], extensions: [] });
const fetcher = (f: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (url, init) => f(url, init)) as typeof fetch;

test("catalog fetch is fixed, bounded, shared and explicitly refreshable", async () => {
  let calls = 0;
  const catalog = new AcpCatalog(fetcher((url, init) => {
    calls++;
    assert.equal(url, ACP_REGISTRY_URL);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.ok(init?.signal);
    return new Response(json);
  }));
  const [a, b] = await Promise.all([catalog.read(), catalog.read()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  assert.equal(a.sha256, createHash("sha256").update(json).digest("hex"));
  assert.equal(a.source, ACP_REGISTRY_URL);
  assert.equal(await catalog.read(), a);
  await catalog.read(true);
  assert.equal(calls, 2);
});

test("failed refresh surfaces failure and a later retry can fetch valid metadata", async () => {
  let calls = 0;
  const catalog = new AcpCatalog(fetcher(() => {
    if (++calls === 2) return new Response("unavailable", { status: 503 });
    return new Response(json);
  }));
  const old = await catalog.read();
  await assert.rejects(catalog.read(true), /HTTP 503/u);
  const current = await catalog.read();
  assert.notEqual(current, old);
  assert.equal(calls, 3);
});

test("rejected HTTP responses cancel their body and abort the request", async () => {
  let cancelled = 0;
  let signal: AbortSignal | undefined;
  const catalog = new AcpCatalog(fetcher((_url, init) => {
    signal = init!.signal!;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
  }));
  await assert.rejects(catalog.read(), /HTTP 503/u);
  assert.equal(cancelled, 1, "a failed open response releases its stream");
  assert.equal(signal!.aborted, true, "a failed request cannot outlive the cleared timeout");
});

test("catalog rejects oversized declared and streamed bodies", async () => {
  for (const response of [
    new Response(json, { headers: { "content-length": String(ACP_REGISTRY_LIMITS.bytes + 1) } }),
    new Response(new Uint8Array(ACP_REGISTRY_LIMITS.bytes + 1)),
  ]) {
    const catalog = new AcpCatalog(fetcher(() => response));
    await assert.rejects(catalog.read(), /byte limit/u);
  }
});

test("malformed documents and untrusted transport diagnostics fail without echoing content", async () => {
  const bad = new AcpCatalog(fetcher(() => new Response('{"version":"secret"}')));
  await assert.rejects(bad.read(), { message: "ACP registry version: unsupported registry version" });
  const transport = new AcpCatalog(fetcher(() => { throw new Error("https://private.invalid/?secret=value"); }));
  await assert.rejects(transport.read(), { message: "ACP catalog could not be read" });
  const utf8 = new AcpCatalog(fetcher(() => new Response(new Uint8Array([0xff]))));
  await assert.rejects(utf8.read(), { message: "ACP catalog could not be read" });
});
