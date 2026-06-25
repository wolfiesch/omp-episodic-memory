import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { ensureIndexStateTable, shouldIndexFile } from "../src/indexer.js";

const SESSIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sessions",
);

interface IndexedFileRow {
  mtime_ms: number;
}

let dbPath: string;
let db: Database.Database;

before(() => {
  dbPath = join(tmpdir(), `indexer-test-${randomUUID()}.db`);
  db = openDb(dbPath);
});

after(() => {
  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test("shouldIndexFile returns true when no stored mtime", () => {
  assert.equal(shouldIndexFile(undefined, 123), true);
});

test("shouldIndexFile returns false when mtimes are equal", () => {
  assert.equal(shouldIndexFile(123, 123), false);
});

test("shouldIndexFile returns true when mtimes differ", () => {
  assert.equal(shouldIndexFile(100, 200), true);
});

test("shouldIndexFile returns true with force regardless of mtime", () => {
  assert.equal(shouldIndexFile(123, 123, true), true);
});

test("ensureIndexStateTable creates the indexed_files table", () => {
  ensureIndexStateTable(db);
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files'`,
    )
    .get() as { name: string } | undefined;
  assert.ok(row);
  assert.equal(row?.name, "indexed_files");
});

test("indexed_files upsert + lookup returns the stored mtime", () => {
  ensureIndexStateTable(db);
  const path = join(SESSIONS_DIR, "example.jsonl");
  db.prepare(
    `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?,?,?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at`,
  ).run(path, 4242, Date.now());

  const stored = db
    .prepare(`SELECT mtime_ms FROM indexed_files WHERE path = ?`)
    .get(path) as IndexedFileRow | undefined;
  assert.equal(stored?.mtime_ms, 4242);

  // Upsert updates in place.
  db.prepare(
    `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?,?,?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at`,
  ).run(path, 9999, Date.now());

  const updated = db
    .prepare(`SELECT mtime_ms FROM indexed_files WHERE path = ?`)
    .get(path) as IndexedFileRow | undefined;
  assert.equal(updated?.mtime_ms, 9999);
});
