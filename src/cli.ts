#!/usr/bin/env node
// CLI for omp-episodic-memory: index / search / stats over OMP transcripts.
// stdout = results only; all status/progress goes to stderr.
import { openDb, openReadOnlyDb, getStats } from "./db.js";
import { indexAll } from "./indexer.js";
import { extract } from "./extractor.js";
import { search } from "./search.js";
import {
  listMemoryRecords,
  searchMemoryRecords,
  updateMemoryStatus,
  type MemoryRecord,
  type MemoryStatus,
  type MemoryType,
} from "./memory.js";
import { recallForTask, formatBundle, type RecallInclude } from "./recall.js";
import { DEFAULT_DB_PATH, type SearchMode } from "./types.js";

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function toEpochSeconds(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const ms = Date.parse(dateStr);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

async function cmdIndex(flags: Map<string, string>): Promise<void> {
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const sessionsDir = flags.get("sessions");
  const maxFiles = flags.has("max") ? Number(flags.get("max")) : undefined;
  process.stderr.write(`Indexing into ${dbPath}...\n`);
  const start = Date.now();
  const result = await indexAll({
    dbPath,
    sessionsDir,
    maxFiles,
    onProgress: (p) => {
      if (p.fileIndex % 25 === 0 || p.fileIndex === p.totalFiles - 1) {
        process.stderr.write(
          `  [${p.fileIndex + 1}/${p.totalFiles}] ${p.exchanges} changed  ${p.file.split("/").pop()}\n`,
        );
      }
    },
  });
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  process.stderr.write(
    `Done in ${secs}s: ${result.filesProcessed} files, ${result.exchangesUpserted} exchanges upserted.\n`,
  );
}

async function cmdSearch(positional: string[], flags: Map<string, string>): Promise<void> {
  const query = positional.join(" ").trim();
  if (!query) {
    process.stderr.write("Usage: omp-episodic search <query> [--mode both|vector|text] [--limit N] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--db PATH]\n");
    process.exitCode = 1;
    return;
  }
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const db = openReadOnlyDb(dbPath);
  const mode = (flags.get("mode") as SearchMode) ?? "both";
  const limit = flags.has("limit") ? Number(flags.get("limit")) : 10;
  const hits = await search(db, {
    query,
    mode,
    limit,
    after: toEpochSeconds(flags.get("after")),
    before: toEpochSeconds(flags.get("before")),
  });
  db.close();

  if (flags.get("json") === "true") {
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
    return;
  }
  if (hits.length === 0) {
    process.stdout.write(`No results for "${query}".\n`);
    return;
  }
  process.stdout.write(`Found ${hits.length} result(s) for "${query}":\n\n`);
  hits.forEach((h, i) => {
    const date = new Date(h.timestamp * 1000).toISOString().slice(0, 10);
    const proj = h.cwd ? h.cwd.split("/").pop() : (h.title ?? "session");
    const signals = [
      h.vectorRank ? `vec#${h.vectorRank}` : null,
      h.textRank ? `kw#${h.textRank}` : null,
    ].filter(Boolean).join(",");
    process.stdout.write(
      `${i + 1}. [${proj}, ${date}] score=${h.score.toFixed(4)} (${signals})\n` +
        `   "${h.snippet}"\n` +
        `   ${h.sourcePath} (exchange ${h.ordinal})\n\n`,
    );
  });
}

async function cmdRecall(positional: string[], flags: Map<string, string>): Promise<void> {
  const task = positional.join(" ").trim();
  if (!task) {
    process.stderr.write("Usage: omp-episodic recall <task...> [--db PATH] [--project P] [--mode both|vector|text] [--tokens N] [--after YYYY-MM-DD] [--before YYYY-MM-DD] [--include a,b,c] [--json]\n");
    process.exitCode = 1;
    return;
  }
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const db = openReadOnlyDb(dbPath);
  const mode = (flags.get("mode") as SearchMode) ?? "both";
  const includeRaw = flags.get("include");
  const include = includeRaw
    ? (includeRaw.split(",").map((s) => s.trim()).filter(Boolean) as RecallInclude[])
    : undefined;
  const bundle = await recallForTask(db, {
    task,
    project: flags.get("project"),
    include,
    mode,
    maxContextTokens: flags.has("tokens") ? Number(flags.get("tokens")) : undefined,
    after: toEpochSeconds(flags.get("after")),
    before: toEpochSeconds(flags.get("before")),
  });
  db.close();

  if (flags.get("json") === "true") {
    process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatBundle(bundle) + "\n");
}

function cmdStats(flags: Map<string, string>): void {
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const db = openReadOnlyDb(dbPath);
  const s = getStats(db);
  db.close();
  const fmt = (t: number | null) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : "n/a");
  process.stdout.write(
    `Index: ${dbPath}\n` +
      `  Exchanges: ${s.exchanges}\n` +
      `  Sessions:  ${s.sessions}\n` +
      `  Range:     ${fmt(s.earliest)} .. ${fmt(s.latest)}\n`,
  );
}

async function cmdExtract(flags: Map<string, string>): Promise<void> {
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const since = toEpochSeconds(flags.get("since"));
  const limit = flags.has("max") ? Number(flags.get("max")) : undefined;
  process.stderr.write(`Extracting derived memories into ${dbPath}...\n`);
  const result = await extract({
    dbPath,
    sessionsDir: flags.get("sessions"),
    since,
    project: flags.get("project"),
    limit,
  });
  process.stdout.write(
    `Proposed ${result.proposed} record(s) from ${result.exchangesScanned} exchange(s) across ${result.sessionsScanned} session(s).\n`,
  );
}

function formatRecordLine(r: MemoryRecord): string {
  return `[${r.id}] (${r.type}, ${r.confidence.toFixed(2)}, ${r.status}) ${r.title} — ${r.project ?? "no-project"} (${r.sources.length} source${r.sources.length === 1 ? "" : "s"})`;
}

function cmdInbox(flags: Map<string, string>): void {
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  const status = (flags.get("status") as MemoryStatus | undefined) ?? "pending";
  const limit = flags.has("limit") ? Number(flags.get("limit")) : undefined;
  const records = listMemoryRecords(db, status, limit);
  db.close();
  if (flags.get("json") === "true") {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  if (records.length === 0) {
    process.stdout.write(`No ${status} records.\n`);
    return;
  }
  for (const r of records) process.stdout.write(`${formatRecordLine(r)}\n`);
}

function cmdApprove(positional: string[], flags: Map<string, string>): void {
  const id = Number(positional[0]);
  if (!Number.isFinite(id)) {
    process.stderr.write("Usage: approve <id> [--db PATH]\n");
    process.exitCode = 1;
    return;
  }
  const db = openDb(flags.get("db") ?? DEFAULT_DB_PATH);
  const ok = updateMemoryStatus(db, id, "approved");
  db.close();
  process.stdout.write(ok ? `Approved [${id}].\n` : `Record [${id}] not found.\n`);
}

function cmdReject(positional: string[], flags: Map<string, string>): void {
  const id = Number(positional[0]);
  if (!Number.isFinite(id)) {
    process.stderr.write("Usage: reject <id> [--db PATH] [--reason TEXT]\n");
    process.exitCode = 1;
    return;
  }
  const db = openDb(flags.get("db") ?? DEFAULT_DB_PATH);
  const ok = updateMemoryStatus(db, id, "rejected");
  db.close();
  const reason = flags.get("reason");
  const suffix = reason && reason !== "true" ? ` (${reason})` : "";
  process.stdout.write(ok ? `Rejected [${id}].${suffix}\n` : `Record [${id}] not found.\n`);
}

function cmdMemories(positional: string[], flags: Map<string, string>): void {
  const dbPath = flags.get("db") ?? DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  const query = positional.join(" ").trim();
  const records = searchMemoryRecords(db, {
    query: query || undefined,
    type: flags.get("type") as MemoryType | undefined,
    project: flags.get("project"),
    status: (flags.get("status") as MemoryStatus | undefined) ?? "approved",
    limit: flags.has("limit") ? Number(flags.get("limit")) : undefined,
  });
  db.close();
  if (flags.get("json") === "true") {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  if (records.length === 0) {
    process.stdout.write("No matching memories.\n");
    return;
  }
  for (const r of records) {
    const snippet = r.body.replace(/\s+/g, " ").trim().slice(0, 120);
    process.stdout.write(
      `[${r.id}] (${r.type}) ${r.title} — ${r.project ?? "no-project"}\n    ${snippet}\n`,
    );
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);
  switch (cmd) {
    case "index":
      await cmdIndex(flags);
      break;
    case "search":
      await cmdSearch(positional, flags);
      break;
    case "recall":
      await cmdRecall(positional, flags);
      break;
    case "stats":
      cmdStats(flags);
      break;
    case "extract":
      await cmdExtract(flags);
      break;
    case "inbox":
      cmdInbox(flags);
      break;
    case "approve":
      cmdApprove(positional, flags);
      break;
    case "reject":
      cmdReject(positional, flags);
      break;
    case "memories":
      cmdMemories(positional, flags);
      break;
    default:
      process.stderr.write(
        "omp-episodic <command>\n\n" +
          "Commands:\n" +
          "  index    [--db PATH] [--sessions DIR] [--max N]   Index OMP transcripts\n" +
          "  search   <query> [--mode both|vector|text] [--limit N] [--after D] [--before D] [--json]\n" +
          "  recall   <task...> [--db PATH] [--project P] [--mode both|vector|text] [--tokens N] [--after D] [--before D] [--include a,b,c] [--json]\n" +
          "  stats    [--db PATH]                              Show index statistics\n" +
          "  extract  [--db PATH] [--sessions DIR] [--since YYYY-MM-DD] [--project P] [--max N]\n" +
          "  inbox    [--db PATH] [--status pending|approved|rejected|superseded] [--limit N] [--json]\n" +
          "  approve  <id> [--db PATH]                         Approve a derived memory\n" +
          "  reject   <id> [--db PATH] [--reason TEXT]         Reject a derived memory\n" +
          "  memories <query> [--db PATH] [--type T] [--project P] [--status S] [--limit N] [--json]\n",
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
