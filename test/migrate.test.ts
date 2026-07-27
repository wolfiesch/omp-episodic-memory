import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { openReadOnlyDb } from "../src/db.js";
import {
  activateCompactedDatabase,
  buildCompactedDatabase,
} from "../src/migrate.js";
import { parseToolEvents } from "../src/tool-events.js";
import { EMBEDDING_DIM } from "../src/types.js";

const cleanupPaths = new Set<string>();

function tempDb(label: string): string {
  const path = join(tmpdir(), `${label}-${randomUUID()}.db`);
  cleanupPaths.add(path);
  return path;
}

function removeDatabase(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
}

afterEach(() => {
  for (const path of cleanupPaths) removeDatabase(path);
  cleanupPaths.clear();
});

function createLegacyDatabase(path: string): void {
  const db = new Database(path);
  sqliteVec.load(db);
  try {
    db.exec(`
      CREATE TABLE exchanges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        ordinal INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        assistant_text TEXT,
        tool_names TEXT,
        tool_events TEXT,
        tool_event_text TEXT,
        UNIQUE(session_id, ordinal)
      );
      CREATE INDEX idx_exchanges_timestamp ON exchanges(timestamp);
      CREATE VIRTUAL TABLE exchanges_fts USING fts5(
        user_text,
        assistant_text,
        tool_names,
        tool_event_text,
        content='exchanges',
        content_rowid='id'
      );
      CREATE VIRTUAL TABLE exchanges_vec USING vec0(
        embedding float[${EMBEDDING_DIM}]
      );
      CREATE TABLE preserved_notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      INSERT INTO preserved_notes VALUES (1, 'keep this reviewed memory');
      PRAGMA user_version = 1;
    `);

    const toolEvents = JSON.stringify([
      {
        callId: "call-1",
        toolName: "bash",
        arguments: { command: "npm rebuild sqlite-vec" },
        resultText: "MIGRATION_TOOL_SENTINEL",
        isError: false,
        details: { exitCode: 0 },
        exitCode: 0,
        filePaths: [],
        command: "npm rebuild sqlite-vec",
      },
    ]);
    const insert = db.prepare(`
      INSERT INTO exchanges
        (id, session_id, source_path, title, cwd, ordinal, timestamp,
         user_text, assistant_text, tool_names, tool_events, tool_event_text)
      VALUES (1, 'legacy-session', '/tmp/legacy.jsonl', 'Legacy session', '/tmp', 0,
              1780000000, 'Why did migration work?', 'Because the rebuild completed.',
              '["bash"]', ?, 'npm rebuild sqlite-vec MIGRATION_TOOL_SENTINEL')
    `);
    insert.run(toolEvents);
    db.prepare(`
      INSERT INTO exchanges_fts
        (rowid, user_text, assistant_text, tool_names, tool_event_text)
      SELECT id, user_text, assistant_text, tool_names, tool_event_text FROM exchanges
    `).run();
    const embedding = new Float32Array(EMBEDDING_DIM).fill(
      1 / Math.sqrt(EMBEDDING_DIM),
    );
    db.prepare(`INSERT INTO exchanges_vec (rowid, embedding) VALUES (?, ?)`).run(
      1n,
      new Uint8Array(embedding.buffer),
    );
  } finally {
    db.close();
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("buildCompactedDatabase preserves rows while replacing duplicate payload storage", async () => {
  const sourcePath = tempDb("omp-migrate-source");
  const outputPath = tempDb("omp-migrate-output");
  createLegacyDatabase(sourcePath);

  const report = await buildCompactedDatabase({ sourcePath, outputPath });

  assert.equal(report.exchanges, 1);
  assert.equal(report.integrityCheck, "ok");
  const migrated = openReadOnlyDb(outputPath);
  try {
    const columns = migrated
      .prepare(`PRAGMA table_info(exchanges)`)
      .all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    assert.ok(names.includes("tool_metadata"));
    assert.ok(names.includes("content_hash"));
    assert.equal(names.includes("tool_event_text"), false);

    const row = migrated.prepare(`SELECT tool_events FROM exchanges WHERE id = 1`).get() as {
      tool_events: Buffer;
    };
    assert.equal(parseToolEvents(row.tool_events)[0]?.resultText, "MIGRATION_TOOL_SENTINEL");
    assert.equal(
      migrated
        .prepare(`SELECT COUNT(*) FROM exchanges_fts WHERE exchanges_fts MATCH ?`)
        .pluck()
        .get(`"MIGRATION_TOOL_SENTINEL"`),
      1,
    );
    assert.equal(
      migrated.prepare(`SELECT body FROM preserved_notes WHERE id = 1`).pluck().get(),
      "keep this reviewed memory",
    );
    assert.equal(migrated.prepare(`SELECT COUNT(*) FROM exchanges_vec`).pluck().get(), 1);
  } finally {
    migrated.close();
  }

  const legacy = new Database(sourcePath, { readonly: true });
  try {
    const legacyColumns = legacy
      .prepare(`PRAGMA table_info(exchanges)`)
      .all() as Array<{ name: string }>;
    assert.ok(legacyColumns.some((column) => column.name === "tool_event_text"));
  } finally {
    legacy.close();
  }
});

test("activateCompactedDatabase keeps a restorable backup when requested", async () => {
  const sourcePath = tempDb("omp-activate-source");
  const candidatePath = tempDb("omp-activate-candidate");
  createLegacyDatabase(sourcePath);
  await buildCompactedDatabase({ sourcePath, outputPath: candidatePath });

  const report = activateCompactedDatabase({
    sourcePath,
    candidatePath,
    keepBackup: true,
  });
  assert.ok(report.backupPath);
  cleanupPaths.add(report.backupPath!);

  const active = openReadOnlyDb(sourcePath);
  try {
    assert.equal(active.prepare(`SELECT COUNT(*) FROM exchanges`).pluck().get(), 1);
  } finally {
    active.close();
  }
  const backup = new Database(report.backupPath!, { readonly: true });
  try {
    const columns = backup
      .prepare(`PRAGMA table_info(exchanges)`)
      .all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "tool_event_text"));
  } finally {
    backup.close();
  }
});

test("activateCompactedDatabase rejects an invalid candidate without touching the source", () => {
  const sourcePath = tempDb("omp-activate-unchanged");
  const candidatePath = tempDb("omp-activate-invalid");
  createLegacyDatabase(sourcePath);
  writeFileSync(candidatePath, "not a sqlite database");
  const before = sha256(sourcePath);

  assert.throws(
    () => activateCompactedDatabase({ sourcePath, candidatePath }),
    /candidate/i,
  );
  assert.equal(sha256(sourcePath), before);
});

test("activateCompactedDatabase rejects a candidate after the source changes", async () => {
  const sourcePath = tempDb("omp-activate-stale-source");
  const candidatePath = tempDb("omp-activate-stale-candidate");
  createLegacyDatabase(sourcePath);
  await buildCompactedDatabase({ sourcePath, outputPath: candidatePath });

  const source = new Database(sourcePath);
  try {
    source.prepare(`UPDATE exchanges SET title = ? WHERE id = 1`).run(
      "Changed after migration build",
    );
  } finally {
    source.close();
  }

  assert.throws(
    () => activateCompactedDatabase({ sourcePath, candidatePath }),
    /source database changed/i,
  );
  const unchanged = new Database(sourcePath, { readonly: true });
  try {
    assert.equal(
      unchanged.prepare(`SELECT title FROM exchanges WHERE id = 1`).pluck().get(),
      "Changed after migration build",
    );
  } finally {
    unchanged.close();
  }
});

test("CLI migrate build and activate complete the explicit two-step cutover", () => {
  const sourcePath = tempDb("omp-cli-migrate-source");
  const candidatePath = tempDb("omp-cli-migrate-candidate");
  createLegacyDatabase(sourcePath);

  const build = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "migrate",
      "build",
      "--db",
      sourcePath,
      "--output",
      candidatePath,
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const buildReport = JSON.parse(build.stdout) as { exchanges: number };
  assert.equal(buildReport.exchanges, 1);

  const activate = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "migrate",
      "activate",
      "--db",
      sourcePath,
      "--candidate",
      candidatePath,
      "--json",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(activate.status, 0, activate.stderr);
  const active = openReadOnlyDb(sourcePath);
  active.close();
});
