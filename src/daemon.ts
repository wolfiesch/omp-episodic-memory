import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
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
  maxBytes: number;
  nodePath: string;
  cliPath: string;
}

export const DAEMON_LABEL = "gg.wolfie.omp-episodic";
export const DAEMON_DEFAULT_MAX_BYTES = 750 * 1024 * 1024;
export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DAEMON_LOG_GENERATIONS = 5;

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
  const maxBytesArgument =
    cfg.maxBytes === Number.MAX_SAFE_INTEGER
      ? "\t\t<string>--no-max-bytes</string>"
      : `\t\t<string>--max-bytes</string>
\t\t<string>${xmlEscape(String(cfg.maxBytes))}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(cfg.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(cfg.nodePath)}</string>
\t\t<string>${xmlEscape(cfg.cliPath)}</string>
\t\t<string>watch</string>
\t\t<string>--db</string>
\t\t<string>${xmlEscape(cfg.dbPath)}</string>
\t\t<string>--sessions</string>
\t\t<string>${xmlEscape(cfg.sessionsDir)}</string>
\t\t<string>--interval</string>
\t\t<string>${xmlEscape(String(cfg.intervalSec))}</string>
${maxBytesArgument}
\t\t<string>--daemon-log</string>
\t\t<string>${xmlEscape(logPath)}</string>
\t\t<string>--daemon-log-max-bytes</string>
\t\t<string>${DAEMON_LOG_MAX_BYTES}</string>
\t\t<string>--daemon-log-generations</string>
\t\t<string>${DAEMON_LOG_GENERATIONS}</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>5</integer>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(logPath)}</string>
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
    ...(cfg.maxBytes === Number.MAX_SAFE_INTEGER
      ? ["--no-max-bytes"]
      : ["--max-bytes", String(cfg.maxBytes)]),
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

/**
 * Rotate a launchd-owned log with copy-and-truncate semantics. Truncating the
 * active inode keeps launchd's open file descriptor valid for later writes.
 */
export function rotateDaemonLog(
  logPath: string = daemonLogPath(),
  maxBytes: number = DAEMON_LOG_MAX_BYTES,
  generations: number = DAEMON_LOG_GENERATIONS,
): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(generations) || generations <= 0) {
    return false;
  }

  try {
    if (!existsSync(logPath) || statSync(logPath).size < maxBytes) return false;

    rmSync(`${logPath}.${generations}`, { force: true });
    for (let generation = generations - 1; generation >= 1; generation--) {
      const source = `${logPath}.${generation}`;
      if (existsSync(source)) renameSync(source, `${logPath}.${generation + 1}`);
    }
    copyFileSync(logPath, `${logPath}.1`);
    truncateSync(logPath, 0);
    return true;
  } catch {
    return false;
  }
}

export function defaultDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  const defaultCliPath = process.argv[1] ?? join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return {
    label: DAEMON_LABEL,
    dbPath: DEFAULT_DB_PATH,
    sessionsDir: DEFAULT_SESSIONS_DIR,
    intervalSec: 30,
    maxBytes: DAEMON_DEFAULT_MAX_BYTES,
    nodePath: process.execPath,
    cliPath: defaultCliPath,
    ...overrides,
  };
}
