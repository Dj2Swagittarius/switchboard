// The Claude Code platform: runs the Claude Code app installed on this PC
// (`claude -p`, headless) for each AI job, on the person's own Claude plan.
// No API key is stored here; Claude Code keeps its own sign-in.
//
// Each call is one short-lived process in an empty temp folder, with every
// tool off (Read only, for a photo), no MCP servers, no project or user
// settings and nothing saved as a session, so it can only answer the prompt.
// Calls run one at a time: a burst of texts queues instead of starting a dozen
// processes.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { TooLongError } from './ai.mjs';

export const MODELS = ['sonnet', 'opus', 'haiku'];
const TIMEOUT = 120e3;
const WIN = process.platform === 'win32';
const NOT_FOUND = 'Claude Code isn\'t installed on this PC. Install it (claude.com/claude-code), sign in once, then try again.';

// The native claude executable. The npm install's claude.cmd shim can't be
// started safely without a shell, so only the native one counts.
// SWITCHBOARD_CLAUDE overrides (tests point it at a stub script).
export function find() {
  const forced = process.env.SWITCHBOARD_CLAUDE;
  if (forced) return existsSync(forced) ? forced : null;
  const name = WIN ? 'claude.exe' : 'claude';
  const home = join(homedir(), '.local', 'bin', name);
  if (existsSync(home)) return home;
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

// A .mjs/.js stub runs under this process's own Node (tests only).
function command(exe, args) {
  return /\.m?js$/i.test(exe) ? [process.execPath, [exe, ...args]] : [exe, args];
}

let chain = Promise.resolve();
function serial(fn) {
  const r = chain.then(fn, fn);
  chain = r.catch(() => {});
  return r;
}

function run(args, input, cwd) {
  const exe = find();
  if (!exe) return Promise.reject(new Error(NOT_FOUND));
  const [cmd, argv] = command(exe, args);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: exe.endsWith('js') ? '1' : undefined } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude Code took longer than 2 minutes and was stopped.')); }, TIMEOUT);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('Could not start Claude Code: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out); } catch {}
      if (!j) return reject(new Error(`Claude Code ${code ? 'failed' : 'gave no answer'}: ${(err || out).trim().slice(0, 240) || 'no output'}`));
      if (j.is_error) {
        const why = String(j.result ?? j.subtype ?? 'unknown error');
        if (/too long|context (window|limit)|max_tokens/i.test(why)) return reject(new TooLongError('Claude Code: ' + why.slice(0, 200)));
        if (/login|log in|api key|auth/i.test(why)) return reject(new Error('Claude Code isn\'t signed in. Open Claude Code once and sign in. (' + why.slice(0, 120) + ')'));
        return reject(new Error('Claude Code: ' + why.slice(0, 240)));
      }
      resolve(j);
    });
    child.stdin.end(input);
  });
}

// Settings no user or project config can change: no tools, no MCP servers.
const LOCKED = ['--no-session-persistence', '--strict-mcp-config', '--setting-sources', ''];

function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-claude-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
}

export function json({ system, user, schema, model }) {
  return serial(() => inTemp(async (dir) => {
    const j = await run(['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--system-prompt', system, '--model', model, '--tools', '', ...LOCKED], user, dir);
    if (j.structured_output && typeof j.structured_output === 'object') return j.structured_output;
    try { return JSON.parse(j.result); } catch {}
    throw new Error('Claude Code did not answer in the expected format.');
  }));
}

const EXT = { 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
export function vision({ prompt, image, model }) {
  return serial(() => inTemp(async (dir) => {
    const name = 'photo' + (EXT[image.mime] ?? '.jpg');
    writeFileSync(join(dir, name), image.buf);
    const j = await run(['-p', '--output-format', 'json', '--model', model,
      '--tools', 'Read', '--allowedTools', 'Read', ...LOCKED],
      `${prompt}\n\nThe photo is the file ${name} in the current folder. Read it, then answer with the description only.`, dir);
    return String(j.result ?? '').trim();
  }));
}

// For Settings: installed, and which version.
export function status() {
  const exe = find();
  if (!exe) return Promise.resolve({ ok: false, error: NOT_FOUND });
  const [cmd, argv] = command(exe, ['--version']);
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: 5000, windowsHide: true }, (e, stdout) => {
      if (e) return resolve({ ok: false, error: 'Claude Code didn\'t start: ' + e.message.slice(0, 160) });
      resolve({ ok: true, version: String(stdout).trim().split(/\s/)[0], path: exe });
    });
  });
}
