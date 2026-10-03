// The Trace: an append-only event log in SQLite, plus the one projection phase 0 needs
// (projects). Events are never updated or deleted; projections are rebuilt from them.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ControllerChoice, Spec, SpecInput, SpecStatus, TraceEvent } from "@governcode/protocol";

export type Project = { name: string; path: string; created: string; controller: ControllerChoice };

const DEFAULT_CONTROLLER: ControllerChoice = { provider: "claude-code", model: "opus", effort: "high" };

// A discarded Spec was stored as "undone" before 0.1.0-motion.9: read as what it is.
const specOf = (body: string): Spec => { const s = JSON.parse(body); return s.status === "undone" ? { ...s, status: "discarded" } : s; };

export class Ledger {
  private db: DatabaseSync;
  private listeners = new Set<(e: TraceEvent) => void>();
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") {
      // The Trace holds prompts: owner-only, whatever the umask says.
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, project TEXT, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        name TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, created TEXT NOT NULL, controller TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS specs (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL);
    `);
  }

  append(project: string | null, kind: TraceEvent["kind"], actor: string, data: Record<string, unknown> = {}): TraceEvent {
    const ts = new Date().toISOString();
    // govd has stopped: a tool still winding down records nothing more (a restart closes what it left open).
    if (this.closed) return { seq: 0, ts, project, kind, actor, data };
    const row = this.db
      .prepare("INSERT INTO events (ts, project, kind, actor, data) VALUES (?, ?, ?, ?, ?) RETURNING seq")
      .get(ts, project, kind, actor, JSON.stringify(data)) as { seq: number };
    const event: TraceEvent = { seq: row.seq, ts, project, kind, actor, data };
    for (const listen of this.listeners) listen(event);
    return event;
  }

  subscribe(listen: (e: TraceEvent) => void): () => void {
    this.listeners.add(listen);
    return () => this.listeners.delete(listen);
  }

  /** The newest events, newest last; with `after`, the first ones after that seq (an export pages with it). */
  events(project: string | undefined, limit: number, after?: number): TraceEvent[] {
    const rows = (after !== undefined
      ? (project ? this.db.prepare("SELECT * FROM events WHERE project = ? AND seq > ? ORDER BY seq LIMIT ?").all(project, after, limit)
        : this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit))
      : (project ? this.db.prepare("SELECT * FROM events WHERE project = ? ORDER BY seq DESC LIMIT ?").all(project, limit)
        : this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit)).reverse()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...(r as unknown as TraceEvent), data: JSON.parse(String(r.data)) }));
  }

  /** A project's events of some kinds, newest last (all of its history, not a recent window). */
  eventsOfKind(project: string | null, kinds: TraceEvent["kind"][], limit = 500): TraceEvent[] {
    const where = project === null ? "project IS NULL" : "project = ?";
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where} AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY seq DESC LIMIT ?`)
      .all(...(project === null ? [] : [project]), ...kinds, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({ ...(r as unknown as TraceEvent), data: JSON.parse(String(r.data)) }));
  }

  /** A project's events of some kinds strictly between `after` and `before` (seq numbers): the
   *  newest `limit` of them, or with `oldest` the first `limit`, newest last either way. */
  eventsOfKindIn(project: string | null, kinds: TraceEvent["kind"][], after: number, before: number, limit: number, oldest = false): TraceEvent[] {
    const where = project === null ? "project IS NULL" : "project = ?";
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where} AND kind IN (${kinds.map(() => "?").join(",")}) AND seq > ? AND seq < ?
      ORDER BY seq ${oldest ? "ASC" : "DESC"} LIMIT ?`)
      .all(...(project === null ? [] : [project]), ...kinds, after, before, limit) as Array<Record<string, unknown>>;
    return (oldest ? rows : rows.reverse()).map((r) => ({ ...(r as unknown as TraceEvent), data: JSON.parse(String(r.data)) }));
  }

  /** The newest event of a kind in any project (all of history). */
  lastOfKind(kind: TraceEvent["kind"]): TraceEvent | undefined {
    const r = this.db.prepare("SELECT * FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1").get(kind) as Record<string, unknown> | undefined;
    return r && { ...(r as unknown as TraceEvent), data: JSON.parse(String(r.data)) };
  }

  /** Every Controller provider that has had a turn in the project (all of history). */
  turnProviders(project: string): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT json_extract(data, '$.controller.provider') AS p FROM events
      WHERE project = ? AND kind = 'turn.started'`).all(project) as Array<{ p: unknown }>;
    return rows.map((r) => r.p).filter((p): p is string => typeof p === "string" && p.length > 0);
  }

  /** The user's latest share answer for each provider (all of history). */
  latestShares(project: string): Record<string, boolean> {
    const rows = this.db.prepare(`SELECT json_extract(data, '$.provider') AS p, json_extract(data, '$.share') AS s FROM events
      WHERE project = ? AND kind = 'context.shared' ORDER BY seq`).all(project) as Array<{ p: unknown; s: unknown }>;
    const out: Record<string, boolean> = {};
    for (const r of rows) if (typeof r.p === "string") out[r.p] = r.s === 1 || r.s === true;
    return out;
  }

  /** The project's newest Specs, oldest first. */
  recentSpecs(project: string, n: number): Spec[] {
    // Insertion order (rowid), not the id's text: S-10000 sorts before S-9999 as text.
    const rows = this.db.prepare("SELECT body FROM specs WHERE project = ? ORDER BY rowid DESC LIMIT ?").all(project, n) as Array<{ body: string }>;
    return rows.reverse().map((r) => JSON.parse(r.body));
  }

  // --- projects (a projection kept in step with project.* events, in one transaction)
  addProject(name: string, path: string, kind: "project.created" | "project.opened", data: Record<string, unknown> = {}): Project {
    const created = new Date().toISOString();
    const project: Project = { name, path, created, controller: DEFAULT_CONTROLLER };
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO projects (name, path, created, controller) VALUES (?, ?, ?, ?)")
        .run(name, path, created, JSON.stringify(project.controller));
      this.append(name, kind, "user", { path, ...data });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return project;
  }

  setController(name: string, controller: ControllerChoice): void {
    this.db.prepare("UPDATE projects SET controller = ? WHERE name = ?").run(JSON.stringify(controller), name);
    this.append(name, "controller.set", "user", controller);
  }

  projects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY name").all() as Array<Record<string, string>>)
      .map((r) => ({ name: r.name, path: r.path, created: r.created, controller: JSON.parse(r.controller) }));
  }

  project(name: string): Project | undefined {
    return this.projects().find((p) => p.name === name);
  }

  // --- specs (a projection of spec.* events, updated in the same transaction)
  private tx<T>(f: () => T): T {
    this.db.exec("BEGIN");
    try { const r = f(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  createSpec(project: string, input: SpecInput, actor: string): Spec {
    return this.tx(() => {
      const n = (this.db.prepare("SELECT COUNT(*) AS n FROM specs").get() as { n: number }).n + 1;
      const spec: Spec = { ...input, id: `S-${String(n).padStart(4, "0")}`, project, status: "queued",
        created: new Date().toISOString(), checkpoints: { before: null, after: null }, files: [] };
      this.db.prepare("INSERT INTO specs (id, project, body) VALUES (?, ?, ?)").run(spec.id, project, JSON.stringify(spec));
      this.append(project, "spec.created", actor, { spec: spec.id, to: spec.to, model: spec.model, effort: spec.effort, reason: spec.reason });
      return spec;
    });
  }

  updateSpec(id: string, change: Partial<Pick<Spec, "status" | "checkpoints" | "files" | "note" | "turn" | "delivery" | "summaries" | "limited" | "model" | "effort" | "budgetPercent">>, actor: string): Spec {
    const kinds: Partial<Record<SpecStatus, TraceEvent["kind"]>> = { held: "spec.held", running: "spec.started",
      "needs-review": "spec.done", failed: "spec.failed", accepted: "spec.accepted", discarded: "spec.discarded", cancelled: "spec.cancelled" };
    // (Who asked for a cancel, and why, is recorded when they ask: spec.cancel.)
    return this.tx(() => {
      const spec = this.spec(id);
      if (!spec) throw new Error(`no spec ${id}`);
      const next: Spec = { ...spec, ...change };
      this.db.prepare("UPDATE specs SET body = ? WHERE id = ?").run(JSON.stringify(next), id);
      const kind = change.status && kinds[change.status];
      if (kind) this.append(spec.project, kind, actor, { spec: id, ...(change.note ? { note: change.note } : {}), ...(change.files ? { files: change.files.length } : {}) });
      return next;
    });
  }

  spec(id: string): Spec | undefined {
    const row = this.db.prepare("SELECT body FROM specs WHERE id = ?").get(id) as { body: string } | undefined;
    return row ? specOf(row.body) : undefined;
  }

  specs(project?: string): Spec[] {
    const rows = (project ? this.db.prepare("SELECT body FROM specs WHERE project = ? ORDER BY id").all(project)
                          : this.db.prepare("SELECT body FROM specs ORDER BY id").all()) as Array<{ body: string }>;
    return rows.map((r) => specOf(r.body));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
