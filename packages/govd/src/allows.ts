// Standing allows (#192): the user may answer a Gate "allow this kind of step for the rest of
// this turn / this Spec / this project". A standing allow only skips the QUESTION. It never
// widens what the sandbox lets the tool read, write, run or reach: that is enforced by the
// kernel for every step, allowed by a rule or not.
//
// A kind is deliberately narrow. For a shell command it is the program and its subcommand
// ("npm test", "cargo build"), and only for plain commands: anything with shell syntax that
// could chain or hide a second command (; & | $ ` < > quotes, newlines...) always asks.
// Some programs always ask whatever the rule says (deleting, publishing, networking,
// interpreters that can run anything).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type AllowScope = "turn" | "spec" | "project";
export type Kind = { key: string; label: string };
export type AllowRule = { id: string; scope: AllowScope; key: string; label: string; project: string | null;
  turn?: string; spec?: string; created: string };
export type GateContext = { project: string | null; turn: string; spec?: string };

// Shell syntax that could chain, substitute, redirect or hide a second command.
const SHELL = /[;&|`$<>(){}\\\n\r'"*?\[\]~!#]/;
// Programs that always ask: they delete, publish, reach the network, change permissions or
// processes, or run arbitrary code given as an argument.
const ALWAYS_ASK = new Set(["rm", "rmdir", "sudo", "su", "doas", "curl", "wget", "ssh", "scp", "rsync", "nc", "dd",
  "mkfs", "chmod", "chown", "kill", "pkill", "killall", "shutdown", "reboot", "systemctl", "crontab", "docker",
  "podman", "eval", "exec", "env", "xargs", "sh", "bash", "zsh", "fish", "dash", "python", "python3", "node", "deno",
  "bun", "perl", "ruby", "php", "lua", "osascript", "open", "xdg-open", "npx", "pnpx", "bunx",
  // git reads the project's .git/config, which can make it run any program (diff drivers,
  // fsmonitor, hooks); the AI can edit that file, so every git command asks.
  "git",
  // sed scripts can write files (w) or run commands (e); only printing line ranges is quiet.
  "sed",
  // Launchers run another program named later on the line, which this check would not see
  // (a Grok red-team review): they always ask, like env and xargs.
  "command", "builtin", "source", ".", "time", "nice", "nohup", "timeout", "stdbuf", "flock", "ionice", "setsid",
  "watch", "enable", "toybox", "unbuffer", "chrt", "taskset", "cgexec", "firejail", "script", "strace", "ltrace"]);
// Program + subcommand pairs that always ask.
const ALWAYS_ASK_SUB = new Set(["npm publish", "npm exec", "yarn publish", "pnpm publish", "pnpm exec",
  "cargo publish", "cargo install", "gh"]);
// Read-only commands that need not ask at all (a setting; on by default). Only programs that no
// file in the project can steer into running something else.
// Quiet reads use the same guard (EXEC_FLAG) as rules.
const QUIET_READS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "which", "stat", "du", "df", "find"]);
const FIND_ACTS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

// Outside quotes, anything that could chain, substitute, redirect, glob or hide a command.
const UNQUOTED = /[;&|`$<>(){}\\\n\r*?\[\]~!#]/;

/** Shell words, read exactly as the shell would, or null when anything could chain, expand or
 *  redirect. Single quotes are literal; double quotes only when they hold no $ ` \ or !. */
export function shellWords(text: string): string[] | null {
  const out: string[] = [];
  let cur = "", open = false;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === " " || c === "\t") { if (open) { out.push(cur); cur = ""; open = false; } i++; continue; }
    if (c === "'" || c === '"') {
      const j = text.indexOf(c, i + 1);
      if (j < 0) return null;
      const inner = text.slice(i + 1, j);
      if (c === '"' && /[$`\\!]/.test(inner)) return null;
      cur += inner; open = true; i = j + 1; continue;
    }
    if (UNQUOTED.test(c)) return null;
    cur += c; open = true; i++;
  }
  if (open) out.push(cur);
  return out;
}

/** A shell command's words, or null when it has shell syntax (then no rule may cover it). */
export function plainWords(command: unknown): string[] | null {
  let words: string[] | null = null;
  if (typeof command === "string") words = shellWords(command);
  else if (Array.isArray(command) && command.every((w) => typeof w === "string")) {
    const argv = command as string[];
    // Codex sends argv, often ["bash", "-lc", "the command"]; other argv is taken only if plain.
    if (argv.length === 3 && ["bash", "sh", "zsh"].includes(argv[0]) && ["-c", "-lc"].includes(argv[1])) words = shellWords(argv[2]);
    else words = argv.some((w) => UNQUOTED.test(w) || /\s/.test(w) || /['"]/.test(w)) ? null : [...argv];
  }
  if (!words) return null;
  // Codex's string form wraps the command:  /usr/bin/bash -lc '<command>'  (or "<command>").
  // A login shell reads the user's profile first; the AI cannot write that (the sandbox confines
  // writes to the project), so the profile is the user's own, not a way around a Gate.
  if (words.length === 3 && /^(?:\/usr\/bin\/|\/bin\/)?(?:bash|sh|zsh)$/.test(words[0]) && ["-c", "-lc"].includes(words[1])) words = shellWords(words[2]);
  if (!words || !words.length || words[0].includes("=") || words[0].includes("/")) return null;   // VAR=x cmd, ./script, /abs/path
  return words;
}

/** The kind of a command: its program and subcommand, which must come right after it. An option
 *  before the subcommand always asks: it may take a value that looks like one (`npm --prefix test
 *  exec ...` is `npm exec`, not `npm test`; security review 2026-09-27). Bare `--version` or
 *  `--help` is the program's own kind. Null when there is no plain subcommand. */
function commandKey(words: string[]): string | null {
  if (words.length === 1) return words[0];
  const sub = words[1];
  // Only options (`ls -la`, `npm --version`): the program's own kind. An option followed by a
  // word is ambiguous (the word may be the option's value), so it asks.
  if (sub.startsWith("-")) return words.slice(1).every((w) => w.startsWith("-")) ? words[0] : null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sub) ? `${words[0]} ${sub}` : null;
}

// Interpreters and anything that runs code given as an argument, however it is versioned
// (python3.13, perl5.38, gawk...).
const INTERPRETER = /^(python|pypy|perl|ruby|node|nodejs|deno|bun|php|lua|luajit|tcl|tclsh|wish|awk|gawk|mawk|nawk|busybox|R|Rscript|julia|java|jshell|groovy|scala|dotnet|pwsh|powershell|osascript|expect|guile|racket|sbcl|ghci|runghc|elixir|erl|swift|kotlin)[0-9._-]*$/;
// Flags that make an otherwise harmless program run something or write where it should not.
const EXEC_FLAG = /^(--pre|--pre-glob|--to-command|--use-compress-program|--checkpoint-action|--rsh-command|--info-script|--new-volume-script|--exec|--execdir|--command|--shell|--editor|--pager|--output|-o|--script-shell|--hostname-bin|--use-compress|-I.*)(=|$)/;

// Quiet reads: for each program, exactly the options known to only read (security review
// 2026-09-27: a denylist missed rg --hostname-bin, tail -f, grep -f /dev/zero...). Anything
// else, including every option not listed, asks. `letters` are single-letter flags that may be
// combined (-la); `arg` take the next word (or an attached number); `long` stand alone;
// `longArg` take `=value`. Numbers alone (-20) are allowed where `num` is set.
type Opts = { letters?: string; arg?: string[]; long?: string[]; longArg?: string[]; num?: boolean; operands?: boolean };
const QUIET: Record<string, Opts> = {
  ls: { letters: "lahRtrS1dFipAG", long: ["--all", "--almost-all", "--human-readable", "--recursive"] },
  pwd: { operands: false },
  cat: { letters: "nAbEsTv" },
  head: { arg: ["-n", "-c"], num: true },
  tail: { arg: ["-n", "-c"], num: true },
  wc: { letters: "lwcmL" },
  grep: { letters: "rRnilwvcoHhsEFxIL", arg: ["-e", "-A", "-B", "-C", "-m"], longArg: ["--include", "--exclude", "--exclude-dir"] },
  rg: { letters: "nilwvcoHhsFSuULNp", arg: ["-e", "-g", "-t", "-T", "-A", "-B", "-C", "-m"],
    long: ["--hidden", "--no-ignore", "--files", "--count", "--line-number", "--fixed-strings", "--ignore-case", "--smart-case", "--no-heading", "--color=never"],
    longArg: ["--glob", "--type", "--max-count", "--max-depth"] },
  which: {},
  stat: { letters: "L", arg: ["-c"] },
  du: { letters: "shcad", arg: ["-d"], longArg: ["--max-depth"] },
  df: { letters: "hTi" },
};
// find: a starting path, then only these tests (with their values) and printing.
const FIND_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-newer", "-size",
  "-mtime", "-mmin", "-user", "-regex", "-iregex"]);
const FIND_FLAGS = new Set(["-print", "-print0", "-not", "-o", "-or", "-a", "-and", "-empty", "-L", "-P"]);
// Special files that never end or are not files at all: reading them is not a quiet read.
const SPECIAL = /^\/(dev|proc|sys|run)(\/|$)/;

function quietArgs(words: string[]): boolean {
  if (words[0] === "find") {
    let i = 1;
    while (i < words.length && !words[i].startsWith("-")) { if (SPECIAL.test(words[i])) return false; i++; }
    for (; i < words.length; i++) {
      if (FIND_FLAGS.has(words[i])) continue;
      if (FIND_TESTS.has(words[i]) && i + 1 < words.length) { i++; continue; }
      return false;
    }
    return true;
  }
  const o = QUIET[words[0]];
  if (!o) return false;
  let operands = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!operands && w === "--") { operands = true; continue; }
    if (!operands && w.startsWith("-") && w !== "-") {
      if (o.long?.includes(w)) continue;
      if (w.startsWith("--")) { if (o.longArg?.some((l) => w.startsWith(l + "="))) continue; return false; }
      if (o.arg?.includes(w)) { if (++i >= words.length) return false; continue; }
      if (o.arg?.some((a) => new RegExp(`^${a}\\d+$`).test(w))) continue;        // -n20
      if (o.num && /^-\d+$/.test(w)) continue;                                    // -20
      if (o.letters && [...w.slice(1)].every((c) => o.letters!.includes(c))) continue;
      return false;
    }
    if (o.operands === false || w === "-" || SPECIAL.test(w)) return false;        // stdin and special files ask
  }
  return true;
}

/** The tool of a Gate request, without the Runner suffix govd adds for display. */
function baseTool(req: { tool: string; base?: string }): string {
  return req.base ?? req.tool;
}

/** What kind of step this is, for a standing allow; null when it must always ask. A Runner's
 *  kinds are its own: allowing a step in a Spec's workspace never covers the Controller's steps
 *  in the real project. */
export function kindOf(req: { tool: string; base?: string; spec?: string; input: Record<string, unknown> }): Kind | null {
  const k = controllerKind(req);
  return k && req.spec ? { key: `runner:${k.key}`, label: `a Runner's ${k.label}` } : k;
}

function controllerKind(req: { tool: string; base?: string; input: Record<string, unknown> }): Kind | null {
  const tool = baseTool(req);
  if (tool === "Bash" || tool === "codex command") {
    const words = plainWords(req.input.command);
    if (!words) return null;
    const key = commandKey(words);
    if (!key || ALWAYS_ASK.has(words[0]) || INTERPRETER.test(words[0]) || ALWAYS_ASK_SUB.has(key) || ALWAYS_ASK_SUB.has(words[0])) return null;
    if (words.some((w) => EXEC_FLAG.test(w))) return null;
    if (words[0] === "find" && words.some((w) => FIND_ACTS.test(w))) return null;
    // Honest label: a build or test command runs the project's own scripts, which the AI can edit.
    return { key: `command:${key}`, label: `\`${key}\` commands (they run whatever the project's files say; the sandbox still applies)` };
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit", "codex fileChange"].includes(tool)) {
    return { key: "edit", label: "file edits (only where the sandbox already lets it write)" };
  }
  if (tool.startsWith("mcp__") || tool.startsWith("governcode ")) return null;   // delegation and GovernCode's tools always ask
  if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(tool)) return { key: `tool:${tool}`, label: `${tool}` };
  return null;
}

/** A read-only command that need not ask at all (when the user keeps "quiet reads" on). */
export function isQuietRead(req: { tool: string; base?: string; input: Record<string, unknown> }): boolean {
  const tool = baseTool(req);
  if (tool !== "Bash" && tool !== "codex command") return false;
  const words = plainWords(req.input.command);
  if (!words) return false;
  // sed -n 'N,Mp' FILE...: printing a range of lines, nothing else.
  if (words[0] === "sed") return words.length >= 3 && words[1] === "-n" && /^(\d+|\$)(,(\d+|\$))?p$/.test(words[2]) && words.slice(3).every((w) => !w.startsWith("-"));
  return QUIET_READS.has(words[0]) && quietArgs(words);
}

/** The scopes a Gate may offer: a Controller's steps per turn or project, a Runner's per Spec or
 *  project; Home (no project) per turn only. */
export function scopesFor(kind: Kind | null, ctx: GateContext): AllowScope[] {
  if (!kind) return [];
  return [...(ctx.spec ? ["spec" as const] : ["turn" as const]), ...(ctx.project ? ["project" as const] : [])];
}

/** The rules: turn and Spec ones in memory, project ones saved (0600) in govd's own state. */
export class Allows {
  private rules: AllowRule[] = [];
  private seq = 0;
  private file: string;
  constructor(file: string) {
    this.file = file;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(saved)) this.rules = saved.filter((r) => r && r.scope === "project" && typeof r.key === "string");
      this.seq = Math.max(0, ...this.rules.map((r) => Number(String(r.id).slice(2)) || 0));
    } catch { /* none yet */ }
  }

  match(kind: Kind | null, ctx: GateContext): AllowRule | null {
    if (!kind) return null;
    return this.rules.find((r) => r.key === kind.key && (
      (r.scope === "turn" && r.turn === ctx.turn) ||
      (r.scope === "spec" && ctx.spec !== undefined && r.spec === ctx.spec) ||
      (r.scope === "project" && ctx.project !== null && r.project === ctx.project))) ?? null;
  }

  add(scope: AllowScope, kind: Kind, ctx: GateContext): AllowRule {
    if (scope === "spec" && !ctx.spec) throw new Error("this Gate is not from a Spec");
    if (scope === "turn" && ctx.spec) throw new Error("a Runner's steps are allowed per Spec, not per turn");
    if (scope === "project" && !ctx.project) throw new Error("Home has no project to remember a rule for");
    const rule: AllowRule = { id: `R-${++this.seq}`, scope, key: kind.key, label: kind.label, project: ctx.project,
      ...(scope !== "project" ? { turn: ctx.turn } : {}), ...(scope === "spec" ? { spec: ctx.spec } : {}), created: new Date().toISOString() };
    // A project rule is saved first: if that fails, nothing changes (the Gate stays open).
    if (scope === "project") this.save([...this.list(), rule]);
    this.rules.push(rule);
    return rule;
  }

  /** Turn and Spec rules end with the Controller turn they were made in (Specs run inside it). */
  endTurn(turn: string): void {
    this.rules = this.rules.filter((r) => r.scope === "project" || r.turn !== turn);
  }

  list(project?: string): AllowRule[] {
    return this.rules.filter((r) => r.scope === "project" && (!project || r.project === project));
  }

  revoke(id: string): boolean {
    if (!this.rules.some((r) => r.id === id)) return false;
    this.save(this.list().filter((r) => r.id !== id));   // saved first, as with add
    this.rules = this.rules.filter((r) => r.id !== id);
    return true;
  }

  private save(rules: AllowRule[] = this.list()): void {
    if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rules, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
