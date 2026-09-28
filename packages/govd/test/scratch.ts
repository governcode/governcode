// Every test's scratch folders live under one folder per test file, removed when the file
// finishes, pass or fail: a test run leaves nothing behind in /tmp.
import { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "governcode-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A fresh folder for one test, named after its purpose. */
export function scratch(prefix: string): string {
  return mkdtempSync(join(ROOT, prefix));
}

/** Tests stand in for the user's Connect: the Controllers' tools count as connected in this
 *  daemon's state (the real sign-in is exercised in connect.test.ts). */
export function markConnected(d: unknown, tools: string[] = ["claude", "codex"]): void {
  const state = dirname((d as { opts: { ledgerPath: string } }).opts.ledgerPath);
  for (const t of tools) {
    mkdirSync(join(state, "tools", t, "home"), { recursive: true });
    writeFileSync(join(state, "tools", t, "connected"), "");
  }
}
