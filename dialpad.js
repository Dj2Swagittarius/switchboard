// Shared dial pad. Include with <script src="/dialpad.js"></script> on any page.
//
// Adds a "Make a call" button to the page header and a keypad dialog.
// When the app's own phone is connected, the call is placed in-app (the phone
// window, over a same-origin BroadcastChannel). Otherwise it falls back to a
// tel: link, which Windows routes to the default phone app.
(() => {
  const css = `
  .dp-btn{font:inherit;font-weight:600;border:1px solid var(--accent,#2f6df6);background:var(--accent,#2f6df6);
    color:#fff;padding:6px 12px;border-radius:7px;cursor:pointer;white-space:nowrap}
  .dp-scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;
    justify-content:center;z-index:1000}
  .dp-scrim.open{display:flex}
  .dp{width:320px;max-width:calc(100vw - 32px);background:var(--panel,#171b21);color:var(--ink,#e6e9ee);
    border:1px solid var(--line,#252b33);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.45);
    padding:16px;font:14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .dp-top{display:flex;align-items:center;margin-bottom:10px}
  .dp-top b{flex:1;font-size:15px}
  .dp-x{border:0;background:none;color:var(--muted,#8b95a1);font-size:20px;cursor:pointer;padding:0 4px}
  .dp-num{width:100%;font:600 22px/1.2 ui-sans-serif,system-ui,sans-serif;text-align:center;letter-spacing:.02em;
    padding:10px 8px;border:1px solid var(--line,#252b33);border-radius:9px;background:var(--bg,#0f1216);
    color:var(--ink,#e6e9ee);font-variant-numeric:tabular-nums}
  .dp-num:focus{outline:2px solid var(--accent,#2f6df6);outline-offset:-1px}
  .dp-who{min-height:18px;text-align:center;font-size:12px;color:var(--muted,#8b95a1);margin:6px 0 8px}
  .dp-sug{display:grid;gap:4px;margin-bottom:8px;max-height:120px;overflow:auto}
  .dp-sug button{display:flex;justify-content:space-between;gap:8px;text-align:left;font:inherit;font-size:13px;
    border:1px solid var(--line,#252b33);background:var(--bg,#0f1216);color:var(--ink,#e6e9ee);
    padding:6px 9px;border-radius:7px;cursor:pointer}
  .dp-sug button:hover{border-color:var(--accent,#2f6df6)}
  .dp-sug span{color:var(--muted,#8b95a1);font-variant-numeric:tabular-nums}
  .dp-keys{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .dp-keys button{height:54px;border-radius:12px;border:1px solid var(--line,#252b33);background:var(--bg,#0f1216);
    color:var(--ink,#e6e9ee);cursor:pointer;font:600 20px/1 ui-sans-serif,system-ui,sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}
  .dp-keys button:hover{border-color:var(--accent,#2f6df6)}
  .dp-keys small{font:600 9px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;color:var(--muted,#8b95a1)}
  .dp-row{display:flex;gap:8px;margin-top:10px}
  .dp-call{flex:1;height:46px;border-radius:12px;border:0;background:#1a7f37;color:#fff;
    font:600 15px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
  .dp-call:disabled{opacity:.45;cursor:not-allowed}
  .dp-del{width:60px;border-radius:12px;border:1px solid var(--line,#252b33);background:var(--bg,#0f1216);
    color:var(--ink,#e6e9ee);font-size:18px;cursor:pointer}
  .dp-note{font-size:11px;color:var(--muted,#8b95a1);text-align:center;margin-top:10px}`;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const pretty = (n) => {
    const d = digits(n).slice(-10);
    return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(n || '');
  };

  // Turn what was typed into a dialable tel: URL, or null if it isn't one.
  function telFor(raw) {
    const s = String(raw || '').replace(/[^\d*#+]/g, '');
    const d = digits(s);
    if (/[*#]/.test(s)) return s.length >= 2 ? 'tel:' + s.replace(/#/g, '%23') : null;  // feature codes
    if (d.length === 10) return 'tel:+1' + d;
    if (d.length === 11 && d[0] === '1') return 'tel:+' + d;
    if (d.length > 11 && d.length <= 15) return 'tel:+' + d;
    if (d.length >= 2 && d.length <= 6) return 'tel:' + d;                                // extensions
    return null;
  }

  // ---- dialog ---------------------------------------------------------------
  const scrim = el('div', 'dp-scrim');
  const box = el('div', 'dp');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Dial pad');
  const top = el('div', 'dp-top');
  top.appendChild(el('b', '', 'Make a call'));
  const x = el('button', 'dp-x', '×');
  x.title = 'Close';
  top.appendChild(x);
  const num = el('input', 'dp-num');
  num.placeholder = 'Number or extension';
  num.inputMode = 'tel';
  num.autocomplete = 'off';
  const who = el('div', 'dp-who');
  const sug = el('div', 'dp-sug');
  const keys = el('div', 'dp-keys');
  const LET = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' };
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']) {
    const b = el('button');
    b.type = 'button';
    b.appendChild(document.createTextNode(k));
    if (LET[k]) b.appendChild(el('small', '', LET[k]));
    b.onclick = () => { num.value += k; update(); num.focus(); };
    keys.appendChild(b);
  }
  const row = el('div', 'dp-row');
  const call = el('button', 'dp-call', 'Call');
  const del = el('button', 'dp-del', '⌫');
  del.title = 'Delete';
  row.append(call, del);
  const note = el('div', 'dp-note', 'Hands the call to your default phone app.');
  box.append(top, num, who, sug, keys, row, note);
  scrim.appendChild(box);
  document.body.appendChild(scrim);

  // In-app phone status, reported by the phone window.
  const chan = ('BroadcastChannel' in window) ? new BroadcastChannel('switchboard-phone') : null;
  let phoneReady = false;
  // Settings > Phone > "Use the in-app phone for Make a call".
  let preferApp = true;
  // The note says what Call will actually do (same test as dial()).
  const setNote = () => {
    note.textContent = (phoneReady && preferApp) ? 'Calls from this app.' : 'Hands the call to your default phone app.';
  };
  fetch('/api/settings').then(r => r.ok ? r.json() : null)
    .then(j => {
      if (!j?.settings?.phone) return;
      preferApp = j.settings.phone.preferApp !== false && j.settings.phone.enabled !== false;
      setNote();
    })
    .catch(() => {});
  if (chan) {
    chan.onmessage = (e) => {
      if (e.data?.type !== 'status') return;
      phoneReady = e.data.state === 'registered';
      heard?.();
      setNote();
    };
    chan.postMessage({ type: 'ping' });
  }

  let book = null;
  async function loadBook() {
    if (book) return book;
    try { book = (await (await fetch('/api/directory')).json()).contacts || []; }
    catch { book = []; }
    return book;
  }

  async function update() {
    const v = num.value;
    call.disabled = !telFor(v);
    const d = digits(v);
    const list = await loadBook();
    const match = list.find(c => d.length >= 10 && digits(c.number).endsWith(d.slice(-10)));
    who.textContent = match ? (match.name || match.suggestedName || '') : (d.length >= 10 ? pretty(v) : '');

    sug.textContent = '';
    const q = v.trim().toLowerCase();
    if (!q) return;
    const hits = list.filter(c => {
      const name = (c.name || c.suggestedName || '').toLowerCase();
      return (d.length >= 3 && digits(c.number).includes(d)) || (/[a-z]/.test(q) && name.includes(q));
    }).slice(0, 5);
    for (const c of hits) {
      const b = el('button');
      b.type = 'button';
      b.appendChild(document.createTextNode(c.name || c.suggestedName || 'Unnamed'));
      b.appendChild(el('span', '', pretty(c.number)));
      b.onclick = () => { num.value = c.number; update(); num.focus(); };
      sug.appendChild(b);
    }
  }

  // With the in-app phone connected, "Make a call" opens the phone overlay
  // (prefilled) instead of this dialog. Status arrives a moment after load, so
  // wait briefly for it before deciding.
  let heard = null;
  const statusSeen = new Promise((r) => { heard = r; });
  async function open(prefill) {
    if (chan) {
      chan.postMessage({ type: 'ping' });
      await Promise.race([statusSeen, new Promise((r) => setTimeout(r, 400))]);
      if (phoneReady && preferApp) { chan.postMessage({ type: 'open', number: prefill ?? '' }); return; }
    }
    openDialog(prefill);
  }
  function openDialog(prefill) {
    if (prefill != null) num.value = prefill;
    scrim.classList.add('open');
    update();
    setTimeout(() => num.focus(), 0);
  }
  function close() { scrim.classList.remove('open'); }
  function dial() {
    const t = telFor(num.value);
    if (!t) return;
    if (phoneReady && preferApp && chan) chan.postMessage({ type: 'dial', number: num.value });
    else location.href = t;  // Electron routes tel: to the OS; browsers do natively
    close();
  }

  num.oninput = update;
  num.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dial(); }
    if (e.key === 'Escape') close();
  };
  call.onclick = dial;
  del.onclick = () => { num.value = num.value.slice(0, -1); update(); num.focus(); };
  x.onclick = close;
  scrim.onclick = (e) => { if (e.target === scrim) close(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && scrim.classList.contains('open')) close(); });

  // One-click call (Contacts): straight out through the in-app phone when it's
  // up, otherwise the handoff to the OS phone app.
  async function callNow(number) {
    const t = telFor(number);
    if (!t) return open(number);
    if (chan) {
      chan.postMessage({ type: 'ping' });
      await Promise.race([statusSeen, new Promise((r) => setTimeout(r, 400))]);
      if (phoneReady && preferApp) { chan.postMessage({ type: 'dial', number: String(number) }); return; }
    }
    location.href = t;
  }

  window.switchboardDial = open;
  window.switchboardCall = callNow;
  if (location.hash === '#dial') open();
})();
