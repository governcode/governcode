// How a model, an effort and a Controller read on screen, shared by the renderer and the tests.
// An empty model is the default one, a missing effort is left out, and no line ever shows an
// empty segment between two separators.

type ControllerLike = { provider: string; model: string; effort: string | null };

/** The parts that have something in them, joined with " · ". */
export function dotted(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" · ");
}

/** "opus · high", "default model", "default model · low". */
export function modelLabel(model: string, effort: string | null | undefined): string {
  return dotted(model.trim() || "default model", effort);
}

/** "claude-code · opus · high"; no effort, no "n/a". */
export function controllerLabel(c: ControllerLike): string {
  return dotted(c.provider, modelLabel(c.model, c.effort));
}
