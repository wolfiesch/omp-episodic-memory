// Combined OMP-MemBench engine: runs the recall eval and the extraction eval,
// then scores them against a two-tier threshold model. Gate-tier checks are
// CI-blocking floors; target-tier checks are aspirational SOTA bars that are
// reported but never block the build. Pure/deterministic given mode:"text"
// (runEval is offline+deterministic in text mode; runExtractEval is always pure).
import { runEval, type EvalReport } from "./eval.js";
import { runExtractEval, type ExtractEvalReport } from "./extract-eval.js";

export interface ThresholdCheck {
  name: string;
  value: number;
  comparator: ">=" | "<" | "<=";
  threshold: number;
  pass: boolean;
  /** "gate" = CI-blocking. "target" = aspirational, never blocks. */
  tier: "gate" | "target";
}

export interface BenchReport {
  recall: EvalReport;
  extract: ExtractEvalReport;
  checks: ThresholdCheck[];
  /** True iff every gate-tier check passed; target checks do not affect this. */
  gatePassed: boolean;
}

export interface BenchOptions {
  questionsPath: string;
  sessionsDir?: string;
  labelsPath?: string;
  mode?: "text" | "both" | "vector";
}

function compare(value: number, comparator: ">=" | "<" | "<=", threshold: number): boolean {
  switch (comparator) {
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
  }
}

function check(
  name: string,
  value: number,
  comparator: ">=" | "<" | "<=",
  threshold: number,
  tier: "gate" | "target",
): ThresholdCheck {
  return { name, value, comparator, threshold, pass: compare(value, comparator, threshold), tier };
}

/**
 * Run the combined bench: recall eval + extraction eval, scored against the
 * two-tier threshold model. Deterministic when mode==="text" (the default).
 */
export async function runBench(opts: BenchOptions): Promise<BenchReport> {
  const recall = await runEval({
    questionsPath: opts.questionsPath,
    sessionsDir: opts.sessionsDir,
    mode: opts.mode ?? "text",
  });
  const extract = runExtractEval({
    sessionsDir: opts.sessionsDir,
    labelsPath: opts.labelsPath,
  });

  const checks: ThresholdCheck[] = [
    // Gate-tier: CI-blocking floors set to currently-achievable values.
    check("recall-question-count", recall.metrics.scored, ">=", 30, "gate"),
    check("recall@5", recall.metrics.recallAt5, ">=", 0.85, "gate"),
    check("abstention-fp", recall.metrics.falsePositiveRate, "<", 0.1, "gate"),
    check("latency-p95-ms", recall.metrics.latencyP95Ms, "<", 500, "gate"),
    check("extract-precision", extract.metrics.precision, ">=", 0.8, "gate"),
    check("extract-unlabeled", extract.unlabeled.length, "<=", 0, "gate"),
    check("duplicate-rate", extract.metrics.duplicateRate, "<", 0.1, "gate"),
    // Target-tier: aspirational SOTA bars, never block the build.
    check("extract-precision-target", extract.metrics.precision, ">=", 0.85, "target"),
    check("recall@1-target", recall.metrics.recallAt1, ">=", 0.85, "target"),
    check("mrr-target", recall.metrics.mrr, ">=", 0.8, "target"),
  ];

  const gatePassed = checks
    .filter((c) => c.tier === "gate")
    .every((c) => c.pass);

  return { recall, extract, checks, gatePassed };
}

/** Render a BenchReport as a markdown report with separated gate/target tiers. */
export function formatBenchReport(report: BenchReport): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const r = report.recall.metrics;
  const e = report.extract.metrics;

  const lines: string[] = [
    "# OMP-MemBench",
    "",
    `Recall: Recall@5 ${pct(r.recallAt5)}, abstention-FP ${pct(r.falsePositiveRate)}, p95 ${r.latencyP95Ms.toFixed(1)}ms`,
    `Extract: precision ${pct(e.precision)}, dup rate ${pct(e.duplicateRate)}`,
    "",
    "## Gates",
  ];

  const fmtValue = (c: ThresholdCheck): string =>
    c.name === "latency-p95-ms"
      ? `${c.value.toFixed(1)}ms`
      : c.name === "mrr-target"
        ? c.value.toFixed(3)
        : c.name === "recall-question-count" || c.name === "extract-unlabeled"
          ? c.value.toFixed(0)
          : pct(c.value);

  for (const c of report.checks.filter((c) => c.tier === "gate")) {
    const mark = c.pass ? "✓" : "✗";
    lines.push(`${mark} ${c.name}: ${fmtValue(c)} ${c.comparator} ${c.threshold}`);
  }

  lines.push("", "## Targets");
  for (const c of report.checks.filter((c) => c.tier === "target")) {
    // Targets never fail the build: use → for unmet, ✓ for met.
    const mark = c.pass ? "✓" : "→";
    lines.push(`${mark} ${c.name}: ${fmtValue(c)} ${c.comparator} ${c.threshold}`);
  }

  lines.push("", `Gate: ${report.gatePassed ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}
