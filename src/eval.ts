// Evaluation harness for recall quality: builds an index + approved memories
// from a sessions dir, runs each eval question through recallForTask, and
// scores recall@k, MRR, abstention accuracy, false-positive rate, and latency.
// Deterministic when run with mode:"text" (no embedding model / network).
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { openDb, insertExchange, runInTransaction, type InsertableExchange } from "./db.js";
import { embedExchange, initEmbeddings } from "./embeddings.js";
import { extract } from "./extractor.js";
import { findSessionFiles } from "./indexer.js";
import { listMemoryRecords, updateMemoryStatus } from "./memory.js";
import { parseSessionFile } from "./parser.js";
import { recallForTask, type RecallBundle } from "./recall.js";
import { EMBEDDING_DIM, type SearchMode } from "./types.js";

/** Categories mirror the recall intents the harness exercises. */
export type EvalCategory =
  | "exact"
  | "decision"
  | "procedural"
  | "temporal"
  | "multi_session"
  | "gotcha"
  | "abstain";

/** One expected episode, keyed on stable (sessionId, ordinal) — not rowid. */
export interface ExpectedEpisode {
  sessionId: string;
  ordinal: number;
}

/** A single eval question. */
export interface EvalQuestion {
  id: string;
  query: string;
  category: EvalCategory;
  /** Expected episodes by stable key (optional). */
  expectedEpisodes?: ExpectedEpisode[];
  /** Case-insensitive substrings expected to appear in a memory-evidence title. */
  expectedMemoryTitles?: string[];
  /** When true, the system SHOULD abstain (answerable === false). */
  mustAbstain?: boolean;
  /** Optional project scope passed to recall. */
  project?: string;
}

export interface EvalMetrics {
  total: number;
  scored: number;
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  abstentionAccuracy: number;
  falsePositiveRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface EvalQuestionResult {
  id: string;
  category: EvalCategory;
  mustAbstain: boolean;
  abstained: boolean;
  /** 1-based rank of the first expected evidence item, or null if not found. */
  firstHitRank: number | null;
  latencyMs: number;
}

export interface EvalReport {
  metrics: EvalMetrics;
  results: EvalQuestionResult[];
}

/** Parse a questions.jsonl buffer into typed questions (skips blank lines). */
export function parseEvalQuestions(raw: string): EvalQuestion[] {
  const out: EvalQuestion[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      out.push(parsed as EvalQuestion);
    }
  }
  return out;
}

export interface EvalOptions {
  dbPath?: string;
  sessionsDir?: string;
  questionsPath: string;
  /** Search mode for recall; "text" keeps the run deterministic + offline. */
  mode?: SearchMode;
  /** Build a fresh index + memories before evaluating (default true). */
  build?: boolean;
}

/** Deterministic, model-free unit-length embedding for offline index builds. */
function fakeEmbedding(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    v[i] = Math.sin((seed + 1) * (i + 1) * 0.0001) + 0.5;
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
  return v;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Rank (1-based) of the first evidence item matching a question's expectations. */
function firstExpectedRank(bundle: RecallBundle, q: EvalQuestion): number | null {
  const wantEpisodes = q.expectedEpisodes ?? [];
  const wantTitles = (q.expectedMemoryTitles ?? []).map((t) => t.toLowerCase());
  for (let i = 0; i < bundle.evidence.length; i++) {
    const ev = bundle.evidence[i];
    if (ev.kind === "episode") {
      const match = wantEpisodes.some(
        (e) => e.sessionId === ev.sessionId && e.ordinal === ev.ordinal,
      );
      if (match) return i + 1;
    } else {
      const title = ev.title.toLowerCase();
      if (wantTitles.some((t) => title.includes(t))) return i + 1;
    }
  }
  return null;
}

/**
 * Run the eval harness. When `build` is true (default), builds a fresh index
 * with deterministic synthetic embeddings (when mode==="text") or the real
 * model otherwise, extracts derived memories, and approves them all.
 */
export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const mode: SearchMode = opts.mode ?? "text";
  const building = opts.build !== false;
  // Building seeds synthetic eval data; never write that into the user's real
  // default index. Use an isolated temp DB unless an explicit dbPath is given.
  const usingTempDb = building && opts.dbPath === undefined;
  const dbPath = usingTempDb
    ? join(tmpdir(), `omp-eval-${randomUUID()}.db`)
    : opts.dbPath;
  const db = openDb(dbPath);
  try {
    if (opts.build !== false) {
      const useFake = mode === "text";
      if (!useFake) await initEmbeddings();
      const files = findSessionFiles(opts.sessionsDir);
      let seed = 0;
      for (const file of files) {
        const exchanges = parseSessionFile(file);
        const insertables: InsertableExchange[] = [];
        for (const ex of exchanges) {
          const embedding = useFake
            ? fakeEmbedding(seed++)
            : await embedExchange(ex.userText, ex.assistantText, ex.toolNames, ex.toolEvents);
          insertables.push({ ...ex, embedding });
        }
        runInTransaction(db, () => {
          for (const ins of insertables) insertExchange(db, ins);
        });
      }
      extract({ dbPath, sessionsDir: opts.sessionsDir });
      for (const rec of listMemoryRecords(db, "pending", Number.MAX_SAFE_INTEGER)) {
        updateMemoryStatus(db, rec.id, "approved");
      }
    }

    const questions = parseEvalQuestions(readFileSync(opts.questionsPath, "utf8"));
    const results: EvalQuestionResult[] = [];
    const latencies: number[] = [];

    for (const q of questions) {
      const start = performance.now();
      const bundle = await recallForTask(db, { task: q.query, mode, project: q.project });
      const latencyMs = performance.now() - start;
      latencies.push(latencyMs);

      results.push({
        id: q.id,
        category: q.category,
        mustAbstain: q.mustAbstain === true,
        abstained: !bundle.answerable,
        firstHitRank: q.mustAbstain === true ? null : firstExpectedRank(bundle, q),
        latencyMs,
      });
    }

    // Metrics. "scored" = questions with concrete expectations (not abstain-only).
    const scoredResults = results.filter((r) => !r.mustAbstain);
    const scored = scoredResults.length;
    const hitAt = (k: number): number =>
      scored === 0
        ? 0
        : scoredResults.filter((r) => r.firstHitRank !== null && r.firstHitRank <= k).length / scored;
    const mrr =
      scored === 0
        ? 0
        : scoredResults.reduce((sum, r) => sum + (r.firstHitRank ? 1 / r.firstHitRank : 0), 0) / scored;

    const abstainResults = results.filter((r) => r.mustAbstain);
    const abstentionAccuracy =
      abstainResults.length === 0
        ? 1
        : abstainResults.filter((r) => r.abstained).length / abstainResults.length;
    const falsePositiveRate =
      abstainResults.length === 0
        ? 0
        : abstainResults.filter((r) => !r.abstained).length / abstainResults.length;

    const sortedLatencies = [...latencies].sort((a, b) => a - b);

    return {
      metrics: {
        total: results.length,
        scored,
        recallAt1: hitAt(1),
        recallAt5: hitAt(5),
        mrr,
        abstentionAccuracy,
        falsePositiveRate,
        latencyP50Ms: percentile(sortedLatencies, 50),
        latencyP95Ms: percentile(sortedLatencies, 95),
      },
      results,
    };
  } finally {
    db.close();
    if (usingTempDb && dbPath !== undefined) {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(dbPath + suffix, { force: true });
      }
    }
  }
}

/** Render an EvalReport as a compact markdown summary. */
export function formatEvalReport(report: EvalReport): string {
  const m = report.metrics;
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  return [
    "# Recall Eval Report",
    "",
    `- Questions:           ${m.total} (${m.scored} scored)`,
    `- Recall@1:            ${pct(m.recallAt1)}`,
    `- Recall@5:            ${pct(m.recallAt5)}`,
    `- MRR:                 ${m.mrr.toFixed(3)}`,
    `- Abstention accuracy: ${pct(m.abstentionAccuracy)}`,
    `- False-positive rate: ${pct(m.falsePositiveRate)}`,
    `- Latency p50:         ${m.latencyP50Ms.toFixed(1)} ms`,
    `- Latency p95:         ${m.latencyP95Ms.toFixed(1)} ms`,
  ].join("\n");
}
