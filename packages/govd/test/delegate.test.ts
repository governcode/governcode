// Delegation end to end with a fake Codex app-server (speaks the real JSON-RPC shapes), so CI
// covers the whole path: Limit, workspace, Runner Gate, snapshots, scope check, diff, accept.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { CountedStore, LimitGate, withBudget } from "../src/limits.ts";
import { codexTokenTally, codexUsage, MAX_RUN_TOKENS } from "../src/codex.ts";
import { openControllerSocket, accept, specModel, SpecRuns } from "../src/delegate.ts";
import { specPaths } from "../src/specstore.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-deleg-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };

// The fake supervisor just runs the program (the real sandbox is tested elsewhere).
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);

// Fake Codex: reads fake.json from its CODEX_HOME (the tool's environment is an allowlist, so
// settings cannot ride in env vars): used = usage percent, path = the file it writes,
// tokens = thread/tokenUsage/updated params it sends before the turn completes, status = how the turn ends,
// hang = never finish (a Runner still at work until stopped), log = a file each turn's params are added to.
process.env.GOVERNCODE_CODEX_BIN = exe("codex", `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs"), path = require("node:path");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || "", "..", "..", "fake.json"), "utf8")); } catch {}
const file = cfg.path || "tests/hello.txt";
let pending = null;
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") return out({ id: m.id, result: {} });
  if (m.method === "account/rateLimits/read") return out({ id: m.id, result: { rateLimits: { primary: { usedPercent: Number(cfg.used || 10), windowDurationMins: 10080, resetsAt: 1900000000 } } } });
  if (m.method === "thread/start") return out({ id: m.id, result: { thread: { id: "t1" } } });
  if (m.method === "turn/start") {
    if (cfg.log) fs.appendFileSync(cfg.log, JSON.stringify(m.params) + "\\n");
    out({ id: m.id, result: {} });
    out({ method: "item/started", params: { item: { id: "fc1", type: "fileChange", changes: [{ path: file, kind: { type: "add" }, diff: "ok\\n" }] } } });
    pending = 900;
    return out({ id: pending, method: "item/fileChange/requestApproval", params: { itemId: "fc1", threadId: "t1", turnId: "u1", startedAtMs: 0 } });
  }
  if (m.id === pending) {
    if (m.result && m.result.decision === "accept") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, cfg.content ?? "ok\\n"); }
    out({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: m.result && m.result.decision === "accept" ? "wrote it" : "declined" } } });
    if (cfg.hang) return;
    for (const params of cfg.tokens || []) out({ method: "thread/tokenUsage/updated", params });
    out({ method: "turn/completed", params: { turn: { status: cfg.status || "completed" } } });
  }
});
`);

function project() {
  const dir = mkdtempSync(join(root, "proj-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# p\n");
  g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  return dir;
}

function setup(gateAnswer: "allow" | "deny" = "allow", fake: object = {}, settings?: any, turnEnded?: AbortSignal,
    budget?: (usage: any, state: string) => object, extra: object = {}) {
  const proj = project();
  const state = mkdtempSync(join(root, "state-"));
  // Connected for GovernCode; the fake's settings sit beside its home (govd cleans the home before each run).
  mkdirSync(join(state, "tools", "codex", "home"), { recursive: true });
  writeFileSync(join(state, "tools", "codex", "connected"), "");
  writeFileSync(join(state, "tools", "codex", "fake.json"), JSON.stringify(fake));
  const ledger = new Ledger(":memory:");
  const limits = new LimitGate();
  const gates: string[] = [];
  const ctx = { project: { name: "p", path: proj }, ledger, limits,
    usage: { codex: codexUsage({ supervisor, policyDir: join(state, "pol"), stateDir: state, scratch: join(state, "scratch") }) },
    runtimeDir: join(state, "run"), supervisor, policyDir: join(state, "pol"), stateDir: state,
    gate: async (r: { tool?: string; canonical: string }) => { if (r.tool === "governcode delegate") return "allow" as const; gates.push(r.canonical); return gateAnswer; }, notify: () => {},
    ...(settings ? { settings: () => settings } : {}), ...(turnEnded ? { turnEnded } : {}), ...extra };
  if (budget) Object.assign(ctx, budget(ctx.usage.codex, state));
  const sock = openControllerSocket(ctx);
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
  const t = { proj, state, ledger, gates, call, close: () => { sock.close(); ledger.close(); } };
  opened.push(t);
  return t;
}

// Every setup is closed after each test even when an assertion fails, so a failure reports
// instead of hanging on an open socket.
const opened: Array<{ close(): void }> = [];
afterEach(() => { while (opened.length) { try { opened.pop()!.close(); } catch { /* already */ } } });

const SPEC = { mode: "wait", to: "codex", brief: "add tests/hello.txt", result: "it contains ok", scope: { read: [], write: ["tests"] },
  budgetPercent: 5, model: "gpt-5.5", effort: "low", reason: "test" };

test("delegate: Limit checked, Runner Gate shown with the change, diff returned, accept applies it", async () => {
  const t = setup("allow");
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "needs-review", JSON.stringify(r));
  assert.deepEqual(r.result.files, ["tests/hello.txt"]);
  assert.match(r.result.diff, /\+ok/);
  assert.match(t.gates[0], /"path": "tests\/hello\.txt"/);          // the Gate showed the actual change
  assert.ok(!existsSync(join(t.proj, "tests/hello.txt")), "nothing lands in the project before accept");
  const spec = t.ledger.spec(r.result.id)!;
  assert.deepEqual(accept(t.state, t.proj, spec), ["tests/hello.txt"]);
  assert.equal(readFileSync(join(t.proj, "tests/hello.txt"), "utf8"), "ok\n");
});

test("delegate: a Runner inside its Limit is held, and nothing runs", async () => {
  const t = setup("allow", { used: 95 });
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "held");
  assert.match(r.result.reason, /Limit/);
  assert.equal(t.gates.length, 0);
});

test("delegate: a change outside the scope fails the Spec instead of being offered", async () => {
  const t = setup("allow", { path: "src/sneaky.txt" });
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "failed");
  assert.match(r.result.note, /outside its scope: src\/sneaky\.txt/);
});

test("delegate: the controller socket offers nothing else (no Gate answers)", async () => {
  const t = setup();
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("gate.answer", { id: "G-1", answer: "allow" });
  assert.match(r.error.message, /not offered to the Controller/);
});

test("codex MCP approvals match exactly one in-flight GovernCode call, or are declined", async () => {
  const { matchMcpApproval } = await import("../src/codex.ts");
  const ask = (tool: string, extra: object = {}) => ({ serverName: "governcode", _meta: { codex_approval_kind: "mcp_tool_call" },
    message: `Allow the governcode MCP server to run tool "${tool}"?`, ...extra });
  const one = new Map([["c1", { tool: "delegate", args: { to: "codex" } }]]);
  assert.deepEqual(matchMcpApproval(ask("delegate"), one), { tool: "delegate", args: { to: "codex" } });
  assert.equal(matchMcpApproval(ask("crew"), one), null, "a tool that was not announced");
  assert.equal(matchMcpApproval(ask("delegate", { serverName: "other" }), one), null, "another server");
  assert.equal(matchMcpApproval({ ...ask("delegate"), message: 'x "delegate" y' }, one), null, "not Codex's exact sentence");
  assert.equal(matchMcpApproval({ ...ask("delegate"), _meta: {} }, one), null, "not a tool-call approval");
  const two = new Map([["c1", { tool: "delegate", args: { to: "a" } }], ["c2", { tool: "delegate", args: { to: "b" } }]]);
  assert.equal(matchMcpApproval(ask("delegate"), two), null, "two parallel calls: ambiguous, so declined");
  assert.equal(matchMcpApproval(ask("delegate"), new Map([["c1", { tool: "delegate", args: undefined }]])), null, "no arguments to show");
});

test("per-Spec models: free keeps the pick, within never goes heavier, defaults always wins", () => {
  const base = { reserves: {}, runners: { codex: { model: "gpt-5.5", effort: "medium" as const } } };
  const ask = { to: "codex", model: "gpt-5.5-pro", effort: "max" as const };
  assert.deepEqual(specModel(ask, { ...base, specModels: "free" }), { model: "gpt-5.5-pro", effort: "max", note: null });
  const within = specModel(ask, { ...base, specModels: "within" });
  assert.deepEqual([within.model, within.effort], ["gpt-5.5", "medium"]);
  assert.match(within.note!, /kept within your Settings/);
  assert.deepEqual(specModel({ to: "codex", model: "gpt-5.5", effort: "low" }, { ...base, specModels: "within" }),
    { model: "gpt-5.5", effort: "low", note: null }, "lighter is fine");
  const forced = specModel({ to: "codex", model: "x", effort: "low" }, { ...base, specModels: "defaults" });
  assert.deepEqual([forced.model, forced.effort], ["gpt-5.5", "medium"]);
  assert.deepEqual(specModel(ask, { runners: {}, specModels: "defaults" }).model, "gpt-5.5-pro", "no default set: the pick stands");
});

test("delegate: the Spec records the model Settings allowed, and crew tells the Controller the policy", async () => {
  const t = setup("allow", {}, { reserves: {}, runners: { codex: { model: "gpt-5.5", effort: "low" } }, specModels: "defaults" });
  await new Promise((r) => setTimeout(r, 50));
  const crew = await t.call("controller.crew", {});
  assert.equal(crew.result.runners[0].defaultModel, "gpt-5.5");
  assert.match(crew.result.modelPolicy, /always uses its default/);
  const r = await t.call("controller.delegate", { ...SPEC, model: "gpt-5.5-pro", effort: "high" });
  const spec = t.ledger.spec(r.result.id)!;
  assert.deepEqual([spec.model, spec.effort], ["gpt-5.5", "low"]);
});

test("delegate: a single-file scope works for an existing file and a new one; an untouched new file leaves no trace", async () => {
  // A demo run found this: a write scope naming a file was created as a folder and the Spec failed.
  const existing = setup("allow", { path: "README.md" });
  await new Promise((r) => setTimeout(r, 50));
  const a = await existing.call("controller.delegate", { ...SPEC, scope: { read: [], write: ["README.md"] } });
  assert.equal(a.result.status, "needs-review", JSON.stringify(a));
  assert.deepEqual(a.result.files, ["README.md"]);
  const fresh = setup("allow", { path: "NOTES.md" });
  await new Promise((r) => setTimeout(r, 50));
  const b = await fresh.call("controller.delegate", { ...SPEC, scope: { read: [], write: ["NOTES.md"] } });
  assert.equal(b.result.status, "needs-review", JSON.stringify(b));
  assert.deepEqual(b.result.files, ["NOTES.md"]);
  const untouched = setup("allow", { path: "tests/hello.txt" });
  await new Promise((r) => setTimeout(r, 50));
  const c = await untouched.call("controller.delegate", { ...SPEC, scope: { read: [], write: ["NOTES.md", "tests"] } });
  assert.equal(c.result.status, "needs-review", JSON.stringify(c));
  assert.deepEqual(c.result.files, ["tests/hello.txt"], "the empty placeholder for NOTES.md is not a change");
});

test("delegate: a new Dockerfile is a file, a name ending in / a folder, and an empty file the Runner wrote stays", async () => {
  const docker = setup("allow", { path: "Dockerfile" });
  await new Promise((r) => setTimeout(r, 50));
  const a = await docker.call("controller.delegate", { ...SPEC, scope: { read: [], write: ["Dockerfile"] } });
  assert.deepEqual([a.result.status, a.result.files], ["needs-review", ["Dockerfile"]], JSON.stringify(a));
  const folder = setup("allow", { path: "cache.v1/data.txt" });
  await new Promise((r) => setTimeout(r, 50));
  const b = await folder.call("controller.delegate", { ...SPEC, scope: { read: [], write: ["cache.v1/"] } });
  assert.deepEqual([b.result.status, b.result.files], ["needs-review", ["cache.v1/data.txt"]], JSON.stringify(b));
  const empty = setup("allow", { path: "pkg/__init__.py", content: "" });
  await new Promise((r) => setTimeout(r, 50));
  const c = await empty.call("controller.delegate", { ...SPEC, scope: { read: [], write: ["pkg/__init__.py"] } });
  assert.deepEqual([c.result.status, c.result.files], ["needs-review", ["pkg/__init__.py"]], "an empty file written on purpose is a change");
});

test("the model may be left out, or given as \"default\": the Runner's own default is used", () => {
  const input = { to: "codex", model: "default", effort: null } as any;
  assert.deepEqual(specModel(input, undefined), { model: "", effort: null, note: null });
  assert.deepEqual(specModel({ ...input, model: "" }, { runners: { codex: { model: "gpt-x", effort: "low" } }, specModels: "free" } as any),
    { model: "gpt-x", effort: "low", note: null });
  // An empty model must not skip the effort policy (security review 2026-09-27).
  const within = specModel({ ...input, model: "", effort: "max" }, { runners: { codex: { model: "gpt-x", effort: "low" } }, specModels: "within" } as any);
  assert.equal(within.effort, "low");
});

test("the Controller can discard its own Spec, but not one that was accepted", async () => {
  const t = setup("allow");
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "needs-review");
  const d = await t.call("controller.spec_discard", { id: r.result.id });
  assert.equal(d.result.discarded, true);
  assert.equal(t.ledger.spec(r.result.id)!.status, "discarded");
  const again = await t.call("controller.spec_discard", { id: r.result.id });
  assert.match(again.error.message, /only a Spec waiting for review, failed, cancelled or held/);
});

test("a Spec outlives the Controller's turn: a wait stops waiting, the Runner finishes, and the Controller is told later", async () => {
  const ended = new AbortController();
  ended.abort("turn ended");
  const told: string[] = [];
  const runs = new SpecRuns();
  const t = setup("allow", {}, undefined, ended.signal, undefined, { runs, onSpecDone: (id: string) => told.push(id) });
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "running", JSON.stringify(r));
  assert.equal(r.result.waitTimedOut, true, "a wait in a turn that has ended returns at once");
  await runs.done(r.result.id);
  await new Promise((ok) => setTimeout(ok, 10));
  const s = t.ledger.spec(r.result.id)!;
  assert.equal(s.status, "needs-review", "the Runner was not stopped by the turn's end");
  assert.equal(s.delivery, "pending");
  assert.deepEqual(told, [r.result.id], "the Controller hears about it later");
});

test("delegate: a counted budget counts each Runner turn, and the stricter reading holds the next Spec", async () => {
  // Codex reports 10% used (room to spare); the user's budget allows one Runner turn a day.
  const t = setup("allow", {}, undefined, undefined, (codex, state) => {
    const counted = new CountedStore(join(state, "counted.json"));
    return { counted, usage: { codex: withBudget("codex", codex, counted, () => ({ unit: "turns", windows: { daily: 1 } })) } };
  });
  await new Promise((r) => setTimeout(r, 50));
  const first = await t.call("controller.delegate", SPEC);
  assert.equal(first.result.status, "needs-review", JSON.stringify(first));
  assert.equal(JSON.parse(readFileSync(join(t.state, "counted.json"), "utf8")).tallies.codex.daily.turns, 1);
  const second = await t.call("controller.delegate", SPEC);
  assert.equal(second.result.status, "held");
  assert.match(second.result.reason, /inside its daily budget \(1 of 1 turns used; counted by GovernCode only\)/);
});

// thread/tokenUsage/updated params as Codex's app-server sends them (v2 ThreadTokenUsage).
const usage = (threadId: string, totalTokens: unknown, inputTokens: unknown = 0, outputTokens: unknown = 0) => ({ threadId, turnId: "u1",
  tokenUsage: { total: { totalTokens, inputTokens, cachedInputTokens: 0, outputTokens, reasoningOutputTokens: 0 },
                last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: null } });

const tokenBudget = (daily: number) => (codex: any, state: string) => {
  const counted = new CountedStore(join(state, "counted.json"));
  return { counted, settings: () => ({ reserves: {}, runners: {}, budgets: { codex: { unit: "tokens", windows: { daily } } } }),
    usage: { codex: withBudget("codex", codex, counted, () => ({ unit: "tokens", windows: { daily } })) } };
};
const daily = (state: string) => JSON.parse(readFileSync(join(state, "counted.json"), "utf8")).tallies.codex.daily;

test("delegate: Codex's reported tokens are counted, the latest total per thread, summed over its threads", async () => {
  // Thread t1 reports twice (running totals: 100, then 250); a subagent's thread t2 reports 50.
  const t = setup("allow", { tokens: [usage("t1", 100, 80, 20), usage("t1", 250, 200, 50), usage("t2", 50, 40, 10)] },
    undefined, undefined, tokenBudget(1000));
  await new Promise((r) => setTimeout(r, 50));
  const first = await t.call("controller.delegate", SPEC);
  assert.equal(first.result.status, "needs-review", JSON.stringify(first));
  const d = daily(t.state);
  assert.deepEqual([d.tokens, d.turns, d.unreported], [300, 1, 0]);
  // 300 of 1000 tokens: the next Spec still runs.
  const second = await t.call("controller.delegate", SPEC);
  assert.equal(second.result.status, "needs-review", JSON.stringify(second));
  assert.equal(daily(t.state).tokens, 600);
});

test("delegate: a Codex run with no usage report counts as unknown tokens, and a token budget holds", async () => {
  const t = setup("allow", {}, undefined, undefined, tokenBudget(1000));
  await new Promise((r) => setTimeout(r, 50));
  const first = await t.call("controller.delegate", SPEC);
  assert.equal(first.result.status, "needs-review", JSON.stringify(first));
  assert.equal(daily(t.state).unreported, 1);
  const second = await t.call("controller.delegate", SPEC);
  assert.equal(second.result.status, "held");
  assert.match(second.result.reason, /did not report tokens/);
});

test("delegate: only malformed Codex usage reports count as unknown tokens, never as a number", async () => {
  const t = setup("allow", { tokens: [usage("t1", -5), usage("t1", "300"), usage("t1", null), { threadId: "t1" }, usage(7 as any, 10)] },
    undefined, undefined, tokenBudget(1000));
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "needs-review", JSON.stringify(r));
  assert.deepEqual([daily(t.state).tokens, daily(t.state).unreported], [0, 1]);
});

test("delegate: a malformed Codex usage report after valid ones counts the valid tokens as a floor, and a token budget holds", async () => {
  // A child thread's update cannot be read: the run's 250 tokens are only part of what it used.
  const t = setup("allow", { tokens: [usage("t1", 250, 200, 50), usage("t2", "90")] }, undefined, undefined, tokenBudget(1000));
  await new Promise((r) => setTimeout(r, 50));
  const first = await t.call("controller.delegate", SPEC);
  assert.equal(first.result.status, "needs-review", JSON.stringify(first));
  const d = daily(t.state);
  assert.deepEqual([d.tokens, d.turns, d.unreported], [250, 1, 1]);
  const second = await t.call("controller.delegate", SPEC);
  assert.equal(second.result.status, "held");
  assert.match(second.result.reason, /did not report tokens/);
});

test("delegate: a Codex run that did not end normally counts its tokens as a floor, and a token budget holds", async () => {
  const t = setup("allow", { tokens: [usage("t1", 120, 100, 20)], status: "failed" }, undefined, undefined, tokenBudget(1000));
  await new Promise((r) => setTimeout(r, 50));
  const first = await t.call("controller.delegate", SPEC);
  assert.equal(first.result.status, "failed", JSON.stringify(first));
  const d = daily(t.state);
  assert.deepEqual([d.tokens, d.turns, d.unreported], [120, 1, 1]);
  const second = await t.call("controller.delegate", SPEC);
  assert.equal(second.result.status, "held");
});

test("codex token tally: malformed updates mark the run incomplete, never negative or NaN, capped, never counted twice", () => {
  const clean = codexTokenTally();
  assert.equal(clean.usage(true), null);                               // nothing reported: unknown
  clean.add(usage("t1", 40, 30, 10));
  clean.add(usage("t1", 25, 20, 5));                                   // an older total arriving late: ignored
  clean.add(usage("t1", 40, 30, 10));                                  // a repeat: not counted twice
  assert.deepEqual(clean.usage(true), { totalTokens: 40, inputTokens: 30, outputTokens: 10, complete: true });
  assert.equal(clean.usage(false)!.complete, false);                   // ended early: a floor only
  for (const bad of [null, {}, "x", { threadId: "t1" }, { threadId: "t1", tokenUsage: { total: null } },
    usage("t1", -1), usage("t1", Number.NaN), usage("t1", Infinity), usage("t1", "12"), usage("t1", 5, -1), usage("t1", 5, 1, "2"), usage(7 as any, 10)]) {
    const tally = codexTokenTally();
    tally.add(bad);
    assert.equal(tally.usage(true), null, JSON.stringify(bad));        // nothing valid: unknown
    tally.add(usage("t1", 40, 30, 10));
    assert.deepEqual(tally.usage(true), { totalTokens: 40, inputTokens: 30, outputTokens: 10, complete: false }, JSON.stringify(bad));
  }
  const big = codexTokenTally();
  big.add(usage("t2", 1e300, 1e300, 1e300));                           // absurd: capped
  big.add(usage("t3", MAX_RUN_TOKENS, 0, 0));
  const u = big.usage(true)!;
  assert.deepEqual(u, { totalTokens: MAX_RUN_TOKENS, inputTokens: MAX_RUN_TOKENS, outputTokens: MAX_RUN_TOKENS, complete: true });
  assert.ok([u.totalTokens, u.inputTokens, u.outputTokens].every((v) => Number.isFinite(v) && v >= 0));
});

// --- Parallel Specs (#227): async by default, caps, cancel, follow-up, status --------------------

const until = async (f: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !f(); await new Promise((ok) => setTimeout(ok, 20))) if (Date.now() > end) throw new Error("timed out");
};
const CAPS = (maxPerProject: number, maxPerRunner: number) => ({ reserves: {}, runners: {}, specModels: "free", budgets: {}, specs: { maxPerProject, maxPerRunner } });
const ASYNC = { ...SPEC, mode: "async" };

test("async: a handoff returns at once, Specs run side by side up to the caps, and a cancel keeps partial work", async () => {
  const runs = new SpecRuns();
  const told: string[] = [];
  const t = setup("allow", { hang: true }, CAPS(2, 2), undefined, undefined, { runs, onSpecDone: (id: string) => told.push(id), provider: "claude-code" });
  const a = await t.call("controller.delegate", ASYNC);
  assert.equal(a.result.status, "running", JSON.stringify(a));
  assert.equal(a.result.mode, "async");
  assert.match(a.result.next, /end your turn/);
  const b = await t.call("controller.delegate", ASYNC);
  assert.equal(b.result.status, "running", JSON.stringify(b));
  assert.equal(runs.count("p"), 2);
  const c = await t.call("controller.delegate", ASYNC);
  assert.match(c.error.message, /2 Specs already running in this project/);
  // Both Runners wrote their file and are still at work: a cancel stops one, its work stays.
  await until(() => [a, b].every((x) => existsSync(join(specPaths(t.state, x.result.id).work, "tests/hello.txt"))));
  const cancelled = await t.call("controller.spec_cancel", { id: a.result.id, reason: "wrong approach" });
  assert.equal(cancelled.result.status, "needs-review", JSON.stringify(cancelled));
  assert.deepEqual(cancelled.result.files, ["tests/hello.txt"]);
  assert.match(cancelled.result.note, /cancelled before it finished: partial work/);
  const s = t.ledger.spec(a.result.id)!;
  assert.equal(s.delivery, "disposed", "whoever cancelled it knows: no later turn is started for it");
  const ev = t.ledger.eventsOfKind("p", ["spec.cancel"]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "controller · claude-code");
  assert.equal(ev[0].data.reason, "wrong approach");
  assert.equal(runs.count("p"), 1);
  assert.match((await t.call("controller.spec_cancel", { id: a.result.id })).error.message, /not running/);
  await t.call("controller.spec_cancel", { id: b.result.id });
  assert.deepEqual(told, [], "a cancelled Spec wakes no one");
});

test("caps: one Runner's cap holds while another project slot is free", async () => {
  const runs = new SpecRuns();
  const t = setup("allow", { hang: true }, CAPS(3, 1), undefined, undefined, { runs });
  const a = await t.call("controller.delegate", ASYNC);
  assert.equal(a.result.status, "running", JSON.stringify(a));
  assert.match((await t.call("controller.delegate", ASYNC)).error.message, /codex is already running 1 Spec \(the most/);
  await until(() => existsSync(join(specPaths(t.state, a.result.id).work, "tests/hello.txt")));
  await t.call("controller.spec_cancel", { id: a.result.id });
});

test("cancel with nothing changed: the Spec ends cancelled, and nobody is told", async () => {
  const runs = new SpecRuns();
  const told: string[] = [];
  const t = setup("deny", { hang: true }, undefined, undefined, undefined, { runs, onSpecDone: (id: string) => told.push(id) });
  const a = await t.call("controller.delegate", ASYNC);
  await until(() => t.gates.length > 0);   // the Runner asked, was denied, and is still at work
  const r = await t.call("controller.spec_cancel", { id: a.result.id });
  assert.equal(r.result.status, "cancelled", JSON.stringify(r));
  assert.deepEqual(r.result.files, []);
  assert.equal(t.ledger.spec(a.result.id)!.delivery, "disposed");
  assert.deepEqual(told, []);
  assert.deepEqual(t.ledger.eventsOfKind("p", ["spec.cancel", "spec.cancelled"]).map((e) => `${e.kind} ${e.actor}`), ["spec.cancel controller", "spec.cancelled govd"]);
});

test("follow-up: the same copy, a Gate again, the context spelled out, and every round in the diff and Accept", async () => {
  const runs = new SpecRuns();
  const log = join(root, `turns-${Date.now()}.jsonl`);
  const t = setup("allow", { log }, undefined, undefined, undefined, { runs, provider: "codex" });
  const first = await t.call("controller.delegate", SPEC);
  assert.equal(first.result.status, "needs-review", JSON.stringify(first));
  const id = first.result.id;
  // The Runner's second round writes another file.
  writeFileSync(join(t.state, "tools", "codex", "fake.json"), JSON.stringify({ log, path: "tests/second.txt", content: "two\n" }));
  const second = await t.call("controller.spec_followup", { id, message: "also add tests/second.txt", mode: "wait" });
  assert.equal(second.result.status, "needs-review", JSON.stringify(second));
  assert.deepEqual([...second.result.files].sort(), ["tests/hello.txt", "tests/second.txt"], "the diff covers every round");
  assert.ok(t.gates.some((g) => /governcode spec_followup/.test(g) || /also add tests\/second\.txt/.test(g)), "the follow-up asked at a Gate");
  const prompts = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /follow-up on earlier work in this same workspace/);
  assert.match(prompts[1], /add tests\/hello\.txt/, "the original brief");
  assert.match(prompts[1], /wrote it/, "its last summary, quoted");
  assert.match(prompts[1], /also add tests\/second\.txt/);
  const s = t.ledger.spec(id)!;
  assert.equal(s.summaries?.length, 2);
  assert.equal(t.ledger.eventsOfKind("p", ["spec.followup"]).length, 1);
  assert.deepEqual(accept(t.state, t.proj, s).sort(), ["tests/hello.txt", "tests/second.txt"]);
  assert.equal(readFileSync(join(t.proj, "tests/second.txt"), "utf8"), "two\n");
  // Accepted: nothing more to follow up.
  t.ledger.updateSpec(id, { status: "accepted" }, "user");
  assert.match((await t.call("controller.spec_followup", { id, message: "more" })).error.message, /is accepted/);
});

test("follow-up: declined at its Gate, nothing runs and the Spec stays as it was", async () => {
  const runs = new SpecRuns();
  const t = setup("allow", {}, undefined, undefined, undefined, { runs });
  const id = (await t.call("controller.delegate", SPEC)).result.id;
  const before = t.ledger.spec(id)!;
  // A later turn's socket on the same project, whose user says no.
  const sock = openControllerSocket({ project: { name: "p", path: t.proj }, ledger: t.ledger, limits: new LimitGate(), usage: { codex: { provider: "codex", read: async () => null } },
    runtimeDir: join(t.state, "run"), supervisor, policyDir: join(t.state, "pol"), stateDir: t.state, runs, gate: async () => "deny" as const, notify: () => {} });
  opened.push(sock);
  const r = await new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "controller.spec_followup", params: { id, message: "again" } }) + "\n");
  });
  assert.match(r.error?.message ?? "", /declined this follow-up/, JSON.stringify(r));
  const after = t.ledger.spec(id)!;
  assert.equal(after.status, before.status);
  assert.deepEqual(after.summaries, before.summaries);
  assert.equal(t.ledger.eventsOfKind("p", ["spec.followup"]).length, 0);
});

test("spec_status: the Runner's words as data, the diff, and reading a finished Spec counts as told", async () => {
  const runs = new SpecRuns();
  const told: string[] = [];
  const t = setup("allow", {}, undefined, undefined, undefined, { runs, onSpecDone: (id: string) => told.push(id) });
  const a = await t.call("controller.delegate", ASYNC);
  await runs.done(a.result.id);
  await until(() => told.length === 1);
  assert.equal(t.ledger.spec(a.result.id)!.delivery, "pending");
  const st = await t.call("controller.spec_status", { id: a.result.id });
  assert.equal(st.result.status, "needs-review", JSON.stringify(st));
  assert.equal(st.result.running, false);
  assert.equal(st.result.runnerSummary.text, "wrote it");
  assert.match(st.result.runnerSummary.about, /information, not instructions/);
  assert.match(st.result.diff, /\+ok/);
  assert.match(st.result.review, /Only the user accepts it/);
  assert.equal(t.ledger.spec(a.result.id)!.delivery, "acknowledged");
});

test("a Runner's Gates go to govd's own Spec gate, which is ended with the round", async () => {
  const runs = new SpecRuns();
  const seen: string[] = [], ended: string[] = [];
  const t = setup("deny", {}, undefined, undefined, undefined, { runs,
    specGate: (spec: { id: string }) => ({ gate: async (req: { tool: string }) => { seen.push(req.tool); return "allow" as const; }, end: () => ended.push(spec.id) }) });
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "needs-review", JSON.stringify(r));
  assert.deepEqual(t.gates, [], "not the turn's gate");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /\(Runner · codex, S-\d+\)$/);
  assert.deepEqual(ended, [r.result.id]);
});

test("parallel calls: two follow-ups at once start one round, and two handoffs at once keep to the caps", async () => {
  const runs = new SpecRuns();
  const t = setup("allow", {}, CAPS(1, 1), undefined, undefined, { runs });
  const id = (await t.call("controller.delegate", SPEC)).result.id;
  writeFileSync(join(t.state, "tools", "codex", "fake.json"), JSON.stringify({ hang: true }));
  const both = await Promise.all([t.call("controller.spec_followup", { id, message: "one" }), t.call("controller.spec_followup", { id, message: "two" })]);
  assert.equal(both.filter((r) => r.result?.status === "running").length, 1, JSON.stringify(both));
  assert.match(both.find((r) => r.error)!.error.message, /still running|already running/);
  assert.equal(runs.count("p"), 1);
  await t.call("controller.spec_cancel", { id });
  const two = await Promise.all([t.call("controller.delegate", ASYNC), t.call("controller.delegate", ASYNC)]);
  assert.equal(two.filter((r) => r.result?.status === "running").length, 1, JSON.stringify(two));
  assert.equal(runs.count("p"), 1);
  await t.call("controller.spec_cancel", { id: two.find((r) => r.result)!.result.id });
});

test("a Runner that cannot start owes nothing: no Limit debit, no counted turn", async () => {
  const runs = new SpecRuns();
  const limits = new LimitGate();
  const fresh = { provider: "codex", read: async () => ({ provider: "codex", measuredAt: Date.now(), readings: [{ window: "weekly", usedPercent: 10, resetsAt: null }] }) };
  const t = setup("allow", {}, undefined, undefined, undefined, { runs, limits, usage: { codex: fresh } });
  const counted = new CountedStore(join(t.state, "counted.json"));
  const real = process.env.GOVERNCODE_CODEX_BIN;
  process.env.GOVERNCODE_CODEX_BIN = join(root, "no-such-codex");   // measured fine; its own start fails
  try {
    const sock = openControllerSocket({ project: { name: "p", path: t.proj }, ledger: t.ledger, limits, usage: { codex: fresh }, counted, runs,
      runtimeDir: join(t.state, "run"), supervisor, policyDir: join(t.state, "pol"), stateDir: t.state, gate: async () => "allow" as const, notify: () => {} });
    opened.push(sock);
    const r = await new Promise<any>((ok) => {
      const s = connect(sock.path);
      createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
      s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "controller.delegate", params: SPEC }) + "\n");
    });
    assert.equal(r.result.status, "failed", JSON.stringify(r));
    assert.match(r.result.note, /codex did not start/);
  } finally { process.env.GOVERNCODE_CODEX_BIN = real; }
  assert.equal(limits.view("codex").owedPercent, 0, "no debit for a run that never started");
  const saved = JSON.parse(readFileSync(join(t.state, "counted.json"), "utf8"));
  assert.deepEqual(saved.open, {}, "its counted entry was dropped");
  assert.equal(saved.tallies.codex, undefined, "and nothing was counted");
});
