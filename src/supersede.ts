// Supersession logic: mark older decisions as superseded by newer ones on the
// same subject, plus a memory-diff between two time points. Pure + deterministic
// (the only clock read happens inside setMemoryValidTo's updated_at write).
import type Database from "better-sqlite3";
import {
  listMemoryRecords,
  setMemoryValidTo,
  updateMemoryStatus,
  type MemoryRecord,
} from "./memory.js";
import type { EdgeType } from "./graph.js";

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

/** The deterministic subject key for a decision: project + first significant token. */
function subjectKey(rec: MemoryRecord): string | null {
  const tokens = significantTokens(rec.title);
  if (tokens.length === 0) return null;
  return `${rec.project ?? ""}\u0000${tokens[0]}`;
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
 * Mark older decisions as superseded by the newest decision sharing the same
 * subject (same project + same first significant title token). Within a group
 * the newest (by validFrom, then id) is current; each older record is set to
 * status "superseded" with its valid_to closed at the newer record's validFrom.
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
    const newest = ordered[ordered.length - 1];
    const subject = key.split("\u0000")[1];
    for (let i = 0; i < ordered.length - 1; i++) {
      const older = ordered[i];
      updateMemoryStatus(db, older.id, "superseded");
      setMemoryValidTo(db, older.id, newest.validFrom);
      pairs.push({ olderId: older.id, newerId: newest.id, subject });
    }
  }

  return { superseded: pairs.length, pairs };
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
