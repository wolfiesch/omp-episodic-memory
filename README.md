# omp-episodic-memory

[![CI](https://github.com/wolfiesch/omp-episodic-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/wolfiesch/omp-episodic-memory/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/omp-episodic-memory.svg)](https://www.npmjs.com/package/omp-episodic-memory)

Local-first experience memory for coding agents: index raw [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) session transcripts, then recall provenance-backed decisions, runbooks, and gotchas — without modifying OMP state.

This is a forensic and experience memory over your actual coding sessions. It reads the session JSONL files already on disk and writes only to its own local index database. Every result traces back to the exact conversation and exchange that produced it, so you can answer questions like "where did we solve this before", "what did the agent actually say", and "which session decided X".

Read-only with respect to OMP state: it never edits, compresses, or curates OMP's own memory. It indexes the raw transcripts and exposes them through a CLI and an MCP server.

## Why not just use OMP memory?

OMP's built-in memory is curated and compressed — a distilled view optimized for the agent's working context. That is useful, but it is lossy: the original wording, the dead ends, and the precise moment a decision was made are gone.

This tool takes the opposite stance. It indexes the **raw transcripts** as they sit on disk and gives you provenance back to the exact conversation and exchange. Use it to answer:

- Where did we solve this before?
- What did the agent actually say (verbatim), not the summary?
- Which session decided X, and what was the reasoning at the time?

The index is read-only with respect to OMP state. Derived memory (decisions, gotchas, runbooks) is proposed into a separate reviewable inbox — nothing is asserted into your knowledge base without an explicit approve step.

This is not a competitor to general-purpose agent memory frameworks (Mem0, Zep, Letta) or to OMP-native curation (Hindsight). Its lane is narrow on purpose: raw-transcript provenance plus reviewable derived memory for OMP coding sessions.

## What it does

- **Hybrid search** — FTS5 keyword retrieval and `sqlite-vec` vector retrieval fused with Reciprocal Rank Fusion (RRF). Modes: `both`, `vector`, `text`.
- **Typed, reviewable derived memory** — decisions, gotchas, and runbooks extracted from transcripts into an approve/reject inbox. Nothing enters the knowledge base without review.
- **`recall_for_task` evidence bundles** — task-scoped retrieval that returns supporting evidence with a confidence score and abstains when the index has nothing relevant, rather than fabricating an answer.
- **Temporal project graph** — entities and time-bounded edges, with decision supersession and a memory diff to see what changed since a given date.
- **Pinned project-context blocks** — durable, project-scoped context surfaced alongside recall.
- **Recall eval harness** — a reproducible benchmark over question/session fixtures that reports recall, ranking, abstention, and latency metrics as a regression guardrail.

## Install

Requires Node.js 20 or newer.

```sh
npm install -g omp-episodic-memory   # global CLI: omp-episodic
```

Or run without installing:

```sh
npx -y omp-episodic-memory index
npx -y omp-episodic-memory search "family tree research"
```

## Quick start

```sh
omp-episodic index                       # index all sessions
omp-episodic search "family tree research"
omp-episodic stats
```

The default index path is `${XDG_DATA_HOME:-~/.local/share}/omp-episodic-memory/index.db`. Override it with `OMP_EPISODIC_DB` or `--db PATH`.

## How it works

| Stage | What happens |
| --- | --- |
| **Parse** | Walks `${OMP_SESSIONS_DIR:-~/.omp/agent/sessions}/**/*.jsonl`, assembling each user turn plus the assistant reply that followed into an `Exchange`. |
| **Embed** | Uses `Xenova/all-MiniLM-L6-v2` (384-d) via `@xenova/transformers`. First run downloads the model if it is not already cached. No API keys are required. |
| **Store** | Writes to a local SQLite database with FTS5 keyword tables and a `sqlite-vec` `vec0` vector table. |
| **Search** | Fuses vector and keyword branches with Reciprocal Rank Fusion (RRF). Supports `both`, `vector`, and `text` modes. |
| **Derive** | Extracts typed memory (decisions, gotchas, runbooks) into a reviewable inbox; builds a temporal entity/edge graph with supersession. |

## CLI

```sh
omp-episodic index                              # index all sessions
omp-episodic search "sqlite-vec" --mode text    # keyword-only search
omp-episodic recall "fix flaky vector search"   # task-scoped evidence bundle
omp-episodic stats                              # index statistics
```

### Command reference

| Command | Description |
| --- | --- |
| `index` | Index OMP transcripts into the local SQLite database. |
| `search` | Hybrid search over indexed exchanges (`--mode both\|vector\|text`). |
| `recall` | Build a task-scoped evidence bundle with confidence and abstention. |
| `stats` | Show index statistics (exchanges, sessions, date range). |
| `extract` | Propose typed derived memories (decisions/gotchas/runbooks) into the inbox. |
| `inbox` | List derived memories by status (pending/approved/rejected/superseded). |
| `approve` | Approve a pending derived memory by id. |
| `reject` | Reject a derived memory by id, with an optional reason. |
| `memories` | Search approved/derived memories by query, type, project, or status. |
| `graph` | Build or inspect the temporal project graph (entities and edges). |
| `diff` | Show what derived memory changed since a given date. |
| `eval` | Run the recall eval harness over a question/session fixture set. |
| `context` | Show pinned project-context blocks plus recent approved decisions/gotchas/runbooks. |
| `blocks` | Manage pinned project-context blocks (`list`, `set <kind>`, `rm <id>`). |

Common flags: `--mode both|vector|text`, `--limit N`, `--after YYYY-MM-DD`, `--before YYYY-MM-DD`, `--project P`, `--json`, `--db PATH`, `--sessions DIR`, `--max N`.

Environment:

| Variable | Purpose |
| --- | --- |
| `OMP_EPISODIC_DB` | Index database path. |
| `OMP_SESSIONS_DIR` | Default session corpus for CLI indexing. |
| `OMP_EPISODIC_SESSIONS_DIR` | Root allowed by the MCP `read` tool. Set this if you index a non-default session directory. |
| `XDG_DATA_HOME` | Base directory for the default index path. |

## Benchmarks

The `eval` command runs a reproducible recall benchmark over a fixture set of questions and sessions:

```sh
omp-episodic eval --questions <file> --sessions <dir> --mode text
```

It builds (or reuses, with `--no-build`) an index from the fixtures, runs each question through recall, and reports:

| Metric | Meaning |
| --- | --- |
| **Recall@1 / Recall@5** | Fraction of questions whose expected source appears in the top 1 / top 5 results. |
| **MRR** | Mean reciprocal rank of the expected source. |
| **Abstention accuracy** | Fraction of unanswerable questions on which recall correctly abstains. |
| **False-positive rate** | Fraction of unanswerable questions answered anyway (confident when it should abstain). |
| **p50 / p95 latency** | Median and tail per-query latency. |

Current baseline on the bundled synthetic fixtures (text mode):

| Metric | Result |
| --- | --- |
| Recall@5 | 100% |
| Abstention accuracy | 100% |
| False-positive rate | 0% |
| p50 latency | sub-millisecond |

These numbers are on small synthetic fixtures. They are a regression guardrail to catch retrieval/abstention regressions, not a leaderboard claim about real-world corpora.

## MCP server

The package ships a second binary, `omp-episodic-mcp` (`./dist/mcp-server.js`), that runs the MCP stdio server. Register it in any harness that speaks MCP (Claude Code, Codex, Oh My Pi).

Using the published package via `npx` (the `-p` flag selects the named bin, since it differs from the package name):

```json
{
  "mcpServers": {
    "omp-episodic-memory": {
      "command": "npx",
      "args": ["-y", "-p", "omp-episodic-memory", "omp-episodic-mcp"]
    }
  }
}
```

If installed globally (`npm install -g omp-episodic-memory`), the `omp-episodic-mcp` command is on your PATH:

```json
{
  "mcpServers": {
    "omp-episodic-memory": {
      "command": "omp-episodic-mcp"
    }
  }
}
```

For a local checkout, build first (`bun run build`) and point at the file directly:

```json
{
  "mcpServers": {
    "omp-episodic-memory": {
      "command": "node",
      "args": ["/absolute/path/to/omp-episodic-memory/dist/mcp-server.js"]
    }
  }
}
```

Tools:

| Tool | Purpose |
| --- | --- |
| `search` | Hybrid retrieval over indexed sessions. Returns markdown or JSON. |
| `read` | Reads a full session transcript by path, constrained to the configured sessions root. |
| `recall_for_task` | Task-scoped evidence bundle with confidence tiers and explicit abstention. |
| `list_gotchas` | Approved failure-mode memories for a project/task, so the agent avoids repeating a known mistake. |
| `get_project_context` | Pinned project context plus recent approved decisions, gotchas, and runbooks. |

The MCP server starts an embedding-model prewarm in the background. A first vector search can still be slow if the model cache is cold or the download has not finished; `mode: "text"` avoids the embedding path.

## Development

Local development uses [Bun](https://bun.sh):

```sh
bun install        # install dependencies
bun run check      # type-check (tsc --noEmit)
bun run test       # run the test suite
```

Tests run on Node's built-in test runner via `tsx` (`node --import tsx --test`).

## Requirements

- Node.js 20+
- Bun for local development commands
- A platform supported by `better-sqlite3` and `sqlite-vec`
- Network access on first embedding run unless the Transformers.js model is already cached

## Layout

| File | Role |
| --- | --- |
| `src/types.ts` | Shared contract and portable defaults. |
| `src/parser.ts` | OMP JSONL to `Exchange[]` parser. See `FORMAT.md`. |
| `src/db.ts` | SQLite schema, read-only open path, and upsert/re-embed writes. |
| `src/embeddings.ts` | MiniLM embedding singleton with balanced user/assistant truncation. |
| `src/indexer.ts` | Crawl, embed, upsert, and persist pipeline. |
| `src/search.ts` | Hybrid RRF retrieval. |
| `src/cli.ts` | CLI commands: index, search, recall, stats, extract, inbox, approve, reject, memories, graph, diff, eval, context, blocks. |
| `src/blocks.ts` | Pinned project-context blocks and the project-context aggregator. |
| `src/mcp-server.ts` | MCP stdio server: `search`, `read`, `recall_for_task`, `list_gotchas`, `get_project_context`. |

## License

MIT
