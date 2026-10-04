// Real user sockets, invented catalog and inert ELF header bytes. No provider is executed.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { AcpCatalog } from "../src/acp-catalog.ts";
import { AcpInstaller } from "../src/acp-install.ts";
import type { AcpArtifactDownloader } from "../src/acp-install-contract.ts";
import { scratch } from "./scratch.ts";

const supportedHost = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
function elf() {
  const bytes = Buffer.alloc(128);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(process.arch === "arm64" ? 183 : 62, 18);
  bytes.writeUInt32LE(1, 20); bytes.writeUInt16LE(64, 52);
  return bytes;
}
function client(path: string) {
  const socket = connect(path), events: any[] = [], waiting = new Map<number, (message: any) => void>();
  let seq = 0;
  createInterface({ input: socket }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "event") events.push(message.params);
    else { waiting.get(message.id)?.(message); waiting.delete(message.id); }
  });
  const call = (method: string, params: unknown = {}) => new Promise<any>((ok) => {
    const id = ++seq; waiting.set(id, ok); socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { socket, call, events };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(check(), "fixture timed out");
}
async function fixture(t: TestContext) {
  const root = scratch("acp-install-rpc-"), path = join(root, "run/govd.sock"), store = join(root, "state/acp-artifacts");
  const opts = { socketPath: path, ledgerPath: join(root, "state/trace.sqlite"),
    policyDir: join(root, "state/policies"), homeDir: join(root, "state/home"), supervisor: "/nonexistent-supervisor", version: "test" };
  const daemon = new Daemon(opts);
  const bytes = elf(), sha256 = createHash("sha256").update(bytes).digest("hex");
  let fetches = 0, downloads = 0, description = "Invented fixture";
  let download: AcpArtifactDownloader = async (_plan, target, signal) => {
    signal.throwIfAborted(); await target.writeFile(bytes); return { bytes: bytes.length, sha256 };
  };
  (daemon as any).catalog = new AcpCatalog(async () => {
    fetches++;
    return new Response(JSON.stringify({ version: "1.0.0", agents: [{ id: "fixture-agent", name: "Fixture Agent",
      version: "1.2.3", description, license_url: "https://example.org/LICENSE", distribution: { binary: {
        [process.arch === "arm64" ? "linux-aarch64" : "linux-x86_64"]: {
          archive: "https://downloads.example.org/1.2.3/fixture-agent", sha256, cmd: "fixture-agent", args: ["--acp"] },
      } } }] }));
  });
  (daemon as any).installer = new AcpInstaller(store, { download: async (...args) => { downloads++; return download(...args); } });
  await daemon.listen();
  const owner = client(path), observer = client(path);
  const sockets: Socket[] = [owner.socket, observer.socket];
  t.after(async () => { for (const socket of sockets) socket.destroy(); await daemon.stop(); });
  const inspect = async () => {
    const result = await owner.call("acp.inspect", { id: "fixture-agent", kind: "binary" });
    assert.equal(result.error, undefined); assert.equal(result.result.executor.supported, true);
    return result.result;
  };
  const install = (fingerprint: string) => owner.call("acp.install", { id: "fixture-agent", kind: "binary", fingerprint });
  const gate = async () => { await until(() => owner.events.some(e => e.kind === "gate")); return owner.events.find(e => e.kind === "gate"); };
  return { root, store, opts, daemon, owner, observer, inspect, install, gate, downloads: () => downloads, fetches: () => fetches,
    changeCatalog: () => { description = "Changed fixture metadata"; }, setDownload: (fn: AcpArtifactDownloader) => { download = fn; } };
}

test("installation is bound to fresh catalog bytes and requires a nonrememberable user Gate", { skip: !supportedHost }, async t => {
  const f = await fixture(t);
  await f.owner.call("settings.set", { gates: { level: "relaxed", quietReads: true } });
  const inspection = await f.inspect();
  assert.equal(inspection.eligibility.eligible, false);
  const pending = f.install(inspection.fingerprint), gate = await f.gate();
  assert.equal(f.fetches(), 2, "install refreshes even an inspection's cached catalog");
  assert.equal(f.downloads(), 0); assert.equal(existsSync(f.store), false);
  assert.deepEqual(gate.scopes, []);
  for (const bound of [inspection.fingerprint, inspection.catalog.sha256, inspection.installation.plan.source,
    inspection.installation.plan.checksum.value, "linux", "registry-advertised", "--acp"])
    assert.ok(gate.canonical.includes(bound), bound);
  assert.ok((await f.observer.call("gate.answer", { id: gate.id, answer: "allow", remember: "project" })).error);
  assert.equal(f.downloads(), 0);
  assert.equal((await f.observer.call("gate.answer", { id: gate.id, answer: "allow" })).error, undefined);
  const result = await pending;
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.result.receipt.gate, gate.id); assert.equal(f.downloads(), 1);
  assert.equal(result.result.receipt.versionEvidence, "registry-advertised");
  const installed = await f.observer.call("acp.installed");
  assert.deepEqual(installed.result.installations, [result.result.receipt]);
  const reused = await f.install(inspection.fingerprint);
  assert.deepEqual(reused.result.receipt, result.result.receipt);
  assert.equal(f.downloads(), 1); assert.equal(f.owner.events.filter(e => e.kind === "gate").length, 1);
  const again = await f.inspect();
  assert.equal(again.eligibility.eligible, false); assert.equal(f.daemon.ledger.specs().length, 0);
});

test("changed catalog and client-supplied recipe fields refuse before Gate or download", { skip: !supportedHost }, async t => {
  const f = await fixture(t), inspection = await f.inspect();
  for (const field of ["source", "sha256", "root", "plan"]) {
    const result = await f.owner.call("acp.install", { id: "fixture-agent", kind: "binary", fingerprint: inspection.fingerprint, [field]: "fixture" });
    assert.ok(result.error);
  }
  assert.equal(f.fetches(), 1);
  f.changeCatalog();
  const stale = await f.install(inspection.fingerprint);
  assert.ok(stale.error); assert.match(stale.error.message, /changed since inspection/);
  assert.equal(f.downloads(), 0); assert.equal(existsSync(f.store), false);
  assert.equal(f.owner.events.some(e => e.kind === "gate"), false);
});

test("denial and operation cancellation withdraw approval without artifact writes", { skip: !supportedHost }, async t => {
  for (const action of ["deny", "cancel"]) {
    const f = await fixture(t), inspection = await f.inspect(), pending = f.install(inspection.fingerprint);
    const gate = await f.gate();
    if (action === "deny") await f.observer.call("gate.answer", { id: gate.id, answer: "deny" });
    else {
      const operation = f.owner.events.find(e => e.kind === "acp.install").id;
      assert.equal((await f.observer.call("acp.install.cancel", { id: operation })).result.cancelled, true);
    }
    assert.ok((await pending).error);
    assert.equal(f.downloads(), 0); assert.equal(existsSync(f.store), false);
    assert.deepEqual((await f.observer.call("gate.list")).result.gates, []);
    assert.ok((await f.observer.call("gate.answer", { id: gate.id, answer: "allow" })).error);
  }
});

test("disconnected installation owner cannot leave an approvable operation", { skip: !supportedHost }, async t => {
  const f = await fixture(t), inspection = await f.inspect();
  void f.install(inspection.fingerprint);
  const gate = await f.gate(); f.owner.socket.destroy();
  await until(() => (f.daemon as any).installations.size === 0);
  assert.equal(f.downloads(), 0); assert.equal(existsSync(f.store), false);
  assert.ok((await f.observer.call("gate.answer", { id: gate.id, answer: "allow" })).error);
  assert.deepEqual((await f.observer.call("gate.list")).result.gates, []);
});

test("shutdown waits for an approved download to cancel and clean its staging state", { skip: !supportedHost }, async t => {
  const f = await fixture(t), inspection = await f.inspect();
  let cancelled = false;
  f.setDownload(async (_plan, _target, signal) => {
    await new Promise<void>((ok) => signal.addEventListener("abort", () => setTimeout(() => { cancelled = true; ok(); }, 20), { once: true }));
    signal.throwIfAborted(); throw new Error("unreachable fixture");
  });
  const pending = f.install(inspection.fingerprint), gate = await f.gate();
  await f.observer.call("gate.answer", { id: gate.id, answer: "allow" });
  await until(() => f.downloads() === 1);
  await f.daemon.stop();
  assert.equal(cancelled, true);
  assert.equal((f.daemon as any).installations.size, 0);
  assert.equal(existsSync(join(f.store, inspection.fingerprint)), false);
  // The server closes its sockets during stop; consume any prior error response if present.
  void pending;
});

test("restart records an unfinished operation once without restoring approval or resuming it", { skip: !supportedHost }, async t => {
  const f = await fixture(t);
  f.daemon.ledger.append(null, "acp.install.started", "user", { operation: "I-41", agent: "fixture-agent", fingerprint: "a".repeat(64) });
  for (let i = 42; i < 2542; i++) {
    f.daemon.ledger.append(null, "acp.install.started", "user", { operation: `I-${i}` });
    f.daemon.ledger.append(null, "acp.install.completed", "govd", { operation: `I-${i}` });
  }
  f.owner.socket.destroy(); f.observer.socket.destroy(); await f.daemon.stop();
  const restarted = new Daemon(f.opts);
  await restarted.listen();
  assert.equal(restarted.ledger.eventsOfKind(null, ["acp.install.interrupted"]).length, 1);
  assert.equal(restarted.ledger.eventsOfKind(null, ["acp.install.interrupted"])[0].data.operation, "I-41");
  assert.equal((restarted as any).installSeq, 2541);
  assert.equal((restarted as any).installations.size, 0);
  assert.equal((restarted as any).gates.size, 0);
  assert.equal(existsSync(f.store), false); assert.equal(f.downloads(), 0);
  await restarted.stop();
  const twice = new Daemon(f.opts);
  await twice.listen();
  assert.equal(twice.ledger.eventsOfKind(null, ["acp.install.interrupted"]).length, 1);
  await twice.stop();
});
