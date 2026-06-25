// Typed derived-memory layer: reviewable records distilled from raw episodes.
// Records are derived from source exchanges and MUST carry provenance.
// They default to status="pending"; only approved records are retrieved by default.
import type Database from "better-sqlite3";

/** Kinds of derived memory. */
export type MemoryType =
  | "fact"
  | "decision"
  | "runbook"
  | "gotcha"
  | "preference"
  | "project_state";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "fact",
  "decision",
  "runbook",
  "gotcha",
  "preference",
  "project_state",
];

/** Lifecycle status of a memory record. */
export type MemoryStatus = "pending" | "approved" | "rejected" | "superseded";

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "pending",
  "approved",
  "rejected",
  "superseded",
];

/** Provenance pointer back to the exact source exchange. */
export interface MemorySource {
  /** OMP session id of the source exchange. */
  sessionId: string;
  /** Zero-based ordinal of the source exchange within the session. */
  ordinal: number;
  /** Absolute path to the source .jsonl transcript. */
  sourcePath: string;
}

/** A derived memory record as stored. */
export interface MemoryRecord {
  id: number;
  type: MemoryType;
  title: string;
  body: string;
  /** Project / cwd association, else null. */
  project: string | null;
  /** Normalized entity names referenced by this record. */
  entities: string[];
  /** Unix SECONDS this memory becomes valid (defaults to earliest source ts). */
  validFrom: number | null;
  /** Unix SECONDS this memory stops being valid, else null (open-ended). */
  validTo: number | null;
  /** Heuristic/model confidence in [0,1]. */
  confidence: number;
  status: MemoryStatus;
  /** >=1 provenance pointer. */
  sources: MemorySource[];
  createdAt: number;
  updatedAt: number;
}

/** Input for inserting a new memory record (id/timestamps assigned by the DB). */
export interface NewMemoryRecord {
  type: MemoryType;
  title: string;
  body: string;
  project?: string | null;
  entities?: string[];
  validFrom?: number | null;
  validTo?: number | null;
  confidence: number;
  /** Defaults to "pending" when omitted. */
  status?: MemoryStatus;
  /** REQUIRED: at least one provenance pointer. */
  sources: MemorySource[];
}

export interface SearchMemoryOptions {
  /** Optional FTS query over title+body. When omitted, returns recent records. */
  query?: string;
  type?: MemoryType;
  project?: string;
  /** Status filter; defaults to "approved" (pending records excluded by default). */
  status?: MemoryStatus;
  limit?: number;
}

/** Idempotency key for a record: type + title + project. */
function dedupeKey(type: MemoryType, title: string, project: string | null): string {
  return `${type}\u0000${title}\u0000${project ?? ""}`;
}

/** Create the derived-memory tables. Safe to call repeatedly. */
export function initMemorySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      project TEXT,
      entities TEXT NOT NULL DEFAULT '[]',
      valid_from INTEGER,
      valid_to INTEGER,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(dedupe_key)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_records(status);
    CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_records(type);
    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_records(project);

    CREATE TABLE IF NOT EXISTS memory_record_sources (
      record_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      source_path TEXT NOT NULL,
      FOREIGN KEY(record_id) REFERENCES memory_records(id) ON DELETE CASCADE,
      UNIQUE(record_id, session_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_sources_record ON memory_record_sources(record_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_record_fts USING fts5(
      title,
      body,
      content='memory_records',
      content_rowid='id'
    );
  `);
}

interface MemoryRow {
  id: number;
  type: string;
  title: string;
  body: string;
  project: string | null;
  entities: string | null;
  valid_from: number | null;
  valid_to: number | null;
  confidence: number;
  status: string;
  created_at: number;
  updated_at: number;
}

function hydrate(db: Database.Database, row: MemoryRow): MemoryRecord {
  const sources = db
    .prepare(
      `SELECT session_id, ordinal, source_path
       FROM memory_record_sources WHERE record_id = ? ORDER BY session_id, ordinal`,
    )
    .all(row.id) as Array<{ session_id: string; ordinal: number; source_path: string }>;
  return {
    id: row.id,
    type: row.type as MemoryType,
    title: row.title,
    body: row.body,
    project: row.project,
    entities: JSON.parse(row.entities ?? "[]") as string[],
    validFrom: row.valid_from,
    validTo: row.valid_to,
    confidence: row.confidence,
    status: row.status as MemoryStatus,
    sources: sources.map((s) => ({
      sessionId: s.session_id,
      ordinal: s.ordinal,
      sourcePath: s.source_path,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function syncFts(db: Database.Database, rowid: number, title: string, body: string): void {
  db.prepare(
    `INSERT INTO memory_record_fts (rowid, title, body) VALUES (?, ?, ?)`,
  ).run(rowid, title, body);
}

function deleteFts(db: Database.Database, rowid: number, title: string, body: string): void {
  // External-content FTS5: use the 'delete' command with the OLD column values.
  db.prepare(
    `INSERT INTO memory_record_fts (memory_record_fts, rowid, title, body)
     VALUES ('delete', ?, ?, ?)`,
  ).run(rowid, title, body);
}

function replaceSources(db: Database.Database, recordId: number, sources: MemorySource[]): void {
  db.prepare(`DELETE FROM memory_record_sources WHERE record_id = ?`).run(recordId);
  const ins = db.prepare(
    `INSERT OR IGNORE INTO memory_record_sources (record_id, session_id, ordinal, source_path)
     VALUES (?, ?, ?, ?)`,
  );
  for (const s of sources) {
    ins.run(recordId, s.sessionId, s.ordinal, s.sourcePath);
  }
}

/**
 * Insert (or idempotently upsert) a derived memory record.
 * Dedupe key is (type, title, project): re-inserting the same logical record
 * updates it in place rather than duplicating. Returns the record id.
 * Throws if no provenance source is supplied.
 */
export function insertMemoryRecord(db: Database.Database, rec: NewMemoryRecord): number {
  if (!rec.sources || rec.sources.length === 0) {
    throw new Error("memory record requires at least one provenance source");
  }
  const now = Math.floor(Date.now() / 1000);
  const project = rec.project ?? null;
  const entities = JSON.stringify(rec.entities ?? []);
  const status = rec.status ?? "pending";
  const validFrom = rec.validFrom ?? null;
  const validTo = rec.validTo ?? null;
  const key = dedupeKey(rec.type, rec.title, project);

  const existing = db
    .prepare(`SELECT id, title, body FROM memory_records WHERE dedupe_key = ?`)
    .get(key) as { id: number; title: string; body: string } | undefined;

  if (existing) {
    deleteFts(db, existing.id, existing.title, existing.body);
    db.prepare(
      `UPDATE memory_records
       SET type = ?, title = ?, body = ?, project = ?, entities = ?,
           valid_from = ?, valid_to = ?, confidence = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      rec.type,
      rec.title,
      rec.body,
      project,
      entities,
      validFrom,
      validTo,
      rec.confidence,
      status,
      now,
      existing.id,
    );
    syncFts(db, existing.id, rec.title, rec.body);
    replaceSources(db, existing.id, rec.sources);
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO memory_records
        (type, title, body, project, entities, valid_from, valid_to, confidence, status, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.type,
      rec.title,
      rec.body,
      project,
      entities,
      validFrom,
      validTo,
      rec.confidence,
      status,
      key,
      now,
      now,
    );
  const id = Number(info.lastInsertRowid);
  syncFts(db, id, rec.title, rec.body);
  replaceSources(db, id, rec.sources);
  return id;
}

/** Update the lifecycle status of a record. Returns true if a row changed. */
export function updateMemoryStatus(
  db: Database.Database,
  id: number,
  status: MemoryStatus,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const info = db
    .prepare(`UPDATE memory_records SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, now, id);
  return info.changes > 0;
}

/** Update the validity end (`valid_to`) of a record. Returns true if a row changed. */
export function setMemoryValidTo(
  db: Database.Database,
  id: number,
  validTo: number | null,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const info = db
    .prepare(`UPDATE memory_records SET valid_to = ?, updated_at = ? WHERE id = ?`)
    .run(validTo, now, id);
  return info.changes > 0;
}

/** Fetch a single record (with sources) by id, or null. */
export function getMemoryRecord(db: Database.Database, id: number): MemoryRecord | null {
  const row = db.prepare(`SELECT * FROM memory_records WHERE id = ?`).get(id) as
    | MemoryRow
    | undefined;
  return row ? hydrate(db, row) : null;
}

function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return tokens.join(" OR ");
}

/**
 * Search derived memories. Defaults to status="approved" so pending records are
 * excluded unless explicitly requested. When `query` is omitted, returns the
 * most recently updated matching records.
 */
export function searchMemoryRecords(
  db: Database.Database,
  opts: SearchMemoryOptions = {},
): MemoryRecord[] {
  const status = opts.status ?? "approved";
  const limit = opts.limit ?? 20;
  const where: string[] = ["mr.status = ?"];
  const params: unknown[] = [status];

  if (opts.type) {
    where.push("mr.type = ?");
    params.push(opts.type);
  }
  if (opts.project) {
    where.push("mr.project = ?");
    params.push(opts.project);
  }

  let rows: MemoryRow[];
  const match = opts.query ? sanitizeFtsQuery(opts.query) : "";
  if (opts.query && match.length > 0) {
    rows = db
      .prepare(
        `SELECT mr.* FROM memory_record_fts f
         JOIN memory_records mr ON mr.id = f.rowid
         WHERE f.memory_record_fts MATCH ? AND ${where.join(" AND ")}
         ORDER BY f.rank
         LIMIT ?`,
      )
      .all(match, ...params, limit) as MemoryRow[];
  } else if (opts.query && match.length === 0) {
    // Query supplied but produced no usable tokens -> no matches.
    return [];
  } else {
    rows = db
      .prepare(
        `SELECT mr.* FROM memory_records mr
         WHERE ${where.join(" AND ")}
         ORDER BY mr.updated_at DESC, mr.id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as MemoryRow[];
  }

  return rows.map((r) => hydrate(db, r));
}

/** List records by status (for the review inbox). Most recent first. */
export function listMemoryRecords(
  db: Database.Database,
  status?: MemoryStatus,
  limit = 50,
): MemoryRecord[] {
  const rows = status
    ? (db
        .prepare(
          `SELECT * FROM memory_records WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(status, limit) as MemoryRow[])
    : (db
        .prepare(`SELECT * FROM memory_records ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .all(limit) as MemoryRow[]);
  return rows.map((r) => hydrate(db, r));
}
