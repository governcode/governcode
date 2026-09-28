// The wire contract between govd and its clients (the gov CLI now; the Dashboard and the
// Pager later). JSON-RPC 2.0, one JSON object per line. Clients check `features` from
// `hello`, never the version number.
import { z } from "zod";

export const PROTOCOL = 1;
export const FEATURES = ["projects", "trace", "ask", "gates", "home", "delegate", "specs", "watch"] as const;

export const Effort = z.enum(["low", "medium", "high", "max"]);

export const ControllerChoice = z.object({
  provider: z.enum(["claude-code", "codex"]),
  model: z.string().min(1).max(80),
  effort: Effort.nullable(),
});
export type ControllerChoice = z.infer<typeof ControllerChoice>;

export const ProjectName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "lowercase letters, digits, . _ -");

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
});
export type SpecInput = z.infer<typeof SpecInput>;
export type SpecStatus = "queued" | "held" | "running" | "needs-review" | "accepted" | "undone" | "failed";
export type Spec = SpecInput & { id: string; project: string; status: SpecStatus; created: string;
  checkpoints: { before: string | null; after: string | null }; files: string[]; note?: string };

/** What a Home Controller may propose; govd creates it only when the user chooses Create. */
export const ProjectProposal = z.object({
  name: ProjectName,
  path: z.string().min(1).max(4096),     // absolute, or ~/...
  git: z.boolean().default(true),
  reason: z.string().max(1000).default(""),
});

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
  // The user's own instructions for each Controller (CLAUDE.md, skills, agents and hooks for
  // Claude Code; AGENTS.md for Codex). null: not asked yet, treated as off.
  personal: z.object({ claude: z.boolean().nullable().default(null), codex: z.boolean().nullable().default(null) })
    .default({ claude: null, codex: null }),
  // Local models (Ollama): no quota, so the Limit is the machine's. At most this many local Specs
  // at once, each stopped after this many minutes.
  local: z.object({ maxRunning: z.number().int().min(1).max(8).default(1), maxMinutes: z.number().int().min(1).max(120).default(10) })
    .default({ maxRunning: 1, maxMinutes: 10 }),
});
export type SettingsValue = z.infer<typeof Settings>;

export const Params = {
  hello: z.object({ client: z.string().max(40), protocol: z.number().int() }),
  "project.list": z.object({}),
  "project.new": z.object({ name: ProjectName, path: z.string().min(1), git: z.boolean().default(true) }),
  "project.open": z.object({ path: z.string().min(1), name: ProjectName.optional() }),
  "controller.set": z.object({ project: ProjectName, controller: ControllerChoice }),
  "trace.list": z.object({ project: ProjectName.optional(), limit: z.number().int().min(1).max(1000).default(50) }),
  ask: z.object({ project: ProjectName.nullable(), prompt: z.string().min(1).max(100_000) }),
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
  watch: z.object({}),
  // Connect (2026-09-28): every tool joins the same way. connect.start runs the tool's own
  // sign-in in GovernCode's private home for it and streams {kind:"connect", id, text | url}
  // events; connect.input passes what the user pastes (a sign-in code); it resolves when the
  // sign-in ends, connected or not. GovernCode never reads the login the tool keeps there.
  // measure: ask each connected tool for its usage now (no quota spent); a login that no longer
  // works then shows as needing sign-in again instead of "connected".
  "tools.list": z.object({ measure: z.boolean().default(false) }),
  "connect.start": z.object({ tool: z.enum(["agy"]) }),
  "connect.input": z.object({ id: z.string().regex(/^C-\d+$/), text: z.string().max(4096).regex(/^[^\x00-\x1f\x7f]*$/) }),
  "connect.cancel": z.object({ id: z.string().regex(/^C-\d+$/) }),
  "tools.disconnect": z.object({ tool: z.enum(["agy"]) }),
  // Project memory: the notes (read, set by the user, with every version), and whether a
  // Controller from another provider may see the project's conversation, record and notes.
  "notes.get": z.object({ project: ProjectName }),
  "notes.set": z.object({ project: ProjectName, text: z.string().max(4000) }),
  "context.state": z.object({ project: ProjectName }),
  "context.share": z.object({ project: ProjectName, provider: z.string().regex(/^[a-z0-9-]{1,40}$/), share: z.boolean() }),
} as const;
export type Method = keyof typeof Params;

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
    | "spec.created" | "spec.held" | "spec.started" | "spec.done" | "spec.failed" | "spec.accepted" | "spec.undone"
    | "tool.connected" | "tool.disconnected" | "notes.updated" | "context.shared";
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
