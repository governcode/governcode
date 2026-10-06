// Provider marks: each AI tool shown with its own logo, so the crew is recognisable at a glance.
// The marks in ./brands are their owners' trademarks, used unchanged and only to say which tool is
// which (see brands/README.md). They sit on the same neutral tile; a one-colour mark is shown in
// its official black or white to suit the theme. A provider without a mark gets a monogram.
import claude from "./brands/claude.svg";
import openai from "./brands/openai.svg";
import openaiWhite from "./brands/openai-white.svg";
import grok from "./brands/grok.svg";
import grokWhite from "./brands/grok-white.svg";
import antigravity from "./brands/antigravity.svg";
import ollama from "./brands/ollama.svg";
import ollamaWhite from "./brands/ollama-white.svg";
import gemini from "./brands/gemini.svg";

type Mark = { name: string; src?: string; white?: string; scale?: number };

export const PROVIDERS: Record<string, Mark> = {
  "claude-code": { name: "Claude Code", src: claude, scale: 0.66 },
  claude: { name: "Claude Code", src: claude, scale: 0.66 },
  codex: { name: "Codex", src: openai, white: openaiWhite, scale: 0.62 },
  grok: { name: "Grok", src: grok, white: grokWhite, scale: 0.7 },
  agy: { name: "Antigravity", src: antigravity, scale: 0.74 },
  ollama: { name: "Ollama", src: ollama, white: ollamaWhite, scale: 0.6 },
  gemini: { name: "Gemini CLI", src: gemini, scale: 0.62 },
  opencode: { name: "OpenCode" },   // a monogram until its mark is cleared (brands/README.md)
};

export function providerName(id: string): string {
  return PROVIDERS[id]?.name ?? id;
}

/** A provider's mark on a neutral rounded tile. size: the tile's edge in px. */
export function ProviderMark({ id, size = 22, title }: { id: string; size?: number; title?: string }) {
  const m = PROVIDERS[id];
  const label = title ?? providerName(id);
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.28) };
  if (!m?.src) {
    const letters = (m?.name ?? id).replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
    return <span className="pmark mono-tile" role="img" aria-label={label} title={label} style={{ ...style, fontSize: Math.round(size * 0.42) }}>
      {letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase()}</span>;
  }
  const inner = Math.round(size * (m.scale ?? 0.64));
  return (
    <span className="pmark" role="img" aria-label={label} title={label} style={style}>
      {m.white ? <>
        <img className="only-light" src={m.src} width={inner} height={inner} alt="" />
        <img className="only-dark" src={m.white} width={inner} height={inner} alt="" />
      </> : <img src={m.src} width={inner} height={inner} alt="" />}
    </span>
  );
}
