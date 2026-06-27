import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, unlinkSync } from "node:fs";
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
import { backfillSupersedesEdges, memoryDiff, supersedeDecisions } from "../src/supersede.js";

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

test("supersedeDecisions does not link unrelated decisions sharing only a first token", () => {
  const FP_PROJECT = "/Users/dev/false-positive";
  const releaseA = insertMemoryRecord(db, {
    type: "decision",
    title: "Pin the release workflow to Node 22 for glob expansion",
    body: "We decided to pin the release workflow to Node 22.",
    project: FP_PROJECT,
    validFrom: 100,
    confidence: 0.9,
    status: "approved",
    sources: [source(0)],
  });
  const releaseB = insertMemoryRecord(db, {
    type: "decision",
    title: "Release checklist should document provenance publishing",
    body: "We decided the release checklist documents npm provenance.",
    project: FP_PROJECT,
    validFrom: 200,
    confidence: 0.9,
    status: "approved",
    sources: [source(1)],
  });

  supersedeDecisions(db);

  // Both share only the leading token "release" (< 2 overlap) -> neither superseded.
  assert.equal(getMemoryRecord(db, releaseA)?.status, "approved", "first release decision stays approved");
  assert.equal(getMemoryRecord(db, releaseB)?.status, "approved", "second release decision stays approved");
  assert.equal(getMemoryRecord(db, releaseA)?.supersedesMemoryId ?? null, null);
  assert.equal(getMemoryRecord(db, releaseB)?.supersedesMemoryId ?? null, null);
});

test("supersedeDecisions isolates two real subjects sharing a first-token bucket", () => {
  const COMP_PROJECT = "/Users/dev/components";
  // Bucket "store": a genuine cache pair plus an unrelated, newer telemetry decision.
  const cacheJson = insertMemoryRecord(db, {
    type: "decision",
    title: "Store recall cache in JSON files while prototyping",
    body: "We decided to store recall cache in JSON files.",
    project: COMP_PROJECT,
    validFrom: 100,
    confidence: 0.9,
    status: "approved",
    sources: [source(0)],
  });
  const cacheSqlite = insertMemoryRecord(db, {
    type: "decision",
    title: "Store recall cache in SQLite instead of JSON files",
    body: "We decided to store recall cache in SQLite.",
    project: COMP_PROJECT,
    validFrom: 200,
    confidence: 0.9,
    status: "approved",
    sources: [source(1)],
  });
  const telemetry = insertMemoryRecord(db, {
    type: "decision",
    title: "Store telemetry events in Kafka topics",
    body: "We decided to store telemetry events in Kafka.",
    project: COMP_PROJECT,
    validFrom: 300,
    confidence: 0.9,
    status: "approved",
    sources: [source(2)],
  });

  supersedeDecisions(db);

  // The genuine cache pair supersedes even though telemetry is the bucket's newest.
  assert.equal(getMemoryRecord(db, cacheJson)?.status, "superseded", "JSON cache decision superseded");
  assert.equal(getMemoryRecord(db, cacheSqlite)?.supersedesMemoryId, cacheJson, "SQLite cache supersedes JSON cache");
  assert.equal(getMemoryRecord(db, cacheSqlite)?.status, "approved", "SQLite cache decision stays current");
  // The unrelated telemetry decision shares only "store" with the pair -> untouched.
  assert.equal(getMemoryRecord(db, telemetry)?.status, "approved", "telemetry decision stays approved");
  assert.equal(getMemoryRecord(db, telemetry)?.supersedesMemoryId ?? null, null, "telemetry supersedes nothing");
});

test("supersedeDecisions does not link compatible sqlite-vec decisions sharing only one token", () => {
  const SV_PROJECT = "/Users/dev/sqlite-vec-fp";
  const pin = insertMemoryRecord(db, {
    type: "decision",
    title: "Pin sqlite-vec to 0.1.6 to keep ABI stability",
    body: "We decided to pin sqlite-vec to 0.1.6.",
    project: SV_PROJECT,
    validFrom: 100,
    confidence: 0.9,
    status: "approved",
    sources: [source(0)],
  });
  const use = insertMemoryRecord(db, {
    type: "decision",
    title: "Use sqlite-vec because it keeps the whole index local-first",
    body: "We decided to use sqlite-vec for a local-first index.",
    project: SV_PROJECT,
    validFrom: 200,
    confidence: 0.9,
    status: "approved",
    sources: [source(1)],
  });

  supersedeDecisions(db);

  // They share only "sqlite" (the "vec" suffix tokenizes with it) -> not a contradiction.
  assert.equal(getMemoryRecord(db, pin)?.status, "approved", "pin decision stays approved");
  assert.equal(getMemoryRecord(db, use)?.status, "approved", "use decision stays approved");
  assert.equal(getMemoryRecord(db, pin)?.supersedesMemoryId ?? null, null);
  assert.equal(getMemoryRecord(db, use)?.supersedesMemoryId ?? null, null);
});

test("supersedeDecisions treats the overlap relation as non-transitive in a chain", () => {
  const CHAIN_PROJECT = "/Users/dev/chain";
  // A overlaps B (>=2 tokens), B overlaps C (>=2), but A and C share only "cache".
  const a = insertMemoryRecord(db, {
    type: "decision",
    title: "Cache vector embeddings for speed",
    body: "We decided to cache vector embeddings.",
    project: CHAIN_PROJECT,
    validFrom: 100,
    confidence: 0.9,
    status: "approved",
    sources: [source(0)],
  });
  const b = insertMemoryRecord(db, {
    type: "decision",
    title: "Cache vector embeddings on disk instead",
    body: "We decided to cache vector embeddings on disk.",
    project: CHAIN_PROJECT,
    validFrom: 200,
    confidence: 0.9,
    status: "approved",
    sources: [source(1)],
  });
  const c = insertMemoryRecord(db, {
    type: "decision",
    title: "Cache disk compaction runs nightly",
    body: "We decided cache disk compaction runs nightly.",
    project: CHAIN_PROJECT,
    validFrom: 300,
    confidence: 0.9,
    status: "approved",
    sources: [source(2)],
  });

  supersedeDecisions(db);

  // A∩B = {cache,vector,embeddings}; B∩C = {cache,disk}; A∩C = {cache} only.
  // Each record links to its nearest earlier overlapping record: B<-A, C<-B.
  assert.equal(getMemoryRecord(db, a)?.status, "superseded", "A superseded by B");
  assert.equal(getMemoryRecord(db, b)?.supersedesMemoryId, a, "B supersedes A (direct overlap)");
  assert.equal(getMemoryRecord(db, b)?.status, "superseded", "B superseded by C");
  assert.equal(getMemoryRecord(db, c)?.supersedesMemoryId, b, "C supersedes B, never jumps to A");
  assert.equal(getMemoryRecord(db, c)?.status, "approved", "C stays current");
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

test("supersedeDecisions writes a newer->older supersedes graph edge", () => {
  const isoPath = join(tmpdir(), "omp-graph-edge-" + randomUUID() + ".db");
  const iso = openDb(isoPath);
  try {
    const EDGE_PROJECT = "/Users/dev/edge-supersede";
    insertMemoryRecord(iso, {
      type: "decision",
      title: "Store recall cache in JSON files",
      body: "We decided to store recall cache in JSON files.",
      project: EDGE_PROJECT,
      validFrom: 100,
      confidence: 0.9,
      status: "approved",
      sources: [source(0)],
    });
    insertMemoryRecord(iso, {
      type: "decision",
      title: "Store recall cache in SQLite tables",
      body: "We decided to store recall cache in SQLite tables.",
      project: EDGE_PROJECT,
      validFrom: 200,
      confidence: 0.9,
      status: "approved",
      sources: [source(1)],
    });

    const result = supersedeDecisions(iso);
    assert.ok(result.superseded >= 1, "a pair was superseded");

    const edges = findEdges(iso, { edgeType: "supersedes" });
    assert.equal(edges.length, 1, "exactly one supersedes edge written");
    assert.ok(edges[0].src.name.toLowerCase().includes("sqlite"), "edge source is the newer (SQLite) decision");
    assert.ok(edges[0].dst.name.toLowerCase().includes("json"), "edge target is the older (JSON) decision");

    // Idempotent: rerunning supersession does not duplicate the edge.
    supersedeDecisions(iso);
    assert.equal(findEdges(iso, { edgeType: "supersedes" }).length, 1, "edge not duplicated");
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

test("backfillSupersedesEdges reconstructs edges from existing columns", () => {
  const isoPath = join(tmpdir(), "omp-graph-backfill-" + randomUUID() + ".db");
  const iso = openDb(isoPath);
  try {
    const BF_PROJECT = "/Users/dev/backfill-supersede";
    insertMemoryRecord(iso, {
      type: "decision",
      title: "Pin embedding model to MiniLM revision one",
      body: "We decided to pin the embedding model to MiniLM revision one.",
      project: BF_PROJECT,
      validFrom: 100,
      confidence: 0.9,
      status: "approved",
      sources: [source(0)],
    });
    insertMemoryRecord(iso, {
      type: "decision",
      title: "Pin embedding model to MiniLM revision two",
      body: "We decided to pin the embedding model to MiniLM revision two.",
      project: BF_PROJECT,
      validFrom: 200,
      confidence: 0.9,
      status: "approved",
      sources: [source(1)],
    });
    // Establish the column links (older is now status="superseded").
    supersedeDecisions(iso);

    // Wipe the edges to simulate a column-only state (links written before edge wiring).
    iso.exec("DELETE FROM graph_edges WHERE edge_type = 'supersedes'");
    assert.equal(findEdges(iso, { edgeType: "supersedes" }).length, 0, "edges cleared");

    const written = backfillSupersedesEdges(iso);
    assert.equal(written, 1, "backfill rewrote one edge from the column");
    const edges = findEdges(iso, { edgeType: "supersedes" });
    assert.equal(edges.length, 1, "edge present after backfill (superseded endpoint included)");
    assert.ok(edges[0].dst.name.includes("revision one"), "older superseded decision is the edge target");
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

test("extractGraph rebuild route re-syncs supersedes edges from columns", () => {
  const isoPath = join(tmpdir(), "omp-graph-route-" + randomUUID() + ".db");
  const emptySessions = mkdtempSync(join(tmpdir(), "omp-graph-route-sessions-"));
  const setup = openDb(isoPath);
  try {
    const RT_PROJECT = "/Users/dev/route-supersede";
    insertMemoryRecord(setup, {
      type: "decision",
      title: "Publish package from Node 20 runner",
      body: "We decided to publish the package from a Node 20 runner.",
      project: RT_PROJECT,
      validFrom: 100,
      confidence: 0.9,
      status: "approved",
      sources: [source(0)],
    });
    insertMemoryRecord(setup, {
      type: "decision",
      title: "Publish package from Node 22 runner",
      body: "We decided to publish the package from a Node 22 runner.",
      project: RT_PROJECT,
      validFrom: 200,
      confidence: 0.9,
      status: "approved",
      sources: [source(1)],
    });
    supersedeDecisions(setup);
    setup.exec("DELETE FROM graph_edges WHERE edge_type = 'supersedes'");
    setup.close();

    // The graph rebuild route (extractGraph) must restore the supersedes edge
    // even with no session files to scan.
    extractGraph({ dbPath: isoPath, sessionsDir: emptySessions });

    const check = openDb(isoPath);
    try {
      const edges = findEdges(check, { edgeType: "supersedes" });
      assert.equal(edges.length, 1, "extractGraph re-synced the supersedes edge");
      assert.ok(edges[0].dst.name.toLowerCase().includes("node 20"), "older Node 20 decision is the edge target");
    } finally {
      check.close();
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(isoPath + suffix);
      } catch {
        // ignore missing sidecar files
      }
    }
  }
});
