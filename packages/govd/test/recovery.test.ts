// Usage-limit recovery (#226), through govd with fake Claude Code and Codex processes. Recovery
// choices live in the Trace, so the same tests cover the RPC surface, unattended sweeps and restart.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { scratch, markConnected } from "./scratch.ts";

process.env.GOVERNCODE_RECOVERY_SWEEP_MS = "40";
const { Daemon } = await import("../src/daemon.ts");

const root = scratch("gc-recovery-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
const supervisor = exe("govern-sup", `#!/bin/sh
[ "$1" = selftest ] && exit 0
cp "$3" "${root}/last-policy-$(basename "$5").json"
shift 4
exec "$@"
`);

// Each Codex process reads the current fake.json. Tests can therefore cross a Limit, change the
// live reading, and prove the resumed round measured again. A limited round writes first so its
// continuation can prove that it kept the same copy and the original before-snapshot.
process.env.GOVERNCODE_CODEX_BIN = exe("codex", `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || "", "..", "..", "fake.json"), "utf8")); } catch {}
const limits = (used = Number(cfg.used ?? 10)) => ({ primary: { usedPercent: used, windowDurationMins: 10080,
  ...(typeof cfg.resetsAt === "number" ? { resetsAt: cfg.resetsAt } : {}) } });
const write = () => {
  fs.mkdirSync("x", { recursive: true });
  const file = path.join("x", "hello.txt");
  const text = cfg.fromReadme ? fs.readFileSync("README.md", "utf8") : String(cfg.text ?? "ok\\n");
  if (cfg.append && fs.existsSync(file)) fs.appendFileSync(file, text); else fs.writeFileSync(file, text);
};
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return out({ id: m.id, result: {} });
  if (m.method === "account/rateLimits/read") return setTimeout(() => out({ id: m.id, result: { rateLimits: limits() } }), Number(cfg.readDelay ?? 0));
  if (m.method === "thread/start") return out({ id: m.id, result: { thread: { id: "thread" } } });
  if (m.method !== "turn/start") return;
  out({ id: m.id, result: {} });
  const prompt = m.params?.input?.[0]?.text || "";
  if (cfg.promptFile) fs.writeFileSync(cfg.promptFile, prompt);
  write();
  out({ method: "item/completed", params: { item: { id: "message", type: "agentMessage", text: String(cfg.summary ?? "worked") } } });
  if (cfg.limitRun) {
    out({ method: "account/rateLimits/updated", params: { rateLimits: limits(Number(cfg.limitUsed ?? 100)) } });
    out({ method: "error", params: { error: { message: "limited", codexErrorInfo: { usageLimitExceeded: {} } }, willRetry: false,
      turnId: "turn", threadId: "thread" } });
    return out({ method: "turn/completed", params: { turn: { status: "failed" } } });
  }
  out({ method: "turn/completed", params: { turn: { status: "completed" } } });
});
`);

// The Controller hands off on HANDOFF. A project-local test control makes its own turn hit a
// provider Limit; removing it lets a user or unattended continuation finish normally.
exe("claude", `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), net = require("node:net"), readline = require("node:readline");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const result = (text) => { out({ type: "result", is_error: false, result: text }); process.exit(0); };
const fresh = (text) => { const k = text.lastIndexOf("The user's new message:"); return k < 0 ? text : text.slice(k); };
const rpc = (method, params) => new Promise((ok) => {
  const cfg = JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]).mcpServers.governcode;
  const sock = net.connect(cfg.args[1]);
  readline.createInterface({ input: sock }).once("line", (line) => { ok(JSON.parse(line)); sock.end(); });
  sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\\n");
});
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type !== "user") return;
  const text = JSON.parse(JSON.stringify(message.message.content)).map((part) => part.text || "").join("");
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".fake-controller.json"), "utf8")); } catch {}
  if (cfg.limit) {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour",
      ...(typeof cfg.resetsAt === "number" ? { resetsAt: cfg.resetsAt } : {}) } });
    out({ type: "result", is_error: true, subtype: "error", terminal_reason: "blocking_limit", result: "stopped" });
    return process.exit(0);
  }
  if (fresh(text).includes("HANDOFF")) {
    const r = await rpc("controller.delegate", { to: "codex", brief: "write the file", result: "x/hello.txt is complete",
      scope: { read: ["README.md"], write: ["x"] }, budgetPercent: 5, model: "gpt-test", effort: "low", reason: "the Runner should do it" });
    return result(r.result ? "spec:" + r.result.id + ":" + r.result.status : "error:" + r.error.message);
  }
  result("continued");
});
`);
process.env.PATH = `${bin}:${process.env.PATH}`;

const opened: Array<() => void> = [];
afterEach(() => { while (opened.length) { try { opened.pop()!(); } catch { /* already closed */ } } });

function client(sock: string) {
  const socket = connect(sock);
  opened.push(() => socket.destroy());
  let seq = 0;
  const waiting = new Map<number, (message: any) => void>();
  const events: any[] = [];
  const call = (method: string, params: unknown = {}) => new Promise<any>((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  createInterface({ input: socket }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "event") {
      events.push(message.params);
      if (message.params.kind === "gate" && /governcode delegate/.test(message.params.tool)) {
        void call("gate.answer", { id: message.params.id, answer: "allow" });
      }
      return;
    }
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  return { call, events, end: () => socket.end() };
}

type Fake = { used?: number; limitUsed?: number; resetsAt?: number; limitRun?: boolean; text?: string; append?: boolean; fromReadme?: boolean;
  summary?: string; promptFile?: string; readDelay?: number };

function fakeFile(dir: string): string { return join(dir, "state/tools/codex/fake.json"); }
function setRunner(dir: string, fake: Fake): void { writeFileSync(fakeFile(dir), JSON.stringify(fake)); }
function setController(dir: string, fake: { limit?: boolean; resetsAt?: number }): void {
  writeFileSync(join(dir, "proj/.fake-controller.json"), JSON.stringify(fake));
}

async function setup(fake: Fake = {}, dir = join(root, `d-${Math.random().toString(36).slice(2)}`)) {
  const d = new Daemon({ socketPath: join(dir, "run/govd.sock"), ledgerPath: join(dir, "state/trace.sqlite"),
    policyDir: join(dir, "state/policies"), homeDir: join(dir, "state/home"), supervisor, version: "test" });
  markConnected(d);
  setRunner(dir, fake);
  opened.push(() => d.close());
  d.selftest();
  await d.listen();
  const c = client(join(dir, "run/govd.sock"));
  const proj = join(dir, "proj");
  if (!d.ledger.project("p")) {
    await c.call("project.new", { name: "p", path: proj, git: true });
    writeFileSync(join(proj, "README.md"), "# original\n");
    execFileSync("git", ["-C", proj, "add", "-A"]);
    execFileSync("git", ["-C", proj, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]);
  }
  return { d, c, dir, proj, sock: join(dir, "run/govd.sock") };
}

const until = async (condition: () => boolean, ms = 15_000) => {
  for (const end = Date.now() + ms; !condition(); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error("timed out");
  }
};

async function handoff(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const response = await t.c.call("ask", { project: "p", prompt: "HANDOFF" });
  assert.ok(response.result, JSON.stringify(response));
  const id = /S-\d{4,}/.exec(response.result.summary)?.[0];
  assert.ok(id, JSON.stringify(response));
  return id;
}

async function recoveries(t: Awaited<ReturnType<typeof setup>>) {
  const response = await t.c.call("recovery.list", { project: "p" });
  assert.ok(response.result, JSON.stringify(response));
  return response.result.items as any[];
}

test("a held Spec is listed with its reset, and clearing only removes the recovery item", async () => {
  const reset = Math.floor((Date.now() + 60_000) / 1000);
  const t = await setup({ used: 100, resetsAt: reset });
  const id = await handoff(t);
  const [item] = await recoveries(t);
  assert.deepEqual({ target: item.target, project: item.project, kind: item.kind, provider: item.provider, resetsAt: item.resetsAt,
    atReset: item.atReset, due: item.due },
  { target: id, project: "p", kind: "held", provider: "codex", resetsAt: new Date(reset * 1000).toISOString(), atReset: false, due: false });
  assert.equal(t.d.ledger.spec(id)!.status, "held");
  assert.equal((await t.c.call("recovery.clear", { target: id })).result.target, id);
  assert.deepEqual(await recoveries(t), []);
  assert.equal(t.d.ledger.spec(id)!.status, "held", "clear does not discard the Spec");
});

test("resume now measures again, uses a fresh project copy, and records resumed before started", async () => {
  const t = await setup({ used: 100, resetsAt: Math.floor((Date.now() + 60_000) / 1000) });
  const id = await handoff(t);
  writeFileSync(join(t.proj, "README.md"), "# changed after the hold\n");
  setRunner(t.dir, { used: 10, fromReadme: true });
  const response = await t.c.call("recovery.resume", { id });
  assert.equal(response.result.id, id, JSON.stringify(response));
  await until(() => t.d.ledger.spec(id)?.status === "needs-review");
  assert.match((await t.c.call("spec.diff", { id })).result.diff, /changed after the hold/);
  const events = t.d.ledger.eventsOfKind("p", ["recovery.resumed", "spec.started"]);
  assert.equal(events.filter((event) => event.kind === "recovery.resumed").length, 1);
  assert.ok(events.find((event) => event.kind === "recovery.resumed")!.seq < events.find((event) => event.kind === "spec.started")!.seq);
  assert.equal(t.d.ledger.spec(id)!.limited, undefined);
});

test("two resume-now calls racing on measurement start only one round", async () => {
  const t = await setup({ used: 100, resetsAt: Math.floor((Date.now() + 60_000) / 1000) });
  const id = await handoff(t);
  setRunner(t.dir, { used: 10, readDelay: 200 });
  const replies = await Promise.all([t.c.call("recovery.resume", { id }), t.c.call("recovery.resume", { id })]);
  assert.equal(replies.filter((reply) => reply.result).length, 1, JSON.stringify(replies));
  assert.match(replies.find((reply) => reply.error)!.error.message, /already running|not a limited Spec/);
  await until(() => t.d.ledger.spec(id)?.status === "needs-review");
  assert.equal(t.d.ledger.eventsOfKind("p", ["spec.started"]).length, 1);
});

test("resume now that is still over the Limit stays held without running", async () => {
  const t = await setup({ used: 100, resetsAt: Math.floor((Date.now() + 60_000) / 1000) });
  const id = await handoff(t);
  const response = await t.c.call("recovery.resume", { id });
  assert.equal(response.result.id, id, JSON.stringify(response));
  assert.equal(t.d.ledger.spec(id)!.status, "held");
  assert.equal(t.d.ledger.eventsOfKind("p", ["recovery.resumed"]).length, 1);
  assert.equal(t.d.ledger.eventsOfKind("p", ["spec.started"]).length, 0);
  assert.equal(t.d.ledger.eventsOfKind("p", ["spec.held"]).length, 2, "the fresh Limit decision is recorded");
});

test("at-reset recovery waits for a watcher, then a due Spec resumes", async () => {
  const past = Math.floor((Date.now() - 60_000) / 1000);
  const t = await setup({ used: 100, resetsAt: past });
  const id = await handoff(t);
  assert.equal((await t.c.call("recovery.set", { target: id, atReset: true })).result.target, id);
  setRunner(t.dir, { used: 10 });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(t.d.ledger.spec(id)!.status, "held", "an ordinary connected client does not permit unattended work");
  await t.c.call("watch", { wake: true });
  await until(() => t.d.ledger.spec(id)?.status === "needs-review");
  assert.equal(t.d.ledger.eventsOfKind("p", ["recovery.resumed"]).at(-1)!.actor, "govd");
});

test("auto-resume arms a newly held Spec, but an unknown reset can only resume now", async () => {
  const reset = Math.floor((Date.now() + 60_000) / 1000);
  const t = await setup({ used: 100, resetsAt: reset });
  await t.c.call("settings.set", { recovery: { autoResume: true } });
  const armed = await handoff(t);
  assert.equal((await recoveries(t)).find((item) => item.target === armed).atReset, true);
  const set = t.d.ledger.eventsOfKind("p", ["recovery.set"]).at(-1)!;
  assert.equal(set.actor, "govd");
  assert.deepEqual(set.data, { target: armed, resetsAt: new Date(reset * 1000).toISOString(), atReset: true });

  setRunner(t.dir, { used: 100 });
  const unknown = await handoff(t);
  const refused = await t.c.call("recovery.set", { target: unknown, atReset: true });
  assert.equal(refused.error.message, `no reset time is known for ${unknown}: resume it yourself`);
  setRunner(t.dir, { used: 10 });
  assert.equal((await t.c.call("recovery.resume", { id: unknown })).result.id, unknown);
  await until(() => t.d.ledger.spec(unknown)?.status === "needs-review");
});

test("a changed handoff blocks automatic recovery, while resume now uses the new values", async () => {
  const past = Math.floor((Date.now() - 60_000) / 1000);
  const t = await setup({ used: 100, resetsAt: past });
  const id = await handoff(t);
  await t.c.call("recovery.set", { target: id, atReset: true });
  await t.c.call("settings.set", { runners: { codex: { model: "gpt-new", effort: "medium" } }, specModels: "defaults" });
  setRunner(t.dir, { used: 10 });
  await t.c.call("watch", { wake: true });
  let item: any;
  for (const end = Date.now() + 3000; Date.now() < end;) {
    item = (await recoveries(t)).find((candidate) => candidate.target === id);
    if (item?.note) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(item?.note, "the handoff changed: resume it yourself to run it as it is now");
  assert.equal(t.d.ledger.spec(id)!.status, "held");
  assert.equal((await t.c.call("recovery.resume", { id })).result.id, id);
  await until(() => t.d.ledger.spec(id)?.status === "needs-review");
  assert.deepEqual({ model: t.d.ledger.spec(id)!.model, effort: t.d.ledger.spec(id)!.effort }, { model: "gpt-new", effort: "medium" });
});

test("a resumed guard prevents the sweep from starting the same Spec twice", async () => {
  const past = Math.floor((Date.now() - 60_000) / 1000);
  const t = await setup({ used: 100, resetsAt: past });
  const id = await handoff(t);
  await t.c.call("recovery.set", { target: id, atReset: true });
  const resetsAt = t.d.ledger.spec(id)!.limited!.resetsAt;
  t.d.ledger.append("p", "recovery.resumed", "govd", { target: id, resetsAt, by: "govd" });
  setRunner(t.dir, { used: 10 });
  await t.c.call("watch", { wake: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(t.d.ledger.spec(id)!.status, "held");
  assert.equal(t.d.ledger.eventsOfKind("p", ["recovery.resumed"]).length, 1);
  assert.equal(t.d.ledger.eventsOfKind("p", ["spec.started"]).length, 0);
  assert.equal((await recoveries(t)).find((item) => item.target === id)?.note, "already resumed for this at-reset choice");
});

test("a Runner-limited Spec continues in its existing copy and keeps both rounds in the diff", async () => {
  const reset = Math.floor((Date.now() + 60_000) / 1000);
  const promptFile = join(root, `prompt-${Math.random().toString(36).slice(2)}`);
  const t = await setup({ used: 10, resetsAt: reset, limitRun: true, text: "first\n", summary: "first round" });
  const id = await handoff(t);
  await until(() => t.d.ledger.spec(id)?.status === "failed");
  assert.equal(t.d.ledger.spec(id)!.limited?.resetsAt, new Date(reset * 1000).toISOString());
  const before = t.d.ledger.spec(id)!.checkpoints.before;
  await t.c.call("recovery.set", { target: id, atReset: true });
  setRunner(t.dir, { used: 100, resetsAt: reset });
  assert.equal((await t.c.call("recovery.resume", { id })).result.status, "failed");
  const renewed = (await recoveries(t)).find((item) => item.target === id);
  assert.equal(renewed.atReset, false, "the old at-reset choice does not carry into the renewed limit");
  setRunner(t.dir, { used: 10, append: true, text: "second\n", summary: "second round", promptFile });
  assert.equal((await t.c.call("recovery.resume", { id })).result.id, id);
  await until(() => t.d.ledger.spec(id)?.status === "needs-review");
  const spec = t.d.ledger.spec(id)!;
  assert.equal(spec.checkpoints.before, before, "the continuation keeps the first round's before-snapshot");
  const diff = (await t.c.call("spec.diff", { id })).result.diff;
  assert.match(diff, /first/);
  assert.match(diff, /second/);
  assert.match(readFileSync(promptFile, "utf8"), /stopped because codex hit its usage limit/i);
  const events = t.d.ledger.eventsOfKind("p", ["recovery.resumed", "spec.started"]);
  assert.ok(events.find((event) => event.kind === "recovery.resumed")!.seq < events.filter((event) => event.kind === "spec.started").at(-1)!.seq);
});

test("a limited Controller turn is listed and can be continued by the user", async () => {
  const reset = Math.floor((Date.now() + 60_000) / 1000);
  const t = await setup();
  setController(t.dir, { limit: true, resetsAt: reset });
  const response = await t.c.call("ask", { project: "p", prompt: "do the work" });
  assert.equal(response.result.ok, false, JSON.stringify(response));
  const failed = t.d.ledger.eventsOfKind("p", ["turn.failed"]).at(-1)!;
  const target = failed.data.turn as string;
  assert.match(target, /^T-\d+$/);
  assert.deepEqual(failed.data.limit, { provider: "claude-code", resetsAt: new Date(reset * 1000).toISOString() });
  assert.equal((await recoveries(t))[0].target, target);
  assert.ok(t.c.events.some((event) => event.kind === "text" && new RegExp(`Continue later with gov resume ${target}`).test(event.text)));
  setController(t.dir, {});
  const continued = await t.c.call("ask", { project: "p", prompt: "Continue where you left off.", continuationOf: target });
  assert.equal(continued.result.summary, "continued", JSON.stringify(continued));
  const started = t.d.ledger.eventsOfKind("p", ["turn.started"]).at(-1)!;
  assert.equal(started.data.continuationOf, target);
  assert.equal(started.actor, "user");
});

test("auto-resume arms a newly limited Controller turn", async () => {
  const reset = Math.floor((Date.now() + 60_000) / 1000);
  const t = await setup();
  await t.c.call("settings.set", { recovery: { autoResume: true } });
  setController(t.dir, { limit: true, resetsAt: reset });
  await t.c.call("ask", { project: "p", prompt: "limited work" });
  const failed = t.d.ledger.eventsOfKind("p", ["turn.failed"]).at(-1)!;
  const target = failed.data.turn as string;
  const item = (await recoveries(t)).find((candidate) => candidate.target === target);
  assert.equal(item.atReset, true);
  const armed = t.d.ledger.eventsOfKind("p", ["recovery.set"]).at(-1)!;
  assert.equal(armed.actor, "govd");
  assert.deepEqual(armed.data, { target, resetsAt: new Date(reset * 1000).toISOString(), atReset: true });
});

test("a reset or a newer turn makes a limited Controller turn stale", async () => {
  const t = await setup();
  setController(t.dir, { limit: true, resetsAt: Math.floor((Date.now() + 60_000) / 1000) });
  await t.c.call("ask", { project: "p", prompt: "first limited turn" });
  const first = t.d.ledger.eventsOfKind("p", ["turn.failed"]).at(-1)!.data.turn as string;
  await t.c.call("conversation.reset", { project: "p" });
  assert.deepEqual(await recoveries(t), []);
  assert.equal((await t.c.call("ask", { project: "p", prompt: "continue", continuationOf: first })).error.message,
    `${first} can no longer be continued: a newer message, a reset or a Controller change came after it`);

  await t.c.call("ask", { project: "p", prompt: "second limited turn" });
  const second = t.d.ledger.eventsOfKind("p", ["turn.failed"]).at(-1)!.data.turn as string;
  setController(t.dir, {});
  await t.c.call("ask", { project: "p", prompt: "a newer message" });
  assert.deepEqual(await recoveries(t), []);
  assert.equal((await t.c.call("ask", { project: "p", prompt: "continue", continuationOf: second })).error.message,
    `${second} can no longer be continued: a newer message, a reset or a Controller change came after it`);
});

test("a due Controller continuation is govd's, runs only with a watcher, and is not read-only", async () => {
  const past = Math.floor((Date.now() - 60_000) / 1000);
  const t = await setup();
  setController(t.dir, { limit: true, resetsAt: past });
  await t.c.call("ask", { project: "p", prompt: "limited work" });
  const target = t.d.ledger.eventsOfKind("p", ["turn.failed"]).at(-1)!.data.turn as string;
  await t.c.call("recovery.set", { target, atReset: true });
  setController(t.dir, {});
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(t.d.ledger.eventsOfKind("p", ["turn.started"]).length, 1);
  await t.c.call("watch", { wake: true });
  await until(() => t.d.ledger.eventsOfKind("p", ["turn.completed"]).length === 1);
  const continuation = t.d.ledger.eventsOfKind("p", ["turn.started"]).at(-1)!;
  assert.equal(continuation.actor, "govd");
  assert.equal(continuation.data.origin, "continuation");
  assert.equal(continuation.data.continuationOf, target);
  assert.ok(t.d.ledger.eventsOfKind("p", ["recovery.resumed"]).at(-1)!.seq < continuation.seq);
  const policy = JSON.parse(readFileSync(join(root, "last-policy-claude.json"), "utf8"));
  assert.ok(policy.write.includes(t.proj), "an automatic continuation has the usual Controller write access");
});

test("a due recovery choice survives restart and runs once when a watcher connects", async () => {
  const dir = join(root, "restart");
  const first = await setup({ used: 100, resetsAt: Math.floor((Date.now() - 60_000) / 1000) }, dir);
  const id = await handoff(first);
  await first.c.call("recovery.set", { target: id, atReset: true });
  setRunner(dir, { used: 10 });
  first.c.end();
  first.d.close();

  const second = await setup({ used: 10 }, dir);
  assert.equal(second.d.ledger.spec(id)!.status, "held");
  await second.c.call("watch", { wake: true });
  await until(() => second.d.ledger.spec(id)?.status === "needs-review");
  assert.equal(second.d.ledger.eventsOfKind("p", ["recovery.resumed"]).length, 1);
  assert.equal(second.d.ledger.eventsOfKind("p", ["spec.started"]).length, 1);
  assert.ok(existsSync(join(dir, `state/specs/${id}/work/x/hello.txt`)));
});
