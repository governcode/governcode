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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** GovernCode's config.toml for a run of Grok. Every command, file change, web fetch or search
 *  and MCP call asks (the request becomes a Gate; an `ask` rule outranks any `allow` a project
 *  could carry), plain reads and searches of the sandboxed copy run quietly as for every Runner;
 *  nothing else is read from anywhere: no hooks, no plugins, no other tools' settings, no memory,
 *  no updater, no leader process, no dashboard. */
export function grokConfig(o: { noSubagents?: boolean } = {}): string {
  return [
    "# Written by GovernCode for this run. The user's own Grok settings are not used.",
    "[ui]", 'permission_mode = "ask"', "remember_tool_approvals = false",
    "[permission]", 'ask = ["Bash", "Edit", "WebFetch", "WebSearch", "MCPTool"]',
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
    ...(o.noSubagents ? ["[subagents]", "enabled = false"] : []),
    "",
  ].join("\n");
}

/** A fresh home for one run (homes.ts): the GovernCode login linked in, GovernCode's config. */
export function grokRunHome(stateDir: string, o: { noSubagents?: boolean } = {}): ReturnType<typeof runHome> {
  const rh = runHome(stateDir, "grok", "auth.json");
  try { safeWrite(join(rh.home, "config.toml"), grokConfig(o)); } catch (e) { rh.finish(); throw e; }
  return rh;
}

export const GROK_ENV = (tmp: string, home: string) => agyEnv(tmp, home, { GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1" });

// Grok reads a project's own `.grok/` (permission rules that can pre-approve tools, hooks,
// plugins), so a project that has one is refused, as for Antigravity's customizations. It also
// reads a project's Claude Code settings for a permission mode: one that switches asking off
// (`defaultMode`) would pass file changes and web calls without a Gate, so a project whose
// Claude settings set any mode is refused too (ponytail: a mode of "default" would be harmless,
// but the file is read as a whole and a mode is a mode; upgrade when a real project needs it).
export const GROK_ROOTS = [".grok"];
export function grokSettings(worktree: string): string[] {
  const found = customizations(worktree, 20_000, GROK_ROOTS);
  for (const dir of customizations(worktree, 20_000, [".claude"])) {
    if (dir.startsWith("(")) { found.push(dir); continue; }
    for (const name of ["settings.json", "settings.local.json"]) {
      const p = join(worktree, dir, name);
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (j?.permissions?.defaultMode !== undefined || j?.defaultMode !== undefined) found.push(join(dir, name));
      } catch { found.push(join(dir, name)); }   // unreadable: not shown to be safe
    }
  }
  return found;
}

const policyName = (kind: string) => `grok-${kind}-${process.pid}-${randomBytes(6).toString("hex")}.json`;

// ponytail: the run's home is writable as a whole (Grok writes its sessions, logs and locks at
// its top level), config.toml included, so a command the user allowed could rewrite the config
// there. Grok reads its permission rules once, when the session starts, so the running session
// keeps GovernCode's; the home is deleted afterwards, and the sandbox bounds every write to the
// Spec's scope either way. Upgrade: a read-only config once Grok reads it from a path of
// its own (a managed config outside the home), as Antigravity's config folder is.
export function grokPolicy(o: { work: string; tmp: string; home: string; bin: string; writePaths?: string[]; readOnly?: boolean; gitDir?: string; login?: string }): Policy {
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom", "/dev/random",
      dirname(o.bin), o.home, ...(o.login ? [o.login] : []), ...resolverFiles(),
      // A Spec's Runner reads its whole worktree (and the repo's git data) but writes only its scope.
      o.work, ...(o.gitDir ? [o.gitDir] : [])].filter((p) => p === o.work || existsSync(p)),
    write: [...(o.readOnly ? [] : o.writePaths ?? [o.work]), o.tmp, o.home, ...(o.login && existsSync(o.login) ? [o.login] : []), "/dev/null"],
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
  prompt: string; hooks: TurnHooks; signal?: AbortSignal; noSubagents?: boolean }): Promise<void> {
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
    if (found.length) return finish({ ok: false, summary: `the project has Grok settings (${found.slice(0, 3).join(", ")}); GovernCode does not run a Grok Runner with a project's own permission rules, modes, hooks or plugins` });
    cleanups.push(hold(o.stateDir, "grok"));
    mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(tmpdir(), "governcode-grok-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const rh = grokRunHome(o.stateDir, { noSubagents: o.noSubagents });
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
