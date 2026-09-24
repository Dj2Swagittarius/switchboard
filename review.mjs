// Review queued drafts and act on them.
//
//   node review.mjs                     list pending
//   node review.mjs show 2              full detail for item 2
//   node review.mjs reject 2            dismiss without sending
//   node review.mjs send 2              DRY RUN — prints the exact request
//   node review.mjs send 2 --send       actually transmit
//   node review.mjs send 2 --text "..." --send   send edited wording
import { loadSession, api } from './lib/kazoo.mjs';
import { mask } from './lib/message.mjs';
import { sendMessage } from './lib/send.mjs';
import * as store from './lib/store.mjs';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'list';
const n = Number(args[1]);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const U = { urgent: '!!!', high: '!! ', normal: '   ', low: '   ' };
const items = store.pending();

if (cmd === 'list') {
  if (!items.length) { console.log('queue empty — run: node bot.mjs'); process.exit(0); }
  console.log(`${items.length} pending` + String.fromCharCode(10));
  items.forEach((e, i) => {
    console.log(`${U[e.urgency] ?? '   '} [${i + 1}] ${mask(e.remote)} ${e.name || ''} — ${e.category}/${e.urgency}/${e.from_role}${e.needs_human ? '  NEEDS HUMAN' : ''}`);
    console.log(`      ${String(e.text).replace(/\s+/g, ' ').slice(0, 88)}`);
    console.log(`      draft: ${e.suggested_reply || '(none)'}`);
  });
  console.log(String.fromCharCode(10) + 'send:  node review.mjs send <n> --send      reject: node review.mjs reject <n>');
  process.exit(0);
}

const item = items[n - 1];
if (!item) { console.error(`no pending item ${args[1] ?? ''} — run: node review.mjs`); process.exit(1); }

if (cmd === 'show') {
  console.log(JSON.stringify({ ...item, remote: mask(item.remote), local: mask(item.local) }, null, 2));
  process.exit(0);
}

if (cmd === 'reject') {
  store.resolve(item.id, 'rejected');
  console.log(`rejected — ${mask(item.remote)}`);
  process.exit(0);
}

if (cmd === 'send') {
  const text = opt('--text') ?? item.suggested_reply;
  if (!text?.trim()) { console.error('no draft to send — supply one with --text "…"'); process.exit(1); }
  const live = flag('--send');

  const r = await sendMessage(loadSession(), {
    to: item.remote, text, localNumber: item.local, dryRun: !live,
  });

  if (!live) {
    console.log('DRY RUN — nothing was sent.' + String.fromCharCode(10));
    console.log(`  to   : ${mask(item.remote)} ${item.name || ''}`);
    console.log(`  text : ${text}`);
    console.log(`  POST : ${r.path}`);
    console.log(`  body : ${JSON.stringify(r.body)}`);
    console.log(String.fromCharCode(10) + 'Add --send to transmit for real.');
    process.exit(0);
  }

  if (r.ok) {
    store.resolve(item.id, 'sent', { sent_text: text });
    console.log(`sent to ${mask(item.remote)}: ${text}`);
  } else {
    console.error(`send failed (HTTP ${r.status})`);
    console.error(JSON.stringify(r.response?.data ?? r.response, null, 2)?.slice(0, 600));
    console.error(String.fromCharCode(10) + 'The body shape was never verified against the live API.');
    console.error('The validation error above names the fields it actually wants —');
    console.error('correct buildBody() in lib/send.mjs to match, then retry.');
  }
  process.exitCode = r.ok ? 0 : 1;
}

console.error(`unknown command: ${cmd}`);
process.exit(1);
