import { types } from "node:util";

export type AcpElfPlatform = "linux-x86_64" | "linux-aarch64";
export type AcpArtifactRuntimeReason =
  | "invalid-platform" | "invalid-bytes" | "shared-backing" | "resizable-backing"
  | "detached-backing" | "artifact-size" | "snapshot-failed" | "elf-identification"
  | "elf-header" | "platform-machine" | "program-header-layout" | "program-header-count"
  | "extended-program-count" | "program-table-range" | "interpreter-segment"
  | "dynamic-segment" | "unsupported-segment-type" | "segment-range" | "segment-flags"
  | "segment-alignment" | "load-layout" | "tls-layout" | "phdr-layout" | "missing-load";
export type AcpArtifactRuntimeInspection = Readonly<{
  status: "observed";
  evidence: "no-interpreter-or-dynamic-segments";
  format: "elf64-le-v1";
  platform: AcpElfPlatform;
  machine: 62 | 183;
  osabi: 0 | 3;
  elfType: "ET_EXEC" | "ET_DYN";
  bytes: number;
  programHeaderOffset: number;
  programHeaders: number;
  loadSegments: number;
}> | Readonly<{
  status: "refused";
  reason: AcpArtifactRuntimeReason;
  programHeaderIndex: number | null;
}>;

// Trusted module initialization: never consult supplied properties or species.
const NativeBytes = Uint8Array, integer = BigInt, number = Number;
const apply = Reflect.apply, freeze = Object.freeze;
const isProxy = types.isProxy, isBytes = types.isUint8Array;
const isShared = types.isSharedArrayBuffer;
const typedArray = Object.getPrototypeOf(NativeBytes.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
const backingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")!.get!;
const copy = NativeBytes.prototype.set;
const MAX_BYTES = 134_217_728, MAX_U64 = 0xffffffffffffffffn;

function refused(reason: AcpArtifactRuntimeReason, programHeaderIndex: number | null = null): AcpArtifactRuntimeInspection {
  return freeze({ status: "refused", reason, programHeaderIndex });
}
function sum(a: bigint, b: bigint): bigint | null {
  const result = a + b;
  return result <= MAX_U64 ? result : null;
}
function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 256;
}
function u32(bytes: Uint8Array, offset: number): number {
  return u16(bytes, offset) + u16(bytes, offset + 2) * 65_536;
}
function u64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | integer(bytes[offset + i]);
  return value;
}

/**
 * Describes only absence of PT_INTERP/PT_DYNAMIC in the supported private snapshot.
 * Caller-provided verified bytes are a precondition, not receipt binding performed here.
 * No payload/section traversal, execution suitability, or authority is implied.
 * Native mutation of externally backed memory is outside the trusted-runtime assumption.
 */
export function inspectAcpArtifactRuntime(suppliedBytes: Uint8Array, platform: AcpElfPlatform): AcpArtifactRuntimeInspection {
  if (platform !== "linux-x86_64" && platform !== "linux-aarch64") return refused("invalid-platform");
  if (isProxy(suppliedBytes) || !isBytes(suppliedBytes)) return refused("invalid-bytes");
  let bytes: Uint8Array, size: number;
  try {
    const backing = apply(bufferGetter, suppliedBytes, []);
    const offset = apply(offsetGetter, suppliedBytes, []);
    size = apply(lengthGetter, suppliedBytes, []);
    if (isShared(backing)) return refused("shared-backing");
    apply(backingLength, backing, []); // Ordinary ArrayBuffer brand, including cross-realm.
    if (apply(resizableGetter, backing, [])) return refused("resizable-backing");
    let view: Uint8Array;
    try { view = new NativeBytes(backing, offset, size); }
    catch { return refused("detached-backing"); }
    if (size < 64 || size > MAX_BYTES) return refused("artifact-size");
    bytes = new NativeBytes(size);
    apply(copy, bytes, [view]);
  } catch { return refused("snapshot-failed"); }

  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46 ||
      bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 ||
      (bytes[7] !== 0 && bytes[7] !== 3) || bytes[8] !== 0) return refused("elf-identification");
  const elfType = u16(bytes, 16), machine = platform === "linux-x86_64" ? 62 : 183;
  // Reserved identification padding and all section fields are intentionally ignored.
  if ((elfType !== 2 && elfType !== 3) || u32(bytes, 20) !== 1 ||
      u32(bytes, 48) !== 0 || u16(bytes, 52) !== 64) return refused("elf-header");
  if (u16(bytes, 18) !== machine) return refused("platform-machine");
  const count = u16(bytes, 56);
  if (count === 65_535) return refused("extended-program-count");
  if (count === 0 || count > 256) return refused("program-header-count");
  const tableOffset = u64(bytes, 32), tableSize = integer(count) * 56n;
  if (u16(bytes, 54) !== 56 || tableOffset < 64n || tableOffset % 8n !== 0n)
    return refused("program-header-layout");
  const limit = integer(size), tableEnd = sum(tableOffset, tableSize);
  if (tableEnd === null || tableEnd > limit) return refused("program-table-range");

  let loads = 0, positiveLoad = false, lastLoad: bigint | null = null;
  let phdrAddress: bigint | null = null, phdrMapped = false;
  for (let i = 0; i < count; i++) {
    // Entire table was bounded before any offset conversion.
    const at = number(tableOffset + integer(i) * 56n), tag = u32(bytes, at);
    if (tag === 3) return refused("interpreter-segment", i);
    if (tag === 2) return refused("dynamic-segment", i);
    if (tag === 0) continue; // PT_NULL's remaining fields are undefined.
    if (tag !== 1 && tag !== 4 && tag !== 6 && tag !== 7 &&
        tag !== 0x6474e550 && tag !== 0x6474e551 && tag !== 0x6474e552 && tag !== 0x6474e553)
      return refused("unsupported-segment-type", i);
    const flags = u32(bytes, at + 4), offset = u64(bytes, at + 8), address = u64(bytes, at + 16);
    const fileSize = u64(bytes, at + 32), memorySize = u64(bytes, at + 40), align = u64(bytes, at + 48);
    // p_paddr is deliberately uninterpreted.
    const fileEnd = sum(offset, fileSize);
    if (fileEnd === null || fileEnd > limit) return refused("segment-range", i);
    if (flags > 7) return refused("segment-flags", i);
    if (align > 1n && (align & (align - 1n)) !== 0n) return refused("segment-alignment", i);
    if (tag === 1) {
      if (fileSize > memorySize || sum(address, memorySize) === null ||
          (align > 1n && offset % align !== address % align) ||
          (lastLoad !== null && address < lastLoad)) return refused("load-layout", i);
      lastLoad = address;
      loads++;
      if (fileSize > 0n) positiveLoad = true;
      if (phdrAddress !== null && offset <= tableOffset && fileEnd >= tableEnd &&
          sum(address, tableOffset - offset) === phdrAddress) phdrMapped = true;
    } else if (tag === 7) {
      if (fileSize > memorySize || sum(address, memorySize) === null) return refused("tls-layout", i);
    } else if (tag === 0x6474e551) {
      if (fileSize !== 0n) return refused("segment-range", i);
    } else if (tag === 6) {
      if (phdrAddress !== null || loads !== 0 || offset !== tableOffset ||
          fileSize !== tableSize || memorySize !== tableSize || sum(address, memorySize) === null)
        return refused("phdr-layout", i);
      phdrAddress = address;
    }
  }
  if (phdrAddress !== null && !phdrMapped) return refused("phdr-layout");
  if (!positiveLoad) return refused("missing-load");
  return freeze({ status: "observed", evidence: "no-interpreter-or-dynamic-segments", format: "elf64-le-v1",
    platform, machine, osabi: bytes[7] as 0 | 3, elfType: elfType === 2 ? "ET_EXEC" : "ET_DYN",
    bytes: size, programHeaderOffset: number(tableOffset), programHeaders: count, loadSegments: loads });
}
