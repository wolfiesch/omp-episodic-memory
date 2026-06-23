import { readFileSync } from "node:fs";
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

function parseLines(raw: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isRecord(parsed)) out.push(parsed);
		} catch {
			// Skip lines that fail to parse.
		}
	}
	return out;
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
	toolNames: string[];
	timestamp: number;
	ordinal: number;
}

export function parseSessionFile(filePath: string): Exchange[] {
	const events = parseLines(readFileSync(filePath, "utf8"));

	let sessionId: string | null = null;
	let title: string | null = null;
	let cwd: string | null = null;
	let headerTimestamp = timestampFromFilename(filePath);

	for (const event of events) {
		if (event.type !== "session") continue;
		if (typeof event.id === "string") sessionId = event.id;
		if (typeof event.title === "string") title = event.title;
		if (typeof event.cwd === "string") cwd = event.cwd;
		if (typeof event.timestamp === "string") {
			const ms = Date.parse(event.timestamp);
			if (!Number.isNaN(ms)) headerTimestamp = Math.floor(ms / 1000);
		}
		break;
	}

	if (sessionId === null) {
		sessionId = sessionIdFromFilename(filePath);
		title = null;
		cwd = null;
	}

	const exchanges: Exchange[] = [];
	let pending: PendingExchange | null = null;
	let ordinal = 0;

	const flush = () => {
		if (pending === null) return;
		if (pending.userText.trim().length > 0) {
			exchanges.push({
				sessionId: sessionId as string,
				sourcePath: filePath,
				title,
				cwd,
				ordinal: pending.ordinal,
				timestamp: pending.timestamp,
				userText: pending.userText,
				assistantText: pending.assistantText.join("\n\n"),
				toolNames: pending.toolNames,
			});
		}
		pending = null;
	};

	for (const event of events) {
		if (event.type !== "message") continue;
		const payload = readMessagePayload(event);
		if (payload === null) continue;
		const parts = extractContentParts(payload.content);

		if (payload.role === "user") {
			const userTexts: string[] = [];
			for (const part of parts) {
				if (part.type === "text" && part.text && part.text.length > 0) {
					userTexts.push(part.text);
				}
			}
			if (userTexts.length === 0) continue;

			flush();

			let timestamp = headerTimestamp;
			if (typeof payload.timestamp === "number") {
				timestamp = Math.floor(payload.timestamp / 1000);
			} else if (typeof event.timestamp === "string") {
				const ms = Date.parse(event.timestamp);
				if (!Number.isNaN(ms)) timestamp = Math.floor(ms / 1000);
			}

			pending = {
				userText: userTexts.join("\n"),
				assistantText: [],
				toolNames: [],
				timestamp,
				ordinal: ordinal++,
			};
			continue;
		}

		if (payload.role === "assistant" && pending !== null) {
			for (const part of parts) {
				if (part.type === "text" && part.text && part.text.length > 0) {
					pending.assistantText.push(part.text);
				} else if (part.type === "toolCall" && part.name && !pending.toolNames.includes(part.name)) {
					pending.toolNames.push(part.name);
				}
			}
		}
	}

	flush();
	return exchanges;
}
