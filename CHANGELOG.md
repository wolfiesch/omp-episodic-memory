# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-25

### Added

- Hybrid semantic + keyword search over Oh My Pi (OMP) session transcripts, fusing vector and keyword results with Reciprocal Rank Fusion (RRF).
- Local SQLite index combining an FTS5 keyword table with a `sqlite-vec` `vec0` vector table.
- Local embeddings via Transformers.js (`Xenova/all-MiniLM-L6-v2`, 384-dimensional); no API keys required.
- CLI (`omp-episodic`) with `index`, `search`, and `stats` commands.
- MCP stdio server exposing read-only `search` and `read` tools.

[Unreleased]: https://github.com/wolfiesch/omp-episodic-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/wolfiesch/omp-episodic-memory/releases/tag/v0.1.0
