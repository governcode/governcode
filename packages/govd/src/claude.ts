// The Claude Code driver: one sandboxed `claude` process per turn (phase 0), driven over its
// stream-json protocol. Permission requests arrive as control_request/can_use_tool and become
// Gates answered by the user through govd, never by the harness itself.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { ControllerChoice } from "@governcode/protocol";

export type Policy = { version: 1; read: string[]; write: string[]; exec: string[]; tcp_connect: number[]; unix_connect: string[]; cwd: string };

// The one local socket a tool may reach: the system DNS resolver, where the host uses one.
const RESOLVER_SOCKETS = ["/run/systemd/resolve/io.systemd.Resolve"];

export type GateRequest = { id: string; tool: string; input: Record<string, unknown>; canonical: string };
export type TurnHooks = {
  text(chunk: string): void;
  tool(name: string, input: Record<string, unknown>): void;
  gate(req: GateRequest): Promise<"allow" | "deny">;
  done(result: { ok: boolean; summary: string; usage?: unknown }): void;
};

/** The exact bytes a Gate shows and a phone will later sign: sorted keys, ASCII-escaped. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    : v;
  return JSON.stringify(sort(value), null, 1).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** What a Claude Code process may touch. Everything not listed is denied by govern-sup. */
export function claudePolicy(worktree: string, sessionTmp: string, readOnly = false): Policy {
  const home = homedir();
  const cfg = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const bin = realpathSync(which("claude"));
  // Claude Code writes its session state under its config dir; its settings stay read-only
  // so a run cannot widen what it auto-allows next time (docs/SANDBOX.md, invariant 3).
  const cfgWritable = ["projects", "sessions", "session-env", "shell-snapshots", "todos", "file-history",
    "paste-cache", "plans", "cache", "statsig", "debug", "history.jsonl", ".credentials.json"].map((p) => join(cfg, p));
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev", cfg, dirname(bin),
      ...(readOnly ? [worktree] : [])],
    write: [...(readOnly ? [] : [worktree]), sessionTmp, "/dev/null", "/dev/tty", ...cfgWritable.filter(existsSync), join(home, ".claude.json")].filter(
      (p) => p === worktree || p === sessionTmp || existsSync(p)),
    exec: ["/usr/bin", "/bin", "/usr/lib", dirname(bin)],
    tcp_connect: [443],
    unix_connect: RESOLVER_SOCKETS.filter(existsSync),
    cwd: worktree,
  };
}

function which(cmd: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  throw new Error(`${cmd} not found on PATH`);
}

export function runTurn(opts: {
  supervisor: string; policyDir: string; worktree: string; readOnly?: boolean; controller: ControllerChoice; prompt: string; hooks: TurnHooks;
}): { cancel(): void } {
  mkdirSync(opts.policyDir, { recursive: true, mode: 0o700 });
  const sessionTmp = mkdtempSync(join(tmpdir(), "governcode-turn-"));
  const policyFile = join(opts.policyDir, `turn-${process.pid}-${Date.now()}.json`);
  writeFileSync(policyFile, JSON.stringify(claudePolicy(opts.worktree, sessionTmp, opts.readOnly)), { mode: 0o600 });

  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-prompt-tool", "stdio", "--permission-mode", "default",
    // Only the user's own settings; never the worktree's, which the harness can write.
    "--setting-sources", "user", "--no-session-persistence",
    "--model", opts.controller.model, ...(opts.controller.effort ? ["--effort", opts.controller.effort] : [])];
  const child = spawn(opts.supervisor, ["run", "--policy", policyFile, "--", which("claude"), ...args], {
    cwd: opts.worktree, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMPDIR: sessionTmp },
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
  const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: opts.prompt }] } });

  let finished = false;
  const finish = (r: { ok: boolean; summary: string; usage?: unknown }) => {
    if (finished) return;
    finished = true;
    child.stdin.end();
    rmSync(policyFile, { force: true });
    rmSync(sessionTmp, { recursive: true, force: true });
    opts.hooks.done(r);
  };

  createInterface({ input: child.stdout }).on("line", async (line) => {
    let e: Record<string, any>;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "text") opts.hooks.text(c.text);
        if (c.type === "tool_use") opts.hooks.tool(c.name, c.input ?? {});
      }
    } else if (e.type === "control_request" && e.request?.subtype === "can_use_tool") {
      const input = (e.request.input ?? {}) as Record<string, unknown>;
      const req: GateRequest = { id: String(e.request_id), tool: String(e.request.tool_name), input,
        canonical: canonical({ tool: e.request.tool_name, input }) };
      const answer = await opts.hooks.gate(req);
      // Allow runs exactly the input that was shown, never a variant (the #177 lesson).
      send({ type: "control_response", response: { subtype: "success", request_id: e.request_id,
        response: answer === "allow" ? { behavior: "allow", updatedInput: input }
                                     : { behavior: "deny", message: "Denied at the Gate." } } });
    } else if (e.type === "result") {
      finish({ ok: !e.is_error, summary: String(e.result ?? e.subtype ?? ""), usage: e.usage });
    }
  });
  child.on("exit", (code) => finish({ ok: false, summary: code === 0 ? "ended without a result" :
    `sandbox or harness exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}` }));
  return { cancel: () => child.kill("SIGTERM") };
}
