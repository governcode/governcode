// Finite fake-stream enforcement in a worker whose parent owns the wall watchdog.
import assert from "node:assert/strict";
import { fixture } from "./acp-output-budget.ts";
const f = fixture(256);
let exited = false, closed = false;
void f.rpc.exited.then(() => { exited = true; });
void f.rpc.closed.then(() => { closed = true; });
const pending = f.rpc.request("fixture", {}, 30_000);
const rejected = assert.rejects(pending, (error) => error === f.rpc.outputBudget!.failure);
for (let i = 0; i < 20; i++) f.out(Buffer.alloc(64, 120));
await rejected;
assert.ok(f.rpc.outputBudget!.failure);
assert.equal(exited, false); assert.equal(closed, false);
assert.equal(f.signals.length, 1);
f.finish(); await f.rpc.closed;
process.stdout.write("fixture-enforced\n");
