// Pulls recent messages, triages inbound ones on the chosen AI platform, prints a queue.
// Read-only: nothing is ever sent.
import { loadSession, api } from './lib/kazoo.mjs';
import { triage, MODELS } from './lib/llm.mjs';
import { normalize, mask } from './lib/message.mjs';
import { enrich, visionModel } from './lib/media.mjs';
import { lines } from './lib/lines.mjs';

const LIMIT = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 8);
const s = loadSession();
// The user doc's phone_number is stale — see lib/lines.mjs.
const active = lines();
const raw = [];
for (const l of active) {
  const r = await api(s, `/messaging?localNumber=${encodeURIComponent(l.number)}`);
  raw.push(...(r.body?.data ?? []));
}
const all = raw.map(normalize);
const rawById = new Map(raw.map(r => [r.id, r]));
all.sort((a, b) => a.at - b.at);

// Thread by counterparty so the model sees conversational context.
const threads = new Map();
for (const m of all) {
  if (!threads.has(m.remote)) threads.set(m.remote, []);
  threads.get(m.remote).push(m);
}

const inbound = all.filter(m => m.inbound && m.forModel()).slice(-LIMIT);
const U = { urgent: '!!!', high: '!! ', normal: '   ', low: '   ' };

console.log(`lines: ${active.map(l => l.number).join(', ')}`);
console.log(`triage: ${MODELS.triage}   vision: ${visionModel()}   messages: ${all.length}   threads: ${threads.size}   triaging last ${inbound.length} inbound\n`);

for (const m of inbound) {
  const thread = threads.get(m.remote) ?? [];
  const history = thread.slice(Math.max(0, thread.indexOf(m) - 4), thread.indexOf(m));
  const t0 = Date.now();
  if (m.media.length) await enrich(s, m, rawById.get(m.id)?.media);
  let r;
  try { r = await triage(m, { history }); }
  catch (e) { console.log(`from ${mask(m.remote)} — TRIAGE FAILED: ${e.message}\n`); continue; }

  console.log(`${U[r.urgency] ?? '   '} ${mask(m.remote)}  [${r.category}/${r.urgency}/${r.from_role}]  ${Date.now() - t0}ms`);
  console.log(`    msg   : ${m.forModel().replace(/\s+/g, ' ').slice(0, 100)}`);
  console.log(`    summary: ${r.summary}`);
  console.log(`    human : ${r.needs_human ? 'YES — ' + r.reason : 'no'}`);
  console.log(`    draft : ${r.suggested_reply || '(none — would require inventing facts)'}`);
  console.log();
}
