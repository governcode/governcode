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

/** DNS config files, followed through symlinks: statically linked tools (Codex) read
 *  /etc/resolv.conf themselves, and it often points into /run. */
export function resolverFiles(): string[] {
  const out: string[] = [];
  for (const f of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"]) {
    try { const real = realpathSync(f); if (!real.startsWith("/etc/")) out.push(real); } catch { /* absent */ }
  }
  return out;
}

/** What every AI GovernCode runs is told about where it is, so it neither flails at the
 *  sandbox nor follows the user's other tooling instructions that cannot work in here. */
export const CONTROLLER_CONTEXT = [
  "You are the Controller in GovernCode, working for the user.",
  "You run inside a sandbox the operating system enforces: you can reach only this project (Home: read only),",
  "and some commands will fail with permission errors by design. Do not try to work around them; say what you could not do.",
  "To hand a job to another AI coding tool, use the governcode delegate tool. It checks that tool's usage Limit",
  "itself, so no other quota or budget check is needed (instructions elsewhere that ask for one do not apply here).",
  "Steps that need approval are shown to the user as Gates. If you need to ask the user something, ask in your reply.",
].join(" ");
export const RUNNER_CONTEXT = [
  "You are a Runner in GovernCode: another AI handed you this job (a Spec).",
  "You work in your own copy of the project, inside a sandbox the operating system enforces; you can write only the",
  "files the Spec allows, and some commands will fail with permission errors by design. Do not try to work around them.",
  "The user reviews your changes before anything reaches the real project.",
].join(" ");

export type GateRequest = { id: string; tool: string; input: Record<string, unknown>; canonical: string; actor?: string;
  base?: string; spec?: string };   // a Runner's Gate: its own tool name and Spec (for standing allows)
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
export type McpServer = { node: string; script: string; socket: string; mode?: "home" };   // home: propose_project only

export function claudePolicy(worktree: string, sessionTmp: string, readOnly = false, mcp?: McpServer): Policy {
  const home = homedir();
  const cfg = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const bin = realpathSync(which("claude"));
  // Only what Claude Code needs, found by testing: its settings, instructions, skills and
  // credentials READ-ONLY (so a run cannot widen what it auto-allows next time, invariant 3;
  // an expired token then needs one unsandboxed `claude` to refresh); scratch state writable.
  // Not other projects' transcripts (projects/, history.jsonl): none of this run's business.
  const cfgRead = ["settings.json", "CLAUDE.md", "skills", "plugins", "hooks", "themes", "agents", "commands",
    ".credentials.json"].map((p) => join(cfg, p));
  const cfgWrite = ["sessions", "session-env", "shell-snapshots", "todos", "statsig", "cache", "debug",
    "paste-cache", "file-history", "plans"].map((p) => join(cfg, p));
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom",
      "/dev/random", dirname(bin), join(home, ".claude.json"), ...cfgRead, ...resolverFiles(), ...(readOnly ? [worktree] : [])].filter(
      (p) => p === worktree || existsSync(p)),
    write: [...(readOnly ? [] : [worktree]), sessionTmp, "/dev/null", ...cfgWrite.filter(existsSync)],
    exec: ["/usr/bin", "/bin", "/usr/lib", dirname(bin), ...(mcp ? [dirname(mcp.node)] : [])],
    tcp_connect: [443],
    // The per-turn GovernCode socket is the one extra socket, and only while this turn runs.
    unix_connect: [...RESOLVER_SOCKETS.filter(existsSync), ...(mcp ? [mcp.socket] : [])],
    cwd: worktree,
  };
}

/** Where the MCP server file lives, so the policy can let the tool read it. */
export function withMcpRead(p: Policy, mcp?: McpServer): Policy {
  return mcp ? { ...p, read: [...p.read, dirname(mcp.script), dirname(mcp.node)] } : p;
}

const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|CLAUDE_CONFIG_DIR|ANTHROPIC_[A-Z_]+|CLAUDE_CODE_[A-Z_]+|HTTPS?_PROXY|NO_PROXY)$/;

export function toolEnv(tmp: string): Record<string, string> {
  const env: Record<string, string> = { TMPDIR: tmp };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ENV_KEEP.test(k)) env[k] = v;
  return env;
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
  mcp?: McpServer;
}): { cancel(): void } {
  mkdirSync(opts.policyDir, { recursive: true, mode: 0o700 });
  const sessionTmp = mkdtempSync(join(tmpdir(), "governcode-turn-"));
  const policyFile = join(opts.policyDir, `turn-${process.pid}-${Date.now()}.json`);
  writeFileSync(policyFile, JSON.stringify(withMcpRead(claudePolicy(opts.worktree, sessionTmp, opts.readOnly, opts.mcp), opts.mcp)), { mode: 0o600 });

  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-prompt-tool", "stdio", "--permission-mode", "default",
    // Only the user's own settings; never the worktree's, which the harness can write.
    "--setting-sources", "user", "--no-session-persistence",
    "--model", opts.controller.model, ...(opts.controller.effort ? ["--effort", opts.controller.effort] : []),
    "--append-system-prompt", CONTROLLER_CONTEXT,
    // GovernCode's own tools for the Controller, and no other MCP servers from anywhere.
    ...(opts.mcp ? ["--mcp-config", JSON.stringify({ mcpServers: { governcode: { command: opts.mcp.node, args: [opts.mcp.script, opts.mcp.socket, ...(opts.mcp.mode ? [opts.mcp.mode] : [])] } } }),
      "--strict-mcp-config"] : []),
    // Proposing a project creates nothing (the user's Create does), so it needs no Gate of its own.
    ...(opts.mcp?.mode === "home" ? ["--allowedTools", "mcp__governcode__propose_project"] : [])];
  // A clean environment: govd's own variables (and anything else in the user's shell) are
  // none of the tool's business. Its own process group, so finishing the turn ends every
  // process it started, not only the one that printed the result.
  const child = spawn(opts.supervisor, ["run", "--policy", policyFile, "--", which("claude"), ...args], {
    cwd: opts.worktree, stdio: ["pipe", "pipe", "pipe"], detached: true,
    // A delegated Spec can run for many minutes while the Controller's tool call waits.
    env: { ...toolEnv(sessionTmp), MCP_TOOL_TIMEOUT: String(60 * 60_000) },
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
  child.stdin.on("error", () => {});   // a dead harness is reported by its exit, not by EPIPE
  const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: opts.prompt }] } });

  let finished = false;
  const finish = (r: { ok: boolean; summary: string; usage?: unknown }) => {
    if (finished) return;
    finished = true;
    child.stdin.end();
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    rmSync(policyFile, { force: true });
    rmSync(sessionTmp, { recursive: true, force: true });
    opts.hooks.done(r);
  };

  const pendingIds = new Set<string>();
  createInterface({ input: child.stdout }).on("line", async (line) => {
    let e: Record<string, any>;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "text") opts.hooks.text(c.text);
        if (c.type === "tool_use") opts.hooks.tool(c.name, c.input ?? {});
      }
    } else if (e.type === "control_request" && e.request?.subtype === "can_use_tool") {
      // One Gate per request id at a time: a repeated id while one is pending is ignored,
      // so an answer can never land on a different request than the one shown.
      if (pendingIds.has(String(e.request_id))) return;
      pendingIds.add(String(e.request_id));
      const input = (e.request.input ?? {}) as Record<string, unknown>;
      const req: GateRequest = { id: String(e.request_id), tool: String(e.request.tool_name), input,
        canonical: canonical({ tool: e.request.tool_name, input }) };
      const answer = await opts.hooks.gate(req);
      pendingIds.delete(String(e.request_id));
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
