// Desktop shell for Switchboard.
//
// Hosts the existing local server in-process (or attaches to one already
// running), opens it in a sandboxed window, and adds what a browser tab can't:
// the phone overlay, tray icon with a pending badge, native notifications for
// new messages, close-to-tray, and an opt-in launch-at-login.
import { app, BrowserWindow, WebContentsView, Tray, Menu, Notification, nativeTheme, shell, dialog, session, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { appIcon, trayIcon, appIco } from './icon.mjs';

// Where per-user files go (lib/paths.mjs), decided before anything that reads
// them is loaded. An installed copy keeps them in %APPDATA%\Switchboard: its
// own files are read-only. Run from the project folder, the data files stay in
// the project folder and Electron's profile keeps the name the app had when it
// was "Ooma Triage": on Windows that folder holds the key (in "Local State")
// that decrypts secrets.bin, so moving it would silently lose saved logins.
// SWITCHBOARD_DATA overrides both, for a test run that mustn't touch real data.
if (process.env.SWITCHBOARD_DATA) app.setPath('userData', process.env.SWITCHBOARD_DATA);
else if (app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'Switchboard'));
  process.env.SWITCHBOARD_DATA = app.getPath('userData');
} else app.setPath('userData', join(app.getPath('appData'), 'ooma-triage'));
const settings = await import('../lib/settings.mjs');
const { dataPath } = await import('../lib/paths.mjs');

app.setName('Switchboard');
// The installer stamps its shortcuts with this id (build.appId in package.json);
// Windows needs the two to match to show the app's notifications.
const APP_ID = app.isPackaged ? 'com.switchboard.desktop' : 'Switchboard';
const OLD_APP_ID = 'com.drew.ooma-triage';
// Launch-at-login: an installed copy is its own .exe; run from the project
// folder, electron.exe needs the app folder passed to it.
const LOGIN_ARGS = () => app.isPackaged ? [] : [ROOT];

const PORT = Number(process.env.UI_PORT ?? 8787);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT = app.getAppPath();
const SMOKE = process.argv.includes('--smoke');
// One-off: write the desktop shortcut and exit (works while the app is running).
const MAKE_SHORTCUT = process.argv.includes('--create-shortcut');
const SHOT = (process.argv.find(a => a.startsWith('--shot=')) ?? '').slice(7);
const SETTLE = Number((process.argv.find(a => a.startsWith('--settle=')) ?? '--settle=400').slice(9));

// --page= overrides the start page chosen in Settings (used by the smoke test).
const START_ARG = process.argv.find(a => a.startsWith('--page='));
const startPage = () => START_ARG ? START_ARG.slice(7) : settings.get('general.startPage');

// Per-launch key. The server (hosted in this process) reads it from the
// environment; every request from this app's windows carries it, and the
// credential endpoints refuse anything without it.
const APP_KEY = randomBytes(32).toString('hex');
process.env.TRIAGE_APP_KEY = APP_KEY;
const PAGES = [['Messages', '/messages'], ['Triage queue', '/'], ['Calls', '/calls'], ['Parked calls', '/parked'], ['Photos', '/photos'], ['Settings', '/settings'], ['Account', '/account'], ['Contacts', '/contacts'], ['Voicemail', '/voicemail'], ['Fax', '/fax'], ['Insights', '/insights']];
// Pages that need a signed-in account. Hidden from the tray when the app is a
// phone only; the server would redirect them to /contacts anyway.
const PLATFORM_PAGES = new Set(['/', '/messages', '/calls', '/parked', '/photos', '/voicemail', '/fax', '/insights']);

let win = null;
let phone = null;
let tray = null;
let quitting = false;
let pending = 0;
let hintShown = false;
// GET /api/profile as last seen (setup state, account features). null when the
// server doesn't have it (an older one attached): then nothing is gated or hidden.
let profile = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pretty = (n) => {
  const d = String(n ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n ?? '');
};

// ---- single instance -------------------------------------------------------
if (!SMOKE && !MAKE_SHORTCUT && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => show());

// Windows only delivers toasts for an identified app.
// Also the name Windows shows on notifications.
app.setAppUserModelId(APP_ID);
// Pages follow prefers-color-scheme, so this makes the whole app dark.
nativeTheme.themeSource = settings.get('general.theme');

// ---- server ----------------------------------------------------------------
async function ours() {
  try {
    const r = await fetch(`${ORIGIN}/api/state`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return Array.isArray(j.pending);
  } catch { return false; }
}

async function ensureServer() {
  if (await ours()) return 'attached';
  if (!app.isPackaged) process.chdir(ROOT);          // (an installed copy's folder is an archive)
  await import(pathToFileURL(join(ROOT, 'server.mjs')).href);
  for (let i = 0; i < 40; i++) {
    if (await ours()) return 'hosted';
    await sleep(500);
  }
  throw new Error(`server did not come up on ${ORIGIN}`);
}

// Non-secret, so it needs no app key (this fetch is Node's, not the window's).
// A network error keeps the last value; a missing endpoint clears it.
async function loadProfile() {
  try {
    const r = await fetch(`${ORIGIN}/api/profile`, { signal: AbortSignal.timeout(3000) });
    const j = r.ok ? await r.json() : null;
    profile = typeof j?.ready === 'boolean' ? j : null;
  } catch {}
  return profile;
}

// Until setup is done the server sends every page to /account, so go there
// directly. Only while the gate is on: a plain-node server has no setup wizard
// and keeps the old behaviour. --page= still beats the Settings start page.
const firstPage = (p) => (p?.gate && !p.ready ? '/account' : startPage());

// ---- window ----------------------------------------------------------------
// Off-origin http(s) opens in the browser. tel: hands a bare number to
// whatever phone app Windows has registered (click-to-call fallback). Nothing
// else is allowed out of a window.
function guard(w) {
  const external = (url) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(ORIGIN)) shell.openExternal(url);
    else if (/^tel:\+?(?:[0-9*]|%23){2,24}$/i.test(url)) shell.openExternal(url);
  };
  w.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => {
    if (url === ORIGIN + '/__update/install') { e.preventDefault(); installUpdate(); return; }   // the update banner
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); external(url); }
  });
}

// The phone is an overlay inside the main window, like a web client's dialer: a
// separate web contents stacked on top of the page. Being separate is what
// lets a call survive moving between pages; being a child view is what keeps
// it captive to the app window (it moves, hides and minimizes with it).
//
// The phone page picks its own layout and tells us: hidden, 'panel' (dialer
// or expanded call) or 'mini' (compact call card). Sizes include a 12px
// transparent margin the page uses for its drop shadow.
const PHONE_SIZE = { panel: [344, 640], mini: [344, 132] };
let phoneMode = 'hidden';
const phonePos = { panel: null, mini: null };   // per mode, for this session
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function createPhoneView() {
  phone = new WebContentsView({
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: join(ROOT, 'electron', 'phone-preload.cjs'),
      autoplayPolicy: 'no-user-gesture-required',   // ringtone + remote audio
      backgroundThrottling: false,                   // keep SIP keepalives on time while hidden
    },
  });
  phone.setBackgroundColor('#00000000');
  phone.setVisible(false);
  win.contentView.addChildView(phone);
  guard(phone);
  phone.webContents.on('console-message', (e, _level, message) => sipTrace(e?.message ?? message));
  phone.webContents.loadURL(ORIGIN + '/phone');
  win.on('resize', placePhone);
}

// Settings > Phone > SIP trace. The phone page prints SIP.js log lines with a
// '[sip] ' prefix only while the setting is on; they land in logs\sip-trace.log
// (rolled to .old at 5 MB). Digest login lines are dropped: the file is for
// comparing signaling with a provider, and may be shared with one.
const TRACE_FILE = dataPath('logs', 'sip-trace.log');
const TRACE_MAX = 5 * 1024 * 1024;
function sipTrace(text) {
  if (typeof text !== 'string' || !text.startsWith('[sip] ') || !settings.get('phone.sipTrace')) return;
  const clean = text.slice(6).split(/\r?\n/)
    .filter((l) => !/^\s*(proxy-)?authorization\s*:/i.test(l))
    .join('\n');
  try {
    mkdirSync(dataPath('logs'), { recursive: true });
    if (existsSync(TRACE_FILE) && statSync(TRACE_FILE).size > TRACE_MAX) renameSync(TRACE_FILE, TRACE_FILE + '.old');
    appendFileSync(TRACE_FILE, `[${new Date().toISOString()}] ${clean}\n`);
  } catch {}
}

function placePhone() {
  if (!phone || !win || win.isDestroyed()) return;
  if (phoneMode === 'hidden') { phone.setVisible(false); return; }
  const [cw, ch] = win.getContentSize();
  const w = Math.min(PHONE_SIZE[phoneMode][0], cw), h = Math.min(PHONE_SIZE[phoneMode][1], ch);
  const p = phonePos[phoneMode] ?? (phoneMode === 'panel'
    ? { x: Math.round((cw - w) / 2) + 100, y: 48 }          // centred over the content, clear of the sidebar
    : { x: cw - w - 8, y: ch - h - 8 });                    // bottom-right corner
  const x = clamp(p.x, 0, Math.max(0, cw - w)), y = clamp(p.y, 0, Math.max(0, ch - h));
  phonePos[phoneMode] = { x, y };
  phone.setBounds({ x, y, width: w, height: h });
  phone.setVisible(true);
}

function setPhoneMode(mode) {
  phoneMode = mode;
  placePhone();
}

// Tray, notifications: bring the app up with the dialer open.
function showPhone() {
  show();
  phone?.webContents.send('phone:open');
}

const fromPhone = (e) => phone && e.sender === phone.webContents;
ipcMain.on('phone:layout', (e, mode) => {
  if (fromPhone(e) && ['hidden', 'panel', 'mini'].includes(mode)) setPhoneMode(mode);
});
ipcMain.on('phone:drag', (e, d) => {
  if (!fromPhone(e) || phoneMode === 'hidden' || !phonePos[phoneMode]) return;
  const dx = Number(d?.dx) || 0, dy = Number(d?.dy) || 0;
  phonePos[phoneMode] = { x: phonePos[phoneMode].x + dx, y: phonePos[phoneMode].y + dy };
  placePhone();
});
ipcMain.on('phone:show', (e) => { if (fromPhone(e)) show(); });
ipcMain.on('phone:idle', (e) => { if (fromPhone(e)) win?.flashFrame(false); });
ipcMain.on('phone:openMain', (e, path) => {
  if (fromPhone(e) && /^\/[\w\/-]*$/.test(path)) show(path);
});
ipcMain.on('phone:ring', (e, who) => {
  if (!fromPhone(e)) return;
  show();
  win.flashFrame(true);
  if (Notification.isSupported() && settings.get('notifications.calls')) {
    const n = new Notification({ title: 'Incoming call', body: String(who).slice(0, 80) || 'Unknown caller', icon: appIcon(), silent: true });
    n.on('click', () => show());
    n.show();
  }
});

function createWindow(start) {
  win = new BrowserWindow({
    width: 1120, height: 820, minWidth: 420, minHeight: 360,
    title: 'Switchboard',
    icon: appIcon(),
    backgroundColor: '#0f1216',
    autoHideMenuBar: true,
    show: !SMOKE,
    webPreferences: {
      // SMS bodies are attacker-controlled. The pages render them as text, but
      // if that ever regressed, a sandboxed renderer without Node keeps an
      // injected script from reaching the filesystem or the session token.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  guard(win);
  win.webContents.on('did-finish-load', () => showUpdateBanner());

  win.on('close', (e) => {
    if (quitting || SMOKE) return;
    e.preventDefault();
    win.hide();
    if (!hintShown && Notification.isSupported()) {
      hintShown = true;
      new Notification({ title: 'Still running', body: 'Switchboard keeps running in the tray. Quit from the tray menu.', silent: true }).show();
    }
  });

  win.loadURL(ORIGIN + (String(start).startsWith('/') ? start : '/'));
}

function show(path) {
  if (!win) return;
  if (path) win.loadURL(ORIGIN + path);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- tray ------------------------------------------------------------------
function loginEnabled() {
  return app.getLoginItemSettings({ path: process.execPath, args: LOGIN_ARGS() }).openAtLogin;
}

// The Windows startup entry used to be written under the old app id. Move it
// to the new one (keeping on/off as it was) so the toggle controls the real entry.
// Electron only looks entries up by the current app id, so it can't see the old
// one; ask Windows directly (read-only) whether it exists.
function migrateLoginItem() {
  if (process.platform !== 'win32' || app.isPackaged) return;
  try {
    execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', OLD_APP_ID],
      { stdio: 'ignore', windowsHide: true });
  } catch { return; }                                   // no old entry: nothing to do
  try {
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath, args: LOGIN_ARGS(), name: OLD_APP_ID });
    setLogin(true);
  } catch {}
}

function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: LOGIN_ARGS() });
}

function refreshTray() {
  if (!tray) return;
  // The queue count is triage's; with triage off it isn't shown anywhere.
  const shown = profile?.triage === false ? 0 : pending;
  tray.setImage(trayIcon(shown));
  tray.setToolTip(shown ? `Switchboard — ${shown} waiting` : 'Switchboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => show() },
    { label: 'Phone', click: () => showPhone() },
    { label: 'Make a call…', click: () => showPhone() },
    // The triage queue count and page only mean something while triage is on.
    ...(profile?.triage === false ? [] : [{ label: pending ? `${pending} waiting` : 'Queue clear', enabled: false }]),
    { type: 'separator' },
    ...PAGES.filter(([, path]) => (profile?.platform !== false || !PLATFORM_PAGES.has(path))
                                  && !(path === '/' && profile?.triage === false))
      .map(([label, path]) => ({ label, click: () => show(path) })),
    { type: 'separator' },
    { label: 'Launch at login', type: 'checkbox', checked: loginEnabled(),
      click: (item) => { setLogin(item.checked); refreshTray(); } },
    ...(!app.isPackaged ? [] : updateReady
      ? [{ label: `Restart to update (v${updateReady})`, click: () => installUpdate() }]
      : [{ label: updateNote || 'Check for updates', enabled: !updateNote, click: () => checkUpdates(true) }]),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---- updates ---------------------------------------------------------------
// An installed copy checks GitHub Releases at start and every few hours, and
// downloads a newer version in the background. It installs when the app quits,
// or at once from the tray/toast ("Restart to update") — never mid-call on its own.
let updater = null, updateReady = '', updateNote = '';
async function startUpdates() {
  if (!app.isPackaged || SMOKE) return;
  try { updater = (await import('electron-updater')).default.autoUpdater; }
  catch (e) { console.error('updates: ' + e.message); return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-available', (i) => { updateNote = `Downloading v${i.version}…`; refreshTray(); });
  updater.on('update-not-available', () => { updateNote = ''; refreshTray(); });
  updater.on('error', (e) => { console.error('updates: ' + (e?.message || e)); updateNote = ''; refreshTray(); });
  updater.on('update-downloaded', (i) => {
    updateReady = i.version; updateNote = '';
    refreshTray();
    showUpdateBanner();
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `Switchboard ${i.version} is ready`,
      body: 'Click to restart and update now, or it installs next time Switchboard closes.', icon: appIcon(), silent: true });
    n.on('click', () => installUpdate());
    n.show();
  });
  checkUpdates();
  setInterval(checkUpdates, 4 * 3600e3);
}
async function checkUpdates(byHand = false) {
  if (!updater || updateReady) return;
  if (byHand) { updateNote = 'Checking for updates…'; refreshTray(); }
  try {
    const r = await updater.checkForUpdates();
    if (byHand && !r?.isUpdateAvailable && Notification.isSupported())
      new Notification({ title: 'Switchboard is up to date', body: `Version ${app.getVersion()}`, icon: appIcon(), silent: true }).show();
  } catch (e) { console.error('updates: ' + e.message); }
  if (updateNote === 'Checking for updates…') { updateNote = ''; refreshTray(); }
}
// The banner in the main window (nav.js), shown again on every page load.
function showUpdateBanner() {
  if (!updateReady || !win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.switchboardUpdate?.(${JSON.stringify(updateReady)})`).catch(() => {});
}
async function installUpdate() {
  if (!updater || !updateReady) return;
  const busy = await phone?.webContents.executeJavaScript('window.phoneBusy?.() ?? false').catch(() => false);
  if (busy) {
    dialog.showMessageBox(win, { type: 'info', title: 'Switchboard', message: 'Finish your call first',
      detail: 'Restarting now would end the call. Update after it, or it installs next time Switchboard closes.' });
    return;
  }
  quitting = true;
  updater.quitAndInstall(true, true);   // silent install, then start again
}

function createTray() {
  tray = new Tray(trayIcon(0));
  tray.on('click', () => (win?.isVisible() ? win.hide() : show()));
  refreshTray();
}

// ---- live events -----------------------------------------------------------
// Toasts are always silent: Windows only plays its own notification sound, so
// the sound chosen in Settings is played by the phone window instead (it is
// always running and allowed to play audio without a click).
function playSound(slot) {
  if (!phone || phone.webContents.isDestroyed()) return;
  let name = settings.get(`sounds.${slot}`), file = settings.get(`sounds.${slot}File`);
  if (slot === 'urgent' && name === 'same') {
    name = settings.get('sounds.message'); file = settings.get('sounds.messageFile');
  }
  phone.webContents.send('sound:play', { name, file, volume: settings.get('sounds.messageVolume') });
}

function notify(e, { force = false } = {}) {
  if (!Notification.isSupported()) return;
  if (!force && e.announced) return;   // already announced plainly while triage was failing
  if (!force && !settings.get('notifications.messages')) return;
  if (!force && e.urgency === 'low' && !settings.get('notifications.lowUrgency')) return;
  const who = e.name || pretty(e.remote);
  const flag = e.needs_human ? 'Needs you · ' : '';
  const n = new Notification({
    title: `${who} — ${e.urgency}`,
    body: flag + (e.summary || 'New message'),
    silent: true,
    icon: appIcon(),
  });
  n.on('click', () => show('/'));
  n.show();
  // Low-priority messages ping too unless turned off in Settings.
  if (e.urgency !== 'low' || settings.get('notifications.lowUrgencySound'))
    playSound(e.urgency === 'urgent' || e.urgency === 'high' ? 'urgent' : 'message');
}

// A new text while triage is off: no AI summary or urgency, just who and what.
function notifyInbound(m, { force = false } = {}) {
  if (!Notification.isSupported() || (!force && !settings.get('notifications.messages'))) return;
  const n = new Notification({
    title: m.name || pretty(m.remote) || 'New message',
    body: String(m.preview || 'New message').slice(0, 160),
    silent: true,
    icon: appIcon(),
  });
  n.on('click', () => show('/messages'));
  n.show();
  playSound('message');
}

// Reads the server's SSE stream from the main process, reconnecting on drop.
async function subscribe() {
  const NL2 = '\n\n';
  while (!quitting) {
    try {
      const res = await fetch(`${ORIGIN}/api/events`);
      // Anything pushed while disconnected was missed; catch up.
      loadProfile().then(refreshTray);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf(NL2)) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          let payload = null;
          try { payload = data ? JSON.parse(data) : null; } catch { continue; }
          if (ev === 'item' && payload) notify(payload);
          if (ev === 'inbound' && payload) notifyInbound(payload);
          if (ev === 'queue' && Array.isArray(payload)) { pending = payload.length; refreshTray(); }
          // Sign-in, sign-out, setup: the tray's page list follows.
          if (ev === 'profile' && typeof payload?.ready === 'boolean') { profile = payload; refreshTray(); }
          if (ev === 'review' && payload && !payload.empty && settings.get('review.enabled') === true && Notification.isSupported()) {
            const n = new Notification({ title: 'Your morning recap is ready',
              body: String(payload.headline || 'Yesterday\'s texts, calls and voicemail.').slice(0, 160), silent: true, icon: appIcon() });
            n.on('click', () => show('/insights'));
            n.show();
          }
        }
      }
    } catch {}
    if (!quitting) await sleep(3000);
  }
}

async function loadPending() {
  try {
    const j = await (await fetch(`${ORIGIN}/api/state`)).json();
    pending = j.pending?.length ?? 0;
    refreshTray();
  } catch {}
}

// ---- boot ------------------------------------------------------------------
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault?.());

const downloadsDefault = () => join(app.getPath('downloads'), 'Switchboard Photos');

// Earlier builds defaulted to Downloads\Ooma Photos. An install that already
// has that folder keeps it (saved as an explicit choice) instead of quietly
// starting a second folder under the new default name.
function migrateDownloadsFolder() {
  if (app.isPackaged) return;
  try {
    if (settings.get('downloads.folder')) return;
    const old = join(app.getPath('downloads'), 'Ooma Photos');
    if (existsSync(old)) settings.update({ 'downloads.folder': old });
  } catch {}
}

// Read by the hosted server for Settings actions that need the app process.
globalThis.__triageHost = {
  getLoginItem: () => loginEnabled(),
  setLoginItem: (on) => { setLogin(!!on); refreshTray(); },
  setTheme: (t) => { nativeTheme.themeSource = ['dark', 'light', 'system'].includes(t) ? t : 'dark'; },
  downloadsDefault,
  pickFolder: async (from) => {
    const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
      title: 'Save downloads to', defaultPath: from, properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  openFolder: (dir) => { mkdirSync(dir, { recursive: true }); shell.openPath(dir); },
  createShortcut: () => createDesktopShortcut(),
  pickFile: async ({ title, filters }) => {
    const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
      title, filters, properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  // Settings > Sounds > "Send a test": the real toast + sound path.
  // With triage off, new texts arrive as plain notifications, so test that.
  testNotify: (kind) => settings.get('triage.enabled') === true ? notify({
    name: 'Test notification', remote: '', urgency: kind === 'urgent' ? 'urgent' : 'normal',
    summary: kind === 'urgent' ? 'This is how urgent messages will sound.' : 'This is how new messages will sound.',
  }, { force: true }) : notifyInbound({ name: 'Test notification', preview: 'This is how new messages will look.' }, { force: true }),
};

// Desktop shortcut with the app's icon and app id. The id matters: it makes the
// shortcut and the running window one taskbar entry, and lets Windows label
// notifications "Switchboard".
// An installed copy points at its own .exe (which carries the icon); run from
// the project folder, at electron.exe with the app folder.
function createDesktopShortcut() {
  const lnk = join(app.getPath('desktop'), 'Switchboard.lnk');
  let where;
  if (app.isPackaged) where = { target: process.execPath, cwd: dirname(process.execPath), icon: process.execPath };
  else {
    const ico = join(ROOT, 'electron', 'app.ico');
    writeFileSync(ico, appIco());
    where = { target: process.execPath, args: `"${ROOT}"`, cwd: ROOT, icon: ico };
  }
  const ok = shell.writeShortcutLink(lnk, 'create', {
    ...where, iconIndex: 0, appUserModelId: APP_ID, description: 'Switchboard softphone',
  });
  return { ok, path: lnk };
}

app.whenReady().then(async () => {
  if (MAKE_SHORTCUT) {
    let r;
    try { r = createDesktopShortcut(); } catch (e) { r = { ok: false, error: e.message }; }
    console.log(JSON.stringify(r));
    app.exit(r.ok ? 0 : 1);
    return;
  }
  // An installed copy has no developer menu (reload, dev tools).
  if (app.isPackaged) Menu.setApplicationMenu(null);
  migrateLoginItem();
  migrateDownloadsFolder();
  let mode;
  try { mode = await ensureServer(); }
  catch (err) {
    if (SMOKE) { console.log(JSON.stringify({ ok: false, error: err.message })); app.exit(1); return; }
    dialog.showErrorBox('Switchboard', `Could not start the local server.\n\n${err.message}`);
    app.exit(1);
    return;
  }

  // Downloads (photos, zips) go to the folder chosen in Settings (default
  // Downloads\Switchboard Photos). Without "ask", they save with no dialog and
  // never overwrite; either way they announce themselves with a click-to-reveal.
  session.defaultSession.on('will-download', (_e, item) => {
    const dir = settings.get('downloads.folder') || downloadsDefault();
    mkdirSync(dir, { recursive: true });
    const name = item.getFilename().replace(/[\\/:*?"<>|]/g, '_');
    if (settings.get('downloads.ask')) {
      item.setSaveDialogOptions({ defaultPath: join(dir, name) });
    } else {
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      let target = join(dir, name);
      for (let i = 2; existsSync(target); i++) target = join(dir, `${base} (${i})${ext}`);
      item.setSavePath(target);
    }
    item.once('done', (_ev, state) => {
      if (state !== 'completed' || !Notification.isSupported()) return;
      const saved = item.getSavePath();
      const n = new Notification({ title: 'Saved', body: saved.split(/[\\/]/).pop() + ' \u2014 click to show', silent: true });
      n.on('click', () => shell.showItemInFolder(saved));
      n.show();
    });
  });

  const ours = (u) => String(u ?? '').startsWith(ORIGIN);
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [ORIGIN + '/*'] }, (d, cb) => {
    d.requestHeaders['X-App-Key'] = APP_KEY;
    cb({ requestHeaders: d.requestHeaders });
  });
  // Microphone and notifications for our own pages only.
  // Our pages may use the microphone, notify, and put text on the clipboard
  // (a message's Copy); nothing else, and nothing for any other origin.
  const ALLOWED = ['media', 'notifications', 'clipboard-sanitized-write'];
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(ours(wc.getURL()) && ALLOWED.includes(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
    ours(origin) && ALLOWED.includes(permission));

  createWindow(firstPage(await loadProfile()));
  createTray();
  if (!SMOKE) createPhoneView();
  startUpdates();
  await loadPending();

  if (SMOKE) {
    // Collect page console errors (e.g. a module that failed to load).
    const consoleErrors = [];
    win.webContents.on('console-message', (e, level, message) => {
      const lvl = e?.level ?? level, text = e?.message ?? message;
      if (lvl === 'error' || lvl === 3) consoleErrors.push(String(text).slice(0, 200));
    });
    const deadline = setTimeout(() => { console.log(JSON.stringify({ ok: false, error: 'timeout' })); app.exit(1); }, 60000);
    win.webContents.once('did-finish-load', async () => {
      // Wait for the page's own data to land rather than a fixed delay; some
      // pages (call history) need several seconds of upstream fetching.
      for (let i = 0; i < 40; i++) {
        const loading = await win.webContents.executeJavaScript(
          "document.body.innerText.includes('Loading') || document.body.innerText.includes('loading')");
        if (!loading) break;
        await sleep(500);
      }
      await sleep(SETTLE);
      const result = {
        ok: true, server: mode,
        title: win.webContents.getTitle(),
        url: win.webContents.getURL(),
        pending,
        tray: !!tray && !tray.isDestroyed(),
        notifications: Notification.isSupported(),
        dark: nativeTheme.shouldUseDarkColors,
        consoleErrors,
        // Imported here, after ready: loading it before ready would cache
        // "encryption unavailable" for the whole session.
        savedPhoneLogin: (await import('../lib/secrets.mjs')).status().device?.set,
        profile: await loadProfile(),
        appName: app.getName(),
        userData: app.getPath('userData'),
        images: await win.webContents.executeJavaScript(`(async () => {
          const imgs = [...document.images];
          const loaded = imgs.filter(i => i.complete && i.naturalWidth > 0).length;
          let probe = null;
          const bad = imgs.find(i => !(i.complete && i.naturalWidth > 0));
          if (bad) { try { const r = await fetch(bad.src); probe = r.status + ' ' + r.headers.get('content-type'); } catch (e) { probe = 'fetch error'; } }
          return { total: imgs.length, loaded, lazy: imgs.filter(i => i.loading === 'lazy').length,
                   visibility: document.visibilityState, probe };
        })()`),
      };
      if (SHOT) {
        const img = await win.webContents.capturePage();
        writeFileSync(SHOT, img.toPNG());
        result.shot = SHOT;
      }
      clearTimeout(deadline);
      console.log(JSON.stringify(result));
      tray.destroy();
      app.exit(0);
    });
    return;
  }

  subscribe();
});
