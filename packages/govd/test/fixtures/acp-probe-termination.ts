// Fixture-local owner. Endpoint ownership, not knowledge of the invocation ID,
// supplies provenance. No production caller or injected stream can create evidence.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { types } from "node:util";
import type { Duplex, Readable } from "node:stream";
import { startAcp, type AcpRpc } from "../../src/acp.ts";

const brand: unique symbol = Symbol("fixture namespace termination");
export type FixtureNamespaceTermination = Readonly<{ [brand]: true }>;
type Outcome = Readonly<{ kind: "exited"; code: number } | { kind: "signalled"; signal: number } |
  { kind: "stopped" } | { kind: "setup-failed" }>;
export type FixtureTermination = Readonly<
  { status: "proven"; evidence: FixtureNamespaceTermination; outcome: Outcome } |
  { status: "refused"; reason: "invalid-input" | "unsupported" | "admission" } |
  { status: "unproven"; reason: "spawn" | "record" | "channel" | "producer" | "deadline" | "native-unproven" }>;
export type FixtureInvocation = Readonly<{ rpc: AcpRpc; termination: Promise<FixtureTermination>; stop(): void }>;
// Caller precondition: these are trusted test-created assets, including the driver
// program itself. Path validation authenticates no binary and binds no receipt.
export type FixtureAssets = Readonly<{ driver: string; target: string; policy: string; cwd: string;
  env: Readonly<{ HOME: string; TMPDIR: string; PATH: "/usr/bin"; LANG: "C"; LC_ALL: "C" }> }>;
const scenarios = ["normal", "high-exit", "signal", "direct", "double", "detach", "signal-tree", "kill-init",
  "forge", "acp", "acp-forbidden", "acp-hang", "stdout-flood", "stderr-flood",
  "death-pre-admission", "death-post-admission", "death-mid-record", "death-full-record", "death-closed-record",
  "proof-stale", "proof-extra", "proof-truncate", "proof-missing",
  "stale-record", "extra-record", "truncated-record", "missing-record", "guard-eof", "guard-registration-failure", "guard-registration-deadline",
  "clone-failure", "pidfd-failure", "map-failure", "restrict-failure", "exec-failure", "wait-failure", "withhold", "control-error", "hold"] as const;
export type FixtureScenario = typeof scenarios[number];
const associations = new WeakMap<FixtureNamespaceTermination, { owner: object; child: ChildProcess }>();
type Candidate = { status: "proven"; outcome: Outcome } | Exclude<FixtureTermination, { status: "proven" }>;
const unproven = (reason: Extract<FixtureTermination, { status: "unproven" }>["reason"]): Candidate => ({ status: "unproven", reason });

// This class cannot construct opaque evidence. Exactly one fixed allocation; byte
// 33 poisons immediately, including a huge first chunk. No recovery after failure.
class Join {
  readonly buffer = Buffer.alloc(32);
  bytes = 0;
  ended = false;
  exitCode: number | null | undefined;
  result: Candidate | undefined;
  deadline: number;
  readonly id: Buffer;
  constructor(id: Buffer, launch: number) { this.id = id; this.deadline = launch + 11_000; }
  fail(reason: Extract<FixtureTermination, { status: "unproven" }>["reason"]): void {
    this.result ??= unproven(reason);
  }
  time(now: number): void { if (now >= this.deadline) this.fail("deadline"); }
  stop(now: number): void { this.deadline = Math.min(this.deadline, now + 3000); this.time(now); }
  data(chunk: Buffer, now: number): void {
    this.time(now);
    if (this.result) return;
    if (this.ended || chunk.length > 32 - this.bytes) { this.bytes = 33; this.fail("record"); return; }
    chunk.copy(this.buffer, this.bytes); this.bytes += chunk.length;
    if (this.bytes === 32 && !this.decode()) this.fail("record");
    this.join(now);
  }
  end(now: number): void {
    this.time(now); if (this.result) return;
    this.ended = true;
    if (this.bytes !== 32 || !this.decode()) this.fail("record");
    this.join(now);
  }
  close(now: number): void { this.time(now); if (!this.ended) this.fail("channel"); }
  exit(code: number | null, signal: string | null, now: number): void {
    this.time(now); if (this.result) return;
    this.exitCode = signal === null ? code : null;
    if (this.exitCode === null || ![0, 64, 65, 66, 70].includes(this.exitCode)) this.fail("producer");
    this.join(now);
  }
  private decode(): Candidate | undefined {
    const b = this.buffer, kind = b[5], detail = b[6], value = b.readUInt32BE(24);
    if (!b.subarray(0, 4).equals(Buffer.from("GPLT")) || b[4] !== 1 || b[7] !== 0 ||
      !b.subarray(8, 24).equals(this.id) || b.readUInt32BE(28) !== 0) return;
    if (kind === 1) {
      if (detail === 1 && value <= 255) return { status: "proven", outcome: { kind: "exited", code: value } };
      if (detail === 2 && value >= 1 && value <= 64) return { status: "proven", outcome: { kind: "signalled", signal: value } };
      if (detail === 3 && value === 0) return { status: "proven", outcome: { kind: "stopped" } };
      if (detail === 4 && value === 0) return { status: "proven", outcome: { kind: "setup-failed" } };
    }
    if (kind === 2 && value === 0 && detail >= 1 && detail <= 3)
      return { status: "refused", reason: (["invalid-input", "unsupported", "admission"] as const)[detail - 1] };
    if (kind === 3 && detail === 1 && value === 0) return unproven("native-unproven");
  }
  private join(now: number): void {
    this.time(now);
    if (this.result || !this.ended || this.exitCode === undefined) return;
    const candidate = this.decode();
    if (!candidate) { this.fail("record"); return; }
    const expected = candidate.status === "proven" ? 0 : candidate.status === "unproven" ? 70 :
      ({ "invalid-input": 64, unsupported: 65, admission: 66 })[candidate.reason];
    this.result = this.exitCode === expected ? candidate : unproven("producer");
  }
}

function plainSnapshot(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("Invalid fixture assets");
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))) throw new Error("Invalid fixture assets");
  const copy: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(input, k)!;
    if (!("value" in d)) throw new Error("Invalid fixture assets");
    copy[k] = d.value;
  }
  return copy;
}
function snapshot(assets: FixtureAssets, scenario: FixtureScenario): FixtureAssets {
  if (!scenarios.includes(scenario)) throw new Error("Invalid fixture scenario");
  const a = plainSnapshot(assets, ["driver", "target", "policy", "cwd", "env"]);
  for (const k of ["driver", "target", "policy", "cwd"]) {
    const v = a[k];
    if (typeof v !== "string" || !v.isWellFormed() || !isAbsolute(v) || v === "/" ||
      Buffer.byteLength(v) > 3072 || /[\p{Cc}:]/u.test(v) || v.slice(1).split("/").some(p => !p || p === "." || p === ".."))
      throw new Error("Invalid fixture path");
  }
  const e = plainSnapshot(a.env, ["HOME", "TMPDIR", "PATH", "LANG", "LC_ALL"]);
  if (![e.HOME, e.TMPDIR].every(v => typeof v === "string" && isAbsolute(v) && v !== "/" &&
    v.isWellFormed() && Buffer.byteLength(v) <= 3072 && !/[\p{Cc}:]/u.test(v) &&
    !v.slice(1).split("/").some(p => !p || p === "." || p === "..")) || e.PATH !== "/usr/bin" || e.LANG !== "C" || e.LC_ALL !== "C")
    throw new Error("Invalid literal fixture environment");
  return Object.freeze({ ...a, env: Object.freeze({ ...e }) }) as FixtureAssets;
}

export function startNativeLifetimeFixture(assets: FixtureAssets, scenario: FixtureScenario): FixtureInvocation {
  const a = snapshot(assets, scenario), owner = Object.freeze({}), id = randomBytes(16);
  const launch = performance.now(), state = new Join(id, launch);
  let child: ChildProcess | undefined, control: Duplex | undefined;
  let resolve!: (r: FixtureTermination) => void, timer: NodeJS.Timeout | undefined, settled = false;
  const termination = new Promise<FixtureTermination>(r => { resolve = r; });
  const settle = () => {
    const now = performance.now();
    if (!settled && now >= state.deadline) state.result = unproven("deadline");
    state.time(now);
    const r = state.result;
    if (settled || !r) return;
    settled = true; clearTimeout(timer);
    if (r.status === "proven" && child && child.exitCode === 0 && child.signalCode === null) {
      const evidence: FixtureNamespaceTermination = Object.freeze({ [brand]: true as const });
      associations.set(evidence, { owner, child });
      resolve(Object.freeze({ ...r, outcome: Object.freeze(r.outcome), evidence }));
    } else resolve(Object.freeze(r.status === "proven" ? unproven("producer") as FixtureTermination : r));
    if (r.status === "unproven") control?.destroy();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.time(performance.now()); settle(); if (!settled) arm(); }, Math.max(1, Math.ceil(state.deadline - performance.now())));
  };
  const stop = () => {
    if (settled) return;
    state.stop(performance.now()); control?.destroy(); arm(); settle();
  };
  const native = {
    spawn: (() => {
      if (child) throw new Error("Fixture spawn already owned");
      child = spawn(a.driver, ["transport-v1", a.target, scenario, a.cwd, a.policy, id.toString("hex")], {
        cwd: a.cwd, env: { ...a.env }, detached: false, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      });
      control = child.stdio[3] as Duplex;
      const proof = child.stdio[4] as Readable;
      control.on("error", stop);
      proof.on("data", (b: Buffer) => { state.data(b, performance.now()); settle(); });
      proof.on("end", () => { state.end(performance.now()); settle(); });
      proof.on("close", () => { state.close(performance.now()); settle(); });
      proof.on("error", () => { state.fail("channel"); settle(); });
      child.on("exit", (code, signal) => { state.exit(code, signal, performance.now()); settle(); });
      child.on("error", () => { state.fail("spawn"); settle(); });
      return child;
    }) as typeof spawn,
    kill: ((pid: number, signal?: NodeJS.Signals | number) => {
      if (!child?.pid || pid !== -child.pid || (signal !== "SIGTERM" && signal !== "SIGKILL")) throw new Error("Unowned fixture stop");
      stop(); return true;
    }) as typeof process.kill,
  };
  const rpc = startAcp({ supervisor: a.driver, policyFile: a.policy, bin: a.target, args: [],
    cwd: a.cwd, env: { ...a.env }, outputBudget: { maxBytes: 65_536 } }, native);
  arm();
  return Object.freeze({ rpc, termination, stop });
}

// Fixed invented checks return only validation metadata. No caller bytes, process,
// identity or transport are accepted, and this path never calls the result factory.
export function syntheticLifetimeChecks(): ReadonlyArray<Readonly<{ name: string; status: string; reason?: string; bytes: number; capacity: number; pass: boolean }>> {
  const id = Buffer.alloc(16, 19), good = Buffer.alloc(32);
  good.write("GPLT"); good[4] = 1; good[5] = 1; good[6] = 1; id.copy(good, 8); good.writeUInt32BE(7, 24);
  const out: Array<{ name: string; status: string; reason?: string; bytes: number; capacity: number; pass: boolean }> = [];
  const check = (name: string, apply: (s: Join) => void, status: string, reason?: string) => {
    const s = new Join(id, 0); apply(s);
    const r = s.result;
    out.push(Object.freeze({ name, status: r?.status ?? "pending", ...(r && "reason" in r ? { reason: r.reason } : {}),
      bytes: s.bytes, capacity: s.buffer.length, pass: (r?.status ?? "pending") === status && (reason === undefined || !!(r && "reason" in r && r.reason === reason)) }));
  };
  for (let n = 0; n < 32; n++) check(`prefix-${n}`, s => { s.data(good.subarray(0, n), 1); s.end(2); s.exit(0, null, 3); }, "unproven", "record");
  for (let n = 0; n <= 32; n++) check(`split-${n}`, s => { s.data(good.subarray(0, n), 1); s.exit(0, null, 2); s.data(good.subarray(n), 3); s.end(4); }, "proven");
  for (const exitFirst of [false, true]) check(`ordering-${exitFirst}`, s => {
    if (exitFirst) s.exit(0, null, 1); s.data(good, 2); s.end(3); if (!exitFirst) s.exit(0, null, 4);
  }, "proven");
  for (const [offset, value] of [[0, 0], [0, 0xc7], [1, 0xd0], [2, 0xcc], [3, 0xd4], [4, 2], [5, 0], [5, 4], [6, 0], [6, 5], [7, 1], [8, 20], [28, 1], [31, 1], [24, 1]] as const)
    check(`invalid-${offset}-${value}`, s => { const b = Buffer.from(good); b[offset] = value; s.data(b, 1); s.end(2); s.exit(0, null, 3); }, "unproven", "record");
  for (const [detail, value, valid] of [[1, 0, true], [1, 255, true], [1, 256, false], [2, 0, false], [2, 1, true], [2, 64, true], [2, 65, false], [3, 0, true], [3, 1, false], [4, 0, true], [4, 1, false]] as const)
    check(`value-${detail}-${value}`, s => { const b = Buffer.from(good); b[6] = detail; b.writeUInt32BE(value, 24); s.data(b, 1); s.end(2); s.exit(0, null, 3); }, valid ? "proven" : "unproven");
  for (const [kind, detail, exit] of [[2, 1, 64], [2, 2, 65], [2, 3, 66], [3, 1, 70]] as const) {
    check(`classification-${kind}-${detail}`, s => { const b = Buffer.from(good); b[5] = kind; b[6] = detail; b.writeUInt32BE(0, 24); s.data(b, 1); s.end(2); s.exit(exit, null, 3); }, kind === 2 ? "refused" : "unproven");
    check(`inconsistent-${kind}-${detail}`, s => { const b = Buffer.from(good); b[5] = kind; b[6] = detail; b.writeUInt32BE(0, 24); s.data(b, 1); s.end(2); s.exit(0, null, 3); }, "unproven", "producer");
  }
  for (const [kind, detail, value] of [[2, 0, 0], [2, 4, 0], [2, 1, 1], [3, 0, 0], [3, 2, 0], [3, 1, 1]] as const)
    check(`failure-field-${kind}-${detail}-${value}`, s => { const b = Buffer.from(good); b[5] = kind; b[6] = detail; b.writeUInt32BE(value, 24); s.data(b, 1); s.end(2); s.exit(0, null, 3); }, "unproven", "record");
  check("byte-33", s => { s.data(good, 1); s.data(Buffer.alloc(1), 2); }, "unproven", "record");
  check("duplicate", s => s.data(Buffer.concat([good, good]), 1), "unproven", "record");
  check("huge-chunk", s => s.data(Buffer.alloc(100_000), 1), "unproven", "record");
  check("poison-no-recovery", s => { s.data(Buffer.alloc(33), 1); s.data(good, 2); s.end(3); s.exit(0, null, 4); }, "unproven", "record");
  check("end-only", s => s.end(1), "unproven", "record");
  check("close-not-end", s => { s.data(good, 1); s.close(2); s.exit(0, null, 3); s.end(4); }, "unproven", "channel");
  check("error-not-end", s => { s.data(good, 1); s.fail("channel"); s.exit(0, null, 3); s.end(4); }, "unproven", "channel");
  check("no-eof", s => { s.data(good, 1); s.exit(0, null, 2); s.time(11_000); }, "unproven", "deadline");
  check("no-exit", s => { s.data(good, 1); s.end(2); s.time(11_000); }, "unproven", "deadline");
  check("missing", s => { s.exit(0, null, 1); s.time(11_000); }, "unproven", "deadline");
  check("full-record-producer-death", s => { s.data(good, 1); s.end(2); s.exit(null, "SIGKILL", 3); }, "unproven", "producer");
  check("late-join", s => { s.data(good, 1); s.end(2); s.exit(0, null, 11_000); }, "unproven", "deadline");
  check("no-late-promotion", s => { s.time(11_000); s.data(good, 11_001); s.end(11_002); s.exit(0, null, 11_003); }, "unproven", "deadline");
  check("stop-deadline", s => { s.stop(10); s.stop(1000); s.data(good, 3009); s.end(3009); s.exit(0, null, 3010); }, "unproven", "deadline");
  check("launch-deadline-earlier", s => { s.stop(10_000); s.data(good, 10_999); s.end(10_999); s.exit(0, null, 11_000); }, "unproven", "deadline");
  check("pending-record", s => s.data(good, 1), "pending");
  check("pending-end", s => { s.data(good, 1); s.end(2); }, "pending");
  check("pending-exit", s => s.exit(0, null, 1), "pending");
  check("concurrent-stale", s => { const other = new Join(Buffer.alloc(16, 20), 0); other.data(good, 1); other.end(2); other.exit(0, null, 3); if (other.result?.status !== "unproven") throw new Error("stale record accepted"); s.data(good, 1); s.end(2); s.exit(0, null, 3); }, "proven");
  return Object.freeze(out);
}
