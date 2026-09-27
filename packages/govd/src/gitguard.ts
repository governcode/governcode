// The .git guard. A sandboxed tool may write its project, and so its .git: a hook, or a config
// key such as core.fsmonitor, would run later OUTSIDE the sandbox when the user runs git.
// Before a turn we record the hooks and the dangerous local config; after it we put them back
// and report what was removed.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";

// Local config keys that make git run a program, or point it somewhere that does.
const DANGEROUS = /^(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy)|diff\..+\.(textconv|command)|diff\.external|merge\..+\.driver|filter\..+\.(clean|smudge|process)|gpg\.(program|.+\.program)|credential\..*helper|sequence\.editor|uploadpack\..*|receivepack\..*|include\.path|includeif\..+\.path|alias\..+)$/i;

function gitDir(project: string): string | null {
  try {
    const d = execFileSync("git", ["-C", project, "rev-parse", "--absolute-git-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return d || null;
  } catch { return null; }
}

function localConfig(dir: string): Array<[string, string]> {
  try {
    return execFileSync("git", ["config", "--file", join(dir, "config"), "--list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter(Boolean).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)] as [string, string]; });
  } catch { return []; }
}

function hooks(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const h = join(dir, "hooks");
  if (!existsSync(h)) return out;
  for (const f of readdirSync(h)) {
    const p = join(h, f);
    if (statSync(p).isFile()) out.set(f, readFileSync(p));
  }
  return out;
}

export function gitGuard(project: string): { restore(): string[] } | null {
  const dir = gitDir(project);
  if (!dir) return null;
  const beforeHooks = hooks(dir);
  const beforePairs = localConfig(dir).filter(([k]) => DANGEROUS.test(k));
  const beforeConfig = new Set(beforePairs.map(([k, v]) => `${k}=${v}`));
  return {
    restore(): string[] {
      const removed: string[] = [];
      for (const [name, body] of hooks(dir)) {
        const was = beforeHooks.get(name);
        if (was && was.equals(body)) continue;
        const p = join(dir, "hooks", name);
        if (was) { writeFileSync(p, was); chmodSync(p, 0o755); } else rmSync(p, { force: true });
        removed.push(`hook ${name}`);
      }
      const file = join(dir, "config");
      const changedKeys = new Set(localConfig(dir).filter(([k, v]) => DANGEROUS.test(k) && !beforeConfig.has(`${k}=${v}`)).map(([k]) => k));
      for (const k of changedKeys) {
        try { execFileSync("git", ["config", "--file", file, "--unset-all", k], { stdio: "ignore" }); } catch { /* gone */ }
        // Put back whatever the user had for this key before the turn.
        for (const [bk, bv] of beforePairs) if (bk === k) execFileSync("git", ["config", "--file", file, "--add", bk, bv], { stdio: "ignore" });
        removed.push(`config ${k}`);
      }
      return removed;
    },
  };
}
