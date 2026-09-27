// The Dashboard's two boundaries: the main process's checks on what the renderer may send,
// and the govd socket client (against a scripted govd and against the real Daemon). The
// preload is checked in its built form, the way Electron's sandbox loads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { checkAsk, checkCall, connect, socketPath } from "../src/main/govd-client.ts";
import { GovdLink } from "../src/main/link.ts";
import { CALLABLE, Channel } from "../src/shared/contract.ts";
import { Daemon } from "../../../packages/govd/src/daemon.ts";

const dir = mkdtempSync(join(tmpdir(), "dashboard-test-"));

test("the socket path resolves exactly as gov and govd resolve it", () => {
  assert.equal(socketPath({ GOVERNCODE_RUNTIME_DIR: "/r" }), "/r/govd.sock");
  assert.equal(socketPath({ XDG_RUNTIME_DIR: "/run/u" }), "/run/u/governcode/govd.sock");
  assert.equal(socketPath({ XDG_STATE_HOME: "/s" }), "/s/governcode/governcode/govd.sock");
});

test("the renderer may call only the allowlisted methods, with valid parameters", () => {
  for (const m of ["ask", "watch", "nope", 42]) {
    assert.throws(() => checkCall(m, {}), /does not call/);
  }
  assert.deepEqual(checkCall("gate.answer", { id: "G-3", answer: "allow" }), { method: "gate.answer", params: { id: "G-3", answer: "allow" } });
  assert.throws(() => checkCall("gate.answer", { id: "G-3", answer: "always" }));
  assert.throws(() => checkCall("spec.accept", { id: "../x" }));
  assert.deepEqual(checkCall("trace.list", undefined).params, { limit: 50 });
  assert.ok(!CALLABLE.includes("ask" as never), "ask streams on its own channel");
  // Projects and the Controller, checked against the protocol's schemas.
  assert.deepEqual(checkCall("project.new", { name: "demo", path: "/p/demo" }).params, { name: "demo", path: "/p/demo", git: true });
  assert.throws(() => checkCall("project.new", { name: "Demo!", path: "/p/demo" }));
  assert.throws(() => checkCall("project.open", { path: "" }));
  assert.ok(checkCall("controller.set", { project: "demo", controller: { provider: "codex", model: "gpt-5.5", effort: null } }));
  assert.throws(() => checkCall("controller.set", { project: "demo", controller: { provider: "other", model: "m", effort: null } }));
  assert.throws(() => checkCall("controller.set", { project: "demo", controller: { provider: "codex", model: "m", effort: "huge" } }));
});

test("an ask needs a well-formed id and prompt; Home is a null project", () => {
  assert.deepEqual(checkAsk("a1", null, "hi"), { askId: "a1", params: { project: null, prompt: "hi" } });
  assert.throws(() => checkAsk("a 1", null, "hi"), /bad ask id/);
  assert.throws(() => checkAsk("a1", "Bad Name", "hi"));
  assert.throws(() => checkAsk("a1", null, ""));
});

test("no govd: a clear message, not a hang", async () => {
  await assert.rejects(connect(join(dir, "missing.sock")), /govd is not running/);
  const link = new GovdLink(join(dir, "missing.sock"));
  const s = await link.start();
  link.stop();
  assert.equal(s.state, "down");
});

test("the link says hello, streams an ask's events on its own connection, and notices govd stopping", async () => {
  const path = join(dir, "fake.sock");
  const socks: Array<import("node:net").Socket> = [];
  const server = createServer((sock) => {
    socks.push(sock);
    createInterface({ input: sock }).on("line", (line) => {
      const req = JSON.parse(line);
      const reply = (result: unknown) => sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\n");
      const event = (params: unknown) => sock.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params }) + "\n");
      if (req.method === "hello") reply({ server: "govd", version: "t", protocol: 1, features: [], sandbox: { ok: true, reason: "ok" } });
      else if (req.method === "ask") {
        event({ kind: "text", text: "hi" });
        event({ kind: "gate", id: "G-1", tool: "Bash", canonical: "{}" });
        reply({ ok: true, summary: "done" });
      } else sock.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: 1002, message: "no Gate G-9 is waiting" } }) + "\n");
    });
  });
  await new Promise<void>((ok) => server.listen(path, ok));
  const link = new GovdLink(path);
  const seen: string[] = [];
  link.onStatus((s) => seen.push(s.state));
  const s = await link.start();
  assert.equal(s.state, "up");
  const events: unknown[] = [];
  const r = await link.ask({ project: null, prompt: "hi" }, (e) => events.push(e));
  assert.deepEqual(r, { ok: true, summary: "done" });
  assert.deepEqual(events, [{ kind: "text", text: "hi" }, { kind: "gate", id: "G-1", tool: "Bash", canonical: "{}" }]);
  await assert.rejects(link.call("gate.answer", { id: "G-9", answer: "deny" }), /no Gate G-9/);
  const down = new Promise<string>((ok) => link.onStatus((st) => ok(st.state)));
  server.close();
  for (const c of socks) c.destroy();
  assert.equal(await down, "down");
  link.stop();
  assert.deepEqual(seen, ["up", "down"]);
});

test("against the real govd: hello reports the sandbox, and lists come back", async () => {
  const d = new Daemon({ socketPath: join(dir, "govd", "govd.sock"), ledgerPath: join(dir, "state", "trace.sqlite"),
    policyDir: join(dir, "state", "policies"), homeDir: join(dir, "state", "home"), supervisor: "/nonexistent", version: "test" });
  await d.listen();
  const link = new GovdLink(join(dir, "govd", "govd.sock"));
  try {
    const s = await link.start();
    assert.equal(s.state, "up");
    if (s.state === "up") assert.equal(s.hello.sandbox.ok, false, "no self-test was run, so the sandbox is not verified");
    for (const m of ["project.list", "gate.list", "spec.list", "trace.list"]) {
      const req = checkCall(m, {});
      assert.ok(await link.call(req.method, req.params));
    }
    // The link watches: a project made and a Controller chosen arrive as live Trace events.
    const seen: string[] = [];
    link.onWatch((w) => { if (w.kind === "trace") seen.push(w.event.kind); });
    const made = checkCall("project.new", { name: "live", path: join(dir, "live"), git: false });
    await link.call(made.method, made.params);
    const ctl = checkCall("controller.set", { project: "live", controller: { provider: "codex", model: "gpt-5.5", effort: "low" } });
    await link.call(ctl.method, ctl.params);
    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, ["project.created", "controller.set"]);
    // Asks are refused while the sandbox is unverified, and the refusal reaches the Dashboard.
    await assert.rejects(link.ask({ project: null, prompt: "hi" }, () => {}), /sandbox not verified/);
  } finally {
    link.stop();
    d.close();
  }
});

const built = new URL("../dist/main/preload.cjs", import.meta.url);
test("the built preload needs only electron and exposes exactly the Dashboard API", { skip: !existsSync(built) && "run npm run build first" }, async () => {
  const exposed: Record<string, any> = {};
  const invoked: unknown[][] = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (k: string, v: unknown) => { exposed[k] = v; } },
    ipcRenderer: { invoke: async (...a: unknown[]) => { invoked.push(a); return { ok: true, value: 1 }; }, on() {}, removeListener() {} },
  };
  const required: string[] = [];
  const module = { exports: {} };
  runInNewContext(readFileSync(built, "utf8"), {
    require: (name: string) => { required.push(name); if (name !== "electron") throw new Error(`preload required ${name}`); return electron; },
    module, exports: module.exports,
  });
  assert.deepEqual(required, ["electron"]);
  assert.deepEqual(Object.keys(exposed), ["governcode"]);
  assert.deepEqual(Object.keys(exposed.governcode).sort(), ["ask", "call", "onEvent", "onStatus", "onWatch", "pickFolder", "retry", "status"]);
  await exposed.governcode.call("gate.list");
  await exposed.governcode.ask("a1", null, "hi");
  await exposed.governcode.pickFolder();
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)), [[Channel.call, "gate.list", {}], [Channel.ask, "a1", null, "hi"], [Channel.pickFolder]]);
});
