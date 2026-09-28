// Connect: every tool joins GovernCode the same way (Dave, 2026-09-28: "Same steps for all the
// stuff for the controllers and the runners"). GovernCode runs the tool's own documented sign-in
// inside the sandbox, in a private home that belongs to GovernCode, with no route to the desktop
// keyring, so the tool keeps its login in its own file store there and refreshes it itself.
// GovernCode never reads, copies or parses that login. Disconnect deletes the home.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyBinary, agyEnv, agyPolicy, hold, inUse, isConnected, quotaIn, safeWrite, toolHome, useKey, CONNECTED_MARK } from "./agy.ts";

export type Tool = "agy";
export const TOOLS: Record<Tool, { name: string; revoke: string }> = {
  agy: { name: "Antigravity", revoke: "https://myaccount.google.com/connections" },
};

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
      try { agyBinary(); } catch { installed = false; }
      return { tool, name: TOOLS[tool].name, installed, connected: installed && this.connected(tool) };
    });
  }

  /** Runs the sign-in; streams its output and link to `notify`; resolves when it ends. */
  start(tool: Tool, notify: (n: unknown) => void): Promise<{ id: string; connected: boolean; note: string }> {
    const id = `C-${this.next++}`;
    let bin: string;
    try { bin = agyBinary(); } catch { return Promise.resolve({ id, connected: false, note: `${TOOLS[tool].name} is not installed` }); }
    const home = toolHome(this.o.stateDir, tool);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(tmpdir(), "governcode-connect-"));
    const work = join(tmp, "work");
    mkdirSync(work);
    mkdirSync(this.o.policyDir, { recursive: true, mode: 0o700 });
    const policyFile = join(this.o.policyDir, `connect-${process.pid}-${Date.now()}.json`);
    // Signing in needs the tool's whole home writable (it creates its folders and login there);
    // no agent runs, only the tool's own no-cost usage command, which triggers its sign-in.
    const base = agyPolicy({ work, tmp, home, bin, writePaths: [join(home, ".gemini")], node: process.execPath, socket: "/nonexistent" });
    mkdirSync(join(home, ".gemini"), { recursive: true, mode: 0o700 });
    writeFileSync(policyFile, JSON.stringify({ ...base, unix_connect: base.unix_connect.filter((s) => s !== "/nonexistent") }), { mode: 0o600 });
    const env = agyEnv(tmp, home);
    const release = hold(this.o.stateDir, tool);
    const sent = new Set<string>();           // what the user pasted is echoed by the terminal: not shown back
    // The tool signs in only with a terminal ("no controlling terminal; cannot complete interactive
    // login"), so the sandboxed command runs under a pseudo-terminal from `script` (util-linux).
    const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
    const inner = [this.o.supervisor, "run", "--policy", policyFile, "--", bin, "-p", "/quota", "--output-format", "json"].map(q).join(" ");
    const child = spawn(process.env.GOVERNCODE_SCRIPT_BIN ?? "script", ["-qfec", inner, "/dev/null"],
      { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdin!.on("error", () => {});
    this.sessions.set(id, { tool, child, sent });
    let shownUrl = false;
    const clean = (x: string) => x.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
    const show = (chunk: string) => {
      for (const line of clean(chunk).split("\n")) {
        const t = line.trim();
        if (sent.has(t)) continue;
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
          connected = code === 0 && (await quotaIn(this.o, home)).m !== null;
          if (connected) safeWrite(join(home, CONNECTED_MARK), "Connected for GovernCode. GovernCode never reads the login the tool keeps here.\n");
          else rmSync(join(home, CONNECTED_MARK), { force: true });
        } catch { connected = false; }
        release();
        ok({ id, connected, note: connected ? `${TOOLS[tool].name} is connected for GovernCode` : `${TOOLS[tool].name} did not finish signing in` });
      });
      child.on("error", () => { clearTimeout(timer); this.sessions.delete(id); release(); ok({ id, connected: false, note: `${TOOLS[tool].name} did not start` }); });
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
    rmSync(home, { recursive: true, force: true });
    return { removed, revoke: TOOLS[tool].revoke };
  }
}
