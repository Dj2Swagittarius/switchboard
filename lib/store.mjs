// Append-only review queue. One JSON object per line.
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('queue.jsonl');

export function add(entry) {
  appendFileSync(FILE, JSON.stringify({ ...entry, queued_at: new Date().toISOString() }) + String.fromCharCode(10));
}

export function all() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8').split(String.fromCharCode(10))
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export const pending = () => all().filter(e => !e.resolution);

export function resolve(id, resolution, extra = {}) {
  const rows = all().map(e => e.id === id ? { ...e, resolution, resolved_at: new Date().toISOString(), ...extra } : e);
  writeFileSync(FILE, rows.map(r => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10));
}

export const has = (id) => all().some(e => e.id === id);

// Merges `patch` into one entry; a key set to undefined is removed. Null when
// there is no such entry.
export function update(id, patch) {
  let hit = null;
  const rows = all().map(e => (e.id === id ? (hit = JSON.parse(JSON.stringify({ ...e, ...patch }))) : e));
  if (!hit) return null;
  writeFileSync(FILE, rows.map(r => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  return hit;
}
