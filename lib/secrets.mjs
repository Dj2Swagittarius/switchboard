// Credentials entered in the app's Account page.
//
// Encrypted at rest with Electron's safeStorage (Windows DPAPI: only this
// Windows user account can decrypt the file). Only available when the server
// is hosted inside the desktop app; plain `node server.mjs` falls back to .env
// for the account login and has no phone.
//
// Passwords go in and never come back out through the UI: status() reports
// only whether each credential is set, plus the non-secret usernames.
//
// Keys: login.username / login.password (account login), sip.username /
// sip.password / sip.authUsername (phone device), ai.anthropicKey / ai.openaiKey.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('secrets.bin');

let electron = null;
try { electron = await import('electron'); } catch {}

// Checked on use rather than once at load: safeStorage only reports itself
// available after the app is ready, and this module may be loaded earlier.
let safe = null;
function store() {
  if (!safe && electron?.safeStorage?.isEncryptionAvailable?.()) safe = electron.safeStorage;
  return safe;
}

export const available = () => !!store();

// Set when the last read found a file this process could not decrypt (e.g. a
// second copy of the app, or another Windows user). Reads as empty, so the
// next write would otherwise replace every saved login.
let unreadable = false;

function readAll() {
  if (!store() || !existsSync(FILE)) return {};
  try {
    const all = JSON.parse(safe.decryptString(readFileSync(FILE)));
    unreadable = false;
    return all;
  } catch { unreadable = true; return {}; }
}

function writeAll(obj) {
  if (!store()) throw new Error('secure storage is only available in the desktop app');
  if (unreadable) {
    // Keep the file we couldn't read before overwriting it.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try { copyFileSync(FILE, dataPath(`secrets.bin.unreadable-${stamp}`)); } catch {}
  }
  writeFileSync(FILE, safe.encryptString(JSON.stringify(obj)));
  unreadable = false;
}

export const get = (key) => readAll()[key] ?? null;

// Empty string or null removes a key.
export function set(patch) {
  const cur = readAll();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete cur[k];
    else cur[k] = String(v);
  }
  writeAll(cur);
}

export function forget(prefix) {
  const cur = readAll();
  for (const k of Object.keys(cur)) if (k.startsWith(prefix)) delete cur[k];
  writeAll(cur);
}

export function status() {
  const s = readAll();
  return {
    secureStorage: available(),
    login: { set: !!(s['login.username'] && s['login.password']), username: s['login.username'] ?? '' },
    device: {
      set: !!(s['sip.username'] && s['sip.password']),
      username: s['sip.username'] ?? '',
      authUsername: s['sip.authUsername'] ?? '',
    },
    // Cloud AI keys: only whether one is saved.
    ai: { anthropic: !!s['ai.anthropicKey'], openai: !!s['ai.openaiKey'] },
  };
}
