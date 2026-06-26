import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatScaffoldJsonl,
  scaffoldLabels,
} from "../src/label-scaffold.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS = join(HERE, "fixtures", "sessions");

test("scaffoldLabels emits well-formed template rows from real fixtures", () => {
  const rows = scaffoldLabels({ sessionsDir: SESSIONS });
  assert.ok(rows.length > 0, "expected >0 rows");
  for (const row of rows) {
    assert.ok(row.sessionId.length > 0, "expected non-empty sessionId");
    assert.ok(row.ordinal >= 0, "expected ordinal >= 0");
    assert.ok(row.titleSubstring.length > 0, "expected non-empty titleSubstring");
    assert.equal(row.correct, true);
    assert.equal(typeof row.title, "string");
    assert.equal(typeof row.matchedText, "string");
    assert.equal(typeof row.rule, "string");
  }
});

test("scaffoldLabels respects opts.limit", () => {
  const rows = scaffoldLabels({ sessionsDir: SESSIONS, limit: 2 });
  assert.ok(rows.length <= 2);
});

test("formatScaffoldJsonl round-trips one JSON object per row", () => {
  const rows = scaffoldLabels({ sessionsDir: SESSIONS });
  const parsed = formatScaffoldJsonl(rows)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(parsed.length, rows.length);
  assert.ok("titleSubstring" in parsed[0]);
});
