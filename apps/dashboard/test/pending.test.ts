import { test } from "node:test";
import assert from "node:assert/strict";
import { hasActiveAsk } from "../src/shared/pending.ts";

test("a synchronous pending reservation blocks another send on the thread", () => {
  const asks = new Map<string, string>();
  assert.equal(hasActiveAsk(asks, "project-a"), false);
  asks.set("a1", "project-a");
  assert.equal(hasActiveAsk(asks, "project-a"), true);
  assert.equal(hasActiveAsk(asks, "project-b"), false);
});

test("finishing one ask leaves its thread busy while another ask is pending", () => {
  const asks = new Map([["a1", "project-a"], ["a2", "project-a"]]);
  asks.delete("a1");
  assert.equal(hasActiveAsk(asks, "project-a"), true);
  asks.delete("a2");
  assert.equal(hasActiveAsk(asks, "project-a"), false);
});
