// Outbound SMS. Dry-run unless explicitly told to transmit.
//
// The send endpoint is UNSCOPED: POST https://<host>:8443/v2/messaging
// NOT /v2/accounts/{account_id}/messaging. GET works on the account-scoped
// path, POST does not — it returns 500 "init failed" for every payload, which
// looks exactly like a malformed body and is not one. Captured from the real
// client via CDP; do not "fix" this back to the scoped path.
import { api } from './kazoo.mjs';
import { derived } from './profile.mjs';

// postedBy is the SIP identity: <extension>@<account realm>.
export async function resolvePostedBy(session) {
  if (session._postedBy) return session._postedBy;
  const me = (await api(session, `/users/${session.owner_id}`)).body?.data;
  const acct = (await api(session, '')).body?.data;
  if (!me?.presence_id || !acct?.realm) throw new Error('could not resolve postedBy (presence_id / realm)');
  session._postedBy = `${me.presence_id}@${acct.realm}`;
  return session._postedBy;
}

// A picture message carries the ids from uploadMedia() in `media`. Like the
// official client, `text` is left out (not sent empty) when there is none, and
// a retry of the same message keeps its clientMsgId.
export function buildBody({ to, text, localNumber, postedBy, media = [], clientMsgId = null }) {
  const data = {};
  if (text) data.text = text;
  if (media.length) data.media = [...media];
  Object.assign(data, {
    localNumber,
    remoteNumber: Array.isArray(to) ? to : [to],
    from: localNumber,
    postedBy,
    clientMsgId: clientMsgId || crypto.randomUUID(),
    createdTs: Date.now(),
  });
  return { data };
}

export async function sendMessage(session, { to, text, localNumber, media = [], clientMsgId = null, dryRun = true }) {
  if (!to || (!text?.trim() && !media.length)) throw new Error('send needs a recipient and text or an attachment');
  if (!localNumber) throw new Error('send needs a localNumber — see lines.json');
  // Read per send, so a change on the Account page applies straight away.
  const base = derived().messagingServer;
  if (!base) throw new Error('No messaging server is set.');

  const postedBy = await resolvePostedBy(session);
  const url = `${base}/v2/messaging`;
  const body = buildBody({ to, text, localNumber, postedBy, media, clientMsgId });

  if (dryRun) return { dryRun: true, path: url, body, status: null };

  // No timeout here: the platform answers only after handing the message to the
  // carrier, and giving up early could lead to it being sent twice.
  const r = await api(session, url, { method: 'POST', body: JSON.stringify(body) });
  return { dryRun: false, path: url, body, status: r.status, ok: r.ok, response: r.body };
}

// ---- MMS attachments ----------------------------------------------------------
// Uploaded the way the official client does it (CDP capture of a real send,
// plus its web app's code):
//   1. PUT  {msg}/v2/messaging/ooma_media
//        {data:{postedBy, localNumber, media:{extension, mime_type, size}, thumbnail?}}
//        -> 201 {data:{media_id}}
//   2. POST {msg}/v2/messaging/ooma_media/{id}?localNumber=+1...        the file's bytes
//   3. POST {msg}/v2/messaging/ooma_media/{id}/thumb?localNumber=+1...  PNG thumbnail bytes
// 2 and 3 run together once 1 has answered; the message itself (sendMessage
// with media: [ids]) goes only after both succeed. Quirks copied on purpose,
// as the proven path: localNumber goes into the query unencoded ('+'), the
// thumbnail POST is labelled with the FILE's type though it carries a PNG,
// and thumbnail.size is the data URL's base64 length (no '=') x 0.75.
// Uploads go to the messaging server; the media server is only read from.
export const MMS_MAX_BYTES = 2e6;   // per file: the official client's default limit (checked with >)
export const MMS_MAX_FILES = 10;
// Type -> extensions the platform takes. The official client requires both the
// type and the extension to be on its list; this is its stricter list.
export const MMS_TYPES = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/pjpeg': ['.jpg', '.jpeg', '.pjpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'video/mp4': ['.mp4', '.m4v'],
  'audio/wav': ['.wav'],
  'audio/ogg': ['.oga'],
  'application/pdf': ['.pdf'],
};
const MEDIA_ID = /^[A-Za-z0-9_-]{8,80}$/;

export async function uploadMedia(session, { localNumber, type, extension, data, thumb = null, dryRun = true }) {
  if (!/^\+\d{8,15}$/.test(localNumber ?? '')) throw new Error('upload needs an E.164 localNumber');
  if (!MMS_TYPES[type]?.includes(extension)) throw new Error('that kind of file can’t be sent by text');
  if (!Buffer.isBuffer(data) || !data.length) throw new Error('the file is empty');
  if (data.length > MMS_MAX_BYTES) throw new Error('the file is over 2 MB');
  const base = derived().messagingServer;
  if (!base) throw new Error('No messaging server is set.');

  const postedBy = await resolvePostedBy(session);
  const root = `${base}/v2/messaging/ooma_media`;
  const meta = { postedBy, localNumber, media: { extension, mime_type: type, size: data.length } };
  let png = null;
  if (thumb) {
    const b64 = thumb.slice(thumb.indexOf(',') + 1);
    png = Buffer.from(b64, 'base64');
    meta.thumbnail = { extension: '.png', mime_type: 'image/png', size: b64.replace(/=/g, '').length * 0.75, url: thumb };
  }
  if (dryRun) return { dryRun: true, path: root, meta: { ...meta, thumbnail: meta.thumbnail && { ...meta.thumbnail, url: '<data url>' } } };

  const signal = () => AbortSignal.timeout(90e3);
  const put = await api(session, root, { method: 'PUT', body: JSON.stringify({ data: meta }), signal: signal() });
  const id = put.body?.data?.media_id;
  if (!put.ok || !MEDIA_ID.test(String(id ?? ''))) throw new Error(`attachment upload failed (HTTP ${put.status})`);

  const q = `?localNumber=${localNumber}`;
  const post = (path, body) => api(session, `${root}/${id}${path}${q}`,
    { method: 'POST', body, headers: { 'Content-Type': type }, signal: signal() });
  const [file, th] = await Promise.all([post('', data), png ? post('/thumb', png) : null]);
  if (!file.ok) throw new Error(`attachment upload failed (HTTP ${file.status})`);
  if (th && !th.ok) throw new Error(`attachment preview upload failed (HTTP ${th.status})`);
  return { dryRun: false, id };
}

// ---- deleting -----------------------------------------------------------------
// As the official client does it (its web app's code):
//   one attachment:  DELETE {msg}/v2/messaging/ooma_media/{mediaId}?localNumber={messageId}
//                    (sic: it puts the MESSAGE id in localNumber; copied as the proven path)
//   whole messages:  DELETE {msg}/v2/messaging  {data:{msgId:[ids], localNumber, updatedBy}}
// It removes them from the account's copy of the conversation; what the other
// phone received stays there.
export async function deleteAttachment(session, { mediaId, messageId }) {
  if (!MEDIA_ID.test(String(mediaId ?? '')) || !MEDIA_ID.test(String(messageId ?? ''))) throw new Error('bad id');
  const base = derived().messagingServer;
  if (!base) throw new Error('No messaging server is set.');
  return api(session, `${base}/v2/messaging/ooma_media/${mediaId}?localNumber=${messageId}`, { method: 'DELETE' });
}

export async function deleteMessages(session, { ids, localNumber }) {
  if (!Array.isArray(ids) || !ids.length || !ids.every(id => MEDIA_ID.test(String(id)))) throw new Error('bad id');
  if (!/^\+\d{8,15}$/.test(localNumber ?? '')) throw new Error('bad localNumber');
  const base = derived().messagingServer;
  if (!base) throw new Error('No messaging server is set.');
  const updatedBy = await resolvePostedBy(session);
  return api(session, `${base}/v2/messaging`,
    { method: 'DELETE', body: JSON.stringify({ data: { msgId: ids, localNumber, updatedBy } }) });
}
