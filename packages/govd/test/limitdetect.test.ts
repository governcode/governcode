// Provider limit detection that belongs to the process driver rather than the daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn } from "../src/claude.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-limit-detect-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
const supervisor = exe("govern-sup", `#!/bin/sh
shift 4
exec "$@"
`);
exe("claude", `#!/bin/sh
sleep .05
case "$(cat scenario)" in
  "one window")
    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1900000000}}'
    echo '{"type":"result","is_error":true,"subtype":"error","terminal_reason":"blocking_limit","result":"stopped"}' ;;
  "missing reset")
    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1900000000}}'
    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day"}}'
    echo '{"type":"result","is_error":true,"subtype":"error","terminal_reason":"blocking_limit","result":"stopped"}' ;;
  "cleared")
    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1900000000}}'
    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","resetsAt":1900000000}}'
    echo '{"type":"result","is_error":true,"subtype":"error","terminal_reason":"api_error","api_error_status":500,"result":"server error"}' ;;
  "stall")
    echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1900000100}}'
    sleep 3600 ;;
  "old text") echo '{"type":"result","is_error":true,"subtype":"error","result":"Usage limit reached|1900000200"}' ;;
  *) echo '{"type":"result","is_error":true,"subtype":"error","terminal_reason":"api_error","api_error_status":500,"result":"ordinary failure"}' ;;
esac
sleep .1
`);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.GOVERNCODE_LIMIT_STALL_MS = "30";

type Result = { ok: boolean; summary: string; usage?: unknown; started?: false; limit?: { resetsAt: string | null }; notices: string[] };

function turn(prompt: string): Promise<Result> {
  const dir = scratch("claude-limit-turn-");
  writeFileSync(join(dir, "scenario"), prompt);
  const notices: string[] = [];
  return new Promise((resolve) => {
    runTurn({ supervisor, policyDir: join(dir, "policy"), worktree: dir, controller: { provider: "claude-code", model: "sonnet", effort: null },
      prompt, stateDir: join(dir, "state"), hooks: { text() {}, tool() {}, gate: async () => "deny",
        notice: (text) => notices.push(text), done: (result) => resolve({ ...result, notices }) } });
  });
}

test("Claude reports a rejected rate-limit window and its reset", async () => {
  const result = await turn("one window");
  assert.deepEqual(result.limit, { resetsAt: new Date(1900000000 * 1000).toISOString() });
  assert.equal(result.ok, false);
  assert.equal(result.summary, "Claude Code hit its usage limit");
  assert.match(result.notices[0], /^Claude Code hit its usage limit \(resets \d\d:\d\d\)$/);
});

test("Claude uses no reset when any rejected window has none", async () => {
  const result = await turn("missing reset");
  assert.deepEqual(result.limit, { resetsAt: null });
  assert.match(result.notices[1], /no reset time given/);
});

test("an allowed rate-limit event clears its window", async () => {
  const result = await turn("cleared");
  assert.equal(result.limit, undefined);
  assert.equal(result.summary, "server error");
});

test("a rejected window that stalls ends the turn as limited", async () => {
  const result = await turn("stall");
  assert.deepEqual(result.limit, { resetsAt: new Date(1900000100 * 1000).toISOString() });
  assert.equal(result.summary, "Claude Code hit its usage limit");
});

test("Claude accepts the older usage-limit epoch text", async () => {
  const result = await turn("old text");
  assert.deepEqual(result.limit, { resetsAt: new Date(1900000200 * 1000).toISOString() });
  assert.equal(result.ok, false);
});

test("an ordinary Claude error is not a usage limit", async () => {
  const result = await turn("normal error");
  assert.equal(result.limit, undefined);
  assert.equal(result.summary, "ordinary failure");
});
