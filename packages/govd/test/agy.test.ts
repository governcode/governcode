// The Antigravity Runner end to end with a fake `agy` that behaves like the real one where it
// matters: it runs the PreToolUse hook from its home's config for every tool call, honours the
// hook's decision (a failing hook denies), streams stream-json events, and answers /quota.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { LimitGate } from "../src/limits.ts";
import { agyGate, agyUsage, parseQuota, HOOK_SCRIPT, toolHome, writeAgyConfig } from "../src/agy.ts";
import { analyze } from "../src/allows.ts";
import { openControllerSocket } from "../src/delegate.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-agy-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);

// fake.json in the private home: calls = the tool calls to make, in order.
process.env.GOVERNCODE_AGY_BIN = exe("agy", `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const home = process.env.HOME, out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const args = process.argv.slice(2);
if (args[1] === "/quota") {
  out({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [
    { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.7, reset_time: "2026-10-01T00:00:00Z" },
    { id: "gemini-5h", window: "5h", remaining_fraction: 0.95, reset_time: "2026-09-29T00:00:00Z" }] }] } } });
  process.exit(0);
}
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(home, "fake.json"), "utf8")); } catch {}
const hooks = JSON.parse(fs.readFileSync(path.join(home, ".gemini/config/hooks.json"), "utf8"));
const cmds = Object.values(hooks).filter((h) => h.enabled !== false).flatMap((h) => (h.PreToolUse || []).flatMap((g) => g.hooks.map((x) => x.command)));
out({ event: "init", init: { tools: ["write_to_file", "view_file", "run_command"] } });
let i = 0;
for (const call of cfg.calls || []) {
  i++;
  let allowed = cmds.length > 0;
  for (const c of cmds) {
    const r = cp.spawnSync("sh", ["-c", c], { input: JSON.stringify({ toolCall: call, stepIdx: i }), encoding: "utf8", cwd: path.join(home, ".gemini/config") });
    let d = null; try { d = JSON.parse(r.stdout).decision; } catch {}
    if (r.status !== 0 && d !== "deny") d = "deny";
    if (d !== "allow") allowed = false;
  }
  out({ step_update: { step_index: i, step_type: "tool", state: "ACTIVE", tool_name: call.name } });
  if (allowed && call.name === "write_to_file") { fs.mkdirSync(path.dirname(call.args.TargetFile), { recursive: true }); fs.writeFileSync(call.args.TargetFile, call.args.CodeContent); }
  out({ step_update: { step_index: i, step_type: "tool", state: allowed ? "DONE" : "ERROR", tool_name: call.name } });
}
out({ step_update: { step_type: "agent_response", state: "DONE", text_delta: "finished" } });
out({ event: "result", result: { status: "SUCCESS", response: "finished", usage: { total_tokens: 42 } } });
`);

function project(extra?: (dir: string) => void) {
  const dir = mkdtempSync(join(root, "proj-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# p\n");
  extra?.(dir);
  g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  return dir;
}

const opened: Array<{ close(): void }> = [];
afterEach(() => { while (opened.length) { try { opened.pop()!.close(); } catch { /* already */ } } });

function setup(answer: "allow" | "deny", calls: (work: string) => object[], extra?: (dir: string) => void) {
  const proj = project(extra);
  const state = mkdtempSync(join(root, "state-"));
  const home = toolHome(state, "agy");
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(home, ".governcode-connected"), "");                     // connected
  writeFileSync(join(home, ".gemini", "config", "plugins"), "left over");     // must be cleared
  const ledger = new Ledger(":memory:");
  const limits = new LimitGate();
  const gates: Array<{ tool: string; canonical: string }> = [];
  const ctx = { project: { name: "p", path: proj }, ledger, limits,
    usage: { agy: agyUsage({ supervisor, policyDir: join(state, "pol"), stateDir: state }) },
    runtimeDir: join(state, "run"), supervisor, policyDir: join(state, "pol"), stateDir: state,
    gate: async (r: { tool: string; canonical: string }) => { gates.push(r); return answer; }, notify: () => {} };
  const sock = openControllerSocket(ctx as any);
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
  const t = { proj, state, home, ledger, gates, call, close: () => { sock.close(); ledger.close(); } };
  // The fake reads its calls from the home; the first Spec's workspace path is known in advance.
  writeFileSync(join(home, "fake.json"), JSON.stringify({ calls: calls(join(state, "specs", "S-0001", "work")) }));
  opened.push(t);
  return t;
}

const SPEC = { to: "agy", brief: "add notes/hello.txt", result: "it says ok", scope: { read: [], write: ["notes"] },
  budgetPercent: 5, model: "", effort: null, reason: "test" };
const write = (work: string, rel: string, content = "ok\n") => ({ name: "write_to_file", args: { TargetFile: join(work, rel), CodeContent: content } });

test("agy Runner: a quiet read passes, a write waits at a Gate that shows its content, allow lands it in the Spec", async () => {
  const t = setup("allow", (w) => [{ name: "view_file", args: { AbsolutePath: join(w, "README.md") } }, write(w, "notes/hello.txt")]);
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "needs-review", JSON.stringify(r));
  assert.deepEqual(r.result.files, ["notes/hello.txt"]);
  assert.equal(t.gates.length, 1, "the read did not ask");
  assert.match(t.gates[0].tool, /^agy fileChange \(Runner · agy, S-0001\)$/);
  assert.match(t.gates[0].canonical, /"CodeContent": "ok\\n"/);
  const cfg = readdirSync(join(t.home, ".gemini", "config"));
  assert.ok(!cfg.includes("plugins"), "anything else in the config folder is removed");
  const hooks = JSON.parse(readFileSync(join(t.home, ".gemini", "config", "hooks.json"), "utf8"));
  assert.match(Object.keys(hooks)[0], /^governcode-[0-9a-f]{18}$/, "the hook's name is random");
  assert.deepEqual(JSON.parse(readFileSync(join(t.home, ".gemini", "antigravity-cli", "settings.json"), "utf8")), { toolPermission: "always-proceed" },
    "Antigravity's own confirmations are off: GovernCode's hook is the Gate");
});

test("agy Runner: a declined Gate leaves the file unwritten", async () => {
  const t = setup("deny", (w) => [write(w, "notes/hello.txt")]);
  const r = await t.call("controller.delegate", SPEC);
  assert.deepEqual(r.result.files ?? [], []);
  assert.equal(t.gates.length, 1);
});

test("agy Runner: a project with Antigravity customizations is refused before anything runs", async () => {
  const t = setup("allow", (w) => [write(w, "notes/hello.txt")], (dir) => {
    mkdirSync(join(dir, "sub", ".agents"), { recursive: true });
    writeFileSync(join(dir, "sub", ".agents", "hooks.json"), JSON.stringify({ anything: { enabled: false } }));
  });
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "failed");
  assert.match(r.result.note, /Antigravity customizations \(sub\/\.agents\)/);
  assert.equal(t.gates.length, 0);
});

test("agy Runner: a Runner that creates Antigravity customizations fails its Spec", async () => {
  const t = setup("allow", (w) => [write(w, "notes/.agents/hooks.json", "{}")]);
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "failed");
  assert.match(r.result.note, /created Antigravity customizations/);
});

test("agy Runner: not connected is a plain failure, not a crash", async () => {
  const t = setup("allow", () => []);
  execFileSync("rm", [join(t.home, ".governcode-connected")]);
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "held");   // the usage source cannot read a home that is not connected
  assert.match(r.result.reason, /not connected \(gov connect agy\)/);
});

test("agy tool calls: reads are quiet; commands, file changes and anything unknown are Gates", () => {
  assert.deepEqual(agyGate({ name: "view_file", args: {} }, "x"), { quiet: true });
  const cmd = agyGate({ name: "run_command", args: { CommandLine: "npm test", Cwd: "/w" } }, "x") as any;
  assert.equal(cmd.req.tool, "agy command");
  assert.equal(cmd.req.input.command, "npm test");
  assert.equal((agyGate({ name: "search_web", args: { q: "x" } }, "x") as any).req.tool, "agy_search_web");
  assert.equal((agyGate({ name: "Bad Name!", args: {} }, "x") as any).req.tool, "agy unknown tool");
  assert.equal((agyGate(null, "x") as any).req.tool, "agy unknown tool");
  // The same command analysis as Claude's and Codex's commands, and file changes are the edit kind.
  const a = analyze({ tool: "agy command (Runner · agy, S-1)", base: "agy command", spec: "S-1", input: { command: "npm test" } });
  assert.deepEqual(a.kinds.map((k) => k.key), ["runner:command:npm test"]);
  assert.equal(analyze({ tool: "x", base: "agy command", spec: "S-1", input: { command: "echo $(id)" } }).ask, true);
  assert.deepEqual(analyze({ tool: "x", base: "agy fileChange", spec: "S-1", input: {} }).kinds.map((k) => k.key), ["runner:edit"]);
});

test("agy usage: /quota becomes weekly and 5-hour readings for the model's group", async () => {
  const m = parseQuota(JSON.stringify({ command: { data: { groups: [
    { name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: 0.68, reset_time: "2026-09-30T03:41:11Z" }] },
    { name: "Claude and GPT models", buckets: [{ window: "5h", remaining_fraction: 0.25, reset_time: null }] }] } } }))!;
  assert.deepEqual(m.readings, [{ window: "weekly", usedPercent: 32, resetsAt: "2026-09-30T03:41:11Z" }]);
  assert.deepEqual(parseQuota(JSON.stringify({ command: { data: { groups: [{ name: "Claude and GPT models", buckets: [{ window: "5h", remaining_fraction: 0.25 }] }] } } }), "claude-sonnet")!.readings,
    [{ window: "5-hour", usedPercent: 75, resetsAt: null }]);
  assert.equal(parseQuota("not json"), null);
  const t = setup("allow", () => []);
  const read = await agyUsage({ supervisor, policyDir: join(t.state, "pol"), stateDir: t.state }).read();
  assert.deepEqual(read?.readings.map((r) => [r.window, r.usedPercent]), [["weekly", 30], ["5-hour", 5]]);
});

test("the hook fails closed: no govd, bad input and an unreadable answer all deny", () => {
  const run = (sock: string, input: string) => spawnSync(process.execPath, [HOOK_SCRIPT, sock], { input, encoding: "utf8" });
  const gone = run(join(root, "nothing.sock"), JSON.stringify({ toolCall: { name: "write_to_file" } }));
  assert.equal(JSON.parse(gone.stdout).decision, "deny");
  assert.notEqual(gone.status, 0);
  const bad = run(join(root, "nothing.sock"), "not json");
  assert.equal(JSON.parse(bad.stdout).decision, "deny");
  // writeAgyConfig quotes paths with spaces and quotes safely for sh -c.
  const home = mkdtempSync(join(root, "q-"));
  writeAgyConfig(home, { node: "/opt/my node/node", script: "/a/it's.ts", socket: "/s.sock" });
  const cmd = Object.values(JSON.parse(readFileSync(join(home, ".gemini/config/hooks.json"), "utf8")) as any[])[0].PreToolUse[0].hooks[0].command;
  assert.equal(spawnSync("sh", ["-c", `printf '%s|' ${cmd}`], { encoding: "utf8" }).stdout, "/opt/my node/node|/a/it's.ts|/s.sock|");
  assert.ok(existsSync(HOOK_SCRIPT));
});

// Codex's review, 2026-09-28: each finding pinned by a test.
test("review: govd never writes through a link a Runner left in the home, and never passes other providers' keys", async () => {
  const { safeWrite, agyEnv } = await import("../src/agy.ts");
  const dir = mkdtempSync(join(root, "link-"));
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "untouched");
  const { symlinkSync, lstatSync } = await import("node:fs");
  symlinkSync(victim, join(dir, "settings.json"));
  safeWrite(join(dir, "settings.json"), "{}");
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.ok(lstatSync(join(dir, "settings.json")).isFile());
  process.env.ANTHROPIC_API_KEY = "sk-test"; process.env.OPENAI_API_KEY = "sk-test"; process.env.CLAUDE_CONFIG_DIR = "/x";
  const env = agyEnv("/tmp/x", "/home/h");
  assert.equal(env.HOME, "/home/h");
  assert.ok(!Object.keys(env).some((k) => /ANTHROPIC|OPENAI|CLAUDE|DBUS/.test(k)), Object.keys(env).join(","));
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.CLAUDE_CONFIG_DIR;
});

test("review: a link planted as settings.json during a run is replaced, not followed, on the next run", async () => {
  const t = setup("allow", (w) => [write(w, "notes/hello.txt")]);
  const victim = join(t.state, "victim.txt");
  writeFileSync(victim, "untouched");
  const { symlinkSync } = await import("node:fs");
  mkdirSync(join(t.home, ".gemini", "antigravity-cli"), { recursive: true });
  symlinkSync(victim, join(t.home, ".gemini", "antigravity-cli", "settings.json"));
  await t.call("controller.delegate", SPEC);
  assert.equal(readFileSync(victim, "utf8"), "untouched");
});

test("review: odd quota output is a failed reading, never a crash; Claude or GPT models are refused on agy", async () => {
  assert.equal(parseQuota(JSON.stringify({ command: { data: { groups: {} } } })), null);
  assert.equal(parseQuota(JSON.stringify({ command: { data: { groups: [{ name: "Gemini", buckets: {} }] } } })), null);
  assert.equal(parseQuota("null"), null);
  const t = setup("allow", (w) => [write(w, "notes/hello.txt")]);
  const r = await t.call("controller.delegate", { ...SPEC, model: "claude-sonnet-5" });
  assert.match(r.error.message, /runs Gemini models/);
  assert.match((await t.call("controller.delegate", { ...SPEC, model: "gpt-oss-120b" })).error.message, /runs Gemini models/);
  assert.equal(t.gates.length, 0);
});

test("review: junk on a turn socket gets no reply and does not crash govd; an oversized line ends only that connection", async () => {
  const { openTurnSocket } = await import("../src/delegate.ts");
  const sock = openTurnSocket(join(root, "run-junk"), async (m) => ({ ok: m }));
  const send = (payload: string) => new Promise<string | null>((ok) => {
    const s = connect(sock.path);
    let got: string | null = null;
    const rl = createInterface({ input: s });
    rl.on("error", () => {});
    rl.once("line", (l) => { got = l; s.end(); });
    s.on("close", () => ok(got));
    s.on("error", () => ok(got));
    s.write(payload);
    setTimeout(() => s.end(), 300);
  });
  try {
    assert.equal(await send("null\n"), null);
    assert.equal(await send("[1,2]\n"), null);
    assert.equal(await send("x".repeat(1_200_000)), null);
    assert.equal(await send("y".repeat(990_000) + "z".repeat(60_000) + "\n"), null, "a line completed past the cap is refused too");
    // The server is still up and answers a proper request.
    assert.equal(JSON.parse((await send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n"))!).result.ok, "ping");
  } finally { sock.close(); }
});

test("review 2: quota fields of the wrong type are skipped, never a crash", () => {
  const evil = { toString: 0 };
  assert.equal(parseQuota(JSON.stringify({ command: { data: { groups: [{ name: evil, buckets: [] }] } } })), null);
  assert.equal(parseQuota(JSON.stringify({ command: { data: { groups: [{ name: "Gemini Models", buckets: [{ window: evil, remaining_fraction: 0.5 }] }] } } })), null);
});
