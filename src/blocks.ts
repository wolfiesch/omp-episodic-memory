// Pinned memory-block store: always-visible, human-curated project context.
// Blocks are keyed on (kind, project). SQLite treats NULL as DISTINCT in a
// UNIQUE constraint, so a global block stored with project = NULL would never
// dedupe. To keep upserts reliable, global blocks are stored internally with
// project = '' (empty string); null<->'' is normalized at the API boundary
// (setBlock writes '' for null; reads map '' back to null).
import type Database from "better-sqlite3";
import { searchMemoryRecords, type MemoryRecord } from "./memory.js";

export type BlockKind =
  | "project_rules"
  | "workflow_preferences"
  | "known_risks"
  | "positioning";

export const BLOCK_KINDS: readonly BlockKind[] = [
  "project_rules",
  "workflow_preferences",
  "known_risks",
  "positioning",
];

export interface PinnedBlock {
  id: number;
  kind: BlockKind;
  project: string | null;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewBlock {
  kind: BlockKind;
  project?: string | null;
  content: string;
}

export interface ProjectContext {
  project: string | null;
  blocks: PinnedBlock[];
  recentDecisions: MemoryRecord[];
  gotchas: MemoryRecord[];
  runbooks: MemoryRecord[];
}

/** Map a nullable project to its internal storage form ('' for global). */
function toStored(project: string | null | undefined): string {
  return project ?? "";
}

/** Create the pinned-blocks table. Safe to call repeatedly. */
export function initBlocksSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pinned_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(kind, project)
    );

    CREATE INDEX IF NOT EXISTS idx_pinned_blocks_project ON pinned_blocks(project);
  `);
}

interface BlockRow {
  id: number;
  kind: string;
  project: string;
  content: string;
  created_at: number;
  updated_at: number;
}

function hydrate(row: BlockRow): PinnedBlock {
  return {
    id: row.id,
    kind: row.kind as BlockKind,
    project: row.project === "" ? null : row.project,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Idempotent upsert keyed on (kind, project). Updates content in place when a
 * block already exists for the pair, otherwise inserts. Returns the row id.
 */
export function setBlock(db: Database.Database, block: NewBlock): number {
  const now = Date.now();
  const project = toStored(block.project);
  db.prepare(
    `INSERT INTO pinned_blocks (kind, project, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, project) DO UPDATE SET
       content = excluded.content,
       updated_at = excluded.updated_at`,
  ).run(block.kind, project, block.content, now, now);

  const row = db
    .prepare(`SELECT id FROM pinned_blocks WHERE kind = ? AND project = ?`)
    .get(block.kind, project) as { id: number };
  return row.id;
}

export function getBlock(
  db: Database.Database,
  kind: BlockKind,
  project?: string | null,
): PinnedBlock | null {
  const row = db
    .prepare(
      `SELECT id, kind, project, content, created_at, updated_at
       FROM pinned_blocks WHERE kind = ? AND project = ?`,
    )
    .get(kind, toStored(project)) as BlockRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * List blocks. When `project` is given, returns blocks for that project AND
 * global blocks (project IS NULL, stored as ''). When omitted, returns all.
 */
export function listBlocks(
  db: Database.Database,
  project?: string | null,
): PinnedBlock[] {
  let rows: BlockRow[];
  if (project === undefined) {
    rows = db
      .prepare(
        `SELECT id, kind, project, content, created_at, updated_at
         FROM pinned_blocks ORDER BY updated_at DESC`,
      )
      .all() as BlockRow[];
  } else {
    rows = db
      .prepare(
        `SELECT id, kind, project, content, created_at, updated_at
         FROM pinned_blocks WHERE project = ? OR project = ''
         ORDER BY updated_at DESC`,
      )
      .all(toStored(project)) as BlockRow[];
  }
  return rows.map(hydrate);
}

export function deleteBlock(db: Database.Database, id: number): boolean {
  const info = db.prepare(`DELETE FROM pinned_blocks WHERE id = ?`).run(id);
  return info.changes > 0;
}

/**
 * Aggregate always-visible project context: pinned blocks plus the most recent
 * approved decisions, gotchas, and runbooks for the project.
 */
export function getProjectContext(
  db: Database.Database,
  opts: { project?: string; limit?: number } = {},
): ProjectContext {
  const { project, limit = 5 } = opts;
  return {
    project: project ?? null,
    blocks: listBlocks(db, project),
    recentDecisions: searchMemoryRecords(db, {
      type: "decision",
      project,
      status: "approved",
      limit,
    }),
    gotchas: searchMemoryRecords(db, {
      type: "gotcha",
      project,
      status: "approved",
      limit,
    }),
    runbooks: searchMemoryRecords(db, {
      type: "runbook",
      project,
      status: "approved",
      limit,
    }),
  };
}
