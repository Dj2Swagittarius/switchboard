// The AI platform: where triage, photo descriptions and thread summaries run.
//
//   lmstudio   LM Studio on this PC or the local network (OpenAI-compatible)
//   ollama     Ollama on this PC or the local network (native /api/chat)
//   anthropic  Claude, Anthropic's cloud API (official SDK)
//   openai     OpenAI's cloud API
//   claudecode Claude through the Claude Code app on this PC (your own Claude
//              plan, no API key; lib/claudecode.mjs)
//   connector  nothing runs here: the Claude app (Desktop, Cowork, Claude
//              Code) does the triage through the Switchboard connector
//              (lib/connector.mjs, mcp/switchboard-mcp.mjs)
//
// The two local platforms keep every message and photo on your own machines;
// their addresses are refused unless they are local (see settings.mjs). The
// cloud platforms are fixed endpoints, used only when chosen in Settings with
// an API key, which is kept encrypted in secrets.bin and never sent back to
// the UI.
//
// Everything goes through two calls: json() for a structured answer against a
// JSON schema, and vision() for a short description of one image.
import Anthropic from '@anthropic-ai/sdk';
import * as settings from './settings.mjs';
import * as secrets from './secrets.mjs';
import * as claudecode from './claudecode.mjs';

export const PROVIDERS = ['lmstudio', 'ollama', 'anthropic', 'openai', 'claudecode', 'connector'];
export const LABEL = { lmstudio: 'LM Studio', ollama: 'Ollama', anthropic: 'Claude', openai: 'OpenAI',
                       claudecode: 'Claude Code', connector: 'the Claude app' };
// The platforms that take an API key.
export const isCloud = (p) => p === 'anthropic' || p === 'openai';
// Large context window: long jobs send their material whole instead of in
// small pieces.
export const bigContext = (p) => isCloud(p) || p === 'claudecode' || p === 'connector';

// Connector mode: triage and recaps are done by the Claude app calling in, so
// nothing may call out. A caller that isn't connector-aware fails with this.
export class ConnectorModeError extends Error {
  constructor() { super('The Claude app does this in connector mode. Ask Claude from the Claude app.'); }
}

const OPENAI_URL = 'https://api.openai.com/v1';
const KEY = { anthropic: 'ai.anthropicKey', openai: 'ai.openaiKey' };

export const provider = () => settings.get('ai.provider');

// Per-platform model settings. LM Studio keeps the original triage.* keys.
const MODEL_KEYS = {
  lmstudio: ['triage.model', 'triage.visionModel'],
  ollama: ['ai.ollamaModel', 'ai.ollamaVisionModel'],
  anthropic: ['ai.anthropicModel', 'ai.anthropicVisionModel'],
  openai: ['ai.openaiModel', 'ai.openaiVisionModel'],
  claudecode: ['ai.claudeCodeModel', 'ai.claudeCodeVisionModel'],
};
export const modelKeys = (p = provider()) => MODEL_KEYS[p] ?? MODEL_KEYS.lmstudio;
// Connector mode has no model of its own: whichever the person's Claude app uses.
export const textModel = (p = provider()) => (p === 'connector' ? 'Claude app' : settings.get(modelKeys(p)[0]));
export const visionModel = (p = provider()) => (p === 'connector' ? 'Claude app' : settings.get(modelKeys(p)[1]));

const trim = (u) => String(u ?? '').replace(/\/+$/, '');
function need(model, p) {
  if (!model) throw new Error(`Pick a ${LABEL[p]} model in Settings → Triage & AI.`);
  return model;
}
function keyFor(p, override) {
  const k = override ?? secrets.get(KEY[p]);
  if (!k) throw new Error(`Add your ${LABEL[p]} API key in Settings → Triage & AI.`);
  return k;
}
// The model stopped before finishing: its output limit or the loaded context
// window was too small for the input. Callers can retry with less material.
export class TooLongError extends Error {}

function parse({ text, cut }, who) {
  if (cut) throw new TooLongError(`${who} ran out of room before finishing its answer.`);
  try { return JSON.parse(text); }
  catch {
    // Cut-off JSON (a context overflow can end a reply without saying so).
    if (/^\s*[{[]/.test(text)) throw new TooLongError(`${who} returned an incomplete answer.`);
    throw new Error(`${who} did not answer in the expected format.`);
  }
}

// ---- Claude --------------------------------------------------------------------
let claude = null, claudeKey = null;
function claudeClient(key) {
  if (!claude || claudeKey !== key) { claude = new Anthropic({ apiKey: key, maxRetries: 2 }); claudeKey = key; }
  return claude;
}
// On these models a policy decline is re-run on a fallback model inside the
// same call rather than failing the triage.
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

async function claudeCall(params) {
  const client = claudeClient(keyFor('anthropic'));
  let res;
  try {
    res = FALLBACK_MODELS.has(params.model)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key. Check it in Settings.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('That Claude API key is not allowed to use ' + params.model + '.');
    if (e instanceof Anthropic.NotFoundError) throw new Error('Claude model not found: ' + params.model);
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit reached. Try again shortly.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach Claude. Check the internet connection.');
    if (e instanceof Anthropic.APIError) throw new Error(`Claude ${e.status ?? ''}: ${e.message}`.slice(0, 240));
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to process this message.');
  return { text: res.content.filter(b => b.type === 'text').map(b => b.text).join(''), cut: res.stop_reason === 'max_tokens' };
}

// ---- OpenAI-compatible (LM Studio, OpenAI) ------------------------------------------
async function openaiCall(p, body) {
  const local = p === 'lmstudio';
  const base = local ? trim(settings.get('triage.lmStudioUrl')) : OPENAI_URL;
  const headers = { 'Content-Type': 'application/json' };
  if (!local) headers.Authorization = 'Bearer ' + keyFor('openai');
  const res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 200);
    if (!local && res.status === 401) throw new Error('OpenAI rejected the API key. Check it in Settings.');
    throw new Error(`${LABEL[p]} ${res.status}: ${t}`);
  }
  const choice = (await res.json()).choices?.[0] ?? {};
  const m = choice.message ?? {}, cut = choice.finish_reason === 'length';
  // Local reasoning models (Gemma-4 in LM Studio) can spend the whole budget
  // on reasoning_content; fall back to it rather than returning nothing.
  const out = (m.content ?? '').trim();
  if (out || !local) return { text: out, cut };
  const think = (m.reasoning_content ?? '').trim();
  return { text: think ? `(unfinished) ${think.slice(-400)}` : '', cut };
}

// ---- Ollama (native API: JSON-schema output and images are first-class) ---------------
async function ollamaCall(body) {
  const res = await fetch(trim(settings.get('ai.ollamaUrl')) + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stream: false, ...body }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const m = j.message ?? {}, cut = j.done_reason === 'length';
  const out = (m.content ?? '').trim();
  if (out) return { text: out, cut };
  const think = (m.thinking ?? '').trim();
  return { text: think ? `(unfinished) ${think.slice(-400)}` : '', cut };
}

// ---- public -----------------------------------------------------------------------
// One structured completion. Returns the parsed object.
// `maxTokens` caps the answer; `ctx` asks Ollama for a context window that
// fits the input (its default is small). LM Studio's window is fixed when the
// model is loaded, so a too-long input there surfaces as a TooLongError.
export async function json({ system, user, schema, name, model, temperature = 0.2, maxTokens = 3000, ctx = 8192 }) {
  const p = provider();
  if (p === 'connector') throw new ConnectorModeError();
  model = need(model ?? textModel(p), p);
  if (p === 'claudecode') return claudecode.json({ system, user, schema, model });
  if (p === 'anthropic') {
    // Current Claude models reject sampling parameters; the schema does the work.
    return parse(await claudeCall({
      model, max_tokens: Math.max(4096, maxTokens), system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    }), 'Claude');
  }
  if (p === 'ollama') {
    return parse(await ollamaCall({
      model, format: schema, options: { temperature, num_predict: maxTokens, num_ctx: ctx },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }), 'Ollama');
  }
  const body = {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
  };
  if (p === 'lmstudio') Object.assign(body, { temperature, reasoning_effort: 'none', max_tokens: maxTokens });
  else body.max_completion_tokens = Math.max(4096, maxTokens);
  return parse(await openaiCall(p, body), LABEL[p]);
}

// A short text answer about one image ({ mime, buf }).
export async function vision({ prompt, image, model, maxTokens = 900 }) {
  const p = provider();
  if (p === 'connector') throw new ConnectorModeError();
  model = need(model ?? visionModel(p), p);
  if (p === 'claudecode') return claudecode.vision({ prompt, image, model });
  const b64 = image.buf.toString('base64');
  if (p === 'anthropic') {
    return (await claudeCall({
      model, max_tokens: Math.max(1024, maxTokens),
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: image.mime, data: b64 } },
        { type: 'text', text: prompt },
      ] }],
    })).text.trim();
  }
  if (p === 'ollama') {
    return (await ollamaCall({
      model, options: { temperature: 0.1, num_predict: maxTokens },
      messages: [{ role: 'user', content: prompt, images: [b64] }],
    })).text;
  }
  const content = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: `data:${image.mime};base64,${b64}` } },
  ];
  const body = { model, messages: [{ role: 'user', content }] };
  if (p === 'lmstudio') Object.assign(body, { temperature: 0.1, reasoning_effort: 'none', max_tokens: maxTokens });
  else body.max_completion_tokens = maxTokens;
  return (await openaiCall(p, body)).text;
}

// The context window (tokens) a local model is running with, so long jobs can
// size their input. LM Studio reports what it has loaded; for Ollama it is what
// json() asks for. Null when unknown (the cloud models' windows are large).
export async function contextTokens(p = provider(), model = textModel(p), requested = 16384) {
  if (p === 'ollama') return requested;
  if (p !== 'lmstudio' || !model) return null;
  try {
    const base = trim(settings.get('triage.lmStudioUrl')).replace(/\/v1$/, '');
    const r = await fetch(`${base}/api/v0/models/${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(3000) });
    const j = r.ok ? await r.json() : null;
    return Number(j?.loaded_context_length) || null;
  } catch { return null; }
}

// Model list for the Settings pickers. `url` tries an unsaved local address;
// `key` checks a key before it is saved. Throws with a readable reason.
export async function listModels(p = provider(), { url, key } = {}) {
  const timeout = AbortSignal.timeout(6000);
  if (p === 'connector') return [];
  if (p === 'claudecode') return claudecode.MODELS;
  if (p === 'anthropic') {
    const client = new Anthropic({ apiKey: keyFor(p, key), maxRetries: 0, timeout: 6000 });
    const ids = [];
    try { for await (const m of client.models.list()) ids.push(m.id); }
    catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected that API key.');
      if (e instanceof Anthropic.APIConnectionError) throw new Error('Could not reach Claude.');
      throw new Error('Claude: ' + (e.message || e));
    }
    return ids;
  }
  if (p === 'openai') {
    const r = await fetch(OPENAI_URL + '/models', { headers: { Authorization: 'Bearer ' + keyFor(p, key) }, signal: timeout })
      .catch(() => { throw new Error('Could not reach OpenAI.'); });
    if (r.status === 401) throw new Error('OpenAI rejected that API key.');
    if (!r.ok) throw new Error('OpenAI ' + r.status);
    // Chat-capable families only; the raw list also has embeddings, audio, image models.
    return ((await r.json()).data ?? []).map(m => m.id)
      .filter(id => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id))
      .sort();
  }
  const base = trim(url || (p === 'ollama' ? settings.get('ai.ollamaUrl') : settings.get('triage.lmStudioUrl')));
  if (!settings.isLocalUrl(base)) throw new Error(`${LABEL[p]} must be on this PC or your local network.`);
  const r = await fetch(base + (p === 'ollama' ? '/api/tags' : '/models'), { signal: timeout })
    .catch(() => { throw new Error(`${LABEL[p]} not reachable at ${base}`); });
  if (!r.ok) throw new Error(`${LABEL[p]} ${r.status} at ${base}`);
  const j = await r.json();
  return p === 'ollama' ? (j.models ?? []).map(m => m.name).filter(Boolean) : (j.data ?? []).map(m => m.id).filter(Boolean);
}

// Save or remove a cloud API key. A new key is checked with the platform first.
export async function setKey(p, key) {
  if (!isCloud(p)) throw new Error('only cloud platforms take a key');
  const k = String(key ?? '').trim();
  if (!k) { secrets.set({ [KEY[p]]: '' }); return { ok: true, removed: true }; }
  const models = await listModels(p, { key: k });
  secrets.set({ [KEY[p]]: k });
  return { ok: true, models };
}

export const hasKey = (p) => !!secrets.get(KEY[p]);
