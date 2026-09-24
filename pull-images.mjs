// Downloads every image sent in a thread.
//   node pull-images.mjs <remoteNumber> [localNumber]
//
// Media auth goes in the X-Auth-Token header, never the URL. The API-echoed
// media URL has its token redacted on the way in, so the fetch URL is rebuilt
// from ooma_media_url.
import { loadSession, api } from './lib/kazoo.mjs';
import { primary } from './lib/lines.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NL = String.fromCharCode(10);
const remote = process.argv[2];
const local = process.argv[3] ?? primary();
if (!remote) { console.error('usage: node pull-images.mjs <+1number> [localNumber]'); process.exit(1); }

const s = loadSession();
const digits = (n) => String(n ?? '').replace(/\D/g, '');
const outDir = join('exports', digits(remote));
mkdirSync(outDir, { recursive: true });

// Page through the whole thread — the API caps a page and hands back start_key.
const msgs = [];
let startKey = null;
for (let page = 0; page < 40; page++) {
  const qs = new URLSearchParams({ localNumber: local, remoteNumber: remote, page_size: '200' });
  if (startKey) qs.set('start_key', startKey);
  const r = await api(s, `/messaging?${qs}`);
  const batch = r.body?.data;
  if (!Array.isArray(batch) || !batch.length) break;
  msgs.push(...batch);
  startKey = r.body?.next_start_key ?? null;
  if (!startKey) break;
}

// De-dupe: pagination can repeat a boundary row.
const seen = new Set();
const unique = msgs.filter(m => !seen.has(m.id) && seen.add(m.id));
unique.sort((a, b) => (a.createdTs ?? 0) - (b.createdTs ?? 0));

const ext = (mime) => ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
                         'image/webp': '.webp', 'image/heic': '.heic' }[mime] ?? '.bin');
const stamp = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);

const manifest = [];
let n = 0, failed = 0;

for (const m of unique) {
  for (const [i, item] of (m.media ?? []).entries()) {
    const mime = item.media?.mime_type ?? '';
    if (!mime.startsWith('image/')) continue;
    const url = `${item.ooma_media_url}/raw?localNumber=${encodeURIComponent(m.localNumber ?? local)}`;
    try {
      const res = await fetch(url, { headers: { 'X-Auth-Token': s.auth_token } });
      if (!res.ok) { failed++; console.error(`  FAILED ${m.id} (HTTP ${res.status})`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const name = `${stamp(m.createdTs)}_${m.direction}_${String(++n).padStart(3, '0')}${ext(mime)}`;
      writeFileSync(join(outDir, name), buf);
      manifest.push({ file: name, at: new Date(m.createdTs).toISOString(),
                      direction: m.direction, bytes: buf.length, mime,
                      text: typeof m.text === 'string' ? m.text : '' });
      console.log(`  ${name}  ${(buf.length / 1024).toFixed(0)} KB  ${m.direction}`);
    } catch (e) { failed++; console.error(`  ERROR ${m.id}: ${e.message}`); }
  }
}

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
  remote, local, pulled_at: new Date().toISOString(),
  messages_scanned: unique.length, images: manifest.length, failed, items: manifest,
}, null, 2));

console.log(NL + `${manifest.length} image(s) from ${unique.length} messages -> ${outDir}`);
if (failed) console.log(`${failed} failed`);
