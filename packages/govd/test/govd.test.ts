// govd end to end with a fake supervisor and a fake Claude Code, so it runs anywhere.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Daemon } from "../src/daemon.ts";
import { canonical } from "../src/claude.ts";
import { scratch, markConnected } from "./scratch.ts";

const root = scratch("govd-test-");
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
// The new message only: earlier ones ride along as a record in the same message.
const newMsg = (m) => { const t = JSON.stringify(m); const k = t.lastIndexOf("The user's new message:"); return k < 0 ? t : t.slice(k); };
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.type === "user" && newMsg(m).includes("propose")) {
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
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "controller.propose_project", params: (() => { const path = /propose (\\/[^ "\\\\]+)/.exec(newMsg(m))[1]; return { name: path.split("/").pop(), path, reason: "an AIS reader" }; })() }) + "\\n");
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "controller.delegate", params: {} }) + "\\n");
  } else if (m.type === "user" && newMsg(m).includes("twice")) {
    // Two steps of the same kind, then a different one: shows what a standing allow covers.
    global.asks = ["npm test", "npm test --watch", "ls -la", "npm install"]; global.got = [];
    out({ type: "control_request", request_id: "t0", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: global.asks[0] } } });
  } else if (m.type === "control_response" && global.asks) {
    global.got.push(m.response.response.behavior);
    const n = global.got.length;
    if (n < global.asks.length) return out({ type: "control_request", request_id: "t" + n, request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: global.asks[n] } } });
    out({ type: "result", is_error: false, result: "answers:" + global.got.join(",") });
    process.exit(0);
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

// Everything a test opens is closed after it, pass or fail, so a failed assertion reports
// instead of leaving a socket open and hanging the run.
const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) { try { opened.pop()!(); } catch { /* already closed */ } } });

function client(sock: string) {
  const s = connect(sock);
  opened.push(() => s.destroy());
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
  const d = new Daemon({ socketPath: join(root, tag, "govd.sock"), ledgerPath: join(root, tag, "trace.sqlite"),
    policyDir: join(root, tag, "policies"), homeDir: join(root, tag, "home"), supervisor, version: "test" });
  markConnected(d);
  opened.push(() => d.close());
  return d;
}

test("canonical: sorted keys, ASCII-escaped, whole input", () => {
  assert.equal(canonical({ b: 1, a: { d: "\u202e", c: 2 } }), '{\n "a": {\n  "c": 2,\n  "d": "\\u202e"\n },\n "b": 1\n}');
});

test("a late wake callback after shutdown never reads the closed Trace", () => {
  const d = daemon("late-wake");
  d.close();
  assert.doesNotThrow(() => (d as any).wakeIfDue("fixture-project"));
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
  // Nothing of govd's own state is writable except the tool's own GovernCode home (its login and
  // state; rebuilt before every turn): never the Trace, settings, rules or another tool's home.
  // The turn's own fresh home (tools/claude/runs/run-*) and the shared login file only.
  const runs = join(root, "turn", "tools", "claude", "runs") + "/";
  const login = join(root, "turn", "tools", "claude", "home", ".credentials.json");
  const claudeHome = policy.write.find((p: string) => p.startsWith(runs));
  assert.ok(claudeHome, "the turn has its own home");
  assert.ok(!policy.write.some((p: string) => p.startsWith(join(root, "turn")) && p !== claudeHome && p !== login), "govd's own state is never writable");
  assert.ok(!policy.read.some((p: string) => p.endsWith("/.claude.json") || p === join(homedir(), ".claude")), "the user's own Claude Code setup is out of reach");
  assert.ok(![...policy.read, ...policy.exec].some((p: string) => p.startsWith(join(root, "turn")) && p !== claudeHome && p !== login), "nor readable");
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

test("gov ask with no input leaves its Gate open; answered from another connection, the turn goes on", async () => {
  const d = daemon("noinput");
  d.selftest();
  await d.listen();
  const c = client(join(root, "noinput", "govd.sock"));
  await c.call("project.new", { name: "ni", path: join(root, "noinput-p"), git: false });
  // stdin is /dev/null, as when gov ask runs from a script: end of input at once.
  const gov = spawn(process.execPath, [fileURLToPath(new URL("../../gov/src/main.ts", import.meta.url)), "ask", "clean up"],
    { cwd: join(root, "noinput-p"), env: { ...process.env, GOVERNCODE_RUNTIME_DIR: join(root, "noinput") }, stdio: ["ignore", "pipe", "pipe"] });
  opened.push(() => gov.kill());
  let out = "";
  gov.stdout.on("data", (b) => (out += b));
  gov.stderr.on("data", (b) => (out += b));
  const exited = new Promise<number | null>((ok) => gov.on("close", ok));
  const left = /no input here: answer from another terminal with gov gate G-1 allow\|deny/;
  for (let i = 0; i < 500 && !left.test(out); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(out, left);
  assert.ok(!d.ledger.events("ni", 50).some((e) => e.kind === "gate.denied"), "no deny the user did not give");
  assert.equal((await c.call("gate.list")).result.gates[0]?.id, "G-1");
  await c.call("gate.answer", { id: "G-1", answer: "allow" });
  assert.equal(await exited, 0, out);
  assert.match(out, /G-1: allowed from elsewhere/);
  assert.equal(d.ledger.events("ni", 50).filter((e) => e.kind === "turn.completed").length, 1);
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
  // The turn goes on after the denial; let it finish before closing the Ledger under it.
  for (let i = 0; i < 100 && (d as any).turning.get("gone"); i++) await new Promise((r) => setTimeout(r, 20));
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
  // The record says which proposal it was, so a client still asking about P-1 can let it go.
  assert.equal(d.ledger.events("harbor", 5).find((e) => e.kind === "project.created")?.data.proposal, "P-1");
  assert.match((await c.call("proposal.answer", { id: "P-1", answer: "create" })).error.message, /no proposal P-1/);
  // A folder on the way turned into a symlink after the card was shown: Create refuses.
  const parent = join(root, "proposed2"), elsewhere = join(root, "elsewhere");
  mkdirSync(parent); mkdirSync(elsewhere);
  const r2 = await c.call("ask", { project: null, prompt: `propose ${join(parent, "sub", "reef")}` });
  assert.match(r2.result.summary, /"P-2"/);
  symlinkSync(elsewhere, join(parent, "sub"));
  assert.match((await c.call("proposal.answer", { id: "P-2", answer: "create" })).error.message, /leads somewhere else/);
  assert.ok(!existsSync(join(elsewhere, "reef")));
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
  // Clients see it too (gov asks about the right tool's instructions at Home).
  assert.deepEqual((await c.call("project.list")).result.home, { controller: { provider: "codex", model: "gpt-5.5", effort: "low" } });
  // However long ago it was chosen: not only within the latest few thousand events.
  for (let i = 0; i < 6000; i++) d.ledger.append("zulu", "turn.text", "controller · claude-code", { text: "x" });
  assert.deepEqual((d as any).homeController(), { provider: "codex", model: "gpt-5.5", effort: "low" });
  c.end(); d.close();
});

test("settings: reserves are validated, reach the Limit gate, and survive a restart", async () => {
  let d = daemon("settings");
  await d.listen();
  let c = client(join(root, "settings", "govd.sock"));
  assert.ok((await c.call("settings.set", { reserves: { codex: { weekly: 95 } } })).error, "over 90% is refused");
  assert.ok((await c.call("settings.set", { reserves: { "Bad Name": { weekly: 5 } } })).error);
  assert.deepEqual((await c.call("settings.set", { reserves: { codex: { weekly: 25 } } })).result.settings, { reserves: { codex: { weekly: 25 } }, runners: {}, specModels: "free", gates: { quietReads: true, level: "balanced" }, memory: { conversationChars: 16_000 }, specs: { maxPerProject: 3, maxPerRunner: 2 }, recovery: { autoResume: false }, local: { maxRunning: 1, maxMinutes: 10 }, personal: { claude: null, codex: null }, budgets: {} });
  (d as any).limits.record({ provider: "codex", measuredAt: Date.now(), readings: [{ window: "weekly", usedPercent: 70, resetsAt: null }] });
  const view = (await c.call("limits.list", {})).result.providers[0];
  assert.deepEqual([view.reserves, view.verdict.ok], [{ weekly: 25 }, true]);   // 70 + 1 <= 75
  (d as any).limits.record({ provider: "codex", measuredAt: Date.now(), readings: [{ window: "weekly", usedPercent: 75, resetsAt: null }] });
  assert.equal((await c.call("limits.list", {})).result.providers[0].verdict.ok, false, "75 + 1 > 75: held by the new reserve");
  assert.ok(d.ledger.events(undefined, 20).some((e) => e.kind === "settings.changed"));
  c.end(); d.close();
  d = daemon("settings");
  await d.listen();
  c = client(join(root, "settings", "govd.sock"));
  assert.deepEqual((await c.call("settings.get", {})).result.settings.reserves, { codex: { weekly: 25 } });
  c.end(); d.close();
});

test("settings: counted budgets are validated and survive a restart", async () => {
  let d = daemon("budgets");
  await d.listen();
  let c = client(join(root, "budgets", "govd.sock"));
  assert.ok((await c.call("settings.set", { budgets: { codex: { unit: "dollars", windows: { daily: 5 } } } })).error, "no unit a driver does not report");
  assert.ok((await c.call("settings.set", { budgets: { codex: { unit: "turns", windows: { hourly: 5 } } } })).error, "only the known windows");
  assert.ok((await c.call("settings.set", { budgets: { codex: { unit: "turns", windows: { daily: 0 } } } })).error);
  const budgets = { codex: { unit: "turns", windows: { daily: 20, weekly: 80 } } };
  assert.deepEqual((await c.call("settings.set", { budgets })).result.settings.budgets, budgets);
  c.end(); d.close();
  d = daemon("budgets");
  await d.listen();
  c = client(join(root, "budgets", "govd.sock"));
  assert.deepEqual((await c.call("settings.get", {})).result.settings.budgets, budgets);
  c.end(); d.close();
});

test("settings and the Crew card refuse a Runner or window GovernCode does not have; one saved before never blocks a change", async () => {
  const d = daemon("names");
  await d.listen();
  const c = client(join(root, "names", "govd.sock"));
  const refused = async (method: string, params: unknown) => (await c.call(method, params)).error?.message ?? "";
  assert.equal(await refused("settings.set", { runners: { antigravity: { model: "x", effort: null } } }), "unknown Runner antigravity (Runners: agy, codex, grok, ollama)");
  assert.equal(await refused("settings.set", { reserves: { codex: { "5h": 20 } } }), "unknown window 5h (windows: 5-hour, daily, weekly, monthly, period)");
  assert.match(await refused("settings.set", { budgets: { antigravity: { unit: "turns", windows: { daily: 5 } } } }), /^unknown Runner antigravity/);
  // A window the Runner reports now is one the Dashboard offers.
  (d as any).limits.record({ provider: "codex", measuredAt: Date.now(), readings: [{ window: "primary", usedPercent: 5, resetsAt: null }] });
  assert.ok((await c.call("settings.set", { reserves: { codex: { primary: 20, weekly: 15 }, grok: { period: 10 } } })).result);
  // A file saved before names were checked: its typos stay (ignored, as before); new ones are refused.
  writeFileSync(join(root, "names", "settings.json"), JSON.stringify({ runners: { antigravity: { model: "x", effort: null } }, reserves: { codex: { "5h": 20 } } }));
  const old = (await c.call("settings.get", {})).result.settings;
  assert.ok((await c.call("settings.set", { ...old, gates: { quietReads: true, level: "strict" } })).result, "an old typo never blocks a change");
  assert.match(await refused("settings.set", { ...old, runners: { ...old.runners, gork: { model: "x", effort: null } } }), /^unknown Runner gork/);
  await c.call("project.new", { name: "p", path: join(root, "names-p"), git: false });
  const crew = (await c.call("crew.get", { project: "p" })).result.crew;
  assert.match(await refused("crew.set", { project: "p", crew: { ...crew, runners: ["codex", "antigravity"] } }), /^unknown Runner antigravity/);
  assert.match(await refused("crew.set", { project: "p", crew: { ...crew, maxPercent: { gemini: 10 } } }), /^unknown Runner gemini/);
  assert.deepEqual((await c.call("crew.set", { project: "p", crew: { ...crew, runners: ["codex", "agy"] } })).result.crew.runners, ["codex", "agy"]);
  c.end(); d.close();
});

test("a bad parameter is named in the error, for the CLI and the Dashboard alike", async () => {
  const d = daemon("badparams");
  await d.listen();
  const c = client(join(root, "badparams", "govd.sock"));
  assert.equal((await c.call("spec.diff", {})).error.message, "id: Invalid input: expected string, received undefined");
  assert.match((await c.call("project.new", { name: "MyApp", path: join(root, "badparams-x") })).error.message,
    /^name: a project name uses lowercase letters, digits, \. _ - and starts with a letter or digit/);
  c.end(); d.close();
});

test("trace.list pages through every event with after, oldest first", async () => {
  const d = daemon("paging");
  await d.listen();
  const c = client(join(root, "paging", "govd.sock"));
  for (let i = 0; i < 2100; i++) d.ledger.append(i % 2 ? null : "q", "turn.text", "test", { i });
  const all: any[] = [];
  for (let after = 0; ;) {
    const { events } = (await c.call("trace.list", { limit: 1000, after })).result;
    all.push(...events);
    if (events.length < 1000) break;
    after = events.at(-1).seq;
  }
  assert.equal(all.length, 2100);
  assert.ok(all.every((e, i) => i === 0 || e.seq > all[i - 1].seq), "oldest first, none twice");
  assert.equal((await c.call("trace.list", { project: "q", limit: 1000, after: 0 })).result.events.length, 1000);
  assert.equal((await c.call("trace.list", { project: "q", limit: 1000, after: all.at(-2).seq })).result.events.length, 0, "only q's events");
  const newest = (await c.call("trace.list", { limit: 2 })).result.events;
  assert.deepEqual(newest.map((e: any) => e.data.i), [2098, 2099], "without after: the newest, newest last");
  c.end(); d.close();
});

test("trace.list by kind reaches every project and all of history; trace.totals counts the whole Trace since a time", async () => {
  const d = daemon("bykind");
  await d.listen();
  const c = client(join(root, "bykind", "govd.sock"));
  d.ledger.append("q", "turn.started", "claude", { prompt: "long" });
  for (let i = 0; i < 1200; i++) d.ledger.append(i % 2 ? null : "q", "turn.tool", "claude", { name: "Bash" });
  d.ledger.append(null, "turn.started", "codex", { prompt: "home" });
  const starts = (await c.call("trace.list", { limit: 10, kinds: ["turn.started"] })).result.events;
  assert.deepEqual(starts.map((e: any) => e.project), ["q", null], "a turn begun 1,200 events ago is still found, in every project");
  assert.match((await c.call("trace.list", { limit: 10, kinds: ["turn.started"], after: 0 })).error?.message ?? "", /pages by kind are not offered/);
  d.ledger.append("q", "spec.done", "codex", {});
  d.ledger.append("q", "gate.allowed", "user", { gate: "G-1", by: "user" });
  d.ledger.append("q", "gate.denied", "user", { gate: "G-2", by: "govd" });
  d.ledger.append("q", "gate.allowed", "user", { rule: "R-1" });
  const { totals } = (await c.call("trace.totals", { since: new Date(Date.now() - 60_000).toISOString() })).result;
  assert.deepEqual(totals, { turns: 2, specsFinished: 1, answeredByYou: 1, letThrough: 1, seq: d.ledger.events(undefined, 1)[0].seq });
  assert.equal((await c.call("trace.totals", { since: new Date(Date.now() + 60_000).toISOString() })).result.totals.turns, 0);
  c.end(); d.close();
});

test("standing allows: a turn rule covers the same kind for this turn only; quiet reads never ask; a project rule stays", async () => {
  const d = daemon("allows");
  d.selftest();
  await d.listen();
  const c = client(join(root, "allows", "govd.sock"));
  await c.call("project.new", { name: "a", path: join(root, "allows-a"), git: false });
  let shown: any[] = [];
  const answerWith = (remember?: string) => { shown = []; c.onEvent = (e) => {
    if (e.kind === "gate") { shown.push(e); void c.call("gate.answer", { id: e.id, answer: "allow", ...(remember && shown.length === 1 ? { remember } : {}) }); } }; };
  answerWith("turn");
  let r = await c.call("ask", { project: "a", prompt: "twice" });
  assert.equal(r.result.summary, "answers:allow,allow,allow,allow");
  // Asked twice: npm test (then remembered for the turn) and npm install; npm test --watch was
  // covered by the rule and ls -la is a quiet read.
  assert.deepEqual(shown.map((e) => e.canonical.match(/"command": "([^"]+)"/)[1]), ["npm test", "npm install"]);
  assert.deepEqual(shown[0].scopes, ["turn", "project"]);
  assert.match(shown[0].covers, /npm test/);
  const trace = d.ledger.events("a", 100);
  assert.ok(trace.some((e) => e.kind === "allow.added" && e.data.scope === "turn"));
  assert.ok(trace.some((e) => e.kind === "gate.allowed" && String(e.data.by).startsWith("rule R-")));
  assert.ok(trace.some((e) => e.kind === "gate.allowed" && e.data.by === "quiet read"));
  answerWith();
  r = await c.call("ask", { project: "a", prompt: "twice" });
  assert.equal(shown.length, 3, "a new turn asks again: npm test, npm test --watch, npm install");
  answerWith("project");
  await c.call("ask", { project: "a", prompt: "twice" });
  answerWith();
  await c.call("ask", { project: "a", prompt: "twice" });
  assert.equal(shown.length, 1, "the project rule covers npm test in later turns; only npm install asks");
  const { rules } = (await c.call("allows.list", { project: "a" })).result;
  assert.equal(rules.length, 1);
  assert.ok((await c.call("allows.revoke", { id: rules[0].id })).result.revoked);
  // A step that always asks cannot be remembered.
  c.onEvent = (e) => { if (e.kind === "gate") void c.call("gate.answer", { id: e.id, answer: "allow", remember: "turn" }).then((x) => { shown.push(x); c.call("gate.answer", { id: e.id, answer: "deny" }); }); };
  shown = [];
  await c.call("ask", { project: "a", prompt: "go" });   // the fake asks for rm -rf dist
  assert.match(shown[0].error.message, /always asks/);
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
