// Live triage bot: watches for inbound messages, describes any photos,
// classifies them, and files a draft into the review queue.
// It never sends anything. Use review.mjs to act on the queue.
import { loadSession, api, redact } from './lib/kazoo.mjs';
import { derived } from './lib/profile.mjs';
import { resolveMyBoxes } from './lib/boxes.mjs';
import { normalize, mask } from './lib/message.mjs';
import { enrich, visionModel } from './lib/media.mjs';
import { triage, MODELS } from './lib/llm.mjs';
import { lookup } from './lib/contacts.mjs';
import { lines } from './lib/lines.mjs';
import * as store from './lib/store.mjs';
import { appendFileSync } from 'node:fs';

const s = loadSession();
// Live events are optional: without an events server the bot just polls.
const WS_URL = derived().eventsServer;
const POLL_MS = Number(process.env.POLL_MS ?? 60_000);
// How much history to chew through on startup. Each message costs ~15s of
// triage plus ~3s per photo, so processing the whole backlog by default would
// pin the machine for minutes. 0 means "only what arrives from now on".
const BACKLOG = Number((process.argv.find(a => a.startsWith('--backlog=')) ?? '--backlog=0').split('=')[1]);
const NL = String.fromCharCode(10);

// Boxes are only needed to subscribe to live events.
const owned = WS_URL ? await resolveMyBoxes(s, { refresh: process.argv.includes('--refresh') }) : null;
const active = lines();
if (!active.length) { console.error('No active lines in lines.json'); process.exit(1); }

console.log(`triage=${MODELS.triage}  vision=${visionModel()}`);
if (owned) console.log(`ext ${owned.presence_id}: ${owned.boxes.length} box(es) of mine, ignoring ${owned.skipped_sessions} other tenant session(s)`);
console.log(`servicing line(s): ${active.map(l => l.number).join(', ')}`);

let working = false;
let firstRun = true;
// Messages deliberately skipped on startup, so a later poll doesn't pick them up.
const seen = new Set();
async function sync(reason) {
  if (working) return;
  working = true;
  try {
    const raw = [];
    for (const l of active) {
      const r = await api(s, `/messaging?localNumber=${encodeURIComponent(l.number)}`);
      raw.push(...(r.body?.data ?? []));
    }
    const rawById = new Map(raw.map(r => [r.id, r]));
    const all = raw.map(normalize).sort((a, b) => a.at - b.at);

    const threads = new Map();
    for (const m of all) {
      if (!threads.has(m.remote)) threads.set(m.remote, []);
      threads.get(m.remote).push(m);
    }

    let fresh = all.filter(m => m.inbound && !store.has(m.id) && !seen.has(m.id));
    if (firstRun) {
      const skipped = Math.max(0, fresh.length - BACKLOG);
      fresh = BACKLOG > 0 ? fresh.slice(-BACKLOG) : [];
      if (skipped) console.log(`skipping ${skipped} older message(s) — use --backlog=N to include them`);
      for (const m of all) if (m.inbound && !fresh.includes(m) && !store.has(m.id)) seen.add(m.id);
      firstRun = false;
    }
    if (!fresh.length) return;
    console.log(`[${reason}] ${fresh.length} new inbound`);

    for (const m of fresh) {
      if (m.media.length) await enrich(s, m, rawById.get(m.id)?.media);
      const thread = threads.get(m.remote) ?? [];
      const history = thread.slice(Math.max(0, thread.indexOf(m) - 4), thread.indexOf(m));
      const contact = lookup(m.remote);
      let r;
      try { r = await triage(m, { history, knownRole: contact?.role }); }
      catch (e) { console.log(`  ${mask(m.remote)} triage failed: ${e.message.slice(0, 80)}`); continue; }

      store.add({ id: m.id, remote: m.remote, local: m.local, at: m.at,
                  text: m.forModel(), name: contact?.name ?? '', ...r });
      console.log(`  queued ${mask(m.remote)} [${r.category}/${r.urgency}] ${r.needs_human ? 'NEEDS HUMAN' : 'draft ready'}`);
    }
  } catch (e) {
    console.error('sync error:', e.message);
  } finally { working = false; }
}

await sync('startup');

// The Blackhole event payload shape is unconfirmed — no live event has been
// captured yet. Rather than parse it, any oomamsg event triggers a REST
// re-sync, which is shape-agnostic. Raw events are logged for later study.
if (WS_URL) {
  const ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => {
    for (const binding of owned.boxes)
      ws.send(JSON.stringify({ action: 'subscribe', auth_token: s.auth_token,
                               data: { account_id: s.account_id, binding } }));
    console.log(`connected — watching. polling every ${POLL_MS / 1000}s as backup.` + NL);
  });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    appendFileSync('events.jsonl', JSON.stringify({ at: new Date().toISOString(), ev: redact(msg) }) + NL);
    if (msg.action === 'reply') return;
    sync('event');
  });
  ws.addEventListener('error', (e) => console.error('ws error:', e.message ?? e));
  ws.addEventListener('close', (e) => console.log(`ws closed (${e.code}) — polling continues`));
} else {
  console.log(`No events server is set — polling every ${POLL_MS / 1000}s only.` + NL);
}

setInterval(() => sync('poll'), POLL_MS);
