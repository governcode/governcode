#!/usr/bin/env node
// The Controller's GovernCode tools, as an MCP server over stdio. Claude Code starts this
// INSIDE its own sandbox; the only thing it can reach is the per-turn socket govd opened for
// this turn (listed in the turn's unix_connect, nothing else). That socket offers delegation
// and read-only views, never Gate answers or undo: those stay with the user.
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socketPath = process.argv[2];
if (!socketPath) { process.stderr.write("usage: mcp-controller SOCKET\n"); process.exit(2); }

const TOOLS = [
  { name: "delegate", description: "Hand a bounded job (a Spec) to another AI coding tool (a Runner). GovernCode checks the Runner's usage Limit, runs it in its own git worktree inside a sandbox, records Checkpoints, and returns the result, the changed files and the diff for review. The user sees and approves each delegation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["to", "brief", "result", "scope", "budgetPercent", "model", "reason"], properties: {
      to: { type: "string", description: "Runner provider, e.g. codex" },
      brief: { type: "string", description: "The job" },
      result: { type: "string", description: "Acceptance: what done means" },
      scope: { type: "object", properties: { read: { type: "array", items: { type: "string" } }, write: { type: "array", items: { type: "string" } } }, description: "Paths relative to the project; write paths are the only writable ones" },
      budgetPercent: { type: "number", description: "Share of the Runner's usage window this job may take (a request; GovernCode caps it)" },
      model: { type: "string" }, effort: { type: ["string", "null"], enum: ["low", "medium", "high", "max", null] },
      reason: { type: "string", description: "Why this Runner, shown to the user" } } } },
  { name: "crew", description: "List the Runners GovernCode can delegate to, with their measured usage and whether a Limit holds them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "spec_status", description: "Status, changed files and summary of a Spec.",
    inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
];

let next = 1;
const waiting = new Map<number, (m: any) => void>();
const sock = connect(socketPath);
sock.on("error", (e) => { process.stderr.write(`governcode: ${e.message}\n`); });
const replies = createInterface({ input: sock });
replies.on("error", () => {});
replies.on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); });
const call = (method: string, params: unknown) => new Promise<any>((ok) => {
  const id = next++; waiting.set(id, ok); sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;                         // notifications need no reply
  if (m.method === "initialize") {
    return out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "governcode", version: "0.0.1" } } });
  }
  if (m.method === "tools/list") return out({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  if (m.method === "tools/call") {
    const r = await call(`controller.${m.params?.name}`, m.params?.arguments ?? {});
    const text = r.error ? `GovernCode refused: ${r.error.message}` : JSON.stringify(r.result, null, 1);
    return out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], isError: !!r.error } });
  }
  out({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
});
