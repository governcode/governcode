// gov against a scripted govd (or none at all): what it asks, sends and prints. No real daemon,
// no AI tool; stdin is closed unless a test gives input.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const gov = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gc-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "");

type Notify = (e: unknown) => void;

/** A govd that answers each call from `handle` (undefined: {}; a throw: an error) and records them. */
async function fakeGovd(handle: (method: string, params: any, notify: Notify) => unknown = () => ({})) {
  const dir = mkdtempSync(join(root, "run-"));
  const calls: Array<{ method: string; params: any }> = [];
  const server = createServer((s) => {
    const send = (o: unknown) => s.writable && s.write(JSON.stringify(o) + "\n");
    createInterface({ input: s }).on("line", async (l) => {
      const m = JSON.parse(l);
      calls.push({ method: m.method, params: m.params });
      try { send({ jsonrpc: "2.0", id: m.id, result: (await handle(m.method, m.params, (e) => send({ jsonrpc: "2.0", method: "event", params: e }))) ?? {} }); }
      catch (e) { send({ jsonrpc: "2.0", id: m.id, error: { code: 1001, message: (e as Error).message } }); }
    });
  });
  await new Promise<void>((ok) => server.listen(join(dir, "govd.sock"), ok));
  after(() => server.close());
  return { dir, calls, methods: () => calls.map((c) => c.method) };
}

/** gov with stdin closed (or fed `input`, or left open for the test to type into: `live`), against
 *  the govd whose runtime folder is `dir`. The user's git config stays out of it (gov demo commits). */
function run(dir: string, args: string[], o: { cwd?: string; input?: string; live?: boolean } = {}) {
  const p = spawn(process.execPath, [gov, ...args], { cwd: o.cwd ?? root,
    env: { ...process.env, GOVERNCODE_RUNTIME_DIR: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: [o.input === undefined && !o.live ? "ignore" : "pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  p.stdout!.on("data", (d) => (stdout += d));
  p.stderr!.on("data", (d) => (stderr += d));
  if (o.input !== undefined) p.stdin!.end(o.input);
  return { p, out: () => plain(stdout),
    done: new Promise<{ code: number | null; stdout: string; stderr: string }>((ok) => p.on("close", (code) => ok({ code, stdout: plain(stdout), stderr: plain(stderr) }))) };
}

async function until(f: () => boolean, ms = 10_000) {
  for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f(), "timed out");
}

test("gov help, --help and -h print the usage on stdout and need no govd; an unknown command gets it on stderr", async () => {
  const none = mkdtempSync(join(root, "none-"));   // no govd listens here
  for (const h of ["help", "--help", "-h"]) {
    const r = await run(none, [h]).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^usage: gov /);
    for (const part of ["open [PATH [NAME]]", "controller claude-code|codex [--model M]", "connect [agy|claude|codex|grok]", "disconnect agy|claude|codex|grok"]) {
      assert.ok(r.stdout.includes(part), part);
    }
  }
  const down = await run(none, ["status"]).done;
  assert.equal(down.code, 1);
  assert.match(down.stderr, /govd is not running .*Start it with: gov daemon start \(or run govd in another terminal\)/);
  const g = await fakeGovd();
  const bad = await run(g.dir, ["frobnicate"]).done;
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /^usage: gov /);
});

test("gov disconnect grok is accepted", async () => {
  const g = await fakeGovd((m, p) => (m === "tools.disconnect" ? { note: `${p.tool} is disconnected` } : {}));
  const r = await run(g.dir, ["disconnect", "grok"]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(g.calls.at(-1), { method: "tools.disconnect", params: { tool: "grok" } });
  assert.match(r.stdout, /grok is disconnected/);
  assert.match((await run(g.dir, ["disconnect", "gemini"]).done).stderr, /usage: gov disconnect agy\|claude\|codex\|grok/);
});

/** A govd with one project, p, in a fresh folder (gov runs inside it). */
async function withProject(handle: (method: string, params: any, notify: Notify) => unknown = () => undefined,
    controller = { provider: "claude-code", model: "opus", effort: "high" }) {
  const path = mkdtempSync(join(root, "proj-"));
  const g = await fakeGovd((m, p, n) => handle(m, p, n) ?? (m === "project.list" ? { projects: [{ name: "p", path, controller }] } : {}));
  return { ...g, path };
}

test("gov controller checks the provider before anything is asked or recorded; claude means claude-code; each provider has its own defaults", async () => {
  let providers = ["claude-code"];
  const g = await withProject((m) => (m === "context.state" ? { providers, shared: {}, notes: "", specs: 0, checkpoints: 0 } : undefined));
  for (const bad of [["grok"], [], ["codex", "--effort", "extreme"], ["codex", "--model"]]) {
    const r = await run(g.dir, ["controller", ...bad], { cwd: g.path }).done;
    assert.equal(r.code, 1, bad.join(" "));
    assert.match(r.stderr, /usage: gov controller claude-code\|codex \[--model M\] \[--effort low\|medium\|high\|max\]/);
  }
  assert.deepEqual(g.methods(), [], "no question, no share answer, no change");

  const claude = await run(g.dir, ["controller", "claude"], { cwd: g.path }).done;
  assert.equal(claude.code, 0, claude.stderr);
  assert.deepEqual(g.calls.at(-1)!.params.controller, { provider: "claude-code", model: "opus", effort: "high" });
  assert.match(claude.stdout, /Controller for p: claude-code · opus · high/);

  const codex = await run(g.dir, ["controller", "codex"], { cwd: g.path, input: "y\n" }).done;
  assert.equal(codex.code, 0, codex.stderr);
  assert.match(codex.stdout, /Codex \(OpenAI\) will see this project's conversation/);
  assert.deepEqual(g.calls.find((c) => c.method === "context.share")!.params, { project: "p", provider: "codex", share: true });
  assert.deepEqual(g.calls.at(-1)!.params.controller, { provider: "codex", model: "gpt-5.5", effort: "medium" });
  assert.match(codex.stdout, /Controller for p: codex · gpt-5\.5 · medium/);

  providers = ["codex"];
  await run(g.dir, ["controller", "codex", "--model", "gpt-5.4", "--effort", "max"], { cwd: g.path }).done;
  assert.deepEqual(g.calls.at(-1)!.params.controller, { provider: "codex", model: "gpt-5.4", effort: "max" });
});

const tools = (claude: boolean, codex: boolean) => ({ tools: [{ tool: "claude", connected: claude }, { tool: "codex", connected: codex }] });
const NOT_ASKED = { settings: { personal: { claude: null, codex: null } } };

test("gov ask checks the connection before the personal question, and asks about Home's own Controller", async () => {
  const g = await withProject((m) => m === "tools.list" ? tools(false, true) : m === "settings.get" ? NOT_ASKED
    : m === "ask" ? Promise.reject(new Error("connect Claude Code for GovernCode first: gov connect claude")) : undefined);
  const r = await run(g.dir, ["ask", "hi"], { cwd: g.path }).done;
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /Use your own/);
  assert.match(r.stderr, /connect Claude Code for GovernCode first/);
  assert.ok(!g.methods().includes("settings.set"), "nothing recorded");

  // At Home the Controller is the one chosen last (govd says which): here Codex.
  const h = await fakeGovd((m) => m === "project.list" ? { projects: [], home: { controller: { provider: "codex", model: "gpt-5.5", effort: "medium" } } }
    : m === "tools.list" ? tools(true, true) : m === "settings.get" ? NOT_ASKED : m === "ask" ? { ok: true, summary: "done" } : undefined);
  const home = await run(h.dir, ["ask", "hi"], { input: "y\n" }).done;
  assert.equal(home.code, 0, home.stderr);
  assert.match(home.stdout, /Use your own Codex instructions in GovernCode\?/);
  assert.deepEqual(h.calls.find((c) => c.method === "settings.set")!.params.personal, { claude: null, codex: true });
});

test("gov demo makes nothing until Claude Code is connected, and says plainly when Codex is not connected", async () => {
  const now = { claude: false, codex: false, reason: "" };
  const g = await fakeGovd((m) => m === "hello" ? { sandbox: { ok: true } } : m === "tools.list" ? tools(now.claude, now.codex)
    : m === "project.list" ? { projects: [] } : m === "settings.get" ? { settings: { personal: { claude: false, codex: null } } }
    : m === "ask" ? { ok: true, summary: "done" } : m === "spec.list" ? { specs: [] }
    : m === "limits.list" ? { providers: [{ provider: "codex", verdict: { ok: false, reason: now.reason } }] } : undefined);
  const first = join(root, "demo-1");
  const r = await run(g.dir, ["demo", "--path", first]).done;
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Claude Code is not connected for GovernCode yet\. Run gov connect claude, then gov demo again\./);
  assert.ok(!existsSync(first), "no folder made");
  assert.deepEqual(g.methods(), ["hello", "tools.list"], "nothing registered or asked");

  now.claude = true;
  const d = await run(g.dir, ["demo", "--path", first]).done;
  assert.equal(d.code, 0, d.stderr);
  assert.match(d.stdout, /Skipped: Codex is not connected for GovernCode \(gov connect codex, then run the demo again\)\./);
  assert.doesNotMatch(d.stdout, /the Limit working/);
  assert.ok(!g.methods().includes("limits.list"));

  Object.assign(now, { codex: true, reason: "Codex did not report its usage (its login may need signing in again: gov connect codex) · held" });
  const held = await run(g.dir, ["demo", "--path", join(root, "demo-2")]).done;
  assert.match(held.stdout, /Skipped: Codex is held \(Codex did not report its usage/);
  assert.doesNotMatch(held.stdout, /the Limit working/);
  now.reason = "inside its 10% weekly Limit (95% used)";
  assert.match((await run(g.dir, ["demo", "--path", join(root, "demo-3")]).done).stdout, /Codex is held \(inside its 10% weekly Limit .*\n.*the Limit working/);
});

const ANSWERS = ["gate.answer", "plan.answer", "proposal.answer", "settings.set", "context.share"];

test("with no input, gov ask leaves Gates, game plans and proposals open for another terminal, and says when one is answered there", async () => {
  let r!: ReturnType<typeof run>;
  const g = await withProject((m, _p, notify) => {
    if (m === "tools.list") return tools(true, true);
    if (m === "settings.get") return NOT_ASKED;
    if (m !== "ask") return undefined;
    return (async () => {
      notify({ kind: "gate", id: "G-1", tool: "Bash", canonical: "rm -rf dist", scopes: [] });
      notify({ kind: "plan", id: "GP-1", items: [{ who: "codex", what: "write tests" }], note: "", handoff: "ask" });
      notify({ kind: "proposal", id: "P-1", name: "x", path: "/tmp/x", git: true, reason: "" });
      // gov used to answer each at once (deny, reject, cancel); it must say where to answer instead.
      await until(() => (r.out().match(/no input here: answer from another terminal/g) ?? []).length === 3 || g.methods().some((x) => ANSWERS.includes(x)));
      notify({ kind: "trace", event: { kind: "gate.allowed", data: { gate: "G-1", tool: "Bash", by: "user" } } });
      notify({ kind: "trace", event: { kind: "plan.answered", data: { plan: "GP-1", answer: "reject", by: "turn ended" } } });
      await until(() => /GP-1: rejected/.test(r.out()));
      return { ok: true, summary: "done" };
    })();
  });
  r = run(g.dir, ["ask", "go"], { cwd: g.path });
  const res = await r.done;
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(g.methods().filter((x) => ANSWERS.includes(x)), [], "no answer the user did not give");
  for (const line of ["no input here: off for now, and asked again next time (gov personal claude on|off sets it)",
    "no input here: answer from another terminal with gov gate G-1 allow|deny",
    "no input here: answer from another terminal with gov plan GP-1 approve [1,3]|just-you|reject",
    "no input here: answer from another terminal with gov proposal P-1 create|cancel",
    "G-1: allowed from elsewhere", "GP-1: rejected (turn ended)", "— done"]) assert.ok(res.stdout.includes(line), line);
  assert.doesNotMatch(res.stdout, /Allow\?|Approve\?|Create it\?/, "no prompt with nobody to answer it");
});

test("a question answered elsewhere is withdrawn here: the next line typed goes to the next question", async () => {
  let r!: ReturnType<typeof run>;
  const g = await withProject((m, _p, notify) => {
    if (m === "tools.list") return tools(true, true);
    if (m === "settings.get") return { settings: { personal: { claude: false, codex: null } } };
    if (m !== "ask") return undefined;
    return (async () => {
      notify({ kind: "gate", id: "G-1", tool: "Bash", canonical: "npm test", scopes: [] });
      await until(() => r.out().endsWith("Allow? [y/N] "));
      notify({ kind: "trace", event: { kind: "gate.denied", data: { gate: "G-1", tool: "Bash", by: "user" } } });
      await until(() => r.out().includes("G-1: denied from elsewhere"));
      notify({ kind: "gate", id: "G-2", tool: "Bash", canonical: "ls", scopes: [] });
      await until(() => r.out().endsWith("Allow? [y/N] "));
      r.p.stdin!.write("y\n");
      await until(() => g.methods().includes("gate.answer"));
      return { ok: true, summary: "done" };
    })();
  });
  r = run(g.dir, ["ask", "go"], { cwd: g.path, live: true });
  const res = await r.done;
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /Allow\? \[y\/N\] \nG-1: denied from elsewhere\n/);
  assert.deepEqual(g.calls.filter((c) => c.method === "gate.answer").map((c) => c.params), [{ id: "G-2", answer: "allow" }]);
});

test("gov plan and gov proposal answer from another terminal", async () => {
  const g = await fakeGovd((m, p) => (m === "proposal.answer" ? { created: p.answer === "create" ? { name: "x", path: "/tmp/x" } : null } : {}));
  assert.equal((await run(g.dir, ["plan", "GP-3", "approve", "1,3"]).done).code, 0);
  assert.match((await run(g.dir, ["plan", "GP-3", "just-you"]).done).stdout, /GP-3: just you/);
  assert.match((await run(g.dir, ["plan", "GP-3", "reject", "1"]).done).stderr, /usage: gov plan GP-N approve \[1,3\]\|just-you\|reject/);
  assert.match((await run(g.dir, ["proposal", "P-2", "create"]).done).stdout, /created x at \/tmp\/x/);
  assert.match((await run(g.dir, ["proposal", "P-2", "maybe"]).done).stderr, /usage: gov proposal P-N create\|cancel/);
  assert.deepEqual(g.calls.map((c) => [c.method, c.params]), [["plan.answer", { id: "GP-3", answer: "approve", items: [1, 3] }],
    ["plan.answer", { id: "GP-3", answer: "just-you" }], ["proposal.answer", { id: "P-2", answer: "create" }]]);
});

test("with no input, gov controller records no share answer: the new Controller starts fresh", async () => {
  const g = await withProject((m) => (m === "context.state" ? { providers: ["claude-code"], shared: {}, notes: "", specs: 0, checkpoints: 0 } : undefined));
  const r = await run(g.dir, ["controller", "codex"], { cwd: g.path }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no input here: nothing is shared, so it starts fresh/);
  assert.deepEqual(g.methods(), ["project.list", "context.state", "controller.set"]);
});
