// Crawl OMP session transcripts, embed each exchange, and persist to the index DB.
// All logging goes to stderr; progress is reported via the onProgress callback.
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, sep } from "node:path";

import Database from "better-sqlite3";
import {
  insertExchange,
  openDb,
  runInTransaction,
} from "./db.js";
import { embedExchange, initEmbeddings } from "./embeddings.js";
import { isSessionFile, iterateSessionFile, parseSessionFile } from "./parser.js";
import { DEFAULT_SESSIONS_DIR } from "./types.js";
import { serializeToolEvents, toolEventsIndexText } from "./tool-events.js";

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
      `SELECT source_path, title, cwd, timestamp, user_text, assistant_text, tool_names, tool_events, tool_event_text
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

      let insertedForFile = 0;
      try {
        // Consume exchanges incrementally: do not materialize a per-session Exchange[]
        // before embedding/upserting. The file mtime is marked only after the iterator
        // completes, so parse/embed failures never make a partial file look current.
        for await (const ex of iterateSessionFile(file, {
          maxBytes: opts.maxBytes ?? 200 * 1024 * 1024,
        })) {
          const toolNamesJson = JSON.stringify(ex.toolNames);
          const toolEventsJson = serializeToolEvents(ex.toolEvents);
          const toolEventText = toolEventsIndexText(ex.toolEvents);
          const existing = selectContent.get(ex.sessionId, ex.ordinal) as
            | {
                source_path: string;
                title: string | null;
                cwd: string | null;
                timestamp: number;
                user_text: string;
                assistant_text: string | null;
                tool_names: string | null;
                tool_events: string | null;
                tool_event_text: string | null;
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
            (existing.tool_names ?? "[]") === toolNamesJson &&
            (existing.tool_events ?? "[]") === toolEventsJson &&
            (existing.tool_event_text ?? "") === toolEventText
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
            insertExchange(db, { ...ex, embedding }) ? 1 : 0,
          );
          insertedForFile += inserted;
        }
      } catch (err: unknown) {
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

      runInTransaction(db, () => {
        upsertMtime.run(file, mtimeMs, Date.now());
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
