import assert from "node:assert/strict";
import { test } from "node:test";

import { redactSecrets, redactToolEvent } from "../src/redact.js";
import type { ToolEvent } from "../src/types.js";

const OPENAI_KEY = `sk-${"A".repeat(30)}`;
const AWS_KEY = `AKIA${"A".repeat(16)}`;
const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;

test("redactSecrets scrubs common secret patterns and preserves benign text", () => {
  const privateKey = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
  const input = [
    `openai=${OPENAI_KEY}`,
    "Authorization: Bearer abcdefghijklmnop.qrst-uvwx",
    `aws=${AWS_KEY}`,
    `github=${GITHUB_TOKEN}`,
    privateKey,
    "DATABASE_PASSWORD=super-secret",
    "short sk-nope and ordinary name=value stay",
  ].join("\n");

  const redacted = redactSecrets(input);
  assert.equal(redacted.includes(OPENAI_KEY), false);
  assert.doesNotMatch(redacted, /Bearer abcdefghijklmnop/);
  assert.equal(redacted.includes(AWS_KEY), false);
  assert.equal(redacted.includes(GITHUB_TOKEN), false);
  assert.doesNotMatch(redacted, /BEGIN PRIVATE KEY/);
  assert.match(redacted, /DATABASE_PASSWORD=\[REDACTED\]/);
  assert.match(redacted, /short sk-nope/);
  assert.match(redacted, /ordinary name=value stay/);
});

test("redactToolEvent scrubs nested arguments, details, command, and result", () => {
  const event: ToolEvent = {
    callId: "t1",
    toolName: "bash",
    arguments: {
      env: { OPENAI_API_KEY: OPENAI_KEY, PASSWORD: "hunter2" },
      command: `echo ${OPENAI_KEY}`,
    },
    resultText: `token ${OPENAI_KEY}`,
    isError: false,
    details: { nested: { token: `Bearer abcdefghijklmnop`, apiKey: "abc123" } },
    exitCode: 0,
    filePaths: ["/tmp/file"],
    command: `echo ${OPENAI_KEY}`,
  };

  const redacted = redactToolEvent(event);
  const json = JSON.stringify(redacted);
  assert.doesNotMatch(json, /ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/);
  assert.doesNotMatch(json, /Bearer abcdefghijklmnop/);
  assert.doesNotMatch(json, /hunter2/);
  assert.doesNotMatch(json, /abc123/);
  assert.match(json, /\[REDACTED\]/);
  assert.equal(event.resultText?.includes(OPENAI_KEY), true, "returns a new event without mutating input");
});
