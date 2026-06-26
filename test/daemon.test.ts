import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectPlatform,
  renderLaunchdPlist,
  renderSystemdUnit,
  defaultDaemonConfig,
  installDaemon,
  xmlEscape,
  daemonLogPath,
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
