// Connect with a fake Antigravity whose usage command asks the user to sign in (a link, then a
// code on stdin), the way the real one does when its home has no login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connector } from "../src/connect.ts";
import { toolHome } from "../src/agy.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-connect-");
const bin = join(root, "bin");
mkdirSync(bin);
const exe = (name: string, body: string) => { const p = join(bin, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
const supervisor = exe("govern-sup", `#!/bin/sh\nshift 4\nexec "$@"\n`);
process.env.GOVERNCODE_AGY_BIN = exe("agy", `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const login = path.join(process.env.HOME, ".gemini", "login");
const quota = () => { process.stdout.write(JSON.stringify({ command: { data: { groups: [{ name: "Gemini Models",
  buckets: [{ window: "weekly", remaining_fraction: 0.5, reset_time: null }] }] } } }) + "\\n"); process.exit(0); };
if (fs.existsSync(login)) quota();
process.stdout.write("Authentication required. Please visit the URL to log in:\\n  https://accounts.example/auth?client=x&code_challenge=y\\n");
require("node:readline").createInterface({ input: process.stdin }).once("line", (code) => {
  if (code.trim() !== "good-code") { process.stderr.write("error: invalid code\\n"); process.exit(1); }
  fs.writeFileSync(login, "fake"); quota();
});
`);

function connector() {
  const state = join(root, `state-${Math.random().toString(36).slice(2)}`);
  return { state, c: new Connector({ supervisor, policyDir: join(state, "pol"), stateDir: state }) };
}

test("connect: the tool's own sign-in link is shown once, the pasted code goes to it, and it ends connected", async () => {
  const { state, c } = connector();
  const seen: any[] = [];
  const r = await c.start("agy", (n: any) => { seen.push(n); if (n.url) c.input(n.id, "good-code"); });
  assert.equal(r.connected, true, JSON.stringify(r));
  assert.deepEqual(seen.filter((n) => n.url).map((n) => n.url), ["https://accounts.example/auth?client=x&code_challenge=y"]);
  assert.ok(seen.some((n) => n.text === "Authentication required. Please visit the URL to log in:"));
  assert.ok(c.list()[0].connected);
  // Connecting again finds the login and needs nothing from the user.
  const again = await c.start("agy", (n: any) => assert.ok(!n.url, "no link when already signed in"));
  assert.equal(again.connected, true);
  const d = c.disconnect("agy");
  assert.equal(d.removed, true);
  assert.ok(!existsSync(toolHome(state, "agy")));
  assert.equal(c.list()[0].connected, false);
});

test("connect: a wrong code or a cancel ends not connected, and input to a finished sign-in is refused", async () => {
  const { c } = connector();
  const bad = await c.start("agy", (n: any) => { if (n.url) c.input(n.id, "wrong"); });
  assert.equal(bad.connected, false);
  assert.match(bad.note, /did not finish signing in/);
  assert.equal(c.list()[0].connected, false, "a failed sign-in is not reported as connected");
  const cancelled = await c.start("agy", (n: any) => { if (n.url) c.cancel(n.id); });
  assert.equal(cancelled.connected, false);
  assert.throws(() => c.input(bad.id, "x"), /no sign-in C-1 is running/);
});

test("review: a sign-in that exits non-zero is not connected, and Disconnect refuses while the login is in use", async () => {
  const { hold } = await import("../src/agy.ts");
  const { state, c } = connector();
  process.env.GOVERNCODE_AGY_BIN = exe("agy-bad", `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ command: { data: { groups: [{ name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: 0.5 }] }] } } }) + "\\n");
process.exit(3);
`);
  const r = await c.start("agy", () => {});
  assert.equal(r.connected, false);
  process.env.GOVERNCODE_AGY_BIN = join(bin, "agy");
  const release = hold(state, "agy");
  assert.throws(() => c.disconnect("agy"), /in use/);
  release();
  assert.doesNotThrow(() => c.disconnect("agy"));
});
