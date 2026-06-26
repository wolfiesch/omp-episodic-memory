import type { MemoryRecord, MemoryStatus } from "./memory.js";
import type { RecallBundle, RecallConfidence } from "./recall.js";
import type { SearchHit } from "./types.js";

export interface TerminalUiOptions {
  ansi?: boolean;
  width?: number;
}

export interface TerminalUiDecision {
  isTty: boolean;
  json?: boolean;
  plain?: boolean;
  requested?: boolean;
  env?: string;
}

type Color = "cyan" | "green" | "yellow" | "red" | "dim" | "bold";

const ANSI: Record<Color, [string, string]> = {
  cyan: ["\x1b[36m", "\x1b[39m"],
  green: ["\x1b[32m", "\x1b[39m"],
  yellow: ["\x1b[33m", "\x1b[39m"],
  red: ["\x1b[31m", "\x1b[39m"],
  dim: ["\x1b[2m", "\x1b[22m"],
  bold: ["\x1b[1m", "\x1b[22m"],
};

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function colorize(text: string, color: Color, enabled: boolean): string {
  if (!enabled) return text;
  const [open, close] = ANSI[color];
  return `${open}${text}${close}`;
}

export function shouldUseTerminalUi(decision: TerminalUiDecision): boolean {
  if (decision.json || decision.plain || !decision.isTty) return false;
  return decision.requested === true || decision.env === "1" || decision.env === "true";
}

function clampWidth(width: number | undefined): number {
  return Math.max(56, Math.min(width ?? 88, 120));
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (visibleLength(clean) <= max) return clean;
  return clean.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function line(text: string, width: number): string {
  return `│ ${padRight(text, width - 4)} │`;
}

function rule(width: number): string {
  return `├${"─".repeat(width - 2)}┤`;
}

function box(title: string, body: string[], opts: TerminalUiOptions = {}): string {
  const width = clampWidth(opts.width);
  const ansi = opts.ansi === true;
  const titleText = colorize(`π recall`, "cyan", ansi) + colorize(` ${title}`, "bold", ansi);
  const rows = [`╭${"─".repeat(width - 2)}╮`, line(titleText, width), rule(width)];
  for (const row of body) rows.push(line(truncate(row, width - 4), width));
  rows.push(`╰${"─".repeat(width - 2)}╯`);
  return rows.join("\n");
}

function projectName(cwd: string | null, title: string | null): string {
  return cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : (title ?? "session");
}

function dateFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function rankSignals(hit: SearchHit): string {
  return [hit.vectorRank ? `vec#${hit.vectorRank}` : null, hit.textRank ? `kw#${hit.textRank}` : null]
    .filter(Boolean)
    .join(" ");
}

export function renderSearchPanel(query: string, hits: SearchHit[], opts: TerminalUiOptions = {}): string {
  if (hits.length === 0) return box("Search", [`No results for ${JSON.stringify(query)}.`], opts);
  const body = [`query: ${query}`, `results: ${hits.length}`, ""];
  for (const [index, hit] of hits.entries()) {
    const signals = rankSignals(hit);
    body.push(`#${index + 1} ${projectName(hit.cwd, hit.title)} ${dateFromSeconds(hit.timestamp)} score ${hit.score.toFixed(3)}${signals ? ` ${signals}` : ""}`);
    body.push(hit.snippet);
    body.push(`${hit.sourcePath} exchange ${hit.ordinal}`);
  }
  return box("Search", body, opts);
}

function confidenceColor(confidence: RecallConfidence): Color {
  if (confidence === "high") return "green";
  if (confidence === "medium" || confidence === "low") return "yellow";
  return "red";
}

export function renderRecallPanel(bundle: RecallBundle, opts: TerminalUiOptions = {}): string {
  const ansi = opts.ansi === true;
  const body = [
    `confidence: ${colorize(bundle.confidence, confidenceColor(bundle.confidence), ansi)} | answerable: ${bundle.answerable}`,
    `intents: ${bundle.intents.join(", ") || "none"}`,
    bundle.summary,
    "",
    "Evidence",
  ];
  for (const [index, ev] of bundle.evidence.entries()) {
    body.push(`#${index + 1} [${ev.kind}] ${ev.title} ${ev.date ?? "n/a"} score ${ev.score.toFixed(3)}`);
    body.push(ev.quote);
  }
  body.push("", "Next");
  for (const step of bundle.recommendedNextSteps) body.push(`• ${step}`);
  return box("Recall", body, opts);
}

export function renderInboxPanel(status: MemoryStatus, records: MemoryRecord[], opts: TerminalUiOptions = {}): string {
  if (records.length === 0) return box("Review inbox", [`No ${status} records.`], opts);
  const body = [`status: ${status}`, `records: ${records.length}`, ""];
  for (const record of records) {
    body.push(`[${record.id}] ${record.type} ${record.confidence.toFixed(2)} ${record.title}`);
    body.push(`${record.project ?? "global"} | ${record.sources.length} source${record.sources.length === 1 ? "" : "s"}`);
    body.push(`next: omp-episodic approve ${record.id} | omp-episodic reject ${record.id} --reason TEXT`);
  }
  return box("Review inbox", body, opts);
}

export function renderStatsPanel(dbPath: string, stats: { exchanges: number; sessions: number; earliest: number | null; latest: number | null }, opts: TerminalUiOptions = {}): string {
  const fmt = (t: number | null) => (t ? dateFromSeconds(t) : "n/a");
  return box("Index stats", [
    `db: ${dbPath}`,
    `exchanges: ${stats.exchanges}`,
    `sessions: ${stats.sessions}`,
    `range: ${fmt(stats.earliest)} .. ${fmt(stats.latest)}`,
  ], opts);
}
