// On-disk copy of the texts already fetched, so Messages opens instantly and
// later fetches only ask the phone platform for what's new.
//
// msg-cache.json (gitignored, owner-only) holds, for the signed-in user only:
//   lists:   last conversation list per line filter ('' = all lines)
//   threads: every thread opened so far, oldest message first
//   reads:   per thread, how far it has been read in Messages (see messaging.mjs)
// A different user signing in starts an empty cache. Writes are batched.
import { readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('msg-cache.json');
let db = null;
let timer = null;

function blank(owner) { return { v: 1, owner, lists: {}, threads: {}, reads: {} }; }

function load(owner) {
  if (db && db.owner === owner) return db;
  let d = null;
  try { if (existsSync(FILE)) d = JSON.parse(readFileSync(FILE, 'utf8')); } catch {}
  db = d && d.v === 1 && d.owner === owner && d.lists && d.threads ? d : blank(owner);
  db.reads ??= {};   // files from before read marks
  return db;
}

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      writeFileSync(FILE, JSON.stringify(db));
      try { chmodSync(FILE, 0o600); } catch {}
    } catch {}
  }, 1000);
}

const who = (session) => String(session?.account_id ?? '') + ':' + String(session?.owner_id ?? '');
const tkey = (line, remote) => line + '|' + remote;

export function getList(session, lineKey) {
  return load(who(session)).lists[lineKey ?? ''] ?? null;
}
export function putList(session, lineKey, conversations) {
  load(who(session)).lists[lineKey ?? ''] = { at: Date.now(), conversations };
  save();
}

export function getThread(session, line, remote) {
  return load(who(session)).threads[tkey(line, remote)] ?? null;
}
export function putThread(session, line, remote, rec) {
  load(who(session)).threads[tkey(line, remote)] = { ...rec, at: Date.now() };
  save();
}

export function getRead(session, line, remote) {
  return load(who(session)).reads[tkey(line, remote)] ?? null;
}
export function putRead(session, line, remote, rec) {
  load(who(session)).reads[tkey(line, remote)] = rec;
  save();
}

// Signed out: nothing of the old account's texts stays on disk.
export function clear() {
  clearTimeout(timer);
  db = null;
  try { rmSync(FILE, { force: true }); } catch {}
}
