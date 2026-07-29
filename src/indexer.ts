// Crawl OMP session transcripts, embed each exchange, and persist to the index DB.
// All logging goes to stderr; progress is reported via the onProgress callback.
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";
import {
  deleteExchangesByIds,
  insertExchange,
  openDb,
  prepareExchange,
  runInTransaction,
} from "./db.js";
import { embedExchange, initEmbeddings } from "./embeddings.js";
import { isSessionFile, iterateSessionFile, parseSessionFile } from "./parser.js";
import { DEFAULT_SESSIONS_DIR } from "./types.js";

function globToRegExp(pattern: string): RegExp {
  let glob = pattern;
  // A leading "./" anchors to the root and is redundant for relative paths.
  if (glob.startsWith("./")) glob = glob.slice(2);
  // A trailing slash denotes a directory: exclude everything beneath it.
  if (glob.endsWith("/")) glob += "**";
  let source = "^";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const next = glob[i + 1];
    if (char === "*" && next === "*") {
      // A "**/" segment matches any number of directories, including zero, so
      // both `a/**/c` -> `a/c` and a leading `**/c` -> `c` match. A bare trailing
      // "**" matches anything that follows.
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i++;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function matchesIgnore(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.split(sep).join("/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function readIgnorePatterns(root: string): string[] {
  const ignorePath = join(root, ".omp-episodic-ignore");
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

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
  const patterns = readIgnorePatterns(root);
  const filtered = patterns.length === 0
    ? out
    : out.filter((file) => !matchesIgnore(relative(root, file), patterns));
  filtered.sort();
  return filtered;
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

type IndexedFileOutcome = "indexed" | "oversize" | "failed";

interface IndexedFileRow {
  mtime_ms: number;
  indexed_at: number;
  outcome: IndexedFileOutcome | null;
  size_bytes: number | null;
  attempted_cap_bytes: number | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
}

const INDEX_STATE_COLUMNS = [
  ["outcome", "TEXT"],
  ["size_bytes", "INTEGER"],
  ["attempted_cap_bytes", "INTEGER"],
  ["last_attempt_at", "INTEGER"],
  ["last_success_at", "INTEGER"],
] as const;

/** Create or migrate the durable per-source indexing state in place. */
export function ensureIndexStateTable(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS indexed_files (path TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, indexed_at INTEGER NOT NULL)`,
  );
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(indexed_files)`).all() as Array<{ name: string }>)
      .map(({ name }) => name),
  );
  for (const [name, type] of INDEX_STATE_COLUMNS) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE indexed_files ADD COLUMN ${name} ${type}`);
    }
  }
}

function isWithinDirectory(path: string, directory: string): boolean {
  const relativePath = relative(resolve(directory), resolve(path));
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/**
 * Remove exchanges whose previously indexed source file no longer exists.
 * Only records beneath the active sessions root are eligible.
 */
export function reconcileDeletedSources(
  db: Database.Database,
  sessionsDir: string,
): number {
  ensureIndexStateTable(db);
  const indexedPaths = db
    .prepare(`SELECT path FROM indexed_files`)
    .pluck()
    .all() as string[];
  const selectExchangeIds = db
    .prepare(`SELECT id FROM exchanges WHERE source_path = ?`)
    .pluck();
  const deleteIndexedFile = db
    .prepare(`DELETE FROM indexed_files WHERE path = ?`);
  let deleted = 0;

  for (const path of indexedPaths) {
    if (!isWithinDirectory(path, sessionsDir) || existsSync(path)) continue;
    deleted += deleteExchangesByIds(db, selectExchangeIds.all(path) as number[]);
    deleteIndexedFile.run(path);
  }
  return deleted;
}

interface ExchangeOrdinalRow {
  id: number;
  session_id: string;
  ordinal: number;
}

/** Remove rows left behind when a successfully parsed source file shrinks. */
export function pruneSourceExchanges(
  db: Database.Database,
  sourcePath: string,
  seen: ReadonlyArray<{ sessionId: string; ordinal: number }>,
): number {
  const seenKeys = new Set(
    seen.map(({ sessionId, ordinal }) => `${sessionId}\0${ordinal}`),
  );
  const rows = db
    .prepare(`SELECT id, session_id, ordinal FROM exchanges WHERE source_path = ?`)
    .all(sourcePath) as ExchangeOrdinalRow[];
  const staleRowids: number[] = [];
  for (const row of rows) {
    if (!seenKeys.has(`${row.session_id}\0${row.ordinal}`)) staleRowids.push(row.id);
  }
  return deleteExchangesByIds(db, staleRowids);
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
    reconcileDeletedSources(db, opts.sessionsDir ?? DEFAULT_SESSIONS_DIR);
    if (opts.maxFiles !== undefined) {
      files = files.slice(0, opts.maxFiles);
    }

    const selectIndexState = db.prepare(
      `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
              last_attempt_at, last_success_at
       FROM indexed_files WHERE path = ?`,
    );
    const upsertOversize = db.prepare(
      `INSERT INTO indexed_files
         (path, mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
          last_attempt_at, last_success_at)
       VALUES (?, ?, ?, 'oversize', ?, ?, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms=excluded.mtime_ms,
         indexed_at=excluded.indexed_at,
         outcome='oversize',
         size_bytes=excluded.size_bytes,
         attempted_cap_bytes=excluded.attempted_cap_bytes,
         last_attempt_at=excluded.last_attempt_at`,
    );
    const upsertIndexed = db.prepare(
      `INSERT INTO indexed_files
         (path, mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
          last_attempt_at, last_success_at)
       VALUES (?, ?, ?, 'indexed', ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms=excluded.mtime_ms,
         indexed_at=excluded.indexed_at,
         outcome='indexed',
         size_bytes=excluded.size_bytes,
         attempted_cap_bytes=excluded.attempted_cap_bytes,
         last_attempt_at=excluded.last_attempt_at,
         last_success_at=excluded.last_success_at`,
    );
    const upsertFailed = db.prepare(
      `INSERT INTO indexed_files
         (path, mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
          last_attempt_at, last_success_at)
       VALUES (?, ?, ?, 'failed', ?, ?, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms=excluded.mtime_ms,
         indexed_at=excluded.indexed_at,
         outcome='failed',
         size_bytes=excluded.size_bytes,
         attempted_cap_bytes=excluded.attempted_cap_bytes,
         last_attempt_at=excluded.last_attempt_at`,
    );
    const classifyLegacyIndexed = db.prepare(
      `UPDATE indexed_files
       SET outcome='indexed',
           size_bytes=?,
           last_success_at=indexed_at
       WHERE path=? AND outcome IS NULL`,
    );
    const selectContentHash = db.prepare(
      `SELECT content_hash
       FROM exchanges WHERE session_id=? AND ordinal=?`,
    );

    let filesProcessed = 0;
    let filesSkipped = 0;
    let filesSkippedOversize = 0;
    let exchangesUpserted = 0;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];

      const stats = statSync(file);
      const mtimeMs = stats.mtimeMs;
      const sizeBytes = stats.size;
      const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
      if (
        opts.minStableMs !== undefined &&
        !isStable(mtimeMs, Date.now(), opts.minStableMs)
      ) {
        // File was modified very recently; likely still being written. Skip
        // this round and pick it up on the next cycle once it settles.
        filesSkipped++;
        continue;
      }
      const storedRow = selectIndexState.get(file) as IndexedFileRow | undefined;
      const unchangedSource =
        storedRow?.mtime_ms === mtimeMs &&
        (storedRow.size_bytes === null || storedRow.size_bytes === sizeBytes);

      if (sizeBytes > maxBytes) {
        if (
          storedRow?.outcome === "oversize" &&
          storedRow.mtime_ms === mtimeMs &&
          storedRow.size_bytes === sizeBytes
        ) {
          filesSkipped++;
          continue;
        }
        const attemptedAt = Date.now();
        runInTransaction(db, () => {
          upsertOversize.run(
            file,
            mtimeMs,
            attemptedAt,
            sizeBytes,
            maxBytes,
            attemptedAt,
          );
        });
        filesSkippedOversize++;
        process.stderr.write(
          `Skipping file ${file} as it is too large: session file too large: size ${sizeBytes} exceeds limit ${maxBytes}\n`,
        );
        continue;
      }

      const hasSuccessfulOutcome =
        storedRow?.outcome === "indexed" || storedRow?.outcome === null;
      if (
        hasSuccessfulOutcome &&
        unchangedSource &&
        !shouldIndexFile(storedRow?.mtime_ms, mtimeMs, opts.force)
      ) {
        if (storedRow?.outcome === null) {
          classifyLegacyIndexed.run(sizeBytes, file);
        }
        filesSkipped++;
        continue;
      }

      let insertedForFile = 0;
      const seenExchanges: Array<{ sessionId: string; ordinal: number }> = [];
      try {
        // Consume exchanges incrementally: do not materialize a per-session Exchange[]
        // before embedding/upserting. The file mtime is marked only after the iterator
        // completes, so parse/embed failures never make a partial file look current.
        for await (const ex of iterateSessionFile(file, {
          maxBytes,
        })) {
          seenExchanges.push({
            sessionId: ex.sessionId,
            ordinal: ex.ordinal,
          });
          const prepared = prepareExchange(ex);
          const existing = selectContentHash.get(ex.sessionId, ex.ordinal) as
            | { content_hash: Buffer }
            | undefined;
          if (
            existing !== undefined &&
            existing.content_hash.equals(prepared.contentHash)
          ) {
            continue;
          }

          const embedding = await embedExchange(
            ex.userText,
            ex.assistantText,
            ex.toolNames,
            ex.toolEvents,
          );
          const inserted = runInTransaction(db, () =>
            insertExchange(db, { ...ex, embedding }, prepared) ? 1 : 0,
          );
          insertedForFile += inserted;
        }
        const completedAt = Date.now();
        runInTransaction(db, () => {
          pruneSourceExchanges(db, file, seenExchanges);
          upsertIndexed.run(
            file,
            mtimeMs,
            completedAt,
            sizeBytes,
            maxBytes,
            completedAt,
            completedAt,
          );
        });
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "message" in err &&
          typeof err.message === "string" &&
          err.message.startsWith("session file too large")
        ) {
          filesSkippedOversize++;
          const currentStats = statSync(file);
          const attemptedAt = Date.now();
          runInTransaction(db, () => {
            upsertOversize.run(
              file,
              currentStats.mtimeMs,
              attemptedAt,
              currentStats.size,
              maxBytes,
              attemptedAt,
            );
          });
          process.stderr.write(`Skipping file ${file} as it is too large: ${err.message}\n`);
          continue;
        }
        const failedAt = Date.now();
        runInTransaction(db, () => {
          upsertFailed.run(
            file,
            mtimeMs,
            failedAt,
            sizeBytes,
            maxBytes,
            failedAt,
          );
        });
        throw err;
      }


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

export interface WatchBackoffResult {
  delayMs: number;
  messages: string[];
}

export class WatchFailureBackoff {
  private consecutiveFailures = 0;
  private repeatedErrors = 0;
  private lastError: string | undefined;

  constructor(
    private readonly baseDelayMs: number,
    private readonly maxDelayMs = 15 * 60 * 1000,
  ) {
    if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
      throw new Error("Watcher base delay must be positive");
    }
    if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
      throw new Error("Watcher maximum delay must be positive");
    }
  }

  failure(error: unknown): WatchBackoffResult {
    this.consecutiveFailures++;
    const delayMs = Math.min(
      this.baseDelayMs * 2 ** Math.min(this.consecutiveFailures - 1, 52),
      this.maxDelayMs,
    );
    const errorText = String(error);

    if (errorText === this.lastError) {
      this.repeatedErrors++;
      return { delayMs, messages: [] };
    }

    const messages: string[] = [];
    if (this.lastError !== undefined && this.repeatedErrors > 0) {
      messages.push(
        `watchIndex: previous error repeated ${this.repeatedErrors} more ${
          this.repeatedErrors === 1 ? "time" : "times"
        }`,
      );
    }
    messages.push(`watchIndex: cycle failed: ${errorText}`);
    this.lastError = errorText;
    this.repeatedErrors = 0;
    return { delayMs, messages };
  }

  success(): WatchBackoffResult {
    const messages: string[] = [];
    if (this.lastError !== undefined && this.repeatedErrors > 0) {
      messages.push(
        `watchIndex: previous error repeated ${this.repeatedErrors} more ${
          this.repeatedErrors === 1 ? "time" : "times"
        }`,
      );
    }
    this.consecutiveFailures = 0;
    this.repeatedErrors = 0;
    this.lastError = undefined;
    return { delayMs: this.baseDelayMs, messages };
  }
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
 * by mtime). Polling-based - no fragile fs.watch dependency.
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
  const failureBackoff = new WatchFailureBackoff(intervalMs);

  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runCycle = async (): Promise<number> => {
    if (stopped || inFlight) return intervalMs;
    inFlight = true;
    try {
      const result = await indexAll({ ...opts, minStableMs });
      opts.onCycle?.({ ...result, at: Date.now() });
      const recovery = failureBackoff.success();
      for (const message of recovery.messages) process.stderr.write(`${message}\n`);
      return recovery.delayMs;
    } catch (err) {
      const failure = failureBackoff.failure(err);
      for (const message of failure.messages) process.stderr.write(`${message}\n`);
      return failure.delayMs;
    } finally {
      inFlight = false;
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runCycle().then(schedule);
    }, delayMs);
  };

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // Initial cycle immediately, then chain polling cycles with failure backoff.
  schedule(await runCycle());

  return { stop };
}
