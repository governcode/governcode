import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { inspectAcpArtifactRuntime as inspect, type AcpElfPlatform, type AcpArtifactRuntimeReason } from "../src/acp-artifact-runtime.ts";

const MAX = 134_217_728, U64 = 0xffffffffffffffffn;
const LOAD = 1, DYNAMIC = 2, INTERP = 3, NOTE = 4, PHDR = 6, TLS = 7;
const GNU = [0x6474e550, 0x6474e551, 0x6474e552, 0x6474e553];
type Segment = { tag?: number; flags?: number; offset?: bigint; address?: bigint;
  physical?: bigint; file?: bigint; memory?: bigint; align?: bigint };
function write(bytes: Uint8Array, offset: number, width: number, value: bigint | number) {
  let remaining = BigInt(value);
  for (let i = 0; i < width; i++) { bytes[offset + i] = Number(remaining & 255n); remaining >>= 8n; }
}
function segment(bytes: Uint8Array, index: number, fields: Segment = {}, table = 64) {
  const at = table + index * 56;
  write(bytes, at, 4, fields.tag ?? LOAD); write(bytes, at + 4, 4, fields.flags ?? 4);
  write(bytes, at + 8, 8, fields.offset ?? 0n); write(bytes, at + 16, 8, fields.address ?? 0n);
  write(bytes, at + 24, 8, fields.physical ?? 0n); write(bytes, at + 32, 8, fields.file ?? 1n);
  write(bytes, at + 40, 8, fields.memory ?? fields.file ?? 1n); write(bytes, at + 48, 8, fields.align ?? 1n);
}
function fixture(segments: Segment[] = [{}], size = 64 + segments.length * 56,
  platform: AcpElfPlatform = "linux-x86_64", table = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  write(bytes, 16, 2, 2); write(bytes, 18, 2, platform === "linux-x86_64" ? 62 : 183);
  write(bytes, 20, 4, 1); write(bytes, 32, 8, table); write(bytes, 52, 2, 64);
  write(bytes, 54, 2, 56); write(bytes, 56, 2, segments.length);
  segments.forEach((fields, i) => segment(bytes, i, fields, table));
  return bytes;
}
function refusal(input: unknown, reason: AcpArtifactRuntimeReason, index: number | null = null,
  platform?: unknown) {
  const result = inspect(input as Uint8Array, (arguments.length >= 4 ? platform : "linux-x86_64") as AcpElfPlatform);
  assert.deepEqual(result, { status: "refused", reason, programHeaderIndex: index });
  assert.ok(Object.isFrozen(result)); return result;
}
function observed(bytes: Uint8Array, platform: AcpElfPlatform = "linux-x86_64") {
  const result = inspect(bytes, platform); assert.equal(result.status, "observed");
  assert.ok(Object.isFrozen(result)); return result;
}

test("exact flat metadata for invented architectures, OSABIs and object types", () => {
  for (const platform of ["linux-x86_64", "linux-aarch64"] as const) {
    for (const osabi of [0, 3]) for (const elfType of [2, 3]) {
      const bytes = fixture([{}], 120, platform); bytes[7] = osabi; write(bytes, 16, 2, elfType);
      const result = observed(bytes, platform);
      assert.deepEqual(result, { status: "observed", evidence: "no-interpreter-or-dynamic-segments",
        format: "elf64-le-v1", platform, machine: platform === "linux-x86_64" ? 62 : 183,
        osabi, elfType: elfType === 2 ? "ET_EXEC" : "ET_DYN", bytes: 120,
        programHeaderOffset: 64, programHeaders: 1, loadSegments: 1 });
      assert.ok(Object.values(result).every(value => typeof value === "string" || typeof value === "number"));
      assert.throws(() => Object.assign(result, { bytes: 0 }), TypeError);
    }
  }
});

test("primitive platform and byte brands refuse with zero coercion, getter or proxy callbacks", () => {
  let calls = 0; const trap = () => { calls++; throw new Error("invented fixture detail"); };
  const bytes = fixture(), proxy = new Proxy(bytes, { get: trap, getPrototypeOf: trap, ownKeys: trap,
    getOwnPropertyDescriptor: trap });
  const revoked = Proxy.revocable(bytes, {}); revoked.revoke();
  const spoof = Object.create(Uint8Array.prototype);
  Object.defineProperties(spoof, { buffer: { get: trap }, byteLength: { get: trap }, length: { get: trap },
    [Symbol.toStringTag]: { get: trap }, [Symbol.iterator]: { get: trap } });
  for (const input of [null, undefined, 1, 1n, true, "bytes", {}, [], new ArrayBuffer(120),
    new Uint8ClampedArray(120), new Int8Array(120), new DataView(new ArrayBuffer(120)),
    spoof, proxy, revoked.proxy, Object.create(proxy)]) refusal(input, "invalid-bytes");
  for (const platform of [null, undefined, 62, {}, new String("linux-x86_64"), "linux", "LINUX-X86_64",
    { [Symbol.toPrimitive]: trap, toString: trap }, proxy, revoked.proxy]) {
    refusal(bytes, "invalid-platform", null, platform);
  }
  assert.equal(calls, 0);
});

test("genuine accessor overrides and subclass species are bypassed", () => {
  let calls = 0; const trap = () => { calls++; throw new Error("invented fixture override"); };
  class ByteSubclass extends Uint8Array { static get [Symbol.species](): Uint8ArrayConstructor { return trap(); } }
  const bytes = new ByteSubclass(fixture());
  for (const key of ["buffer", "byteOffset", "byteLength", "length", "constructor", "slice", "subarray", "set"])
    Object.defineProperty(bytes, key, { get: trap });
  Object.defineProperty(bytes, Symbol.iterator, { get: trap });
  Object.defineProperty(bytes, Symbol.toStringTag, { get: trap });
  observed(bytes); assert.equal(calls, 0);
});

test("copies the exact ordinary/Buffer view and accepts cross-realm native brands", () => {
  const payload = fixture(), pool = new Uint8Array(200).fill(0xff); pool.set(payload, 17);
  const view = new Uint8Array(pool.buffer, 17, payload.length); observed(view);
  const buffer = Buffer.alloc(200, 0xff); buffer.set(payload, 17);
  observed(buffer.slice(17, 17 + payload.length));
  const foreign = runInNewContext("new Uint8Array(160)") as Uint8Array;
  foreign.set(payload, 8); observed(new Uint8Array(foreign.buffer, 8, payload.length));
  const foreignView = runInNewContext("new Uint8Array(120)") as Uint8Array;
  foreignView.set(payload); observed(foreignView);
});

test("shared and growable shared backing refuse before any source properties", () => {
  for (const backing of [new SharedArrayBuffer(120), new SharedArrayBuffer(120, { maxByteLength: 240 })]) {
    const bytes = new Uint8Array(backing); bytes.set(fixture());
    let calls = 0;
    Object.defineProperty(bytes, "buffer", { get: () => { calls++; throw new Error("override"); } });
    refusal(bytes, "shared-backing"); assert.equal(calls, 0);
  }
  refusal(runInNewContext("new Uint8Array(new SharedArrayBuffer(120))"), "shared-backing");
});

test("resizable backing refuses tracking, fixed-length and resized out-of-bounds views", () => {
  const backing = new ArrayBuffer(120, { maxByteLength: 240 });
  const tracking = new Uint8Array(backing), fixed = new Uint8Array(backing, 0, 120);
  tracking.set(fixture()); refusal(tracking, "resizable-backing"); refusal(fixed, "resizable-backing");
  backing.resize(0); refusal(tracking, "resizable-backing"); refusal(fixed, "resizable-backing");
  refusal(runInNewContext("new Uint8Array(new ArrayBuffer(120, { maxByteLength: 240 }))"), "resizable-backing");
});

test("detached backing is distinct from an ordinary empty view", () => {
  const bytes = fixture(); structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  refusal(bytes, "detached-backing"); refusal(new Uint8Array(0), "artifact-size");
  const foreign = runInNewContext("new Uint8Array(120)") as Uint8Array;
  structuredClone(foreign.buffer, { transfer: [foreign.buffer] }); refusal(foreign, "detached-backing");
});

test("later mutation and transfer cannot alter the frozen snapshot metadata", () => {
  const bytes = fixture(), result = observed(bytes), expected = { ...result };
  bytes.fill(0); assert.deepEqual(result, expected);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); assert.deepEqual(result, expected);
  assert.equal(Object.getOwnPropertySymbols(result).length, 0);
});

test("captured natives survive later getter, copy, utility and freezing overrides", () => {
  const bytes = fixture(), prototype = Object.getPrototypeOf(Uint8Array.prototype);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "buffer")!;
  const set = Uint8Array.prototype.set, freeze = Object.freeze, proxy = types.isProxy, brand = types.isUint8Array;
  let calls = 0; const trap = () => { calls++; throw new Error("native override"); };
  let result;
  try {
    Object.defineProperty(prototype, "buffer", { get: trap, configurable: true });
    Uint8Array.prototype.set = trap; Object.freeze = trap; types.isProxy = trap;
    types.isUint8Array = (object: unknown): object is Uint8Array => trap();
    result = inspect(bytes, "linux-x86_64");
  } finally {
    Object.defineProperty(prototype, "buffer", descriptor); Uint8Array.prototype.set = set;
    Object.freeze = freeze; types.isProxy = proxy; types.isUint8Array = brand;
  }
  assert.equal(result?.status, "observed"); assert.ok(Object.isFrozen(result)); assert.equal(calls, 0);
});

test("64-byte minimum, exact 128 MiB cap and over-cap supplied views", () => {
  refusal(fixture().subarray(0, 64), "program-table-range");
  const bytes = new Uint8Array(MAX + 1); bytes.set(fixture());
  observed(new Uint8Array(bytes.buffer, 0, MAX)); refusal(bytes, "artifact-size");
});

test("every truncated ELF-header and three-entry table boundary refuses", () => {
  const bytes = fixture([{}, { tag: NOTE }, { tag: 0 }]);
  for (let size = 0; size < bytes.length; size++) {
    refusal(bytes.subarray(0, size), size < 64 ? "artifact-size" : "program-table-range");
  }
  observed(bytes);
  const maximum = fixture(Array.from({ length: 256 }, (_, i) => i ? { tag: 0 } : {}));
  for (let size = 64; size < maximum.length; size++) refusal(maximum.subarray(0, size), "program-table-range");
  observed(maximum);
});

test("identification and conservative fixed-header fields refuse deterministically", () => {
  for (const [at, value] of [[0, 0], [1, 0], [2, 0], [3, 0], [4, 1], [5, 2], [6, 0], [7, 1], [8, 1]]) {
    const bytes = fixture(); bytes[at] = value; refusal(bytes, "elf-identification");
  }
  for (const [at, width, value] of [[16, 2, 0], [16, 2, 1], [16, 2, 4], [20, 4, 0],
    [20, 4, 2], [48, 4, 1], [52, 2, 63], [52, 2, 65]]) {
    const bytes = fixture(); write(bytes, at, width, value); refusal(bytes, "elf-header");
  }
  for (const machine of [0, 3, 183, 65535]) {
    const bytes = fixture(); write(bytes, 18, 2, machine); refusal(bytes, "platform-machine");
  }
  refusal(fixture(), "platform-machine", null, "linux-aarch64");
  refusal(fixture([{}], 120, "linux-aarch64"), "platform-machine");
});

test("program counts, entry widths, offsets, precision and unsigned table overflow", () => {
  const maximum = fixture(Array.from({ length: 256 }, (_, i) => i ? { tag: 0 } : {})); observed(maximum);
  for (const count of [0, 257, 65534, 65535]) {
    const bytes = fixture(); write(bytes, 56, 2, count); write(bytes, 40, 8, U64);
    refusal(bytes, count === 65535 ? "extended-program-count" : "program-header-count");
  }
  for (const width of [0, 55, 57, 65535]) {
    const bytes = fixture(); write(bytes, 54, 2, width); refusal(bytes, "program-header-layout");
  }
  for (const offset of [0n, 56n, 63n, 65n, 71n]) {
    const bytes = fixture(); write(bytes, 32, 8, offset); refusal(bytes, "program-header-layout");
  }
  for (const offset of [128n, (1n << 53n) + 8n, U64 - 7n]) {
    const bytes = fixture(); write(bytes, 32, 8, offset); refusal(bytes, "program-table-range");
  }
  observed(fixture([{}], 128, "linux-x86_64", 72));
});

test("forbidden tags at first, middle and final allowed header precede field interpretation", () => {
  for (const tag of [INTERP, DYNAMIC]) for (const i of [0, 128, 255]) for (const malformed of [false, true]) {
    const bytes = fixture(Array.from({ length: 256 }, (_, at) => at ? { tag: 0 } : {}));
    segment(bytes, i, { tag, file: 0n, memory: 0n, offset: malformed ? U64 : 0n,
      flags: malformed ? 0xffffffff : 0, align: malformed ? 3n : 1n });
    refusal(bytes, tag === INTERP ? "interpreter-segment" : "dynamic-segment", i);
  }
});

test("accepted metadata tags and PT_NULL undefined fields; unknown tags refuse", () => {
  for (const tag of [NOTE, TLS, ...GNU]) observed(fixture([{}, { tag, file: 0n, memory: 0n }]));
  const bytes = fixture([{}, { tag: 0 }]); bytes.fill(0xff, 124); observed(bytes);
  for (const tag of [5, 8, 0x6474e554, 0x70000001, 0xffffffff])
    refusal(fixture([{}, { tag }]), "unsupported-segment-type", 1);
  // NOTE/GNU envelopes do not interpret virtual memory or payload contents.
  observed(fixture([{}, { tag: NOTE, address: U64, memory: U64, physical: U64 }]));
});

test("all supported non-null tags enforce generic file range, flags and alignment", () => {
  for (const tag of [LOAD, NOTE, PHDR, TLS, ...GNU]) {
    for (const fields of [{ offset: 233n, file: 0n }, { offset: U64, file: 1n },
      { offset: (1n << 53n) + 1n, file: 0n }, { offset: 231n, file: 2n }])
      refusal(fixture([{}, { tag, ...fields }, { tag: 0 }]), "segment-range", 1);
    for (const flags of [8, 0x80000000, 0xffffffff])
      refusal(fixture([{}, { tag, flags }]), "segment-flags", 1);
    for (const align of [3n, 6n, U64])
      refusal(fixture([{}, { tag, align }]), "segment-alignment", 1);
  }
  observed(fixture([{}, { tag: NOTE, offset: 176n, file: 0n }]));
  for (const align of [0n, 1n, 2n, 1n << 63n]) observed(fixture([{ align, flags: 7 }]));
});

test("load file/memory size, unsigned range, congruence, order and positive-size requirement", () => {
  for (const fields of [{ file: 2n, memory: 1n }, { address: U64, memory: 1n },
    { offset: 1n, address: 0n, align: 2n }]) refusal(fixture([fields]), "load-layout", 0);
  refusal(fixture([{ address: 2n }, { address: 1n }]), "load-layout", 1);
  refusal(fixture([{ file: 0n, memory: 0n }]), "missing-load");
  refusal(fixture([{ tag: 0 }, { tag: NOTE }]), "missing-load");
  observed(fixture([{ file: 0n, memory: 0n }, {}]));
  observed(fixture([{ address: U64 - 1n }, { address: U64, file: 0n, memory: 0n }]));
});

test("deliberately permitted zero entry, nonexecuting/RWX flags, overlapping loads and ignored sections", () => {
  const bytes = fixture([{ file: 176n, memory: 200n, flags: 0 },
    { file: 176n, memory: 200n, flags: 7, physical: U64 }]);
  write(bytes, 16, 2, 3); write(bytes, 24, 8, 0); write(bytes, 40, 8, U64);
  for (const at of [58, 60, 62]) write(bytes, at, 2, 65535);
  bytes.fill(0xff, 9, 16); observed(bytes);
  write(bytes, 24, 8, U64); write(bytes, 40, 8, 64); observed(bytes);
});

function phdrFixture() {
  return fixture([{ tag: PHDR, offset: 64n, address: 0x1040n, file: 112n, memory: 112n },
    { address: 0x1000n, file: 176n, memory: 176n }]);
}
test("optional PHDR exact extent, uniqueness, placement and consistent load mapping", () => {
  observed(phdrFixture());
  for (const fields of [{ offset: 63n }, { file: 111n }, { memory: 113n }, { address: U64 }]) {
    const bytes = phdrFixture(); segment(bytes, 0, { tag: PHDR, offset: 64n, address: 0x1040n,
      file: 112n, memory: 112n, ...fields }); refusal(bytes, "phdr-layout", 0);
  }
  const duplicate = fixture([{ tag: PHDR, offset: 64n, file: 168n, memory: 168n },
    { tag: PHDR, offset: 64n, file: 168n, memory: 168n }, {}]); refusal(duplicate, "phdr-layout", 1);
  refusal(fixture([{}, { tag: PHDR, offset: 64n, file: 112n, memory: 112n }]), "phdr-layout", 1);
  const mismatched = phdrFixture(); write(mismatched, 80, 8, 0x1041n); refusal(mismatched, "phdr-layout");
  const short = phdrFixture(); segment(short, 1, { address: 0x1000n, file: 175n }); refusal(short, "phdr-layout");
  const offset = phdrFixture(); segment(offset, 1, { offset: 65n, address: 0x1041n, file: 111n });
  refusal(offset, "phdr-layout");
  // A later load can supply the mapping; overlap and same-address loads are permitted.
  observed(fixture([{ tag: PHDR, offset: 64n, address: 64n, file: 168n, memory: 168n },
    { file: 1n }, { file: 232n }]));
  observed(fixture([{ tag: PHDR, offset: 64n, address: 0n, file: 112n, memory: 112n },
    { offset: 64n, address: 0n, file: 112n }]));
});

test("TLS template and GNU STACK file envelope restrictions grant no runtime claim", () => {
  for (const fields of [{ file: 2n, memory: 1n }, { address: U64, memory: 1n }])
    refusal(fixture([{}, { tag: TLS, ...fields }]), "tls-layout", 1);
  observed(fixture([{}, { tag: TLS, file: 0n, memory: 0n, address: U64 }]));
  refusal(fixture([{}, { tag: GNU[1], file: 1n }]), "segment-range", 1);
  observed(fixture([{}, { tag: GNU[1], file: 0n, memory: U64, address: U64, flags: 7 }]));
});

test("fixed-seed small mutation corpus has bounded deterministic frozen results and refuses forbidden tags", () => {
  let seed = 0x5eeda11;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let iteration = 0; iteration < 512; iteration++) {
    const bytes = fixture([{}, { tag: NOTE, file: 0n }, { tag: 0 }]);
    for (let mutation = 0; mutation < 4; mutation++) bytes[next() % bytes.length] = next() & 255;
    const result = inspect(bytes, "linux-x86_64");
    assert.deepEqual(result, inspect(bytes, "linux-x86_64")); assert.ok(Object.isFrozen(result));
    if (result.status === "refused") {
      assert.equal(Object.keys(result).length, 3);
      assert.ok(result.programHeaderIndex === null || (result.programHeaderIndex >= 0 && result.programHeaderIndex < 3));
      assert.ok(result.reason.length <= 32);
    } else assert.equal(Object.keys(result).length, 11);
    // Keep the envelope valid while mutating undefined fields of a late forbidden entry.
    const forbidden = fixture([{}, { tag: NOTE, file: 0n }, { tag: 0 }]);
    for (let at = 180; at < forbidden.length; at++) forbidden[at] = next() & 255;
    const tag = iteration % 2 ? INTERP : DYNAMIC; write(forbidden, 176, 4, tag);
    refusal(forbidden, tag === INTERP ? "interpreter-segment" : "dynamic-segment", 2);
  }
});

test("source remains passive with only util dependency and no production importer", async () => {
  const source = await readFile(new URL("../src/acp-artifact-runtime.ts", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/gu)].map(match => match[1]), ["node:util"]);
  assert.doesNotMatch(source, /\b(?:async|await|process|fetch|require|setTimeout|setInterval|queueMicrotask|Promise)\b/u);
  assert.doesNotMatch(source, /node:(?:fs|os|path|child_process|net|http|https|crypto|timers|module)|\bimport\s*\(/u);
  assert.doesNotMatch(source, /suppliedBytes\s*[.[]|\binstanceof\b|Buffer\.from|\.slice\(|\.subarray\(|Symbol\.(?:iterator|species)|toString\(/u);
  const root = new URL("../../../", import.meta.url);
  async function scan(directory: URL) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) await scan(child);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) && entry.name !== "acp-artifact-runtime.ts") {
        const text = await readFile(child, "utf8");
        assert.doesNotMatch(text, /acp-artifact-runtime|inspectAcpArtifactRuntime/u, `production importer: ${entry.name}`);
      }
    }
  }
  for (const group of ["packages/", "apps/"]) {
    for (const entry of await readdir(new URL(group, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = new URL(`${group}${entry.name}/`, root);
      if ((await readdir(directory)).includes("src")) await scan(new URL("src/", directory));
    }
  }
});
