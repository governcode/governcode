// A unified git diff, parsed for review: per file, its +/- counts and hunks with line
// numbers, and the side-by-side pairing of each run of removed lines with the added lines
// that replace them. Pure, so it is tested without a window.

export type DiffLine = { kind: "ctx" | "add" | "del"; text: string; old: number | null; new: number | null };
export type Hunk = { header: string; lines: DiffLine[] };
export type DiffFile = { path: string; added: number; removed: number; binary: boolean; hunks: Hunk[] };
export type SideRow = { left: DiffLine | null; right: DiffLine | null } | { hunk: string };

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null, hunk: Hunk | null = null;
  let oldNo = 0, newNo = 0;
  for (const line of text.split("\n")) {
    const start = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (start) {
      file = { path: start[2], added: 0, removed: 0, binary: false, hunks: [] };
      files.push(file); hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") { file.binary = true; continue; }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (at) {
      oldNo = Number(at[1]); newNo = Number(at[2]);
      hunk = { header: line, lines: [] }; file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;                                   // headers: index, ---, +++, modes
    if (line.startsWith("+")) { hunk.lines.push({ kind: "add", text: line.slice(1), old: null, new: newNo++ }); file.added++; }
    else if (line.startsWith("-")) { hunk.lines.push({ kind: "del", text: line.slice(1), old: oldNo++, new: null }); file.removed++; }
    else if (line.startsWith(" ")) hunk.lines.push({ kind: "ctx", text: line.slice(1), old: oldNo++, new: newNo++ });
    // "\ No newline at end of file" and the final empty line carry no content
  }
  return files;
}

/** Side by side: context on both sides; each run of removals paired row by row with the additions after it. */
export function sideBySide(file: DiffFile): SideRow[] {
  const rows: SideRow[] = [];
  for (const h of file.hunks) {
    rows.push({ hunk: h.header });
    let i = 0;
    while (i < h.lines.length) {
      const l = h.lines[i];
      if (l.kind === "ctx") { rows.push({ left: l, right: l }); i++; continue; }
      const dels: DiffLine[] = [], adds: DiffLine[] = [];
      while (i < h.lines.length && h.lines[i].kind === "del") dels.push(h.lines[i++]);
      while (i < h.lines.length && h.lines[i].kind === "add") adds.push(h.lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}
