# Conversation Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triage whole conversations instead of single texts, one queue card per conversation, and a Triage button + panel in the Messages window.

**Architecture:** A new `lib/convtriage.mjs` owns conversation triage: pure helpers (ids, transcript, open/close rules, entry patches) plus `analyze()` which loads a thread, runs the model (or queues it for the Claude connector) and upserts a `c:<10 digits>` entry in the existing `queue.jsonl` store. `lib/pipeline.mjs` groups new inbound texts by conversation and calls `analyze()`; it also closes open entries whose newest message is ours. Photo descriptions move to `lib/photonotes.mjs`. Server routes `/api/triage` serve the Messages panel.

**Tech Stack:** Node ESM, `node:test`, plain HTML/JS pages, Electron.

Spec: `docs/superpowers/specs/2026-09-28-conversation-triage-design.md`.

## Global Constraints

- Conversation entry id: `'c:' + last 10 digits of the remote`.
- Resolutions: `sent`, `replied`, `done`, `viewed`, and `merged` (migration of old per-message entries).
- Transcript: last 40 messages, oldest first, `YYYY-MM-DD HH:MM THEM|US: text`.
- A roster role always overrides the model's `from_role`.
- Suggested replies are drafts; nothing is sent without a person pressing Send.
- Every new data file goes through `dataPath()`.
- Tests run with `npm test` (`node --test test/*.test.mjs`) against a throwaway data folder (`test/helpers.mjs`).

## File map

| file | change |
|---|---|
| `lib/store.mjs` | + `upsert(id, patch)` |
| `lib/photonotes.mjs` | new: photo descriptions by message id |
| `lib/llm.mjs` | + `CONVERSATION_SCHEMA`, `conversationInstructions()`, `triageConversation()` |
| `lib/convtriage.mjs` | new: helpers, `analyze()`, `migrate()`, `closeReplied()` |
| `lib/pipeline.mjs` | AI path per conversation |
| `lib/connector.mjs` | conversation pending / saveTriage |
| `lib/review.mjs` | photo descriptions from photonotes |
| `lib/thread.mjs` | drop `summarizeThread` |
| `server.mjs` | `/api/triage`, connector routes, migration, done |
| `mcp/switchboard-mcp.mjs` | tool wording + shapes |
| `ui.html` | conversation cards |
| `messages.html` | Triage button + panel, `#to=` deep link |
| `changelog.json`, `package.json` | 0.4.0 |

---

### Task 1: store.upsert and photo notes

**Files:**
- Modify: `lib/store.mjs`
- Create: `lib/photonotes.mjs`
- Test: `test/convtriage.test.mjs`

**Interfaces:**
- Produces: `store.upsert(id: string, patch: object) → entry`; `photonotes.get(id) → string[] | null`, `photonotes.all() → {[id]: string[]}`, `photonotes.set(id, string[])`.

- [ ] **Step 1: failing tests** — `test/convtriage.test.mjs`:

```js
import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const store = await import('../lib/store.mjs');
const photonotes = await import('../lib/photonotes.mjs');

test('upsert creates, merges, and reopens', () => {
  store.upsert('c:5550001111', { remote: '+15550001111', urgency: 'low' });
  store.resolve('c:5550001111', 'replied');
  const e = store.upsert('c:5550001111', { urgency: 'high', resolution: undefined, resolved_at: undefined });
  assert.equal(e.urgency, 'high');
  assert.equal(e.remote, '+15550001111');
  assert.equal('resolution' in e, false);
  assert.ok(store.pending().some(x => x.id === 'c:5550001111'));
});

test('photo notes round-trip', () => {
  assert.equal(photonotes.get('m1'), null);
  photonotes.set('m1', ['a ladder', 'a gate']);
  assert.deepEqual(photonotes.get('m1'), ['a ladder', 'a gate']);
  assert.deepEqual(photonotes.all().m1, ['a ladder', 'a gate']);
});
```

- [ ] **Step 2:** `npm test` → FAIL (`store.upsert is not a function`, missing module).
- [ ] **Step 3: implement.** Append to `lib/store.mjs`:

```js
// Creates the entry, or merges `patch` into it (a key set to undefined is
// removed). Conversation triage keeps one entry per conversation this way.
export function upsert(id, patch) {
  if (has(id)) return update(id, patch);
  add(JSON.parse(JSON.stringify({ id, ...patch })));
  return all().find(e => e.id === id);
}
```

`lib/photonotes.mjs`:

```js
// What the vision model saw in each photo, by message id: an array, one
// description per image. Kept apart from the triage queue so conversation
// triage and the daily recap reuse it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('photo-notes.json');
const KEEP = 3000;

export function all() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}
export const get = (id) => all()[id] ?? null;
export function set(id, descriptions) {
  const n = all();
  delete n[id];
  n[id] = descriptions;
  const keys = Object.keys(n);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete n[k];
  writeFileSync(FILE, JSON.stringify(n));
}
```

- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** commit `store.upsert and photo notes`.

### Task 2: conversation schema and prompt

**Files:** Modify `lib/llm.mjs`; Test `test/convtriage.test.mjs`.

**Interfaces:**
- Produces: `CONVERSATION_SCHEMA`, `conversationInstructions() → string`, `triageConversation(text: string, { knownRole }) → Promise<answer>`.

- [ ] **Step 1: failing test** (append):

```js
const llm = await import('../lib/llm.mjs');
test('conversation schema and instructions', () => {
  const req = llm.CONVERSATION_SCHEMA.required;
  for (const k of ['summary', 'situation', 'open_items', 'last_ask', 'waiting_on', 'urgency', 'suggested_reply'])
    assert.ok(req.includes(k), k);
  assert.match(llm.conversationInstructions(), /whole SMS conversation/);
});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: implement** in `lib/llm.mjs` after `TRIAGE_SCHEMA`:

```js
// Triage of a whole conversation: the message-level fields judged on where the
// conversation stands now, plus the catch-up fields.
export const CONVERSATION_SCHEMA = {
  type: 'object',
  properties: {
    ...TRIAGE_SCHEMA.properties,
    situation: { type: 'string' },
    open_items: { type: 'array', items: { type: 'string' } },
    last_ask: { type: 'string' },
    waiting_on: { type: 'string', enum: ['us', 'them', 'nobody'] },
  },
  required: [...TRIAGE_SCHEMA.required, 'situation', 'open_items', 'last_ask', 'waiting_on'],
  additionalProperties: false,
};
```

and after `instructions()`:

```js
const CONVERSATION_FRAME = `The input is a whole SMS conversation between this business (US) and
one outside number (THEM), oldest first. Triage the conversation as it stands
now, not any single message:
- summary: one short line, the latest development.
- situation: 2-3 sentences: what the conversation is about and where it stands.
- open_items: concrete unresolved things. Empty array if none. Never invent one.
- last_ask: the most recent thing someone asked for, near-verbatim. Empty if none.
- waiting_on: "us" if they need something from us, "them" if we are waiting
  on them, "nobody" if nothing is outstanding.
- urgency and needs_human: judged on where things stand now. Something already
  handled in the conversation is no longer urgent.
- suggested_reply: what to send now, or "" if nothing needs saying.`;

export const conversationInstructions = () => instructions() + NL + NL + CONVERSATION_FRAME;

export async function triageConversation(text, { model = MODELS.triage, knownRole = null } = {}) {
  const out = await ai.json({
    model, name: 'conversation', schema: CONVERSATION_SCHEMA, system: conversationInstructions(),
    user: rolePrefix(knownRole) + 'Conversation (oldest first):' + NL + text,
  });
  if (knownRole && knownRole !== 'unknown') out.from_role = knownRole;
  return out;
}
```

- [ ] **Step 4:** PASS. **Step 5:** commit `Conversation triage schema and prompt`.

### Task 3: lib/convtriage.mjs

**Files:** Create `lib/convtriage.mjs`; Test `test/convtriage.test.mjs`.

**Interfaces:**
- Consumes: Task 1, Task 2; `messaging.thread(session, { line, remote })` → `[{ id, at, inbound, text, media: [{ id, mime }] }]` oldest first; `contacts.lookup(remote)`; `ai.provider()`.
- Produces: `convId(remote)`, `isConv(entry)`, `transcript(msgs, notes)`, `recent(msgs, notes)`, `replied(msgs)`, `stale(entry, msgs)`, `AWAITING`, `analyze(session, { remote, line, name, upTo, reopen, keepClosed }) → Promise<entry>`, `get(remote)`, `migrate()`, `closeReplied(threads: Map<remote, msg[]>) → number`.

- [ ] **Step 1: failing tests** (append):

```js
const ct = await import('../lib/convtriage.mjs');
const M = (id, at, inbound, text, media = []) => ({ id, at, inbound, text, media });

test('ids, transcript, recent, replied, stale', () => {
  assert.equal(ct.convId('+1 (555) 000-1111'), 'c:5550001111');
  const msgs = [M('a', Date.UTC(2026, 8, 28, 9), true, 'gate locked'),
                M('b', Date.UTC(2026, 8, 28, 10), false, 'sending someone'),
                M('c', Date.UTC(2026, 8, 28, 11), true, '', [{ id: 'x1', mime: 'image/jpeg' }])];
  const t = ct.transcript(msgs, { c: ['a broken gate'] });
  assert.match(t, /THEM: gate locked/);
  assert.match(t, /US: sending someone/);
  assert.match(t, /\[image 1: a broken gate\]/);
  assert.match(ct.transcript(msgs, {}), /\[1 photo attached\]/);
  assert.deepEqual(ct.recent(msgs, {}).map(r => r.text), ['[1 photo attached]']);
  assert.equal(ct.replied(msgs), false);
  assert.equal(ct.replied(msgs.slice(0, 2)), true);
  assert.equal(ct.stale(null, msgs), true);
  assert.equal(ct.stale({ through_at: msgs[2].at }, msgs), false);
});

test('migrate merges old per-message entries; closeReplied closes answered ones', () => {
  store.add({ id: 'old-msg', remote: '+15550002222' });
  store.upsert('c:5550003333', { remote: '+15550003333' });
  ct.migrate();
  assert.equal(store.all().find(e => e.id === 'old-msg').resolution, 'merged');
  const threads = new Map([['+15550003333', [M('q', 1, true, 'hi'), M('r', 2, false, 'hello')]]]);
  assert.equal(ct.closeReplied(threads), 1);
  assert.equal(store.all().find(e => e.id === 'c:5550003333').resolution, 'replied');
});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: implement** `lib/convtriage.mjs`:

```js
// Triage of whole conversations (one outside number), kept as one queue entry
// per conversation (id "c:" + its last 10 digits) in lib/store.mjs.
//
// analyze() reads the conversation's full thread and either runs triage now
// or, in connector mode, leaves it "awaiting triage" with the transcript for
// the Claude app. Whether the entry sits in the queue (unresolved) is up to
// the caller: new texts reopen it, our reply closes it (closeReplied).
import * as store from './store.mjs';
import * as photonotes from './photonotes.mjs';
import * as ai from './ai.mjs';
import { thread } from './messaging.mjs';
import { lookup } from './contacts.mjs';
import { triageConversation } from './llm.mjs';

export const AWAITING = 'awaiting_triage';
const MAX = 40;
const NL = String.fromCharCode(10);
const ten = (n) => String(n ?? '').replace(/\D/g, '').slice(-10);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export const convId = (remote) => 'c:' + ten(remote);
export const isConv = (e) => String(e?.id ?? '').startsWith('c:');
export const get = (remote) => store.all().find(e => e.id === convId(remote)) ?? null;

// One message as the model reads it. Photos use their saved descriptions.
export function say(m, notes = {}) {
  const body = String(m.text ?? '').trim();
  const n = (m.media ?? []).length;
  if (!n) return body || '(empty message)';
  const d = notes[m.id];
  const att = d?.length ? d.map((x, i) => `[image ${i + 1}: ${x}]`).join(' ')
                        : `[${n} photo${n === 1 ? '' : 's'} attached]`;
  return body ? body + ' ' + att : att;
}

export const transcript = (msgs, notes = {}) =>
  msgs.slice(-MAX).map(m => `${stamp(m.at)} ${m.inbound ? 'THEM' : 'US'}: ${say(m, notes)}`).join(NL);

// Their texts since our last reply (the newest 5), for the queue card.
export function recent(msgs, notes = {}) {
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].inbound) i--;
  return msgs.slice(i).slice(-5).map(m => ({ at: m.at, text: say(m, notes) }));
}

const newest = (msgs) => msgs[msgs.length - 1] ?? null;
export const replied = (msgs) => { const n = newest(msgs); return !!n && !n.inbound; };
export const stale = (entry, msgs) => { const n = newest(msgs); return !entry || (!!n && n.at > (entry.through_at ?? 0)); };

// Photos Claude can ask for through /api/connector/media.
const photoRefs = (msgs) => msgs.slice(-MAX).flatMap(m => (m.media ?? [])
  .filter(x => /^image\//.test(x.mime)).map((x, n) => ({ msg: m.id, n, media_id: x.id, mime: x.mime })));

export async function analyze(session, { remote, line, name = '', upTo = 0, reopen = false, keepClosed = false }) {
  const msgs = await thread(session, { line, remote });
  const notes = photonotes.all();
  const contact = lookup(remote);
  const knownRole = contact?.role && contact.role !== 'unknown' ? contact.role : null;
  const last = newest(msgs);
  const base = {
    remote, local: line, name: contact?.name || name || '',
    at: last?.at ?? upTo, through_at: Math.max(last?.at ?? 0, upTo), through_id: last?.id ?? null,
    recent: recent(msgs, notes),
    ...(reopen ? { resolution: undefined, resolved_at: undefined } : {}),
  };
  if (ai.provider() === 'connector') {
    return store.upsert(convId(remote), { ...base, status: AWAITING, known_role: knownRole ?? 'unknown',
      transcript: msgs.slice(-MAX).map(m => ({ at: m.at, inbound: m.inbound, text: say(m, notes) })),
      photos: photoRefs(msgs), keep_closed: keepClosed || undefined });
  }
  const answer = await triageConversation(transcript(msgs, notes), { knownRole });
  return store.upsert(convId(remote), { ...base, ...answer, status: undefined, transcript: undefined,
    photos: undefined, known_role: undefined, keep_closed: undefined,
    triaged_by: 'app', triaged_at: new Date().toISOString() });
}

// Once: per-message entries from before conversation triage leave the queue.
export function migrate() {
  for (const e of store.pending()) if (!isConv(e)) store.resolve(e.id, 'merged');
}

// Open conversations whose newest message is ours: we replied, so they leave
// the queue. A conversation asked of Claude on request stays until answered.
// `threads` maps remote -> messages oldest first. Returns how many closed.
export function closeReplied(threads) {
  const byTen = new Map([...threads].map(([r, msgs]) => [ten(r), msgs]));
  let n = 0;
  for (const e of store.pending()) {
    if (!isConv(e) || (e.status === AWAITING && e.keep_closed)) continue;
    const msgs = byTen.get(ten(e.remote));
    if (msgs && replied(msgs)) { store.resolve(e.id, 'replied'); n++; }
  }
  return n;
}
```

- [ ] **Step 4:** PASS. **Step 5:** commit `lib/convtriage.mjs`.

### Task 4: pipeline per conversation

**Files:** Modify `lib/pipeline.mjs` (`runOnce`).

**Interfaces:** Consumes Task 3. Produces: `runOnce` result gains `closed: number`.

- [ ] **Step 1:** replace the imports of `triage` and `connector` with `import * as convtriage from './convtriage.mjs'; import * as photonotes from './photonotes.mjs';`.
- [ ] **Step 2:** `fresh` becomes "newer than its conversation's `through_at`":

```js
const through = new Map(store.all().filter(convtriage.isConv).map(e => [e.id, e.through_at ?? 0]));
let fresh = all.filter(m => m.inbound && !skip.has(m.id) && !store.has(m.id) &&
  m.at > (through.get(convtriage.convId(m.remote)) ?? 0));
```

- [ ] **Step 3:** replace the AI loop (from `const viaConnector` to the end) with:

```js
  const viaConnector = ai.provider() === 'connector';
  const groups = new Map();
  for (const m of fresh) {
    const k = convtriage.convId(m.remote);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  for (const [id, ms] of groups) {
    const last = ms[ms.length - 1];
    // New photos are described once; the Claude app looks at them itself.
    if (!viaConnector && settings.get('triage.describePhotos'))
      for (const m of ms) if (m.media.length && !photonotes.get(m.id)) {
        await enrich(session, m, rawById.get(m.id)?.media);
        photonotes.set(m.id, m.descriptions);
      }
    let entry;
    try {
      entry = await convtriage.analyze(session, { remote: last.remote, line: last.local,
        name: lookup(last.remote)?.name ?? '', upTo: last.at, reopen: true });
    } catch (e) {
      // Still retried next pass; meanwhile the person hears about the texts.
      done.push({ id, error: e.message });
      for (const m of ms) if (isNews(m)) announce(m);
      continue;
    }
    if (viaConnector) {
      // Triaged later by the Claude app; announced now as plain new texts.
      for (const m of ms) if (isNews(m)) announce(m);
      done.push(entry);
      continue;
    }
    // Already announced plainly (triage was failing): no second notification.
    entry = { ...entry, announced: ms.every(m => notified.has(m.id)) };
    done.push(entry);
    onItem?.(entry);
  }
  const closed = convtriage.closeReplied(threads);
  return { processed: done, scanned: all.length, newest, closed };
```

and make the no-AI early return `{ processed: done, scanned: all.length, newest, closed: 0 }`.

- [ ] **Step 4:** `npm test` → PASS (no pipeline unit test: it needs a live account; covered by manual check in Task 9).
- [ ] **Step 5:** commit `Pipeline: triage per conversation, close answered ones`.

### Task 5: connector conversations

**Files:** Modify `lib/connector.mjs`, `test/connector.test.mjs`, `mcp/switchboard-mcp.mjs`, `test/mcp.test.mjs` (only if it asserts tool text).

**Interfaces:** Produces `connector.pending(limit)` (conversation entries awaiting), `connector.saveTriage(id, body)` validating `CONVERSATION_SCHEMA`; after save: resolved `viewed` if `keep_closed`.

- [ ] **Step 1: rewrite tests** in `test/connector.test.mjs` for conversations (replace the `entryFor`/`pending`/`saveTriage` tests):

```js
const answer = { category: 'dispatch_request', urgency: 'urgent', from_role: 'customer',
  summary: 'Tech locked out', needs_human: true, reason: 'blocked', suggested_reply: 'On it.',
  situation: 'Tech at the gate, locked out.', open_items: ['gate code'], last_ask: 'code?', waiting_on: 'us' };

test('pending lists awaiting conversations oldest first', () => {
  store.upsert('c:5550001111', { remote: '+15550001111', at: 2, status: connector.AWAITING, known_role: 'technician' });
  store.upsert('c:5550002222', { remote: '+15550002222', at: 1, status: connector.AWAITING });
  store.upsert('c:5550003333', { remote: '+15550003333', at: 0 });
  assert.deepEqual(connector.pending().map(e => e.id), ['c:5550002222', 'c:5550001111']);
});

test('saveTriage validates, applies, and uses the known role', () => {
  assert.equal(connector.saveTriage('nope', answer).code, 404);
  const bad = connector.saveTriage('c:5550001111', { ...answer, waiting_on: 'eh' });
  assert.equal(bad.code, 400);
  const ok = connector.saveTriage('c:5550001111', answer);
  assert.equal(ok.entry.from_role, 'technician');
  assert.equal('status' in ok.entry, false);
  assert.ok(store.pending().some(e => e.id === 'c:5550001111'));
});

test('a conversation asked on request leaves the queue once answered', () => {
  store.upsert('c:5550004444', { remote: '+15550004444', at: 3, status: connector.AWAITING, keep_closed: true });
  connector.saveTriage('c:5550004444', answer);
  assert.equal(store.all().find(e => e.id === 'c:5550004444').resolution, 'viewed');
});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: implement** in `lib/connector.mjs`: import `CONVERSATION_SCHEMA` instead of `TRIAGE_SCHEMA`; `AWAITING` re-exported from convtriage (`export { AWAITING } from './convtriage.mjs'` and drop the local const); delete `entryFor`; `pending` filters `isAwaiting` (unchanged); `saveTriage`:

```js
export function saveTriage(id, body) {
  const cur = store.all().find(e => e.id === id);
  if (!cur || (cur.resolution && !cur.keep_closed)) return { ok: false, code: 404, errors: ['No conversation with that id is waiting in the queue.'] };
  const errors = validate(CONVERSATION_SCHEMA, body);
  if (errors.length) return { ok: false, code: 400, errors };
  const role = lookup(cur.remote)?.role ?? cur.known_role;
  const answer = { ...body, ...(role && role !== 'unknown' ? { from_role: role } : {}) };
  if (!isAwaiting(cur)) console.log(`connector  triage for ${id} replaced`);
  let entry = store.update(id, { ...answer, status: undefined, transcript: undefined, photos: undefined,
    known_role: undefined, keep_closed: undefined, triaged_by: 'connector', triaged_at: new Date().toISOString() });
  if (cur.keep_closed) { store.resolve(id, 'viewed'); entry = store.all().find(e => e.id === id); }
  return { ok: true, entry };
}
```

TOOLS descriptions: `['list_pending', 'List conversations waiting for triage'], ['save_triage', 'Save triage and a draft reply for a conversation']`.

In `mcp/switchboard-mcp.mjs`: `list_pending` description → `'Conversations in Switchboard waiting for triage, oldest first: the recent transcript (THEM = the other person, US = this business), the sender\'s known role, photo refs, and the triage instructions. Triage each conversation as it stands now and call save_triage for it.'`; `save_triage` description → `'Save your triage for one waiting conversation. suggested_reply is a DRAFT a person reviews in Switchboard before anything is sent; never say a reply was sent.'`, id description `'The conversation id from list_pending.'`. The media tool/argument (if list_pending's photo refs are passed back to a media call) takes `{ id: <message id>, n }`.

- [ ] **Step 4:** `npm test` → PASS (fix `test/mcp.test.mjs` expectations if they quote the old wording).
- [ ] **Step 5:** commit `Connector: conversations instead of single texts`.

### Task 6: server routes

**Files:** Modify `server.mjs`, `lib/thread.mjs`, `lib/review.mjs`.

- [ ] **Step 1:** imports: `import * as convtriage from './lib/convtriage.mjs';`, `CONVERSATION_SCHEMA, conversationInstructions` from llm; drop `summarizeThread`. Call `convtriage.migrate()` right after `const migrated = profile.migrate(session);`.
- [ ] **Step 2:** `sync()`: push the queue when `r.processed.length || r.closed`.
- [ ] **Step 3:** add `'/api/triage'` to `PLATFORM_API`, and the route (next to `/api/thread`):

```js
    // Conversation triage for the Messages panel (lib/convtriage.mjs).
    if (p === '/api/triage') {
      if (!fromApp(req)) return json(res, 403, { error: 'Open this from the Switchboard app.' });
      const remote = String(url.searchParams.get('remote') ?? ''), line = String(url.searchParams.get('line') ?? '') || primary();
      if (!/\d{7}/.test(remote.replace(/\D/g, ''))) return json(res, 400, { error: 'bad number' });
      if (req.method === 'GET') {
        const entry = convtriage.get(remote);
        let stale = true;
        try { stale = convtriage.stale(entry, await thread(session, { line, remote, cached: true }) ?? []); } catch {}
        return json(res, 200, { entry, stale, connector: ai.provider() === 'connector' });
      }
      if (req.method === 'POST') {
        const before = convtriage.get(remote);
        const open = !!before && !before.resolution;
        try {
          const msgs = await thread(session, { line, remote });
          const wantsUs = settings.get('triage.enabled') === true && msgs.length && msgs[msgs.length - 1].inbound;
          let entry = await convtriage.analyze(session, { remote, line, keepClosed: !open && !wantsUs, reopen: !before && wantsUs });
          if (!before && !wantsUs && ai.provider() !== 'connector') { store.resolve(entry.id, 'viewed'); entry = convtriage.get(remote); }
          push('queue', store.pending());
          return json(res, 200, { entry, stale: false, connector: ai.provider() === 'connector' });
        } catch (e) { return json(res, 502, { error: e.message }); }
      }
    }
```

(`thread` is already imported from lib/messaging.mjs as `convThread`; use that name.)

For connector mode with a closed entry, `analyze` sets `status: AWAITING` and `keep_closed`; the entry must also be unresolved for `connector.pending()` to see it, so pass `reopen: true` in connector mode: `reopen: ai.provider() === 'connector' || (!before && wantsUs)`.

- [ ] **Step 4:** `/api/reject` resolves `'done'`. `/api/thread` drops the `summary=1` branch; remove `summarizeThread` and its imports from `lib/thread.mjs`.
- [ ] **Step 5:** connector routes: `instructions` returns `{ instructions: conversationInstructions(), schema: CONVERSATION_SCHEMA }` under `triage`; `pending` maps entries to:

```js
{ id: e.id, from: e.remote, name: e.name, known_role: e.known_role, line: e.local,
  at: new Date(e.at).toISOString(),
  transcript: (e.transcript ?? []).map(t => ({ at: new Date(t.at).toISOString(), from: t.inbound ? 'THEM' : 'US', text: t.text })),
  photos: (e.photos ?? []).map(ph => ({ id: ph.msg, n: ph.n, mime: ph.mime })) }
```

`media` looks the photo up across waiting entries: `const ph = store.all().flatMap(x => (x.photos ?? []).map(p => ({ ...p, line: x.local }))).find(p => p.msg === url.searchParams.get('id') && p.n === Number(url.searchParams.get('n')))`, then fetches it with lib/messaging.mjs `fetchMedia(session, ph.media_id, ph.line)` (returns `{ buf, mime }` — check its return shape and adapt), then the existing resize.
- [ ] **Step 6:** `lib/review.mjs`: `const notes = photonotes.all();` and in `say(m)`: `const d = notes[m.id]?.length ? m.text.trim() + ' ' + notes[m.id].map((x, i) => `[image ${i + 1}: ${x}]`).join(' ') : described.get(m.id);`.
- [ ] **Step 7:** `npm test` → PASS; `node --check server.mjs`. Commit `Server: /api/triage, conversation connector routes`.

### Task 7: Triage page cards

**Files:** Modify `ui.html` (`render()`).

- [ ] Card per conversation entry: top row as today (urgency/category/role/needs you/line, time of `e.at`); the message block shows `e.recent` (each `text`), or `(no new texts)`; summary block: `e.summary` bold, `e.situation`, open items list, `Last ask: …`, waiting-on line; awaiting: the existing "Waiting for triage from the Claude app…" note. Buttons: Send (unchanged flow, posts `{ id: e.id, text }`), **Done** (was Dismiss, same `/api/reject` call), **Open conversation** (`location.href = '/messages#to=' + encodeURIComponent(e.remote)`), role select. Remove the Catch me up button, the `.thread` block and its handler. Old entries (non-`c:`) can't be pending after migration, so no fallback is needed.
- [ ] Manual check in the scratch preview (Task 9). Commit `Triage page: one card per conversation`.

### Task 8: Messages Triage button and panel

**Files:** Modify `messages.html`.

- [ ] CSS: `.tri{margin:0 16px 8px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}`, `.tri .tags span{…}` reusing the urgency colour variables, `.tri ul{margin:6px 0 0;padding-left:18px}`, `.tri .acts{display:flex;gap:8px;margin-top:10px}`.
- [ ] In `openConv(c)`: after the header, add `const tb = el('button', '', 'Triage'); tb.title = "What's going on in this conversation"; h.insertBefore(tb, <the grow span's next sibling or append>)` and a panel `const tri = el('div', 'tri'); tri.hidden = true;` inserted after the header. `tb.onclick = () => triage(c, tri, false)`.
- [ ] `async function triage(c, box, force)`:

```js
async function triage(c, box, force) {
  box.hidden = false;
  const q = '/api/triage?remote=' + encodeURIComponent(c.remote) + '&line=' + encodeURIComponent(c.line);
  const paint = (d) => {
    box.textContent = '';
    const e = d.entry;
    if (d.error) { box.appendChild(el('div', 'err', "Couldn't triage: " + d.error)); }
    else if (e && e.status === 'awaiting_triage') {
      box.appendChild(el('div', 'meta', 'Waiting for Claude… Ask Claude to "triage my Switchboard inbox".'));
    } else if (e && e.summary) {
      const tags = el('div', 'tags');
      for (const t of [e.urgency, e.category, e.needs_human ? 'needs you' : ''].filter(Boolean)) tags.appendChild(el('span', 'tag ' + t, t));
      box.append(tags, el('b', '', e.summary), el('div', '', e.situation || ''));
      if ((e.open_items || []).length) { const ul = el('ul'); for (const it of e.open_items) ul.appendChild(el('li', '', it)); box.appendChild(ul); }
      const w = { us: 'Waiting on you.', them: 'Waiting on them.', nobody: 'Nothing outstanding.' }[e.waiting_on] || '';
      box.appendChild(el('div', 'meta', w + (e.last_ask ? '  Last ask: ' + e.last_ask : '')));
    }
    const acts = el('div', 'acts');
    if (e?.suggested_reply) {
      const use = el('button', '', 'Use reply');
      use.onclick = () => { const ta = $('#pane textarea'); if (ta) { ta.value = e.suggested_reply; ta.dispatchEvent(new Event('input')); ta.focus(); } };
      acts.appendChild(use);
    }
    const again = el('button', '', 'Refresh'); again.onclick = () => triage(c, box, true);
    const close = el('button', '', 'Hide'); close.onclick = () => { box.hidden = true; };
    acts.append(again, close);
    box.appendChild(acts);
  };
  box.textContent = ''; box.appendChild(el('div', 'meta', 'Reading the conversation…'));
  let d = null;
  if (!force) { try { d = await (await fetch(q)).json(); } catch {} }
  if (force || !d || d.error || d.stale || !d.entry || (!d.entry.summary && d.entry.status !== 'awaiting_triage')) {
    try { const r = await fetch(q, { method: 'POST' }); d = await r.json(); } catch (err) { d = { error: err.message }; }
  }
  if (open?.remote !== c.remote) return;             // moved to another conversation meanwhile
  paint(d);
  if (d.entry?.status === 'awaiting_triage') waitFor = () => triage(c, box, false);
}
```

(Check `$('#pane')` is the id of the thread pane and the composer textarea selector; adapt to what `composer()` builds.)
- [ ] SSE: `es.addEventListener('queue', () => waitFor?.())` with `let waitFor = null;` reset in `openConv`.
- [ ] Deep link: on load, `const m = location.hash.match(/^#to=(.+)$/)`; after conversations load, open the matching conversation (`convs.find(c => same(c.remote, decodeURIComponent(m[1])))`) and clear the hash.
- [ ] Commit `Messages: Triage button and panel`.

### Task 9: version, notes, check

- [ ] `changelog.json` entry `0.4.0`: "Triage now reads whole conversations: one card per conversation on the Triage page, updated as new texts arrive, and it leaves the queue when you reply." / "In Messages, press Triage on any conversation to see what's going on, what's still open, and a suggested reply."; `npm version 0.4.0 --no-git-tag-version`.
- [ ] `npm test` → all pass.
- [ ] Manual, scratch preview server with stubbed `/api/triage` + `/api/state`: Triage card layout, Messages panel states (result, waiting for Claude, error).
- [ ] Commit `Conversation triage (v0.4.0)`.
