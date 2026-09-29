// gov tunnel HOST: reach a govd on another machine. ssh forwards that govd's Unix socket to a
// socket in a private local folder, and `gov --host HOST ...` (or the Dashboard, pointed at that
// folder) talks to it as if it were local. The SSH user is the govd user there, so nothing new is
// trusted: whoever can ssh in could already run gov on that machine.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeSync } from "node:fs";

type Env = NodeJS.ProcessEnv;

/** Where govd keeps its state: the same resolution as packages/govd/src/paths.ts. */
export function stateDir(env: Env = process.env): string {
  return env.GOVERNCODE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "governcode");
}

/** The local govd's socket: the same resolution as packages/govd/src/paths.ts. */
export function localSocket(env: Env = process.env): string {
  return join(env.GOVERNCODE_RUNTIME_DIR ?? join(env.XDG_RUNTIME_DIR ?? stateDir(env), "governcode"), "govd.sock");
}

/** The user's runtime folder (the state folder where there is none), and the private folder
 *  under it that holds each host's forwarded socket. */
const tunnelRoot = (env: Env) => env.XDG_RUNTIME_DIR ?? stateDir(env);
export function tunnelBase(env: Env = process.env): string {
  return join(tunnelRoot(env), "governcode-tunnels");
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

const uid = () => process.getuid!();
const others = (mode: number) => (mode & 0o077) !== 0;

/** The runtime folder must be this user's and closed to everyone else (as XDG requires), and
 *  no folder above it may be writable by anyone but its owner (root or this user) unless it is
 *  root's sticky /tmp kind. Nothing is repaired: an unsafe folder is refused, not chmodded. */
function checkRoot(root: string, create: boolean): string {
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  let real: string;
  try { real = realpathSync(root); } catch { throw new Error(`refusing ${root}: it does not exist`); }
  const st = lstatSync(real);
  if (!st.isDirectory() || st.uid !== uid() || others(st.mode)) throw new Error(`refusing ${root}: it must be your own folder with mode 0700`);
  for (let d = dirname(real); ; d = dirname(d)) {
    const a = lstatSync(d);
    const sticky = (a.mode & 0o1000) !== 0 && a.uid === 0;
    if ((a.uid !== 0 && a.uid !== uid()) || ((a.mode & 0o022) && !sticky)) throw new Error(`refusing ${root}: ${d} above it can be changed by other users`);
    if (d === "/") break;
  }
  return real;
}

/** A folder under the checked root: made 0700 if missing (when creating); if it exists, it must
 *  already be a real directory of this user with mode 0700. */
function privateDir(dir: string, create: boolean): void {
  if (create) try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid() || (st.mode & 0o777) !== 0o700) throw new Error(`refusing ${dir}: it must be your own folder with mode 0700 (remove it if you do not know what it is)`);
}

/** The host's tunnel folder, checked, as a resolved path used for everything after: the root is
 *  resolved once and every folder below it is checked with lstat, so no symlink swapped in
 *  later can redirect a later step. Null when it does not exist and create is false. */
function hostDir(host: string, env: Env, create: boolean): string | null {
  const root = checkRoot(tunnelRoot(env), create && env.XDG_RUNTIME_DIR === undefined);
  const base = join(root, "governcode-tunnels"), dir = join(base, checkHost(host));
  if (!create && !existsSync(dir)) return null;
  privateDir(base, create);
  privateDir(dir, create);
  checkSocketPath(join(dir, "govd.sock"), "local socket");
  return dir;
}

/** A file's identity (device and inode, not following symlinks), to unlink it only if it is
 *  still the one that was read. */
function fileId(path: string): string | null {
  try { const st = lstatSync(path); return `${st.dev}:${st.ino}`; } catch { return null; }
}
function unlinkIf(path: string, id: string | null): boolean {
  if (id === null || fileId(path) !== id) return false;
  rmSync(path, { force: true });
  return true;
}

const lastLine = (s: string) => (s.trim().split("\n").filter(Boolean).at(-1) ?? "").replace(/\.$/, "");
const SSH_ONLY_KEYS = "gov tunnel uses key-based ssh only (BatchMode): check that `ssh -o BatchMode=yes HOST true` works";

// A process is named by its pid and its start time (field 22 of /proc/PID/stat), so a pid the
// system has since given to something else is never mistaken for it.
type Proc = { pid: number; start: string | null };
type Rec = { gov: Proc; ssh?: Proc };
export function startTime(pid: number): string | null {
  try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2).split(" ")[19] ?? null; } catch { return null; }
}
const canVerify = () => startTime(process.pid) !== null;
/** Verified to be the same process: needs /proc. */
const same = (p: Proc | undefined) => !!p && p.start !== null && startTime(p.pid) === p.start;
/** For refusing a second start: verified where /proc exists; elsewhere any live pid counts. */
function maybeRunning(p: Proc): boolean {
  if (canVerify()) return same(p);
  try { process.kill(p.pid, 0); return true; } catch { return false; }
}

function readRec(path: string): Rec | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const r = JSON.parse(readFileSync(fd, "utf8"));
    const ok = (p: any) => p && Number.isInteger(p.pid) && p.pid > 1 && (p.start === null || typeof p.start === "string");
    return ok(r.gov) && (r.ssh === undefined || ok(r.ssh)) ? r : null;
  } catch { return null; } finally { closeSync(fd); }
}

/** Rewrites the record in place. Records only grow (the ssh entry is added), so no reader ever
 *  sees an empty or half-old file. */
function writeRec(fd: number, rec: Rec): void {
  writeSync(fd, JSON.stringify(rec) + "\n", 0);
}

/** Takes the host's lock: tunnel.pid, created exclusively and never through a symlink. A lock
 *  left by a tunnel that is gone is set aside atomically (and its ssh stopped) before retrying. */
function lock(dir: string, host: string, me: Rec): number {
  const path = join(dir, "tunnel.pid");
  // The record is written in full to a new file first and then linked into place: link() is
  // atomic, never follows a symlink and fails if tunnel.pid exists, so it is the lock.
  const fresh = join(dir, `tunnel.pid.new-${process.pid}`);
  const fd = openSync(fresh, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeRec(fd, me);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { linkSync(fresh, path); return fd; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      setAside(dir, path, host);
    }
    throw new Error(`could not take the lock for ${host} in ${dir}`);
  } catch (e) { closeSync(fd); throw e; } finally { rmSync(fresh, { force: true }); }
}

/** A tunnel.pid whose tunnel is gone is moved aside atomically (and the ssh it left, if any,
 *  stopped); one that turns out to be live after all is put back. */
function setAside(dir: string, path: string, host: string): void {
  const held = () => new Error(`a tunnel to ${host} is already running; gov tunnel --stop ${host}`);
  const id = fileId(path);
  const rec = readRec(path);
  if (rec && maybeRunning(rec.gov)) throw held();
  const aside = join(dir, `tunnel.pid.old-${process.pid}`);
  try { renameSync(path, aside); } catch { return; }
  const taken = readRec(aside);
  if (fileId(aside) !== id || (taken && maybeRunning(taken.gov))) {   // not the stale one we read: put it back
    try { linkSync(aside, path); } catch { /* another start holds the lock now */ }
    rmSync(aside, { force: true });
    if (taken && maybeRunning(taken.gov)) throw held();
    return;
  }
  if (same(taken?.ssh)) process.kill(taken!.ssh!.pid, "SIGTERM");   // ssh left behind by a crashed tunnel
  rmSync(aside, { force: true });
  // The stale socket is left for the new owner, which removes it once it holds the lock.
}

// ponytail: the lock is a file, not a kernel-released lock. Several starts of the SAME host by
// the same user racing one stale lock can, at worst, lose a record (the put-back above fails),
// leaving a tunnel --stop cannot see. Ceiling: same-user only, and only after a crash. Upgrade
// trigger: a report of it happening; then take an flock through a small helper instead.

/** Removes what a tunnel left in its folder, but only while the lock is still the one read
 *  (lockId), then the folder if it is empty. */
function clean(dir: string, lockId: string | null): void {
  const lockPath = join(dir, "tunnel.pid");
  if (fileId(lockPath) !== lockId) return;
  rmSync(join(dir, "govd.sock"), { force: true });
  unlinkIf(lockPath, lockId);
  try { rmdirSync(dir); } catch { /* something else is in it: leave it */ }
}

/** ssh dies with gov where util-linux's setpriv can arrange it (Linux PR_SET_PDEATHSIG), so even a
 *  SIGKILLed gov leaves no forward behind. Elsewhere --stop, or the next start, stops it.
 *  ponytail: without setpriv (macOS), a gov killed between spawning ssh and recording its pid
 *  leaves an ssh nothing names; ceiling: that window is microseconds and needs a SIGKILL. Upgrade
 *  trigger: macOS support leaves preview; then run ssh from a helper that watches its parent.
 *  ponytail: setpriv and ssh come from PATH, the same trust gov already gives ssh itself (a
 *  hostile PATH could replace ssh too). Upgrade trigger: gov resolving ssh to a fixed path. */
function spawnSsh(args: string[]): ChildProcess {
  const pdeath = process.platform === "linux" && spawnSync("setpriv", ["--help"], { stdio: "ignore" }).status === 0;
  return spawn(pdeath ? "setpriv" : "ssh", pdeath ? ["--pdeathsig", "TERM", "--", "ssh", ...args] : args, { stdio: ["ignore", "ignore", "pipe"] });
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
  const dir = hostDir(host, env, true)!, local = join(dir, "govd.sock");
  const me: Rec = { gov: { pid: process.pid, start: startTime(process.pid) } };
  const fd = lock(dir, host, me);
  const lockId = fileId(join(dir, "tunnel.pid"));
  let ssh: ChildProcess | undefined;
  let exited = true;
  let exit: Promise<number | null> = Promise.resolve(null);
  const stop = async () => { if (ssh && !exited) ssh.kill("SIGTERM"); await exit; closeSync(fd); clean(dir, lockId); };
  try {
    let remote = remoteArg;
    if (remote === undefined) {
      const r = spawnSync("ssh", discoverArgs(host), { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
      if (r.error) throw new Error((r.error as NodeJS.ErrnoException).code === "ENOENT" ? "ssh is not installed" : `ssh failed: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`could not ask ${host} where govd listens (ssh exit ${r.status}): ${lastLine(r.stderr) || "no message"}. ${SSH_ONLY_KEYS.replace("HOST", host)}`);
      remote = r.stdout.replace(/\n$/, "");
    }
    checkSocketPath(remote, `the govd socket ${host} reported`);
    rmSync(local, { force: true });

    const child = ssh = spawnSsh(forwardArgs(host, local, remote));
    exited = false;
    if (child.pid) writeRec(fd, { ...me, ssh: { pid: child.pid, start: startTime(child.pid) } });
    let stderr = "";
    child.stderr!.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    exit = new Promise<number | null>((ok) => {
      child.on("exit", (code) => { exited = true; ok(code); });
      child.on("error", (e) => { exited = true; stderr += (e as NodeJS.ErrnoException).code === "ENOENT" ? "ssh is not installed" : e.message; ok(null); });
    });
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
      throw new Error(!exited ? `ssh to ${host} did not open the tunnel within 30 s` :
        `ssh to ${host} exited before the tunnel was up: ${lastLine(stderr) || "no message"}. ${SSH_ONLY_KEYS.replace("HOST", host)}`);
    }
    const version = await hello(local);
    if (!version) throw new Error(`the tunnel to ${host} opened, but no govd answered at ${remote} there${lastLine(stderr) ? ` (${lastLine(stderr)})` : ""}. Is govd running on ${host}?`);

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
  } catch (e) {
    await stop();
    throw e;
  }
}

/** gov tunnel --stop HOST: stops a running tunnel (it removes its own socket), or the ssh a
 *  crashed one left behind. Signals only processes it can verify by pid and start time. */
export function stopTunnel(hostArg: string | undefined, env: Env = process.env): string {
  const host = checkHost(hostArg);
  const dir = hostDir(host, env, false);
  if (!dir) return `no tunnel to ${host} is running`;
  const lockId = fileId(join(dir, "tunnel.pid"));
  const rec = readRec(join(dir, "tunnel.pid"));
  if (!rec) return `no tunnel to ${host} is running`;
  if (fileId(join(dir, "tunnel.pid")) !== lockId) throw new Error(`the tunnel to ${host} changed while it was being read; try again`);
  if (!canVerify()) throw new Error(`cannot verify which process holds the tunnel to ${host} on this system (no /proc), so nothing was signalled; stop it with Ctrl-C where it runs`);
  if (same(rec.gov)) { process.kill(rec.gov.pid, "SIGTERM"); return `stopping the tunnel to ${host} (pid ${rec.gov.pid})`; }
  const orphan = same(rec.ssh);
  if (orphan) process.kill(rec.ssh!.pid, "SIGTERM");
  clean(dir, lockId);
  return orphan ? `stopped the ssh a closed tunnel to ${host} left running (pid ${rec.ssh!.pid})` : `no tunnel to ${host} is running (tidied what was left)`;
}

/** gov tunnel: the tunnels this user has open. */
export function listTunnels(env: Env = process.env): string[] {
  let hosts: string[] = [];
  try { hosts = readdirSync(tunnelBase(env)); } catch { return []; }
  return hosts.sort().map((h) => {
    const rec = readRec(join(tunnelBase(env), h, "tunnel.pid"));
    return rec && maybeRunning(rec.gov) ? `${h.padEnd(24)} running (pid ${rec.gov.pid})  gov --host ${h} status`
      : `${h.padEnd(24)} not running (left over; gov tunnel --stop ${h} tidies it)`;
  });
}
