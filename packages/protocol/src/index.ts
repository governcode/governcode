// The wire contract between govd and its clients (the gov CLI now; the Dashboard and the
// Pager later). JSON-RPC 2.0, one JSON object per line. Clients check `features` from
// `hello`, never the version number.
import { z } from "zod";

export const PROTOCOL = 1;
export const FEATURES = ["projects", "trace", "ask", "gates", "home"] as const;

export const Effort = z.enum(["low", "medium", "high", "max"]);

export const ControllerChoice = z.object({
  provider: z.literal("claude-code"), // phase 0 ships one driver
  model: z.string().min(1).max(80),
  effort: Effort.nullable(),
});
export type ControllerChoice = z.infer<typeof ControllerChoice>;

export const ProjectName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "lowercase letters, digits, . _ -");

export const Params = {
  hello: z.object({ client: z.string().max(40), protocol: z.number().int() }),
  "project.list": z.object({}),
  "project.new": z.object({ name: ProjectName, path: z.string().min(1), git: z.boolean().default(true) }),
  "project.open": z.object({ path: z.string().min(1), name: ProjectName.optional() }),
  "controller.set": z.object({ project: ProjectName, controller: ControllerChoice }),
  "trace.list": z.object({ project: ProjectName.optional(), limit: z.number().int().min(1).max(1000).default(50) }),
  ask: z.object({ project: ProjectName.nullable(), prompt: z.string().min(1).max(100_000) }),
  "gate.list": z.object({}),
  "gate.answer": z.object({ id: z.string().regex(/^G-\d+$/), answer: z.enum(["allow", "deny"]) }),
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
    | "project.created" | "project.opened" | "controller.set"
    | "turn.started" | "turn.text" | "turn.tool" | "turn.completed" | "turn.failed"
    | "gate.opened" | "gate.allowed" | "gate.denied" | "sandbox.refused";
  actor: string; // "user", "govd", "controller · claude-code"
  data: Record<string, unknown>;
};

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
