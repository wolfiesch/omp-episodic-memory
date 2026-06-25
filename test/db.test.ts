import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  openDb,
  insertExchange,
  getStats,
  runInTransaction,
  type InsertableExchange,
} from "../src/db.js";
import { parseSessionFile } from "../src/parser.js";
import { EMBEDDING_DIM, type Exchange } from "../src/types.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sessions",
);

/** Deterministic, model-free unit-length embedding of length EMBEDDING_DIM. */
function fakeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    v[i] = Math.sin((seed + 1) * (i + 1) * 0.0001) + 0.5;
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
  return v;
}

/** Pair a parsed exchange with a deterministic synthetic embedding. */
function toInsertable(ex: Exchange, seed: number): InsertableExchange {
  return { ...ex, embedding: fakeEmbedding(seed) };
}

/** All exchanges across every fixture file, in deterministic file/ordinal order. */
function allFixtureExchanges(): Exchange[] {
  return readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .flatMap((n) => parseSessionFile(join(FIXTURES_DIR, n)));
}

let dbPath: string;
let db: Database.Database;

before(() => {
  dbPath = join(tmpdir(), "omp-epi-test-" + randomUUID() + ".db");
  db = openDb(dbPath);
});

after(() => {
  try {
    db.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        // ignore missing sidecar files
      }
    }
  }
});

test("openDb/initSchema creates a usable empty DB", () => {
  const stats = getStats(db);
  assert.equal(stats.exchanges, 0);
  assert.equal(stats.sessions, 0);
  assert.equal(stats.earliest, null);
  assert.equal(stats.latest, null);
});

test("insertExchange inserts one row and getStats reflects it", () => {
  const ex = allFixtureExchanges()[0];
  assert.ok(ex, "fixture exchange must exist");

  const inserted = insertExchange(db, toInsertable(ex, 0));
  assert.equal(inserted, true);

  const stats = getStats(db);
  assert.equal(stats.exchanges, 1);
  assert.equal(stats.sessions, 1);
  assert.equal(stats.earliest, ex.timestamp);
  assert.equal(stats.latest, ex.timestamp);
});

test("insertExchange is idempotent and updates in place on change", () => {
  // Re-inserting the identical row is a no-op.
  const ex = allFixtureExchanges()[0];
  const again = insertExchange(db, toInsertable(ex, 0));
  assert.equal(again, false);
  assert.equal(getStats(db).exchanges, 1);

  // Changing a field updates the existing row (same session_id + ordinal).
  const changed: Exchange = { ...ex, userText: ex.userText + " EXTRA_MARKER_TOKEN" };
  const updated = insertExchange(db, toInsertable(changed, 0));
  assert.equal(updated, true);
  assert.equal(getStats(db).exchanges, 1, "update must not duplicate the row");

  const row = db
    .prepare(
      `SELECT user_text FROM exchanges WHERE session_id = ? AND ordinal = ?`,
    )
    .get(ex.sessionId, ex.ordinal) as { user_text: string };
  assert.match(row.user_text, /EXTRA_MARKER_TOKEN/);
});

test("inserting all 6 fixture exchanges yields 6 exchanges / 3 sessions", () => {
  const exchanges = allFixtureExchanges();
  assert.equal(exchanges.length, 6);

  runInTransaction(db, () => {
    exchanges.forEach((ex, i) => insertExchange(db, toInsertable(ex, i)));
  });

  const stats = getStats(db);
  assert.equal(stats.exchanges, 6);
  assert.equal(stats.sessions, 3);

  const timestamps = exchanges.map((e) => e.timestamp);
  assert.equal(stats.earliest, Math.min(...timestamps));
  assert.equal(stats.latest, Math.max(...timestamps));
});
