// The main process's hold on govd: one control connection for calls, reconnecting while
// govd is down, and a fresh connection for every ask. An ask gets its own connection
// because govd ties that ask's Gates to it (the asker leaving denies them) and its events
// carry no request id.
import type { AskEvent, AskResult, Hello, Status, WatchEvent } from "../shared/contract.ts";
import { connect, GovdError, type Connection } from "./govd-client.ts";

// ponytail: fixed 3 s retry while govd is down; upgrade to backoff if it ever matters.
const RETRY_MS = 3000;

export class GovdLink {
  private conn: Connection | null = null;
  private current: Status;
  private listeners = new Set<(s: Status) => void>();
  private watchListeners = new Set<(w: WatchEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.current = { state: "connecting", socketPath: path };
  }

  status(): Status {
    return this.current;
  }

  onStatus(f: (s: Status) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** govd's live stream (Trace appends, Gate changes), when govd offers `watch`. */
  onWatch(f: (w: WatchEvent) => void): () => void {
    this.watchListeners.add(f);
    return () => this.watchListeners.delete(f);
  }

  private set(s: Status): void {
    this.current = s;
    for (const f of this.listeners) f(s);
  }

  /** Try now; on failure keep trying every few seconds until stopped. */
  async start(): Promise<Status> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.conn) return this.current;
    try {
      const c = await connect(this.path);
      const hello = await c.call<Hello>("hello", { client: "dashboard", protocol: 1 });
      if (hello.features.includes("watch")) {
        c.onEvent((e) => {
          const w = e as WatchEvent;
          if (w && (w.kind === "gates" || (w.kind === "trace" && typeof w.event?.seq === "number"))) for (const f of this.watchListeners) f(w);
        });
        await c.call("watch", {});
      }
      this.conn = c;
      c.onClose(() => {
        if (this.conn !== c) return;
        this.conn = null;
        this.set({ state: "down", socketPath: this.path, error: "govd stopped" });
        this.schedule();
      });
      this.set({ state: "up", socketPath: this.path, hello });
    } catch (err) {
      this.set({ state: "down", socketPath: this.path, error: err instanceof Error ? err.message : String(err) });
      this.schedule();
    }
    return this.current;
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.start(); }, RETRY_MS);
    this.timer.unref?.();
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    if (!this.conn) await this.start();
    if (!this.conn) throw new GovdError(this.current.state === "down" ? this.current.error : "govd is not connected");
    return this.conn.call<T>(method, params);
  }

  /** One ask on its own connection; events stream to `onEvent` until the result arrives. */
  async ask(params: { project: string | null; prompt: string }, onEvent: (e: AskEvent) => void): Promise<AskResult> {
    const c = await connect(this.path);
    try {
      c.onEvent((e) => { if (e && typeof e === "object" && typeof (e as AskEvent).kind === "string") onEvent(e as AskEvent); });
      return await c.call<AskResult>("ask", params);
    } finally {
      c.close();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.conn?.close();
    this.conn = null;
  }
}
