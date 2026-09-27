// Delegation: the Controller hands a Spec to a Runner. One small socket per Controller turn
// serves only these calls (no Gate answers, no undo); govd checks the Limit, makes a git
// worktree, records Checkpoints, runs the Runner sandboxed to the Spec's scope, and returns the
// result for review. The Runner's own Gates go to the same user terminal as the Controller's.
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { SpecInput, type Spec } from "@governcode/protocol";
import type { Ledger } from "./ledger.ts";
import type { LimitGate, UsageSource } from "./limits.ts";
import type { GateRequest } from "./claude.ts";
import * as cp from "./checkpoint.ts";
import { runCodexTurn } from "./codex.ts";

export type DelegationContext = {
  project: { name: string; path: string };
  ledger: Ledger;
  limits: LimitGate;
  usage: Record<string, UsageSource>;      // providers that can be Runners, with a usage source
  runtimeDir: string;
  supervisor: string; policyDir: string; stateDir: string;
  gate(req: GateRequest): Promise<"allow" | "deny">;   // the user's terminal
  notify(n: unknown): void;
};

const MEASURE_TTL = 5 * 60_000;

/** Opens the per-turn socket; returns its path and a close(). */
export function openControllerSocket(ctx: DelegationContext): { path: string; close(): void } {
  const dir = join(ctx.runtimeDir, "turns");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${randomBytes(12).toString("hex")}.sock`);
  const server: Server = createServer((sock) => {
    createInterface({ input: sock }).on("line", async (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      const reply = (o: object) => sock.writable && sock.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }) + "\n");
      try {
        if (m.method === "controller.delegate") return reply({ result: await delegate(ctx, m.params) });
        if (m.method === "controller.crew") return reply({ result: await crew(ctx) });
        if (m.method === "controller.spec_status") {
          const s = ctx.ledger.spec(String(m.params?.id));
          if (!s || s.project !== ctx.project.name) throw new Error("no such Spec in this project");
          return reply({ result: { id: s.id, status: s.status, files: s.files, note: s.note } });
        }
        throw new Error(`not offered to the Controller: ${m.method}`);
      } catch (e) {
        reply({ error: { code: 1001, message: e instanceof Error ? e.message : String(e) } });
      }
    });
  });
  server.listen(path, () => chmodSync(path, 0o600));
  return { path, close: () => { server.close(); rmSync(path, { force: true }); } };
}

async function measured(ctx: DelegationContext, provider: string): Promise<void> {
  const src = ctx.usage[provider];
  if (!src) return;
  const m = await src.read();
  if (m) ctx.limits.record(m);
}

async function crew(ctx: DelegationContext) {
  const out = [];
  for (const provider of Object.keys(ctx.usage)) {
    await measured(ctx, provider);
    const probe = ctx.limits.admit(`probe-${provider}`, provider, 1);
    ctx.limits.release(`probe-${provider}`);
    out.push({ provider, available: probe.ok, ...(probe.ok ? {} : { reason: probe.reason, resetsAt: probe.resetsAt }) });
  }
  return { runners: out };
}

/** Scope paths are relative to the project and must stay inside it. */
function inside(root: string, p: string): string {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`scope path ${p} leaves the project`);
  return abs;
}

async function delegate(ctx: DelegationContext, raw: unknown) {
  const input = SpecInput.parse(raw);
  const L = ctx.ledger;
  if (!ctx.usage[input.to]) throw new Error(`${input.to} is not a Runner GovernCode can use (known: ${Object.keys(ctx.usage).join(", ") || "none"})`);
  const spec = L.createSpec(ctx.project.name, input, "controller");
  ctx.notify({ kind: "spec", id: spec.id, to: spec.to, brief: spec.brief });

  // 1. The Limit, from a fresh measurement.
  await measured(ctx, input.to);
  const verdict = ctx.limits.admit(spec.id, input.to, input.budgetPercent);
  if (!verdict.ok) {
    L.updateSpec(spec.id, { status: "held", note: verdict.reason }, "govd");
    return { id: spec.id, status: "held", reason: `${input.to} is ${verdict.reason}`, resetsAt: verdict.resetsAt };
  }

  try {
    // 2. Its own worktree, on its own branch, from the project's HEAD.
    const project = ctx.project.path;
    let head = "";
    try { head = execFileSync("git", ["-C", project, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* none */ }
    if (!head) throw new Error("the project has no commit yet; commit once so a Runner can work from it");
    const worktree = join(project, ".gov", "worktrees", spec.id);
    const exclude = join(project, ".git", "info", "exclude");
    if (existsSync(join(project, ".git")) && !(existsSync(exclude) && readFileSync(exclude, "utf8").includes("/.gov/"))) {
      mkdirSync(join(project, ".git", "info"), { recursive: true });
      appendFileSync(exclude, "\n/.gov/\n");
    }
    execFileSync("git", ["-C", project, "worktree", "add", "-q", "-b", `gov/${spec.id}`, worktree, head], { stdio: "ignore" });

    // 3. Checkpoint, run the Runner sandboxed to the scope, checkpoint again.
    const before = cp.take(worktree, spec.id, "before");
    const writePaths = input.scope.write.length ? input.scope.write.map((p) => inside(worktree, p)) : [worktree];
    for (const p of writePaths) mkdirSync(p, { recursive: true });
    L.updateSpec(spec.id, { status: "running", checkpoints: { before, after: null } }, "govd");
    const prompt = `${input.brief}\n\nDone means: ${input.result}\n\nYou may change only: ${input.scope.write.length ? input.scope.write.join(", ") : "anything in this worktree"}.`;
    const texts: string[] = [];
    const result = await new Promise<{ ok: boolean; summary: string }>((done) => {
      void runCodexTurn({ supervisor: ctx.supervisor, policyDir: ctx.policyDir, stateDir: ctx.stateDir, worktree,
        writePaths, gitDir: join(project, ".git"), model: input.model, effort: input.effort, prompt,
        hooks: {
          text: (t) => { texts.push(t); ctx.notify({ kind: "spec.text", id: spec.id, text: t }); },
          tool: (name) => ctx.notify({ kind: "spec.tool", id: spec.id, name }),
          gate: (req) => ctx.gate({ ...req, tool: `${req.tool} (Runner · ${input.to}, ${spec.id})`, actor: `runner · ${input.to} · ${spec.id}` }),
          done,
        } });
    });
    const after = cp.take(worktree, spec.id, "after");
    const files = before && after ? cp.changed(worktree, before, after) : [];
    const diff = files.length ? cp.diff(worktree, spec.id) : "";
    const status = result.ok ? "needs-review" : "failed";
    L.updateSpec(spec.id, { status, files, checkpoints: { before, after }, note: result.ok ? undefined : result.summary }, "govd");
    return { id: spec.id, status, runner: input.to, files, summary: texts.join("\n").slice(-4000),
      diff: diff.length > 20_000 ? diff.slice(0, 20_000) + "\n… (diff truncated; the user sees it in full with gov diff)" : diff,
      review: `The user reviews with gov diff ${spec.id} and applies with gov accept ${spec.id}.` };
  } catch (e) {
    L.updateSpec(spec.id, { status: "failed", note: e instanceof Error ? e.message : String(e) }, "govd");
    throw e;
  } finally {
    ctx.limits.release(spec.id);
  }
}

/** The user accepts a Spec: its changes are applied to the project's working tree. */
export function accept(projectPath: string, specId: string): string[] {
  const patch = execFileSync("git", ["-C", projectPath, "diff", "--binary", `refs/governcode/specs/${specId}/before`, `refs/governcode/specs/${specId}/after`]);
  if (!patch.length) return [];
  execFileSync("git", ["-C", projectPath, "apply", "-"], { input: patch });
  return execFileSync("git", ["-C", projectPath, "diff", "--name-only", `refs/governcode/specs/${specId}/before`, `refs/governcode/specs/${specId}/after`], { encoding: "utf8" }).split("\n").filter(Boolean);
}

/** Remove a Spec's worktree and branch (its Checkpoints stay in the Trace). */
export function discard(projectPath: string, specId: string): void {
  const wt = join(projectPath, ".gov", "worktrees", specId);
  try { execFileSync("git", ["-C", projectPath, "worktree", "remove", "--force", wt], { stdio: "ignore" }); } catch { /* gone */ }
  try { execFileSync("git", ["-C", projectPath, "branch", "-D", `gov/${specId}`], { stdio: "ignore" }); } catch { /* gone */ }
}
