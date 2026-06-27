import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { ensureIndexStateTable, findSessionFiles, matchesIgnore, shouldIndexFile } from "../src/indexer.js";

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

test(".omp-episodic-ignore excludes matching session files", () => {
  const root = join(tmpdir(), `indexer-ignore-${randomUUID()}`);
  mkdirSync(root);
  try {
    writeFileSync(join(root, ".omp-episodic-ignore"), "secret-*.jsonl\n# comment\n\n");
    writeFileSync(join(root, "secret-x.jsonl"), "{}\n");
    writeFileSync(join(root, "public.jsonl"), "{}\n");

    const files = findSessionFiles(root).map((file) => file.split("/").pop());
    assert.deepEqual(files, ["public.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchesIgnore: literal and single-star match within a segment only", () => {
  assert.equal(matchesIgnore("secret-x.jsonl", ["secret-*.jsonl"]), true);
  assert.equal(matchesIgnore("dir/secret-x.jsonl", ["secret-*.jsonl"]), false, "* does not cross a slash");
  assert.equal(matchesIgnore("public.jsonl", ["secret-*.jsonl"]), false);
});

test("matchesIgnore: ** crosses slashes and matches at the root", () => {
  assert.equal(matchesIgnore("a/b/secret.jsonl", ["**/secret.jsonl"]), true);
  // A leading **/ must also match the file at the root (zero intermediate dirs).
  assert.equal(matchesIgnore("secret.jsonl", ["**/secret.jsonl"]), true, "**/ matches root-level file");
  assert.equal(matchesIgnore("a/b/c.jsonl", ["a/**/c.jsonl"]), true);
  // A middle **/ must also match zero intermediate directories.
  assert.equal(matchesIgnore("a/c.jsonl", ["a/**/c.jsonl"]), true, "a/**/c matches a/c (zero dirs)");
  assert.equal(matchesIgnore("x/c.jsonl", ["a/**/c.jsonl"]), false, "prefix still anchored");
});

test("matchesIgnore: a leading ./ in the pattern is normalized away", () => {
  assert.equal(matchesIgnore("secret.jsonl", ["./secret.jsonl"]), true);
  assert.equal(matchesIgnore("sub/secret.jsonl", ["./sub/secret.jsonl"]), true);
});

test("matchesIgnore: a trailing-slash pattern excludes the directory's children", () => {
  assert.equal(matchesIgnore("secret/a.jsonl", ["secret/"]), true, "dir pattern matches children");
  assert.equal(matchesIgnore("secret/nested/a.jsonl", ["secret/"]), true, "dir pattern matches deep children");
  assert.equal(matchesIgnore("not-secret/a.jsonl", ["secret/"]), false);
  assert.equal(matchesIgnore("secret", ["secret/"]), false, "dir pattern does not match a same-named file");
});

test("matchesIgnore: special regex characters in patterns are matched literally", () => {
  assert.equal(matchesIgnore("a.b+c.jsonl", ["a.b+c.jsonl"]), true);
  assert.equal(matchesIgnore("axbxc.jsonl", ["a.b+c.jsonl"]), false, "dot/plus are literal, not regex");
});

test("findSessionFiles: trailing-slash dir pattern excludes a nested session file", () => {
  const root = join(tmpdir(), `indexer-ignore-dir-${randomUUID()}`);
  mkdirSync(join(root, "secret"), { recursive: true });
  try {
    writeFileSync(join(root, ".omp-episodic-ignore"), "secret/\n");
    writeFileSync(join(root, "secret", "a.jsonl"), "{}\n");
    writeFileSync(join(root, "public.jsonl"), "{}\n");

    const files = findSessionFiles(root).map((file) => file.split("/").pop());
    assert.deepEqual(files, ["public.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
