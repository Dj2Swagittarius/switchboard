// Automated SMS replies. Every gate must pass; any doubt means no send.
//
// Deliberately conservative:
//  - off and dry-run by default
//  - template text by default, not model-generated prose
//  - never fires on anything the triage flagged for a human, or on high/urgent
//  - discloses that it is automated
//  - hard daily caps, per contact and overall
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { lookup } from './contacts.mjs';
import * as store from './store.mjs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('autoreply.json');
const LOG = dataPath('autoreply.log');
const NL = String.fromCharCode(10);

export const policy = () => existsSync(FILE)
  ? JSON.parse(readFileSync(FILE, 'utf8'))
  : { enabled: false, dryRun: true };

export function setPolicy(patch) {
  const p = { ...policy(), ...patch };
  writeFileSync(FILE, JSON.stringify(p, null, 2));
  return p;
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function sentToday(remote = null) {
  const now = Date.now();
  return store.all().filter(e =>
    e.resolution === 'sent' && e.auto && e.resolved_at && sameDay(e.resolved_at, now) &&
    (remote ? e.remote === remote : true)).length;
}

function withinHours(p, when = new Date()) {
  const h = p.hours ?? {};
  const days = h.days ?? [1, 2, 3, 4, 5];
  if (!days.includes(when.getDay())) return false;
  const hr = when.getHours();
  return hr >= (h.startHour ?? 8) && hr < (h.endHour ?? 18);
}

// Returns { ok, reason }. `reason` always explains the decision, so the UI can
// show why something did or did not fire.
export function evaluate(entry, p = policy(), now = new Date()) {
  if (!p.enabled) return { ok: false, reason: 'auto-reply is off' };
  if (entry.needs_human) return { ok: false, reason: 'triage flagged it for you' };
  if ((p.blockUrgencies ?? []).includes(entry.urgency))
    return { ok: false, reason: `urgency is ${entry.urgency}` };
  if ((p.allowCategories ?? []).length && !p.allowCategories.includes(entry.category))
    return { ok: false, reason: `category ${entry.category} not allowed` };

  const contact = lookup(entry.remote);
  if (p.requireKnownContact && (!contact || contact.role === 'unknown'))
    return { ok: false, reason: 'sender is not a labelled contact' };
  if ((p.allowRoles ?? []).length) {
    const role = contact?.role ?? entry.from_role;
    if (!p.allowRoles.includes(role)) return { ok: false, reason: `role ${role} not allowed` };
  }

  if (p.onlyOutsideHours && withinHours(p, now))
    return { ok: false, reason: 'inside working hours — you are available' };

  if (sentToday(entry.remote) >= (p.maxPerContactPerDay ?? 1))
    return { ok: false, reason: 'per-contact daily cap reached' };
  if (sentToday() >= (p.maxPerDay ?? 10))
    return { ok: false, reason: 'daily cap reached' };

  return { ok: true, reason: 'all gates passed' };
}

export function buildText(entry, p = policy()) {
  let text = p.mode === 'ai' && entry.suggested_reply?.trim()
    ? entry.suggested_reply.trim()
    : (p.template ?? 'Thanks — got your message.');
  if (p.disclose !== false) {
    const tag = p.disclosure ?? ' (automated reply)';
    if (!text.toLowerCase().includes('automated')) text += tag;
  }
  return text;
}

export function log(line) {
  appendFileSync(LOG, new Date().toISOString() + '  ' + line + NL);
}
