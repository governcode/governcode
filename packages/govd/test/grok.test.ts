// The Grok Runner end to end with a fake `grok` that speaks ACP the way the real one does where
// it matters: initialize, session/new, session/prompt, a `session/request_permission` for every
// tool call (with an "allow always" option on offer, first), a `turn_completed` update with token
// usage, `_x.ai/billing`, `session/cancel`, and a device-code `login`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { LimitGate } from "../src/limits.ts";
import { acpTokenTally, permissionGate, pickOption, runAcpTurn, startAcp } from "../src/acp.ts";
import { grokConfig, grokPolicy, grokSettings, grokUsage, parseBilling, GROK_HOME_DIRS, GROK_HOME_FILES } from "../src/grok.ts";
import { customizations } from "../src/agy.ts";
import { toolHome } from "../src/homes.ts";
import { Connector } from "../src/connect.ts";
import { analyze } from "../src/allows.ts";
import { openControllerSocket } from "../src/delegate.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-grok-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);

// The user's own Grok setup, which a Runner must never see: it auto-approves everything.
const userHome = join(root, "user-home");
mkdirSync(join(userHome, ".grok", "hooks"), { recursive: true });
writeFileSync(join(userHome, ".grok", "config.toml"), `[ui]\npermission_mode = "always-approve"\n`);
writeFileSync(join(userHome, ".grok", "auth.json"), "the user's own login");
process.env.HOME = userHome;

// fake.json in the shared home: calls = the tool calls to make, in order; mode = a twist.
process.env.GOVERNCODE_GROK_BIN = exe("grok", `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const args = process.argv.slice(2);
const grokHome = process.env.GROK_HOME;
if (args[0] === "login") {
  process.stdout.write("Open https://auth.example/device in your browser\\nand enter the code ABCD-1234\\n");
  setTimeout(() => { fs.writeFileSync(path.join(grokHome, "auth.json"), "fake login"); process.stdout.write("Signed in.\\n"); process.exit(0); }, 100);
  return;
}
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
const login = path.join(grokHome, "auth.json");
const signedIn = fs.existsSync(login);
const shared = signedIn ? path.dirname(fs.realpathSync(login)) : grokHome;
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(shared, "fake.json"), "utf8")); } catch {}
const seen = { argv: args, home: process.env.HOME, grokHome, config: fs.readFileSync(path.join(grokHome, "config.toml"), "utf8"),
  files: fs.readdirSync(grokHome).sort(), decisions: [], cancelled: false, prompt: null, env: Object.keys(process.env).sort() };
const record = () => fs.writeFileSync(path.join(shared, "seen.json"), JSON.stringify(seen));
let next = 1; const waiting = new Map();
const ask = (method, params) => new Promise((ok) => { const id = next++; waiting.set(id, ok); out({ id, method, params }); });
let cancelled = () => {};
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { const w = waiting.get(m.id); waiting.delete(m.id); w?.(m.result ?? m.error); return; }
  if (m.method === "session/cancel") { seen.cancelled = true; cancelled(); return; }
  if (m.method === "initialize") return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  if (m.method === "_x.ai/billing") return signedIn ? out({ id: m.id, result: { config: { creditUsagePercent: 12, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-10-07T13:10:59Z" } }, subscription_tier: "SuperGrok" } })
    : out({ id: m.id, error: { code: -32000, message: "not signed in" } });
  if (m.method === "session/new") {
    if (cfg.mode === "probe") {   // an id echoed as a string is the same id; a reply may arrive in pieces, cut inside a character, ending in CRLF
      const reply = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: String(m.id), result: { sessionId: "s-1", note: "ünïcödé" } }) + "\\r\\n");
      const cut = reply.indexOf(Buffer.from("ü")) + 1;   // inside the two-byte ü
      process.stdout.write(reply.subarray(0, cut)); setTimeout(() => process.stdout.write(reply.subarray(cut)), 20);
      return;
    }
    return out({ id: m.id, result: { sessionId: "s-1" } });
  }
  if (m.method !== "session/prompt") return out({ id: m.id, error: { code: -32601, message: "no such method " + m.method } });
  seen.prompt = m.params.prompt[0].text; record();
  const update = (u, sid = "s-1") => out({ method: "session/update", params: { sessionId: sid, update: u } });
  if (cfg.mode === "flood") {   // more steps than the record takes
    for (let i = 0; i < 15000; i++) update({ sessionUpdate: "tool_call", toolCallId: "f" + i, title: "step number " + i + " of a very long list of steps that says little", kind: "other", status: "pending" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after the flood" } });
  }
  if (cfg.mode === "probe") {   // things GovernCode must refuse or ignore
    seen.refused = await ask("fs/read_text_file", { sessionId: "s-1", path: "/etc/passwd" });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not mine" } }, "s-other");
    update({ sessionUpdate: "turn_completed", usage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 } }, "s-other");
    seen.otherSession = await ask("session/request_permission", { sessionId: "s-other", toolCall: { toolCallId: "x", kind: "execute", title: "x", rawInput: { command: "id" } },
      options: [{ optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] });
  }
  let n = 0;
  for (const call of cfg.calls || []) {
    const id = "tc-" + (++n);
    update({ sessionUpdate: "tool_call", toolCallId: id, title: call.title, kind: call.kind, status: "pending", rawInput: call.rawInput });
    if (cfg.mode === "die") { process.stderr.write("boom: out of cheese\\n"); record(); process.exit(7); }
    if (cfg.mode === "wait-cancel") { await new Promise((ok) => (cancelled = ok)); record(); return out({ id: m.id, result: { stopReason: "cancelled" } }); }
    if (cfg.mode === "never") { record(); return; }   // no answer, ever
    const r = await ask("session/request_permission", { sessionId: "s-1", toolCall: { toolCallId: id, title: call.title, kind: call.kind, rawInput: call.rawInput },
      options: [{ optionId: "always", name: "Allow always", kind: "allow_always" }, { optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] });
    const d = r?.outcome?.outcome === "selected" ? r.outcome.optionId : String(r?.outcome?.outcome);
    seen.decisions.push(d);
    if ((d === "once" || d === "always") && call.write) { fs.mkdirSync(path.dirname(call.write), { recursive: true }); fs.writeFileSync(call.write, call.rawInput.content); }
    update({ sessionUpdate: "tool_call_update", toolCallId: id, status: d === "once" || d === "always" ? "completed" : "failed" });
  }
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "finished" } });
  update({ sessionUpdate: "turn_completed", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: 50 } });
  record();
  out({ id: m.id, result: { stopReason: cfg.stopReason || "end_turn" } });
  if (cfg.mode === "late-ask") setTimeout(async () => {   // asking, and talking, after the turn ended
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "too late" } });
    process.stdout.write(JSON.stringify({ id: 999, method: "session/request_permission", result: {}, params: {} }) + "\\n");   // not JSON-RPC 2.0: ignored
    process.stdout.write("x".repeat(9 * 1024 * 1024) + "\\n");                                                                  // too long: dropped
    seen.late = await ask("session/request_permission", { sessionId: "s-1", toolCall: { toolCallId: "l", kind: "execute", title: "late", rawInput: { command: "id" } },
      options: [{ optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] });
    record();
  }, 50);
});
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

function setup(answer: "allow" | "deny", calls: (work: string) => object[], extra?: (dir: string) => void, crew?: any) {
  const proj = project(extra);
  const state = mkdtempSync(join(root, "state-"));
  const home = toolHome(state, "grok");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), "login");             // the shared login (never read by govd)
  writeFileSync(join(home, "..", "connected"), "generation x\n");
  writeFileSync(join(home, "config.toml"), `[ui]\npermission_mode = "always-approve"\n`);   // left over in the shared home: a run never sees it
  const ledger = new Ledger(":memory:");
  const limits = new LimitGate();
  const gates: Array<{ tool: string; canonical: string }> = [];
  const ctx = { project: { name: "p", path: proj }, ledger, limits,
    usage: { grok: grokUsage({ supervisor, policyDir: join(state, "pol"), stateDir: state, scratch: join(state, "usage-scratch") }) },
    runtimeDir: join(state, "run"), supervisor, policyDir: join(state, "pol"), stateDir: state,
    gate: async (r: { tool: string; canonical: string }) => { if (r.tool === "governcode delegate") return "allow"; gates.push(r); return answer; }, notify: () => {},
    ...(crew ? { crew: () => crew } : {}) };
  const sock = openControllerSocket(ctx as any);
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
  const t = { proj, state, home, ledger, gates, call, close: () => { sock.close(); ledger.close(); },
    seen: () => JSON.parse(readFileSync(join(home, "seen.json"), "utf8")) };
  writeFileSync(join(home, "fake.json"), JSON.stringify({ calls: calls(join(state, "specs", "S-0001", "work")) }));
  opened.push(t);
  return t;
}

const SPEC = { to: "grok", brief: "add notes/hello.txt", result: "it says ok", scope: { read: [], write: ["notes"] },
  budgetPercent: 5, model: "", effort: null, reason: "test" };
const write = (work: string, rel: string, content = "ok\n") => ({ kind: "edit", title: `Write ${rel}`, write: join(work, rel), rawInput: { path: join(work, rel), content } });

test("grok Runner: a write waits at a Gate, allow picks 'allow once' (never 'allow always') and lands it in the Spec", async () => {
  const t = setup("allow", (w) => [write(w, "notes/hello.txt")]);
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "needs-review", JSON.stringify(r));
  assert.deepEqual(r.result.files, ["notes/hello.txt"]);
  assert.equal(t.gates.length, 1);
  assert.match(t.gates[0].tool, /^grok fileChange \(Runner · grok, S-0001\)$/);
  assert.match(t.gates[0].canonical, /"content": "ok\\n"/);
  const seen = t.seen();
  assert.deepEqual(seen.decisions, ["once"]);
  assert.deepEqual(seen.argv, ["agent", "--no-leader", "stdio"]);
  assert.match(seen.prompt, /You are a Runner in GovernCode.*add notes\/hello\.txt/s);
});

test("grok Runner: the run's home is GovernCode's, with GovernCode's config, and nothing of the user's own Grok setup", async () => {
  const t = setup("allow", (w) => [write(w, "notes/hello.txt")]);
  await t.call("controller.delegate", SPEC);
  const seen = t.seen();
  assert.equal(seen.home, seen.grokHome, "HOME and GROK_HOME are the same private home");
  assert.ok(seen.home.startsWith(join(t.state, "tools", "grok", "runs", "run-")), seen.home);
  assert.ok(!seen.home.startsWith(userHome) && !seen.home.startsWith(t.home), "not the user's home, not the shared home");
  assert.ok(!existsSync(seen.home), "and the run's home is gone afterwards");
  assert.match(seen.config, /permission_mode = "ask"/);
  assert.match(seen.config, /remember_tool_approvals = false/);
  assert.match(seen.config, /\[permission\]\nask = \["\*", "Read", "Grep", "Bash", "Edit", "WebFetch", "WebSearch", "MCPTool"\]/);
  assert.match(seen.config, /\[folder_trust\]\nenabled = true/);
  assert.match(seen.config, /\[session\]\nload_envrc = false/);
  assert.doesNotMatch(seen.config, /always-approve|\[hooks/);
  assert.deepEqual(seen.files, ["auth.json", "config.toml", ...GROK_HOME_DIRS, ...GROK_HOME_FILES].sort(), "the login link, GovernCode's config, and the places Grok may write");
  assert.ok(!seen.env.some((k: string) => /^(XAI_API_KEY|GROK_(CLAUDE|CURSOR)_.*|DBUS_SESSION_BUS_ADDRESS)$/.test(k)), "no API key, no compat switches, no keyring");
  // The sandbox policy: the private home and the worktree, never the user's own ~/.grok.
  const p = grokPolicy({ work: t.proj, tmp: "/tmp/x", home: seen.home, bin: process.env.GOVERNCODE_GROK_BIN!, writePaths: [join(t.proj, "notes")], login: join(t.home, "auth.json") });
  assert.ok(![...p.read, ...p.write].some((x) => x.startsWith(userHome)), JSON.stringify(p));
  assert.ok(p.read.includes(t.proj) && p.write.includes(join(t.proj, "notes")) && !p.write.includes(t.proj));
  // Writable in the home: only the places Grok keeps its sessions, logs and locks; never the home itself, its config or the login.
  const rhome = mkdtempSync(join(root, "rh-")); writeFileSync(join(rhome, "config.toml"), "x"); mkdirSync(join(rhome, "sessions")); writeFileSync(join(rhome, "agent_id"), "");
  const q = grokPolicy({ work: t.proj, tmp: "/tmp/x", home: rhome, bin: process.env.GOVERNCODE_GROK_BIN!, writePaths: [], login: join(t.home, "auth.json") });
  assert.deepEqual(q.write, ["/tmp/x", join(rhome, "sessions"), join(rhome, "agent_id"), "/dev/null"]);
  assert.ok(q.read.includes(rhome) && q.read.includes(join(t.home, "auth.json")));
  assert.deepEqual(p.tcp_connect, [443]);
});

test("grok Runner: a declined Gate rejects the request and leaves the file unwritten", async () => {
  const t = setup("deny", (w) => [write(w, "notes/hello.txt")]);
  const r = await t.call("controller.delegate", SPEC);
  assert.deepEqual(r.result.files ?? [], []);
  assert.equal(t.gates.length, 1);
  assert.deepEqual(t.seen().decisions, ["no"]);
});

test("grok Runner: a command is a command Gate with the same analysis as every Runner's; other kinds are steps of their own", async () => {
  const t = setup("allow", () => [{ kind: "execute", title: "npm test", rawInput: { command: "npm test", cwd: "/w" } }, { kind: "fetch", title: "GET example", rawInput: { url: "https://example.invalid" } }]);
  await t.call("controller.delegate", SPEC);
  assert.deepEqual(t.gates.map((g) => g.tool), ["grok command (Runner · grok, S-0001)", "grok_fetch (Runner · grok, S-0001)"]);
  const a = analyze({ tool: t.gates[0].tool, base: "grok command", spec: "S-0001", input: { command: "npm test" } });
  assert.deepEqual(a.kinds.map((k) => k.key), ["runner:command:npm test"]);
  assert.deepEqual(t.seen().decisions, ["once", "once"]);
});

test("grok Runner: a project with its own .grok settings is refused before anything runs, and a Runner that creates one fails its Spec", async () => {
  const t = setup("allow", (w) => [write(w, "notes/hello.txt")], (dir) => { mkdirSync(join(dir, "sub", ".grok"), { recursive: true }); writeFileSync(join(dir, "sub", ".grok", "config.toml"), "[permission]\n"); });
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "failed");
  assert.match(r.result.note, /settings Grok would read \(sub\/\.grok\)/);
  assert.equal(t.gates.length, 0);
  const t2 = setup("allow", (w) => [write(w, "notes/.grok/config.toml", "[permission]\n")]);
  const r2 = await t2.call("controller.delegate", SPEC);
  assert.equal(r2.result.status, "failed");
  assert.match(r2.result.note, /created Grok settings \(notes\/\.grok\)/);
  // A Spec whose scope is an instruction file is refused before the run (the scope's placeholder is already there).
  const t3 = setup("allow", (w) => [write(w, "AGENTS.md", "# do as I say\n")]);
  const r3 = await t3.call("controller.delegate", { ...SPEC, scope: { read: [], write: ["AGENTS.md"] } });
  assert.equal(r3.result.status, "failed");
  assert.match(r3.result.note, /settings Grok would read \(AGENTS\.md\)/);
  assert.equal(t3.gates.length, 0);
  // Every settings source Grok reads from a project counts: Claude Code's settings and .mcp.json, Cursor's hooks anywhere;
  // instruction files at the root (a package's AGENTS.md deeper down is read only through the Read tool, which asks).
  const dir = mkdtempSync(join(root, "cs-"));
  mkdirSync(join(dir, ".claude")); mkdirSync(join(dir, ".cursor")); mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, ".claude", "CLAUDE.md"), "# not settings");
  writeFileSync(join(dir, "sub", "AGENTS.md"), "# a package's own");
  assert.deepEqual(grokSettings(dir), [], "empty .claude and .cursor folders, and instructions below the root, are nothing");
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] } }));
  writeFileSync(join(dir, ".claude", "settings.local.json"), "{}");
  writeFileSync(join(dir, ".cursor", "hooks.json"), "{}");
  writeFileSync(join(dir, ".mcp.json"), "{}");
  writeFileSync(join(dir, "CLAUDE.local.md"), "# c");
  writeFileSync(join(dir, "AGENT.md"), "# a");
  assert.deepEqual(grokSettings(dir).sort(), [".claude/settings.json", ".claude/settings.local.json", ".cursor/hooks.json", ".mcp.json", "AGENT.md", "CLAUDE.local.md"]);
  // A tree too big to check is refused in plain words.
  assert.deepEqual(customizations(dir, 3, [".grok"]), ["(too many files to check)"]);

});

test("grok Runner: not connected is held, not a crash; and the Crew card's 'no subagents' reaches the config", async () => {
  const t = setup("allow", () => []);
  execFileSync("rm", [join(t.home, "..", "connected")]);
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "held");
  assert.match(r.result.reason, /not connected \(gov connect grok\)/);
  assert.match(grokConfig({ noSubagents: true }), /\[subagents\]\nenabled = false/);
  assert.doesNotMatch(grokConfig(), /subagents/);
});

test("grok usage: _x.ai/billing becomes the period's reading; anything but a figure from 0 to 100 is unreadable", async () => {
  const m = parseBilling({ config: { creditUsagePercent: 3, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-30T13:10:59.979727+00:00", end: "2026-10-07T13:10:59.979727+00:00" } }, subscription_tier: "SuperGrok" })!;
  assert.deepEqual(m.readings, [{ window: "weekly", usedPercent: 3, resetsAt: "2026-10-07T13:10:59.979Z" }]);
  assert.deepEqual(parseBilling({ config: { creditUsagePercent: 0, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } })!.readings, [{ window: "monthly", usedPercent: 0, resetsAt: null }]);
  assert.equal(parseBilling({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } }), null, "no figure yet: unknown, so held");
  assert.equal(parseBilling({ config: { creditUsagePercent: 250 } }), null);
  assert.equal(parseBilling({ config: { creditUsagePercent: -1 } }), null);
  assert.equal(parseBilling({ config: {} }), null);
  assert.equal(parseBilling({ config: { creditUsagePercent: "90", currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } }), null, "a figure of the wrong shape is unreadable, not 0");
  assert.equal(parseBilling({ config: { creditUsagePercent: NaN, currentPeriod: {} } }), null);
  assert.equal(parseBilling({ config: { currentPeriod: [] } }), null);
  assert.equal(parseBilling({}), null);
  assert.equal(parseBilling("junk"), null);
  const t = setup("allow", () => []);
  const src = grokUsage({ supervisor, policyDir: join(t.state, "pol"), stateDir: t.state, scratch: join(t.state, "usage-scratch") });
  const read = await src.read();
  assert.deepEqual(read?.readings.map((r) => [r.window, r.usedPercent]), [["weekly", 12]]);
  assert.equal(src.why?.(), null);
});

test("acp permission mapping: 'allow once' or a rejection, never 'allow always', and nothing granted when no 'allow once' is on offer", () => {
  const opts = [{ optionId: "a", kind: "allow_always" }, { optionId: "o", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }, { optionId: "ra", kind: "reject_always" }];
  assert.deepEqual(pickOption(opts, "allow"), { outcome: { outcome: "selected", optionId: "o" } });
  assert.deepEqual(pickOption(opts, "deny"), { outcome: { outcome: "selected", optionId: "r" } });
  assert.deepEqual(pickOption([opts[0], opts[2]], "allow"), { outcome: { outcome: "selected", optionId: "r" } }, "only 'allow always' offered: rejected");
  assert.deepEqual(pickOption([opts[0], opts[3]], "deny"), { outcome: { outcome: "selected", optionId: "ra" } });
  assert.deepEqual(pickOption([opts[0]], "allow"), { outcome: { outcome: "cancelled" } }, "nothing acceptable to choose: the request is cancelled");
  assert.deepEqual(pickOption("junk", "allow"), { outcome: { outcome: "cancelled" } });
  assert.deepEqual(pickOption([{ optionId: 5, kind: "allow_once" }, { kind: "allow_once" }], "allow"), { outcome: { outcome: "cancelled" } });
  // The Gate shows the request as the agent sent it.
  const cmd = permissionGate("grok", { toolCall: { kind: "execute", title: "ls", rawInput: { command: "ls -la", cwd: "/w" } } }, "g1");
  assert.equal(cmd.tool, "grok command"); assert.equal(cmd.input.command, "ls -la"); assert.equal(cmd.input.cwd, "/w");
  // The agent's title never stands in for its command: a request whose command cannot be read always asks (Codex's review).
  const titled = permissionGate("grok", { toolCall: { kind: "execute", title: "ls", rawInput: { cmd: "rm -r notes" } } }, "g");
  assert.equal(titled.input.command, null); assert.equal(titled.input.title, "ls");
  assert.equal(analyze({ tool: "x", base: "grok command", spec: "S-1", input: titled.input }).ask, true);
  assert.deepEqual(analyze({ tool: "x", base: "grok command", spec: "S-1", input: titled.input }).kinds, []);
  assert.deepEqual(pickOption([{ optionId: "same", kind: "allow_always" }, { optionId: "same", kind: "reject_once" }], "deny"), { outcome: { outcome: "cancelled" } }, "ambiguous ids: nothing chosen");
  assert.deepEqual(pickOption([{ optionId: "", kind: "reject_once" }], "deny"), { outcome: { outcome: "cancelled" } });
  assert.equal(permissionGate("grok", { toolCall: { kind: "delete", locations: [{ path: "/w/a" }] } }, "g").tool, "grok fileChange");
  assert.equal(permissionGate("grok", { toolCall: { kind: "search" } }, "g").tool, "grok_search");
  assert.equal(permissionGate("grok", { toolCall: { kind: "Bad Kind!" } }, "g").tool, "grok unknown tool");
  assert.equal(permissionGate("grok", null, "g").tool, "grok unknown tool");
  assert.equal(analyze({ tool: "x", base: "grok fileChange", spec: "S-1", input: {} }).kinds.map((k) => k.key)[0], "runner:edit");
  // Tokens: summed over turns; a turn that cannot be read leaves a floor.
  const t = acpTokenTally();
  assert.equal(t.usage(true), null);
  t.add({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }); t.add({ usage: { inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(t.usage(true), { totalTokens: 17, inputTokens: 11, outputTokens: 6, complete: true });
  t.add({ usage: { inputTokens: "x" } });
  assert.equal(t.usage(true)!.complete, false);
  const z = acpTokenTally(); z.add({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  assert.equal(z.usage(true)!.complete, false, "nothing used is not a complete report");
  z.add({ usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
  assert.deepEqual(z.usage(true), { totalTokens: 15, inputTokens: 10, outputTokens: 5, complete: false }, "one empty turn keeps the run incomplete");
});

// The driver on its own, with the fake started directly: stopping, a Gate that waits too long, a dying agent.
function direct(mode: string, calls: object[], answer: (req: any) => Promise<"allow" | "deny">) {
  const home = mkdtempSync(join(root, "direct-"));
  writeFileSync(join(home, "auth.json"), "login");
  writeFileSync(join(home, "config.toml"), grokConfig());
  writeFileSync(join(home, "fake.json"), JSON.stringify({ mode, calls }));
  const work = mkdtempSync(join(root, "work-"));
  const policyFile = join(home, "policy.json"); writeFileSync(policyFile, "{}");
  const rpc = startAcp({ supervisor, policyFile, bin: process.env.GOVERNCODE_GROK_BIN!, args: ["agent", "--no-leader", "stdio"],
    env: { PATH: process.env.PATH!, HOME: home, GROK_HOME: home }, cwd: work });
  const tools: string[] = [], texts: string[] = [];
  const hooks = { text: (s: string) => { texts.push(s); }, tool: (n: string) => { tools.push(n); }, gate: answer, done: () => {} };
  return { home, work, rpc, tools, texts, hooks, seen: () => JSON.parse(readFileSync(join(home, "seen.json"), "utf8")) };
}

test("acp: a stop sends session/cancel, the agent's 'cancelled' ends the turn as stopped, and its process is gone", async () => {
  const d = direct("wait-cancel", [{ kind: "execute", title: "sleep", rawInput: { command: "sleep 100" } }], async () => "allow");
  const stop = new AbortController();
  const step = new Promise<void>((ok) => { d.hooks.tool = (n: string) => { d.tools.push(n); ok(); }; });
  const run = runAcpTurn({ rpc: d.rpc, agent: "grok", cwd: d.work, prompt: "go", hooks: d.hooks, signal: stop.signal });
  await step;
  stop.abort("a Limit was crossed");
  const r = await run;
  assert.equal(r.ok, false); assert.equal(r.summary, "stopped: a Limit was crossed");
  d.rpc.close();
  await d.rpc.closed;
  assert.equal(d.seen().cancelled, true, "the agent got session/cancel");
  assert.deepEqual(d.tools, ["grok execute: sleep"]);
});

test("acp: a Gate nobody answers in time is rejected, and a stop rejects the Gates still waiting", async () => {
  const d = direct("", [write(join(root, "w1"), "notes/a.txt")], () => new Promise(() => {}));
  const r = await runAcpTurn({ rpc: d.rpc, agent: "grok", cwd: d.work, prompt: "go", hooks: d.hooks, gateTimeoutMs: 300 });
  d.rpc.close(); await d.rpc.closed;
  assert.equal(r.ok, true);
  assert.deepEqual(d.seen().decisions, ["no"]);
  assert.ok(!existsSync(join(root, "w1", "notes", "a.txt")));
  assert.deepEqual(r.usage, { totalTokens: 120, inputTokens: 100, outputTokens: 20, complete: true });
  assert.deepEqual(d.texts, ["finished"]);
  // Stopped while a Gate waits: rejected at once, the turn ends stopped.
  const d2 = direct("", [write(join(root, "w2"), "notes/a.txt")], () => new Promise(() => {}));
  const stop = new AbortController();
  const run = runAcpTurn({ rpc: d2.rpc, agent: "grok", cwd: d2.work, prompt: "go", hooks: d2.hooks, signal: stop.signal });
  await new Promise((ok) => setTimeout(ok, 300));
  stop.abort("turn ended");
  const r2 = await run;
  d2.rpc.close(); await d2.rpc.closed;
  assert.equal(r2.summary, "stopped: turn ended");
  assert.deepEqual(d2.seen().decisions, ["no"]);
});

test("acp: an agent that dies mid-turn ends it with its last words; requests GovernCode does not offer are refused", async () => {
  const d = direct("die", [{ kind: "execute", title: "x", rawInput: {} }], async () => "allow");
  const r = await runAcpTurn({ rpc: d.rpc, agent: "grok", cwd: d.work, prompt: "go", hooks: d.hooks });
  await d.rpc.closed;
  assert.equal(r.ok, false);
  assert.match(r.summary, /grok: the agent exited \(7\): boom: out of cheese/);
  assert.equal(r.usage, null);
});

test("acp: requests GovernCode does not offer get an error, another session's words, tokens and requests are not this run's, and a request after the turn is rejected", async () => {
  const d = direct("probe", [], async () => "allow");
  const r = await runAcpTurn({ rpc: d.rpc, agent: "grok", cwd: d.work, prompt: "go", hooks: d.hooks });
  d.rpc.close(); await d.rpc.closed;
  assert.equal(r.ok, true);
  const seen = d.seen();
  assert.match(seen.refused.message, /GovernCode does not answer fs\/read_text_file/);
  assert.deepEqual(seen.otherSession, { outcome: { outcome: "selected", optionId: "no" } });
  assert.deepEqual(d.texts, ["finished"]);
  assert.deepEqual(r.usage, { totalTokens: 120, inputTokens: 100, outputTokens: 20, complete: true });
  const late = direct("late-ask", [], async () => "allow");
  await runAcpTurn({ rpc: late.rpc, agent: "grok", cwd: late.work, prompt: "go", hooks: late.hooks });
  await new Promise((ok) => setTimeout(ok, 300));
  late.rpc.close(); await late.rpc.closed;
  assert.deepEqual(late.seen().late, { outcome: { outcome: "selected", optionId: "no" } });
  assert.deepEqual(late.texts, ["finished"], "words after the turn are not this run's");
});

test("acp: a flood of steps and words stops at the record's budget", async () => {
  const d = direct("flood", [], async () => "allow");
  const r = await runAcpTurn({ rpc: d.rpc, agent: "grok", cwd: d.work, prompt: "go", hooks: d.hooks });
  d.rpc.close(); await d.rpc.closed;
  assert.equal(r.ok, true);
  assert.ok(d.tools.length > 5000 && d.tools.length < 15000, `${d.tools.length} steps: the budget stopped the flood`);
  assert.deepEqual(d.texts, [], "words after the budget are not delivered");
});

test("acp: a prompt with no answer by its deadline ends the agent", async () => {
  const d = direct("never", [{ kind: "execute", title: "x", rawInput: {} }], async () => "allow");
  const r = await runAcpTurn({ rpc: d.rpc, agent: "grok", cwd: d.work, prompt: "go", hooks: d.hooks, promptTimeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.summary, /session\/prompt: no answer in 0s/);
  await d.rpc.closed;   // ended by the driver itself
  assert.deepEqual(d.tools, ["grok execute: x"]);
});

test("acp: a supervisor that cannot start is a plain failure, not a crash", async () => {
  const rpc = startAcp({ supervisor: join(root, "no-such-supervisor"), policyFile: "/dev/null", bin: "x", args: [], env: { PATH: process.env.PATH! }, cwd: root });
  const r = await runAcpTurn({ rpc, agent: "grok", cwd: root, prompt: "go", hooks: { text() {}, tool() {}, gate: async () => "deny", done() {} } });
  assert.equal(r.ok, false);
  assert.match(r.summary, /grok: the agent did not start: .*ENOENT/);
  await rpc.closed;
  rpc.close();   // inert once closed
});

test("connect grok: the device-code sign-in shows its link and code, ends connected, and Disconnect removes the home", async () => {
  const state = mkdtempSync(join(root, "cstate-"));
  const c = new Connector({ supervisor, policyDir: join(state, "pol"), stateDir: state });
  const g = c.list().find((t) => t.tool === "grok")!;
  assert.equal(g.installed, true); assert.equal(g.flow, "code"); assert.equal(g.connected, false);
  const seen: any[] = [];
  const r = await c.start("grok", (n: any) => seen.push(n));
  assert.equal(r.connected, true, JSON.stringify({ r, seen }));
  assert.deepEqual(seen.filter((n) => n.url).map((n) => n.url), ["https://auth.example/device"]);
  assert.ok(seen.some((n) => n.text === "and enter the code ABCD-1234"), JSON.stringify(seen));
  assert.ok(existsSync(join(toolHome(state, "grok"), "auth.json")));
  assert.equal(await c.check("grok"), true);
  const d = c.disconnect("grok");
  assert.equal(d.removed, true);
  assert.ok(!existsSync(toolHome(state, "grok")));
  assert.equal(c.list().find((t) => t.tool === "grok")!.connected, false);
});
