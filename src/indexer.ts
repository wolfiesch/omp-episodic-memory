// Crawl OMP session transcripts, embed each exchange, and persist to the index DB.
// All logging goes to stderr; progress is reported via the onProgress callback.
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import {
  insertExchange,
  openDb,
  runInTransaction,
  type InsertableExchange,
} from "./db.js";
import { embedExchange, initEmbeddings } from "./embeddings.js";
import { isSessionFile, parseSessionFile } from "./parser.js";
import { DEFAULT_SESSIONS_DIR } from "./types.js";

export function findSessionFiles(root: string = DEFAULT_SESSIONS_DIR): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Tolerate unreadable directories.
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isSessionFile(entry.name)) {
        out.push(full);
      }
    }
  };

  walk(root);
  out.sort();
  return out;
}

export interface IndexProgress {
  file: string;
  fileIndex: number;
  totalFiles: number;
  exchanges: number;
}

export interface IndexOptions {
  dbPath?: string;
  sessionsDir?: string;
  maxFiles?: number;
  force?: boolean;
  onProgress?: (p: IndexProgress) => void;
}

export interface IndexResult {
  filesProcessed: number;
  filesSkipped: number;
  exchangesUpserted: number;
}

interface IndexedFileRow {
  mtime_ms: number;
}

/** Create the table that tracks which files have been indexed and at what mtime. */
export function ensureIndexStateTable(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS indexed_files (path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, indexed_at INTEGER NOT NULL)`,
  );
}

/** Decide whether a file needs (re)indexing given its stored vs current mtime. */
export function shouldIndexFile(
  storedMtimeMs: number | undefined,
  currentMtimeMs: number,
  force?: boolean,
): boolean {
  if (force) return true;
  if (storedMtimeMs === undefined) return true;
  return storedMtimeMs !== currentMtimeMs;
}

export async function indexAll(opts: IndexOptions = {}): Promise<IndexResult> {
  const db = openDb(opts.dbPath);
  try {
    await initEmbeddings();
    ensureIndexStateTable(db);

    let files = findSessionFiles(opts.sessionsDir);
    if (opts.maxFiles !== undefined) {
      files = files.slice(0, opts.maxFiles);
    }

    const selectMtime = db.prepare(
      `SELECT mtime_ms FROM indexed_files WHERE path = ?`,
    );
    const upsertMtime = db.prepare(
      `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?,?,?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at`,
    );

    let filesProcessed = 0;
    let filesSkipped = 0;
    let exchangesUpserted = 0;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];

      const mtimeMs = statSync(file).mtimeMs;
      const storedRow = selectMtime.get(file) as IndexedFileRow | undefined;
      if (!shouldIndexFile(storedRow?.mtime_ms, mtimeMs, opts.force)) {
        filesSkipped++;
        continue;
      }

      const exchanges = parseSessionFile(file);

      // Compute embeddings first (async); better-sqlite3 transactions cannot span await.
      const insertables: InsertableExchange[] = [];
      for (const ex of exchanges) {
        const embedding = await embedExchange(
          ex.userText,
          ex.assistantText,
          ex.toolNames,
        );
        insertables.push({ ...ex, embedding });
      }

      // Synchronous inserts only inside the transaction.
      const insertedForFile = runInTransaction(db, () => {
        let inserted = 0;
        for (const ins of insertables) {
          if (insertExchange(db, ins)) inserted++;
        }
        upsertMtime.run(file, mtimeMs, Date.now());
        return inserted;
      });

      filesProcessed++;
      exchangesUpserted += insertedForFile;

      opts.onProgress?.({
        file,
        fileIndex,
        totalFiles: files.length,
        exchanges: insertedForFile,
      });
    }

    return { filesProcessed, filesSkipped, exchangesUpserted };
  } finally {
    db.close();
  }
}
