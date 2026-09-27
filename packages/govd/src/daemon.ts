// govd: the daemon. A Unix socket in a 0700 directory, JSON-RPC 2.0 one object per line.
// Sandboxed AI tools cannot connect to it: Landlock allows only the Unix sockets their
// policy names (or, on older kernels, seccomp refuses Unix sockets altogether), so every
// connection here is the user (the CLI now, apps later). docs/SANDBOX.md, invariant 5.
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, existsSync, statSync, chmodSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { Errors, FEATURES, PROTOCOL, Params, ProjectName, ProjectProposal, Request, RpcError, type Method, type WatchEvent } from "@governcode/protocol";
import { gitGuard } from "./gitguard.ts";
import { checkClaudePolicy } from "./policycheck.ts";
import { Ledger } from "./ledger.ts";
import { runTurn, type TurnHooks } from "./claude.ts";
import { runCodexTurn, codexUsage } from "./codex.ts";
import { LimitGate, type UsageSource } from "./limits.ts";
import { openControllerSocket, openTurnSocket, accept, discard } from "./delegate.ts";
import { applyToProject, changedFiles, diff as specDiff, projectFiles, snapshot, specPaths, turnStore } from "./specstore.ts";

// ponytail: very large projects skip turn Checkpoints (hashing every file each turn).
// Raise or make it incremental when a real project hits it.
const MAX_CHECKPOINT_FILES = 20_000;
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
  // Controller turns running per project: accept and undo wait for them, so a running tool
  // cannot swap a folder for a symlink while govd writes into the project.
  private turning = new Map<string, number>();
  private usage: Record<string, UsageSource> = {};
  private gateSeq = 0;
  // Projects a Home Controller proposed, waiting for the user's Create or Cancel.
  // ponytail: in memory; a govd restart drops them (the Controller can propose again).
  private proposals = new Map<string, { id: string; name: string; path: string; git: boolean }>();
  private proposalSeq = 0;
  /** Connections that called `watch`: each gets Trace appends and Gate changes pushed to it. */
  private watchers = new Map<Socket, { send: (n: WatchEvent) => void; stop: () => void }>();
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

  /** The real Claude policy, probed on this machine (after listen, so govd's socket exists). */
  policyCheck(): { ok: boolean; problems: string[] } {
    if (!this.sandboxOk) return { ok: false, problems: [] };
    const problems = checkClaudePolicy(this.opts.supervisor, this.opts.policyDir, this.opts.socketPath);
    if (problems.length) {
      this.sandboxOk = false;
      this.sandboxReason = `the Claude policy does not hold here: ${problems.join("; ")}`;
    }
    return { ok: !problems.length, problems };
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

  /** A rule saying no (the project changed, a path is unsafe) is a refusal, not a crash. */
  private refusing<T>(f: () => T): T {
    try { return f(); } catch (e) { throw new RpcError(Errors.refused, e instanceof Error ? e.message : String(e)); }
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

  /** A folder that may become a new project: free name, nothing there yet, no denied folder. */
  private newProjectPath(name: string, raw: string): string {
    if (this.ledger.project(name)) throw new RpcError(Errors.refused, `a project named ${name} already exists`);
    const path = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
    if (existsSync(path)) throw new RpcError(Errors.refused, `${path} already exists; use project.open`);
    this.checkProjectPath(path);
    this.checkProjectPath(realAncestor(path));   // a symlinked parent must not smuggle in a denied folder
    return path;
  }

  /** A Home Controller's proposal: checked now, shown to the user, created only on Create. */
  private propose(raw: unknown, notify: (n: unknown) => void, actor: string): unknown {
    const parsed = ProjectProposal.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { name, git, reason } = parsed.data;
    const path = this.newProjectPath(name, parsed.data.path);
    const id = `P-${++this.proposalSeq}`;
    this.proposals.set(id, { id, name, path, git });
    this.ledger.append(null, "project.proposed", actor, { proposal: id, name, path, git });
    notify({ kind: "proposal", id, name, path, git, reason });
    return { id, status: "shown to the user with Create and Cancel; nothing exists until they choose Create" };
  }

  private notWhileTurning(project: string): void {
    if (this.turning.get(project)) throw new RpcError(Errors.refused, `a Controller turn is running in ${project}; try again when it ends`);
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
    sock.on("close", () => { this.sockets.delete(sock); this.watchers.get(sock)?.stop(); this.watchers.delete(sock); });
    const write = (obj: unknown) => sock.writable && sock.write(JSON.stringify(obj) + "\n");
    sock.on("close", () => { for (const g of [...this.gates.values()]) if (g.owner === sock) this.settle(g.id, "deny", "asker left"); });
    // A client that drops mid-line (ECONNRESET) must not take govd down: the error is the
    // client's problem, and "close" already denies its Gates.
    sock.on("error", () => sock.destroy());
    const lines = createInterface({ input: sock });
    lines.on("error", () => {});
    lines.on("line", async (line) => {
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
    this.gatesChanged();
    g.answer(answer);
    return true;
  }

  private gatesChanged(): void {
    for (const w of this.watchers.values()) w.send({ kind: "gates" });
  }

  private watch(sock: Socket, notify: (n: unknown) => void): void {
    if (this.watchers.has(sock)) return;
    // ponytail: a watcher that stops reading lets its socket buffer grow; add a high-water
    // mark and drop the watcher when a real client needs it.
    const send = (n: WatchEvent) => { if (sock.writable) notify(n); };
    const stop = this.ledger.subscribe((event) => send({ kind: "trace", event }));
    this.watchers.set(sock, { send, stop });
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
        const path = this.newProjectPath(p.name, p.path);
        mkdirSync(path, { recursive: true });
        if (p.git) execFileSync("git", ["init", "-q", "-b", "main", path]);
        return { project: L.addProject(p.name, path, "project.created") };
      }
      case "proposal.answer": {
        const prop = this.proposals.get(p.id);
        if (!prop) throw new RpcError(Errors.notFound, `no proposal ${p.id} waiting`);
        this.proposals.delete(p.id);
        if (p.answer === "cancel") {
          L.append(null, "project.declined", "user", { proposal: p.id, name: prop.name });
          return { id: p.id, created: null };
        }
        const path = this.newProjectPath(prop.name, prop.path);   // checked again: things may have changed
        mkdirSync(path, { recursive: true });
        if (prop.git) execFileSync("git", ["init", "-q", "-b", "main", path]);
        return { id: p.id, created: L.addProject(prop.name, path, "project.created") };
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
      case "limits.list": {
        if (p.measure) await Promise.all(Object.values(this.usage).map(async (src) => {
          const m = await src.read();
          if (m) this.limits.record(m); else this.limits.forget(src.provider);   // unknown holds
        }));
        return { providers: Object.keys(this.usage).map((name) => this.limits.view(name)) };
      }
      case "spec.list":
        return { specs: L.specs(p.project) };
      case "turn.list": {
        const events = L.events(p.project, 1000);
        const undone = new Set(events.filter((e) => e.kind === "checkpoint.undone").map((e) => e.data.turn));
        return { turns: events.filter((e) => e.kind === "checkpoint.taken")
          .map((e) => ({ id: e.data.turn, at: e.ts, files: e.data.files, undone: undone.has(e.data.turn) })) };
      }
      case "turn.undo": {
        const ev = L.events(undefined, 5000).find((e) => e.kind === "checkpoint.taken" && e.data.turn === p.id);
        if (!ev || !ev.project) throw new RpcError(Errors.notFound, `no Checkpoint ${p.id}`);
        if (L.events(ev.project, 5000).some((e) => e.kind === "checkpoint.undone" && e.data.turn === p.id)) {
          throw new RpcError(Errors.refused, `${p.id} was already undone`);
        }
        const project = ev.project;
        this.notWhileTurning(project);
        const path = this.projectPath(project);
        // Restore the before-state, only where the project still holds exactly the after-state.
        const files = this.refusing(() => applyToProject(turnStore(this.stateDir(), project, path), path, String(ev.data.after), String(ev.data.before), p.id));
        L.append(project, "checkpoint.undone", "user", { turn: p.id, files });
        return { id: p.id, restored: files };
      }
      case "spec.diff": {
        const s = this.specOr404(p.id);
        const { before, after } = s.checkpoints;
        return { id: s.id, files: s.files, diff: before && after ? specDiff(specPaths(this.stateDir(), s.id), before, after) : "" };
      }
      case "spec.accept": {
        const s = this.specOr404(p.id);
        if (s.status !== "needs-review") throw new RpcError(Errors.refused, `${s.id} is ${s.status}, not waiting for review`);
        this.notWhileTurning(s.project);
        const files = this.refusing(() => accept(this.stateDir(), this.projectPath(s.project), s));
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
      case "watch":
        this.watch(sock, notify);
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
    if (found) this.turning.set(found.name, (this.turning.get(found.name) ?? 0) + 1);
    // A tool that can write the project can write .git; hooks and some config keys would then
    // run later, outside the sandbox, when the user runs git. Undone after every turn.
    const guard = found ? gitGuard(project.path) : null;
    // A Checkpoint of the project before the Controller's turn, in govd's own store, so the
    // user can undo the whole turn (gov undo T-n). Git projects only; ignored files excluded.
    const started = L.events(project.name ?? undefined, 1).at(-1);
    const turnId = `T-${started?.seq ?? Date.now()}`;
    const files = found ? projectFiles(found.path) : null;
    const store = found && files && files.length <= MAX_CHECKPOINT_FILES ? turnStore(this.stateDir(), found.name, found.path) : null;
    let before: string | null = null;
    try { if (store && files) before = snapshot(store, `turns/${turnId}/before`, null, files); } catch { before = null; }
    return new Promise((done) => {
      const hooks: TurnHooks = {
          text: (t) => { notify({ kind: "text", text: t }); L.append(project.name, "turn.text", actor, { text: t.slice(0, 4000) }); },
          tool: (name, input) => { notify({ kind: "tool", name, input }); L.append(project.name, "turn.tool", actor, { name }); },
          gate: (req) => new Promise((answer) => {
            const id = `G-${++this.gateSeq}`;
            this.gates.set(id, { id, project: project.name, tool: req.tool, canonical: req.canonical,
              opened: new Date().toISOString(), owner: sock, answer });
            L.append(project.name, "gate.opened", req.actor ?? actor, { gate: id, tool: req.tool });
            this.gatesChanged();
            notify({ kind: "gate", id, tool: req.tool, canonical: req.canonical });
          }),
          done: (r) => {
            if (found) this.turning.set(found.name, (this.turning.get(found.name) ?? 1) - 1);
            if (store && before) {
              try {
                const after = snapshot(store, `turns/${turnId}/after`, before, [...new Set([...(files ?? []), ...(projectFiles(found!.path) ?? [])])]);
                const changed = changedFiles(store, before, after);
                if (changed.length) L.append(project.name, "checkpoint.taken", "govd", { turn: turnId, before, after, files: changed });
              } catch { /* a Checkpoint is a convenience; its failure never fails the turn */ }
            }
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
        // exists only for this turn. Home (read-only, no project) gets only propose_project.
        const ctl = found ? openControllerSocket({ project: { name: found.name, path: found.path }, ledger: L, limits: this.limits,
          usage: this.usage, runtimeDir: resolve(this.opts.socketPath, ".."), supervisor: this.opts.supervisor,
          policyDir: this.opts.policyDir, stateDir: resolve(this.opts.ledgerPath, ".."), gate: hooks.gate, notify })
          : openTurnSocket(resolve(this.opts.socketPath, ".."), async (method, params) => {
            if (method !== "controller.propose_project") throw new Error(`not offered at Home: ${method}`);
            return this.propose(params, notify, actor);
          });
        const finish = hooks.done;
        hooks.done = (r) => { ctl?.close(); finish(r); };
        runTurn({ ...common, controller: project.controller,
          mcp: { node: process.execPath, script: MCP_SCRIPT, socket: ctl.path, ...(found ? {} : { mode: "home" as const }) } });
      }
    });
  }
}

/** The path with its deepest existing ancestor resolved through any symlinks. */
function realAncestor(path: string): string {
  let head = path, tail: string[] = [];
  while (!existsSync(head) && head !== dirname(head)) { tail.unshift(basename(head)); head = dirname(head); }
  return join(realpathSync(head), ...tail);
}
