// govd end to end with a fake supervisor and a fake Claude Code, so it runs anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { Daemon } from "../src/daemon.ts";
import { canonical } from "../src/claude.ts";

const root = mkdtempSync(join(tmpdir(), "govd-test-"));
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };

// Fake supervisor: `selftest` obeys FAKE_SELFTEST; `run --policy F -- prog...` records the policy, then execs.
const supervisor = exe("govern-sup", `#!/bin/sh
if [ "$1" = selftest ]; then [ "\${FAKE_SELFTEST:-ok}" = ok ] && exit 0; echo "landlock missing" >&2; exit 1; fi
shift; policy="$2"; shift 3; cp "$policy" "${root}/last-policy.json"; exec "$@"
`);
// Fake Claude Code: one text, one permission request, then a result reporting the answer.
exe("claude", `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.type === "user" && JSON.stringify(m).includes("propose")) {
    // Like the real MCP server: call propose_project on the turn socket named in --mcp-config.
    const cfg = JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]).mcpServers.governcode;
    const s = require("node:net").connect(cfg.args[1]);
    const got = [];
    require("node:readline").createInterface({ input: s }).on("line", (l) => {
      got.push(JSON.parse(l));
      if (got.length < 2) return;
      out({ type: "result", is_error: false, result: "mode:" + cfg.args[2] + " " + JSON.stringify(got.map((g) => g.result ? g.result.id : g.error.message)) });
      process.exit(0);
    });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "controller.propose_project", params: { name: "harbor", path: /propose (\\/[^ "\\\\]+)/.exec(JSON.stringify(m))[1], reason: "an AIS reader" } }) + "\\n");
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "controller.delegate", params: {} }) + "\\n");
  } else if (m.type === "user") {
    out({ type: "assistant", message: { content: [{ type: "text", text: "hello from fake" }] } });
    out({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash",
      input: { command: "rm -rf dist", description: "clean \\u202e" } } });
  } else if (m.type === "control_response") {
    out({ type: "result", is_error: false, result: "gate:" + m.response.response.behavior + ":" + JSON.stringify(m.response.response.updatedInput ?? null) });
    process.exit(0);
  }
});
`);
process.env.PATH = `${bin}:${process.env.PATH}`;

function client(sock: string) {
  const s = connect(sock);
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  const events: any[] = [];
  let onEvent = (_e: any) => {};
  createInterface({ input: s }).on("line", (l) => {
    const m = JSON.parse(l);
    if (m.method === "event") { events.push(m.params); return onEvent(m.params); }
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  });
  return {
    events, set onEvent(f: (e: any) => void) { onEvent = f; },
    call: (method: string, params: unknown = {}) => new Promise<any>((ok) => { const n = ++id; waiting.set(n, ok);
      s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); }),
    end: () => s.end(),
  };
}

function daemon(tag: string) {
  return new Daemon({ socketPath: join(root, tag, "govd.sock"), ledgerPath: join(root, tag, "trace.sqlite"),
    policyDir: join(root, tag, "policies"), homeDir: join(root, tag, "home"), supervisor, version: "test" });
}

test("canonical: sorted keys, ASCII-escaped, whole input", () => {
  assert.equal(canonical({ b: 1, a: { d: "\u202e", c: 2 } }), '{\n "a": {\n  "c": 2,\n  "d": "\\u202e"\n },\n "b": 1\n}');
});

test("no AI tool starts when the sandbox self-test fails", async () => {
  process.env.FAKE_SELFTEST = "fail";
  const d = daemon("refuse");
  assert.equal(d.selftest().ok, false);
  await d.listen();
  const c = client(join(root, "refuse", "govd.sock"));
  await c.call("project.new", { name: "p", path: join(root, "refuse-p"), git: false });
  const r = await c.call("ask", { project: "p", prompt: "hi" });
  assert.match(r.error.message, /sandbox not verified/);
  assert.equal(d.ledger.events("p", 10).at(-1)?.kind, "sandbox.refused");
  c.end(); d.close();
  delete process.env.FAKE_SELFTEST;
});

test("a turn streams, raises a Gate on the user's connection, and runs exactly what was shown", async () => {
  const d = daemon("turn");
  assert.equal(d.selftest().ok, true);
  await d.listen();
  const c = client(join(root, "turn", "govd.sock"));
  const hello = await c.call("hello", { client: "test", protocol: 1 });
  assert.equal(hello.result.sandbox.ok, true);
  const worktree = join(root, "tidepool");
  assert.ok((await c.call("project.new", { name: "tidepool", path: worktree, git: true })).result.project);
  c.onEvent = (e) => { if (e.kind === "gate") void c.call("gate.answer", { id: e.id, answer: "allow" }); };
  const r = await c.call("ask", { project: "tidepool", prompt: "clean up" });
  assert.equal(r.result.ok, true);
  assert.equal(r.result.summary, 'gate:allow:{"command":"rm -rf dist","description":"clean \u202e"}');
  const gate = c.events.find((e) => e.kind === "gate");
  assert.match(gate.canonical, /\\u202e/);                        // shown escaped, not rendered
  assert.ok(c.events.some((e) => e.kind === "text" && e.text === "hello from fake"));
  const policy = JSON.parse(readFileSync(join(root, "last-policy.json"), "utf8"));
  assert.equal(policy.cwd, worktree);
  assert.ok(policy.write.includes(worktree));
  assert.deepEqual(policy.tcp_connect, [443]);
  assert.ok(!policy.write.some((p: string) => p.startsWith(join(root, "turn"))), "govd's own state is never writable");
  assert.ok(![...policy.read, ...policy.exec].some((p: string) => p.startsWith(join(root, "turn"))), "nor readable");
  const kinds = d.ledger.events("tidepool", 20).map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k.startsWith("turn.") || k.startsWith("project.")),
    ["project.created", "turn.started", "turn.text", "turn.completed"]);
  c.end(); d.close();
});

test("a new project cannot reach a denied folder through a symlinked parent", async () => {
  const d = daemon("smuggle");
  await d.listen();
  const c = client(join(root, "smuggle", "govd.sock"));
  symlinkSync(join(root, "smuggle"), join(root, "smuggle-link"));   // govd's own state, behind a link
  const r = await c.call("project.new", { name: "s", path: join(root, "smuggle-link", "p"), git: false });
  assert.match(r.error?.message ?? "", /cannot be a project/);
  assert.ok(!existsSync(join(root, "smuggle", "p")));
  c.end(); d.close();
});

test("a Gate denied or abandoned is a deny", async () => {
  const d = daemon("deny");
  d.selftest();
  await d.listen();
  const c = client(join(root, "deny", "govd.sock"));
  await c.call("project.new", { name: "x", path: join(root, "deny-x"), git: false });
  c.onEvent = (e) => { if (e.kind === "gate") void c.call("gate.answer", { id: e.id, answer: "deny" }); };
  const r = await c.call("ask", { project: "x", prompt: "go" });
  assert.equal(r.result.summary, "gate:deny:null");
  assert.ok(d.ledger.events("x", 20).some((e) => e.kind === "gate.denied"));
  c.end(); d.close();
});

test("a Gate can be answered from a second terminal, and is listed there", async () => {
  const d = daemon("second");
  d.selftest();
  await d.listen();
  const sock = join(root, "second", "govd.sock");
  const asker = client(sock), other = client(sock);
  await asker.call("project.new", { name: "two", path: join(root, "second-two"), git: false });
  asker.onEvent = async (e) => {
    if (e.kind !== "gate") return;
    const listed = await other.call("gate.list");
    assert.equal(listed.result.gates[0].id, e.id);
    assert.equal(listed.result.gates[0].owner, undefined);             // no internals leak
    await other.call("gate.answer", { id: e.id, answer: "allow" });
  };
  const r = await asker.call("ask", { project: "two", prompt: "go" });
  assert.match(r.result.summary, /^gate:allow:/);
  const again = await other.call("gate.answer", { id: "G-1", answer: "allow" });
  assert.match(again.error.message, /no Gate G-1 is waiting/);          // answered once only
  asker.end(); other.end(); d.close();
});

test("watch streams every Trace append and each Gate change, until the watcher leaves", async () => {
  const d = daemon("watch");
  d.selftest();
  await d.listen();
  const sock = join(root, "watch", "govd.sock");
  const asker = client(sock), watcher = client(sock);
  assert.ok((await watcher.call("hello", { client: "t", protocol: 1 })).result.features.includes("watch"));
  assert.deepEqual((await watcher.call("watch")).result, { ok: true });
  assert.deepEqual((await watcher.call("watch")).result, { ok: true });   // twice is still one watch
  await asker.call("project.new", { name: "seen", path: join(root, "watch-seen"), git: false });
  watcher.onEvent = async (e) => {
    if (e.kind !== "gates") return;
    const { gates } = (await watcher.call("gate.list")).result;
    if (gates.length) await watcher.call("gate.answer", { id: gates[0].id, answer: "deny" });
  };
  const r = await asker.call("ask", { project: "seen", prompt: "go" });
  assert.match(r.result.summary, /^gate:deny:/);
  const kinds = watcher.events.filter((e) => e.kind === "trace").map((e) => e.event.kind);
  for (const k of ["project.created", "turn.started", "turn.text", "gate.opened", "gate.denied", "turn.completed"]) assert.ok(kinds.includes(k), k);
  assert.equal(watcher.events.filter((e) => e.kind === "gates").length, 2);           // opened, then settled
  assert.equal(watcher.events.filter((e) => e.kind === "trace").length, d.ledger.events(undefined, 1000).length, "every append, once");
  assert.equal(asker.events.some((e) => e.kind === "trace" || e.kind === "gates"), false, "only watchers get the stream");
  watcher.end();
  for (let i = 0; i < 50 && (d as any).watchers.size; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((d as any).watchers.size, 0);
  assert.equal((d.ledger as any).listeners.size, 0, "unsubscribed from the Ledger");
  d.ledger.append("seen", "turn.started", "user", {});                              // no listener left to write to a closed socket
  asker.end(); d.close();
});

test("the asker leaving denies its waiting Gate", async () => {
  const d = daemon("leave");
  d.selftest();
  await d.listen();
  const sock = join(root, "leave", "govd.sock");
  const asker = client(sock), watcher = client(sock);
  await asker.call("project.new", { name: "gone", path: join(root, "leave-gone"), git: false });
  let seen = false;
  asker.onEvent = (e) => { if (e.kind === "gate") { seen = true; asker.end(); } };
  void asker.call("ask", { project: "gone", prompt: "go" });
  for (let i = 0; i < 100 && !d.ledger.events("gone", 20).some((e) => e.kind === "gate.denied"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(seen);
  assert.ok(d.ledger.events("gone", 20).some((e) => e.kind === "gate.denied" && e.data.by === "asker left"));
  assert.equal((await watcher.call("gate.list")).result.gates.length, 0);
  watcher.end(); d.close();
});

test("Home: the Controller may only propose a project; govd creates it on the user's Create", async () => {
  const d = daemon("propose");
  d.selftest();
  await d.listen();
  const c = client(join(root, "propose", "govd.sock"));
  const target = join(root, "proposed", "harbor");
  const shown: any[] = [];
  c.onEvent = (e) => { if (e.kind === "proposal") shown.push(e); };
  const r = await c.call("ask", { project: null, prompt: `propose ${target}` });
  // Home's socket offers propose_project and nothing else (delegate is refused).
  assert.match(r.result.summary, /^mode:home \["P-1","not offered at Home: controller.delegate"\]$/);
  assert.deepEqual(shown.map((e) => [e.id, e.name, e.path, e.git, e.reason]), [["P-1", "harbor", target, true, "an AIS reader"]]);
  assert.ok(!existsSync(target), "nothing exists before the user chooses Create");
  const made = await c.call("proposal.answer", { id: "P-1", answer: "create" });
  assert.equal(made.result.created.name, "harbor");
  assert.ok(existsSync(join(target, ".git")));
  assert.match((await c.call("proposal.answer", { id: "P-1", answer: "create" })).error.message, /no proposal P-1/);
  assert.ok(d.ledger.events(undefined, 50).some((e) => e.kind === "project.proposed"));
  c.end(); d.close();
});

test("Home uses the Controller chosen most recently, not the alphabetically last project's", async () => {
  const d = daemon("homectl");
  await d.listen();
  const c = client(join(root, "homectl", "govd.sock"));
  for (const name of ["alpha", "zulu"]) await c.call("project.new", { name, path: join(root, `homectl-${name}`), git: false });
  await c.call("controller.set", { project: "zulu", controller: { provider: "claude-code", model: "sonnet", effort: "low" } });
  await c.call("controller.set", { project: "alpha", controller: { provider: "codex", model: "gpt-5.5", effort: "low" } });
  assert.deepEqual((d as any).homeController(), { provider: "codex", model: "gpt-5.5", effort: "low" });
  c.end(); d.close();
});

test("Home runs with no project, in a folder the tool may only read", async () => {
  const d = daemon("home");
  d.selftest();
  await d.listen();
  const c = client(join(root, "home", "govd.sock"));
  c.onEvent = (e) => { if (e.kind === "gate") void c.call("gate.answer", { id: e.id, answer: "deny" }); };
  const r = await c.call("ask", { project: null, prompt: "plan something" });
  assert.equal(r.result.ok, true);
  const policy = JSON.parse(readFileSync(join(root, "last-policy.json"), "utf8"));
  const homeDir = join(root, "home", "home");
  assert.equal(policy.cwd, homeDir);
  assert.ok(policy.read.includes(homeDir));
  assert.ok(!policy.write.includes(homeDir), "Home is read-only");
  assert.equal(d.ledger.events(undefined, 50).find((e) => e.kind === "turn.started")?.data.home, true);
  c.end(); d.close();
});
