// SQLite schema owner: FTS5 (keyword) + vec0 (vector) over the same exchanges.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { DEFAULT_DB_PATH, EMBEDDING_DIM, type Exchange } from "./types.js";
import { initMemorySchema } from "./memory.js";
import { initGraphSchema } from "./graph.js";
import { initBlocksSchema } from "./blocks.js";
import {
  compressToolEvents,
  serializeToolEventMetadata,
  toolEventsIndexText,
} from "./tool-events.js";

const SCHEMA_VERSION = 2;
const OUTDATED_SCHEMA_MESSAGE =
  'Index DB schema is outdated. Run "omp-episodic migrate" to rebuild it safely.';

function tableExists(db: Database.Database, table: string): boolean {
  return db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`)
    .get(table) !== undefined;
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function exchangeSchemaIsCurrent(db: Database.Database): boolean {
  if (!tableExists(db, "exchanges") || !tableExists(db, "exchanges_fts")) {
    return false;
  }
  const exchangeColumns = tableColumns(db, "exchanges");
  const ftsSql = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'exchanges_fts'`)
    .pluck()
    .get() as string | undefined;
  if (ftsSql === undefined) return false;
  return (
    exchangeColumns.includes("tool_events") &&
    exchangeColumns.includes("tool_metadata") &&
    exchangeColumns.includes("content_hash") &&
    !exchangeColumns.includes("tool_event_text") &&
    tableColumns(db, "exchanges_fts").includes("tool_event_text") &&
    ftsSql.includes("content=''") &&
    ftsSql.includes("contentless_delete=1") &&
    ftsSql.includes("detail=full")
  );
}

export function openDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    sqliteVec.load(db);
    db.pragma("journal_mode = WAL");
    initSchema(db);
    initMemorySchema(db);
    initGraphSchema(db);
    initBlocksSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openReadOnlyDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`Index DB not found: ${dbPath}. Run "omp-episodic index" first.`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
    if (!exchangeSchemaIsCurrent(db)) throw new Error(OUTDATED_SCHEMA_MESSAGE);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createExchangeSchema(db: Database.Database): void {
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
      tool_names TEXT NOT NULL,
      tool_events BLOB NOT NULL,
      tool_metadata TEXT NOT NULL,
      content_hash BLOB NOT NULL,
      UNIQUE(session_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_exchanges_timestamp ON exchanges(timestamp);

    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      user_text,
      assistant_text,
      tool_names,
      tool_event_text,
      content='',
      contentless_delete=1,
      detail=full
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_vec USING vec0(
      embedding float[${EMBEDDING_DIM}]
    );
  `);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export function initSchema(db: Database.Database): void {
  if (tableExists(db, "exchanges") && !exchangeSchemaIsCurrent(db)) {
    throw new Error(OUTDATED_SCHEMA_MESSAGE);
  }
  createExchangeSchema(db);
}

export interface InsertableExchange extends Exchange {
  embedding: Float32Array;
}

export interface PreparedExchange {
  toolNamesJson: string;
  toolEventsCompressed: Buffer;
  toolMetadataJson: string;
  toolEventText: string;
  contentHash: Buffer;
}

export function prepareExchange(ex: Exchange): PreparedExchange {
  const toolNamesJson = JSON.stringify(ex.toolNames);
  const toolEventsCompressed = compressToolEvents(ex.toolEvents);
  const toolMetadataJson = serializeToolEventMetadata(ex.toolEvents);
  const toolEventText = toolEventsIndexText(ex.toolEvents);
  const hash = createHash("sha256");
  for (const value of [
    ex.sourcePath,
    ex.title ?? "",
    ex.cwd ?? "",
    String(ex.timestamp),
    ex.userText,
    ex.assistantText,
    toolNamesJson,
    toolEventsCompressed,
  ]) {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
  }
  return {
    toolNamesJson,
    toolEventsCompressed,
    toolMetadataJson,
    toolEventText,
    contentHash: hash.digest(),
  };
}

export function insertExchange(
  db: Database.Database,
  ex: InsertableExchange,
  prepared: PreparedExchange = prepareExchange(ex),
): boolean {
  const existing = db
    .prepare(
      `SELECT id, content_hash
       FROM exchanges
       WHERE session_id = ? AND ordinal = ?`,
    )
    .get(ex.sessionId, ex.ordinal) as { id: number; content_hash: Buffer } | undefined;

  let rowid: number;
  if (existing) {
    if (existing.content_hash.equals(prepared.contentHash)) return false;

    rowid = existing.id;
    db.prepare(
      `UPDATE exchanges
       SET source_path = ?, title = ?, cwd = ?, timestamp = ?,
           user_text = ?, assistant_text = ?, tool_names = ?, tool_events = ?,
           tool_metadata = ?, content_hash = ?
       WHERE id = ?`,
    ).run(
      ex.sourcePath,
      ex.title,
      ex.cwd,
      ex.timestamp,
      ex.userText,
      ex.assistantText,
      prepared.toolNamesJson,
      prepared.toolEventsCompressed,
      prepared.toolMetadataJson,
      prepared.contentHash,
      rowid,
    );
    db.prepare(`DELETE FROM exchanges_fts WHERE rowid = ?`).run(rowid);
    db.prepare(`DELETE FROM exchanges_vec WHERE rowid = ?`).run(BigInt(rowid));
  } else {
    const insert = db
      .prepare(
        `INSERT INTO exchanges
          (session_id, source_path, title, cwd, ordinal, timestamp, user_text, assistant_text,
           tool_names, tool_events, tool_metadata, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        prepared.toolNamesJson,
        prepared.toolEventsCompressed,
        prepared.toolMetadataJson,
        prepared.contentHash,
      );
    rowid = Number(insert.lastInsertRowid);
  }

  db.prepare(
    `INSERT INTO exchanges_fts (rowid, user_text, assistant_text, tool_names, tool_event_text)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    rowid,
    ex.userText,
    ex.assistantText,
    prepared.toolNamesJson,
    prepared.toolEventText,
  );

  db.prepare(
    `INSERT INTO exchanges_vec (rowid, embedding) VALUES (?, ?)`,
  ).run(BigInt(rowid), new Uint8Array(ex.embedding.buffer));

  return true;
}

/**
 * Delete exchange rows and their manually maintained FTS/vector index entries.
 * Contentless FTS tables cannot use external-content triggers, so this is the
 * single deletion path for indexed exchanges.
 */
export function deleteExchangesByIds(
  db: Database.Database,
  rowids: readonly number[],
): number {
  const uniqueRowids = [...new Set(rowids)];
  if (uniqueRowids.length === 0) return 0;

  return runInTransaction(db, () => {
    const deleteFts = db.prepare(`DELETE FROM exchanges_fts WHERE rowid = ?`);
    const deleteVector = db.prepare(`DELETE FROM exchanges_vec WHERE rowid = ?`);
    const deleteExchange = db.prepare(`DELETE FROM exchanges WHERE id = ?`);
    let deleted = 0;
    for (const rowid of uniqueRowids) {
      deleteFts.run(rowid);
      deleteVector.run(BigInt(rowid));
      deleted += deleteExchange.run(rowid).changes;
    }
    return deleted;
  });
}

export interface IndexStats {
  exchanges: number;
  sessions: number;
  earliest: number | null;
  latest: number | null;
}

export function getStats(db: Database.Database): IndexStats {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS exchanges,
         COUNT(DISTINCT session_id) AS sessions,
         MIN(timestamp) AS earliest,
         MAX(timestamp) AS latest
       FROM exchanges`,
    )
    .get() as IndexStats;
}

export function runInTransaction<T>(db: Database.Database, fn: () => T): T {
  return db.transaction(fn)();
}
