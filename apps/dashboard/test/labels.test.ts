// How models, efforts and Controllers read on screen: no empty segment, no "n/a".
import { test } from "node:test";
import assert from "node:assert/strict";
import { controllerLabel, dotted, modelLabel } from "../src/shared/labels.ts";

test("an empty model is the default one, and a missing effort is left out", () => {
  assert.equal(modelLabel("", null), "default model");
  assert.equal(modelLabel("  ", "low"), "default model · low");
  assert.equal(modelLabel("qwen3.5:9b", null), "qwen3.5:9b");
  assert.equal(modelLabel("opus", "high"), "opus · high");
  assert.equal(controllerLabel({ provider: "claude-code", model: "opus", effort: null }), "claude-code · opus");
  assert.equal(controllerLabel({ provider: "codex", model: "gpt-5.5", effort: "medium" }), "codex · gpt-5.5 · medium");
});

test("a line never shows an empty segment between separators", () => {
  assert.equal(dotted("tidepool-live", "", null, undefined, false, "2 files"), "tidepool-live · 2 files");
  assert.equal(dotted("a", " ", "b"), "a · b");
  assert.equal(dotted(), "");
  assert.ok(!/·\s*·/.test(dotted("p", modelLabel("", null), "1 file")));
});
