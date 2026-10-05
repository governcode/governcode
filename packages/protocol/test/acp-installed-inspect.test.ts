import { test } from "node:test";
import assert from "node:assert/strict";
import { Params } from "../src/index.ts";

const schema = Params["acp.installed.inspect"];
const fingerprint = "0123456789abcdef".repeat(4);

test("installed inspection accepts lowercase fingerprints unchanged, including all zeroes", () => {
  for (const id of [fingerprint, "0".repeat(64), "a".repeat(64), "f".repeat(64)])
    assert.deepEqual(schema.parse({ id }), { id });
});

test("installed inspection requires an object with an id", () => {
  for (const params of [undefined, null, {}, fingerprint, 0, false, [], [fingerprint], [{ id: fingerprint }]])
    assert.equal(schema.safeParse(params).success, false);
});

test("installed inspection refuses nonstring ids without coercion", () => {
  for (const id of [undefined, null, 0, 123, true, false, {}, [], [fingerprint]])
    assert.equal(schema.safeParse({ id }).success, false);
});

test("installed inspection refuses uppercase, nonhex, and wrong length ids", () => {
  for (const id of [fingerprint.toUpperCase(), "A" + fingerprint.slice(1), "g".repeat(64),
    "", "a".repeat(40), "a".repeat(63), "a".repeat(65)])
    assert.equal(schema.safeParse({ id }).success, false, JSON.stringify(id));
});

test("installed inspection refuses whitespace without trimming or suffix normalization", () => {
  for (const id of [" " + fingerprint, fingerprint + " ", " " + fingerprint.slice(1),
    fingerprint.slice(0, 63) + " ", fingerprint + "\n", fingerprint + "\r", fingerprint + "\r\n",
    fingerprint + "\u2028", fingerprint + "\u2029", fingerprint.slice(0, 63) + "\n"])
    assert.equal(schema.safeParse({ id }).success, false, JSON.stringify(id));
});

test("installed inspection refuses registry agent ids and installation operation ids", () => {
  for (const id of ["fixture-agent", "codex", "I-1", "I-1234567890123456", "I-N"])
    assert.equal(schema.safeParse({ id }).success, false, id);
});

test("installed inspection refuses every extra field instead of stripping it", () => {
  const fields = ["limit", "query", "platform", "kind", "refresh", "fingerprint", "agentId", "operation",
    "source", "sha256", "root", "plan", "receipt", "inspection", "command", "args", "env", "cwd",
    "execute", "probe", "launch", "authority", "options", "extra", "__proto__"];
  for (const field of fields) {
    for (const value of [undefined, null, false, "fixture", [], {}])
      assert.equal(schema.safeParse({ id: fingerprint, [field]: value }).success, false, field);
  }
  assert.equal(schema.safeParse({ id: fingerprint, ...Object.fromEntries(fields.map(field => [field, true])) }).success, false);
});
