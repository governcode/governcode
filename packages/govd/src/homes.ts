// Tool homes (Codex's review of step 4, 2026-09-28). Each tool has one GovernCode home where
// Connect signed it in; only its login file is shared between runs. Every run gets a fresh, empty
// home of its own with that login file linked in, and the run's home is deleted afterwards, so
// nothing a run writes (memory, caches, settings, rules, skills, instructions) reaches another
// run, in this project or any other, even when runs overlap. If the tool replaced its login file
// (a token refresh written by rename), govd copies the new file back byte for byte, never parsing it.
// Whether a tool is connected is recorded outside every home a tool can write.
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const toolDir = (stateDir: string, tool: string) => join(stateDir, "tools", tool);
/** The GovernCode home Connect signs the tool into. */
export const toolHome = (stateDir: string, tool: string) => join(toolDir(stateDir, tool), "home");
const mark = (stateDir: string, tool: string) => join(toolDir(stateDir, tool), "connected");

export function isConnected(stateDir: string, tool: string): boolean {
  return existsSync(mark(stateDir, tool));
}
/** The current connection's generation: a new Connect (or a Disconnect) changes it, so a run
 *  started under an older one never writes its login back over the new one. */
function generation(stateDir: string, tool: string): string | null {
  try { return readFileSync(mark(stateDir, tool), "utf8").split("\n").find((l) => l.startsWith("generation "))?.slice(11) ?? null; } catch { return null; }
}
export function setConnected(stateDir: string, tool: string, yes: boolean): void {
  if (!yes) { rmSync(mark(stateDir, tool), { force: true }); return; }
  mkdirSync(toolDir(stateDir, tool), { recursive: true, mode: 0o700 });
  writeFileSync(mark(stateDir, tool), `Connected for GovernCode. GovernCode never parses the login the tool keeps in home/.\ngeneration ${randomBytes(9).toString("hex")}\n`, { mode: 0o600 });
}

/** A fresh home for one run, with the tool's login file linked in. Call finish() only after the
 *  tool's process has exited: it puts a replaced login file back into the shared home (bytes
 *  only, never parsed) and deletes the run's home. The copy-back happens only if the connection
 *  is the same one and the shared login has not changed since the run started (another run's
 *  refresh wins, never an older one); it opens the run's file without following a link and
 *  writes the shared file in place, so other running tools keep their access to it. */
// ponytail: a run may write the shared login file in place (tools refresh their token that way),
// so a run can overwrite its own tool's GovernCode login. That can only break that login (Connect
// again fixes it); it reaches nothing else. Upgrade: a private copy per run, published under a
// lock, if a tool is found refreshing mid-run while another run is signing in.
export function runHome(stateDir: string, tool: string, loginFile: string): { home: string; login: string; finish(): void } {
  const shared = join(toolHome(stateDir, tool), loginFile);
  const runs = join(toolDir(stateDir, tool), "runs");
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(runs, "run-"));
  const link = join(home, loginFile);
  if (existsSync(shared)) symlinkSync(shared, link);
  const gen = generation(stateDir, tool);
  const stamp = (): string | null => { try { const st = statSync(shared); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return null; } };
  const before = stamp();
  let done = false;
  return {
    home, login: shared,
    finish() {
      if (done) return;
      done = true;
      try {
        if (gen === null || generation(stateDir, tool) !== gen || stamp() !== before) throw new Error("stale");
        // The run's own file: opened without following a link, and it must be a regular file.
        const fd = openSync(link, constants.O_RDONLY | constants.O_NOFOLLOW);
        let body: Buffer;
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.size === 0 || st.size > 1_000_000) throw new Error("not a login file");
          body = readFileSync(fd);
        } finally { closeSync(fd); }
        const out = openSync(shared, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
        try { writeSync(out, body); fsyncSync(out); } finally { closeSync(out); }
      } catch { /* still our link (written in place, or not at all), stale, or not a file: nothing to put back */ }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
