import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_DB_PATH, DEFAULT_SESSIONS_DIR } from "./types.js";

export type DaemonPlatform = "launchd" | "systemd" | "unsupported";

export interface DaemonConfig {
  label: string;
  dbPath: string;
  sessionsDir: string;
  intervalSec: number;
  nodePath: string;
  cliPath: string;
}

export const DAEMON_LABEL = "gg.wolfie.omp-episodic";

export function detectPlatform(): DaemonPlatform {
  if (process.platform === "darwin") {
    return "launchd";
  } else if (process.platform === "linux") {
    return "systemd";
  } else {
    return "unsupported";
  }
}

export function launchdPlistPath(label?: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label ?? DAEMON_LABEL}.plist`);
}

export function systemdUnitPath(label?: string): string {
  return join(homedir(), ".config", "systemd", "user", `${label ?? DAEMON_LABEL}.service`);
}

export function daemonLogPath(): string {
  return join(homedir(), ".local", "state", "omp-episodic", "daemon.log");
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderLaunchdPlist(cfg: DaemonConfig): string {
  const logPath = daemonLogPath();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xmlEscape(cfg.label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(cfg.nodePath)}</string>
		<string>${xmlEscape(cfg.cliPath)}</string>
		<string>watch</string>
		<string>--db</string>
		<string>${xmlEscape(cfg.dbPath)}</string>
		<string>--sessions</string>
		<string>${xmlEscape(cfg.sessionsDir)}</string>
		<string>--interval</string>
		<string>${xmlEscape(String(cfg.intervalSec))}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${xmlEscape(logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function systemdQuoteArg(arg: string): string {
  if (/[\s"\\%]/.test(arg)) {
    const escaped = arg
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/%/g, "%%");
    return `"${escaped}"`;
  }
  return arg;
}

export function renderSystemdUnit(cfg: DaemonConfig): string {
  const argv = [
    cfg.nodePath,
    cfg.cliPath,
    "watch",
    "--db",
    cfg.dbPath,
    "--sessions",
    cfg.sessionsDir,
    "--interval",
    String(cfg.intervalSec),
  ];
  const execStart = argv.map(systemdQuoteArg).join(" ");
  return `[Unit]
Description=omp-episodic-memory daemon

[Service]
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export interface InstallResult {
  platform: DaemonPlatform;
  path: string;
  created: boolean;
  activateHint: string;
}

export function installDaemon(cfg: DaemonConfig, opts?: { write?: boolean }): InstallResult {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    throw new Error("Unsupported platform for daemon installation");
  }

  let daemonPath: string;
  let content: string;
  let activateHint: string;

  if (platform === "launchd") {
    daemonPath = launchdPlistPath(cfg.label);
    content = renderLaunchdPlist(cfg);
    activateHint = `launchctl load -w ${daemonPath}`;
  } else {
    daemonPath = systemdUnitPath(cfg.label);
    content = renderSystemdUnit(cfg);
    activateHint = `systemctl --user enable --now ${cfg.label}`;
  }

  const shouldWrite = opts?.write !== false;
  if (shouldWrite) {
    mkdirSync(dirname(daemonPath), { recursive: true });
    mkdirSync(dirname(daemonLogPath()), { recursive: true });
    writeFileSync(daemonPath, content, "utf8");
  }

  return {
    platform,
    path: daemonPath,
    created: shouldWrite,
    activateHint,
  };
}

export function uninstallDaemon(opts?: { label?: string }): {
  platform: DaemonPlatform;
  path: string;
  removed: boolean;
} {
  const platform = detectPlatform();
  if (platform === "unsupported") {
    throw new Error("Unsupported platform for daemon uninstallation");
  }

  const label = opts?.label ?? DAEMON_LABEL;
  const daemonPath = platform === "launchd" ? launchdPlistPath(label) : systemdUnitPath(label);
  const exists = existsSync(daemonPath);

  if (exists) {
    rmSync(daemonPath, { force: true });
  }

  return {
    platform,
    path: daemonPath,
    removed: exists,
  };
}

export function defaultDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  const defaultCliPath = process.argv[1] ?? join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return {
    label: DAEMON_LABEL,
    dbPath: DEFAULT_DB_PATH,
    sessionsDir: DEFAULT_SESSIONS_DIR,
    intervalSec: 30,
    nodePath: process.execPath,
    cliPath: defaultCliPath,
    ...overrides,
  };
}
