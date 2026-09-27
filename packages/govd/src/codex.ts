// The Codex driver: `codex app-server` (JSON-RPC over stdio) under govern-sup. Codex's own
// approval requests (commands, file changes) become Gates; account/rateLimits/read feeds the
// Limit gate, so Codex is a measured Runner.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonical, resolverFiles, toolEnv, type GateRequest, type Policy, type TurnHooks } from "./claude.ts";
import type { Measurement, UsageSource } from "./limits.ts";

/** The real Codex binary: $GOVERNCODE_CODEX_BIN, else `codex` on PATH, looking through a mise shim. */
export function codexBinary(): string {
  if (process.env.GOVERNCODE_CODEX_BIN) return process.env.GOVERNCODE_CODEX_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, "codex");
    if (!existsSync(p)) continue;
    const real = realpathSync(p);
    if (readFileSync(real).subarray(0, 4).toString("latin1") === "\x7fELF") return real;
    try { return realpathSync(execFileSync("mise", ["which", "codex"], { encoding: "utf8" }).trim()); } catch { /* not mise */ }
  }
  throw new Error("codex not found (set GOVERNCODE_CODEX_BIN to the codex binary)");
}

/**
 * Codex keeps databases and logs in its home. A private CODEX_HOME per GovernCode, rebuilt
 * before each run, holds them; the user's config and login are linked in and read-only in
 * the policy, so a run cannot rewrite what the next run trusts.
 */
export function prepareCodexHome(stateDir: string): string {
  const user = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const home = join(stateDir, "codex-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(home)) {
    const p = join(home, name);
    if (lstatSync(p).isSymbolicLink() || ["config.toml", "auth.json", "AGENTS.md"].includes(name)) rmSync(p, { force: true });
  }
  for (const name of ["config.toml", "auth.json"]) if (existsSync(join(user, name))) symlinkSync(join(user, name), join(home, name));
  return home;
}

export function codexPolicy(worktree: string, sessionTmp: string, codexHome: string, bin: string, readOnly = false,
                            writePaths?: string[], gitDir?: string): Policy {
  const user = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const exists = (p: string) => existsSync(p);
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom",
      "/dev/random", dirname(bin), join(user, "config.toml"), join(user, "auth.json"), ...resolverFiles(),
      // A Spec's Runner reads its whole worktree (and the repo's git data) but writes only its scope.
      ...(readOnly || writePaths ? [worktree] : []), ...(gitDir ? [gitDir] : [])].filter((p) => p === worktree || exists(p)),
    write: [...(readOnly ? [] : writePaths ?? [worktree]), sessionTmp, codexHome, "/dev/null"],
    exec: ["/usr/bin", "/bin", "/usr/lib", dirname(bin)],
    tcp_connect: [443],
    unix_connect: ["/run/systemd/resolve/io.systemd.Resolve"].filter(exists),
    cwd: worktree,
  };
}

type Rpc = { request(method: string, params: unknown): Promise<any>; onRequest(f: (m: any) => Promise<unknown>): void;
  onNotify(f: (m: any) => void): void; close(): void; exited: Promise<string> };

function start(supervisor: string, policyFile: string, bin: string, env: Record<string, string>, cwd: string): Rpc {
  const child = spawn(supervisor, ["run", "--policy", policyFile, "--", bin, "app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
  // A Runner that dies turns our next write into EPIPE; its exit is reported below instead.
  child.stdin.on("error", () => {});
  let next = 1;
  const waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  let onReq: (m: any) => Promise<unknown> = async () => ({});
  let onNote: (m: any) => void = () => {};
  const send = (o: unknown) => child.stdin.writable && child.stdin.write(JSON.stringify(o) + "\n");
  createInterface({ input: child.stdout }).on("line", async (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && m.method) {                        // a request from Codex to us
      try { send({ id: m.id, result: await onReq(m) }); } catch (e) { send({ id: m.id, error: { code: -32603, message: String(e) } }); }
    } else if (m.id !== undefined) {                             // a response to us
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) w?.fail(new Error(m.error.message ?? "codex error")); else w?.ok(m.result);
    } else if (m.method) onNote(m);
  });
  const exited = new Promise<string>((res) => child.on("exit", (code) => {
    for (const w of waiting.values()) w.fail(new Error(`codex exited ${code}: ${stderr.trim().split("\n").slice(-2).join(" | ")}`));
    res(stderr);
  }));
  return {
    request: (method, params) => new Promise((ok, fail) => { const id = next++; waiting.set(id, { ok, fail }); send({ id, method, params }); }),
    onRequest: (f) => (onReq = f),
    onNotify: (f) => (onNote = f),
    close: () => { child.stdin.end(); try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } },
    exited,
  };
}

async function session(o: { supervisor: string; policyDir: string; stateDir: string; worktree: string; readOnly?: boolean;
                           writePaths?: string[]; gitDir?: string }) {
  const bin = codexBinary();
  mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(tmpdir(), "governcode-codex-"));
  const home = prepareCodexHome(o.stateDir);
  const policyFile = join(o.policyDir, `codex-${process.pid}-${Date.now()}.json`);
  writeFileSync(policyFile, JSON.stringify(codexPolicy(o.worktree, tmp, home, bin, o.readOnly, o.writePaths, o.gitDir)), { mode: 0o600 });
  const rpc = start(o.supervisor, policyFile, bin, { ...toolEnv(tmp), CODEX_HOME: home }, o.worktree);
  await rpc.request("initialize", { clientInfo: { name: "governcode", title: "GovernCode", version: "0.0.1" } });
  const cleanup = () => { rpc.close(); rmSync(policyFile, { force: true }); rmSync(tmp, { recursive: true, force: true }); };
  return { rpc, cleanup };
}

/** Codex's usage windows, for the Limit gate. Null when they cannot be read (= held). */
export function codexUsage(o: { supervisor: string; policyDir: string; stateDir: string; scratch: string }): UsageSource {
  return {
    provider: "codex",
    async read(): Promise<Measurement | null> {
      let s: Awaited<ReturnType<typeof session>> | undefined;
      try {
        mkdirSync(o.scratch, { recursive: true, mode: 0o700 });
        s = await session({ ...o, worktree: o.scratch, readOnly: true });
        const r = await Promise.race([s.rpc.request("account/rateLimits/read", {}),
          new Promise((_, fail) => setTimeout(() => fail(new Error("timeout")), 20_000))]) as any;
        const snap = r?.rateLimits ?? {};
        const win = (w: any, name: string) => w && typeof w.usedPercent === "number"
          ? [{ window: w.windowDurationMins ? (w.windowDurationMins >= 10_000 ? "weekly" : `${Math.round(w.windowDurationMins / 60)}-hour`) : name,
               usedPercent: w.usedPercent, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }] : [];
        const readings = [...win(snap.primary, "primary"), ...win(snap.secondary, "secondary")];
        return readings.length ? { provider: "codex", measuredAt: Date.now(), readings } : null;
      } catch {
        return null;
      } finally {
        s?.cleanup();
      }
    },
  };
}

/** One Codex turn in a fresh, ephemeral thread. Approvals become Gates; allow runs what was shown. */
export async function runCodexTurn(o: { supervisor: string; policyDir: string; stateDir: string; worktree: string;
  readOnly?: boolean; writePaths?: string[]; gitDir?: string; model: string; effort: string | null; prompt: string; hooks: TurnHooks;
  signal?: AbortSignal }): Promise<void> {
  let s: Awaited<ReturnType<typeof session>>;
  try {
    s = await session(o);
  } catch (e) {
    o.hooks.done({ ok: false, summary: `codex did not start: ${e instanceof Error ? e.message : e}` });
    return;
  }
  const { rpc, cleanup } = s;
  let text = "";
  let finished = false;
  const items = new Map<string, any>();   // itemId -> the item Codex announced (holds a file change's diffs)
  const finish = (r: { ok: boolean; summary: string }) => { if (finished) return; finished = true; cleanup(); o.hooks.done(r); };
  rpc.onRequest(async (m) => {
    const p = m.params ?? {};
    const kind = m.method === "item/commandExecution/requestApproval" ? "command"
      : m.method === "item/fileChange/requestApproval" ? "fileChange" : null;
    // Anything we do not recognise is refused, never granted by silence (Rattle).
    if (!kind) throw new Error(`GovernCode does not answer ${m.method}`);
    const changes = kind === "fileChange" ? items.get(String(p.itemId))?.changes : undefined;
    // A Gate shows exactly what will happen. A file change whose content we have not seen
    // cannot be shown, so it is declined rather than approved blind.
    if (kind === "fileChange" && !Array.isArray(changes)) return { decision: "decline" };
    const input = kind === "command" ? { command: p.command ?? null, cwd: p.cwd ?? null, reason: p.reason ?? null }
                                     : { changes, grantRoot: p.grantRoot ?? null, reason: p.reason ?? null };
    const req: GateRequest = { id: String(p.approvalId ?? p.itemId ?? m.id), tool: `codex ${kind}`, input,
      canonical: canonical({ tool: `codex ${kind}`, input }) };
    const answer = await o.hooks.gate(req);
    return { decision: answer === "allow" ? "accept" : "decline" };   // never "for session": each one asks
  });
  rpc.onNotify((m) => {
    const p = m.params ?? {};
    if (m.method === "item/agentMessage/delta" && typeof p.delta === "string") text += p.delta;
    if (m.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") {
      o.hooks.text(p.item.text); text = "";
    }
    if ((m.method === "item/started" || m.method === "item/completed") && p.item?.id) items.set(String(p.item.id), p.item);
    if (m.method === "item/started" && p.item?.type && p.item.type !== "agentMessage" && p.item.type !== "userMessage") {
      o.hooks.tool(`codex ${p.item.type}`, {});
    }
    if (m.method === "turn/completed") {
      const status = p.turn?.status;
      finish({ ok: status === "completed", summary: status === "completed" ? "done" : `turn ${status ?? "ended"}: ${JSON.stringify(p.turn?.error ?? "").slice(0, 300)}` });
    }
  });
  void rpc.exited.then((err) => finish({ ok: false, summary: `codex exited: ${err.trim().split("\n").slice(-2).join(" | ")}` }));
  // Stopped from outside (a Limit crossed mid-run): end the process, report why.
  o.signal?.addEventListener("abort", () => finish({ ok: false, summary: `stopped: ${String(o.signal?.reason ?? "aborted")}` }), { once: true });
  try {
    const t = await rpc.request("thread/start", { cwd: o.worktree, model: o.model, ephemeral: true,
      approvalPolicy: "untrusted", sandbox: o.readOnly ? "read-only" : "workspace-write" });
    await rpc.request("turn/start", { threadId: t.thread.id, input: [{ type: "text", text: o.prompt }],
      ...(o.effort ? { effort: o.effort } : {}) });
  } catch (e) {
    finish({ ok: false, summary: `codex refused the turn: ${e instanceof Error ? e.message : e}` });
  }
}
