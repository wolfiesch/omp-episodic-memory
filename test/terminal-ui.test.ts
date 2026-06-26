import assert from "node:assert/strict";
import { test } from "node:test";

import {
  colorize,
  renderInboxPanel,
  renderRecallPanel,
  renderSearchPanel,
  shouldUseTerminalUi,
  stripAnsi,
} from "../src/terminal-ui.js";
import type { RecallBundle } from "../src/recall.js";
import type { SearchHit } from "../src/types.js";
import type { MemoryRecord } from "../src/memory.js";

const hit: SearchHit = {
  sessionId: "sess-1",
  sourcePath: "/tmp/sessions/sess-1.jsonl",
  title: "Fix sqlite-vec install",
  cwd: "/Users/dev/omp-episodic-memory",
  ordinal: 2,
  timestamp: Date.UTC(2026, 5, 20) / 1000,
  snippet: "U: why did sqlite-vec fail? | A: dyld symbol mismatch with native package",
  userSnippet: "why did sqlite-vec fail?",
  assistantSnippet: "dyld symbol mismatch with native package",
  toolEvents: [],
  score: 0.87,
  vectorRank: 1,
  textRank: 3,
};

const bundle: RecallBundle = {
  answerable: true,
  confidence: "high",
  intents: ["decision", "gotcha"],
  memoryTypesUsed: ["decision", "gotcha"],
  summary: "Found prior evidence for sqlite-vec failure.",
  suggestedContext: "Use sqlite-vec 0.1.6 and avoid rebuilding native bindings.",
  evidence: [
    {
      kind: "gotcha",
      title: "sqlite-vec native install mismatch",
      date: "2026-06-20",
      path: "/tmp/sessions/sess-1.jsonl",
      ordinal: 2,
      sessionId: "sess-1",
      quote: "The prebuilt binary can mismatch the Node ABI.",
      score: 0.9,
    },
  ],
  recommendedNextSteps: ["Pin the sqlite-vec version", "Run node --test"],
};

const memory: MemoryRecord = {
  id: 7,
  type: "gotcha",
  title: "Native module ABI mismatch",
  body: "Avoid rebuilding sqlite native bindings with a mismatched runtime.",
  project: "/Users/dev/omp-episodic-memory",
  entities: [],
  validFrom: 100,
  validTo: null,
  confidence: 0.76,
  status: "pending",
  createdAt: 100,
  updatedAt: 100,
  reviewedAt: null,
  reviewReason: null,
  sources: [{ sessionId: "sess-1", ordinal: 2, sourcePath: "/tmp/sessions/sess-1.jsonl" }],
};

test("shouldUseTerminalUi requires TTY and never enables for json", () => {
  assert.equal(shouldUseTerminalUi({ isTty: true, json: false, requested: true }), true);
  assert.equal(shouldUseTerminalUi({ isTty: false, json: false, requested: true }), false);
  assert.equal(shouldUseTerminalUi({ isTty: true, json: true, requested: true }), false);
  assert.equal(shouldUseTerminalUi({ isTty: true, json: false, env: "1" }), true);
});

test("colorize only emits ANSI when enabled", () => {
  assert.match(colorize("Recall", "cyan", true), /\x1b\[/);
  assert.equal(colorize("Recall", "cyan", false), "Recall");
  assert.equal(stripAnsi(colorize("Recall", "cyan", true)), "Recall");
});

test("renderSearchPanel creates an OMP-branded card with evidence snippets", () => {
  const out = renderSearchPanel("sqlite-vec", [hit], { ansi: true, width: 80 });
  assert.match(out, /π recall/);
  assert.match(out, /sqlite-vec/);
  assert.match(out, /#1/);
  assert.match(out, /vec#1/);
  assert.match(out, /dyld symbol mismatch/);
  assert.match(out, /\x1b\[/);
});

test("renderRecallPanel highlights confidence, evidence, and next actions", () => {
  const out = renderRecallPanel(bundle, { ansi: false, width: 88 });
  assert.match(out, /π recall/);
  assert.match(out, /confidence: high/);
  assert.match(out, /Evidence/);
  assert.match(out, /sqlite-vec native install mismatch/);
  assert.match(out, /Next/);
  assert.doesNotMatch(out, /\x1b\[/);
});

test("renderInboxPanel groups review records without ANSI in plain mode", () => {
  const out = renderInboxPanel("pending", [memory], { ansi: false, width: 78 });
  assert.match(out, /Review inbox/);
  assert.match(out, /pending/);
  assert.match(out, /Native module ABI mismatch/);
  assert.match(out, /approve 7/);
  assert.doesNotMatch(out, /\x1b\[/);
});
