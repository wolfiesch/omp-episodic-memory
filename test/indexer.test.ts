import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { insertExchange, openDb, type InsertableExchange } from "../src/db.js";
import {
  ensureIndexStateTable,
  findSessionFiles,
  indexAll,
  matchesIgnore,
  pruneSourceExchanges,
  reconcileDeletedSources,
  shouldIndexFile,
} from "../src/indexer.js";
import { parseSessionFile } from "../src/parser.js";
import { EMBEDDING_DIM } from "../src/types.js";

const SESSIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sessions",
);

interface IndexedFileRow {
  mtime_ms: number;
  indexed_at: number;
  outcome: "indexed" | "oversize" | "failed" | null;
  size_bytes: number | null;
  attempted_cap_bytes: number | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
}

function fixtureExchange(
  sourcePath: string,
  sessionId: string,
  ordinal: number,
  userText?: string,
): InsertableExchange {
  const base = parseSessionFile(findSessionFiles(SESSIONS_DIR)[0]!)[0]!;
  return {
    ...base,
    sourcePath,
    sessionId,
    ordinal,
    userText: userText ?? base.userText,
    embedding: new Float32Array(EMBEDDING_DIM).fill(1 / Math.sqrt(EMBEDDING_DIM)),
  };
}

async function captureStderr<T>(
  action: () => Promise<T>,
): Promise<{ result: T; output: string }> {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await action(), output };
  } finally {
    process.stderr.write = originalWrite;
  }
}

let dbPath: string;
let db: Database.Database;

before(() => {
  dbPath = join(tmpdir(), `indexer-test-${randomUUID()}.db`);
  db = openDb(dbPath);
});

after(() => {
  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test("shouldIndexFile returns true when no stored mtime", () => {
  assert.equal(shouldIndexFile(undefined, 123), true);
});

test("shouldIndexFile returns false when mtimes are equal", () => {
  assert.equal(shouldIndexFile(123, 123), false);
});

test("shouldIndexFile returns true when mtimes differ", () => {
  assert.equal(shouldIndexFile(100, 200), true);
});

test("shouldIndexFile returns true with force regardless of mtime", () => {
  assert.equal(shouldIndexFile(123, 123, true), true);
});

test("ensureIndexStateTable creates the indexed_files table", () => {
  ensureIndexStateTable(db);
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='indexed_files'`,
    )
    .get() as { name: string } | undefined;
  assert.ok(row);
  assert.equal(row?.name, "indexed_files");
});

test("ensureIndexStateTable migrates legacy rows in place", () => {
  const legacyDbPath = join(tmpdir(), `indexer-legacy-schema-${randomUUID()}.db`);
  const legacyDb = openDb(legacyDbPath);
  const path = join(SESSIONS_DIR, "legacy.jsonl");
  try {
    legacyDb.exec(
      `CREATE TABLE indexed_files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      )`,
    );
    legacyDb.prepare(
      `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?, ?, ?)`,
    ).run(path, 4242, 1234);

    ensureIndexStateTable(legacyDb);

    const columnRows = legacyDb
      .prepare(`PRAGMA table_info(indexed_files)`)
      .all() as Array<{ name: string }>;
    const columns = columnRows.map(({ name }) => name);
    assert.deepEqual(columns, [
      "path",
      "mtime_ms",
      "indexed_at",
      "outcome",
      "size_bytes",
      "attempted_cap_bytes",
      "last_attempt_at",
      "last_success_at",
    ]);
    assert.deepEqual(
      legacyDb.prepare(`SELECT * FROM indexed_files WHERE path = ?`).get(path),
      {
        path,
        mtime_ms: 4242,
        indexed_at: 1234,
        outcome: null,
        size_bytes: null,
        attempted_cap_bytes: null,
        last_attempt_at: null,
        last_success_at: null,
      },
    );
  } finally {
    legacyDb.close();
    rmSync(legacyDbPath, { force: true });
    rmSync(`${legacyDbPath}-wal`, { force: true });
    rmSync(`${legacyDbPath}-shm`, { force: true });
  }
});

test("indexed_files upsert + lookup returns the stored mtime", () => {
  ensureIndexStateTable(db);
  const path = join(SESSIONS_DIR, "example.jsonl");
  db.prepare(
    `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?,?,?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at`,
  ).run(path, 4242, Date.now());

  const stored = db
    .prepare(`SELECT mtime_ms FROM indexed_files WHERE path = ?`)
    .get(path) as IndexedFileRow | undefined;
  assert.equal(stored?.mtime_ms, 4242);

  // Upsert updates in place.
  db.prepare(
    `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?,?,?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, indexed_at=excluded.indexed_at`,
  ).run(path, 9999, Date.now());

  const updated = db
    .prepare(`SELECT mtime_ms FROM indexed_files WHERE path = ?`)
    .get(path) as IndexedFileRow | undefined;
  assert.equal(updated?.mtime_ms, 9999);
});

test(".omp-episodic-ignore excludes matching session files", () => {
  const root = join(tmpdir(), `indexer-ignore-${randomUUID()}`);
  mkdirSync(root);
  try {
    writeFileSync(join(root, ".omp-episodic-ignore"), "secret-*.jsonl\n# comment\n\n");
    writeFileSync(join(root, "secret-x.jsonl"), "{}\n");
    writeFileSync(join(root, "public.jsonl"), "{}\n");

    const files = findSessionFiles(root).map((file) => file.split("/").pop());
    assert.deepEqual(files, ["public.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchesIgnore: literal and single-star match within a segment only", () => {
  assert.equal(matchesIgnore("secret-x.jsonl", ["secret-*.jsonl"]), true);
  assert.equal(matchesIgnore("dir/secret-x.jsonl", ["secret-*.jsonl"]), false, "* does not cross a slash");
  assert.equal(matchesIgnore("public.jsonl", ["secret-*.jsonl"]), false);
});

test("matchesIgnore: ** crosses slashes and matches at the root", () => {
  assert.equal(matchesIgnore("a/b/secret.jsonl", ["**/secret.jsonl"]), true);
  // A leading **/ must also match the file at the root (zero intermediate dirs).
  assert.equal(matchesIgnore("secret.jsonl", ["**/secret.jsonl"]), true, "**/ matches root-level file");
  assert.equal(matchesIgnore("a/b/c.jsonl", ["a/**/c.jsonl"]), true);
  // A middle **/ must also match zero intermediate directories.
  assert.equal(matchesIgnore("a/c.jsonl", ["a/**/c.jsonl"]), true, "a/**/c matches a/c (zero dirs)");
  assert.equal(matchesIgnore("x/c.jsonl", ["a/**/c.jsonl"]), false, "prefix still anchored");
});

test("matchesIgnore: a leading ./ in the pattern is normalized away", () => {
  assert.equal(matchesIgnore("secret.jsonl", ["./secret.jsonl"]), true);
  assert.equal(matchesIgnore("sub/secret.jsonl", ["./sub/secret.jsonl"]), true);
});

test("matchesIgnore: a trailing-slash pattern excludes the directory's children", () => {
  assert.equal(matchesIgnore("secret/a.jsonl", ["secret/"]), true, "dir pattern matches children");
  assert.equal(matchesIgnore("secret/nested/a.jsonl", ["secret/"]), true, "dir pattern matches deep children");
  assert.equal(matchesIgnore("not-secret/a.jsonl", ["secret/"]), false);
  assert.equal(matchesIgnore("secret", ["secret/"]), false, "dir pattern does not match a same-named file");
});

test("matchesIgnore: special regex characters in patterns are matched literally", () => {
  assert.equal(matchesIgnore("a.b+c.jsonl", ["a.b+c.jsonl"]), true);
  assert.equal(matchesIgnore("axbxc.jsonl", ["a.b+c.jsonl"]), false, "dot/plus are literal, not regex");
});

test("findSessionFiles: trailing-slash dir pattern excludes a nested session file", () => {
  const root = join(tmpdir(), `indexer-ignore-dir-${randomUUID()}`);
  mkdirSync(join(root, "secret"), { recursive: true });
  try {
    writeFileSync(join(root, ".omp-episodic-ignore"), "secret/\n");
    writeFileSync(join(root, "secret", "a.jsonl"), "{}\n");
    writeFileSync(join(root, "public.jsonl"), "{}\n");

    const files = findSessionFiles(root).map((file) => file.split("/").pop());
    assert.deepEqual(files, ["public.jsonl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileDeletedSources removes only indexed source files that disappeared", () => {
  const root = join(tmpdir(), `indexer-reconcile-${randomUUID()}`);
  const livePath = join(root, "live.jsonl");
  const deletedPath = join(root, "deleted.jsonl");
  mkdirSync(root, { recursive: true });
  writeFileSync(livePath, "{}\n");
  try {
    ensureIndexStateTable(db);
    insertExchange(db, fixtureExchange(livePath, `live-${randomUUID()}`, 0));
    insertExchange(db, fixtureExchange(deletedPath, `deleted-${randomUUID()}`, 0));
    const upsert = db.prepare(
      `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?, ?, ?)`,
    );
    upsert.run(livePath, 1, Date.now());
    upsert.run(deletedPath, 1, Date.now());

    assert.equal(reconcileDeletedSources(db, root), 1);
    assert.equal(
      db.prepare(`SELECT COUNT(*) FROM exchanges WHERE source_path = ?`).pluck().get(deletedPath),
      0,
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) FROM exchanges WHERE source_path = ?`).pluck().get(livePath),
      1,
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) FROM indexed_files WHERE path = ?`).pluck().get(deletedPath),
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pruneSourceExchanges removes stale ordinals from every index table", () => {
  const sourcePath = join(tmpdir(), `indexer-stale-${randomUUID()}.jsonl`);
  const sessionId = `stale-${randomUUID()}`;
  insertExchange(db, fixtureExchange(sourcePath, sessionId, 0));
  insertExchange(
    db,
    fixtureExchange(sourcePath, sessionId, 1, "STALE_ORDINAL_SENTINEL"),
  );

  assert.equal(
    pruneSourceExchanges(db, sourcePath, [{ sessionId, ordinal: 0 }]),
    1,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) FROM exchanges WHERE source_path = ?`).pluck().get(sourcePath),
    1,
  );
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) FROM exchanges_fts WHERE exchanges_fts MATCH ?`,
    ).pluck().get(`"STALE_ORDINAL_SENTINEL"`),
    0,
  );
  assert.equal(
    db.prepare(
      `SELECT COUNT(*) FROM exchanges_vec WHERE rowid NOT IN (SELECT id FROM exchanges)`,
    ).pluck().get(),
    0,
  );
});

test("indexAll persists oversize once without repeating the attempt or log", async () => {
  const sessionsDir = join(tmpdir(), `indexer-oversize-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000ffff.jsonl",
  );
  writeFileSync(sessionFile, `${"x".repeat(4096)}\n`);

  try {
    const first = await captureStderr(() =>
      indexAll({ dbPath, sessionsDir, maxBytes: 1024 })
    );
    assert.equal(first.result.filesSkippedOversize, 1);
    assert.match(first.output, /Skipping file .* as it is too large/);

    const oversizeDb = openDb(dbPath);
    let firstState: IndexedFileRow;
    try {
      firstState = oversizeDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.equal(firstState.outcome, "oversize");
      assert.equal(firstState.size_bytes, 4097);
      assert.equal(firstState.attempted_cap_bytes, 1024);
      assert.equal(firstState.last_success_at, null);
    } finally {
      oversizeDb.close();
    }

    const second = await captureStderr(() =>
      indexAll({ dbPath, sessionsDir, maxBytes: 1024 })
    );
    assert.equal(second.result.filesSkippedOversize, 0);
    assert.equal(second.result.filesSkipped, 1);
    assert.doesNotMatch(second.output, /Skipping file .* as it is too large/);

    const unchangedDb = openDb(dbPath);
    try {
      const secondState = unchangedDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.deepEqual(secondState, firstState);
    } finally {
      unchangedDb.close();
    }
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("indexAll retries an unchanged oversized file when a larger cap covers it", async () => {
  const sessionsDir = join(tmpdir(), `indexer-cap-increase-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000fffe.jsonl",
  );
  writeFileSync(sessionFile, `${"x".repeat(4096)}\n`);

  try {
    const first = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(first.filesSkippedOversize, 1);

    const second = await indexAll({ dbPath, sessionsDir, maxBytes: 8192 });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.filesSkipped, 0);
    assert.equal(second.filesSkippedOversize, 0);

    const stateDb = openDb(dbPath);
    try {
      const state = stateDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.equal(state.outcome, "indexed");
      assert.equal(state.size_bytes, 4097);
      assert.equal(state.attempted_cap_bytes, 8192);
      assert.ok(state.last_success_at !== null);
    } finally {
      stateDb.close();
    }
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("indexAll classifies an unchanged fitting legacy row as indexed without reprocessing", async () => {
  const sessionsDir = join(tmpdir(), `indexer-legacy-success-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000fffd.jsonl",
  );
  writeFileSync(sessionFile, "{}\n");
  const mtimeMs = statSync(sessionFile).mtimeMs;
  const indexedAt = 1234;

  try {
    const legacyDb = openDb(dbPath);
    try {
      ensureIndexStateTable(legacyDb);
      legacyDb.prepare(
        `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?, ?, ?)`,
      ).run(sessionFile, mtimeMs, indexedAt);
    } finally {
      legacyDb.close();
    }

    const result = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(result.filesProcessed, 0);
    assert.equal(result.filesSkipped, 1);

    const stateDb = openDb(dbPath);
    try {
      const state = stateDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.equal(state.outcome, "indexed");
      assert.equal(state.size_bytes, 3);
      assert.equal(state.last_success_at, indexedAt);
    } finally {
      stateDb.close();
    }
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("indexAll records a failed finalization without marking the source successful", async () => {
  const sessionsDir = join(tmpdir(), `indexer-failure-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000fffc.jsonl",
  );
  writeFileSync(sessionFile, "{}\n");

  try {
    const setupDb = openDb(dbPath);
    try {
      ensureIndexStateTable(setupDb);
      insertExchange(
        setupDb,
        fixtureExchange(sessionFile, `failure-${randomUUID()}`, 0),
      );
      setupDb.exec(
        `CREATE TRIGGER reject_source_prune
         BEFORE DELETE ON exchanges
         BEGIN
           SELECT RAISE(ABORT, 'blocked source prune');
         END`,
      );
    } finally {
      setupDb.close();
    }

    await assert.rejects(
      indexAll({ dbPath, sessionsDir, maxBytes: 1024 }),
      /blocked source prune/,
    );

    const failedDb = openDb(dbPath);
    try {
      const state = failedDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow | undefined;
      assert.equal(state?.outcome, "failed");
      assert.equal(state?.size_bytes, 3);
      assert.equal(state?.last_success_at, null);
      assert.equal(
        failedDb
          .prepare(`SELECT COUNT(*) FROM exchanges WHERE source_path = ?`)
          .pluck()
          .get(sessionFile),
        1,
      );
      failedDb.exec(`DROP TRIGGER reject_source_prune`);
    } finally {
      failedDb.close();
    }

    const retry = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(retry.filesProcessed, 1);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("indexAll conservatively classifies a legacy oversized row without pruning exchanges", async () => {
  const sessionsDir = join(tmpdir(), `indexer-legacy-oversize-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000fffb.jsonl",
  );
  writeFileSync(sessionFile, `${"x".repeat(4096)}\n`);
  const mtimeMs = statSync(sessionFile).mtimeMs;

  try {
    const legacyDb = openDb(dbPath);
    try {
      ensureIndexStateTable(legacyDb);
      legacyDb.prepare(
        `INSERT INTO indexed_files (path, mtime_ms, indexed_at) VALUES (?, ?, ?)`,
      ).run(sessionFile, mtimeMs, 1234);
      insertExchange(
        legacyDb,
        fixtureExchange(sessionFile, `preserved-${randomUUID()}`, 0),
      );
    } finally {
      legacyDb.close();
    }

    const result = await captureStderr(() =>
      indexAll({ dbPath, sessionsDir, maxBytes: 1024 })
    );
    assert.equal(result.result.filesSkippedOversize, 1);
    assert.match(result.output, /Skipping file .* as it is too large/);

    const classifiedDb = openDb(dbPath);
    try {
      const state = classifiedDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.equal(state.outcome, "oversize");
      assert.equal(state.size_bytes, 4097);
      assert.equal(state.attempted_cap_bytes, 1024);
      assert.equal(
        classifiedDb
          .prepare(`SELECT COUNT(*) FROM exchanges WHERE source_path = ?`)
          .pluck()
          .get(sessionFile),
        1,
      );
    } finally {
      classifiedDb.close();
    }
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("indexAll retries an oversized source that shrinks without an mtime change", async () => {
  const sessionsDir = join(tmpdir(), `indexer-shrink-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000fffa.jsonl",
  );
  writeFileSync(sessionFile, `${"x".repeat(4096)}\n`);

  try {
    const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
    utimesSync(sessionFile, fixedTime, fixedTime);
    const originalStats = statSync(sessionFile);
    const first = await captureStderr(() =>
      indexAll({ dbPath, sessionsDir, maxBytes: 1024 })
    );
    assert.equal(first.result.filesSkippedOversize, 1);

    writeFileSync(sessionFile, "{}\n");
    utimesSync(sessionFile, originalStats.atime, originalStats.mtime);
    assert.equal(statSync(sessionFile).mtimeMs, originalStats.mtimeMs);

    const second = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(second.filesProcessed, 1);
    assert.equal(second.filesSkipped, 0);

    const stateDb = openDb(dbPath);
    try {
      const state = stateDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.equal(state.outcome, "indexed");
      assert.equal(state.size_bytes, 3);
      assert.ok(state.last_success_at !== null);
    } finally {
      stateDb.close();
    }
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("indexAll force reprocesses fitting files but never bypasses the byte cap", async () => {
  const sessionsDir = join(tmpdir(), `indexer-force-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000fff9.jsonl",
  );
  writeFileSync(sessionFile, "{}\n");

  try {
    const first = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(first.filesProcessed, 1);

    const unchanged = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(unchanged.filesSkipped, 1);

    const forced = await indexAll({
      dbPath,
      sessionsDir,
      maxBytes: 1024,
      force: true,
    });
    assert.equal(forced.filesProcessed, 1);

    writeFileSync(sessionFile, `${"x".repeat(4096)}\n`);
    const forcedOversize = await captureStderr(() =>
      indexAll({ dbPath, sessionsDir, maxBytes: 1024, force: true })
    );
    assert.equal(forcedOversize.result.filesProcessed, 0);
    assert.equal(forcedOversize.result.filesSkippedOversize, 1);
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});

test("indexAll skips an unchanged successful source without advancing state", async () => {
  const sessionsDir = join(tmpdir(), `indexer-success-skip-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
  const dbPath = join(sessionsDir, "index.db");
  const sessionFile = join(
    sessionsDir,
    "2026-06-20T10-00-00-000Z_ffffffff-0000-7000-8000-00000000fff8.jsonl",
  );
  writeFileSync(sessionFile, "{}\n");

  try {
    const first = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(first.filesProcessed, 1);

    const stateDb = openDb(dbPath);
    let firstState: IndexedFileRow;
    try {
      firstState = stateDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.equal(firstState.outcome, "indexed");
    } finally {
      stateDb.close();
    }

    const second = await indexAll({ dbPath, sessionsDir, maxBytes: 1024 });
    assert.equal(second.filesProcessed, 0);
    assert.equal(second.filesSkipped, 1);

    const unchangedDb = openDb(dbPath);
    try {
      const secondState = unchangedDb.prepare(
        `SELECT mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
                last_attempt_at, last_success_at
         FROM indexed_files WHERE path = ?`,
      ).get(sessionFile) as IndexedFileRow;
      assert.deepEqual(secondState, firstState);
    } finally {
      unchangedDb.close();
    }
  } finally {
    rmSync(sessionsDir, { recursive: true, force: true });
  }
});
