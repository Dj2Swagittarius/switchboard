// The connection profile: which SIP, API and messaging servers this app talks
// to. Non-secret, stored in profile.json in the app folder; the logins
// themselves live in lib/secrets.mjs.
//
// Nothing here names a provider. The SIP fields are always needed (the phone);
// the API server is optional, and only when it is set do the account login and
// the data pages (messages, calls, voicemail, photos, triage, insights) exist.
//
// Must not import lib/kazoo.mjs: kazoo reads the profile, so that would be a cycle.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import * as secrets from './secrets.mjs';
import { loadEnv, ENV_FILE } from './env.mjs';

const FILE = new URL('../profile.json', import.meta.url);

export const FIELDS = ['realm', 'wsServer', 'stun', 'apiServer', 'eventsServer', 'messagingServer', 'mediaServer'];

// Migration only: what builds before profile.json used without being told,
// written out once for an existing install so it keeps working unchanged.
// Never used as defaults for a new setup.
const LEGACY = {
  realm: 'oeinternal.voxter.sip.voxter.com',
  wsServer: 'wss://sbc-na-us-east.voxter.com:5065',
  stun: 'stun:stun.ooma.com:3478',
  apiServer: 'https://api-na-us-east.voxter.com',
  eventsServer: 'wss://api-na-us-east.voxter.com:5556',
  messagingServer: 'https://api-na-us-east.voxter.com:8443',
  mediaServer: 'https://api.voxter.com:8443/v2/messaging/ooma_media/',
};

// Same test as lib/kazoo.mjs exports (re-exported there); defined here so the
// setup steps can use it without importing kazoo.
export const connected = (s) => !!(s && s.auth_token && s.account_id && s.base);

// Plain-text (http/ws) is allowed only to this machine or the local network.
// Numeric addresses only for the private ranges, so "10.example.com" is not local.
export const isLocalHost = (hostname) => {
  const h = String(hostname ?? '').toLowerCase();
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m || m.slice(1).some(x => Number(x) > 255)) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
};

// ---- storage -----------------------------------------------------------------
// Cached, but re-read when the file changes on disk (the CLI tools and the
// hosted server may each hold a copy of this module), like lib/settings.mjs.
let cache = null, cachedMtime = -1;
export function stored() {
  let mtime = 0;
  try { mtime = existsSync(FILE) ? statSync(FILE).mtimeMs : 0; } catch {}
  if (cache && mtime === cachedMtime) return cache;
  try {
    const v = mtime ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    cache = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { cache = {}; }
  cachedMtime = mtime;
  return cache;
}

let envCache = null, envMtime = -1;
function dotenv() {
  let mtime = 0;
  try { mtime = existsSync(ENV_FILE) ? statSync(ENV_FILE).mtimeMs : 0; } catch {}
  if (envCache && mtime === envMtime) return envCache;
  envCache = mtime ? loadEnv() : {};
  envMtime = mtime;
  return envCache;
}

const noSlash = (v) => String(v ?? '').replace(/\/+$/, '');

// Every field as a string. realm and apiServer fall back to .env when
// profile.json does not mention them (the CLI tools' old configuration); a
// field saved blank on purpose stays blank.
export function get() {
  const s = stored(), env = dotenv();
  const p = {};
  for (const f of FIELDS) p[f] = typeof s[f] === 'string' ? s[f] : '';
  if (typeof s.realm !== 'string') p.realm = env.OOMA_ACCOUNT_REALM ?? '';
  if (typeof s.apiServer !== 'string') p.apiServer = noSlash(env.OOMA_API_BASE);
  return p;
}

// The values actually used, with the optional advanced fields filled in.
export function derived(p = get()) {
  const eventsServer = p.eventsServer || process.env.BLACKHOLE_URL || '';
  const messagingServer = p.messagingServer || process.env.OOMA_SEND_BASE || p.apiServer || '';
  const mediaServer = p.mediaServer || process.env.OOMA_MEDIA_BASE ||
    (messagingServer ? messagingServer + '/v2/messaging/ooma_media/' : '');
  return { eventsServer, messagingServer, mediaServer };
}

export const hasApi = (p = get()) => !!p.apiServer;

// ---- validation --------------------------------------------------------------
const LABEL = {
  realm: 'SIP realm', wsServer: 'WebSocket server', stun: 'STUN server', apiServer: 'API server',
  eventsServer: 'Events server', messagingServer: 'Messaging server', mediaServer: 'Media server',
};
const REALM = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const STUN = /^stuns?:[A-Za-z0-9.-]+(:\d{1,5})?$/;

// null when fine, else why not. `secure` is wss:/https:, `plain` its local-only twin.
function urlProblem(v, secure, plain, { query = true } = {}) {
  const label = secure === 'wss:' ? 'wss://' : 'https://';
  const plainLabel = plain === 'ws:' ? 'ws://' : 'http://';
  let u;
  try { u = new URL(v); } catch { return `isn't a valid address`; }
  if (!/^[a-z]+:\/\//i.test(v) || !u.hostname) return `isn't a valid address`;
  if (u.protocol !== secure && !(u.protocol === plain && isLocalHost(u.hostname)))
    return `must start with ${label} (${plainLabel} only for this computer or your local network)`;
  if (u.username || u.password || /^[a-z]+:\/\/[^/?#]*@/i.test(v)) return `can't include a username or password`;
  if (v.includes('#')) return `can't include a # part`;
  if (!query && v.includes('?')) return `can't include a ? part`;
  return null;
}

const CHECK = {
  realm: (v) => REALM.test(v) ? null : 'should be a domain name, like sip.example.com',
  wsServer: (v) => urlProblem(v, 'wss:', 'ws:'),
  eventsServer: (v) => urlProblem(v, 'wss:', 'ws:'),
  stun: (v) => {
    const m = STUN.exec(v);
    if (!m) return 'should look like stun:host:port (or stuns:)';
    return m[1] && Number(m[1].slice(1)) > 65535 ? 'has a port that is out of range' : null;
  },
  apiServer: (v) => urlProblem(v, 'https:', 'http:', { query: false }),
  messagingServer: (v) => urlProblem(v, 'https:', 'http:', { query: false }),
  mediaServer: (v) => urlProblem(v, 'https:', 'http:', { query: false }),
};

// Checks non-empty values only; whether a required field is present is the
// caller's decision (setup asks for them in order).
export function validate(patch) {
  const errors = [];
  for (const [k, raw] of Object.entries(patch ?? {})) {
    if (!FIELDS.includes(k)) { errors.push(`Unknown server setting "${k}".`); continue; }
    if (raw != null && typeof raw !== 'string') { errors.push(`The ${LABEL[k]} must be text.`); continue; }
    const v = String(raw ?? '').trim();
    if (!v) continue;
    if (v.length > 500) { errors.push(`The ${LABEL[k]} is too long.`); continue; }
    const why = CHECK[k](v);
    if (why) errors.push(`The ${LABEL[k]} ${why}.`);
  }
  return errors;
}

function normalise(field, raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  if (field === 'apiServer' || field === 'messagingServer' || field === 'mediaServer') v = noSlash(v);
  if (field === 'mediaServer') v += '/';
  return v;
}

function write(next) {
  const out = {};
  for (const f of FIELDS) if (typeof next[f] === 'string') out[f] = next[f];
  writeFileSync(FILE, JSON.stringify(out, null, 2));
  cache = null; cachedMtime = -1;     // re-read (and re-stat) on next use
}

// Only the fields present in patch change. Throws with every problem at once.
export function update(patch) {
  const errors = validate(patch);
  if (errors.length) throw new Error(errors.join(' '));
  const next = { ...stored() };
  for (const f of FIELDS) if (Object.hasOwn(patch, f)) next[f] = normalise(f, patch[f]);
  write(next);
  return get();
}

// Start over. Leaves a profile rather than no file: with no file, the next
// boot's migration would bring the old servers back from .env. realm and
// apiServer are saved blank so get() doesn't fall back to .env for them.
export function clear() {
  write({ realm: '', apiServer: '' });
}

// ---- what the pages need -------------------------------------------------------
// What the phone window registers with. The password only goes out when the
// phone can actually use it.
export function sipConfig() {
  const p = get(), d = secrets.status().device;
  const configured = !!(p.realm && p.wsServer && d.set);
  return {
    configured, username: d.username, authUsername: d.authUsername,
    password: configured ? secrets.get('sip.password') ?? '' : '',
    realm: p.realm, server: p.wsServer, stun: p.stun,
  };
}

// The first setup step still to do, or null when setup is complete.
export function step(session, { p = get(), a = secrets.status() } = {}) {
  if (!(p.realm && p.wsServer)) return 'server';
  if (hasApi(p) && !connected(session) && !a.login.set) return 'login';
  if (!a.device.set) return 'device';
  return null;
}

// GET /api/profile (and the SSE 'profile' event). Nothing secret.
export function summary(session) {
  const p = get();
  const s = step(session, { p });
  return {
    gate: secrets.available(), ready: s === null, step: s,
    platform: hasApi(p) && connected(session), phoneOnly: !hasApi(p),
  };
}

// GET /api/account: the Account page's form values and each section's state.
export function status(session, { loginError = '' } = {}) {
  const p = get(), a = secrets.status();
  const s = step(session, { p, a });
  return {
    secureStorage: a.secureStorage, gate: secrets.available(), ready: s === null, step: s,
    server: { ...p, derived: derived(p), set: !!(p.realm && p.wsServer) },
    login: { needed: hasApi(p), set: a.login.set, username: a.login.username,
             connected: connected(session), error: loginError },
    device: a.device,
  };
}

// ---- migration -----------------------------------------------------------------
// One-time import from builds before profile.json. Safe to run on every boot:
// each part only acts while there is something left to move. Never throws and
// never logs values (some sources are secret stores).
export function migrate(session) {
  const done = { profile: false, secrets: false };
  const has = (k) => { try { return secrets.get(k) != null; } catch { return false; } };
  const val = (k) => { try { return secrets.get(k) ?? ''; } catch { return ''; } };
  // Keys only the old build wrote (sip.username is a current key, so not one).
  const OLD_KEYS = ['ooma.username', 'ooma.password', 'sip.realm', 'sip.server'];
  // First usable value; one that would fail validation is skipped rather than
  // blocking the rest.
  const pick = (f, list) => normalise(f, list.map(v => String(v ?? '').trim())
    .find(v => v && !validate({ [f]: v }).length) ?? '');
  const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

  // 1. profile.json, written with what the old build used implicitly.
  try {
    if (!existsSync(FILE)) {
      const env = loadEnv();
      const oldKeys = OLD_KEYS.some(has);
      const legacy = connected(session) || !!(env.OOMA_USERNAME || env.OOMA_API_BASE || env.OOMA_ACCOUNT_REALM) || oldKeys;
      if (legacy) {
        // The old build fell back to its built-in API server, so landing on it
        // (or a token for it) means the old provider's servers were in use.
        const apiServer = pick('apiServer', [session?.base, env.OOMA_API_BASE, LEGACY.apiServer]);
        const legacyHost = host(LEGACY.apiServer);
        const oldBuild = oldKeys || host(apiServer) === legacyHost ||
          (connected(session) && host(session.base) === legacyHost);
        // Otherwise only what was set explicitly; the rest stays blank and the
        // setup wizard asks for it.
        const L = (f) => oldBuild ? [LEGACY[f]] : [];
        const candidates = {
          realm: [val('sip.realm'), env.OOMA_ACCOUNT_REALM, ...L('realm')],
          wsServer: [val('sip.server'), ...L('wsServer')],
          stun: [...L('stun')],
          apiServer: [apiServer],
          eventsServer: [process.env.BLACKHOLE_URL, ...L('eventsServer')],
          messagingServer: [process.env.OOMA_SEND_BASE, ...L('messagingServer')],
          mediaServer: [process.env.OOMA_MEDIA_BASE, ...L('mediaServer')],
        };
        const next = {};
        for (const f of FIELDS) next[f] = pick(f, candidates[f]);
        write(next);
        done.profile = true;
      }
    }
  } catch {}

  // 2. secrets: old key names to new, and SIP servers out of the secret store.
  // Waits for profile.json: if part 1 could not write it, the old keys are
  // still the only copy of the SIP servers, so leave them for the next boot.
  try {
    if (secrets.available() && existsSync(FILE) && OLD_KEYS.some(has)) {
      const cur = stored();
      const envRealm = String(loadEnv().OOMA_ACCOUNT_REALM ?? '').trim();
      const fill = {};
      for (const [f, k] of [['realm', 'sip.realm'], ['wsServer', 'sip.server']]) {
        const v = val(k).trim();
        // Part 1 may have run without the secret store (CLI, plain node) and
        // written a default or the .env realm; the saved value was the real one.
        const standIn = !cur[f] || cur[f] === LEGACY[f] || (f === 'realm' && !!envRealm && cur[f] === envRealm);
        if (standIn && v && v !== cur[f] && !validate({ [f]: v }).length) fill[f] = v;
      }
      if (Object.keys(fill).length) update(fill);

      const patch = { 'ooma.username': null, 'ooma.password': null, 'sip.realm': null, 'sip.server': null };
      if (!has('login.username') && !has('login.password')) {
        patch['login.username'] = val('ooma.username') || null;
        patch['login.password'] = val('ooma.password') || null;
      }
      secrets.set(patch);
      done.secrets = true;
    }
  } catch {}
  return done;
}
