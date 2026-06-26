import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import type { Exchange, ToolEvent } from "./types.js";
import { deriveCommand, deriveExitCode, deriveFilePaths, isRecord, normalizeArguments } from "./tool-events.js";
import { redactSecrets, redactToolEvent } from "./redact.js";

export function isSessionFile(name: string): boolean {
	return name.endsWith(".jsonl");
}

interface ContentPart {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: unknown;
}

interface MessagePayload {
	role?: string;
	content?: unknown;
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details: Record<string, unknown> | null;
}


function extractContentParts(content: unknown): ContentPart[] {
	if (!Array.isArray(content)) return [];
	const parts: ContentPart[] = [];
	for (const item of content) {
		if (isRecord(item) && typeof item.type === "string") {
			const text = typeof item.text === "string" ? item.text : undefined;
			const name = typeof item.name === "string" ? item.name : undefined;
			const id = typeof item.id === "string" ? item.id : undefined;
			parts.push({ type: item.type, text, name, id, arguments: item.arguments });
		}
	}
	return parts;
}

function readMessagePayload(event: Record<string, unknown>): MessagePayload | null {
	const message = event.message;
	if (!isRecord(message)) return null;
	const role = typeof message.role === "string" ? message.role : undefined;
	const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
	const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
	const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
	const isError = typeof message.isError === "boolean" ? message.isError : undefined;
	const details = isRecord(message.details) ? message.details : null;
	return { role, content: message.content, timestamp, toolCallId, toolName, isError, details };
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
	toolEvents: ToolEvent[];
	timestamp: number;
	ordinal: number;
}

function clipText(text: string, max: number): string {
	const redacted = redactSecrets(text);
	if (redacted.length > max) {
		const clipped = redacted.length - max;
		return redacted.slice(0, max) + `\n\u2026[clipped ${clipped} chars]`;
	}
	return redacted;
}

interface ParserOptions {
	maxBytes?: number;
	maxExchangeChars?: number;
	maxToolResultChars?: number;
}

interface ParserState {
	sessionId: string | null;
	title: string | null;
	cwd: string | null;
	headerTimestamp: number;
	pending: PendingExchange | null;
	ordinal: number;
	exchanges?: Exchange[];
}

function flushPending(
	state: ParserState,
	filePath: string,
	maxExchangeChars: number
): Exchange | null {
	const pending = state.pending;
	if (pending === null) return null;
	let exchange: Exchange | null = null;
	if (pending.userText.trim().length > 0) {
		const userText = redactSecrets(pending.userText);
		const joined = pending.assistantText.join("\n\n");
		const assistantText = redactSecrets(
			pending.assistantDropped > 0
				? `${joined}\n\u2026[clipped ${pending.assistantDropped} chars]`
				: joined,
		);
		exchange = {
			sessionId: state.sessionId as string,
			sourcePath: filePath,
			title: state.title,
			cwd: state.cwd,
			ordinal: pending.ordinal,
			timestamp: pending.timestamp,
			userText,
			assistantText,
			toolNames: pending.toolNames,
			toolEvents: pending.toolEvents.map(redactToolEvent),
		};
		state.exchanges?.push(exchange);
	}
	state.pending = null;
	return exchange;
}

function processMessageEvent(
	event: Record<string, unknown>,
	state: ParserState,
	filePath: string,
	maxExchangeChars: number,
	maxToolResultChars: number
): Exchange | null {
	const payload = readMessagePayload(event);
	if (payload === null) return null;
	const parts = extractContentParts(payload.content);

	if (payload.role === "toolResult" && state.pending !== null) {
		const resultTexts: string[] = [];
		for (const part of parts) {
			if (part.type === "text" && part.text && part.text.length > 0) {
				resultTexts.push(part.text);
			}
		}
		const resultText = resultTexts.length > 0 ? clipText(resultTexts.join("\n\n"), maxToolResultChars) : null;
		const pending = state.pending;
		const callId = payload.toolCallId ?? null;
		const details = payload.details;
		let eventToUpdate: ToolEvent | undefined;
		if (callId !== null) {
			for (let i = pending.toolEvents.length - 1; i >= 0; i--) {
				const event = pending.toolEvents[i];
				if (event.callId === callId) {
					eventToUpdate = event;
					break;
				}
			}
		}
		if (eventToUpdate === undefined && payload.toolName !== undefined) {
			for (let i = pending.toolEvents.length - 1; i >= 0; i--) {
				const event = pending.toolEvents[i];
				if (event.toolName === payload.toolName && event.resultText === null) {
					eventToUpdate = event;
					break;
				}
			}
		}
		if (eventToUpdate === undefined) {
			eventToUpdate = {
				callId,
				toolName: payload.toolName ?? "unknown",
				arguments: null,
				resultText: null,
				isError: null,
				details: null,
				exitCode: null,
				filePaths: [],
				command: null,
			};
			pending.toolEvents.push(eventToUpdate);
			if (!pending.toolNames.includes(eventToUpdate.toolName)) pending.toolNames.push(eventToUpdate.toolName);
		}
		eventToUpdate.resultText = resultText;
		eventToUpdate.isError = payload.isError ?? null;
		eventToUpdate.details = details;
		eventToUpdate.exitCode = deriveExitCode(details, resultText);
		return null;
	}

	if (payload.role === "user") {
		const userTexts: string[] = [];
		for (const part of parts) {
			if (part.type === "text" && part.text && part.text.length > 0) {
				userTexts.push(part.text);
			}
		}
		if (userTexts.length === 0) return null;

		const flushed = flushPending(state, filePath, maxExchangeChars);

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
			toolEvents: [],
			timestamp,
			ordinal: state.ordinal++,
		};
		return flushed;
	}

	if (payload.role === "assistant" && state.pending !== null) {
		const pending = state.pending;
		for (const part of parts) {
			if (part.type === "text" && part.text && part.text.length > 0) {
				const text = redactSecrets(part.text);
				const remaining = maxExchangeChars - pending.assistantLen;
				if (remaining <= 0) {
					// Cap already reached: count everything past it but store nothing more,
					// so a single huge exchange cannot grow unbounded in memory.
					pending.assistantDropped += text.length;
					continue;
				}
				if (text.length > remaining) {
					pending.assistantText.push(text.slice(0, remaining));
					pending.assistantLen += remaining;
					pending.assistantDropped += text.length - remaining;
				} else {
					pending.assistantText.push(text);
					pending.assistantLen += text.length;
				}
			} else if (part.type === "toolCall" && part.name) {
				const args = normalizeArguments(part.arguments);
				pending.toolEvents.push({
					callId: part.id ?? null,
					toolName: part.name,
					arguments: args,
					resultText: null,
					isError: null,
					details: null,
					exitCode: null,
					filePaths: deriveFilePaths(args),
					command: deriveCommand(args),
				});
				if (!pending.toolNames.includes(part.name)) pending.toolNames.push(part.name);
			}
		}
	}
	return null;
}

export function parseSessionFile(
	filePath: string,
	opts?: ParserOptions
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
	const maxToolResultChars = opts?.maxToolResultChars ?? 20_000;
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
			processMessageEvent(event, state, filePath, maxExchangeChars, maxToolResultChars);
		} catch {
			// Skip lines that fail to parse
		}
	}

	flushPending(state, filePath, maxExchangeChars);
	return state.exchanges;
}


async function* readCappedJsonlLines(
	filePath: string,
	maxLineLength: number
): AsyncGenerator<string> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	let line = "";
	let skippingLongLine = false;

	try {
		for await (const chunk of stream) {
			let offset = 0;
			while (offset < chunk.length) {
				const newline = chunk.indexOf("\n", offset);
				const end = newline === -1 ? chunk.length : newline;
				const segment = chunk.slice(offset, end);

				if (!skippingLongLine && line.length + segment.length > maxLineLength) {
					process.stderr.write(`Skipping line because it exceeds length limit of ${maxLineLength} chars.\n`);
					line = "";
					skippingLongLine = true;
				}

				if (!skippingLongLine) {
					line += segment;
				}

				if (newline === -1) {
					break;
				}

				if (!skippingLongLine) {
					yield line.endsWith("\r") ? line.slice(0, -1) : line;
				}
				line = "";
				skippingLongLine = false;
				offset = newline + 1;
			}
		}

		if (!skippingLongLine && line.length > 0) {
			yield line.endsWith("\r") ? line.slice(0, -1) : line;
		}
	} finally {
		stream.destroy();
	}
}
export async function* iterateSessionFile(
	filePath: string,
	opts?: ParserOptions
): AsyncGenerator<Exchange> {
	const size = statSync(filePath).size;
	if (opts?.maxBytes !== undefined && size > opts.maxBytes) {
		// Throws an error when file exceeds limit. The error message starts with 'session file too large'.
		throw new Error(`session file too large: size ${size} exceeds limit ${opts.maxBytes}`);
	}

	const maxExchangeChars = opts?.maxExchangeChars ?? 100_000;
	const maxToolResultChars = opts?.maxToolResultChars ?? 20_000;
	const maxLineLength = Math.max(maxExchangeChars * 4, 10_000_000);

	let sessionId: string | null = null;
	let title: string | null = null;
	let cwd: string | null = null;
	let headerTimestamp = timestampFromFilename(filePath);
	let seenSession = false;

	const state: ParserState = {
		sessionId: null,
		title: null,
		cwd: null,
		headerTimestamp,
		pending: null,
		ordinal: 0,
	};

	for await (const line of readCappedJsonlLines(filePath, maxLineLength)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
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
			const flushed = processMessageEvent(event, state, filePath, maxExchangeChars, maxToolResultChars);
			if (flushed !== null) yield flushed;
		}
	}

	const final = flushPending(state, filePath, maxExchangeChars);
	if (final !== null) yield final;
}

export async function parseSessionFileStream(
	filePath: string,
	opts?: ParserOptions
): Promise<Exchange[]> {
	const exchanges: Exchange[] = [];
	for await (const exchange of iterateSessionFile(filePath, opts)) {
		exchanges.push(exchange);
	}
	return exchanges;
}
