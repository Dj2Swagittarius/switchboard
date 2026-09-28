// Suggested replies for the Messages window: three short answers to what the
// other person last said, written by the chosen AI platform. Only suggestions:
// a click puts one in the message box, and a person presses Send.
import * as ai from './ai.mjs';
import * as photonotes from './photonotes.mjs';
import { MODELS } from './llm.mjs';
import { transcript } from './convtriage.mjs';

const CONTEXT = 12;          // messages the model sees
const KEEP = 200;            // conversations remembered
const cache = new Map();     // remote|newest message id -> replies

export const SCHEMA = {
  type: 'object',
  properties: { replies: { type: 'array', items: { type: 'string' } } },
  required: ['replies'],
  additionalProperties: false,
};

export const SYSTEM = `You suggest quick SMS replies for a field-service business (US) answering
the other person (THEM). Give exactly 3 replies to THEM's latest message(s),
as a person at the business would type them:
- Each under 12 words. Plain and friendly. No emoji. No sign-off.
- Three different directions (for example: yes / a question back / not yet),
  not three wordings of the same answer.
- Never invent facts: no times, prices, names, addresses or promises that are
  not already in the conversation.`;

// Up to 3 distinct, non-empty, trimmed replies.
export function clean(replies) {
  const out = [];
  for (const r of Array.isArray(replies) ? replies : []) {
    const t = String(r ?? '').replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
    if (t && t.length <= 160 && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length === 3) break;
  }
  return out;
}

// msgs: the thread, oldest first. Nothing to suggest unless they spoke last.
export async function suggest(remote, msgs) {
  const last = msgs[msgs.length - 1];
  if (!last?.inbound) return [];
  const key = remote + '|' + last.id;
  if (cache.has(key)) return cache.get(key);
  const out = await ai.json({
    model: MODELS.draft, name: 'suggest', schema: SCHEMA, system: SYSTEM, temperature: 0.5, maxTokens: 400,
    user: 'Conversation (oldest first):\n' + transcript(msgs.slice(-CONTEXT), photonotes.all()),
  });
  const replies = clean(out?.replies);
  cache.set(key, replies);
  if (cache.size > KEEP) cache.delete(cache.keys().next().value);
  return replies;
}
