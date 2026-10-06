// JSON lines, the way GovernCode's processes talk (govd, gov, the Dashboard, and the AI tools'
// stream output). A line ends at "\n" and nowhere else. Node's readline also ends a line at U+2028
// and U+2029, which JSON leaves raw inside strings, so one message with such a character in it was
// read as broken pieces (a review on 2026-10-06 crashed `gov` that way). Writers escape the two as
// well, so an older reader stays whole too. Node only: the Dashboard's renderer does not import it.
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

const SEPARATORS = new RegExp("[\\u2028\\u2029]", "g");   // (from a string: Node's TypeScript stripping can write these raw in a literal)

/** One JSON message as a line: U+2028 and U+2029 escaped (still the same JSON), then "\n". */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(SEPARATORS, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029")) + "\n";
}

/** Lines from a stream, split at "\n" only (a "\r" before it is dropped): emits "line" for each and
 *  "close" once when the stream ends, like readline's interface, which it replaces here. */
export function jsonLines(input: NodeJS.ReadableStream): EventEmitter {
  const out = new EventEmitter();
  const decoder = new StringDecoder("utf8");
  let buf = "", closed = false;
  const emit = (line: string) => out.emit("line", line.endsWith("\r") ? line.slice(0, -1) : line);
  input.on("data", (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (let k; (k = buf.indexOf("\n")) >= 0;) { const line = buf.slice(0, k); buf = buf.slice(k + 1); emit(line); }
  });
  const close = () => {
    if (closed) return;
    closed = true;
    buf += decoder.end();
    if (buf) emit(buf);
    buf = "";
    out.emit("close");
  };
  input.on("end", close);
  input.on("close", close);
  input.on("error", () => {});   // (the stream's own error handler reports it; here it only ends the lines)
  return out;
}
