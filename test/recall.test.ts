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
import { supersedeDecisions } from "../src/supersede.js";
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

test("exact single identifier token can answer when present", async () => {
  const bundle = await recallForTask(db, {
    task: "sqlite-vec",
    mode: "text",
  });

  assert.equal(bundle.answerable, true);
  assert.ok(bundle.evidence.length >= 1);
});

test("recall evidence includes tool output matches", async () => {
  const bundle = await recallForTask(db, {
    task: "ABI_MISMATCH_SENTINEL command failed",
    mode: "text",
  });
  assert.equal(bundle.answerable, true);
  assert.ok(
    bundle.evidence.some((ev) =>
      ev.quote.includes("ABI_MISMATCH_SENTINEL") ||
      ev.toolEvents?.some((event) => event.resultText?.includes("ABI_MISMATCH_SENTINEL")),
    ),
  );
});

test("single identifier match does not hide a missing nonce", async () => {
  const bundle = await recallForTask(db, {
    task: "sqlite-vec zzqqxx",
    mode: "text",
  });

  assert.equal(bundle.confidence, "abstain");
  assert.equal(bundle.answerable, false);
  assert.deepEqual(bundle.evidence, []);
});

test("vector fallback abstains when only generic project words overlap", async () => {
  insertExchange(
    db,
    toInsertable(
      {
        sessionId: "generic-project-only",
        sourcePath: "/tmp/generic-project-only.jsonl",
        title: "Generic project planning",
        cwd: "/Users/dev/generic",
        ordinal: 0,
        timestamp: 1_700_000_000,
        userText: "continue project work",
        assistantText: "Project notes and project planning only.",
        toolNames: [],
        toolEvents: [],
      },
      999,
    ),
  );

  const bundle = await recallForTask(db, {
    task: "configure kubernetes helm chart autoscaler quux for this project",
    mode: "both",
  });

  assert.equal(bundle.confidence, "abstain");
  assert.equal(bundle.answerable, false);
  assert.deepEqual(bundle.evidence, []);
});

test("vector fallback abstains when only generic action verbs overlap", async () => {
  insertExchange(
    db,
    toInsertable(
      {
        sessionId: "generic-action-only",
        sourcePath: "/tmp/generic-action-only.jsonl",
        title: "Generic integration workflow",
        cwd: "/Users/dev/generic",
        ordinal: 0,
        timestamp: 1_700_000_001,
        userText: "integrate configure install continue workflow",
        assistantText: "Integration workflow notes without any product-specific evidence.",
        toolNames: [],
        toolEvents: [],
      },
      1000,
    ),
  );

  const bundle = await recallForTask(db, {
    task: "How do we integrate Supabase realtime websockets zzqqxx?",
    mode: "both",
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

test("formatBundle renders grouped evidence sections", async () => {
  const bundle = await recallForTask(db, {
    task: "Why did we choose sqlite-vec for the index?",
    mode: "text",
  });
  const text = formatBundle(bundle);
  assert.ok(text.length > 0);
  assert.ok(text.includes(bundle.confidence));
  assert.match(text, /## Relevant prior decisions/);
  assert.match(text, /## Prior episodes/);
  assert.doesNotMatch(text, /^Evidence:$/m);
  assert.ok(/^-\s+\[decision\]/m.test(text), "expected grouped decision evidence line");
});

test("formatBundle renders tool summaries for episode evidence", async () => {
  const bundle = await recallForTask(db, {
    task: "ABI_MISMATCH_SENTINEL command failed",
    mode: "text",
  });
  const text = formatBundle(bundle);
  assert.match(text, /Tools: .*bash/);
  assert.match(text, /exitCode=1/);
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

test("recall bundle exposes typed sections while preserving flat evidence", async () => {
  const bundle = await recallForTask(db, {
    task: "Why did we choose sqlite-vec for the index?",
    mode: "text",
  });

  assert.ok(bundle.evidence.length >= 1);
  assert.ok(bundle.sections.decisions.length >= 1);
  const episodeCount = bundle.evidence.filter((ev) => ev.kind === "episode").length;
  assert.equal(bundle.sections.episodes.length, episodeCount);
});

test("abstaining recall bundle records one abstention section item", async () => {
  const bundle = await recallForTask(db, {
    task: "configure the kubernetes helm chart autoscaler quux",
    mode: "text",
  });

  assert.equal(bundle.answerable, false);
  assert.equal(bundle.sections.abstentions.length, 1);
  assert.equal(bundle.sections.abstentions[0], "configure the kubernetes helm chart autoscaler quux");
});

test("recall surfaces a superseded decision as a conflict in its own DB", async () => {
  // Isolated DB so superseding approved memories cannot perturb shared-DB tests.
  const isoPath = join(tmpdir(), "omp-recall-conflict-" + randomUUID() + ".db");
  const iso = openDb(isoPath);
  try {
    let seed = 1000;
    for (const file of findSessionFiles(FIX)) {
      for (const ex of parseSessionFile(file)) {
        insertExchange(iso, toInsertable(ex, seed++));
      }
    }
    extract({ dbPath: isoPath, sessionsDir: FIX });
    for (const rec of listMemoryRecords(iso, "pending", 1000)) {
      updateMemoryStatus(iso, rec.id, "approved");
    }
    const result = supersedeDecisions(iso);
    assert.ok(result.superseded >= 1, "fixture has at least one superseded decision");

    const bundle = await recallForTask(iso, {
      task: "What is the current decision for recall cache storage after stale reads?",
      mode: "text",
    });
    assert.ok(bundle.sections.conflicts.length >= 1, "recall surfaces at least one conflict");
    const conflict = bundle.sections.conflicts.find((c) =>
      c.current.title.includes("SQLite") && c.superseded.title.includes("JSON"),
    );
    assert.ok(conflict, "the SQLite-over-JSON cache conflict is surfaced");
    assert.ok(
      formatBundle(bundle).includes("## Conflicts / stale facts"),
      "formatted bundle renders the conflicts section",
    );
  } finally {
    iso.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(isoPath + suffix);
      } catch {
        // ignore missing sidecar files
      }
    }
  }
});
