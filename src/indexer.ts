// Crawl OMP session transcripts, embed each exchange, and persist to the index DB.
// All logging goes to stderr; progress is reported via the onProgress callback.
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

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
  onProgress?: (p: IndexProgress) => void;
}

export interface IndexResult {
  filesProcessed: number;
  exchangesUpserted: number;
}

export async function indexAll(opts: IndexOptions = {}): Promise<IndexResult> {
  const db = openDb(opts.dbPath);
  try {
    await initEmbeddings();

    let files = findSessionFiles(opts.sessionsDir);
    if (opts.maxFiles !== undefined) {
      files = files.slice(0, opts.maxFiles);
    }

    let filesProcessed = 0;
    let exchangesUpserted = 0;

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
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

    return { filesProcessed, exchangesUpserted };
  } finally {
    db.close();
  }
}
