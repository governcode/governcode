import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHost, checkSocketPath, discoverArgs, forwardArgs, tunnelSocket } from "../src/tunnel.ts";

const gov = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("hosts that ssh could read as an option, or that are not a plain name, are refused", () => {
  for (const ok of ["build-box", "build-box.example.org", "me@build-box", "192.0.2.7", "ci_user@host-1"]) assert.equal(checkHost(ok), ok);
  for (const bad of [undefined, "", "-oProxyCommand=touch x", "-p", "--", "a b", "host;id", "a/b", "../x", "@host", "h:22", "host\nx", "x".repeat(65)]) {
    assert.throws(() => checkHost(bad), /refusing host/);
  }
});

test("socket paths must be absolute, plain, named govd.sock and short", () => {
  assert.equal(checkSocketPath("/run/user/1000/governcode/govd.sock"), "/run/user/1000/governcode/govd.sock");
  for (const bad of ["governcode/govd.sock", "/run/x:y/govd.sock", "/run/../etc/govd.sock", "/run/./govd.sock", "/run//govd.sock",
    "/run/a b/govd.sock", "/run/x\n/govd.sock", "/run/other.sock", "/run/govd.sock/", `/${"d".repeat(100)}/govd.sock`, "-L/govd.sock"]) {
    assert.throws(() => checkSocketPath(bad), /refusing/);
  }
});

test("the ssh command lines: batch mode, its own connection, a socket forward, and -- before the host", () => {
  const f = forwardArgs("build-box", "/run/user/1/governcode-tunnels/build-box/govd.sock", "/run/user/2/governcode/govd.sock");
  assert.deepEqual(f, ["-N", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=no", "-o", "ControlPath=none",
    "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes", "-o", "StreamLocalBindMask=0177",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-L", "/run/user/1/governcode-tunnels/build-box/govd.sock:/run/user/2/governcode/govd.sock", "--", "build-box"]);
  const d = discoverArgs("build-box");
  assert.deepEqual(d.slice(-3, -1), ["--", "build-box"]);
  assert.ok(d.includes("BatchMode=yes"));
  assert.throws(() => forwardArgs("-oProxyCommand=x", "/a/govd.sock", "/b/govd.sock"), /refusing host/);
});

test("the discovery command gives the documented default when the remote has no gov", () => {
  const home = mkdtempSync(join(tmpdir(), "gc-disc-"));
  const run = (env: Record<string, string>) => spawnSync("sh", ["-c", discoverArgs("h").at(-1)!], { env: { PATH: "/usr/bin:/bin", HOME: home, ...env }, encoding: "utf8" }).stdout.trim();
  assert.equal(run({ XDG_RUNTIME_DIR: "/run/user/7" }), "/run/user/7/governcode/govd.sock");
  assert.equal(run({}), `${home}/.local/state/governcode/governcode/govd.sock`);
  assert.equal(run({ GOVERNCODE_RUNTIME_DIR: "/srv/gc" }), "/srv/gc/govd.sock");
  rmSync(home, { recursive: true, force: true });
});

// A fake ssh on PATH. It records its arguments; asked a command it answers like the remote
// shell would; with -N it plays the forward, serving a scripted govd on the local socket.
const FAKE_SSH = `#!/usr/bin/env node
const fs = require("node:fs"), net = require("node:net");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\\n");
if (!args.includes("-N")) {
  process.stdout.write(process.env.FAKE_DISCOVER ?? "");
  if (process.env.FAKE_DISCOVER_ERR) process.stderr.write(process.env.FAKE_DISCOVER_ERR + "\\n");
  process.exit(Number(process.env.FAKE_DISCOVER_EXIT ?? 0));
}
if (process.env.FAKE_FORWARD === "fail") { process.stderr.write("unix_listener: cannot bind to path: Address already in use\\n"); process.exit(255); }
const local = args[args.indexOf("-L") + 1].split(":")[0];
fs.writeFileSync(process.env.FAKE_SSH_LOG + ".pid", String(process.pid));
const server = net.createServer((s) => {
  if (process.env.FAKE_FORWARD === "mute") return s.end();
  let buf = "";
  s.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const result = m.method === "hello" ? { version: "9.9-fake", protocol: 1, sandbox: { ok: true } } : m.method === "project.list" ? { projects: [] } : {};
      s.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
    }
  });
});
server.listen(local);
process.on("SIGTERM", () => { fs.writeFileSync(process.env.FAKE_SSH_LOG + ".stopped", "yes"); process.exit(0); });
`;

function setup(extra: Record<string, string> = {}) {
  const t = mkdtempSync(join(tmpdir(), "gc-tunnel-"));
  const bin = join(t, "bin"), run = join(t, "run");
  mkdirSync(bin); mkdirSync(run, { mode: 0o700 });
  writeFileSync(join(bin, "ssh"), FAKE_SSH); chmodSync(join(bin, "ssh"), 0o755);
  const log = join(t, "ssh.log");
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, XDG_RUNTIME_DIR: run,
    FAKE_SSH_LOG: log, FAKE_DISCOVER: "/run/user/2/governcode/govd.sock\n", ...extra };
  delete (env as any).GOVERNCODE_RUNTIME_DIR;
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
  const gov1 = (...a: string[]) => spawnSync(process.execPath, [gov, ...a], { env, encoding: "utf8" });
  return { t, run, env, log, calls, gov: gov1, done: () => rmSync(t, { recursive: true, force: true }) };
}

function start(s: ReturnType<typeof setup>, ...a: string[]): { p: ChildProcess; out: () => string; exit: Promise<number | null> } {
  const p = spawn(process.execPath, [gov, "tunnel", ...a], { env: s.env });
  let out = "";
  p.stdout!.on("data", (d) => (out += d)); p.stderr!.on("data", (d) => (out += d));
  return { p, out: () => out, exit: new Promise((ok) => p.on("exit", ok)) };
}
async function until(f: () => boolean, ms = 15000) {
  for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(f(), "timed out");
}

test("gov tunnel HOST: discovers the socket, forwards it into a private folder, gov --host uses it, SIGTERM cleans up", async () => {
  const s = setup();
  try {
    const tun = start(s, "build-box");
    await until(() => /tunnel to build-box: govd 9\.9-fake/.test(tun.out()));
    const local = tunnelSocket("build-box", s.env);
    assert.equal(local, join(s.run, "governcode-tunnels/build-box/govd.sock"));
    assert.equal(statSync(join(s.run, "governcode-tunnels")).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(local)).mode & 0o777, 0o700);

    const [disc, fwd] = s.calls();
    assert.deepEqual(disc.slice(-3, -1), ["--", "build-box"]);
    assert.deepEqual(fwd.slice(-4), ["-L", `${local}:/run/user/2/governcode/govd.sock`, "--", "build-box"]);
    for (const o of ["BatchMode=yes", "ExitOnForwardFailure=yes", "StreamLocalBindUnlink=yes", "ServerAliveInterval=15"]) assert.ok(fwd.includes(o), o);
    assert.equal(fwd[0], "-N");

    const status = s.gov("--host", "build-box", "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /govd 9\.9-fake · protocol 1/);
    assert.match(s.gov("tunnel").stdout, /build-box\s+running \(pid \d+\)/);
    assert.match(s.gov("tunnel", "build-box").stderr, /already running/);

    tun.p.kill("SIGTERM");
    assert.equal(await tun.exit, 0);
    assert.ok(existsSync(s.log + ".stopped"), "ssh was stopped");
    assert.ok(!existsSync(dirname(local)), "the tunnel folder is gone");
    assert.match(s.gov("--host", "build-box", "status").stderr, /no tunnel to build-box .*gov tunnel build-box/);
  } finally { s.done(); }
});

test("gov tunnel --stop HOST stops a running tunnel; --remote-socket skips discovery", async () => {
  const s = setup();
  try {
    const tun = start(s, "build-box", "--remote-socket", "/srv/gc/govd.sock");
    await until(() => /tunnel to build-box/.test(tun.out()));
    assert.equal(s.calls().length, 1, "no discovery call");
    assert.ok(s.calls()[0].includes(`${tunnelSocket("build-box", s.env)}:/srv/gc/govd.sock`));
    assert.match(s.gov("tunnel", "--stop", "build-box").stdout, /stopping the tunnel to build-box/);
    assert.equal(await tun.exit, 0);
    assert.ok(!existsSync(join(s.run, "governcode-tunnels/build-box")));
    assert.match(s.gov("tunnel", "--stop", "build-box").stdout, /no tunnel to build-box is running/);
  } finally { s.done(); }
});

test("option injection and unsafe remote paths are refused before any forward starts", () => {
  const s = setup({ FAKE_DISCOVER: "/tmp/x:/etc/govd.sock\n" });
  try {
    for (const bad of ["-oProxyCommand=touch pwned", "-L", "a;b"]) {
      const r = s.gov("tunnel", bad);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /refusing host/);
    }
    assert.match(s.gov("--host", "-oX", "status").stderr, /refusing host/);
    assert.equal(s.calls().length, 0, "ssh never ran");

    const r = s.gov("tunnel", "build-box");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing the govd socket build-box reported/);
    assert.equal(s.calls().length, 1, "only the discovery call");
    assert.match(s.gov("tunnel", "build-box", "--remote-socket", "relative/govd.sock").stderr, /refusing/);
    assert.equal(s.calls().length, 1);
  } finally { s.done(); }
});

test("failures say what went wrong and leave nothing behind", async () => {
  const s = setup({ FAKE_DISCOVER: "", FAKE_DISCOVER_EXIT: "255", FAKE_DISCOVER_ERR: "me@build-box: Permission denied (publickey)." });
  try {
    const r = s.gov("tunnel", "build-box");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not ask build-box where govd listens \(ssh exit 255\): me@build-box: Permission denied \(publickey\)\. .*BatchMode/);
  } finally { s.done(); }

  const f = setup({ FAKE_FORWARD: "fail" });
  try {
    const r = f.gov("tunnel", "build-box");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ssh to build-box exited before the tunnel was up: unix_listener: cannot bind/);
    assert.ok(!existsSync(join(f.run, "governcode-tunnels/build-box")));
  } finally { f.done(); }

  const m = setup({ FAKE_FORWARD: "mute" });
  try {
    const r = m.gov("tunnel", "build-box");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /the tunnel to build-box opened, but no govd answered at \/run\/user\/2\/governcode\/govd\.sock there/);
    assert.ok(existsSync(m.log + ".stopped"), "ssh was stopped");
    assert.ok(!existsSync(join(m.run, "governcode-tunnels/build-box")));
  } finally { m.done(); }
});
