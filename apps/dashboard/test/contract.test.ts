// The Dashboard's two boundaries: the main process's checks on what the renderer may send,
// and the govd socket client (against a scripted govd and against the real Daemon). The
// preload is checked in its built form, the way Electron's sandbox loads it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { checkAsk, checkCall, connect, socketPath } from "../src/main/govd-client.ts";
import { GovdLink } from "../src/main/link.ts";
import { CALLABLE, Channel } from "../src/shared/contract.ts";
import { Daemon } from "../../../packages/govd/src/daemon.ts";

const dir = mkdtempSync(join(tmpdir(), "dashboard-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));   // leave nothing in /tmp

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
  // Checkpoints.
  assert.deepEqual(checkCall("turn.list", { project: "demo" }).params, { project: "demo" });
  assert.throws(() => checkCall("turn.list", {}));
  assert.deepEqual(checkCall("turn.undo", { id: "T-12" }).params, { id: "T-12" });
  for (const id of ["S-0001", "T-", "T-1; rm", 7]) assert.throws(() => checkCall("turn.undo", { id }));
  // Limits: a read; measuring is an explicit boolean.
  assert.deepEqual(checkCall("limits.list", undefined).params, { measure: false });
  assert.throws(() => checkCall("limits.list", { measure: "yes" }));
  // Proposals: create or cancel, by id.
  assert.deepEqual(checkCall("proposal.answer", { id: "P-2", answer: "create" }).params, { id: "P-2", answer: "create" });
  for (const bad of [{ id: "P-2", answer: "yes" }, { id: "G-2", answer: "create" }]) assert.throws(() => checkCall("proposal.answer", bad));
  // Settings: reserves are whole percents from 0 to 90, keyed by Runner and window.
  assert.deepEqual(checkCall("settings.set", { reserves: { codex: { weekly: 20 } } }).params, { reserves: { codex: { weekly: 20 } }, runners: {}, specModels: "free", gates: { quietReads: true } });
  assert.throws(() => checkCall("settings.set", { specModels: "anything" }));
  assert.throws(() => checkCall("settings.set", { runners: { codex: { model: "m", effort: "huge" } } }));
  for (const bad of [{ codex: { weekly: 91 } }, { codex: { weekly: 1.5 } }, { "../x": { weekly: 5 } }]) assert.throws(() => checkCall("settings.set", { reserves: bad }));
  // Standing allows: remember is one of three scopes; rules are revoked by id.
  assert.deepEqual(checkCall("gate.answer", { id: "G-3", answer: "allow", remember: "turn" }).params, { id: "G-3", answer: "allow", remember: "turn" });
  assert.throws(() => checkCall("gate.answer", { id: "G-3", answer: "allow", remember: "forever" }));
  assert.deepEqual(checkCall("allows.revoke", { id: "R-2" }).params, { id: "R-2" });
  assert.throws(() => checkCall("allows.revoke", { id: "G-2" }));
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
    // Unmeasured Runners show as held, not available (unknown usage holds).
    const { providers } = await link.call("limits.list", { measure: false }) as { providers: Array<{ provider: string; verdict: { ok: boolean } }> };
    assert.deepEqual(providers.map((x) => [x.provider, x.verdict.ok]), [["codex", false]]);
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

test("against the real govd: a Controller turn's Checkpoint is listed, undone once, and refused after", async () => {
  // A fake supervisor and a fake Controller that edits README.md and adds notes.txt.
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
  const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);
  exe("claude", `#!/usr/bin/env node
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  fs.writeFileSync("README.md", "# changed by the controller\\n");
  fs.writeFileSync("notes.txt", "new\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "edited" }) + "\\n");
  process.exit(0);
});
`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const d = new Daemon({ socketPath: join(dir, "cp-run", "govd.sock"), ledgerPath: join(dir, "cp-state", "trace.sqlite"),
    policyDir: join(dir, "cp-state", "pol"), homeDir: join(dir, "cp-state", "home"), supervisor, version: "t" });
  d.selftest();
  await d.listen();
  const link = new GovdLink(join(dir, "cp-run", "govd.sock"));
  const call = (m: string, p: unknown) => { const r = checkCall(m, p); return link.call<any>(r.method, r.params); };
  try {
    await link.start();
    const taken: string[] = [];
    link.onWatch((w) => { if (w.kind === "trace" && w.event.kind === "checkpoint.taken") taken.push(String(w.event.data.turn)); });
    for (const name of ["cp", "cp2"]) {
      const proj = join(dir, name);
      await call("project.new", { name, path: proj, git: true });
      writeFileSync(join(proj, "README.md"), "# original\n");
      execFileSync("git", ["-C", proj, "add", "-A"]);
      const ask = checkAsk("a1", name, "edit things");
      assert.equal((await link.ask(ask.params, () => {})).ok, true);
    }
    const [t] = (await call("turn.list", { project: "cp" })).turns;
    assert.deepEqual([...t.files].sort(), ["README.md", "notes.txt"]);
    assert.equal(t.undone, false);
    assert.equal(taken.length, 2, "each Checkpoint arrives on the watch stream");
    const u = await call("turn.undo", { id: t.id });
    assert.deepEqual([...u.restored].sort(), ["README.md", "notes.txt"]);
    assert.equal(readFileSync(join(dir, "cp", "README.md"), "utf8"), "# original\n");
    assert.equal((await call("turn.list", { project: "cp" })).turns[0].undone, true);
    await assert.rejects(call("turn.undo", { id: t.id }), /already undone/);
    // The user kept working after the turn: govd refuses, and says why.
    const [t2] = (await call("turn.list", { project: "cp2" })).turns;
    writeFileSync(join(dir, "cp2", "notes.txt"), "the user kept working\n");
    await assert.rejects(call("turn.undo", { id: t2.id }), /changed since.*notes\.txt/);
  } finally {
    process.env.PATH = oldPath;
    link.stop();
    d.close();
  }
});
