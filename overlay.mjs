// Mounts the triage dashboard as a floating panel inside the Ooma app window.
//
// Requires:
//   1. the Ooma app launched with --remote-debugging-port=9222
//   2. server.mjs already running (the panel embeds it in an iframe)
//
// Re-injects on navigation, because the BizApp is a SPA that swaps routes and
// would otherwise drop the panel.
//
//   node overlay.mjs           inject, then watch for navigation
//   node overlay.mjs --remove  take it back out
//
// SECURITY: this only works while the app runs with an open debug port. That
// port gives any local process full control of the app — reading your messages
// and sending as you. The standalone dashboard at http://127.0.0.1:8787 needs
// no debug port; prefer it unless you specifically want the in-app panel.
const PORT = Number(process.env.CDP_PORT ?? 9222);
const UI = process.env.UI_URL ?? 'http://127.0.0.1:8787/';
const REMOVE = process.argv.includes('--remove');
const NL = String.fromCharCode(10);

const PANEL = `(() => {
  const ID = 'ooma-triage-overlay';
  const old = document.getElementById(ID);
  if (old) old.remove();
  if (${REMOVE}) return 'removed';

  const wrap = document.createElement('div');
  wrap.id = ID;
  wrap.style.cssText = 'position:fixed;z-index:2147483647;right:18px;bottom:18px;font:13px system-ui,sans-serif';

  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;width:430px;height:560px;background:#171b21;' +
    'border:1px solid #2b323b;border-radius:12px;overflow:hidden;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.45);margin-bottom:10px';

  const frame = document.createElement('iframe');
  frame.src = '${UI}';
  frame.style.cssText = 'width:100%;height:100%;border:0';
  panel.appendChild(frame);

  const btn = document.createElement('button');
  btn.textContent = 'Triage';
  btn.style.cssText = 'float:right;background:#2f6df6;color:#fff;border:0;border-radius:999px;' +
    'padding:11px 18px;font:600 13px system-ui,sans-serif;cursor:pointer;' +
    'box-shadow:0 4px 14px rgba(0,0,0,.35)';
  btn.onclick = () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    btn.textContent = open ? 'Triage' : 'Hide';
    if (!open) frame.src = frame.src;   // refresh on open
  };

  wrap.appendChild(panel);
  wrap.appendChild(btn);
  document.body.appendChild(wrap);
  return 'injected';
})()`;

let list;
try {
  list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
} catch {
  console.error('No debug port on ' + PORT + '.');
  console.error('Launch the app with:  "…\\office-desktop-oe\\Ooma Enterprise.exe" --remote-debugging-port=' + PORT);
  process.exit(1);
}

const found = list.filter(t => /enterprise-app\.ooma\.com/.test(t.url ?? ''));
if (!found.length) {
  console.error('BizApp frame not found — is the Ooma app open and logged in?');
  process.exit(1);
}

for (const t of found) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

  ws.addEventListener('open', () => {
    send('Runtime.evaluate', { expression: PANEL, returnByValue: true });
    if (!REMOVE) send('Page.enable');
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }

    const v = m.result && m.result.result && m.result.result.value;
    if (v) console.log(v + ': ' + String(t.url).slice(0, 60));

    if (m.result && m.result.exceptionDetails)
      console.error('inject failed:', m.result.exceptionDetails.text);

    // SPA route changes wipe the panel; put it back.
    if (m.method === 'Page.frameNavigated' && m.params && m.params.frame && !m.params.frame.parentId) {
      setTimeout(() => send('Runtime.evaluate', { expression: PANEL, returnByValue: true }), 1200);
    }
  });

  ws.addEventListener('error', (e) => console.error('cdp error:', e.message || e));
}

if (!REMOVE) console.log(NL + 'Watching for navigation. Ctrl+C to stop (the panel stays until app reload).');
