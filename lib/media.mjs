// Fetches MMS attachments and describes them with the chosen AI platform's
// vision model (lib/ai.mjs).
// Auth goes in the X-Auth-Token header, never the URL, so tokens stay out of
// logs. The URL is rebuilt from ooma_media_url because the API-echoed one has
// its token redacted on the way in.
import * as ai from './ai.mjs';
// On LM Studio: gemma-4-e4b with reasoning disabled: 3s/image vs 54s with
// reasoning on, and llava-llama-3-8b writes florid captions that are useless
// for triage.
export const visionModel = () => ai.visionModel();

const MAX_BYTES = 6 * 1024 * 1024;

export async function fetchMedia(session, item, localNumber, { thumbnail = false } = {}) {
  if (!item?.ooma_media_url) return null;
  const url = `${item.ooma_media_url}/${thumbnail ? 'thumbnail' : 'raw'}`
    + `?localNumber=${encodeURIComponent(localNumber)}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': session.auth_token } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  return { buf, mime: res.headers.get('content-type') ?? item.media?.mime_type ?? 'image/jpeg' };
}

const PROMPT = `Describe this photo in one or two factual sentences, for a
field-service dispatcher triaging a text message. Say what equipment, damage,
readings, or paperwork is visible. If text or numbers are legible, quote them.
Do not speculate about what should be done. If the image is unclear, say so.`;

export async function describeImage({ buf, mime }, { model = visionModel() } = {}) {
  return ai.vision({
    model, prompt: PROMPT, image: { buf, mime },
    maxTokens: Number(process.env.VISION_MAX_TOKENS ?? 900),
  });
}

// Attaches `descriptions` to a normalized message so forModel() can use them.
export async function enrich(session, msg, rawMedia) {
  msg.descriptions = [];
  for (const item of rawMedia ?? []) {
    const mime = item.media?.mime_type ?? '';
    if (!mime.startsWith('image/')) { msg.descriptions.push(`[${mime || 'attachment'} — not an image]`); continue; }
    try {
      const media = await fetchMedia(session, item, msg.local);
      msg.descriptions.push(media ? await describeImage(media) : '[image could not be fetched]');
    } catch (e) {
      msg.descriptions.push(`[image description failed: ${e.message.slice(0, 60)}]`);
    }
  }
  return msg;
}
