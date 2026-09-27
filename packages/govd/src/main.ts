#!/usr/bin/env node
// govd entry point: run the sandbox self-test, then serve until stopped.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "./daemon.ts";
import { homeDir, ledgerPath, policyDir, socketPath } from "./paths.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const supervisor = process.env.GOVERN_SUP ?? [join(repo, "target/release/govern-sup"), join(repo, "target/debug/govern-sup")]
  .find(existsSync) ?? "govern-sup";

const daemon = new Daemon({ socketPath, ledgerPath, policyDir, homeDir, supervisor, version: "0.0.1" });
const test = daemon.selftest();
console.log(`govd: sandbox ${test.ok ? "enforced (self-test passed)" : "NOT verified: " + test.reason}`);
await daemon.listen();
console.log(`govd: listening on ${socketPath}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { daemon.close(); process.exit(0); });
