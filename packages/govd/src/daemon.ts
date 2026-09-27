// govd: the daemon. A Unix socket in a 0700 directory, JSON-RPC 2.0 one object per line.
// Sandboxed AI tools cannot open Unix sockets at all (docs/SANDBOX.md, invariant 5), so every
// connection here is the user (the CLI now, apps later).
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, existsSync, statSync, chmodSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Errors, FEATURES, PROTOCOL, Params, Request, RpcError, type Method } from "@governcode/protocol";
import { Ledger } from "./ledger.ts";
import { runTurn } from "./claude.ts";

export type DaemonOptions = { socketPath: string; ledgerPath: string; policyDir: string; supervisor: string; version: string };

export class Daemon {
  readonly ledger: Ledger;
  private server?: Server;
  private sockets = new Set<Socket>();
  private sandboxOk = false;
  private sandboxReason = "self-test not run";

  private opts: DaemonOptions;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.ledger = new Ledger(opts.ledgerPath);
  }

  /** Fail closed: no AI tool starts until the sandbox self-test passes on this machine. */
  selftest(): { ok: boolean; reason: string } {
    const r = spawnSync(this.opts.supervisor, ["selftest", "--json"], { encoding: "utf8", timeout: 60_000 });
    this.sandboxOk = r.status === 0;
    this.sandboxReason = this.sandboxOk ? "self-test passed" : (r.error?.message ?? (r.stderr || r.stdout || "failed").trim().slice(-500));
    return { ok: this.sandboxOk, reason: this.sandboxReason };
  }

  async listen(): Promise<void> {
    const dir = resolve(this.opts.socketPath, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    if (existsSync(this.opts.socketPath)) rmSync(this.opts.socketPath);
    this.server = createServer((sock) => this.serve(sock));
    await new Promise<void>((ok) => this.server!.listen(this.opts.socketPath, ok));
    chmodSync(this.opts.socketPath, 0o600);
  }

  close(): void {
    for (const s of this.sockets) s.destroy();
    this.server?.close();
    this.ledger.close();
  }

  private serve(sock: Socket): void {
    this.sockets.add(sock);
    sock.on("close", () => this.sockets.delete(sock));
    const write = (obj: unknown) => sock.writable && sock.write(JSON.stringify(obj) + "\n");
    const pendingGates = new Map<string, (a: "allow" | "deny") => void>();
    sock.on("close", () => { for (const answer of pendingGates.values()) answer("deny"); });
    createInterface({ input: sock }).on("line", async (line) => {
      let id: number | string | null = null;
      try {
        const req = Request.parse(JSON.parse(line));
        id = req.id;
        if (req.method === "gate.answer") {
          const p = req.params as { id?: string; answer?: string };
          const answer = pendingGates.get(String(p?.id));
          if (!answer || (p.answer !== "allow" && p.answer !== "deny")) throw new RpcError(Errors.notFound, "no such Gate on this connection");
          pendingGates.delete(String(p.id));
          answer(p.answer);
          return write({ jsonrpc: "2.0", id, result: { ok: true } });
        }
        if (!(req.method in Params)) throw new RpcError(Errors.unknownMethod, `unknown method ${req.method}`);
        const method = req.method as Method;
        const parsed = Params[method].safeParse(req.params ?? {});
        if (!parsed.success) throw new RpcError(Errors.badParams, parsed.error.issues.map((i) => i.message).join("; "));
        const result = await this.call(method, parsed.data as never, (n) => write({ jsonrpc: "2.0", method: "event", params: n }), pendingGates);
        write({ jsonrpc: "2.0", id, result });
      } catch (err) {
        const code = err instanceof RpcError ? err.code : -32603;
        write({ jsonrpc: "2.0", id, error: { code, message: err instanceof Error ? err.message : String(err) } });
      }
    });
  }

  private async call(method: Method, p: any, notify: (n: unknown) => void, gates: Map<string, (a: "allow" | "deny") => void>): Promise<unknown> {
    const L = this.ledger;
    switch (method) {
      case "hello":
        return { server: "govd", version: this.opts.version, protocol: PROTOCOL, features: FEATURES,
          sandbox: { ok: this.sandboxOk, reason: this.sandboxReason } };
      case "project.list":
        return { projects: L.projects() };
      case "project.new": {
        const path = resolve(p.path);
        if (existsSync(path)) throw new RpcError(Errors.refused, `${path} already exists; use project.open`);
        mkdirSync(path, { recursive: true });
        if (p.git) execFileSync("git", ["init", "-q", "-b", "main", path]);
        return { project: L.addProject(p.name, path, "project.created") };
      }
      case "project.open": {
        const path = resolve(p.path);
        if (!existsSync(path) || !statSync(path).isDirectory()) throw new RpcError(Errors.notFound, `${path} is not a folder`);
        const name = p.name ?? path.split("/").pop()!.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
        return { project: L.addProject(name, path, "project.opened") };
      }
      case "controller.set":
        if (!L.project(p.project)) throw new RpcError(Errors.notFound, `no project ${p.project}`);
        L.setController(p.project, p.controller);
        return { ok: true };
      case "trace.list":
        return { events: L.events(p.project, p.limit) };
      case "ask":
        return this.ask(p.project, p.prompt, notify, gates);
    }
  }

  private ask(projectName: string | null, prompt: string, notify: (n: unknown) => void,
              gates: Map<string, (a: "allow" | "deny") => void>): Promise<unknown> {
    if (!this.sandboxOk) {
      this.ledger.append(projectName, "sandbox.refused", "govd", { reason: this.sandboxReason });
      throw new RpcError(Errors.refused, `sandbox not verified on this machine (${this.sandboxReason}); nothing was started`);
    }
    // ponytail: Home (no project) needs a read-only scratch worktree; phase 0 asks for a project.
    const project = projectName ? this.ledger.project(projectName) : undefined;
    if (!project) throw new RpcError(Errors.notFound, projectName ? `no project ${projectName}` : "phase 0 needs a project: gov open PATH");
    const actor = `controller · ${project.controller.provider}`;
    const L = this.ledger;
    L.append(project.name, "turn.started", "user", { prompt: prompt.slice(0, 2000), controller: project.controller });
    return new Promise((done) => {
      runTurn({
        supervisor: this.opts.supervisor, policyDir: this.opts.policyDir, worktree: project.path,
        controller: project.controller, prompt,
        hooks: {
          text: (t) => { notify({ kind: "text", text: t }); L.append(project.name, "turn.text", actor, { text: t.slice(0, 4000) }); },
          tool: (name, input) => { notify({ kind: "tool", name, input }); L.append(project.name, "turn.tool", actor, { name }); },
          gate: (req) => new Promise((answer) => {
            gates.set(req.id, (a) => {
              if (a === "deny") L.append(project.name, "gate.denied", "user", { tool: req.tool });
              answer(a);
            });
            notify({ kind: "gate", id: req.id, tool: req.tool, canonical: req.canonical });
          }),
          done: (r) => {
            L.append(project.name, r.ok ? "turn.completed" : "turn.failed", actor, { summary: r.summary.slice(0, 2000) });
            done(r);
          },
        },
      });
    });
  }
}
