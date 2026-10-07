// `gov friction` (#224): how often GovernCode got in the way, measured from the Trace before any
// policy changes. It only reads: no setting, Gate, rule or sandbox behaviour is touched, and a kind
// of step allowed every time is reported, never remembered.
//
// Everything here is what govd actually records (daemon.ts, ledger.ts). What it does not record is
// left out rather than guessed:
// - A Gate's kind of step (`command:npm test`, `edit`: what a standing allow would cover) is in
//   gate.opened, gate.allowed and gate.denied from this version on (data.kinds, data.always). Older
//   events have only the tool: they are counted by tool, and left out of the kinds.
// - Why a step always asked (data.why on gate.opened: "interpreter", "shell syntax"...) from this
//   version on: one word from a fixed list, never the command.
// - A turn the user stopped is not recorded apart from other failed turns (its summary is free text).
// - sandbox.refused records why govd would not start a turn (the sandbox is not verified here), not a
//   tool. sandbox.blocked (from this version on) records a failed step whose output showed what the
//   sandbox says when it refuses something (EACCES, EPERM, a read-only file system): probably the
//   sandbox, an estimate, since an ordinary permission error in a project looks the same.
import type { TraceEvent } from "./index.ts";

export type FrictionOptions = {
  since?: Date;
  /** undefined: every project and Home; null: Home only (and what belongs to no project); a name: that project. */
  project?: string | null;
  /** Allowed at least this often, and never denied by you: a candidate for a standing allow. */
  minAllowed?: number;
};

export type ToolFriction = { tool: string; asked: number; allowed: number; denied: number; autoDenied: number; allowedEveryTime: boolean };
/** One kind of step: `command:npm test`, `runner:edit`..., or `always:<tool>` for steps no rule may
 *  cover (rm, curl, shell syntax: they always ask). A Gate for a command of several kinds counts
 *  under each. passed: let through without a Gate (your rule, an approved plan, relaxed). */
export type KindFriction = { kind: string; asked: number; allowed: number; denied: number; autoDenied: number; passed: number;
  /** Steps of this kind that failed, probably at the sandbox (sandbox.blocked: an estimate). */
  blocked: number; allowedEveryTime: boolean };

export type FrictionReport = {
  since: string | null;
  project: string | null | undefined;
  turns: { started: number; completed: number; failed: number; limited: number };
  gates: {
    opened: number; byControllers: number; byRunners: number;
    /** Gates opened by Controllers per Controller turn started; null with no turns. */
    perTurn: number | null;
    allowed: number;
    denied: number;
    /** Denied by govd, not by you: nobody answered, the turn or Spec ended, govd stopped... */
    autoDenied: number;
    autoDeniedBy: Record<string, number>;
    /** Steps that went through without a Gate: quiet reads, your rules, an approved plan, relaxed. */
    passed: number;
    passedBy: Record<string, number>;
  };
  tools: ToolFriction[];
  kinds: KindFriction[];
  /** Gates opened with their kind recorded (an older govd recorded only the tool). */
  kindsRecorded: number;
  /** Gates for steps that always ask, by why (data.why: "interpreter", "shell syntax", "install"...;
   *  recorded from this version on, so older Gates are not in it). */
  alwaysWhy: Record<string, number>;
  sandbox: { refused: number; refusedBy: Record<string, number>; gitScrubbed: number; gitGuardFailed: number;
    /** Failed steps that probably ran into the sandbox, by what their output said (an estimate). */
    blocked: number; blockedBy: Record<string, number>;
    /** The same, by roughly where they were refused (data.where: "~/.npm", "/tmp", "system folders"...). */
    blockedWhere: Record<string, number> };
  specs: { created: number; failed: number; limited: number; held: number };
};

/** The only kinds the report reads: a caller paging the Trace can keep just these. */
export const FRICTION_KINDS: ReadonlySet<TraceEvent["kind"]> = new Set<TraceEvent["kind"]>(["turn.started", "turn.completed", "turn.failed",
  "gate.opened", "gate.allowed", "gate.denied", "sandbox.refused", "sandbox.blocked", "git.scrubbed", "git.guard_failed", "spec.created", "spec.failed", "spec.held"]);

// A Runner's Gate names its Spec ("Bash (Runner · codex, S-0012)"); grouped without it, or every
// Spec would be a tool of its own.
const toolOf = (e: TraceEvent) => String(e.data.tool ?? "(unknown)").replace(/, S-\d{4,}\)$/, ")");
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

export function friction(events: Iterable<TraceEvent>, o: FrictionOptions = {}): FrictionReport {
  const since = o.since ? o.since.getTime() : null, min = o.minAllowed ?? 5;
  const r: FrictionReport = {
    since: o.since ? o.since.toISOString() : null, project: o.project,
    turns: { started: 0, completed: 0, failed: 0, limited: 0 },
    gates: { opened: 0, byControllers: 0, byRunners: 0, perTurn: null, allowed: 0, denied: 0, autoDenied: 0, autoDeniedBy: {}, passed: 0, passedBy: {} },
    tools: [], kinds: [], kindsRecorded: 0, alwaysWhy: {},
    sandbox: { refused: 0, refusedBy: {}, gitScrubbed: 0, gitGuardFailed: 0, blocked: 0, blockedBy: {}, blockedWhere: {} },
    specs: { created: 0, failed: 0, limited: 0, held: 0 },
  };
  const tools = new Map<string, ToolFriction>();
  const tool = (e: TraceEvent) => {
    const name = toolOf(e);
    let t = tools.get(name);
    if (!t) tools.set(name, t = { tool: name, asked: 0, allowed: 0, denied: 0, autoDenied: 0, allowedEveryTime: false });
    return t;
  };
  const kinds = new Map<string, KindFriction>();
  // The kinds an event is about; none when govd did not record them.
  const kindsOf = (e: TraceEvent): KindFriction[] => {
    const d = e.data;
    if (!Array.isArray(d.kinds)) return [];
    const keys = d.always === true ? [`always:${toolOf(e)}`] : d.kinds.length ? d.kinds.map(String) : [`other:${toolOf(e)}`];
    return keys.map((k) => {
      let x = kinds.get(k);
      if (!x) kinds.set(k, x = { kind: k, asked: 0, allowed: 0, denied: 0, autoDenied: 0, passed: 0, blocked: 0, allowedEveryTime: false });
      return x;
    });
  };
  for (const e of events) {
    if (o.project !== undefined && e.project !== o.project) continue;
    if (since !== null && !(Date.parse(e.ts) >= since)) continue;
    const d = e.data;
    switch (e.kind) {
      case "turn.started": r.turns.started++; break;
      case "turn.completed": r.turns.completed++; break;
      // A usage limit ends a turn as turn.failed with data.limit.
      case "turn.failed": r.turns.failed++; if (d.limit) r.turns.limited++; break;
      case "gate.opened":
        r.gates.opened++;
        // Controllers' Gates are "controller · ...", Runners' "runner · ..."; others (an ACP install) are the user's own.
        if (e.actor.startsWith("controller")) r.gates.byControllers++;
        else if (e.actor.startsWith("runner")) r.gates.byRunners++;
        tool(e).asked++;
        if (Array.isArray(d.kinds)) r.kindsRecorded++;
        if (d.always === true && typeof d.why === "string" && /^[a-z ]{1,24}$/.test(d.why)) bump(r.alwaysWhy, d.why);
        for (const k of kindsOf(e)) k.asked++;
        break;
      case "gate.allowed":
        // With a Gate: you allowed it (only you can). Without one: govd let it through, `by` says why
        // ("quiet read", "relaxed", "plan", "rule R-3, R-7").
        if (d.gate) { r.gates.allowed++; tool(e).allowed++; for (const k of kindsOf(e)) k.allowed++; }
        else {
          r.gates.passed++; bump(r.gates.passedBy, String(d.by ?? "").startsWith("rule") ? "rule" : String(d.by ?? "unknown"));
          // A quiet read is no kind (nothing to remember); the rest are what your rules and plans saved.
          if (Array.isArray(d.kinds) && d.kinds.length) for (const k of kindsOf(e)) k.passed++;
        }
        break;
      case "gate.denied":
        // `by` is "user" for your answer; anything else is govd's ("nobody answered within the hour",
        // "turn ended", "the Spec ended", "asker left", "govd stopped"...). A step asked after its turn
        // or Spec ended is denied without a Gate (no data.gate), and counted here the same way.
        if (d.by === "user") { r.gates.denied++; tool(e).denied++; for (const k of kindsOf(e)) k.denied++; }
        else { r.gates.autoDenied++; bump(r.gates.autoDeniedBy, String(d.by ?? "unknown")); tool(e).autoDenied++; for (const k of kindsOf(e)) k.autoDenied++; }
        break;
      case "sandbox.refused": r.sandbox.refused++; bump(r.sandbox.refusedBy, String(d.reason ?? "unknown")); break;
      case "sandbox.blocked":
        r.sandbox.blocked++; bump(r.sandbox.blockedBy, String(d.pattern ?? "unknown")); for (const k of kindsOf(e)) k.blocked++;
        if (typeof d.where === "string" && /^[A-Za-z0-9 ~/.,_()'-]{1,64}$/.test(d.where)) bump(r.sandbox.blockedWhere, d.where);
        break;
      case "git.scrubbed": r.sandbox.gitScrubbed++; break;
      case "git.guard_failed": r.sandbox.gitGuardFailed++; break;
      case "spec.created": r.specs.created++; break;
      // A Runner that hit its provider's usage limit fails its Spec with data.limited.
      case "spec.failed": r.specs.failed++; if (d.limited) r.specs.limited++; break;
      case "spec.held": r.specs.held++; break;
    }
  }
  r.gates.perTurn = r.turns.started ? r.gates.byControllers / r.turns.started : null;
  for (const t of tools.values()) t.allowedEveryTime = t.allowed >= min && t.denied === 0;
  r.tools = [...tools.values()].sort((a, b) => b.asked - a.asked || b.allowed - a.allowed || a.tool.localeCompare(b.tool));
  // A step that always asks is never a candidate: no rule may cover it.
  for (const k of kinds.values()) k.allowedEveryTime = !k.kind.startsWith("always:") && k.allowed >= min && k.denied === 0;
  r.kinds = [...kinds.values()].sort((a, b) => b.asked - a.asked || b.blocked - a.blocked || b.passed - a.passed || a.kind.localeCompare(b.kind));
  return r;
}

/** A kind in words: `command:npm test` → "npm test", `runner:edit` → "file edits (Runners)".
 *  For a terminal: control characters (escape codes from an older Trace) show as "?". */
export function kindName(kind: string): string {
  const runner = kind.startsWith("runner:"), k = (runner ? kind.slice(7) : kind).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  const [head, ...rest] = k.split(":"), tail = rest.join(":");
  const name = k === "command:(other)" ? "other commands" : head === "command" ? tail : head === "edit" ? "file edits" : head === "tool" ? tail
    : k === "delegate:local" ? "jobs for a local model" : k === "spec:discard" ? "discarding a Spec"
    : head === "always" ? `${tail}, always asks` : head === "other" ? `${tail}, no kind` : k;
  return runner ? `${name} (Runners)` : name;
}

/** One page of trace.list: the first `limit` events after seq `after`, or with no `after` the newest. */
export type TracePage = (after: number | undefined, limit: number) => Promise<TraceEvent[]>;

/** The events from `since` on, oldest first, read a page at a time with trace.list's `after`; only
 *  those `keep` wants are held. The first one in the window is found by a binary search on seq
 *  (one event per call), so a week's report does not read the whole Trace. Seq and time rise
 *  together in an append-only log; a clock set back can only move the start a little, and the
 *  report filters by time again. An older govd that ignores `after` repeats its newest page, which
 *  ends the reading rather than looping (as gov trace --jsonl does). */
export async function readTrace(page: TracePage, since: Date | undefined, keep: (e: TraceEvent) => boolean = () => true): Promise<TraceEvent[]> {
  const newest = (await page(undefined, 1)).at(-1);
  if (!newest) return [];
  let lo = 1, hi = newest.seq;
  if (since) {
    if (Date.parse(newest.ts) < since.getTime()) return [];
    // The smallest seq whose first event at or after it is in the window.
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2), first = (await page(mid - 1, 1))[0];
      if (first && Date.parse(first.ts) >= since.getTime()) hi = mid; else lo = mid + 1;
    }
  }
  const out: TraceEvent[] = [];
  for (let after = lo - 1; ;) {
    const got = (await page(after, 1000)).filter((e) => e.seq > after);
    for (const e of got) if (keep(e)) out.push(e);
    if (got.length < 1000) return out;
    after = got.at(-1)!.seq;
  }
}
