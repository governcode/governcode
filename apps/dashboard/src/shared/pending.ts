/** Whether any reserved or running ask still belongs to this thread. */
export function hasActiveAsk(asks: ReadonlyMap<string, string>, key: string): boolean {
  for (const thread of asks.values()) if (thread === key) return true;
  return false;
}
