// The game plan: the Controller posts who does what; the user approves (all or some items),
// answers "just you", or rejects. With the Crew card on "follow the approved plan", an approved
// item lets one handoff to that Runner through without a Gate; anything else still asks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { parsePlan } from "../src/delegate.ts";
import { DEFAULT_CREW } from "../src/crew.ts";
import { scratch } from "./scratch.ts";

test("a plan is checked: 1 to 12 items, 'me' or a Runner, short lines", () => {
  assert.deepEqual(parsePlan({ items: [{ who: "Codex", what: " tests " }] }).items, [{ who: "codex", what: "tests" }]);
  assert.throws(() => parsePlan({ items: [] }), /1 to 12/);
  assert.throws(() => parsePlan({ items: [{ who: "../x", what: "y" }] }), /who must be/);
  assert.throws(() => parsePlan({ items: [{ who: "me", what: "x".repeat(301) }] }), /under 300/);
});

// A Controller that posts a plan, then asks to hand off to each Runner in "handoffs" in turn
// (as Claude Code does: a can_use_tool request for the delegate tool), and reports the answers.
const root = scratch("gc-plan-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);
// The Runners' tools fail at once: a handoff that gets past govd's Gate is then held (no usage).
process.env.GOVERNCODE_CODEX_BIN = exe("codex-fake", "#!/bin/sh\nexit 1\n");
process.env.GOVERNCODE_AGY_BIN = exe("agy-fake", "#!/bin/sh\nexit 1\n");
// A Controller that posts a plan, then calls the delegate tool for each Runner in HANDOFFS, as
// Claude Code does now: straight through GovernCode's MCP server (no permission prompt of its
// own; govd decides the handoff inside the call). It reports each call's outcome.
exe("claude", `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const cfg = JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]).mcpServers.governcode;
const net = require("node:net"), rl = require("node:readline");
const rpc = (method, params) => new Promise((ok) => {
  const s = net.connect(cfg.args[1]);
  rl.createInterface({ input: s }).once("line", (r) => { ok(JSON.parse(r)); s.end(); });
  s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\\n");
});
rl.createInterface({ input: process.stdin }).on("line", async (l) => {
  const m = JSON.parse(l);
  if (m.type !== "user") return;
  const handoffs = JSON.parse(/HANDOFFS=(\\[[^\\]]*\\])/.exec(JSON.stringify(m))[1].replace(/\\\\"/g, '"'));
  const plan = await rpc("controller.plan", { items: [{ who: "codex", what: "write tests" }, { who: "agy", what: "write docs" }] });
  const got = [];
  for (const to of handoffs) {
    const r = await rpc("controller.delegate", { to, brief: "b", result: "r", scope: { read: [], write: ["x"] }, reason: "r" });
    got.push(r.result ? "ok" : /declined/.test(r.error.message) ? "declined" : r.error.message);
  }
  out({ type: "result", is_error: false, result: "plan:" + (plan.result ? plan.result.answer : "error") + "|" + got.join(",") });
  process.exit(0);
});
`);

async function run(crew: object, planReply: Record<string, unknown>, handoffs: string[]) {
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  const dir = join(root, `d-${Math.random().toString(36).slice(2)}`);
  const d = new Daemon({ socketPath: join(dir, "run/govd.sock"), ledgerPath: join(dir, "state/trace.sqlite"),
    policyDir: join(dir, "state/pol"), homeDir: join(dir, "state/home"), supervisor, version: "t" });
  try {
    d.selftest();
    await d.listen();
    const s = connect(join(dir, "run/govd.sock"));
    let id = 0;
    const waiting = new Map<number, (m: any) => void>();
    const gates: string[] = [];
    const call = (method: string, params: unknown = {}) => new Promise<any>((ok) => { const n = ++id; waiting.set(n, ok);
      s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
    createInterface({ input: s }).on("line", (l) => {
      const m = JSON.parse(l);
      if (m.method === "event" && m.params.kind === "plan") void call("plan.answer", { id: m.params.id, ...planReply });
      if (m.method === "event" && m.params.kind === "gate") { gates.push(String(m.params.canonical)); void call("gate.answer", { id: m.params.id, answer: "deny" }); }
      if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); }
    });
    await call("project.new", { name: "p", path: join(dir, "p"), git: false });
    await call("crew.set", { project: "p", crew: { ...DEFAULT_CREW, ...crew } });
    const r = await call("ask", { project: "p", prompt: `go HANDOFFS=${JSON.stringify(handoffs)}` });
    const events = d.ledger.events("p", 200).map((e) => e.kind);
    s.end();
    return { summary: String(r.result?.summary ?? r.error?.message), gates, events };
  } finally {
    d.close();
    process.env.PATH = PATH;
  }
}

test("follow the plan: an approved item lets one handoff through; a second, or an unapproved one, asks", async () => {
  const r = await run({ handoff: "plan" }, { answer: "approve", items: [1] }, ["codex", "codex", "agy"]);
  assert.equal(r.summary, "plan:approve|ok,declined,declined");
  assert.equal(r.gates.length, 2, "the second codex handoff and the agy one asked");
  assert.ok(r.events.includes("plan.proposed") && r.events.includes("plan.answered"));
});

test("'just you': the Controller cannot hand off for the rest of the turn", async () => {
  const r = await run({ handoff: "plan" }, { answer: "just-you" }, ["codex"]);
  assert.match(r.summary, /^plan:just-you\|the user answered your plan with "just you"/);
  assert.equal(r.gates.length, 0, "refused before any Gate");
});

test("ask each time: an approved plan is shown, and every handoff still asks", async () => {
  const r = await run({ handoff: "ask" }, { answer: "approve" }, ["codex"]);
  assert.equal(r.summary, "plan:approve|declined");
  assert.equal(r.gates.length, 1);
});

test("review: an empty selection approves nothing, so the handoff asks", async () => {
  const r = await run({ handoff: "plan" }, { answer: "approve", items: [] }, ["codex"]);
  assert.equal(r.summary, "plan:approve|declined");
  assert.equal(r.gates.length, 1);
});
