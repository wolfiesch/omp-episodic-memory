import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import Database from "better-sqlite3";

import { classifyStorageHeadroom, runDoctor } from "../src/doctor.js";
import type { DoctorCheck, DoctorOptions } from "../src/doctor.js";
import { openDb } from "../src/db.js";
import { ensureIndexStateTable } from "../src/indexer.js";

test("SQLite health accepts a healthy database with a vec0 table", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-vec-health-"));
  const sessionsDir = join(root, "sessions");
  const dbPath = join(root, "index.db");
  mkdirSync(sessionsDir);
  const build = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `import Database from "better-sqlite3";
       import * as sqliteVec from "sqlite-vec";
       const db = new Database(${JSON.stringify(dbPath)});
       sqliteVec.load(db);
       db.exec("CREATE VIRTUAL TABLE vectors USING vec0(v float[4])");
       db.close();`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);

  try {
    const checks = await runDoctorIn(root);
    assert.deepEqual(getCheck(checks, "SQLite health"), {
      name: "SQLite health",
      status: "pass",
      detail: "quick_check: ok",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctor reports every setup check without creating an index", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-"));
  const sessionsDir = join(root, "sessions");
  const dbPath = join(root, "index.db");
  mkdirSync(sessionsDir);
  try {
    const checks = await runDoctorIn(root);
    assert.deepEqual(checks.map((check) => check.name), [
      "sessions directory",
      "storage headroom",
      "index database",
      "SQLite health",
      "sqlite-vec extension",
      "embedding model (cached)",
      "index freshness",
      "source coverage",
      "installed daemon cap",
      "daemon log size",
      "MCP server entry",
    ]);
    assert.equal(checks.find((check) => check.name === "sessions directory")?.status, "pass");
    assert.equal(checks.find((check) => check.name === "index database")?.status, "warn");
    assert.equal(checks.find((check) => check.name === "index freshness")?.status, "warn");
    assert.equal(existsSync(dbPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor CLI emits JSON and exits nonzero on failed checks", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "doctor",
    "--sessions",
    "/nope/omp-episodic-doctor-missing",
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  const checks = JSON.parse(result.stdout) as Array<{ name: string; status: string; detail: string }>;
  assert.equal(checks.find((check) => check.name === "sessions directory")?.status, "fail");
  assert.match(result.stdout, /sessions directory/);
});

function containsMiniLmCache(dir: string, depth = 0): boolean {
  if (depth > 5) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (full.includes("Xenova") && full.includes("all-MiniLM-L6-v2")) return true;
    if (entry.isDirectory() && containsMiniLmCache(full, depth + 1)) return true;
  }
  return false;
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheCandidates = [
  process.env.TRANSFORMERS_CACHE,
  join(packageRoot, "node_modules", "@xenova", "transformers", ".cache"),
  join(homedir(), ".cache", "huggingface"),
].filter((dir): dir is string => typeof dir === "string");
const isCached = cacheCandidates.some((dir) => existsSync(dir) && containsMiniLmCache(dir));

test(
  "runDoctor --probe-model actively loads the embedding model",
  { skip: isCached ? false : "model not cached" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-doctor-probe-"));
    const sessionsDir = join(root, "sessions");
    const dbPath = join(root, "index.db");
    mkdirSync(sessionsDir);
    try {
      const checks = await runDoctor({ dbPath, sessionsDir, probeModel: true });
      const check = checks.find((c) => c.name === "embedding model (cached)");
      assert.ok(check, "embedding model (cached) check exists");
      assert.equal(check.status, "pass", "probe-model loads the model from cache");
      assert.equal(check.detail, "model loaded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

type Outcome = "indexed" | "oversize" | "failed";

function createCurrentDb(dbPath: string, outcomes: readonly Outcome[]): void {
  const db = openDb(dbPath);
  try {
    ensureIndexStateTable(db);
    const insertState = db.prepare(
      `INSERT INTO indexed_files
         (path, mtime_ms, indexed_at, outcome, size_bytes, attempted_cap_bytes,
          last_attempt_at, last_success_at)
       VALUES (?, 1, 1, ?, 1, NULL, 1, ?)`,
    );
    outcomes.forEach((outcome, index) => {
      insertState.run(
        `/sessions/${index}.jsonl`,
        outcome,
        outcome === "indexed" ? 1 : null,
      );
    });
    db.prepare(
      `INSERT INTO exchanges
         (session_id, source_path, title, cwd, ordinal, timestamp, user_text,
          assistant_text, tool_names, tool_events, tool_metadata, content_hash)
       VALUES ('healthy', '/sessions/0.jsonl', NULL, NULL, 0, 1, 'hello',
               'world', '[]', ?, '{}', ?)`,
    ).run(Buffer.from("[]"), Buffer.alloc(32));
  } finally {
    db.close();
  }
}

function getCheck(
  checks: DoctorCheck[],
  name: string,
): DoctorCheck {
  const check = checks.find((candidate) => candidate.name === name);
  assert.ok(check, `${name} check exists`);
  return check;
}

/**
 * Run doctor entirely inside a temp root. Pinning the service and log paths
 * keeps the daemon checks off the developer's real launchd/systemd install.
 */
async function runDoctorIn(
  root: string,
  overrides: Partial<DoctorOptions> = {},
): Promise<DoctorCheck[]> {
  return runDoctor({
    dbPath: join(root, "index.db"),
    sessionsDir: join(root, "sessions"),
    servicePath: join(root, "missing.plist"),
    daemonLogPath: join(root, "missing.log"),
    daemonPlatform: "launchd",
    ...overrides,
  });
}

test("storage headroom classification honors fail and warning boundaries", () => {
  assert.equal(classifyStorageHeadroom(5 * GiB - 1, 100 * GiB), "fail");
  assert.equal(classifyStorageHeadroom(5 * GiB, 100 * GiB), "warn");
  assert.equal(classifyStorageHeadroom(20 * GiB - 1, 100 * GiB), "warn");
  assert.equal(classifyStorageHeadroom(20 * GiB, 100 * GiB), "pass");
  assert.equal(classifyStorageHeadroom(30 * GiB - 1, 300 * GiB), "warn");
  assert.equal(classifyStorageHeadroom(30 * GiB, 300 * GiB), "pass");
  assert.equal(classifyStorageHeadroom(4 * GiB, 4 * GiB), "pass");
  assert.equal(classifyStorageHeadroom(4 * GiB - 1, 4 * GiB), "fail");
  assert.equal(classifyStorageHeadroom(10 * GiB, 10 * GiB), "pass");
  assert.equal(classifyStorageHeadroom(5 * GiB, 10 * GiB), "warn");
});

test("runDoctor reports healthy SQLite, source coverage, daemon cap, and log", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-healthy-"));
  const sessionsDir = join(root, "sessions");
  const dbPath = join(root, "index.db");
  const servicePath = join(root, "daemon.plist");
  const daemonLogPath = join(root, "daemon.log");
  mkdirSync(sessionsDir);
  createCurrentDb(dbPath, ["indexed"]);
  writeFileSync(
    servicePath,
    "<string>--max-bytes</string>\n<string>805306368</string>\n",
  );
  writeFileSync(daemonLogPath, "healthy\n");

  try {
    const checks = await runDoctorIn(root, { servicePath, daemonLogPath });
    assert.equal(getCheck(checks, "SQLite health").status, "pass");
    assert.equal(getCheck(checks, "SQLite health").detail, "quick_check: ok");
    assert.deepEqual(getCheck(checks, "source coverage"), {
      name: "source coverage",
      status: "pass",
      detail: "indexed 1, oversize 0, failed 0",
    });
    assert.equal(getCheck(checks, "installed daemon cap").status, "pass");
    assert.match(getCheck(checks, "installed daemon cap").detail, /768(?:\.0)? MiB/);
    assert.equal(getCheck(checks, "daemon log size").status, "pass");
    assert.match(getCheck(checks, "daemon log size").detail, /8 bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctor warns about deferred and failed source coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-coverage-"));
  const sessionsDir = join(root, "sessions");
  const dbPath = join(root, "index.db");
  mkdirSync(sessionsDir);
  createCurrentDb(dbPath, ["indexed", "oversize", "oversize", "failed"]);

  try {
    const checks = await runDoctorIn(root);
    assert.deepEqual(getCheck(checks, "source coverage"), {
      name: "source coverage",
      status: "warn",
      detail: "indexed 1, oversize 2, failed 1",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctor warns when indexed_files has the legacy schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-legacy-"));
  const sessionsDir = join(root, "sessions");
  const dbPath = join(root, "index.db");
  mkdirSync(sessionsDir);
  const db = new Database(dbPath);
  db.exec(
    `CREATE TABLE indexed_files (
       path TEXT PRIMARY KEY,
       mtime_ms INTEGER NOT NULL,
       indexed_at INTEGER NOT NULL
     )`,
  );
  db.close();

  try {
    const before = readFileSync(dbPath);
    const checks = await runDoctorIn(root);
    assert.equal(getCheck(checks, "SQLite health").status, "pass");
    assert.deepEqual(getCheck(checks, "index freshness"), {
      name: "index freshness",
      status: "warn",
      detail:
        "index schema outdated; run `omp-episodic migrate build`, stop the indexing daemon, then run `omp-episodic migrate activate`",
    });
    assert.deepEqual(getCheck(checks, "source coverage"), {
      name: "source coverage",
      status: "warn",
      detail: "legacy indexed_files schema; run `omp-episodic index` to record outcomes",
    });
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctor fails SQLite health for a corrupt database without changing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-corrupt-"));
  const sessionsDir = join(root, "sessions");
  const dbPath = join(root, "index.db");
  mkdirSync(sessionsDir);
  writeFileSync(dbPath, "not a sqlite database");

  try {
    const before = readFileSync(dbPath);
    const checks = await runDoctorIn(root);
    assert.equal(getCheck(checks, "SQLite health").status, "fail");
    assert.match(getCheck(checks, "SQLite health").detail, /database|file/i);
    assert.deepEqual(readFileSync(dbPath), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctor reports installed custom, unbounded, and legacy daemon configs", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-daemon-"));
  const sessionsDir = join(root, "sessions");
  const servicePath = join(root, "daemon.plist");
  mkdirSync(sessionsDir);

  try {
    writeFileSync(
      servicePath,
      "<string>--max-bytes</string>\n<string>123456789</string>\n",
    );
    let checks = await runDoctorIn(root, { servicePath });
    assert.equal(getCheck(checks, "installed daemon cap").status, "pass");
    assert.match(getCheck(checks, "installed daemon cap").detail, /117\.7 MiB/);

    writeFileSync(servicePath, "<string>--no-max-bytes</string>\n");
    checks = await runDoctorIn(root, { servicePath });
    assert.deepEqual(getCheck(checks, "installed daemon cap"), {
      name: "installed daemon cap",
      status: "pass",
      detail: "unbounded (--no-max-bytes)",
    });

    writeFileSync(servicePath, "<string>watch</string>\n");
    checks = await runDoctorIn(root, { servicePath });
    assert.equal(getCheck(checks, "installed daemon cap").status, "warn");
    assert.match(getCheck(checks, "installed daemon cap").detail, /legacy/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctor classifies daemon log size at exact thresholds", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-log-"));
  const sessionsDir = join(root, "sessions");
  const daemonLogPath = join(root, "daemon.log");
  mkdirSync(sessionsDir);
  writeFileSync(daemonLogPath, "");

  async function statusAt(size: number): Promise<string> {
    truncateSync(daemonLogPath, size);
    const checks = await runDoctorIn(root, { daemonLogPath });
    return getCheck(checks, "daemon log size").status;
  }

  try {
    assert.equal(await statusAt(10 * MiB - 1), "pass");
    assert.equal(await statusAt(10 * MiB), "warn");
    assert.equal(await statusAt(50 * MiB - 1), "warn");
    assert.equal(await statusAt(50 * MiB), "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runDoctor warns for missing operational paths without creating them", async () => {
  const root = join(tmpdir(), `omp-doctor-absent-${process.pid}-${Date.now()}`);
  const dbPath = join(root, "state", "index.db");

  const checks = await runDoctorIn(root, { dbPath });
  assert.equal(getCheck(checks, "storage headroom").status, "warn");
  assert.match(getCheck(checks, "storage headroom").detail, /missing|cannot inspect/i);
  assert.equal(getCheck(checks, "SQLite health").status, "warn");
  assert.equal(getCheck(checks, "source coverage").status, "warn");
  assert.equal(getCheck(checks, "installed daemon cap").status, "warn");
  assert.equal(getCheck(checks, "daemon log size").status, "warn");
  assert.equal(existsSync(root), false);
});
