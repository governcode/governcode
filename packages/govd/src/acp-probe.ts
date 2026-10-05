// Metadata-only ACP discovery over an already supplied transport. This module launches
// nothing and never authenticates, prompts, restores sessions, or changes configuration.
import { isAbsolute } from "node:path";
import type { AcpRpc } from "./acp.ts";

export const ACP_DISCOVERY_LIMITS = Object.freeze({
  bytes: 65_536, nodes: 4096, depth: 8, recordKeys: 32, arrayItems: 64,
  string: 4096, id: 256, configOptions: 32, authMethods: 16, notifications: 128,
});
export type AcpDiscoveryStatus = "reported" | "missing" | "unsupported" | "malformed" |
  "auth-required" | "cancelled" | "timeout" | "forbidden-request" | "notification-flood" | "output-budget-exceeded" | "error";
export type AcpReportedChoice = { id: string; name: string; description?: string };
export type AcpReportedSelection = { current: string; available: AcpReportedChoice[] };
export type AcpReportedConfig = {
  id: string; name: string; description?: string; category?: string;
} & ({
  type: "select"; currentValue: string;
  options: { value: string; name: string; description?: string; group?: string; groupName?: string }[];
} | { type: "boolean"; currentValue: boolean });
export type AcpReportedInitialization = {
  protocolVersion: 1;
  agentInfo: { name: string; version: string; title?: string } | null;
  authMethods: { id: string; name: string; description?: string; type: string }[] | null;
  capabilities: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
};
export type AcpReportedSession = {
  source: "configOptions" | "legacy" | "missing";
  configOptions: AcpReportedConfig[];
  unsupportedConfigTypes: string[];
  models: AcpReportedSelection | null;
  modes: AcpReportedSelection | null;
};
export type AcpDiscoveryReport = {
  evidence: "agent-reported";
  status: AcpDiscoveryStatus;
  initialization: AcpReportedInitialization | null;
  session: AcpReportedSession | null;
  sessionStatus: AcpDiscoveryStatus | "not-requested";
  // This is the supplied transport's runtime closure, not proof about arbitrary descendants.
  runtimeClosed: true;
};

class DecodeError extends Error {
  status: AcpDiscoveryStatus;
  constructor(status: AcpDiscoveryStatus) { super(`ACP discovery: ${status}`); this.status = status; }
}
const bad = (): never => { throw new DecodeError("malformed"); };
const missing = (): never => { throw new DecodeError("missing"); };
const present = (v: unknown) => v !== undefined && v !== null;
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad();
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return bad();
  let count = 0;
  for (const key in v) if (Object.hasOwn(v, key) && ++count > ACP_DISCOVERY_LIMITS.recordKeys) return bad();
  return v as Record<string, unknown>;
};
const text = (v: unknown, max: number = ACP_DISCOVERY_LIMITS.string): string => {
  if (typeof v !== "string" || !v.length || v.length > max || Buffer.byteLength(v) > max || /[\x00-\x1f\x7f]/.test(v)) return bad();
  return v;
};
const id = (v: unknown) => text(v, ACP_DISCOVERY_LIMITS.id);
const list = (v: unknown, max: number = ACP_DISCOVERY_LIMITS.arrayItems): unknown[] => {
  if (!Array.isArray(v) || v.length > max) return bad();
  return v;
};
const optionalText = (o: Record<string, unknown>, key: string): Record<string, string> =>
  present(o[key]) ? { [key]: text(o[key]) } : {};

/** A bounded size fence, including ignored extensions. It grants no trust to unknown fields. */
function bounded(value: unknown): void {
  let nodes = 0, bytes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > ACP_DISCOVERY_LIMITS.nodes || depth > ACP_DISCOVERY_LIMITS.depth) return bad();
    if (typeof v === "string") bytes += v === "" ? 0 : Buffer.byteLength(text(v));
    else if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) bytes += 8;
    else if (Array.isArray(v)) { for (const item of list(v)) visit(item, depth + 1); }
    else {
      const o = record(v);
      for (const key in o) if (Object.hasOwn(o, key)) {
        bytes += Buffer.byteLength(text(key, ACP_DISCOVERY_LIMITS.id));
        const descriptor = Object.getOwnPropertyDescriptor(o, key)!;
        if (!("value" in descriptor)) return bad();
        visit(descriptor.value, depth + 1);
      }
    }
    if (bytes > ACP_DISCOVERY_LIMITS.bytes) return bad();
  };
  visit(value, 0);
}
function unique<T>(items: T[], key: (item: T) => string): T[] {
  if (new Set(items.map(key)).size !== items.length) return bad();
  return items;
}
function bools(o: unknown, keys: string[]): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const r = record(o);
  for (const key of keys) if (present(r[key])) {
    if (typeof r[key] !== "boolean") return bad();
    result[key] = r[key];
  }
  return result;
}

/** ACP v1 initialization only; vendor extensions and executable auth descriptors are dropped. */
export function decodeAcpInitialize(value: unknown): AcpReportedInitialization {
  bounded(value);
  const o = record(value);
  if (!Object.hasOwn(o, "protocolVersion")) return missing();
  if (typeof o.protocolVersion !== "number" || !Number.isSafeInteger(o.protocolVersion) || o.protocolVersion < 1) return bad();
  if (o.protocolVersion !== 1) throw new DecodeError("unsupported");
  if (!Object.hasOwn(o, "agentCapabilities")) return missing();
  const caps = record(o.agentCapabilities);
  const capabilities: AcpReportedInitialization["capabilities"] = bools(caps, ["loadSession"]);
  if (present(caps.promptCapabilities)) capabilities.promptCapabilities = bools(caps.promptCapabilities, ["image", "audio", "embeddedContext"]);
  if (present(caps.mcpCapabilities)) capabilities.mcpCapabilities = bools(caps.mcpCapabilities, ["http", "sse"]);
  let agentInfo: AcpReportedInitialization["agentInfo"] = null;
  if (present(o.agentInfo)) {
    const info = record(o.agentInfo);
    agentInfo = { name: text(info.name), version: text(info.version), ...optionalText(info, "title") };
  }
  const authMethods = !present(o.authMethods) ? null : unique(list(o.authMethods, ACP_DISCOVERY_LIMITS.authMethods).map((v) => {
    const method = record(v);
    return { id: id(method.id), name: text(method.name), ...optionalText(method, "description"),
      type: present(method.type) ? id(method.type) : "agent" };
  }), (v) => v.id);
  return { protocolVersion: 1, agentInfo, authMethods, capabilities };
}

function legacy(value: unknown, currentKey: string, availableKey: string, itemKey: string): AcpReportedSelection | null {
  if (!present(value)) return null;
  const o = record(value);
  const available = unique(list(o[availableKey]).map((v) => {
    const item = record(v);
    return { id: id(item[itemKey]), name: text(item.name), ...optionalText(item, "description") };
  }), (v) => v.id);
  const current = id(o[currentKey]);
  if (!available.some((v) => v.id === current)) return bad();
  return { current, available };
}
function selection(config: AcpReportedConfig[], category: string): AcpReportedSelection | null {
  const o = config.find((v): v is Extract<AcpReportedConfig, { type: "select" }> => v.type === "select" && v.category === category);
  return o ? { current: o.currentValue, available: o.options.map((v) => ({ id: v.value, name: v.name,
    ...(v.description ? { description: v.description } : {}) })) } : null;
}

/** Known boolean and select schemas (flat or grouped); no generic passthrough, no config writes. */
export function decodeAcpSession(value: unknown): AcpReportedSession {
  bounded(value);
  const o = record(value);
  if (!Object.hasOwn(o, "sessionId")) return missing();
  id(o.sessionId); // validate but do not retain a session handle
  const configOptions: AcpReportedConfig[] = [], unsupportedConfigTypes: string[] = [];
  if (present(o.configOptions)) {
    const seen = new Set<string>();
    for (const value of list(o.configOptions, ACP_DISCOVERY_LIMITS.configOptions)) {
      const option = record(value), configId = id(option.id), name = text(option.name), type = id(option.type);
      if (seen.has(configId)) return bad();
      seen.add(configId);
      const common = { id: configId, name, ...optionalText(option, "description"),
        ...(present(option.category) ? { category: id(option.category) } : {}) };
      if (type === "boolean") {
        if (typeof option.currentValue !== "boolean") return bad();
        configOptions.push({ ...common, type: "boolean", currentValue: option.currentValue });
        continue;
      }
      if (type !== "select") { unsupportedConfigTypes.push(type); continue; }
      const currentValue = id(option.currentValue);
      const values: Extract<AcpReportedConfig, { type: "select" }>["options"] = [];
      let grouped: boolean | undefined;
      const add = (value: unknown, group?: string, groupName?: string) => {
        const v = record(value);
        values.push({ value: id(v.value), name: text(v.name), ...optionalText(v, "description"),
          ...(group !== undefined ? { group, groupName } : {}) });
        if (values.length > ACP_DISCOVERY_LIMITS.arrayItems) return bad();
      };
      const groups = new Set<string>();
      for (const value of list(option.options)) {
        const v = record(value), isGroup = Object.hasOwn(v, "group");
        if (grouped !== undefined && grouped !== isGroup) return bad();
        grouped = isGroup;
        if (!isGroup) add(v);
        else {
          const group = id(v.group), groupName = text(v.name);
          if (groups.has(group)) return bad();
          groups.add(group);
          for (const item of list(v.options)) add(item, group, groupName);
        }
      }
      unique(values, (v) => v.value);
      if (!values.some((v) => v.value === currentValue)) return bad();
      configOptions.push({ ...common, type: "select", currentValue, options: values });
    }
    return { source: "configOptions", configOptions, unsupportedConfigTypes: [...new Set(unsupportedConfigTypes)],
      models: selection(configOptions, "model"), modes: selection(configOptions, "mode") };
  }
  const models = legacy(o.models, "currentModelId", "availableModels", "modelId");
  const modes = legacy(o.modes, "currentModeId", "availableModes", "id");
  return { source: models || modes ? "legacy" : "missing", configOptions, unsupportedConfigTypes, models, modes };
}

export type AcpDiscoveryOptions = {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Opt-in only. The caller must supply a fresh isolated directory, never a project. */
  createSession?: boolean;
  freshCwd?: true;
  cleanupTimeoutMs?: number;
};
/** A broken transport closure contract must not be reported as successful cleanup. Even after
 * rpc.closed resolves, a real launcher needs independent descendant-death evidence before
 * removing its cwd. This error deliberately carries no agent text or paths. */
export class AcpDiscoveryCleanupError extends Error {
  constructor() { super("ACP discovery runtime closure was not confirmed; retain its cwd until rpc.closed resolves"); }
}

/** Takes exclusive ownership of an already supplied AcpRpc and always requests close.
 * A result is returned only after rpc.closed fulfills. Work has one overall deadline;
 * closure has a separate bounded wait and rejects if the transport breaks its contract.
 * No filesystem checks/cleanup occur here: freshCwd is a caller assertion, not a sandbox.
 * Transport closure is not descendant-death evidence; production launch/cleanup is not wired.
 */
export async function discoverAcp(rpc: AcpRpc, options: AcpDiscoveryOptions): Promise<AcpDiscoveryReport> {
  let initialization: AcpReportedInitialization | null = null, session: AcpReportedSession | null = null;
  let status: AcpDiscoveryStatus = "reported", sessionStatus: AcpDiscoveryReport["sessionStatus"] = "not-requested";
  let stopped: AcpDiscoveryStatus | undefined, closeRequested = false, closeFailed = false, notes = 0;
  let timer: NodeJS.Timeout | undefined;
  let deadline = Infinity;
  let interrupt!: () => void;
  const interrupted = new Promise<void>((resolve) => { interrupt = resolve; });
  const close = () => {
    if (closeRequested) return;
    closeRequested = true;
    try { rpc.close(100); } catch { closeFailed = true; }
  };
  const stop = (reason: AcpDiscoveryStatus) => {
    if (stopped && reason !== "output-budget-exceeded") return;
    stopped = reason; interrupt(); close();
  };
  const observeBudget = () => {
    if (rpc.outputBudget?.failure) stop("output-budget-exceeded");
  };
  // Keep this observation alive through cleanup. Peer errors never set this local status.
  if (rpc.outputBudget) void rpc.outputBudget.settled.then((failure) => {
    if (failure) stop("output-budget-exceeded");
  });
  observeBudget();
  const abort = () => stop("cancelled");
  // Observe closure immediately, including a transport that fails while a request hangs.
  // Reflect rejection so it can never become an unhandled rejection before finalization.
  const closure = rpc.closed.then(() => {
    if (!closeRequested) stop("error");
    return true;
  }, () => { stop("error"); return false; });
  const remainingTime = () => {
    observeBudget();
    const remaining = deadline - performance.now();
    if (remaining <= 0) stop("timeout");
    if (stopped) throw new DecodeError(stopped);
    return Math.max(1, Math.ceil(remaining));
  };
  const request = async (method: string, params: unknown): Promise<unknown> => {
    remainingTime();
    try {
      return await Promise.race([
        Promise.resolve().then(() => rpc.request(method, params, remainingTime())),
        interrupted.then(() => { throw new DecodeError(stopped!); }),
      ]);
    } finally {
      // Rejected replies also consume the overall budget before protocol interpretation.
      remainingTime();
    }
  };
  let cleanupTimeout = 1000;
  try {
    // Register denial handlers before any request, including initialize. No peer strings
    // or request payloads enter an error message, UI, filesystem, or command invocation.
    rpc.onRequest(async () => { stop("forbidden-request"); throw new Error("ACP discovery rejects all client requests"); });
    rpc.onNotify(() => { if (!stopped && ++notes > ACP_DISCOVERY_LIMITS.notifications) stop("notification-flood"); });
    const timeout = options.timeoutMs ?? 5000;
    cleanupTimeout = options.cleanupTimeoutMs ?? 1000;
    if (!Number.isSafeInteger(cleanupTimeout) || cleanupTimeout < 1 || cleanupTimeout > 5000) { cleanupTimeout = 1000; return bad(); }
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000 ||
      typeof options.cwd !== "string" || !isAbsolute(text(options.cwd)) ||
      (options.createSession !== undefined && typeof options.createSession !== "boolean") ||
      (options.createSession && options.freshCwd !== true)) return bad();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    deadline = performance.now() + timeout;
    timer = setTimeout(() => stop("timeout"), timeout);
    const initialReply = await request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "governcode-discovery", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
    });
    remainingTime();
    initialization = decodeAcpInitialize(initialReply);
    if (options.createSession) {
      sessionStatus = "reported";
      const sessionReply = await request("session/new", { cwd: options.cwd, mcpServers: [] });
      remainingTime();
      session = decodeAcpSession(sessionReply);
      sessionStatus = session.source === "missing" ? "missing" : session.unsupportedConfigTypes.length ? "unsupported" : "reported";
      status = sessionStatus;
    }
    remainingTime();
  } catch (error) {
    observeBudget();
    // Only protocol codes are interpreted; messages such as "sign in" prove nothing.
    const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
    status = stopped ?? (error instanceof DecodeError ? error.status : code === -32000 ? "auth-required" :
      code === -32601 ? "unsupported" : "error");
    if (options.createSession && initialization) sessionStatus = status;
  } finally {
    clearTimeout(timer);
    close();
    let cleanupTimer: NodeJS.Timeout | undefined;
    try {
      const confirmed = await Promise.race([closure, new Promise<never>((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new AcpDiscoveryCleanupError()), cleanupTimeout);
      })]);
      observeBudget();
      if (!confirmed || closeFailed) throw new AcpDiscoveryCleanupError();
    } catch { throw new AcpDiscoveryCleanupError(); }
    finally { clearTimeout(cleanupTimer); options.signal?.removeEventListener("abort", abort); }
  }
  observeBudget();
  status = stopped ?? status;
  if (stopped && options.createSession && initialization) sessionStatus = stopped;
  return { evidence: "agent-reported", status, initialization, session, sessionStatus, runtimeClosed: true };
}
