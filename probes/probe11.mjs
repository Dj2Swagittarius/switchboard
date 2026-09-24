import { loadSession, api } from '../lib/kazoo.mjs';
import { fetchMedia } from '../lib/media.mjs';
const s = loadSession();
const me = (await api(s, `/users/${s.owner_id}`)).body.data;
const all = (await api(s, `/messaging?localNumber=${encodeURIComponent(me.phone_number)}`)).body.data ?? [];
const { buf, mime } = await fetchMedia(s, all.find(x => x.media?.length).media[0], me.phone_number);

const res = await fetch('http://localhost:1234/v1/chat/completions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'google/gemma-4-12b', temperature: 0.1, max_tokens: 160,
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is in this photo? Be factual and brief.' },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }]}],
  }),
});
const j = await res.json();
console.log('HTTP', res.status);
console.log('finish_reason:', j.choices?.[0]?.finish_reason);
console.log('usage:', JSON.stringify(j.usage));
console.log('message:', JSON.stringify(j.choices?.[0]?.message)?.slice(0, 400));
if (j.error) console.log('error:', JSON.stringify(j.error).slice(0, 300));
