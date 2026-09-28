// Connect: every tool joins GovernCode the same way (Dave, 2026-09-28: "Same steps for all the
// stuff for the controllers and the runners"). GovernCode runs the tool's own documented sign-in
// inside the sandbox, in a private home that belongs to GovernCode, with no route to the desktop
// keyring, so the tool keeps its login in its own file store there and refreshes it itself.
// GovernCode never reads, copies or parses that login. Disconnect deletes the home.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agyBinary, agyEnv, hold, inUse, isConnected, quotaIn, run, toolHome, useKey } from "./agy.ts";
import { setConnected } from "./homes.ts";
import { resolverFiles, toolchainDirs, which, type Policy } from "./claude.ts";
import { codexBinary } from "./codex.ts";

export type Tool = "agy" | "claude" | "codex";
type Opts = { supervisor: string; policyDir: string; stateDir: string };

/** How each tool signs in, in its GovernCode home. flow: "paste" = the user pastes a code back;
 *  "browser" = the browser hands the login back to the tool on this machine, nothing to paste.
 *  bind: the local ports its sign-in listens on for that (0: one the kernel picks). */
type Spec = { name: string; revoke: string; flow: "paste" | "browser"; binary(): string; signIn: string[];
  env(tmp: string, home: string): Record<string, string>; bind?: number[]; writable(home: string): string[];
  check(o: Opts, home: string): Promise<boolean> };

/** The tool's own status command, sandboxed in its home: signed in or not. */
async function status(o: Opts, t: Tool, home: string, args: string[], ok: (out: { stdout: string; stderr: string; code: number | null }) => boolean): Promise<boolean> {
  const spec = TOOLS[t];
  let bin: string;
  try { bin = spec.binary(); } catch { return false; }
  const tmp = mkdtempSync(join(tmpdir(), "governcode-status-"));
  const work = join(tmp, "work");
  mkdirSync(work);
  mkdirSync(o.policyDir, { recursive: true, mode: 0o700 });
  const pf = join(o.policyDir, `status-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(pf, JSON.stringify(signInPolicy({ work, tmp, home, bin, writable: spec.writable(home), bind: [] })), { mode: 0o600 });
    return ok(await run(o.supervisor, pf, bin, args, spec.env(tmp, home), work, 30_000));
  } catch { return false; } finally { rmSync(pf, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
}

export const TOOLS: Record<Tool, Spec> = {
  agy: { name: "Antigravity", revoke: "https://myaccount.google.com/connections", flow: "paste", binary: agyBinary,
    signIn: ["-p", "/quota", "--output-format", "json"], env: (tmp, home) => agyEnv(tmp, home), writable: (home) => [join(home, ".gemini")],
    check: async (o, home) => (await quotaIn(o, home)).m !== null },
  claude: { name: "Claude Code", revoke: "https://claude.ai/settings", flow: "paste", binary: () => realpathSync(which("claude")),
    signIn: ["auth", "login", "--claudeai"], bind: [0],   // its sign-in also listens on localhost for the browser's callback
    env: (tmp, home) => agyEnv(tmp, home, { CLAUDE_CONFIG_DIR: home }), writable: (home) => [home],
    check: (o, home) => status(o, "claude", home, ["auth", "status", "--json"], (r) => {
      // A subscription sign-in only: never an API key (paid API use) from anywhere.
      try { const j = JSON.parse(r.stdout); return r.code === 0 && j.loggedIn === true && j.authMethod === "claude.ai"; } catch { return false; } }) },
  // The browser sign-in (its callback on localhost:1455), not --device-auth: device-code sign-in
  // is off by default in ChatGPT's security settings (found in the first real Connect).
  codex: { name: "Codex", revoke: "https://chatgpt.com/#settings/Security", flow: "browser", binary: codexBinary,
    signIn: ["login"], bind: [1455], env: (tmp, home) => agyEnv(tmp, home, { CODEX_HOME: home }), writable: (home) => [home],
    // Codex prints its status on stderr ("Logged in using ChatGPT"), found in the first real Connect.
    // A ChatGPT sign-in only, never an API key.
    check: (o, home) => status(o, "codex", home, ["login", "status"], (r) => r.code === 0 && /logged in using chatgpt/i.test(r.stdout + r.stderr)) },
};

/** What a sign-in (or its status check) may touch: its own home, the network on 443, no keyring,
 *  and a listening port only for a sign-in whose browser calls back to localhost. */
export function signInPolicy(o: { work: string; tmp: string; home: string; bin: string; writable: string[]; bind: number[] }): Policy {
  return {
    version: 1,
    read: ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/proc", "/sys", "/dev/zero", "/dev/urandom", "/dev/random",
      dirname(o.bin), o.home, ...resolverFiles(), o.work].filter((p) => p === o.work || existsSync(p)),
    write: [...o.writable, o.tmp, "/dev/null"],
    exec: ["/usr/bin", "/bin", "/usr/lib", dirname(o.bin), ...toolchainDirs()],
    tcp_connect: [443],
    ...(o.bind.length ? { tcp_bind: o.bind } : {}),
    unix_connect: ["/run/systemd/resolve/io.systemd.Resolve"].filter(existsSync),
    cwd: o.work,
  };
}

type Session = { tool: Tool; child: ChildProcess; sent: Set<string> };
const URL_RE = /https:\/\/[^\s"'<>]+/;

export class Connector {
  private sessions = new Map<string, Session>();
  private next = 1;
  private o: { supervisor: string; policyDir: string; stateDir: string };
  constructor(o: { supervisor: string; policyDir: string; stateDir: string }) { this.o = o; }

  connected(tool: Tool): boolean {
    return isConnected(this.o.stateDir, tool);
  }

  list() {
    return (Object.keys(TOOLS) as Tool[]).map((tool) => {
      let installed = true;
      try { TOOLS[tool].binary(); } catch { installed = false; }
      return { tool, name: TOOLS[tool].name, flow: TOOLS[tool].flow, installed, connected: installed && this.connected(tool) };
    });
  }

  /** Is the tool's login still good? Its own status command, run now. */
  check(tool: Tool): Promise<boolean> {
    return this.connected(tool) ? TOOLS[tool].check(this.o, toolHome(this.o.stateDir, tool)) : Promise.resolve(false);
  }

  /** Runs the sign-in; streams its output and link to `notify`; resolves when it ends. */
  start(tool: Tool, notify: (n: unknown) => void): Promise<{ id: string; connected: boolean; note: string }> {
    const id = `C-${this.next++}`;
    const spec = TOOLS[tool];
    let bin: string;
    try { bin = spec.binary(); } catch { return Promise.resolve({ id, connected: false, note: `${spec.name} is not installed` }); }
    const home = toolHome(this.o.stateDir, tool);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return this.alreadySignedIn(tool, home).then((yes) => yes
      ? { id, connected: true, note: `${spec.name} is connected for GovernCode (it was already signed in here)` }
      : this.signIn(id, tool, bin, home, notify));
  }

  /** Signed in already (a sign-in that finished but was not recorded, or a re-Connect)? The tool's
   *  own status command decides; then no new sign-in is needed. */
  private async alreadySignedIn(tool: Tool, home: string): Promise<boolean> {
    if (!existsSync(home) || !(await TOOLS[tool].check(this.o, home).catch(() => false))) return false;
    setConnected(this.o.stateDir, tool, true);
    return true;
  }

  private signIn(id: string, tool: Tool, bin: string, home: string, notify: (n: unknown) => void): Promise<{ id: string; connected: boolean; note: string }> {
    const spec = TOOLS[tool];
    const tmp = mkdtempSync(join(tmpdir(), "governcode-connect-"));
    const work = join(tmp, "work");
    mkdirSync(work);
    mkdirSync(this.o.policyDir, { recursive: true, mode: 0o700 });
    const policyFile = join(this.o.policyDir, `connect-${process.pid}-${Date.now()}.json`);
    // Signing in needs the tool's home writable (it creates its folders and login there); no agent
    // runs, only the tool's own sign-in command.
    for (const w of spec.writable(home)) mkdirSync(w, { recursive: true, mode: 0o700 });
    writeFileSync(policyFile, JSON.stringify(signInPolicy({ work, tmp, home, bin, writable: spec.writable(home), bind: spec.bind ?? [] })), { mode: 0o600 });
    const env = spec.env(tmp, home);
    const release = hold(this.o.stateDir, tool);
    const sent = new Set<string>();           // what the user pasted is echoed by the terminal: not shown back
    // The tool signs in only with a terminal ("no controlling terminal; cannot complete interactive
    // login"), so the sandboxed command runs under a pseudo-terminal from `script` (util-linux).
    const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    // Echo off first, so the code the user pastes is not printed back.
    const inner = "stty -echo 2>/dev/null; exec " + [this.o.supervisor, "run", "--policy", policyFile, "--", bin, ...spec.signIn].map(q).join(" ");
    const child = spawn(process.env.GOVERNCODE_SCRIPT_BIN ?? "script", ["-qfec", inner, "/dev/null"],
      { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdin!.on("error", () => {});
    this.sessions.set(id, { tool, child, sent });
    let shownUrl = false;
    // Terminal codes out: colours, and hyperlinks (OSC 8), whose link is also printed as text.
    const clean = (x: string) => x.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
    // Output is shown line by line (a chunk can end mid-line), with anything the user pasted cut out.
    let partial = "";
    const show = (chunk: string) => {
      const parts = (partial + clean(chunk)).split("\n");
      partial = parts.pop() ?? "";
      if (partial.length > 8192) { parts.push(partial); partial = ""; }
      for (const line of parts) {
        let t = line.trim();
        for (const code of sent) if (code) t = t.split(code).join("[code]");
        if (!t || t === "[code]") continue;
        if (!t || t.startsWith("{")) continue;             // the final usage JSON is read, not shown
        const url = URL_RE.exec(t)?.[0];
        if (url && !shownUrl) { shownUrl = true; notify({ kind: "connect", id, url }); continue; }
        notify({ kind: "connect", id, text: t.slice(0, 500) });
      }
    };
    child.stdout!.on("data", (b) => show(String(b)));
    child.stderr!.on("data", (b) => show(String(b)));
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } }, 10 * 60_000);
    return new Promise((ok) => {
      child.on("close", async (code) => {
        clearTimeout(timer);
        this.sessions.delete(id);
        rmSync(policyFile, { force: true });
        rmSync(tmp, { recursive: true, force: true });
        // Connected only when the sign-in exited cleanly AND a separate, ordinary usage check in
        // that home then works (a terminal may drop the tool's last line, so its output is not
        // trusted for this).
        let connected = false;
        try {
          connected = code === 0 && await spec.check(this.o, home);
          setConnected(this.o.stateDir, tool, connected);
        } catch { connected = false; }
        release();
        ok({ id, connected, note: connected ? `${spec.name} is connected for GovernCode` : `${spec.name} did not finish signing in` });
      });
      child.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); this.sessions.delete(id); release();
        ok({ id, connected: false, note: e.code === "ENOENT" ? "the sign-in needs the script command (util-linux), which was not found" : `${TOOLS[tool].name} did not start` }); });
    });
  }

  /** What the user pasted (a sign-in code), passed to the tool as one line. */
  input(id: string, text: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no sign-in ${id} is running`);
    s.sent.add(text.trim());
    s.child.stdin!.write(text + "\r");      // Enter, on a terminal
  }

  cancel(id: string): void {
    const s = this.sessions.get(id);
    if (s) { try { process.kill(-s.child.pid!, "SIGTERM"); } catch { /* gone */ } }
  }

  /** Forget the tool's login: its private home is deleted. The grant itself is revoked from the
   *  user's account page (returned, so the user can open it). */
  disconnect(tool: Tool): { removed: boolean; revoke: string } {
    // Not while a sign-in or a Runner is using the login: stop or finish those first.
    if (inUse.get(useKey(this.o.stateDir, tool))) throw new Error(`${TOOLS[tool].name} is in use (a sign-in or a Runner); try again when it has finished`);
    const home = toolHome(this.o.stateDir, tool);
    const removed = existsSync(home);
    setConnected(this.o.stateDir, tool, false);
    rmSync(home, { recursive: true, force: true });
    return { removed, revoke: TOOLS[tool].revoke };
  }
}
