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
function exchangeWithAssistant(assistantText: string) {
  return {
    sessionId: "real-noise-sample",
    sourcePath: "/tmp/session.jsonl",
    title: "Noise sample",
    cwd: "/tmp/project",
    ordinal: 0,
    timestamp: 1_782_000_000,
    userText: "summarize progress",
    assistantText,
    toolNames: [],
    toolEvents: [],
  };
}


test("extractFromExchanges yields decision and gotcha records with correct provenance and project", () => {
  const exchanges = allFixtureExchanges();
  const records = extractFromExchanges(exchanges);

  const decisions = records.filter((r) => r.type === "decision");
  const gotchas = records.filter((r) => r.type === "gotcha");
  assert.ok(decisions.length >= 1, "expected >=1 decision record");
  assert.ok(gotchas.length >= 1, "expected >=1 gotcha record");

  // Decisions match durable decision phrasing, not arbitrary status headings.
  assert.ok(decisions.every((r) => /\b(?:decided|chose|agreed)\b|\bdecision\s+(?:is|was|to)\b/i.test(r.body)));
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

test("extractFromExchanges ignores transient task constraints as gotchas", () => {
  const records = extractFromExchanges([
    exchangeWithAssistant("Do not edit anything. Do not run project-wide tests or formatters. Do not run gates or formatters."),
  ]);
  assert.equal(records.some((record) => record.type === "gotcha"), false);
});

test("extractFromExchanges ignores table rows and coordination as gotchas", () => {
  const records = extractFromExchanges([
    exchangeWithAssistant("| Issue | Root cause is documented | Auth boundary. I’ll only update docs and avoid installer changes."),
  ]);
  assert.equal(records.some((record) => record.type === "gotcha"), false);
});

test("extractFromExchanges ignores status headings as gotchas and decisions", () => {
  const records = extractFromExchanges([
    exchangeWithAssistant("# Acceptance Report merge-likelihood heuristics and PR anti-patterns to avoid.\n\n## Likely patch area\n\nStart with files.\n\nDecision: reproduce first.\n\nChanged:\n- Fixed issue\n\nNote: auth error."),
  ]);
  assert.equal(records.some((record) => record.type === "gotcha"), false);
  assert.equal(records.some((record) => record.type === "decision"), false);
});

test("extractFromExchanges keeps durable gotchas with specific technical object", () => {
  const records = extractFromExchanges([
    exchangeWithAssistant("Do not edit the generated sqlite-vec bindings directly."),
  ]);
  assert.equal(records.some((record) => record.type === "gotcha"), true);
});

test("extractFromExchanges ignores status-summary lists as runbooks", () => {
  const records = extractFromExchanges([
    exchangeWithAssistant("Timestamp: 06/17/2026 04:04 AM PDT. Done. Next steps: 1. Opened the PR. 2. Added screenshots. 3. Waiting for review."),
  ]);
  assert.equal(records.some((record) => record.type === "runbook"), false);
});

test("extractFromExchanges keeps procedural runbooks with explicit steps", () => {
  const records = extractFromExchanges([
    exchangeWithAssistant("Runbook for publishing: 1. Inspect the package. 2. Run npm publish --dry-run. 3. Publish."),
  ]);
  assert.equal(records.some((record) => record.type === "runbook"), true);
});

test("extractFromExchanges ignores question-form and too-short gotchas", () => {
  const qGotcha = extractFromExchanges([
    exchangeWithAssistant("Why avoid building a dashboard first?"),
  ]);
  assert.equal(qGotcha.some((r) => r.type === "gotcha"), false);

  const shortGotcha = extractFromExchanges([
    exchangeWithAssistant("Avoid it."),
  ]);
  assert.equal(shortGotcha.some((r) => r.type === "gotcha"), false);
});

test("extractFromExchanges ignores first-person narration gotchas lacking durable cues, but keeps them with cues", () => {
  const narrationNoCue = extractFromExchanges([
    exchangeWithAssistant("I will now write a test so we don't regress."),
  ]);
  assert.equal(narrationNoCue.some((r) => r.type === "gotcha"), false);

  const narrationWithCue = extractFromExchanges([
    exchangeWithAssistant("I will now make sure to avoid editing the files."),
  ]);
  assert.equal(narrationWithCue.some((r) => r.type === "gotcha"), true);
});

test("extractFromExchanges ignores noisy runbook leads and empty step leads", () => {
  const heresLead = extractFromExchanges([
    exchangeWithAssistant("Here's how to publish: 1. Compile. 2. Publish."),
  ]);
  assert.equal(heresLead.some((r) => r.type === "runbook"), false);

  const belowLead = extractFromExchanges([
    exchangeWithAssistant("Below are the steps: 1. Compile. 2. Publish."),
  ]);
  assert.equal(belowLead.some((r) => r.type === "runbook"), false);

  const numberLead = extractFromExchanges([
    exchangeWithAssistant("1. Compile. 2. Publish."),
  ]);
  assert.equal(numberLead.some((r) => r.type === "runbook"), false);
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
