import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const cacheDir = process.env.TRANSFORMERS_CACHE ?? join(homedir(), ".cache", "huggingface");
  if (existsSync(cacheDir) && containsMiniLmCache(cacheDir)) {
    return { name: "embedding model (cached)", status: "pass", detail: "model cached" };
  }
  return {
    name: "embedding model (cached)",
    status: "warn",
    detail: "model not cached; first vector run downloads it, or use --mode text",
  };
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
    checks.push(checkIndexDatabase(dbPath));
  } catch (error: unknown) {
    checks.push({ name: "index database", status: "fail", detail: messageOf(error) });
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
    checks.push(checkMcpServerEntry());
  } catch (error: unknown) {
    checks.push({ name: "MCP server entry", status: "warn", detail: messageOf(error) });
  }

  return checks;
}
