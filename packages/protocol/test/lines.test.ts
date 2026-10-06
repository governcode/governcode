// JSON lines: split at "\n" only, so a message with U+2028 or U+2029 in it stays one message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { jsonLine, jsonLines } from "../src/lines.ts";

const read = (chunks: Array<string | Buffer>) => new Promise<string[]>((ok) => {
  const input = new PassThrough(), lines: string[] = [];
  const out = jsonLines(input);
  out.on("line", (l: string) => lines.push(l));
  out.on("close", () => ok(lines));
  for (const c of chunks) input.write(c);
  input.end();
});

test("a message with the Unicode line and paragraph separators is one line, written and read", async () => {
  const value = { text: "a b c", n: 1 };
  const line = jsonLine(value);
  assert.ok(!line.includes(" ") && !line.includes(" "), "escaped when written");
  assert.deepEqual(JSON.parse(line), value);
  // From a writer that leaves them raw (an older govd, an AI tool's own JSON): still one message.
  const raw = JSON.stringify(value) + "\n";
  assert.deepEqual((await read([raw])).map((l) => JSON.parse(l)), [value]);
  // (readline, which this replaces, splits it into three broken pieces.)
  const pieces = await new Promise<number>((ok) => { const n: string[] = []; const rl = createInterface({ input: PassThrough.from([raw]) as any });
    rl.on("line", (l) => n.push(l)); rl.on("close", () => ok(n.length)); });
  assert.equal(pieces, 3);
});

test("lines split at \\n only; \\r\\n, chunks cut mid-character and a last line without \\n all come out whole", async () => {
  const bytes = Buffer.from("é中😀", "utf8");
  assert.deepEqual(await read(["one\r\ntwo\n", bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5), "\nlast"]), ["one", "two", "é中😀", "last"]);
  assert.deepEqual(await read([]), []);
});
