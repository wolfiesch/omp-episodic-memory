import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { extract, extractFromExchanges } from "../src/extractor.js";
import { findSessionFiles } from "../src/indexer.js";
import { listMemoryRecords } from "../src/memory.js";
import { parseSessionFile } from "../src/parser.js";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sessions",
);

function allFixtureExchanges() {
  return findSessionFiles(FIXTURES_DIR).flatMap((f) => parseSessionFile(f));
}

test("extractFromExchanges yields decision and gotcha records with correct provenance and project", () => {
  const exchanges = allFixtureExchanges();
  const records = extractFromExchanges(exchanges);

  const decisions = records.filter((r) => r.type === "decision");
  const gotchas = records.filter((r) => r.type === "gotcha");
  assert.ok(decisions.length >= 1, "expected >=1 decision record");
  assert.ok(gotchas.length >= 1, "expected >=1 gotcha record");

  // Decisions match the "We decided to use ..." sentences.
  assert.ok(decisions.every((r) => /we decided to/i.test(r.body)));
  // Gotchas match the documented cautionary/failure vocabulary.
  assert.ok(
    gotchas.every((r) =>
      /\b(?:avoid|do not|don['’]t|never|gotcha|fails?|failed|error)\b/i.test(r.body),
    ),
  );

  // Provenance matches a real exchange (sessionId + ordinal) and project == cwd.
  for (const rec of records) {
    assert.equal(rec.sources.length, 1);
    const src = rec.sources[0];
    const ex = exchanges.find(
      (e) => e.sessionId === src.sessionId && e.ordinal === src.ordinal,
    );
    assert.ok(ex, "source must point at a parsed exchange");
    assert.equal(src.sourcePath, ex.sourcePath);
    assert.equal(rec.project, ex.cwd);
  }
});

test("every proposed record is well-formed", () => {
  const records = extractFromExchanges(allFixtureExchanges());
  assert.ok(records.length > 0);
  for (const rec of records) {
    assert.ok(rec.title.length > 0);
    assert.ok(rec.body.length > 0);
    assert.ok(rec.status === undefined || rec.status === "pending");
    assert.ok(rec.confidence >= 0 && rec.confidence <= 1);
    assert.ok(rec.sources.length >= 1);
  }
});

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

test("extract() inserts pending records and is idempotent", () => {
  const first = extract({ dbPath, sessionsDir: FIXTURES_DIR });
  assert.ok(first.proposed > 0);

  const afterFirst = listMemoryRecords(db, "pending", 1000).length;
  assert.ok(afterFirst > 0);

  extract({ dbPath, sessionsDir: FIXTURES_DIR });
  const afterSecond = listMemoryRecords(db, "pending", 1000).length;
  assert.equal(afterSecond, afterFirst);
});
