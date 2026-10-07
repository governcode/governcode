// #224: steps that probably ran into the sandbox. When a tool reports a failed step whose output
// says what the kernel says when the sandbox refuses something (EACCES from Landlock, EPERM from
// seccomp, a read-only file system), govd records `sandbox.blocked` with the tool, the kind of step
// (as a Gate would record it) and which of those it said; never the output itself. It is an
// estimate: an ordinary permission error in a project looks the same, so the report says
// "probably". Only failed steps are looked at, so a command that merely prints such words (a grep
// through a log) is not counted unless it failed too.
import { homedir } from "node:os";
import { analyze, recordedKind } from "./allows.ts";

const PATTERNS: Array<[string, RegExp]> = [
  ["permission denied", /permission denied|\bEACCES\b/i],
  ["operation not permitted", /operation not permitted|\bEPERM\b/i],
  ["read-only file system", /read-only file system|\bEROFS\b/i],
];

/** Which of the sandbox's refusals a failed step's output shows, if any (only its first 64 KB). */
export function blockOf(output: string): string | null {
  const text = output.slice(0, 65_536);
  return PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
}

export type Block = { tool: string; kinds: string[]; always: boolean; pattern: string; why?: string; where?: string };

/** Roughly where a refusal happened, from the first absolute path on the line that says it: a
 *  category, plus at most one top-level folder name under the home folder (`~/.npm`). Never the
 *  path itself. A Runner's home is GovernCode's own, inside its state folder. */
export function whereOf(output: string, home = homedir()): string | undefined {
  const line = output.slice(0, 65_536).split("\n").find((l) => PATTERNS.some(([, re]) => re.test(l)));
  const path = line && /(?:^|[\s'"(:=])(\/[^\s'"),:]*)/.exec(line)?.[1];
  if (!path) return undefined;
  if (/^\/(proc|sys|dev)(\/|$)/.test(path)) return "/proc, /sys or /dev";
  if (/^\/(tmp|var\/tmp)(\/|$)/.test(path)) return "/tmp";
  if (/^\/(etc|usr|opt|bin|sbin|lib|lib64|boot|srv|var)(\/|$)/.test(path)) return "system folders";
  if (path === home || path.startsWith(`${home}/`)) {
    const rest = path.slice(home.length + 1);
    if (rest.startsWith(".local/state/governcode/")) return "GovernCode's own folders (a run's home or a Spec's copy)";
    const top = rest.split("/")[0];
    return /^\.?[A-Za-z0-9_-][A-Za-z0-9._-]{0,31}$/.test(top) ? `~/${top}` : "the home folder";
  }
  if (path.startsWith("/run/") ) return "/run";
  return "elsewhere";
}

/** A failed step as a probable sandbox block, judged by the same analysis as its Gate would be;
 *  null when its output shows no refusal. `spec`: a Runner's step (its kinds are a Runner's). */
export function blockFor(tool: string, input: Record<string, unknown>, output: string, spec?: string, base?: string): Block | null {
  const pattern = blockOf(output);
  if (!pattern) return null;
  const a = analyze({ tool, input, ...(spec ? { spec } : {}), ...(base ? { base } : {}) });
  const where = whereOf(output);
  return { tool: tool.slice(0, 80), kinds: a.kinds.map((k) => recordedKind(k.key)), always: a.ask, pattern,
    ...(a.why ? { why: a.why } : {}), ...(where ? { where } : {}) };
}

/** A tool result's text, whatever shape it came in (a string, or a list of text parts). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : typeof c?.text === "string" ? c.text : "")).join("\n");
  return "";
}
