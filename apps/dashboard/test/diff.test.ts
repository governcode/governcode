// The review diff parser: counts, line numbers, and side-by-side pairing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, sideBySide } from "../src/shared/diff.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 keep
-old one
-old two
+new one
 tail
diff --git a/tests/new.txt b/tests/new.txt
new file mode 100644
--- /dev/null
+++ b/tests/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

test("parseDiff: files, counts, line numbers, binaries", () => {
  const files = parseDiff(DIFF);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed, f.binary]), [["src/a.ts", 1, 2, false], ["tests/new.txt", 2, 0, false], ["logo.png", 0, 0, true]]);
  const a = files[0].hunks[0].lines;
  assert.deepEqual(a.map((l) => [l.kind, l.old, l.new, l.text]), [
    ["ctx", 1, 1, "keep"], ["del", 2, null, "old one"], ["del", 3, null, "old two"], ["add", null, 2, "new one"], ["ctx", 4, 3, "tail"]]);
  assert.equal(files[1].hunks[0].lines.length, 2, "the no-newline marker is not a line");
});

test("sideBySide: removals pair with the additions that replace them", () => {
  const rows = sideBySide(parseDiff(DIFF)[0]);
  const shape = rows.map((r) => "hunk" in r ? "@@" : `${r.left?.text ?? "·"} | ${r.right?.text ?? "·"}`);
  assert.deepEqual(shape, ["@@", "keep | keep", "old one | new one", "old two | ·", "tail | tail"]);
});

test("parseDiff: nothing to show for an empty diff", () => {
  assert.deepEqual(parseDiff(""), []);
});
