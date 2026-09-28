// The Crew card: set by the user, enforced by govd (not asked of the AI).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { LimitGate } from "../src/limits.ts";
import { Daemon } from "../src/daemon.ts";
import { crewBrief, crewOf, runnerAllowed, setCrew, DEFAULT_CREW } from "../src/crew.ts";
import { openControllerSocket } from "../src/delegate.ts";
import { scratch, markConnected } from "./scratch.ts";

test("crew card: defaults, the latest setting wins, and what the Controller is told", () => {
  const L = new Ledger(":memory:");
  L.addProject("p", "/tmp/p", "project.created");
  assert.deepEqual(crewOf(L, "p"), DEFAULT_CREW);
  assert.deepEqual(DEFAULT_CREW, { controllerWorks: true, handoff: "ask", runners: null, maxPercent: {}, subagents: { controller: true, runners: true } });
  setCrew(L, "p", { ...DEFAULT_CREW, controllerWorks: false, handoff: "off" });
  assert.equal(crewOf(L, "p").handoff, "off");
  assert.match(crewBrief(crewOf(L, "p")), /plan and hand off only.*Handing off is off/);
  assert.match(runnerAllowed({ ...DEFAULT_CREW, runners: ["agy"] }, "codex")!, /allows only: agy/);
  assert.equal(runnerAllowed(DEFAULT_CREW, "codex"), null);
  L.close();
});

function socketFor(L: Ledger, root: string, crew: () => any) {
  const usage = { codex: { provider: "codex", read: async () => ({ provider: "codex", measuredAt: Date.now(), readings: [{ window: "weekly", usedPercent: 5, resetsAt: null }] }) },
    agy: { provider: "agy", read: async () => ({ provider: "agy", measuredAt: Date.now(), readings: [{ window: "weekly", usedPercent: 5, resetsAt: null }] }) } };
  const sock = openControllerSocket({ project: { name: "p", path: join(root, "p") }, provider: "claude-code", crew, ledger: L, limits: new LimitGate(), usage,
    runtimeDir: join(root, "run"), supervisor: "/bin/false", policyDir: join(root, "pol"), stateDir: join(root, "state"),
    gate: async (r: { tool: string }) => (r.tool === "governcode delegate" ? "allow" : "deny"), notify: () => {} });
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
  return { sock, call };
}
const SPEC = { to: "codex", brief: "b", result: "r", scope: { read: [], write: ["x"] }, budgetPercent: 20, model: "", effort: null, reason: "r" };

test("crew card: handing off off, and Runners not on the card, are refused before anything runs; crew lists only the card's", async () => {
  const root = scratch("gc-crew-");
  const L = new Ledger(":memory:");
  L.addProject("p", join(root, "p"), "project.created");
  let card: any = { ...DEFAULT_CREW, handoff: "off" };
  const { sock, call } = socketFor(L, root, () => card);
  try {
    assert.match((await call("controller.delegate", SPEC)).error.message, /handing off off/);
    assert.deepEqual((await call("controller.crew", {})).result.runners, []);
    card = { ...DEFAULT_CREW, runners: ["agy"] };
    assert.match((await call("controller.delegate", SPEC)).error.message, /allows only: agy/);
    assert.deepEqual((await call("controller.crew", {})).result.runners.map((r: any) => r.provider), ["agy"]);
    assert.equal(L.specs("p").length, 0, "no Spec was even created");
  } finally { sock.close(); L.close(); }
});

test("crew card: a Spec reserves at most the card's cap for its Runner", async () => {
  const root = scratch("gc-crew-cap-");
  const L = new Ledger(":memory:");
  L.addProject("p", join(root, "p"), "project.created");
  const { sock, call } = socketFor(L, root, () => ({ ...DEFAULT_CREW, maxPercent: { codex: 7 } }));
  try {
    await call("controller.delegate", SPEC);   // fails later (no commit, no codex); the Spec is recorded first
    assert.equal(L.specs("p")[0].budgetPercent, 7);
  } finally { sock.close(); L.close(); }
});

test("crew card: 'plans only' makes the project read-only for the Controller, and 'no subagents' removes Claude's subagent tool", async () => {
  const root = scratch("gc-crew-turn-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
  // The fake supervisor keeps a copy of the policy it was given.
  const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\ncp "$3" "${join(bin, "last-policy.json")}"\nshift 4\nexec "$@"\n`);
  exe("claude", `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(path.join(__dirname, "last-args.json"), JSON.stringify(process.argv.slice(2)));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  fs.writeFileSync(path.join(__dirname, "last-input.json"), line);
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "ok" }) + "\\n");
  process.exit(0);
});
`);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  const d = new Daemon({ socketPath: join(root, "run/govd.sock"), ledgerPath: join(root, "state/trace.sqlite"),
    policyDir: join(root, "state/pol"), homeDir: join(root, "state/home"), supervisor, version: "t" });
  markConnected(d);
  try {
    d.selftest();
    await d.listen();
    const s = connect(join(root, "run/govd.sock"));
    let id = 0;
    const waiting = new Map<number, (m: any) => void>();
    createInterface({ input: s }).on("line", (l) => { const m = JSON.parse(l); if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
    const call = (method: string, params: unknown = {}) => new Promise<any>((ok) => { const n = ++id; waiting.set(n, ok);
      s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
    const proj = join(root, "p");
    await call("project.new", { name: "p", path: proj, git: false });
    await call("ask", { project: "p", prompt: "one" });
    const args = () => JSON.parse(readFileSync(join(bin, "last-args.json"), "utf8")) as string[];
    const policy = () => JSON.parse(readFileSync(join(bin, "last-policy.json"), "utf8"));
    assert.ok(!args().includes("--disallowedTools"));
    assert.ok(policy().write.includes(proj), "by default the Controller may write the project");

    const r = await call("crew.set", { project: "p", crew: { ...DEFAULT_CREW, controllerWorks: false, subagents: { controller: false, runners: true } } });
    assert.equal(r.result.crew.controllerWorks, false);
    await call("ask", { project: "p", prompt: "two" });
    assert.deepEqual(args().slice(args().indexOf("--disallowedTools"), args().indexOf("--disallowedTools") + 2), ["--disallowedTools", "Task,Agent"]);
    assert.ok(!policy().write.includes(proj), "plans only: the project is not writable");
    assert.ok(policy().read.includes(proj), "but still readable");
    const sent = JSON.parse(readFileSync(join(bin, "last-input.json"), "utf8")).message.content[0].text as string;
    assert.match(sent, /The Crew card .* plan and hand off only/);
    assert.equal((await call("crew.get", { project: "p" })).result.crew.subagents.controller, false);
    assert.match((await call("crew.set", { project: "p", crew: { ...DEFAULT_CREW, maxPercent: { codex: 90 } } })).error.message, /25|less than or equal/i);
    s.end();
  } finally {
    d.close();
    process.env.PATH = PATH;
  }
});

test("review: a closed turn socket refuses new connections and requests; another AI program from a command always asks", async () => {
  const { openTurnSocket } = await import("../src/delegate.ts");
  const { analyze } = await import("../src/allows.ts");
  const root = scratch("gc-crew-closed-");
  const sock = openTurnSocket(join(root, "run"), async () => ({ ok: true }));
  const s = connect(sock.path);
  await new Promise((r) => s.once("connect", r));
  const closedEarly = new Promise((r) => s.once("close", r));
  sock.close();
  await closedEarly;   // an open connection is dropped when the turn ends
  const again = connect(sock.path);
  assert.equal(await new Promise((ok) => { again.once("error", () => ok("refused")); again.once("connect", () => ok("connected")); }), "refused");
  for (const cmd of ["codex exec hi", "claude -p hi", "agy -p hi", "gemini", "ollama run qwen", "aider"]) {
    assert.equal(analyze({ tool: "Bash", input: { command: cmd } }).ask, true, cmd);
  }
});

test("board review: a turn cut off by govd stopping is closed on the record at the next start", async () => {
  const root = scratch("gc-crew-interrupted-");
  const opts = { socketPath: join(root, "run/govd.sock"), ledgerPath: join(root, "state/trace.sqlite"),
    policyDir: join(root, "state/pol"), homeDir: join(root, "state/home"), supervisor: "/bin/true", version: "t" };
  const d1 = new Daemon(opts);
  markConnected(d1);
  d1.ledger.addProject("p", join(root, "p"), "project.created");
  d1.ledger.append("p", "turn.started", "user", { prompt: "x", controller: { provider: "claude-code" } });
  d1.close();
  const d2 = new Daemon(opts);
  markConnected(d2);
  try {
    await d2.listen();
    const last = d2.ledger.eventsOfKind("p", ["turn.started", "turn.completed", "turn.failed"], 1).at(-1)!;
    assert.equal(last.kind, "turn.failed");
    assert.equal(last.data.summary, "govd stopped during this turn");
    assert.equal(d2.ledger.eventsOfKind("p", ["turn.started", "turn.completed", "turn.failed"], 10).filter((e) => e.kind === "turn.failed").length, 1);
  } finally { d2.close(); }
});
