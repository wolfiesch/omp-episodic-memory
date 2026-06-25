# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-06-25

### Fixed

- `bin` paths no longer use a leading `./`, which npm's bin-path validator
  rejected — silently dropping both `omp-episodic` and `omp-episodic-mcp`
  binaries from the published package. First registry-publishable release.

## [1.0.0] - 2026-06-25

### Added

- Typed derived-memory layer (`memory_records`): reviewable `decision`, `gotcha`,
  `runbook`, `fact`, `preference`, and `project_state` records with required
  provenance back to source exchanges, idempotent upsert keyed on
  `(type, title, project)`, FTS5 search, and a status lifecycle
  (`pending`/`approved`/`rejected`/`superseded`) where pending records are
  excluded from retrieval by default.
- Heuristic, network-free extractor that distills decisions, gotchas, and
  runbooks from raw episodes into pending memory records.
- CLI review inbox: `extract`, `inbox`, `approve`, `reject`, and `memories`
  commands.
- `recall_for_task` engine: intent-routed retrieval over episodes and approved
  derived memories returning a confidence-tiered (`high`/`medium`/`low`/`abstain`),
  provenance-backed evidence bundle with a token-budgeted suggested context and
  explicit abstention when nothing relevant exists. Exposed as a CLI `recall`
  command and an MCP `recall_for_task` tool.
- Temporal project graph (`graph_entities` + `graph_edges`): entities
  (project/repo/file/package/command/error/decision/tool) and time-bounded edges
  (uses/failed_with/fixed_by/supersedes/touches/belongs_to) with provenance and
  validity windows; heuristic extraction from episodes and decision memories.
- Decision supersession (older same-subject decisions marked `superseded` with
  `valid_to` closed) and a `memoryDiff` between two time points. CLI `graph`
  (build/edges/stats) and `diff` commands.
- Recall evaluation harness: JSONL question format keyed on stable
  `(sessionId, ordinal)` + memory-title substrings; scores Recall@1/@5, MRR,
  abstention accuracy, false-positive rate, and p50/p95 latency over an isolated
  index. CLI `eval` command and a CI smoke-eval step.
- Pinned project-context blocks (`project_rules`, `workflow_preferences`,
  `known_risks`, `positioning`) and a `get_project_context` aggregator. CLI
  `blocks` and `context` commands; MCP `get_project_context` and `list_gotchas`
  tools.
- Incremental indexing: unchanged session files are skipped via stored mtimes
  (`indexed_files`); `--force` re-indexes. Index reports files skipped.
- MCP server migrates schemas on startup so pre-existing indexes gain new tables.

### Fixed

- External-content FTS5 updates now use the `'delete'` command with the old
  column values instead of `DELETE … WHERE rowid`, preventing
  `SQLITE_CORRUPT_VTAB` on re-indexing changed exchanges.

## [0.1.0] - 2026-06-25

### Added

- Hybrid semantic + keyword search over Oh My Pi (OMP) session transcripts, fusing vector and keyword results with Reciprocal Rank Fusion (RRF).
- Local SQLite index combining an FTS5 keyword table with a `sqlite-vec` `vec0` vector table.
- Local embeddings via Transformers.js (`Xenova/all-MiniLM-L6-v2`, 384-dimensional); no API keys required.
- CLI (`omp-episodic`) with `index`, `search`, and `stats` commands.
- MCP stdio server exposing read-only `search` and `read` tools.

[1.0.1]: https://github.com/wolfiesch/omp-episodic-memory/releases/tag/v1.0.1
[1.0.0]: https://github.com/wolfiesch/omp-episodic-memory/releases/tag/v1.0.0
[0.1.0]: https://github.com/wolfiesch/omp-episodic-memory/releases/tag/v0.1.0
