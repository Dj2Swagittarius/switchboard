// Shared speech-to-text (local faster-whisper) and structured LLM calls.
//
// Transcriptions run strictly one at a time. Whisper and the LLM compete for
// the same CPU/GPU; letting voicemail and call-recording jobs overlap is the
// same thrash that once made a single triage take 194 seconds.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MODELS } from './llm.mjs';
import * as ai from './ai.mjs';
import * as settings from './settings.mjs';
import { unpackedPath } from './paths.mjs';

const run = promisify(execFile);
const NL = String.fromCharCode(10);
export const whisperModel = () => settings.get('triage.whisperModel');

// Node does not resolve bare "python" on Windows the way a shell does.
function pythonPath() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const local = process.env.LOCALAPPDATA ?? '';
  for (const v of ['Python313', 'Python312', 'Python311']) {
    const p = join(local, 'Programs', 'Python', v, 'python.exe');
    if (existsSync(p)) return p;
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}
const PY = pythonPath();

let chain = Promise.resolve();
const serial = (fn) => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

export function whisper(buf, { ext = '.mp3', model = whisperModel() } = {}) {
  return serial(async () => {
    const dir = join(tmpdir(), 'switchboard-stt');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, randomUUID() + ext);
    try {
      writeFileSync(file, buf);
      const { stdout } = await run(PY, [unpackedPath('transcribe.py'), file, model],
        { cwd: dir, maxBuffer: 16e6, timeout: 15 * 60e3 });
      const t = JSON.parse(stdout.trim().split(NL).pop());
      if (t.error) throw new Error(t.error);
      return t;
    } finally {
      try { rmSync(file, { force: true }); } catch {}
    }
  });
}

// One structured completion on the chosen AI platform (lib/ai.mjs).
export async function llmJson({ system, user, schema, name, model = MODELS.triage }) {
  return ai.json({ system, user, schema, name, model });
}
