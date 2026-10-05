// A generic ACP client (the Agent Client Protocol: JSON-RPC 2.0 over the agent's stdio), for
// Runners whose tool speaks it (Grok first). GovernCode is the client: it starts the agent under
// govern-sup, runs initialize, session/new and one session/prompt, and answers the agent's
// `session/request_permission` from the user's Gate. Only two answers are ever given: the
// agent's "allow once" option, or a rejection; "allow always" is never chosen, so every call asks
// again. Token use comes from the agent's `turn_completed` update (an xAI extension, which Grok
// 1.0.46 sends on `_x.ai/session_notification`) and from the prompt's own answer (ACP's `usage`,
// or the totals in xAI's `_meta`); a plain ACP agent may report none. A stop from outside sends
// `session/cancel` and then ends the process; an agent that dies ends the turn with its last
// words on stderr.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { canonical, type GateRequest, type TurnHooks } from "./claude.ts";
import { MAX_RUN_TOKENS } from "./codex.ts";

export type AcpOutputBudget = { maxBytes: number };
export class AcpOutputBudgetError extends Error {
  readonly code = "ACP_OUTPUT_BUDGET_EXCEEDED";
  readonly limitBytes: number;
  readonly stream: "stdout" | "stderr";
  constructor(limitBytes: number, stream: "stdout" | "stderr") {
    super("ACP output byte budget exceeded");
    this.limitBytes = limitBytes; this.stream = stream;
  }
}

export type AcpRpc = {
  /** Internal opt-in observation; only local accounting can latch this failure. */
  outputBudget?: { readonly failure: AcpOutputBudgetError | null; readonly settled: Promise<AcpOutputBudgetError | null> };
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params: unknown): void;
  onRequest(f: (method: string, params: any) => Promise<unknown>): void;
  onNotify(f: (method: string, params: any) => void): void;
  /** Ends the agent: stdin closed, SIGTERM to its process group, SIGKILL after `killAfterMs`.
   *  Nothing happens once the sandbox has closed (a process group id could have been reused). */
  close(killAfterMs?: number): void;
  /** Resolves with the tail of stderr once the process has exited (or could not start). */
  exited: Promise<string>;
  /** Resolves once the supervisor and its stdio have closed. This alone does not prove
   *  descendant death: SIGKILL can interrupt govern-sup's collection of detached children. */
  closed: Promise<number | null>;
};

const isId = (v: unknown) => typeof v === "number" || typeof v === "string";
const MAX_LINE = 8 * 1024 * 1024;   // larger than any real message; a longer line is dropped, never held whole
/** An agent may echo a numeric id back as its decimal string: the same id. */
const sameId = (v: unknown): number | null => typeof v === "number" ? v : typeof v === "string" && /^(0|[1-9][0-9]{0,14})$/.test(v) ? Number(v) : null;

// Validate descriptors without executing configuration accessors. Proxy traps and any
// reflection errors are refused with the same local diagnostic, without a nested cause.
function outputLimit(o: object): number | undefined {
  try {
    if (types.isProxy(o)) throw null;
    const option = Object.getOwnPropertyDescriptor(o, "outputBudget");
    if (!option) {
      // Walk descriptors rather than using `in`: an ordinary object's prototype can
      // itself be a Proxy whose membership trap would otherwise execute here.
      for (let proto = Object.getPrototypeOf(o); proto !== null; proto = Object.getPrototypeOf(proto)) {
        if (types.isProxy(proto) || Object.getOwnPropertyDescriptor(proto, "outputBudget")) throw null;
      }
      return undefined;
    }
    if (!("value" in option)) throw null;
    const budget = option.value;
    if (budget === undefined) return undefined;
    if (!budget || typeof budget !== "object" || types.isProxy(budget) || Array.isArray(budget)) throw null;
    const proto = Object.getPrototypeOf(budget);
    if (proto !== Object.prototype && proto !== null) throw null;
    const keys = Reflect.ownKeys(budget);
    if (keys.length !== 1 || keys[0] !== "maxBytes") throw null;
    const value = Object.getOwnPropertyDescriptor(budget, "maxBytes");
    if (!value || !("value" in value) || !Number.isSafeInteger(value.value) || value.value < 1 || value.value > 1_048_576) throw null;
    return value.value;
  } catch { throw new Error("Invalid ACP output budget configuration"); }
}

type AcpNative = { spawn: typeof spawn; kill: typeof process.kill };
/** Starts `bin args...` under govern-sup and speaks JSON-RPC 2.0 over its stdio.
 * The optional native seam is for invented transport fixtures, never daemon configuration. */
export function startAcp(o: { supervisor: string; policyFile: string; bin: string; args: string[]; env: Record<string, string>; cwd: string;
  outputBudget?: AcpOutputBudget }, native: AcpNative = { spawn, kill: process.kill }): AcpRpc {
  const limit = outputLimit(o); // immutable copy, validated before any spawn attempt
  const child = native.spawn(o.supervisor, ["run", "--policy", o.policyFile, "--", o.bin, ...o.args], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderr = "", stderrBytes = Buffer.alloc(0);
  let gone = false;                 // exited, or never started
  let failure: AcpOutputBudgetError | null = null, admitted = 0;
  let settleBudget!: (error: AcpOutputBudgetError | null) => void;
  const outputBudget = limit === undefined ? undefined : {
    get failure() { return failure; },
    settled: new Promise<AcpOutputBudgetError | null>((resolve) => { settleBudget = resolve; }),
  };
  let next = 1;
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void; timer?: NodeJS.Timeout }>();
  const failAll = (why: string) => {
    for (const w of waiting.values()) { clearTimeout(w.timer); w.fail(failure ?? new Error(why)); }
    waiting.clear();
  };
  let onReq: (method: string, params: any) => Promise<unknown> = async (m) => { throw new Error(`GovernCode does not answer ${m}`); };
  let onNote: (method: string, params: any) => void = () => {};
  const send = (obj: unknown) => {
    if (failure || gone || !child.stdin?.writable) return;
    const line = JSON.stringify({ jsonrpc: "2.0", ...(obj as object) }) + "\n";
    if (!failure && !gone && child.stdin?.writable) child.stdin.write(line);
  };
  // One message per line, JSON-RPC 2.0 only; malformed envelopes and overlong lines are ignored.
  let buf = "", dropping = false;
  let decoder = limit === undefined ? undefined : new StringDecoder("utf8");
  const onLine = (line: string) => {
    if (failure) return;
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (failure || !m || typeof m !== "object" || Array.isArray(m) || m.jsonrpc !== "2.0") return;
    if (m.params !== undefined && (m.params === null || typeof m.params !== "object")) return;
    if ("method" in m && ("result" in m || "error" in m)) return;
    if (isId(m.id) && typeof m.method === "string") {
      onReq(m.method, m.params ?? {}).then((result) => {
        if (!failure) send({ id: m.id, result: result ?? null });
      }, (e) => {
        if (!failure) send({ id: m.id, error: { code: -32601, message: String(e instanceof Error ? e.message : e).slice(0, 300) } });
      });
    } else if (sameId(m.id) !== null && !("method" in m)) {
      const w = waiting.get(sameId(m.id)!); waiting.delete(sameId(m.id)!);
      if (!w) return;
      clearTimeout(w.timer);
      const hasResult = "result" in m, hasError = "error" in m;
      if (hasError === hasResult) w.fail(new Error("the agent sent a malformed reply"));
      else if (hasError) w.fail(Object.assign(new Error(String(m.error?.message ?? "agent error").slice(0, 300)), { code: m.error?.code }));
      else w.ok(m.result);
    } else if (m.id === undefined && typeof m.method === "string") onNote(m.method, m.params ?? {});
  };
  const consume = (chunk: string) => {
    let rest = chunk;
    while (rest.length && !failure) {
      const nl = rest.indexOf("\n");
      if (nl < 0) {
        if (!dropping) { buf += rest; if (buf.length > MAX_LINE) { buf = ""; dropping = true; } }
        return;
      }
      const head = rest.slice(0, nl); rest = rest.slice(nl + 1);
      if (dropping) { dropping = false; continue; }
      const line = buf + head; buf = "";
      if (!failure && line.length <= MAX_LINE) onLine(line);
      // A callback can breach reentrantly; the next loop iteration must do no work.
    }
  };
  let killer: NodeJS.Timeout | undefined, over = false, stopping = false;
  const stop = (killAfterMs = 60_000) => {
    if (over || !child.pid || (limit !== undefined && stopping)) return;
    stopping = true;
    child.stdin?.end();
    try { native.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    // SIGKILL may interrupt descendant collection; closed is not descendant-death proof.
    if (!killer) { killer = setTimeout(() => { if (!over) { try { native.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } } }, killAfterMs); killer.unref(); }
  };
  const admit = (chunk: Buffer, stream: "stdout" | "stderr") => {
    if (failure) return false;
    if (chunk.length > limit! - admitted) {
      failure = new AcpOutputBudgetError(limit!, stream);
      settleBudget(failure);
      failAll(failure.message);
      buf = ""; dropping = false; decoder = undefined;
      // Destroy endpoints instead of continuing to allocate and drain peer output.
      child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
      stop();
      return false;
    }
    admitted += chunk.length;
    return true;
  };
  // An agent that dies can turn a write into EPIPE. Destruction must not raise an
  // unhandled stream error; opted-in output endpoint errors are also observed.
  child.stdin?.on("error", () => {});
  if (limit === undefined) {
    child.stderr?.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", consume);
  } else {
    child.stdout!.on("error", () => {}); child.stderr?.on("error", () => {});
    child.stdout!.on("data", (chunk: Buffer) => { if (admit(chunk, "stdout")) consume(decoder!.write(chunk)); });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!admit(chunk, "stderr")) return;
      // Copy slices: a small retained tail must not keep a large backing Buffer alive.
      const keep = Math.min(4096, limit);
      if (chunk.length >= keep) stderrBytes = Buffer.from(chunk.subarray(chunk.length - keep));
      else stderrBytes = Buffer.concat([stderrBytes.subarray(Math.max(0, stderrBytes.length + chunk.length - keep)), chunk]);
    });
  }
  // A raw tail cut inside a UTF-8 sequence may begin with a replacement character.
  const diagnostic = () => failure?.message ?? (limit === undefined ? stderr : stderrBytes.toString("utf8"));
  const tail = () => diagnostic().trim().split("\n").slice(-2).join(" | ").slice(0, 300);
  let onExit: (s: string) => void = () => {}, onClose: (c: number | null) => void = () => {};
  const exited = new Promise<string>((res) => (onExit = res));
  const closed = new Promise<number | null>((res) => (onClose = res));
  child.on("exit", (code) => { gone = true; failAll(failure?.message ?? `the agent exited (${code ?? "signal"}): ${tail()}`); onExit(diagnostic()); });
  child.on("error", (e) => {
    // Once pipes have produced enough data to breach, an error is not evidence of
    // process exit or stdio closure. Keep the stop timer until native lifecycle events.
    if (failure) { failAll(failure.message); return; }
    gone = true;
    stderr = e.message;
    failAll(`the agent did not start: ${e.message}`);
    onExit(stderr); onClose(null);
    if (outputBudget) settleBudget(null);
  });
  child.on("close", (code) => { onClose(code); if (!failure && outputBudget) settleBudget(null); });
  void closed.then(() => { over = true; clearTimeout(killer); });
  return {
    ...(outputBudget ? { outputBudget } : {}),
    request: (method, params, timeoutMs) => new Promise((ok, fail) => {
      if (failure) return fail(failure);
      if (gone) return fail(new Error(`the agent is gone: ${tail()}`));
      const id = next++;
      const timer = timeoutMs ? setTimeout(() => { waiting.delete(id); fail(failure ?? new Error(`${method}: no answer in ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs) : undefined;
      waiting.set(id, { ok, fail, timer });
      send({ id, method, params });
    }),
    notify: (method, params) => send({ method, params }),
    onRequest: (f) => (onReq = f),
    onNotify: (f) => (onNote = f),
    close: stop,
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
 *  cannot read always asks); `edit`, `delete` and `move` are file changes; any other call is a
 *  step named after the agent's own name for its tool (Grok's `variant`), else after its kind, so
 *  allowing one tool never covers another. A call of kind `other` with no name of its own is
 *  something GovernCode cannot name: it always asks. */
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
    // Capitalised, as Grok's are, so a name can never read as a kind (`grok_read`).
    const variant = typeof raw.variant === "string" && /^[A-Z][A-Za-z0-9]{0,29}$/.test(raw.variant) ? raw.variant : null;
    tool = variant ? `${agent}_${variant}` : kind !== "other" && /^[a-z_]{1,30}$/.test(kind) ? `${agent}_${kind}` : `${agent} unknown tool`;
    input = { kind, ...(title ? { title } : {}), locations, input: raw };
  }
  // Only the existing Grok adapter supplies this host-owned command semantic. Agent metadata
  // and display labels never author it; other ACP adapters still need justified local semantics.
  return { id, tool, input, canonical: canonical({ tool, input }),
    ...(agent === "grok" && kind === "execute" ? { base: "acp command" } : {}) };
}

/**
 * A run's token use from `turn_completed` updates ({ usage: { inputTokens, outputTokens,
 * totalTokens, ... } }), summed over the run's turns (a subagent's turn is one more; an update
 * with a `prompt_id` and figures already counted is the same turn sent twice). The prompt's own answer may
 * carry the run's totals too (`prompt`): each figure is then the larger of the two, never their
 * sum. A run with no report reports null; a run that did not end normally, or sent a report that
 * could not be read, reports what it saw with `complete: false` (a floor: a token budget holds on it).
 */
export function acpTokenTally() {
  let totalTokens = 0, inputTokens = 0, outputTokens = 0, turns = 0, malformed = false, empty = false;
  let answer: { totalTokens: number; inputTokens: number; outputTokens: number } | null = null;
  const counted = new Set<string>();
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_RUN_TOKENS) : null);
  const read = (u: any) => {
    const inp = n(u?.inputTokens), out = n(u?.outputTokens);
    const suppliedTotal = u?.totalTokens, declaredTotal = n(suppliedTotal);
    // Omission permits component fallback; an unreadable supplied total leaves only a floor.
    if (suppliedTotal !== undefined && declaredTotal === null) malformed = true;
    const total = declaredTotal ?? (inp !== null && out !== null ? inp + out : null);
    return total === null || inp === null || out === null ? null : { totalTokens: total, inputTokens: inp, outputTokens: out };
  };
  return {
    add(update: any): void {
      const u = read(update?.usage);
      if (!u) { malformed = true; return; }
      // The same turn sent again: the same prompt and the same figures (a report that differs counts).
      const key = typeof update?.prompt_id === "string" ? `${update.prompt_id}|${u.totalTokens}|${u.inputTokens}|${u.outputTokens}` : null;
      if (key) { if (counted.has(key)) return; counted.add(key); }
      if (u.totalTokens === 0) empty = true;   // a turn that reports nothing used is not believed
      turns++;
      totalTokens = Math.min(totalTokens + u.totalTokens, MAX_RUN_TOKENS); inputTokens = Math.min(inputTokens + u.inputTokens, MAX_RUN_TOKENS); outputTokens = Math.min(outputTokens + u.outputTokens, MAX_RUN_TOKENS);
    },
    /** The prompt's answer: ACP's `usage`, else xAI's totals in `_meta`. Neither is no report. */
    prompt(result: any): void {
      const u = result?.usage ?? (result?._meta && typeof result._meta === "object" && "totalTokens" in result._meta ? result._meta : undefined);
      if (u === undefined) return;
      answer = read(u);
      if (!answer) malformed = true;
      else if (answer.totalTokens === 0) empty = true;
    },
    usage(endedNormally: boolean) {
      if (!turns && !answer && !malformed) return null;
      const a = answer ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
      return { totalTokens: Math.max(totalTokens, a.totalTokens), inputTokens: Math.max(inputTokens, a.inputTokens), outputTokens: Math.max(outputTokens, a.outputTokens),
        complete: endedNormally && !malformed && !empty };
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
  gateTimeoutMs?: number; maxGates?: number; promptTimeoutMs?: number }): Promise<{ ok: boolean; summary: string; usage: unknown; limit?: { resetsAt: string | null } }> {
  const { rpc } = o;
  const tokens = acpTokenTally();
  let asked = 0;
  let stopped: string | null = null;
  const cancelled = Symbol("ACP turn cancelled");
  let interrupt!: (value: typeof cancelled) => void;
  const interrupted = new Promise<typeof cancelled>((resolve) => { interrupt = resolve; });
  const checkStopped = () => { if (stopped !== null) throw cancelled; };
  // Cancellation can finish preparation without waiting for the peer. The race observes
  // late rejections too; its final check gives cancellation priority over either reply.
  const preflight = async (method: string, params: unknown) => {
    checkStopped();
    try {
      return await Promise.race([rpc.request(method, params, 60_000), interrupted]);
    } finally { checkStopped(); }
  };
  let sessionId = "";
  let prompting = false;            // between session/prompt sent and its answer: the only time a Gate can allow
  let ended = false;                // the prompt has been answered (or failed): nothing more is this run's
  const gateTimeout = o.gateTimeoutMs ?? 60 * 60_000;   // ponytail: a backstop; the turn's end stops a Runner's Gates before this
  const pending = new Set<() => void>();
  const drain = () => { for (const p of pending) p(); };
  let said = 0;   // a Runner's words and steps reach the hooks up to a budget of bytes; a flood does not fill govd
  const within = (s: string) => (said += Buffer.byteLength(s)) <= 1_000_000;
  // The agent streams its words in pieces of a few characters; they reach the hooks whole, before
  // its next step or Gate and at the end of the turn. A long message goes in parts of a few
  // thousand characters, cut at a line or a space.
  let words = "";
  const say = (w: string) => { if (w && within(w)) o.hooks.text(w); };
  const flush = () => { const w = words; words = ""; say(w); };
  const flushLong = () => {
    if (words.length < 4000) return;
    let cut = words.lastIndexOf("\n");
    if (cut <= 0) cut = words.lastIndexOf(" ");
    if (cut <= 0) return flush();
    const w = words.slice(0, cut); words = words.slice(cut + 1); say(w);
  };
  rpc.onRequest(async (method, params) => {
    if (method !== "session/request_permission") throw new Error(`GovernCode does not answer ${method}`);
    const mine = prompting && stopped === null && typeof params?.sessionId === "string" && params.sessionId === sessionId;
    if (!mine) return pickOption(params?.options, "deny");
    flush();
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
  rpc.onNotify((method, params) => {
    // xAI's own channel carries only token use here; it may leave the session out, and a turn
    // counted that should not have been can only make a budget stricter.
    const xai = method === "_x.ai/session_notification";
    if (method !== "session/update" && method !== "_x.ai/session/update" && !xai) return;
    if (!sessionId || ended) return;   // after the turn: not this run's
    if (params?.sessionId !== sessionId && !(xai && params?.sessionId === undefined)) return;   // another session's
    const u = params?.update;
    if (!u || typeof u !== "object") return;
    if (u.sessionUpdate === "turn_completed") tokens.add(u);
    if (xai) return;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && typeof u.content.text === "string") {
      words += u.content.text;
      flushLong();
    }
    if (u.sessionUpdate === "tool_call") {
      flush();
      const step = `${o.agent} ${typeof u.kind === "string" ? u.kind : "tool"}${typeof u.title === "string" ? `: ${u.title.slice(0, 60)}` : ""}`;
      if (within(step)) o.hooks.tool(step, {});
    }
  });
  let closer: NodeJS.Timeout | undefined;
  let closeFailed = false;
  const onAbort = () => {
    if (stopped !== null) return;
    stopped = String(o.signal?.reason ?? "aborted");
    interrupt(cancelled);
    drain();
    if (!prompting) {
      try { rpc.close(); } catch { closeFailed = true; }
      return;
    }
    rpc.notify("session/cancel", { sessionId });
    // The agent should answer the prompt with "cancelled" now; if it does not, it is ended.
    closer = setTimeout(() => rpc.close(), 10_000); closer.unref();
  };
  const stoppedResult = () => ({ ok: false, summary: closeFailed ? "stopped: ACP close request failed" : `stopped: ${stopped}`, usage: tokens.usage(false) });
  try {
    if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener("abort", onAbort, { once: true });
    const init = await preflight("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO });
    checkStopped();
    if (init?.protocolVersion !== 1) throw new Error(`the agent speaks ACP version ${JSON.stringify(init?.protocolVersion ?? null)}, not 1`);
    const s = await preflight("session/new", { cwd: o.cwd, mcpServers: [] });
    checkStopped();
    const id = s?.sessionId;
    if (typeof id !== "string" || !id) throw new Error("the agent opened no session");
    // No await between this last admission check and sending the prompt.
    checkStopped();
    sessionId = id;
    prompting = true;
    // The prompt has a deadline (a Runner is one job, not a service); past it the agent is ended.
    const r = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: o.prompt }] }, o.promptTimeoutMs ?? 2 * 60 * 60_000);
    prompting = false;
    tokens.prompt(r);
    drain();
    const reason = typeof r?.stopReason === "string" ? r.stopReason : "unknown";
    if (stopped !== null) return stoppedResult();
    return reason === "end_turn" ? { ok: true, summary: "done", usage: tokens.usage(true) }
      : { ok: false, summary: `${o.agent} stopped: ${reason}`, usage: tokens.usage(false) };
  } catch (e) {
    if (stopped !== null) return stoppedResult();
    if (prompting) { rpc.notify("session/cancel", { sessionId }); rpc.close(); }   // no answer in time: the process is ended (the caller waits for it to be gone)
    if (prompting && e instanceof Error && (e as Error & { code?: unknown }).code === -32003)
      return { ok: false, summary: `${o.agent} hit its rate limit`, limit: { resetsAt: null }, usage: tokens.usage(false) };
    return { ok: false, summary: `${o.agent}: ${e instanceof Error ? e.message : e}`, usage: tokens.usage(false) };
  } finally {
    prompting = false;
    flush();
    ended = true;
    drain();
    clearTimeout(closer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}
