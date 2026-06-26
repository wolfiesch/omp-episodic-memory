# OMP session JSONL format (parser contract)

Each session is one `.jsonl` file under `~/.omp/agent/sessions/<project-dir>/...`.
Files: `<timestamp>_<sessionId>.jsonl`. Subdirectories named after a session id hold
subagent transcripts (same line format) — index them too; their `sessionId` comes
from their own header line if present, else falls back to the JSONL filename stem.

## Line types (field `type`)

- `session` — FIRST line, the header. Fields we use:
  - `id` (string) — session id
  - `timestamp` (ISO string) — session start
  - `cwd` (string) — working dir
  - `title` (string, optional) — human title
- `model_change`, `thinking_level_change`, `mcp_tool_selection`, `compaction`,
  `custom_message`, `bashExecution` — IGNORE for indexing.
- `message` — the conversational events. Shape:
  ```json
  {
    "type": "message",
    "id": "1e45da8e",
    "parentId": "5372a733",
    "timestamp": "2026-06-19T03:36:07.754Z",
    "message": {
      "role": "user" | "assistant" | "toolResult",
      "content": [ <ContentPart>... ],
      "timestamp": 1781840167713   // epoch MILLISECONDS, may be present
    }
  }
  ```

## ContentPart shapes (inside `message.content[]`)

- `{ "type": "text", "text": "..." }` — primary text. NOTE: assistant text parts
  can have `text: ""` (phase markers). Skip empty strings.
- `{ "type": "thinking", ... }` — IGNORE (do not index reasoning).
- `{ "type": "toolCall", "name": "read", "arguments": {...}, "id": "..." }` —
  collect distinct `name`s into `toolNames` and append a `toolEvents` entry with
  `callId`, `toolName`, normalized `arguments`, derived `command`, and derived
  top-level `filePaths`.
- `{ "type": "image", ... }` — IGNORE.
- Role `toolResult` messages — ignore their content for assistant prose, but
  merge it into `toolEvents.resultText`, `isError`, `details`, and `exitCode`.

## Exchange assembly (parser output = Exchange[])

Walk `message` events in file order. Maintain a "current exchange" state machine:

1. On a `user` message with at least one non-empty `text` part:
   - flush any in-progress exchange,
   - start a new exchange: `userText` = join of non-empty user text parts (`\n`),
     `timestamp` = floor(message.timestamp ms / 1000) if present else parse the
     line `timestamp` ISO to epoch seconds, `ordinal` = running counter.
2. On `assistant` messages that follow (before the next `user`):
   - append non-empty `text` parts to `assistantText` (`\n\n` between parts),
   - add any `toolCall` `name`s to `toolNames` (dedup),
   - append corresponding `toolEvents` with call id, arguments, command, and file paths.
3. On `toolResult` messages that follow (before the next `user`), merge result
   text, error state, details, and exit code into the matching `toolEvents` item.
4. All non-message lines: ignore.
5. At EOF, flush the final in-progress exchange.

Drop exchanges whose `userText` is empty after trimming. An exchange with empty
`assistantText` is still valid (user turn with no captured prose reply).

`sessionId`, `title`, `cwd`, `sourcePath` come from the header line and are stamped
onto every exchange from that file.

## Timestamps
- `message.message.timestamp` is epoch **milliseconds**.
- Line-level `timestamp` is an **ISO 8601 string**.
- `Exchange.timestamp` MUST be epoch **seconds** (integer).
