// Resolves ONLY this user's oomamsg boxes.
//
// /websockets returns live sessions for the whole tenant, so a naive sweep
// would subscribe to colleagues' message boxes. We identify our own session
// by its MWI binding (ooma_mwi.mailbox.<our presence_id>) and take boxes from
// that session alone, then pin the result to disk so later runs never depend
// on tenant-wide enumeration.
import { api } from './kazoo.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dataPath } from './paths.mjs';

const FILE = dataPath('boxes.json');

export async function resolveMyBoxes(session, { refresh = false } = {}) {
  if (!refresh && existsSync(FILE)) {
    const c = JSON.parse(readFileSync(FILE, 'utf8'));
    if (c.owner_id === session.owner_id && c.boxes?.length) return c;
  }

  const me = (await api(session, `/users/${session.owner_id}`)).body?.data;
  if (!me?.presence_id) throw new Error('Could not read my presence_id');
  const mine = `ooma_mwi.mailbox.${me.presence_id}`;

  const sessions = (await api(session, '/websockets')).body?.data ?? [];
  const boxes = new Set();
  let matched = 0;
  for (const s of sessions) {
    const b = s.bindings ?? [];
    if (!b.includes(mine)) continue;          // not us — skip entirely
    matched++;
    for (const x of b) if (x.startsWith('oomamsg.')) boxes.add(x);
  }

  if (!boxes.size)
    throw new Error(
      `No boxes found for extension ${me.presence_id}. Open the Ooma desktop client so it registers, then rerun with --refresh.`);

  const out = {
    owner_id: session.owner_id,
    presence_id: me.presence_id,
    phone_number: me.phone_number,
    boxes: [...boxes],
    matched_sessions: matched,
    skipped_sessions: sessions.length - matched,
    resolved_at: new Date().toISOString(),
  };
  writeFileSync(FILE, JSON.stringify(out, null, 2));
  return out;
}
