#!/usr/bin/env node
// govd entry point: run the sandbox self-test, then serve until stopped.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "./daemon.ts";
import { homeDir, ledgerPath, policyDir, socketPath } from "./paths.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const supervisor = process.env.GOVERN_SUP ?? [join(repo, "target/release/govern-sup"), join(repo, "target/debug/govern-sup")]
  .find(existsSync) ?? "govern-sup";

// A release writes VERSION next to package.json; a checkout reports package.json's version.
const version = (() => {
  try { return readFileSync(join(repo, "VERSION"), "utf8").trim(); } catch { /* a checkout */ }
  try { return String(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version ?? "dev"); } catch { return "dev"; }
})();
const daemon = new Daemon({ socketPath, ledgerPath, policyDir, homeDir, supervisor, version });
const test = daemon.selftest();
console.log(`govd: sandbox ${test.ok ? "enforced (self-test passed)" : "NOT verified: " + test.reason}`);
await daemon.listen();
console.log(`govd: listening on ${socketPath}`);
if (test.ok) {
  const pc = daemon.policyCheck();
  console.log(pc.ok ? "govd: Claude policy verified on this machine" : `govd: Claude policy FAILED, starting nothing: ${pc.problems.join("; ")}`);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { daemon.close(); process.exit(0); });
