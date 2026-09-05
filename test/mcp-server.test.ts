import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDb, insertExchange, type InsertableExchange } from "../src/db.js";
import { EMBEDDING_DIM } from "../src/types.js";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};


type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

type ToolDefinition = {
  name: string;
  inputSchema: {
    properties?: Record<string, { description?: unknown }>;
  };
};

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return response.jsonrpc === "2.0" && typeof response.id === "number";
}

function resultOf<T>(response: JsonRpcResponse): T {
  assert.equal(response.error, undefined, response.error?.message);
  assert.notEqual(response.result, undefined, "MCP response must have a result");
  return response.result as T;
}

function textOf(result: ToolResult): string {
  assert.equal(result.isError, undefined, "MCP tool call must not return an error result");
  const textContent = result.content.find((content) => content.type === "text");
  assert.ok(textContent && typeof textContent.text === "string", "MCP tool result must contain text");
  return textContent.text;
}

class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly responses = new EventEmitter();
  private buffer = "";
  private nextId = 1;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, ["--import", "tsx", "src/mcp-server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stdin.on("error", (error) => this.failRequest(error));
    this.child.on("error", (error) => this.failRequest(error));
    this.child.on("exit", (code, signal) => {
      this.failRequest(new Error(`MCP server exited before responding (code ${code}, signal ${signal})`));
    });
  }

  async initialize(): Promise<void> {
    const response = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-server-test", version: "1.0.0" },
    });
    resultOf(response);
    this.notify("notifications/initialized", {});
  }

  request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const response = once(this.responses, String(id)).then(
      ([message]) => message as JsonRpcResponse,
    );
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.kill();
    await exited;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.failRequest(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!isJsonRpcResponse(message)) continue;
      this.responses.emit(String(message.id), message);
    }
  }

  private failRequest(error: Error): void {
    if (this.responses.listenerCount("error") > 0) {
      this.responses.emit("error", error);
    }
  }
}

function exchange(ordinal: number, timestamp: string, text: string, sourcePath: string): InsertableExchange {
  return {
    sessionId: `mcp-date-filter-${ordinal}`,
    sourcePath,
    title: "MCP date filter fixture",
    cwd: "/fixture/mcp-date-filter",
    ordinal,
    timestamp: Math.floor(Date.parse(timestamp) / 1000),
    userText: text,
    assistantText: "ISO date filter fixture response",
    toolNames: [],
    toolEvents: [],
    embedding: new Float32Array(EMBEDDING_DIM),
  };
}

test("MCP search and recall accept ISO datetime filters", async () => {
  const root = mkdtempSync(join(tmpdir(), `omp-mcp-date-filter-${randomUUID()}-`));
  const dbPath = join(root, "index.db");
  const sessionsDir = join(root, "sessions");
  const sourcePath = join(sessionsDir, "fixture.jsonl");
  const db = openDb(dbPath);
  insertExchange(db, exchange(0, "2026-09-04T18:30:00Z", "ISO_FILTER_SENTINEL earlier evidence", sourcePath));
  insertExchange(db, exchange(1, "2026-09-04T19:30:00Z", "ISO_FILTER_SENTINEL later evidence", sourcePath));
  db.close();

  const client = new McpStdioClient({
    OMP_EPISODIC_DB: dbPath,
    OMP_EPISODIC_SESSIONS_DIR: sessionsDir,
  });
  try {
    await client.initialize();

    const listed = resultOf<{ tools: ToolDefinition[] }>(await client.request("tools/list", {}));
    for (const name of ["search", "recall_for_task"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} must be advertised`);
      for (const property of ["after", "before"]) {
        assert.equal(
          tool.inputSchema.properties?.[property]?.description,
          "Date filter: YYYY-MM-DD or ISO 8601 datetime (e.g. 2026-09-04 or 2026-09-04T20:00:00Z)",
        );
      }
    }

    const beforeUtc = JSON.parse(
      textOf(
        resultOf<ToolResult>(
          await client.request("tools/call", {
            name: "search",
            arguments: {
              query: "ISO_FILTER_SENTINEL",
              mode: "text",
              response_format: "json",
              before: "2026-09-04T18:45:00Z",
            },
          }),
        ),
      ),
    ) as { results: Array<{ ordinal: number }> };
    assert.deepEqual(beforeUtc.results.map((result) => result.ordinal), [0]);

    const afterOffset = JSON.parse(
      textOf(
        resultOf<ToolResult>(
          await client.request("tools/call", {
            name: "search",
            arguments: {
              query: "ISO_FILTER_SENTINEL",
              mode: "text",
              response_format: "json",
              after: "2026-09-04T15:00:00-04:00",
            },
          }),
        ),
      ),
    ) as { results: Array<{ ordinal: number }> };
    assert.deepEqual(afterOffset.results.map((result) => result.ordinal), [1]);

    const bareDate = JSON.parse(
      textOf(
        resultOf<ToolResult>(
          await client.request("tools/call", {
            name: "search",
            arguments: {
              query: "ISO_FILTER_SENTINEL",
              mode: "text",
              response_format: "json",
              after: "2026-09-04",
            },
          }),
        ),
      ),
    ) as { results: Array<{ ordinal: number }> };
    assert.deepEqual(bareDate.results.map((result) => result.ordinal).sort(), [0, 1]);

    const recalled = JSON.parse(
      textOf(
        resultOf<ToolResult>(
          await client.request("tools/call", {
            name: "recall_for_task",
            arguments: {
              task: "Locate ISO_FILTER_SENTINEL evidence",
              include: ["episodes"],
              mode: "text",
              response_format: "json",
              after: "2026-09-04T15:00:00-04:00",
            },
          }),
        ),
      ),
    ) as { sections: { episodes: Array<{ ordinal: number }> } };
    assert.deepEqual(recalled.sections.episodes.map((episode) => episode.ordinal), [1]);

    for (const [name, arguments_] of [
      ["search", { query: "ISO_FILTER_SENTINEL", mode: "text", after: "2026/09/04" }],
      ["recall_for_task", { task: "Locate ISO_FILTER_SENTINEL evidence", mode: "text", after: "2026/09/04" }],
    ]) {
      const invalid = await client.request("tools/call", { name, arguments: arguments_ });
      if (invalid.error) {
        assert.ok(invalid.error.message.length > 0);
      } else {
        assert.equal((invalid.result as ToolResult).isError, true);
      }
    }
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
