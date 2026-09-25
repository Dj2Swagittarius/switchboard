// Switchboard connector for the Claude apps (Claude Desktop, Cowork, Claude
// Code): an MCP server over stdio that lets Claude triage Switchboard's
// waiting texts and write the daily recap, on the person's own Claude plan.
//
// It is a thin bridge: every tool is one call to the running Switchboard app
// on 127.0.0.1 (/api/connector/* in server.mjs), authorized with the token
// shown in Switchboard → Settings → Connect to Claude. Claude can read texts
// and save triage, reply drafts and recaps. Nothing here can send a text.
//
// No dependencies, so it runs from anywhere (inside a Claude Desktop bundle,
// or next to the installed app): MCP is JSON-RPC 2.0, one message per line.
//
// Env: SWITCHBOARD_TOKEN (required), SWITCHBOARD_URL (default
// http://127.0.0.1:8787).
import { createInterface } from 'node:readline';

const VERSION = '1.0.0';
const BASE = String(process.env.SWITCHBOARD_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = String(process.env.SWITCHBOARD_TOKEN || '');
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_IMAGES = 12;          // per list_pending call, across all messages
const NL = '\n';

class Problem extends Error {}

// ---- Switchboard -----------------------------------------------------------------
async function call(path, { method = 'GET', body, raw = false } = {}) {
  if (!TOKEN) throw new Problem('No Switchboard token is set. Reconnect from Switchboard → Settings → Connect to Claude.');
  let r;
  try {
    r = await fetch(BASE + '/api/connector/' + path, {
      method, headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180e3),
    });
  } catch {
    throw new Problem('Switchboard isn\'t running. Open it and try again.');
  }
  if (r.status === 401) throw new Problem('The Switchboard token changed. Reconnect from Switchboard → Settings → Connect to Claude.');
  if (raw && r.ok) return r;
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const errs = Array.isArray(j?.errors) && j.errors.length ? j.errors.join('; ') : (j?.error || `HTTP ${r.status}`);
    throw new Problem(errs);
  }
  return j;
}

// The schemas come from the running app so they always match it; without it
// the tools still list, with open objects.
let schemas = null;
async function loadSchemas() {
  if (schemas) return schemas;
  try { schemas = await call('instructions'); } catch { return null; }
  return schemas;
}

const pad = (n) => String(n).padStart(2, '0');
function yesterday() {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const text = (t) => ({ type: 'text', text: t });

// ---- tools -----------------------------------------------------------------------
async function tools() {
  const s = await loadSchemas();
  const triage = s?.triage?.schema ?? { type: 'object' };
  return [
    {
      name: 'list_pending',
      title: 'List texts waiting for triage',
      description: 'Texts that arrived in Switchboard and are waiting for triage, oldest first, with recent thread context, the sender\'s known role, any photos, and the triage instructions to follow. Triage each one and call save_triage for it.',
      inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many (default 10).' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'save_triage',
      title: 'Save triage for one text',
      description: 'Save your triage for one waiting text. suggested_reply is a DRAFT a person reviews in Switchboard before anything is sent; never say a reply was sent.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The message id from list_pending.' }, ...(triage.properties ?? {}) },
                     required: ['id', ...(triage.required ?? [])] },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    {
      name: 'get_thread',
      title: 'Read a text conversation',
      description: 'The last 50 messages with one phone number, oldest first. THEM = the other person, US = this business.',
      inputSchema: { type: 'object', properties: { with: { type: 'string', description: 'Their phone number.' } }, required: ['with'] },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_day',
      title: 'Get a day\'s activity for the recap',
      description: 'Everything for one finished day (texts, calls, voicemail transcripts) plus the recap instructions and answer format. Write the recap, then call save_recap.',
      inputSchema: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD, default yesterday.' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'save_recap',
      title: 'Save the daily recap',
      description: 'Save the recap for a day; it appears at the top of Switchboard\'s Insights page.',
      inputSchema: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                     recap: s?.recap?.schema ?? { type: 'object' } }, required: ['date', 'recap'] },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
  ];
}

async function listPending({ limit = 10 } = {}) {
  const [j, s] = [await call('pending?limit=' + encodeURIComponent(limit)), await loadSchemas()];
  const out = [];
  if (j.note) out.push(text(j.note));
  if (!j.items.length) return [...out, text('Nothing is waiting for triage.')];
  out.push(text(`${j.items.length} text${j.items.length === 1 ? '' : 's'} waiting for triage. Follow these instructions:` + NL + NL +
    (s?.triage?.instructions ?? '') + NL + NL + 'Then call save_triage once per message, with its id.'));
  let images = 0;
  for (const e of j.items) {
    out.push(text(JSON.stringify({ id: e.id, from: e.from, name: e.name || undefined, known_role: e.known_role,
      line: e.line, at: e.at, text: e.text, earlier_in_thread: e.history }, null, 1)));
    for (const m of e.media) {
      if (!m.image) { out.push(text(`[${e.id} attachment ${m.n + 1}: ${m.mime || 'file'}, not an image]`)); continue; }
      if (images >= MAX_IMAGES) { out.push(text(`[${e.id} photo ${m.n + 1}: not shown, too many photos in one call; ask for fewer messages]`)); continue; }
      try {
        const r = await call(`media?id=${encodeURIComponent(e.id)}&n=${m.n}`, { raw: true });
        out.push(text(`${e.id} photo ${m.n + 1}:`),
                 { type: 'image', data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: r.headers.get('content-type') || 'image/jpeg' });
        images++;
      } catch (err) { out.push(text(`[${e.id} photo ${m.n + 1} could not be fetched: ${err.message}]`)); }
    }
  }
  return out;
}

const RUN = {
  list_pending: listPending,
  async save_triage({ id, ...answer }) {
    if (!id) throw new Problem('id is required.');
    const j = await call('triage?id=' + encodeURIComponent(id), { method: 'POST', body: answer });
    return [text(`Saved. ${j.remaining} still waiting.`)];
  },
  async get_thread({ with: who }) {
    const j = await call('thread?with=' + encodeURIComponent(who ?? ''));
    return [text(j.messages.length ? j.messages.map(m => `${m.at} ${m.inbound ? 'THEM' : 'US'}: ${m.text}`).join(NL) : 'No messages with that number.')];
  },
  async get_day({ date } = {}) {
    const day = date || yesterday();
    const j = await call('day?date=' + day);
    if (j.empty) return [text(`Nothing came through on ${day}. Save a recap anyway only if asked.`)];
    return [text(`Recap instructions:${NL}${j.instructions}${NL}${NL}Answer format (JSON schema for save_recap's recap):${NL}` +
      JSON.stringify(j.schema) + NL + NL + `Stats: ${JSON.stringify(j.stats)}` +
      (j.errors?.length ? NL + 'Could not collect: ' + j.errors.join('; ') : '') + NL + NL + j.material)];
  },
  async save_recap({ date, recap }) {
    await call('recap?date=' + encodeURIComponent(date ?? ''), { method: 'POST', body: recap });
    return [text(`Recap for ${date} saved. It is on Switchboard's Insights page.`)];
  },
};

// ---- prompts -----------------------------------------------------------------------
const PROMPTS = [
  { name: 'triage-inbox', title: 'Triage my Switchboard inbox',
    description: 'Triage every text waiting in Switchboard and save a draft reply for each.' },
  { name: 'daily-recap', title: 'Write the Switchboard daily recap',
    description: 'Write the morning recap of a day\'s texts, calls and voicemail.',
    arguments: [{ name: 'date', description: 'YYYY-MM-DD, default yesterday', required: false }] },
];

function prompt(name, args = {}) {
  if (name === 'triage-inbox') {
    return { description: PROMPTS[0].description, messages: [{ role: 'user', content: text(
      'Triage my Switchboard inbox. Call list_pending, triage each message by the instructions it returns, ' +
      'and call save_triage for every message. Replies are drafts only: never say anything was sent. ' +
      'Repeat list_pending until nothing is waiting, then tell me briefly what needs me first.') }] };
  }
  if (name === 'daily-recap') {
    const day = args.date || 'yesterday';
    return { description: PROMPTS[1].description, messages: [{ role: 'user', content: text(
      `Write my Switchboard daily recap for ${day}. Call get_day${args.date ? ` with date ${args.date}` : ''}, ` +
      'write the recap exactly as its instructions and format say, call save_recap, then give me the headline and the follow-ups.') }] };
  }
  return null;
}

// ---- JSON-RPC over stdio -------------------------------------------------------------
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + NL);

async function handle(req) {
  const { id, method, params = {} } = req;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'switchboard', title: 'Switchboard', version: VERSION },
          instructions: 'Switchboard is this business\'s phone and texting app. Use list_pending and save_triage to triage waiting texts, ' +
            'get_day and save_recap for the daily recap. Replies you write are drafts a person reviews; you cannot send texts.',
        };
        break;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: await tools() }; break;
      case 'tools/call': {
        const run = RUN[params.name];
        if (!run) { result = { content: [text('Unknown tool: ' + params.name)], isError: true }; break; }
        try { result = { content: await run(params.arguments ?? {}) }; }
        catch (e) { result = { content: [text(e instanceof Problem ? e.message : 'Error: ' + e.message)], isError: true }; }
        break;
      }
      case 'prompts/list': result = { prompts: PROMPTS }; break;
      case 'prompts/get': {
        const p = prompt(params.name, params.arguments);
        if (!p) { if (isRequest) send({ id, error: { code: -32602, message: 'Unknown prompt: ' + params.name } }); return; }
        result = p;
        break;
      }
      default:
        if (method?.startsWith('notifications/') || !isRequest) return;
        send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
        return;
    }
    if (isRequest) send({ id, result });
  } catch (e) {
    if (isRequest) send({ id, error: { code: -32603, message: e.message } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
});
