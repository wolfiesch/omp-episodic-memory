import type { ToolEvent } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeArguments(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function deriveCommand(args: Record<string, unknown> | null): string | null {
  const command = args?.command;
  if (typeof command !== "string") return null;
  const trimmed = command.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function deriveFilePaths(args: Record<string, unknown> | null): string[] {
  if (args === null) return [];
  const keys = [
    "path",
    "paths",
    "file",
    "files",
    "sourcePath",
    "targetPath",
    "input_path",
    "output_path",
    "cwd",
    "workingDirectory",
  ];
  const seen = new Set<string>();
  const paths: string[] = [];

  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    if (seen.has(value)) return;
    seen.add(value);
    paths.push(value);
  };

  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) {
      for (const item of value) add(item);
    } else {
      add(value);
    }
  }

  return paths;
}

export function deriveExitCode(details: Record<string, unknown> | null, resultText: string | null): number | null {
  const exitCode = details?.exitCode;
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
  const match = resultText?.match(/Command exited with code (\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function serializeToolEvents(events: ToolEvent[]): string {
  return JSON.stringify(events);
}

export function parseToolEvents(raw: string | null | undefined): ToolEvent[] {
  if (raw == null || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const events: ToolEvent[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.toolName !== "string") continue;
    const details = normalizeArguments(entry.details);
    const args = normalizeArguments(entry.arguments);
    const resultText = typeof entry.resultText === "string" ? entry.resultText : null;
    const filePaths = Array.isArray(entry.filePaths)
      ? entry.filePaths.filter((path): path is string => typeof path === "string")
      : [];
    const command = typeof entry.command === "string" ? entry.command : null;
    const exitCode = typeof entry.exitCode === "number" && Number.isInteger(entry.exitCode)
      ? entry.exitCode
      : deriveExitCode(details, resultText);

    events.push({
      callId: typeof entry.callId === "string" ? entry.callId : null,
      toolName: entry.toolName,
      arguments: args,
      resultText,
      isError: typeof entry.isError === "boolean" ? entry.isError : null,
      details,
      exitCode,
      filePaths,
      command,
    });
  }
  return events;
}

export function toolEventsIndexText(events: ToolEvent[]): string {
  return events
    .map((event) => {
      const parts = [event.toolName];
      if (event.command !== null) parts.push(event.command);
      parts.push(...event.filePaths);
      if (event.exitCode !== null) parts.push(`exitCode ${event.exitCode}`);
      if (event.isError === true) parts.push("error");
      if (event.isError === false) parts.push("success");
      if (event.details !== null) parts.push(JSON.stringify(event.details));
      if (event.resultText !== null) parts.push(event.resultText);
      return parts.join(" ");
    })
    .join(" ");
}

export function formatToolEventSummary(event: ToolEvent, maxResultChars = 120): string {
  const parts = [event.toolName];
  if (event.command !== null) parts.push(`cmd=${event.command}`);
  if (event.filePaths.length > 0) parts.push(`paths=${event.filePaths.join(",")}`);
  if (event.exitCode !== null) parts.push(`exitCode=${event.exitCode}`);
  if (event.isError === true) parts.push("error");
  if (event.isError === false) parts.push("success");
  if (event.resultText !== null && maxResultChars > 0) {
    const normalized = event.resultText.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) {
      parts.push(normalized.length > maxResultChars ? `${normalized.slice(0, maxResultChars)}…` : normalized);
    }
  }
  return parts.join(" | ");
}
