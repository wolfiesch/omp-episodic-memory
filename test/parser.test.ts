import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isSessionFile, parseSessionFile, parseSessionFileStream } from "../src/parser.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures", "sessions");
const fixtureA = join(
	fixturesDir,
	"2026-06-20T10-00-00-000Z_aaaaaaaa-0000-7000-8000-000000000001.jsonl",
);

test("parseSessionFile returns session metadata and two exchanges", () => {
	const exchanges = parseSessionFile(fixtureA);
	assert.equal(exchanges.length, 2);
	for (const ex of exchanges) {
		assert.equal(ex.sessionId, "aaaaaaaa-0000-7000-8000-000000000001");
		assert.equal(ex.title, "Fix sqlite-vec install failure on macOS");
		assert.equal(ex.cwd, "/Users/dev/proj-api");
	}
});

test("ordinals are sequential from 0 and timestamps are unix seconds", () => {
	const exchanges = parseSessionFile(fixtureA);
	assert.deepEqual(
		exchanges.map((ex) => ex.ordinal),
		[0, 1],
	);
	assert.equal(exchanges[0].timestamp, 1781950801);
	assert.equal(exchanges[0].timestamp, Math.floor(1781950801000 / 1000));
});

test("toolNames extraction per exchange", () => {
	const exchanges = parseSessionFile(fixtureA);
	assert.ok(exchanges[0].toolNames.includes("bash"));
	assert.deepEqual(exchanges[1].toolNames, []);
});

test("assistantText and userText are captured", () => {
	const exchanges = parseSessionFile(fixtureA);
	assert.ok(exchanges[0].assistantText.length > 0);
	assert.ok(exchanges[0].assistantText.includes("known gotcha"));
	assert.equal(
		exchanges[0].userText,
		"The sqlite-vec native install fails on macOS with a dyld symbol error. How do we fix this?",
	);
});

test("exchanges with empty userText are skipped", () => {
	const exchanges = parseSessionFile(fixtureA);
	for (const ex of exchanges) {
		assert.ok(ex.userText.trim().length > 0);
	}
});

test("isSessionFile recognizes .jsonl only", () => {
	assert.equal(isSessionFile("foo.jsonl"), true);
	assert.equal(isSessionFile("foo.json"), false);
	assert.equal(isSessionFile("foo.txt"), false);
});

test("parseSessionFile tolerates malformed lines", () => {
	const dir = mkdtempSync(join(tmpdir(), "parser-test-"));
	const tmpFile = join(
		dir,
		"2026-06-20T10-00-00-000Z_dddddddd-0000-7000-8000-000000000004.jsonl",
	);
	const lines = [
		'{"type":"session","version":3,"id":"dddddddd-0000-7000-8000-000000000004","timestamp":"2026-06-20T10:00:00.000Z","cwd":"/tmp/proj","title":"Robustness","titleSource":"auto"}',
		"{not json",
		'{"type":"message","id":"u1","timestamp":"2026-06-20T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1781950801000}}',
		'{"type":"message","id":"a1","timestamp":"2026-06-20T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi there"}],"timestamp":1781950805000}}',
	];
	writeFileSync(tmpFile, lines.join("\n"));
	try {
		const exchanges = parseSessionFile(tmpFile);
		assert.equal(exchanges.length, 1);
		assert.equal(exchanges[0].userText, "hello");
		assert.equal(exchanges[0].assistantText, "hi there");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseSessionFileStream parity with parseSessionFile", async () => {
	const exchangesSync = parseSessionFile(fixtureA);
	const exchangesStream = await parseSessionFileStream(fixtureA);
	assert.equal(exchangesStream.length, exchangesSync.length);
	assert.equal(exchangesStream.length, 2);
	assert.equal(exchangesStream[0].userText, exchangesSync[0].userText);
	assert.equal(exchangesStream[0].assistantText, exchangesSync[0].assistantText);
	assert.deepEqual(exchangesStream[0].toolNames, exchangesSync[0].toolNames);
	assert.equal(exchangesStream[0].sessionId, exchangesSync[0].sessionId);
	assert.equal(exchangesStream[0].title, exchangesSync[0].title);
	assert.equal(exchangesStream[0].cwd, exchangesSync[0].cwd);
	assert.equal(exchangesStream[0].timestamp, exchangesSync[0].timestamp);
});

test("parseSessionFileStream and parseSessionFile throw error when file exceeds maxBytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "parser-size-test-"));
	const tmpFile = join(
		dir,
		"2026-06-20T10-00-00-000Z_dddddddd-0000-7000-8000-000000000005.jsonl",
	);
	const lines = [
		'{"type":"session","version":3,"id":"dddddddd-0000-7000-8000-000000000005","timestamp":"2026-06-20T10:00:00.000Z","cwd":"/tmp/proj","title":"SizeLimit"}',
		'{"type":"message","id":"u1","timestamp":"2026-06-20T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
		'{"type":"message","id":"a1","timestamp":"2026-06-20T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
	];
	writeFileSync(tmpFile, lines.join("\n"));
	try {
		// Sync parser throws
		assert.throws(() => {
			parseSessionFile(tmpFile, { maxBytes: 10 });
		}, (err: any) => {
			return err instanceof Error && err.message.startsWith("session file too large");
		});

		// Stream parser throws
		await assert.rejects(async () => {
			await parseSessionFileStream(tmpFile, { maxBytes: 10 });
		}, (err: any) => {
			return err instanceof Error && err.message.startsWith("session file too large");
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseSessionFileStream and parseSessionFile clip text when it exceeds maxExchangeChars", async () => {
	const dir = mkdtempSync(join(tmpdir(), "parser-clip-test-"));
	const tmpFile = join(
		dir,
		"2026-06-20T10-00-00-000Z_dddddddd-0000-7000-8000-000000000006.jsonl",
	);
	const longText = "a".repeat(150);
	const lines = [
		'{"type":"session","version":3,"id":"dddddddd-0000-7000-8000-000000000006","timestamp":"2026-06-20T10:00:00.000Z","cwd":"/tmp/proj","title":"ClipLimit"}',
		`{"type":"message","id":"u1","timestamp":"2026-06-20T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"${longText}"}]}}`,
		`{"type":"message","id":"a1","timestamp":"2026-06-20T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"${longText}"}]}}`,
	];
	writeFileSync(tmpFile, lines.join("\n"));
	try {
		// Test sync
		const exchangesSync = parseSessionFile(tmpFile, { maxExchangeChars: 10 });
		assert.equal(exchangesSync.length, 1);
		assert.equal(exchangesSync[0].userText, "a".repeat(10) + "\n\u2026[clipped 140 chars]");
		assert.equal(exchangesSync[0].assistantText, "a".repeat(10) + "\n\u2026[clipped 140 chars]");

		// Test stream
		const exchangesStream = await parseSessionFileStream(tmpFile, { maxExchangeChars: 10 });
		assert.equal(exchangesStream.length, 1);
		assert.equal(exchangesStream[0].userText, "a".repeat(10) + "\n\u2026[clipped 140 chars]");
		assert.equal(exchangesStream[0].assistantText, "a".repeat(10) + "\n\u2026[clipped 140 chars]");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseSessionFileStream and parseSessionFile skip only pathologically long raw lines", async () => {
	const dir = mkdtempSync(join(tmpdir(), "parser-oversized-line-"));
	const tmpFile = join(
		dir,
		"2026-06-20T10-00-00-000Z_dddddddd-0000-7000-8000-000000000007.jsonl",
	);
	const normalSession = '{"type":"session","id":"s7"}';
	const normalUser = '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}';
	const normalAssistant = '{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}';
	// A line beyond the absolute 10MB sanity bound must be skipped regardless of maxExchangeChars.
	const pathologicalUser =
		'{"type":"message","message":{"role":"user","content":[{"type":"text","text":"' +
		"a".repeat(11_000_000) +
		'"}]}}';

	writeFileSync(tmpFile, [normalSession, pathologicalUser, normalUser, normalAssistant].join("\n"));
	try {
		// The pathological line is skipped; the normal exchange survives. A small
		// maxExchangeChars must NOT drop normal-sized lines (only clip their content).
		const exchangesSync = parseSessionFile(tmpFile, { maxExchangeChars: 30 });
		assert.equal(exchangesSync.length, 1);
		assert.equal(exchangesSync[0].userText, "hi");
		assert.equal(exchangesSync[0].assistantText, "hello");

		const exchangesStream = await parseSessionFileStream(tmpFile, { maxExchangeChars: 30 });
		assert.equal(exchangesStream.length, 1);
		assert.equal(exchangesStream[0].userText, "hi");
		assert.equal(exchangesStream[0].assistantText, "hello");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
