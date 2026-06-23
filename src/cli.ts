#!/usr/bin/env node
// CLI for omp-episodic-memory: index / search / stats over OMP transcripts.
// stdout = results only; all status/progress goes to stderr.
import { openReadOnlyDb, getStats } from "./db.js";
import { indexAll } from "./indexer.js";
import { search } from "./search.js";
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
    case "stats":
      cmdStats(flags);
      break;
    default:
      process.stderr.write(
        "omp-episodic <command>\n\n" +
          "Commands:\n" +
          "  index   [--db PATH] [--sessions DIR] [--max N]   Index OMP transcripts\n" +
          "  search  <query> [--mode both|vector|text] [--limit N] [--after D] [--before D] [--json]\n" +
          "  stats   [--db PATH]                              Show index statistics\n",
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
