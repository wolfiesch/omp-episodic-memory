import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  runEval,
  formatEvalReport,
  parseEvalQuestions,
  type EvalReport,
} from "../src/eval.js";
import { openDb } from "../src/db.js";
import { listMemoryRecords } from "../src/memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const sessionsDir = join(here, "fixtures", "sessions");
const questionsPath = join(here, "fixtures", "eval", "questions.jsonl");
const allQuestions = parseEvalQuestions(readFileSync(questionsPath, "utf8"));

test("parseEvalQuestions parses valid lines and skips blanks", () => {
  const raw = [
    '{"id":"a","query":"q1","category":"decision"}',
    "",
    '{"id":"b","query":"q2","category":"abstain","mustAbstain":true}',
  ].join("\n");
  const questions = parseEvalQuestions(raw);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].id, "a");
  assert.equal(questions[0].category, "decision");
  assert.equal(questions[1].id, "b");
  assert.equal(questions[1].category, "abstain");
  assert.equal(questions[1].mustAbstain, true);
});

test("runEval end-to-end metrics", async () => {
  const report = await runEval({ sessionsDir, questionsPath, mode: "text" });
  const m = report.metrics;
  assert.equal(m.total, allQuestions.length);
  assert.equal(m.scored, allQuestions.filter((q) => q.mustAbstain !== true).length);
  assert.ok(m.recallAt5 >= 0.99);
  assert.equal(m.abstentionAccuracy, 1);
  assert.equal(m.falsePositiveRate, 0);
  assert.ok(m.recallAt1 >= 0.5);
  assert.ok(m.mrr > 0 && m.mrr <= 1);
});

test("runEval supersedes stale decisions before scoring", async () => {
  const dbPath = join(tmpdir(), "omp-eval-supersede-" + randomUUID() + ".db");
  try {
    await runEval({ dbPath, sessionsDir, questionsPath, mode: "text" });
    const db = openDb(dbPath);
    try {
      const approved = listMemoryRecords(db, "approved", 1000);
      const superseded = listMemoryRecords(db, "superseded", 1000);
      assert.ok(
        approved.some((rec) => rec.title.includes("store recall cache in SQLite")),
        "current SQLite cache decision should remain approved",
      );
      assert.ok(
        superseded.some((rec) => rec.title.includes("store recall cache in JSON")),
        "stale JSON cache decision should be superseded",
      );
    } finally {
      db.close();
    }
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

test("abstention results abstain and have null firstHitRank", async () => {
  const report = await runEval({ sessionsDir, questionsPath, mode: "text" });
  const abstainResults = report.results.filter((r) => r.mustAbstain === true);
  assert.equal(abstainResults.length, allQuestions.filter((q) => q.mustAbstain === true).length);
  for (const r of abstainResults) {
    assert.equal(r.abstained, true);
    assert.equal(r.firstHitRank, null);
  }
});

test("scored results have valid ranks", async () => {
  const report = await runEval({ sessionsDir, questionsPath, mode: "text" });
  const scored = report.results.filter((r) => r.mustAbstain === false);
  for (const r of scored) {
    if (r.firstHitRank !== null) {
      assert.ok(r.firstHitRank >= 1);
    }
  }
  assert.ok(scored.some((r) => r.firstHitRank === 1));
});

test("latency metrics are finite and ordered", async () => {
  const report = await runEval({ sessionsDir, questionsPath, mode: "text" });
  const { latencyP50Ms, latencyP95Ms } = report.metrics;
  assert.ok(Number.isFinite(latencyP50Ms) && latencyP50Ms >= 0);
  assert.ok(Number.isFinite(latencyP95Ms) && latencyP95Ms >= 0);
  assert.ok(latencyP95Ms >= latencyP50Ms);
});

test("formatEvalReport renders a summary string", async () => {
  const report = await runEval({ sessionsDir, questionsPath, mode: "text" });
  const out = formatEvalReport(report);
  assert.ok(out.length > 0);
  assert.ok(out.includes("Recall@5"));
  assert.ok(out.includes("Abstention"));
});

test("runEval is deterministic in text mode", async () => {
  const a = await runEval({ sessionsDir, questionsPath, mode: "text" });
  const b = await runEval({ sessionsDir, questionsPath, mode: "text" });
  const same = (r: EvalReport["metrics"]) => ({
    recallAt1: r.recallAt1,
    recallAt5: r.recallAt5,
    mrr: r.mrr,
    abstentionAccuracy: r.abstentionAccuracy,
    falsePositiveRate: r.falsePositiveRate,
  });
  assert.deepEqual(same(a.metrics), same(b.metrics));
});
