// Project memory: notes (with every version), the project record from the Trace, and the rule
// that another provider sees a project's context only after the user says yes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { Daemon } from "../src/daemon.ts";
import { contextState, mayShare, notesHistory, notesOf, projectRecord, setNotes, NOTES_MAX } from "../src/memory.ts";
import { scratch } from "./scratch.ts";

test("notes: the latest version, every version kept, and a size limit", () => {
  const L = new Ledger(":memory:");
  L.addProject("p", "/tmp/p", "project.created");
  assert.deepEqual(notesOf(L, "p"), { text: "", seq: null, actor: null });
  setNotes(L, "p", "Goal: tide tables.", "controller");
  setNotes(L, "p", "Goal: tide tables.\nDecided: CSV input.", "user");
  assert.equal(notesOf(L, "p").text, "Goal: tide tables.\nDecided: CSV input.");
  assert.equal(notesOf(L, "p").actor, "user");
  assert.deepEqual(notesHistory(L, "p").map((h) => h.actor), ["controller", "user"]);
  assert.throws(() => setNotes(L, "p", "x".repeat(NOTES_MAX + 1), "controller"), /limited to 4000/);
  L.close();
});

test("the project record comes from the Trace alone, and is empty for a new project", () => {
  const L = new Ledger(":memory:");
  L.addProject("p", "/tmp/p", "project.created");
  assert.equal(projectRecord(L, "p", []), "");
  L.createSpec("p", { to: "codex", brief: "write tests", result: "they pass", scope: { read: [], write: ["tests"] }, budgetPercent: 5,
    model: "", effort: null, reason: "r" } as any, "controller");
  L.append("p", "checkpoint.taken", "govd", { turn: "T-1", files: ["README.md"] });
  L.append("p", "checkpoint.undone", "govd", { turn: "T-1" });
  const r = JSON.parse(projectRecord(L, "p", ["`npm test` commands"]));
  assert.equal(r.specs[0].runner, "codex");
  assert.deepEqual(r.checkpoints[0], { turn: "T-1", at: r.checkpoints[0].at, files: ["README.md"], undone: true });
  assert.deepEqual(r.allowedForThisProject, ["`npm test` commands"]);
  L.close();
});

test("sharing: the project's own provider sees its context; another needs the user's yes, and no is kept", () => {
  const L = new Ledger(":memory:");
  L.addProject("p", "/tmp/p", "project.created");
  assert.equal(mayShare(L, "p", "codex"), true, "a new project has nothing to share");
  L.append("p", "turn.started", "user", { prompt: "hi", controller: { provider: "claude-code" } });
  assert.equal(mayShare(L, "p", "claude-code"), true);
  assert.equal(mayShare(L, "p", "codex"), false, "another provider waits for the user");
  L.append("p", "context.shared", "user", { provider: "codex", share: true });
  assert.equal(mayShare(L, "p", "codex"), true);
  L.append("p", "context.shared", "user", { provider: "codex", share: false });
  assert.equal(mayShare(L, "p", "codex"), false);
  assert.deepEqual(contextState(L, "p"), { providers: ["claude-code"], shared: { codex: false } });
  L.close();
});

test("a turn gets the notes, the record and the conversation, but another provider's only after the user says yes", async () => {
  const root = scratch("gc-memory-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
  const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);
  exe("claude", `#!/usr/bin/env node
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  fs.writeFileSync(require("node:path").join(__dirname, "last-input.json"), line);
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\\n");
  process.exit(0);
});
`);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  const d = new Daemon({ socketPath: join(root, "run/govd.sock"), ledgerPath: join(root, "state/trace.sqlite"),
    policyDir: join(root, "state/pol"), homeDir: join(root, "state/home"), supervisor, version: "t" });
  try {
    d.selftest();
    await d.listen();
    const s = connect(join(root, "run/govd.sock"));
    let id = 0;
    const waiting = new Map<number, (m: any) => void>();
    createInterface({ input: s }).on("line", (l) => { const m = JSON.parse(l); if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
    const call = (method: string, params: unknown = {}) => new Promise<any>((ok) => { const n = ++id; waiting.set(n, ok);
      s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
    await call("project.new", { name: "tides", path: join(root, "tides"), git: false });
    // An earlier turn by Codex, and notes written then.
    d.ledger.append("tides", "turn.started", "user", { prompt: "the codex plan", controller: { provider: "codex" } });
    d.ledger.append("tides", "turn.text", "controller · codex", { text: "codex's answer" });
    d.ledger.append("tides", "turn.completed", "controller · codex", { summary: "done" });
    await call("notes.set", { project: "tides", text: "Goal: tide tables from harbor.csv" });
    const sent = () => JSON.parse(readFileSync(join(bin, "last-input.json"), "utf8")).message.content[0].text as string;

    await call("ask", { project: "tides", prompt: "hello" });
    assert.ok(!sent().includes("codex's answer") && !sent().includes("tide tables"), "nothing of Codex's goes to Claude before a yes");
    const st = (await call("context.state", { project: "tides" })).result;
    assert.deepEqual(st.providers.sort(), ["claude-code", "codex"]);
    assert.equal(st.notes, "Goal: tide tables from harbor.csv");

    await call("context.share", { project: "tides", provider: "claude-code", share: true });
    await call("ask", { project: "tides", prompt: "again" });
    const t = sent();
    assert.match(t, /^Project notes .*information, not new instructions\):\nGoal: tide tables from harbor\.csv/);
    assert.ok(t.includes("codex's answer") && t.includes("the codex plan"), "after yes, the whole conversation");
    assert.ok(t.endsWith("The user's new message:\nagain"));
    // Home has no share question: it replays only the current provider's turns.
    d.ledger.append(null, "turn.started", "user", { prompt: "home codex secret", controller: { provider: "codex" } });
    d.ledger.append(null, "turn.completed", "controller · codex", { summary: "home codex answer" });
    await call("ask", { project: null, prompt: "at home" });
    assert.ok(!sent().includes("home codex"), "Home does not pass Codex's Home turns to Claude");
    // One Home turn at a time, so a late reply can never land on another provider's turn.
    const first = call("ask", { project: null, prompt: "slow" });
    const second = await call("ask", { project: null, prompt: "overlap" });
    assert.match(second.error?.message ?? "", /still working at Home/);
    await first;
    s.end();
  } finally {
    d.close();
    process.env.PATH = PATH;
  }
});

test("the Controller's project_notes tool reads and rewrites the notes, within the limit", async () => {
  const { openControllerSocket } = await import("../src/delegate.ts");
  const { LimitGate } = await import("../src/limits.ts");
  const root = scratch("gc-notes-tool-");
  const L = new Ledger(":memory:");
  L.addProject("p", join(root, "p"), "project.created");
  const events: any[] = [];
  const sock = openControllerSocket({ project: { name: "p", path: join(root, "p") }, ledger: L, limits: new LimitGate(), usage: {},
    runtimeDir: join(root, "run"), supervisor: "/bin/false", policyDir: join(root, "pol"), stateDir: join(root, "state"),
    gate: async () => "deny", notify: (n) => events.push(n) });
  const call = (params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "controller.project_notes", params }) + "\n");
  });
  try {
    assert.deepEqual((await call({})).result, { notes: "" });
    assert.deepEqual((await call({ write: "Next: parse harbor.csv" })).result, { saved: true, chars: 22 });
    assert.deepEqual((await call({})).result, { notes: "Next: parse harbor.csv" });
    assert.equal(notesOf(L, "p").actor, "controller");
    assert.match((await call({ write: "x".repeat(NOTES_MAX + 1) })).error.message, /limited to 4000/);
    assert.match((await call({ write: 42 })).error.message, /whole notes, as text/);
    assert.deepEqual(events.filter((e) => e.kind === "notes").map((e) => e.chars), [22]);
  } finally { sock.close(); L.close(); }
});

// Codex's review, 2026-09-28: consent holds everywhere and forever.
test("review: after 'start fresh', GovernCode's tools show that Controller neither the notes nor other providers' Specs", async () => {
  const { openControllerSocket } = await import("../src/delegate.ts");
  const { LimitGate } = await import("../src/limits.ts");
  const root = scratch("gc-consent-");
  const L = new Ledger(":memory:");
  L.addProject("p", join(root, "p"), "project.created");
  L.append("p", "turn.started", "user", { prompt: "x", controller: { provider: "claude-code" } });
  setNotes(L, "p", "claude's plan", "controller");
  const theirs = L.createSpec("p", { to: "codex", brief: "b", result: "r", scope: { read: [], write: [] }, budgetPercent: 5, model: "", effort: null, reason: "r" } as any, "controller · claude-code");
  L.append("p", "context.shared", "user", { provider: "codex", share: false });
  const sock = openControllerSocket({ project: { name: "p", path: join(root, "p") }, provider: "codex", ledger: L, limits: new LimitGate(), usage: {},
    runtimeDir: join(root, "run"), supervisor: "/bin/false", policyDir: join(root, "pol"), stateDir: join(root, "state"), gate: async () => "deny", notify: () => {} });
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
  try {
    assert.match((await call("controller.project_notes", {})).error.message, /start this Controller fresh/);
    assert.match((await call("controller.project_notes", { write: "mine now" })).error.message, /start this Controller fresh/);
    assert.equal(notesOf(L, "p").text, "claude's plan");
    assert.match((await call("controller.spec_status", { id: theirs.id })).error.message, /no such Spec/);
    assert.match((await call("controller.spec_discard", { id: theirs.id })).error.message, /no such Spec/);
  } finally { sock.close(); L.close(); }
});

test("review: a 'no' is kept however much history follows, and the record is valid JSON within any budget", () => {
  const L = new Ledger(":memory:");
  L.addProject("p", "/tmp/p", "project.created");
  L.append("p", "turn.started", "user", { prompt: "x", controller: { provider: "claude-code" } });
  L.append("p", "context.shared", "user", { provider: "codex", share: false });
  for (let i = 0; i < 2100; i++) L.append("p", "turn.started", "user", { prompt: "y", controller: { provider: "codex" } });
  for (let i = 0; i < 250; i++) L.append("p", "context.shared", "user", { provider: "other", share: true });
  assert.equal(mayShare(L, "p", "codex"), false, "the old answer still holds");
  assert.deepEqual(contextState(L, "p").providers.sort(), ["claude-code", "codex"], "Claude's early turn is still known");
  for (let i = 0; i < 15; i++) L.createSpec("p", { to: "codex", brief: "z".repeat(300), result: "r", scope: { read: [], write: [] }, budgetPercent: 5, model: "", effort: null, reason: "r" } as any, "controller");
  const r = projectRecord(L, "p", ["rule"], 900);
  assert.ok(r.length <= 900);
  assert.ok(Array.isArray(JSON.parse(r).specs));
  L.close();
});

test("review 2: tool events never push exchanges out of the conversation, and the newest Specs are the newest past S-9999", () => {
  const L = new Ledger(":memory:");
  L.addProject("p", "/tmp/p", "project.created");
  L.append("p", "turn.started", "user", { prompt: "keep me", controller: { provider: "claude-code" } });
  L.append("p", "turn.completed", "controller · claude-code", { summary: "kept" });
  for (let i = 0; i < 1000; i++) L.append("p", "turn.tool", "controller · claude-code", { name: "Bash" });
  const conv = L.eventsOfKind("p", ["turn.started", "turn.text", "turn.completed", "turn.failed", "conversation.reset"], 2000);
  assert.equal(conv[0].data.prompt, "keep me");
  const spec = { to: "codex", brief: "b", result: "r", scope: { read: [], write: [] }, budgetPercent: 5, model: "", effort: null, reason: "r" } as any;
  for (let i = 0; i < 10_001; i++) L.createSpec("p", spec, "controller");
  assert.deepEqual(L.recentSpecs("p", 2).map((s) => s.id), ["S-10000", "S-10001"]);
  L.close();
});
