// Scaffolds an extraction gold-set TEMPLATE against REAL sessions: runs the pure
// extractor over a sessions dir and emits one row per candidate, pre-filled
// correct:true, for a human to review and flip to false where wrong. Each row
// carries context fields (title, matchedText, rule) to aid the judgment; the
// eval loader ignores those and reads only the ExtractLabel keys. Pure and
// deterministic: no DB, no network.
import { extractWithExplanations } from "./extractor.js";
import type { ExtractLabel } from "./extract-eval.js";
import { findSessionFiles } from "./indexer.js";
import { parseSessionFile } from "./parser.js";

export interface ScaffoldOptions {
  sessionsDir?: string;
  limit?: number;
}

/**
 * A label row plus the context a human needs to judge it: the candidate's title,
 * the exact text that matched, and which rule fired. The extra fields are ignored
 * by the eval loader but help review.
 */
export interface ScaffoldRow extends ExtractLabel {
  title: string;
  matchedText: string;
  rule: string;
}
/**
 * Build a labels.jsonl template from real sessions. Gathers exchanges, runs the
 * pure extractor, and emits one row per candidate (correct:true by default) in
 * extractor order. Deterministic.
 */
export function scaffoldLabels(opts: ScaffoldOptions): ScaffoldRow[] {
  const exchanges = findSessionFiles(opts.sessionsDir).flatMap((f) => parseSessionFile(f));
  const candidates = extractWithExplanations(exchanges);

  const rows: ScaffoldRow[] = candidates.map((candidate) => {
    const source = candidate.record.sources[0];
    return {
      sessionId: source?.sessionId ?? "",
      ordinal: source?.ordinal ?? -1,
      type: candidate.record.type,
      titleSubstring: candidate.record.title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .slice(0, 4)
        .join(" ")
        .trim(),
      correct: true,
      title: candidate.record.title,
      matchedText: candidate.matchedText,
      rule: candidate.rule,
    };
  });

  return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
}

/**
 * Render rows as compact JSONL: one JSON object per line, newline-separated,
 * trailing newline. Meant to be redirected into a labels.jsonl a human edits.
 */
export function formatScaffoldJsonl(rows: ScaffoldRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}
