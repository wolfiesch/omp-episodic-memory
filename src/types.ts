// Shared contract and defaults for omp-episodic-memory.
import { homedir } from "node:os";
import { join } from "node:path";

export interface ToolEvent {
  callId: string | null;
  toolName: string;
  arguments: Record<string, unknown> | null;
  resultText: string | null;
  isError: boolean | null;
  details: Record<string, unknown> | null;
  exitCode: number | null;
  filePaths: string[];
  command: string | null;
}

/**
 * One indexable unit: a user turn paired with the assistant's response text
 * that followed it, within a single OMP session.
 */
export interface Exchange {
  /** OMP session id (from the `session` header line `id`). */
  sessionId: string;
  /** Absolute path to the source .jsonl file. */
  sourcePath: string;
  /** Session title if present in the header, else null. */
  title: string | null;
  /** Working directory from the session header, else null. */
  cwd: string | null;
  /** Zero-based index of this exchange within the session (ordering key). */
  ordinal: number;
  /** Unix epoch SECONDS of the user message that opened this exchange. */
  timestamp: number;
  /** The user's message text (concatenated text parts). */
  userText: string;
  /** The assistant reply text that followed, up to the next user turn (may be empty). */
  assistantText: string;
  /** Distinct tool names invoked in the assistant span (for keyword recall). */
  toolNames: string[];
  toolEvents: ToolEvent[];
}

/** Embedding model output dimension. all-MiniLM-L6-v2 => 384. */
export const EMBEDDING_DIM = 384;

function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function ompHome(): string {
  return process.env.OMP_HOME ?? join(homedir(), ".omp");
}

/** A single ranked search hit returned by the hybrid searcher. */
export interface SearchHit {
  sessionId: string;
  sourcePath: string;
  title: string | null;
  cwd: string | null;
  ordinal: number;
  timestamp: number;
  /** Short snippet (truncated userText) for display. */
  snippet: string;
  userSnippet?: string;
  assistantSnippet?: string;
  toolEvents: ToolEvent[];
  /** Fused relevance score (higher = better). */
  score: number;
  /** Per-signal debug scores. */
  vectorRank: number | null;
  textRank: number | null;
}

export type SearchMode = "vector" | "text" | "both";

export interface SearchOptions {
  query: string;
  mode?: SearchMode; // default "both"
  limit?: number; // default 10
  /** Only hits at/after this unix-seconds time. */
  after?: number;
  /** Only hits at/before this unix-seconds time. */
  before?: number;
  toolName?: string;
  toolError?: boolean;
}

/** Default location of the prototype index DB (kept OUT of ~/.omp to avoid touching native state). */
export const DEFAULT_DB_PATH = process.env.OMP_EPISODIC_DB ?? join(dataHome(), "omp-episodic-memory", "index.db");

/** Default OMP sessions root to index. Override with OMP_SESSIONS_DIR. */
export const DEFAULT_SESSIONS_DIR = process.env.OMP_SESSIONS_DIR ?? join(ompHome(), "agent", "sessions");
