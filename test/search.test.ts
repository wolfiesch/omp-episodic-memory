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

test("query matching long assistant reply yields combined U+A snippet with non-empty assistantSnippet", async () => {
  const hits = await search(db, { query: "sqlite-vec", mode: "text" });
  assert.ok(hits.length >= 1, "expected at least one hit");
  const hit = hits.find((h) => h.sessionId.startsWith("aaaaaaaa") && h.ordinal === 0);
  assert.ok(hit, "expected to find the first exchange in session aaaaaaaa");
  // Combined labeled excerpt: assistant evidence is surfaced (not just the user command).
  assert.ok(hit.snippet.includes("A: "), `snippet should include assistant evidence, got: ${hit.snippet}`);
  assert.ok(
    hit.snippet.includes("This is a known gotcha:"),
    `snippet should carry assistant content, got: ${hit.snippet}`,
  );
  assert.ok(hit.assistantSnippet, "assistantSnippet should be non-empty");
  assert.ok(hit.assistantSnippet.startsWith("This is a known gotcha:"), `assistantSnippet should start with content, got: ${hit.assistantSnippet}`);
  assert.ok(hit.userSnippet, "userSnippet should also be set");
});

test("given two candidate exchanges in the same session, substantive ranks above filler after specificity rerank", async () => {
  const sessionId = "dddddddd-0000-7000-8000-000000000004";
  const sourcePath = "/tmp/fake-session-d.jsonl";
  
  // Exchange A: Substantive
  const exA: InsertableExchange = {
    sessionId,
    sourcePath,
    title: "Test Spec Rerank",
    cwd: "/tmp",
    ordinal: 0,
    timestamp: 1782379300,
    userText: "spec-rerank-test-keyword: query about some complex design",
    assistantText: "A very long assistant explanation that is definitely substantive and has at least four hundred characters to reach high specificity signal. Let's write more text here: we want to ensure the assistant's reply contains detailed instructions, architectural patterns, constraints, and other highly useful engineering insights that a developer would find valuable. This ensures combinedLen is large.",
    toolNames: [],
  };

  // Exchange B: Filler
  const exB: InsertableExchange = {
    sessionId,
    sourcePath,
    title: "Test Spec Rerank",
    cwd: "/tmp",
    ordinal: 1,
    timestamp: 1782379400, // Later timestamp, which is normally a tie-breaker or could rank higher
    userText: "spec-rerank-test-keyword: tiny user request",
    assistantText: "proceed",
    toolNames: [],
  };

  runInTransaction(db, () => {
    insertExchange(db, { ...exA, embedding: fakeEmbedding(100) });
    insertExchange(db, { ...exB, embedding: fakeEmbedding(101) });
  });

  const hits = await search(db, { query: "spec-rerank-test-keyword", mode: "text" });
  assert.ok(hits.length >= 2, "expected at least 2 hits");

  // Find position of both hits
  const idxA = hits.findIndex((h) => h.sessionId === sessionId && h.ordinal === 0);
  const idxB = hits.findIndex((h) => h.sessionId === sessionId && h.ordinal === 1);

  assert.ok(idxA !== -1, "should find Exchange A");
  assert.ok(idxB !== -1, "should find Exchange B");
  assert.ok(idxA < idxB, `Substantive Exchange A (rank ${idxA}) should rank above Filler Exchange B (rank ${idxB})`);
});
