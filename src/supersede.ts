// Supersession logic: mark older decisions as superseded by newer ones on the
// same subject, plus a memory-diff between two time points. Pure + deterministic
// (the only clock read happens inside setMemoryValidTo's updated_at write).
import type Database from "better-sqlite3";
import {
  listMemoryRecords,
  setSupersedesMemoryId,
  setMemoryValidTo,
  updateMemoryStatus,
  type MemoryRecord,
} from "./memory.js";
import { upsertEdge, upsertEntity, type EdgeType } from "./graph.js";

export interface SupersedeResult {
  superseded: number;
  pairs: Array<{ olderId: number; newerId: number; subject: string }>;
}

export interface MemoryDiff {
  project: string | null;
  since: number;
  newDecisions: MemoryRecord[];
  supersededDecisions: MemoryRecord[];
  newGotchas: MemoryRecord[];
  newRunbooks: MemoryRecord[];
}

/** Edge type recorded when one decision supersedes another. */
const SUPERSEDES_EDGE: EdgeType = "supersedes";

/**
 * Record a `newer --supersedes--> older` edge in the project graph so the graph
 * view never diverges from the `supersedes_memory_id` column. Both decision
 * entities are upserted by title (matching graph-extract's naming), and the edge
 * carries the newer record's provenance + validity. Idempotent via upsertEdge.
 */
function linkSupersedesEdge(db: Database.Database, newer: MemoryRecord, older: MemoryRecord): void {
  const newerEntity = upsertEntity(db, "decision", newer.title);
  const olderEntity = upsertEntity(db, "decision", older.title);
  const source = newer.sources[0];
  upsertEdge(db, {
    srcEntityId: newerEntity,
    edgeType: SUPERSEDES_EDGE,
    dstEntityId: olderEntity,
    validFrom: newer.validFrom ?? undefined,
    sourceSessionId: source ? source.sessionId : null,
    sourceOrdinal: source ? source.ordinal : null,
    confidence: newer.confidence,
  });
}

/** Tokens too generic to identify a decision subject. */
const STOPWORDS: Record<string, true> = {
  decided: true,
  because: true,
  using: true,
  about: true,
  with: true,
  from: true,
  into: true,
  this: true,
  that: true,
  than: true,
  then: true,
  they: true,
  them: true,
  have: true,
  will: true,
  should: true,
  would: true,
  could: true,
  switch: true,
  switched: true,
  migrate: true,
  migrated: true,
  adopt: true,
  adopted: true,
  choose: true,
  chose: true,
  chosen: true,
  moving: true,
  move: true,
  moved: true,
  instead: true,
  over: true,
  update: true,
  updated: true,
  change: true,
  changed: true,
};

/** Extract lowercased significant tokens (length>=4, not a stopword) from a title, in order. */
function significantTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 4 && STOPWORDS[t] !== true);
}

/** Significant title tokens as a set, for subject-overlap comparison. */
function significantTokenSet(rec: MemoryRecord): Set<string> {
  return new Set(significantTokens(rec.title));
}

/**
 * The deterministic grouping key for a decision: project + first significant
 * title token. This is a cheap bucket; final pairing also requires a real
 * subject overlap (see `sharesSubject`) so unrelated decisions that merely share
 * a leading word are not falsely linked.
 */
function subjectKey(rec: MemoryRecord): string | null {
  const tokens = significantTokens(rec.title);
  if (tokens.length === 0) return null;
  return `${rec.project ?? ""}\u0000${tokens[0]}`;
}

/** Minimum number of shared significant tokens required to call two decisions the same subject. */
const MIN_SUBJECT_OVERLAP = 2;

/** Two decisions share a subject when they overlap on at least MIN_SUBJECT_OVERLAP significant tokens. */
function sharesSubject(a: Set<string>, b: Set<string>): boolean {
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) {
      overlap += 1;
      if (overlap >= MIN_SUBJECT_OVERLAP) return true;
    }
  }
  return false;
}

/** Order comparator: validFrom ascending (nulls last), then id ascending. */
function olderFirst(a: MemoryRecord, b: MemoryRecord): number {
  const av = a.validFrom;
  const bv = b.validFrom;
  if (av === null && bv === null) return a.id - b.id;
  if (av === null) return 1;
  if (bv === null) return -1;
  if (av !== bv) return av - bv;
  return a.id - b.id;
}

/**
 * Mark older decisions as superseded by a newer decision on the same subject.
 * Decisions are bucketed by project + first significant title token; within a
 * bucket, each record is linked to the NEAREST earlier record it directly shares
 * a real subject with (>= MIN_SUBJECT_OVERLAP significant tokens), checked
 * pairwise. Because the link is stored on the newer record (its
 * `supersedes_memory_id` points at the one record it replaced), driving the scan
 * per-newer keeps that column single-valued and lossless: distinct newers record
 * their own predecessor, and successive same-subject revisions form a chain
 * (r1 <- r2 <- r3). The overlap relation is intentionally non-transitive, so an
 * unrelated decision merely sharing a first token (or an interleaved revision of
 * a different real subject) is never linked. A record with no compatible earlier
 * record stays current. Each superseded record is set to status "superseded"
 * with valid_to closed at its successor's validFrom.
 */
export function supersedeDecisions(db: Database.Database): SupersedeResult {
  const approved = listMemoryRecords(db, "approved", Number.MAX_SAFE_INTEGER);
  const pending = listMemoryRecords(db, "pending", Number.MAX_SAFE_INTEGER);
  const decisions = [...approved, ...pending].filter((r) => r.type === "decision");

  const groups = new Map<string, MemoryRecord[]>();
  for (const rec of decisions) {
    const key = subjectKey(rec);
    if (key === null) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(rec);
    else groups.set(key, [rec]);
  }

  const pairs: SupersedeResult["pairs"] = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    const ordered = [...members].sort(olderFirst);
    const tokenSets = ordered.map(significantTokenSet);
    const subject = key.split("\u0000")[1];
    for (let j = ordered.length - 1; j > 0; j--) {
      // Link this record to the nearest earlier record it directly overlaps.
      let predecessor = -1;
      for (let i = j - 1; i >= 0; i--) {
        if (sharesSubject(tokenSets[j], tokenSets[i])) {
          predecessor = i;
          break;
        }
      }
      if (predecessor === -1) continue;
      const newer = ordered[j];
      const older = ordered[predecessor];
      updateMemoryStatus(db, older.id, "superseded");
      setMemoryValidTo(db, older.id, newer.validFrom);
      setSupersedesMemoryId(db, newer.id, older.id);
      linkSupersedesEdge(db, newer, older);
      pairs.push({ olderId: older.id, newerId: newer.id, subject });
    }
  }

  return { superseded: pairs.length, pairs };
}

/**
 * Reconstruct `supersedes` graph edges from every record's `supersedes_memory_id`
 * column, covering links written before edge-wiring existed and records already
 * marked `superseded` (which `supersedeDecisions` no longer revisits). Idempotent.
 * Returns the number of edges written.
 */
export function backfillSupersedesEdges(db: Database.Database): number {
  const all = listMemoryRecords(db, undefined, Number.MAX_SAFE_INTEGER);
  const byId = new Map<number, MemoryRecord>(all.map((r) => [r.id, r]));
  let written = 0;
  for (const newer of all) {
    if (newer.supersedesMemoryId === null) continue;
    const older = byId.get(newer.supersedesMemoryId);
    if (!older) continue;
    linkSupersedesEdge(db, newer, older);
    written += 1;
  }
  return written;
}

/**
 * Diff of memory between `opts.after` (unix seconds) and now, optionally scoped
 * to a project. Gathers candidate records via listMemoryRecords and filters in
 * TypeScript.
 */
export function memoryDiff(
  db: Database.Database,
  opts: { project?: string; after: number },
): MemoryDiff {
  const project = opts.project ?? null;
  const after = opts.after;

  const matchesProject = (rec: MemoryRecord): boolean =>
    opts.project === undefined || rec.project === opts.project;

  const approved = listMemoryRecords(db, "approved", Number.MAX_SAFE_INTEGER);
  const pending = listMemoryRecords(db, "pending", Number.MAX_SAFE_INTEGER);
  const superseded = listMemoryRecords(db, "superseded", Number.MAX_SAFE_INTEGER);
  const live = [...approved, ...pending];

  const newDecisions = live.filter(
    (r) => r.type === "decision" && matchesProject(r) && r.validFrom !== null && r.validFrom >= after,
  );

  const supersededDecisions = superseded.filter(
    (r) => r.type === "decision" && matchesProject(r) && r.updatedAt >= after,
  );

  const newGotchas = live.filter(
    (r) => r.type === "gotcha" && matchesProject(r) && r.validFrom !== null && r.validFrom >= after,
  );

  const newRunbooks = live.filter(
    (r) => r.type === "runbook" && matchesProject(r) && r.validFrom !== null && r.validFrom >= after,
  );

  return {
    project,
    since: after,
    newDecisions,
    supersededDecisions,
    newGotchas,
    newRunbooks,
  };
}
