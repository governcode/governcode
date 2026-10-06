// The palette's rules, apart from its screen so they can be tested: which items a search shows,
// where the highlight starts, how it moves, and what Enter would run. The highlight is an item's
// id, never a position: a list that changes underneath can never put a different Gate under it.

export type PaletteItem = { id: string; label: string; detail?: string; answer?: boolean; hidden?: boolean };

/** Every word typed must appear in the label or its detail. With no search, hidden items stay out. */
export function filterItems<T extends PaletteItem>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => words.length ? words.every((w) => `${it.label} ${it.detail ?? ""}`.toLowerCase().includes(w)) : !it.hidden);
}

/** A search starts on its first result that is not an answer: an answer is chosen by moving to it. */
export function initialSelection(shown: readonly PaletteItem[]): string | null {
  return shown.find((it) => !it.answer)?.id ?? null;
}

/** One step up or down; from nothing, down starts at the top and up at the bottom. */
export function moveSelection(shown: readonly PaletteItem[], sel: string | null, by: 1 | -1): string | null {
  if (!shown.length) return null;
  const at = shown.findIndex((it) => it.id === sel);
  const from = at < 0 ? (by > 0 ? -1 : shown.length) : at;
  return shown[Math.max(0, Math.min(shown.length - 1, from + by))].id;
}

/** What Enter runs: the highlighted item if it is still shown, otherwise nothing. */
export function selected<T extends PaletteItem>(shown: readonly T[], sel: string | null): T | null {
  return shown.find((it) => it.id === sel) ?? null;
}
