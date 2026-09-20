import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { openDb } from "../src/db.js";
import {
  DAEMON_LABEL,
  defaultDaemonConfig,
  detectPlatform,
  renderLaunchdPlist,
  renderSystemdUnit,
} from "../src/daemon.js";

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

test("help advertises the setup command", async () => {
  const { stderr } = await runCli([]);
  assert.match(stderr, /setup\s+\[--db PATH\]/);
});

test("help advertises byte caps for index, watch, setup, and daemon install", async () => {
  const { stderr } = await runCli([]);
  assert.match(stderr, /setup\s+.*--max-bytes N\|--no-max-bytes/);
  assert.match(stderr, /index\s+.*--max-bytes N\|--no-max-bytes/);
  assert.match(stderr, /watch\s+.*--max-bytes N\|--no-max-bytes/);
  assert.match(stderr, /daemon\s+.*--max-bytes N\|--no-max-bytes/);
  assert.match(stderr, /Installed watch cap: 750 MiB/);
});

test("shared max-bytes parsing rejects invalid caps", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-cli-cap-"));
  const invalidValues = ["0", "-1", "NaN", "1.5", String(Number.MAX_SAFE_INTEGER + 1)];

  try {
    for (const value of invalidValues) {
      await assert.rejects(
        runCli([
          "index",
          "--db",
          join(root, `${value}.db`),
          "--sessions",
          root,
          "--max-bytes",
          value,
        ]),
        (error: unknown) => {
          const stderr =
            typeof error === "object" && error !== null && "stderr" in error
              ? String(error.stderr)
              : String(error);
          return /--max-bytes must be a positive safe integer/.test(stderr);
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon status exposes the resolved effective byte cap", async () => {
  const capped = await runCli(["daemon", "status", "--max-bytes", "12345", "--json"]);
  assert.equal(JSON.parse(capped.stdout).maxBytes, 12345);

  const unlimited = await runCli(["daemon", "status", "--no-max-bytes", "--json"]);
  assert.equal(JSON.parse(unlimited.stdout).maxBytes, null);
});

test("daemon status reads custom and no-cap values from the installed service", async () => {
  const platform = detectPlatform();
  if (platform === "unsupported") return;

  const home = mkdtempSync(join(tmpdir(), "omp-cli-daemon-status-"));
  const servicePath =
    platform === "launchd"
      ? join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`)
      : join(home, ".config", "systemd", "user", `${DAEMON_LABEL}.service`);
  mkdirSync(join(servicePath, ".."), { recursive: true });
  const installCap = (maxBytes: number): void => {
    const cfg = defaultDaemonConfig({ maxBytes });
    writeFileSync(
      servicePath,
      platform === "launchd" ? renderLaunchdPlist(cfg) : renderSystemdUnit(cfg),
    );
  };

  try {
    installCap(54321);
    const customStatus = await runCli(["daemon", "status", "--json"], { HOME: home });
    assert.equal(JSON.parse(customStatus.stdout).maxBytes, 54321);

    installCap(Number.MAX_SAFE_INTEGER);
    const unlimitedStatus = await runCli(["daemon", "status", "--json"], { HOME: home });
    assert.equal(JSON.parse(unlimitedStatus.stdout).maxBytes, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
