// Minimal Kazoo/Crossbar client. Authenticates with the user's own login,
// exactly as the phone system's own web app does. No secrets are ever logged.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import * as secrets from './secrets.mjs';
import * as profile from './profile.mjs';
import { loadEnv as readEnv, ENV_FILE } from './env.mjs';

export { connected } from './profile.mjs';

const TOKEN_FILE = new URL('../.token.json', import.meta.url);
const PROFILE_FILE = new URL('../profile.json', import.meta.url);

// For auth.mjs, which has nothing to work with without a .env. Everything else
// reads it through lib/env.mjs, where a missing file is simply empty.
export function loadEnv(path = ENV_FILE) {
  if (!existsSync(path)) throw new Error('.env not found — copy .env.example to .env and fill it in');
  return readEnv(path);
}

const hash = (algo, s) => createHash(algo).update(s).digest('hex');

// Kazoo infers the algorithm from digest length: 32 = md5, 40 = sha1.
function authBodies(env) {
  const raw = `${env.OOMA_USERNAME}:${env.OOMA_PASSWORD}`;
  const scopes = [];
  if (env.OOMA_ACCOUNT_REALM) scopes.push({ account_realm: env.OOMA_ACCOUNT_REALM });
  if (env.OOMA_ACCOUNT_NAME) scopes.push({ account_name: env.OOMA_ACCOUNT_NAME });
  if (env.OOMA_PHONE_NUMBER) scopes.push({ phone_number: env.OOMA_PHONE_NUMBER });
  if (!scopes.length) throw new Error('No account realm is set (the SIP realm, or OOMA_ACCOUNT_REALM / OOMA_ACCOUNT_NAME / OOMA_PHONE_NUMBER in .env).');

  const bodies = [];
  for (const algo of ['md5', 'sha1'])
    for (const scope of scopes)
      bodies.push({ algo, scope, data: { credentials: hash(algo, raw), ...scope } });
  return bodies;
}

// persist: false leaves .token.json alone, so a caller that may yet discard
// the result (stale sign-in) saves it with saveSession() only once adopted.
export async function authenticate(env, { persist = true } = {}) {
  const base = env.OOMA_API_BASE;
  if (!base) throw new Error('No API server is set.');
  const attempts = [];
  for (const b of authBodies(env)) {
    // The server is whatever the user typed; don't let a dead one hang sign-in.
    const res = await fetch(`${base}/v2/user_auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: b.data }),
      signal: AbortSignal.timeout(20e3),
    });
    const json = await res.json().catch(() => ({}));
    const label = `${b.algo} + ${Object.keys(b.scope)[0]}`;
    attempts.push({ label, status: res.status, message: json.message ?? '' });
    if (res.ok && json.auth_token) {
      const session = {
        auth_token: json.auth_token,
        account_id: json.data?.account_id,
        owner_id: json.data?.owner_id,
        base,
        method: label,
      };
      if (persist) saveSession(session);
      return { session, attempts };
    }
  }
  return { session: null, attempts };
}

// Only the sign-in's own fields: other modules cache things on the live
// session object (send.mjs, calls.mjs) that don't belong on disk.
const SESSION_FIELDS = ['auth_token', 'account_id', 'owner_id', 'base', 'method'];
export function saveSession(s) {
  const out = {};
  for (const k of SESSION_FIELDS) if (s?.[k] !== undefined) out[k] = s[k];
  writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 2));
  try { chmodSync(TOKEN_FILE, 0o600); } catch {}
}

// For the command-line tools: no session is fatal there.
export function loadSession() {
  if (!existsSync(TOKEN_FILE)) throw new Error('No session — run: node auth.mjs');
  const s = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  // A tool run before the app's first launch must see an older install's servers too.
  if (!existsSync(PROFILE_FILE)) profile.migrate(s);
  return s;
}

// For the app: no (or an unreadable) session just means "not signed in".
export function tryLoadSession() {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const s = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  } catch { return null; }
}

// Signs out: removes the saved token and empties the session object in place,
// so every module holding a reference sees it go.
export function clearSession(session) {
  try { rmSync(TOKEN_FILE, { force: true }); } catch {}
  for (const k of Object.keys(session ?? {})) delete session[k];
}

// Strip the auth_token Kazoo echoes back in every response, so it never
// reaches a log, a console, or a transcript.
export function redact(v) {
  // Tokens also ride inside media URLs as ?auth_token=... — scrub those too.
  if (typeof v === 'string')
    return v.replace(/([?&]auth_token=)[^&\s"']+/gi, '$1<redacted>');
  if (v && typeof v === 'object') {
    const out = Array.isArray(v) ? [] : {};
    for (const [k, val] of Object.entries(v))
      out[k] = k === 'auth_token' ? '<redacted>' : redact(val);
    return out;
  }
  return v;
}

// Login details: what was entered on the app's Account page wins; .env is
// the fallback (and the only source for the command-line tools). The API
// server and realm come from the connection profile (lib/profile.mjs), which
// itself falls back to .env. No built-in servers: unset means unset.
export function credentials() {
  const env = readEnv();
  const u = secrets.get('login.username'), pw = secrets.get('login.password');
  if (u && pw) { env.OOMA_USERNAME = u; env.OOMA_PASSWORD = pw; }
  const p = profile.get();
  if (p.apiServer) env.OOMA_API_BASE = p.apiServer;
  if (p.realm) env.OOMA_ACCOUNT_REALM = p.realm;
  return env;
}

// Re-authenticates in place when the JWT expires. The session object is
// mutated rather than replaced so long-lived holders (the WebSocket loop,
// media fetches) pick up the new token automatically.
async function refresh(session) {
  // The desktop app signs in only with the Account page's login: after a
  // sign-out, .env must not bring the session back.
  if (secrets.available() && !(secrets.get('login.username') && secrets.get('login.password'))) return false;
  const env = credentials();
  if (!env.OOMA_USERNAME || !env.OOMA_PASSWORD) return false;
  const was = session.auth_token, base = session.base;
  try {
    const { session: fresh } = await authenticate(env, { persist: false });
    if (!fresh) return false;
    // Signed out or replaced by another sign-in meanwhile: never refill.
    if (!profile.connected(session) || session.base !== base) return false;
    if (session.auth_token !== was) return true;   // a concurrent refresh already won
    Object.assign(session, fresh);
    saveSession(session);
    return true;
  } catch { return false; }
}

export async function api(session, path, opts = {}, retry = true) {
  const url = path.startsWith('http') ? path
    : `${session.base}/v2/accounts/${session.account_id}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { 'X-Auth-Token': session.auth_token, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (res.status === 401 && retry && await refresh(session))
    return api(session, path, opts, false);

  const body = redact(await res.json().catch(() => null));
  return { status: res.status, ok: res.ok, body };
}
