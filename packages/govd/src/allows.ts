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
import { dirname, posix } from "node:path";

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
  // sed scripts can write files (w) or run commands (e); only printing line ranges is quiet.
  "sed",
  // Another AI coding tool started from a command would be a handoff GovernCode does not see.
  "claude", "codex", "agy", "gemini", "grok", "ollama", "aider", "opencode", "cursor-agent", "goose", "amp", "crush", "qwen",
  // Launchers run another program named later on the line, which this check would not see
  // (a Grok red-team review): they always ask, like env and xargs.
  "command", "builtin", "source", ".", "time", "nice", "nohup", "timeout", "stdbuf", "flock", "ionice", "setsid",
  "watch", "enable", "toybox", "unbuffer", "chrt", "taskset", "cgexec", "firejail", "script", "strace", "ltrace",
  // More launchers (a Grok red-team, 2026-09-27): a kind for any of these would cover every
  // program named after it.
  "fakeroot", "setarch", "numactl", "nsenter", "runuser", "pkexec", "sshpass", "prlimit", "chroot", "setpriv",
  "unshare", "systemd-run", "doas", "ssh-agent", "dbus-launch", "xvfb-run", "valgrind", "gdb",
  // tar's options hide in its first word without a dash (tar xvfI a.tar ./prog runs ./prog).
  "tar",
  // Grok's red-team of compound commands, 2026-09-27: more shells, and programs that run their
  // input or another program later (a pipe into any of these runs whatever came before it).
  "ksh", "mksh", "ash", "csh", "tcsh", "coproc", "at", "batch", "parallel", "socat", "ncat", "netcat", "corepack",
  "torsocks", "proot", "bwrap"]);
// Program + subcommand pairs that always ask.
const ALWAYS_ASK_SUB = new Set(["npm publish", "npm exec", "yarn publish", "pnpm publish", "pnpm exec",
  "cargo publish", "cargo install", "gh",
  // Installing packages downloads code and runs its install scripts: always asks, at every level.
  "npm install", "npm i", "npm ci", "npm add", "npm update", "npm uninstall", "yarn add", "yarn install", "yarn remove",
  "pnpm add", "pnpm install", "pnpm i", "pnpm remove", "bun add", "bun install", "bun remove", "pip install", "pip3 install",
  "pip uninstall", "uv add", "uv pip", "uv sync", "uv tool", "poetry add", "poetry install", "cargo add", "go get", "go install",
  "gem install", "bundle install", "bundle add", "composer require", "composer install", "deno install", "npx"]);
// Read-only commands that need not ask at all (a setting; on by default). Only programs that no
// file in the project can steer into running something else.
// Quiet reads use the same guard (EXEC_FLAG) as rules.
const QUIET_READS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "which", "stat", "du", "df", "find",
  "sort", "cut", "nl", "echo"]);
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
// A standing kind already runs the project's own scripts (the label says so), inside the sandbox;
// these are the flags that would run something else, or read config that can.
const EXEC_FLAG = /^(--pre|--pre-glob|--to-command|--use-compress-program|--checkpoint-action|--rsh-command|--info-script|--new-volume-script|--exec|--execdir|--command|--shell|--editor|--pager|--output|-o|--script-shell|--hostname-bin|--use-compress|-I.*|-exec|-execdir|-toolexec|--config|--eval|--compress-program|--userconfig|--globalconfig|--prefix|--manifest-path|--file|--makefile|--rcfile|--init-file)(=|$)/;
// Short options that run or load a program for these tools only (grep -f and -I stay quiet).
const EXEC_SHORT: Record<string, RegExp> = { make: /^-f/, gmake: /^-f/ };

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
  // Filters that commonly end a pipeline; sort's -o (write a file) is not among its options.
  sort: { letters: "rnufbdhV", arg: ["-k", "-t"] },
  cut: { arg: ["-d", "-f", "-c", "-b"] },
  nl: { letters: "b", arg: ["-w"] },
  echo: { letters: "neE" },
};
// find: a starting path, then only these tests (with their values) and printing.
const FIND_TESTS = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-newer", "-size",
  "-mtime", "-mmin", "-user", "-regex", "-iregex"]);
const FIND_FLAGS = new Set(["-print", "-print0", "-not", "-o", "-or", "-a", "-and", "-empty", "-L", "-P"]);
// Special files that never end or are not files at all: reading them is not a quiet read.
const SPECIAL_RE = /^\/(dev|proc|sys|run)(\/|$)/;
/** A special place, however it is spelled (//dev/zero, /./dev), or any path with a .. segment,
 *  which could climb out of the project to one (security review 2026-09-27).
 *  ponytail: a symlink inside the project pointing at /dev/zero is not caught here; the read is
 *  still sandboxed, only unbounded. */
const SPECIAL = { test: (p: string) => p.split("/").includes("..") || (p.startsWith("/") && SPECIAL_RE.test(posix.normalize(p).replace(/^\/+/, "/"))) };

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
  if (words[0] === "echo") return true;                        // echo prints its words (substitution already refused)
  const o = Object.hasOwn(QUIET, words[0]) ? QUIET[words[0]] : undefined;
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
// Tools whose input is a shell command, judged by the same command analysis.
const COMMAND_TOOLS = new Set(["Bash", "codex command", "agy command"]);

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

// git: reading the repository is a kind like any other (it runs inside the sandbox, and the .git
// guard puts back anything a turn changed in .git); anything that changes the repository or
// reaches the network always asks: commit, push, pull, fetch, reset, rebase, checkout, config...
// Only these subcommands, and only these options (anything else, such as grep's
// --open-files-in-pager or diff's --output, asks; security review 2026-09-27). Operands (refs,
// paths) are allowed. git may still run a program its own config names (a diff driver, a
// pager): inside the sandbox, as `npm test` runs the project's scripts, and the label says so.
const GIT_READ: Record<string, RegExp> = {
  status: /^(-s|--short|-b|--branch|--porcelain(=v[12])?|-u|--untracked-files=(no|normal|all)|--ignored)$/,
  diff: /^(--stat|--numstat|--shortstat|--summary|--name-only|--name-status|--cached|--staged|--no-color|--color=never|-U\d+|--unified=\d+|--word-diff|-w|--ignore-all-space|--no-ext-diff|--no-textconv|--)$/,
  log: /^(--oneline|-\d+|-n|--max-count=\d+|--stat|--graph|--decorate|--all|--no-color|--reverse|--name-only|--name-status|-p|--patch|--no-ext-diff|--no-textconv|--(format|pretty)=[^]*|--(since|until|author)=[^]*|--)$/,
  show: /^(--stat|--name-only|--name-status|--oneline|--no-color|-p|--patch|--no-ext-diff|--no-textconv|--(format|pretty)=[^]*|--)$/,
};
function gitReadOk(words: string[]): boolean {
  const opts = Object.hasOwn(GIT_READ, words[1] ?? "") ? GIT_READ[words[1]] : undefined;   // never Object.prototype's names
  if (!opts) return false;
  for (let i = 2; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) continue;
    if (!opts.test(w)) return false;
    if (w === "-n") i++;                                          // -n N
  }
  return true;
}

// Package managers: only these subcommands are a kind (running the project's own scripts or
// listing). Everything else asks, because installing hides behind many names (npm i, it,
// isntall, add...) and some tools install when given nothing at all (a bare `yarn`).
const PACKAGE_SAFE: Record<string, Set<string>> = {
  npm: new Set(["test", "t", "tst", "run", "run-script", "rum", "urn", "start", "ls", "list", "outdated", "help"]),
  pnpm: new Set(["test", "t", "run", "start", "ls", "list", "outdated"]),
  yarn: new Set(["test", "run", "start", "list", "outdated"]),
  bun: new Set(["test", "run"]),
  pip: new Set(["list", "show", "freeze", "check"]), pip3: new Set(["list", "show", "freeze", "check"]),
  uv: new Set(["run"]), poetry: new Set(["run", "show", "check"]), gem: new Set(["list"]), bundle: new Set(["exec", "list"]),
  composer: new Set(["show", "test", "run-script"]), deno: new Set(["test", "task", "fmt", "lint", "check"]),
};

/** The kind of one simple command (its words), or null when it must always ask. */
function commandKind(words: string[]): Kind | null {
    if (words[0] === "git" && !gitReadOk(words)) return null;
    const pm = Object.hasOwn(PACKAGE_SAFE, words[0]) ? PACKAGE_SAFE[words[0]] : undefined;
    const info = words.length === 2 && ["--version", "-v", "-V", "--help", "-h"].includes(words[1]);
    if (pm && !info && !pm.has(words[1] ?? "")) return null;
    const key = commandKey(words);
    if (!key || ALWAYS_ASK.has(words[0]) || INTERPRETER.test(words[0]) || ALWAYS_ASK_SUB.has(key) || ALWAYS_ASK_SUB.has(words[0])) return null;
    if (words.some((w) => EXEC_FLAG.test(w))) return null;
    const short = EXEC_SHORT[words[0]];
    if (short && words.slice(1).some((w) => !w.startsWith("--") && short.test(w))) return null;
    if (words[0] === "find" && words.some((w) => FIND_ACTS.test(w))) return null;
    // Honest label: a build or test command runs the project's own scripts, which the AI can edit;
    // git may run programs its config names.
    const what = words[0] === "git" ? "git may run programs its config names" : "they run whatever the project's files say";
    return { key: `command:${key}`, label: `\`${key}\` commands (${what}; the sandbox still applies)` };
}

function controllerKind(req: { tool: string; base?: string; input: Record<string, unknown> }): Kind | null {
  const tool = baseTool(req);
  if (COMMAND_TOOLS.has(tool)) {
    const words = plainWords(req.input.command);
    return words ? commandKind(words) : null;
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit", "codex fileChange", "agy fileChange"].includes(tool)) {
    return { key: "edit", label: "file edits (only where the sandbox already lets it write)" };
  }
  if (tool.startsWith("mcp__") || tool.startsWith("governcode ")) return null;   // delegation and GovernCode's tools always ask
  if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(tool)) return { key: `tool:${tool}`, label: `${tool}` };
  return null;
}

/** A read-only command that need not ask at all (when the user keeps "quiet reads" on). */
export function isQuietRead(req: { tool: string; base?: string; input: Record<string, unknown> }): boolean {
  const tool = baseTool(req);
  if (!COMMAND_TOOLS.has(tool)) return false;
  const words = plainWords(req.input.command);
  if (!words) return false;
  // sed -n 'N,Mp' FILE...: printing a range of lines, nothing else.
  if (words[0] === "sed") return words.length >= 3 && words[1] === "-n" && /^(\d+|\$)(,(\d+|\$))?p$/.test(words[2]) && words.slice(3).every((w) => !w.startsWith("-"));
  return QUIET_READS.has(words[0]) && quietArgs(words);
}

// --- Compound commands (how strict, 2026-09-27) ------------------------------------------
// AI tools rarely run a bare `npm test`; they run `cd x && npm test 2>&1 | tail -20`. Judged as a
// whole, that always asked: 29 of 30 questions in the first real test were like it. So a command
// is split into its simple commands, and each is judged on its own. Only syntax that joins
// commands the way the shell always does is understood; anything that could hide or compute a
// command (substitution, subshells, background jobs, globs, comments, heredocs, redirection
// into a file) still makes the whole command ask.

export type Analysis = { ask: boolean; quiet: boolean; kinds: Kind[] };

/** A command's simple commands, as shell words, or null when any part cannot be read statically.
 *  Splits at && || ; | and newlines outside quotes; drops `2>&1`, `>&2` and redirection to
 *  /dev/null; `cd DIR` counts as nothing. */
export function shellSegments(text: string): string[][] | null {
  const segs: string[][] = [];
  let words: string[] = [], cur = "", open = false;
  const endWord = () => { if (open) { words.push(cur); cur = ""; open = false; } };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === " " || c === "\t") { endWord(); i++; continue; }
    if (c === "\n" || c === ";") { endSeg(); i++; continue; }
    if (c === "&" && text[i + 1] === "&") { endSeg(); i += 2; continue; }
    if (c === "|") { endSeg(); i += text[i + 1] === "|" ? 2 : 1; continue; }
    if (c === ">" || c === "<") {
      // A file descriptor right before it (2>): part of the redirection, not a word.
      if (open && /^[0-9]$/.test(cur)) { cur = ""; open = false; }
      if (c === "<") return null;                                  // input from a file or heredoc
      let j = i + 1;
      if (text[j] === ">") j++;                                    // >>
      if (text[j] === "&") {                                       // >&1, >&2
        if (!/[12]/.test(text[j + 1] ?? "") || /[^\s;&|]/.test(text[j + 2] ?? " ")) return null;
        i = j + 2; continue;
      }
      while (text[j] === " ") j++;
      const m = /^\/dev\/null(?=$|[\s;&|])/.exec(text.slice(j));
      if (!m) return null;                                         // writing a file: asks
      i = j + m[0].length; continue;
    }
    if (c === "'" || c === '"') {
      const j = text.indexOf(c, i + 1);
      if (j < 0) return null;
      const inner = text.slice(i + 1, j);
      if (c === '"' && /[$`\\!]/.test(inner)) return null;
      cur += inner; open = true; i = j + 1; continue;
    }
    if (/[`$(){}\\*?\[\]~!#&\r]/.test(c)) return null;
    cur += c; open = true; i++;
  }
  endSeg();
  if (!segs.length) return null;
  return segs.filter((w) => !(w[0] === "cd" && w.length <= 2));    // cd changes nothing outside this command
}

/** What a request needs: `ask` when some part must always ask; `quiet` when every part is a
 *  plain read; otherwise the kinds a rule (or the user) must cover. */
export function analyze(req: { tool: string; base?: string; spec?: string; input: Record<string, unknown> }): Analysis {
  const tool = baseTool(req);
  const runner = (k: Kind): Kind => (req.spec ? { key: `runner:${k.key}`, label: `a Runner's ${k.label}` } : k);
  if (COMMAND_TOOLS.has(tool)) {
    let command = req.input.command;
    if (Array.isArray(command) && command.length === 3 && ["bash", "sh", "zsh"].includes(String(command[0])) && ["-c", "-lc"].includes(String(command[1]))) command = command[2];
    let segs: string[][] | null = null;
    if (typeof command === "string") {
      const w = shellWords(command);
      // Codex's string wrapper: /usr/bin/bash -lc '<command>'
      if (w && w.length === 3 && /^(?:\/usr\/bin\/|\/bin\/)?(?:bash|sh|zsh)$/.test(w[0]) && ["-c", "-lc"].includes(w[1])) command = w[2];
      segs = shellSegments(String(command));
    } else if (Array.isArray(command)) {
      const w = plainWords(command);
      segs = w ? [w] : null;
    }
    if (!segs) return { ask: true, quiet: false, kinds: [] };
    if (!segs.length) return { ask: false, quiet: true, kinds: [] };   // only cd
    const kinds: Kind[] = [];
    for (const w of segs) {
      if (!w.length || w[0].includes("=") || w[0].includes("/")) return { ask: true, quiet: false, kinds: [] };
      if (QUIET_READS.has(w[0]) && quietArgs(w)) continue;
      // A read-only program with an option it is not known to read with (sort -o, tail -f,
      // grep -f, a special file) is not a kind a rule may cover: it asks (Grok's red-team).
      if (QUIET_READS.has(w[0]) && !(w.length === 2 && ["--help", "--version"].includes(w[1]))) return { ask: true, quiet: false, kinds: [] };
      const k = commandKind(w);
      if (!k) return { ask: true, quiet: false, kinds: [] };
      if (!kinds.some((x) => x.key === runner(k).key)) kinds.push(runner(k));
    }
    return { ask: false, quiet: kinds.length === 0, kinds };
  }
  // Handing a job to a local model costs no quota: a kind like any other. A paid Runner always asks.
  if (/^(mcp__governcode__delegate|governcode delegate)$/.test(tool)) {
    return LOCAL_RUNNERS.includes(String(req.input.to ?? "")) ? { ask: false, quiet: false, kinds: [runner({ key: "delegate:local", label: "handing jobs to a local model" })] }
      : { ask: true, quiet: false, kinds: [] };
  }
  if (/^(mcp__governcode__spec_discard|governcode spec_discard)$/.test(tool)) {
    return { ask: false, quiet: false, kinds: [runner({ key: "spec:discard", label: "throwing away a Spec it proposed (accepting is always yours)" })] };
  }
  const k = kindOf(req);
  return k ? { ask: false, quiet: false, kinds: [k] } : { ask: true, quiet: false, kinds: [] };
}
const LOCAL_RUNNERS = ["ollama"];

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
