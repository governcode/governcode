// Mandatory operation Gates use the same user socket as normal Gates, with no AI process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { Daemon } from "../src/daemon.ts";
import { canonical } from "../src/claude.ts";
import { scratch } from "./scratch.ts";

async function fixture() {
  const root = scratch("mandatory-install-gate-");
  const socketPath = join(root, "run/govd.sock");
  const daemon = new Daemon({ socketPath, ledgerPath: join(root, "state/trace.sqlite"), policyDir: join(root, "state/policies"),
    homeDir: join(root, "state/home"), supervisor: "/nonexistent-supervisor", version: "test" });
  await daemon.listen();
  const socket = connect(socketPath);
  const waiting = new Map<number, (result: any) => void>();
  let seq = 0;
  createInterface({ input: socket }).on("line", (line) => {
    const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id);
  });
  const call = (method: string, params: unknown = {}) => new Promise<any>((ok) => {
    const id = ++seq; waiting.set(id, ok); socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { daemon, socket, call, close: () => { socket.destroy(); daemon.close(); } };
}

test("mandatory Gates cannot inherit relaxed, quiet, plan, or remembered approval", async () => {
  const f = await fixture();
  try {
    for (const level of ["relaxed", "balanced", "strict"]) {
      await f.call("settings.set", { gates: { level, quietReads: true } });
      const events: any[] = [];
      let id = "", planned = false;
      // A normally quiet read deliberately exercises the explicit mandatory behavior.
      const input = { command: "ls" };
      const result = (f.daemon as any).decide({ id: "I-1", tool: "Bash", input, canonical: canonical({ tool: "Bash", input }) },
        { project: null, ctx: { project: null, turn: "I-1" }, actor: "user", owner: null, mandatory: true,
          planned: () => { planned = true; return "preapproved"; }, notify: (event: any) => events.push(event), onOpened: (gate: string) => { id = gate; } });
      assert.equal(planned, false);
      assert.match(id, /^G-\d+$/);
      assert.deepEqual(events[0].scopes, []);
      for (const remember of ["turn", "spec", "project"]) {
        assert.ok((await f.call("gate.answer", { id, answer: "allow", remember })).error);
        assert.ok((await f.call("gate.list")).result.gates.some((gate: any) => gate.id === id));
      }
      assert.ok((await f.call("gate.answer", { id, answer: "deny" })).result);
      assert.equal(await result, "deny");
      assert.equal((await f.call("allows.list")).result.rules.length, 0);
    }
  } finally { f.close(); }
});

test("mandatory Gate cancellation and shutdown withdraw the pending question", async () => {
  const f = await fixture();
  const begin = (signal?: AbortSignal) => (f.daemon as any).decide({ id: "I-2", tool: "acp.install", input: {}, canonical: "fixture installation" },
    { project: null, ctx: { project: null, turn: "I-2" }, actor: "user", owner: null, notify: () => {}, mandatory: true, signal });
  try {
    const abort = new AbortController();
    const cancelled = begin(abort.signal);
    abort.abort();
    assert.equal(await cancelled, "deny");
    assert.deepEqual((await f.call("gate.list")).result.gates, []);
    const stopped = begin();
    f.daemon.close();
    assert.equal(await stopped, "deny");
  } finally { f.close(); }
});
