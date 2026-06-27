import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runDoctor } from "../src/doctor.js";

test("runDoctor reports every setup check without creating an index", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-doctor-"));
  const sessionsDir = join(root, "sessions");
  const dbPath = join(root, "index.db");
  mkdirSync(sessionsDir);
  try {
    const checks = await runDoctor({ dbPath, sessionsDir });
    assert.deepEqual(checks.map((check) => check.name), [
      "sessions directory",
      "index database",
      "sqlite-vec extension",
      "embedding model (cached)",
      "index freshness",
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
