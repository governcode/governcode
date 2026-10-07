// #224: a failed step's output that shows a sandbox refusal, judged by the same analysis as a Gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionGate, runAcpTurn, type AcpRpc } from "../src/acp.ts";
import { analyze, recordedKind } from "../src/allows.ts";
import { blockFor, blockOf, resultText, whereOf } from "../src/blocks.ts";

test("the sandbox's refusals are recognised; other failures are not", () => {
  assert.equal(blockOf("npm ERR! Error: EACCES: permission denied, mkdir '/home/u/.npm'"), "permission denied");
  assert.equal(blockOf("socket: Operation not permitted"), "operation not permitted");
  assert.equal(blockOf("cp: cannot create regular file 'x': Read-only file system"), "read-only file system");
  assert.equal(blockOf("Error: connect EPERM 127.0.0.1:5432"), "operation not permitted");
  assert.equal(blockOf("TypeError: undefined is not a function"), null);
  assert.equal(blockOf("x".repeat(70_000) + "permission denied"), null, "only the start of a long output is looked at");
});

test("a block names its tool and kind as a Gate would, and keeps none of the output", () => {
  const b = blockFor("Bash", { command: "npm install" }, "EACCES: permission denied, open '/home/u/.npmrc' secret-token-123");
  const { where, ...rest } = b!;
  assert.deepEqual(rest, { tool: "Bash", kinds: [], always: true, pattern: "permission denied", why: "install" }, "npm install always asks");
  assert.equal(typeof where, "string", "a place, never the path");
  assert.ok(!JSON.stringify(b).includes("secret") && !JSON.stringify(b).includes(".npmrc"));
  assert.deepEqual(blockFor("Bash", { command: "cargo build" }, "Read-only file system"), { tool: "Bash", kinds: ["command:cargo build"], always: false, pattern: "read-only file system" });
  assert.deepEqual(blockFor("codex command", { command: "cargo build" }, "Read-only file system", "runner")?.kinds, ["runner:command:cargo build"]);
  assert.ok(!JSON.stringify(blockFor("Bash", { command: "ls" }, "permission denied: secret-token-123")).includes("secret"));
  assert.equal(blockFor("Bash", { command: "npm test" }, "3 tests failed"), null);
});

test("tool results are read in their usual shapes", () => {
  assert.equal(resultText("plain"), "plain");
  assert.equal(resultText([{ type: "text", text: "a" }, { type: "image" }, "b"]), "a\n\nb");
  assert.equal(resultText(null), "");
});

// Through the ACP driver (an in-memory agent; adapted from an independent review's reproduction):
// a failed call's kind is the one its Gate would have, and a call a Gate declined is never a block.
async function acpBlocks(tc: Record<string, unknown>, declinedAtGate = false) {
  let notify!: (method: string, params: any) => void, ask!: (method: string, params: any) => Promise<any>;
  const blocks: unknown[] = [];
  const rpc = {
    onNotify(f: any) { notify = f; }, onRequest(f: any) { ask = f; }, notify() {}, close() {},
    closed: new Promise<void>(() => {}), exited: new Promise<void>(() => {}),
    async request(method: string) {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId: "s" };
      if (method === "session/prompt") {
        notify("session/update", { sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "c", status: "pending", ...tc } });
        if (declinedAtGate) await ask("session/request_permission", { sessionId: "s", toolCall: { toolCallId: "c", ...tc },
          options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] });
        notify("session/update", { sessionId: "s", update: { sessionUpdate: "tool_call_update", toolCallId: "c", status: "failed",
          content: [{ type: "content", content: { type: "text", text: declinedAtGate ? "Permission denied by the user." : "EACCES: permission denied: secret-in-output" } }] } });
        return { stopReason: "end_turn" };
      }
      throw new Error(method);
    },
  } as unknown as AcpRpc;
  await runAcpTurn({ rpc, agent: "grok", cwd: "/invented", prompt: "invented",
    hooks: { text() {}, tool() {}, gate: async () => "deny", blocked: (b) => blocks.push(b), done() {} } });
  return blocks as Array<{ kinds: string[]; always: boolean }>;
}

test("ACP: a failed call's kind is its Gate's kind; a call a Gate declined is not a block; no output kept", async () => {
  for (const tc of [{ kind: "execute", rawInput: { command: ["bash", "-lc", "cargo build"] } }, { kind: "delete", rawInput: { path: "/invented/a" } },
    { kind: "other", rawInput: { variant: "ListDir", target_directory: "/invented" } }]) {
    const blocks = await acpBlocks(tc);
    const a = analyze({ ...permissionGate("grok", { toolCall: tc }, "g"), spec: "S-0001" });
    assert.equal(blocks.length, 1, JSON.stringify(tc));
    assert.deepEqual([blocks[0].kinds, blocks[0].always], [a.kinds.map((k) => recordedKind(k.key)), a.ask], JSON.stringify(tc));
    assert.ok(!JSON.stringify(blocks).includes("secret-in-output"));
  }
  assert.deepEqual(await acpBlocks({ kind: "execute", rawInput: { command: "cargo build" } }, true), [], "declined at the Gate");
});

test("a block says roughly where it was refused: a category or one folder under home, never the path", () => {
  const h = "/home/u";
  assert.equal(whereOf("npm ERR! EACCES: permission denied, mkdir '/home/u/.npm/_cacache/tmp'", h), "~/.npm");
  assert.equal(whereOf("touch: cannot touch '/home/u/Documents/secret plans.txt': Permission denied", h), "~/Documents");
  assert.equal(whereOf("open /home/u/.local/state/governcode/specs/S-1/x: permission denied", h), "GovernCode's own folders (a run's home or a Spec's copy)");
  assert.equal(whereOf("cat: /proc/1/environ: Permission denied", h), "/proc, /sys or /dev");
  assert.equal(whereOf("mktemp: failed to create file via template '/tmp/x.XXX': Permission denied", h), "/tmp");
  assert.equal(whereOf("cp: cannot create regular file '/etc/hosts': Read-only file system", h), "system folders");
  assert.equal(whereOf("bash: /mnt/data/x: Permission denied", h), "elsewhere");
  assert.equal(whereOf("Error: EPERM: operation not permitted", h), undefined, "no path, no place");
  assert.equal(whereOf("all good\n/home/u/.npm is fine", h), undefined, "only the line that shows the refusal");
  const b = blockFor("Bash", { command: "node build.js" }, "Error: EACCES: permission denied, open '/home/u/.cache/x'")!;
  assert.equal(b.why, "interpreter");
  assert.match(b.where!, /^~\/\.cache$|^elsewhere$|^the home folder$/);   // (the real home folder decides)
});
