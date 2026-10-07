// Direct Gate helpers and importer-scoped, in-memory Runner stubs only: no provider or workspace execution.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { SpecInput } from "@governcode/protocol";
import { permissionGate, pickOption, runAcpTurn, type AcpRpc } from "../src/acp.ts";
import { Allows, analyze, isQuietRead, kindOf, scopesFor } from "../src/allows.ts";
import { canonical, type GateRequest, type TurnHooks } from "../src/claude.ts";
import type { DelegationContext } from "../src/delegate.ts";
import { Ledger } from "../src/ledger.ts";
import { LimitGate } from "../src/limits.ts";

const marker = "acp command";
const asks = { ask: true, quiet: false, kinds: [] };
// The decision only: why a step asks has its own test (allows.test.ts).
const decision = ({ why: _why, ...a }: ReturnType<typeof analyze>) => a;
const options = [{ optionId: "once", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }];
const denied = { outcome: { outcome: "selected", optionId: "no" } };
const paramsFor = (command: unknown) => ({ toolCall: { kind: "execute", title: "invented title", rawInput: { command, cwd: "/invented/work" } } });
const hostGate = (command: unknown): GateRequest => ({ id: "host", tool: "unrelated display", base: marker,
  input: { command }, canonical: canonical({ tool: "unrelated display", input: { command } }) });
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

const commands: Array<[string, unknown]> = [
  ["string", "npm test"], ["array", ["npm", "test"]], ["array shell wrapper", ["bash", "-lc", "npm test"]],
  ["string shell wrapper", "/usr/bin/bash -lc 'npm test'"], ["quiet", "cat src/example.ts"],
  ["quiet array", ["ls", "-la"]], ["version", "node --version"], ["range", "sed -n '1,3p' src/example.ts"],
  ["compound", "cd src && npm test 2>&1 | tail -20"], ["multiple kinds", "npm test && cargo test"],
  ["repeated kind", "npm test; npm test"], ["cd only", "cd src"],
  ["dangerous compound", "npm test && rm -rf src"], ["install", "npm install"], ["git mutation", "git reset --hard"],
  ["substitution", "echo $(npm test)"], ["backtick", "echo `npm test`"], ["redirection", "npm test > result.txt"],
  ["null redirection", "npm test >/dev/null"], ["special path", "cat /dev/zero"],
  ["normalized special path", "cat /./dev/zero"], ["parent path", "cat ../example.ts"],
  ["malformed quotes", "npm test '"], ["empty", ""], ["null", null], ["object", { command: "npm test" }],
  ["mixed array", ["npm", 1]], ["empty array", []],
];

for (const [name, command] of commands) {
  test(`legacy control: Grok ${name} keeps visible/canonical bytes and analysis`, () => {
    const req = permissionGate("grok", paramsFor(command), "request");
    const accepted = typeof command === "string" || (Array.isArray(command) && command.every((w) => typeof w === "string")) ? command : null;
    const input = { command: accepted, cwd: "/invented/work", title: "invented title", input: { command, cwd: "/invented/work" } };
    const visible = { id: "request", tool: "grok command", input, canonical: canonical({ tool: "grok command", input }) };
    const { base: _base, ...shown } = req;
    assert.deepEqual(shown, visible);
    assert.equal(req.canonical, visible.canonical);
    for (const spec of [undefined, "S-invented"]) {
      assert.deepEqual(analyze({ ...req, spec }), analyze({ ...visible, spec }));
      assert.deepEqual(kindOf({ ...req, spec }), kindOf({ ...visible, spec }));
      assert.equal(isQuietRead(req), isQuietRead(visible));
    }
  });
}

test("contract: only Grok execute authors the internal command base", () => {
  assert.equal(permissionGate("grok", paramsFor("npm test"), "request").base, marker);
  for (const agent of ["invented", "acp", "Grok", "grok "]) {
    const req = permissionGate(agent, paramsFor("npm test"), "request");
    assert.equal(req.base, undefined);
    assert.deepEqual(decision(analyze(req)), asks);
    assert.equal(kindOf(req), null);
    assert.equal(isQuietRead(req), false);
  }
});

test("contract: host base recognizes commands with unrelated displays in all entry points", () => {
  for (const [, command] of commands) {
    const host = hostGate(command), legacy = { ...host, tool: "grok command", base: undefined };
    for (const spec of [undefined, "S-invented"]) {
      assert.deepEqual(analyze({ ...host, spec }), analyze({ ...legacy, spec }));
      assert.deepEqual(kindOf({ ...host, spec }), kindOf({ ...legacy, spec }));
    }
    assert.equal(isQuietRead(host), isQuietRead(legacy));
  }
  assert.equal(kindOf(hostGate("npm test"))?.key, "command:npm test");
  assert.equal(isQuietRead(hostGate("cat src/example.ts")), true);
  for (const tool of [marker, "invented command"]) {
    const displayOnly = { ...hostGate("cat src/example.ts"), tool, base: undefined };
    assert.deepEqual(decision(analyze(displayOnly)), asks);
    assert.equal(kindOf(displayOnly), null);
    assert.equal(isQuietRead(displayOnly), false);
  }
});

test("untrusted metadata, titles and variants cannot supply command authority", () => {
  for (const agent of ["invented", "acp"]) {
    for (const command of ["npm test", null, { command: "npm test" }, ["npm", 1]]) {
      const params = { base: marker, agent: "grok", _meta: { base: marker }, toolCall: {
        kind: "execute", base: marker, title: "cat src/example.ts", _meta: { base: marker },
        rawInput: { command, base: marker, variant: "ReadFile", agent: "grok", _meta: { base: marker } },
      } };
      const req = permissionGate(agent, params, "forged");
      assert.equal(req.base, undefined);
      assert.deepEqual(decision(analyze(req)), asks);
      assert.equal(isQuietRead(req), false);
    }
  }
  for (const command of [undefined, null, { command: "npm test" }, ["npm", 1], "npm test && rm -rf src", "echo $(npm test)", "npm test > file", "cat /dev/zero"]) {
    const req = permissionGate("grok", { toolCall: { kind: "execute", title: "npm test", rawInput: { command, variant: "ReadFile", base: marker } } }, "malformed");
    assert.deepEqual(decision(analyze(req)), asks);
  }
});

test("non-command normalization and builtin classifications stay unchanged", () => {
  for (const kind of ["read", "search", "other", "edit", "delete", "move", "unknown"]) {
    for (const agent of ["grok", "invented", "acp"]) {
      const req = permissionGate(agent, { base: marker, toolCall: { kind, base: marker, title: "npm test",
        rawInput: { command: "cat src/example.ts", base: marker, variant: "ReadFile", target_file: "src/example.ts" } } }, "kind");
      assert.equal(req.base, undefined);
      const a = analyze(req);
      assert.equal(a.quiet, agent === "grok" && kind === "read");
      if (["edit", "delete", "move"].includes(kind)) assert.equal(a.ask, agent !== "grok");
      else if (agent === "grok" && kind !== "read") assert.deepEqual(decision(a), asks);
    }
  }
  assert.deepEqual(decision(analyze(permissionGate("grok", { title: "npm test", base: marker }, "missing"))), asks);
  for (const tool of ["Bash", "codex command", "agy command", "grok command"]) {
    assert.deepEqual(analyze({ tool, input: { command: "npm test" } }), analyze({ tool: "grok command", input: { command: "npm test" } }));
    assert.equal(isQuietRead({ tool, input: { command: "cat src/example.ts" } }), true);
  }
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "codex fileChange", "agy fileChange", "grok fileChange"]) {
    assert.equal(kindOf({ tool, input: {} })?.key, "edit");
  }
  for (const [variant, kind, path] of [["ReadFile", "read", "target_file"], ["ListDir", "other", "target_directory"], ["Grep", "search", "path"]]) {
    const req = permissionGate("grok", { toolCall: { kind, rawInput: { variant, [path]: "src" } } }, "read");
    assert.deepEqual(analyze(req), { ask: false, quiet: true, kinds: [] });
    assert.deepEqual(decision(analyze({ ...req, input: { ...req.input, kind: "execute" } })), asks);
    assert.deepEqual(decision(analyze({ ...req, input: { ...req.input, input: { variant, [path]: "/dev/zero" } } })), asks);
  }
});

test("contract: real Allows helpers retain Controller/Runner keys and scope matching", () => {
  // ENOENT only; turn/Spec rules never save a project approval file.
  const allows = new Allows(`/invented-missing-${process.pid}/allows.json`);
  const controller = { project: "invented-project", turn: "T-one" };
  const runner = { ...controller, spec: "S-one" };
  const c = kindOf(hostGate("npm test")), r = kindOf({ ...hostGate("npm test"), spec: runner.spec });
  assert.ok(c); assert.ok(r);
  assert.equal(c.key, "command:npm test"); assert.equal(r.key, "runner:command:npm test");
  assert.deepEqual(analyze({ ...hostGate("npm test"), spec: runner.spec }).kinds, [r]);
  assert.deepEqual(scopesFor(c, controller), ["turn", "project"]);
  assert.deepEqual(scopesFor(r, runner), ["spec", "project"]);
  assert.deepEqual(scopesFor(c, { project: null, turn: "T-home" }), ["turn"]);
  const cr = allows.add("turn", c, controller), rr = allows.add("spec", r, runner);
  assert.deepEqual(allows.match(c, controller), cr);
  assert.deepEqual(allows.match(r, runner), rr);
  assert.equal(allows.match(c, { ...controller, turn: "T-other" }), null);
  assert.equal(allows.match(r, { ...runner, spec: "S-other" }), null);
  assert.equal(allows.match(r, controller), null);
  assert.equal(allows.match(r, { ...controller, turn: "T-other", spec: runner.spec })?.id, rr.id);
  assert.throws(() => allows.add("turn", r, runner), /per Spec/);
  assert.throws(() => allows.add("spec", c, controller), /not from a Spec/);
  allows.endTurn(controller.turn, (spec) => spec === runner.spec);
  assert.equal(allows.match(c, controller), null);
  assert.equal(allows.match(r, runner)?.id, rr.id);
  allows.endSpec(runner.spec);
  assert.equal(allows.match(r, runner), null);
});

test("contract: existing project rules match only their project and Controller/Runner key", async () => {
  const allowsUrl = new URL("../src/allows.ts?acp-command-project-rules", import.meta.url).href;
  const rules = [
    { id: "R-1", scope: "project", key: "command:npm test", project: "invented-controller", label: "invented", created: "2026-01-01" },
    { id: "R-2", scope: "project", key: "runner:command:npm test", project: "invented-runner", label: "invented", created: "2026-01-01" },
  ];
  // Load existing project rules without any persistent file. Writes fail if accidentally reached.
  const fsUrl = moduleUrl(`
    export function readFileSync() { return ${JSON.stringify(JSON.stringify(rules))}; }
    const unexpected = () => { throw new Error('unexpected approval file operation'); };
    export { unexpected as existsSync, unexpected as mkdirSync, unexpected as renameSync, unexpected as writeFileSync };
  `);
  let interceptions = 0;
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === allowsUrl && specifier === "node:fs") {
      interceptions++;
      return { url: fsUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  try {
    const isolated = await import(allowsUrl) as typeof import("../src/allows.ts");
    const allows = new isolated.Allows("/invented/approvals.json");
    const c = kindOf(hostGate("npm test")), r = kindOf({ ...hostGate("npm test"), spec: "S-one" });
    assert.ok(c); assert.ok(r);
    const ctx = { project: "invented-controller", turn: "T-one" };
    assert.equal(allows.match(c, ctx)?.id, "R-1");
    assert.equal(allows.match(c, { ...ctx, turn: "T-other" })?.id, "R-1");
    assert.equal(allows.match(r, { ...ctx, spec: "S-one" }), null);
    const runner = { ...ctx, project: "invented-runner", spec: "S-one" };
    assert.equal(allows.match(r, runner)?.id, "R-2");
    assert.equal(allows.match(r, { ...runner, spec: "S-other" })?.id, "R-2");
    assert.equal(allows.match(c, runner), null);
    assert.equal(allows.match(r, { ...runner, project: "invented-other" }), null);
    assert.equal(allows.match(c, { ...ctx, project: null }), null);
    assert.equal(interceptions, 1);
  } finally { loader.deregister(); }
  assert.notEqual((await import("../src/allows.ts")).Allows, (await import(allowsUrl)).Allows);
  assert.equal(interceptions, 1);
});

test("strict allow_once, rejection and ambiguous option handling stay unchanged", () => {
  assert.deepEqual(pickOption([...options, { optionId: "always", kind: "allow_always" }], "allow"), { outcome: { outcome: "selected", optionId: "once" } });
  assert.deepEqual(pickOption(options, "deny"), denied);
  assert.deepEqual(pickOption([{ optionId: "always", kind: "allow_always" }, options[1]], "allow"), denied);
  assert.deepEqual(pickOption([{ optionId: "no-always", kind: "reject_always" }], "allow"), { outcome: { outcome: "selected", optionId: "no-always" } });
  for (const offered of [undefined, [], [{ optionId: "always", kind: "allow_always" }], [options[0], { ...options[1], optionId: "once" }], [{ optionId: "", kind: "allow_once" }]]) {
    assert.deepEqual(pickOption(offered, "allow"), { outcome: { outcome: "cancelled" } });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Grok ACP session admission, Gate cap and late cancellation retain strict outcomes", async () => {
  const prompting = deferred<void>(), prompt = deferred<unknown>(), answer = deferred<"allow" | "deny">();
  const controller = new AbortController(), gates: GateRequest[] = [], notices: string[] = [];
  let ask!: (method: string, params: unknown) => Promise<unknown>;
  const rpc: AcpRpc = {
    async request(method) {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new") return { sessionId: "invented-session" };
      assert.equal(method, "session/prompt"); prompting.resolve(); return prompt.promise;
    },
    notify(method) { notices.push(method); }, onRequest(f) { ask = f; }, onNotify() {}, close() { assert.fail("no transport close needed"); },
    closed: deferred<number | null>().promise, exited: deferred<string>().promise,
  };
  const hooks: TurnHooks = { text() {}, tool() {}, done() {}, gate(req) { gates.push(req); return gates.length === 1 ? Promise.resolve("allow") : answer.promise; } };
  const running = runAcpTurn({ rpc, hooks, agent: "grok", cwd: "/invented/work", prompt: "invented", signal: controller.signal, maxGates: 2 });
  const params = { ...paramsFor("npm test"), sessionId: "invented-session", options };
  assert.deepEqual(await ask("session/request_permission", params), denied);
  await prompting.promise;
  assert.deepEqual(await ask("session/request_permission", { ...params, sessionId: "foreign" }), denied);
  assert.equal(gates.length, 0);
  assert.deepEqual(await ask("session/request_permission", params), { outcome: { outcome: "selected", optionId: "once" } });
  assert.equal(gates[0].base, marker);
  assert.equal(analyze(gates[0]).kinds[0]?.key, "command:npm test");
  const late = ask("session/request_permission", params);
  assert.equal(gates.length, 2);
  assert.deepEqual(await ask("session/request_permission", params), denied);
  assert.equal(gates.length, 2);
  controller.abort("invented stop");
  answer.resolve("allow");
  assert.deepEqual(await late, denied);
  prompt.resolve({ stopReason: "cancelled" });
  assert.equal((await running).ok, false);
  assert.deepEqual(notices, ["session/cancel"]);
  assert.deepEqual(await ask("session/request_permission", params), denied);
});

test("contract: actual Runner hook preserves authored base without promoting the reserved display", async (t) => {
  // Query isolates this delegate module from the ordinary module cache. Only its two direct
  // imports are intercepted; no source rewriting, global mocks or copied decoration formula.
  const delegateUrl = new URL("../src/delegate.ts?acp-command-mapping", import.meta.url).href;
  const workspaceUrl = moduleUrl(`
    export const calls = [];
    export function hasCommit() { calls.push('hasCommit'); return true; }
    export function specPaths() { return { root: '/invented/state', work: '/invented/work', gitDir: '/invented/git' }; }
    export function createWorkspace() { calls.push('createWorkspace'); return { left: [], skipped: [] }; }
    export function snapshot(_paths, label) { calls.push(label); return label; }
    export function changedFiles() { calls.push('changedFiles'); return []; }
    const unexpected = () => { throw new Error('unexpected workspace operation'); };
    export { unexpected as applyToProject, unexpected as diff, unexpected as removeWorkspace, unexpected as safeTarget };
  `);
  const driverUrl = moduleUrl(`
    export let requests = [];
    export const answers = [];
    export function setRequests(value) { requests = value; }
    export async function runGrokTurn(o) {
      for (const req of requests) answers.push(await o.hooks.gate(req));
      o.hooks.done({ ok: true, summary: 'invented in-memory completion' });
    }
  `);
  const intercepted: string[] = [];
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === delegateUrl && ["./specstore.ts", "./grok.ts"].includes(specifier)) {
      intercepted.push(specifier);
      return { url: specifier === "./specstore.ts" ? workspaceUrl : driverUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  const ledger = new Ledger(":memory:");
  try {
    const { resumeSpec, SpecRuns } = await import(delegateUrl) as typeof import("../src/delegate.ts");
    const driver = await import(driverUrl), workspace = await import(workspaceUrl);
    assert.deepEqual(intercepted.sort(), ["./grok.ts", "./specstore.ts"]);
    const displayGate = (command: string): GateRequest => ({ id: "display-only", tool: marker,
      input: { command }, canonical: canonical({ tool: marker, input: { command } }) });
    const cases: Array<{ name: string; req: GateRequest; base: string | undefined; command: string; ask: boolean }> = [];
    for (const command of ["npm test", "cat src/example.ts", "npm test && rm -rf src"]) {
      const dangerous = command.includes("rm -rf");
      cases.push(
        { name: `host base: ${command}`, req: hostGate(command), base: marker, command, ask: dangerous },
        { name: `Grok execute: ${command}`, req: permissionGate("grok", paramsFor(command), "grok"), base: marker, command, ask: dangerous },
        { name: `invented acp execute: ${command}`, req: permissionGate("acp", paramsFor(command), "acp"), base: undefined, command, ask: true },
        { name: `reserved display without base: ${command}`, req: displayGate(command), base: undefined, command, ask: true },
      );
    }
    cases.push(
      { name: "reserved display with undefined base", req: { ...displayGate("cat src/example.ts"), base: undefined }, base: undefined, command: "cat src/example.ts", ask: true },
      // Exercise the nullish runtime boundary even though typed adapters omit absent bases.
      { name: "reserved display with null base", req: { ...displayGate("cat src/example.ts"), base: null } as unknown as GateRequest, base: undefined, command: "cat src/example.ts", ask: true },
      { name: "explicit marker base with marker display", req: { ...displayGate("npm test"), base: marker }, base: marker, command: "npm test", ask: false },
      { name: "explicit empty base", req: { ...displayGate("npm test"), base: "" }, base: "", command: "npm test", ask: true },
      { name: "explicit unrelated base", req: { ...displayGate("npm test"), base: "invented base" }, base: "invented base", command: "npm test", ask: true },
      { name: "unrelated agent display fallback", req: permissionGate("invented", paramsFor("npm test"), "unknown"), base: "invented command", command: "npm test", ask: true },
    );
    for (const tool of ["Bash", "codex command", "agy command", "grok command"]) {
      for (const command of ["npm test", "cat src/example.ts"]) {
        const input = { command };
        cases.push({ name: `legacy fallback ${tool}: ${command}`, req: { id: "legacy", tool, input, canonical: canonical({ tool, input }) },
          base: tool, command, ask: false });
      }
    }
    cases.push({ name: "legacy fallback with null base", req: { id: "legacy-null", tool: "Bash", base: null,
      input: { command: "npm test" }, canonical: canonical({ tool: "Bash", input: { command: "npm test" } }) } as unknown as GateRequest,
      base: "Bash", command: "npm test", ask: false });
    const requests = cases.map(({ req }) => ({ ...req, actor: "forged actor", spec: "forged spec" }));
    driver.setRequests(requests);
    const runs = new SpecRuns(), seen: GateRequest[] = [], completed = deferred<void>();
    const ctx: DelegationContext = {
      project: { name: "invented-project", path: "/invented/project" }, ledger, runs, limits: new LimitGate(),
      usage: { grok: { provider: "grok", async read() { return { provider: "grok", measuredAt: Date.now(), readings: [{ window: "invented", usedPercent: 0, resetsAt: null }] }; } } },
      runtimeDir: "/invented/runtime", supervisor: "/invented/supervisor", policyDir: "/invented/policy", stateDir: "/invented/state",
      async gate(req) { seen.push(req); return "deny"; }, notify() {}, onSpecDone() { completed.resolve(); },
    };
    const created = ledger.createSpec(ctx.project.name, SpecInput.parse({ to: "grok", brief: "invented brief", result: "invented result",
      reason: "invented reason", scope: { read: [], write: [] } }), "controller");
    const spec = ledger.updateSpec(created.id, { status: "held", limited: { at: "2026-01-01T00:00:00Z", resetsAt: null, why: "invented hold" } }, "govd");
    await resumeSpec(ctx, spec, "user");
    await completed.promise;
    assert.equal(runs.count(), 0);
    assert.equal(ledger.spec(spec.id)?.status, "needs-review");
    assert.deepEqual(workspace.calls, ["hasCommit", "createWorkspace", "before", "after", "changedFiles"]);
    assert.deepEqual(driver.answers, requests.map(() => "deny"));
    assert.equal(seen.length, requests.length);
    for (let i = 0; i < seen.length; i++) {
      await t.test(cases[i].name, () => {
        const actual = seen[i], original = requests[i], expected = cases[i];
        assert.equal(actual.tool, `${original.tool} (Runner · grok, ${spec.id})`);
        assert.equal(actual.input, original.input);
        assert.equal(actual.canonical, original.canonical);
        assert.equal(actual.id, original.id);
        assert.equal(actual.actor, `runner · grok · ${spec.id}`);
        assert.equal(actual.spec, spec.id);
        if (expected.ask) {
          assert.deepEqual(decision(analyze(actual)), asks);
          assert.equal(kindOf(actual), null);
          assert.equal(isQuietRead(actual), false);
        } else {
          const legacy = { tool: "grok command", input: { command: expected.command } };
          assert.deepEqual(analyze(actual), analyze({ ...legacy, spec: spec.id }));
          assert.deepEqual(kindOf(actual), kindOf({ ...legacy, spec: spec.id }));
          assert.equal(isQuietRead(actual), isQuietRead(legacy));
          if (expected.command === "npm test") {
            assert.equal(kindOf(legacy)?.key, "command:npm test");
            assert.equal(kindOf(actual)?.key, "runner:command:npm test");
          }
        }
        assert.equal(actual.base, expected.base);
      });
    }
  } finally {
    loader.deregister();
    ledger.close();
  }
  // Normal imports remain separate after deregistration; neither production function is run.
  const ordinary = await import("../src/delegate.ts"), isolated = await import(delegateUrl);
  assert.notEqual(ordinary.resumeSpec, isolated.resumeSpec);
  const ordinaryWorkspace = await import("../src/specstore.ts"), stubWorkspace = await import(workspaceUrl);
  assert.notEqual(ordinaryWorkspace.snapshot, stubWorkspace.snapshot);
  assert.equal(intercepted.length, 2);
});
