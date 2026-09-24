// Phone devices on the platform, so setup can give this app its phone without
// anyone typing SIP details: list the signed-in user's own devices and use one
// of them. Read-only on the account: nothing is created or changed there.
// (Creating a device from the app was removed: on 2026-09-24 the user's
// extension was found reset right after the app made one.)
//
// Only devices owned by the signed-in user are ever listed or used, even when
// the login could see others (an admin). Passwords stay on this side: the page
// gets names and types, and the chosen login goes straight into encrypted
// storage.
import { api } from './kazoo.mjs';

const ID = /^[0-9a-f]{32}$/i;
const MAX = 100;

// Device calls give up after 30 s rather than leave setup spinning.
const call = (session, path) => api(session, path, { signal: AbortSignal.timeout(30e3) });

function fail(r, what) {
  if (r.status === 401) return new Error('Your sign-in has expired or was turned down. Sign in again under Account login, then try this again.');
  if (r.status === 403) return new Error(`Your login isn’t allowed to ${what}. Enter the SIP username and password yourself instead.`);
  return new Error(`Couldn’t ${what} (HTTP ${r.status}${r.body?.message ? ': ' + r.body.message : ''}).`);
}

// Why a device can't be this app's phone ('' if it can): calls to it go
// somewhere other than a registered SIP client, or it has no SIP login.
export function unusable(d) {
  const t = d.device_type;
  if (['cellphone', 'landline', 'smartphone', 'mobile'].includes(t) || d.call_forward?.enabled) return 'forwards to another number';
  if (t === 'sip_uri' || d.sip?.invite_format === 'route') return 'rings an outside SIP address';
  if (t === 'fax') return 'for faxes only';
  if (!d.sip?.username || !d.sip?.password) return 'has no username and password';
  return '';
}

async function mine(session) {
  const r = await call(session, `/devices?filter_owner_id=${encodeURIComponent(session.owner_id)}&page_size=${MAX + 1}`);
  if (!r.ok) throw fail(r, 'list your phone devices');
  return (r.body?.data ?? []).filter(d => ID.test(String(d.id)) && d.owner_id === session.owner_id);
}

async function doc(session, id) {
  if (!ID.test(String(id ?? ''))) throw new Error('bad device id');
  const r = await call(session, `/devices/${id}`);
  if (!r.ok) throw fail(r, 'read that phone device');
  const d = r.body?.data;
  if (!d || d.owner_id !== session.owner_id) throw new Error('That phone device isn’t yours.');
  return d;
}

// The user's phones: {id, name, type, enabled, webrtc, usable, reason}, plus
// total when there are more than are listed.
export async function listMine(session) {
  const all = await mine(session);
  const list = all.slice(0, MAX);
  const docs = new Array(list.length);
  for (let i = 0; i < list.length; i += 6)          // a few at a time
    await Promise.all(list.slice(i, i + 6).map(async (d, j) => { try { docs[i + j] = await doc(session, d.id); } catch {} }));
  const devices = list.map((d, i) => {
    const full = docs[i];
    const reason = full ? unusable(full) : '';
    return { id: d.id, name: String(d.name ?? ''), type: String(d.device_type ?? ''), enabled: d.enabled !== false,
      webrtc: full ? full.media?.webrtc === true : null, usable: !reason, reason };
  });
  return { devices, total: all.length > MAX ? `${MAX}+` : all.length };
}

// The SIP login of one of the user's own devices.
export async function useMine(session, id) {
  const d = await doc(session, id);
  if (d.enabled === false) throw new Error('That phone device is turned off on your account.');
  const why = unusable(d);
  if (why) throw new Error(`That phone device ${why}, so calls to you would never reach Switchboard.`);
  return { username: d.sip.username, password: d.sip.password, webrtc: d.media?.webrtc === true, name: d.name ?? '' };
}
