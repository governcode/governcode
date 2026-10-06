#!/usr/bin/env node
// A fake of OpenCode 2.0.23 `opencode serve --stdio`. GovernCode spawns this binary, reads the first
// stdout line ({"url":"..."}) and then drives the HTTP API with Basic auth. Event shapes are copied
// from real 2.0.23 captures: /tmp/oc-fixture/events-{once,reject,edit}.jsonl.
import http from "node:http";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";

const VERSION = process.env.FAKE_OPENCODE_VERSION ?? "2.0.23";   // (a test can pose as another release)
const ROOT = process.cwd();
const LOG = process.env.FAKE_OPENCODE_LOG ?? "";
const PASSWORD = process.env.OPENCODE_PASSWORD ?? "";
const PROJECT = "a459ddd1ce2c97efbf1a2d00c895ee8113ea1a7a"; // the captures' project id

// OpenCode's own free models (seen in 2.0.23's list), OpenCode Go's subscription, and one paid
// Zen model: GovernCode's checks need a model that costs money to tell apart from the free ones.
const MODELS = [
  { id: "big-pickle", providerID: "opencode", name: "Big Pickle", settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
    variants: [], cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: "active", enabled: true },
  { id: "kimi-k3", providerID: "opencode-go", name: "Kimi K3", settings: { baseURL: "https://opencode.ai/zen/go/v1", provider: "opencode-go" },
    variants: [{ id: "max", settings: { reasoningEffort: "max" } }], cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 0 } }], status: "active", enabled: true },
  { id: "zen-paid", providerID: "opencode", name: "Zen Paid", settings: { baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
    variants: [{ id: "high", settings: {} }], cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 0 } }], status: "active", enabled: true },
];

// ------------------------------------------------------------------ args
// Only `serve` is served; any other first argument (--version, --help, ...) prints the version.
const argv = process.argv.slice(2);
if (argv[0] !== "serve") {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}
let hostname = "127.0.0.1";
let port = 0;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--hostname") hostname = String(argv[++i] ?? hostname);
  else if (argv[i] === "--port") port = Number(argv[++i] ?? 0);
  else if (argv[i] === "--stdio") { /* accepted, unused: this fake only speaks HTTP */ }
}

// ------------------------------------------------------------ ids, log, events
const hex = (bytes = 8) => randomBytes(bytes).toString("hex");
const eventID = () => `evt_${Date.now().toString(16)}${hex(6)}`;
const messageID = () => `msg_${hex(10)}`;

function log(entry) {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}
// The environment GovernCode sets, by value: everything here is configuration, never a secret.
// OPENCODE_PASSWORD is deliberately absent (its value is the server's only secret).
const ENV_VALUES = ["OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_DISABLE_PROJECT_CONFIG",
  "XDG_DATA_HOME", "XDG_CONFIG_HOME", "HOME"];
const envValues = Object.fromEntries(ENV_VALUES.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
log({ start: { argv, cwd: ROOT, env: Object.keys(process.env).sort(), envValues } }); // names only, never values

const streams = new Set();

function emit(type, data) {
  // server.connected is the one event the real server sends without `created`.
  const event = type === "server.connected" ? { id: eventID(), type, data } : { id: eventID(), created: Date.now(), type, data };
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(frame);
  return event;
}

// ------------------------------------------------------------------- state
const sessions = new Map();
const pending = new Map(); // permission requestID -> { sessionID, resolve(decision|null) }
let sessionSeq = 0;
const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

function newSession(body = {}) {
  const now = Date.now();
  const session = {
    id: `ses_fake${++sessionSeq}`, model: body.model ?? null, agent: body.agent ?? null, title: body.title ?? null,
    permissions: body.permissions ?? null, location: body.location ?? null, tokens: zeroTokens(), time: { created: now, updated: now },
  };
  sessions.set(session.id, session);
  return session;
}
// An unknown id gets an implicit session: the fake stays permissive instead of 404ing mid-scenario.
const sessionFor = (id) => sessions.get(id) ?? newSession();

// --------------------------------------------------------------- credentials
// The real server keeps logins in a SQLite file at $XDG_DATA_HOME/opencode/opencode.db, which
// GovernCode copies into each run's fresh home. The file and its name are what matter here, so the
// fake stores the same list as JSON and never looks at the bytes.
const DB = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"), "opencode", "opencode.db");
let credentials = [];
try {
  const parsed = JSON.parse(readFileSync(DB, "utf8"));
  if (Array.isArray(parsed)) credentials = parsed;
} catch { /* no store yet, or not the fake's own: start empty */ }

function saveCredentials() {
  mkdirSync(dirname(DB), { recursive: true, mode: 0o700 });
  writeFileSync(DB, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

// ------------------------------------------------------------- readiness probe
// GovernCode asks the server to create a permission request for an action and reads the effect back,
// before it lets the model do anything. The real server never prompts for such a request, so neither
// does the fake: it answers with the effect and keeps the id answerable (a later reply is a 204).
let probes = 0;
const probeEffect = () => {
  const once = process.env.FAKE_OPENCODE_EFFECT_ONCE;
  if (once) return probes++ === 0 ? once : "ask"; // the first probe only: for retry loops
  return process.env.FAKE_OPENCODE_EFFECT ?? "ask";
};

function createPermissionRequest(res, session, body) {
  const effect = probeEffect();
  const id = `per_${hex(11)}`;
  if (effect === "ask") pending.set(id, { sessionID: session.id, resolve: () => {} });
  send(res, 200, { data: { id, effect } });
}

// -------------------------------------------------------------- step helpers
const TOOL_TOKENS = { input: 179, output: 29, reasoning: 0, cache: { read: 6016, write: 0 } };
const REJECT_TOKENS = { input: 179, output: 35, reasoning: 0, cache: { read: 6016, write: 0 } };
const STOP_TOKENS = { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } };
const TOOL_DECLINED = { type: "aborted", message: "The user declined this tool call" };
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" };

const modelRef = (session) => session.model && typeof session.model === "string"
  ? { id: session.model, providerID: "opencode", variant: "default" }
  : { id: session.model?.id ?? "big-pickle", providerID: session.model?.providerID ?? "opencode", variant: "default" };
const startExecution = (session) => emit("session.execution.started", { sessionID: session.id });
const streamed = (session, id) => emit("session.step.streamed", { sessionID: session.id, assistantMessageID: id });

function startStep(session) {
  const id = messageID();
  emit("session.step.started", { sessionID: session.id, agent: "build", model: modelRef(session), assistantMessageID: id, started: Date.now() });
  return id;
}

const textStart = (s, id) => emit("session.text.started", { sessionID: s.id, assistantMessageID: id, ordinal: 0 });
const textDelta = (s, id, delta) => emit("session.text.delta", { sessionID: s.id, assistantMessageID: id, ordinal: 0, delta });
const textEnd = (s, id, text) => emit("session.text.ended", { sessionID: s.id, assistantMessageID: id, ordinal: 0, text });

// The real server streams assistant text as several deltas.
function sayText(session, id, text) {
  textStart(session, id);
  if (text.length > 24) {
    const cut = Math.floor(text.length / 2);
    textDelta(session, id, text.slice(0, cut));
    textDelta(session, id, text.slice(cut));
  } else textDelta(session, id, text);
  textEnd(session, id, text);
}

function callTool(session, id, name, input) {
  const callID = `call_${hex(9)}`;
  const base = { sessionID: session.id, assistantMessageID: id, id: callID };
  emit("session.tool.input.started", { ...base, name });
  emit("session.tool.input.ended", { ...base, text: JSON.stringify(input) });
  emit("session.tool.called", { ...base, input, executed: false });
  return callID;
}

const toolSuccess = (s, id, callID, content, metadata) => emit("session.tool.success", {
  sessionID: s.id, assistantMessageID: id, id: callID, content, metadata, executed: false,
});

function accumulate(session, tokens) {
  const total = session.tokens;
  total.input += tokens.input;
  total.output += tokens.output;
  total.reasoning += tokens.reasoning;
  total.cache.read += tokens.cache.read;
  total.cache.write += tokens.cache.write;
  emit("session.usage.updated", { sessionID: session.id, cost: 0, tokens: { ...total, cache: { ...total.cache } } });
}

function endStep(session, id, finish, tokens) {
  streamed(session, id);
  const rawFinish = finish === "tool-calls" ? "tool_calls" : finish;
  emit("session.step.ended", { sessionID: session.id, assistantMessageID: id, finish, rawFinish, cost: 0, tokens });
  accumulate(session, tokens);
}

// Ask for permission; resolves with the reply ({decision, message?}) once the turn is answered, or
// null if the turn was interrupted while the question was still open.
function ask(session, request) {
  const id = `per_${hex(11)}`;
  emit("permission.asked", { id, sessionID: session.id, ...request });
  return new Promise((resolve) => pending.set(id, { sessionID: session.id, resolve }));
}

const accepted = (reply) => reply?.decision === "once" || reply?.decision === "always";
/** A rejection with a message tells the model why, and it carries on; without one the turn ends. */
const declined = (reply) => Boolean(reply?.message);

function runShell(session, id, callID, command) {
  return new Promise((resolve) => {
    const shellID = `sh_${hex(11)}`;
    const file = `${process.env.TMPDIR ?? "/tmp"}/fake-opencode-${shellID}.out`;
    emit("shell.created", { info: {
      id: shellID, status: "running", command, cwd: ROOT, shell: "/usr/bin/bash", file,
      metadata: { sessionID: session.id }, time: { started: Date.now() },
    } });
    emit("session.tool.progress", { sessionID: session.id, assistantMessageID: id, id: callID, metadata: { shellID } });
    const child = spawn("/bin/sh", ["-c", command], { cwd: ROOT });
    let out = "";
    // Both streams, as OpenCode's shell tool reports them.
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", (chunk) => { out += chunk; }); }
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exit = signal ? 124 : (code ?? 0);
      emit("shell.exited", { id: shellID, exit, status: "exited" });
      toolSuccess(session, id, callID, [{ type: "text", text: out }], { status: "completed", truncated: false, exit });
      resolve();
    });
  });
}

// ---------------------------------------------------------------- turn ends
// A decline with no message ends the turn: the tool fails and the step is cut short.
function rejectTurn(session, step) {
  emit("session.tool.failed", { sessionID: session.id, assistantMessageID: step.messageID, id: step.callID, error: TOOL_DECLINED, executed: false });
  emit("session.step.failed", {
    sessionID: session.id, assistantMessageID: step.messageID, error: STEP_INTERRUPTED,
    rawFinish: "tool_calls", cost: 0, tokens: REJECT_TOKENS,
  });
  accumulate(session, REJECT_TOKENS);
  emit("session.execution.interrupted", { sessionID: session.id, reason: "shutdown" }); // as the 2.0.23 capture has it
}

// A decline with a message tells the model, so the step ends on its tool calls and the model goes on.
function declineTool(session, step, reply) {
  emit("session.tool.failed", {
    sessionID: session.id, assistantMessageID: step.messageID, id: step.callID,
    error: { type: "permission.rejected", message: String(reply.message) }, executed: false,
  });
  endStep(session, step.messageID, "tool-calls", TOOL_TOKENS);
}

// The turn a decline with a message leaves behind: one short line, then success.
function declineTurn(session) {
  const id = startStep(session);
  sayText(session, id, "Declined.");
  endStep(session, id, "stop", STOP_TOKENS);
  emit("session.execution.succeeded", { sessionID: session.id });
}

function succeedTurn(session) {
  const id = startStep(session);
  sayText(session, id, "Done.");
  endStep(session, id, "stop", STOP_TOKENS);
  emit("session.execution.succeeded", { sessionID: session.id });
}

// Close the turn according to how the open permission was answered.
function settle(session, step) {
  if (step.outcome === "gone") return; // interrupted while waiting for the reply
  if (step.outcome === "rejected") return rejectTurn(session, step);
  if (step.outcome === "declined") return declineTurn(session);
  succeedTurn(session);
}

const verdict = (reply) => (reply === null ? "gone" : accepted(reply) ? "ok" : declined(reply) ? "declined" : "rejected");

// One shell step: a text preamble, the tool call, then the permission question.
async function shellStep(session, command) {
  const message = startStep(session);
  textStart(session, message);
  textDelta(session, message, "I'll run that command.");
  const callID = callTool(session, message, "shell", { command });
  textEnd(session, message, "I'll run that command.");
  streamed(session, message);
  const reply = await ask(session, {
    action: "shell",
    resources: [command],
    save: [`${command.trim().split(/\s+/)[0]} *`],
    source: { type: "tool", messageID: message, id: callID },
  });
  const step = { messageID: message, callID, outcome: verdict(reply) };
  if (step.outcome === "declined") { declineTool(session, step, reply); return step; }
  if (!accepted(reply)) return step;
  if (reply.decision === "always") {
    // A tripwire: GovernCode must never choose "always".
    log({ method: "FAKE_OPENCODE", path: "ALWAYS-CHOSEN", body: { sessionID: session.id, request: callID } });
  }
  await runShell(session, message, callID, command);
  endStep(session, message, "tool-calls", TOOL_TOKENS);
  return step;
}

// ----------------------------------------------------------------- scenarios
async function shellScenario(session, command) {
  startExecution(session);
  settle(session, await shellStep(session, command));
}

async function twoScenario(session) {
  startExecution(session);
  // A decline with a message does not end the turn: the model asks for the next thing.
  let step = await shellStep(session, "echo one");
  if (step.outcome !== "ok" && step.outcome !== "declined") return settle(session, step);
  step = await shellStep(session, "echo two");
  settle(session, step);
}

async function editScenario(session, file, oldText, newText) {
  startExecution(session);
  const message = startStep(session);
  const callID = callTool(session, message, "edit", { path: file, oldString: oldText, newString: newText });
  streamed(session, message);
  const patch = [
    `Index: ${file}`, "=".repeat(67), // the git separator width the captures use
    `--- ${file}`, `+++ ${file}`, "@@ -1,1 +1,1 @@", `-${oldText}`, `+${newText}`, "",
  ].join("\n");
  const diff = { file, patch, status: "modified", additions: 1, deletions: 1 };
  const reply = await ask(session, {
    action: "edit", resources: [file], save: ["*"], metadata: { files: [diff] },
    source: { type: "tool", messageID: message, id: callID },
  });
  const step = { messageID: message, callID, outcome: verdict(reply) };
  if (step.outcome === "declined") declineTool(session, step, reply);
  else if (accepted(reply)) {
    let result = `Edited ${file} (1 replacement)`;
    try {
      const target = isAbsolute(file) ? file : join(ROOT, file);
      writeFileSync(target, readFileSync(target, "utf8").replace(oldText, newText));
    } catch (err) {
      result = `Edit failed: ${err.message}`;
    }
    toolSuccess(session, message, callID, [{ type: "text", text: result }], { files: [diff], truncated: false });
    endStep(session, message, "tool-calls", TOOL_TOKENS);
  }
  settle(session, step);
}

async function limitScenario(session) {
  startExecution(session);
  const message = startStep(session);
  // ASSUMED SHAPE: no captured stream exists for a provider usage-limit failure. The same error
  // object is reused on the step and the execution, because the tests expect one shared value.
  const error = { type: "api", message: "Go usage limit exceeded" };
  emit("session.step.failed", { sessionID: session.id, assistantMessageID: message, error, rawFinish: "error", cost: 0, tokens: REJECT_TOKENS });
  emit("session.execution.failed", { sessionID: session.id, error });
}

async function hangScenario(session) {
  startExecution(session); // then silence until /interrupt
}

async function subagentScenario(session, text) {
  startExecution(session);
  const message = startStep(session);
  const callID = callTool(session, message, "task", { description: "delegate a subtask", prompt: text });
  streamed(session, message);
  const reply = await ask(session, {
    action: "task", resources: [text], save: ["*"],
    source: { type: "tool", messageID: message, id: callID },
  });
  const step = { messageID: message, callID, outcome: verdict(reply) };
  if (step.outcome === "declined") declineTool(session, step, reply);
  else if (accepted(reply)) {
    toolSuccess(session, message, callID, [{ type: "text", text: "Subagent finished." }], { status: "completed" });
    endStep(session, message, "tool-calls", TOOL_TOKENS);
  }
  settle(session, step);
}

async function plainScenario(session) {
  startExecution(session);
  const id = startStep(session);
  sayText(session, id, "ok");
  endStep(session, id, "stop", STOP_TOKENS);
  emit("session.execution.succeeded", { sessionID: session.id });
}

// The scenario is chosen by the FIRST keyword found in the prompt text.
const KEYWORDS = ["SHELL", "EDIT", "TWO", "LIMIT", "HANG", "SUBAGENT", "DROPSTREAM"];
const after = (text, key) => text.slice(text.indexOf(key) + key.length).replace(/^[:\s]+/, "").split("\n")[0].trim();

async function runScenario(session, text) {
  const key = KEYWORDS.map((k) => [text.indexOf(k), k]).filter(([at]) => at >= 0).sort((a, b) => a[0] - b[0])[0]?.[1] ?? "";
  try {
    if (key === "SHELL") return await shellScenario(session, after(text, key));
    if (key === "EDIT") {
      const [file, oldText, ...rest] = after(text, key).split(":");
      return await editScenario(session, file, oldText, rest.join(":"));
    }
    if (key === "TWO") return await twoScenario(session);
    if (key === "LIMIT") return await limitScenario(session);
    if (key === "HANG") return await hangScenario(session);
    // DROPSTREAM: the turn starts, then every event stream ends (the server stays up).
    if (key === "DROPSTREAM") { emit("session.execution.started", { sessionID: session.id }); for (const res of streams) res.end(); return; }
    if (key === "SUBAGENT") return await subagentScenario(session, text);
    return await plainScenario(session);
  } catch (err) {
    emit("session.execution.failed", { sessionID: session.id, error: { type: "unknown", message: String(err) } });
  }
}

// --------------------------------------------------------------------- http
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return resolve(null);
    try {
      resolve(JSON.parse(raw));
    } catch {
      resolve(raw);
    }
  });
});

function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const authorized = (req) => req.headers.authorization === `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;

function openStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  streams.add(res);
  emit("server.connected", {});
  res.on("close", () => streams.delete(res));
}

function replyPermission(res, requestID, decision, message) {
  const entry = pending.get(requestID);
  if (!entry) return send(res, 404, { _tag: "PermissionNotFoundError", requestID, message: `No pending permission ${requestID}` });
  pending.delete(requestID);
  res.writeHead(204);
  res.end();
  emit("permission.replied", { sessionID: entry.sessionID, requestID, reply: decision });
  entry.resolve(message === undefined ? { decision } : { decision, message: String(message) });
}

function listCredentials(res) {
  send(res, 200, { data: credentials });
}

function storeCredential(res, body) {
  const integrationID = String(body?.integrationID ?? "");
  const key = typeof body?.value?.key === "string" ? body.value.key : "";
  if (!integrationID || !key) return send(res, 400, { _tag: "BadRequestError", message: "integrationID and value.key are required" });
  const credential = { id: `cred_${hex(11)}`, integrationID, label: "default", active: body?.activate !== false, value: { type: "key", key } };
  if (credential.active) for (const c of credentials) if (c.integrationID === integrationID) c.active = false; // one active key per integration
  credentials.push(credential);
  saveCredentials();
  send(res, 200, { data: credential });
}

function deleteCredential(res, id) {
  const at = credentials.findIndex((c) => c.id === id);
  if (at < 0) return send(res, 404, { _tag: "NotFoundError", message: `No credential ${id}` });
  credentials.splice(at, 1);
  saveCredentials();
  res.writeHead(204);
  res.end();
}

function createSession(res, body) {
  const session = newSession(body ?? {});
  const data = {
    id: session.id, model: session.model, permissions: session.permissions,
    location: session.location ?? { directory: ROOT }, projectID: PROJECT,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.title ? { title: session.title } : {}),
    cost: 0, tokens: zeroTokens(), time: session.time,
  };
  send(res, 200, { data });
}

function prompt(res, session, body) {
  const text = String(body?.text ?? "");
  send(res, 200, { data: { id: messageID(), sessionID: session.id, type: "user", payload: { text }, delivery: "steer" } });
  void runScenario(session, text); // the scenario continues over the event stream
}

function interrupt(res, session) {
  send(res, 200, { interrupted: true });
  for (const [requestID, entry] of pending) {
    if (entry.sessionID !== session.id) continue;
    pending.delete(requestID);
    entry.resolve(null);
  }
  emit("session.execution.interrupted", { sessionID: session.id, reason: "user" });
}

const server = http.createServer((req, res) => {
  void (async () => {
    const body = await readBody(req);
    const [pathname] = req.url.split("?");
    // A key is the one body value that must never be written down.
    const logged = req.method === "POST" && pathname === "/api/credential" && body?.value?.key !== undefined
      ? { ...body, value: { ...body.value, key: "<redacted>" } }
      : body;
    log({ method: req.method, path: req.url, body: logged });
    if (!pathname.startsWith("/api/")) return send(res, 404, { _tag: "NotFoundError", message: `No route for ${pathname}` });
    if (!authorized(req)) return send(res, 401, { _tag: "UnauthorizedError" });
    const parts = pathname.split("/").filter(Boolean); // ["api", "session", <id>, ...]

    if (req.method === "GET" && pathname === "/api/info") {
      const url = `http://${hostname}:${server.address()?.port ?? port}`;
      return send(res, 200, { version: VERSION, pid: process.pid, urls: [url], paths: { tmp: process.env.TMPDIR ?? "/tmp" } });
    }
    if (req.method === "GET" && pathname === "/api/event") return openStream(res);
    if (req.method === "GET" && pathname === "/api/model") return send(res, 200, { location: { directory: ROOT }, data: MODELS });
    if (req.method === "GET" && pathname === "/api/credential") return listCredentials(res);
    if (req.method === "POST" && pathname === "/api/credential") return storeCredential(res, body);
    if (req.method === "DELETE" && parts[1] === "credential" && parts.length === 3) return deleteCredential(res, parts[2]);
    if (req.method === "POST" && parts[1] === "session" && parts.length === 2) return createSession(res, body);
    if (req.method === "POST" && parts[1] === "session" && parts[3] === "prompt") return prompt(res, sessionFor(parts[2]), body);
    if (req.method === "POST" && parts[1] === "session" && parts[3] === "permission" && parts.length === 4) return createPermissionRequest(res, sessionFor(parts[2]), body);
    if (req.method === "POST" && parts[1] === "session" && parts[3] === "permission" && parts[5] === "reply") {
      // FAKE_OPENCODE_REPLY_STATUS: every reply fails with that status (GovernCode must notice).
      if (process.env.FAKE_OPENCODE_REPLY_STATUS) return send(res, Number(process.env.FAKE_OPENCODE_REPLY_STATUS), { _tag: "InternalError" });
      return replyPermission(res, parts[4], body?.decision, body?.message);
    }
    if (req.method === "POST" && parts[1] === "session" && parts[3] === "interrupt") return interrupt(res, sessionFor(parts[2]));
    return send(res, 404, { _tag: "NotFoundError", message: `No route for ${req.method} ${pathname}` });
  })().catch((err) => {
    try {
      send(res, 500, { _tag: "UnknownError", message: String(err) });
    } catch { /* the response is already gone */ }
  });
});

server.listen(port, hostname, () => {
  process.stdout.write(`${JSON.stringify({ url: `http://${hostname}:${server.address().port}` })}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  for (const res of streams) res.end(); // long-lived SSE responses would hold the server open
  setTimeout(() => process.exit(0), 100).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);