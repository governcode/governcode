// Delegation: the Controller hands a Spec to a Runner. One small socket per Controller turn
// serves only these calls (no Gate answers, no undo); govd checks the Limit, makes a git
// worktree, records Checkpoints, runs the Runner sandboxed to the Spec's scope, and returns the
// result for review. The Runner's own Gates go to the same user terminal as the Controller's.
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { SpecInput, type SettingsValue } from "@governcode/protocol";
import type { Ledger } from "./ledger.ts";
import { reportedTokens, usageComplete, type CountedStore, type LimitGate, type UsageSource } from "./limits.ts";
import { canonical, type GateRequest } from "./claude.ts";
import { applyToProject, changedFiles, createWorkspace, diff, removeWorkspace, safeTarget, snapshot, specPaths } from "./specstore.ts";
import { runCodexTurn } from "./codex.ts";
import { runLocalTurn } from "./local.ts";
import { runAgyTurn } from "./agy.ts";
import { runGrokTurn } from "./grok.ts";
import { mayShare, notesOf, setNotes } from "./memory.ts";
import { runnerAllowed } from "./crew.ts";
import type { CrewValue } from "@governcode/protocol";

/** A Spec this Controller may look at: any, when the project's context is shared with it; else
 *  only the ones its own provider made. */
function mine(ctx: DelegationContext, id: string): boolean {
  if (!ctx.provider || mayShare(ctx.ledger, ctx.project.name, ctx.provider)) return true;
  return ctx.ledger.eventsOfKind(ctx.project.name, ["spec.created"], 5000)
    .some((e) => e.data.spec === id && e.actor === `controller · ${ctx.provider}`);
}

export type PlanItem = { who: string; what: string; scope?: string[] };

/** A game plan as the Controller sent it, checked: 1 to 12 items, short, "me" or a Runner name. */
export function parsePlan(raw: unknown): { items: PlanItem[]; note: string } {
  const p = (raw ?? {}) as { items?: unknown; note?: unknown };
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 12) throw new Error("a plan has 1 to 12 items");
  const items = p.items.map((x: any, i: number) => {
    const who = typeof x?.who === "string" ? x.who.trim().toLowerCase() : "";
    if (!/^[a-z0-9-]{1,40}$/.test(who)) throw new Error(`item ${i + 1}: who must be "me" or a Runner's name`);
    if (typeof x?.what !== "string" || !x.what.trim() || x.what.length > 300) throw new Error(`item ${i + 1}: what must be a short description (under 300 characters)`);
    const scope = Array.isArray(x?.scope) ? x.scope.filter((s: unknown) => typeof s === "string").slice(0, 20).map((s: string) => s.slice(0, 200)) : undefined;
    return { who, what: x.what.trim(), ...(scope?.length ? { scope } : {}) };
  });
  return { items, note: typeof p.note === "string" ? p.note.slice(0, 500) : "" };
}

export type DelegationContext = {
  project: { name: string; path: string };
  provider?: string;                       // the Controller's provider (project memory consent)
  crew?: () => CrewValue;                  // the project's Crew card, read at each call
  alive?: () => boolean;                   // false once the Controller's turn has ended
  turnEnded?: AbortSignal;                 // aborted when that turn ends: its Runners stop too
  plan?: {                                 // this turn's game plan (govd asks the user)
    propose(items: PlanItem[], note: string): Promise<{ answer: string; approved: PlanItem[] }>;
    justYou(): boolean;
  };
  ledger: Ledger;
  limits: LimitGate;
  usage: Record<string, UsageSource>;      // providers that can be Runners, with a usage source
  counted?: CountedStore;                  // every cloud Runner's use, for counted budgets
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
  // "default", "auto" or nothing: the Runner's default (a Controller once guessed "default"),
  // then the same policy as for a named model (security review: an empty model must not skip it).
  if (/^(default|auto)?$/i.test(input.model.trim())) {
    if (!def) return { model: "", effort: input.effort, note: null };
    input = { ...input, model: def.model, effort: input.effort ?? def.effort };
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
    if (method === "controller.plan") {
      if (!ctx.plan) throw new Error("plans are not offered here");
      const { items, note } = parsePlan(params);
      const r = await ctx.plan.propose(items, note);
      return { answer: r.answer, approved: r.approved,
        next: r.answer === "just-you" ? "The user wants you to do this yourself: do not hand anything off in this turn."
          : r.answer === "reject" ? "The user rejected this plan: ask what they want instead, or work within the usual Gates."
          : "Go ahead with the approved items." };
    }
    if (method === "controller.spec_discard") {
      // The Controller may throw away its own proposal (a bad draft it wants to redo). Accepting
      // stays the user's alone.
      const s = ctx.ledger.spec(String((params as any)?.id));
      if (!s || s.project !== ctx.project.name || !mine(ctx, s.id)) throw new Error("no such Spec in this project");
      if (!["needs-review", "failed", "held"].includes(s.status)) throw new Error(`${s.id} is ${s.status}; only a Spec waiting for review, failed or held can be discarded`);
      const shown = { id: s.id, runner: s.to, brief: s.brief };
      if ((await ctx.gate({ id: `discard-${Date.now()}`, tool: "governcode spec_discard", input: shown, canonical: canonical({ tool: "governcode spec_discard", input: shown }) })) !== "allow") {
        throw new Error("the user declined discarding it");
      }
      discard(ctx.stateDir, s.id);
      ctx.ledger.updateSpec(s.id, { status: "undone", note: "discarded by the Controller" }, "controller");
      return { id: s.id, discarded: true };
    }
    if (method === "controller.project_notes") {
      // A Controller the user told to start fresh sees none of the project's shared notes, and
      // cannot overwrite them either.
      if (ctx.provider && !mayShare(ctx.ledger, ctx.project.name, ctx.provider)) {
        throw new Error("the user chose to start this Controller fresh in this project: the project's notes are not shared with it");
      }
      const w = (params as { write?: unknown } | null)?.write;
      if (w === undefined) return { notes: notesOf(ctx.ledger, ctx.project.name).text };
      if (typeof w !== "string") throw new Error("write must be the whole notes, as text");
      const r = setNotes(ctx.ledger, ctx.project.name, w, "controller");
      ctx.notify({ kind: "notes", project: ctx.project.name, chars: r.chars });
      return { saved: true, chars: r.chars };
    }
    if (method === "controller.spec_status") {
      const s = ctx.ledger.spec(String((params as any)?.id));
      if (!s || s.project !== ctx.project.name || !mine(ctx, s.id)) throw new Error("no such Spec in this project");
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
  let closed = false;
  const conns = new Set<Socket>();
  const server: Server = createServer((sock) => {
    if (closed) return sock.destroy();
    conns.add(sock);
    sock.on("close", () => conns.delete(sock));
    sock.on("error", () => sock.destroy());
    // Whatever a tool sends here is untrusted: a line over 1 MB ends the connection, and anything
    // that is not a JSON object with a method gets no reply (never a crash).
    let pending = 0;   // bytes of the line still being received
    sock.on("data", (c: Buffer) => {
      const first = c.indexOf(10);
      if (first < 0) pending += c.length;
      else if (pending + first > 1_000_000) return sock.destroy();   // the line this chunk completes
      else pending = c.length - c.lastIndexOf(10) - 1;               // (lines wholly inside a chunk are under 64 KB)
      if (pending > 1_000_000) sock.destroy();
    });
    const lines = createInterface({ input: sock });
    lines.on("error", () => {});
    lines.on("line", (line) => {
      void (async () => {
        let m: any;
        try { m = JSON.parse(line); } catch { return; }
        if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.method !== "string") return;
        const id = typeof m.id === "number" || typeof m.id === "string" ? m.id : null;
        const reply = (o: object) => { if (sock.writable) sock.write(JSON.stringify({ jsonrpc: "2.0", id, ...o }) + "\n"); };
        try {
          if (closed) throw new Error("this turn has ended");
          reply({ result: await handle(m.method, m.params) });
        } catch (e) {
          reply({ error: { code: 1001, message: e instanceof Error ? e.message : String(e) } });
        }
      })().catch(() => sock.destroy());
    });
  });
  server.listen(path, () => chmodSync(path, 0o600));
  return { path, close: () => { closed = true; server.close(); for (const c of conns) c.destroy(); conns.clear(); rmSync(path, { force: true }); } };
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
  const card = ctx.crew?.();
  if (card?.handoff === "off") return { runners: [], handoff: "off", note: "The user turned handing off off for this project: work alone." };
  for (const provider of Object.keys(ctx.usage)) {
    if (card?.runners && !card.runners.includes(provider)) continue;
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
  // The Crew card, "just you" and the turn itself are checked now and again after every wait:
  // an answer or a setting can change while this call is waiting.
  const stillAllowed = () => {
    if (ctx.alive && !ctx.alive()) throw new Error("the Controller's turn has ended");
    if (ctx.plan?.justYou()) throw new Error("the user answered your plan with \"just you\": do this yourself, do not hand off in this turn");
    const card = ctx.crew?.();
    const no = card ? runnerAllowed(card, input.to) : null;
    if (no) throw new Error(no);
    return card;
  };
  let capNote: string | null = null;
  const asked = input.budgetPercent;
  // The card's cap for this Runner, applied again after every wait (it may have been lowered).
  const applyCap = (card: CrewValue | undefined) => {
    const cap = card?.maxPercent[input.to];
    if (cap !== undefined && input.budgetPercent > cap) { input.budgetPercent = cap; capNote = `budget capped at ${cap}% by the Crew card (asked ${asked}%)`; }
  };
  applyCap(stillAllowed());
  const picked = specModel(input, ctx.settings?.());
  input.model = picked.model; input.effort = picked.effort;
  // ponytail: the Antigravity Runner's Limit reads its Gemini pool, so it runs Gemini models only;
  // Claude and GPT through Antigravity have their own pool. Upgrade: a Limit per model group.
  if (input.to === "agy" && input.model && !/^gemini[a-z0-9.\- ()]*$/i.test(input.model)) {
    throw new Error("the Antigravity Runner runs Gemini models (its Limit reads the Gemini pool); name a Gemini model or leave model empty");
  }
  // The handoff itself is decided here, in govd, however the call arrived (the tool's own
  // permission prompt is not the boundary: Codex's review). A local model is a kind the user can
  // allow; a paid Runner asks, unless an item of the plan the user approved covers it.
  const shown = { to: input.to, brief: input.brief, result: input.result, scope: input.scope, budgetPercent: input.budgetPercent,
    model: input.model || "(the Runner's default)", effort: input.effort, reason: input.reason };
  if ((await ctx.gate({ id: `handoff-${Date.now()}`, tool: "governcode delegate", input: shown, canonical: canonical({ tool: "governcode delegate", input: shown }) })) !== "allow") {
    throw new Error("the user declined this handoff");
  }
  applyCap(stillAllowed());
  const spec = L.createSpec(ctx.project.name, input, ctx.provider ? `controller · ${ctx.provider}` : "controller");
  const notes = [capNote, picked.note].filter(Boolean).join("; ");
  if (notes) L.updateSpec(spec.id, { note: notes }, "govd");
  ctx.notify({ kind: "spec", id: spec.id, to: spec.to, brief: spec.brief });

  // 1. The Limit, from a fresh measurement.
  await measured(ctx, input.to);
  try {
    const before = input.budgetPercent;
    applyCap(stillAllowed());
    if (input.budgetPercent !== before) L.updateSpec(spec.id, { note: capNote! }, "govd");
  } catch (e) { L.updateSpec(spec.id, { status: "failed", note: e instanceof Error ? e.message : String(e) }, "govd"); throw e; }
  const verdict = ctx.limits.admit(spec.id, input.to, input.budgetPercent);
  if (!verdict.ok) {
    L.updateSpec(spec.id, { status: "held", note: verdict.reason }, "govd");
    return { id: spec.id, status: "held", reason: `${input.to} is ${verdict.reason}`, resetsAt: verdict.resetsAt };
  }

  let poll: ReturnType<typeof setInterval> | undefined;
  let ran = false, runUsage: unknown;   // a cloud Runner was started: its use counts, whatever the outcome
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
    let steps = 0;
    // While it runs, the Limit is re-measured; crossing it stops the Runner (a measured hold,
    // so a little overshoot between readings is possible, never a free run).
    const stop = new AbortController();
    // The Controller's turn ending stops its Runners: nothing of a finished turn keeps running or asking.
    if (ctx.turnEnded?.aborted) stop.abort("the Controller's turn ended");
    ctx.turnEnded?.addEventListener("abort", () => stop.abort("the Controller's turn ended"), { once: true });
    poll = setInterval(async () => {
      await measured(ctx, input.to);
      const v = ctx.limits.stillWithin(spec.id);
      if (!v.ok) { ctx.notify({ kind: "spec.text", id: spec.id, text: `Limit: ${v.reason}; stopping.` }); stop.abort(v.reason); }
    }, POLL_MS);
    const local = ctx.limits.localRule(input.to);
    const result = await new Promise<{ ok: boolean; summary: string; usage?: unknown }>((done) => {
      // Already stopped (the turn ended while this handoff waited): nothing starts.
      if (stop.signal.aborted) { done({ ok: false, summary: `stopped: ${String(stop.signal.reason ?? "aborted")}` }); return; }
      if (local) {
        // No tools and no commands: govd itself writes the model's proposed files, checked against the scope.
        const model = input.model || ctx.usage[input.to].models?.()[0] || "";
        if (!model) { done({ ok: false, summary: "no local model is installed (ollama pull a model first)" }); return; }
        runLocalTurn({ model, work: paths.work, scope: input.scope, prompt, maxMinutes: local.maxMinutes, signal: stop.signal,
          hooks: { text: (t) => { texts.push(t); ctx.notify({ kind: "spec.text", id: spec.id, text: t }); }, done } })
          .catch((e) => done({ ok: false, summary: `the local Runner failed: ${e instanceof Error ? e.message : e}` }));   // never an unhandled rejection
        return;
      }
      const hooks = {
        text: (t: string) => { texts.push(t); ctx.notify({ kind: "spec.text", id: spec.id, text: t }); },
        tool: (name: string) => {
          ctx.notify({ kind: "spec.tool", id: spec.id, name });
          // Each Runner step is on the record too (the Crew board shows the latest), up to 200 per
          // Spec, then one line saying the rest were not recorded: a runaway Runner cannot fill the Trace.
          steps++;
          if (steps <= 200) L.append(ctx.project.name, "spec.step", `runner · ${input.to} · ${spec.id}`, { spec: spec.id, name: name.slice(0, 80) });
          else if (steps === 201) L.append(ctx.project.name, "spec.step", "govd", { spec: spec.id, name: "(later steps not recorded)" });
        },
        gate: (req: GateRequest) => ctx.gate({ ...req, tool: `${req.tool} (Runner · ${input.to}, ${spec.id})`, actor: `runner · ${input.to} · ${spec.id}`,
          base: req.tool, spec: spec.id }),
        done,
      };
      // Written down before it starts. With a counted budget, a count that cannot be written stops
      // it here (throws); without one, the Runner runs and is counted in memory.
      const budget = ctx.settings?.().budgets?.[input.to];
      ctx.counted?.begin(spec.id, input.to, !!budget && Object.keys(budget.windows).length > 0);
      ran = true;
      if (input.to === "agy") {
        void runAgyTurn({ supervisor: ctx.supervisor, policyDir: ctx.policyDir, stateDir: ctx.stateDir, runtimeDir: ctx.runtimeDir,
          worktree: paths.work, writePaths, model: input.model, effort: input.effort, prompt, signal: stop.signal, hooks,
          noSubagents: ctx.crew?.()?.subagents.runners === false,
          openSocket: (h) => openTurnSocket(ctx.runtimeDir, h) })
          .catch((e) => done({ ok: false, summary: `the Antigravity Runner failed: ${e instanceof Error ? e.message : e}` }));
        return;
      }
      if (input.to === "grok") {
        void runGrokTurn({ supervisor: ctx.supervisor, policyDir: ctx.policyDir, stateDir: ctx.stateDir, worktree: paths.work, writePaths,
          model: input.model, effort: input.effort, prompt, signal: stop.signal, hooks, noSubagents: ctx.crew?.()?.subagents.runners === false })
          .catch((e) => done({ ok: false, summary: `the Grok Runner failed: ${e instanceof Error ? e.message : e}` }));
        return;
      }
      void runCodexTurn({ supervisor: ctx.supervisor, policyDir: ctx.policyDir, stateDir: ctx.stateDir, worktree: paths.work,
        writePaths, model: input.model, effort: input.effort, prompt, signal: stop.signal, hooks, noSubagents: ctx.crew?.()?.subagents.runners === false });
    });
    clearInterval(poll);
    runUsage = result.usage;
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
    // Counted before the Limit is released, so the next check already sees it.
    if (ran) ctx.counted?.settle(spec.id, reportedTokens(runUsage), usageComplete(runUsage));
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
