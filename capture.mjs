// Captures the real send request from the running Ooma client via Chrome
// DevTools Protocol. Requires the app started with --remote-debugging-port=9222.
//
// Read-only observation: it enables the Network domain and prints matching
// requests with their bodies and responses. It never injects, clicks, or
// modifies the page. Tokens, signatures and passwords are redacted, and file
// contents inside uploads are shown only as their size.
//
//   node capture.mjs            watch sends/uploads to messaging or media URLs
//   node capture.mjs --all      every POST/PUT/PATCH, plus messaging reads
//
// Everything printed is also written to logs/capture-<time>.log.
import { mkdirSync, appendFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT ?? 9222);
const ALL = process.argv.includes('--all');
const NL = String.fromCharCode(10);

mkdirSync(new URL('./logs/', import.meta.url), { recursive: true });
const LOG = new URL(`./logs/capture-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, import.meta.url);
const out = (s = '') => { console.log(s); appendFileSync(LOG, s + NL); };

const red = (s) => typeof s !== 'string' ? s : s
  .replace(/([?&](?:auth_token|token|access_token|signature|x-amz-signature|x-amz-credential|x-amz-security-token|sig)=)[^&\s"']+/gi, '$1<redacted>')
  .replace(/("(?:auth_token|token|access_token|refresh_token|password|credentials|secret)"\s*:\s*")[^"]*"/gi, '$1<redacted>"');

// Long base64 / binary runs become a size note so a picture doesn't flood the log.
const squash = (s) => s
  .replace(/[A-Za-z0-9+/=]{400,}/g, (m) => `<base64 ${m.length} chars>`)
  .replace(/[^\x09\x0a\x0d\x20-\x7e]{16,}[\s\S]*?(?=\r?\n--|$)/g, (m) => `<binary ${m.length} bytes>`);

// raw: Buffer of the request body as sent.
function body(raw, contentType = '') {
  const b = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (!b) return red(squash(raw.toString('utf8'))).slice(0, 4000);
  // multipart: show each part's headers and a short look at its content.
  // latin1 keeps one char per byte, so sizes are exact and splitting is safe.
  return raw.toString('latin1').split('--' + b).filter(p => p.trim() && p.trim() !== '--').map((part, i) => {
    const [head, ...rest] = part.replace(/^\r?\n/, '').split(/\r?\n\r?\n/);
    const content = rest.join('\r\n\r\n').replace(/\r?\n$/, '');
    const binary = /filename=|content-type:\s*(image|video|audio|application\/octet)/i.test(head);
    const shown = binary ? `<file content ${content.length} bytes>`
      : red(squash(Buffer.from(content, 'latin1').toString('utf8'))).slice(0, 1500);
    return `   [part ${i + 1}]${NL}      ${head.split(/\r?\n/).join(NL + '      ')}${NL}      ${shown}`;
  }).join(NL);
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  .catch(() => { throw new Error(`No debug port on ${PORT}. Start the app with --remote-debugging-port=${PORT}`); });

const pages = targets.filter(t => ['page', 'iframe', 'webview'].includes(t.type));
out(`${pages.length} target(s):`);
for (const p of pages) out(`   ${(p.type + '        ').slice(0, 8)} ${red(p.url).slice(0, 90)}`);
out(NL + 'Watching. Send a message (or a picture) from the Ooma UI now. Ctrl+C to stop.');
out(`Log: ${decodeURIComponent(LOG.pathname).replace(/^\/([A-Za-z]:)/, '$1')}` + NL);

for (const target of pages) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const calls = new Map();
  const call = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    calls.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const pending = new Map();   // requestId -> { url, status, type }

  ws.addEventListener('open', () => call('Network.enable', { maxPostDataSize: 65536 }));

  ws.addEventListener('message', async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && calls.has(m.id)) { calls.get(m.id)(m); calls.delete(m.id); return; }

    if (m.method === 'Network.requestWillBeSent') {
      const r = m.params.request;
      const write = /^(POST|PUT|PATCH)$/.test(r.method);
      const interesting = ALL
        ? write || /messag|sms|mms/i.test(r.url)
        : write && /messag|sms|mms|media|upload|attach/i.test(r.url);
      if (!interesting) return;

      const reqId = m.params.requestId;
      pending.set(reqId, { url: r.url });
      const ct = Object.entries(r.headers ?? {}).find(([k]) => /^content-type$/i.test(k))?.[1] ?? '';
      const lines = ['='.repeat(70), `${new Date().toLocaleTimeString()}  ${r.method} ${red(r.url)}`];
      for (const [k, v] of Object.entries(r.headers ?? {})) {
        if (/^(cookie|authorization|x-auth-token)$/i.test(k)) lines.push(`   ${k}: <redacted>`);
        else lines.push(`   ${k}: ${red(String(v)).slice(0, 120)}`);
      }
      // Full body bytes: ask for them (uploads aren't inlined), else use what the event carried.
      let raw = null;
      if (r.hasPostData) {
        const got = (await call('Network.getRequestPostData', { requestId: reqId })).result;
        if (got?.postData != null) raw = Buffer.from(got.postData, got.base64Encoded ? 'base64' : 'utf8');
      }
      if (!raw && r.postDataEntries) raw = Buffer.concat(r.postDataEntries.map(e => Buffer.from(e.bytes ?? '', 'base64')));
      if (!raw && r.postData != null) raw = Buffer.from(r.postData, 'utf8');
      if (raw) lines.push(NL + '   BODY (' + raw.length + ' bytes):' + NL + '   ' + body(raw, ct));
      out(lines.join(NL) + NL);
    }

    if (m.method === 'Network.responseReceived' && pending.has(m.params.requestId)) {
      const p = pending.get(m.params.requestId);
      p.status = m.params.response.status; p.type = m.params.response.mimeType;
    }

    if ((m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') && pending.has(m.params.requestId)) {
      const p = pending.get(m.params.requestId);
      pending.delete(m.params.requestId);
      if (m.method === 'Network.loadingFailed') { out(`   -> FAILED (${m.params.errorText}) ${red(p.url).slice(0, 80)}` + NL); return; }
      let text = '';
      if (!/^(image|video|audio)\//.test(p.type ?? '')) {
        const r = (await call('Network.getResponseBody', { requestId: m.params.requestId })).result;
        if (r) text = r.base64Encoded ? `<${Math.round(r.body.length * 3 / 4)} bytes binary>` : red(squash(r.body)).slice(0, 2500);
      } else text = `<${p.type}>`;
      out(`   -> HTTP ${p.status} ${p.type ?? ''} for ${red(p.url).slice(0, 80)}${text ? NL + '   RESPONSE: ' + text : ''}` + NL);
    }
  });

  ws.addEventListener('error', (e) => console.error('cdp error:', e.message ?? e));
}
