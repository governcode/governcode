// Every test's scratch folders live under one folder per test file, removed when the file
// finishes, pass or fail: a test run leaves nothing behind in /tmp.
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "governcode-test-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A fresh folder for one test, named after its purpose. */
export function scratch(prefix: string): string {
  return mkdtempSync(join(ROOT, prefix));
}
