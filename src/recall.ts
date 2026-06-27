// recall_for_task: the high-level, agent-facing retrieval surface.
// Classifies a task into retrieval intents, gathers raw episodes + approved
// derived memories, and returns a compact, provenance-backed evidence bundle
// optimized for injection into another agent's context.
//
// Pure read path: never writes to the DB.
import type Database from "better-sqlite3";

import { search } from "./search.js";
import { getSupersededBy, searchMemoryRecords, type MemoryRecord, type MemoryType } from "./memory.js";
import type { SearchHit, SearchMode, ToolEvent } from "./types.js";
import { formatToolEventSummary } from "./tool-events.js";

/** Retrieval intents inferred from the task text. */
export type RecallIntent =
  | "exact"
  | "semantic"
  | "decision"
  | "procedural"
  | "gotcha"
  | "temporal";

/** Memory categories a caller may opt into. */
export type RecallInclude = "episodes" | "memories" | "runbooks" | "gotchas" | "decisions";

export const DEFAULT_INCLUDE: readonly RecallInclude[] = [
  "episodes",
  "memories",
  "runbooks",
  "gotchas",
  "decisions",
];

export type RecallConfidence = "high" | "medium" | "low" | "abstain";

export interface RecallEvidence {
  kind: "episode" | MemoryType;
  title: string;
  date: string | null;
  /** Source transcript path (episodes) or first provenance path (memories). */
  path: string | null;
  /** Exchange ordinal for episodes / first source ordinal for memories. */
  ordinal: number | null;
  sessionId: string | null;
  /** Short excerpt. */
  quote: string;
  /** Per-evidence confidence signal (memory confidence, or fused rank for episodes). */
  score: number;
  toolEvents?: ToolEvent[];
}

export interface RecallConflict {
  subject: string;
  current: RecallEvidence;
  superseded: RecallEvidence;
}

export interface RecallSections {
  decisions: RecallEvidence[];
  gotchas: RecallEvidence[];
  runbooks: RecallEvidence[];
  projectContext: RecallEvidence[];
  episodes: RecallEvidence[];
  conflicts: RecallConflict[];
  abstentions: string[];
}

export interface RecallBundle {
  answerable: boolean;
  confidence: RecallConfidence;
  intents: RecallIntent[];
  memoryTypesUsed: string[];
  summary: string;
  /** Compact text optimized for injection into the next agent turn. */
  suggestedContext: string;
  sections: RecallSections;
  evidence: RecallEvidence[];
  recommendedNextSteps: string[];
}

export interface RecallOptions {
  task: string;
  project?: string;
  include?: RecallInclude[];
  /** Search mode for episode retrieval. "text" avoids loading the embedding model. */
  mode?: SearchMode;
  /** Approximate ceiling on injected-context tokens (chars/4 heuristic). */
  maxContextTokens?: number;
  /** Only consider evidence at/after this unix-seconds time. */
  after?: number;
  /** Only consider evidence at/before this unix-seconds time. */
  before?: number;
  toolName?: string;
  toolError?: boolean;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_CONTEXT_TOKENS = 2000;

/** Heuristic, deterministic classification of a task into retrieval intents. */
export function classifyIntents(task: string): RecallIntent[] {
  const t = task.toLowerCase();
  const intents = new Set<RecallIntent>();

  if (/\bwhy\b|\bdecid|\bchose\b|\bchoose\b|\bdecision\b/.test(t)) intents.add("decision");
  if (/\bhow (?:do|to|did)\b|\bsteps?\b|\bpublish\b|\brunbook\b|\bprocedure\b|\bsetup\b|\binstall\b/.test(t))
    intents.add("procedural");
  if (/\bavoid\b|\bgotcha\b|\bpitfall\b|\bmistake\b|\bfail|\berror\b|\bbug\b|\bbroke|\bwrong\b/.test(t))
    intents.add("gotcha");
  if (/\bsince\b|\bchanged?\b|\bwhen\b|\brecent\b|\blast (?:week|month|time)\b|\bbefore\b|\bafter\b|\bago\b/.test(t))
    intents.add("temporal");
  if (/\bfind\b|\bsearch\b|\bwhere\b|\bwhich (?:session|file)\b|\bexact\b/.test(t))
    intents.add("exact");

  // Always include semantic recall as the baseline.
  intents.add("semantic");
  return [...intents];
}

/** Common English/coding stopwords that carry no retrieval signal. */
const STOPWORDS: Record<string, true> = {
  the: true, a: true, an: true, and: true, or: true, but: true, of: true, to: true,
  for: true, in: true, on: true, at: true, by: true, with: true, from: true, as: true,
  is: true, are: true, was: true, were: true, be: true, been: true, being: true,
  do: true, did: true, does: true, done: true, how: true, what: true, when: true,
  where: true, which: true, who: true, why: true, we: true, i: true, you: true,
  it: true, this: true, that: true, these: true, those: true, our: true, my: true,
  can: true, should: true, would: true, will: true, use: true, used: true, using: true,
  about: true, into: true, before: true, after: true, since: true, ago: true,
  has: true, have: true, had: true, not: true, no: true, any: true, some: true,
  if: true, then: true, else: true, so: true, just: true, only: true,
};

const GENERIC_SIGNAL_TOKENS: Record<string, true> = {
  code: true,
  continue: true,
  command: true,
  configure: true,
  install: true,
  integrate: true,
  fix: true,
  history: true,
  issue: true,
  package: true,
  project: true,
  repo: true,
  task: true,
  test: true,
  update: true,
  user: true,
  work: true,
};

/**
 * Lowercased content tokens (length >= 3, not stopwords) that carry retrieval
 * signal. Used to gate ORed FTS/vector hits so unrelated tasks abstain.
 */
function significantTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const tok = raw.trim();
    if (tok.length < 3 || STOPWORDS[tok]) continue;
    seen.add(tok);
  }
  return [...seen];
}

function isRequiredEvidenceToken(token: string): boolean {
  const rareLetters = token.match(/[qxz]/g)?.length ?? 0;
  return token.includes("-") || token.includes("_") || rareLetters >= 2;
}

function hasEnoughTokenOverlap(taskTokens: string[], text: string): boolean {
  const hay = text.toLowerCase();
  const matches = taskTokens.filter((tok) => hay.includes(tok));
  const required = taskTokens.filter(isRequiredEvidenceToken);
  if (required.length > 0 && !required.every((tok) => matches.includes(tok))) return false;
  if (required.length > 0) return true;

  const strongTokens = taskTokens.filter((tok) => !GENERIC_SIGNAL_TOKENS[tok]);
  const strongMatches = matches.filter((tok) => !GENERIC_SIGNAL_TOKENS[tok]);
  if (strongMatches.length < 2) return false;
  return strongMatches.length / Math.max(strongTokens.length, 1) >= 0.4;
}

function clip(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function isoDate(unixSeconds: number | null): string | null {
  if (unixSeconds === null || unixSeconds === undefined) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function episodeToEvidence(hit: SearchHit): RecallEvidence {
  const evidence: RecallEvidence = {
    kind: "episode",
    title: hit.title ?? hit.sessionId,
    date: isoDate(hit.timestamp),
    path: hit.sourcePath,
    ordinal: hit.ordinal,
    sessionId: hit.sessionId,
    quote: clip(hit.snippet, 240),
    score: hit.score,
  };
  if (hit.toolEvents.length > 0) evidence.toolEvents = hit.toolEvents;
  return evidence;
}

function memoryToEvidence(rec: MemoryRecord): RecallEvidence {
  const first = rec.sources[0] ?? null;
  return {
    kind: rec.type,
    title: clip(rec.title, 120),
    date: isoDate(rec.validFrom),
    path: first ? first.sourcePath : null,
    ordinal: first ? first.ordinal : null,
    sessionId: first ? first.sessionId : null,
    quote: clip(rec.body, 240),
    score: rec.confidence,
  };
}

function buildSections(
  evidence: RecallEvidence[],
  answerable: boolean,
  task: string,
  conflicts: RecallConflict[] = [],
): RecallSections {
  return {
    decisions: evidence.filter((ev) => ev.kind === "decision"),
    gotchas: evidence.filter((ev) => ev.kind === "gotcha"),
    runbooks: evidence.filter((ev) => ev.kind === "runbook"),
    projectContext: evidence.filter((ev) =>
      ev.kind === "fact" || ev.kind === "project_state" || ev.kind === "preference",
    ),
    episodes: evidence.filter((ev) => ev.kind === "episode"),
    conflicts,
    abstentions: answerable ? [] : [clip(task, 120)],
  };
}

const SECTION_ORDER: Array<{
  key: keyof Pick<
    RecallSections,
    "decisions" | "gotchas" | "runbooks" | "projectContext" | "episodes"
  >;
  title: string;
}> = [
  { key: "decisions", title: "Relevant prior decisions" },
  { key: "gotchas", title: "Gotchas" },
  { key: "runbooks", title: "Runbook snippets" },
  { key: "projectContext", title: "Project context" },
  { key: "episodes", title: "Prior episodes" },
];

function formatEvidenceLine(ev: RecallEvidence): string {
  const toolLine = ev.toolEvents?.length
    ? ` Tools: ${ev.toolEvents.slice(0, 2).map((event) => formatToolEventSummary(event, 80)).join("; ")}`
    : "";
  return `- [${ev.kind}] ${ev.title}${ev.date ? ` (${ev.date})` : ""}: ${ev.quote}${toolLine}`;
}

/** Map intents to the memory types they should pull. */
function memoryTypesForIntents(intents: RecallIntent[], include: RecallInclude[]): MemoryType[] {
  const types = new Set<MemoryType>();
  if (include.includes("decisions") && intents.includes("decision")) types.add("decision");
  if (include.includes("runbooks") && intents.includes("procedural")) types.add("runbook");
  if (include.includes("gotchas") && intents.includes("gotcha")) types.add("gotcha");
  // "memories" is a catch-all: when present, allow the core derived types.
  if (include.includes("memories")) {
    types.add("decision");
    types.add("runbook");
    types.add("gotcha");
    types.add("fact");
    types.add("project_state");
    types.add("preference");
  }
  return [...types];
}

/**
 * Derive an overall confidence tier from the gathered evidence.
 * - high: >=2 supporting items, OR an approved memory plus a strong episode match.
 * - medium: exactly one solid item.
 * - low: weak/sparse signal.
 * - abstain: nothing usable.
 */
function deriveConfidence(memories: MemoryRecord[], episodes: SearchHit[]): RecallConfidence {
  const memCount = memories.length;
  const epiCount = episodes.length;
  const total = memCount + epiCount;
  if (total === 0) return "abstain";

  const strongMemory = memories.some((m) => m.confidence >= 0.65);
  if ((memCount >= 1 && epiCount >= 1) || total >= 3 || (strongMemory && total >= 2)) {
    return "high";
  }
  if (total >= 1 && (strongMemory || epiCount >= 1)) return "medium";
  return "low";
}

function nextSteps(intents: RecallIntent[], bundle: { episodes: SearchHit[]; memories: MemoryRecord[] }): string[] {
  const steps: string[] = [];
  if (bundle.episodes.length > 0) {
    steps.push("read the cited transcript(s) for full context before acting");
  }
  if (intents.includes("gotcha") && bundle.memories.some((m) => m.type === "gotcha")) {
    steps.push("review the noted gotchas to avoid repeating a prior failure");
  }
  if (intents.includes("procedural") && bundle.memories.some((m) => m.type === "runbook")) {
    steps.push("follow the matching runbook steps");
  }
  if (steps.length === 0) {
    steps.push("no strong prior experience found; proceed and capture new findings");
  }
  return steps;
}

/**
 * High-level recall. Returns an evidence bundle for a coding task.
 * Pass mode:"text" to avoid loading the embedding model (used in tests).
 */
export async function recallForTask(
  db: Database.Database,
  opts: RecallOptions,
): Promise<RecallBundle> {
  const include = opts.include ?? [...DEFAULT_INCLUDE];
  const mode: SearchMode = opts.mode ?? "both";
  const maxTokens = opts.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const intents = classifyIntents(opts.task);

  // 1. Episodes (raw transcript exchanges).
  let episodes: SearchHit[] = [];
  if (include.includes("episodes")) {
    episodes = await search(db, {
      query: opts.task,
      mode,
      limit: 8,
      after: opts.after,
      before: opts.before,
      toolName: opts.toolName,
      toolError: opts.toolError,
    });
  }

  // 2. Derived memories (approved only) for the relevant types.
  const wantTypes = memoryTypesForIntents(intents, include);
  let memories: MemoryRecord[] = [];
  if (wantTypes.length > 0) {
    const seen = new Set<number>();
    for (const type of wantTypes) {
      const recs = searchMemoryRecords(db, {
        query: opts.task,
        type,
        project: opts.project,
        status: "approved",
        limit: 5,
      });
      for (const r of recs) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          memories.push(r);
        }
      }
    }
    memories.sort((a, b) => b.confidence - a.confidence);
    memories = memories.slice(0, 8);
  }

  // Episodes carry their own cwd; honor an explicit project filter (memories
  // were already project-filtered at query time).
  if (opts.project !== undefined) {
    episodes = episodes.filter((e) => e.cwd === opts.project);
  }

  // Relevance gate: the underlying FTS/vector search ORs every token (incl.
  // stopwords), so it almost always returns SOMETHING. Keep only evidence that
  // shares a significant content token with the task; otherwise abstain.
  const taskTokens = significantTokens(opts.task);
  if (taskTokens.length > 0) {
    const relevant = (text: string): boolean => hasEnoughTokenOverlap(taskTokens, text);
    // `snippet` is only user_text; the search may have matched assistant_text or
    // tool names, so hydrate the full exchange text before gating an episode.
    const hydrateText = db.prepare(
      `SELECT user_text, assistant_text, tool_names, tool_event_text FROM exchanges
       WHERE session_id = ? AND ordinal = ?`,
    );
    episodes = episodes.filter((e) => {
      const row = hydrateText.get(e.sessionId, e.ordinal) as
        | { user_text: string; assistant_text: string | null; tool_names: string | null; tool_event_text: string | null }
        | undefined;
      const full = row
        ? `${e.title ?? ""} ${row.user_text} ${row.assistant_text ?? ""} ${row.tool_names ?? ""} ${row.tool_event_text ?? ""}`
        : `${e.title ?? ""} ${e.snippet}`;
      return relevant(full);
    });
    memories = memories.filter((m) => relevant(`${m.title} ${m.body} ${m.entities.join(" ")}`));
  }

  const confidence = deriveConfidence(memories, episodes);
  const answerable = confidence !== "abstain";

  // 3. Build evidence list: memories first (distilled), then episodes (raw).
  const evidence: RecallEvidence[] = [
    ...memories.map(memoryToEvidence),
    ...episodes.map(episodeToEvidence),
  ];

  const memoryTypesUsed = [...new Set(memories.map((m) => m.type))];

  // 4. Summary + suggested context (token-budgeted).
  let summary: string;
  if (!answerable) {
    summary = `No prior experience found for: "${clip(opts.task, 120)}". Abstaining.`;
  } else {
    const parts: string[] = [];
    if (memories.length > 0) parts.push(`${memories.length} derived memory record(s)`);
    if (episodes.length > 0) parts.push(`${episodes.length} prior episode(s)`);
    summary = `Found ${parts.join(" and ")} relevant to: "${clip(opts.task, 100)}" (confidence: ${confidence}).`;
  }

  const conflicts: RecallConflict[] = [];
  for (const memory of memories) {
    if (memory.type !== "decision") continue;
    for (const older of getSupersededBy(db, memory.id)) {
      conflicts.push({
        subject: memory.title,
        current: memoryToEvidence(memory),
        superseded: memoryToEvidence(older),
      });
    }
  }

  const sections = buildSections(evidence, answerable, opts.task, conflicts);

  // Assemble suggested context within the token budget.
  const lines: string[] = [];
  let usedTokens = Math.ceil(summary.length / CHARS_PER_TOKEN);
  const pushBudgeted = (line: string): boolean => {
    const cost = Math.ceil(line.length / CHARS_PER_TOKEN);
    if (usedTokens + cost > maxTokens) return false;
    lines.push(line);
    usedTokens += cost;
    return true;
  };
  for (const section of SECTION_ORDER) {
    const items = sections[section.key];
    if (items.length === 0) continue;
    if (!pushBudgeted(`## ${section.title}`)) break;
    for (const ev of items) {
      if (!pushBudgeted(formatEvidenceLine(ev))) break;
    }
  }
  if (sections.conflicts.length > 0 && pushBudgeted("## Conflicts / stale facts")) {
    for (const conflict of sections.conflicts) {
      if (!pushBudgeted(`- ${conflict.subject}: current "${conflict.current.title}" supersedes "${conflict.superseded.title}"`)) break;
    }
  }
  if (sections.abstentions.length > 0 && pushBudgeted("## Abstention")) {
    for (const abstention of sections.abstentions) {
      if (!pushBudgeted(`- Not enough evidence for: ${abstention}`)) break;
    }
  }
  const suggestedContext = `${summary}\n${lines.join("\n")}`.trim();

  return {
    answerable,
    confidence,
    intents,
    memoryTypesUsed,
    summary,
    suggestedContext,
    sections,
    evidence,
    recommendedNextSteps: nextSteps(intents, { episodes, memories }),
  };
}

/** Render a bundle as compact markdown for human/agent display. */
export function formatBundle(bundle: RecallBundle): string {
  const lines: string[] = [];
  lines.push(`**Recall** - confidence: ${bundle.confidence} | intents: ${bundle.intents.join(", ")}`);
  lines.push("");
  lines.push(bundle.summary);
  for (const section of SECTION_ORDER) {
    const items = bundle.sections[section.key];
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`## ${section.title}`);
    for (const ev of items) {
      const loc = ev.path ? ` - ${ev.path}${ev.ordinal !== null ? `#${ev.ordinal}` : ""}` : "";
      lines.push(`- [${ev.kind}] ${ev.title}${ev.date ? ` (${ev.date})` : ""}${loc}`);
      lines.push(`  ${ev.quote}`);
      if (ev.toolEvents?.length) {
        lines.push(`  Tools: ${ev.toolEvents.slice(0, 2).map((event) => formatToolEventSummary(event, 80)).join("; ")}`);
      }
    }
  }
  if (bundle.sections.conflicts.length > 0) {
    lines.push("");
    lines.push("## Conflicts / stale facts");
    for (const conflict of bundle.sections.conflicts) {
      lines.push(`- ${conflict.subject}: current "${conflict.current.title}" supersedes "${conflict.superseded.title}"`);
    }
  }
  if (bundle.sections.abstentions.length > 0) {
    lines.push("");
    lines.push("## Abstention");
    for (const abstention of bundle.sections.abstentions) {
      lines.push(`- Not enough evidence for: ${abstention}`);
    }
  }
  lines.push("");
  lines.push("Recommended next steps:");
  bundle.recommendedNextSteps.forEach((s) => lines.push(`- ${s}`));
  return lines.join("\n");
}
