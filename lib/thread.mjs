// "Catch me up on this conversation" — a summary of one thread.
import { fetchAll } from './pipeline.mjs';
import { MODELS } from './llm.mjs';
import * as ai from './ai.mjs';
const NL = String.fromCharCode(10);
const digits = (n) => String(n ?? '').replace(/\D/g, '').slice(-10);

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    open_items: { type: 'array', items: { type: 'string' } },
    last_ask: { type: 'string' },
    waiting_on: { type: 'string', enum: ['us', 'them', 'nobody'] },
  },
  required: ['summary', 'open_items', 'last_ask', 'waiting_on'],
  additionalProperties: false,
};

const SYSTEM = `You summarize an SMS thread for a field-service dispatcher
returning to it after time away.

- summary: what this conversation is about and where it stands. 2-3 sentences.
- open_items: concrete unresolved things. Empty array if none. Never invent one.
- last_ask: the most recent thing someone asked for, verbatim-ish. Empty if none.
- waiting_on: "them" if we replied last and need a response, "us" if they
  replied last and need something from us, "nobody" if it is closed.
Use only what is in the transcript. Attachments appear as [image N: ...]
descriptions — treat them as what was seen, not as certainty.`;

export async function threadFor(session, remote) {
  const { threads } = await fetchAll(session);
  for (const [k, msgs] of threads) if (digits(k) === digits(remote)) return msgs;
  return [];
}

export async function summarizeThread(msgs, { model = MODELS.triage } = {}) {
  if (!msgs.length) return null;
  const transcript = msgs.slice(-40)
    .map(m => `${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')} ` +
              `${m.inbound ? 'THEM' : 'US'}: ${m.forModel()}`)
    .join(NL);

  return ai.json({
    model, name: 'thread', schema: SCHEMA, system: SYSTEM,
    user: 'Transcript (oldest first):' + NL + transcript,
  });
}
