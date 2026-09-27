// The Trace: an append-only event log in SQLite, plus the one projection phase 0 needs
// (projects). Events are never updated or deleted; projections are rebuilt from them.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ControllerChoice, Spec, SpecInput, SpecStatus, TraceEvent } from "@governcode/protocol";

export type Project = { name: string; path: string; created: string; controller: ControllerChoice };

const DEFAULT_CONTROLLER: ControllerChoice = { provider: "claude-code", model: "opus", effort: "high" };

export class Ledger {
  private db: DatabaseSync;
  private listeners = new Set<(e: TraceEvent) => void>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
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

  events(project: string | undefined, limit: number): TraceEvent[] {
    const rows = (project
      ? this.db.prepare("SELECT * FROM events WHERE project = ? ORDER BY seq DESC LIMIT ?").all(project, limit)
      : this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit)) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({ ...(r as unknown as TraceEvent), data: JSON.parse(String(r.data)) }));
  }

  // --- projects (a projection kept in step with project.* events, in one transaction)
  addProject(name: string, path: string, kind: "project.created" | "project.opened"): Project {
    const created = new Date().toISOString();
    const project: Project = { name, path, created, controller: DEFAULT_CONTROLLER };
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO projects (name, path, created, controller) VALUES (?, ?, ?, ?)")
        .run(name, path, created, JSON.stringify(project.controller));
      this.append(name, kind, "user", { path });
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

  updateSpec(id: string, change: Partial<Pick<Spec, "status" | "checkpoints" | "files" | "note">>, actor: string): Spec {
    const kinds: Partial<Record<SpecStatus, TraceEvent["kind"]>> = { held: "spec.held", running: "spec.started",
      "needs-review": "spec.done", failed: "spec.failed", accepted: "spec.accepted", undone: "spec.undone" };
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
    return row ? JSON.parse(row.body) : undefined;
  }

  specs(project?: string): Spec[] {
    const rows = (project ? this.db.prepare("SELECT body FROM specs WHERE project = ? ORDER BY id").all(project)
                          : this.db.prepare("SELECT body FROM specs ORDER BY id").all()) as Array<{ body: string }>;
    return rows.map((r) => JSON.parse(r.body));
  }

  close(): void {
    this.db.close();
  }
}
