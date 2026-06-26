import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatExtractEvalReport,
  runExtractEval,
} from "../src/extract-eval.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(HERE, "fixtures", "sessions");
const LABELS_PATH = join(HERE, "fixtures", "extract-eval", "labels.jsonl");
const EXTRACT_SESSIONS_DIR = join(HERE, "fixtures", "extract-eval", "sessions");

test("runExtractEval with no labels reports candidates and a valid duplicate rate", () => {
  const report = runExtractEval({ sessionsDir: SESSIONS_DIR });
  assert.ok(report.metrics.totalCandidates > 0, "expected >0 candidates");
  assert.ok(report.metrics.duplicateRate >= 0 && report.metrics.duplicateRate <= 1);
  assert.equal(report.metrics.labeledCandidates, 0);
});

test("runExtractEval with the labels fixture scores precision and per-type breakdown", () => {
  const report = runExtractEval({
    sessionsDir: SESSIONS_DIR,
    labelsPath: LABELS_PATH,
  });
  assert.ok(report.metrics.precision >= 0 && report.metrics.precision <= 1);
  assert.ok(report.metrics.labeledCandidates > 0, "expected >0 labeled candidates");
  assert.ok(
    Object.keys(report.metrics.byType).length >= 1,
    "expected byType populated for >=1 type",
  );
});

test("runExtractEval with the relocated ffffffff session handles specific assertions", () => {
  const report = runExtractEval({
    sessionsDir: EXTRACT_SESSIONS_DIR,
    labelsPath: LABELS_PATH,
  });
  assert.equal(report.metrics.totalCandidates, 4);
  assert.equal(report.metrics.labeledCandidates, 4);
  assert.equal(report.metrics.precision, 0.75);
  assert.equal(report.unlabeled.length, 0);
});

test("formatExtractEvalReport returns a non-empty string mentioning precision", () => {
  const report = runExtractEval({
    sessionsDir: SESSIONS_DIR,
    labelsPath: LABELS_PATH,
  });
  const text = formatExtractEvalReport(report);
  assert.ok(text.length > 0);
  assert.ok(/precision/i.test(text));
});

test("runExtractEval is deterministic", () => {
  const a = runExtractEval({ sessionsDir: SESSIONS_DIR, labelsPath: LABELS_PATH });
  const b = runExtractEval({ sessionsDir: SESSIONS_DIR, labelsPath: LABELS_PATH });
  assert.deepEqual(a.metrics, b.metrics);
});
