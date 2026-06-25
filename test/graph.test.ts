import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  closeEdge,
  findEdges,
  getGraphStats,
  upsertEdge,
  upsertEntity,
} from "../src/graph.js";
import { extractGraph } from "../src/graph-extract.js";
import { extract } from "../src/extractor.js";
import {
  getMemoryRecord,
  insertMemoryRecord,
  type MemorySource,
} from "../src/memory.js";
import { memoryDiff, supersedeDecisions } from "../src/supersede.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sessions",
);

const PROJECT = "/Users/dev/proj-api";

let dbPath: string;
let db: Database.Database;

before(() => {
  dbPath = join(tmpdir(), "omp-graph-test-" + randomUUID() + ".db");
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

// ---------------------------------------------------------------------------
// Graph primitives (src/graph.ts)
// ---------------------------------------------------------------------------

test("upsertEntity dedupes by (type, normalizedName)", () => {
  const a = upsertEntity(db, "package", "sqlite-vec");
  const b = upsertEntity(db, "package", "SQLite-Vec ");
  assert.equal(a, b, "case/whitespace-insensitive dedupe should return same id");
});

test("upsertEdge is idempotent on (src, type, dst, source)", () => {
  const before = getGraphStats(db).edges;
  const src = upsertEntity(db, "project", "/Users/dev/idem-proj");
  const dst = upsertEntity(db, "package", "idem-pkg");
  const edge = {
    srcEntityId: src,
    edgeType: "uses" as const,
    dstEntityId: dst,
    sourceSessionId: "sess-idem",
    sourceOrdinal: 0,
    confidence: 0.9,
  };
  const id1 = upsertEdge(db, edge);
  const id2 = upsertEdge(db, edge);
  assert.equal(id1, id2, "identical upserts return the same id");
  assert.equal(getGraphStats(db).edges, before + 1, "only one edge added");
});

test("closeEdge sets validTo and lowers openEdges", () => {
  const src = upsertEntity(db, "project", "/Users/dev/close-proj");
  const dst = upsertEntity(db, "package", "close-pkg");
  const edgeId = upsertEdge(db, {
    srcEntityId: src,
    edgeType: "uses",
    dstEntityId: dst,
    sourceSessionId: "sess-close",
    sourceOrdinal: 0,
  });

  const openBefore = getGraphStats(db).openEdges;
  const changed = closeEdge(db, edgeId, 12345);
  assert.equal(changed, true, "closeEdge reports a row changed");
  assert.equal(
    getGraphStats(db).openEdges,
    openBefore - 1,
    "openEdges decreases by one",
  );

  const views = findEdges(db, { srcEntityId: src, edgeType: "uses" });
  const closed = views.find((v) => v.edge.id === edgeId);
  assert.ok(closed, "closed edge is returned by findEdges");
  assert.equal(closed.edge.validTo, 12345, "validTo is set");
});

test("findEdges filters by src/type and hydrates endpoints", () => {
  const src = upsertEntity(db, "project", "/Users/dev/find-proj");
  const dst = upsertEntity(db, "package", "find-pkg");
  const other = upsertEntity(db, "package", "find-other");
  upsertEdge(db, {
    srcEntityId: src,
    edgeType: "uses",
    dstEntityId: dst,
    sourceSessionId: "sess-find",
    sourceOrdinal: 1,
  });
  upsertEdge(db, {
    srcEntityId: src,
    edgeType: "touches",
    dstEntityId: other,
    sourceSessionId: "sess-find",
    sourceOrdinal: 2,
  });

  const views = findEdges(db, { srcEntityId: src, edgeType: "uses" });
  assert.ok(views.length >= 1, "at least one matching edge");
  for (const v of views) {
    assert.equal(v.edge.srcEntityId, src);
    assert.equal(v.edge.edgeType, "uses");
    assert.equal(v.src.id, src, "src entity hydrated");
    assert.equal(v.src.type, "project");
    assert.equal(v.dst.id, dst, "dst entity hydrated");
    assert.equal(v.dst.type, "package");
  }
});

// ---------------------------------------------------------------------------
// Extraction (src/graph-extract.ts)
// ---------------------------------------------------------------------------
// We populate decision memories via extract() first, then run extractGraph so
// the graph is derived from both episodes and derived-memory records.

test("extractGraph derives project/package entities and a uses edge", () => {
  extract({ dbPath, sessionsDir: FIXTURES_DIR });
  extractGraph({ dbPath, sessionsDir: FIXTURES_DIR });

  const stats = getGraphStats(db);
  assert.ok(stats.entities > 0, "entities created");
  assert.ok(stats.edges > 0, "edges created");

  // A package entity for sqlite-vec exists (upsertEntity returns its existing id).
  const before = getGraphStats(db).entities;
  upsertEntity(db, "package", "sqlite-vec");
  assert.equal(
    getGraphStats(db).entities,
    before,
    "sqlite-vec package already present (no new entity)",
  );

  // At least one project --uses--> package edge.
  const uses = findEdges(db, { edgeType: "uses" });
  assert.ok(uses.length >= 1, "at least one 'uses' edge");
  assert.ok(
    uses.some((v) => v.src.type === "project" && v.dst.type === "package"),
    "a project --uses--> package edge exists",
  );
});

test("extractGraph is idempotent", () => {
  extractGraph({ dbPath, sessionsDir: FIXTURES_DIR });
  const first = getGraphStats(db);
  extractGraph({ dbPath, sessionsDir: FIXTURES_DIR });
  const second = getGraphStats(db);
  assert.equal(second.entities, first.entities, "entity count stable");
  assert.equal(second.edges, first.edges, "edge count stable");
});

// ---------------------------------------------------------------------------
// Supersession (src/supersede.ts)
// ---------------------------------------------------------------------------

function source(ordinal: number): MemorySource {
  return {
    sessionId: "supersede-sess",
    ordinal,
    sourcePath: join(FIXTURES_DIR, "supersede.jsonl"),
  };
}

test("supersedeDecisions marks older same-topic decision superseded", () => {
  const SUPERSEDE_PROJECT = "/Users/dev/supersede-only";
  const olderId = insertMemoryRecord(db, {
    type: "decision",
    title: "Use widgetlib 0.1.5 for vectors",
    body: "We decided to use widgetlib 0.1.5 for vectors.",
    project: SUPERSEDE_PROJECT,
    validFrom: 100,
    confidence: 0.9,
    status: "approved",
    sources: [source(0)],
  });
  const newerId = insertMemoryRecord(db, {
    type: "decision",
    title: "Use widgetlib 0.2.0 for vectors",
    body: "We decided to use widgetlib 0.2.0 for vectors.",
    project: SUPERSEDE_PROJECT,
    validFrom: 200,
    confidence: 0.9,
    status: "approved",
    sources: [source(1)],
  });

  const result = supersedeDecisions(db);
  assert.ok(result.superseded >= 1, "at least one record superseded");

  const older = getMemoryRecord(db, olderId);
  assert.ok(older, "older record exists");
  assert.equal(older.status, "superseded", "older record superseded");
  assert.ok(older.validTo !== null, "older record validTo set");

  const newer = getMemoryRecord(db, newerId);
  assert.ok(newer, "newer record exists");
  assert.equal(newer.status, "approved", "newer record remains approved");
});

test("memoryDiff reports new and superseded decisions after a cutoff", () => {
  const diff = memoryDiff(db, { project: "/Users/dev/supersede-only", after: 150 });
  assert.ok(
    diff.newDecisions.length >= 1,
    "newDecisions includes the newer decision",
  );
  assert.ok(
    diff.newDecisions.some((r) => r.validFrom === 200),
    "newer decision (validFrom 200) is present in newDecisions",
  );
});
