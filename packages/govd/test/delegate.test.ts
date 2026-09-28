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
import { LimitGate } from "../src/limits.ts";
import { codexUsage } from "../src/codex.ts";
import { openControllerSocket, accept, specModel } from "../src/delegate.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-deleg-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };

// The fake supervisor just runs the program (the real sandbox is tested elsewhere).
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);

// Fake Codex: reads fake.json from its CODEX_HOME (the tool's environment is an allowlist, so
// settings cannot ride in env vars): used = usage percent, path = the file it writes.
process.env.GOVERNCODE_CODEX_BIN = exe("codex", `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs"), path = require("node:path");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || "", "..", "fake.json"), "utf8")); } catch {}
const file = cfg.path || "tests/hello.txt";
let pending = null;
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") return out({ id: m.id, result: {} });
  if (m.method === "account/rateLimits/read") return out({ id: m.id, result: { rateLimits: { primary: { usedPercent: Number(cfg.used || 10), windowDurationMins: 10080, resetsAt: 1900000000 } } } });
  if (m.method === "thread/start") return out({ id: m.id, result: { thread: { id: "t1" } } });
  if (m.method === "turn/start") {
    out({ id: m.id, result: {} });
    out({ method: "item/started", params: { item: { id: "fc1", type: "fileChange", changes: [{ path: file, kind: { type: "add" }, diff: "ok\\n" }] } } });
    pending = 900;
    return out({ id: pending, method: "item/fileChange/requestApproval", params: { itemId: "fc1", threadId: "t1", turnId: "u1", startedAtMs: 0 } });
  }
  if (m.id === pending) {
    if (m.result && m.result.decision === "accept") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, cfg.content ?? "ok\\n"); }
    out({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: m.result && m.result.decision === "accept" ? "wrote it" : "declined" } } });
    out({ method: "turn/completed", params: { turn: { status: "completed" } } });
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

function setup(gateAnswer: "allow" | "deny" = "allow", fake: object = {}, settings?: any, turnEnded?: AbortSignal) {
  const proj = project();
  const state = mkdtempSync(join(root, "state-"));
  // Connected for GovernCode; the fake's settings sit beside its home (govd cleans the home before each run).
  mkdirSync(join(state, "tools", "codex", "home"), { recursive: true });
  writeFileSync(join(state, "tools", "codex", "home", ".governcode-connected"), "");
  writeFileSync(join(state, "tools", "codex", "fake.json"), JSON.stringify(fake));
  const ledger = new Ledger(":memory:");
  const limits = new LimitGate();
  const gates: string[] = [];
  const ctx = { project: { name: "p", path: proj }, ledger, limits,
    usage: { codex: codexUsage({ supervisor, policyDir: join(state, "pol"), stateDir: state, scratch: join(state, "scratch") }) },
    runtimeDir: join(state, "run"), supervisor, policyDir: join(state, "pol"), stateDir: state,
    gate: async (r: { tool?: string; canonical: string }) => { if (r.tool === "governcode delegate") return "allow" as const; gates.push(r.canonical); return gateAnswer; }, notify: () => {},
    ...(settings ? { settings: () => settings } : {}), ...(turnEnded ? { turnEnded } : {}) };
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

const SPEC = { to: "codex", brief: "add tests/hello.txt", result: "it contains ok", scope: { read: [], write: ["tests"] },
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
  assert.equal(t.ledger.spec(r.result.id)!.status, "undone");
  const again = await t.call("controller.spec_discard", { id: r.result.id });
  assert.match(again.error.message, /only a Spec waiting for review, failed or held/);
});

test("review: a Runner whose Controller's turn has ended is stopped, not left running", async () => {
  const ended = new AbortController();
  ended.abort("turn ended");
  const t = setup("allow", {}, undefined, ended.signal);
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "failed");
  assert.match(r.result.note, /stopped: the Controller's turn ended/);
});
