// Invented streams only. The invented process id always reaches a fake kill function.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { spawn } from "node:child_process";
import { startAcp, type AcpOutputBudget } from "../../src/acp.ts";

export const options = { supervisor: "fixture-supervisor", policyFile: "fixture-policy", bin: "fixture-agent",
  args: [], env: {}, cwd: "/fixture" };
export function fakeNative() {
  const writes: string[] = [], signals: { pid: number; signal: NodeJS.Signals | number | undefined }[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 123456789,
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } }),
  });
  let spawns = 0;
  const native = {
    spawn: ((..._args: unknown[]) => { spawns++; return child; }) as unknown as typeof spawn,
    kill: ((pid: number, signal?: NodeJS.Signals | number) => { signals.push({ pid, signal }); return true; }) as typeof process.kill,
  };
  return { child, writes, signals, native, get spawns() { return spawns; },
    out: (b: Buffer | string) => child.stdout.emit("data", typeof b === "string" ? Buffer.from(b) : b),
    err: (b: Buffer | string) => child.stderr.emit("data", typeof b === "string" ? Buffer.from(b) : b),
    finish: (code: number | null = 0) => { child.emit("exit", code); child.emit("close", code); },
  };
}
export function fixture(maxBytes?: number) {
  const f = fakeNative();
  const outputBudget: AcpOutputBudget | undefined = maxBytes === undefined ? undefined : { maxBytes };
  const rpc = startAcp(outputBudget === undefined ? options : { ...options, outputBudget }, f.native);
  return { ...f, rpc };
}
export const message = (body: object) => JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n";
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
