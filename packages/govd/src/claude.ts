// The Claude Code driver: one sandboxed `claude` process per turn (phase 0), driven over its
// stream-json protocol. Permission requests arrive as control_request/can_use_tool and become
// Gates answered by the user through govd, never by the harness itself.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { runHome } from "./homes.ts";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { ControllerChoice } from "@governcode/protocol";

export type Policy = { version: 1; read: string[]; write: string[]; exec: string[]; tcp_connect: number[]; tcp_bind?: number[]; unix_connect: string[]; cwd: string };

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
  "The user talks to you in plain words; turn that into the right steps yourself, and prefer simple, direct commands",
  "(the project's own scripts, such as npm test, rather than an interpreter run by hand).",
  "To hand a job to another AI coding tool, use the governcode delegate tool: call crew to see who is available, then",
  "work out the brief, what done means and the scope (the files it may read and write) yourself, from the request and",
  "the code. Leave model empty unless the user named one, so the Runner uses its own default; never guess model names.",
  "It checks that tool's usage Limit itself, so no other quota or budget check is needed (instructions elsewhere that",
  "ask for one do not apply here). A Spec's result waits for the user's review: tell them what you think of it. If a",
  "Spec's work is wrong, you may throw it away with spec_discard and delegate again; only the user can accept one.",
  "Keep the project's notes current with project_notes (goal, decisions, open questions, next steps; short): the next",
  "Controller of this project, possibly another AI, reads them first, and the user can see and edit them.",
  "Steps that need approval are shown to the user as Gates. If you need to ask the user something, ask in your reply.",
].join(" ");
export const RUNNER_CONTEXT = [
  "You are a Runner in GovernCode: another AI handed you this job (a Spec).",
  "You work in your own copy of the project, inside a sandbox the operating system enforces; you can write only the",
  "files the Spec allows, and some commands will fail with permission errors by design. Do not try to work around them.",
  "The user reviews your changes before anything reaches the real project.",
].join(" ");

export type GateRequest = { id: string; tool: string; input: Record<string, unknown>; canonical: string; actor?: string;
  base?: string; spec?: string };   // host-owned analysis base (semantic or undecorated tool); Runner Spec for standing allows
export type TurnHooks = {
  text(chunk: string): void;
  tool(name: string, input: Record<string, unknown>): void;
  gate(req: GateRequest): Promise<"allow" | "deny">;
  notice?(text: string): void;
  // started false: no process of the tool got going (it could not start), so nothing was used.
  done(result: { ok: boolean; summary: string; usage?: unknown; started?: false; limit?: { resetsAt: string | null } }): void;
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

/** The user's own Claude Code folder: only its personal files are ever reachable, and only
 *  when the user chose to bring them. */
export const userClaudeDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const PERSONAL_CLAUDE = ["CLAUDE.md", "skills", "plugins", "hooks", "agents", "commands", "output-styles", "rules", "settings.json"];

// Keys kept from the user's own settings.json when they bring their personal setup: what shapes
// Claude Code's behaviour, never its credentials or where it sends requests (env, apiKeyHelper,
// credential exports, proxies: Codex's review).
const SETTINGS_KEEP = ["hooks", "enabledPlugins", "outputStyle", "permissions", "includeCoAuthoredBy", "alwaysThinkingEnabled", "statusLine"];

/** A fresh Claude Code home for one turn (homes.ts): the GovernCode login linked in, and the
 *  user's personal files only when they chose to bring them (instructions, skills, agents,
 *  commands, plugins, hooks linked read-only; settings.json copied with only SETTINGS_KEEP). */
export function claudeRunHome(stateDir: string, personal: boolean): { home: string; login: string; finish(): void } {
  const rh = runHome(stateDir, "claude", ".credentials.json");
  if (personal) {
    // The turn's HOME is this home (runTurn); hooks the user wrote as ~/.claude/... still find
    // their files through this link (only the files they chose to bring are readable).
    if (existsSync(userClaudeDir())) symlinkSync(userClaudeDir(), join(rh.home, ".claude"));
    for (const name of PERSONAL_CLAUDE) {
      const src = join(userClaudeDir(), name);
      if (name === "settings.json" || !existsSync(src)) continue;
      symlinkSync(src, join(rh.home, name));
    }
    try {
      const mine = JSON.parse(readFileSync(join(userClaudeDir(), "settings.json"), "utf8")) as Record<string, unknown>;
      const kept = Object.fromEntries(Object.entries(mine).filter(([k]) => SETTINGS_KEEP.includes(k)));
      writeFileSync(join(rh.home, "settings.json"), JSON.stringify(kept), { mode: 0o600 });
    } catch { /* none, or not JSON */ }
  }
  return rh;
}

export function claudePolicy(worktree: string, sessionTmp: string, readOnly = false, mcp?: McpServer, personal = false,
                             cfg = join(tmpdir(), "governcode-no-claude-home"), login?: string): Policy {
  const bin = realpathSync(which("claude"));
  // GovernCode's own Claude home (cfg) is the tool's: its login, state and transcripts, writable.
  // The user's own ~/.claude and ~/.claude.json are not in this policy at all; their personal
  // files (instructions, skills, agents, commands, plugins, hooks, settings) are readable only when
  // the user chose to bring them, through the links prepareClaudeHome made.
  // (settings.json is copied in, filtered, never read from the user's folder by the tool.)
  const personalRead = personal ? PERSONAL_CLAUDE.filter((n) => n !== "settings.json").map((n) => join(userClaudeDir(), n)) : [];
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom",
      "/dev/random", dirname(bin), cfg, ...(login ? [login] : []), ...personalRead, ...resolverFiles(), ...(readOnly ? [worktree] : [])].filter(
      (p) => p === worktree || existsSync(p)),
    // The turn's own fresh home, and the shared login file (a token refresh may write it in place).
    write: [...(readOnly ? [] : [worktree]), sessionTmp, "/dev/null", ...(existsSync(cfg) ? [cfg] : []), ...(login && existsSync(login) ? [login] : [])],
    exec: ["/usr/bin", "/bin", "/usr/lib", dirname(bin), ...(mcp ? [dirname(mcp.node)] : []), ...toolchainDirs()],
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

// No provider keys or config locations (ANTHROPIC_*, CLAUDE_*, OPENAI_*...): every tool uses the
// login Connect made in its GovernCode home, never an API key from the user's shell.
const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|HTTPS?_PROXY|NO_PROXY)$/;

export function toolEnv(tmp: string): Record<string, string> {
  // npm keeps its cache and logs in ~/.npm, which the sandbox does not let it write: give it
  // one inside this run's own scratch folder.
  const env: Record<string, string> = { TMPDIR: tmp, npm_config_cache: join(tmp, "npm-cache"), npm_config_update_notifier: "false" };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && ENV_KEEP.test(k)) env[k] = v;
  return env;
}

// Language tools a project's commands commonly run. Installed by a version manager (mise, nvm,
// asdf, fnm, volta, pyenv...) they live in the user's home, outside the system folders the
// sandbox runs programs from; `npm test` then fails in the sandbox while it works in the shell
// (first fresh-install test, 2026-09-27).
const TOOLCHAIN = ["node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "python3", "python", "pip", "pip3", "uv",
  "ruby", "bundle", "go", "java", "cargo", "rustc"];

/** The install folders of the user's own toolchains, found on PATH: each tool's real location,
 *  two levels up (…/node/26.7.0 for …/node/26.7.0/bin/node), so its libraries come along. Read
 *  and run only, never write. Never a folder directly in home (~/.cargo, ~/.local), which can
 *  hold credentials or much more than a toolchain.
 *  ponytail: a shim-based setup (mise shims, rustup proxies) resolves to such a folder and is
 *  skipped; those tools still run from the system if installed there. */
export function toolchainDirs(path = process.env.PATH ?? "", home = homedir()): string[] {
  const out = new Set<string>();
  for (const t of TOOLCHAIN) {
    let real: string;
    try { real = realpathSync(whichIn(t, path)); } catch { continue; }
    if (!real.startsWith(home + "/")) continue;                  // system tools are already allowed
    const root = dirname(dirname(real));
    const rel = root.slice(home.length + 1);
    if (!rel || !rel.includes("/")) continue;                    // home itself, or ~/.cargo-like
    out.add(root);
  }
  return [...out];
}

function whichIn(cmd: string, path: string): string {
  for (const dir of path.split(":")) {
    const p = join(dir, cmd);
    if (dir && existsSync(p)) return p;
  }
  throw new Error(`${cmd} not found on PATH`);
}

export function which(cmd: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, cmd);
    if (existsSync(p)) return p;
  }
  throw new Error(`${cmd} not found on PATH`);
}

/** Every tool that acts, sent back to GovernCode whatever the user's own Claude Code settings
 *  allow. The user's settings are loaded (their model and preferences), and in Claude Code an
 *  "ask" rule outranks an "allow" rule, so a permissive `permissions.allow` there can never
 *  skip GovernCode's Gate; GovernCode then applies its own rules (quiet reads, standing allows).
 *  Found in the first fresh-install test, 2026-09-27: `npm test` ran with no Gate. Reads
 *  (Read, Glob, Grep) are not listed: Claude Code does not ask for them, the sandbox bounds them. */
// GovernCode's delegate and spec_discard are not here: govd itself decides them (a Gate inside the
// call), so a Controller reaching the turn socket some other way gains nothing.
export const ASK_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"];

export function runTurn(opts: {
  supervisor: string; policyDir: string; worktree: string; readOnly?: boolean; controller: ControllerChoice; prompt: string; hooks: TurnHooks;
  mcp?: McpServer; personal?: boolean; noSubagents?: boolean; stateDir: string;
}): { cancel(): void } {
  const configuredStall = Number(process.env.GOVERNCODE_LIMIT_STALL_MS);
  const limitStallMs = Number.isFinite(configuredStall) && configuredStall >= 0 ? configuredStall : 60_000;
  mkdirSync(opts.policyDir, { recursive: true, mode: 0o700 });
  const sessionTmp = mkdtempSync(join(tmpdir(), "governcode-turn-"));
  const rh = claudeRunHome(opts.stateDir, opts.personal === true);
  const cfg = rh.home;
  const policyFile = join(opts.policyDir, `turn-${process.pid}-${Date.now()}.json`);
  writeFileSync(policyFile, JSON.stringify(withMcpRead(claudePolicy(opts.worktree, sessionTmp, opts.readOnly, opts.mcp, opts.personal, cfg, rh.login), opts.mcp)), { mode: 0o600 });

  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-prompt-tool", "stdio", "--permission-mode", "default",
    // Never the worktree's settings (the harness can write them), and the user's own only when
    // they chose to bring them: otherwise no settings file at all, so nothing a turn writes into
    // its home's settings.json can take effect.
    "--setting-sources", opts.personal ? "user" : "", "--no-session-persistence",
    // Without personal instructions the user's hooks do not run either.
    "--settings", JSON.stringify({ permissions: { ask: ASK_TOOLS }, ...(opts.personal ? {} : { disableAllHooks: true }) }),
    "--model", opts.controller.model, ...(opts.controller.effort ? ["--effort", opts.controller.effort] : []),
    "--append-system-prompt", CONTROLLER_CONTEXT,
    // GovernCode's own tools for the Controller, and no other MCP servers from anywhere.
    ...(opts.mcp ? ["--mcp-config", JSON.stringify({ mcpServers: { governcode: { command: opts.mcp.node, args: [opts.mcp.script, opts.mcp.socket, ...(opts.mcp.mode ? [opts.mcp.mode] : [])] } } }),
      "--strict-mcp-config"] : []),
    // Proposing a project creates nothing (the user's Create does), so it needs no Gate of its own;
    // listing the Runners and reading a Spec's status only read.
    "--allowedTools", opts.mcp?.mode === "home" ? "mcp__governcode__propose_project" : "mcp__governcode__crew,mcp__governcode__spec_status,mcp__governcode__project_notes,mcp__governcode__conversation_read,mcp__governcode__plan,mcp__governcode__delegate,mcp__governcode__spec_discard,mcp__governcode__spec_cancel,mcp__governcode__spec_followup",
    // The Crew card's "no subagents": Claude Code's subagent tool is not available at all.
    ...(opts.noSubagents ? ["--disallowedTools", "Task,Agent"] : [])];
  // A clean environment: govd's own variables (and anything else in the user's shell) are
  // none of the tool's business. Its own process group, so finishing the turn ends every
  // process it started, not only the one that printed the result.
  const child = spawn(opts.supervisor, ["run", "--policy", policyFile, "--", which("claude"), ...args], {
    cwd: opts.worktree, stdio: ["pipe", "pipe", "pipe"], detached: true,
    // A delegated Spec can run for many minutes while the Controller's tool call waits.
    // HOME is the run's own home too: the user's shell files (~/.bashrc), which the sandbox does
    // not let it read, are not there to fail on every command.
    env: { ...toolEnv(sessionTmp), HOME: cfg, CLAUDE_CONFIG_DIR: cfg, MCP_TOOL_TIMEOUT: String(60 * 60_000) },
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
  child.stdin.on("error", () => {});   // a dead harness is reported by its exit, not by EPIPE
  // The run's home is finished (login put back, folder removed) only once govern-sup has exited,
  // which it does after every process of the run is gone.
  child.on("close", () => rh.finish());
  // A sandbox that could not even start ends the turn too (no exit event may follow).
  child.on("error", (e) => { rh.finish(); finish({ ok: false, summary: `the sandbox could not start: ${e.message}` }); });
  const send = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: opts.prompt }] } });

  let finished = false;
  // Usage limits (#226): each window Claude Code reports rejected, with its reset time (null when it
  // gives none). The reset is the latest of them, or unknown if any is: never guessed (T3's rule).
  let limitStall: NodeJS.Timeout | undefined;
  const blockedWindows = new Map<string, number | null>();
  const noticedLimits = new Set<string>();
  const resetsAt = (): string | null => {
    const times = [...blockedWindows.values()];
    if (times.length === 0 || times.some((v) => v === null)) return null;
    return new Date(Math.max(...times.map((v) => v!))).toISOString();
  };
  const finish = (r: { ok: boolean; summary: string; usage?: unknown; limit?: { resetsAt: string | null } }) => {
    if (finished) return;
    finished = true;
    if (limitStall) clearTimeout(limitStall);
    child.stdin.end();
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ }
    rmSync(policyFile, { force: true });
    rmSync(sessionTmp, { recursive: true, force: true });
    opts.hooks.done(r);
  };
  // A rejected window can pause Claude Code without ending its turn: with no result and no output
  // for a while (GOVERNCODE_LIMIT_STALL_MS, 60 s), the turn ends as limited.
  const armLimitStall = () => {
    if (limitStall) clearTimeout(limitStall);
    limitStall = undefined;
    if (blockedWindows.size === 0 || pendingIds.size > 0 || finished) return;
    limitStall = setTimeout(() => finish({ ok: false, summary: "Claude Code hit its usage limit",
      limit: { resetsAt: resetsAt() } }), limitStallMs);
  };
  const resetTime = (seconds: unknown): number | null => {
    const ms = Number(seconds) * 1000;
    return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? ms : null;
  };
  const clockTime = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const pendingIds = new Set<string>();
  createInterface({ input: child.stdout }).on("line", async (line) => {
    let e: Record<string, any>;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === "assistant") {
      armLimitStall();
      for (const c of e.message?.content ?? []) {
        if (c.type === "text") opts.hooks.text(c.text);
        if (c.type === "tool_use") opts.hooks.tool(c.name, c.input ?? {});
      }
    } else if (e.type === "tool_progress") {
      armLimitStall();
    } else if (e.type === "control_request" && e.request?.subtype === "can_use_tool") {
      // One Gate per request id at a time: a repeated id while one is pending is ignored,
      // so an answer can never land on a different request than the one shown.
      if (pendingIds.has(String(e.request_id))) return;
      pendingIds.add(String(e.request_id));
      armLimitStall();
      const input = (e.request.input ?? {}) as Record<string, unknown>;
      const req: GateRequest = { id: String(e.request_id), tool: String(e.request.tool_name), input,
        canonical: canonical({ tool: e.request.tool_name, input }) };
      const answer = await opts.hooks.gate(req);
      pendingIds.delete(String(e.request_id));
      // Allow runs exactly the input that was shown, never a variant (the #177 lesson).
      send({ type: "control_response", response: { subtype: "success", request_id: e.request_id,
        response: answer === "allow" ? { behavior: "allow", updatedInput: input }
                                     : { behavior: "deny", message: "Denied at the Gate." } } });
      armLimitStall();
    } else if (e.type === "rate_limit_event") {
      const info = e.rate_limit_info ?? {};
      const window = String(info.rateLimitType ?? "unknown");
      const overageAllowed = info.overageStatus === "allowed" || info.overageStatus === "allowed_warning" ||
        info.isUsingOverage === true || info.overageInUse === true;
      if (info.status === "rejected" && !overageAllowed) {
        const reset = resetTime(info.resetsAt);
        blockedWindows.set(window, reset);
        const noticeKey = `${window}:${reset ?? "none"}`;
        if (!noticedLimits.has(noticeKey)) {
          noticedLimits.add(noticeKey);
          opts.hooks.notice?.(`Claude Code hit its usage limit (${reset === null ? "no reset time given" : `resets ${clockTime(reset)}`})`);
        }
        armLimitStall();
      } else if (info.status === "allowed" || info.status === "allowed_warning" || overageAllowed) {
        blockedWindows.delete(window);
        armLimitStall();
      }
    } else if (e.type === "result") {
      // Limited: a blocking limit or a 429, a window still rejected, or older versions' text form.
      const textEpoch = /usage limit reached\|(\d{9,})/i.exec(String(e.result ?? ""));
      const remembered = blockedWindows.size > 0 &&
        (e.subtype !== "success" || e.api_error_status == null || e.api_error_status === 429) &&
        (e.terminal_reason == null || e.terminal_reason === "api_error" || e.terminal_reason === "blocking_limit");
      const limited = textEpoch !== null || remembered || e.terminal_reason === "blocking_limit" ||
        (e.subtype === "success" && e.api_error_status === 429);
      if (limited) {
        const reset = textEpoch ? resetTime(textEpoch[1]) : null;
        finish({ ok: false, summary: "Claude Code hit its usage limit", usage: e.usage,
          limit: { resetsAt: textEpoch ? (reset === null ? null : new Date(reset).toISOString()) : resetsAt() } });
      } else {
        finish({ ok: !e.is_error, summary: String(e.result ?? e.subtype ?? ""), usage: e.usage });
      }
    }
  });
  // After its output closes, not at exit: a result written just before exiting may still be unread.
  child.on("close", (code) => finish({ ok: false, summary: code === 0 ? "ended without a result" :
    `sandbox or harness exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}` }));
  return { cancel: () => child.kill("SIGTERM") };
}
