import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import {
  openDb,
  openReadOnlyDb,
  insertExchange,
  getStats,
  runInTransaction,
  type InsertableExchange,
} from "../src/db.js";
import { parseSessionFile } from "../src/parser.js";
import { EMBEDDING_DIM, type Exchange } from "../src/types.js";
import { parseToolEvents } from "../src/tool-events.js";

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

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function createLegacyDb(path: string): void {
  const legacy = new Database(path);
  try {
    legacy.exec(`
      CREATE TABLE exchanges (
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
      CREATE VIRTUAL TABLE exchanges_fts USING fts5(
        user_text,
        assistant_text,
        tool_names,
        content='exchanges',
        content_rowid='id'
      );
      INSERT INTO exchanges (session_id, source_path, title, cwd, ordinal, timestamp, user_text, assistant_text, tool_names)
      VALUES ('legacy', '/tmp/fixture/legacy.jsonl', 'legacy', '/tmp/fixture', 0, 1, 'user', 'assistant', '[]');
    `);
  } finally {
    legacy.close();
  }
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

test("inserting all 8 fixture exchanges yields 8 exchanges / 4 sessions", () => {
  const exchanges = allFixtureExchanges();
  assert.equal(exchanges.length, 8);

  runInTransaction(db, () => {
    exchanges.forEach((ex, i) => insertExchange(db, toInsertable(ex, i)));
  });

  const stats = getStats(db);
  assert.equal(stats.exchanges, 8);
  assert.equal(stats.sessions, 4);

  const timestamps = exchanges.map((e) => e.timestamp);
  assert.equal(stats.earliest, Math.min(...timestamps));
  assert.equal(stats.latest, Math.max(...timestamps));
});

test("insertExchange persists serialized tool events and FTS text", () => {
  const ex = allFixtureExchanges()[0];
  assert.ok(ex, "fixture exchange must exist");
  insertExchange(db, toInsertable(ex, 42));
  const row = db
    .prepare(`SELECT tool_events, tool_event_text FROM exchanges WHERE session_id = ? AND ordinal = ?`)
    .get(ex.sessionId, ex.ordinal) as { tool_events: string | null; tool_event_text: string | null };
  const events = parseToolEvents(row.tool_events);
  assert.equal(events[0]?.toolName, "bash");
  assert.match(row.tool_event_text ?? "", /ABI_MISMATCH_SENTINEL/);
  assert.match(row.tool_event_text ?? "", /npm rebuild sqlite-vec/);
  assert.match(row.tool_event_text ?? "", /src\/db\.ts/);
  assert.match(row.tool_event_text ?? "", /exitCode\s+1/);
});

test("initSchema migrates legacy exchange tables", () => {
  const path = join(tmpdir(), "omp-epi-legacy-" + randomUUID() + ".db");
  createLegacyDb(path);
  const migrated = openDb(path);
  try {
    assert.ok(tableColumns(migrated, "exchanges").includes("tool_events"));
    assert.ok(tableColumns(migrated, "exchanges").includes("tool_event_text"));
    assert.ok(tableColumns(migrated, "exchanges_fts").includes("tool_event_text"));
    const row = migrated.prepare("SELECT COUNT(*) AS count FROM exchanges").get() as { count: number };
    assert.equal(row.count, 1);
  } finally {
    migrated.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        // ignore missing sidecar files
      }
    }
  }
});

test("openReadOnlyDb reports old schema clearly", () => {
  const path = join(tmpdir(), "omp-epi-old-readonly-" + randomUUID() + ".db");
  createLegacyDb(path);
  try {
    assert.throws(
      () => openReadOnlyDb(path),
      /Index DB schema is outdated\. Run "omp-episodic index --force" once to migrate tool event columns\./,
    );
    openDb(path).close();
    const readonly = openReadOnlyDb(path);
    readonly.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        // ignore missing sidecar files
      }
    }
  }
});
