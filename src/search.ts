// Hybrid search: FTS5 (keyword) + vec0 (vector) fused with Reciprocal Rank Fusion.
// Pure read path: never writes to the DB.
import type Database from "better-sqlite3";

import { embed } from "./embeddings.js";
import type { SearchHit, SearchOptions } from "./types.js";

/** RRF constant. */
const RRF_K = 60;

interface ExchangeRow {
  id: number;
  session_id: string;
  source_path: string;
  title: string | null;
  cwd: string | null;
  ordinal: number;
  timestamp: number;
  user_text: string;
}

/**
 * Turn a raw natural-language query into an FTS5-safe MATCH expression:
 * split on whitespace, strip FTS5 special characters, quote each token,
 * and OR them together. Returns "" if nothing usable remains.
 */
function sanitizeFtsQuery(query: string): string {
  // Split on any run of non-alphanumeric characters so hyphenated/punctuated
  // input (e.g. "sqlite-vec") yields the same tokens FTS5 indexed ("sqlite",
  // "vec") rather than one untokenizable blob ("sqlitevec").
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return tokens.join(" OR ");
}

function vectorSearch(db: Database.Database, qv: Float32Array, k: number): number[] {
  const rows = db
    .prepare(
      `SELECT rowid FROM exchanges_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`,
    )
    .all(new Uint8Array(qv.buffer), k) as Array<{ rowid: number | bigint }>;
  return rows.map((r) => Number(r.rowid));
}

function textSearch(db: Database.Database, query: string, k: number): number[] {
  const match = sanitizeFtsQuery(query);
  if (match.length === 0) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT rowid FROM exchanges_fts
       WHERE exchanges_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, k) as Array<{ rowid: number | bigint }>;
  return rows.map((r) => Number(r.rowid));
}

export async function search(
  db: Database.Database,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  const mode = opts.mode ?? "both";
  const limit = opts.limit ?? 10;
  const hasDateFilter = opts.after !== undefined || opts.before !== undefined;
  const k = hasDateFilter ? Math.max(limit * 20, 500) : Math.max(limit * 5, 50);

  // Per-branch ordered id lists (best first).
  let vectorIds: number[] = [];
  let textIds: number[] = [];

  if (mode === "vector" || mode === "both") {
    const qv = await embed(opts.query);
    vectorIds = vectorSearch(db, qv, k);
  }
  if (mode === "text" || mode === "both") {
    textIds = textSearch(db, opts.query, k);
  }

  // 1-based rank maps for each branch.
  const vectorRanks = new Map<number, number>();
  vectorIds.forEach((id, i) => {
    if (!vectorRanks.has(id)) vectorRanks.set(id, i + 1);
  });
  const textRanks = new Map<number, number>();
  textIds.forEach((id, i) => {
    if (!textRanks.has(id)) textRanks.set(id, i + 1);
  });

  // Fuse with RRF over the union of candidate ids.
  const fusedScore = new Map<number, number>();
  for (const [id, rank] of vectorRanks) {
    fusedScore.set(id, (fusedScore.get(id) ?? 0) + 1 / (RRF_K + rank));
  }
  for (const [id, rank] of textRanks) {
    fusedScore.set(id, (fusedScore.get(id) ?? 0) + 1 / (RRF_K + rank));
  }

  if (fusedScore.size === 0) {
    return [];
  }

  // Order candidates by fused score (desc) before hydration.
  const candidateIds = [...fusedScore.keys()].sort(
    (a, b) => (fusedScore.get(b) ?? 0) - (fusedScore.get(a) ?? 0),
  );

  const selectRow = db.prepare(
    `SELECT id, session_id, source_path, title, cwd, ordinal, timestamp, user_text
     FROM exchanges WHERE id = ?`,
  );

  const hits: SearchHit[] = [];
  for (const id of candidateIds) {
    const row = selectRow.get(id) as ExchangeRow | undefined;
    if (!row) continue;
    if (opts.after !== undefined && row.timestamp < opts.after) continue;
    if (opts.before !== undefined && row.timestamp > opts.before) continue;

    hits.push({
      sessionId: row.session_id,
      sourcePath: row.source_path,
      title: row.title,
      cwd: row.cwd,
      ordinal: row.ordinal,
      timestamp: row.timestamp,
      snippet: row.user_text.replace(/\s+/g, " ").trim().slice(0, 200),
      score: fusedScore.get(id) ?? 0,
      vectorRank: vectorRanks.get(id) ?? null,
      textRank: textRanks.get(id) ?? null,
    });
  }

  hits.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
  return hits.slice(0, limit);
}
