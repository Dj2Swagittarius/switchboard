# Claude Connector + Claude Code Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Desktop / Cowork / Claude Code do Switchboard's triage and recap without an API key — via a local MCP connector (pull) and a Claude Code CLI platform (push).

**Architecture:** New `connector` and `claudecode` values for `ai.provider`. Connector mode queues inbound texts as `awaiting_triage`; token-protected `/api/connector/*` routes expose them; a dependency-free stdio MCP server (`mcp/switchboard-mcp.mjs`) proxies Claude's tool calls to those routes. Claude Code mode spawns `claude.exe -p --json-schema …` per `ai.json`/`ai.vision` call, serialized.

**Tech Stack:** Node 24 ESM, Electron 44, `node:test` for tests, MCP JSON-RPC 2.0 over newline-delimited stdio (protocol `2025-06-18`), Claude Code CLI 2.1.x.

## Global Constraints

- Everything stays on 127.0.0.1. No tool sends texts, calls, or changes account settings.
- Never launch the real app or use live data in tests; use temp `SWITCHBOARD_DATA` dirs.
- UI names no phone vendor. "Claude" may be named (it is the product being connected).
- Existing platforms (lmstudio, ollama, anthropic, openai) behave exactly as before.
- Code style: match surrounding files — terse comments explaining *why*, 2-space indent, ESM, no new deps.
- Deviation from spec (recorded): the MCP server is hand-rolled JSON-RPC, not `@modelcontextprotocol/sdk`, because the unpacked script cannot resolve modules inside `app.asar`. `isCloud()` stays "needs an API key"; a new `bigContext()` covers "large context window".

---

### Task 1: Schema validator + store.update

**Files:**
- Create: `lib/schema.mjs`, `test/schema.test.mjs`, `test/store.test.mjs`
- Modify: `lib/store.mjs` (add `update`), `package.json` (add `"test": "node --test test/"`)

**Interfaces — Produces:**
- `validate(schema, value) → string[]` (empty = valid). Supports `type` object/array/string/boolean/number/integer, `enum`, `required`, `properties`, `additionalProperties:false`, `items`.
- `store.update(id, patch) → entry|null` — merges patch into the matching row; keys set to `undefined` are removed.

Tests: valid triage object → `[]`; missing field, wrong enum, extra key, wrong nested array item → one message each naming the path (e.g. `follow_ups[0].priority`). store.update merges, removes undefined keys, returns null for unknown id (temp `SWITCHBOARD_DATA`).

### Task 2: Connector queue + pipeline

**Files:**
- Create: `lib/connector.mjs`, `test/connector.test.mjs`
- Modify: `lib/llm.mjs` (export `SCHEMA` as `TRIAGE_SCHEMA`), `lib/ai.mjs` (`connector` provider, `ConnectorModeError`, `bigContext`), `lib/pipeline.mjs`, `lib/settings.mjs` (provider enum), `lib/review.mjs` (`due()` false in connector mode; use `bigContext`)

**Interfaces — Produces (`lib/connector.mjs`):**
- `token() → string` (creates 64-hex token in secrets `connector.token` on first use; throws if secure storage unavailable)
- `newToken() → string`
- `authorized(req) → boolean` (Bearer, constant-time)
- `entryFor(m, {history, contact, rawMedia}) → entry` with `status:'awaiting_triage'`, `known_role`, `history:[{at,inbound,text}]`, `media:[{url,mime}]`
- `pending(limit=20) → entry[]` (oldest first, max 50)
- `saveTriage(id, body) → {ok:true, entry} | {ok:false, code:404|400, errors}`; roster role overrides `from_role`.

Pipeline: when `ai.provider()==='connector'`, skip `enrich`/`triage`; `store.add(connector.entryFor(...))`; announce plain via `onMessage` when news. Queue page shows these cards with an "awaiting Claude" tag.

### Task 3: Recap split for connector

**Files:** Modify `lib/review.mjs`

**Produces:**
- `collect(session, day, {transcribe, onStep}) → {base, empty, material(level)}` (run() refactored onto it, behaviour unchanged)
- `connectorDay(session, day) → {day, empty, stats, instructions, schema, material}` (no transcription; caches base per day)
- `saveConnectorRecap(session, day, recap) → {ok, errors?}` (validates vs `RECAP_SCHEMA`, saves `{...base, provider:'connector', model:'Claude app', recap}`)

### Task 4: Connector HTTP routes

**Files:** Modify `server.mjs`, `ui.html`

Routes under `/api/connector/` (Bearer token; 401 otherwise; 409 when not signed in): `GET pending`, `GET media?id=&n=`, `GET thread?with=`, `POST triage?id=`, `GET day?date=`, `POST recap?date=`, `GET instructions`. Media downscaled to ≤1568px JPEG via nativeImage when available. After a save: `push('queue', store.pending())`.

Settings actions (app key): `connectorInfo` → `{token, exe, script, dataDir, command, desktopConfig}`; `connectorNewToken`; `connectorBundle` → writes `.mcpb` and opens it.

### Task 5: MCP stdio server

**Files:** Create `mcp/switchboard-mcp.mjs`, `test/mcp.test.mjs`; Modify `package.json` build `files` + `asarUnpack`.

Implements `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`. Tools: `list_pending`, `get_thread`, `save_triage`, `get_day`, `save_recap`. Prompts: `triage-inbox`, `daily-recap`. Error texts per spec. Test spawns it against a fake HTTP server and drives JSON-RPC.

### Task 6: Claude Code platform

**Files:** Create `lib/claudecode.mjs`, `test/claudecode.test.mjs` (stub exe via `SWITCHBOARD_CLAUDE` env); Modify `lib/ai.mjs`, `lib/settings.mjs` (`ai.claudeCodeModel`, `ai.claudeCodeVisionModel`, default `sonnet`).

**Produces:** `find() → path|null` (env `SWITCHBOARD_CLAUDE`, `~/.local/bin/claude.exe`, `where claude.exe`); `status() → {ok, version?, error?}`; `json({system,user,schema,model}) → object`; `vision({prompt,image,model}) → string`. Serialized via promise chain; 120 s timeout; `TooLongError` on context-limit messages.

### Task 7: Settings UI

**Files:** Modify `settings.html`

- Platform options: "Claude app — connector (no API key)", "Claude Code — this PC (no API key)".
- Connector section: token (masked, copy), Install in Claude Desktop, Claude Code command (copy), New token, scheduling tip.
- Claude Code row: status line + Test; model pickers list `sonnet/opus/haiku`.

### Task 8: Verify

- `npm test` green; `node --check` on all touched files.
- Temp-data server run (`SWITCHBOARD_DATA=<tmp> UI_PORT=8799 node server.mjs`) + MCP server against it: tools/list, list_pending (empty, not-signed-in message), bad token → 401 text.
- One real `claudecode` `ai.json` + `ai.vision` call via a node script with temp data.
- `npm run smoke` if it runs headless without touching live data; else report skipped.
