#!/usr/bin/env node
// govd entry point: run the sandbox self-test, then serve until stopped.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "./daemon.ts";
import { homeDir, ledgerPath, policyDir, socketPath, stateDir } from "./paths.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const supervisor = process.env.GOVERN_SUP ?? [join(repo, "target/release/govern-sup"), join(repo, "target/debug/govern-sup")]
  .find(existsSync) ?? "govern-sup";

// A release writes VERSION next to package.json; a checkout reports package.json's version.
const version = (() => {
  try { return readFileSync(join(repo, "VERSION"), "utf8").trim(); } catch { /* a checkout */ }
  try { return String(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version ?? "dev"); } catch { return "dev"; }
})();
const freshState = !existsSync(stateDir);
const daemon = new Daemon({ socketPath, ledgerPath, policyDir, homeDir, supervisor, version });
// A state folder govd created itself is marked as its own, so `install.sh --uninstall --purge`
// may remove it; one that already existed (it could be anything) is never marked.
if (freshState) try { writeFileSync(join(stateDir, ".governcode-state"), "GovernCode's state folder (govd).\n", { flag: "wx" }); } catch { /* already there */ }
const test = daemon.selftest();
console.log(`govd: sandbox ${test.ok ? "enforced (self-test passed)" : "NOT verified: " + test.reason}`);
await daemon.listen();
console.log(`govd: listening on ${socketPath}`);
if (test.ok) {
  const pc = daemon.policyCheck();
  console.log(pc.ok ? "govd: Claude policy verified on this machine" : `govd: Claude policy FAILED, starting nothing: ${pc.problems.join("; ")}`);
}
// Stopping gives running Runners a few seconds to end, so their Specs are recorded as stopped; a
// second signal does not wait.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
  if (stopping) process.exit(0);
  stopping = true;
  void daemon.stop().finally(() => process.exit(0));
});
