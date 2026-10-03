import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCodexTurn } from "../src/codex.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-codex-limit-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => {
  const path = join(bin, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
};

const supervisor = exe("govern-sup", `#!/bin/sh
[ "$1" = selftest ] && exit 0
shift 4
exec "$@"
`);

process.env.GOVERNCODE_CODEX_BIN = exe("codex", `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) echo '{"id":1,"result":{}}' ;;
    *'"method":"thread/start"'*) echo '{"id":2,"result":{"thread":{"id":"thread"}}}' ;;
    *'"method":"turn/start"'*'notification'*)
      echo '{"id":3,"result":{}}'
      echo '{"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":2000000000},"secondary":{"usedPercent":100,"windowDurationMins":10080,"resetsAt":2100000000}}}}'
      echo '{"method":"error","params":{"error":{"message":"limited","codexErrorInfo":{"usageLimitExceeded":{}}},"willRetry":false,"turnId":"turn","threadId":"thread"}}'
      echo '{"method":"turn/completed","params":{"turn":{"status":"failed"}}}' ;;
    *'"method":"turn/start"'*'completed'*)
      echo '{"id":3,"result":{}}'
      echo '{"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":2000000000},"secondary":{"usedPercent":100,"windowDurationMins":10080}}}}'
      echo '{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"codexErrorInfo":"rateLimitExceeded"}}}}' ;;
    *'"method":"turn/start"'*'exit'*)
      echo '{"id":3,"result":{}}'
      echo '{"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":2000000000},"secondary":{"usedPercent":100,"windowDurationMins":10080,"resetsAt":2100000000}}}}'
      echo '{"method":"error","params":{"error":{"message":"limited","codexErrorInfo":{"usageLimitExceeded":{}}},"willRetry":false,"turnId":"turn","threadId":"thread"}}'
      exit 0 ;;
    *'"method":"turn/start"'*)
      echo '{"id":3,"result":{}}'
      echo '{"method":"account/rateLimits/updated","params":{"rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300,"resetsAt":2000000000}}}}'
      echo '{"method":"error","params":{"error":{"message":"retrying","codexErrorInfo":"usageLimitExceeded"},"willRetry":true,"turnId":"turn","threadId":"thread"}}'
      echo '{"method":"turn/completed","params":{"turn":{"status":"failed","error":{"message":"failed"}}}}' ;;
  esac
done
`);

async function run(prompt: string): Promise<any> {
  const stateDir = scratch("state-");
  const worktree = scratch("work-");
  mkdirSync(join(stateDir, "tools", "codex", "home"), { recursive: true });
  writeFileSync(join(stateDir, "tools", "codex", "connected"), "");
  let resolve!: (result: any) => void;
  const done = new Promise<any>((r) => (resolve = r));
  await runCodexTurn({ supervisor, policyDir: join(stateDir, "policies"), stateDir, worktree,
    model: "test", effort: null, prompt,
    hooks: { text: () => {}, tool: () => {}, gate: async () => "deny", done: resolve } });
  return done;
}

test("Codex non-retrying limit notification uses the latest exhausted reset", async () => {
  const result = await run("notification");
  assert.equal(result.ok, false);
  assert.equal(result.summary, "Codex hit its usage limit");
  assert.deepEqual(result.limit, { resetsAt: new Date(2100000000 * 1000).toISOString() });
});

test("Codex completed limit has no reset when an exhausted window has none", async () => {
  const result = await run("completed");
  assert.equal(result.ok, false);
  assert.equal(result.summary, "Codex hit its usage limit");
  assert.deepEqual(result.limit, { resetsAt: null });
});

test("Codex keeps a known limit when app-server exits without completing", async () => {
  const result = await run("exit");
  assert.equal(result.ok, false);
  assert.equal(result.summary, "Codex hit its usage limit");
  assert.deepEqual(result.limit, { resetsAt: new Date(2100000000 * 1000).toISOString() });
});

test("Codex retrying limit notification does not mark the turn limited", async () => {
  const result = await run("retry");
  assert.equal(result.ok, false);
  assert.match(result.summary, /^turn failed:/);
  assert.equal("limit" in result, false);
});
