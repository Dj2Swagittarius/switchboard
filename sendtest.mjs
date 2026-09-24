// One-off send using the verified shape (captured from the real client).
//   node sendtest.mjs +15555550199 "message"          dry run
//   node sendtest.mjs +15555550199 "message" --send   transmit
import { loadSession } from './lib/kazoo.mjs';
import { sendMessage } from './lib/send.mjs';
import { primary } from './lib/lines.mjs';

const [to, text] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!to || !text) { console.error('usage: node sendtest.mjs <+1number> "<text>" [--send]'); process.exit(1); }
const live = process.argv.includes('--send');

const r = await sendMessage(loadSession(), { to, text, localNumber: primary(), dryRun: !live });
console.log(`${live ? 'SEND' : 'DRY RUN'}  POST ${r.path}`);
console.log(JSON.stringify(r.body, null, 2));
if (live) {
  console.log(`${String(r.status)} ${r.ok ? 'OK' : 'FAILED'}`);
  if (!r.ok) console.log(JSON.stringify(r.response).slice(0, 400));
  else console.log('id:', r.response?.data?.id ?? '(see response)');
  process.exitCode = r.ok ? 0 : 1;
}
