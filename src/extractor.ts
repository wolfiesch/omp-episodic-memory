// Heuristic distillation of derived-memory candidates from raw exchanges.
// Pure extraction (extractFromExchanges) is DB-free and deterministic; extract()
// wires it to the session crawler and the derived-memory store. All proposed
// records default to status="pending" so they await human review.
import { openDb, runInTransaction } from "./db.js";
import { findSessionFiles } from "./indexer.js";
import { insertMemoryRecord, type NewMemoryRecord } from "./memory.js";
import { parseSessionFile } from "./parser.js";
import type { Exchange } from "./types.js";

/** Matches decision statements like "We decided to use sqlite-vec ...". */
const DECISION_RE = /\bwe (?:decided|chose|will use|agreed)\b|\bdecision\b/i;
/** Matches cautionary statements like "Avoid ..." / "Do not ..." / "... fails". */
const GOTCHA_RE = /\b(?:avoid|do not|don['’]t|never|gotcha|fails?|failed|error)\b/i;
/** Matches an ordered step marker (start-of-line or inline "N."). */
const STEP_RE = /(?:^|\n)\s*\d+\.\s|\s\d+\.\s/g;

/** Split text into trimmed, non-empty sentences on terminal punctuation. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Derive a short, single-line, non-empty title from a sentence. */
function titleFrom(sentence: string): string {
  const normalized = sentence.replace(/\s+/gu, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

/** Count ordered-step markers in a block of text. */
function countSteps(text: string): number {
  const matches = text.match(STEP_RE);
  return matches ? matches.length : 0;
}

/**
 * Extract candidate derived-memory records from parsed exchanges.
 * Pure and deterministic: no DB, no network. Each record carries provenance
 * (sessionId + ordinal + sourcePath) and the exchange's cwd as its project.
 * A single exchange may yield multiple records (e.g. a decision AND a gotcha).
 */
export interface ExtractCandidate {
  record: NewMemoryRecord;
  rule: string;
  matchedText: string;
  dedupeKey: string;
}

/**
 * Pure, auditable core: like extractFromExchanges but each produced record is
 * paired with the rule that fired, the exact text that triggered it, and the
 * dedupeKey memory.ts would use. No DB, no network, deterministic ordering.
 */
export function extractWithExplanations(exchanges: Exchange[]): ExtractCandidate[] {
  const out: ExtractCandidate[] = [];
  for (const ex of exchanges) {
    const source = {
      sessionId: ex.sessionId,
      ordinal: ex.ordinal,
      sourcePath: ex.sourcePath,
    };
    const project = ex.cwd;
    const seen = new Set<string>(); // dedupe (type+title) within one exchange

    const add = (
      type: NewMemoryRecord["type"],
      title: string,
      body: string,
      confidence: number,
      rule: string,
      matchedText: string,
    ): void => {
      if (title.length === 0 || body.length === 0) return;
      const key = `${type}\u0000${title}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        record: {
          type,
          title,
          body,
          project,
          confidence,
          status: "pending",
          sources: [source],
          validFrom: ex.timestamp,
        },
        rule,
        matchedText,
        dedupeKey: `${type}\u0000${title}\u0000${project ?? ""}`,
      });
    };

    // Decisions + gotchas: scan both user and assistant text, sentence by sentence.
    for (const text of [ex.userText, ex.assistantText]) {
      for (const sentence of splitSentences(text)) {
        if (DECISION_RE.test(sentence)) {
          add("decision", titleFrom(sentence), sentence, 0.7, "decision", sentence);
        } else if (GOTCHA_RE.test(sentence)) {
          add("gotcha", titleFrom(sentence), sentence, 0.6, "gotcha", sentence);
        }
      }
    }

    // Runbook: an assistant reply with an ordered step list (>=2 steps).
    if (countSteps(ex.assistantText) >= 2) {
      const firstSentence = splitSentences(ex.assistantText)[0] ?? ex.assistantText;
      const title = titleFrom(firstSentence);
      add("runbook", title, ex.assistantText.trim(), 0.65, "runbook", firstSentence);
    }
  }
  return out;
}

export function extractFromExchanges(exchanges: Exchange[]): NewMemoryRecord[] {
  return extractWithExplanations(exchanges).map((c) => c.record);
}

export interface ExtractOptions {
  dbPath?: string;
  sessionsDir?: string;
  /** Only consider exchanges at/after this unix-seconds time. */
  since?: number;
  /** Only consider exchanges whose cwd equals this project path. */
  project?: string;
  /** Cap the number of session files scanned. */
  limit?: number;
}

export interface ExtractResult {
  sessionsScanned: number;
  exchangesScanned: number;
  proposed: number;
}

/**
 * Crawl session transcripts under sessionsDir, extract candidate records, and
 * upsert them into the derived-memory store. Idempotent: re-running upserts the
 * same (type,title,project) tuples in place rather than duplicating them.
 * Synchronous (all underlying I/O is synchronous).
 */
export function extract(opts: ExtractOptions = {}): ExtractResult {
  const db = openDb(opts.dbPath);
  try {
    let files = findSessionFiles(opts.sessionsDir);
    if (opts.limit !== undefined) files = files.slice(0, opts.limit);
    let proposed = 0;
    let exchangesScanned = 0;
    runInTransaction(db, () => {
      for (const file of files) {
        let exchanges = parseSessionFile(file);
        if (opts.since !== undefined) {
          exchanges = exchanges.filter((e) => e.timestamp >= (opts.since as number));
        }
        if (opts.project !== undefined) {
          exchanges = exchanges.filter((e) => e.cwd === opts.project);
        }
        exchangesScanned += exchanges.length;
        for (const rec of extractFromExchanges(exchanges)) {
          insertMemoryRecord(db, rec);
          proposed++;
        }
      }
    });
    return { sessionsScanned: files.length, exchangesScanned, proposed };
  } finally {
    db.close();
  }
}
