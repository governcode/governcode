// The Grok Runner (xAI's `grok` CLI, over ACP: acp.ts). One session per Spec, `grok agent
// --no-leader stdio` under govern-sup, in a private home of GovernCode's own (GROK_HOME and HOME):
// Connect signed Grok in there, and GovernCode writes its own config.toml into every run's home
// (ask for every tool, no hooks, no plugins, no Claude or Cursor compatibility, no memory, no
// updates), so nothing of the user's own Grok setup (which may auto-approve everything, and may
// run hooks) reaches a Runner. Grok's permission requests are Gates, answered "allow once" or
// rejected, never "allow always". Measured by the ACP extension `_x.ai/billing` (the same figure
// Grok's own /usage shows: credits used this period, and when the period ends), so Grok is a
// measured Runner like Codex.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { agyEnv, customizations, hold, safeWrite } from "./agy.ts";
import { isConnected, runHome } from "./homes.ts";
import { resolverFiles, toolchainDirs, RUNNER_CONTEXT, type Policy, type TurnHooks } from "./claude.ts";
import type { Measurement, UsageSource } from "./limits.ts";
import { runAcpTurn, startAcp, CLIENT_INFO } from "./acp.ts";

/** The real grok binary: $GOVERNCODE_GROK_BIN, else `grok` on PATH, looking through a mise shim. */
export function grokBinary(): string {
  if (process.env.GOVERNCODE_GROK_BIN) return process.env.GOVERNCODE_GROK_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, "grok");
    if (!dir || !existsSync(p)) continue;
    const real = realpathSync(p);
    if (readFileSync(real).subarray(0, 4).toString("latin1") === "\x7fELF") return real;
    try { return realpathSync(execFileSync("mise", ["which", "grok"], { encoding: "utf8" }).trim()); } catch { /* not mise */ }
    return real;
  }
  throw new Error("grok not found (install the Grok CLI, or set GOVERNCODE_GROK_BIN)");
}

/** GovernCode's config.toml for a run of Grok. Every call asks, reads and searches included
 *  (Grok's `ask` mode alone runs those quietly; an `ask` rule per tool makes each one a
 *  `session/request_permission`, and so a Gate, and outranks any `allow` a project could carry);
 *  nothing else is read from anywhere: no hooks, no plugins, no other tools' settings, no memory,
 *  no updater, no leader process, no dashboard, and folder trust stays on (a project's own hooks,
 *  MCP servers and instructions are never trusted in a fresh home).
 *  What a Runner has no use for is off outright, whatever the Crew card says: subagents (Grok's
 *  task tool) and background workflows (a scripting tool that can start agents of its own). Skills
 *  have no switch, but a fresh home holds none and a project's `.grok/` is refused, so Grok has
 *  no skill tool at all (seen live: "the skill invocation tool is missing"). Grok's guide lists the
 *  task list (todo_write) and the background-task tools (get_command_or_subagent_output,
 *  kill_command_or_subagent) as never prompting, and no rule can name them (the rule names are
 *  Bash, Read, Edit, Grep, MCPTool, WebFetch, WebSearch and "*"). Seen live under this config
 *  (Grok 1.0.44, the "*" ask rule): each of the three produced a session/request_permission
 *  before running, so each is a Gate. They stay: they change nothing outside the session. */
export function grokConfig(): string {
  return [
    "# Written by GovernCode for this run. The user's own Grok settings are not used.",
    "[ui]", 'permission_mode = "ask"', "remember_tool_approvals = false",
    // "*" covers the tools no rule can name (directory listings, task lists, skill lookups, subagent
    // control); the named ones are listed as well, in case a bare rule is ever read more narrowly.
    "[permission]", 'ask = ["*", "Read", "Grep", "Bash", "Edit", "WebFetch", "WebSearch", "MCPTool"]',
    "[folder_trust]", "enabled = true",
    "[session]", "load_envrc = false",   // a project's .envrc would give an allowed command an environment the Gate never showed
    "[cli]", "auto_update = false", "use_leader = false",
    "[compat.claude]", "agents = false", "hooks = false", "mcps = false", "rules = false", "skills = false",
    "[compat.cursor]", "agents = false", "hooks = false", "mcps = false", "rules = false", "skills = false",
    "[compat.codex]", "hooks = false", "skills = false",
    "[plugins]", "enabled = []",
    "[memory]", "enabled = false",
    "[memory_v2]", "enabled = false",
    "[dashboard]", "enabled = false",
    "[features]", "telemetry = false",
    "[sandbox]", "auto_allow_bash = false",
    "[subagents]", "enabled = false",
    "[workflows]", "enabled = false",
    "",
  ].join("\n");
}

/** What Grok must be able to write in its home to run at all, found by running it under the
 *  sandbox with less and less writable (Grok 1.0.44): these exist in every run home before Grok
 *  starts, and the sandbox lets the run write them and nothing else there.
 *  - sessions/: the session's transcript, state and locks; without it session/new fails
 *    ("Permission denied"). Grok also keeps remembered approvals here (see grokPolicy).
 *  - logs/: its own log; the session search index bootstrap warns without it.
 *  - agent_id, .metadata_version, .config-init.lock, managed_config.lock: written at startup.
 *  Everything else it would like to write (its docs and README copies, caches, plugin registry)
 *  is refused, and it runs without them with no warning in its log. The home itself is not
 *  writable, so config.toml can be neither changed nor replaced; the login link is read-only too
 *  (a run cannot swap GovernCode's login; Grok's own token refresh then waits for the next Connect). */
export const GROK_HOME_DIRS = ["sessions", "logs"];
export const GROK_HOME_FILES = ["agent_id", ".metadata_version", ".config-init.lock", "managed_config.lock"];

/** A fresh, empty home for one run (homes.ts: made by mkdtemp, deleted when the run's processes
 *  are gone), with the GovernCode login linked in, GovernCode's config, and the places Grok may
 *  write, made in advance. Nothing a run leaves in it, a remembered approval included, is there
 *  for the next run. */
export function grokRunHome(stateDir: string): ReturnType<typeof runHome> {
  const rh = runHome(stateDir, "grok", "auth.json");
  try {
    safeWrite(join(rh.home, "config.toml"), grokConfig());
    for (const d of GROK_HOME_DIRS) mkdirSync(join(rh.home, d), { recursive: true, mode: 0o700 });
    for (const f of GROK_HOME_FILES) writeFileSync(join(rh.home, f), "", { flag: "a", mode: 0o600 });
  } catch (e) { rh.finish(); throw e; }
  return rh;
}
/** The run's writable places in its home: the folders and files above, as they exist. */
export function grokWritable(home: string): string[] {
  return [...GROK_HOME_DIRS, ...GROK_HOME_FILES].map((p) => join(home, p)).filter(existsSync);
}

export const GROK_ENV = (tmp: string, home: string) => agyEnv(tmp, home, { GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" });

// Grok reads a project's own settings: `.grok/` (permission rules that can pre-approve tools,
// hooks, plugins, workflows), `.agents/` (its skill and command scan), Claude Code's
// `.claude/settings*.json` (a permission mode, rules) and `.mcp.json`, Cursor's
// `.cursor/hooks.json`, and instruction files (AGENTS.md and its variants, which Grok loads from
// every directory between the repo root and where it works). A project that has any of them,
// anywhere in the copy, is refused, as for Antigravity's customizations, and a Runner that
// creates one fails its Spec. The walk does not follow links, and a committed link survives
// `git archive`, so a link to a folder (a way past the walk) or to anywhere outside the copy
// is refused as well; a link to a file inside the copy is fine.
export const GROK_INSTRUCTIONS = ["AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md", "Claude.md", "CLAUDE.local.md"];
export const GROK_ROOTS = [".grok", ".agents", ".claude", ".cursor", ".mcp.json", ...GROK_INSTRUCTIONS];
const GROK_NESTED: Record<string, string[]> = { ".claude": ["settings.json", "settings.local.json"], ".cursor": ["hooks.json"] };
export function grokSettings(worktree: string): string[] {
  const found: string[] = [];
  for (const hit of customizations(worktree, 20_000, GROK_ROOTS)) {
    if (hit.startsWith("(")) { found.push("too many files to check"); continue; }
    const inside = GROK_NESTED[hit.split("/").pop() ?? ""];
    if (!inside) { found.push(hit); continue; }
    for (const name of inside) if (existsSync(join(worktree, hit, name))) found.push(join(hit, name));
  }
  if (found.includes("too many files to check")) return found;   // no second walk of a tree too big for the first
  return [...found, ...unsafeLinks(worktree)];
}

/** Links in a copy that lead to a folder, out of the copy, or nowhere (which cannot be checked).
 *  A folder that cannot be listed cannot be checked either, so it counts as unsafe (fail closed;
 *  today the snapshot's own listing fails first, so this is a second line).
 *  Two limits, accepted: the check runs before the run starts, and the copy belongs to the same
 *  user, so something else running as that user could change it between the check and the
 *  start; and a link made and removed again during the run is not seen by the check after it
 *  (Grok's folder trust keeps a project's own hooks, MCP servers and instructions unloaded in a
 *  fresh home either way). */
export function unsafeLinks(worktree: string, max = 20_000): string[] {
  const found: string[] = [];
  let real: string;
  try { real = realpathSync(worktree); } catch { return [`${worktree} (cannot be checked)`]; }
  let seen = 0;
  const walk = (dir: string): boolean => {
    let names: string[];
    try { names = readdirSync(dir); } catch { found.push(`${relative(worktree, dir) || "."} (a folder that cannot be listed)`); return false; }
    for (const name of names) {
      if (++seen > max) { found.push("too many files to check"); return false; }
      const p = join(dir, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (name === ".git" && !st.isSymbolicLink()) continue;   // (a copy has no .git; a link by that name is a link like any other)
      if (st.isSymbolicLink()) {
        let target: string | null = null;
        try { target = realpathSync(p); } catch { /* dangling */ }
        const inside = target !== null && (target === real || target.startsWith(real + sep));
        let toDir = false;
        try { toDir = target !== null && lstatSync(target).isDirectory(); } catch { /* gone */ }
        if (target === null || !inside || toDir) found.push(`${relative(worktree, p)} (a link${target === null ? " to nothing" : !inside ? " out of the copy" : " to a folder"})`);
      } else if (st.isDirectory() && !walk(p)) return false;
    }
    return true;
  };
  walk(worktree);
  return found;
}

const policyName = (kind: string) => `grok-${kind}-${process.pid}-${randomBytes(6).toString("hex")}.json`;

/** The run's sandbox: its home readable, and writable only where Grok keeps its sessions, logs
 *  and locks (grokWritable), never its config or its login.
 *  ponytail: Grok keeps remembered approvals under sessions/ (a folder it must be able to
 *  write), so a command the user allowed could plant one for the rest of that run. GovernCode
 *  never grants one (the "always allow" choices are off and never chosen), the run's home is
 *  fresh and deleted afterwards, and the sandbox bounds every call to the Spec's scope either
 *  way. Upgrade: a per-file rule if Grok ever lets the approvals file live outside sessions/. */
export function grokPolicy(o: { work: string; tmp: string; home: string; bin: string; writePaths?: string[]; readOnly?: boolean; gitDir?: string; login?: string }): Policy {
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom", "/dev/random",
      dirname(o.bin), o.home, ...(o.login ? [o.login] : []), ...resolverFiles(),
      // A Spec's Runner reads its whole worktree (and the repo's git data) but writes only its scope.
      o.work, ...(o.gitDir ? [o.gitDir] : [])].filter((p) => p === o.work || existsSync(p)),
    write: [...(o.readOnly ? [] : o.writePaths ?? [o.work]), o.tmp, ...grokWritable(o.home), "/dev/null"],
    exec: ["/usr/bin", "/bin", "/usr/lib", dirname(o.bin), ...toolchainDirs()],
    tcp_connect: [443],
    unix_connect: ["/run/systemd/resolve/io.systemd.Resolve"].filter(existsSync),
    cwd: o.work,
  };
}

type Opts = { supervisor: string; policyDir: string; stateDir: string };

/** Grok's `_x.ai/billing` answer as a Measurement: credits used this period, as a percentage,
 *  and the period's end. Null when there is no figure from 0 to 100 (= held): Grok leaves the
 *  field out until the account has used something in the period, and unknown holds. */
export function parseBilling(r: unknown): Measurement | null {
  const c = (r as any)?.config;
  if (!c || typeof c !== "object") return null;
  const period = c.currentPeriod && typeof c.currentPeriod === "object" && !Array.isArray(c.currentPeriod) ? c.currentPeriod : null;
  // Only a figure between 0 and 100 is a reading. Grok leaves the field out until an account has
  // used something in the period: that is unknown, so held, and `why` says what to do.
  const pct = typeof c.creditUsagePercent === "number" && Number.isFinite(c.creditUsagePercent) && c.creditUsagePercent >= 0 && c.creditUsagePercent <= 100 ? c.creditUsagePercent : null;
  if (pct === null) return null;
  const type = String(period?.type ?? "").replace(/^USAGE_PERIOD_TYPE_/, "").toLowerCase();
  const end = typeof period?.end === "string" ? Date.parse(period.end) : NaN;
  return { provider: "grok", measuredAt: Date.now(), readings: [{ window: type === "weekly" ? "weekly" : type === "monthly" ? "monthly" : "period",
    usedPercent: pct, resetsAt: Number.isFinite(end) ? new Date(end).toISOString() : null }] };
}

/** One authenticated request with GovernCode's Grok login (Connect uses it to check that the
 *  login really works): Grok's usage this period. Null when it cannot be read. */
export async function readGrokUsage(o: Opts & { scratch: string }): Promise<Measurement | null> {
  let bin: string;
  try { bin = grokBinary(); } catch { return null; }
  // Everything taken here is given back once every process of the check is gone, or at once
  // when the check cannot even start.
  const cleanups: Array<() => void> = [];
  const cleanup = () => { for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } } cleanups.length = 0; };
  let rpc: ReturnType<typeof startAcp>;
  try {
    mkdirSync(o.scratch, { recursive: true, mode: 0o700 });
    mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
    cleanups.push(hold(o.stateDir, "grok"));
    const tmp = mkdtempSync(join(tmpdir(), "governcode-grok-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const rh = grokRunHome(o.stateDir);
    cleanups.push(() => rh.finish());
    const policyFile = join(o.policyDir, policyName("usage"));
    cleanups.push(() => rmSync(policyFile, { force: true }));
    writeFileSync(policyFile, JSON.stringify(grokPolicy({ work: o.scratch, tmp, home: rh.home, bin, readOnly: true, login: rh.login })), { mode: 0o600 });
    rpc = startAcp({ supervisor: o.supervisor, policyFile, bin, args: ["agent", "--no-leader", "stdio"], env: GROK_ENV(tmp, rh.home), cwd: o.scratch });
  } catch { cleanup(); return null; }
  try {
    const init = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: CLIENT_INFO }, 20_000);
    if (init?.protocolVersion !== 1) return null;
    return parseBilling(await rpc.request("_x.ai/billing", {}, 20_000));
  } catch {
    return null;
  } finally {
    rpc.close(10_000);
    await rpc.closed;   // the home and the hold go only once every process of the check is gone
    cleanup();
  }
}

export function grokUsage(o: Opts & { scratch: string }): UsageSource {
  let why: string | null = null;
  return {
    provider: "grok",
    why: () => why,
    async read(): Promise<Measurement | null> {
      if (!isConnected(o.stateDir, "grok")) { why = "Grok is not connected (gov connect grok)"; return null; }
      const m = await readGrokUsage(o);
      why = m ? null : "Grok did not report a usage figure (an account that has used nothing this period reports none: use Grok once outside GovernCode; or its login may need signing in again: gov connect grok)";
      return m;
    },
  };
}

/** One Grok Runner turn. Permission requests reach `hooks.gate`; text and steps stream to
 *  `hooks.text` / `hooks.tool`; done reports the result and token usage. */
export async function runGrokTurn(o: Opts & { worktree: string; writePaths: string[]; gitDir?: string; model: string; effort: string | null;
  prompt: string; hooks: TurnHooks; signal?: AbortSignal }): Promise<void> {
  let finished = false;
  const cleanups: Array<() => void> = [];
  const finish = (r: { ok: boolean; summary: string; usage?: unknown }) => {
    if (finished) return; finished = true;
    for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
    o.hooks.done(r);
  };
  try {
    let bin: string;
    try { bin = grokBinary(); } catch (e) { return finish({ ok: false, summary: String(e instanceof Error ? e.message : e) }); }
    if (!isConnected(o.stateDir, "grok")) return finish({ ok: false, summary: "Grok is not connected: run gov connect grok" });
    const found = grokSettings(o.worktree);
    if (found.length) return finish({ ok: false, summary: `the project has settings Grok would read (${found.slice(0, 3).join(", ")}); GovernCode does not run a Grok Runner with a project's own permission rules, hooks, MCP servers or instructions` });
    cleanups.push(hold(o.stateDir, "grok"));
    mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(tmpdir(), "governcode-grok-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const rh = grokRunHome(o.stateDir);   // (subagents are off for every Grok run, whatever the Crew card says)
    cleanups.push(() => rh.finish());   // (normally after the process has exited; see below)
    const policyFile = join(o.policyDir, policyName("run"));
    cleanups.push(() => rmSync(policyFile, { force: true }));
    writeFileSync(policyFile, JSON.stringify(grokPolicy({ work: o.worktree, tmp, home: rh.home, bin, writePaths: o.writePaths, gitDir: o.gitDir, login: rh.login })), { mode: 0o600 });
    const args = ["agent", "--no-leader", ...(o.model ? ["-m", o.model] : []), ...(o.effort ? ["--reasoning-effort", o.effort] : []), "stdio"];
    const rpc = startAcp({ supervisor: o.supervisor, policyFile, bin, args, env: GROK_ENV(tmp, rh.home), cwd: o.worktree });
    // The run's home goes once govern-sup has closed (every process of the run gone), whether the
    // turn ends normally or Grok dies first.
    void rpc.closed.then(() => rh.finish());
    let result;
    try {
      result = await runAcpTurn({ rpc, agent: "grok", cwd: o.worktree, prompt: `${RUNNER_CONTEXT}\n\n${o.prompt}`, hooks: o.hooks, signal: o.signal });
    } finally {
      // Nothing is checked or recorded until the sandbox reports every process gone (a snapshot
      // taken earlier could miss a last write).
      rpc.close();
      await rpc.closed;
    }
    // A Runner that created Grok settings could pre-approve its tools in later runs.
    const made = grokSettings(o.worktree);
    if (made.length) return finish({ ok: false, summary: `the Runner created Grok settings (${made.slice(0, 3).join(", ")}); not offered`, usage: result.usage });
    finish(result);
  } catch (e) {
    finish({ ok: false, summary: `the Grok Runner could not start: ${e instanceof Error ? e.message : e}` });
  }
}
