// Text from tools and files must stay readable without controlling the terminal or hiding words.
// Every control, format and line/paragraph separator character (Unicode Cc, Cf, Zl, Zp: escape
// codes, bidi controls, zero-width and tag characters, soft hyphens...), the blank fillers some
// fonts draw as nothing, and the variation selectors that can carry hidden data are shown as a
// visible code, never sent as they are (a review on 2026-10-06 found a U+2028 that ended a code
// comment unseen in a diff). Only the two selectors ordinary emoji use (U+FE0E, U+FE0F) pass.
// On a terminal the code is marked (inverse video), so it cannot be mistaken for the same letters
// typed in the text: the text's own escape codes are shown as codes, so it cannot make that mark.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}͏ᅟᅠㅤﾠ︀-︍\u{e0100}-\u{e01ef}]/gu;

let marked = false;
/** Mark the codes in inverse video (set once, for a terminal). */
export function markCodes(on: boolean): void { marked = on; }

function escaped(char: string): string {
  const code = char.codePointAt(0)!;
  const text = code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
  return marked ? `\x1b[7m${text}\x1b[27m` : text;
}

/** Multi-line text keeps line breaks and tabs; every other hidden character is shown, never removed. */
export function shown(text: string): string {
  return text.replace(HIDDEN, (char) => (char === "\n" || char === "\t" ? char : escaped(char)));
}

/** A field must not break its row or move the next field to another column. */
export function oneLine(text: string): string {
  return text.replace(HIDDEN, escaped);
}

/** How many hidden characters text holds (line breaks and tabs aside), to say so before a review. */
export function hiddenCount(text: string): number {
  let n = 0;
  for (const m of text.matchAll(HIDDEN)) if (m[0] !== "\n" && m[0] !== "\t") n++;
  return n;
}

/** JSON.stringify leaves most of these raw; as JSON escapes they parse to exactly the same data.
 *  (Line breaks, returns and tabs only ever appear between values: inside strings JSON escapes them.) */
export function jsonShown(json: string): string {
  return json.replace(HIDDEN, (char) => char === "\n" || char === "\r" || char === "\t" ? char : Array.from({ length: char.length }, (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
}
