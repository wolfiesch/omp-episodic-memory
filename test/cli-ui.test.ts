import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { openDb } from "../src/db.js";

const execFileAsync = promisify(execFile);

async function runCli(args: string[], env: Record<string, string> = {}) {
  return execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    env: { ...process.env, ...env },
    cwd: process.cwd(),
  });
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // ignore missing sidecar files
    }
  }
}

test("help advertises the terminal UI controls", async () => {
  const { stderr } = await runCli([]);
  assert.match(stderr, /--ui/);
  assert.match(stderr, /--plain/);
  assert.match(stderr, /OMP_EPISODIC_UI/);
});

test("piped CLI output stays plain even when UI is requested", async () => {
  const dbPath = join(tmpdir(), "omp-cli-ui-" + randomUUID() + ".db");
  const db = openDb(dbPath);
  db.close();
  try {
    const { stdout } = await runCli(["stats", "--db", dbPath, "--ui"], { OMP_EPISODIC_UI: "1" });
    assert.match(stdout, /^Index: /);
    assert.doesNotMatch(stdout, /\x1b\[/);
    assert.doesNotMatch(stdout, /╭|╰|π recall/);
  } finally {
    cleanupDb(dbPath);
  }
});
