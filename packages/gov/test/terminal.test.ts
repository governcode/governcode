import { test } from "node:test";
import assert from "node:assert/strict";
import { hiddenCount, jsonShown, markCodes, oneLine, shown } from "../src/terminal.ts";

test("terminal text shows ESC, OSC clipboard/title/link sequences and cursor moves", () => {
  for (const [text, expected] of [
    ["\x1b", "\\x1b"],
    ["\x1b]52;c;c2VjcmV0\x07", "\\x1b]52;c;c2VjcmV0\\x07"],
    ["\x1b]0;owned\x07", "\\x1b]0;owned\\x07"],
    ["\x1b]8;;https://example.org\x1b\\link\x1b]8;;\x1b\\", "\\x1b]8;;https://example.org\\x1b\\link\\x1b]8;;\\x1b\\"],
    ["\x1b[2J\x1b[1;1H", "\\x1b[2J\\x1b[1;1H"],
    ["\x9b2J", "\\x9b2J"],
  ]) {
    assert.equal(shown(text), expected);
    assert.equal(oneLine(text), expected);
  }
});

test("every C0, DEL and C1 control stays visible except multi-line tabs and newlines", () => {
  for (const code of [...Array(32).keys(), ...Array.from({ length: 33 }, (_, i) => i + 0x7f)]) {
    const char = String.fromCodePoint(code), escaped = `\\x${code.toString(16).padStart(2, "0")}`;
    assert.equal(oneLine(char), escaped);
    assert.equal(shown(char), code === 9 || code === 10 ? char : escaped);
  }
  assert.equal(shown("one\n\ttwo\rthree"), "one\n\ttwo\\x0dthree");
  assert.equal(oneLine("one\n\ttwo\rthree"), "one\\x0a\\x09two\\x0dthree");
});

test("bidi and zero-width controls cannot reorder or hide terminal text", () => {
  const codes = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  for (const code of codes) {
    const text = `before${String.fromCodePoint(code)}after`, expected = `before\\u${code.toString(16)}after`;
    assert.equal(shown(text), expected);
    assert.equal(oneLine(text), expected);
  }
});

test("ordinary Unicode and literal backslash escapes pass through unchanged", () => {
  const text = "café, 中文, 日本語, 😀 🚀; literal \\x1b and \\u202e";
  assert.equal(shown(text), text);
  assert.equal(oneLine(text), text);
  assert.equal(shown(""), "");
  assert.equal(oneLine(""), "");
});

test("JSON output escapes the controls JSON.stringify leaves raw without changing parsed data", () => {
  const value = { text: "\x1b\x07\x7f\x9b\u202e\u200b café 中文 😀\n\t" };
  const json = JSON.stringify(value), safe = jsonShown(json);
  assert.ok(json.includes("\x9b"), "JSON.stringify alone leaves C1 controls raw");
  assert.doesNotMatch(safe, /[\x00-\x1f\x7f-\x9f\u202e\u200b]/);
  assert.ok(safe.includes("\\u009b\\u202e\\u200b café 中文 😀"));
  assert.deepEqual(JSON.parse(safe), value);
  assert.deepEqual(JSON.parse(jsonShown(JSON.stringify(value, null, 2))), value);
  assert.equal(jsonShown('{"text":"café 中文 😀"}'), '{"text":"café 中文 😀"}');
});

test("every character a terminal hides or that moves text is shown: separators, Arabic mark, soft hyphen, tags, fillers, selectors", () => {
  const cases: Array<[string, string]> = [["\u2028", "\\u2028"], ["\u2029", "\\u2029"], ["؜", "\\u061c"], ["\u00ad", "\\xad"], ["᠎", "\\u180e"],
    ["⁡", "\\u2061"], ["⁯", "\\u206f"], ["͏", "\\u034f"], ["￹", "\\ufff9"], ["ᅟ", "\\u115f"], ["ㅤ", "\\u3164"],
    ["\u{e0041}", "\\u{e0041}"], ["\u{e0100}", "\\u{e0100}"], ["︁", "\\ufe01"]];
  for (const [char, code] of cases) { assert.equal(oneLine(`a${char}b`), `a${code}b`, code); assert.equal(shown(`a${char}b`), `a${code}b`, code); }
  assert.equal(shown("café 中文 😀 ❤️ ́e"), "café 中文 😀 ❤️ ́e", "ordinary text, an emoji's own selector and combining marks pass");
  assert.equal(hiddenCount("a\nb\tc\u2028d\u{e0041}"), 2);
  markCodes(true);
  try { assert.equal(oneLine("a\u2028b"), "a\x1b[7m\\u2028\x1b[27mb", "marked on a terminal, so it cannot be mistaken for typed text"); }
  finally { markCodes(false); }
  const json = JSON.stringify({ t: "x\u2028\u{e0041}\u00ad" });
  assert.deepEqual(JSON.parse(jsonShown(json)), { t: "x\u2028\u{e0041}\u00ad" });
  assert.doesNotMatch(jsonShown(json), new RegExp("[\\u2028\\u00ad\\u{e0041}]", "u"));
});
