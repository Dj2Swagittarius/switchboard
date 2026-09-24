# Agnostic softphone — design

Date: 2026-09-23. Status: approved (approach A).

Switchboard is today an Ooma Enterprise (Voxter/Kazoo) client with Ooma
servers baked in as defaults and an "Ooma login" that the server cannot boot
without. This change makes it a provider-agnostic WebRTC SIP softphone whose
Kazoo-style data features (messages, call history, voicemail, photos, triage,
insights) switch on only when an API server is configured and signed in.

## Decisions (from the user)

1. **Setup gates the app.** First launch opens straight into setup; no other
   page is reachable until it is done. Order: **1 Servers → 2 Account login →
   3 Phone device.**
2. **No provider names in the UI.** No presets, no vendor defaults. Everyone
   types realm / WebSocket / API server. The login is called "Account login".
3. **Login is optional via the API server field.** API server filled → step 2
   required and the data pages work. Blank → step 2 skipped, the app is a
   phone only, and the data pages are hidden.
4. **Approach A:** `/account` is both the first-run wizard and the place to edit
   these later. One page, one code path.

## Vocabulary

- **profile**: non-secret connection settings in `profile.json` (new, gitignored).
- **login**: account (API) username/password, in `secrets.bin`.
- **device**: SIP device username/password (+ optional auth username), in `secrets.bin`.
- **hasApi**: the profile has an API server.
- **connected(session)**: the Kazoo session object has `auth_token`, `account_id`, `base`.
- **platform**: `hasApi && connected(session)` — the data pages/endpoints are usable.
- **phoneOnly**: `!hasApi`.
- **gate**: the setup gate is active. True only when secure storage is available
  (the server is hosted in the desktop app). Under plain `node server.mjs` the
  gate is off and behaviour is as before (.env + .token.json).

## Storage

### `profile.json` (new file in the app folder; add to `.gitignore`)

```json
{
  "realm": "",            // SIP realm/domain. Also the Kazoo account realm for login.
  "wsServer": "",         // SIP over WebSocket. wss://, or ws:// for a local-network host
  "stun": "",             // optional. stun:host[:port] or stuns:host[:port]
  "apiServer": "",        // optional. https:// base (http:// only for a local-network host). No trailing slash.
  "eventsServer": "",     // optional advanced. wss:// live-events socket. Blank = no live events (polling only)
  "messagingServer": "",  // optional advanced. https:// base for sending texts. Blank = apiServer
  "mediaServer": ""       // optional advanced. https:// base for MMS media. Blank = <messaging>/v2/messaging/ooma_media/
}
```

Not touched by Settings → Reset. Readable by the CLI tools (plain node).

### `secrets.bin` keys (DPAPI via Electron safeStorage)

| key | meaning |
|---|---|
| `login.username`, `login.password` | account login (was `ooma.*`) |
| `sip.username`, `sip.password` | device (unchanged) |
| `sip.authUsername` | optional SIP authorization username (new) |
| `ai.anthropicKey`, `ai.openaiKey` | unchanged |

Legacy keys removed by migration: `ooma.username`, `ooma.password`, `sip.realm`, `sip.server`.

## Units

### `lib/env.mjs` (new, tiny)
`export function loadEnv(path?)` — the `.env` parser moved out of `lib/kazoo.mjs`
(returns `{}` when the file is missing; never throws). `lib/kazoo.mjs` re-exports
a `loadEnv` that keeps its old throwing behaviour for `auth.mjs`.

### `lib/profile.mjs` (new) — the connection profile

```js
export const FIELDS = ['realm','wsServer','stun','apiServer','eventsServer','messagingServer','mediaServer'];
export function stored()              // raw profile.json object ({} when missing), cached by mtime like settings.mjs
export function get()                 // every FIELD as a string; realm falls back to .env OOMA_ACCOUNT_REALM,
                                      // apiServer to .env OOMA_API_BASE (CLI compatibility). Others: stored only.
export function derived(p = get())    // { eventsServer, messagingServer, mediaServer } effective values:
                                      //   events:    p.eventsServer || process.env.BLACKHOLE_URL || ''
                                      //   messaging: p.messagingServer || process.env.OOMA_SEND_BASE || p.apiServer
                                      //   media:     p.mediaServer || process.env.OOMA_MEDIA_BASE ||
                                      //              (messaging ? messaging + '/v2/messaging/ooma_media/' : '')
export function hasApi(p = get())     // !!p.apiServer
export function validate(patch)       // -> array of human error strings ([] when fine). Rules below.
export function update(patch)         // validate, normalise (trim, strip trailing '/' from http(s) bases,
                                      // ensure mediaServer ends with '/'), write profile.json, return get(). Throws Error(joined errors).
export function clear()               // delete profile.json
export function sipConfig()           // { configured, username, authUsername, password, realm, server, stun }
                                      // configured = realm && wsServer && sip.username && sip.password
export function step(session)         // 'server' | 'login' | 'device' | null
                                      //   'server' if !(realm && wsServer)
                                      //   'login'  if hasApi && !connected(session) && !(login.username && login.password)
                                      //   'device' if !(sip.username && sip.password)
export function summary(session)      // what GET /api/profile returns (below)
export function status(session, { loginError = '' } = {})   // what GET /api/account returns (below)
export function migrate(session)      // one-time legacy import, see Migration. Returns { profile: bool, secrets: bool }
export const isLocalHost = (hostname) => ...  // localhost, 127.x, 10.x, 192.168.x, 172.16-31.x, [::1]
```

Validation (applies only to non-empty values; emptiness of required fields is
checked by the endpoint):

- `realm`: `^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`
- `wsServer`, `eventsServer`: parse with `new URL`; protocol `wss:`, or `ws:` only when `isLocalHost`; no credentials, no hash.
- `stun`: `^stuns?:[A-Za-z0-9.-]+(:\d{1,5})?$`
- `apiServer`, `messagingServer`, `mediaServer`: `new URL`; `https:`, or `http:` only when `isLocalHost`; no credentials, no query, no hash.

`connected(session)` is exported from `lib/kazoo.mjs`:
`!!(s && s.auth_token && s.account_id && s.base)`.

### `lib/secrets.mjs`
Unchanged storage; `status()` becomes:
```js
{ secureStorage, login: { set, username }, device: { set, username, authUsername }, ai: { anthropic, openai } }
```

### `lib/kazoo.mjs`
- `credentials()` builds from profile + secrets, .env as fallback:
  `.env` values → overridden by `login.*` secrets (username/password) →
  `OOMA_API_BASE = profile.get().apiServer`, `OOMA_ACCOUNT_REALM = profile.get().realm` when set.
  **No hardcoded Voxter defaults.** (`OOMA_ACCOUNT_NAME` / `OOMA_PHONE_NUMBER` from .env still work.)
- `authenticate(env)` throws `Error('No API server is set.')` when `OOMA_API_BASE` is empty.
- New `tryLoadSession()` → session object or `null` (never throws). `loadSession()` keeps throwing (CLI).
- New `clearSession(session)` → deletes `.token.json` (if present) and deletes every own key of `session` (mutate, don't replace).
- New `connected(session)` as above.

### `lib/send.mjs`, `lib/messaging.mjs`, `bot.mjs`, `listen.mjs`
Replace the hardcoded `SEND_BASE` / `MEDIA_BASE` / `BLACKHOLE_URL` constants with
calls to `profile.derived()` at use time. When the needed value is empty, throw
a clear error (`'No messaging server is set.'` etc.) or, for the event socket, skip it.

### `lib/directory.mjs`
When `!connected(session)` the traffic side is `[]` (no upstream calls); the
local roster (`contacts.json`) still produces the book.

### `server.mjs`
- `const session = tryLoadSession() ?? {}` — one object, always mutated in place.
- Boot: `profile.migrate(session)` before anything else uses the profile.
- `platformUp()` = `profile.hasApi() && connected(session)`.
- `gate()` = `secrets.available()`.
- **Platform lifecycle** (replaces the top-level `resolveMyBoxes` + the listen-callback startup):
  - `startPlatform()` (idempotent): resolve boxes, warm `directory` + `photoIndex`,
    `sync('startup', BACKLOG)`, open the events socket if `profile.derived().eventsServer` is set.
  - `stopPlatform()`: close the events socket (and stop it reconnecting), `owned = null`,
    `invalidate('')`, clear the media cache.
  - On listen: `if (platformUp()) startPlatform(); else if (profile.hasApi() && creds available) backgroundSignIn()`.
  - `backgroundSignIn()`: `authenticate(credentials())`; success → `Object.assign(session, fresh)`, `loginError = ''`, `startPlatform()`, push profile; failure → `loginError = message`.
  - `sync()` returns early unless `platformUp()`. The review scheduler runs only when `platformUp()`.
- **Setup gate** for HTML routes (every `.html` page route except `/account` and `/phone`):
  - `gate() && profile.step(session) !== null` → `302 Location: /account`.
  - Platform pages (`/`, `/messages`, `/calls`, `/voicemail`, `/photos`, `/insights`, and their `.html` forms) when `!platformUp()` → `302 Location: /contacts`.
- **Platform endpoints** answer `409 { error: 'Not signed in to an account.', code: 'no-account' }` when `!platformUp()`:
  `/api/review/run`, `/api/insights`, `/api/conversations`, `/api/conversation`, `/api/media`,
  `/api/photos`, `/api/photos/zip`, `/api/messages/send`, `/api/calls`, `/api/recording/audio`,
  `/api/recording/transcribe`, `/api/voicemail/audio`, `/api/voicemails`, `/api/voicemail/transcribe`,
  `/api/thread`, `/api/sync`, `/api/send`.
  `/api/badges` returns zeros (plus local `pending`). `/api/directory` works (local roster only).
- **`GET /api/profile`** (no app key; non-secret):
  `{ gate, ready, step, platform, phoneOnly }` where `ready = step === null`.
- **`GET /api/settings`** adds `profile: <same summary>`; `account` is the new `secrets.status()` shape.
- **`/api/account`** (app key required, as today):
  - `GET` → `profile.status(session, { loginError })`:
    ```js
    {
      secureStorage, gate, ready, step,
      server: { realm, wsServer, stun, apiServer, eventsServer, messagingServer, mediaServer,  // form values
                derived: { eventsServer, messagingServer, mediaServer },                          // effective
                set },                                                                            // realm && wsServer
      login:  { needed, set, username, connected, error },   // needed = hasApi
      device: { set, username, authUsername },
    }
    ```
  - `POST { server: {…7 fields} }` → require realm (`'Enter the SIP realm (domain).'`) and
    wsServer (`'Enter the WebSocket server.'`); `profile.update`. If `apiServer` or `realm`
    changed while a session exists: `stopPlatform()`, `clearSession(session)`; then if
    `apiServer` is now blank also `secrets.forget('login.')`; else if login creds are
    stored, `backgroundSignIn()`.
  - `POST { login: { username, password } }` → 400 if `!hasApi` (`'Set an API server first.'`);
    400 if either blank; `authenticate({ ...credentials(), OOMA_USERNAME, OOMA_PASSWORD })`;
    failure → 401 `'The server did not accept that username and password.'`;
    success → store `login.*`, `Object.assign(session, fresh)`, `loginError = ''`, `startPlatform()`.
  - `POST { device: { username, password, authUsername } }` → username required; password
    required unless one is saved (blank keeps it); authUsername optional (blank removes it);
    username/authUsername must match `^[^\s@:;<>"]{1,64}$`.
  - `POST { forget: 'login' }` → `secrets.forget('login.')`, `stopPlatform()`, `clearSession(session)`.
  - `POST { forget: 'device' }` → forget `sip.username`, `sip.password`, `sip.authUsername`.
  - `POST { reset: true }` → `stopPlatform()`, `clearSession(session)`, forget `login.` and the
    three `sip.*` keys, `profile.clear()`. AI keys are kept.
  - Every successful POST answers `{ ok: true, account: <GET shape> }` and pushes SSE `profile`.
- **`GET /api/sip/config`** (app key) → `profile.sipConfig()`; `stun` may be `''`.
- SSE: new event `profile` carrying the `/api/profile` payload.

### `account.html` — setup wizard + account editor
- Three numbered sections in order: **1 Servers**, **2 Account login**, **3 Phone device**,
  each with a state pill.
- **Setup mode** (`gate && !ready`): header "Set up Switchboard" with a 3-step stepper
  (step 2 shown as "Skipped" when there's no API server). Steps after the current
  one are locked/collapsed; finished steps collapse to a one-line summary with Edit.
  Buttons read Next / Sign in / Finish. After Finish → navigate to the start page
  (`/api/settings` → `settings.general.startPage`; the server redirects platform pages
  to `/contacts` when there's no platform).
- **Normal mode**: the same sections, editable, plus a danger-zone **Start over** (confirm
  dialog) that POSTs `{ reset: true }` and reloads into setup mode.
- Servers: SIP realm/domain*, WebSocket server*, STUN server, API server
  ("Optional. Leave blank to use Switchboard as a phone only."), and an "Advanced"
  disclosure for Events / Messaging / Media servers whose placeholders show the
  derived values. A **Test** button next to the WebSocket field opens
  `new WebSocket(url, 'sip')` from the page and reports reachable / failed within 6 s.
- Account login: hidden entirely when there's no API server. Username, password,
  Sign in, Sign out. Shows `login.error` when a background sign-in failed.
- Phone device: SIP username*, password*, Advanced → Authorization username. Save →
  post `reload` to the phone channel and show live registration state from it.
- Passwords are write-only (placeholder "Saved — type to change"). 403 → the existing
  "Open this in the desktop app" block.
- Keep the storage note; the 911 note reads "Keep your provider's own app or a desk
  phone working as a backup, especially for 911, until you're confident in this one."

### `nav.js`
- Fetch `/api/profile`. `gate && !ready` → build no sidebar and drop the body padding.
- Hide Messages, Calls, Voicemail, Photos, Triage, Insights when `!platform`. Contacts stays.
- Footer: primary line when `platform`; otherwise the SIP username from the phone's status broadcast.

### `settings.html`
- Sections/rows only meaningful with a platform get `data-platform` and are hidden when
  `!profile.platform`: Lines, Triage & AI, Daily recap, Downloads, the message-related
  notification and sound rows, the Refresh-cached-data row, and platform start-page options.
- Account section: one "Account & phone" row summarising servers / login / device, with Manage → `/account`.
- Uses the new `account` shape (`a.login`, `a.device`).
- Vendor text removed (see Wording).

### `phone.html`
- `iceServers: c.stun ? [{ urls: c.stun }] : []`; `authorizationUsername: c.authUsername || c.username`.
- Setup screen text: "Add your SIP server and phone device on the Account page."
- Recent calls: when `/api/calls` fails (409), show no "Recent calls" list — only contact matches.

### `electron/main.mjs`
- First page: `GET /api/profile` → `!ready` → `/account`, else `startPage()`.
- Tray: pages filtered by the cached profile (platform pages hidden when `!platform`);
  refresh on the SSE `profile` event.
- `downloadsDefault()` → `Downloads\Switchboard Photos`. Boot: if `downloads.folder` is empty
  and `Downloads\Ooma Photos` exists, set `downloads.folder` to it (keeps the current user's folder).
- Close-to-tray hint: "Switchboard keeps running in the tray. Quit from the tray menu."
- Smoke output: `savedPhoneLogin` reads `status().device.set`; add `profile` (the `/api/profile` payload).
- The `ooma-triage` userData folder is NOT renamed (it holds the key for secrets.bin).

### Internal renames (all files, keep consistent)
| old | new |
|---|---|
| `BroadcastChannel('ooma-phone')` | `BroadcastChannel('switchboard-phone')` |
| `window.oomaDial` | `window.switchboardDial` |
| `window.oomaSounds` | `window.switchboardSounds` |

Wire-protocol names (`oomamsg.*`, `ooma_media`, `ooma_mwi`, `ooma_media_url`) stay — they are the API's.

### Wording (user-visible)
- "Places the call through Ooma Enterprise." → "Hands the call to your default phone app."
- "Off hands the number to Ooma Enterprise instead." → "Off hands the number to your default phone app instead."
- "nothing changes on Ooma's side" / "Nothing changes on Ooma." → "…on your provider's side" / "Nothing changes on your provider's side."
- "Reloads contacts, photos and call history from Ooma." → "…from your account."
- "Dial through Ooma Enterprise" (messages.html title) → "Call".
- Insights: "Kazoo labels each call leg's direction…" → "The phone system labels each call leg's direction…".
- `Downloads\Ooma Photos` fallback text → from `meta.host.downloadsDefault`.

## Migration (existing install)

`profile.migrate(session)` at server boot, two idempotent parts:

1. **profile.json** — only if the file does not exist and there is install evidence
   (`connected(session)`, or `.env` has `OOMA_USERNAME` / `OOMA_API_BASE` / `OOMA_ACCOUNT_REALM`,
   or secrets hold any old-only key: `ooma.username`, `ooma.password`, `sip.realm`, `sip.server`).
   The API server is chosen first (`session.base`, then `.env OOMA_API_BASE`, then the legacy one).
   The `LEGACY` constants below are used **only for an old build**: old-only secret keys exist,
   or the chosen API host (or the session's base host) is the legacy API host. Otherwise only
   explicit values are written and the rest stay blank, so setup opens at step 1 — a plain
   `.env` on a new install is not treated as an old install. (Revised after review.)
   Values for an old build (`LEGACY` constants in profile.mjs, commented as migration-only):
   - realm: secrets `sip.realm` || .env `OOMA_ACCOUNT_REALM` || `oeinternal.voxter.sip.voxter.com`
   - wsServer: secrets `sip.server` || `wss://sbc-na-us-east.voxter.com:5065`
   - stun: `stun:stun.ooma.com:3478`
   - apiServer: `session.base` || .env `OOMA_API_BASE` || `https://api-na-us-east.voxter.com`
   - eventsServer: `process.env.BLACKHOLE_URL` || `wss://api-na-us-east.voxter.com:5556`
   - messagingServer: `process.env.OOMA_SEND_BASE` || `https://api-na-us-east.voxter.com:8443`
   - mediaServer: `process.env.OOMA_MEDIA_BASE` || `https://api.voxter.com:8443/v2/messaging/ooma_media/`
   No legacy install detected → write nothing (fresh install → wizard).
2. **secrets** — whenever secure storage is available and legacy keys exist:
   `ooma.username/password` → `login.*` (only if `login.*` unset); `sip.realm` / `sip.server`
   replace a profile realm / wsServer that is blank or still a default part 1 wrote without
   secrets (a `LEGACY` value, or the `.env` realm); then delete the four legacy keys.

## Review-round changes (2026-09-24)
- Sign-ins never persist `.token.json` until they are known to be current: `authenticate(env,
  { persist: false })` + `saveSession()` after the generation check. `POST {login}` answers 409
  when servers or sign-in changed while it waited. `refresh()` never refills a cleared or
  replaced session and, in the desktop app, never re-authenticates from `.env` after sign-out.
- `POST {login}` with a blank password and the saved username retries with the saved password.
- Changing the API server's origin blanks the Advanced events/messaging/media servers not edited
  in the same save (they belonged to the previous provider and would receive the new token).
- `profile.clear()` writes `{ realm: '', apiServer: '' }` so Start over also defeats the `.env` fallback.
- Phone-only drops any loaded session at boot; `directory()` receives the session only when `platformUp()`.
- `auth.mjs` overlays profile.json; `loadSession()` (CLI) runs `migrate()` when profile.json is missing.
- An undecryptable `secrets.bin` is copied to `secrets.bin.unreadable-<time>` before it is overwritten.
- Account page: Sign out / Forget device confirm first; the page switches to setup mode whenever the
  server gate locks the app; the stepper shows "Sign-in failed" for a failing saved login.

## Error handling
- Validation errors come back as 400 with a sentence the page shows inline.
- Platform endpoints never call upstream without a session; they return 409 `no-account`.
- A failed background sign-in is remembered (`loginError`) and shown on the Account page;
  it does not block boot.
- The phone's existing auth-rejection / watchdog logic is unchanged.

## Testing
1. `node --check` every changed `.mjs`; parse every inline `<script>` of changed `.html`.
2. **Migration run**: a temp copy of the app (node_modules as a junction, same
   `ooma-triage` userData so secrets decrypt), `UI_PORT=8799`, `--smoke --page=/messages`:
   profile.json written with the legacy values, page stays on /messages, no console errors.
3. **Fresh run**: temp copy without profile.json / secrets.bin / .token.json / .env,
   `--smoke --page=/messages` → lands on `/account` in setup mode, no console errors.
4. **Phone-only run**: a scratch Electron harness (own userData) hosts `server.mjs`, sets
   the app key, POSTs servers (no API) + device, then checks: `/api/profile` ready & phoneOnly,
   `/messages` → 302 `/contacts`, `/api/calls` → 409, `/api/badges` zeros, `/api/directory` 200,
   `/api/sip/config` shape.
5. Grep: no `ooma-phone`, `oomaDial`, `oomaSounds`, or user-visible "Ooma" left in pages.

## Out of scope
- Local call history for phone-only mode.
- Non-Kazoo data APIs.
- Renaming `.env` variable names used by the CLI tools.
- Renaming the userData folder.
