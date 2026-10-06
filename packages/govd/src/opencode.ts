// The OpenCode Runner (sst's `opencode`, 2.0). OpenCode 2.0 is a client and a server: its ACP front
// always starts a private HTTP server on a loopback port and drives it, and the shell commands the
// model runs are that server's children. Anything that can reach the port with its password can
// answer the server's own permission requests ("always" included), run shell commands and write
// files through its API, and a child can read the password from /proc. So GovernCode does not run
// `opencode acp`: govd starts `opencode serve` under govern-sup with a sandbox that lets it listen
// on its one port and never connect to it, and govd (outside the sandbox) is its only client. The
// kernel refuses a connection from the server, or from any command it runs, to that port
// (Landlock: bind and connect are separate rights), whatever they know.
//
// Every permission request is a Gate, answered "once" or "reject", never "always"; asking a
// subagent (task) is rejected without one. Each run gets a fresh home with a copy of the database
// Connect signed in (OpenCode 2.0 keeps logins, sessions and saved permissions in one SQLite file),
// so nothing a run saves reaches another run, and the copy is never written back. GovernCode's
// own config comes in the environment (every action asks, no subagents, no sharing, no updates);
// a project's own OpenCode config is off, and a project with instruction or settings files
// OpenCode would read is refused, as for Grok. Models: OpenCode Go (the subscription) and
// OpenCode's free models only (Dave, 2026-10-05): Connect stores the key for opencode-go alone,
// so a paid Zen model has no login either. Metered by a counted budget (OpenCode reports no
// subscription window GovernCode can read).
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agyEnv, customizations, hold } from "./agy.ts";
import { isConnected, removeTree, toolDir, toolHome } from "./homes.ts";
import { canonical, resolverFiles, toolchainDirs, RUNNER_CONTEXT, type GateRequest, type Policy, type TurnHooks } from "./claude.ts";
import { unsafeLinks } from "./grok.ts";

/** The real opencode binary: $GOVERNCODE_OPENCODE_BIN, else `opencode` on PATH followed to the
 *  program itself (npm installs a link to it; a wrapper script is looked through with mise). */
export function opencodeBinary(): string {
  if (process.env.GOVERNCODE_OPENCODE_BIN) return process.env.GOVERNCODE_OPENCODE_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, "opencode");
    if (!dir || !existsSync(p)) continue;
    const real = realpathSync(p);
    if (readFileSync(real).subarray(0, 4).toString("latin1") === "\x7fELF") return real;
    try { return realpathSync(execFileSync("mise", ["which", "opencode"], { encoding: "utf8" }).trim()); } catch { /* not mise */ }
  }
  throw new Error("opencode not found (install OpenCode, or set GOVERNCODE_OPENCODE_BIN)");
}

// OpenCode's own free models that do not end in -free (seen in 2.0.23's list).
const FREE_ZEN = new Set(["big-pickle"]);
/** A model a Runner may use, as OpenCode names it: `opencode-go/<id>` (the Go subscription) or one
 *  of OpenCode's free models (`opencode/<id>-free`, `opencode/big-pickle`). Anything else (a paid
 *  Zen model, another provider) is null: refused before anything starts. */
export function opencodeModel(model: string): { providerID: string; id: string } | null {
  const m = /^(opencode-go|opencode)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,99})$/.exec(model.trim());
  if (!m) return null;
  if (m[1] === "opencode" && !(m[2].endsWith("-free") || FREE_ZEN.has(m[2]))) return null;
  return { providerID: m[1], id: m[2] };
}
export const OPENCODE_DEFAULT_MODEL = "opencode/big-pickle";

/** GovernCode's config for a run, given in OPENCODE_CONFIG_CONTENT: every action asks, subagents
 *  are denied, only OpenCode's own providers, nothing shared, no updates, no MCP servers. */
export function opencodeConfig(): string {
  return JSON.stringify({
    permission: { "*": "ask", task: "deny" },
    enabled_providers: ["opencode", "opencode-go"],
    share: "disabled",
    autoupdate: false,
    mcp: {},
  });
}

// What OpenCode would read from a project: its own config and agents (.opencode/, opencode.json),
// instruction files from every folder up from where it works (AGENTS.md, CLAUDE.md, CONTEXT.md),
// and the skill folders it shares with other tools. A project with any of them is refused, and a
// Runner that creates one fails its Spec (as for Grok; the walk and the link check are Grok's).
export const OPENCODE_ROOTS = [".opencode", "opencode.json", "opencode.jsonc", "AGENTS.md", "Agents.md", "AGENT.md", "CLAUDE.md", "Claude.md",
  "CLAUDE.local.md", "CONTEXT.md", ".agents", ".claude"];
export function opencodeSettings(worktree: string): string[] {
  const found = customizations(worktree, 20_000, OPENCODE_ROOTS).map((h) => (h.startsWith("(") ? "too many files to check" : h));
  if (found.includes("too many files to check")) return found;
  return [...found, ...unsafeLinks(worktree)];
}

/** The folders of a home OpenCode writes: its data (the database), cache and state; not .config. */
export const HOME_WRITABLE = [join(".local", "share"), ".cache", join(".local", "state")];

/** The folders a home needs before OpenCode starts: it creates .config/opencode at startup, and
 *  may not inside a run (the sandbox keeps .config read-only), so it is made empty beforehand. */
const HOME_DIRS = [join(".config", "opencode"), ".cache", join(".local", "state"), join(".local", "share", "opencode")];

/** Where OpenCode keeps its database in a home: logins, sessions and saved permissions. */
export const OPENCODE_DB = join(".local", "share", "opencode", "opencode.db");

/** A fresh home for one run with a copy of Connect's database (the file and its write-ahead log,
 *  bytes only, never read); finish() deletes it, and nothing is copied back. */
export function opencodeRunHome(stateDir: string): { home: string; finish(): void } {
  const runs = join(toolDir(stateDir, "opencode"), "runs");
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(runs, "run-"));
  try {
    for (const d of HOME_DIRS) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
    for (const suffix of ["", "-wal"]) {
      const from = join(toolHome(stateDir, "opencode"), OPENCODE_DB + suffix);
      if (existsSync(from)) copyFileSync(from, join(home, OPENCODE_DB + suffix));
    }
  } catch (e) { removeTree(home); throw e; }
  return { home, finish: () => removeTree(home) };
}

/** OpenCode's environment for a home: XDG paths inside it, GovernCode's config, the server's
 *  password, and no updater, project config or other tools' settings. */
export function opencodeEnv(tmp: string, home: string, password: string): Record<string, string> {
  return agyEnv(tmp, home, {
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    // OPENCODE_PASSWORD, not OPENCODE_SERVER_PASSWORD: the server keeps the first out of its children's
    // environment (the second it passes on). Either way, they cannot connect to its port.
    OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: opencodeConfig(),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  });
}

/** The run's sandbox: listen on `port` and never connect to it (so neither the server nor any
 *  command it runs can reach its own API); reach the network on 443 only; write the Spec's scope,
 *  its temp folder, and the data, cache and state folders of its fresh home, never the home's
 *  config folder (OpenCode loads config, agents and plugins from it).
 *  ponytail: OpenCode keeps saved permissions in its database, which it must be able to write, so
 *  a command the user allowed could plant one for the rest of that run (as for Grok's sessions/).
 *  GovernCode never grants one ("always" is never chosen), the home is fresh and deleted after the
 *  run, and the sandbox bounds every step to the Spec's scope either way.
 *  ponytail: the server is the tool govern-sup runs, so a command that kills it ends the run (the
 *  supervisor then kills everything left); in the moments between, something that took its port
 *  could only tell govd untrue things (no Gate is skipped and no file is changed that way). */
export function opencodePolicy(o: { work: string; tmp: string; home: string; bin: string; port: number; writePaths?: string[]; readOnly?: boolean; gitDir?: string }): Policy {
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom", "/dev/random",
      dirname(o.bin), o.home, ...resolverFiles(), o.work, ...(o.gitDir ? [o.gitDir] : [])].filter((p) => p === o.work || existsSync(p)),
    write: [...(o.readOnly ? [] : o.writePaths ?? [o.work]), o.tmp, ...HOME_WRITABLE.map((d) => join(o.home, d)), "/dev/null"],
    exec: ["/usr/bin", "/bin", "/usr/lib", dirname(o.bin), ...toolchainDirs()],
    tcp_connect: [443],
    tcp_bind: [o.port],
    unix_connect: ["/run/systemd/resolve/io.systemd.Resolve"].filter(existsSync),
    cwd: o.work,
  };
}

/** A free loopback port, found by binding and releasing one (if another program takes it first,
 *  the server cannot start and the run fails; it never listens elsewhere). */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); const p = typeof a === "object" && a ? a.port : 0; s.close(() => ok(p)); });
  });
}

export type OpencodeEvent = { type: string; data: Record<string, unknown> };
export type OpencodeServer = {
  url: string;
  api(method: string, path: string, body?: unknown, ms?: number): Promise<{ status: number; body: any }>;
  /** Every event the server sends from now on, until close; settles once the stream is open (or
   *  could not be opened). `lost` is told why the stream ended, if it ends before close. */
  events(on: (e: OpencodeEvent) => void, lost?: (why: string) => void): Promise<void>;
  close(): void;
  /** Settles once govern-sup (and so the server and everything it ran) has exited. */
  closed: Promise<void>;
};

const MAX_EVENT = 1_000_000;   // one event's bytes; a larger one ends the stream (it is not OpenCode's)

/** Starts `opencode serve` under govern-sup and waits for its address (its first stdout line). */
export async function startOpencodeServer(o: { supervisor: string; policyFile: string; bin: string; port: number; env: Record<string, string>; cwd: string; password: string; startMs?: number }): Promise<OpencodeServer> {
  const child = spawn(o.supervisor, ["run", "--policy", o.policyFile, "--", o.bin, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", String(o.port)],
    // stdin stays open for the server's whole life: with --stdio, OpenCode stops when it closes.
    { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  child.stdin!.on("error", () => {});
  const closed = new Promise<void>((ok) => { child.on("close", () => ok()); child.on("error", () => ok()); });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-4000)));
  const stop = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch { /* gone */ } };
  let line = "";
  const url = await new Promise<string>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`OpenCode did not start in time${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`)), o.startMs ?? 20_000);
    child.stdout.on("data", (b) => {
      line = (line + b).slice(0, 4000);
      // Its address line, among whatever else it prints first; only the address it was told to
      // listen on: another is not the server GovernCode started.
      const m = /\{"url":"(http:\/\/[^"]+)"\}/.exec(line);
      if (!m) return;
      clearTimeout(t);
      if (m[1] === `http://127.0.0.1:${o.port}`) ok(m[1]);
      else fail(new Error(`OpenCode started somewhere else: ${m[1].slice(0, 100)}`));
    });
    void closed.then(() => { clearTimeout(t); fail(new Error(`OpenCode exited before it started${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`)); });
  }).catch(async (e) => { stop("SIGKILL"); await closed; throw e; });
  const auth = "Basic " + Buffer.from(`opencode:${o.password}`).toString("base64");
  // OpenCode prints its address before it accepts connections (seen with 2.0.23): wait until it answers.
  for (const until = Date.now() + (o.startMs ?? 20_000); ;) {
    try {
      const r = await fetch(url + "/api/info", { headers: { authorization: auth }, signal: AbortSignal.timeout(2000) });
      await r.body?.cancel();
      if (r.status === 200) break;
      throw new Error(`OpenCode answered ${r.status}`);
    } catch (e) {
      if (Date.now() > until) { stop("SIGKILL"); await closed; throw new Error(`OpenCode did not answer in time: ${e instanceof Error ? e.message : e}`); }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const aborter = new AbortController();
  let gone = false;
  const close = () => {
    if (gone) return; gone = true;
    aborter.abort();
    child.stdin!.end();
    stop("SIGTERM");
    setTimeout(() => stop("SIGKILL"), 5000).unref();
  };
  return {
    url, closed, close,
    async api(method, path, body, ms = 30_000) {
      const r = await fetch(url + path, { method, headers: { authorization: auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(ms)]) });
      const text = await r.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: r.status, body: parsed };
    },
    events(on, lost) {
      let opened: () => void = () => {};
      const open = new Promise<void>((ok) => { opened = ok; });
      // A stream that is lost cannot be followed, so the run ends, saying why.
      const gone = (why: string) => { if (!aborter.signal.aborted) { lost?.(why); close(); } };
      void (async () => {
        const late = new AbortController();
        const timer = setTimeout(() => late.abort(), 15_000);   // no answer at all: not waited for forever
        try {
          const r = await fetch(url + "/api/event", { headers: { authorization: auth, accept: "text/event-stream" }, signal: AbortSignal.any([aborter.signal, late.signal]) });
          clearTimeout(timer);
          if (r.status !== 200 || !r.body) throw new Error(`status ${r.status}`);
          opened();   // (OpenCode's first event, server.connected, comes next)
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return gone("OpenCode's event stream ended");
            buf += dec.decode(value, { stream: true });
            if (buf.length > MAX_EVENT) return gone("an event from OpenCode was too large to follow");
            let k;
            while ((k = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, k); buf = buf.slice(k + 2);
              const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
              let e: any;
              try { e = JSON.parse(data); } catch { continue; }
              if (!(e && typeof e.type === "string" && e.data && typeof e.data === "object")) continue;
              try { on({ type: e.type, data: e.data }); }
              catch (err) { return gone(`GovernCode could not follow OpenCode's events: ${err instanceof Error ? err.message : err}`); }
            }
          }
        } catch (err) {
          gone(`no event stream from OpenCode (${err instanceof Error ? err.message : err})`);
        } finally { clearTimeout(timer); opened(); }
      })();
      return open;
    },
  };
}

/** A permission request as a Gate, or "reject" for one GovernCode never grants (a subagent). The
 *  shell's command is judged like every Runner's command; an edit shows its files and patch; a
 *  read is a quiet read (the sandbox bounds what can be read); anything else is a step named
 *  after its action. */
export function opencodeGate(data: Record<string, unknown>): GateRequest | "reject" {
  const action = typeof data.action === "string" && /^[a-z_]{1,30}$/.test(data.action) ? data.action : null;
  const resources = Array.isArray(data.resources) ? data.resources.filter((r): r is string => typeof r === "string").map((r) => r.slice(0, 4000)).slice(0, 50) : [];
  const id = String(data.id ?? "");
  if (!action || action === "task" || action === "subagent") return "reject";
  let tool: string, input: Record<string, unknown>;
  if (action === "shell" || action === "bash") {
    tool = "opencode command";
    input = { command: resources.length === 1 ? resources[0] : null, ...(resources.length > 1 ? { resources } : {}) };
  } else if (action === "edit" || action === "write" || action === "patch") {
    tool = "opencode fileChange";
    const files = Array.isArray((data.metadata as any)?.files) ? ((data.metadata as any).files as any[]).slice(0, 50).map((f) => ({
      file: String(f?.file ?? "").slice(0, 4000), status: String(f?.status ?? "").slice(0, 40), patch: String(f?.patch ?? "").slice(0, 20_000) })) : [];
    input = { kind: action, locations: resources, ...(files.length ? { files } : {}) };
  } else if (action === "read" && resources.length) {
    tool = "opencode_read";
    input = { kind: "read", locations: resources, input: { path: resources[0] } };
  } else {
    tool = `opencode_${action}`;
    input = { kind: action, locations: resources };
  }
  return { id, tool, input, canonical: canonical({ tool, input }) };
}

/** A run's token use from OpenCode's cumulative session.usage.updated figures. */
function usageOf(t: { input: number; output: number; reasoning: number } | null, complete: boolean) {
  if (!t) return complete ? null : { complete: false };
  return { inputTokens: t.input, outputTokens: t.output + t.reasoning, totalTokens: t.input + t.output + t.reasoning, ...(complete ? {} : { complete: false }) };
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

const policyName = (kind: string) => `opencode-${kind}-${process.pid}-${randomBytes(6).toString("hex")}.json`;
type Opts = { supervisor: string; policyDir: string; stateDir: string };

/** One OpenCode Runner turn. Permission requests reach `hooks.gate`; words and steps stream to
 *  `hooks.text` / `hooks.tool`; done reports the result and token use. */
export async function runOpencodeTurn(o: Opts & { worktree: string; writePaths: string[]; gitDir?: string; model: string; effort: string | null;
  prompt: string; hooks: TurnHooks; signal?: AbortSignal; turnMs?: number }): Promise<void> {
  let finished = false;
  const cleanups: Array<() => void> = [];
  const finish = (r: { ok: boolean; summary: string; usage?: unknown; started?: false; limit?: { resetsAt: string | null } }) => {
    if (finished) return; finished = true;
    for (const c of cleanups.reverse()) { try { c(); } catch { /* best effort */ } }
    o.hooks.done(r);
  };
  // Refused before anything starts: nothing used (started false).
  let bin: string;
  try { bin = opencodeBinary(); } catch (e) { return finish({ ok: false, summary: String(e instanceof Error ? e.message : e), started: false }); }
  if (!isConnected(o.stateDir, "opencode")) return finish({ ok: false, summary: "OpenCode is not connected: run gov connect opencode", started: false });
  const model = opencodeModel(o.model || OPENCODE_DEFAULT_MODEL);
  if (!model) return finish({ ok: false, started: false, summary: `${o.model} is not an OpenCode Go or free model; GovernCode runs OpenCode Runners only on those (never a paid Zen model)` });
  const found = opencodeSettings(o.worktree);
  if (found.length) return finish({ ok: false, started: false, summary: `the project has settings or instructions OpenCode would read (${found.slice(0, 3).join(", ")}); GovernCode does not run an OpenCode Runner with a project's own config, agents or instructions` });
  let server: OpencodeServer | null = null;
  try {
    cleanups.push(hold(o.stateDir, "opencode"));
    mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(tmpdir(), "governcode-opencode-"));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const rh = opencodeRunHome(o.stateDir);
    // Until the server is running, the home (with its copy of the login) goes with any failure.
    try {
      const port = await freePort();
      const password = randomBytes(32).toString("base64url");
      const policyFile = join(o.policyDir, policyName("run"));
      cleanups.push(() => rmSync(policyFile, { force: true }));
      writeFileSync(policyFile, JSON.stringify(opencodePolicy({ work: o.worktree, tmp, home: rh.home, bin, port, writePaths: o.writePaths, gitDir: o.gitDir })), { mode: 0o600 });
      server = await startOpencodeServer({ supervisor: o.supervisor, policyFile, bin, port, env: opencodeEnv(tmp, rh.home, password), cwd: o.worktree, password });
    } catch (e) { rh.finish(); throw e; }
    const srv = server;
    // The run's home goes once govern-sup (and everything it ran) has exited.
    void srv.closed.then(() => rh.finish());
    cleanups.push(() => srv.close());
    const result = await turn(srv, o, model);
    srv.close();
    await srv.closed;
    // A Runner that created OpenCode settings or instructions could steer later runs.
    const made = opencodeSettings(o.worktree);
    if (made.length) return finish({ ok: false, summary: `the Runner created OpenCode settings or instructions (${made.slice(0, 3).join(", ")}); not offered`, usage: result.usage });
    finish(result);
  } catch (e) {
    if (server) { server.close(); await server.closed; }
    if (e instanceof Refused) return finish({ ok: false, summary: e.message, started: false });
    finish({ ok: false, summary: `the OpenCode Runner could not start: ${e instanceof Error ? e.message : e}` });
  }
}

/** The actions proved to ask before the prompt: changing files, running commands, reaching outside
 *  the project, and the network. (Every action asks under GovernCode's config; these matter most.) */
const PROBED = ["edit", "shell", "external_directory", "webfetch"];

/** A run GovernCode refused before the model was asked anything: nothing was used. */
class Refused extends Error {}

/** The model as OpenCode itself lists it, which must agree: an OpenCode Go model, or a free one
 *  (OpenCode serves those with its public key). The effort is passed only where the model offers it. */
export function checkModel(list: unknown, model: { providerID: string; id: string }, effort: string | null): { variant?: string } {
  const entry = Array.isArray(list) ? (list as any[]).find((m) => m?.providerID === model.providerID && m?.id === model.id) : undefined;
  if (!entry) throw new Refused(`OpenCode does not offer ${model.providerID}/${model.id} here`);
  const free = model.providerID === "opencode" && entry.settings?.apiKey === "public";
  if (model.providerID !== "opencode-go" && !free) throw new Refused(`${model.providerID}/${model.id} is not an OpenCode Go or free model; not run`);
  const variants = Array.isArray(entry.variants) ? entry.variants.map((v: any) => v?.id).filter((v: unknown) => typeof v === "string") : [];
  return effort && variants.includes(effort) ? { variant: effort } : {};
}

/** The session itself: create it, prove every action asks, prompt, follow its events to the end. */
async function turn(srv: OpencodeServer, o: { worktree: string; prompt: string; hooks: TurnHooks; signal?: AbortSignal; effort: string | null; turnMs?: number },
  model: { providerID: string; id: string }): Promise<{ ok: boolean; summary: string; usage?: unknown; limit?: { resetsAt: string | null } }> {
  // OpenCode fills its model list a moment after it starts (it fetches its catalog): wait for it,
  // then the model must be in it.
  let list: unknown = null;
  for (const until = Date.now() + 15_000; ;) {
    list = (await srv.api("GET", "/api/model")).body?.data;
    const loaded = Array.isArray(list) && list.length > 0;
    if ((loaded && (list as any[]).some((m) => m?.providerID === model.providerID && m?.id === model.id)) || (loaded && Date.now() > until - 13_000) || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const { variant } = checkModel(list, model, o.effort);
  const created = await srv.api("POST", "/api/session", {
    model: { ...model, ...(variant ? { variant } : {}) }, location: { directory: o.worktree },
    // OpenCode 2.0 calls a subagent "subagent" (its config's "task" maps to it); both are denied.
    permissions: [{ action: "*", resource: "*", effect: "ask" }, { action: "task", resource: "*", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }],
  });
  const sid = created.body?.data?.id;
  if (created.status !== 200 || typeof sid !== "string") throw new Error(`no session (${created.status})`);
  // Proof that GovernCode's rules are in force before the model is asked anything: an edit and a
  // command must each ask (OpenCode was once seen to start a session before its config loaded).
  for (let tries = 0; ; tries++) {
    const effects: string[] = [];
    for (const action of PROBED) {
      const r = await srv.api("POST", `/api/session/${sid}/permission`, { action, resources: ["governcode-readiness-check"] });
      const effect = r.body?.data?.effect;
      effects.push(String(effect));
      if (effect === "ask" && typeof r.body.data.id === "string") await srv.api("POST", `/api/session/${sid}/permission/${r.body.data.id}/reply`, { decision: "reject" });
    }
    if (effects.every((e) => e === "ask")) break;
    if (tries >= 20) throw new Refused(`OpenCode does not ask before every step (${effects.join(", ")}); not run`);
    await new Promise((r) => setTimeout(r, 250));
  }

  let tokens: { input: number; output: number; reasoning: number } | null = null;
  const texts: string[] = [];
  const names = new Map<string, string>();
  let settle: (r: { ok: boolean; summary: string; usage?: unknown; limit?: { resetsAt: string | null } }) => void = () => {};
  const ended = new Promise<{ ok: boolean; summary: string; usage?: unknown; limit?: { resetsAt: string | null } }>((ok) => { settle = ok; });
  let finished = false, prompted = false;
  // complete: the use reported is all of it (OpenCode itself ended the turn, after its last usage
  // figures); otherwise it is a floor. Before the prompt, nothing was used.
  const end = (ok: boolean, why: string, o2: { limit?: { resetsAt: string | null }; complete?: boolean; error?: boolean } = {}) => {
    if (finished) return;
    finished = true;
    const said = texts.join("").trim().slice(-4000);
    settle({ ok, summary: o2.error || !said ? (said ? `${why}\n\n${said}`.slice(0, 4000) : why) : said,
      usage: prompted ? usageOf(tokens, o2.complete ?? ok) : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ...(o2.limit ? { limit: o2.limit } : {}) });
  };
  // A stop: the session is interrupted (if it was asked anything) and the turn ends, by OpenCode's
  // own report or 5 s later; before the prompt, at once and nothing is sent.
  const stop = () => {
    if (!prompted) return end(false, "stopped before it began");
    void srv.api("POST", `/api/session/${sid}/interrupt`).catch(() => null);
    setTimeout(() => end(false, "stopped"), 5000).unref();
  };
  if (o.signal?.aborted) stop(); else o.signal?.addEventListener("abort", stop, { once: true });
  const deadline = setTimeout(() => { end(false, "the turn took too long", { error: true }); stop(); }, o.turnMs ?? 60 * 60_000);
  void srv.closed.then(() => end(false, "OpenCode exited", { error: true }));
  /** A Gate's answer to OpenCode, tried twice; one that cannot be delivered ends the turn. */
  const reply = async (id: string, decision: "once" | "reject", message?: string) => {
    for (let tries = 0; tries < 2; tries++) {
      const r = await srv.api("POST", `/api/session/${sid}/permission/${encodeURIComponent(id)}/reply`, { decision, ...(message ? { message } : {}) }).catch(() => null);
      if (r && r.status >= 200 && r.status < 300) return;
      if (finished) return;   // (after the end, OpenCode no longer waits for it)
    }
    end(false, "GovernCode could not give OpenCode a Gate's answer", { error: true });
    stop();
  };
  await srv.events((e) => {
    const d = e.data;
    if (d.sessionID !== sid) return;   // only this run's session (it has no other)
    switch (e.type) {
      case "session.text.delta": if (typeof d.delta === "string") { texts.push(d.delta); o.hooks.text(d.delta); } break;
      // Each step's words start on a paragraph of their own.
      case "session.step.started": if (texts.length && !texts.at(-1)!.endsWith("\n")) { texts.push("\n\n"); o.hooks.text("\n\n"); } break;
      case "session.tool.input.started": if (typeof d.id === "string" && typeof d.name === "string") names.set(d.id, d.name.slice(0, 60)); break;
      case "session.tool.called": {
        const name = names.get(String(d.id)) ?? "tool";
        const input = d.input && typeof d.input === "object" ? d.input as Record<string, unknown> : {};
        o.hooks.tool(`${name}${typeof input.command === "string" ? ` ${input.command}` : typeof input.path === "string" ? ` ${input.path}` : ""}`.slice(0, 80), input);
        break;
      }
      case "session.usage.updated": {
        const t = d.tokens as any;
        if (t && typeof t === "object") tokens = { input: num(t.input), output: num(t.output), reasoning: num(t.reasoning) };
        break;
      }
      case "permission.asked": {
        const req = opencodeGate(d);
        const id = String(d.id);
        // A rejection with a message tells the model and lets it go on (without one, OpenCode ends the turn).
        if (req === "reject") { void reply(id, "reject", "GovernCode Runners do not start subagents; do the work yourself."); break; }
        // Never "always": a saved permission would let later steps in this run skip their Gate.
        const declined = "The user declined this step at GovernCode's Gate. Do not try it another way; go on without it or explain what you need.";
        void o.hooks.gate(req).then((a) => (a === "allow" ? reply(id, "once") : reply(id, "reject", declined)), () => reply(id, "reject", declined));
        break;
      }
      case "session.execution.succeeded": end(true, "done"); break;
      case "session.execution.interrupted": end(false, `stopped (${String(d.reason ?? "interrupted").slice(0, 60)})`, { complete: true }); break;
      case "session.execution.failed": {
        const msg = String((d.error as any)?.message ?? "OpenCode failed").slice(0, 500);
        // OpenCode Go's own words when its usage window is spent ("Go usage limit exceeded"); no reset time is given.
        end(false, msg, { complete: true, error: true, ...(/usage limit|rate limit|quota/i.test(msg) ? { limit: { resetsAt: null } } : {}) });
        break;
      }
    }
  }, (why) => end(false, why, { error: true }));
  // Stopped, out of time or gone while the stream opened: the prompt is never sent.
  if (!finished) {
    prompted = true;
    const sent = await srv.api("POST", `/api/session/${sid}/prompt`, { text: `${RUNNER_CONTEXT}\n\n${o.prompt}` }).catch(() => null);
    if (sent?.status !== 200) end(false, `OpenCode did not take the prompt (${sent?.status ?? "no answer"})`, { error: true });
  }
  try { return await ended; } finally { clearTimeout(deadline); o.signal?.removeEventListener("abort", stop); }
}

/** A sandboxed server in Connect's own home (GovernCode's, never the user's ~/.local/share/opencode),
 *  for Connect and its check: no project, no prompt, nothing but OpenCode's credential store. */
async function connectServer(o: Opts, home: string): Promise<{ srv: OpencodeServer; done(): Promise<void> }> {
  const bin = opencodeBinary();
  const tmp = mkdtempSync(join(tmpdir(), "governcode-opencode-connect-"));
  const work = join(tmp, "work");
  mkdirSync(work);
  for (const d of HOME_DIRS) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
  mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const password = randomBytes(32).toString("base64url");
  const policyFile = join(o.policyDir, policyName("connect"));
  writeFileSync(policyFile, JSON.stringify(opencodePolicy({ work, tmp, home, bin, port, readOnly: true })), { mode: 0o600 });
  const cleanup = () => { rmSync(policyFile, { force: true }); rmSync(tmp, { recursive: true, force: true }); };
  let srv: OpencodeServer;
  try { srv = await startOpencodeServer({ supervisor: o.supervisor, policyFile, bin, port, env: opencodeEnv(tmp, home, password), cwd: work, password }); }
  catch (e) { cleanup(); throw e; }
  return { srv, done: async () => { srv.close(); await srv.closed; cleanup(); } };
}

/** Is an OpenCode Go key stored in this home? Only the entries' integration and state are looked
 *  at, never their values. (Whether opencode.ai still accepts the key shows on the first run.) */
export async function opencodeSignedIn(o: Opts, home: string): Promise<boolean> {
  if (!existsSync(join(home, OPENCODE_DB))) return false;
  const c = await connectServer(o, home);
  try {
    const r = await c.srv.api("GET", "/api/credential");
    return r.status === 200 && Array.isArray(r.body?.data) && r.body.data.some((x: any) => x?.integrationID === "opencode-go" && x?.active === true);
  } catch { return false; } finally { await c.done(); }
}

/** Connect: the key the user pasted goes to OpenCode's own store in GovernCode's home, for OpenCode
 *  Go only (never "opencode", OpenCode's paid Zen models). govd holds it only for this call. */
export async function opencodeSignIn(o: Opts, home: string, key: string): Promise<boolean> {
  const k = key.trim();
  if (!/^[\x21-\x7e]{8,512}$/.test(k)) return false;   // one printable word: anything else is not a key
  const c = await connectServer(o, home);
  try {
    const r = await c.srv.api("POST", "/api/credential", { integrationID: "opencode-go", value: { type: "key", key: k }, activate: true });
    const id = r.body?.data?.id;
    if (r.status !== 200 || r.body?.data?.integrationID !== "opencode-go" || typeof id !== "string") return false;
    // Then the old key goes (a re-Connect replaces it; one that fails keeps it), and anything else stored.
    const all = await c.srv.api("GET", "/api/credential");
    for (const x of Array.isArray(all.body?.data) ? all.body.data : []) {
      if (typeof x?.id === "string" && x.id !== id) await c.srv.api("DELETE", `/api/credential/${encodeURIComponent(x.id)}`);
    }
    return true;
  } catch { return false; } finally { await c.done(); }
}
