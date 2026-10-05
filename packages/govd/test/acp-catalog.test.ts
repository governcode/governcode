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
    assert.deepEqual(init?.headers, { Accept: "application/json" });
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

// These tests defer timers and advance only the monotonic clock. All transport is in memory.
const timeout = { message: "ACP catalog request timed out" };
function clock(t: import("node:test").TestContext, initial = 0) {
  let now = initial;
  const timers: { run: () => void; delay: number | undefined; cleared: boolean }[] = [];
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", ((run: () => void, delay?: number) => {
    const timer = { run, delay, cleared: false };
    timers.push(timer);
    return timer as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", ((timer: unknown) => {
    const scheduled = timers.find(value => value === timer);
    assert.ok(scheduled);
    scheduled.cleared = true;
  }) as typeof clearTimeout);
  t.after(() => t.mock.restoreAll());
  return { set(value: number) { now = value; }, timers };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
// A finite microtask budget detects cancellation stalls without a competing timeout or sleep.
async function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  let result: PromiseSettledResult<T> | undefined;
  void promise.then(value => { result = { status: "fulfilled", value }; },
    reason => { result = { status: "rejected", reason }; });
  for (let i = 0; i < 100 && !result; i++) await Promise.resolve();
  assert.ok(result, "request must settle without awaiting cancellation");
  return result;
}
async function refuses(promise: Promise<unknown>, message: string) {
  const result = await settled(promise);
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.reason.message, message);
}
function observeReader(t: import("node:test").TestContext, response: Response) {
  const body = response.body!;
  const acquire = body.getReader.bind(body);
  const cancelBody = body.cancel.bind(body);
  let acquired = 0, cancelled = 0, released = 0, bodyCancelled = 0;
  t.mock.method(body, "cancel", (reason?: unknown) => { bodyCancelled++; return cancelBody(reason); });
  t.mock.method(body, "getReader", () => {
    acquired++;
    const reader = acquire();
    const cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader);
    t.mock.method(reader, "cancel", (reason?: unknown) => { cancelled++; return cancel(reason); });
    t.mock.method(reader, "releaseLock", () => { released++; release(); });
    return reader;
  });
  return { counts: () => ({ acquired, cancelled, released }), bodyCancellations: () => bodyCancelled };
}

test("absolute deadline refuses fetch, chunk and EOF at the boundary with timers deferred", { concurrency: false }, async t => {
  for (const seam of ["fetch", "chunk", "EOF"] as const) for (const at of [9_999, 10_000, 10_001]) {
    await t.test(`${seam} at ${at} ms`, async t => {
      const time = clock(t);
      let cancelled = 0, chunks = 0;
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks++ === 0) {
            if (seam === "chunk") time.set(at);
            controller.enqueue(new TextEncoder().encode(json));
          } else {
            if (seam === "EOF") time.set(at);
            controller.close();
          }
        },
        cancel() { cancelled++; },
      }, { highWaterMark: 0 }));
      const reader = observeReader(t, response);
      let signal: AbortSignal | undefined, calls = 0;
      const catalog = new AcpCatalog(fetcher((_url, init) => {
        calls++; signal = init!.signal!;
        if (seam === "fetch") time.set(at);
        return response;
      }));
      if (at < 10_000) {
        const value = await catalog.read();
        assert.equal(await catalog.read(), value);
        assert.equal(calls, 1);
        assert.equal(signal!.aborted, false);
        assert.deepEqual(reader.counts(), { acquired: 1, cancelled: 0, released: 1 });
      } else {
        await refuses(catalog.read(), timeout.message);
        assert.equal(signal!.aborted, true);
        assert.deepEqual(reader.counts(), seam === "fetch" ? { acquired: 0, cancelled: 0, released: 0 } :
          { acquired: 1, cancelled: 1, released: 1 });
        assert.equal(cancelled, seam === "EOF" ? 0 : 1);
      }
      assert.equal(response.body!.locked, false);
      assert.equal(reader.bodyCancellations(), seam === "fetch" && at >= 10_000 ? 1 : 0);
      assert.equal(time.timers.length, 1);
      assert.equal(time.timers[0].delay, 10_000);
      assert.equal(time.timers[0].cleared, true);
    });
  }
});

test("successive chunks never renew the original request budget", async t => {
  const time = clock(t, 123);
  let chunk = 0;
  const bytes = new TextEncoder().encode(json);
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (chunk === 3) { controller.close(); return; }
    time.set([4_123, 8_123, 10_123][chunk]);
    controller.enqueue(bytes.subarray(Math.floor(chunk * bytes.length / 3), Math.floor(++chunk * bytes.length / 3)));
  } }, { highWaterMark: 0 }));
  const reader = observeReader(t, response);
  await refuses(new AcpCatalog(fetcher(() => response)).read(), timeout.message);
  assert.equal(chunk, 3);
  assert.equal(time.timers.length, 1);
  assert.deepEqual(reader.counts(), { acquired: 1, cancelled: 1, released: 1 });
  assert.equal(reader.bodyCancellations(), 0);
});

test("synchronous processing cannot admit a snapshot after the deadline", { concurrency: false }, async t => {
  for (const stage of ["concatenation", "UTF-8", "registry", "hash", "snapshot"] as const) {
    await t.test(stage, async t => {
      const time = clock(t);
      const response = new Response(json);
      const reader = observeReader(t, response);
      let advanced = false, signal: AbortSignal | undefined;
      const advance = () => { advanced = true; time.set(10_000); };
      if (stage === "concatenation") {
        const original = Buffer.concat;
        t.mock.method(Buffer, "concat", (...args: Parameters<typeof Buffer.concat>) => {
          const result = original(...args); advance(); return result;
        });
      } else if (stage === "UTF-8") {
        const original = TextDecoder.prototype.decode;
        t.mock.method(TextDecoder.prototype, "decode", function(this: TextDecoder, ...args: Parameters<typeof original>) {
          const result = original.apply(this, args); advance(); return result;
        });
      } else if (stage === "registry") {
        const original = JSON.parse;
        t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
          const result = original(...args); advance(); return result;
        });
      } else if (stage === "hash") {
        const prototype = Object.getPrototypeOf(createHash("sha256"));
        const original = prototype.digest;
        t.mock.method(prototype, "digest", function(this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args); advance(); return result;
        });
      } else {
        const original = Date.prototype.toISOString;
        t.mock.method(Date.prototype, "toISOString", function(this: Date) {
          const result = original.call(this); advance(); return result;
        });
      }
      await refuses(new AcpCatalog(fetcher((_url, init) => { signal = init!.signal!; return response; })).read(), timeout.message);
      assert.equal(advanced, true);
      assert.equal(signal!.aborted, true);
      assert.deepEqual(reader.counts(), { acquired: 1, cancelled: 0, released: 1 });
      assert.equal(response.body!.locked, false);
      assert.equal(reader.bodyCancellations(), 0);
      assert.equal(time.timers[0].cleared, true);
    });
  }
});

test("publication expiry rejects every shared reader, invalidates cache and permits one retry", async t => {
  const time = clock(t);
  let calls = 0, signal: AbortSignal | undefined;
  const catalog = new AcpCatalog(fetcher((_url, init) => { calls++; signal = init!.signal!; return new Response(json); }));
  const old = await catalog.read();
  const original = Object.freeze;
  t.mock.method(Object, "freeze", (<T>(value: T): Readonly<T> => {
    const frozen = original(value);
    if (value && typeof value === "object" && "source" in value && "registry" in value) {
      queueMicrotask(() => {
        assert.equal(time.timers[1].cleared, false, "timer survives loader completion");
        time.set(10_000);
      });
    }
    return frozen;
  }) as typeof Object.freeze);
  const readers = [catalog.read(true), catalog.read(), catalog.read(true)];
  const results = await Promise.all(readers.map(settled));
  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.reason.message, timeout.message);
  }
  assert.equal(calls, 2);
  assert.equal(signal!.aborted, true);
  assert.equal(time.timers[1].cleared, true);
  t.mock.restoreAll();
  clock(t);
  const [current, shared] = await Promise.all([catalog.read(), catalog.read()]);
  assert.notEqual(current, old);
  assert.equal(shared, current);
  assert.equal(await catalog.read(), current);
  assert.equal(calls, 3);
});

test("late failures prefer timeout while on-time diagnostics retain their classification", { concurrency: false }, async t => {
  for (const kind of ["transport", "body", "HTTP", "schema", "UTF-8"] as const) for (const at of [9_999, 10_000, 10_001]) {
    await t.test(`${kind} at ${at} ms`, async t => {
      const time = clock(t);
      const underlying = new Error("https://example.org/untrusted-transport");
      let signal: AbortSignal | undefined;
      if (kind === "schema") {
        const original = JSON.parse;
        t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
          const result = original(...args); time.set(at); return result;
        });
      }
      const catalog = new AcpCatalog(fetcher((_url, init) => {
        signal = init!.signal!;
        if (kind === "transport") { time.set(at); throw underlying; }
        if (kind === "body") return new Response(new ReadableStream({ pull(controller) {
          time.set(at); controller.error(underlying);
        } }, { highWaterMark: 0 }));
        if (kind === "HTTP") { time.set(at); return new Response(json, { status: 503 }); }
        if (kind === "UTF-8") { time.set(at); return new Response(new Uint8Array([0xff])); }
        return new Response('{"version":"unsupported"}');
      }));
      const message = at >= 10_000 ? timeout.message : kind === "HTTP" ? "official catalog returned HTTP 503" :
        kind === "schema" ? "ACP registry version: unsupported registry version" : "ACP catalog could not be read";
      await refuses(catalog.read(), message);
      assert.equal(signal!.aborted, true);
      assert.equal(time.timers[0].cleared, true);
    });
  }
});

test("timer aborts the fetch signal during abort-aware fetch and body waits", { concurrency: false }, async t => {
  for (const seam of ["fetch", "body"] as const) await t.test(seam, async t => {
    const time = clock(t);
    const waiting = deferred<Response>();
    const ready = deferred<void>();
    let signal: AbortSignal | undefined, response: Response | undefined;
    let reader: ReturnType<typeof observeReader> | undefined;
    const catalog = new AcpCatalog(fetcher((_url, init) => {
      signal = init!.signal!;
      if (seam === "fetch") {
        signal.addEventListener("abort", () => waiting.reject(new Error("aborted")), { once: true });
        ready.resolve();
        return waiting.promise;
      }
      response = new Response(new ReadableStream({ start(controller) {
        signal!.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      }, pull() { ready.resolve(); } }, { highWaterMark: 0 }));
      reader = observeReader(t, response);
      return response;
    }));
    const request = catalog.read();
    await ready.promise;
    assert.equal(signal!.aborted, false);
    // The fired timer is authoritative even if a clock sample has not advanced.
    time.timers[0].run();
    await refuses(request, timeout.message);
    assert.equal(signal!.aborted, true);
    assert.equal(time.timers[0].cleared, true);
    if (response) {
      assert.equal(response.body!.locked, false);
      assert.deepEqual(reader!.counts(), { acquired: 1, cancelled: 1, released: 1 });
      assert.equal(reader!.bodyCancellations(), 0);
    }
  });
});

test("pending and rejected cancellations never delay or replace failure", { concurrency: false }, async t => {
  for (const cancellation of ["pending", "rejected"] as const) {
    for (const kind of ["HTTP", "announced", "streamed", "reader", "overdue", "acquisition"] as const) {
      await t.test(`${kind}, ${cancellation} cancellation`, async t => {
        const time = clock(t);
        let cancelled = 0, pulled = false, signal: AbortSignal | undefined;
        const response = new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled) { controller.close(); return; }
            pulled = true;
            if (kind === "overdue") time.set(10_001);
            controller.enqueue(kind === "streamed" ? new Uint8Array(ACP_REGISTRY_LIMITS.bytes + 1) : new TextEncoder().encode(json));
          },
          cancel() {
            cancelled++;
            return cancellation === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("cancel failed"));
          },
        }, { highWaterMark: 0 }), { status: kind === "HTTP" ? 503 : 200,
          headers: kind === "announced" ? { "content-length": String(ACP_REGISTRY_LIMITS.bytes + 1) } : {} });
        const reader = observeReader(t, response);
        if (kind === "reader") {
          const acquire = response.body!.getReader.bind(response.body!);
          t.mock.method(response.body!, "getReader", () => {
            const owned = acquire();
            t.mock.method(owned, "read", () => Promise.reject(new Error("read failed")));
            return owned;
          });
        } else if (kind === "acquisition") {
          t.mock.method(response.body!, "getReader", () => { throw new Error("acquisition failed"); });
        }
        const catalog = new AcpCatalog(fetcher((_url, init) => { signal = init!.signal!; return response; }));
        const message = kind === "HTTP" ? "official catalog returned HTTP 503" : kind === "announced" || kind === "streamed" ?
          "official catalog exceeds the byte limit" : kind === "overdue" ? timeout.message : "ACP catalog could not be read";
        await refuses(catalog.read(), message);
        assert.equal(cancelled, 1);
        assert.equal(signal!.aborted, true);
        assert.equal(response.body!.locked, false);
        assert.deepEqual(reader.counts(), ["streamed", "reader", "overdue"].includes(kind) ?
          { acquired: 1, cancelled: 1, released: 1 } : { acquired: 0, cancelled: 0, released: 0 });
        assert.equal(reader.bodyCancellations(), ["streamed", "reader", "overdue"].includes(kind) ? 0 : 1);
        assert.equal(time.timers[0].cleared, true);
        // node:test also treats an unhandled rejection as a test failure after this turn.
        await new Promise<void>(resolve => setImmediate(resolve));
      });
    }
  }
});

test("cached reads keep the wall-clock TTL and do not start a request timer", async t => {
  const time = clock(t);
  let wall = 1_000, calls = 0;
  t.mock.method(Date, "now", () => wall);
  const catalog = new AcpCatalog(fetcher(() => { calls++; return new Response(json); }));
  const first = await catalog.read();
  time.set(1_000_000);
  wall += 10 * 60_000 - 1;
  assert.equal(await catalog.read(), first);
  assert.equal(time.timers.length, 1);
  wall++;
  assert.notEqual(await catalog.read(), first);
  assert.equal(calls, 2);
  assert.equal(time.timers.length, 2);
});
