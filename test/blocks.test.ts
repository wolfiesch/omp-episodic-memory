import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  deleteBlock,
  getBlock,
  getProjectContext,
  listBlocks,
  setBlock,
} from "../src/blocks.js";
import { insertMemoryRecord, type MemorySource } from "../src/memory.js";

let dbPath: string;
let db: Database.Database;

before(() => {
  dbPath = join(tmpdir(), "omp-blocks-test-" + randomUUID() + ".db");
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

test("setBlock inserts and returns an id; getBlock returns it", () => {
  const id = setBlock(db, {
    kind: "project_rules",
    project: "/Users/dev/proj-a",
    content: "Always run the linter.",
  });
  assert.ok(id > 0);

  const block = getBlock(db, "project_rules", "/Users/dev/proj-a");
  assert.ok(block);
  assert.equal(block.id, id);
  assert.equal(block.kind, "project_rules");
  assert.equal(block.project, "/Users/dev/proj-a");
  assert.equal(block.content, "Always run the linter.");
});

test("setBlock is idempotent on (kind, project): same id, content updates in place", () => {
  const before = listBlocks(db, "/Users/dev/proj-idem").length;

  const id1 = setBlock(db, {
    kind: "known_risks",
    project: "/Users/dev/proj-idem",
    content: "v1",
  });
  const id2 = setBlock(db, {
    kind: "known_risks",
    project: "/Users/dev/proj-idem",
    content: "v2",
  });

  assert.equal(id1, id2);
  const block = getBlock(db, "known_risks", "/Users/dev/proj-idem");
  assert.equal(block?.content, "v2");
  assert.equal(listBlocks(db, "/Users/dev/proj-idem").length, before + 1);
});

test("null/global project round-trips: project undefined -> getBlock returns project === null", () => {
  const id = setBlock(db, {
    kind: "positioning",
    content: "Global positioning statement.",
  });
  const block = getBlock(db, "positioning");
  assert.ok(block);
  assert.equal(block.id, id);
  assert.equal(block.project, null);

  // Idempotent on global too.
  const id2 = setBlock(db, {
    kind: "positioning",
    project: null,
    content: "Updated global.",
  });
  assert.equal(id2, id);
  assert.equal(getBlock(db, "positioning")?.content, "Updated global.");
});

test("listBlocks(project) returns project-specific AND global blocks", () => {
  setBlock(db, {
    kind: "workflow_preferences",
    project: "/Users/dev/proj-list",
    content: "Prefer rebases.",
  });
  setBlock(db, {
    kind: "project_rules",
    content: "Global: no force-push to main.",
  });

  const blocks = listBlocks(db, "/Users/dev/proj-list");
  const projects = new Set(blocks.map((b) => b.project));
  assert.ok(projects.has("/Users/dev/proj-list"));
  assert.ok(projects.has(null));
  // No unrelated project leaks in.
  for (const b of blocks) {
    assert.ok(b.project === "/Users/dev/proj-list" || b.project === null);
  }
});

test("deleteBlock removes the block", () => {
  const id = setBlock(db, {
    kind: "known_risks",
    project: "/Users/dev/proj-del",
    content: "Delete me.",
  });
  assert.equal(deleteBlock(db, id), true);
  assert.equal(getBlock(db, "known_risks", "/Users/dev/proj-del"), null);
  assert.equal(deleteBlock(db, id), false);
});

test("getProjectContext aggregates blocks + approved decisions/gotchas/runbooks", () => {
  const project = "/Users/dev/proj-ctx";

  setBlock(db, {
    kind: "project_rules",
    project,
    content: "Context rules.",
  });

  const decisionId = insertMemoryRecord(db, {
    type: "decision",
    title: "Adopt NodeNext modules",
    body: "We switched to NodeNext.",
    project,
    confidence: 0.8,
    status: "approved",
    sources: [source],
  });
  const gotchaId = insertMemoryRecord(db, {
    type: "gotcha",
    title: "WAL sidecar files",
    body: "Remember to clean up -wal/-shm.",
    project,
    confidence: 0.8,
    status: "approved",
    sources: [source],
  });
  const runbookId = insertMemoryRecord(db, {
    type: "runbook",
    title: "Reindex procedure",
    body: "Run omp-episodic index.",
    project,
    confidence: 0.8,
    status: "approved",
    sources: [source],
  });

  const ctx = getProjectContext(db, { project });
  assert.equal(ctx.project, project);
  assert.ok(ctx.blocks.some((b) => b.kind === "project_rules"));
  assert.ok(ctx.recentDecisions.some((r) => r.id === decisionId));
  assert.ok(ctx.gotchas.some((r) => r.id === gotchaId));
  assert.ok(ctx.runbooks.some((r) => r.id === runbookId));
});
