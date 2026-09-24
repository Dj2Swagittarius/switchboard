// Where things live.
//
// APP_DIR: the app's own files (code, pages, sounds). Read-only once the app is
// installed: it is inside resources\app.asar then.
// DATA_DIR: everything that belongs to the person using it: logins, settings,
// lines, contacts, message caches, logs, sent faxes. The desktop app sets
// SWITCHBOARD_DATA before any of this loads (an installed copy uses
// %APPDATA%\Switchboard). Unset (running from the project folder, the
// command-line tools), it is the project folder itself, as it always was.
// It is fixed for the life of the process.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = process.env.SWITCHBOARD_DATA || APP_DIR;
try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

export const dataPath = (...parts) => join(DATA_DIR, ...parts);
// A bundled file another program has to open (Python, say), which can't read
// inside app.asar: the installer keeps such files unpacked next to it.
export const unpackedPath = (...parts) => join(APP_DIR.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), ...parts);
