// Pure, network-free graph extraction: populate the temporal project graph
// from parsed episodes and existing derived-memory records. Deterministic
// heuristics only - no embeddings, no I/O beyond reading session files + DB.
import { openDb, runInTransaction } from "./db.js";
import {
  getGraphStats,
  upsertEdge,
  upsertEntity,
} from "./graph.js";
import { findSessionFiles } from "./indexer.js";
import { listMemoryRecords } from "./memory.js";
import { parseSessionFile } from "./parser.js";
import { backfillSupersedesEdges } from "./supersede.js";

export interface GraphExtractOptions {
  dbPath?: string;
  sessionsDir?: string;
}

export interface GraphExtractResult {
  entitiesUpserted: number;
  edgesUpserted: number;
  sessionsScanned: number;
}

/** Canonical package names detected by case-insensitive substring match. */
const KNOWN_PACKAGES: readonly string[] = [
  "sqlite-vec",
  "better-sqlite3",
  "npm",
  "bun",
  "tsx",
  "typescript",
  "xenova/all-minilm-l6-v2",
];

const ERROR_SENTENCE_RE = /\b(?:fails?|failed|error|exception|corrupt|mismatch)\b/i;

/** Split text into rough sentences for error-snippet extraction. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Normalize a matched sentence to a short error-entity name (<=60 chars). */
function errorSnippet(sentence: string): string {
  const collapsed = sentence.replace(/\s+/g, " ").trim();
  const words = collapsed.split(" ").slice(0, 6).join(" ");
  return words.length > 60 ? words.slice(0, 60).trim() : words;
}

export function extractGraph(opts: GraphExtractOptions = {}): GraphExtractResult {
  const db = openDb(opts.dbPath);
  try {
    const files = findSessionFiles(opts.sessionsDir);
    const before = getGraphStats(db);

    runInTransaction(db, () => {
      for (const file of files) {
        const exchanges = parseSessionFile(file);
        for (const ex of exchanges) {
          const provenance = {
            sourceSessionId: ex.sessionId,
            sourceOrdinal: ex.ordinal,
          };

          // PROJECT node from cwd.
          let projectId: number | null = null;
          if (ex.cwd !== null) {
            projectId = upsertEntity(db, "project", ex.cwd);
          }

          const haystack = `${ex.userText}\n${ex.assistantText}`;
          const lower = haystack.toLowerCase();

          // PACKAGE nodes via substring detection.
          for (const pkg of KNOWN_PACKAGES) {
            if (lower.includes(pkg.toLowerCase())) {
              const pkgId = upsertEntity(db, "package", pkg);
              if (projectId !== null) {
                upsertEdge(db, {
                  srcEntityId: projectId,
                  edgeType: "uses",
                  dstEntityId: pkgId,
                  validFrom: ex.timestamp,
                  confidence: 0.6,
                  ...provenance,
                });
              }
            }
          }

          // TOOL nodes.
          for (const tool of ex.toolNames) {
            const toolId = upsertEntity(db, "tool", tool);
            if (projectId !== null) {
              upsertEdge(db, {
                srcEntityId: projectId,
                edgeType: "uses",
                dstEntityId: toolId,
                validFrom: ex.timestamp,
                confidence: 0.5,
                ...provenance,
              });
            }
          }

          // ERROR nodes from failing sentences.
          for (const sentence of splitSentences(haystack)) {
            if (!ERROR_SENTENCE_RE.test(sentence)) continue;
            const name = errorSnippet(sentence);
            if (name.length === 0) continue;
            const errorId = upsertEntity(db, "error", name);
            if (projectId !== null) {
              upsertEdge(db, {
                srcEntityId: projectId,
                edgeType: "failed_with",
                dstEntityId: errorId,
                validFrom: ex.timestamp,
                confidence: 0.5,
                ...provenance,
              });
            }
          }
        }
      }

      // Link DECISION memory records to their projects (pending + approved).
      const records = [
        ...listMemoryRecords(db, "approved", 1000),
        ...listMemoryRecords(db, "pending", 1000),
      ];
      for (const record of records) {
        if (record.type !== "decision" || record.project === null) continue;
        const decisionId = upsertEntity(db, "decision", record.title);
        const projectId = upsertEntity(db, "project", record.project);
        const firstSource = record.sources[0];
        upsertEdge(db, {
          srcEntityId: decisionId,
          edgeType: "belongs_to",
          dstEntityId: projectId,
          validFrom: record.validFrom ?? undefined,
          sourceSessionId: firstSource ? firstSource.sessionId : null,
          sourceOrdinal: firstSource ? firstSource.ordinal : null,
          confidence: record.confidence,
        });
      }

      // Sync supersedes edges from existing supersedes_memory_id links, covering
      // records already marked superseded (which supersedeDecisions won't revisit).
      backfillSupersedesEdges(db);
    });

    const after = getGraphStats(db);
    return {
      entitiesUpserted: after.entities - before.entities,
      edgesUpserted: after.edges - before.edges,
      sessionsScanned: files.length,
    };
  } finally {
    db.close();
  }
}
