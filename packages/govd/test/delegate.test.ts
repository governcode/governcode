// Delegation end to end with a fake Codex app-server (speaks the real JSON-RPC shapes), so CI
// covers the whole path: Limit, workspace, Runner Gate, snapshots, scope check, diff, accept.
import { test } from "node:test";
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
import { openControllerSocket, accept } from "../src/delegate.ts";

const root = mkdtempSync(join(tmpdir(), "gc-deleg-"));
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };

// The fake supervisor just runs the program (the real sandbox is tested elsewhere).
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 3\nexec "$@"\n`);

// Fake Codex: reads fake.json from its CODEX_HOME (the tool's environment is an allowlist, so
// settings cannot ride in env vars): used = usage percent, path = the file it writes.
process.env.GOVERNCODE_CODEX_BIN = exe("codex", `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs"), path = require("node:path");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || "", "fake.json"), "utf8")); } catch {}
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
    if (m.result && m.result.decision === "accept") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "ok\\n"); }
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

function setup(gateAnswer: "allow" | "deny" = "allow", fake: object = {}) {
  const proj = project();
  const state = mkdtempSync(join(root, "state-"));
  mkdirSync(join(state, "codex-home"), { recursive: true });
  writeFileSync(join(state, "codex-home", "fake.json"), JSON.stringify(fake));
  const ledger = new Ledger(":memory:");
  const limits = new LimitGate();
  const gates: string[] = [];
  const ctx = { project: { name: "p", path: proj }, ledger, limits,
    usage: { codex: codexUsage({ supervisor, policyDir: join(state, "pol"), stateDir: state, scratch: join(state, "scratch") }) },
    runtimeDir: join(state, "run"), supervisor, policyDir: join(state, "pol"), stateDir: state,
    gate: async (r: { canonical: string }) => { gates.push(r.canonical); return gateAnswer; }, notify: () => {} };
  const sock = openControllerSocket(ctx);
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
  return { proj, state, ledger, gates, call, close: () => { sock.close(); ledger.close(); } };
}

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
  t.close();
});

test("delegate: a Runner inside its Limit is held, and nothing runs", async () => {
  const t = setup("allow", { used: 95 });
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "held");
  assert.match(r.result.reason, /Limit/);
  assert.equal(t.gates.length, 0);
  t.close();
});

test("delegate: a change outside the scope fails the Spec instead of being offered", async () => {
  const t = setup("allow", { path: "src/sneaky.txt" });
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("controller.delegate", SPEC);
  assert.equal(r.result.status, "failed");
  assert.match(r.result.note, /outside its scope: src\/sneaky\.txt/);
  t.close();
});

test("delegate: the controller socket offers nothing else (no Gate answers)", async () => {
  const t = setup();
  await new Promise((r) => setTimeout(r, 50));
  const r = await t.call("gate.answer", { id: "G-1", answer: "allow" });
  assert.match(r.error.message, /not offered to the Controller/);
  t.close();
});
