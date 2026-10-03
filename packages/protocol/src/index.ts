// The wire contract between govd and its clients (the gov CLI now; the Dashboard and the
// Pager later). JSON-RPC 2.0, one JSON object per line. Clients check `features` from
// `hello`, never the version number.
import { z } from "zod";

export const PROTOCOL = 1;
export const FEATURES = ["projects", "trace", "ask", "gates", "home", "delegate", "specs", "watch", "parallel-specs", "recovery"] as const;

export const Effort = z.enum(["low", "medium", "high", "max"]);

export const ControllerChoice = z.object({
  provider: z.enum(["claude-code", "codex"]),
  model: z.string().min(1).max(80),
  effort: Effort.nullable(),
});
export type ControllerChoice = z.infer<typeof ControllerChoice>;

export const ProjectName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/,
  "a project name uses lowercase letters, digits, . _ - and starts with a letter or digit, at most 63 characters (e.g. my-app)");

// A Spec: one delegated job, written down before it runs (phase 1). The Controller fills it
// in; govd checks it against the Limit, turns `scope` into the sandbox policy, and records
// Checkpoints before and after.
export const SpecInput = z.object({
  to: z.string().min(1).max(40),                        // Runner provider, e.g. "codex"
  brief: z.string().min(1).max(20_000),
  result: z.string().min(1).max(4_000),                  // acceptance: what "done" means
  scope: z.object({
    read: z.array(z.string().min(1)).max(50).default([]),
    write: z.array(z.string().min(1)).max(50).default([]),
  }),
  budgetPercent: z.number().min(1).max(100).default(10), // a request; govd clamps it
  workspace: z.enum(["worktree", "shared"]).default("worktree"),
  // Empty: the Runner's default (the user's Settings, else the tool's own). The Controller need
  // not know model names.
  model: z.string().max(80).default(""),
  effort: Effort.nullable().default(null),
  reason: z.string().min(1).max(2_000),                  // why this Runner, shown to the user
  // async: the call returns at once and the Spec runs on its own (the Controller is told when it
  // finishes); wait: the call returns the result, or after waitSeconds says it is still running.
  mode: z.enum(["async", "wait"]).default("async"),
  waitSeconds: z.number().int().min(10).max(3300).default(600),
});
export type SpecInput = z.infer<typeof SpecInput>;
export type SpecStatus = "queued" | "held" | "running" | "needs-review" | "accepted" | "discarded" | "failed" | "cancelled";
/** Whether the Controller still has to hear about a finished Spec: pending (not yet), claimed (a
 *  turn is telling it), delivered (told), acknowledged (it read the result or got it inline),
 *  disposed (it will not be told: cancelled, or the user already accepted or discarded it). */
export type SpecDelivery = "pending" | "claimed" | "delivered" | "acknowledged" | "disposed";
export type Spec = SpecInput & { id: string; project: string; status: SpecStatus; created: string;
  checkpoints: { before: string | null; after: string | null }; files: string[]; note?: string;
  turn?: string;                 // the Controller turn that made it (T-n)
  delivery?: SpecDelivery;
  summaries?: string[];          // the Runner's own words at the end of each round; the first is never rewritten
  // A usage limit stopped it: its Limit held it before it started (status held), or its Runner hit
  // the provider's usage limit (status failed, its copy kept). resetsAt is never guessed: null when
  // unknown. Gone once it runs again.
  limited?: { resetsAt: string | null; at: string; why: string };
};

/** What a Home Controller may propose; govd creates it only when the user chooses Create. */
export const ProjectProposal = z.object({
  name: ProjectName,
  path: z.string().min(1).max(4096),     // absolute, or ~/...
  git: z.boolean().default(true),
  reason: z.string().max(1000).default(""),
});

/** The Runners GovernCode has. A setting naming any other is refused: it would be saved and never used. */
export const RUNNERS = ["agy", "codex", "grok", "ollama"] as const;
/** The usage windows a reserve can name: the Runners' own (Grok's is weekly, monthly or a period)
 *  and counted budgets'. */
export const RESERVE_WINDOWS = ["5-hour", "daily", "weekly", "monthly", "period"] as const;

/** How a counted budget is labelled wherever it is shown: it is blind to use outside GovernCode. */
export const COUNTED_LABEL = "counted by GovernCode only";
/** The windows a counted budget can have, and their length. A window starts at the first run
 *  counted after the previous one ended, and resets that long after (as the vendors' do). */
export const COUNTED_WINDOWS = { "5-hour": 5 * 3_600_000, daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 } as const;
export type CountedWindow = keyof typeof COUNTED_WINDOWS;
const Cap = z.number().int().min(1).max(1_000_000_000_000);
export const Budget = z.object({
  unit: z.enum(["tokens", "turns"]),
  windows: z.object({ "5-hour": Cap.optional(), daily: Cap.optional(), weekly: Cap.optional(), monthly: Cap.optional() }).strict(),
});
export type BudgetValue = z.infer<typeof Budget>;

/** One budget change, as `gov budget` and the Dashboard make it: a cap for one window (null
 *  removes it). Caps in another unit mean something else, so switching the unit drops them. */
export function setBudget(budgets: Record<string, BudgetValue>, provider: string, window: CountedWindow, cap: number | null,
    unit: BudgetValue["unit"] = budgets[provider]?.unit ?? "turns"): Record<string, BudgetValue> {
  const old = budgets[provider];
  const windows: BudgetValue["windows"] = old && old.unit === unit ? { ...old.windows } : {};
  if (cap === null) delete windows[window]; else windows[window] = cap;
  const next = { ...budgets };
  if (Object.keys(windows).length) next[provider] = { unit, windows }; else delete next[provider];
  return next;
}

/** What the user sets in Settings. Reserves: per Runner, per usage window, the % held back. */
export const Settings = z.object({
  reserves: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.record(z.string().regex(/^[a-z0-9-]{1,20}$/), z.number().int().min(0).max(90))).default({}),
  // Each Runner's default model and effort, and how far a Controller may depart from them per Spec:
  // free (its pick), within (the default model, effort at most the default), defaults (always these).
  runners: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.object({ model: z.string().min(1).max(80), effort: Effort.nullable() })).default({}),
  specModels: z.enum(["free", "within", "defaults"]).default("free"),
  // Plain read-only commands (ls, cat, grep...) run without a Gate. The sandbox still applies.
  // How strict Gates are. relaxed: only steps on the always-ask list (and paid delegation) ask;
  // balanced: each new kind of command asks once, then the user can remember it for the project;
  // strict: everything asks except quiet reads and rules the user made. The sandbox is the same
  // at every level.
  gates: z.object({ quietReads: z.boolean().default(true), level: z.enum(["relaxed", "balanced", "strict"]).default("balanced") })
    .default({ quietReads: true, level: "balanced" }),
  // How much of the recent conversation each Controller turn gets, in characters: whole items only,
  // the rest left out whole and readable with conversation_read.
  memory: z.object({ conversationChars: z.number().int().min(2000).max(48_000).default(16_000) }).default({ conversationChars: 16_000 }),
  // How many Specs may run at once, in one project and for one Runner (on top of each Limit).
  specs: z.object({ maxPerProject: z.number().int().min(1).max(10).default(3), maxPerRunner: z.number().int().min(1).max(10).default(2) })
    .default({ maxPerProject: 3, maxPerRunner: 2 }),
  // The user's own instructions for each Controller (CLAUDE.md, skills, agents and hooks for
  // Claude Code; AGENTS.md for Codex). null: not asked yet, treated as off.
  personal: z.object({ claude: z.boolean().nullable().default(null), codex: z.boolean().nullable().default(null) })
    .default({ claude: null, codex: null }),
  // Local models (Ollama): no quota, so the Limit is the machine's. At most this many local Specs
  // at once, each stopped after this many minutes.
  local: z.object({ maxRunning: z.number().int().min(1).max(8).default(1), maxMinutes: z.number().int().min(1).max(120).default(10) })
    .default({ maxRunning: 1, maxMinutes: 10 }),
  // Counted budgets, per Runner: at most this much per window, in the provider's unit (tokens
  // where its driver reports them, turns otherwise). govd counts only what its own Runners use,
  // so a budget cannot see use outside GovernCode: set it below the real plan. When the provider
  // also reports its own usage, both are checked and the stricter one decides.
  budgets: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), Budget).default({}),
  // Usage limits (#226): autoResume makes "resume at the reset time" the choice for each newly
  // limited Spec or turn (off: only when you choose it; resume now is always available).
  recovery: z.object({ autoResume: z.boolean().default(false) }).default({ autoResume: false }),
});
export type SettingsValue = z.infer<typeof Settings>;

/** How a project's crew works (the Crew card). Enforced by govd, not asked of the AI.
 *  controllerWorks false: the Controller reads, plans and hands off, but cannot change the project.
 *  handoff: ask = each paid handoff waits at a Gate; plan = a handoff you approved in the game plan
 *  runs without asking again, anything else asks; off = the Controller works alone.
 *  runners: the Runners it may use (null: all). maxPercent: the most one Spec may reserve, per Runner.
 *  subagents: whether the Controller's tool, and the Runners' tools, may start their own helpers. */
export const Crew = z.object({
  controllerWorks: z.boolean().default(true),
  handoff: z.enum(["ask", "plan", "off"]).default("ask"),
  runners: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(20).nullable().default(null),
  maxPercent: z.record(z.string().regex(/^[a-z0-9-]{1,40}$/), z.number().int().min(1).max(25)).default({}),
  subagents: z.object({ controller: z.boolean().default(true), runners: z.boolean().default(true) }).default({ controller: true, runners: true }),
  // When Specs finish and the Controller is not working: auto = govd starts a turn for it to review
  // them (only while a client is connected, else as tell); tell = it hears on your next message;
  // off = neither (the project record still lists them).
  wake: z.enum(["auto", "tell", "off"]).default("auto"),
});
export type CrewValue = z.infer<typeof Crew>;

/** A limited Spec or Controller turn that may be resumed (#226). */
const RecoveryTarget = z.string().regex(/^(S-\d{4,}|T-\d+)$/);
const RecoverySince = z.string().min(1).max(40);

export const Params = {
  hello: z.object({ client: z.string().max(40), protocol: z.number().int() }),
  "project.list": z.object({}),
  "project.new": z.object({ name: ProjectName, path: z.string().min(1), git: z.boolean().default(true) }),
  "project.open": z.object({ path: z.string().min(1), name: ProjectName.optional() }),
  "controller.set": z.object({ project: ProjectName, controller: ControllerChoice }),
  // kinds: only events of these kinds (e.g. the latest turn boundaries, however long the turn).
  // after: the events after that seq, oldest first, instead of the newest (an export pages with it).
  "trace.list": z.object({ project: ProjectName.optional(), limit: z.number().int().min(1).max(1000).default(50),
    kinds: z.array(z.string().regex(/^[a-z.]{1,40}$/)).max(20).optional(), after: z.number().int().min(0).optional() }),
  // continuationOf: the user continues a turn a usage limit stopped (T-n), with their own prompt.
  ask: z.object({ project: ProjectName.nullable(), prompt: z.string().min(1).max(100_000), continuationOf: z.string().regex(/^T-\d+$/).optional() }),
  "gate.list": z.object({}),
  "spec.list": z.object({ project: ProjectName.optional() }),
  "turn.list": z.object({ project: ProjectName }),
  // measure: read each Runner's usage now (starts its tool briefly); otherwise the last reading.
  "limits.list": z.object({ measure: z.boolean().default(false) }),
  "settings.get": z.object({}),
  "settings.set": Settings,
  "turn.undo": z.object({ id: z.string().regex(/^T-\d+$/) }),
  "spec.diff": z.object({ id: z.string().regex(/^S-\d{4,}$/) }),
  "spec.accept": z.object({ id: z.string().regex(/^S-\d{4,}$/) }),
  "spec.discard": z.object({ id: z.string().regex(/^S-\d{4,}$/) }),
  "spec.cancel": z.object({ id: z.string().regex(/^S-\d{4,}$/) }),
  // Usage limits (#226). A target is a limited Spec (S-n) or Controller turn (T-n). recovery.list
  // gives { items: Array<{ target, project, kind: "held" | "spec" | "turn", provider, resetsAt (null:
  // unknown), since, why, atReset, due, note? }> }: held = its Limit held it before it started;
  // spec = its Runner hit the provider's limit (its copy kept); due = at reset, and the reset passed;
  // note = why it is not resumed by itself. A turn is continued with ask { continuationOf }.
  // since: the item's own `since`, as listed: a choice made on one limit never applies to a newer
  // one (govd refuses it when the item has changed since the client looked).
  "recovery.list": z.object({ project: ProjectName.optional() }),
  "recovery.set": z.object({ target: RecoveryTarget, since: RecoverySince, atReset: z.boolean() }),
  "recovery.resume": z.object({ id: z.string().regex(/^S-\d{4,}$/), since: RecoverySince }),
  "recovery.clear": z.object({ target: RecoveryTarget, since: RecoverySince }),
  // remember: also allow this kind of step for the rest of this turn / Spec / project. It only
  // skips the question; the sandbox still applies to every step.
  "gate.answer": z.object({ id: z.string().regex(/^G-\d+$/), answer: z.enum(["allow", "deny"]),
    remember: z.enum(["turn", "spec", "project"]).optional() }),
  "conversation.reset": z.object({ project: ProjectName.nullable() }),
  "allows.list": z.object({ project: ProjectName.optional() }),
  "allows.revoke": z.object({ id: z.string().regex(/^R-\d+$/) }),
  "proposal.answer": z.object({ id: z.string().regex(/^P-\d+$/), answer: z.enum(["create", "cancel"]) }),
  // After `watch`, the connection also receives `event` notifications: {kind:"trace", event}
  // for every Trace append, and {kind:"gates"} whenever a Gate opens or is settled.
  // wake true: this client shows wake turns (the Dashboard), so a finished Spec may start one while
  // it is connected. Opt-in: a client that does not say so (gov, an older Dashboard) is not counted.
  watch: z.object({ wake: z.boolean().default(false) }),
  // Connect (2026-09-28): every tool joins the same way. connect.start runs the tool's own
  // sign-in in GovernCode's private home for it and streams {kind:"connect", id, text | url}
  // events; connect.input passes what the user pastes (a sign-in code); it resolves when the
  // sign-in ends, connected or not. GovernCode never reads the login the tool keeps there.
  // measure: ask each connected tool for its usage now (no quota spent); a login that no longer
  // works then shows as needing sign-in again instead of "connected".
  "tools.list": z.object({ measure: z.boolean().default(false) }),
  "connect.start": z.object({ tool: z.enum(["agy", "claude", "codex", "grok"]) }),
  "connect.input": z.object({ id: z.string().regex(/^C-\d+$/), text: z.string().max(4096).regex(/^[^\x00-\x1f\x7f]*$/) }),
  "connect.cancel": z.object({ id: z.string().regex(/^C-\d+$/) }),
  "tools.disconnect": z.object({ tool: z.enum(["agy", "claude", "codex", "grok"]) }),
  // Project memory: the notes (read, set by the user, with every version), and whether a
  // Controller from another provider may see the project's conversation, record and notes.
  "notes.get": z.object({ project: ProjectName, limit: z.number().int().min(1).max(1000).default(50) }),
  "notes.set": z.object({ project: ProjectName, text: z.string().max(4000) }),
  "context.state": z.object({ project: ProjectName }),
  "context.share": z.object({ project: ProjectName, provider: z.string().regex(/^[a-z0-9-]{1,40}$/), share: z.boolean() }),
  "crew.get": z.object({ project: ProjectName }),
  "crew.set": z.object({ project: ProjectName, crew: Crew }),
  // The game plan a Controller posted: approve all (or only some items, 1-based), "just you"
  // (it works alone for the rest of the turn), or reject.
  "plan.answer": z.object({ id: z.string().regex(/^GP-\d+$/), answer: z.enum(["approve", "just-you", "reject"]),
    items: z.array(z.number().int().min(1).max(12)).max(12).optional() }),
} as const;
export type Method = keyof typeof Params;

/** A validation failure in plain words, naming the field: `reserves.codex.weekly: Too big...`. */
export const issues = (e: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string =>
  e.issues.map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message)).join("; ");

export const Request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});

// Canonical events, kept in the Trace and streamed to clients. `data` carries detail; the
// raw provider payload stays in the driver log, not here.
export type TraceEvent = {
  seq: number;
  ts: string; // ISO 8601, UTC
  project: string | null;
  kind:
    | "project.created" | "project.opened" | "project.proposed" | "project.declined" | "controller.set" | "settings.changed" | "allow.added" | "allow.revoked"
    | "turn.started" | "turn.text" | "turn.tool" | "turn.completed" | "turn.failed"
    | "gate.opened" | "gate.allowed" | "gate.denied" | "sandbox.refused"
    | "git.scrubbed" | "git.guard_failed" | "conversation.reset" | "checkpoint.taken" | "checkpoint.failed" | "checkpoint.undone"
    | "spec.created" | "spec.held" | "spec.started" | "spec.done" | "spec.failed" | "spec.accepted" | "spec.discarded" | "spec.undone" | "spec.cancel" | "spec.cancelled" | "spec.followup"
    | "recovery.set" | "recovery.resumed" | "recovery.cleared"
    | "tool.connected" | "tool.disconnected" | "notes.updated" | "context.shared" | "crew.set" | "plan.proposed" | "plan.answered" | "spec.step";
  actor: string; // "user", "govd", "controller · claude-code"
  data: Record<string, unknown>;
};

/** What a watching connection receives, as the params of `event` notifications. */
export type WatchEvent = { kind: "trace"; event: TraceEvent } | { kind: "gates" };

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
export const Errors = {
  badParams: -32602,
  unknownMethod: -32601,
  refused: 1001, // a rule said no (sandbox, gate, limit)
  notFound: 1002,
} as const;
