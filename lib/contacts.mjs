// Number -> {name, role} roster. When a number is known, the role is taken
// from here instead of being guessed by the model per message.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FILE = new URL('../contacts.json', import.meta.url);
export const ROLES = ['technician', 'customer', 'vendor', 'unknown'];

export function load() {
  if (!existsSync(FILE)) return {};
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export const save = (c) => writeFileSync(FILE, JSON.stringify(c, null, 2));

const key = (n) => String(n ?? '').replace(/[^\d+]/g, '');

export function lookup(number, roster = load()) {
  return roster[key(number)] ?? null;
}

// Adds any unseen numbers as role "unknown" so they can be labelled by hand.
export function bootstrap(messages) {
  const roster = load();
  let added = 0;
  for (const m of messages) {
    const k = key(m.remote);
    if (!k || roster[k]) continue;
    roster[k] = { name: '', role: 'unknown', note: '' };
    added++;
  }
  save(roster);
  return { roster, added };
}
