// User socket discovery with an invented catalog and fake transport. No provider process runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { AcpCatalog } from "../src/acp-catalog.ts";
import { scratch } from "./scratch.ts";

test("user ACP discovery preserves catalog provenance and cannot enable a registry agent", async () => {
  const root = scratch("acp-discovery-");
  const socketPath = join(root, "run/govd.sock");
  const d = new Daemon({ socketPath, ledgerPath: join(root, "state/trace.sqlite"), policyDir: join(root, "state/policies"),
    homeDir: join(root, "state/home"), supervisor: "/nonexistent-supervisor", version: "test" });
  let fetches = 0;
  const document = JSON.stringify({ version: "1.0.0", agents: [{ id: "fixture-agent", name: "Fixture Agent", version: "1.2.3",
    description: "Invented catalog fixture", license_url: "https://example.org/LICENSE",
    distribution: { npx: { package: "fixture-agent@1.2.3", args: Array(64).fill("acp") } } }] });
  // Transport injection remains test-local; production uses only the fixed official URL.
  (d as any).catalog = new AcpCatalog(async () => { fetches++; return new Response(document); });
  await d.listen();
  const socket = connect(socketPath);
  const waiting = new Map<number, (message: any) => void>();
  let seq = 0;
  createInterface({ input: socket }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message); waiting.delete(message.id);
  });
  const call = (method: string, params: unknown) => new Promise<any>((ok) => {
    const id = ++seq; waiting.set(id, ok);
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const bad = await call("acp.inspect", { id: "fixture-agent", platform: "linux-arm64" });
    assert.ok(bad.error); assert.equal(fetches, 0);
    const search = await call("acp.search", { query: "FIXTURE" });
    assert.deepEqual(search.result.agents.map((a: any) => a.id), ["fixture-agent"]);
    assert.equal(search.result.total, 1);
    assert.match(search.result.catalog.sha256, /^[a-f0-9]{64}$/);
    const inspected = await call("acp.inspect", { id: "fixture-agent", platform: "linux-x86_64" });
    assert.deepEqual(inspected.result.catalog, search.result.catalog);
    assert.equal(inspected.result.installation.plan.packageSpec, "fixture-agent@1.2.3");
    assert.equal(inspected.result.installation.plan.command.length, 66);
    assert.match(inspected.result.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(inspected.result.executor.supported, false, "package recipes remain inspectable without enabling their installer");
    assert.equal(inspected.result.eligibility.eligible, false);
    assert.match(inspected.result.eligibility.reasons.join(" "), /No safety profile/);
    assert.equal(fetches, 1, "search and inspection reuse the same bounded snapshot");
    await call("acp.search", { refresh: true });
    assert.equal(fetches, 2);
    assert.ok((await call("acp.inspect", { id: "missing-agent" })).error);
    assert.ok((await call("acp.install", { id: "fixture-agent" })).error);
    assert.ok((await call("settings.set", { runners: { "fixture-agent": { model: "m" } } })).error);
    assert.equal(d.ledger.specs().length, 0);
  } finally { socket.destroy(); await d.close(); }
});
