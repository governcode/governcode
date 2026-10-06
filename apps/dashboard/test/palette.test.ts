import { test } from "node:test";
import assert from "node:assert/strict";
import { filterItems, initialSelection, moveSelection, selected } from "../src/shared/palette.ts";

const items = [
  { id: "allow:G-1", label: "Allow G-1 once", detail: "app · Bash · npm test", answer: true },
  { id: "deny:G-1", label: "Deny G-1", detail: "app · Bash · npm test", answer: true },
  { id: "allow:G-2", label: "Allow G-2 once", detail: "app · Bash · cargo bench", answer: true },
  { id: "deny:G-2", label: "Deny G-2", detail: "app · Bash · cargo bench", answer: true },
  { id: "go:Overview", label: "Overview" },
  { id: "p:app:specs", label: "app · Specs", hidden: true },
];

test("the palette never starts on an answer, so Ctrl K then Enter answers nothing", () => {
  assert.equal(initialSelection(filterItems(items, "")), "go:Overview");
  assert.equal(initialSelection(filterItems(items, "allow")), null, "only answers match: nothing is highlighted until you move");
});

test("search: every word must match; hidden items appear only when searched for", () => {
  assert.deepEqual(filterItems(items, "deny cargo").map((i) => i.id), ["deny:G-2"]);
  assert.equal(filterItems(items, "").some((i) => i.id === "p:app:specs"), false);
  assert.equal(filterItems(items, "specs").some((i) => i.id === "p:app:specs"), true);
});

test("the highlight is an item: when the list changes it stays on that item, or on nothing", () => {
  const shown = filterItems(items, "");
  const chosen = moveSelection(shown, moveSelection(shown, "go:Overview", -1), -1);
  assert.equal(chosen, "allow:G-2");
  // G-1 is answered elsewhere: the list shrinks, the choice is still G-2, never whatever took its place.
  const after = shown.filter((i) => !i.id.endsWith("G-1"));
  assert.equal(selected(after, chosen)?.id, "allow:G-2");
  // G-2 itself goes away: Enter runs nothing.
  assert.equal(selected(after.filter((i) => !i.id.endsWith("G-2")), chosen), null);
});

test("moving: clamps at the ends, and from nothing starts at the top or the bottom", () => {
  const shown = filterItems(items, "");
  assert.equal(moveSelection(shown, null, 1), "allow:G-1");
  assert.equal(moveSelection(shown, null, -1), "go:Overview");
  assert.equal(moveSelection(shown, "go:Overview", 1), "go:Overview");
  assert.equal(moveSelection([], null, 1), null);
});
