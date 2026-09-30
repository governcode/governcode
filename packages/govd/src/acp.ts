// A generic ACP client (the Agent Client Protocol: JSON-RPC 2.0 over the agent's stdio), for
// Runners whose tool speaks it (Grok first). GovernCode is the client: it starts the agent under
// govern-sup, runs initialize, session/new and one session/prompt, and answers the agent's
// `session/request_permission` from the user's Gate. Only two answers are ever given: the
// agent's "allow once" option, or a rejection; "allow always" is never chosen, so every call asks
// again. Token use comes from the agent's `turn_completed` update (an xAI extension; a plain ACP
// agent reports none). A stop from outside sends `session/cancel` and then ends the process; an
// agent that dies ends the turn with its last words on stderr.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { canonical, type GateRequest, type TurnHooks } from "./claude.ts";
import { MAX_RUN_TOKENS } from "./codex.ts";

export type AcpRpc = {
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params: unknown): void;
  onRequest(f: (method: string, params: any) => Promise<unknown>): void;
  onNotify(f: (method: string, params: any) => void): void;
  /** Ends the agent: stdin closed, SIGTERM to its process group, SIGKILL after `killAfterMs`.
   *  Nothing happens once the sandbox has closed (a process group id could have been reused). */
  close(killAfterMs?: number): void;
  /** Resolves with the tail of stderr once the process has exited (or could not start). */
  exited: Promise<string>;
  /** Resolves once the sandbox (govern-sup) has closed: every process of the run is gone. */
  closed: Promise<number | null>;
};

const isId = (v: unknown) => typeof v === "number" || typeof v === "string";
const MAX_LINE = 8 * 1024 * 1024;   // ponytail: larger than any real message; a file an agent embeds stays under it

/** Starts `bin args...` under govern-sup and speaks JSON-RPC 2.0 over its stdio. */
export function startAcp(o: { supervisor: string; policyFile: string; bin: string; args: string[]; env: Record<string, string>; cwd: string }): AcpRpc {
  const child = spawn(o.supervisor, ["run", "--policy", o.policyFile, "--", o.bin, ...o.args], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderr = "";
  let gone = false;                 // exited, or never started
  child.stderr?.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
  // An agent that dies turns our next write into EPIPE; its exit is reported through `exited`.
  child.stdin?.on("error", () => {});
  let next = 1;
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void; timer?: NodeJS.Timeout }>();
  let onReq: (method: string, params: any) => Promise<unknown> = async (m) => { throw new Error(`GovernCode does not answer ${m}`); };
  let onNote: (method: string, params: any) => void = () => {};
  const send = (obj: unknown) => { if (!gone && child.stdin?.writable) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(obj as object) }) + "\n"); };
  // One message per line, JSON-RPC 2.0 only; anything else (a stray print, a malformed envelope,
  // a line too long to be a message) is ignored, never acted on.
  // ponytail: readline holds a line until its end, so a runaway agent can still make govd hold
  // one long line (not parse it); upgrade to a bounded reader if a Runner is ever seen doing it.
  createInterface({ input: child.stdout! }).on("line", (line: string) => {
    if (line.length > MAX_LINE) return;
    let m: any;
    try { m = JSON.parse(line); } catch { return; }              // not a message (a stray print): ignored
    if (!m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0") return;
    if (m.params !== undefined && (m.params === null || typeof m.params !== "object")) return;
    if ("method" in m && ("result" in m || "error" in m)) return;   // a request and a reply at once: neither
    if (isId(m.id) && typeof m.method === "string") {           // a request from the agent to us
      onReq(m.method, m.params ?? {}).then((result) => send({ id: m.id, result: result ?? null }),
        (e) => send({ id: m.id, error: { code: -32601, message: String(e instanceof Error ? e.message : e).slice(0, 300) } }));
    } else if (typeof m.id === "number" && !("method" in m)) {   // a response to us
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (!w) return;
      clearTimeout(w.timer);
      const hasResult = "result" in m, hasError = "error" in m;
      if (hasError === hasResult) w.fail(new Error("the agent sent a malformed reply"));
      else if (hasError) w.fail(new Error(String(m.error?.message ?? "agent error").slice(0, 300)));
      else w.ok(m.result);
    } else if (m.id === undefined && typeof m.method === "string") onNote(m.method, m.params ?? {});
  });
  const tail = () => stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300);
  const failAll = (why: string) => {
    for (const w of waiting.values()) { clearTimeout(w.timer); w.fail(new Error(why)); }
    waiting.clear();
  };
  let onExit: (s: string) => void = () => {}, onClose: (c: number | null) => void = () => {};
  const exited = new Promise<string>((res) => (onExit = res));
  const closed = new Promise<number | null>((res) => (onClose = res));
  child.on("exit", (code) => { gone = true; failAll(`the agent exited (${code ?? "signal"}): ${tail()}`); onExit(stderr); });
  // Could not start at all (no such supervisor, no such folder): the same ending, said plainly.
  child.on("error", (e) => { gone = true; stderr = e.message; failAll(`the agent did not start: ${e.message}`); onExit(stderr); onClose(null); });
  child.on("close", (code) => { onClose(code); });
  let killer: NodeJS.Timeout | undefined;
  let over = false;
  void closed.then(() => { over = true; clearTimeout(killer); });
  return {
    request: (method, params, timeoutMs) => new Promise((ok, fail) => {
      if (gone) return fail(new Error(`the agent is gone: ${tail()}`));
      const id = next++;
      const timer = timeoutMs ? setTimeout(() => { waiting.delete(id); fail(new Error(`${method}: no answer in ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs) : undefined;
      waiting.set(id, { ok, fail, timer });
      send({ id, method, params });
    }),
    notify: (method, params) => send({ method, params }),
    onRequest: (f) => (onReq = f),
    onNotify: (f) => (onNote = f),
    close: (killAfterMs = 60_000) => {
      if (over || !child.pid) return;
      child.stdin?.end();
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
      // govern-sup reaps every descendant itself and only then exits; SIGKILL is the last resort.
      if (!killer) { killer = setTimeout(() => { if (!over) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } } }, killAfterMs); killer.unref(); }
    },
    exited, closed,
  };
}

export type PermissionOption = { optionId: string; name?: string; kind: string };
export type PermissionOutcome = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };

/**
 * The answer to a permission request: for "allow", the agent's `allow_once` option and nothing
 * else (never `allow_always`: the user allowed one step, and the next one asks again); for
 * anything else, `reject_once`, else `reject_always`, else the request is cancelled. An
 * "allow" with no `allow_once` on offer is a rejection too, and a list whose ids are not all
 * distinct non-empty strings is cancelled: nothing is ever granted by silence or by ambiguity.
 */
export function pickOption(options: unknown, answer: "allow" | "deny"): PermissionOutcome {
  const cancelled: PermissionOutcome = { outcome: { outcome: "cancelled" } };
  if (!Array.isArray(options)) return cancelled;
  const list = options.filter((o): o is PermissionOption => !!o && typeof o === "object" && typeof (o as any).optionId === "string" && (o as any).optionId !== "" && typeof (o as any).kind === "string");
  if (list.length !== options.length || new Set(list.map((o) => o.optionId)).size !== list.length) return cancelled;
  const by = (kind: string) => list.find((o) => o.kind === kind);
  const chosen = (answer === "allow" ? by("allow_once") : undefined) ?? by("reject_once") ?? by("reject_always");
  return chosen ? { outcome: { outcome: "selected", optionId: chosen.optionId } } : cancelled;
}

/** The Gate for one ACP permission request: what the agent is about to do, shown as it sent it.
 *  An `execute` is a command (the same command analysis as every other Runner's: only the
 *  command field itself is analysed, never the agent's title for it, so a command GovernCode
 *  cannot read always asks); `edit`, `delete` and `move` are file changes; any other kind is a
 *  step of its own kind. */
export function permissionGate(agent: string, params: any, id: string): GateRequest {
  let tc = params?.toolCall && typeof params.toolCall === "object" ? params.toolCall : null;
  // No tool call at all is not a call of kind "other": it is something GovernCode cannot show.
  const kind = tc && typeof tc.kind === "string" ? tc.kind : tc ? "other" : "unknown tool";
  if (!tc) tc = {};
  const raw = tc.rawInput !== null && typeof tc.rawInput === "object" && !Array.isArray(tc.rawInput) ? tc.rawInput as Record<string, unknown> : {};
  const title = typeof tc.title === "string" ? tc.title.slice(0, 500) : null;
  const locations = Array.isArray(tc.locations) ? tc.locations.map((l: any) => (l && typeof l.path === "string" ? l.path : String(l))).slice(0, 50) : [];
  let tool: string, input: Record<string, unknown>;
  if (kind === "execute") {
    tool = `${agent} command`;
    const command = typeof raw.command === "string" || (Array.isArray(raw.command) && raw.command.every((w) => typeof w === "string")) ? raw.command : null;
    input = { command, ...(typeof raw.cwd === "string" ? { cwd: raw.cwd } : {}), ...(title ? { title } : {}), input: raw };
  } else if (kind === "edit" || kind === "delete" || kind === "move") {
    tool = `${agent} fileChange`;
    input = { kind, ...(title ? { title } : {}), locations, input: raw };
  } else {
    tool = /^[a-z_]{1,40}$/.test(kind) ? `${agent}_${kind}` : `${agent} unknown tool`;
    input = { ...(title ? { title } : {}), locations, input: raw };
  }
  return { id, tool, input, canonical: canonical({ tool, input }) };
}

/**
 * A run's token use from `turn_completed` updates ({ usage: { inputTokens, outputTokens,
 * totalTokens, ... } }), summed over the run's turns (a subagent's turn is one more). A run with
 * no update reports null; a run that did not end normally, or sent an update that could not be
 * read, reports what it saw with `complete: false` (a floor: a token budget holds on it).
 */
export function acpTokenTally() {
  let totalTokens = 0, inputTokens = 0, outputTokens = 0, turns = 0, malformed = false, empty = false;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_RUN_TOKENS) : null);
  return {
    add(update: any): void {
      const u = update?.usage;
      const inp = n(u?.inputTokens), out = n(u?.outputTokens);
      const total = n(u?.totalTokens) ?? (inp !== null && out !== null ? inp + out : null);
      if (total === null || inp === null || out === null) { malformed = true; return; }
      if (total === 0) empty = true;   // a turn that reports nothing used is not believed
      turns++;
      totalTokens = Math.min(totalTokens + total, MAX_RUN_TOKENS); inputTokens = Math.min(inputTokens + inp, MAX_RUN_TOKENS); outputTokens = Math.min(outputTokens + out, MAX_RUN_TOKENS);
    },
    usage(endedNormally: boolean) {
      return turns || malformed ? { totalTokens, inputTokens, outputTokens, complete: endedNormally && !malformed && !empty } : null;
    },
  };
}

export const CLIENT_INFO = { name: "governcode", title: "GovernCode", version: "0.1.0" };

/**
 * One ACP turn on a started agent: initialize, a session in `cwd`, one prompt. Text and steps
 * stream to the hooks; every permission request of that session, while the prompt runs, is a
 * Gate (at most `maxGates` per run, then rejected); a Gate unanswered after `gateTimeoutMs`, or
 * still waiting when the run is stopped or the prompt has ended, is rejected. Requests
 * GovernCode does not offer (the client file system, terminals, an agent's own questions) are
 * refused with an error, never granted by silence. Resolves with the result for `hooks.done`
 * (the caller reports it, after its own cleanup).
 */
export async function runAcpTurn(o: { rpc: AcpRpc; agent: string; cwd: string; prompt: string; hooks: TurnHooks; signal?: AbortSignal;
  gateTimeoutMs?: number; maxGates?: number }): Promise<{ ok: boolean; summary: string; usage: unknown }> {
  const { rpc } = o;
  const tokens = acpTokenTally();
  let asked = 0;
  let stopped: string | null = null;
  let sessionId = "";
  let prompting = false;            // between session/prompt sent and its answer: the only time a Gate can allow
  let ended = false;                // the prompt has been answered (or failed): nothing more is this run's
  const gateTimeout = o.gateTimeoutMs ?? 60 * 60_000;   // ponytail: a backstop; the turn's end stops a Runner's Gates before this
  const pending = new Set<() => void>();
  const drain = () => { for (const p of pending) p(); };
  rpc.onRequest(async (method, params) => {
    if (method !== "session/request_permission") throw new Error(`GovernCode does not answer ${method}`);
    const mine = prompting && stopped === null && typeof params?.sessionId === "string" && params.sessionId === sessionId;
    if (!mine) return pickOption(params?.options, "deny");
    const req = permissionGate(o.agent, params, `${o.agent}-${Date.now()}-${asked}`);
    if (++asked > (o.maxGates ?? 200)) return pickOption(params?.options, "deny");
    // The user's answer, unless the run is stopped, the prompt has ended or the Gate has waited
    // too long: then rejected. Checked again after the wait: an allow that arrives late is not one.
    const answer = await new Promise<"allow" | "deny">((res) => {
      let done = false;
      const settle = (a: "allow" | "deny") => { if (done) return; done = true; clearTimeout(timer); pending.delete(onEnd); res(a); };
      const onEnd = () => settle("deny");
      const timer = setTimeout(onEnd, gateTimeout);
      pending.add(onEnd);
      o.hooks.gate(req).then(settle, () => settle("deny"));
    });
    return pickOption(params?.options, answer === "allow" && prompting && stopped === null ? "allow" : "deny");
  });
  let said = 0;   // a Runner's words reach the record up to a size; a flood does not fill govd
  rpc.onNotify((method, params) => {
    if (method !== "session/update" && method !== "_x.ai/session/update") return;
    if (!sessionId || params?.sessionId !== sessionId || ended) return;   // another session's, or after the turn: not this run's
    const u = params?.update;
    if (!u || typeof u !== "object") return;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && typeof u.content.text === "string" && (said += Buffer.byteLength(u.content.text)) <= 1_000_000) o.hooks.text(u.content.text);
    if (u.sessionUpdate === "tool_call") o.hooks.tool(`${o.agent} ${typeof u.kind === "string" ? u.kind : "tool"}${typeof u.title === "string" ? `: ${u.title.slice(0, 60)}` : ""}`, {});
    if (u.sessionUpdate === "turn_completed") tokens.add(u);
  });
  let closer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    stopped = String(o.signal?.reason ?? "aborted");
    drain();
    if (sessionId) rpc.notify("session/cancel", { sessionId });
    // The agent should answer the prompt with "cancelled" now; if it does not, it is ended.
    closer = setTimeout(() => rpc.close(), 10_000); closer.unref();
  };
  if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener("abort", onAbort, { once: true });
  const stoppedResult = () => ({ ok: false, summary: `stopped: ${stopped}`, usage: tokens.usage(false) });
  try {
    const init = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO }, 60_000);
    if (init?.protocolVersion !== 1) throw new Error(`the agent speaks ACP version ${JSON.stringify(init?.protocolVersion ?? null)}, not 1`);
    const s = await rpc.request("session/new", { cwd: o.cwd, mcpServers: [] }, 60_000);
    if (!s || typeof s.sessionId !== "string" || !s.sessionId) throw new Error("the agent opened no session");
    sessionId = s.sessionId;
    if (stopped !== null) { rpc.notify("session/cancel", { sessionId }); return stoppedResult(); }
    prompting = true;
    const r = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: o.prompt }] });
    prompting = false;
    drain();
    const reason = typeof r?.stopReason === "string" ? r.stopReason : "unknown";
    if (stopped !== null) return stoppedResult();
    return reason === "end_turn" ? { ok: true, summary: "done", usage: tokens.usage(true) }
      : { ok: false, summary: `${o.agent} stopped: ${reason}`, usage: tokens.usage(false) };
  } catch (e) {
    if (stopped !== null) return stoppedResult();
    return { ok: false, summary: `${o.agent}: ${e instanceof Error ? e.message : e}`, usage: tokens.usage(false) };
  } finally {
    prompting = false;
    ended = true;
    drain();
    clearTimeout(closer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}
