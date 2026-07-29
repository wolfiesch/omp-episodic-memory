import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statfsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import {
  daemonLogPath,
  detectPlatform,
  launchdPlistPath,
  parseDaemonMaxBytes,
  systemdUnitPath,
} from "./daemon.js";
import type { DaemonPlatform } from "./daemon.js";
import { getStats, openReadOnlyDb } from "./db.js";
import { initEmbeddings } from "./embeddings.js";
import { DEFAULT_DB_PATH, DEFAULT_SESSIONS_DIR } from "./types.js";

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface DoctorOptions {
  dbPath?: string;
  sessionsDir?: string;
  probeModel?: boolean;
  daemonPlatform?: DaemonPlatform;
  servicePath?: string;
  daemonLogPath?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const STORAGE_FAIL_BYTES = 5 * GiB;
const STORAGE_WARN_BYTES = 20 * GiB;
const DAEMON_LOG_WARN_BYTES = 10 * MiB;
const DAEMON_LOG_FAIL_BYTES = 50 * MiB;

export function classifyStorageHeadroom(
  freeBytes: number,
  totalBytes: number,
): DoctorCheck["status"] {
  if (
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(totalBytes) ||
    freeBytes < 0 ||
    totalBytes <= 0
  ) {
    return "warn";
  }
  if (freeBytes < STORAGE_FAIL_BYTES) return "fail";
  return freeBytes < Math.max(STORAGE_WARN_BYTES, totalBytes * 0.1) ? "warn" : "pass";
}

function formatByteCount(bytes: number): string {
  if (bytes >= GiB) return `${(bytes / GiB).toFixed(1)} GiB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

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

async function checkEmbeddingModel(probeModel: boolean | undefined): Promise<DoctorCheck> {
  if (probeModel === true) {
    try {
      await initEmbeddings();
      return { name: "embedding model (cached)", status: "pass", detail: "model loaded" };
    } catch (error: unknown) {
      return { name: "embedding model (cached)", status: "fail", detail: messageOf(error) };
    }
  }

  // Transformers.js defaults its cache to node_modules/@xenova/transformers/.cache
  // (NOT ~/.cache/huggingface) unless TRANSFORMERS_CACHE is set. Check all three.
  const candidates = [
    process.env.TRANSFORMERS_CACHE,
    join(packageRoot(), "node_modules", "@xenova", "transformers", ".cache"),
    join(homedir(), ".cache", "huggingface"),
  ].filter((dir): dir is string => typeof dir === "string");
  if (candidates.some((dir) => existsSync(dir) && containsMiniLmCache(dir))) {
    return { name: "embedding model (cached)", status: "pass", detail: "model cached" };
  }
  return {
    name: "embedding model (cached)",
    status: "warn",
    detail: "model not cached; first vector run downloads it, or use --mode text",
  };
}

function checkStorageHeadroom(dbPath: string, sessionsDir: string): DoctorCheck {
  const dbStoragePath = existsSync(dbPath) ? dbPath : dirname(dbPath);
  const storagePath = [dbStoragePath, sessionsDir].find((candidate) => existsSync(candidate));
  if (storagePath === undefined) {
    return {
      name: "storage headroom",
      status: "warn",
      detail: `cannot inspect storage; DB directory ${dirname(dbPath)} and sessions directory ${sessionsDir} are missing`,
    };
  }

  try {
    const stats = statfsSync(storagePath);
    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    const status = classifyStorageHeadroom(freeBytes, totalBytes);
    const warningThreshold = Math.max(STORAGE_WARN_BYTES, totalBytes * 0.1);
    const threshold =
      status === "fail"
        ? `; free at least ${formatByteCount(STORAGE_FAIL_BYTES)} immediately`
        : status === "warn"
          ? `; free at least ${formatByteCount(warningThreshold)}`
          : "";
    return {
      name: "storage headroom",
      status,
      detail: `${formatByteCount(freeBytes)} free of ${formatByteCount(totalBytes)} on ${storagePath}${threshold}`,
    };
  } catch (error: unknown) {
    return {
      name: "storage headroom",
      status: "warn",
      detail: `cannot inspect ${storagePath}: ${messageOf(error)}`,
    };
  }
}

function checkSessionsDirectory(sessionsDir: string): DoctorCheck {
  return existsSync(sessionsDir)
    ? { name: "sessions directory", status: "pass", detail: sessionsDir }
    : { name: "sessions directory", status: "fail", detail: sessionsDir };
}

function checkIndexDatabase(dbPath: string): DoctorCheck {
  try {
    accessSync(dirname(dbPath), constants.W_OK);
  } catch {
    return { name: "index database", status: "fail", detail: "index directory not writable" };
  }
  return existsSync(dbPath)
    ? { name: "index database", status: "pass", detail: dbPath }
    : { name: "index database", status: "warn", detail: "not yet created; run `omp-episodic index`" };
}

function checkSqliteHealth(dbPath: string): DoctorCheck {
  if (!existsSync(dbPath)) {
    return {
      name: "SQLite health",
      status: "warn",
      detail: "database not found; run `omp-episodic index`",
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma("quick_check(1)") as Array<Record<string, unknown>>;
    const result = rows[0] === undefined ? undefined : Object.values(rows[0])[0];
    if (result === "ok") {
      return { name: "SQLite health", status: "pass", detail: "quick_check: ok" };
    }
    return {
      name: "SQLite health",
      status: "fail",
      detail: `quick_check: ${result === undefined ? "no result" : String(result)}`,
    };
  } catch (error: unknown) {
    return {
      name: "SQLite health",
      status: "fail",
      detail: `cannot open or check database: ${messageOf(error)}`,
    };
  } finally {
    db?.close();
  }
}

function checkSqliteVec(): DoctorCheck {
  let probe: Database.Database | null = null;
  try {
    probe = new Database(":memory:");
    sqliteVec.load(probe);
    probe.exec("CREATE VIRTUAL TABLE t USING vec0(v float[4])");
    return { name: "sqlite-vec extension", status: "pass", detail: "vec0 available" };
  } catch (error: unknown) {
    return { name: "sqlite-vec extension", status: "fail", detail: messageOf(error) };
  } finally {
    probe?.close();
  }
}

function checkIndexFreshness(dbPath: string): DoctorCheck {
  if (!existsSync(dbPath)) {
    return { name: "index freshness", status: "warn", detail: "index empty" };
  }
  let db: Database.Database | null = null;
  try {
    db = openReadOnlyDb(dbPath);
    const stats = getStats(db);
    if (stats.exchanges === 0) {
      return { name: "index freshness", status: "warn", detail: "index empty" };
    }
    const latest = stats.latest === null ? "unknown" : new Date(stats.latest * 1000).toISOString();
    return {
      name: "index freshness",
      status: "pass",
      detail: `${stats.exchanges} exchanges across ${stats.sessions} sessions, latest ${latest}`,
    };
  } catch (error: unknown) {
    const message = messageOf(error);
    if (message.includes("Index DB schema is outdated")) {
      return { name: "index freshness", status: "warn", detail: "index schema outdated; run `omp-episodic index --force`" };
    }
    return { name: "index freshness", status: "fail", detail: message };
  } finally {
    db?.close();
  }
}

function checkSourceCoverage(dbPath: string): DoctorCheck {
  if (!existsSync(dbPath)) {
    return {
      name: "source coverage",
      status: "warn",
      detail: "database not found; run `omp-episodic index`",
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tableExists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'indexed_files'`)
      .get() !== undefined;
    if (!tableExists) {
      return {
        name: "source coverage",
        status: "warn",
        detail: "indexed_files state missing; run `omp-episodic index`",
      };
    }

    const columns = (
      db.prepare(`PRAGMA table_info(indexed_files)`).all() as Array<{ name: string }>
    ).map(({ name }) => name);
    if (!columns.includes("outcome")) {
      return {
        name: "source coverage",
        status: "warn",
        detail: "legacy indexed_files schema; run `omp-episodic index` to record outcomes",
      };
    }

    const rows = db
      .prepare(`SELECT outcome, COUNT(*) AS count FROM indexed_files GROUP BY outcome`)
      .all() as Array<{ outcome: string | null; count: number }>;
    let indexed = 0;
    let oversize = 0;
    let failed = 0;
    let unclassified = 0;
    for (const row of rows) {
      if (row.outcome === "indexed") indexed = row.count;
      else if (row.outcome === "oversize") oversize = row.count;
      else if (row.outcome === "failed") failed = row.count;
      else unclassified += row.count;
    }
    const detail =
      `indexed ${indexed}, oversize ${oversize}, failed ${failed}` +
      (unclassified === 0 ? "" : `, unclassified ${unclassified}`);
    return {
      name: "source coverage",
      status: oversize === 0 && failed === 0 && unclassified === 0 ? "pass" : "warn",
      detail,
    };
  } catch (error: unknown) {
    return {
      name: "source coverage",
      status: "fail",
      detail: `cannot inspect source outcomes: ${messageOf(error)}`,
    };
  } finally {
    db?.close();
  }
}

function checkInstalledDaemonCap(
  platform: DaemonPlatform,
  servicePathOverride: string | undefined,
): DoctorCheck {
  if (platform === "unsupported") {
    return {
      name: "installed daemon cap",
      status: "warn",
      detail: `unsupported platform: ${process.platform}`,
    };
  }
  const servicePath =
    servicePathOverride ??
    (platform === "launchd" ? launchdPlistPath() : systemdUnitPath());
  if (!existsSync(servicePath)) {
    return {
      name: "installed daemon cap",
      status: "warn",
      detail: `service not installed at ${servicePath}`,
    };
  }

  try {
    const cap = parseDaemonMaxBytes(readFileSync(servicePath, "utf8"), platform);
    if (cap === undefined) {
      return {
        name: "installed daemon cap",
        status: "warn",
        detail: "legacy service has no safe cap; reinstall with `omp-episodic daemon install`",
      };
    }
    return {
      name: "installed daemon cap",
      status: "pass",
      detail:
        cap === Number.MAX_SAFE_INTEGER
          ? "unbounded (--no-max-bytes)"
          : `${formatByteCount(cap)} (${cap} bytes)`,
    };
  } catch (error: unknown) {
    return {
      name: "installed daemon cap",
      status: "warn",
      detail: `cannot read ${servicePath}: ${messageOf(error)}`,
    };
  }
}

function checkDaemonLog(logPath: string): DoctorCheck {
  if (!existsSync(logPath)) {
    return {
      name: "daemon log size",
      status: "warn",
      detail: `log not found at ${logPath}`,
    };
  }

  try {
    const size = statSync(logPath).size;
    const status =
      size >= DAEMON_LOG_FAIL_BYTES
        ? "fail"
        : size >= DAEMON_LOG_WARN_BYTES
          ? "warn"
          : "pass";
    return {
      name: "daemon log size",
      status,
      detail: `${formatByteCount(size)} at ${logPath}`,
    };
  } catch (error: unknown) {
    return {
      name: "daemon log size",
      status: "warn",
      detail: `cannot inspect ${logPath}: ${messageOf(error)}`,
    };
  }
}

function checkMcpServerEntry(): DoctorCheck {
  const entry = join(packageRoot(), "dist", "mcp-server.js");
  return existsSync(entry)
    ? { name: "MCP server entry", status: "pass", detail: entry }
    : { name: "MCP server entry", status: "warn", detail: "run `bun run build`" };
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  const sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  const checks: DoctorCheck[] = [];

  try {
    checks.push(checkSessionsDirectory(sessionsDir));
  } catch (error: unknown) {
    checks.push({ name: "sessions directory", status: "fail", detail: messageOf(error) });
  }

  try {
    checks.push(checkStorageHeadroom(dbPath, sessionsDir));
  } catch (error: unknown) {
    checks.push({ name: "storage headroom", status: "warn", detail: messageOf(error) });
  }

  try {
    checks.push(checkIndexDatabase(dbPath));
  } catch (error: unknown) {
    checks.push({ name: "index database", status: "fail", detail: messageOf(error) });
  }

  try {
    checks.push(checkSqliteHealth(dbPath));
  } catch (error: unknown) {
    checks.push({ name: "SQLite health", status: "fail", detail: messageOf(error) });
  }

  try {
    checks.push(checkSqliteVec());
  } catch (error: unknown) {
    checks.push({ name: "sqlite-vec extension", status: "fail", detail: messageOf(error) });
  }

  checks.push(await checkEmbeddingModel(opts.probeModel));

  try {
    checks.push(checkIndexFreshness(dbPath));
  } catch (error: unknown) {
    checks.push({ name: "index freshness", status: "fail", detail: messageOf(error) });
  }

  try {
    checks.push(checkSourceCoverage(dbPath));
  } catch (error: unknown) {
    checks.push({ name: "source coverage", status: "fail", detail: messageOf(error) });
  }

  try {
    checks.push(checkInstalledDaemonCap(opts.daemonPlatform ?? detectPlatform(), opts.servicePath));
  } catch (error: unknown) {
    checks.push({ name: "installed daemon cap", status: "warn", detail: messageOf(error) });
  }

  try {
    checks.push(checkDaemonLog(opts.daemonLogPath ?? daemonLogPath()));
  } catch (error: unknown) {
    checks.push({ name: "daemon log size", status: "warn", detail: messageOf(error) });
  }

  try {
    checks.push(checkMcpServerEntry());
  } catch (error: unknown) {
    checks.push({ name: "MCP server entry", status: "warn", detail: messageOf(error) });
  }

  return checks;
}
