# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  derived memories returning a confidence-tiered, provenance-backed evidence
  bundle with a token-budgeted suggested context and explicit abstention when
  nothing relevant exists. Exposed as a CLI `recall` command and an MCP
  `recall_for_task` tool.

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

[Unreleased]: https://github.com/wolfiesch/omp-episodic-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wolfiesch/omp-episodic-memory/releases/tag/v0.1.0
