#!/usr/bin/env node
// Antigravity's PreToolUse hook for a GovernCode Runner. Antigravity runs it INSIDE the Runner's
// sandbox before every tool call, with the call as JSON on stdin; it asks govd over the run's own
// socket (the only socket the policy lets it reach) and prints govd's answer. Anything that goes
// wrong prints a denial and exits non-zero: Antigravity treats a failing hook as a denial too
// (verified 2026-09-28: crash, timeout and garbage output all blocked the write).
import { connect } from "node:net";
import { createInterface } from "node:readline";

const deny = (reason: string) => { process.stdout.write(JSON.stringify({ decision: "deny", reason }) + "\n"); process.exit(1); };
const socketPath = process.argv[2];
if (!socketPath) deny("GovernCode hook: no socket");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { input += c; if (input.length > 4_000_000) deny("GovernCode hook: input too large"); });
process.stdin.on("end", () => {
  let payload: unknown;
  try { payload = JSON.parse(input); } catch { return deny("GovernCode hook: unreadable tool call"); }
  const sock = connect(socketPath);
  sock.on("error", (e) => deny(`GovernCode hook: ${e.message}`));
  sock.on("close", () => deny("GovernCode hook: govd closed the connection"));
  createInterface({ input: sock }).once("line", (l) => {
    let m: any;
    try { m = JSON.parse(l); } catch { return deny("GovernCode hook: unreadable answer"); }
    const d = m?.result?.decision;
    if (d !== "allow" && d !== "deny") return deny(m?.error?.message ? `GovernCode: ${m.error.message}` : "GovernCode hook: no decision");
    process.stdout.write(JSON.stringify({ decision: d, ...(m.result.reason ? { reason: String(m.result.reason) } : {}) }) + "\n");
    process.exit(0);   // a decided answer (allow or deny) exits cleanly so its reason reaches the agent
  });
  sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "agy.pretool", params: payload }) + "\n");
});
