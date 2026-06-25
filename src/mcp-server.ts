#!/usr/bin/env node
/**
 * MCP server for omp-episodic-memory.
 *
 * Exposes hybrid (semantic + keyword) search over OMP session transcripts plus
 * a read tool to pull a full conversation back. Pure read path: it queries the
 * prebuilt index DB and reads source JSONL files; it never writes to ~/.omp.
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { openDb, openReadOnlyDb } from "./db.js";
import { initEmbeddings } from "./embeddings.js";
import { parseSessionFile } from "./parser.js";
import { search } from "./search.js";
import { recallForTask, formatBundle } from "./recall.js";
import { searchMemoryRecords, type MemoryRecord } from "./memory.js";
import { getProjectContext, type ProjectContext } from "./blocks.js";
import { DEFAULT_DB_PATH, DEFAULT_SESSIONS_DIR, type SearchHit } from "./types.js";

const DB_PATH = process.env.OMP_EPISODIC_DB ?? DEFAULT_DB_PATH;
const SESSIONS_ROOT = process.env.OMP_EPISODIC_SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;

const SearchInputSchema = z
  .object({
    query: z.string().min(2),
    mode: z.enum(["vector", "text", "both"]).default("both"),
    limit: z.number().min(1).max(50).default(10),
    after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    response_format: z.enum(["markdown", "json"]).default("markdown"),
  })
  .strict();

const ReadInputSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().min(1).optional(),
    endLine: z.number().min(1).optional(),
  })
  .strict();

const RecallInputSchema = z
  .object({
    task: z.string().min(3),
    project: z.string().optional(),
    include: z.array(z.enum(["episodes", "memories", "runbooks", "gotchas", "decisions"])).optional(),
    mode: z.enum(["vector", "text", "both"]).default("both"),
    max_context_tokens: z.number().min(100).max(8000).default(2000),
    after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    response_format: z.enum(["markdown", "json"]).default("markdown"),
  })
  .strict();

const GotchasInputSchema = z
  .object({
    query: z.string().optional(),
    project: z.string().optional(),
    limit: z.number().min(1).max(50).default(10),
    response_format: z.enum(["markdown", "json"]).default("markdown"),
  })
  .strict();

const ProjectContextInputSchema = z
  .object({
    project: z.string().optional(),
    limit: z.number().min(1).max(20).default(5),
    response_format: z.enum(["markdown", "json"]).default("markdown"),
  })
  .strict();

function toEpochSeconds(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const ms = Date.parse(dateStr);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

function resolveSessionPath(path: string): string {
  const resolved = resolve(path);
  const sessionsRoot = resolve(SESSIONS_ROOT);
  const rel = relative(sessionsRoot, resolved);
  if (rel.startsWith("..") || rel === "" || resolve(sessionsRoot, rel) !== resolved) {
    throw new Error(`Path is outside configured sessions directory: ${path}`);
  }
  return resolved;
}

function handleError(error: unknown): string {
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

function formatHits(hits: SearchHit[], query: string): string {
  if (hits.length === 0) return `No results for "${query}".`;
  const lines: string[] = [`Found ${hits.length} result(s) for "${query}":`, ""];
  hits.forEach((h, i) => {
    const date = new Date(h.timestamp * 1000).toISOString().slice(0, 10);
    const proj = h.cwd ? h.cwd.split("/").pop() : (h.title ?? "session");
    const signals = [
      h.vectorRank ? `vec#${h.vectorRank}` : null,
      h.textRank ? `kw#${h.textRank}` : null,
    ]
      .filter(Boolean)
      .join(",");
    lines.push(
      `${i + 1}. [${proj}, ${date}] score=${h.score.toFixed(4)} (${signals})`,
      `   "${h.snippet}"`,
      `   ${h.sourcePath} (exchange ${h.ordinal})`,
      "",
    );
  });
  return lines.join("\n");
}

function formatMemoryRecord(r: MemoryRecord): string {
  const src = r.sources[0];
  const loc = src ? ` — ${src.sourcePath}#${src.ordinal}` : "";
  const body = r.body.replace(/\s+/g, " ").trim().slice(0, 240);
  return `- (${r.type}, conf ${r.confidence.toFixed(2)}) ${r.title}${loc}\n  ${body}`;
}

function formatGotchas(records: MemoryRecord[]): string {
  if (records.length === 0) return "No gotchas found.";
  return [`Found ${records.length} gotcha(s):`, "", ...records.map(formatMemoryRecord)].join("\n");
}

function formatProjectContext(ctx: ProjectContext): string {
  const lines: string[] = [`# Project context${ctx.project ? `: ${ctx.project}` : " (global)"}`, ""];
  if (ctx.blocks.length > 0) {
    lines.push("## Pinned blocks");
    for (const b of ctx.blocks) lines.push(`- [${b.kind}] ${b.content.replace(/\s+/g, " ").trim()}`);
    lines.push("");
  }
  const section = (label: string, recs: MemoryRecord[]): void => {
    if (recs.length === 0) return;
    lines.push(`## ${label}`);
    for (const r of recs) lines.push(formatMemoryRecord(r));
    lines.push("");
  };
  section("Recent decisions", ctx.recentDecisions);
  section("Gotchas", ctx.gotchas);
  section("Runbooks", ctx.runbooks);
  if (lines.length <= 2) lines.push("No pinned context or derived memories yet.");
  return lines.join("\n").trim();
}

function formatConversation(
  path: string,
  startLine?: number,
  endLine?: number,
): string {
  const exchanges = parseSessionFile(path);
  if (exchanges.length === 0) return `No exchanges parsed from ${path}.`;
  const header = exchanges[0];
  const out: string[] = [
    `# ${header.title ?? "OMP session"}`,
    `Session: ${header.sessionId}`,
    header.cwd ? `Directory: ${header.cwd}` : "",
    `Exchanges: ${exchanges.length}`,
    "",
  ].filter((l) => l !== "");
  for (const ex of exchanges) {
    out.push(`## Exchange ${ex.ordinal}`);
    if (ex.userText) out.push(`**User:** ${ex.userText}`, "");
    if (ex.toolNames.length > 0) out.push(`_Tools: ${ex.toolNames.join(", ")}_`, "");
    if (ex.assistantText) out.push(`**Assistant:** ${ex.assistantText}`, "");
  }
  const allLines = out.join("\n").split("\n");
  const from = startLine ? startLine - 1 : 0;
  const to = endLine ?? allLines.length;
  return allLines.slice(from, to).join("\n");
}

const server = new Server(
  { name: "omp-episodic-memory", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search",
      description:
        "Search your past Oh My Pi sessions to recover decisions, solutions, and context. Hybrid semantic + keyword retrieval over full conversation transcripts. Use BEFORE a task to avoid reinventing prior work. Returns ranked hits with project, date, snippet, and source path.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2 },
          mode: { type: "string", enum: ["vector", "text", "both"], default: "both" },
          limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
          after: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          before: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: {
        title: "Search OMP Episodic Memory",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "read",
      description:
        "Read a full OMP session transcript (rendered as markdown) after locating it with search. Use startLine/endLine (1-indexed) to paginate large conversations.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          startLine: { type: "number", minimum: 1 },
          endLine: { type: "number", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: {
        title: "Read OMP Conversation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "recall_for_task",
      description:
        "Before starting a coding task, retrieve an evidence-backed context packet from prior OMP sessions — distilled decisions, runbooks, and gotchas plus raw episode citations, with a confidence tier and explicit abstention when nothing relevant exists.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", minLength: 3 },
          project: { type: "string" },
          include: {
            type: "array",
            items: { type: "string", enum: ["episodes", "memories", "runbooks", "gotchas", "decisions"] },
          },
          mode: { type: "string", enum: ["vector", "text", "both"], default: "both" },
          max_context_tokens: { type: "number", minimum: 100, maximum: 8000, default: 2000 },
          after: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          before: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      annotations: {
        title: "Recall Prior Experience",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "list_gotchas",
      description:
        "List failure-mode memories (gotchas) for a project or task before acting, so the agent avoids repeating a prior mistake. Returns approved gotcha records with provenance.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          project: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 50, default: 10 },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "List Gotchas",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "get_project_context",
      description:
        "Return pinned project context (rules, workflow preferences, known risks, positioning) plus recent approved decisions, gotchas, and runbooks for a project. Use at the start of work in a repo.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 20, default: 5 },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Get Project Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (name === "search") {
      const params = SearchInputSchema.parse(args);
      const db = openReadOnlyDb(DB_PATH);
      try {
        const hits = await search(db, {
          query: params.query,
          mode: params.mode,
          limit: params.limit,
          after: toEpochSeconds(params.after),
          before: toEpochSeconds(params.before),
        });
        const text =
          params.response_format === "json"
            ? JSON.stringify({ results: hits, count: hits.length, mode: params.mode }, null, 2)
            : formatHits(hits, params.query);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
      }
    }

    if (name === "recall_for_task") {
      const params = RecallInputSchema.parse(args);
      const db = openReadOnlyDb(DB_PATH);
      try {
        const bundle = await recallForTask(db, {
          task: params.task,
          project: params.project,
          include: params.include,
          mode: params.mode,
          maxContextTokens: params.max_context_tokens,
          after: toEpochSeconds(params.after),
          before: toEpochSeconds(params.before),
        });
        const text =
          params.response_format === "json"
            ? JSON.stringify(bundle, null, 2)
            : formatBundle(bundle);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
      }
    }

    if (name === "list_gotchas") {
      const params = GotchasInputSchema.parse(args);
      const db = openReadOnlyDb(DB_PATH);
      try {
        const records = searchMemoryRecords(db, {
          query: params.query,
          type: "gotcha",
          project: params.project,
          status: "approved",
          limit: params.limit,
        });
        const text =
          params.response_format === "json"
            ? JSON.stringify({ gotchas: records, count: records.length }, null, 2)
            : formatGotchas(records);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
      }
    }

    if (name === "get_project_context") {
      const params = ProjectContextInputSchema.parse(args);
      const db = openReadOnlyDb(DB_PATH);
      try {
        const ctx = getProjectContext(db, { project: params.project, limit: params.limit });
        const text =
          params.response_format === "json"
            ? JSON.stringify(ctx, null, 2)
            : formatProjectContext(ctx);
        return { content: [{ type: "text", text }] };
      } finally {
        db.close();
      }
    }

    if (name === "read") {
      const params = ReadInputSchema.parse(args);
      const path = resolveSessionPath(params.path);
      if (!existsSync(path)) {
        throw new Error(`File not found: ${path}`);
      }
      const text = formatConversation(path, params.startLine, params.endLine);
      return { content: [{ type: "text", text }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return { content: [{ type: "text", text: handleError(error) }], isError: true };
  }
});

async function main(): Promise<void> {
  console.error("omp-episodic-memory MCP server running via stdio");
  // Migrate: if the index DB already exists, open it writable once so any
  // schemas added in newer versions (memory/graph/blocks) are created before
  // we serve read-only queries against pre-existing DBs.
  if (existsSync(DB_PATH)) {
    try {
      openDb(DB_PATH).close();
    } catch (error) {
      console.error("Schema migration skipped:", error instanceof Error ? error.message : String(error));
    }
  }
  void initEmbeddings().catch((error) => {
    console.error("Embedding prewarm failed:", error instanceof Error ? error.message : String(error));
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
