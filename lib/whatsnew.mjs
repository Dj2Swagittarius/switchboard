// "What's new" after an update.
//
// changelog.json ships with the app: newest first, one entry per release,
// written for the people using it (scripts/release.mjs won't publish a version
// without one). The last version this person has seen notes for is kept in
// the data folder; the first start on a newer version shows every entry in
// between, once.
//
// A brand-new install has nothing to catch up on: init(), run when this
// module loads (server.mjs imports it first, before anything writes data), records the version
// when the data folder is empty. An install from before this existed has data
// but no record: it gets the current version's notes.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { APP_DIR, dataPath } from './paths.mjs';
import { join } from 'node:path';

const SEEN = dataPath('seen-version.json');
const MAX = 5;

export const compare = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

export const currentVersion = () => JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version;
export function changelog() {
  try { return JSON.parse(readFileSync(join(APP_DIR, 'changelog.json'), 'utf8')); } catch { return []; }
}

function seen() {
  try { return JSON.parse(readFileSync(SEEN, 'utf8')).version || null; } catch { return null; }
}
export function markSeen(version = currentVersion()) {
  writeFileSync(SEEN, JSON.stringify({ version }, null, 2));
}

const EXISTING = ['profile.json', 'secrets.bin', 'settings.json', 'lines.json'];
function init() {
  if (!existsSync(SEEN) && !EXISTING.some(f => existsSync(dataPath(f)))) markSeen();
}
try { init(); } catch {}

// The notes to show now, or null.
export function pending() {
  const now = currentVersion();
  const from = seen();   // null: upgraded from a version before this existed
  if (from && compare(from, now) >= 0) return null;
  const entries = changelog()
    .filter(e => compare(e.version, now) <= 0 && (from ? compare(e.version, from) > 0 : compare(e.version, now) === 0))
    .slice(0, MAX);
  if (!entries.length) { markSeen(now); return null; }
  return { version: now, entries };
}
