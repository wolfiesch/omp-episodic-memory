// Evaluation harness for extraction quality: gathers exchanges from a sessions
// dir, runs the pure candidate extractor, and scores precision against a gold
// label set keyed on stable (sessionId, ordinal, type, titleSubstring). Also
// reports a duplicate rate over dedupeKeys and surfaces unlabeled candidates so
// the gold set can be grown. Pure and deterministic: no DB, no network.
import { readFileSync } from "node:fs";

import { extractWithExplanations } from "./extractor.js";
import { findSessionFiles } from "./indexer.js";
import type { MemoryType } from "./memory.js";
import { parseSessionFile } from "./parser.js";

/**
 * One gold judgment: in the given exchange, a candidate of `type` whose title
 * contains `titleSubstring` (case-insensitive) is correct (true) or a false
 * positive (false).
 */
export interface ExtractLabel {
  sessionId: string;
  ordinal: number;
  type: MemoryType;
  titleSubstring: string;
  correct: boolean;
}

export interface ExtractEvalMetrics {
  totalCandidates: number;
  labeledCandidates: number;
  precision: number;
  duplicateRate: number;
  byType: Record<string, { candidates: number; correct: number; precision: number }>;
}

export interface ExtractEvalReport {
  metrics: ExtractEvalMetrics;
  unlabeled: Array<{ sessionId: string; ordinal: number; type: string; title: string }>;
}

export interface ExtractEvalOptions {
  sessionsDir?: string;
  labelsPath?: string;
}

/** Parse a labels.jsonl buffer into typed labels (skips blank lines). */
export function loadExtractLabels(path: string): ExtractLabel[] {
  const raw = readFileSync(path, "utf8");
  const out: ExtractLabel[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      out.push(parsed as ExtractLabel);
    }
  }
  return out;
}

/**
 * Run the extraction eval. Gathers candidates from the sessions dir, computes a
 * duplicate rate over dedupeKeys, and (when labelsPath is given) scores overall
 * and per-type precision against the gold labels. Deterministic ordering.
 */
export function runExtractEval(opts: ExtractEvalOptions): ExtractEvalReport {
  const exchanges = findSessionFiles(opts.sessionsDir).flatMap((f) =>
    parseSessionFile(f),
  );
  const candidates = extractWithExplanations(exchanges);

  const total = candidates.length;
  const distinctKeys = new Set(candidates.map((c) => c.dedupeKey)).size;
  const duplicateRate = total === 0 ? 0 : (total - distinctKeys) / total;

  const labels =
    opts.labelsPath !== undefined ? loadExtractLabels(opts.labelsPath) : [];

  let labeledCandidates = 0;
  let correctCount = 0;
  const byType: ExtractEvalMetrics["byType"] = {};
  const unlabeled: ExtractEvalReport["unlabeled"] = [];

  for (const c of candidates) {
    const source = c.record.sources[0];
    const sessionId = source?.sessionId ?? "";
    const ordinal = source?.ordinal ?? -1;
    const type = c.record.type;
    const titleLower = c.record.title.toLowerCase();

    const match = labels.find(
      (l) =>
        l.sessionId === sessionId &&
        l.ordinal === ordinal &&
        l.type === type &&
        titleLower.includes(l.titleSubstring.toLowerCase()),
    );

    if (match === undefined) {
      unlabeled.push({ sessionId, ordinal, type, title: c.record.title });
      continue;
    }

    labeledCandidates += 1;
    const bucket = byType[type] ?? { candidates: 0, correct: 0, precision: 0 };
    bucket.candidates += 1;
    if (match.correct) {
      correctCount += 1;
      bucket.correct += 1;
    }
    byType[type] = bucket;
  }

  for (const bucket of Object.values(byType)) {
    bucket.precision =
      bucket.candidates === 0 ? 0 : bucket.correct / bucket.candidates;
  }

  const precision =
    labeledCandidates === 0 ? 0 : correctCount / labeledCandidates;

  return {
    metrics: {
      totalCandidates: total,
      labeledCandidates,
      precision,
      duplicateRate,
      byType,
    },
    unlabeled,
  };
}

/** Render an ExtractEvalReport as a compact multi-line summary. */
export function formatExtractEvalReport(report: ExtractEvalReport): string {
  const m = report.metrics;
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const lines = [
    "# Extract Eval Report",
    "",
    `- Candidates:     ${m.totalCandidates} (${m.labeledCandidates} labeled)`,
    `- Precision:      ${pct(m.precision)}`,
    `- Duplicate rate: ${pct(m.duplicateRate)}`,
    "",
    "Per-type:",
  ];
  for (const type of Object.keys(m.byType).sort()) {
    const b = m.byType[type];
    lines.push(
      `- ${type.padEnd(8)} ${b.correct}/${b.candidates} (${pct(b.precision)})`,
    );
  }
  lines.push("", `- Unlabeled:      ${report.unlabeled.length}`);
  return lines.join("\n");
}
