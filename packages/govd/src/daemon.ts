// govd: the daemon. A Unix socket in a 0700 directory, JSON-RPC 2.0 one object per line.
// Sandboxed AI tools cannot connect to it: Landlock allows only the Unix sockets their
// policy names (or, on older kernels, seccomp refuses Unix sockets altogether), so every
// connection here is the user (the CLI now, apps later). docs/SANDBOX.md, invariant 5.
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, existsSync, statSync, chmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Errors, FEATURES, PROTOCOL, Params, ProjectName, Request, RpcError, type Method } from "@governcode/protocol";
import { gitGuard } from "./gitguard.ts";
import { Ledger } from "./ledger.ts";
import { runTurn, type TurnHooks } from "./claude.ts";
import { runCodexTurn, codexUsage } from "./codex.ts";
import { LimitGate, type UsageSource } from "./limits.ts";
import { openControllerSocket, accept, discard } from "./delegate.ts";
import { diff as specDiff, specPaths } from "./specstore.ts";
import { fileURLToPath } from "node:url";

const MCP_SCRIPT = fileURLToPath(new URL("./mcp-controller.ts", import.meta.url));

export type DaemonOptions = { socketPath: string; ledgerPath: string; policyDir: string; homeDir: string; supervisor: string; version: string };

// A Gate waiting for the user. Any user connection may answer it (all connections are the
// user: sandboxed tools cannot open Unix sockets); if the connection that asked goes away,
// its Gates are denied rather than left for a Controller to wait on forever.
type Gate = { id: string; project: string | null; tool: string; canonical: string; opened: string;
  owner: Socket; answer: (a: "allow" | "deny") => void };

export class Daemon {
  readonly ledger: Ledger;
  private server?: Server;
  private sockets = new Set<Socket>();
  private gates = new Map<string, Gate>();
  private limits = new LimitGate();
  private usage: Record<string, UsageSource> = {};
  private gateSeq = 0;
  private sandboxOk = false;
  private sandboxReason = "self-test not run";

  private opts: DaemonOptions;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.ledger = new Ledger(opts.ledgerPath);
    const stateDir = resolve(opts.ledgerPath, "..");
    this.usage = { codex: codexUsage({ supervisor: opts.supervisor, policyDir: opts.policyDir, stateDir, scratch: join(stateDir, "usage-scratch") }) };
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

  private stateDir(): string {
    return resolve(this.opts.ledgerPath, "..");
  }

  private specOr404(id: string) {
    const s = this.ledger.spec(id);
    if (!s) throw new RpcError(Errors.notFound, `no Spec ${id}`);
    return s;
  }

  private projectPath(name: string): string {
    const pr = this.ledger.project(name);
    if (!pr) throw new RpcError(Errors.notFound, `no project ${name}`);
    return pr.path;
  }

  /** A project folder becomes an AI tool's writable root, so some folders never can. */
  private checkProjectPath(path: string): void {
    const home = homedir();
    const state = resolve(this.opts.ledgerPath, "..");
    const runtime = resolve(this.opts.socketPath, "..");
    const never = ["/", home, state, runtime, ...[".ssh", ".gnupg", ".config", ".local", ".claude", ".aws", ".kube",
      ".docker", ".password-store"].map((d) => resolve(home, d))];
    const inside = (a: string, b: string) => a === b || a.startsWith(b + "/");
    if (never.some((n) => path === n) || [state, runtime, ...never.slice(3)].some((n) => inside(path, n)) || inside(state, path) || inside(runtime, path)) {
      throw new RpcError(Errors.refused, `${path} cannot be a project: an AI tool would get write access to it`);
    }
  }

  /** Home's Controller: the most recently chosen project Controller, else the default. */
  private homeController() {
    const all = this.ledger.projects();
    return all.length ? all[all.length - 1].controller : { provider: "claude-code" as const, model: "opus", effort: "high" as const };
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
    sock.on("close", () => { for (const g of [...this.gates.values()]) if (g.owner === sock) this.settle(g.id, "deny", "asker left"); });
    createInterface({ input: sock }).on("line", async (line) => {
      let id: number | string | null = null;
      try {
        const req = Request.parse(JSON.parse(line));
        id = req.id;
        if (!(req.method in Params)) throw new RpcError(Errors.unknownMethod, `unknown method ${req.method}`);
        const method = req.method as Method;
        const parsed = Params[method].safeParse(req.params ?? {});
        if (!parsed.success) throw new RpcError(Errors.badParams, parsed.error.issues.map((i) => i.message).join("; "));
        const result = await this.call(method, parsed.data as never, (n) => write({ jsonrpc: "2.0", method: "event", params: n }), sock);
        write({ jsonrpc: "2.0", id, result });
      } catch (err) {
        const code = err instanceof RpcError ? err.code : -32603;
        write({ jsonrpc: "2.0", id, error: { code, message: err instanceof Error ? err.message : String(err) } });
      }
    });
  }

  private settle(id: string, answer: "allow" | "deny", by: string): boolean {
    const g = this.gates.get(id);
    if (!g) return false;
    this.gates.delete(id);
    this.ledger.append(g.project, answer === "allow" ? "gate.allowed" : "gate.denied", "user", { gate: id, tool: g.tool, by });
    g.answer(answer);
    return true;
  }

  private async call(method: Method, p: any, notify: (n: unknown) => void, sock: Socket): Promise<unknown> {
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
        this.checkProjectPath(path);
        mkdirSync(path, { recursive: true });
        if (p.git) execFileSync("git", ["init", "-q", "-b", "main", path]);
        return { project: L.addProject(p.name, path, "project.created") };
      }
      case "project.open": {
        if (!existsSync(resolve(p.path)) || !statSync(resolve(p.path)).isDirectory()) throw new RpcError(Errors.notFound, `${resolve(p.path)} is not a folder`);
        const path = realpathSync(resolve(p.path));   // a symlink must not smuggle in another folder
        this.checkProjectPath(path);
        const name = p.name ?? path.split("/").pop()!.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "");
        if (!ProjectName.safeParse(name).success) throw new RpcError(Errors.badParams, `cannot derive a project name from ${path}; pass one`);
        return { project: L.addProject(name, path, "project.opened") };
      }
      case "controller.set":
        if (!L.project(p.project)) throw new RpcError(Errors.notFound, `no project ${p.project}`);
        L.setController(p.project, p.controller);
        return { ok: true };
      case "trace.list":
        return { events: L.events(p.project, p.limit) };
      case "ask":
        return this.ask(p.project, p.prompt, notify, sock);
      case "spec.list":
        return { specs: L.specs(p.project) };
      case "spec.diff": {
        const s = this.specOr404(p.id);
        const { before, after } = s.checkpoints;
        return { id: s.id, files: s.files, diff: before && after ? specDiff(specPaths(this.stateDir(), s.id), before, after) : "" };
      }
      case "spec.accept": {
        const s = this.specOr404(p.id);
        if (s.status !== "needs-review") throw new RpcError(Errors.refused, `${s.id} is ${s.status}, not waiting for review`);
        const files = accept(this.stateDir(), this.projectPath(s.project), s);
        L.updateSpec(s.id, { status: "accepted" }, "user");
        discard(this.stateDir(), s.id);
        return { id: s.id, applied: files };
      }
      case "spec.discard": {
        const s = this.specOr404(p.id);
        discard(this.stateDir(), s.id);
        if (s.status === "needs-review" || s.status === "failed") L.updateSpec(s.id, { status: "undone", note: "discarded by the user" }, "user");
        return { id: s.id, discarded: true };
      }
      case "gate.list":
        return { gates: [...this.gates.values()].map(({ owner: _o, answer: _a, ...g }) => g) };
      case "gate.answer":
        if (!this.settle(p.id, p.answer, "user")) throw new RpcError(Errors.notFound, `no Gate ${p.id} is waiting`);
        return { ok: true };
    }
  }

  private ask(projectName: string | null, prompt: string, notify: (n: unknown) => void, sock: Socket): Promise<unknown> {
    if (!this.sandboxOk) {
      this.ledger.append(projectName, "sandbox.refused", "govd", { reason: this.sandboxReason });
      throw new RpcError(Errors.refused, `sandbox not verified on this machine (${this.sandboxReason}); nothing was started`);
    }
    // Home: no project. The Controller works in an empty scratch folder it may only read,
    // so nothing anywhere is written (the sandbox enforces it, not the prompt).
    const found = projectName ? this.ledger.project(projectName) : undefined;
    if (projectName && !found) throw new RpcError(Errors.notFound, `no project ${projectName}`);
    if (!found) mkdirSync(this.opts.homeDir, { recursive: true, mode: 0o700 });
    const project = found ?? { name: null, path: this.opts.homeDir, controller: this.homeController(), readOnly: true };
    const actor = `controller · ${project.controller.provider}`;
    const L = this.ledger;
    L.append(project.name, "turn.started", "user", { prompt: prompt.slice(0, 2000), controller: project.controller, home: !found });
    // A tool that can write the project can write .git; hooks and some config keys would then
    // run later, outside the sandbox, when the user runs git. Undone after every turn.
    const guard = found ? gitGuard(project.path) : null;
    return new Promise((done) => {
      const hooks: TurnHooks = {
          text: (t) => { notify({ kind: "text", text: t }); L.append(project.name, "turn.text", actor, { text: t.slice(0, 4000) }); },
          tool: (name, input) => { notify({ kind: "tool", name, input }); L.append(project.name, "turn.tool", actor, { name }); },
          gate: (req) => new Promise((answer) => {
            const id = `G-${++this.gateSeq}`;
            this.gates.set(id, { id, project: project.name, tool: req.tool, canonical: req.canonical,
              opened: new Date().toISOString(), owner: sock, answer });
            L.append(project.name, "gate.opened", req.actor ?? actor, { gate: id, tool: req.tool });
            notify({ kind: "gate", id, tool: req.tool, canonical: req.canonical });
          }),
          done: (r) => {
            const scrubbed = guard?.restore() ?? [];
            if (scrubbed.length) L.append(project.name, "git.scrubbed", "govd", { removed: scrubbed });
            L.append(project.name, r.ok ? "turn.completed" : "turn.failed", actor, { summary: r.summary.slice(0, 2000) });
            done(r);
          },
      };
      const common = { supervisor: this.opts.supervisor, policyDir: this.opts.policyDir, worktree: project.path,
        readOnly: "readOnly" in project, prompt, hooks };
      if (project.controller.provider === "codex") {
        void runCodexTurn({ ...common, stateDir: resolve(this.opts.ledgerPath, ".."), model: project.controller.model, effort: project.controller.effort });
      } else {
        // In a project, the Claude Controller gets GovernCode's delegate tool on a socket that
        // exists only for this turn. Home (read-only, no project) gets none.
        const ctl = found ? openControllerSocket({ project: { name: found.name, path: found.path }, ledger: L, limits: this.limits,
          usage: this.usage, runtimeDir: resolve(this.opts.socketPath, ".."), supervisor: this.opts.supervisor,
          policyDir: this.opts.policyDir, stateDir: resolve(this.opts.ledgerPath, ".."), gate: hooks.gate, notify }) : null;
        const finish = hooks.done;
        hooks.done = (r) => { ctl?.close(); finish(r); };
        runTurn({ ...common, controller: project.controller,
          mcp: ctl ? { node: process.execPath, script: MCP_SCRIPT, socket: ctl.path } : undefined });
      }
    });
  }
}
