// The policies govd actually hands AI tools, checked on this machine at startup (Rattle: the
// self-test certified its own fixture, not claudePolicy/codexPolicy). Harmless probes run under
// the real policy for a scratch project: the tool's own settings and other projects'
// transcripts must be out of reach, the project writable, govd's socket unreachable.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudePolicy, type Policy } from "./claude.ts";

type Probe = { name: string; code: string; expect: "ok" | "refused"; when?: () => boolean };

// Each probe is a tiny Python snippet that prints "ok" if the action worked, "refused" if not.
const py = (body: string) => `import os, socket, sys
try:
${body.split("\n").map((l) => "    " + l).join("\n")}
    print("ok")
except OSError:
    print("refused")`;

export function policyProbes(project: string, daemonSocket: string): Probe[] {
  const home = homedir(), cfg = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return [
    { name: "write inside the project", expect: "ok", code: py(`open(${JSON.stringify(join(project, "probe.txt"))}, "w").write("x")`) },
    { name: "write ~/.claude.json (the tool's own allow-list)", expect: "refused", when: () => existsSync(join(home, ".claude.json")),
      code: py(`open(${JSON.stringify(join(home, ".claude.json"))}, "a").close()`) },
    { name: "write the tool's settings.json", expect: "refused", when: () => existsSync(join(cfg, "settings.json")),
      code: py(`open(${JSON.stringify(join(cfg, "settings.json"))}, "a").close()`) },
    { name: "list other projects' transcripts", expect: "refused", when: () => existsSync(join(cfg, "projects")),
      code: py(`os.listdir(${JSON.stringify(join(cfg, "projects"))})`) },
    { name: "write in the home folder outside the project", expect: "refused",
      code: py(`open(${JSON.stringify(join(home, ".governcode-policy-probe"))}, "w").write("x")`) },
    { name: "connect to govd's socket", expect: "refused", when: () => existsSync(daemonSocket),
      code: py(`s = socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(daemonSocket)})`) },
  ];
}

/** Returns the probes that did not behave; empty means the real policy holds here. */
export function checkClaudePolicy(supervisor: string, policyDir: string, daemonSocket: string): string[] {
  let policy: Policy;
  const scratch = mkdtempSync(join(tmpdir(), "governcode-policycheck-"));
  const project = join(scratch, "project"), sessionTmp = join(scratch, "tmp");
  mkdirSync(project); mkdirSync(sessionTmp);
  try {
    try { policy = claudePolicy(project, sessionTmp); } catch { return []; }   // no Claude Code installed: nothing to check
    const probeFile = join(policyDir, `policycheck-${process.pid}.json`);
    mkdirSync(policyDir, { recursive: true, mode: 0o700 });
    writeFileSync(probeFile, JSON.stringify(policy), { mode: 0o600 });
    const bad: string[] = [];
    for (const p of policyProbes(project, daemonSocket)) {
      if (p.when && !p.when()) continue;
      const r = spawnSync(supervisor, ["run", "--policy", probeFile, "--", "/usr/bin/python3", "-c", p.code], { encoding: "utf8", timeout: 20_000 });
      const got = (r.stdout ?? "").trim().split("\n").pop();
      if (got !== p.expect) bad.push(`${p.name}: expected ${p.expect}, got ${got || r.stderr?.trim().slice(-120) || "nothing"}`);
    }
    rmSync(probeFile, { force: true });
    return bad;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(join(homedir(), ".governcode-policy-probe"), { force: true });
  }
}
