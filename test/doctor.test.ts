import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
