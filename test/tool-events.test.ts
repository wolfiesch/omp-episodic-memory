import { test } from "node:test";
import assert from "node:assert/strict";

import type { ToolEvent } from "../src/types.js";
import {
  compressToolEvents,
  parseToolEventMetadata,
  parseToolEvents,
  serializeToolEventMetadata,
} from "../src/tool-events.js";

const event: ToolEvent = {
  callId: "call-1",
  toolName: "read",
  arguments: { path: "/tmp/example.txt" },
  resultText: "repeated evidence ".repeat(2_000),
  isError: false,
  details: { displayContent: "repeated detail ".repeat(2_000) },
  exitCode: 0,
  filePaths: ["/tmp/example.txt"],
  command: null,
};

test("compressed tool events round-trip and remain smaller than JSON", () => {
  const compressed = compressToolEvents([event]);
  assert.ok(Buffer.isBuffer(compressed));
  assert.ok(compressed.byteLength < Buffer.byteLength(JSON.stringify([event])) / 4);
  assert.deepEqual(parseToolEvents(compressed), [event]);
});

test("parseToolEvents remains compatible with legacy JSON text", () => {
  assert.deepEqual(parseToolEvents(JSON.stringify([event])), [event]);
});

test("compact metadata preserves filters and bounded excerpts", () => {
  const metadata = parseToolEventMetadata(serializeToolEventMetadata([event]));
  assert.equal(metadata[0]?.toolName, "read");
  assert.equal(metadata[0]?.isError, false);
  assert.equal(metadata[0]?.exitCode, 0);
  assert.deepEqual(metadata[0]?.filePaths, ["/tmp/example.txt"]);
  assert.ok((metadata[0]?.resultExcerpt.length ?? 0) <= 512);
});
