// Connect: every tool joins GovernCode the same way (Dave, 2026-09-28: "Same steps for all the
// stuff for the controllers and the runners"). GovernCode runs the tool's own documented sign-in
// inside the sandbox, in a private home that belongs to GovernCode, with no route to the desktop
// keyring, so the tool keeps its login in its own file store there and refreshes it itself.
// GovernCode never reads, copies or parses that login. Disconnect deletes the home.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyBinary, agyPolicy, isConnected, parseQuota, toolHome, CONNECTED_MARK } from "./agy.ts";
import { toolEnv } from "./claude.ts";

export type Tool = "agy";
export const TOOLS: Record<Tool, { name: string; revoke: string }> = {
  agy: { name: "Antigravity", revoke: "https://myaccount.google.com/connections" },
};

type Session = { tool: Tool; child: ChildProcess };
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
    const env = { ...toolEnv(tmp), HOME: home };
    const child = spawn(this.o.supervisor, ["run", "--policy", policyFile, "--", bin, "-p", "/quota", "--output-format", "json"],
      { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    child.stdin!.on("error", () => {});
    this.sessions.set(id, { tool, child });
    let stdout = "";
    let shownUrl = false;
    const show = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("{")) continue;             // the final usage JSON is read, not shown
        const url = URL_RE.exec(t)?.[0];
        if (url && !shownUrl) { shownUrl = true; notify({ kind: "connect", id, url }); continue; }
        notify({ kind: "connect", id, text: t.slice(0, 500) });
      }
    };
    child.stdout!.on("data", (b) => { const s = String(b); stdout = (stdout + s).slice(-200_000); show(s); });
    child.stderr!.on("data", (b) => show(String(b)));
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } }, 10 * 60_000);
    return new Promise((ok) => {
      child.on("close", () => {
        clearTimeout(timer);
        this.sessions.delete(id);
        rmSync(policyFile, { force: true });
        rmSync(tmp, { recursive: true, force: true });
        const json = stdout.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "";
        const connected = parseQuota(json) !== null;
        if (connected) writeFileSync(join(home, CONNECTED_MARK), "Connected for GovernCode. GovernCode never reads the login the tool keeps here.\n", { mode: 0o600 });
        else rmSync(join(home, CONNECTED_MARK), { force: true });
        ok({ id, connected, note: connected ? `${TOOLS[tool].name} is connected for GovernCode` : `${TOOLS[tool].name} did not finish signing in` });
      });
      child.on("error", () => { clearTimeout(timer); this.sessions.delete(id); ok({ id, connected: false, note: `${TOOLS[tool].name} did not start` }); });
    });
  }

  /** What the user pasted (a sign-in code), passed to the tool as one line. */
  input(id: string, text: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no sign-in ${id} is running`);
    s.child.stdin!.write(text + "\n");
  }

  cancel(id: string): void {
    const s = this.sessions.get(id);
    if (s) { try { process.kill(-s.child.pid!, "SIGTERM"); } catch { /* gone */ } }
  }

  /** Forget the tool's login: its private home is deleted. The grant itself is revoked from the
   *  user's account page (returned, so the user can open it). */
  disconnect(tool: Tool): { removed: boolean; revoke: string } {
    const home = toolHome(this.o.stateDir, tool);
    const removed = existsSync(home);
    rmSync(home, { recursive: true, force: true });
    return { removed, revoke: TOOLS[tool].revoke };
  }
}
