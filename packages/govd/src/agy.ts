// The Antigravity driver (Google's `agy` CLI) for Runners. One print-mode turn per Spec,
// `agy -p BRIEF --output-format stream-json`, under govern-sup, in the tool's own private home
// (Connect signs it in there; GovernCode never reads its login). Every tool call passes
// Antigravity's documented PreToolUse hook, which is GovernCode's: it asks govd over this run's
// socket, and govd answers from the user's Gate. Measured by `agy -p /quota` (costs no quota).
//
// Keeping the Gate locked (probed 2026-09-28, agy 1.2.12):
// - the home's config folder (hooks, plugins, MCP servers) is read-only in the sandbox and
//   rewritten by govd before every run;
// - a failing hook denies (crash, timeout and garbage output all blocked the write);
// - a hook named in a project's `.agents/hooks.json` with "enabled": false switched a named hook
//   off on the next run, so the hook's name is random per run, a Spec whose copy holds Antigravity
//   customizations is refused, and a Runner that creates one fails its Spec.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { canonical, resolverFiles, toolchainDirs, toolEnv, RUNNER_CONTEXT, type GateRequest, type Policy, type TurnHooks } from "./claude.ts";
import type { Measurement, UsageSource } from "./limits.ts";

export const HOOK_SCRIPT = new URL("./agy-hook.ts", import.meta.url).pathname;

/** The real agy binary: $GOVERNCODE_AGY_BIN, else `agy` on PATH. */
export function agyBinary(): string {
  if (process.env.GOVERNCODE_AGY_BIN) return process.env.GOVERNCODE_AGY_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, "agy");
    if (dir && existsSync(p)) return realpathSync(p);
  }
  throw new Error("agy not found (install the Antigravity CLI, or set GOVERNCODE_AGY_BIN)");
}

/** A tool's private home in GovernCode's state, where Connect signs it in. */
export function toolHome(stateDir: string, tool: string): string {
  return join(stateDir, "tools", tool, "home");
}

// Antigravity's customization roots; a project copy holding one is refused (see above).
const CUSTOM_ROOTS = [".agents", ".agent", "_agents", "_agent"];

/** Customization roots anywhere in a folder (not following links), relative to it. */
export function customizations(root: string, max = 20_000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (++seen > max) { found.push("(too many files to check)"); return; }
      const p = join(dir, name);
      if (CUSTOM_ROOTS.includes(name)) { found.push(relative(root, p)); continue; }
      if (name === ".git") continue;
      try { if (lstatSync(p).isDirectory()) walk(p); } catch { /* gone */ }
    }
  };
  walk(root);
  return found;
}

// Read-only tools Antigravity uses to look around; the sandbox bounds what they can read.
const QUIET = new Set(["view_file", "list_dir", "grep_search", "find_by_name", "command_status", "wait", "wait_5_seconds",
  "finish", "list_permissions"]);
const FILE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);

/** How one Antigravity tool call is judged: allowed without asking, or a Gate. Unknown and
 *  malformed calls always become Gates, never silent allows. */
export function agyGate(call: unknown, id: string): { quiet: true } | { req: GateRequest } {
  const c = (call ?? {}) as { name?: unknown; args?: unknown };
  const name = typeof c.name === "string" && /^[a-z][a-z0-9_]{0,60}$/.test(c.name) ? c.name : null;
  const args = c.args && typeof c.args === "object" && !Array.isArray(c.args) ? c.args as Record<string, unknown> : {};
  if (name && QUIET.has(name)) return { quiet: true };
  // The Gate shows exactly this: the tool and every argument it will run with.
  const gate = (tool: string, input: Record<string, unknown>) => ({ req: { id, tool, input, canonical: canonical({ tool, input }) } });
  if (name === "run_command") return gate("agy command", { command: args.CommandLine ?? null, cwd: args.Cwd ?? null });
  if (name && FILE_TOOLS.has(name)) return gate("agy fileChange", { tool: name, ...args });
  return gate(name ? `agy_${name}` : "agy unknown tool", name ? args : { call: c as Record<string, unknown> });
}

/** GovernCode's hooks file and nothing else in the home's config folder: other hooks, plugins,
 *  MCP servers and settings a previous run or anyone else left there are removed. */
export function writeAgyConfig(home: string, hook: { node: string; script: string; socket: string }): string {
  const cfg = join(home, ".gemini", "config");
  mkdirSync(cfg, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(cfg)) if (!["projects", ".migrated"].includes(name)) rmSync(join(cfg, name), { recursive: true, force: true });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const name = `governcode-${randomBytes(9).toString("hex")}`;   // unguessable: a project file cannot switch it off by name
  writeFileSync(join(cfg, "hooks.json"), JSON.stringify({ [name]: { PreToolUse: [{ matcher: "*",
    hooks: [{ type: "command", command: `${q(hook.node)} ${q(hook.script)} ${q(hook.socket)}`, timeout: 3600 }] }] } }), { mode: 0o600 });
  return name;
}

export function agyPolicy(o: { work: string; tmp: string; home: string; bin: string; writePaths: string[]; gitDir?: string;
                               node: string; socket: string }): Policy {
  const state = join(o.home, ".gemini", "antigravity-cli");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom", "/dev/random",
      o.bin, o.home, dirname(HOOK_SCRIPT), dirname(o.node), ...resolverFiles(), o.work, ...(o.gitDir ? [o.gitDir] : [])]
      .filter((p) => p === o.work || existsSync(p)),
    // The config folder that holds the hook is NOT here: only Antigravity's own state is writable.
    write: [...o.writePaths, o.tmp, state, "/dev/null"],
    exec: ["/usr/bin", "/bin", "/usr/lib", o.bin, dirname(o.node), ...toolchainDirs()],
    tcp_connect: [443],
    // No D-Bus: the desktop keyring stays out of reach, so the tool uses the login Connect made.
    unix_connect: [...["/run/systemd/resolve/io.systemd.Resolve"].filter(existsSync), o.socket],
    cwd: o.work,
  };
}

function agyEnv(tmp: string, home: string): Record<string, string> {
  // HOME is the private home; no DBUS address, so no keyring (the policy blocks the socket too).
  const env = toolEnv(tmp);
  delete env.DBUS_SESSION_BUS_ADDRESS;
  return { ...env, HOME: home };
}

/** Antigravity's usage for the model group GovernCode runs (Gemini unless a Claude or GPT
 *  model is named): weekly and 5-hour windows. Null when it cannot be read (= held). */
export function parseQuota(out: string, model = ""): Measurement | null {
  let d: any;
  try { d = JSON.parse(out); } catch { return null; }
  const groups: any[] = d?.command?.data?.groups ?? [];
  const third = /claude|gpt|opus|sonnet/i.test(model);
  const g = groups.find((x) => (third ? /claude|gpt/i : /gemini/i).test(String(x?.name ?? "")));
  const readings = (g?.buckets ?? []).filter((b: any) => typeof b?.remaining_fraction === "number" && Number.isFinite(b.remaining_fraction))
    .map((b: any) => ({ window: b.window === "5h" ? "5-hour" : String(b.window ?? b.id ?? "window"),
      usedPercent: Math.round(Math.min(100, Math.max(0, (1 - b.remaining_fraction) * 100)) * 10) / 10,
      resetsAt: typeof b.reset_time === "string" ? b.reset_time : null }));
  return readings.length ? { provider: "agy", measuredAt: Date.now(), readings } : null;
}

/** The usage source: `agy -p /quota` in the private home, sandboxed, no agent turn. */
export function agyUsage(o: { supervisor: string; policyDir: string; stateDir: string }): UsageSource & { why(): string | null } {
  let why: string | null = null;
  return {
    provider: "agy",
    why: () => why,
    async read() {
      let bin: string;
      try { bin = agyBinary(); } catch (e) { why = "Antigravity is not installed"; return null; }
      const home = toolHome(o.stateDir, "agy");
      if (!existsSync(join(home, ".gemini"))) { why = "Antigravity is not connected (gov connect agy)"; return null; }
      const tmp = mkdtempSync(join(tmpdir(), "governcode-agy-"));
      const scratch = join(tmp, "work");
      mkdirSync(scratch);
      const policyFile = join(o.policyDir, `agy-usage-${process.pid}-${Date.now()}.json`);
      try {
        mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
        const policy = agyPolicy({ work: scratch, tmp, home, bin, writePaths: [], node: process.execPath, socket: "/nonexistent" });
        writeFileSync(policyFile, JSON.stringify({ ...policy, unix_connect: policy.unix_connect.filter((s) => s !== "/nonexistent") }), { mode: 0o600 });
        const out = await run(o.supervisor, policyFile, bin, ["-p", "/quota", "--output-format", "json"], agyEnv(tmp, home), scratch, 40_000);
        const m = parseQuota(out.stdout);
        why = m ? null : /not logged in|Authentication required/i.test(out.stdout + out.stderr)
          ? "Antigravity needs signing in again (gov connect agy)" : "Antigravity did not report its quota";
        return m;
      } catch {
        why = "Antigravity did not report its quota";
        return null;
      } finally {
        rmSync(policyFile, { force: true });
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}

function run(supervisor: string, policyFile: string, bin: string, args: string[], env: Record<string, string>, cwd: string, ms: number) {
  return new Promise<{ stdout: string; stderr: string }>((ok) => {
    const child = spawn(supervisor, ["run", "--policy", policyFile, "--", bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout = (stdout + b).slice(-200_000)));
    child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-8000)));
    const t = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, ms);
    child.on("close", () => { clearTimeout(t); ok({ stdout, stderr }); });
    child.on("error", () => { clearTimeout(t); ok({ stdout, stderr }); });
  });
}

/** One Antigravity Runner turn. Tool calls reach `hooks.gate` through the hook; text and steps
 *  stream to `hooks.text` / `hooks.tool`; done reports the result and token usage. */
export async function runAgyTurn(o: { supervisor: string; policyDir: string; stateDir: string; runtimeDir: string; worktree: string;
  writePaths: string[]; gitDir?: string; model: string; effort: string | null; prompt: string; hooks: TurnHooks; signal?: AbortSignal;
  openSocket(handle: (method: string, params: unknown) => Promise<unknown>): { path: string; close(): void } }): Promise<void> {
  let finished = false;
  const cleanups: Array<() => void> = [];
  const finish = (r: { ok: boolean; summary: string; usage?: unknown }) => {
    if (finished) return; finished = true;
    for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
    o.hooks.done(r);
  };
  let bin: string;
  try { bin = agyBinary(); } catch (e) { return finish({ ok: false, summary: String(e instanceof Error ? e.message : e) }); }
  const home = toolHome(o.stateDir, "agy");
  if (!existsSync(join(home, ".gemini"))) return finish({ ok: false, summary: "Antigravity is not connected: run gov connect agy" });
  const found = customizations(o.worktree);
  if (found.length) {
    return finish({ ok: false, summary: `the project has Antigravity customizations (${found.slice(0, 3).join(", ")}); ` +
      "GovernCode does not run an Antigravity Runner with a project's own hooks, plugins or agents" });
  }

  // A cap on Gate requests per run, so a Runner cannot bury the user in them.
  let asked = 0;
  const sock = o.openSocket(async (method, params) => {
    if (method !== "agy.pretool") throw new Error(`not offered: ${method}`);
    const j = agyGate((params as any)?.toolCall, `agy-${Date.now()}-${asked}`);
    if ("quiet" in j) return { decision: "allow" };
    if (++asked > 200) return { decision: "deny", reason: "GovernCode: too many requests in one run" };
    const answer = await o.hooks.gate(j.req);
    return answer === "allow" ? { decision: "allow" } : { decision: "deny", reason: "The user declined this step in GovernCode." };
  });
  cleanups.push(() => sock.close());
  writeAgyConfig(home, { node: process.execPath, script: HOOK_SCRIPT, socket: sock.path });

  mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(tmpdir(), "governcode-agy-"));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const policyFile = join(o.policyDir, `agy-${process.pid}-${Date.now()}.json`);
  writeFileSync(policyFile, JSON.stringify(agyPolicy({ work: o.worktree, tmp, home, bin, writePaths: o.writePaths, gitDir: o.gitDir,
    node: process.execPath, socket: sock.path })), { mode: 0o600 });
  cleanups.push(() => rmSync(policyFile, { force: true }));

  const args = ["-p", `${RUNNER_CONTEXT}\n\n${o.prompt}`, "--output-format", "stream-json", "--disable-slash-commands",
    ...(o.model ? ["--model", o.model] : []), ...(o.effort ? ["--effort", o.effort] : [])];
  const child = spawn(o.supervisor, ["run", "--policy", policyFile, "--", bin, ...args],
    { cwd: o.worktree, env: agyEnv(tmp, home), stdio: ["ignore", "pipe", "pipe"], detached: true });
  cleanups.push(() => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
  let result: any = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    const s = m?.step_update;
    if (s?.step_type === "tool" && s.state === "ACTIVE" && typeof s.tool_name === "string") o.hooks.tool(`agy ${s.tool_name}`, {});
    if (s?.step_type === "agent_response" && s.state === "DONE" && typeof s.text_delta === "string") o.hooks.text(s.text_delta);
    if (m?.event === "result" && m.result) result = m.result;
  });
  o.signal?.addEventListener("abort", () => finish({ ok: false, summary: `stopped: ${String(o.signal?.reason ?? "aborted")}` }), { once: true });
  child.on("close", (code) => {
    // A Runner that created Antigravity customizations could switch the Gate off for later runs.
    const made = customizations(o.worktree);
    if (made.length) return finish({ ok: false, summary: `the Runner created Antigravity customizations (${made.slice(0, 3).join(", ")}); not offered` });
    if (result?.status === "SUCCESS") {
      const denied = Array.isArray(result.denied_actions) && result.denied_actions.length ? ` (declined: ${result.denied_actions.map((d: any) => d?.action).join(", ")})` : "";
      return finish({ ok: true, summary: `done${denied}`, usage: result.usage ?? null });
    }
    finish({ ok: false, summary: `agy ended (${code}): ${String(result?.response ?? stderr.trim().split("\n").slice(-2).join(" | ")).slice(0, 300)}` });
  });
}
