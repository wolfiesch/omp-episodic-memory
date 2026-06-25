import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { openDb, insertExchange, type InsertableExchange } from "../src/db.js";
import { parseSessionFile } from "../src/parser.js";
import { findSessionFiles } from "../src/indexer.js";
import { extract } from "../src/extractor.js";
import { listMemoryRecords, updateMemoryStatus } from "../src/memory.js";
import {
  classifyIntents,
  recallForTask,
  formatBundle,
} from "../src/recall.js";
import { EMBEDDING_DIM, type Exchange } from "../src/types.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sessions");

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

function toInsertable(ex: Exchange, seed: number): InsertableExchange {
  return { ...ex, embedding: fakeEmbedding(seed) };
}

let dbPath: string;
let db: Database.Database;

before(() => {
  dbPath = join(tmpdir(), "omp-recall-test-" + randomUUID() + ".db");
  db = openDb(dbPath);

  // Index every fixture exchange with a deterministic synthetic embedding.
  let seed = 0;
  for (const file of findSessionFiles(FIX)) {
    for (const ex of parseSessionFile(file)) {
      insertExchange(db, toInsertable(ex, seed++));
    }
  }

  // Populate pending derived memories, then approve them all.
  extract({ dbPath, sessionsDir: FIX });
  for (const rec of listMemoryRecords(db, "pending", 1000)) {
    updateMemoryStatus(db, rec.id, "approved");
  }
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

test("classifyIntents maps task phrasing to intents", () => {
  const decision = classifyIntents("Why did we choose sqlite-vec?");
  assert.ok(decision.includes("decision"));
  assert.ok(decision.includes("semantic"));

  assert.ok(classifyIntents("How do we publish to npm?").includes("procedural"));
  assert.ok(
    classifyIntents("What should we avoid when installing?").includes("gotcha"),
  );

  const plain = classifyIntents("The build pipeline runs nightly.");
  assert.ok(plain.includes("semantic"));
});

test("relevant recall returns provenance-backed evidence", async () => {
  const bundle = await recallForTask(db, {
    task: "Why did we choose sqlite-vec for the index?",
    mode: "text",
  });

  assert.equal(bundle.answerable, true);
  assert.ok(["high", "medium"].includes(bundle.confidence));
  assert.ok(bundle.evidence.length >= 1);
  assert.ok(bundle.memoryTypesUsed.includes("decision"));

  const withProvenance = bundle.evidence.find(
    (e) => e.path !== null && e.sessionId !== null,
  );
  assert.ok(withProvenance, "expected at least one evidence item with provenance");
});

test("unrelated/nonsense task abstains with no evidence", async () => {
  const bundle = await recallForTask(db, {
    task: "How do we integrate Supabase realtime websockets zzqqxx?",
    mode: "text",
  });

  assert.equal(bundle.confidence, "abstain");
  assert.equal(bundle.answerable, false);
  assert.deepEqual(bundle.evidence, []);
});

test("suggestedContext respects the token budget", async () => {
  const small = await recallForTask(db, {
    task: "Why did we choose sqlite-vec for the index?",
    mode: "text",
    maxContextTokens: 120,
  });
  assert.ok(Math.ceil(small.suggestedContext.length / 4) <= 120 + 30);

  const large = await recallForTask(db, {
    task: "Why did we choose sqlite-vec for the index?",
    mode: "text",
    maxContextTokens: 2000,
  });
  assert.ok(large.suggestedContext.length >= small.suggestedContext.length);
});

test("project filter scopes episode evidence and abstains when unmatched", async () => {
  const scoped = await recallForTask(db, {
    task: "publish package npm",
    mode: "text",
    project: "/Users/dev/proj-web",
  });
  for (const ev of scoped.evidence) {
    if (ev.kind === "episode" && ev.path !== null) {
      assert.ok(
        ev.path.includes("bbbbbbbb-0000-7000-8000-000000000002"),
        `episode evidence should come from the proj-web session: ${ev.path}`,
      );
    }
  }

  const missing = await recallForTask(db, {
    task: "publish package npm",
    mode: "text",
    project: "/nonexistent/path",
  });
  assert.equal(missing.answerable, false);
  assert.deepEqual(missing.evidence, []);
});

test("formatBundle renders confidence tier and evidence lines", async () => {
  const bundle = await recallForTask(db, {
    task: "Why did we choose sqlite-vec for the index?",
    mode: "text",
  });
  const text = formatBundle(bundle);
  assert.ok(text.length > 0);
  assert.ok(text.includes(bundle.confidence));
  assert.ok(/^\d+\.\s/m.test(text), "expected at least one numbered evidence line");
});

test("recommendedNextSteps is non-empty for answerable and abstain bundles", async () => {
  const answerable = await recallForTask(db, {
    task: "Why did we choose sqlite-vec for the index?",
    mode: "text",
  });
  assert.ok(Array.isArray(answerable.recommendedNextSteps));
  assert.ok(answerable.recommendedNextSteps.length > 0);

  const abstain = await recallForTask(db, {
    task: "How do we integrate Supabase realtime websockets zzqqxx?",
    mode: "text",
  });
  assert.ok(Array.isArray(abstain.recommendedNextSteps));
  assert.ok(abstain.recommendedNextSteps.length > 0);
});
