// Delegation: the Controller hands a Spec to a Runner. One small socket per Controller turn
// serves only these calls (no Gate answers, no undo); govd checks the Limit, makes a git
// worktree, records Checkpoints, runs the Runner sandboxed to the Spec's scope, and returns the
// result for review. The Runner's own Gates go to the same user terminal as the Controller's.
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { SpecInput, type SettingsValue } from "@governcode/protocol";
import type { Ledger } from "./ledger.ts";
import type { LimitGate, UsageSource } from "./limits.ts";
import type { GateRequest } from "./claude.ts";
import { applyToProject, changedFiles, createWorkspace, diff, removeWorkspace, safeTarget, snapshot, specPaths } from "./specstore.ts";
import { runCodexTurn } from "./codex.ts";
import { runLocalTurn } from "./local.ts";

export type DelegationContext = {
  project: { name: string; path: string };
  ledger: Ledger;
  limits: LimitGate;
  usage: Record<string, UsageSource>;      // providers that can be Runners, with a usage source
  runtimeDir: string;
  supervisor: string; policyDir: string; stateDir: string;
  gate(req: GateRequest): Promise<"allow" | "deny">;   // the user's terminal
  notify(n: unknown): void;
  settings?: () => SettingsValue;                    // read at each call: Settings may change mid-turn
};

const EFFORT_ORDER = ["low", "medium", "high", "max"] as const;

/**
 * The model and effort a Spec actually gets: the Controller's pick is a request, and the user's
 * Settings decide how far it may depart from the Runner's defaults. Returns why, if it changed.
 */
export function specModel(input: { to: string; model: string; effort: SpecInput["effort"] }, s: Pick<SettingsValue, "runners" | "specModels"> | undefined):
    { model: string; effort: SpecInput["effort"]; note: string | null } {
  const def = s?.runners[input.to];
  // "default", "auto" or nothing: the Runner's default (a Controller once guessed "default").
  if (/^(default|auto)?$/i.test(input.model.trim())) {
    return def ? { model: def.model, effort: input.effort ?? def.effort, note: null } : { model: "", effort: input.effort, note: null };
  }
  if (!def || !s || s.specModels === "free") return { model: input.model, effort: input.effort, note: null };
  if (s.specModels === "defaults") {
    const same = def.model === input.model && def.effort === input.effort;
    return { model: def.model, effort: def.effort, note: same ? null : `model and effort set by your Settings (asked ${input.model} · ${input.effort ?? "n/a"})` };
  }
  // within: the default model; effort no heavier than the default (lighter is fine).
  const rank = (e: SpecInput["effort"]) => (e === null ? -1 : EFFORT_ORDER.indexOf(e));
  const effort = def.effort !== null && (input.effort === null || rank(input.effort) > rank(def.effort)) ? def.effort : input.effort;
  const changed = input.model !== def.model || effort !== input.effort;
  return { model: def.model, effort, note: changed ? `kept within your Settings' defaults (asked ${input.model} · ${input.effort ?? "n/a"})` : null };
}

const POLL_MS = Number(process.env.GOVERNCODE_LIMIT_POLL_MS ?? 120_000);

/** Opens the per-turn socket; returns its path and a close(). */
export function openControllerSocket(ctx: DelegationContext): { path: string; close(): void } {
  return openTurnSocket(ctx.runtimeDir, async (method, params) => {
    if (method === "controller.delegate") return delegate(ctx, params);
    if (method === "controller.crew") return crew(ctx);
    if (method === "controller.spec_discard") {
      // The Controller may throw away its own proposal (a bad draft it wants to redo). Accepting
      // stays the user's alone.
      const s = ctx.ledger.spec(String((params as any)?.id));
      if (!s || s.project !== ctx.project.name) throw new Error("no such Spec in this project");
      if (!["needs-review", "failed", "held"].includes(s.status)) throw new Error(`${s.id} is ${s.status}; only a Spec waiting for review, failed or held can be discarded`);
      discard(ctx.stateDir, s.id);
      ctx.ledger.updateSpec(s.id, { status: "undone", note: "discarded by the Controller" }, "controller");
      return { id: s.id, discarded: true };
    }
    if (method === "controller.spec_status") {
      const s = ctx.ledger.spec(String((params as any)?.id));
      if (!s || s.project !== ctx.project.name) throw new Error("no such Spec in this project");
      return { id: s.id, status: s.status, files: s.files, note: s.note };
    }
    throw new Error(`not offered to the Controller: ${method}`);
  });
}

/** A socket that exists for one Controller turn and answers only what `handle` offers. */
export function openTurnSocket(runtimeDir: string, handle: (method: string, params: unknown) => Promise<unknown>): { path: string; close(): void } {
  const dir = join(runtimeDir, "turns");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${randomBytes(12).toString("hex")}.sock`);
  const server: Server = createServer((sock) => {
    sock.on("error", () => sock.destroy());
    const lines = createInterface({ input: sock });
    lines.on("error", () => {});
    lines.on("line", async (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      const reply = (o: object) => sock.writable && sock.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...o }) + "\n");
      try {
        reply({ result: await handle(String(m.method), m.params) });
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
  if (m) ctx.limits.record(m); else ctx.limits.forget(provider, src.why?.());
}

async function crew(ctx: DelegationContext) {
  const out = [];
  for (const provider of Object.keys(ctx.usage)) {
    await measured(ctx, provider);
    const probe = ctx.limits.check(provider);
    const def = ctx.settings?.().runners[provider];
    const local = ctx.limits.localRule(provider);
    out.push({ provider, available: probe.ok, ...(probe.ok ? {} : { reason: probe.reason, resetsAt: probe.resetsAt }),
      ...(def ? { defaultModel: def.model, defaultEffort: def.effort } : {}),
      ...(local ? { local: true, models: ctx.usage[provider].models?.() ?? [], limit: `at most ${local.maxRunning} at once, ${local.maxMinutes} min each`,
        note: "A local model: no tools, no commands. It sees the files in the Spec's scope and proposes whole new file contents, " +
          "which GovernCode checks against the write scope. Best for small, well-scoped jobs (docs, comments, small fixes); " +
          "keep the scope to a few small files. effort does not apply (use null); budgetPercent is ignored." } : {}) });
  }
  const policy = ctx.settings?.().specModels ?? "free";
  return { runners: out, modelPolicy: policy === "free" ? "pick model and effort per Spec"
    : policy === "within" ? "use each Runner's default model; effort may be lower than its default, never higher"
    : "each Runner always uses its default model and effort" };
}


async function delegate(ctx: DelegationContext, raw: unknown) {
  const input = SpecInput.parse(raw);
  const L = ctx.ledger;
  if (!ctx.usage[input.to]) throw new Error(`${input.to} is not a Runner GovernCode can use (known: ${Object.keys(ctx.usage).join(", ") || "none"})`);
  const picked = specModel(input, ctx.settings?.());
  input.model = picked.model; input.effort = picked.effort;
  const spec = L.createSpec(ctx.project.name, input, "controller");
  if (picked.note) L.updateSpec(spec.id, { note: picked.note }, "govd");
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

    // 3. Scope: real directories or files inside the workspace, never through a symlink. A scope
    //    entry that is an existing file stays a file (a file-level sandbox rule); a new file name
    //    (it has an extension) gets an empty placeholder after the before-snapshot, removed again
    //    if the Runner leaves it empty, so it never shows up as a change.
    const writePaths = input.scope.write.length ? input.scope.write.map((p) => safeTarget(paths.work, p.replace(/^\.\/+/, "").replace(/\/+$/, ""))) : [paths.work];
    // ponytail: a new scope entry is a file when it ends without "/" and looks like one (an
    // extension, or a common extensionless file name); otherwise a folder. Upgrade to an explicit
    // file/folder field in the Spec if this guesses wrong in practice.
    const placeholders: Array<{ path: string; mtime: bigint }> = [];
    input.scope.write.forEach((raw, i) => {
      const p = writePaths[i];
      if (existsSync(p)) return;
      const isFile = !raw.endsWith("/") && (/\.[A-Za-z0-9]{1,10}$/.test(p) || /^(Dockerfile|Makefile|Justfile|Rakefile|Gemfile|Procfile|LICENSE|README|CHANGELOG|NOTICE|AUTHORS|CODEOWNERS)$/.test(basename(p)));
      if (isFile) { mkdirSync(dirname(p), { recursive: true }); placeholders.push({ path: p, mtime: 0n }); }
      else mkdirSync(p, { recursive: true });
    });
    const before = snapshot(paths, "before");
    for (const ph of placeholders) { writeFileSync(ph.path, "", { flag: "wx" }); ph.mtime = statSync(ph.path, { bigint: true }).mtimeNs; }
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
    const local = ctx.limits.localRule(input.to);
    const result = await new Promise<{ ok: boolean; summary: string }>((done) => {
      if (local) {
        // No tools and no commands: govd itself writes the model's proposed files, checked against the scope.
        const model = input.model || ctx.usage[input.to].models?.()[0] || "";
        if (!model) { done({ ok: false, summary: "no local model is installed (ollama pull a model first)" }); return; }
        runLocalTurn({ model, work: paths.work, scope: input.scope, prompt, maxMinutes: local.maxMinutes, signal: stop.signal,
          hooks: { text: (t) => { texts.push(t); ctx.notify({ kind: "spec.text", id: spec.id, text: t }); }, done } })
          .catch((e) => done({ ok: false, summary: `the local Runner failed: ${e instanceof Error ? e.message : e}` }));   // never an unhandled rejection
        return;
      }
      void runCodexTurn({ supervisor: ctx.supervisor, policyDir: ctx.policyDir, stateDir: ctx.stateDir, worktree: paths.work,
        writePaths, model: input.model, effort: input.effort, prompt, signal: stop.signal,
        hooks: {
          text: (t) => { texts.push(t); ctx.notify({ kind: "spec.text", id: spec.id, text: t }); },
          tool: (name) => ctx.notify({ kind: "spec.tool", id: spec.id, name }),
          gate: (req) => ctx.gate({ ...req, tool: `${req.tool} (Runner · ${input.to}, ${spec.id})`, actor: `runner · ${input.to} · ${spec.id}`,
            base: req.tool, spec: spec.id }),
          done,
        } });
    });
    clearInterval(poll);
    // An untouched placeholder (still empty, same timestamp) was never the Runner's: remove it.
    // An empty file the Runner wrote on purpose (__init__.py, .gitkeep) has a new timestamp and stays.
    for (const ph of placeholders) {
      try { const st = statSync(ph.path, { bigint: true }); if (st.size === 0n && st.mtimeNs === ph.mtime) rmSync(ph.path); } catch { /* the Runner removed it */ }
    }
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
