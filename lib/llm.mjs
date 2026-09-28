// Message triage with strict JSON-schema output, on whichever AI platform is
// chosen in Settings (see lib/ai.mjs).
import * as ai from './ai.mjs';
import * as settings from './settings.mjs';

// ONE model for triage and vision on the local platforms. LM Studio evicts and
// reloads when two models are asked for in turn, which made a single message
// take 194s. Keeping both jobs on one multimodal model keeps it resident.
export const MODELS = {
  get triage() { return ai.textModel(); },
  get draft() { return ai.textModel(); },
};

export const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: ['dispatch_request', 'job_status', 'scheduling', 'hours_or_location',
             'billing', 'complaint', 'sales_lead', 'spam', 'personal',
             'acknowledgement', 'other'],
    },
    urgency: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    from_role: { type: 'string', enum: ['technician', 'customer', 'vendor', 'unknown'] },
    summary: { type: 'string' },
    needs_human: { type: 'boolean' },
    reason: { type: 'string' },
    suggested_reply: { type: 'string' },
  },
  required: ['category', 'urgency', 'from_role', 'summary', 'needs_human', 'reason', 'suggested_reply'],
  additionalProperties: false,
};

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

// The built-in instructions. Settings > Triage & AI > Triage instructions can
// replace them; Settings shows this text as the box's placeholder.
export const DEFAULT_INSTRUCTIONS = `You triage inbound SMS for a field-service phone line.
Messages come from technicians in the field, customers, or vendors.

Rules:
- summary: one short factual line. No speculation.
- needs_human: true for anything involving money, cancellations, complaints,
  safety, legal, angry tone, or ambiguity. When unsure, true.
- suggested_reply: a DRAFT only, never sent automatically. Plain, brief,
  professional. No emoji. No invented facts — no prices, times, names, or
  commitments that are not present in the message. If you cannot write a
  reply without inventing something, return an empty string.
- urgency, judged on business impact, not tone alone:
    urgent = someone is blocked, stranded, on-site waiting, or a job is failing now.
    high   = angry customer, money in dispute, cancellation, safety concern,
             or a deadline today. An upset customer is NEVER low.
    normal = routine questions, status updates, scheduling with lead time.
    low    = acknowledgements, thanks, FYI with no action needed.
  Rate on the worst plausible reading, not the best.`;

// Appended to custom instructions only, so a prompt that never mentions the
// answer fields still fills them, and a draft stays a draft. The built-in
// instructions already say all of this and are sent unchanged.
const OUTPUT_RULES = `Answer in the required JSON and fill every field:
- category, urgency (low / normal / high / urgent), from_role
- summary: one short factual line
- needs_human: true when a person should look at it; when unsure, true
- reason: why you chose this urgency
- suggested_reply: a DRAFT for a person to review, never sent automatically.
  Never invent prices, times, names or commitments that are not in the
  message; if you can't reply without inventing something, return "".`;

const NL = String.fromCharCode(10);

// What triage is told, read on every message so a change in Settings applies
// to the next one.
export function instructions() {
  const custom = String(settings.get('triage.instructions') ?? '').trim();
  return custom ? custom + NL + NL + OUTPUT_RULES : DEFAULT_INSTRUCTIONS;
}
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

// What conversation triage is told: the triage instructions (built-in or from
// Settings) plus how to read a whole conversation.
export const conversationInstructions = () => instructions() + NL + NL + CONVERSATION_FRAME;

// A roster entry beats a per-message guess.
const rolePrefix = (r) => (r && r !== 'unknown') ? `The sender is a known ${r}.` + NL + NL : '';

export async function triage(msg, { model = MODELS.triage, history = [], knownRole = null } = {}) {
  const ctx = history.length
    ? `\n\nPrior messages in this thread (oldest first):\n` +
      history.map(h => `${h.inbound ? 'THEM' : 'US'}: ${h.forModel()}`).join('\n')
    : '';

  const out = await ai.json({
    model, name: 'triage', schema: TRIAGE_SCHEMA, system: instructions(),
    user: rolePrefix(knownRole) + `Inbound message:\n"""${msg.forModel()}"""${ctx}`,
  });
  // A roster entry is authoritative; the model only guesses when we don't know.
  if (knownRole && knownRole !== 'unknown') out.from_role = knownRole;
  return out;
}

// Triage of a whole conversation; `text` is lib/convtriage.mjs transcript().
export async function triageConversation(text, { model = MODELS.triage, knownRole = null } = {}) {
  const out = await ai.json({
    model, name: 'conversation', schema: CONVERSATION_SCHEMA, system: conversationInstructions(),
    user: rolePrefix(knownRole) + 'Conversation (oldest first):' + NL + text,
  });
  if (knownRole && knownRole !== 'unknown') out.from_role = knownRole;
  return out;
}
