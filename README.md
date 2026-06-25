# omp-episodic-memory

Hybrid semantic + keyword search over [Oh My Pi](https://github.com/can1357/oh-my-pi) session transcripts. It indexes past OMP conversations into a local SQLite database and exposes them through a CLI and MCP server, so an agent can recover prior decisions, solutions, and context across sessions.

Read-only with respect to OMP state: it reads session JSONL files and writes only to its own index database.

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

## CLI

```sh
omp-episodic index                              # index all sessions
omp-episodic search "sqlite-vec" --mode text    # keyword-only search
omp-episodic search "genealogy research" --json # machine-readable output
omp-episodic stats                              # index statistics
```

Flags: `--mode both|vector|text`, `--limit N`, `--after YYYY-MM-DD`, `--before YYYY-MM-DD`, `--json`, `--db PATH`, `--sessions DIR`, `--max N`.

Environment:

| Variable | Purpose |
| --- | --- |
| `OMP_EPISODIC_DB` | Index database path. |
| `OMP_SESSIONS_DIR` | Default session corpus for CLI indexing. |
| `OMP_EPISODIC_SESSIONS_DIR` | Root allowed by the MCP `read` tool. Set this if you index a non-default session directory. |
| `XDG_DATA_HOME` | Base directory for the default index path. |

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
| `src/cli.ts` | `index`, `search`, and `stats`. |
| `src/mcp-server.ts` | MCP stdio server with `search` and `read`. |

## License

MIT
