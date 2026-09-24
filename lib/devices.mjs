// Phone devices on the platform, so setup can give this app its phone without
// anyone typing SIP details: list the signed-in user's own devices, use one of
// them, or create one for this computer.
//
// Only devices owned by the signed-in user are ever listed or used, even when
// the login could see others (an admin). Passwords stay on this side: the page
// gets names and types, and the chosen login goes straight into encrypted
// storage.
//
// Created devices copy the settings of a WebRTC device known to work with this
// app on the platform: softphone, media.webrtc on, OPUS/PCMU/PCMA, password
// auth, invite_format "contact". They're owned by the user, so a call to the
// user rings them wherever the account's call routing rings "the user's
// phones". This install remembers the device it made (phone-device.json in the
// data folder) and reuses that one when set up again, rather than adding
// another; it never reuses a device just because of its name, which another
// computer or person could share.
//
// Caution: this changes the live company account. On 2026-09-24, right after
// the app made a device, the user's extension was found reset (number off its
// call route, older devices gone, text history empty); the cause was never
// proven. So the numbers on the user's call route are read before and after,
// and any that went missing are reported back (routeLost) so the user can act
// at once instead of finding out from missed calls.
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { api } from './kazoo.mjs';
import { dataPath } from './paths.mjs';

const ID = /^[0-9a-f]{32}$/i;
const MAX = 100;
const MARK = dataPath('phone-device.json');
export const deviceName = () => `Switchboard – ${hostname().slice(0, 40) || 'this computer'}`;

const readMark = () => { try { return JSON.parse(readFileSync(MARK, 'utf8')); } catch { return null; } };
const writeMark = (m) => { try { writeFileSync(MARK, JSON.stringify(m)); } catch {} };
const markFor = (session) => {
  const m = readMark();
  return m && m.account_id === session.account_id && m.owner_id === session.owner_id && ID.test(String(m.id)) ? m.id : null;
};

// Device calls give up after 30 s rather than leave setup spinning.
const call = (session, path, opts = {}) => api(session, path, { ...opts, signal: AbortSignal.timeout(30e3) });

function fail(r, what) {
  if (r.status === 401) return new Error('Your sign-in has expired or was turned down. Sign in again under Account login, then try this again.');
  if (r.status === 403) return new Error(`Your login isn’t allowed to ${what}. Ask whoever runs your phone system, or enter the SIP username and password yourself.`);
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

// The user's phones: {id, name, type, enabled, webrtc, ours, usable, reason},
// plus total when there are more than are listed.
export async function listMine(session) {
  const all = await mine(session);
  const list = all.slice(0, MAX), ours = markFor(session);
  const docs = new Array(list.length);
  for (let i = 0; i < list.length; i += 6)          // a few at a time
    await Promise.all(list.slice(i, i + 6).map(async (d, j) => { try { docs[i + j] = await doc(session, d.id); } catch {} }));
  const devices = list.map((d, i) => {
    const full = docs[i];
    const reason = full ? unusable(full) : '';
    return { id: d.id, name: String(d.name ?? ''), type: String(d.device_type ?? ''), enabled: d.enabled !== false,
      webrtc: full ? full.media?.webrtc === true : null, ours: d.id === ours, usable: !reason, reason };
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

const newPassword = () => randomBytes(18).toString('base64url');     // 24 characters

// The numbers on the call routes that ring this user, read-only; null if they
// can't be read. A route rings the user when its row names them (user_id or
// owner_id) or it answers their extension.
export async function routeNumbers(session) {
  try {
    const r = await call(session, '/callflows?page_size=500');
    if (!r.ok || !Array.isArray(r.body?.data)) return null;
    const me = (await call(session, `/users/${session.owner_id}`)).body?.data;
    const ext = me?.presence_id ? String(me.presence_id) : null;
    const rows = r.body.data.filter(c => c.user_id === session.owner_id || c.owner_id === session.owner_id ||
      (ext && (c.numbers ?? []).includes(ext)));
    return [...new Set(rows.flatMap(c => c.numbers ?? []).map(String))].sort();
  } catch { return null; }
}
const lost = (before, after) => before && after ? before.filter(n => !after.includes(n)) : [];

// A phone for this computer: the one this install made before (with a fresh
// password), else a new one. acceptCharges: the user agreed to a charge the
// platform asked about (HTTP 402). Answers its SIP login.
export async function createForThisComputer(session, { acceptCharges = false } = {}) {
  const devices = await mine(session);
  const password = newPassword();
  const before = await routeNumbers(session);
  const prev = devices.find(d => d.id === markFor(session));
  if (prev) {
    if (prev.enabled === false)
      throw new Error('The phone Switchboard made for this computer is turned off on your account. Ask whoever runs your phone system to turn it back on.');
    const r = await call(session, `/devices/${prev.id}`, { method: 'PATCH', body: JSON.stringify({ data: { sip: { password } } }) });
    if (!r.ok) throw fail(r, 'update your phone device');
    const username = r.body?.data?.sip?.username ?? prev.username;
    if (!username) throw new Error('The phone device came back without a SIP username.');
    return { username, password, id: prev.id, reused: true, name: prev.name, routeLost: lost(before, await routeNumbers(session)) };
  }
  // A name that isn't already one of this user's devices.
  const taken = new Set(devices.map(d => d.name));
  let name = deviceName();
  for (let i = 2; taken.has(name) && i < 100; i++) name = `${deviceName()} (${i})`;
  let username = 'sb' + randomBytes(7).toString('hex');             // 16 characters, unique in practice
  const body = { data: {
    name,
    device_type: 'softphone',
    owner_id: session.owner_id,
    enabled: true,
    // A desktop app comes and goes: no "device went offline" alert each time it closes.
    suppress_unregister_notifications: true,
    sip: { username, password, method: 'password', invite_format: 'contact', expire_seconds: 360 },
    media: {
      webrtc: true,
      peer_to_peer: 'auto',
      audio: { codecs: ['OPUS', 'PCMU', 'PCMA'] },
      video: { codecs: [] },
      encryption: { enforce_security: false, methods: [] },
    },
  } };
  if (acceptCharges) body.accept_charges = true;
  let r = await call(session, '/devices', { method: 'PUT', body: JSON.stringify(body) });
  // "SIP credentials already in use": a clash with some other login on the
  // account (or a hiccup reported the same way). Try a couple of new usernames.
  for (let i = 0; i < 2 && r.status === 400 && /unique|already in use/i.test(JSON.stringify(r.body ?? '')); i++) {
    body.data.sip.username = username = 'sb' + randomBytes(7).toString('hex');
    r = await call(session, '/devices', { method: 'PUT', body: JSON.stringify(body) });
  }
  if (r.status === 402) {
    const e = new Error(/billing/i.test(String(r.body?.message)) || /billing/i.test(String(r.body?.error))
      ? 'Your phone service won’t add a phone right now because of a billing problem on the account. Ask whoever runs your phone system.'
      : 'Your phone service says adding a phone to your account comes with a charge.');
    e.code = /billing/i.test(String(r.body?.message) + String(r.body?.error)) ? 'billing' : 'charges';
    throw e;
  }
  if (!r.ok) throw fail(r, 'create a phone device');
  const id = r.body?.data?.id;
  if (!ID.test(String(id ?? ''))) throw new Error('The phone device wasn’t created.');
  writeMark({ account_id: session.account_id, owner_id: session.owner_id, id });
  return { username, password, id, reused: false, name, routeLost: lost(before, await routeNumbers(session)) };
}
