// Delegation: the Controller hands a Spec to a Runner. One small socket per Controller turn
// serves only these calls (no Gate answers, no undo); govd checks the Limit, makes a git
// worktree, records Checkpoints, runs the Runner sandboxed to the Spec's scope, and returns the
// result for review. The Runner's own Gates go to the same user terminal as the Controller's.
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SpecInput } from "@governcode/protocol";
import type { Ledger } from "./ledger.ts";
import type { LimitGate, UsageSource } from "./limits.ts";
import type { GateRequest } from "./claude.ts";
import { applyToProject, changedFiles, createWorkspace, diff, removeWorkspace, safeTarget, snapshot, specPaths } from "./specstore.ts";
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

const POLL_MS = Number(process.env.GOVERNCODE_LIMIT_POLL_MS ?? 120_000);

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
  // A failed reading must not leave an old one standing: unknown usage holds.
  if (m) ctx.limits.record(m); else ctx.limits.forget(provider);
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

  let poll: ReturnType<typeof setInterval> | undefined;
  try {
    // 2. Its own workspace in govd's state (out of every AI tool's reach): the project's
    //    committed HEAD, exported without filters, with its own git dir for snapshots.
    const project = ctx.project.path;
    let head = "";
    try { head = execFileSync("git", ["-C", project, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* none */ }
    if (!head) throw new Error("the project has no commit yet; commit once so a Runner can work from it");
    const paths = specPaths(ctx.stateDir, spec.id);
    createWorkspace(project, paths);

    // 3. Scope: real directories inside the workspace, never through a symlink.
    const writePaths = input.scope.write.length ? input.scope.write.map((p) => safeTarget(paths.work, p.replace(/^\.\/+/, "").replace(/\/+$/, ""))) : [paths.work];
    for (const p of writePaths) mkdirSync(p, { recursive: true });
    const before = snapshot(paths, "before");
    L.updateSpec(spec.id, { status: "running", checkpoints: { before, after: null } }, "govd");
    const prompt = `${input.brief}\n\nDone means: ${input.result}\n\nYou may change only: ${input.scope.write.length ? input.scope.write.join(", ") : "anything in this workspace"}.`;
    const texts: string[] = [];
    // While it runs, the Limit is re-measured; crossing it stops the Runner (a measured hold,
    // so a little overshoot between readings is possible, never a free run).
    const stop = new AbortController();
    poll = setInterval(async () => {
      await measured(ctx, input.to);
      const v = ctx.limits.stillWithin(spec.id);
      if (!v.ok) { ctx.notify({ kind: "spec.text", id: spec.id, text: `Limit: ${v.reason}; stopping.` }); stop.abort(v.reason); }
    }, POLL_MS);
    const result = await new Promise<{ ok: boolean; summary: string }>((done) => {
      void runCodexTurn({ supervisor: ctx.supervisor, policyDir: ctx.policyDir, stateDir: ctx.stateDir, worktree: paths.work,
        writePaths, model: input.model, effort: input.effort, prompt, signal: stop.signal,
        hooks: {
          text: (t) => { texts.push(t); ctx.notify({ kind: "spec.text", id: spec.id, text: t }); },
          tool: (name) => ctx.notify({ kind: "spec.tool", id: spec.id, name }),
          gate: (req) => ctx.gate({ ...req, tool: `${req.tool} (Runner · ${input.to}, ${spec.id})`, actor: `runner · ${input.to} · ${spec.id}` }),
          done,
        } });
    });
    clearInterval(poll);
    const after = snapshot(paths, "after", before);
    const files = changedFiles(paths, before, after);
    // The sandbox should already stop it, but a change outside the scope is never offered.
    const scopes = input.scope.write.map((w) => w.replace(/^\.\/+/, "").replace(/\/+$/, ""));
    const outside = scopes.length ? files.filter((f) => !scopes.some((w) => f === w || f.startsWith(w + "/"))) : [];
    const ok = result.ok && !outside.length;
    const note = outside.length ? `changed files outside its scope: ${outside.join(", ")}` : result.ok ? undefined : result.summary;
    L.updateSpec(spec.id, { status: ok ? "needs-review" : "failed", files, checkpoints: { before, after }, note }, "govd");
    const d = files.length ? diff(paths, before, after) : "";
    return { id: spec.id, status: ok ? "needs-review" : "failed", runner: input.to, files, ...(note ? { note } : {}),
      summary: texts.join("\n").slice(-4000),
      diff: d.length > 20_000 ? d.slice(0, 20_000) + "\n… (diff truncated; the user sees it in full with gov diff)" : d,
      review: `The user reviews with gov diff ${spec.id} and applies with gov accept ${spec.id}.` };
  } catch (e) {
    L.updateSpec(spec.id, { status: "failed", note: e instanceof Error ? e.message : String(e) }, "govd");
    throw e;
  } finally {
    clearInterval(poll);
    ctx.limits.release(spec.id);
  }
}

/** The user accepts a Spec: exactly the reviewed after-state of its files, if the project still
 *  holds their before-state. Bound to the snapshot ids stored on the Spec, not to any ref. */
export function accept(stateDir: string, projectPath: string, spec: { id: string; checkpoints: { before: string | null; after: string | null } }): string[] {
  const { before, after } = spec.checkpoints;
  if (!before || !after) throw new Error(`${spec.id} has no complete snapshot`);
  return applyToProject(specPaths(stateDir, spec.id), projectPath, before, after);
}

/** Remove a Spec's workspace (its snapshots stay, for the record). */
export function discard(stateDir: string, specId: string): void {
  removeWorkspace(specPaths(stateDir, specId));
}
