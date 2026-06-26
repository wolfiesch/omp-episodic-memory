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
import { isSessionFile, parseSessionFile, parseSessionFileStream } from "./parser.js";
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
  maxBytes?: number;
  /**
   * When set, skip files whose mtime changed less than this many ms ago
   * (still likely being written). Used by watch mode; default unset = index all.
   */
  minStableMs?: number;
  onProgress?: (p: IndexProgress) => void;
}

export interface IndexResult {
  filesProcessed: number;
  filesSkipped: number;
  filesSkippedOversize: number;
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
    const selectContent = db.prepare(
      `SELECT source_path, title, cwd, timestamp, user_text, assistant_text, tool_names
       FROM exchanges WHERE session_id=? AND ordinal=?`,
    );

    let filesProcessed = 0;
    let filesSkipped = 0;
    let filesSkippedOversize = 0;
    let exchangesUpserted = 0;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];

      const mtimeMs = statSync(file).mtimeMs;
      if (
        opts.minStableMs !== undefined &&
        !isStable(mtimeMs, Date.now(), opts.minStableMs)
      ) {
        // File was modified very recently; likely still being written. Skip
        // this round and pick it up on the next cycle once it settles.
        filesSkipped++;
        continue;
      }
      const storedRow = selectMtime.get(file) as IndexedFileRow | undefined;
      if (!shouldIndexFile(storedRow?.mtime_ms, mtimeMs, opts.force)) {
        filesSkipped++;
        continue;
      }

      let exchanges;
      try {
        exchanges = await parseSessionFileStream(file, {
          maxBytes: opts.maxBytes ?? 200 * 1024 * 1024,
        });
      } catch (err: any) {
        if (
          err &&
          typeof err === "object" &&
          "message" in err &&
          typeof err.message === "string" &&
          err.message.startsWith("session file too large")
        ) {
          filesSkippedOversize++;
          process.stderr.write(`Skipping file ${file} as it is too large: ${err.message}\n`);
          continue;
        }
        throw err;
      }

      // Compute embeddings first (async); better-sqlite3 transactions cannot span await.
      // Embedding is the costly step, so skip exchanges whose stored row already
      // matches the parsed values (mirror insertExchange's unchanged comparison).
      const insertables: InsertableExchange[] = [];
      for (const ex of exchanges) {
        const toolNamesJson = JSON.stringify(ex.toolNames);
        const existing = selectContent.get(ex.sessionId, ex.ordinal) as
          | {
              source_path: string;
              title: string | null;
              cwd: string | null;
              timestamp: number;
              user_text: string;
              assistant_text: string | null;
              tool_names: string | null;
            }
          | undefined;
        if (
          existing !== undefined &&
          existing.source_path === ex.sourcePath &&
          existing.title === ex.title &&
          existing.cwd === ex.cwd &&
          existing.timestamp === ex.timestamp &&
          existing.user_text === ex.userText &&
          (existing.assistant_text ?? "") === ex.assistantText &&
          (existing.tool_names ?? "[]") === toolNamesJson
        ) {
          continue;
        }

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

    return { filesProcessed, filesSkipped, filesSkippedOversize, exchangesUpserted };
  } finally {
    db.close();
  }
}

/**
 * Returns true when a file's mtime is old enough to be considered settled.
 * Pure helper: a file whose mtime changed less than `stableMs` ago is treated
 * as still being written and should be skipped this round.
 */
export function isStable(
  mtimeMs: number,
  now: number,
  stableMs: number,
): boolean {
  return now - mtimeMs >= stableMs;
}

export interface WatchOptions extends IndexOptions {
  /** Polling interval between re-index cycles, in ms. Default 5000. */
  intervalMs?: number;
  /**
   * A file whose mtime changed less than this many ms ago is considered
   * still-being-written and skipped this round. Default 2000.
   */
  stableMs?: number;
  /** Invoked after each cycle with the result and the wall-clock time. */
  onCycle?: (r: IndexResult & { at: number }) => void;
}

/**
 * Keep the index fresh during active OMP work via periodic background
 * re-indexing. Reuses the incremental `indexAll` (which skips unchanged files
 * by mtime). Polling-based — no fragile fs.watch dependency.
 *
 * Each cycle runs the incremental `indexAll` with `minStableMs` set from
 * `stableMs` (default 2000), so files modified within that window are treated
 * as still being written and deferred to a later cycle.
 */
export async function watchIndex(
  opts: WatchOptions = {},
): Promise<{ stop: () => void }> {
  const intervalMs = opts.intervalMs ?? 5000;
  const minStableMs = opts.stableMs ?? 2000;

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runCycle = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await indexAll({ ...opts, minStableMs });
      opts.onCycle?.({ ...result, at: Date.now() });
    } catch (err) {
      process.stderr.write(`watchIndex: cycle failed: ${String(err)}\n`);
    } finally {
      inFlight = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runCycle().finally(schedule);
    }, intervalMs);
  };

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // Initial cycle immediately, then chain polling cycles.
  await runCycle();
  schedule();

  return { stop };
}
