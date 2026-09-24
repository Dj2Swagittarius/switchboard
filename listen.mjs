// Real-time message ingest over Kazoo Blackhole.
// Outbound connection only — no public URL, no tunnel, no open port.
import { loadSession, redact } from './lib/kazoo.mjs';
import { derived } from './lib/profile.mjs';
import { resolveMyBoxes } from './lib/boxes.mjs';
import { appendFileSync } from 'node:fs';

// From profile.json (Account page, Servers, Advanced) or BLACKHOLE_URL.
const WS_URL = derived().eventsServer;
if (!WS_URL) {
  console.error('No events server is set: add one on the Account page (Servers, Advanced) or set BLACKHOLE_URL.');
  process.exit(1);
}
const s = loadSession();
const LOG = 'events.jsonl';

const owned = await resolveMyBoxes(s, { refresh: process.argv.includes('--refresh') });
const bindings = owned.boxes;

console.log(`extension ${owned.presence_id} — ${bindings.length} box(es) of mine`);
console.log(`ignored ${owned.skipped_sessions} other tenant session(s)`);
for (const b of bindings) console.log('  ', b);

const ws = new WebSocket(WS_URL);
const mask = (n) => String(n ?? '').replace(/\d(?=\d{4})/g, '•');

ws.addEventListener('open', () => {
  console.log('\nconnected —', WS_URL);
  for (const binding of bindings)
    ws.send(JSON.stringify({
      action: 'subscribe',
      auth_token: s.auth_token,
      data: { account_id: s.account_id, binding },
    }));
  console.log('subscribe sent. waiting for events… (Ctrl+C to stop)\n');
});

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return console.log('raw:', String(ev.data).slice(0, 200)); }

  // Persist the full event for schema work; redact the echoed token.
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ev: redact(msg) }) + '\n');

  if (msg.action === 'reply') {
    console.log(`  [${msg.status}] subscribe ack${msg.data?.subscribed ? ' — ' + JSON.stringify(msg.data.subscribed) : ''}`);
    return;
  }
  const d = msg.data ?? {};
  console.log(`[EVENT] ${msg.name ?? msg.routing_key ?? '?'}`);
  console.log(`   dir=${d.direction ?? '?'} state=${d.state ?? '?'} from=${mask(d.remoteNumber)} to=${mask(d.localNumber)}`);
  if (d.value) console.log(`   body: ${String(d.value).slice(0, 120)}`);
  console.log(`   keys: ${Object.keys(d).join(', ')}`);
});

ws.addEventListener('error', (e) => console.error('ws error:', e.message ?? e));
ws.addEventListener('close', (e) => console.log(`ws closed (${e.code})`));
