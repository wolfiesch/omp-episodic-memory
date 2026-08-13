import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import {
  createExchangeSchema,
  openReadOnlyDb,
  prepareExchange,
} from "./db.js";
import { parseToolEvents } from "./tool-events.js";
import type { Exchange } from "./types.js";

interface LegacyExchangeRow {
  id: number;
  session_id: string;
  source_path: string;
  title: string | null;
  cwd: string | null;
  ordinal: number;
  timestamp: number;
  user_text: string;
  assistant_text: string | null;
  tool_names: string | null;
  tool_events?: string | Buffer | null;
}

interface FileFingerprint {
  exists: boolean;
  size: string | null;
  mtimeNs: string | null;
}

interface SourceFingerprint {
  sourcePath: string;
  database: FileFingerprint;
  wal: FileFingerprint;
}

export interface BuildMigrationOptions {
  sourcePath: string;
  outputPath: string;
  onProgress?: (completed: number, total: number) => void;
}

export interface MigrationValidation {
  exchanges: number;
  sessions: number;
  ftsRows: number;
  vectorRows: number;
  integrityCheck: string;
}

export interface BuildMigrationReport extends MigrationValidation {
  sourceBytes: number;
  outputBytes: number;
}

export interface ActivateMigrationOptions {
  sourcePath: string;
  candidatePath: string;
  keepBackup?: boolean;
}

export interface ActivateMigrationReport {
  backupPath: string | null;
  exchanges: number;
}

function parseToolNames(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("Legacy exchange has invalid tool_names JSON");
  }
  return parsed;
}

function parseLegacyToolEvents(raw: string | Buffer | null | undefined) {
  if (raw === null || raw === undefined) return [];
  const text = Buffer.isBuffer(raw) ? inflateSync(raw).toString("utf8") : raw;
  const events = parseToolEvents(raw);
  if (events.length === 0 && text.trim() !== "" && text.trim() !== "[]") {
    throw new Error("Legacy exchange has invalid tool_events JSON");
  }
  return events;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
}

function fileFingerprint(path: string): FileFingerprint {
  if (!existsSync(path)) {
    return { exists: false, size: null, mtimeNs: null };
  }
  const stat = statSync(path, { bigint: true });
  return {
    exists: true,
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function sourceFingerprint(sourcePath: string): SourceFingerprint {
  return {
    sourcePath: resolve(sourcePath),
    database: fileFingerprint(sourcePath),
    wal: fileFingerprint(`${sourcePath}-wal`),
  };
}

function readExpectedSourceFingerprint(candidatePath: string): SourceFingerprint {
  const candidate = new Database(candidatePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const raw = candidate
      .prepare(
        `SELECT value FROM omp_migration_metadata WHERE key = 'source_fingerprint'`,
      )
      .pluck()
      .get() as string | undefined;
    if (raw === undefined) {
      throw new Error("source fingerprint is missing");
    }
    return JSON.parse(raw) as SourceFingerprint;
  } catch (error) {
    throw new Error(
      `Invalid migration candidate metadata: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    candidate.close();
  }
}

function fingerprintsMatch(
  expected: SourceFingerprint,
  actual: SourceFingerprint,
): boolean {
  return (
    expected.sourcePath === actual.sourcePath &&
    expected.database.exists === actual.database.exists &&
    expected.database.size === actual.database.size &&
    expected.database.mtimeNs === actual.database.mtimeNs &&
    expected.wal.exists === actual.wal.exists &&
    expected.wal.size === actual.wal.size &&
    expected.wal.mtimeNs === actual.wal.mtimeNs
  );
}

export function validateCompactedDatabase(path: string): MigrationValidation {
  let db: Database.Database;
  try {
    db = openReadOnlyDb(path);
  } catch (error) {
    throw new Error(
      `Invalid migration candidate: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    const integrityRows = db.pragma("integrity_check") as Array<{
      integrity_check: string;
    }>;
    const integrityCheck = integrityRows.map((row) => row.integrity_check).join("; ");
    if (integrityCheck !== "ok") {
      throw new Error(`Invalid migration candidate: integrity_check returned ${integrityCheck}`);
    }

    const stats = db.prepare(
      `SELECT COUNT(*) AS exchanges, COUNT(DISTINCT session_id) AS sessions FROM exchanges`,
    ).get() as { exchanges: number; sessions: number };
    const ftsRows = db.prepare(`SELECT COUNT(*) FROM exchanges_fts`).pluck().get() as number;
    const vectorRows = db.prepare(`SELECT COUNT(*) FROM exchanges_vec`).pluck().get() as number;
    if (ftsRows !== stats.exchanges || vectorRows !== stats.exchanges) {
      throw new Error(
        `Invalid migration candidate: exchanges=${stats.exchanges}, FTS=${ftsRows}, vectors=${vectorRows}`,
      );
    }
    return { ...stats, ftsRows, vectorRows, integrityCheck };
  } finally {
    db.close();
  }
}

export async function buildCompactedDatabase(
  options: BuildMigrationOptions,
): Promise<BuildMigrationReport> {
  const { sourcePath, outputPath, onProgress } = options;
  if (!existsSync(sourcePath)) {
    throw new Error(`Source index DB not found: ${sourcePath}`);
  }
  if (sourcePath === outputPath) {
    throw new Error("Migration output must differ from the source database");
  }
  if (existsSync(outputPath)) {
    throw new Error(`Migration output already exists: ${outputPath}`);
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const stagingPath = `${outputPath}.staging-${randomUUID()}`;
  let source: Database.Database | undefined;
  let staging: Database.Database | undefined;
  try {
    source = new Database(sourcePath, { fileMustExist: true });
    sqliteVec.load(source);
    const sourceStats = source.prepare(`SELECT COUNT(*) AS exchanges FROM exchanges`).get() as {
      exchanges: number;
    };
    await source.backup(stagingPath);
    source.close();
    source = undefined;
    const expectedSourceFingerprint = sourceFingerprint(sourcePath);

    staging = new Database(stagingPath, { fileMustExist: true });
    sqliteVec.load(staging);
    // The staging clone is disposable. Disabling its rollback journal avoids
    // copying several GiB of legacy payload pages a second time during rebuild.
    staging.pragma("journal_mode = OFF");
    staging.pragma("synchronous = OFF");
    staging.exec(`
      ALTER TABLE exchanges RENAME TO exchanges_legacy;
      DROP INDEX IF EXISTS idx_exchanges_timestamp;
      DROP TABLE exchanges_fts;
    `);
    createExchangeSchema(staging);

    const insertExchange = staging.prepare(`
      INSERT INTO exchanges
        (id, session_id, source_path, title, cwd, ordinal, timestamp, user_text,
         assistant_text, tool_names, tool_events, tool_metadata, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = staging.prepare(`
      INSERT INTO exchanges_fts
        (rowid, user_text, assistant_text, tool_names, tool_event_text)
      VALUES (?, ?, ?, ?, ?)
    `);
    const selectNextLegacyExchange = staging.prepare(
      `SELECT * FROM exchanges_legacy WHERE id > ? ORDER BY id LIMIT 1`,
    );
    let completed = 0;
    let lastId = -1;
    while (true) {
      const row = selectNextLegacyExchange.get(lastId) as
        | LegacyExchangeRow
        | undefined;
      if (row === undefined) break;
      lastId = row.id;
      const exchange: Exchange = {
        sessionId: row.session_id,
        sourcePath: row.source_path,
        title: row.title,
        cwd: row.cwd,
        ordinal: row.ordinal,
        timestamp: row.timestamp,
        userText: row.user_text,
        assistantText: row.assistant_text ?? "",
        toolNames: parseToolNames(row.tool_names),
        toolEvents: parseLegacyToolEvents(row.tool_events),
      };
      const prepared = prepareExchange(exchange);
      insertExchange.run(
        row.id,
        exchange.sessionId,
        exchange.sourcePath,
        exchange.title,
        exchange.cwd,
        exchange.ordinal,
        exchange.timestamp,
        exchange.userText,
        exchange.assistantText,
        prepared.toolNamesJson,
        prepared.toolEventsCompressed,
        prepared.toolMetadataJson,
        prepared.contentHash,
      );
      insertFts.run(
        row.id,
        exchange.userText,
        exchange.assistantText,
        prepared.toolNamesJson,
        prepared.toolEventText,
      );
      completed++;
      if (completed % 1000 === 0 || completed === sourceStats.exchanges) {
        onProgress?.(completed, sourceStats.exchanges);
      }
    }
    if (completed !== sourceStats.exchanges) {
      throw new Error(
        `Migration row count changed while rebuilding: expected ${sourceStats.exchanges}, got ${completed}`,
      );
    }

    staging.exec(`DROP TABLE exchanges_legacy`);
    const rebuiltCount = staging
      .prepare(`SELECT COUNT(*) FROM exchanges`)
      .pluck()
      .get() as number;
    if (rebuiltCount !== sourceStats.exchanges) {
      throw new Error(
        `Migration row count mismatch: expected ${sourceStats.exchanges}, got ${rebuiltCount}`,
      );
    }
    staging.exec(`
      CREATE TABLE IF NOT EXISTS omp_migration_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    staging.prepare(
      `INSERT INTO omp_migration_metadata (key, value) VALUES ('source_fingerprint', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify(expectedSourceFingerprint));

    staging.exec(`VACUUM INTO ${quoteSqlString(outputPath)}`);
    staging.close();
    staging = undefined;

    const validation = validateCompactedDatabase(outputPath);
    return {
      ...validation,
      sourceBytes: statSync(sourcePath).size,
      outputBytes: statSync(outputPath).size,
    };
  } catch (error) {
    removeDatabaseFiles(outputPath);
    throw error;
  } finally {
    if (source?.open) source.close();
    if (staging?.open) staging.close();
    removeDatabaseFiles(stagingPath);
  }
}

export function activateCompactedDatabase(
  options: ActivateMigrationOptions,
): ActivateMigrationReport {
  const { sourcePath, candidatePath, keepBackup = false } = options;
  if (sourcePath === candidatePath) {
    throw new Error("Migration candidate must differ from the active database");
  }
  const candidate = validateCompactedDatabase(candidatePath);
  const expectedSourceFingerprint =
    readExpectedSourceFingerprint(candidatePath);
  const currentSourceFingerprint = sourceFingerprint(sourcePath);
  if (
    !fingerprintsMatch(
      expectedSourceFingerprint,
      currentSourceFingerprint,
    )
  ) {
    throw new Error(
      "Source database changed after the migration candidate was built; rebuild the candidate before activation",
    );
  }

  const source = new Database(sourcePath, { fileMustExist: true });
  sqliteVec.load(source);
  const sourceExchanges = source
    .prepare(`SELECT COUNT(*) FROM exchanges`)
    .pluck()
    .get() as number;
  if (sourceExchanges !== candidate.exchanges) {
    source.close();
    throw new Error(
      `Migration candidate exchange count differs from source: ${candidate.exchanges} != ${sourceExchanges}`,
    );
  }
  const checkpoint = source.pragma("wal_checkpoint(TRUNCATE)") as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  source.close();
  if (checkpoint.some((row) => row.busy !== 0)) {
    throw new Error("Active database is busy; stop the indexing daemon before activation");
  }
  rmSync(`${sourcePath}-wal`, { force: true });
  rmSync(`${sourcePath}-shm`, { force: true });

  const backupPath = `${sourcePath}.pre-v2-${Date.now()}.bak`;
  renameSync(sourcePath, backupPath);
  try {
    renameSync(candidatePath, sourcePath);
    validateCompactedDatabase(sourcePath);
  } catch (error) {
    removeDatabaseFiles(sourcePath);
    renameSync(backupPath, sourcePath);
    throw new Error(
      `Migration activation failed and the original database was restored: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!keepBackup) {
    removeDatabaseFiles(backupPath);
  }
  return {
    backupPath: keepBackup ? backupPath : null,
    exchanges: candidate.exchanges,
  };
}
