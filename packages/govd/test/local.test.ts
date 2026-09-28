// Local Runners (#185 C): a fake Ollama that answers in Ollama's real streaming shape, so CI covers
// the whole path: availability, machine Limits, the scope check on proposed files, and delegation.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";
import { LimitGate } from "../src/limits.ts";
import { ollamaUsage, planWrites, runLocalTurn } from "../src/local.ts";
import { openControllerSocket, accept } from "../src/delegate.ts";
import { scratch } from "./scratch.ts";

const root = scratch("gc-local-");

type Fake = { status?: number; error?: string; answer?: unknown; raw?: string; hang?: boolean; models?: string[]; bareEnd?: boolean; noDone?: boolean };
const servers: Server[] = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

/** A fake Ollama: /api/tags lists models; /api/chat streams the answer in pieces, then done. */
async function ollama(f: Fake): Promise<{ host: string; asked: any[] }> {
  const asked: any[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (f.status) { res.writeHead(f.status, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: f.error ?? "nope" })); }
      if (req.url === "/api/tags") { res.writeHead(200); return res.end(JSON.stringify({ models: (f.models ?? ["qwen3.5:9b"]).map((name) => ({ name })) })); }
      asked.push(JSON.parse(body));
      if (f.hang) return;   // never answers: the caller's signal must stop it
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const text = f.raw ?? JSON.stringify(f.answer);
      const half = Math.floor(text.length / 2);
      res.write(JSON.stringify({ message: { content: text.slice(0, half) }, done: false }) + "\n");
      res.write(JSON.stringify({ message: { content: text.slice(half) }, done: false }) + "\n");
      if (f.noDone) return res.end();
      res.end(JSON.stringify({ message: { content: "" }, done: true, eval_count: 42, prompt_eval_count: 300 }) + (f.bareEnd ? "" : "\n"));
    });
  });
  servers.push(srv);
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { host: `http://127.0.0.1:${(srv.address() as any).port}`, asked };
}

function work() {
  const dir = mkdtempSync(join(root, "work-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "src/tide.js"), "export const level = (t) => t;\n");
  return dir;
}

const run = (o: Omit<Parameters<typeof runLocalTurn>[0], "hooks">) => new Promise<{ ok: boolean; summary: string; texts: string[] }>((done) => {
  const texts: string[] = [];
  void runLocalTurn({ ...o, hooks: { text: (t) => texts.push(t), done: (r) => done({ ...r, texts }) } });
});

test("local: the model sees the scope's files, and its in-scope file is written", async () => {
  const w = work();
  const f = await ollama({ answer: { summary: "added usage", files: [{ path: "README.md", content: "# demo\n\n## Usage\n" }] } });
  const r = await run({ host: f.host, model: "qwen3.5:9b", work: w, scope: { read: ["src"], write: ["README.md"] }, prompt: "add usage", maxMinutes: 1 });
  assert.equal(r.ok, true, r.summary);
  assert.equal(readFileSync(join(w, "README.md"), "utf8"), "# demo\n\n## Usage\n");
  const user = f.asked[0].messages[1].content;
  assert.match(user, /=== src\/tide\.js ===/);
  assert.match(user, /=== README\.md ===/);
  assert.equal(f.asked[0].think, false);
  assert.ok(f.asked[0].format, "asks for structured JSON");
  assert.match(r.texts.at(-1)!, /300 tokens in, 42 out/);
});

test("local: a file outside the write scope refuses the whole answer, and nothing is written", async () => {
  const w = work();
  const f = await ollama({ answer: { summary: "x", files: [{ path: "README.md", content: "ok" }, { path: "src/tide.js", content: "sneaky" }] } });
  const r = await run({ host: f.host, model: "m", work: w, scope: { read: [], write: ["README.md"] }, prompt: "p", maxMinutes: 1 });
  assert.equal(r.ok, false);
  assert.match(r.summary, /refused, nothing written: src\/tide\.js is outside/);
  assert.equal(readFileSync(join(w, "README.md"), "utf8"), "# demo\n");
});

test("local: proposed paths that escape, touch git, or go through a symlink are refused", () => {
  const w = work();
  mkdirSync(join(w, "elsewhere"));
  symlinkSync(join(w, "elsewhere"), join(w, "linked"));
  for (const path of ["../outside.txt", "/etc/passwd", ".git/config", "src/.git/hooks/x", "linked/x.txt", "src/../../x"]) {
    const p = planWrites(w, [], { files: [{ path, content: "x" }] });
    assert.ok("refused" in p, `${path} should be refused`);
  }
  linkSync(join(w, "README.md"), join(w, "hardlink.md"));
  assert.ok("refused" in planWrites(w, [], { files: [{ path: "hardlink.md", content: "x" }] }), "a hard link is never written through");
  mkdirSync(join(w, "adir"));
  assert.ok("refused" in planWrites(w, [], { files: [{ path: "adir", content: "x" }] }), "a directory is not overwritten");
  assert.ok("refused" in planWrites(w, [], { files: "nope" }));
  // Codex review: one spelling per file, no file-and-folder clash, no writing under a file.
  const refused = (files: Array<{ path: string }>) => "refused" in planWrites(w, [], { files: files.map((f) => ({ ...f, content: "x" })) });
  assert.ok(refused([{ path: "a" }, { path: "a/b" }]), "a file and a folder of the same name");
  assert.ok(refused([{ path: "a/b" }, { path: "a" }]));
  assert.ok(refused([{ path: "README.md/child" }]), "under an existing file");
  assert.ok(refused([{ path: "README.md" }, { path: "./README.md" }]), "the same file twice");
  assert.ok(refused([{ path: "README.md" }, { path: "readme.md" }]));
  for (const path of ["src/./x.js", "src//x.js", "src/", "", ".GIT/config"]) assert.ok(refused([{ path }]), `${JSON.stringify(path)} should be refused`);
  const ok = planWrites(w, ["src"], { files: [{ path: "src/new/deep.js", content: "x" }] });
  assert.ok("writes" in ok && ok.writes[0].content === "x\n", "a dropped final newline is put back");
});

test("local: Ollama's own refusal reaches the user word for word", async () => {
  const f = await ollama({ status: 503, error: "busy: try again later" });
  const r = await run({ host: f.host, model: "m", work: work(), scope: { read: [], write: [] }, prompt: "p", maxMinutes: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.summary, "Ollama: busy: try again later");
  const src = ollamaUsage(f.host);
  assert.equal(await src.read(), null);
  assert.equal(src.why(), "Ollama: busy: try again later");
});

test("local: the stream's last record without a newline still counts; a stream with no final record writes nothing", async () => {
  const w = work();
  const bare = await ollama({ bareEnd: true, answer: { summary: "s", files: [{ path: "README.md", content: "new\n" }] } });
  assert.equal((await run({ host: bare.host, model: "m", work: w, scope: { read: [], write: [] }, prompt: "p", maxMinutes: 1 })).ok, true);
  const cut = await ollama({ noDone: true, answer: { summary: "s", files: [{ path: "src/tide.js", content: "cut\n" }] } });
  const r = await run({ host: cut.host, model: "m", work: w, scope: { read: [], write: [] }, prompt: "p", maxMinutes: 1 });
  assert.equal(r.ok, false);
  assert.match(r.summary, /ended early/);
  assert.equal(readFileSync(join(w, "src/tide.js"), "utf8"), "export const level = (t) => t;\n");
});

test("local: an absolute read scope shows the model nothing, not the whole project", async () => {
  const f = await ollama({ answer: { summary: "s", files: [] } });
  await run({ host: f.host, model: "m", work: work(), scope: { read: ["/"], write: ["README.md"] }, prompt: "p", maxMinutes: 1 });
  const user = f.asked[0].messages[1].content;
  assert.doesNotMatch(user, /src\/tide\.js/);
  assert.match(user, /=== README\.md ===/);
});

test("local: not valid JSON is a failed Spec, not a partial write", async () => {
  const w = work();
  const f = await ollama({ raw: "Sure! Here is the file: ..." });
  const r = await run({ host: f.host, model: "m", work: w, scope: { read: [], write: [] }, prompt: "p", maxMinutes: 1 });
  assert.equal(r.ok, false);
  assert.match(r.summary, /not valid JSON/);
});

test("local: the caller's stop ends a model that never answers", async () => {
  const f = await ollama({ hang: true });
  const stop = new AbortController();
  setTimeout(() => stop.abort("Limit: stopping"), 100);
  const r = await run({ host: f.host, model: "m", work: work(), scope: { read: [], write: [] }, prompt: "p", maxMinutes: 1, signal: stop.signal });
  assert.equal(r.ok, false);
  assert.equal(r.summary, "Limit: stopping");
});

test("local Limits: held with the reason while Ollama is away; at most N at once; no quota debit", () => {
  const g = new LimitGate();
  g.forget("ollama", "Ollama is not answering at http://127.0.0.1:11434");
  const held = g.check("ollama");
  assert.equal(held.ok, false);
  assert.match((held as any).reason, /not answering at .* · held/);
  g.record({ provider: "ollama", measuredAt: Date.now(), readings: [] });
  assert.equal(g.admit("S-1", "ollama", 50).ok, true);
  const second = g.admit("S-2", "ollama", 5);
  assert.equal(second.ok, false);
  assert.match((second as any).reason, /already running 1 local Spec \(at most 1 at once\)/);
  assert.equal(g.stillWithin("S-1").ok, true);
  g.release("S-1");
  assert.equal(g.admit("S-3", "ollama", 5).ok, true, "released: the next one may start, nothing owed");
  g.setLocal({ maxRunning: 2, maxMinutes: 5 });
  assert.equal(g.admit("S-4", "ollama", 5).ok, true);
  assert.deepEqual(g.localRule("ollama"), { maxRunning: 2, maxMinutes: 5 });
  assert.equal(g.localRule("codex"), null);
});

test("delegate to ollama: crew lists its models; the Spec's change is offered for review, not applied", async () => {
  const f = await ollama({ answer: { summary: "usage section", files: [{ path: "README.md", content: "# p\n\n## Usage\n" }] } });
  const proj = mkdtempSync(join(root, "proj-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", proj, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  writeFileSync(join(proj, "README.md"), "# p\n");
  g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  const state = mkdtempSync(join(root, "state-"));
  const ledger = new Ledger(":memory:");
  const prev = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = f.host;
  const gates: string[] = [];
  const ctx = { project: { name: "p", path: proj }, ledger, limits: new LimitGate(), usage: { ollama: ollamaUsage(f.host) },
    runtimeDir: join(state, "run"), supervisor: "/nonexistent", policyDir: join(state, "pol"), stateDir: state,
    gate: async (r: { tool?: string; canonical: string }) => { if (r.tool !== "governcode delegate") gates.push(r.canonical); return "allow" as const; }, notify: () => {} };
  const sock = openControllerSocket(ctx);
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const s = connect(sock.path);
    createInterface({ input: s }).once("line", (l) => { ok(JSON.parse(l)); s.end(); });
    s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    const crew = await call("controller.crew", {});
    const o = crew.result.runners.find((r: any) => r.provider === "ollama");
    assert.equal(o.available, true);
    assert.deepEqual(o.models, ["qwen3.5:9b"]);
    const r = await call("controller.delegate", { to: "ollama", brief: "add a Usage section", result: "README has ## Usage",
      scope: { read: [], write: ["README.md"] }, budgetPercent: 5, model: "qwen3.5:9b", effort: null, reason: "small docs job" });
    assert.equal(r.result.status, "needs-review", JSON.stringify(r));
    assert.deepEqual(r.result.files, ["README.md"]);
    assert.match(r.result.diff, /\+## Usage/);
    assert.equal(gates.length, 0, "a local model runs nothing, so it asks nothing");
    assert.equal(readFileSync(join(proj, "README.md"), "utf8"), "# p\n", "nothing lands before accept");
    assert.deepEqual(accept(state, proj, ledger.spec(r.result.id)!), ["README.md"]);
    assert.equal(readFileSync(join(proj, "README.md"), "utf8"), "# p\n\n## Usage\n");
  } finally {
    sock.close(); ledger.close();
    if (prev === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = prev;
  }
});

test("local: a missing model name is Ollama's own message", async () => {
  const f = await ollama({ status: 404, error: "model 'nope' not found" });
  const r = await run({ host: f.host, model: "nope", work: work(), scope: { read: [], write: [] }, prompt: "p", maxMinutes: 1 });
  assert.equal(r.summary, "Ollama: model 'nope' not found");
  assert.ok(!existsSync(join(root, "never")));
});
