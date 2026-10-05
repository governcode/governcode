// Exercise the Controller socket at the discard Gate without executing a Runner. Fixtures
// stay for inspection; only the exact workspace deletion is recorded and suppressed.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecInput, type Spec, type SpecDelivery, type SpecStatus } from "@governcode/protocol";
import { canonical, type GateRequest } from "../src/claude.ts";
import { openControllerSocket, SpecRuns, type DelegationContext, type SpecResult } from "../src/delegate.ts";
import { Ledger } from "../src/ledger.ts";
import { LimitGate } from "../src/limits.ts";
import { specPaths } from "../src/specstore.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => { resolve = ok; });
  return { promise, resolve };
}

type Reply = { jsonrpc: "2.0"; id: number; result?: { id: string; discarded: boolean }; error?: { code: number; message: string } };
const markerText = "invented draft: retain for inspection\n";
const root = fs.mkdtempSync(join(tmpdir(), "gc-discard-"));

function fixture(t: TestContext, options: { status?: SpecStatus; delivery?: SpecDelivery; otherOwner?: boolean; otherProject?: boolean } = {}) {
  const base = fs.mkdtempSync(join(root, "case-"));
  const stateDir = join(base, "state"), runtimeDir = join(base, "run"), projectPath = join(base, "project");
  for (const dir of [stateDir, runtimeDir, projectPath]) fs.mkdirSync(dir);
  const ledger = new Ledger(":memory:"), runs = new SpecRuns();
  const input = SpecInput.parse({ to: "codex", brief: "Revise the invented draft", result: "A reviewed draft",
    scope: { read: ["draft.txt"], write: ["draft.txt"] }, reason: "A small draft revision" });
  const created = ledger.createSpec(options.otherProject ? "other-project" : "example", input,
    `controller · ${options.otherOwner ? "other-controller" : "codex"}`);
  const spec = ledger.updateSpec(created.id, { status: options.status ?? "needs-review", delivery: options.delivery ?? "pending" }, "govd");
  ledger.append("example", "context.shared", "user", { provider: "codex", share: !options.otherOwner });
  const work = specPaths(stateDir, spec.id).work, marker = join(work, "draft.txt");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(marker, markerText);
  const approval = deferred<"allow" | "deny">(), entered = deferred<GateRequest>();
  let gates = 0;
  const ctx: DelegationContext = { project: { name: "example", path: projectPath }, provider: "codex",
    ledger, runs, limits: new LimitGate(), usage: {}, stateDir, runtimeDir,
    supervisor: join(base, "unused-supervisor"), policyDir: join(base, "unused-policy"),
    gate: (req) => { gates++; entered.resolve(req); return approval.promise; }, notify: () => {} };
  const controller = openControllerSocket(ctx);
  const deletions: Array<{ path: string; options: fs.RmOptions | undefined }> = [];
  const socketRemovals: string[] = [];
  const originalRm = fs.rmSync;
  const intercepted = t.mock.method(fs, "rmSync", (path: fs.PathLike, options?: fs.RmOptions) => {
    if (path === work) { deletions.push({ path: work, options }); return; }
    // The socket's normal lifecycle is separate from retained workspace/state fixtures.
    assert.equal(path, controller.path, "unexpected deletion target");
    assert.deepEqual(options, { force: true });
    socketRemovals.push(controller.path);
    originalRm(path, options);
  });
  syncBuiltinESMExports();
  const client = connect(controller.path), closed = once(client, "close");
  void closed.catch(() => {});
  const lines = createInterface({ input: client });
  let reply: Reply | undefined;
  const response = new Promise<Reply>((resolve, reject) => {
    client.once("error", reject);
    lines.once("line", (line) => { try { reply = JSON.parse(line); resolve(reply!); } catch (e) { reject(e); } });
    client.once("close", () => { if (!reply) reject(new Error("socket closed before reply")); });
  });
  // Attach a rejection handler immediately, even while a test awaits Gate entry.
  void response.catch(() => {});
  let round: { finish(): void; done: Promise<SpecResult>; signal: AbortSignal; cancelled(): boolean } | undefined;
  const manifest = { name: t.name, base, stateDir, runtimeDir, projectPath, work, marker, socket: controller.path };
  fs.appendFileSync(join(root, "manifest.jsonl"), JSON.stringify(manifest) + "\n");
  fs.writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(join(base, "original.json"), JSON.stringify({ created, spec, events: ledger.events(undefined, 1000), marker: markerText }, null, 2) + "\n");
  return { ledger, runs, spec, work, deletions, entered: entered.promise, approval, gates: () => gates,
    call: () => { client.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "controller.spec_discard", params: { id: spec.id } }) + "\n"); return response; },
    startRound: () => {
      const finish = deferred<SpecResult>();
      const done = runs.start(spec.id, spec.project, spec.to, (stop, cancelled) => {
        round = { finish: () => finish.resolve({ id: spec.id, status: "needs-review", runner: spec.to, files: [], summary: "", diff: "", review: "" }),
          done: finish.promise, signal: stop.signal, cancelled };
        return finish.promise;
      });
      round!.done = done;
      return round!;
    },
    checkGate: async () => {
      const req = await entered.promise;
      const shown = { id: spec.id, runner: spec.to, brief: spec.brief };
      assert.equal(req.tool, "governcode spec_discard");
      assert.match(req.id, /^discard-\d+$/);
      assert.deepEqual(req.input, shown);
      assert.equal(req.canonical, canonical({ tool: "governcode spec_discard", input: shown }));
      assert.equal(gates, 1);
      assert.deepEqual(deletions, []);
    },
    close: async () => {
      try {
        approval.resolve("deny");
        // Snapshot before settling the manual round or closing the in-memory ledger.
        fs.writeFileSync(join(base, "result.json"), JSON.stringify({ spec: ledger.spec(spec.id), events: ledger.events(undefined, 1000),
          reply, gates, deletions, marker: fs.readFileSync(marker, "utf8"), active: runs.has(spec.id),
          ...(round ? { aborted: round.signal.aborted, cancelled: round.cancelled() } : {}) }, null, 2) + "\n");
        if (round) { round.finish(); await round.done; }
        controller.close();
        client.destroy();
        await closed;
        lines.close();
        assert.equal(fs.existsSync(controller.path), false);
        assert.deepEqual(socketRemovals, [controller.path]);
        assert.equal(fs.readFileSync(marker, "utf8"), markerText);
        assert.equal(runs.count(), 0);
      } finally {
        ledger.close();
        intercepted.mock.restore();
        syncBuiltinESMExports();
        assert.equal(fs.rmSync, originalRm);
      }
    } };
}

type Fixture = ReturnType<typeof fixture>;
function unchanged(f: Fixture, before: Spec, eventCount: number, reply: Reply, message: string) {
  assert.deepEqual(f.deletions, []);
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, error: { code: 1001, message } });
  assert.deepEqual(f.ledger.spec(f.spec.id), before);
  assert.equal(f.ledger.events(undefined, 1000).length, eventCount);
}

function discarded(f: Fixture, before: Spec, eventCount: number, reply: Reply) {
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 1, result: { id: f.spec.id, discarded: true } });
  assert.deepEqual(f.deletions, [{ path: f.work, options: { recursive: true, force: true } }]);
  assert.deepEqual(f.ledger.spec(f.spec.id), { ...before, status: "discarded", note: "discarded by the Controller",
    ...(["pending", "claimed"].includes(before.delivery ?? "") ? { delivery: "disposed" } : {}) });
  const events = f.ledger.events(undefined, 1000);
  assert.equal(events.length, eventCount + 1);
  assert.deepEqual(events.at(-1), { seq: events[eventCount - 1].seq + 1, ts: events.at(-1)!.ts,
    project: "example", kind: "spec.discarded", actor: "controller", data: { spec: f.spec.id, note: "discarded by the Controller" } });
}

test("Controller discard rechecks eligibility and delivery after its Gate", { timeout: 30_000 }, async (t) => {
  t.diagnostic(`retained fixtures: ${root}`);
  async function run(name: string, options: Parameters<typeof fixture>[1], check: (f: Fixture) => Promise<void>) {
    await t.test(name, async (child) => {
      const f = fixture(child, options);
      try { await check(f); } finally { await f.close(); }
    });
  }
  for (const status of ["needs-review", "running"] as const) {
    await run(`active round while ledger is ${status}`, {}, async (f) => {
      const response = f.call(); await f.checkGate();
      const round = f.startRound();
      if (status === "running") f.ledger.updateSpec(f.spec.id, { status }, "govd");
      const before = f.ledger.spec(f.spec.id)!, count = f.ledger.events(undefined, 1000).length;
      f.approval.resolve("allow");
      const reply = await response;
      assert.equal(f.runs.has(f.spec.id), true);
      assert.equal(round.signal.aborted, false);
      assert.equal(round.cancelled(), false);
      unchanged(f, before, count, reply, `${f.spec.id} is running: cancel it first with spec_cancel`);
    });
  }
  for (const status of ["running", "queued", "accepted", "discarded"] as const) {
    await run(`status becomes ${status} during Gate`, {}, async (f) => {
      const response = f.call(); await f.checkGate();
      const before = f.ledger.updateSpec(f.spec.id, { status }, "user"), count = f.ledger.events(undefined, 1000).length;
      f.approval.resolve("allow");
      unchanged(f, before, count, await response, `${f.spec.id} is ${status}; only a Spec waiting for review, failed, cancelled or held can be discarded`);
    });
  }
  await run("sharing revoked for another Controller's Spec during Gate", { otherOwner: true }, async (f) => {
    f.ledger.append("example", "context.shared", "user", { provider: "codex", share: true });
    const response = f.call(); await f.checkGate();
    f.ledger.append("example", "context.shared", "user", { provider: "codex", share: false });
    const before = f.ledger.spec(f.spec.id)!, count = f.ledger.events(undefined, 1000).length;
    f.approval.resolve("allow");
    unchanged(f, before, count, await response, "no such Spec in this project");
  });
  await run("declined approval preserves the draft", {}, async (f) => {
    const response = f.call(); await f.checkGate();
    const before = f.ledger.spec(f.spec.id)!, count = f.ledger.events(undefined, 1000).length;
    f.approval.resolve("deny");
    unchanged(f, before, count, await response, "the user declined discarding it");
  });
  for (const status of ["needs-review", "failed", "held", "cancelled"] as const) {
    await run(`eligible ${status} approval`, { status }, async (f) => {
      const response = f.call(); await f.checkGate();
      const before = f.ledger.spec(f.spec.id)!, count = f.ledger.events(undefined, 1000).length;
      f.approval.resolve("allow");
      discarded(f, before, count, await response);
    });
  }
  for (const [from, to] of [["pending", "claimed"], ["pending", "acknowledged"], ["claimed", "acknowledged"],
    ["acknowledged", "pending"], ["acknowledged", "claimed"]] as const) {
    await run(`delivery changes ${from} to ${to} during Gate`, { delivery: from }, async (f) => {
      const response = f.call(); await f.checkGate();
      const before = f.ledger.updateSpec(f.spec.id, { delivery: to }, "govd"), count = f.ledger.events(undefined, 1000).length;
      f.approval.resolve("allow");
      discarded(f, before, count, await response);
    });
  }
  for (const status of ["running", "queued", "accepted", "discarded"] as const) {
    await run(`preflight refuses ${status} without Gate`, { status }, async (f) => {
      const count = f.ledger.events(undefined, 1000).length;
      unchanged(f, f.spec, count, await f.call(), `${f.spec.id} is ${status}; only a Spec waiting for review, failed, cancelled or held can be discarded`);
      assert.equal(f.gates(), 0);
    });
  }
  await run("preflight refuses active round without Gate", {}, async (f) => {
    const round = f.startRound(), count = f.ledger.events(undefined, 1000).length;
    unchanged(f, f.spec, count, await f.call(), `${f.spec.id} is running: cancel it first with spec_cancel`);
    assert.equal(f.gates(), 0);
    assert.equal(round.signal.aborted, false);
  });
  for (const options of [{ otherOwner: true }, { otherProject: true }]) {
    await run(`preflight refuses ${options.otherOwner ? "unshared ownership" : "other project"} without Gate`, options, async (f) => {
      const count = f.ledger.events(undefined, 1000).length;
      unchanged(f, f.spec, count, await f.call(), "no such Spec in this project");
      assert.equal(f.gates(), 0);
    });
  }
});
