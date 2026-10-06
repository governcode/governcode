import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withMcpRead, type Policy } from "../src/claude.ts";

// The other tests run the AI tools under a stand-in govern-sup, so they never saw the MCP server
// fail to load inside the real sandbox (an import it could not read: "Connection closed" for the
// Controller, no delegation). This one starts it under the real govern-sup with the read rules
// govd gives it. Skipped where govern-sup is not built or this kernel cannot run the sandbox.
const sup = fileURLToPath(new URL("../../../target/release/govern-sup", import.meta.url));
const script = fileURLToPath(new URL("../src/mcp-controller.ts", import.meta.url));
const usable = existsSync(sup) && spawnSync(sup, ["selftest"], { stdio: "ignore" }).status === 0;

test("the Controller's MCP server starts inside the real sandbox and reaches its socket", { skip: !usable && "govern-sup not built, or no sandbox on this kernel" }, async () => {
  const t = mkdtempSync(join(tmpdir(), "gc-mcp-"));
  const socket = join(t, "turn.sock");
  const server = createServer((c) => c.end());
  await new Promise<void>((ok) => server.listen(socket, ok));
  try {
    const node = process.execPath;
    const base: Policy = { version: 1, read: ["/usr", "/etc", "/lib", "/lib64", "/proc", "/dev/zero", "/dev/urandom", "/dev/random"].filter(existsSync),
      write: ["/dev/null"], exec: ["/usr/bin", "/bin", "/usr/lib", dirname(node)], tcp_connect: [], unix_connect: [socket], cwd: "/usr" };
    const policy = withMcpRead(base, { node, script, socket });
    writeFileSync(join(t, "policy.json"), JSON.stringify(policy));
    const child = spawn(sup, ["run", "--policy", join(t, "policy.json"), "--", node, script, socket], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { err += b; });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise((ok) => child.on("close", ok));
    assert.doesNotMatch(err, /ERR_MODULE_NOT_FOUND|Cannot find module|EACCES/, err);
    assert.match(out, /"serverInfo":\{"name":"governcode"/, err);
  } finally {
    server.close();
    rmSync(t, { recursive: true, force: true });
  }
});
