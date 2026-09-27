// `gov daemon ...`: run govd as a user service (systemd --user on Linux; launchd arrives with
// the macOS port), or start it once in the background.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const govdEntry = join(repo, "packages/govd/src/main.ts");

export function unitFile(node: string, entry: string): string {
  return `[Unit]
Description=GovernCode daemon (govd)
Documentation=https://github.com/onelegdave/governcode

[Service]
ExecStart=${node} ${entry}
Restart=on-failure
RestartSec=5
# govd holds no secrets and needs none of these.
NoNewPrivileges=yes
PrivateTmp=no

[Install]
WantedBy=default.target
`;
}

export function unitPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "systemd/user/governcode.service");
}

export function install(): string {
  if (process.platform !== "linux") throw new Error("gov daemon install supports Linux (systemd --user) for now");
  const path = unitPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unitFile(process.execPath, govdEntry));
  execFileSync("systemctl", ["--user", "daemon-reload"]);
  execFileSync("systemctl", ["--user", "enable", "--now", "governcode.service"]);
  return path;
}

export function uninstall(): void {
  execFileSync("systemctl", ["--user", "disable", "--now", "governcode.service"]);
}

/** Start govd once, detached, logging to the state dir. */
export function startOnce(logDir: string): number {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(logDir, "govd.log"), "a");
  const child = spawn(process.execPath, [govdEntry], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  return child.pid ?? -1;
}

export const serviceInstalled = () => existsSync(unitPath());
