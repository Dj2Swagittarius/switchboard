// The Claude connector: in connector mode (Settings → AI platform → the Claude
// app) new texts wait in the queue as "awaiting triage" and the person's own
// Claude app (Desktop, Cowork, Claude Code) triages them through the
// Switchboard MCP server (mcp/switchboard-mcp.mjs), which calls the
// /api/connector/* routes in server.mjs with this token.
//
// Claude can read texts and save triage, drafts and recaps. It can't send
// anything: a person still presses Send.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as store from './store.mjs';
import * as secrets from './secrets.mjs';
import { TRIAGE_SCHEMA } from './llm.mjs';
import { validate } from './schema.mjs';
import { lookup } from './contacts.mjs';
import { zip } from './zip.mjs';

const KEY = 'connector.token';
export const AWAITING = 'awaiting_triage';
const MAX_PENDING = 50;

// Kept encrypted with the other secrets. Outside the desktop app (plain
// `node server.mjs`, tests) there is no secure storage, so the token comes
// from SWITCHBOARD_CONNECTOR_TOKEN or the connector is off.
export function token() {
  if (!secrets.available()) {
    const t = process.env.SWITCHBOARD_CONNECTOR_TOKEN;
    if (t) return t;
    throw new Error('The Claude connector only works in the desktop app.');
  }
  return secrets.get(KEY) || newToken();
}

export function newToken() {
  if (!secrets.available()) throw new Error('The Claude connector only works in the desktop app.');
  const t = randomBytes(32).toString('hex');
  secrets.set({ [KEY]: t });
  return t;
}

export function authorized(req) {
  let want;
  try { want = token(); } catch { return false; }
  const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// A queue entry for a text Claude hasn't triaged yet. Photos keep their media
// address (no token in it) so /api/connector/media can fetch them on demand.
export function entryFor(m, { history = [], contact = null, rawMedia = [] } = {}) {
  return {
    id: m.id, remote: m.remote, local: m.local, at: m.at, text: m.forModel(), name: contact?.name ?? '',
    status: AWAITING, known_role: contact?.role ?? 'unknown',
    history: history.map(h => ({ at: h.at, inbound: h.inbound, text: h.forModel() })),
    media: (rawMedia ?? []).map(r => ({ url: r.ooma_media_url ?? null, mime: r.media?.mime_type ?? '' })),
  };
}

export const isAwaiting = (e) => e?.status === AWAITING && !e.resolution;

// Oldest first, so a backlog is worked through in order.
export function pending(limit = 20) {
  const n = Math.max(1, Math.min(MAX_PENDING, Number(limit) || 20));
  return store.all().filter(isAwaiting).sort((a, b) => a.at - b.at).slice(0, n);
}

// Claude's answer for one text. Checked against the same schema inline triage
// uses; afterwards the entry is an ordinary triaged one. Saving twice keeps
// the later answer.
export function saveTriage(id, body) {
  const cur = store.all().find(e => e.id === id);
  if (!cur || cur.resolution) return { ok: false, code: 404, errors: ['No message with that id is waiting in the queue.'] };
  const errors = validate(TRIAGE_SCHEMA, body);
  if (errors.length) return { ok: false, code: 400, errors };
  const role = lookup(cur.remote)?.role ?? cur.known_role;
  const answer = { ...body, ...(role && role !== 'unknown' ? { from_role: role } : {}) };
  if (!isAwaiting(cur)) console.log(`connector  triage for ${id} replaced`);
  const entry = store.update(id, { ...answer, status: undefined, history: undefined, media: undefined,
                                   known_role: undefined, triaged_by: 'connector', triaged_at: new Date().toISOString() });
  return { ok: true, entry };
}

// ---- Claude Desktop ----------------------------------------------------------------
// A Claude Desktop extension (.mcpb: a zip with manifest.json) holding the MCP
// script, run by Claude Desktop's built-in Node, with the address and token
// filled in. Opening the file starts Claude Desktop's install dialog.
const TOOLS = [
  ['list_pending', 'List texts waiting for triage'], ['save_triage', 'Save triage and a draft reply'],
  ['get_thread', 'Read a conversation'], ['get_day', "Get a day's activity"], ['save_recap', 'Save the daily recap'],
];
export function desktopBundle({ url, version, script }) {
  const manifest = {
    manifest_version: '0.3', name: 'switchboard', display_name: 'Switchboard', version,
    description: 'Triage your Switchboard texts and write the daily recap with Claude. Replies are drafts; Claude cannot send texts.',
    author: { name: 'Switchboard' },
    server: { type: 'node', entry_point: 'server/switchboard-mcp.mjs', mcp_config: {
      command: 'node', args: ['${__dirname}/server/switchboard-mcp.mjs'],
      env: { SWITCHBOARD_URL: url, SWITCHBOARD_TOKEN: token() } } },
    tools: TOOLS.map(([name, description]) => ({ name, description })),
    prompts: [{ name: 'triage-inbox', description: 'Triage my Switchboard inbox', text: 'Triage my Switchboard inbox.' },
              { name: 'daily-recap', description: 'Write the Switchboard daily recap', text: 'Write my Switchboard daily recap.' }],
    compatibility: { platforms: ['win32', 'darwin', 'linux'] },
  };
  return zip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'server/switchboard-mcp.mjs', data: script },
  ]);
}
