// What the vision model saw in each photo, by message id: an array, one
// description per image. Kept apart from the triage queue so conversation
// triage and the daily recap reuse it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('photo-notes.json');
const KEEP = 3000;

export function all() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}
export const get = (id) => all()[id] ?? null;
export function set(id, descriptions) {
  const n = all();
  delete n[id];
  n[id] = descriptions;
  const keys = Object.keys(n);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete n[k];
  writeFileSync(FILE, JSON.stringify(n));
}
