// A client of govd's Unix socket: JSON-RPC 2.0, one object per line, `event` notifications
// while an ask runs. The same pattern as packages/gov, with no Electron in it so it can be
// tested with node:test.
import { connect as netConnect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { Params } from "@governcode/protocol";
import { ASK_ID, isCallable, type Callable } from "../shared/contract.ts";

/** Where govd listens: the same resolution as packages/gov and packages/govd. */
export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = env.GOVERNCODE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "governcode");
  const runtimeDir = env.GOVERNCODE_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? stateDir, "governcode");
  return join(runtimeDir, "govd.sock");
}

export class GovdError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

export type Connection = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
};

/** Opens one connection. Rejects with a readable message if govd is not there. */
export function connect(path: string, timeoutMs = 3000): Promise<Connection> {
  return new Promise((ok, fail) => {
    const sock: Socket = netConnect(path);
    let next = 1;
    const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    let eventListener: (e: unknown) => void = () => {};
    const closeListeners: Array<() => void> = [];
    const timer = setTimeout(() => { sock.destroy(); fail(new GovdError(`govd did not answer at ${path}`)); }, timeoutMs);
    sock.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new GovdError(err.code === "ENOENT" || err.code === "ECONNREFUSED"
        ? `govd is not running (no socket at ${path})` : `cannot reach govd at ${path}: ${err.message}`));
    });
    sock.on("error", () => {}); // after connect, errors surface as close
    sock.on("close", () => {
      for (const w of waiting.values()) w.rej(new GovdError("govd closed the connection"));
      waiting.clear();
      for (const f of closeListeners) f();
    });
    // readline re-emits the socket's errors on itself (Node 26); the socket handlers above
    // deal with them, so this one only keeps them from becoming uncaught.
    const lines = createInterface({ input: sock });
    lines.on("error", () => {});
    lines.on("line", (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.method === "event") return eventListener(msg.params);
      const w = waiting.get(msg?.id);
      if (!w) return;
      waiting.delete(msg.id);
      if (msg.error) w.rej(new GovdError(String(msg.error.message ?? "error"), msg.error.code));
      else w.res(msg.result);
    });
    sock.once("connect", () => {
      clearTimeout(timer);
      ok({
        call: (method, params = {}) => new Promise((res, rej) => {
          if (!sock.writable) return rej(new GovdError("govd connection is closed"));
          const id = next++;
          waiting.set(id, { res, rej });
          sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        }),
        onEvent: (f) => { eventListener = f; },
        onClose: (f) => { closeListeners.push(f); },
        close: () => { sock.end(); },
      });
    });
  });
}

/**
 * The trust boundary on the main side: only allowlisted methods, with parameters that pass
 * the protocol's own schemas. govd validates again; this keeps a compromised renderer from
 * reaching anything the Dashboard does not use.
 */
export function checkCall(method: unknown, params: unknown): { method: Callable; params: unknown } {
  if (!isCallable(method)) throw new GovdError(`the Dashboard does not call ${String(method)}`);
  const parsed = Params[method].safeParse(params ?? {});
  if (!parsed.success) throw new GovdError(parsed.error.issues.map((i) => i.message).join("; "));
  return { method, params: parsed.data };
}

export function checkConnect(streamId: unknown, tool: unknown): { streamId: string; params: { tool: "agy" } } {
  if (typeof streamId !== "string" || !ASK_ID.test(streamId)) throw new GovdError("bad stream id");
  const parsed = Params["connect.start"].safeParse({ tool });
  if (!parsed.success) throw new GovdError(parsed.error.issues.map((i) => i.message).join("; "));
  return { streamId, params: parsed.data };
}

export function checkAsk(askId: unknown, project: unknown, prompt: unknown): { askId: string; params: { project: string | null; prompt: string } } {
  if (typeof askId !== "string" || !ASK_ID.test(askId)) throw new GovdError("bad ask id");
  const parsed = Params.ask.safeParse({ project, prompt });
  if (!parsed.success) throw new GovdError(parsed.error.issues.map((i) => i.message).join("; "));
  return { askId, params: parsed.data };
}
