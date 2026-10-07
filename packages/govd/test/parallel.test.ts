// Parallel Specs through govd (#227): a Spec outlives the turn that made it; its Gates are govd's,
// answerable from any client; the Controller hears of it in a wake turn (Crew card: auto, while a
// client watches) or with the user's next message; a restart fails what was running, keeping its copy.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { scratch, markConnected } from "./scratch.ts";

// A Gate no connection owns waits this long here (an hour in govd), then is denied.
process.env.GOVERNCODE_GATE_WAIT_MS = "3000";
const { Daemon } = await import("../src/daemon.ts");

const root = scratch("gc-parallel-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
// The fake supervisor keeps each program's last policy (last-policy-claude.json, ...), then runs it.
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\ncp "$3" "${root}/last-policy-$(basename "$5").json"\nshift 4\nexec "$@"\n`);

// Fake Codex Runner, set by fake.json beside its home: delay = ms before it works, ask = it asks
// at a Gate before writing x/hello.txt, hang = it never finishes (until stopped).
process.env.GOVERNCODE_CODEX_BIN = exe("codex", `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs"), path = require("node:path");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || "", "..", "..", "fake.json"), "utf8")); } catch {}
const write = () => { fs.mkdirSync("x", { recursive: true }); fs.writeFileSync("x/hello.txt", "ok\\n"); };
const finish = (text) => {
  out({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text } } });
  if (!cfg.hang) out({ method: "turn/completed", params: { turn: { status: "completed" } } });
};
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") return out({ id: m.id, result: {} });
  if (m.method === "account/rateLimits/read") return out({ id: m.id, result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1900000000 } } } });
  if (m.method === "thread/start") return out({ id: m.id, result: { thread: { id: "t1" } } });
  if (m.method === "turn/start") {
    out({ id: m.id, result: {} });
    setTimeout(() => {
      if (!cfg.ask) { write(); return finish("wrote it"); }
      out({ method: "item/started", params: { item: { id: "fc1", type: "fileChange", changes: [{ path: "x/hello.txt", kind: { type: "add" }, diff: "ok\\n" }] } } });
      out({ id: 900, method: "item/fileChange/requestApproval", params: { itemId: "fc1", threadId: "t1", turnId: "u1", startedAtMs: 0 } });
    }, Number(cfg.delay || 0));
  }
  if (m.id === 900) { if (m.result && m.result.decision === "accept") { write(); finish("wrote it"); } else finish("declined"); }
});
`);

// Fake Controller (Claude Code): HANDOFF hands a Spec to codex (async, the default) and ends its
// turn; GovernCode's wake message is answered by reading each named Spec with spec_status (and
// trying what a wake turn may not do; with the file slow-wake present it then takes its time); any
// other message reports the finished Specs that rode along with it.
exe("claude", `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const cfg = JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]).mcpServers.governcode;
const net = require("node:net"), rl = require("node:readline");
const rpc = (method, params) => new Promise((ok) => {
  const s = net.connect(cfg.args[1]);
  rl.createInterface({ input: s }).once("line", (r) => { ok(JSON.parse(r)); s.end(); });
  s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\\n");
});
const result = (r) => { out({ type: "result", is_error: false, result: r }); process.exit(0); };
rl.createInterface({ input: process.stdin }).on("line", async (l) => {
  const m = JSON.parse(l);
  if (m.type !== "user") return;
  const text = JSON.parse(JSON.stringify(m.message.content)).map((c) => c.text || "").join("");
  const wake = text.indexOf("GovernCode's message (not the user's)");
  if (wake >= 0) {
    await new Promise((ok) => setTimeout(ok, 400));
    const ids = [...new Set(text.slice(wake).match(/S-\\d{4,}/g))];
    const st = [];
    for (const id of ids) st.push((await rpc("controller.spec_status", { id })).result.status);
    // A wake turn reports; it changes nothing by itself.
    const tries = [["controller.spec_followup", { id: ids[0], message: "more" }], ["controller.spec_cancel", { id: ids[0] }],
      ["controller.spec_discard", { id: ids[0] }], ["controller.project_notes", { write: "x" }]];
    const done = [];
    for (const [method, params] of tries) if (!(await rpc(method, params)).error) done.push(method);
    if (require("node:fs").existsSync(${JSON.stringify(join(root, "slow-wake"))})) await new Promise((ok) => setTimeout(ok, 30000));
    return result("woke:" + ids.join(",") + ":" + st.join(",") + (done.length ? ":DID:" + done.join(",") : ""));
  }
  // The new message only: earlier ones ride along in the record.
  const k0 = text.lastIndexOf("The user's new message:");
  if ((k0 < 0 ? text : text.slice(k0)).includes("HANDOFF")) {
    const r = await rpc("controller.delegate", { to: "codex", brief: "b", result: "r", scope: { read: [], write: ["x"] }, reason: "r" });
    return result("spec:" + (r.result ? r.result.id + ":" + r.result.status : r.error.message));
  }
  const kd = /^Since your last turn the user (.*) \\(from GovernCode's Trace\\)\\.$/m.exec(text);   // GovernCode's own line, not the history's copy
  if (kd) return result("decided:Since your last turn the user " + kd[1]);
  const k = text.indexOf("Specs that finished since you last heard");
  result("fold:" + (k < 0 ? "" : text.slice(k, text.indexOf(".", k + 60) + 1)));
});
`);
process.env.PATH = `${bin}:${process.env.PATH}`;

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) { try { opened.pop()!(); } catch { /* already */ } } });

function client(sock: string) {
  const s = connect(sock);
  opened.push(() => s.destroy());
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  const events: any[] = [];
  createInterface({ input: s }).on("line", (l) => {
    const m = JSON.parse(l);
    if (m.method === "event") {
      events.push(m.params);
      // The handoff's own Gate (during the turn) is allowed from here.
      if (m.params.kind === "gate" && /governcode delegate/.test(m.params.tool)) void call("gate.answer", { id: m.params.id, answer: "allow" });
      return;
    }
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  });
  const call = (method: string, params: unknown = {}) => new Promise<any>((ok) => { const n = ++id; waiting.set(n, ok);
    s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  return { call, events, end: () => s.end() };
}

/** A daemon with one committed project "p"; fake = the Runner's settings. */
async function setup(fake: object = {}, dir = join(root, `d-${Math.random().toString(36).slice(2)}`)) {
  const d = new Daemon({ socketPath: join(dir, "run/govd.sock"), ledgerPath: join(dir, "state/trace.sqlite"),
    policyDir: join(dir, "state/pol"), homeDir: join(dir, "state/home"), supervisor, version: "t" });
  markConnected(d);
  writeFileSync(join(dir, "state/tools/codex/fake.json"), JSON.stringify(fake));
  opened.push(() => d.close());
  d.selftest();
  await d.listen();
  const c = client(join(dir, "run/govd.sock"));
  const proj = join(dir, "proj");
  if (!d.ledger.project("p")) {
    await c.call("project.new", { name: "p", path: proj, git: true });
    writeFileSync(join(proj, "README.md"), "# p\n");
    execFileSync("git", ["-C", proj, "add", "-A"]);
    execFileSync("git", ["-C", proj, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
  }
  return { d, c, dir, sock: join(dir, "run/govd.sock") };
}

const until = async (f: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !f(); await new Promise((ok) => setTimeout(ok, 25))) if (Date.now() > end) throw new Error("timed out");
};
const wakes = (d: InstanceType<typeof Daemon>) => d.ledger.eventsOfKind("p", ["turn.started"]).filter((e) => e.data.origin === "wake");

test("a Spec that finishes after its turn wakes the Controller while a client watches; the wake turn is govd's", async () => {
  const { d, c, dir } = await setup({ delay: 500 });
  await c.call("watch", { wake: true });
  const r = await c.call("ask", { project: "p", prompt: "HANDOFF" });
  assert.match(r.result.summary, /^spec:S-0001:running$/, JSON.stringify(r));
  await until(() => d.ledger.eventsOfKind("p", ["turn.completed"]).length === 2);
  const [w] = wakes(d);
  assert.ok(w, "a wake turn started");
  assert.equal(w.actor, "govd");
  assert.deepEqual(w.data.specs, ["S-0001"]);
  assert.match(String(w.data.prompt), /S-0001 \(codex, needs-review\)/);
  assert.equal(d.ledger.eventsOfKind("p", ["turn.completed"]).at(-1)!.data.summary, "woke:S-0001:needs-review", "and it changed nothing");
  assert.equal(d.ledger.spec("S-0001")!.delivery, "delivered", "told, once its wake turn ended");
  const policy = JSON.parse(readFileSync(join(root, "last-policy-claude.json"), "utf8"));
  assert.ok(!policy.write.includes(join(dir, "proj")), "a wake turn's sandbox keeps the project read-only");
});

test("with no client showing wake turns (gov and older clients do not), or wake set to tell, no turn starts by itself: the user's next message carries the Spec", async () => {
  for (const wake of ["auto", "auto, watching without wake turns", "tell"] as const) {
    const { d, c } = await setup({ delay: 200 });
    if (wake === "tell") { await c.call("crew.set", { project: "p", crew: { wake: "tell" } }); await c.call("watch", { wake: true }); }
    if (wake === "auto, watching without wake turns") await c.call("watch");   // as gov and older clients ask
    await c.call("ask", { project: "p", prompt: "HANDOFF" });
    await until(() => d.ledger.spec("S-0001")?.status === "needs-review");
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(wakes(d).length, 0, `${wake}: no wake turn`);
    assert.equal(d.ledger.spec("S-0001")!.delivery, "pending");
    const r = await c.call("ask", { project: "p", prompt: "what happened?" });
    assert.match(r.result.summary, /S-0001 \(codex, needs-review\)/, `${wake}: ${JSON.stringify(r)}`);
    assert.equal(d.ledger.spec("S-0001")!.delivery, "delivered");
    d.close();
  }
});

test("wake off: the Controller is never told", async () => {
  const { d, c } = await setup({ delay: 100 });
  await c.call("crew.set", { project: "p", crew: { wake: "off" } });
  await c.call("watch", { wake: true });
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => d.ledger.spec("S-0001")?.delivery === "disposed");
  const r = await c.call("ask", { project: "p", prompt: "anything?" });
  assert.equal(r.result.summary, "fold:");
  assert.equal(wakes(d).length, 0);
});

test("a message from the user waits for a wake turn, then goes next", async () => {
  const { d, c } = await setup({ delay: 300 });
  await c.call("watch", { wake: true });
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => wakes(d).length === 1);
  const r = await c.call("ask", { project: "p", prompt: "and now?" });
  assert.equal(r.result.summary, "fold:", JSON.stringify(r));
  assert.ok(c.events.some((e) => e.kind === "text" && /your message goes right after/.test(e.text)));
  const turns = d.ledger.eventsOfKind("p", ["turn.started", "turn.completed"]).map((e) => `${e.kind}:${e.data.origin ?? ""}`);
  assert.deepEqual(turns, ["turn.started:", "turn.completed:", "turn.started:wake", "turn.completed:", "turn.started:", "turn.completed:"]);
});

test("a Runner's Gate outlives the turn: no owner, answered from another connection after the asker left", async () => {
  const { d, c, sock } = await setup({ ask: true, delay: 400 });
  await c.call("crew.set", { project: "p", crew: { wake: "off" } });
  const r = await c.call("ask", { project: "p", prompt: "HANDOFF" });
  assert.match(r.result.summary, /running/);
  c.end();   // the terminal that asked is gone
  const c2 = client(sock);
  let gate: any;
  for (const end = Date.now() + 10_000; !gate && Date.now() < end; await new Promise((ok) => setTimeout(ok, 50))) {
    gate = (await c2.call("gate.list")).result.gates.find((g: any) => /Runner · codex, S-0001/.test(g.tool));
  }
  assert.ok(gate, "the Runner's Gate waits for any client");
  assert.equal((await c2.call("gate.answer", { id: gate.id, answer: "allow" })).result.ok, true);
  await until(() => d.ledger.spec("S-0001")?.status === "needs-review");
  assert.deepEqual(d.ledger.spec("S-0001")!.files, ["x/hello.txt"]);
});

test("a Runner's Gate nobody answers is denied after the wait", async () => {
  const { d, c } = await setup({ ask: true, delay: 100 });
  await c.call("crew.set", { project: "p", crew: { wake: "off" } });
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => d.ledger.eventsOfKind("p", ["gate.denied"]).some((e) => e.data.by === "nobody answered within the hour"), 10_000);
  await until(() => !["running", "queued"].includes(d.ledger.spec("S-0001")!.status));
  assert.deepEqual(d.ledger.spec("S-0001")!.files, []);
});

test("the user cancels a running Spec; discarding waits for the cancel", async () => {
  const { d, c } = await setup({ hang: true });
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => d.ledger.spec("S-0001")?.status === "running");
  await new Promise((ok) => setTimeout(ok, 300));   // it has written its file by now
  assert.match((await c.call("spec.discard", { id: "S-0001" })).error.message, /is running: cancel it first/);
  assert.match((await c.call("spec.accept", { id: "S-0001", checkpoints: { before: "1".repeat(40), after: "2".repeat(40) } })).error.message, /is running/);
  const r = await c.call("spec.cancel", { id: "S-0001" });
  assert.equal(r.result.status, "needs-review", JSON.stringify(r));
  assert.match(r.result.note, /cancelled before it finished/);
  assert.equal(d.ledger.eventsOfKind("p", ["spec.cancel"]).at(-1)!.actor, "user");
  assert.match((await c.call("spec.cancel", { id: "S-0001" })).error.message, /not running/);
  assert.equal((await c.call("spec.discard", { id: "S-0001" })).result.discarded, true);
  assert.equal(d.ledger.spec("S-0001")!.status, "discarded");
});

test("after a restart: a Spec that was running is failed with its copy kept, no turn starts by itself, and the next message tells the Controller", async () => {
  const dir = join(root, "restart");
  const first = await setup({ hang: true }, dir);
  await first.c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => first.d.ledger.spec("S-0001")?.status === "running");
  await new Promise((ok) => setTimeout(ok, 300));   // it has written its file
  first.d.close();
  const { d, c } = await setup({}, dir);
  const s = d.ledger.spec("S-0001")!;
  assert.equal(s.status, "failed");
  assert.match(s.note!, /^govd stopped while it ran; its copy is kept for review \(1 changed file\(s\): gov diff S-0001\)/);
  assert.deepEqual(s.files, ["x/hello.txt"]);
  assert.match((await c.call("spec.diff", { id: "S-0001" })).result.diff, /\+ok/);
  assert.equal(s.delivery, "pending");
  await c.call("watch", { wake: true });
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(wakes(d).length, 0, "no turn starts by itself after a restart");
  const r = await c.call("ask", { project: "p", prompt: "where were we?" });
  assert.match(r.result.summary, /S-0001 \(codex, failed: govd stopped while it ran\)/, JSON.stringify(r));
});

test("a wake turn stops when the last client showing it leaves; its Spec is told with the next message", async () => {
  const { d, c, sock } = await setup({ delay: 300 });
  writeFileSync(join(root, "slow-wake"), "");
  try {
    const w = client(sock);
    await w.call("watch", { wake: true });
    await c.call("ask", { project: "p", prompt: "HANDOFF" });
    await until(() => wakes(d).length === 1);
    await new Promise((ok) => setTimeout(ok, 1000));   // it has read the Spec, and is still at work
    w.end();
    await until(() => d.ledger.eventsOfKind("p", ["turn.failed"]).length === 1, 10_000);
  } finally { rmSync(join(root, "slow-wake"), { force: true }); }
  // Read but not reported: it is told again with the next message.
  assert.equal(d.ledger.spec("S-0001")!.delivery, "pending");
  const r = await c.call("ask", { project: "p", prompt: "so?" });
  assert.match(r.result.summary, /S-0001 \(codex, needs-review\)/);
  assert.equal(wakes(d).length, 1, "and no second wake turn by itself");
});

test("a Controller that cannot start ends its turn: the project is not left working, and a wake turn's Specs stay to be told", async () => {
  const { d, c } = await setup({ delay: 400 });
  await c.call("watch", { wake: true });
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  const PATH = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";   // no claude: the wake turn cannot start
  try {
    await until(() => d.ledger.eventsOfKind("p", ["turn.failed"]).length === 1);
  } finally { process.env.PATH = PATH; }
  assert.match(String(d.ledger.eventsOfKind("p", ["turn.failed"])[0].data.summary), /could not start/);
  assert.equal(d.ledger.spec("S-0001")!.delivery, "pending");
  const r = await c.call("ask", { project: "p", prompt: "and?" });
  assert.match(r.result.summary, /S-0001 \(codex, needs-review\)/, JSON.stringify(r));
  assert.equal(wakes(d).length, 1);
});

test("turning wake off settles Specs still waiting to be told", async () => {
  const { d, c } = await setup({ delay: 100 });
  await c.call("crew.set", { project: "p", crew: { wake: "tell" } });
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => d.ledger.spec("S-0001")?.delivery === "pending");
  await c.call("crew.set", { project: "p", crew: { wake: "off" } });
  assert.equal(d.ledger.spec("S-0001")!.delivery, "disposed");
});

test("a project whose folder is gone says so, instead of the sandbox's spawn error", async () => {
  const { d, c, dir } = await setup();
  rmSync(join(dir, "proj"), { recursive: true, force: true });
  const r = await c.call("ask", { project: "p", prompt: "hello" });
  assert.match(JSON.stringify(r), /the project folder .*proj no longer exists/);
  assert.match(String(d.ledger.eventsOfKind("p", ["turn.failed"])[0].data.summary), /no longer exists/);
});

test("the Controller hears with the next message that the user accepted or discarded a Spec, once", async () => {
  const { d, c } = await setup();
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => d.ledger.spec("S-0001")?.status === "needs-review");
  const { checkpoints } = (await c.call("spec.diff", { id: "S-0001" })).result;
  assert.ok((await c.call("spec.accept", { id: "S-0001", checkpoints })).result, "accepted");
  const told = await c.call("ask", { project: "p", prompt: "next?" });
  assert.equal(told.result.summary, "decided:Since your last turn the user accepted S-0001 (its changes are in the project now, not committed)");
  const again = await c.call("ask", { project: "p", prompt: "and now?" });
  assert.equal(again.result.summary, "fold:", "told once");
  // A discard is told the same way.
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => d.ledger.spec("S-0002")?.status === "needs-review");
  assert.equal((await c.call("spec.discard", { id: "S-0002" })).result.discarded, true);
  assert.equal((await c.call("ask", { project: "p", prompt: "next?" })).result.summary, "decided:Since your last turn the user discarded S-0002");
});

test("a project comes off the list only once its work is settled; its folder stays, and its name stays taken", async () => {
  const { d, c, dir } = await setup();
  await c.call("ask", { project: "p", prompt: "HANDOFF" });
  await until(() => d.ledger.spec("S-0001")?.status === "needs-review");
  assert.match((await c.call("project.forget", { name: "p" })).error.message, /still has Specs to settle \(S-0001\)/);
  assert.equal((await c.call("spec.discard", { id: "S-0001" })).result.discarded, true);
  const r = (await c.call("project.forget", { name: "p" })).result;
  assert.deepEqual(r, { name: "p", path: join(dir, "proj"), forgotten: true });
  assert.ok(!d.ledger.project("p"), "off the list");
  assert.ok(existsSync(join(dir, "proj", "README.md")), "the folder is untouched");
  assert.equal(d.ledger.eventsOfKind("p", ["project.forgotten"]).length, 1, "and the Trace says so");
  assert.match((await c.call("project.forget", { name: "p" })).error.message, /no project p/);
  // A new project may not take the name (it would inherit the old history), but the folder may come back under another.
  assert.match((await c.call("project.open", { path: join(dir, "proj"), name: "p" })).error.message, /was removed and its history keeps the name/);
  assert.equal((await c.call("project.open", { path: join(dir, "proj"), name: "p2" })).result.project.name, "p2");
});
