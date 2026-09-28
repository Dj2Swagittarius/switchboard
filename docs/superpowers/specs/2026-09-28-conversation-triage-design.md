# Conversation triage

2026-09-28. Status: approved in chat (options A, A, A, A).

## Problem

Triage runs once per inbound text, with only the 4 messages before it as
context. A tech who sends twelve texts produces twelve queue cards, each
judged half-blind. The Messages window has no triage at all; the whole-thread
"Catch me up" summary exists only on the Triage page.

## Decisions

1. **The unit of triage is the conversation** (one remote number). The Triage
   page keeps working as a queue, one card per conversation, updated as new
   texts arrive.
2. **A card leaves the queue when we reply** (from the card, from Messages, or
   from any other phone on the account), or when marked Done. The next inbound
   text reopens it.
3. **Messages gets a Triage button** on every conversation. It works on request
   whenever an AI platform is set, even with background triage off.
4. **Connector mode:** the button asks Claude. The conversation joins the
   connector's waiting list; the panel says "Waiting for Claude…" and fills in
   when Claude saves. The connector tools become conversation-level.

## What a triage says

One schema (`CONVERSATION_SCHEMA`, lib/llm.mjs) replaces both the per-message
triage schema and the thread-summary schema:

| field | meaning |
|---|---|
| `summary` | one short line: the latest development (notifications, card title line) |
| `situation` | 2–3 sentences: what this conversation is about and where it stands |
| `open_items` | concrete unresolved things; empty if none |
| `last_ask` | the most recent request, near-verbatim; empty if none |
| `waiting_on` | `us` / `them` / `nobody` |
| `category`, `urgency`, `from_role`, `needs_human`, `reason` | as today, judged on the conversation's current state |
| `suggested_reply` | draft reply to the conversation as it stands now; empty if none is needed or it would need invented facts |

Instructions: the existing built-in or custom triage instructions, with a
framing line saying the input is a whole conversation and urgency is about
where it stands now (an old emergency that was resolved is not urgent).
`OUTPUT_RULES` gains the new fields. A roster role still overrides `from_role`.

Input: the conversation's last 40 messages, oldest first, `THEM`/`US` with
timestamps, from the full thread (lib/messaging.mjs `thread()`, as the recap
uses), not the short triage feed. Photos appear as their saved description
when one exists, otherwise `[photo attached]`.

## Storage

`queue.jsonl` (lib/store.mjs) stays the store; conversation entries sit next
to the old per-message ones so Insights keeps its history.

- Conversation entry id: `c:` + the remote's last 10 digits.
- Fields: `remote`, `local` (line of the latest inbound, where a reply goes
  from), `name`, the schema fields, `through_at` / `through_id` (the newest
  message the triage has seen), `triaged_at`, `triaged_by` (`app` or
  `connector`), `recent` (inbound texts since our last reply, for the card),
  and `status: 'awaiting_triage'` while waiting for Claude.
- Queue = unresolved conversation entries. Resolutions: `sent` (from the
  card), `replied` (an outbound message is now the newest in the thread),
  `done` (marked by hand), `viewed` (created by an on-request triage of a
  conversation that isn't waiting on us: kept for the panel, not queued).
- New `store.upsert(id, patch)` creates or merges; reopening clears
  `resolution` / `resolved_at`.
- Migration, once: every unresolved per-message entry is resolved `merged`.
  Their conversations are picked up by the next pass (the normal backlog limit
  applies).

Photo descriptions move to `photo-notes.json` (message id → description) so
they outlive the per-message entries. lib/review.mjs reads it, falling back
to old queue entries.

## Background pass (lib/pipeline.mjs `runOnce`)

1. Fetch as today. `fresh` = inbound messages not in `skip` and newer than
   their conversation entry's `through_at` (instead of `!store.has(id)`).
2. Group `fresh` by conversation. The backlog limit counts conversations.
3. Per conversation: describe any new photos (setting permitting) into
   photo-notes, load the full thread, triage it, upsert the entry, reopen it.
   Connector mode: upsert as `awaiting_triage` with the transcript instead.
4. Auto-close: any unresolved conversation entry whose thread's newest message
   is outbound is resolved `replied`.
5. Notifications: one `item` per conversation triaged (not per text), same
   payload shape (`summary` is the one-line headline). Plain announcements for
   triage-off and AI-down are unchanged and stay per message.

Failure: triage error for a conversation leaves `through_at` unchanged so the
next pass retries; the texts are announced once as today.

## On request

- `GET /api/triage?remote=` → `{ entry, stale }`; `stale` when the thread has
  messages newer than `through_at`.
- `POST /api/triage?remote=` → runs it now and returns the entry. It updates
  an existing entry's analysis without changing its open/closed state; with no
  entry it creates one, open if the newest message is inbound and background
  triage is on, else resolved `viewed`. Connector mode: marks the entry
  `awaiting_triage` (open, so Claude's `list_pending` sees it) and returns it.
- App key required (like the other app routes).

## Connector

- `list_pending` returns conversations: id, number, name, known role, line,
  latest time, the transcript (last 40 messages), and photo refs
  (`{ id: messageId, n }`).
- `save_triage` takes the conversation id and `CONVERSATION_SCHEMA`.
- `/api/connector/media` looks a photo up by message id within the waiting
  entry's photo refs.
- MCP tool descriptions, the Claude Desktop bundle's tool list and the
  triage-inbox prompt are reworded for conversations.

## UI

**Triage page (ui.html).** One card per conversation: number/name, tags
(urgency, category, role, needs you), time of the latest text; the `recent`
inbound texts; `summary` + `situation`, open items, last ask; the draft
reply; buttons Send, Done, Open conversation (→ `/messages#<remote>`), role
select. "Catch me up" goes: the card already is the catch-up.

**Messages (messages.html).** A Triage button in the thread header. It opens a
panel under the header:
- shows the saved triage if it's current; if stale or missing, runs one
  (spinner "Reading the conversation…");
- urgency tag, `summary`, `situation`, open items, last ask, waiting on;
- "Use reply" puts `suggested_reply` in the composer (never sends);
- Refresh re-runs it; errors show in the panel;
- connector mode: "Waiting for Claude…" until a `queue` event brings the saved
  triage.

## Testing

- Unit: `store.upsert` (create, merge, reopen), transcript builder, the
  open/close rules (pure function over thread + entry), migration.
- Connector tests updated for conversation ids and the new schema; MCP test
  for the new tool shapes.
- Manual, in a throwaway data folder: Triage page cards, Messages panel,
  connector waiting state.

## Out of scope

Urgency dots in the Messages conversation list; auto-reply (CLI only, not
shipped); the bot.mjs / triage.mjs CLIs keep the per-message `triage()`.
