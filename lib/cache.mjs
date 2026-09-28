// Tiny in-memory cache with stale-while-revalidate.
//
// A hit returns immediately, even if stale; a stale hit also kicks off one
// background refresh. Concurrent misses share a single upstream request.
// Used for slow, read-mostly upstream data (call records take ~7s to fetch).
// Never use it for the live message pipeline — that must see new messages
// the moment they exist.
const entries = new Map();

function refresh(key, load) {
  const e = entries.get(key) ?? {};
  e.pending = Promise.resolve()
    .then(load)
    .then((value) => { e.value = value; e.at = Date.now(); e.pending = null; return value; },
          (err) => { e.pending = null; throw err; });
  entries.set(key, e);
  return e.pending;
}

// { wait: true } waits for the refresh when the value is stale (falling back
// to the stale value if it fails), for callers that must see recent data.
export function swr(key, ttlMs, load, { wait = false } = {}) {
  const e = entries.get(key);
  if (e && 'value' in e) {
    if (Date.now() - e.at > ttlMs) {
      const p = e.pending ?? refresh(key, load);
      p.catch(() => {});
      if (wait) return p.catch(() => e.value);
    }
    return Promise.resolve(e.value);
  }
  if (e?.pending) return e.pending;
  return refresh(key, load);
}

export function invalidate(prefix) {
  for (const k of entries.keys()) if (k.startsWith(prefix)) entries.delete(k);
}
