# Claude connector and Claude Code platform — design

Date: 2026-09-25
Status: approved design, awaiting spec review

## Goal

Let people who have Claude Desktop, Claude Cowork, Claude Code, or a regular
Claude plan use it for Switchboard's AI work (message triage, reply drafts,
thread summaries, daily recap) without a Claude API key.

Two parts, built in this order:

- **Part B — Switchboard connector (MCP, pull).** Works with Claude Desktop,
  Cowork and Claude Code. Claude reads pending items from Switchboard and
  writes triage results back. Runs when asked or on a schedule, not instantly.
- **Part A — Claude Code platform (push).** A new AI platform in Settings that
  runs the user's installed `claude` CLI headless for every AI job. Instant,
  Claude Code users only.

## Non-goals

- No tool that sends texts, places calls, or changes account settings. Claude
  writes triage and drafts; a person presses Send in Switchboard.
- No remote (internet-facing) connector. Everything stays on 127.0.0.1.
- No change to the existing LM Studio / Ollama / Claude API / OpenAI platforms.

## Current state

All AI goes through `lib/ai.mjs`: `ai.json({system, user, schema, name, model})`
and `ai.vision({prompt, image, model})`, dispatching on `settings.ai.provider`
(`lmstudio | ollama | anthropic | openai`). Callers:

- `lib/pipeline.mjs` `runOnce` → `lib/llm.mjs` `triage()` → queue entry in
  `queue.jsonl` (`lib/store.mjs`).
- `lib/media.mjs` `enrich` → `ai.vision` (photo descriptions).
- `lib/thread.mjs` `summarizeThread`, `lib/review.mjs` daily recap,
  `lib/stt.mjs`.

`server.mjs` listens on `127.0.0.1:${UI_PORT ?? 8787}` with no request auth.

## Part B — Switchboard connector

### Platform choice

New value `connector` for `ai.provider`, labelled "Claude app (connector)".
`ai.isCloud('connector')` is false; `ai.json`/`ai.vision` throw
`ConnectorModeError` ("Triage runs from the Claude app in connector mode") if
called, so any caller that is not connector-aware fails loudly, not silently.

### Pipeline change

In `runOnce`, when the provider is `connector`:

- Photo description is skipped (Claude sees the images itself).
- Instead of calling `triage()`, the message goes into the queue with
  `status: 'awaiting_triage'`, the normalized message, thread history ids, and
  the known contact role. It is announced as new, as with triage off.
- Messages page shows these entries with an "Awaiting triage" badge.

When `save_triage` arrives, the entry gets the triage fields (same shape the
inline path writes today) and `status` is removed, so the rest of the app
treats it exactly like an inline-triaged entry.

Thread summaries and the recap button in the UI show "Ask Claude to do this
from the Claude app" in connector mode instead of running.

### Local API

New routes in `server.mjs` under `/api/connector/`, all requiring header
`Authorization: Bearer <token>`:

| Route | Does |
|---|---|
| `GET  /api/connector/pending?limit=N` | Awaiting-triage entries, oldest first, default 20, max 50. Each: id, line, from, known role, text, media refs, last 10 thread messages. |
| `GET  /api/connector/media/:id` | One photo, bytes + content type. |
| `GET  /api/connector/thread?with=<number>&line=<line>` | A conversation, last 50 messages. |
| `POST /api/connector/triage/:id` | Body validated against the triage schema in `lib/llm.mjs`. 400 with the field errors on failure. 404 unknown id. A second save overwrites and is logged. |
| `GET  /api/connector/day?date=YYYY-MM-DD` | The recap inputs `lib/review.mjs` already gathers (texts, calls, voicemail transcripts). |
| `POST /api/connector/recap?date=YYYY-MM-DD` | Body validated against the recap schema; stored where `review.mjs` stores recaps, `provider: 'connector'`. |
| `GET  /api/connector/instructions` | Current triage instructions (`llm.instructions()`) and recap instructions, plus both JSON schemas. |

Token: 32 random bytes, hex, created on first use, stored with
`lib/secrets.mjs` under `connector.token`. Compared in constant time. The
existing unauthenticated routes are unchanged.

The schemas move to exported constants (`llm.TRIAGE_SCHEMA`,
`review.RECAP_SCHEMA`) with a small validator in `lib/schema.mjs`
(type, enum, required, additionalProperties — only what these schemas use).

### MCP server

`mcp/switchboard-mcp.mjs`: stdio MCP server using
`@modelcontextprotocol/sdk`. Reads `SWITCHBOARD_URL` (default
`http://127.0.0.1:8787`) and `SWITCHBOARD_TOKEN` from env. Each tool is a thin
call to one route above.

Tools:

- `list_pending(limit?)` — returns text content per message, plus image
  content blocks for photos (fetched via `/media/:id`, max 4 per message,
  downscaled by the server to ≤1568 px long edge).
- `get_thread(with, line)`
- `save_triage(id, category, urgency, from_role, summary, needs_human, reason, suggested_reply)` — input schema is the triage schema.
- `get_day(date)`
- `save_recap(date, recap)`

Prompts:

- `triage-inbox` — the current triage instructions, then: "Call
  list_pending, triage each message, call save_triage for each. Drafts only;
  never claim a message was sent."
- `daily-recap(date?)` — recap instructions, then: "Call get_day, write the
  recap, call save_recap."

Errors surfaced as tool errors with plain text: connection refused →
"Switchboard isn't running. Open it and try again."; 401 → "The Switchboard
token changed. Reconnect from Switchboard → Settings → Connect to Claude.";
400 → the validation messages.

### Packaging

- `mcp/**` added to `files` and `asarUnpack` so Claude can run it with the
  bundled Node from Electron (`ELECTRON_RUN_AS_NODE=1` + Switchboard.exe).
- `@modelcontextprotocol/sdk` added to dependencies.

### Settings → Connect to Claude

New section on `settings.html`, shown for every platform choice:

- **Install in Claude Desktop** — writes a `.mcpb` bundle (manifest pointing
  at Switchboard.exe with `ELECTRON_RUN_AS_NODE=1` and the unpacked
  `mcp/switchboard-mcp.mjs`, token in env) to the data folder and opens it,
  which starts Claude Desktop's install dialog. Covers Desktop and Cowork.
- **Claude Code command** — a copyable line:
  `claude mcp add switchboard --env SWITCHBOARD_TOKEN=<token> -- "<exe>" "<script>"`
  with `ELECTRON_RUN_AS_NODE=1` in env.
- **New token** — regenerates; old installs then get the 401 message.
- Tip text: in Cowork or Claude Code, schedule "triage my Switchboard inbox"
  every 15 minutes.

UI text names Claude (the product being connected), consistent with the
existing "Claude" AI platform label. No phone-provider names.

## Part A — Claude Code platform

New value `claudecode` for `ai.provider`, label "Claude — through Claude Code
on this computer". Settings key `ai.claudeCodeModel` (default `sonnet`;
free text validated by `isModel`).

### Calls

`ai.json` with `claudecode`:

```
claude -p --output-format json --json-schema <schema file>
       --system-prompt <system> --model <model>
       --tools "" --no-session-persistence
```

User content goes on stdin. Run with `cwd` = a fresh temp dir, timeout 120 s.
Parse stdout JSON; take `structured_output`. Non-zero exit, `is_error: true`,
or missing `structured_output` → `Error` with the CLI's message. A result that
reports the context limit → `TooLongError`.

`ai.vision` with `claudecode`: write the image to the temp dir, run with
`--allowedTools Read` and the prompt naming that file; read `result` as text.

One CLI call at a time: a module-level promise chain in `ai.mjs`, so a burst
of messages queues instead of spawning many processes.

`ai.isCloud('claudecode')` is true (large context, so `review.mjs` uses the
cloud budgets). `listModels('claudecode')` returns `['sonnet','opus','haiku']`.

### Detection

`ai.claudeCodeStatus()` runs `claude --version` (5 s timeout). Settings shows
"Found Claude Code <version>" or "Install Claude Code and sign in first",
with a **Test** button that runs one tiny `ai.json` call and shows the error
text if login is missing.

### Terms note

Settings shows: "Uses your own Claude plan through Claude Code on this
computer." Before this platform is advertised to other users, confirm it fits
Anthropic's rules on third-party apps using Claude subscription logins. The
connector (Part B) has no such concern: the user runs Claude, which calls
Switchboard.

## Testing

Per project rule: never launch the real app or touch the live account; test
against a temp copy of the data folder.

- `lib/schema.mjs` validator: unit tests for each rule and both schemas.
- Queue: awaiting-triage entry created in connector mode; `save_triage`
  turns it into a normal entry; unknown id → 404; bad body → 400.
- Routes: missing/wrong token → 401.
- MCP server: run against a temp server, drive with MCP Inspector —
  list_pending (incl. an image), save_triage, prompts listed, Switchboard-down
  error text.
- Claude Code platform: stub `claude` script on PATH for success, error,
  missing structured_output, timeout; then one real `triage()` call.
- `npm run smoke` still passes.

## Open risks

- `.mcpb` format details for launching via Switchboard.exe as Node must be
  verified against current Claude Desktop during implementation; fallback is
  instructions to add the server in Claude Desktop's config file.
- Claude Code CLI flags (`--json-schema`, `--tools`) must be checked against
  the installed version; the status check reports an unsupported version.
