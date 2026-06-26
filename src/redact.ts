import type { ToolEvent } from "./types.js";
import { isRecord } from "./tool-events.js";

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._\-]{16,}\b/gi, "[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "[REDACTED]"],
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s"']+)/gi,
    "$1=[REDACTED]",
  ],
];

export function redactSecrets(text: string): string {
  let redacted = text.replace(PRIVATE_KEY_BLOCK, "[REDACTED]");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    compact.includes("secret") ||
    compact.includes("token") ||
    compact.includes("password") ||
    compact.includes("apikey") ||
    compact.includes("accesskey") ||
    compact.includes("privatekey")
  );
}


function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!isRecord(value)) return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    cleaned[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(child);
  }
  return cleaned;
}

function redactRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (value === null) return null;
  const redacted = redactValue(value);
  return isRecord(redacted) ? redacted : null;
}

export function redactToolEvent(ev: ToolEvent): ToolEvent {
  return {
    ...ev,
    arguments: redactRecord(ev.arguments),
    resultText: ev.resultText === null ? null : redactSecrets(ev.resultText),
    details: redactRecord(ev.details),
    command: ev.command === null ? null : redactSecrets(ev.command),
  };
}
