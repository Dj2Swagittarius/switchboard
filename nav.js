// Shared left sidebar.
// Include in each page's <head> area: <script src="/nav.js"></script>
//
// The CSS goes in immediately (so the page never jumps sideways); the sidebar
// itself is built once the document has parsed and /api/profile has answered.
// The body padding hangs off a class on <html> so first-run setup, which has
// no sidebar, can drop it.
(() => {
  const W = 216;
  const css = `
  html.sb-pad body{padding-left:${W}px}
  .sb{position:fixed;left:0;top:0;bottom:0;width:${W}px;background:var(--panel,#171b21);
    border-right:1px solid var(--line,#252b33);display:flex;flex-direction:column;z-index:60;
    font:14px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .sb-brand{display:flex;align-items:center;gap:10px;padding:16px 18px 12px;font-weight:700;font-size:17px;
    color:var(--ink,#e6e9ee);letter-spacing:-.01em}
  .sb-logo{width:26px;height:26px;border-radius:50%;background:var(--accent,#5b8dff);position:relative;flex:none}
  .sb-logo::after{content:'';position:absolute;inset:9px;border-radius:50%;background:#fff}
  .sb-nav{flex:1;overflow:auto;padding:4px 10px}
  .sb-item{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:9px;margin:1px 0;
    color:var(--ink,#e6e9ee);text-decoration:none;position:relative}
  .sb-item:hover{background:var(--bg,#0f1216)}
  .sb-item.on{background:var(--sel,rgba(91,141,255,.16));color:var(--accent,#5b8dff);font-weight:600}
  .sb-item svg{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;
    stroke-linecap:round;stroke-linejoin:round}
  .sb-badge{margin-left:auto;background:var(--accent,#5b8dff);color:#fff;border-radius:999px;font-size:11px;
    font-weight:700;min-width:20px;height:20px;display:none;align-items:center;justify-content:center;padding:0 6px}
  .sb-badge.show{display:inline-flex}
  .sb-sep{height:1px;background:var(--line,#252b33);margin:8px 12px}
  .sb-bottom{padding:10px;border-top:1px solid var(--line,#252b33);display:grid;gap:8px}
  .sb-call{display:flex;align-items:center;justify-content:center;gap:9px;height:42px;border-radius:10px;border:0;
    background:var(--accent,#5b8dff);color:#fff;font:600 14px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
  .sb-call:hover{filter:brightness(1.08)}
  .sb-call svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .sb-me{display:flex;align-items:center;gap:10px;padding:4px 4px 2px}
  .sb-av{width:32px;height:32px;border-radius:50%;background:var(--bg,#0f1216);border:1px solid var(--line,#252b33);
    display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:var(--muted,#8b95a1);
    position:relative;flex:none}
  .sb-dot{position:absolute;right:-1px;bottom:-1px;width:10px;height:10px;border-radius:50%;
    border:2px solid var(--panel,#171b21);background:var(--muted,#8b95a1)}
  .sb-dot.ok{background:#34c759}.sb-dot.warn{background:#ffa04d}.sb-dot.bad{background:#ff5c5c}
  .sb-txt{flex:1;min-width:0}
  .sb-txt b{display:block;font-size:13px;font-weight:600;color:var(--ink,#e6e9ee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sb-txt span{display:block;font-size:11.5px;color:var(--muted,#8b95a1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sb-icon{width:32px;height:32px;border-radius:8px;border:1px solid transparent;background:none;cursor:pointer;
    color:var(--muted,#8b95a1);display:flex;align-items:center;justify-content:center;flex:none}
  .sb-icon:hover{border-color:var(--line,#252b33);color:var(--ink,#e6e9ee)}
  .sb-icon svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .sb [hidden]{display:none!important}
  @media (max-width:820px){
    html.sb-pad body{padding-left:64px}
    .sb{width:64px}
    .sb-brand span,.sb-label,.sb-txt,.sb-call span,.sb-icon{display:none}
    .sb-brand{justify-content:center;padding:16px 0 12px}
    .sb-item{justify-content:center;padding:10px 0}
    .sb-badge{position:absolute;top:3px;right:6px;min-width:16px;height:16px;font-size:10px;padding:0 4px}
    .sb-me{justify-content:center}
  }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.documentElement.classList.add('sb-pad');

  // { gate, ready, step, platform, phoneOnly }, or null from a server that
  // doesn't have it (then everything shows, as before).
  const profileOf = (r) => r.ok ? r.json().then(p => (p && typeof p.platform === 'boolean' ? p : null)) : null;
  const firstProfile = fetch('/api/profile').then(profileOf).catch(() => null);

  // Glass theme goes last so it wins over each page's own tokens.
  const glass = document.createElement('link');
  glass.rel = 'stylesheet';
  glass.href = '/glass.css';
  document.head.appendChild(glass);
  const wall = document.createElement('script');
  wall.src = '/bg.js';
  document.head.appendChild(wall);

  const ICON = {
    messages: '<path d="M4 5h16v11H9l-5 4z"/>',
    calls: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    voicemail: '<circle cx="6.5" cy="12" r="3.5"/><circle cx="17.5" cy="12" r="3.5"/><path d="M6.5 15.5h11"/>',
    parked: '<circle cx="12" cy="12" r="9"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/>',
    fax: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="9" rx="2"/><path d="M7 14h10v7H7z"/>',
    contacts: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
    photos: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    triage: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M4 13 6.5 5h11L20 13v6H4z"/>',
    insights: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    theme: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    dial: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

  // The fourth flag marks pages that need a signed-in account; a fifth names the
  // AI feature (from /api/profile) the page belongs to, hidden while it's off.
  const ITEMS = [
    ['messages', 'Messages', '/messages', true],
    ['calls', 'Calls', '/calls', true],
    ['parked', 'Parked', '/parked', true],
    ['voicemail', 'Voicemail', '/voicemail', true],
    ['fax', 'Fax', '/fax', true],
    ['contacts', 'Contacts', '/contacts', false],
    ['photos', 'Photos', '/photos', true],
    null,
    ['triage', 'Triage', '/', true, 'triage'],
    ['insights', 'Insights', '/insights', true],
  ];

  const digits = (s) => String(s || '').replace(/\D/g, '');
  const pretty = (n) => {
    const d = digits(n).slice(-10);
    return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(n || '');
  };

  let profile;             // undefined until known; null = older server, show everything
  let sb = null;
  let lineText = null, sipUser = '';
  const setup = () => !!(profile && profile.gate && !profile.ready);
  const platform = () => !profile || profile.platform;

  function build() {
    const here = location.pathname.replace(/\.html$/, '') || '/';
    sb = document.createElement('aside');
    sb.className = 'sb';
    sb.setAttribute('aria-label', 'Main navigation');

    // Everything below is static markup (icons + fixed labels); dynamic values
    // are only ever written with textContent.
    let nav = '';
    for (const it of ITEMS) {
      if (!it) { nav += '<div class="sb-sep"></div>'; continue; }
      const [key, label, href, plat, feature] = it;
      const on = here === href || (href !== '/' && here.startsWith(href));
      nav += `<a class="sb-item${on ? ' on' : ''}" href="${href}"${on ? ' aria-current="page"' : ''}${plat ? ' data-platform' : ''}` +
             `${feature ? ` data-feature="${feature}"` : ''}>` +
             `${svg(key)}<span class="sb-label">${label}</span><span class="sb-badge" data-badge="${key}"></span></a>`;
    }
    const setOn = here.startsWith('/settings') || here.startsWith('/account');
    sb.innerHTML =
      `<div class="sb-brand"><div class="sb-logo"></div><span>Switchboard</span></div>` +
      `<nav class="sb-nav">${nav}</nav>` +
      `<div class="sb-bottom">` +
        `<a class="sb-item${setOn ? ' on' : ''}" href="/settings">${svg('settings')}<span class="sb-label">Settings</span></a>` +
        `<button class="sb-call" type="button">${svg('dial')}<span>Make a call</span></button>` +
        `<div class="sb-me"><div class="sb-av">&#9742;<span class="sb-dot"></span></div>` +
          `<div class="sb-txt"><b class="sb-line"></b><span class="sb-phone">Phone</span></div>` +
          `<button class="sb-icon sb-themebtn" type="button" title="Switch light / dark">${svg('theme')}</button></div>` +
      `</div>`;
    document.body.appendChild(sb);

    sb.querySelector('.sb-call').onclick = () => {
      if (window.switchboardDial) window.switchboardDial();
      else location.href = (platform() ? '/messages' : '/contacts') + '#dial';
    };
    sb.querySelector('.sb-themebtn').onclick = () => {
      const cur = document.documentElement.dataset.theme
        || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch {}
    };

    // Phone status from the phone window. Its SIP username stands in for the
    // line in the footer when there's no account.
    const dot = sb.querySelector('.sb-dot'), ptxt = sb.querySelector('.sb-phone');
    if ('BroadcastChannel' in window) {
      const chan = new BroadcastChannel('switchboard-phone');
      chan.onmessage = (e) => {
        const m = e.data || {};
        if (m.type !== 'status') return;
        const map = { registered: ['ok', 'Phone ready'], connecting: ['warn', 'Phone connecting…'],
                      failed: ['bad', 'Phone offline'], offline: ['bad', 'Phone offline'],
                      unconfigured: ['', 'Phone not set up'], disabled: ['', 'Phone off'] };
        const [cls, text] = map[m.state] || ['', 'Phone'];
        dot.className = 'sb-dot ' + cls;
        ptxt.textContent = m.inCall ? 'On a call' : text;
        sipUser = typeof m.username === 'string' ? m.username : '';
        paintLine();
      };
      chan.postMessage({ type: 'ping' });
    }
  }

  // Footer: the primary line, like "(555) 123-4567", when there's an account;
  // otherwise the phone's SIP username.
  function paintLine() {
    if (!sb) return;
    const out = sb.querySelector('.sb-line');
    if (!platform()) { out.textContent = sipUser || 'Phone'; return; }
    if (lineText != null) { out.textContent = lineText; return; }
    lineText = '';
    out.textContent = '';
    fetch('/api/state').then(r => r.json()).then(s => {
      const l = (s.lines || []).find(x => x.active !== false);
      lineText = l ? pretty(l.number) : 'No line enabled';
      paintLine();
    }).catch(() => { lineText = null; });
  }

  // Counts: unread conversations, parked calls, new voicemail, triage items waiting.
  async function badges() {
    if (!sb || !platform()) return;
    try {
      const b = await (await fetch('/api/badges')).json();
      const set = (key, n) => {
        const el = sb?.querySelector(`[data-badge="${key}"]`);
        if (!el) return;
        el.textContent = n > 99 ? '99+' : String(n || '');
        el.classList.toggle('show', n > 0);
      };
      set('messages', b.unread);
      set('parked', b.parked);
      set('voicemail', b.voicemail);
      set('triage', b.pending);
    } catch {}
  }

  // First-run setup gets no sidebar at all; without an account only the pages
  // that work without one show.
  function apply() {
    document.documentElement.classList.toggle('sb-pad', !setup());
    if (setup()) { if (sb) { sb.remove(); sb = null; } return; }
    if (!sb) build();
    for (const a of sb.querySelectorAll('[data-platform]')) a.hidden = !platform();
    for (const a of sb.querySelectorAll('[data-feature]')) if (profile && profile[a.dataset.feature] === false) a.hidden = true;
    // A separator shows only with a visible item on both sides of it.
    const shown = (sep, dir) => {
      for (let n = sep[dir]; n && !n.classList.contains('sb-sep'); n = n[dir]) if (!n.hidden) return true;
      return false;
    };
    for (const sep of sb.querySelectorAll('.sb-sep')) {
      sep.hidden = !(shown(sep, 'previousElementSibling') && shown(sep, 'nextElementSibling'));
    }
    paintLine();
  }

  // Signing in or out on the Account page changes which pages belong here;
  // pick that up on the badge poll rather than holding another event stream
  // open. A failed poll keeps what we had.
  async function refresh() {
    const p = await fetch('/api/profile').then(profileOf).catch(() => null);
    if (p) profile = p;
    apply();
    badges();
  }

  // Settings calls this after turning triage on/off (or Reset), so the sidebar
  // follows at once instead of on the next 30s poll.
  window.switchboardNav = { refresh };

  // Update banner. The app calls this on every page load once a new version
  // has downloaded. "Restart now" goes to an address the app itself catches
  // (and refuses during a call); "Later" hides it until the app restarts, and
  // the update installs then anyway.
  window.switchboardUpdate = (version) => {
    const v = String(version ?? '').replace(/[^\w.-]/g, '');
    if (!v || document.getElementById('sb-update')) return;
    try { if (sessionStorage.getItem('sb-update-later') === v) return; } catch {}
    const bar = document.createElement('div');
    bar.id = 'sb-update';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:1200;display:flex;align-items:center;gap:12px;'
      + 'padding:12px 14px 12px 16px;border-radius:12px;background:var(--panel,#171b21);color:var(--ink,#e6e9ee);'
      + 'border:1px solid var(--accent,#5b8dff);box-shadow:0 14px 40px rgba(0,0,0,.45);'
      + 'font:14px/1.35 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:calc(100vw - 36px)';
    const txt = document.createElement('div');
    const b = document.createElement('b'); b.textContent = `Switchboard ${v} is ready`;
    const s = document.createElement('span'); s.textContent = 'Restart to update. Takes a few seconds.';
    s.style.cssText = 'display:block;font-size:12.5px;color:var(--muted,#8b95a1)';
    txt.append(b, s);
    const btn = (label, primary) => {
      const x = document.createElement('button');
      x.type = 'button'; x.textContent = label;
      x.style.cssText = 'font-family:inherit;font-weight:600;font-size:13px;padding:7px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;'
        + (primary ? 'background:var(--accent,#5b8dff);color:#fff;border:1px solid var(--accent,#5b8dff)'
                   : 'background:none;color:var(--muted,#8b95a1);border:1px solid var(--line,#252b33)');
      return x;
    };
    const later = btn('Later', false), now = btn('Restart now', true);
    later.onclick = () => { try { sessionStorage.setItem('sb-update-later', v); } catch {} bar.remove(); };
    now.onclick = () => { now.disabled = true; now.textContent = 'Restarting…'; location.href = '/__update/install';
      setTimeout(() => { now.disabled = false; now.textContent = 'Restart now'; }, 4000); };
    bar.append(txt, later, now);
    (document.body || document.documentElement).appendChild(bar);
  };

  function start() {
    firstProfile.then((p) => {
      profile = p;
      apply();
      badges();
      setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 30000);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
