// gov tunnel HOST: reach a govd on another machine. ssh forwards that govd's Unix socket to a
// socket in a private local folder, and `gov --host HOST ...` (or the Dashboard, pointed at that
// folder) talks to it as if it were local. The SSH user is the govd user there, so nothing new is
// trusted: whoever can ssh in could already run gov on that machine.
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";

type Env = NodeJS.ProcessEnv;

/** Where govd keeps its state: the same resolution as packages/govd/src/paths.ts. */
export function stateDir(env: Env = process.env): string {
  return env.GOVERNCODE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "governcode");
}

/** The local govd's socket: the same resolution as packages/govd/src/paths.ts. */
export function localSocket(env: Env = process.env): string {
  return join(env.GOVERNCODE_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? stateDir(env), "governcode"), "govd.sock");
}

/** The private folder that holds each host's forwarded socket. */
export function tunnelBase(env: Env = process.env): string {
  return join(env.XDG_RUNTIME_DIR ?? stateDir(env), "governcode-tunnels");
}
export const tunnelDir = (host: string, env: Env = process.env) => join(tunnelBase(env), checkHost(host));
export const tunnelSocket = (host: string, env: Env = process.env) => join(tunnelDir(host, env), "govd.sock");

/** An ssh host name or alias, optionally user@: never anything ssh could read as an option. */
export function checkHost(host: string | undefined): string {
  if (!host || host.length > 64 || !/^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    throw new Error(`refusing host ${JSON.stringify(host ?? "")}: give an ssh host name or alias (letters, digits, '.', '-', optionally user@)`);
  }
  return host;
}

/** A govd socket path either end of the tunnel may use: absolute, plain characters (no ':',
 *  which would split ssh's -L argument, no spaces or newlines), no '.' or '..' parts, named
 *  govd.sock, and short enough for a Unix socket on Linux and macOS. */
export function checkSocketPath(path: string, what = "socket path"): string {
  const parts = path.split("/").slice(1);
  if (!/^\/[A-Za-z0-9._@+\/-]+$/.test(path) || parts.some((p) => p === "" || p === "." || p === "..")
      || parts.at(-1) !== "govd.sock" || Buffer.byteLength(path) > 100) {
    throw new Error(`refusing ${what} ${JSON.stringify(path)}: it must be an absolute path to govd.sock, plain characters only, at most 100 bytes`);
  }
  return path;
}

// Every ssh here: key-based login only (BatchMode never prompts for a password or a host key),
// its own connection (a shared ControlMaster would keep the forward after we exit), and `--`
// before the host.
const COMMON = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", "ControlPath=none"];

/** Asks the remote where its govd listens: `gov socket-path` if gov is on its PATH, else the
 *  documented default. Run through sh so the user's login shell does not matter. */
export const DISCOVER = `sh -c 'command -v gov >/dev/null 2>&1 && gov socket-path 2>/dev/null || { s="\${GOVERNCODE_STATE_DIR:-\${XDG_STATE_HOME:-$HOME/.local/state}/governcode}"; echo "\${GOVERNCODE_RUNTIME_DIR:-\${XDG_RUNTIME_DIR:-$s}/governcode}/govd.sock"; }'`;

export const discoverArgs = (host: string) => [...COMMON, "--", checkHost(host), DISCOVER];

export function forwardArgs(host: string, local: string, remote: string): string[] {
  return ["-N", ...COMMON, "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes", "-o", "StreamLocalBindMask=0177",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-L", `${checkSocketPath(local, "local socket")}:${checkSocketPath(remote, "remote govd socket")}`, "--", checkHost(host)];
}

/** Creates (or checks) a folder only this user can enter: a real directory, ours, mode 0700. */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`refusing ${dir}: not a directory of this user`);
  chmodSync(dir, 0o700);
}

const lastLine = (s: string) => (s.trim().split("\n").filter(Boolean).at(-1) ?? "").replace(/\.$/, "");
const SSH_ONLY_KEYS = "gov tunnel uses key-based ssh only (BatchMode): check that `ssh -o BatchMode=yes HOST true` works";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  // Where /proc exists, make sure the pid is still a gov tunnel and not a reused number.
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("tunnel"); } catch { return true; }
}

function readPid(dir: string): number | null {
  try { const n = Number(readFileSync(join(dir, "tunnel.pid"), "utf8").trim()); return Number.isInteger(n) && n > 1 ? n : null; }
  catch { return null; }
}

/** Removes what a tunnel left in its folder, then the folder if it is empty. */
function clean(dir: string): void {
  for (const f of ["govd.sock", "tunnel.pid"]) rmSync(join(dir, f), { force: true });
  try { rmdirSync(dir); } catch { /* something else is in it: leave it */ }
}

/** Sends govd's hello over the forwarded socket; the version it reports, or null. */
function hello(path: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((done) => {
    const sock = connect(path);
    const finish = (v: string | null) => { clearTimeout(timer); sock.destroy(); done(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
    sock.on("connect", () => sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { client: "gov", protocol: 1 } }) + "\n"));
    const lines = createInterface({ input: sock });
    lines.on("error", () => {});
    lines.on("line", (l) => {
      try { const m = JSON.parse(l); if (m.id === 1) finish(m.result ? String(m.result.version ?? "?") : null); } catch { finish(null); }
    });
  });
}

/** gov tunnel HOST [--remote-socket PATH]: runs until Ctrl-C, SIGTERM or `gov tunnel --stop HOST`. */
export async function runTunnel(hostArg: string | undefined, remoteArg: string | undefined, env: Env = process.env): Promise<number> {
  const host = checkHost(hostArg);
  const dir = tunnelDir(host, env), local = tunnelSocket(host, env);
  checkSocketPath(local, "local socket");
  const running = readPid(dir);
  if (running && alive(running)) throw new Error(`a tunnel to ${host} is already running (pid ${running}); gov tunnel --stop ${host}`);

  let remote = remoteArg;
  if (remote === undefined) {
    const r = spawnSync("ssh", discoverArgs(host), { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) throw new Error((r.error as NodeJS.ErrnoException).code === "ENOENT" ? "ssh is not installed" : `ssh failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`could not ask ${host} where govd listens (ssh exit ${r.status}): ${lastLine(r.stderr) || "no message"}. ${SSH_ONLY_KEYS.replace("HOST", host)}`);
    remote = r.stdout.replace(/\n$/, "");
  }
  checkSocketPath(remote, `the govd socket ${host} reported`);

  privateDir(tunnelBase(env));
  privateDir(dir);
  rmSync(local, { force: true });
  writeFileSync(join(dir, "tunnel.pid"), `${process.pid}\n`, { mode: 0o600 });

  const ssh = spawn("ssh", forwardArgs(host, local, remote), { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  ssh.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  let exited = false;
  const exit = new Promise<number | null>((ok) => {
    ssh.on("exit", (code) => { exited = true; ok(code); });
    ssh.on("error", (e) => { exited = true; stderr += (e as NodeJS.ErrnoException).code === "ENOENT" ? "ssh is not installed" : e.message; ok(null); });
  });
  const stop = async () => { if (!exited) ssh.kill("SIGTERM"); await exit; clean(dir); };
  let stopping = false;
  const signalled = new Promise<void>((ok) => {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => { stopping = true; ok(); });
  });

  // Up means: ssh bound the local socket, and govd answered hello through it.
  const up = await (async () => {
    for (let i = 0; i < 300 && !exited && !stopping; i++) {
      if (existsSync(local)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })();
  if (stopping) { await stop(); return 0; }
  if (!up) {
    const timedOut = !exited;
    await stop();
    throw new Error(timedOut ? `ssh to ${host} did not open the tunnel within 30 s` :
      `ssh to ${host} exited before the tunnel was up: ${lastLine(stderr) || "no message"}. ${SSH_ONLY_KEYS.replace("HOST", host)}`);
  }
  const version = await hello(local);
  if (!version) {
    await stop();
    throw new Error(`the tunnel to ${host} opened, but no govd answered at ${remote} there${lastLine(stderr) ? ` (${lastLine(stderr)})` : ""}. Is govd running on ${host}?`);
  }

  console.log(`tunnel to ${host}: govd ${version} at ${remote} there, reachable here at ${local}`);
  console.log(`  gov --host ${host} status        # any gov command, run against ${host}`);
  console.log(`  GOVERNCODE_RUNTIME_DIR=${dir}    # set for the Dashboard to use it`);
  console.log(`Ctrl-C (or gov tunnel --stop ${host}) closes it.`);

  await Promise.race([exit, signalled]);
  const lost = !stopping;
  await stop();
  if (lost) { console.error(`gov: the tunnel to ${host} closed: ${lastLine(stderr) || "ssh exited"}`); return 1; }
  console.log(`tunnel to ${host} closed`);
  return 0;
}

/** gov tunnel --stop HOST: stops a running tunnel (the tunnel removes its own socket). */
export function stopTunnel(hostArg: string | undefined, env: Env = process.env): string {
  const host = checkHost(hostArg);
  const dir = tunnelDir(host, env);
  const pid = readPid(dir);
  if (!pid || !alive(pid)) { if (existsSync(dir)) clean(dir); return `no tunnel to ${host} is running`; }
  process.kill(pid, "SIGTERM");
  return `stopping the tunnel to ${host} (pid ${pid})`;
}

/** gov tunnel: the tunnels this user has open. */
export function listTunnels(env: Env = process.env): string[] {
  let hosts: string[] = [];
  try { hosts = readdirSync(tunnelBase(env)); } catch { return []; }
  return hosts.sort().map((h) => {
    const pid = readPid(join(tunnelBase(env), h));
    return pid && alive(pid) ? `${h.padEnd(24)} running (pid ${pid})  gov --host ${h} status` : `${h.padEnd(24)} not running (left over; gov tunnel --stop ${h} tidies it)`;
  });
}
