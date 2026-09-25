# Switchboard

A desktop softphone for Windows. Point it at any phone system that accepts SIP
over WebSocket (WebRTC) and it registers as one of your phones: dial pad,
incoming calls, hold, mute, touch tones, contacts, tray icon and notifications.

If your phone system also has a compatible account API (see *The account
API* below), sign in to it and Switchboard adds the rest of your line: text
messages (SMS/MMS), call history with recordings, voicemail, photos, and local
AI triage of incoming texts. Without one it is a phone and nothing more.

Triage drafts replies but never sends them on its own: drafts wait in a review
queue. The command-line tools send only with an explicit `--send`, and
auto-reply (`autoreply.json`) is off and dry-run by default.

## Install and run

```bash
npm install
Switchboard.bat     # or: npm start
npm run smoke       # headless self-test: boots, renders, checks tray + notifications, exits
```

Settings has a **Desktop shortcut** button that puts an icon on your desktop
(`npx electron . --create-shortcut` does the same from a terminal).

## First-run setup

The first launch opens straight into setup, and no other page is reachable
until it is done. Three steps, in order:

1. **Servers**
   - **SIP realm (domain)**, required. The domain your phones register to. It
     is also the account realm used to sign in.
   - **WebSocket server**, required. SIP over WebSocket: `wss://…` (`ws://`
     only for a host on your local network). **Test** tries to connect from the
     app and reports within a few seconds whether the server answered.
   - **STUN server**, optional. `stun:host[:port]` or `stuns:host[:port]`.
   - **API server**, optional. The `https://` address of the account API.
     Leave it blank to use Switchboard as a phone only (see below).
   - **Advanced**, all optional; the boxes show what is used when left blank:
     - *Events server*: `wss://` live-events socket. Blank means no live
       events; new messages are picked up by polling instead.
     - *Messaging server*: `https://` address for sending texts. Blank means
       the API server.
     - *Media server*: where MMS pictures are fetched from. Blank means the
       messaging server's standard media path.
2. **Account login**: the username and password of your account on the API
   server. Only asked for when an API server is set; otherwise the step shows
   as *Skipped*. The server has to accept the login before it is saved.
3. **Phone device**: the SIP username and password of a device (endpoint) on
   your phone system. Under *Advanced*, an **authorization username** for
   systems where it differs from the SIP username (blank uses the SIP
   username).

**Finish** opens your start page (Settings → General).

Everything is editable later on the **Account** page, which is the same three
sections outside setup. Changing the API server or the realm signs you out of
the account; if a login is saved, Switchboard signs straight back in with it.
Clearing the API server also forgets the login. Changing the API server to a
different host also blanks the Advanced events, messaging and media servers
you didn't edit in the same save. Saving the phone device restarts the phone
and shows its registration state.

Passwords are write-only: once saved they are never shown again. Type a new
one to change it, or leave the box blank to keep the saved one.

### Phone-only mode

With no API server Switchboard is a softphone. You get the phone, the dial
pad, **Contacts** (your own roster in `contacts.json`), **Settings** and
**Account**. Messages, Calls, Voicemail, Photos, Triage and Insights are
hidden from the sidebar and the tray menu, along with the settings that only
apply to them (Lines, Triage & AI, Daily recap, Downloads, message
notifications and sounds). Their addresses redirect to Contacts and their API
endpoints answer `409 { code: 'no-account' }`.

With an API server set but not signed in, it depends on whether a login is
saved. With a saved login that is failing to sign in (for example after a
password change), the same happens: the data pages redirect to Contacts, and
they come back as soon as a sign-in succeeds. After **Sign out** there is no
saved login, so every page goes to Account until you sign in again or clear
the API server.

There is no local call history in phone-only mode.

### Start over

Account → **Start over** (asks first) clears the servers (including the realm
and API server, even if `.env` has them), the account login, the phone device
and the session, and returns to setup. AI keys, settings, lines and contacts
are kept. Settings → **Reset** is different: it resets
preferences only and never touches servers or logins.

## Where things are stored

Everything lives in the app folder unless noted.

| File | Holds | Protection |
|---|---|---|
| `profile.json` | The servers from step 1. Not secret. | Plain JSON. |
| `secrets.bin` | Account login, phone device username, password and authorization username, cloud AI keys. | Encrypted with Electron `safeStorage` (Windows DPAPI): only your Windows account on this PC can decrypt it. |
| `.token.json` | The account session token after sign-in. | Plain JSON, owner-only file mode. Deleted on sign-out and Start over. |
| `settings.json` | Settings page choices. | Plain JSON. |
| `lines.json`, `contacts.json` | Your phone numbers and your contact labels. | Plain JSON. |
| `queue.jsonl`, `events.jsonl`, `boxes.json`, `vm-cache.json`, `rec-cache.json`, `.cache\`, `reviews\` | Triage queue, raw events, your message boxes, transcripts, caches, recaps. | Plain. |
| `msg-cache.json` | Texts already shown in Messages, so the page opens instantly and only new messages are fetched. Cleared on sign-out or when the servers change. | Plain, owner-only. |

The key that decrypts `secrets.bin` sits in the app's Electron data folder,
`%APPDATA%\ooma-triage`. That is an older internal name, kept on purpose:
renaming the folder would lose the key and with it every saved login.

If `secrets.bin` can't be decrypted (for example while a second copy of the
app is running), a copy is kept as `secrets.bin.unreadable-<time>` before
anything overwrites it.

The plain `node server.mjs` server has no secure storage, so it has no setup
wizard and no phone; it signs in with `.env` and `.token.json` as before.

## Updating an existing install

Nothing to do. On the first launch of this version Switchboard migrates by
itself, and the migration is safe to run again (it only acts once):

- If there is no `profile.json` and the folder was already in use, it writes
  `profile.json` with the servers the previous version had built in. An
  existing install is recognised by its old saved logins or its old API host.
  Servers, login and phone device carry over unchanged, so setup does not
  appear (unless something was never saved, such as a phone device; then it
  opens at that step).
- A plain `.env` on a new install is not treated as an old install: setup
  opens at step 1.
- Saved credentials move to their new names inside `secrets.bin`, and the old
  entries are removed.
- New installs save downloaded photos to `Downloads\Switchboard Photos`. If
  no folder was chosen in Settings and `Downloads\Ooma Photos` already exists,
  that existing folder is kept as your download folder instead.
- The Windows launch-at-login entry moves to the new app id, on or off as it
  was.

## Sharing with coworkers

The easy way: send them the installer from the
[latest release](https://github.com/Dj2Swagittarius/switchboard/releases/latest)
(`Switchboard-Setup-<version>.exe`). Installed copies update themselves: they
check the releases at start and every 4 hours, download a newer version in the
background, and install it when Switchboard closes (or right away from the
tray's "Restart to update"). Copies from before 0.3.4 have no updater; install
0.3.4 once by hand and they update from then on.

### Releasing a new version

1. Bump `version` in `package.json` and commit.
2. Build and upload: `$env:GH_TOKEN = (gh auth token); npm run dist -- --publish always`.
   This publishes a GitHub release `v<version>` with the installer,
   its `.blockmap`, and `latest.yml` (what installed copies read).
3. Push the commit and tag: `git tag v<version>; git push; git push --tags`.

Running from a copied folder instead: copy the app folder, but leave out what is yours:

- `.env`, `.token.json` and `secrets.bin`: your logins and session.
  (`secrets.bin` can't be decrypted on another Windows account anyway.)
- `settings.json`: your preferences and folder paths.
- `lines.json`, `contacts.json`, `boxes.json`: your numbers, contacts and
  message boxes. They add their own lines in Settings → Lines.
- Queues and caches: `queue.jsonl`, `events.jsonl`, `vm-cache.json`,
  `rec-cache.json`, `msg-cache.json` (your texts), `.cache\`, `reviews\`, `exports\`, `backups\`, and any
  `*.log` / `*.out` files.

`profile.json` is safe to share. If they are on the same servers it fills in
step 1 for them; they still sign in with their own login and phone device.

They need `node_modules` too: copy it, or run `npm install`. Then
`Switchboard.bat`.

## Security model

- **Loopback only.** The local server listens on `127.0.0.1:8787` and nothing
  else. The app makes outbound connections only: no public URL, no tunnel, no
  inbound port.
- **Per-launch app key.** Electron generates a random key at launch, the
  hosted server reads it from `TRIAGE_APP_KEY`, and every request from the
  app's windows carries it (`X-App-Key`). `/api/account`, `/api/sip/config`
  and the settings endpoints refuse anything without it, so neither a browser
  tab nor another local program can read or change credentials or settings.
  A second app instance that *attaches* to an already-running server has a
  different key and is refused too; expected, not a bug.
- **Sandboxed windows.** Pages run sandboxed with context isolation and no
  Node access. SMS bodies and caller names are attacker-controlled; the pages
  render them as text, and the sandbox is the backstop if that ever regresses.
- **Locked navigation.** Windows can only navigate within the local origin.
  Other web links open in the default browser; `tel:` links go to Windows'
  default phone app; nothing else leaves the app.
- **Permissions.** Microphone and notifications are granted to the app's own
  pages only.
- **Secrets at rest** are DPAPI-encrypted (above); passwords never come back
  out through the UI.

## Desktop app

Electron shell around the same server and pages. Hosts `server.mjs`
in-process, or attaches if one is already running on :8787. Adds a tray icon
with an amber badge when triaged messages are waiting, native notifications on
new triaged messages and incoming calls, close-to-tray, and an opt-in
**Launch at login** checkbox in the tray menu. The tray's page list follows
the account: pages that need one are hidden in phone-only mode.

The **phone** (`/phone`) is SIP.js 0.21.1 `SimpleUser` over the WebSocket
server from setup, with the STUN server when one is set. It is a separate web
view layered over the main window, so a call survives moving between pages;
pages reach it over `BroadcastChannel('switchboard-phone')`. One call at a
time; mute, hold, in-band DTMF (RFC 4733).

**Make a call** (every page, `dialpad.js`) dials in-app when the phone is
registered, otherwise hands a `tel:` link to your default phone app.

## Layout and settings

Every page includes `nav.js`, a fixed left sidebar: sections with badges
(unread conversations, new voicemail, triage items waiting, from
`/api/badges`, cached 20s), then Settings, Make a call, and your primary line
(in phone-only mode, your SIP username) with the in-app phone's status.
During setup there is no sidebar.

`/settings` edits `settings.json` through `lib/settings.mjs`. Every key is
validated; values are read on each use, so changes apply without a restart.
Notably: triage can be switched off (it is the CPU-heavy part), photo
descriptions can be switched off, and the LM Studio address is restricted to
this PC or the local network so message content can't be pointed at the
internet. Actions only the app process can do (launch at login, folder
picker, opening a folder, theme) go through `globalThis.__triageHost`, set in
`electron/main.mjs`.

## Account features

These need an API server and a signed-in account.

- **/messages**: conversations per line, threads, replies (Enter sends),
  photos inline. Separate from triage. Only lines enabled in Settings → Lines
  (`lines.json`) appear or can send. MMS videos and voice memos play in the
  thread. Phones send them as 3GPP with AMR audio, which Chromium plays
  silently, so pressing play asks for `/api/media?…&play=1`: `lib/transcode.mjs`
  converts the audio to AAC with **ffmpeg** (video stream copied, result
  cached). Without ffmpeg on the PATH (or `FFMPEG_PATH`) the video plays
  without sound and the thread says so. ffmpeg only ever runs on play, with a
  forced input format, file-only protocol and a time limit (MMS comes from
  anyone).
- **/fax**: received and sent faxes for **your own fax box only** (the
  account's fax lists are company-wide; `lib/fax.mjs` filters received faxes
  by fax box and sent ones by your fax number, and refuses any other PDF).
  View or download each as a PDF; **Send a fax** takes a PDF and a number,
  asks first, and uploads with `PUT /faxes` (multipart: JSON details + PDF)
  from your fax box's number. (`PUT /faxes/outbox` is advertised but answers
  `405 invalid_method` on this platform.) Sent from the app, a fax is a job in
  `/faxes/outgoing` (tagged with your fax box); Sent lists those together with
  the outbox (faxes sent from the portal or by email), with Queued / Retrying
  (and why) / Sending / Sent / Failed. The platform won't hand back a queued
  job's document, so the app keeps a copy of each PDF it sends in
  `faxes\sent\` (gitignored; leave it out when sharing the folder); faxes sent
  before that have View/Download greyed out. Fax PDFs are fetched with
  `Accept: */*` because this platform answers `Accept: application/pdf` with 406.
- **/parked**: calls waiting in park slots, with Pick up.
- **/photos**: every photo across all conversations. Thumbnails are generated
  by Electron's `nativeImage` when hosted in the app (full images under plain
  Node). Downloads land in the folder chosen in Settings (default
  `Downloads\Switchboard Photos`) with readable names; zips via
  `/api/photos/zip` (GET one conversation, or form-POST `ids=`), max 300. The
  index reads every thread (~20s cold) and is cached with
  stale-while-revalidate.
- **/calls**: call history with playback and on-demand transcription.
- **/voicemail**: plays audio in place.
- **/insights**: call and message statistics and the morning recap.
- **Triage** (`/`): the review queue (see *AI triage*).

Calls and Voicemail both have **Call back**, which dials straight out through
the in-app phone when it's connected (and Settings → Phone → Use it for "Make a
call" is on); otherwise it hands a `tel:` link to your default phone app.

## AI triage

**Off by default**, like the morning recap: both need an AI platform, and
people without one shouldn't see them. While triage is off the Triage page is
gone from the sidebar and tray (`/` redirects to Messages), and new texts still
raise a plain notification (sender and a preview, no AI summary or urgency).
While the morning recap is off, Insights shows just the numbers (no recap, no
Triage mix). Turn either on in Settings → Triage & AI / Daily recap.

Plain notifications only announce texts newer than the newest one the previous
check saw, so start-up, switching a line on, or turning triage off never
replays old texts. If triage is on but the AI can't be reached, each new text
is still announced plainly (once) and triage keeps retrying it; when it later
succeeds, no second notification is raised.

When on, it watches inbound messages, describes photo attachments with a
vision model, classifies each message, drafts a reply and files it in a review
queue. **Triage instructions** (Settings → Triage & AI) can replace the
built-in prompt, which is shown greyed as the placeholder; a short fixed block
listing the answer fields is added after custom instructions. The AI platform
is chosen in Settings → Triage & AI:

- **LM Studio** (default) on `:1234` with **`google/gemma-4-e4b`** loaded, and
  nothing else.
- **Ollama** on `:11434` with a vision-capable model pulled.
- **Claude** or **OpenAI** with your own API key (stored encrypted in
  `secrets.bin`). These send every triaged message and photo to that
  provider; the local platforms keep everything on your machines. Voicemail
  transcription (Whisper) stays local either way.

Label senders with `node contacts.mjs` (see *Command-line tools*) or on the
Contacts page.

### Model choice: do not change casually

**One model does both triage and vision: `google/gemma-4-e4b`.**

Asking LM Studio for two different models in turn makes it evict and reload
between calls. Measured: a single message took **194 seconds** and the vision
call failed with `Model unloaded by user or API request`. One resident
multimodal model is ~15s per triage, ~3s per image.

- **`reasoning_effort: 'none'` is required.** Gemma-4 is a reasoning model.
  Left on, it spends its whole token budget on `reasoning_content` and returns
  empty `content`. Image description: 54s with reasoning, **3.3s without**.
- **Image size is irrelevant.** A 157KB JPEG is ~298 prompt tokens; latency is
  all generation. Do not add an image-resize dependency.
- `gpt-oss-20b` is faster on text (1.3s) but classified nearly everything as
  `other` and leaves no headroom for vision. `llava-llama-3-8b` writes florid
  captions useless for triage.

Startup deliberately skips the backlog (`--backlog=0`) because each message
costs ~15s; processing all history at once pins the machine for minutes.

## Command-line tools

The CLI tools run under plain Node, so they can't read `secrets.bin`.
`node auth.mjs` signs in with the login in `.env` and caches the session; the
other tools use that session. Server addresses come from `profile.json` (the
one the desktop app writes), with `.env`'s `OOMA_API_BASE` and
`OOMA_ACCOUNT_REALM` as the fallback for the API server and realm;
`auth.mjs` reads them the same way as the other tools. A CLI tool run before
the desktop app's first launch creates `profile.json` itself when it can. The
`OOMA_*` variable names are kept so existing `.env` files keep working. When
`profile.json` leaves the advanced servers blank, the `BLACKHOLE_URL`,
`OOMA_SEND_BASE` and `OOMA_MEDIA_BASE` environment variables stand in for the
events, messaging and media servers.

1. `cp .env.example .env`, fill `OOMA_USERNAME` / `OOMA_PASSWORD`,
   `OOMA_API_BASE`, and one of `OOMA_ACCOUNT_REALM` / `OOMA_ACCOUNT_NAME` /
   `OOMA_PHONE_NUMBER`.
2. `node auth.mjs`: signs in and caches the session to `.token.json`
   (gitignored, 600).
3. `node contacts.mjs --sync`, then label senders.

```bash
node bot.mjs                  # live: watch, triage, queue. Sends nothing.
node bot.mjs --backlog=5      # also process the last 5 existing messages
node review.mjs               # list pending drafts
node review.mjs show 2        # full detail
node review.mjs send 2        # DRY RUN: prints the exact request
node review.mjs send 2 --send # actually transmit
node review.mjs reject 2
node sendtest.mjs +1XXXXXXXXXX "text"        # dry run; --send to transmit

node triage.mjs 10            # one-shot triage of recent history
node discover.mjs             # read-only map of reachable endpoints
node contacts.mjs             # roster; --sync to add unseen numbers
node contacts.mjs +1555… technician "Dave"
```

## The account API

Everything below describes the Kazoo-style (Crossbar REST + Blackhole events)
API that the account features talk to. It authenticates with an ordinary user
login. Identifiers such as `oomamsg.*` and `ooma_media` are that API's own
wire names and are kept as they are.

```
REST   <API server>/v2
  PUT  /user_auth                               md5(user:pass) + account_realm -> JWT
  GET  /accounts/{id}/messaging?localNumber=    history
  GET  /accounts/{id}/users/{owner}/cdrs        call legs
  GET  /accounts/{id}/vmboxes/{box}/messages    voicemail
POST   <messaging server>/v2/messaging          send (unscoped; the account-scoped
                                                path answers 500 "init failed")
GET    <media server>{id}/raw                   MMS bytes (X-Auth-Token header)

WS     <events server>                          Blackhole live events
  binding oomamsg.box.<id>                      inbound messages
SIP    <WebSocket server>                       the phone (SIP over WebSocket)
```

### Calls, recordings, voicemail

**CDRs are per leg, not per call.** Two traps, both of which made earlier
numbers wrong (Insights once showed 80 missed calls out of 93; the real figure
was 8 missed incoming out of 75):

- Every inbound call rings all of your devices in parallel. The devices that
  don't pick up log `hangup_cause: LOSE_RACE` with zero billed seconds. Those
  are not missed calls.
- Each leg's `direction` is from that leg's point of view, so a call *to* you
  appears as an `outbound` leg. Real direction comes from which side your own
  number/extension is on.
- Calls you place are logged `SUCCESS`, not `ANSWER`.

`lib/calls.mjs` groups legs by `interaction_id` and treats a call as connected
when any leg has billed time and isn't a lost race. Insights uses the same data.

Recording audio: `GET /v2/accounts/{id}/recordings/{media_recordings[0]}` with
`Accept: audio/mpeg`. Voicemail audio: `.../vmboxes/{box}/messages/{media}/raw`.
The server proxies both with Range support so seeking works, and validates ids
before they reach an upstream URL.

Transcription (`lib/stt.mjs`) runs one job at a time, voicemail and recordings
alike, so Whisper never competes with itself or piles onto the LLM. Default
model is `base.en`; set `WHISPER_MODEL=small.en` for better accuracy at roughly
2-3x the time. Transcripts cache to `vm-cache.json` / `rec-cache.json`.

### Scoping: important

`GET /websockets` returns live sessions for the **whole tenant**, so a naive
sweep subscribes to colleagues' message boxes. `lib/boxes.mjs` identifies our
own session by its `ooma_mwi.mailbox.<presence_id>` binding, takes boxes from
that session only, and pins the result to `boxes.json`. Do not replace this
with a blanket `oomamsg.*` subscription.

### Message shape

`value` is a nested duplicate of the record; ignore it. The body is `text`.
`direction` is `IN`/`OUT`. MMS parts are in `media[]`, fetched from
`ooma_media_url + /raw`. The `/thumbnail` variant returns 403 on the account
this was built against. `lib/message.mjs` normalizes all of it.

### Secrets and redaction

The API echoes `auth_token` in every response body *and* inside MMS media URLs
(`?auth_token=…`). `redact()` in `lib/kazoo.mjs` strips both (object keys and
URL query strings) before anything is logged or printed. Keep it in the path.
Media fetches send the token as a header so it never enters a URL.

The JWT expires; `api()` re-authenticates in place on a 401 and mutates the
session object so long-lived holders pick up the new token.

### Not verified

- **The send body shape.** `POST` is the verb, but `buildBody()` in
  `lib/send.mjs` is an educated guess; confirming it means texting a real
  person. On a 400, the response names the fields it actually wants; correct
  `buildBody()` to match. Test against your own number first.
- **The Blackhole event payload.** No live event has been captured yet, so
  `bot.mjs` does not parse it: any `oomamsg` event triggers a shape-agnostic
  REST re-sync, with a 60s poll as backup. Raw events land in `events.jsonl`.
