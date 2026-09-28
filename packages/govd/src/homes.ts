// Tool homes (Codex's review of step 4, 2026-09-28). Each tool has one GovernCode home where
// Connect signed it in; only its login file is shared between runs. Every run gets a fresh, empty
// home of its own with that login file linked in, and the run's home is deleted afterwards, so
// nothing a run writes (memory, caches, settings, rules, skills, instructions) reaches another
// run, in this project or any other, even when runs overlap. If the tool replaced its login file
// (a token refresh written by rename), govd copies the new file back byte for byte, never parsing it.
// Whether a tool is connected is recorded outside every home a tool can write.
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const toolDir = (stateDir: string, tool: string) => join(stateDir, "tools", tool);
/** The GovernCode home Connect signs the tool into. */
export const toolHome = (stateDir: string, tool: string) => join(toolDir(stateDir, tool), "home");
const mark = (stateDir: string, tool: string) => join(toolDir(stateDir, tool), "connected");

export function isConnected(stateDir: string, tool: string): boolean {
  return existsSync(mark(stateDir, tool));
}
export function setConnected(stateDir: string, tool: string, yes: boolean): void {
  if (!yes) { rmSync(mark(stateDir, tool), { force: true }); return; }
  mkdirSync(toolDir(stateDir, tool), { recursive: true, mode: 0o700 });
  writeFileSync(mark(stateDir, tool), "Connected for GovernCode. GovernCode never reads the login the tool keeps in home/.\n", { mode: 0o600 });
}

/** A fresh home for one run, with the tool's login file linked in. finish() puts a replaced login
 *  file back into the shared home (bytes only) and deletes the run's home. */
export function runHome(stateDir: string, tool: string, loginFile: string): { home: string; login: string; finish(): void } {
  const shared = join(toolHome(stateDir, tool), loginFile);
  const runs = join(toolDir(stateDir, tool), "runs");
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(runs, "run-"));
  const link = join(home, loginFile);
  if (existsSync(shared)) symlinkSync(shared, link);
  let done = false;
  return {
    home, login: shared,
    finish() {
      if (done) return;
      done = true;
      try {
        const st = lstatSync(link);
        // Still our link: the tool wrote in place (or not at all). A regular file: it replaced the
        // link with a refreshed login, which goes back to the shared home, atomically.
        if (st.isFile() && st.size > 0 && st.size < 1_000_000) {
          const tmp = `${shared}.governcode-${process.pid}-${randomBytes(6).toString("hex")}`;
          const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeSync(fd, readFileSync(link)); fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(tmp, shared);
        }
      } catch { /* no login file: nothing to keep */ }
      rmSync(home, { recursive: true, force: true });
    },
  };
}
