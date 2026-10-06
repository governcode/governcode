import { test } from "node:test";
import assert from "node:assert/strict";
import { gateAsker, gateFitsInline, gateTool, projectStatus, providerUsage } from "../src/shared/status.ts";

const spec = (id: string, project: string, status: string, to = "codex") => ({ id, project, status, to, brief: "b" });

test("a project's status: Gates first, then reviews, then running work, then held work", () => {
  const specs = [spec("S-1", "a", "running", "grok"), spec("S-2", "a", "needs-review"), spec("S-3", "b", "held"), spec("S-4", "c", "accepted")];
  assert.deepEqual(projectStatus("a", specs, [{ project: "a" }]).dot, "needs");
  assert.equal(projectStatus("a", specs, [{ project: "a" }]).text, "1 Gate waiting for you");
  assert.equal(projectStatus("a", specs, []).text, "1 Spec ready for review");
  assert.equal(projectStatus("a", specs.filter((s) => s.id !== "S-2"), []).text, "grok is working on S-1");
  assert.deepEqual([projectStatus("b", specs, []).dot, projectStatus("b", specs, []).text], ["held", "1 Spec held by its Limit"]);
  assert.deepEqual([projectStatus("c", specs, [{ project: null }]).dot, projectStatus("c", specs, []).text], [null, "Idle"]);
});

test("a provider's ring shows the window with the least room before its reserve", () => {
  const p = { provider: "codex", unmetered: false, reservePercent: 10, reserves: { "5h": 10, weekly: 15 }, verdict: { ok: true as const },
    readings: [{ window: "5h", usedPercent: 60, resetsAt: null }, { window: "weekly", usedPercent: 80, resetsAt: null }] };
  assert.deepEqual(providerUsage(p), { percent: 80, reserve: 15, window: "weekly", counted: null });
  assert.deepEqual(providerUsage({ ...p, readings: [] }), { percent: 0, reserve: 10, window: null, counted: null });
});

test("a queued Spec says it is queued, not working", () => {
  assert.equal(projectStatus("a", [spec("S-9", "a", "queued", "grok")], []).text, "S-9 is queued for grok");
});

test("a Gate is answerable from a one-line row only when all of its request is shown there", () => {
  assert.equal(gateFitsInline("npm install --save-dev @types/supertest"), true);
  assert.equal(gateFitsInline("cat <<EOF > x\nharmless\nEOF\nrm -rf ~/work"), false, "a second line would be hidden");
  assert.equal(gateFitsInline("echo ok\rrm -rf ~"), false);
  assert.equal(gateFitsInline("x".repeat(141)), false, "too long to show in full");
  for (const hidden of ["echo a\tb", "echo ok\u2028rm -rf ~", "echo \u202egnp.exe", "rm\u200b -rf build", "echo \ufeffx"]) {
    assert.equal(gateFitsInline(hidden), false, JSON.stringify(hidden));
  }
});

test("a Gate's asker is the Runner named in its tool, else the project's Controller, else unknown", () => {
  const projects = [{ name: "web", controller: { provider: "claude" } }];
  assert.equal(gateAsker({ tool: "Runner · codex · Bash", project: "web" }, projects), "codex");
  assert.equal(gateAsker({ tool: "Bash", project: "web" }, projects), "claude");
  assert.equal(gateAsker({ tool: "Bash", project: null }, projects), null);
  assert.equal(gateAsker({ tool: "Bash", project: "removed" }, projects), null);
  assert.equal(gateTool("Runner · codex · Bash"), "Bash");
  assert.equal(gateTool("Edit"), "Edit");
});
