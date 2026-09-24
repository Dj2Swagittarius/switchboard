// Reads .env (KEY=value lines). Shared by the app and the command-line tools.
// A missing or unreadable file is just an empty result: a fresh install has
// no .env, and the app must boot without one. lib/kazoo.mjs keeps a throwing
// wrapper for auth.mjs, which cannot do anything useful without the file.
import { readFileSync, existsSync } from 'node:fs';

export const ENV_FILE = new URL('../.env', import.meta.url);

export function loadEnv(path = ENV_FILE) {
  const env = {};
  let text;
  try {
    if (!existsSync(path)) return env;
    text = readFileSync(path, 'utf8');
  } catch { return env; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
