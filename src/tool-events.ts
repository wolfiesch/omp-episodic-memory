import { deflateSync, inflateSync } from "node:zlib";

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

export interface ToolEventMetadata {
  toolName: string;
  isError: boolean | null;
  exitCode: number | null;
  filePaths: string[];
  command: string | null;
  resultExcerpt: string;
}

export function serializeToolEvents(events: ToolEvent[]): string {
  return JSON.stringify(events);
}

export function compressToolEvents(events: ToolEvent[]): Buffer {
  return deflateSync(Buffer.from(serializeToolEvents(events), "utf8"), { level: 6 });
}

function decodeToolEvents(raw: string | Uint8Array): string {
  if (typeof raw === "string") return raw;
  return inflateSync(raw).toString("utf8");
}

/** Longest result snippet retained in the compact metadata column. */
const RESULT_EXCERPT_CHARS = 512;

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Parse JSON that is expected to hold an array; malformed input yields null. */
function parseJsonArray(text: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

export function parseToolEvents(raw: string | Uint8Array | null | undefined): ToolEvent[] {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return [];
  const parsed = parseJsonArray(decodeToolEvents(raw));
  if (parsed === null) return [];

  const events: ToolEvent[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.toolName !== "string") continue;
    const details = normalizeArguments(entry.details);
    const resultText = typeof entry.resultText === "string" ? entry.resultText : null;
    events.push({
      callId: typeof entry.callId === "string" ? entry.callId : null,
      toolName: entry.toolName,
      arguments: normalizeArguments(entry.arguments),
      resultText,
      isError: typeof entry.isError === "boolean" ? entry.isError : null,
      details,
      exitCode: typeof entry.exitCode === "number" && Number.isInteger(entry.exitCode)
        ? entry.exitCode
        : deriveExitCode(details, resultText),
      filePaths: asStringArray(entry.filePaths),
      command: typeof entry.command === "string" ? entry.command : null,
    });
  }
  return events;
}

export function serializeToolEventMetadata(events: ToolEvent[]): string {
  const metadata: ToolEventMetadata[] = events.map((event) => ({
    toolName: event.toolName,
    isError: event.isError,
    exitCode: event.exitCode,
    filePaths: event.filePaths,
    command: event.command,
    resultExcerpt:
      event.resultText?.replace(/\s+/g, " ").trim().slice(0, RESULT_EXCERPT_CHARS) ?? "",
  }));
  return JSON.stringify(metadata);
}

export function parseToolEventMetadata(raw: string | null | undefined): ToolEventMetadata[] {
  if (raw == null || raw.trim() === "") return [];
  const parsed = parseJsonArray(raw);
  if (parsed === null) return [];

  const metadata: ToolEventMetadata[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.toolName !== "string") continue;
    metadata.push({
      toolName: entry.toolName,
      isError: typeof entry.isError === "boolean" ? entry.isError : null,
      exitCode: typeof entry.exitCode === "number" && Number.isInteger(entry.exitCode)
        ? entry.exitCode
        : null,
      filePaths: asStringArray(entry.filePaths),
      command: typeof entry.command === "string" ? entry.command : null,
      resultExcerpt: typeof entry.resultExcerpt === "string"
        ? entry.resultExcerpt.slice(0, RESULT_EXCERPT_CHARS)
        : "",
    });
  }
  return metadata;
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
