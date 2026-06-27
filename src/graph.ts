// Temporal project graph (lite): entities + time-bounded edges in SQLite.
// Derived, reviewable, invalidatable knowledge layered over immutable episodes.
// No external graph DB; plain SQLite tables with validity windows.
import type Database from "better-sqlite3";

/** Entity categories tracked in the project graph. */
export type EntityType =
  | "project"
  | "repo"
  | "file"
  | "package"
  | "command"
  | "error"
  | "decision"
  | "tool";

export const ENTITY_TYPES: readonly EntityType[] = [
  "project",
  "repo",
  "file",
  "package",
  "command",
  "error",
  "decision",
  "tool",
];

/** Relationship categories between entities. */
export type EdgeType =
  | "uses"
  | "failed_with"
  | "fixed_by"
  | "supersedes"
  | "touches"
  | "belongs_to";

export const EDGE_TYPES: readonly EdgeType[] = [
  "uses",
  "failed_with",
  "fixed_by",
  "supersedes",
  "touches",
  "belongs_to",
];

export interface GraphEntity {
  id: number;
  type: EntityType;
  name: string;
  /** Lowercased, whitespace-collapsed key used for dedupe. */
  normalizedName: string;
}

export interface GraphEdge {
  id: number;
  srcEntityId: number;
  edgeType: EdgeType;
  dstEntityId: number;
  /** Unix SECONDS the edge becomes valid, else null. */
  validFrom: number | null;
  /** Unix SECONDS the edge stops being valid, else null (open-ended). */
  validTo: number | null;
  /** Provenance: the source episode's session id + ordinal, when known. */
  sourceSessionId: string | null;
  sourceOrdinal: number | null;
  confidence: number;
}

/** A hydrated edge with both endpoint entities resolved (for display/queries). */
export interface GraphEdgeView {
  edge: GraphEdge;
  src: GraphEntity;
  dst: GraphEntity;
}

export function normalizeName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function initGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      UNIQUE(type, normalized_name)
    );

    CREATE INDEX IF NOT EXISTS idx_graph_entities_norm ON graph_entities(normalized_name);

    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src_entity_id INTEGER NOT NULL,
      edge_type TEXT NOT NULL,
      dst_entity_id INTEGER NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      source_session_id TEXT,
      source_ordinal INTEGER,
      confidence REAL NOT NULL DEFAULT 0,
      UNIQUE(src_entity_id, edge_type, dst_entity_id, source_session_id, source_ordinal),
      FOREIGN KEY(src_entity_id) REFERENCES graph_entities(id) ON DELETE CASCADE,
      FOREIGN KEY(dst_entity_id) REFERENCES graph_entities(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(src_entity_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst_entity_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(edge_type);
  `);
}

interface EntityRow {
  id: number;
  type: string;
  name: string;
  normalized_name: string;
}

interface EdgeRow {
  id: number;
  src_entity_id: number;
  edge_type: string;
  dst_entity_id: number;
  valid_from: number | null;
  valid_to: number | null;
  source_session_id: string | null;
  source_ordinal: number | null;
  confidence: number;
}

function rowToEntity(row: EntityRow): GraphEntity {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    normalizedName: row.normalized_name,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    srcEntityId: row.src_entity_id,
    edgeType: row.edge_type as EdgeType,
    dstEntityId: row.dst_entity_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    sourceSessionId: row.source_session_id,
    sourceOrdinal: row.source_ordinal,
    confidence: row.confidence,
  };
}

/** Insert or fetch an entity by (type, normalized name). Returns its id. */
export function upsertEntity(db: Database.Database, type: EntityType, name: string): number {
  const normalized = normalizeName(name);
  const existing = db
    .prepare(`SELECT id FROM graph_entities WHERE type = ? AND normalized_name = ?`)
    .get(type, normalized);
  if (existing && typeof existing === "object" && "id" in existing) {
    const idVal = existing.id;
    return typeof idVal === "number" ? idVal : Number(idVal);
  }
  const info = db
    .prepare(`INSERT INTO graph_entities (type, name, normalized_name) VALUES (?, ?, ?)`)
    .run(type, name.trim(), normalized);
  return Number(info.lastInsertRowid);
}

export interface NewEdge {
  srcEntityId: number;
  edgeType: EdgeType;
  dstEntityId: number;
  validFrom?: number | null;
  validTo?: number | null;
  sourceSessionId?: string | null;
  sourceOrdinal?: number | null;
  confidence?: number;
}

/**
 * Insert an edge. Idempotent on (src, type, dst, source) - re-inserting the
 * same provenance-scoped edge updates its validity/confidence in place.
 * Returns the edge id.
 */
export function upsertEdge(db: Database.Database, edge: NewEdge): number {
  const validFrom = edge.validFrom ?? null;
  const validTo = edge.validTo ?? null;
  const sessionId = edge.sourceSessionId ?? null;
  const ordinal = edge.sourceOrdinal ?? null;
  const confidence = edge.confidence ?? 0.5;
  const info = db
    .prepare(
      `INSERT INTO graph_edges
        (src_entity_id, edge_type, dst_entity_id, valid_from, valid_to, source_session_id, source_ordinal, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src_entity_id, edge_type, dst_entity_id, source_session_id, source_ordinal)
       DO UPDATE SET valid_from = excluded.valid_from, valid_to = excluded.valid_to, confidence = excluded.confidence`,
    )
    .run(edge.srcEntityId, edge.edgeType, edge.dstEntityId, validFrom, validTo, sessionId, ordinal, confidence);
  if (info.lastInsertRowid && Number(info.lastInsertRowid) > 0 && info.changes > 0) {
    const fetched = db
      .prepare(
        `SELECT id FROM graph_edges
         WHERE src_entity_id = ? AND edge_type = ? AND dst_entity_id = ?
           AND source_session_id IS ? AND source_ordinal IS ?`,
      )
      .get(edge.srcEntityId, edge.edgeType, edge.dstEntityId, sessionId, ordinal);
    if (fetched && typeof fetched === "object" && "id" in fetched) {
      return Number(fetched.id);
    }
  }
  return Number(info.lastInsertRowid);
}

/** Close an open edge by setting its validTo (used for supersession). */
export function closeEdge(db: Database.Database, edgeId: number, validTo: number): boolean {
  const info = db
    .prepare(`UPDATE graph_edges SET valid_to = ? WHERE id = ? AND valid_to IS NULL`)
    .run(validTo, edgeId);
  return info.changes > 0;
}

export function getEntity(db: Database.Database, id: number): GraphEntity | null {
  const row = db.prepare(`SELECT * FROM graph_entities WHERE id = ?`).get(id);
  if (!row) return null;
  const entityRow = row as EntityRow;
  return rowToEntity(entityRow);
}

export interface FindEdgesOptions {
  srcEntityId?: number;
  dstEntityId?: number;
  edgeType?: EdgeType;
  /** When true, only edges still open (valid_to IS NULL). */
  openOnly?: boolean;
  limit?: number;
}

/** Find edges matching the filter, hydrated with endpoint entities. */
export function findEdges(db: Database.Database, opts: FindEdgesOptions = {}): GraphEdgeView[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.srcEntityId !== undefined) {
    where.push("src_entity_id = ?");
    params.push(opts.srcEntityId);
  }
  if (opts.dstEntityId !== undefined) {
    where.push("dst_entity_id = ?");
    params.push(opts.dstEntityId);
  }
  if (opts.edgeType !== undefined) {
    where.push("edge_type = ?");
    params.push(opts.edgeType);
  }
  if (opts.openOnly) {
    where.push("valid_to IS NULL");
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  const rows = db
    .prepare(`SELECT * FROM graph_edges ${clause} ORDER BY id LIMIT ?`)
    .all(...params, limit);
  const views: GraphEdgeView[] = [];
  for (const raw of rows) {
    const edge = rowToEdge(raw as EdgeRow);
    const src = getEntity(db, edge.srcEntityId);
    const dst = getEntity(db, edge.dstEntityId);
    if (src && dst) views.push({ edge, src, dst });
  }
  return views;
}

export interface GraphStats {
  entities: number;
  edges: number;
  openEdges: number;
}

export function getGraphStats(db: Database.Database): GraphStats {
  const e = db.prepare(`SELECT COUNT(*) AS n FROM graph_entities`).get();
  const ed = db.prepare(`SELECT COUNT(*) AS n FROM graph_edges`).get();
  const oe = db.prepare(`SELECT COUNT(*) AS n FROM graph_edges WHERE valid_to IS NULL`).get();
  const count = (row: unknown): number =>
    row && typeof row === "object" && "n" in row ? Number(row.n) : 0;
  return { entities: count(e), edges: count(ed), openEdges: count(oe) };
}
