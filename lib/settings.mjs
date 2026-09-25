// App settings (non-secret). Credentials live in lib/secrets.mjs instead.
//
// Stored in settings.json; anything unset falls back to DEFAULTS, which in
// turn honour the old environment variables. Values are read on every use,
// so a change on the Settings page applies without a restart.
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('settings.json');
const env = process.env;

export const DEFAULTS = {
  // Triage and the morning recap need an AI platform, so they start off and
  // the app opens on Messages; turning either on is what brings its UI back.
  general: { startPage: '/messages', theme: 'dark', background: 'default', animatedBackground: true },
  notifications: { messages: true, lowUrgency: true, lowUrgencySound: true, calls: true },
  triage: {
    enabled: false,
    pollSeconds: Math.round(Number(env.POLL_MS ?? 60000) / 1000),
    describePhotos: true,
    model: env.TRIAGE_MODEL ?? 'google/gemma-4-e4b',
    visionModel: env.VISION_MODEL ?? 'google/gemma-4-e4b',
    lmStudioUrl: env.LMSTUDIO_URL ?? 'http://localhost:1234/v1',
    whisperModel: env.WHISPER_MODEL ?? 'base.en',
    instructions: '',            // '' = the built-in triage instructions (lib/llm.mjs)
  },
  // Where triage runs. Local by default; the cloud ones need an API key.
  ai: {
    provider: 'lmstudio',
    ollamaUrl: env.OLLAMA_URL ?? 'http://localhost:11434',
    ollamaModel: '', ollamaVisionModel: '',
    anthropicModel: 'claude-opus-5', anthropicVisionModel: 'claude-opus-5',
    openaiModel: '', openaiVisionModel: '',
    claudeCodeModel: 'sonnet', claudeCodeVisionModel: 'sonnet',
  },
  // Morning recap of the previous day (lib/review.mjs), shown on Insights.
  review: { enabled: false, time: '06:30', transcribe: true },
  phone: { enabled: true, preferApp: true, ringVolume: 60, sipTrace: false },
  sounds: {
    ringtone: 'classic', ringtoneFile: '',
    message: 'ding', messageFile: '',
    urgent: 'same', urgentFile: '',
    messageVolume: 60,
  },
  downloads: { folder: '', ask: false },
};

export const PAGES = ['/', '/messages', '/calls', '/photos', '/contacts', '/voicemail', '/insights'];
// Must match THEMES in bg.js.
export const BACKGROUNDS = ['default', 'aurora', 'marble', 'mercury', 'dawn', 'vapor', 'velvet'];
export const WHISPER_MODELS = ['tiny.en', 'base.en', 'small.en', 'medium.en'];
// Must match the presets in sounds.js.
export const RINGTONES = ['classic', 'double', 'chime', 'marimba', 'digital', 'pulse', 'custom'];
export const MESSAGE_SOUNDS = ['ding', 'pop', 'chirp', 'twotone', 'knock', 'alert', 'custom', 'none'];
const soundFile = (slot) => (v) => v === '' || new RegExp(`^custom-${slot}\\.(mp3|wav|ogg|m4a)$`).test(v);

const isBool = (v) => typeof v === 'boolean';
const isModel = (v) => typeof v === 'string' && /^[\w./:@+-]{1,120}$/.test(v);
// LM Studio and Ollama must stay on this machine or the local network: every
// message and photo goes to this address, so it must never point at the
// internet. (The cloud platforms are fixed endpoints in lib/ai.mjs, used only
// when chosen explicitly.)
export const isLocalUrl = (v) => {
  let u;
  try { u = new URL(v); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname;
  return h === 'localhost' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
         /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '[::1]';
};
const isFolder = (v) => typeof v === 'string' && v.length < 400 && (v === '' || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\'));

const RULES = {
  'general.startPage': (v) => PAGES.includes(v),
  'general.theme': (v) => ['dark', 'light', 'system'].includes(v),
  'general.background': (v) => BACKGROUNDS.includes(v),
  'general.animatedBackground': isBool,
  'notifications.messages': isBool,
  'notifications.lowUrgency': isBool,
  'notifications.lowUrgencySound': isBool,
  'notifications.calls': isBool,
  'triage.enabled': isBool,
  'triage.pollSeconds': (v) => Number.isInteger(v) && v >= 15 && v <= 3600,
  'triage.describePhotos': isBool,
  'triage.model': isModel,
  'triage.visionModel': isModel,
  'triage.lmStudioUrl': isLocalUrl,
  'ai.provider': (v) => ['lmstudio', 'ollama', 'anthropic', 'openai', 'claudecode', 'connector'].includes(v),
  'ai.ollamaUrl': isLocalUrl,
  'ai.ollamaModel': (v) => v === '' || isModel(v),
  'ai.ollamaVisionModel': (v) => v === '' || isModel(v),
  'ai.anthropicModel': isModel,
  'ai.anthropicVisionModel': isModel,
  'ai.openaiModel': (v) => v === '' || isModel(v),
  'ai.openaiVisionModel': (v) => v === '' || isModel(v),
  'ai.claudeCodeModel': isModel,
  'ai.claudeCodeVisionModel': isModel,
  'triage.whisperModel': (v) => WHISPER_MODELS.includes(v),
  'triage.instructions': (v) => typeof v === 'string' && v.length <= 4000,
  'review.enabled': isBool,
  'review.time': (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
  'review.transcribe': isBool,
  'phone.enabled': isBool,
  'phone.preferApp': isBool,
  'phone.ringVolume': (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  'phone.sipTrace': isBool,
  'downloads.folder': isFolder,
  'sounds.ringtone': (v) => RINGTONES.includes(v),
  'sounds.ringtoneFile': soundFile('ringtone'),
  'sounds.message': (v) => MESSAGE_SOUNDS.includes(v),
  'sounds.messageFile': soundFile('message'),
  'sounds.urgent': (v) => v === 'same' || MESSAGE_SOUNDS.includes(v),
  'sounds.urgentFile': soundFile('urgent'),
  'sounds.messageVolume': (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  'downloads.ask': isBool,
};

// Cached, but re-read when the file changes on disk — the app process and the
// hosted server may each hold a copy of this module, and the CLI tools read
// the same file.
let cache = null, cachedMtime = -1;
function stored() {
  let mtime = 0;
  try { mtime = existsSync(FILE) ? statSync(FILE).mtimeMs : 0; } catch {}
  if (cache && mtime === cachedMtime) return cache;
  try { cache = mtime ? JSON.parse(readFileSync(FILE, 'utf8')) : {}; }
  catch { cache = {}; }
  cachedMtime = mtime;
  return cache;
}

export function get(path) {
  const [a, b] = path.split('.');
  const v = stored()?.[a]?.[b];
  return v === undefined ? DEFAULTS[a]?.[b] : v;
}

export function all() {
  const out = {};
  for (const [a, sect] of Object.entries(DEFAULTS)) {
    out[a] = {};
    for (const b of Object.keys(sect)) out[a][b] = get(`${a}.${b}`);
  }
  return out;
}

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// patch is flat: { 'triage.enabled': false, 'phone.ringVolume': 40 }
export function update(patch) {
  const next = structuredClone(stored());
  const errors = [];
  for (const [k, v] of Object.entries(patch ?? {})) {
    const rule = RULES[k];
    if (!rule) { errors.push(`unknown setting ${k}`); continue; }
    if (!rule(v)) { errors.push(`invalid value for ${k}`); continue; }
    const [a, b] = k.split('.');
    (next[a] ??= {})[b] = v;
  }
  if (errors.length) throw new Error(errors.join('; '));
  writeFileSync(FILE, JSON.stringify(next, null, 2));
  cache = next;
  for (const fn of listeners) { try { fn(patch); } catch {} }
  return all();
}

export function reset() {
  writeFileSync(FILE, '{}');
  cache = {};
  for (const fn of listeners) { try { fn({ reset: true }); } catch {} }
  return all();
}
