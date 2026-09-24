// Index of every photo across all conversations on enabled lines.
//
// The API has no "list all media" call, so the index is built by reading each
// thread (a handful at a time) and cached with stale-while-revalidate.
import { conversations, thread } from './messaging.mjs';
import { swr } from './cache.mjs';

// Run fn over items with at most n in flight; failures become null.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export function photoIndex(session) {
  return swr('photos:' + session.owner_id, 120e3, async () => {
    const convs = await conversations(session);
    const threads = await pool(convs, 6, async (c) =>
      ({ c, msgs: await thread(session, { line: c.line, remote: c.remote }) }));

    const out = [];
    for (const t of threads) {
      if (!t) continue;
      for (const m of t.msgs) {
        m.media.forEach((md, i) => {
          if (!md.mime.startsWith('image/')) return;
          out.push({
            id: md.id, mime: md.mime, msg: m.id,
            line: t.c.line, remote: t.c.remote, name: t.c.name,
            at: m.at, inbound: m.inbound, text: m.text, part: i,
          });
        });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  });
}

const EXT = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
              'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };
const pad = (n, w = 2) => String(n).padStart(w, '0');

// 2026-09-23_12-15-06_Nick_Smith_IN.jpg — sorts chronologically, says who.
export function fileName(p, seq = null) {
  const d = new Date(p.at);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
                `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const who = String(p.name || p.remote || 'unknown')
    .replace(/[^A-Za-z0-9+]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'unknown';
  const n = seq == null ? (p.part ? '_' + (p.part + 1) : '') : '_' + pad(seq, 3);
  return `${stamp}_${who}_${p.inbound ? 'IN' : 'OUT'}${n}${EXT[p.mime] ?? '.jpg'}`;
}
