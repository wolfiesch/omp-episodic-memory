import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  getMemoryRecord,
  insertMemoryRecord,
  listMemoryRecords,
  searchMemoryRecords,
  updateMemoryStatus,
  type MemorySource,
  type NewMemoryRecord,
} from "../src/memory.js";

let dbPath: string;
let db: Database.Database;

before(() => {
  dbPath = join(tmpdir(), "omp-mem-test-" + randomUUID() + ".db");
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

const source: MemorySource = {
  sessionId: "aaaaaaaa-0000-7000-8000-000000000001",
  ordinal: 0,
  sourcePath: "/tmp/proj/session.jsonl",
};

function record(overrides: Partial<NewMemoryRecord> = {}): NewMemoryRecord {
  return {
    type: "decision",
    title: "Use sqlite-vec for local vectors",
    body: "We decided to use sqlite-vec for local-first vector search.",
    project: "/Users/dev/proj-api",
    confidence: 0.7,
    sources: [source],
    ...overrides,
  };
}

test("insertMemoryRecord returns an id; getMemoryRecord returns pending record with provenance", () => {
  const id = insertMemoryRecord(db, record({ title: "Provenance test" }));
  assert.ok(Number.isInteger(id) && id > 0);

  const rec = getMemoryRecord(db, id);
  assert.ok(rec);
  assert.equal(rec.status, "pending");
  assert.equal(rec.title, "Provenance test");
  assert.deepEqual(rec.sources, [source]);
});

test("PROVENANCE REQUIRED: insertMemoryRecord with sources:[] throws", () => {
  assert.throws(() => insertMemoryRecord(db, record({ sources: [] })));
});

test("IDEMPOTENCY: same (type,title,project) returns same id and updates in place", () => {
  const title = "Idempotent decision " + randomUUID();
  const project = "/idem/proj";
  const id1 = insertMemoryRecord(
    db,
    record({ title, project, body: "first body" }),
  );
  const id2 = insertMemoryRecord(
    db,
    record({ title, project, body: "second body" }),
  );
  assert.equal(id1, id2);

  const matching = listMemoryRecords(db, "pending", 1000).filter(
    (r) => r.title === title && r.project === project,
  );
  assert.equal(matching.length, 1);
  assert.equal(getMemoryRecord(db, id1)?.body, "second body");
});

test("STATUS GATING: pending excluded by default, included with status:'pending', visible after approval", () => {
  const title = "Gated decision " + randomUUID();
  const project = "/gate/proj";
  const id = insertMemoryRecord(db, record({ title, project, body: "gated body" }));

  const defaultHits = searchMemoryRecords(db, { project, type: "decision" });
  assert.equal(
    defaultHits.some((r) => r.id === id),
    false,
  );

  const pendingHits = searchMemoryRecords(db, {
    project,
    type: "decision",
    status: "pending",
  });
  assert.equal(
    pendingHits.some((r) => r.id === id),
    true,
  );

  assert.equal(updateMemoryStatus(db, id, "approved"), true);
  const approvedHits = searchMemoryRecords(db, { project, type: "decision" });
  assert.equal(
    approvedHits.some((r) => r.id === id),
    true,
  );
});

test("searchMemoryRecords filters by type and project; tolerates FTS special chars and empty tokens", () => {
  const project = "/filter/proj-" + randomUUID();
  const decisionId = insertMemoryRecord(
    db,
    record({
      type: "decision",
      title: "Filter decision",
      project,
      status: "approved",
    }),
  );
  const gotchaId = insertMemoryRecord(
    db,
    record({
      type: "gotcha",
      title: "Filter gotcha",
      body: "Avoid editing generated bindings.",
      project,
      status: "approved",
    }),
  );
  const otherProjectId = insertMemoryRecord(
    db,
    record({
      type: "decision",
      title: "Other project decision",
      project: "/filter/other-" + randomUUID(),
      status: "approved",
    }),
  );

  const byType = searchMemoryRecords(db, { project, type: "decision" });
  const byTypeIds = byType.map((r) => r.id);
  assert.ok(byTypeIds.includes(decisionId));
  assert.ok(!byTypeIds.includes(gotchaId));
  assert.ok(!byTypeIds.includes(otherProjectId));

  const byProject = searchMemoryRecords(db, { project });
  const byProjectIds = byProject.map((r) => r.id);
  assert.ok(byProjectIds.includes(decisionId));
  assert.ok(byProjectIds.includes(gotchaId));
  assert.ok(!byProjectIds.includes(otherProjectId));

  // FTS special characters must not throw.
  assert.doesNotThrow(() =>
    searchMemoryRecords(db, { query: 'sqlite-vec "AND" (OR) *:^', status: "approved" }),
  );

  // A query with no usable tokens returns [].
  assert.deepEqual(searchMemoryRecords(db, { query: "  -- ** :: ", status: "approved" }), []);
});

test("distinct (type,title,project) tuples create distinct records", () => {
  const title = "Shared title " + randomUUID();
  const id1 = insertMemoryRecord(db, record({ title, project: "/proj/one" }));
  const id2 = insertMemoryRecord(db, record({ title, project: "/proj/two" }));
  assert.notEqual(id1, id2);
  assert.ok(getMemoryRecord(db, id1));
  assert.ok(getMemoryRecord(db, id2));
});

test("listMemoryRecords(status) returns only that status, most-recent-first", () => {
  const tag = randomUUID();
  const approvedId = insertMemoryRecord(
    db,
    record({ title: "Listed approved " + tag, project: "/list/proj", status: "approved" }),
  );
  const rejectedId = insertMemoryRecord(
    db,
    record({ title: "Listed rejected " + tag, project: "/list/proj", status: "rejected" }),
  );

  const approved = listMemoryRecords(db, "approved", 1000);
  assert.ok(approved.every((r) => r.status === "approved"));
  assert.ok(approved.some((r) => r.id === approvedId));
  assert.ok(!approved.some((r) => r.id === rejectedId));

  // Most-recent-first ordering by updated_at, id.
  const updatedAts = approved.map((r) => r.updatedAt);
  for (let i = 1; i < updatedAts.length; i++) {
    assert.ok(updatedAts[i - 1] >= updatedAts[i]);
  }
});
