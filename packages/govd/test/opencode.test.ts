// The OpenCode Runner: the rules that need no server (models, Gates, the sandbox, settings), then a
// run end to end against fixtures/fake-opencode.mjs, a fake of `opencode serve` 2.0.23 built from
// real captures of its events (permission.asked, the tool and step events, usage, the end).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/allows.ts";
import type { GateRequest } from "../src/claude.ts";
import { isConnected, setConnected, toolHome } from "../src/homes.ts";
import { checkModel, opencodeConfig, opencodeGate, opencodeModel, opencodePolicy, opencodeSettings, opencodeSignedIn, opencodeSignIn,
  runOpencodeTurn, OPENCODE_DB } from "../src/opencode.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-opencode-");

test("models: OpenCode Go and OpenCode's free ones only, never a paid Zen model or another provider", () => {
  assert.deepEqual(opencodeModel("opencode-go/kimi-k3"), { providerID: "opencode-go", id: "kimi-k3" });
  assert.deepEqual(opencodeModel("opencode/big-pickle"), { providerID: "opencode", id: "big-pickle" });
  assert.deepEqual(opencodeModel("opencode/nemotron-3-ultra-free"), { providerID: "opencode", id: "nemotron-3-ultra-free" });
  for (const m of ["opencode/claude-sonnet-5", "anthropic/claude-sonnet-5", "openai/gpt-6", "kimi-k3", "opencode-go/", "opencode-go/a b", "ollama/qwen3.5:9b"]) {
    assert.equal(opencodeModel(m), null, m);
  }
});

test("models: OpenCode's own list must agree (Go, or served with its public key), and an effort is passed only where offered", () => {
  const list = [
    { id: "big-pickle", providerID: "opencode", settings: { apiKey: "public" }, variants: [] },
    { id: "kimi-k3", providerID: "opencode-go", settings: {}, variants: [{ id: "max" }] },
    { id: "lookalike-free", providerID: "opencode", settings: {}, variants: [] },   // named free, not served free
  ];
  assert.deepEqual(checkModel(list, { providerID: "opencode-go", id: "kimi-k3" }, "max"), { variant: "max" });
  assert.deepEqual(checkModel(list, { providerID: "opencode-go", id: "kimi-k3" }, "low"), {}, "an effort the model lacks is left out");
  assert.deepEqual(checkModel(list, { providerID: "opencode", id: "big-pickle" }, "high"), {});
  assert.throws(() => checkModel(list, { providerID: "opencode", id: "lookalike-free" }, null), /not an OpenCode Go or free model/);
  assert.throws(() => checkModel(list, { providerID: "opencode-go", id: "gone" }, null), /does not offer/);
  assert.throws(() => checkModel(null, { providerID: "opencode-go", id: "kimi-k3" }, null), /does not offer/);
});

test("config: every action asks, no subagents, only OpenCode's providers, nothing shared, no updates, no MCP servers", () => {
  assert.deepEqual(JSON.parse(opencodeConfig()), {
    permission: { "*": "ask", task: "deny" }, enabled_providers: ["opencode", "opencode-go"], share: "disabled", autoupdate: false, mcp: {} });
});

test("Gates: a command is judged like every Runner's command; an edit shows its patch; a read is quiet; a subagent is refused", () => {
  const shell = opencodeGate({ id: "per_1", action: "shell", resources: ["npm test"], save: ["npm *"] });
  assert.ok(shell !== "reject");
  assert.equal(shell.tool, "opencode command");
  assert.deepEqual(shell.input, { command: "npm test" });
  // The same analysis as Claude's Bash: npm test is a kind a rule may cover, rm always asks.
  assert.deepEqual(analyze({ ...shell, spec: "S-1" }).kinds.map((k) => k.key), ["runner:command:npm test"]);
  const rm = opencodeGate({ id: "per_2", action: "shell", resources: ["rm -rf dist"] });
  assert.ok(rm !== "reject" && analyze(rm).ask, "rm always asks");
  assert.ok(analyze(opencodeGate({ id: "per_3", action: "shell", resources: ["ls -la"] }) as any).quiet, "ls is a quiet read");

  const patch = "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n";
  const edit = opencodeGate({ id: "per_4", action: "edit", resources: ["a.txt"], metadata: { files: [{ file: "a.txt", patch, status: "modified" }] } });
  assert.ok(edit !== "reject");
  assert.equal(edit.tool, "opencode fileChange");
  assert.match(edit.canonical, /goodbye/, "the Gate shows the change itself");
  assert.deepEqual(analyze(edit).kinds.map((k) => k.key), ["edit"]);

  const read = opencodeGate({ id: "per_5", action: "read", resources: ["src/app.ts"] });
  assert.ok(read !== "reject" && analyze(read).quiet, "a read is a quiet read (the sandbox bounds what can be read)");
  assert.ok(!analyze(opencodeGate({ id: "per_6", action: "read", resources: ["/dev/zero"] }) as any).quiet, "a special file is no quiet read");

  assert.equal(opencodeGate({ id: "per_7", action: "task", resources: ["*"] }), "reject");
  assert.equal(opencodeGate({ id: "per_8", action: "subagent", resources: [] }), "reject");
  assert.equal(opencodeGate({ id: "per_9", action: "Shell; rm", resources: [] }), "reject", "an action that is not a plain name is refused");
  const web = opencodeGate({ id: "per_10", action: "webfetch", resources: ["https://example.com"] });
  assert.ok(web !== "reject" && web.tool === "opencode_webfetch");
  // A command of two parts is shown whole and never treated as one plain command.
  const two = opencodeGate({ id: "per_11", action: "shell", resources: ["a", "b"] });
  assert.ok(two !== "reject" && two.input.command === null && analyze(two).ask);
});

test("sandbox: OpenCode may listen on its one port and never connect to it; the network on 443 only", () => {
  const p = opencodePolicy({ work: "/w", tmp: "/t", home: "/h", bin: "/opt/oc/bin/opencode.exe", port: 41234, writePaths: ["/w/src"] });
  assert.deepEqual(p.tcp_bind, [41234]);
  assert.deepEqual(p.tcp_connect, [443], "not its own port: a command it runs cannot reach its API");
  assert.ok(p.write.includes("/w/src") && !p.write.includes("/w"));
  assert.ok(["/h/.local/share", "/h/.cache", "/h/.local/state"].every((d) => p.write.includes(d)));
  assert.ok(!p.write.includes("/h") && !p.write.some((w) => w.startsWith("/h/.config")), "never its config (OpenCode loads config and plugins from it)");
  assert.ok(p.exec.includes("/opt/oc/bin"));
  assert.deepEqual(opencodePolicy({ work: "/w", tmp: "/t", home: "/h", bin: "/b/oc", port: 1, readOnly: true }).write,
    ["/t", "/h/.local/share", "/h/.cache", "/h/.local/state", "/dev/null"]);
});

test("settings: a project with OpenCode config, agents or instructions is refused; so is a link out of it", () => {
  const clean = join(root, "clean");
  mkdirSync(join(clean, "src"), { recursive: true });
  writeFileSync(join(clean, "src", "a.ts"), "x");
  assert.deepEqual(opencodeSettings(clean), []);
  for (const [name, dir] of [["opencode.json", false], [".opencode", true], ["AGENTS.md", false], ["CONTEXT.md", false], [".agents", true]] as const) {
    const w = join(root, `with-${name}`);
    mkdirSync(join(w, "deep"), { recursive: true });
    if (dir) mkdirSync(join(w, "deep", name)); else writeFileSync(join(w, "deep", name), "x");
    assert.deepEqual(opencodeSettings(w), [join("deep", name)], name);
  }
  const linked = join(root, "linked");
  mkdirSync(linked);
  symlinkSync("/etc", join(linked, "out"));
  assert.match(opencodeSettings(linked)[0], /a link/);
});

// ---- End to end, against the fake server -------------------------------------------------------

const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const log = join(root, "fake.log");
const supEnv = join(root, "sup.env");
// The stand-in for govern-sup: it records the policy it was given, passes the test's settings for
// the fake (govd gives OpenCode a stripped environment of its own), and runs the program.
const supervisor = join(bin, "govern-sup");
writeFileSync(supervisor, `#!/bin/sh\n[ "$1" = selftest ] && exit 0\ncp "$3" "${root}/last-policy.json"\nexport FAKE_OPENCODE_LOG="${log}"\n[ -f "${supEnv}" ] && . "${supEnv}"\nshift 4\nexec "$@"\n`);
chmodSync(supervisor, 0o755);
process.env.GOVERNCODE_OPENCODE_BIN = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));
const stateDir = join(root, "state");
const o = { supervisor, policyDir: join(root, "policies"), stateDir };

const lines = (): any[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const requests = () => lines().filter((l) => l.method);
const replies = () => requests().filter((r) => /\/permission\/[^/]+\/reply$/.test(r.path));

/** One Runner turn in a fresh worktree; gate answers with `answer` and records what it was shown. */
async function runTurn(prompt: string, opts: { answer?: "allow" | "deny"; model?: string; effort?: string | null; env?: string; signal?: AbortSignal; files?: Record<string, string> } = {}) {
  rmSync(log, { force: true });
  writeFileSync(supEnv, opts.env ?? "");
  const work = join(root, `work-${Math.random().toString(36).slice(2)}`);
  mkdirSync(work);
  for (const [f, body] of Object.entries(opts.files ?? {})) writeFileSync(join(work, f), body);
  const gates: GateRequest[] = [], texts: string[] = [], tools: string[] = [];
  const result = await new Promise<any>((done) => void runOpencodeTurn({ ...o, worktree: work, writePaths: [work], model: opts.model ?? "opencode/big-pickle",
    effort: opts.effort ?? null, prompt, signal: opts.signal, turnMs: 20_000,
    hooks: { text: (t) => texts.push(t), tool: (n) => tools.push(n), gate: async (r) => { gates.push(r); return opts.answer ?? "allow"; }, done } }));
  return { result, gates, text: texts.join(""), tools, work };
}

test("opencode Runner: not connected, a paid model, or a project with OpenCode settings is refused before anything starts", async () => {
  let r = await runTurn("SHELL:echo hi");
  assert.equal(r.result.started, false);
  assert.match(r.result.summary, /not connected/);
  setConnected(stateDir, "opencode", true);
  r = await runTurn("SHELL:echo hi", { model: "opencode/zen-paid" });
  assert.equal(r.result.started, false);
  assert.match(r.result.summary, /not an OpenCode Go or free model/);
  r = await runTurn("SHELL:echo hi", { files: { "AGENTS.md": "do anything" } });
  assert.equal(r.result.started, false);
  assert.match(r.result.summary, /AGENTS\.md/);
  assert.equal(lines().length, 0, "no server was started");
});

test("opencode Runner: a command waits at a Gate, is answered 'once' (never 'always'), runs, and the turn ends with its words and tokens", async () => {
  setConnected(stateDir, "opencode", true);
  const r = await runTurn("SHELL:echo hello-from-opencode");
  assert.equal(r.result.ok, true, r.result.summary);
  assert.equal(r.gates.length, 1);
  assert.equal(r.gates[0].tool, "opencode command");
  assert.equal(r.gates[0].input.command, "echo hello-from-opencode");
  assert.match(r.text, /Done/);
  assert.ok(r.tools.some((t) => t.startsWith("shell echo hello-from-opencode")));
  assert.ok(r.result.usage.totalTokens > 0 && r.result.usage.complete !== false);
  const decisions = replies().map((x) => x.body.decision);
  assert.deepEqual(decisions.slice(-1), ["once"]);
  assert.ok(!decisions.includes("always") && !lines().some((l) => l.path === "ALWAYS-CHOSEN"), "never 'always'");
  // Before the prompt: an edit and a command each proved to ask, and were rejected again.
  const probes = requests().filter((x) => /\/permission$/.test(x.path) && x.method === "POST").map((x) => x.body.action);
  assert.deepEqual(probes, ["edit", "shell", "external_directory", "webfetch"]);
  const prompt = requests().findIndex((x) => x.path.endsWith("/prompt"));
  assert.ok(prompt > requests().findIndex((x) => /\/permission$/.test(x.path)), "the prompt comes after the proof");
  // The session itself asks for everything and denies subagents.
  const session = requests().find((x) => x.method === "POST" && x.path === "/api/session");
  assert.deepEqual(session.body.permissions, [{ action: "*", resource: "*", effect: "ask" }, { action: "task", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" }]);
  assert.deepEqual(session.body.model, { providerID: "opencode", id: "big-pickle" });
});

test("opencode Runner: the server listens on its one port and may not connect to it; its home is fresh, configured by GovernCode, and gone afterwards", async () => {
  setConnected(stateDir, "opencode", true);
  await runTurn("plain");
  const policy = JSON.parse(readFileSync(join(root, "last-policy.json"), "utf8"));
  const start = lines().find((l) => l.start).start;
  const port = Number(start.argv[start.argv.indexOf("--port") + 1]);
  assert.deepEqual(policy.tcp_bind, [port]);
  assert.deepEqual(policy.tcp_connect, [443]);
  assert.equal(start.argv[start.argv.indexOf("--hostname") + 1], "127.0.0.1");
  assert.ok(start.env.includes("OPENCODE_PASSWORD") && !start.env.includes("OPENCODE_SERVER_PASSWORD"));
  assert.deepEqual(JSON.parse(start.envValues.OPENCODE_CONFIG_CONTENT).permission, { "*": "ask", task: "deny" });
  assert.equal(start.envValues.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  const runs = join(stateDir, "tools", "opencode", "runs");
  assert.ok(start.envValues.HOME.startsWith(runs + "/"), "a run home of GovernCode's own, not the user's");
  assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], [], "and it is deleted afterwards");
  assert.ok(!JSON.stringify(start).includes(process.env.HOME + "/.local/share/opencode"));
});

test("opencode Runner: a declined Gate tells the model and the turn goes on; nothing ran", async () => {
  setConnected(stateDir, "opencode", true);
  const marker = join(root, "should-not-exist");
  const r = await runTurn(`SHELL:touch ${marker}`, { answer: "deny" });
  assert.equal(existsSync(marker), false);
  const last = replies().at(-1);
  assert.equal(last.body.decision, "reject");
  assert.match(last.body.message, /declined/);
  assert.equal(r.result.ok, true, "the model was told, and finished");
  assert.match(r.text, /Declined/);
});

test("opencode Runner: an edit Gate shows the patch; allowed once, the file changes", async () => {
  setConnected(stateDir, "opencode", true);
  const r = await runTurn("EDIT:readme.txt:hello:goodbye", { files: { "readme.txt": "hello\n" } });
  assert.equal(r.result.ok, true, r.result.summary);
  assert.equal(r.gates[0].tool, "opencode fileChange");
  assert.match(r.gates[0].canonical, /\+goodbye/);
  assert.equal(readFileSync(join(r.work, "readme.txt"), "utf8"), "goodbye\n");
});

test("opencode Runner: a subagent is refused without a Gate", async () => {
  setConnected(stateDir, "opencode", true);
  const r = await runTurn("SUBAGENT:go");
  assert.equal(r.gates.length, 0);
  assert.equal(replies().at(-1).body.decision, "reject");
  assert.match(replies().at(-1).body.message, /subagents/);
});

test("opencode Runner: OpenCode Go's usage limit ends the turn as limited, with no reset time", async () => {
  setConnected(stateDir, "opencode", true);
  const r = await runTurn("LIMIT", { model: "opencode-go/kimi-k3", effort: "max" });
  assert.equal(r.result.ok, false);
  assert.deepEqual(r.result.limit, { resetsAt: null });
  assert.match(r.result.summary, /usage limit/);
  const session = requests().find((x) => x.method === "POST" && x.path === "/api/session");
  assert.deepEqual(session.body.model, { providerID: "opencode-go", id: "kimi-k3", variant: "max" });
});

test("opencode Runner: a stop interrupts the session and ends the turn", async () => {
  setConnected(stateDir, "opencode", true);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  const r = await runTurn("HANG", { signal: ac.signal });
  assert.equal(r.result.ok, false);
  assert.ok(requests().some((x) => x.path.endsWith("/interrupt")));
});

test("opencode Runner: if OpenCode would not ask before a step, nothing is run; a late config is waited for", async () => {
  setConnected(stateDir, "opencode", true);
  let r = await runTurn("SHELL:echo no", { env: "export FAKE_OPENCODE_EFFECT=allow\n" });
  assert.equal(r.result.started, false);
  assert.match(r.result.summary, /does not ask before every step/);
  assert.ok(!requests().some((x) => x.path.endsWith("/prompt")), "no prompt was sent");
  r = await runTurn("plain", { env: "export FAKE_OPENCODE_EFFECT_ONCE=allow\n" });
  assert.equal(r.result.ok, true, r.result.summary);
});

test("connect opencode: the key goes to OpenCode's own store for OpenCode Go only, never to a log; a run gets a copy, and a re-Connect replaces it", async () => {
  const home = toolHome(stateDir, "opencode");
  rmSync(home, { recursive: true, force: true });
  rmSync(log, { force: true });
  writeFileSync(supEnv, "");
  assert.equal(await opencodeSignedIn(o, home), false);
  assert.equal(await opencodeSignIn(o, home, "not a key"), false, "not one word: refused before anything starts");
  assert.equal(await opencodeSignIn(o, home, "sk-test-key-1234567890"), true);
  assert.equal(await opencodeSignedIn(o, home), true);
  assert.ok(existsSync(join(home, OPENCODE_DB)));
  assert.ok(!readFileSync(log, "utf8").includes("sk-test-key-1234567890"), "the key is in no log");
  const created = requests().find((x) => x.method === "POST" && x.path === "/api/credential");
  assert.equal(created.body.integrationID, "opencode-go");
  assert.equal(await opencodeSignIn(o, home, "sk-test-key-0987654321"), true);
  const order = requests().filter((x) => x.path.startsWith("/api/credential") && x.method !== "GET").slice(-2).map((x) => x.method);
  assert.deepEqual(order, ["POST", "DELETE"], "the new key is stored before the old one goes");
  const stored = JSON.parse(readFileSync(join(home, OPENCODE_DB), "utf8"));
  const list = Array.isArray(stored) ? stored : stored.credentials ?? stored.data ?? [];
  assert.equal(list.length, 1, "a re-Connect replaces the old key");
  setConnected(stateDir, "opencode", true);
  assert.ok(isConnected(stateDir, "opencode"));
});

test("opencode Runner: a lost event stream ends the turn at once, saying so, with its use as a floor", async () => {
  setConnected(stateDir, "opencode", true);
  const t0 = Date.now();
  const r = await runTurn("DROPSTREAM");
  assert.ok(Date.now() - t0 < 10_000, "not left to the deadline");
  assert.equal(r.result.ok, false);
  assert.match(r.result.summary, /event stream ended/);
  assert.equal(r.result.usage.complete, false);
});

test("opencode Runner: a Gate's answer OpenCode does not take is tried again, then ends the turn", async () => {
  setConnected(stateDir, "opencode", true);
  const r = await runTurn("SHELL:echo hi", { env: "export FAKE_OPENCODE_REPLY_STATUS=500\n" });
  assert.equal(r.result.ok, false);
  assert.match(r.result.summary, /could not give OpenCode a Gate's answer/);
  const all = requests(), at = all.findIndex((x) => x.path.endsWith("/prompt"));
  assert.equal(all.slice(at).filter((x) => /\/reply$/.test(x.path)).length, 2, "the Gate's answer was tried twice");
});

test("opencode Runner: stopped before the prompt, nothing is asked and nothing counted", async () => {
  setConnected(stateDir, "opencode", true);
  const ac = new AbortController();
  ac.abort();
  const r = await runTurn("SHELL:echo hi", { signal: ac.signal });
  assert.equal(r.result.ok, false);
  assert.ok(!requests().some((x) => x.path.endsWith("/prompt")), "no prompt was sent");
  assert.deepEqual(r.result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test("opencode Runner: a turn OpenCode ends itself reports its whole use; two Gates in a row are each answered", async () => {
  setConnected(stateDir, "opencode", true);
  let r = await runTurn("LIMIT");
  assert.notEqual(r.result.usage?.complete, false, "OpenCode reported the end itself");
  r = await runTurn("TWO:");
  assert.equal(r.result.ok, true, r.result.summary);
  assert.deepEqual(r.gates.map((g) => g.input.command), ["echo one", "echo two"]);
  assert.deepEqual(replies().map((x) => x.body.decision).slice(-2), ["once", "once"]);
});
