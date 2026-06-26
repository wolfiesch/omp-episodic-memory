// Hybrid search: FTS5 (keyword) + vec0 (vector) fused with Reciprocal Rank Fusion.
// Pure read path: never writes to the DB.
import type Database from "better-sqlite3";

import { embed } from "./embeddings.js";
import type { SearchHit, SearchOptions } from "./types.js";
import { formatToolEventSummary, parseToolEvents } from "./tool-events.js";

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
  assistant_text: string;
  tool_events: string | null;
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

/** Build a 1-based rank map (first occurrence wins) from an ordered id list. */
function rankMap(ids: number[]): Map<number, number> {
  const ranks = new Map<number, number>();
  ids.forEach((id, i) => {
    if (!ranks.has(id)) ranks.set(id, i + 1);
  });
  return ranks;
}

export async function search(
  db: Database.Database,
  opts: SearchOptions,
): Promise<SearchHit[]> {
  const mode = opts.mode ?? "both";
  const limit = opts.limit ?? 10;
  const hasDateFilter = opts.after !== undefined || opts.before !== undefined;
  const hasToolFilter = opts.toolName !== undefined || opts.toolError !== undefined;
  const k = hasToolFilter
    ? Math.max(limit * 100, 1000)
    : hasDateFilter
      ? Math.max(limit * 20, 500)
      : Math.max(limit * 5, 50);

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

  // 1-based rank maps for each branch (first occurrence wins).
  const vectorRanks = rankMap(vectorIds);
  const textRanks = rankMap(textIds);

  // Fuse with RRF over the union of candidate ids.
  const fusedScore = new Map<number, number>();
  for (const ranks of [vectorRanks, textRanks]) {
    for (const [id, rank] of ranks) {
      fusedScore.set(id, (fusedScore.get(id) ?? 0) + 1 / (RRF_K + rank));
    }
  }

  if (fusedScore.size === 0) {
    return [];
  }

  // Order candidates by fused score (desc) before hydration.
  const candidateIds = [...fusedScore.keys()].sort(
    (a, b) => (fusedScore.get(b) ?? 0) - (fusedScore.get(a) ?? 0),
  );

  const selectRow = db.prepare(
    `SELECT id, session_id, source_path, title, cwd, ordinal, timestamp, user_text, assistant_text, tool_events
     FROM exchanges WHERE id = ?`,
  );

  const hits: SearchHit[] = [];
  for (const id of candidateIds) {
    const row = selectRow.get(id) as ExchangeRow | undefined;
    if (!row) continue;
    if (opts.after !== undefined && row.timestamp < opts.after) continue;
    if (opts.before !== undefined && row.timestamp > opts.before) continue;
    const toolEvents = parseToolEvents(row.tool_events);
    if (opts.toolName !== undefined && !toolEvents.some((event) => event.toolName === opts.toolName)) continue;
    if (opts.toolError !== undefined && !toolEvents.some((event) => event.isError === opts.toolError)) continue;

    const userPart = row.user_text.replace(/\s+/g, " ").trim();
    const asstPart = row.assistant_text.replace(/\s+/g, " ").trim();

    // Combined labeled excerpt: keep user intent AND assistant evidence visible.
    // Assistant gets the larger share since that's where substance lives.
    const parts: string[] = [];
    if (userPart) parts.push("U: " + userPart.slice(0, 100));
    if (asstPart) parts.push("A: " + asstPart.slice(0, 200));
    for (const event of toolEvents.slice(0, 2)) parts.push("T: " + formatToolEventSummary(event, 120));
    const snippet = parts.length > 0 ? parts.join(" | ") : "";

    const rawScore = fusedScore.get(id) ?? 0;
    const combinedLen = userPart.length + asstPart.length;
    const signal = Math.min(1, combinedLen / 400);
    const factor = 0.3 + 0.7 * signal;
    const finalScore = rawScore * factor;

    hits.push({
      sessionId: row.session_id,
      sourcePath: row.source_path,
      title: row.title,
      cwd: row.cwd,
      ordinal: row.ordinal,
      timestamp: row.timestamp,
      snippet,
      userSnippet: userPart.slice(0, 200),
      assistantSnippet: asstPart.slice(0, 200),
      toolEvents,
      score: finalScore,
      vectorRank: vectorRanks.get(id) ?? null,
      textRank: textRanks.get(id) ?? null,
    });
  }

  hits.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
  return hits.slice(0, limit);
}
