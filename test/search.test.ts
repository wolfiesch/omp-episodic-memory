import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  openDb,
  insertExchange,
  runInTransaction,
  type InsertableExchange,
} from "../src/db.js";
import { parseSessionFile } from "../src/parser.js";
import { search } from "../src/search.js";
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

/** All exchanges across every fixture file, in deterministic file/ordinal order. */
function allFixtureExchanges(): Exchange[] {
  return readdirSync(FIXTURES_DIR)
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .flatMap((n) => parseSessionFile(join(FIXTURES_DIR, n)));
}

let dbPath: string;
let db: Database.Database;
// Timestamps of session aaaaaaaa's exchanges, for the date-filter test.
let aaaaTimestamps: number[];

before(() => {
  dbPath = join(tmpdir(), "omp-epi-test-" + randomUUID() + ".db");
  db = openDb(dbPath);

  const exchanges = allFixtureExchanges();
  aaaaTimestamps = exchanges
    .filter((e) => e.sessionId.startsWith("aaaaaaaa"))
    .map((e) => e.timestamp);

  runInTransaction(db, () => {
    exchanges.forEach((ex, i) => {
      const insertable: InsertableExchange = { ...ex, embedding: fakeEmbedding(i) };
      insertExchange(db, insertable);
    });
  });
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

test("text search finds a distinctive keyword in the expected fixture", async () => {
  const hits = await search(db, { query: "sqlite-vec", mode: "text" });
  assert.ok(hits.length >= 1, "expected at least one hit for 'sqlite-vec'");
  assert.ok(
    hits.some((h) => h.sessionId.startsWith("aaaaaaaa")),
    "sqlite-vec discussion lives in fixture aaaaaaaa",
  );

  const publishHits = await search(db, { query: "publish", mode: "text" });
  assert.ok(publishHits.length >= 1);
  assert.ok(publishHits.some((h) => h.sessionId.startsWith("bbbbbbbb")));
});

test("date filtering respects after/before timestamp bounds", async () => {
  const minAaaa = Math.min(...aaaaTimestamps);
  const maxAaaa = Math.max(...aaaaTimestamps);

  // 'after' just past aaaaaaaa excludes its hits.
  const afterBound = maxAaaa + 1;
  const afterHits = await search(db, { query: "we decided", mode: "text", after: afterBound });
  for (const h of afterHits) {
    assert.ok(h.timestamp >= afterBound, "every hit must be >= after");
  }
  assert.ok(
    !afterHits.some((h) => h.sessionId.startsWith("aaaaaaaa")),
    "after filter must exclude aaaaaaaa hits",
  );

  // 'before' just under aaaaaaaa excludes its hits.
  const beforeBound = minAaaa - 1;
  const beforeHits = await search(db, { query: "we decided", mode: "text", before: beforeBound });
  for (const h of beforeHits) {
    assert.ok(h.timestamp <= beforeBound, "every hit must be <= before");
  }
  assert.ok(
    !beforeHits.some((h) => h.sessionId.startsWith("aaaaaaaa")),
    "before filter must exclude aaaaaaaa hits",
  );

  // A window straddling aaaaaaaa keeps only its hits.
  const windowHits = await search(db, {
    query: "we decided",
    mode: "text",
    after: minAaaa,
    before: maxAaaa,
  });
  for (const h of windowHits) {
    assert.ok(h.timestamp >= minAaaa && h.timestamp <= maxAaaa);
  }
});

test("limit is respected", async () => {
  const hits = await search(db, { query: "we decided", mode: "text", limit: 1 });
  assert.ok(hits.length <= 1);
});

test("FTS5 special characters are sanitized and do not throw", async () => {
  const messy = await search(db, {
    query: 'sqlite-vec: "install" (macOS)',
    mode: "text",
  });
  const plain = await search(db, { query: "sqlite vec install macOS", mode: "text" });

  assert.ok(messy.length >= 1, "messy query should still match");
  // Same underlying tokens -> same candidate set (order-independent).
  const messyIds = new Set(messy.map((h) => `${h.sessionId}:${h.ordinal}`));
  const plainIds = new Set(plain.map((h) => `${h.sessionId}:${h.ordinal}`));
  assert.deepEqual([...messyIds].sort(), [...plainIds].sort());
});

test("empty / non-matching query returns [] without throwing", async () => {
  assert.deepEqual(await search(db, { query: "", mode: "text" }), []);
  assert.deepEqual(await search(db, { query: "!!! ??? ###", mode: "text" }), []);
  assert.deepEqual(
    await search(db, { query: "zzzzznonexistenttoken", mode: "text" }),
    [],
  );
});

test("vector mode returns hits over synthetic embeddings", async () => {
  // mode:'vector' calls the real embedding model via search(); guard against it
  // by exercising the vec0 index directly with a deterministic query vector.
  const rows = db
    .prepare(
      `SELECT rowid FROM exchanges_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    )
    .all(new Uint8Array(fakeEmbedding(0).buffer), 3) as Array<{ rowid: number | bigint }>;
  assert.ok(rows.length >= 1, "vec0 nearest-neighbour query should return rows");
});
