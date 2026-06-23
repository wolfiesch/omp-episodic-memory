// SQLite schema owner: FTS5 (keyword) + vec0 (vector) over the same exchanges.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DEFAULT_DB_PATH, EMBEDDING_DIM, type Exchange } from "./types.js";

export function openDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  initSchema(db);
  return db;
}

export function openReadOnlyDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Index DB not found: ${dbPath}. Run "omp-episodic index" first.`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  sqliteVec.load(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      ordinal INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      user_text TEXT NOT NULL,
      assistant_text TEXT,
      tool_names TEXT,
      UNIQUE(session_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_exchanges_timestamp ON exchanges(timestamp);

    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      user_text,
      assistant_text,
      tool_names,
      content='exchanges',
      content_rowid='id'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_vec USING vec0(
      embedding float[${EMBEDDING_DIM}]
    );
  `);
}

export interface InsertableExchange extends Exchange {
  embedding: Float32Array;
}

export function insertExchange(db: Database.Database, ex: InsertableExchange): boolean {
  const toolNamesJson = JSON.stringify(ex.toolNames);
  const existing = db
    .prepare(
      `SELECT id, source_path, title, cwd, timestamp, user_text, assistant_text, tool_names
       FROM exchanges
       WHERE session_id = ? AND ordinal = ?`,
    )
    .get(ex.sessionId, ex.ordinal) as
    | {
        id: number;
        source_path: string;
        title: string | null;
        cwd: string | null;
        timestamp: number;
        user_text: string;
        assistant_text: string | null;
        tool_names: string | null;
      }
    | undefined;

  let rowid: number;
  if (existing) {
    const unchanged =
      existing.source_path === ex.sourcePath &&
      existing.title === ex.title &&
      existing.cwd === ex.cwd &&
      existing.timestamp === ex.timestamp &&
      existing.user_text === ex.userText &&
      (existing.assistant_text ?? "") === ex.assistantText &&
      (existing.tool_names ?? "[]") === toolNamesJson;
    if (unchanged) return false;

    rowid = existing.id;
    db.prepare(
      `UPDATE exchanges
       SET source_path = ?, title = ?, cwd = ?, timestamp = ?,
           user_text = ?, assistant_text = ?, tool_names = ?
       WHERE id = ?`,
    ).run(
      ex.sourcePath,
      ex.title,
      ex.cwd,
      ex.timestamp,
      ex.userText,
      ex.assistantText,
      toolNamesJson,
      rowid,
    );
    db.prepare(`DELETE FROM exchanges_fts WHERE rowid = ?`).run(rowid);
    db.prepare(`DELETE FROM exchanges_vec WHERE rowid = ?`).run(BigInt(rowid));
  } else {
    const insert = db
      .prepare(
        `INSERT INTO exchanges
          (session_id, source_path, title, cwd, ordinal, timestamp, user_text, assistant_text, tool_names)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ex.sessionId,
        ex.sourcePath,
        ex.title,
        ex.cwd,
        ex.ordinal,
        ex.timestamp,
        ex.userText,
        ex.assistantText,
        toolNamesJson,
      );
    rowid = Number(insert.lastInsertRowid);
  }

  db.prepare(
    `INSERT INTO exchanges_fts (rowid, user_text, assistant_text, tool_names)
     VALUES (?, ?, ?, ?)`,
  ).run(rowid, ex.userText, ex.assistantText, toolNamesJson);

  db.prepare(
    `INSERT INTO exchanges_vec (rowid, embedding) VALUES (?, ?)`,
  ).run(BigInt(rowid), new Uint8Array(ex.embedding.buffer));

  return true;
}

export function getStats(db: Database.Database): {
  exchanges: number;
  sessions: number;
  earliest: number | null;
  latest: number | null;
} {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS exchanges,
         COUNT(DISTINCT session_id) AS sessions,
         MIN(timestamp) AS earliest,
         MAX(timestamp) AS latest
       FROM exchanges`,
    )
    .get() as {
    exchanges: number;
    sessions: number;
    earliest: number | null;
    latest: number | null;
  };
  return row;
}

export function runInTransaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}
