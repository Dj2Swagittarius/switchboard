import { loadSession, api } from '../lib/kazoo.mjs';
import { fetchMedia, describeImage } from '../lib/media.mjs';
const s = loadSession();
const me = (await api(s, `/users/${s.owner_id}`)).body.data;
const all = (await api(s, `/messaging?localNumber=${encodeURIComponent(me.phone_number)}`)).body.data ?? [];
const media = await fetchMedia(s, all.find(x => x.media?.length).media[0], me.phone_number);
console.log(`image: ${media.buf.length} bytes ${media.mime}\n`);
for (const model of ['google/gemma-4-12b', 'google/gemma-4-e4b']) {
  const t = Date.now();
  try { console.log(`--- ${model} (${Date.now() - t}ms placeholder) ---`);
        const d = await describeImage(media, { model });
        console.log(`  [${Date.now() - t}ms] ${d}\n`); }
  catch (e) { console.log(`  FAILED: ${e.message}\n`); }
}
