// Scripted demo: no daemon, provider, authentication, or git command is run.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo } from "../src/demo.ts";

const id = "S-0001";
const checkpoints = { before: "a".repeat(40), after: "b".repeat(40) };
const diff = "diff --git a/README.md b/README.md\n+Usage: import level()\n";
const acceptPrompt = `Accept ${id} into the project? [y/N] `;
const review = () => ({ id, diff, checkpoints: { ...checkpoints } });

function demo(t: TestContext, response: unknown, o: {
  specId?: string; answer?: string | null; atPrompt?: () => void;
  accept?: (params: any) => unknown; displayed?: typeof checkpoints;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "gc-demo-test-"));
  const git = t.mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  });
  const output: string[] = [];
  t.mock.method(console, "log", (s: string) => output.push(s));
  const calls: Array<{ method: string; params: any }> = [];
  const prompts: string[] = [];
  const spec = { id: o.specId ?? id, status: "needs-review" };
  const api = { async call(method: string, params: unknown) {
    calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case "hello": return { sandbox: { ok: true } };
      case "tools.list": return { tools: [{ tool: "claude", connected: true }, { tool: "codex", connected: true }] };
      case "project.list": return { projects: [] };
      case "project.open": case "controller.set": return {};
      case "limits.list": return { providers: [{ provider: "codex", verdict: { ok: true } }] };
      case "spec.list": return { specs: [spec] };
      case "spec.diff": return response;
      case "spec.accept": return o.accept ? o.accept(params) : { id, applied: ["README.md"] };
      case "spec.discard": return { id, discarded: true };
      default: throw new Error(`unexpected demo RPC: ${method}`);
    }
  } };
  let asks = 0;
  const run = () => runDemo(api, {
    path: join(root, "project"), dim: (s) => s, warn: (s) => s,
    runAsk: async () => { asks++; return { ok: true, summary: "scripted task complete" }; },
    tty: { async next(prompt) {
      prompts.push(prompt);
      if (prompts.length === 1) return "";
      assert.equal(prompt, acceptPrompt);
      assert.ok(output.includes(diff), "the diff is displayed before approval");
      const displayed = o.displayed ?? checkpoints;
      assert.ok(output.includes(`${id}: ${displayed.before} → ${displayed.after}`), "the displayed diff names its snapshots");
      o.atPrompt?.();
      return o.answer === undefined ? "y" : o.answer;
    }, close() {} },
  });
  return { run, calls, prompts, output, spec, asks: () => asks, git };
}

test("demo accepts only the displayed, validated snapshot pair", async (t) => {
  const d = demo(t, review());
  assert.equal(await d.run(), 0);
  assert.equal(d.asks(), 2, "both provider turns are mocked");
  assert.equal(d.git.mock.callCount(), 3, "sample git commands are mocked");
  assert.deepEqual(d.calls.filter((c) => c.method.startsWith("spec.")), [
    { method: "spec.list", params: { project: "demo" } },
    { method: "spec.diff", params: { id } },
    { method: "spec.accept", params: { id, checkpoints } },
  ]);
  assert.ok(d.output.some((s) => s.startsWith("Applied 1 file(s).")));
});

test("demo accepts full SHA-256 snapshot IDs too", async (t) => {
  const pair = { before: "c".repeat(64), after: "D".repeat(64) };
  const d = demo(t, { id, diff, checkpoints: pair }, { displayed: pair });
  assert.equal(await d.run(), 0);
  assert.deepEqual(d.calls.at(-1), { method: "spec.accept", params: { id, checkpoints: pair } });
});

test("demo refuses legacy, malformed, or mismatched review metadata before prompting or writing", async (t) => {
  const cases: Array<[string, unknown]> = [
    ["legacy diff-only response", { diff }],
    ["missing ID", { diff, checkpoints }],
    ["invalid ID", { ...review(), id: "S-1" }],
    ["mismatched ID", { ...review(), id: "S-0002" }],
    ["missing checkpoints", { id, diff }],
    ["missing before", { id, diff, checkpoints: { after: checkpoints.after } }],
    ["missing after", { id, diff, checkpoints: { before: checkpoints.before } }],
    ["missing diff", { id, checkpoints }],
    ["non-string diff", { ...review(), diff: 42 }],
    ["no response", null],
  ];
  for (const invalid of [null, "", "abcd", "g".repeat(40), "a".repeat(41), "a".repeat(63), "a".repeat(65), "0".repeat(40), "0".repeat(64)]) {
    for (const side of ["before", "after"]) cases.push([`${side}: ${String(invalid)}`, { id, diff, checkpoints: { ...checkpoints, [side]: invalid } }]);
  }
  for (const [name, response] of cases) await t.test(name, async (t) => {
    const d = demo(t, response);
    await assert.rejects(d.run(), /valid matching review checkpoints; not accepted/);
    assert.equal(d.prompts.length, 1, "no approval prompt after Ready");
    assert.ok(!d.calls.some((c) => c.method === "spec.accept" || c.method === "spec.discard"));
  });
});

test("demo refuses an invalid listed Spec ID before requesting its diff", async (t) => {
  const d = demo(t, review(), { specId: "S-1" });
  await assert.rejects(d.run(), /invalid Spec id; not accepted/);
  assert.ok(!d.calls.some((c) => ["spec.diff", "spec.accept", "spec.discard"].includes(c.method)));
});

test("demo approval stays bound when the server changes while the prompt is open", async (t) => {
  const response = review();
  const latest = { before: "c".repeat(40), after: "d".repeat(40) };
  const d = demo(t, response, {
    atPrompt() {
      response.checkpoints.before = latest.before;
      response.checkpoints.after = latest.after;
      response.diff = "unseen newer change";
      d.spec.id = "S-0002";
    },
    accept(params) {
      assert.deepEqual(params, { id, checkpoints }, "the reviewed ID and snapshots survive mutable response metadata");
      throw new Error("Spec changed since you reviewed it; reload its diff before accepting");
    },
  });
  await assert.rejects(d.run(), /changed since you reviewed/);
  assert.equal(d.calls.filter((c) => c.method === "spec.diff").length, 1, "no unseen snapshot is reacquired");
  assert.equal(d.calls.filter((c) => c.method === "spec.accept").length, 1, "no automatic acceptance retry");
  assert.ok(!d.output.includes("unseen newer change"));
});

test("demo keeps existing decline, no-input, and empty-diff behavior", async (t) => {
  for (const answer of ["n", null]) await t.test(String(answer), async (t) => {
    const d = demo(t, review(), { answer });
    assert.equal(await d.run(), 0);
    assert.ok(!d.calls.some((c) => c.method === "spec.accept"));
    assert.equal(d.calls.some((c) => c.method === "spec.discard"), answer === "n");
    if (answer === null) assert.ok(d.output.some((s) => s.includes("waits for your review")));
  });
  await t.test("empty diff", async (t) => {
    const d = demo(t, { ...review(), diff: "" });
    assert.equal(await d.run(), 0);
    assert.equal(d.prompts.length, 1);
    assert.deepEqual(d.calls.at(-1), { method: "spec.discard", params: { id } });
    assert.ok(!d.calls.some((c) => c.method === "spec.accept"));
  });
});
