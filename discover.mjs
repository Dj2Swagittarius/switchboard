// Maps which Crossbar endpoints this account can actually reach.
// Read-only: every request is a GET.
import { loadSession, api } from './lib/kazoo.mjs';

const session = loadSession();

const PATHS = [
  ['', 'account'],
  ['/users/' + session.owner_id, 'me (user doc)'],
  ['/devices', 'devices'],
  ['/vmboxes', 'voicemail boxes'],
  ['/webhooks', 'WEBHOOKS (push ingest)'],
  ['/notifications', 'notification templates'],
  ['/sms', 'SMS'],
  ['/messages', 'messages'],
  ['/conversations', 'conversations'],
  ['/chats', 'chats'],
  ['/faxes', 'faxes'],
  ['/cdrs', 'call records'],
  ['/channels', 'live channels'],
  ['/phone_numbers', 'phone numbers'],
  ['/callflows', 'callflows'],
  ['/queues', 'queues'],
  ['/apps_store', 'apps store'],
];

console.log(`account_id ${session.account_id}\n`);
console.log('  STATUS  ENDPOINT                    NOTE');

const reachable = [];
for (const [p, label] of PATHS) {
  const { status, ok, body } = await api(session, p);
  const n = Array.isArray(body?.data) ? `${body.data.length} item(s)` : ok ? 'ok' : (body?.message ?? '');
  console.log(`  ${String(status).padEnd(6)}  ${(p || '/').padEnd(26)}  ${label} — ${n}`);
  if (ok) reachable.push(p || '/');
}

console.log('\nReachable:', reachable.join(', ') || 'none');
