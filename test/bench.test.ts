import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { formatBenchReport, runBench } from "../src/bench.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS = join(HERE, "fixtures", "sessions");
const QUESTIONS = join(HERE, "fixtures", "eval", "questions.jsonl");
const LABELS = join(HERE, "fixtures", "extract-eval", "labels.jsonl");

test("runBench reports both gate and target tiers", async () => {
  const report = await runBench({
    questionsPath: QUESTIONS,
    sessionsDir: SESSIONS,
    labelsPath: LABELS,
    mode: "text",
  });
  const gates = report.checks.filter((c) => c.tier === "gate");
  const targets = report.checks.filter((c) => c.tier === "target");
  assert.ok(gates.length >= 7, "expected at least 7 gate checks");
  assert.ok(targets.length >= 3, "expected at least 3 target checks");
});

test("runBench keeps targets non-blocking", async () => {
  const report = await runBench({
    questionsPath: QUESTIONS,
    sessionsDir: SESSIONS,
    labelsPath: LABELS,
    mode: "text",
  });
  assert.equal(report.gatePassed, true, "all gate floors should be met");
  const target = report.checks.find((c) => c.name === "recall@1-target");
  assert.ok(target, "recall@1-target check should exist");
  assert.equal(target.tier, "target");
});

test("runBench gates on a meaningful scored recall question set size", async () => {
  const report = await runBench({
    questionsPath: QUESTIONS,
    sessionsDir: SESSIONS,
    labelsPath: LABELS,
    mode: "text",
  });
  const check = report.checks.find((c) => c.name === "recall-question-count");
  assert.ok(check, "recall-question-count gate should exist");
  assert.equal(check.tier, "gate");
  assert.equal(check.threshold, 30);
  assert.equal(check.pass, true);
});

test("runBench gates on fully labeled extraction candidates", async () => {
  const report = await runBench({
    questionsPath: QUESTIONS,
    sessionsDir: SESSIONS,
    labelsPath: LABELS,
    mode: "text",
  });
  const check = report.checks.find((c) => c.name === "extract-unlabeled");
  assert.ok(check, "extract-unlabeled gate should exist");
  assert.equal(check.tier, "gate");
  assert.equal(check.threshold, 0);
  assert.equal(check.pass, true);
});


test("formatBenchReport renders gate/target sections and a Gate verdict", async () => {
  const report = await runBench({
    questionsPath: QUESTIONS,
    sessionsDir: SESSIONS,
    labelsPath: LABELS,
    mode: "text",
  });
  const text = formatBenchReport(report);
  assert.ok(text.includes("# OMP-MemBench"));
  assert.ok(text.includes("## Gates"));
  assert.ok(text.includes("## Targets"));
  assert.match(text.trim().split("\n").at(-1) ?? "", /Gate: (PASS|FAIL)/);
  assert.match(text, /recall-question-count: \d+ >= 30/);
});
