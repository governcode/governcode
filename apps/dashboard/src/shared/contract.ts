// The Dashboard's IPC contract: the only doors between the renderer and the main process.
// The renderer never touches Node or govd's socket; it asks the main process, which checks
// every request here before anything reaches govd. Kept free of Node and Electron imports so
// the preload, the main process, the renderer and the tests can all share it.

/** Channel names on ipcMain / ipcRenderer. */
export const Channel = {
  call: "governcode:call",     // invoke: one govd method from the allowlist, returns its result
  ask: "governcode:ask",       // invoke: an ask on its own connection, returns the final result
  status: "governcode:status", // invoke: the current connection status
  retry: "governcode:retry",   // invoke: try to reach govd now
  pickFolder: "governcode:pick-folder", // invoke: the native folder picker; returns a path or null
  connect: "governcode:connect", // invoke: a tool's sign-in on its own connection; streams on `event`
  openSignIn: "governcode:open-sign-in", // invoke: open a sign-in link govd sent (only that exact link)
  event: "governcode:event",   // main -> renderer: one streamed ask event, tagged with its askId
  watch: "governcode:watch",   // main -> renderer: one govd watch event (Trace append, Gate change)
  statusChanged: "governcode:status-changed", // main -> renderer
} as const;

/**
 * The govd methods the renderer may call through `call`. `ask` has its own channel (it
 * streams, and it holds the connection that owns its Gates); `watch` is the main process's
 * own, forwarded as `onWatch`.
 */
export const CALLABLE = ["hello", "project.list", "project.new", "project.open", "controller.set", "gate.list",
  "gate.answer", "spec.list", "spec.diff", "spec.accept", "spec.discard", "trace.list", "turn.list", "turn.undo", "limits.list", "proposal.answer", "settings.get", "settings.set",
  "allows.list", "allows.revoke", "conversation.reset", "tools.list", "tools.disconnect", "connect.input", "connect.cancel"] as const;
export type Callable = (typeof CALLABLE)[number];

export function isCallable(m: unknown): m is Callable {
  return typeof m === "string" && (CALLABLE as readonly string[]).includes(m);
}

/** An askId names one ask's event stream; the renderer picks it, so it is checked. */
export const ASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Hello = { server: string; version: string; protocol: number; features: string[];
  sandbox: { ok: boolean; reason: string } };

export type Status =
  | { state: "connecting"; socketPath: string }
  | { state: "down"; socketPath: string; error: string }
  | { state: "up"; socketPath: string; hello: Hello };

/** One event streamed during an ask (govd's `event` notifications). */
export type AskEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input?: unknown }
  | { kind: "gate"; id: string; tool: string; canonical: string; covers?: string | null; scopes?: string[] }
  | { kind: "allowed"; tool: string; canonical?: string; why: string }
  | { kind: "spec"; id: string; to: string; brief: string }
  | { kind: "spec.text"; id: string; text: string }
  | { kind: "spec.tool"; id: string; name: string }
  | { kind: string; [k: string]: unknown };

export type TraceEvent = { seq: number; ts: string; project: string | null; kind: string; actor: string; data: Record<string, unknown> };

/** Pushed by govd to a watching connection: every Trace append, and "the Gates changed". */
export type WatchEvent = { kind: "trace"; event: TraceEvent } | { kind: "gates" };

export type AskResult = { ok: boolean; summary: string; [k: string]: unknown };

/** The result of any invoke: errors travel as data so the renderer gets govd's message intact. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string; code?: number };

/** What the preload exposes on `window.governcode`. Nothing else crosses the bridge. */
export type DashboardApi = {
  call<T = any>(method: Callable, params?: Record<string, unknown>): Promise<Outcome<T>>;
  ask(askId: string, project: string | null, prompt: string): Promise<Outcome<AskResult>>;
  status(): Promise<Status>;
  retry(): Promise<Status>;
  onEvent(listener: (askId: string, event: AskEvent) => void): () => void;
  onStatus(listener: (status: Status) => void): () => void;
  onWatch(listener: (event: WatchEvent) => void): () => void;
  pickFolder(): Promise<string | null>;
  /** Connect a tool: its sign-in's events arrive on onEvent under `streamId`. */
  connect(streamId: string, tool: string): Promise<Outcome<ConnectResult>>;
  /** Opens a sign-in link in the browser, only if govd sent exactly that link in a sign-in. */
  openSignIn(url: string): Promise<boolean>;
};
export type ConnectResult = { id: string; connected: boolean; note: string };
