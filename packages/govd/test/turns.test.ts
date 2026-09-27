// Controller turn Checkpoints: a turn that edits the project can be undone, exactly, once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";

const root = mkdtempSync(join(tmpdir(), "gc-turns-"));
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
const supervisor = exe("govern-sup", `#!/bin/sh\n[ "$1" = selftest ] && exit 0\nshift 4\nexec "$@"\n`);
// A Controller that edits README.md and adds notes.txt in its working directory.
exe("claude", `#!/usr/bin/env node
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  fs.writeFileSync("README.md", "# changed by the controller\\n");
  fs.writeFileSync("notes.txt", "new\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "edited" }) + "\\n");
  process.exit(0);
});
`);
process.env.PATH = `${bin}:${process.env.PATH}`;

function client(sock: string) {
  const s = connect(sock);
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: s }).on("line", (l) => { const m = JSON.parse(l); if (m.id) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  return { call: (method: string, params: unknown = {}) => new Promise<any>((ok) => { const n = ++id; waiting.set(n, ok);
    s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); }), end: () => s.end() };
}

test("a Controller turn's changes are checkpointed and can be undone exactly once", async () => {
  const d = new Daemon({ socketPath: join(root, "run/govd.sock"), ledgerPath: join(root, "state/trace.sqlite"),
    policyDir: join(root, "state/pol"), homeDir: join(root, "state/home"), supervisor, version: "t" });
  d.selftest();
  await d.listen();
  const c = client(join(root, "run/govd.sock"));
  const proj = join(root, "proj");
  await c.call("project.new", { name: "proj", path: proj, git: true });
  writeFileSync(join(proj, "README.md"), "# original\n");
  execFileSync("git", ["-C", proj, "add", "-A"]);
  const r = await c.call("ask", { project: "proj", prompt: "edit things" });
  assert.equal(r.result.ok, true, JSON.stringify(r));
  const { result: { turns } } = await c.call("turn.list", { project: "proj" });
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].files.sort(), ["README.md", "notes.txt"]);

  const u = await c.call("turn.undo", { id: turns[0].id });
  assert.deepEqual(u.result.restored.sort(), ["README.md", "notes.txt"]);
  assert.equal(readFileSync(join(proj, "README.md"), "utf8"), "# original\n");
  assert.ok(!existsSync(join(proj, "notes.txt")));
  const again = await c.call("turn.undo", { id: turns[0].id });
  assert.match(again.error.message, /already undone/);
  c.end(); d.close();
});

test("undo refuses when the user changed a file after the turn", async () => {
  const d = new Daemon({ socketPath: join(root, "run2/govd.sock"), ledgerPath: join(root, "state2/trace.sqlite"),
    policyDir: join(root, "state2/pol"), homeDir: join(root, "state2/home"), supervisor, version: "t" });
  d.selftest();
  await d.listen();
  const c = client(join(root, "run2/govd.sock"));
  const proj = join(root, "proj2");
  await c.call("project.new", { name: "proj2", path: proj, git: true });
  writeFileSync(join(proj, "README.md"), "# original\n");
  execFileSync("git", ["-C", proj, "add", "-A"]);
  await c.call("ask", { project: "proj2", prompt: "edit things" });
  const { result: { turns } } = await c.call("turn.list", { project: "proj2" });
  writeFileSync(join(proj, "notes.txt"), "the user kept working\n");
  const u = await c.call("turn.undo", { id: turns[0].id });
  assert.match(u.error.message, /changed since.*notes\.txt/);
  assert.equal(readFileSync(join(proj, "README.md"), "utf8"), "# changed by the controller\n", "all or nothing");
  c.end(); d.close();
});
