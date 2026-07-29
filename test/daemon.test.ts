import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DAEMON_DEFAULT_MAX_BYTES,
  daemonLogPath,
  defaultDaemonConfig,
  detectPlatform,
  installDaemon,
  renderLaunchdPlist,
  parseDaemonMaxBytes,
  renderSystemdUnit,
  rotateDaemonLog,
  xmlEscape,
} from "../src/daemon.js";

test("detectPlatform returns a valid platform literal", () => {
  const platform = detectPlatform();
  assert.ok(["launchd", "systemd", "unsupported"].includes(platform));
});

test("renderLaunchdPlist returns valid launchd plist containing key configuration elements", () => {
  const cfg = defaultDaemonConfig();
  const plist = renderLaunchdPlist(cfg);
  assert.match(plist, /<key>Label<\/key>/);
  assert.match(plist, new RegExp(`<string>${cfg.label}<\/string>`));
  assert.match(plist, /<string>watch<\/string>/);
  assert.match(plist, /<string>--interval<\/string>/);
});

test("renderSystemdUnit returns valid systemd unit file containing key service elements", () => {
  const cfg = defaultDaemonConfig();
  const unit = renderSystemdUnit(cfg);
  assert.match(unit, /ExecStart=/);
  assert.match(unit, /\bwatch\b/);
  assert.match(unit, /WantedBy=default.target/);
});

test("installDaemon with write: false behavior", () => {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    assert.throws(() => {
      installDaemon(defaultDaemonConfig(), { write: false });
    });
  } else {
    const res = installDaemon(defaultDaemonConfig(), { write: false });
    assert.equal(res.platform, platform);
    assert.ok(res.path.length > 0);
    assert.equal(res.created, false);
    if (platform === "launchd") {
      assert.match(res.activateHint, /launchctl/);
    } else if (platform === "systemd") {
      assert.match(res.activateHint, /systemctl/);
    }
  }
});

test("xmlEscape correctness", () => {
  assert.equal(xmlEscape(`& < > " '`), "&amp; &lt; &gt; &quot; &apos;");
});

test("defaultDaemonConfig honors a cliPath override", () => {
  const cfg = defaultDaemonConfig({ cliPath: "/usr/local/bin/omp-episodic" });
  assert.equal(cfg.cliPath, "/usr/local/bin/omp-episodic");
  const unit = renderSystemdUnit(cfg);
  assert.match(unit, /\/usr\/local\/bin\/omp-episodic/);
});

test("systemd ExecStart with a space-containing dbPath is quoted", () => {
  const cfg = defaultDaemonConfig({ dbPath: "/Users/a b/index.db", sessionsDir: "/s p/sessions" });
  const unit = renderSystemdUnit(cfg);
  assert.ok(unit.includes('"/Users/a b/index.db"'));
  assert.ok(unit.includes('"/s p/sessions"'));
  const execStartLine = unit.split("\n").find(line => line.startsWith("ExecStart="));
  assert.ok(execStartLine);
  assert.ok(!execStartLine.includes(" /Users/a b/"));
  assert.ok(!execStartLine.includes(" /s p/sessions"));
});

test("systemd % escaping: dbPath containing % renders as %% in ExecStart", () => {
  const cfg = defaultDaemonConfig({ dbPath: "/Users/a%b/index.db" });
  const unit = renderSystemdUnit(cfg);
  assert.ok(unit.includes('"/Users/a%%b/index.db"'));
});

test("daemonLogPath() returns a path ending with omp-episodic/daemon.log", () => {
  const path = daemonLogPath();
  assert.ok(path.includes("omp-episodic"));
  assert.ok(path.endsWith("daemon.log"));
});

test("launchd plist still contains the log path string", () => {
  const cfg = defaultDaemonConfig();
  const plist = renderLaunchdPlist(cfg);
  const logPath = daemonLogPath();
  assert.ok(plist.includes(`<string>${xmlEscape(logPath)}</string>`));
});

test("daemon services preserve the default watch byte cap", () => {
  const cfg = defaultDaemonConfig();
  assert.equal(cfg.maxBytes, 750 * 1024 * 1024);
  assert.equal(cfg.maxBytes, DAEMON_DEFAULT_MAX_BYTES);

  const plist = renderLaunchdPlist(cfg);
  assert.match(
    plist,
    new RegExp(`<string>--max-bytes</string>\\s*<string>${cfg.maxBytes}</string>`),
  );

  const unit = renderSystemdUnit(cfg);
  assert.match(unit, new RegExp(`--max-bytes ${cfg.maxBytes}(?:\\s|$)`));
});

test("daemon services preserve the explicit no-max-bytes override", () => {
  const cfg = defaultDaemonConfig({ maxBytes: Number.MAX_SAFE_INTEGER });
  assert.match(renderLaunchdPlist(cfg), /<string>--no-max-bytes<\/string>/);
  assert.match(renderSystemdUnit(cfg), /--no-max-bytes(?:\s|$)/);
});

test("launchd throttles restarts and enables user-level log rotation", () => {
  const plist = renderLaunchdPlist(defaultDaemonConfig());
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/);
  assert.match(
    plist,
    new RegExp(`<string>--daemon-log</string>\\s*<string>${xmlEscape(daemonLogPath())}</string>`),
  );
  assert.match(plist, /<string>--daemon-log-max-bytes<\/string>\s*<string>10485760<\/string>/);
  assert.match(plist, /<string>--daemon-log-generations<\/string>\s*<string>5<\/string>/);
  assert.match(renderSystemdUnit(defaultDaemonConfig()), /RestartSec=5/);
});

test("rotateDaemonLog retains bounded generations and active-descriptor writes", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-daemon-log-"));
  const logPath = join(root, "daemon.log");
  const fd = openSync(logPath, "a");

  try {
    for (let i = 0; i < 7; i++) {
      writeSync(fd, `entry-${i}\n`);
      assert.equal(rotateDaemonLog(logPath, 4, 5), true);
    }
    writeSync(fd, "active\n");

    assert.equal(readFileSync(logPath, "utf8"), "active\n");
    assert.equal(readFileSync(`${logPath}.1`, "utf8"), "entry-6\n");
    assert.equal(readFileSync(`${logPath}.5`, "utf8"), "entry-2\n");
    assert.equal(existsSync(`${logPath}.6`), false);
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rotateDaemonLog contains filesystem failures", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-daemon-log-failure-"));
  try {
    assert.doesNotThrow(() => {
      assert.equal(rotateDaemonLog(root, 1, 5), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseDaemonMaxBytes reads custom caps from both service formats", () => {
  const cfg = defaultDaemonConfig({ maxBytes: 12345 });
  assert.equal(parseDaemonMaxBytes(renderLaunchdPlist(cfg), "launchd"), 12345);
  assert.equal(parseDaemonMaxBytes(renderSystemdUnit(cfg), "systemd"), 12345);
});

test("parseDaemonMaxBytes reads explicit no-cap service configurations", () => {
  const cfg = defaultDaemonConfig({ maxBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(
    parseDaemonMaxBytes(renderLaunchdPlist(cfg), "launchd"),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    parseDaemonMaxBytes(renderSystemdUnit(cfg), "systemd"),
    Number.MAX_SAFE_INTEGER,
  );
});
