import { createReadStream, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";

import type { Exchange } from "./types.js";

export function isSessionFile(name: string): boolean {
	return name.endsWith(".jsonl");
}

interface ContentPart {
	type: string;
	text?: string;
	name?: string;
}

interface MessagePayload {
	role?: string;
	content?: unknown;
	timestamp?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}


function extractContentParts(content: unknown): ContentPart[] {
	if (!Array.isArray(content)) return [];
	const parts: ContentPart[] = [];
	for (const item of content) {
		if (isRecord(item) && typeof item.type === "string") {
			const text = typeof item.text === "string" ? item.text : undefined;
			const name = typeof item.name === "string" ? item.name : undefined;
			parts.push({ type: item.type, text, name });
		}
	}
	return parts;
}

function readMessagePayload(event: Record<string, unknown>): MessagePayload | null {
	const message = event.message;
	if (!isRecord(message)) return null;
	const role = typeof message.role === "string" ? message.role : undefined;
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
	return { role, content: message.content, timestamp };
}

function sessionIdFromFilename(filePath: string): string {
	const base = basename(filePath).replace(/\.jsonl$/, "");
	const underscore = base.lastIndexOf("_");
	return underscore >= 0 ? base.slice(underscore + 1) : base;
}

function timestampFromFilename(filePath: string): number {
	const base = basename(filePath).replace(/\.jsonl$/, "");
	const prefix = base.split("_", 1)[0]?.replace(
		/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
		"$1T$2:$3:$4.$5Z",
	);
	if (!prefix) return 0;
	const ms = Date.parse(prefix);
	return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

interface PendingExchange {
	userText: string;
	assistantText: string[];
	/** Running char count of accumulated assistantText, to bound memory while appending. */
	assistantLen: number;
	/** Total assistant chars dropped past the cap, for an honest clip marker at flush. */
	assistantDropped: number;
	toolNames: string[];
	timestamp: number;
	ordinal: number;
}

function clipText(text: string, max: number): string {
	if (text.length > max) {
		const clipped = text.length - max;
		return text.slice(0, max) + `\n\u2026[clipped ${clipped} chars]`;
	}
	return text;
}

function flushPending(
	state: {
		sessionId: string | null;
		title: string | null;
		cwd: string | null;
		pending: PendingExchange | null;
		exchanges: Exchange[];
	},
	filePath: string,
	maxExchangeChars: number
): void {
	const pending = state.pending;
	if (pending === null) return;
	if (pending.userText.trim().length > 0) {
		const userText = pending.userText;
		const joined = pending.assistantText.join("\n\n");
		const assistantText =
			pending.assistantDropped > 0
				? `${joined}\n\u2026[clipped ${pending.assistantDropped} chars]`
				: joined;
		state.exchanges.push({
			sessionId: state.sessionId as string,
			sourcePath: filePath,
			title: state.title,
			cwd: state.cwd,
			ordinal: pending.ordinal,
			timestamp: pending.timestamp,
			userText,
			assistantText,
			toolNames: pending.toolNames,
		});
	}
	state.pending = null;
}

function processMessageEvent(
	event: Record<string, unknown>,
	state: {
		sessionId: string | null;
		title: string | null;
		cwd: string | null;
		headerTimestamp: number;
		pending: PendingExchange | null;
		ordinal: number;
		exchanges: Exchange[];
	},
	filePath: string,
	maxExchangeChars: number
): void {
	const payload = readMessagePayload(event);
	if (payload === null) return;
	const parts = extractContentParts(payload.content);

	if (payload.role === "user") {
		const userTexts: string[] = [];
		for (const part of parts) {
			if (part.type === "text" && part.text && part.text.length > 0) {
				userTexts.push(part.text);
			}
		}
		if (userTexts.length === 0) return;

		flushPending(state, filePath, maxExchangeChars);

		let timestamp = state.headerTimestamp;
		if (typeof payload.timestamp === "number") {
			timestamp = Math.floor(payload.timestamp / 1000);
		} else if (typeof event.timestamp === "string") {
			const ms = Date.parse(event.timestamp);
			if (!Number.isNaN(ms)) timestamp = Math.floor(ms / 1000);
		}

		state.pending = {
			userText: clipText(userTexts.join("\n"), maxExchangeChars),
			assistantText: [],
			assistantLen: 0,
			assistantDropped: 0,
			toolNames: [],
			timestamp,
			ordinal: state.ordinal++,
		};
		return;
	}

	if (payload.role === "assistant" && state.pending !== null) {
		const pending = state.pending;
		for (const part of parts) {
			if (part.type === "text" && part.text && part.text.length > 0) {
				const remaining = maxExchangeChars - pending.assistantLen;
				if (remaining <= 0) {
					// Cap already reached: count everything past it but store nothing more,
					// so a single huge exchange cannot grow unbounded in memory.
					pending.assistantDropped += part.text.length;
					continue;
				}
				if (part.text.length > remaining) {
					pending.assistantText.push(part.text.slice(0, remaining));
					pending.assistantLen += remaining;
					pending.assistantDropped += part.text.length - remaining;
				} else {
					pending.assistantText.push(part.text);
					pending.assistantLen += part.text.length;
				}
			} else if (part.type === "toolCall" && part.name && !pending.toolNames.includes(part.name)) {
				pending.toolNames.push(part.name);
			}
		}
	}
}

export function parseSessionFile(
	filePath: string,
	opts?: { maxBytes?: number; maxExchangeChars?: number }
): Exchange[] {
	// Explicit maxBytes -> hard throw (indexer/tests rely on this).
	// No explicit maxBytes -> apply a default cap and SKIP (return empty + warn) so a
	// single pathological session (e.g. a 660MB file) cannot crash bulk dir-scan paths
	// (extract, label-scaffold, extract-eval, graph-extract, eval, mcp read).
	const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
	const size = statSync(filePath).size;
	if (opts?.maxBytes !== undefined) {
		if (size > opts.maxBytes) {
			throw new Error(`session file too large: size ${size} exceeds limit ${opts.maxBytes}`);
		}
	} else if (size > DEFAULT_MAX_BYTES) {
		process.stderr.write(
			`Skipping oversized session file (${size} bytes > ${DEFAULT_MAX_BYTES} default cap): ${filePath}\n`,
		);
		return [];
	}

	const maxExchangeChars = opts?.maxExchangeChars ?? 100_000;
	// Absolute sanity bound for a single raw line (catches pathological multi-hundred-MB
	// lines), independent of the content clip cap so a small maxExchangeChars never drops
	// normal message lines.
	const maxLineLength = Math.max(maxExchangeChars * 4, 10_000_000);

	const raw = readFileSync(filePath, "utf8");
	const lines = raw.split("\n");

	let sessionId: string | null = null;
	let title: string | null = null;
	let cwd: string | null = null;
	let headerTimestamp = timestampFromFilename(filePath);

	// First pass: find the session event for header info
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.length > maxLineLength) {
			process.stderr.write(`Skipping line because it exceeds length limit of ${maxLineLength} chars.\n`);
			continue;
		}
		try {
			const event = JSON.parse(trimmed);
			if (!isRecord(event)) continue;
			if (event.type !== "session") continue;
			if (typeof event.id === "string") sessionId = event.id;
			if (typeof event.title === "string") title = event.title;
			if (typeof event.cwd === "string") cwd = event.cwd;
			if (typeof event.timestamp === "string") {
				const ms = Date.parse(event.timestamp);
				if (!Number.isNaN(ms)) headerTimestamp = Math.floor(ms / 1000);
			}
			break;
		} catch {
			// Skip lines that fail to parse
		}
	}

	if (sessionId === null) {
		sessionId = sessionIdFromFilename(filePath);
		title = null;
		cwd = null;
	}

	const state = {
		sessionId,
		title,
		cwd,
		headerTimestamp,
		pending: null as PendingExchange | null,
		ordinal: 0,
		exchanges: [] as Exchange[],
	};

	// Second pass: process messages
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.length > maxLineLength) {
			process.stderr.write(`Skipping line because it exceeds length limit of ${maxLineLength} chars.\n`);
			continue;
		}
		try {
			const event = JSON.parse(trimmed);
			if (!isRecord(event)) continue;
			if (event.type !== "message") continue;
			processMessageEvent(event, state, filePath, maxExchangeChars);
		} catch {
			// Skip lines that fail to parse
		}
	}

	flushPending(state, filePath, maxExchangeChars);
	return state.exchanges;
}

export async function parseSessionFileStream(
	filePath: string,
	opts?: { maxBytes?: number; maxExchangeChars?: number }
): Promise<Exchange[]> {
	const size = statSync(filePath).size;
	if (opts?.maxBytes !== undefined && size > opts.maxBytes) {
		// Throws an error when file exceeds limit. The error message starts with 'session file too large'.
		throw new Error(`session file too large: size ${size} exceeds limit ${opts.maxBytes}`);
	}

	const maxExchangeChars = opts?.maxExchangeChars ?? 100_000;
	const maxLineLength = Math.max(maxExchangeChars * 4, 10_000_000);

	let sessionId: string | null = null;
	let title: string | null = null;
	let cwd: string | null = null;
	let headerTimestamp = timestampFromFilename(filePath);
	let seenSession = false;

	const state = {
		sessionId: null as string | null,
		title: null as string | null,
		cwd: null as string | null,
		headerTimestamp,
		pending: null as PendingExchange | null,
		ordinal: 0,
		exchanges: [] as Exchange[],
	};

	const fileStream = createReadStream(filePath, { encoding: "utf8" });
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Infinity,
	});

	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.length > maxLineLength) {
			process.stderr.write(`Skipping line because it exceeds length limit of ${maxLineLength} chars.\n`);
			continue;
		}
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(event)) continue;

		if (event.type === "session" && !seenSession) {
			seenSession = true;
			if (typeof event.id === "string") sessionId = event.id;
			if (typeof event.title === "string") title = event.title;
			if (typeof event.cwd === "string") cwd = event.cwd;
			if (typeof event.timestamp === "string") {
				const ms = Date.parse(event.timestamp);
				if (!Number.isNaN(ms)) headerTimestamp = Math.floor(ms / 1000);
			}
			state.sessionId = sessionId;
			state.title = title;
			state.cwd = cwd;
			state.headerTimestamp = headerTimestamp;
		} else if (event.type === "message") {
			if (state.sessionId === null) {
				state.sessionId = sessionIdFromFilename(filePath);
				state.title = null;
				state.cwd = null;
			}
			processMessageEvent(event, state, filePath, maxExchangeChars);
		}
	}

	flushPending(state, filePath, maxExchangeChars);
	return state.exchanges;
}
