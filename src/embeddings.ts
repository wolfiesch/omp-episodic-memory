// Local embedding via @xenova/transformers (Xenova/all-MiniLM-L6-v2, 384-dim).
// All logging goes to stderr; stdout is reserved for CLI/MCP output.
import type { FeatureExtractionPipeline } from "@xenova/transformers";

import { EMBEDDING_DIM, type ToolEvent } from "./types.js";
import { toolEventsIndexText } from "./tool-events.js";

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

const MAX_EMBED_CHARS = 2000;
const USER_CHARS = 800;
const ASSISTANT_CHARS = 1000;
const TOOL_CHARS = 200;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export async function initEmbeddings(): Promise<void> {
  if (pipelinePromise) {
    await pipelinePromise;
    return;
  }
  // Dynamic import required: @xenova/transformers is ESM/CJS-interop sensitive
  // and must be loaded at runtime to avoid interop resolution failures.
  pipelinePromise = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    // Allow fetching the model on first run if it is not already cached.
    env.allowRemoteModels = true;
    // Honor TRANSFORMERS_CACHE so the cache location is configurable and matches
    // what `doctor` probes; absent the var, Transformers.js uses its package default.
    if (process.env.TRANSFORMERS_CACHE) {
      env.cacheDir = process.env.TRANSFORMERS_CACHE;
    }
    console.error("Loading embedding model...");
    return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  })();
  await pipelinePromise;
}

export async function embed(text: string): Promise<Float32Array> {
  await initEmbeddings();
  if (!pipelinePromise) {
    throw new Error("Embedding pipeline failed to initialize");
  }
  const extractor = await pipelinePromise;
  const input = truncate(text, MAX_EMBED_CHARS);
  const output = await extractor(input, { pooling: "mean", normalize: true });
  const vector = Float32Array.from(output.data, Number);
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${vector.length}`,
    );
  }
  return vector;
}

export async function embedExchange(
  userText: string,
  assistantText: string,
  toolNames: string[],
  toolEvents: ToolEvent[] = [],
): Promise<Float32Array> {
  const tools = toolNames.length > 0 ? `\n\nTools: ${truncate(toolNames.join(", "), TOOL_CHARS)}` : "";
  const eventText = toolEvents.length > 0 ? `\n\nTool events: ${truncate(toolEventsIndexText(toolEvents), 400)}` : "";
  const composed =
    `User: ${truncate(userText, USER_CHARS)}` +
    `\n\nAssistant: ${truncate(assistantText, ASSISTANT_CHARS)}` +
    tools +
    eventText;
  return embed(composed);
}

