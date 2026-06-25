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

import { openReadOnlyDb } from "./db.js";
import { initEmbeddings } from "./embeddings.js";
import { parseSessionFile } from "./parser.js";
import { search } from "./search.js";
import { recallForTask, formatBundle } from "./recall.js";
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
  { name: "omp-episodic-memory", version: "0.1.0" },
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
