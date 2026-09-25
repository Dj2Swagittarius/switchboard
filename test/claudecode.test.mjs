import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
process.env.SWITCHBOARD_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const cc = await import('../lib/claudecode.mjs');
const ai = await import('../lib/ai.mjs');
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
const mode = (m) => { process.env.FAKE_CLAUDE = m; };

test('json returns structured_output; no tools; prompt on stdin', async () => {
  mode('ok');
  const r = await cc.json({ system: 's', user: 'hello there', schema, model: 'haiku' });
  assert.deepEqual(r, { ok: true, echo: 'hello there', keys: ['ok'], tools: '', model: 'haiku' });
});
test('vision passes the photo file and Read', async () => {
  mode('vision');
  const r = await cc.vision({ prompt: 'Describe', image: { mime: 'image/png', buf: Buffer.from('x') }, model: 'sonnet' });
  assert.equal(r, 'A red pump. true true');
});
test('errors are readable', async () => {
  mode('login');
  await assert.rejects(cc.json({ system: 's', user: 'u', schema, model: 'm' }), /isn't signed in/);
  mode('long');
  await assert.rejects(cc.json({ system: 's', user: 'u', schema, model: 'm' }), ai.TooLongError);
  mode('garbage');
  await assert.rejects(cc.json({ system: 's', user: 'u', schema, model: 'm' }), /Claude Code failed: boom/);
});
test('calls run one at a time and a failure does not block the next', async () => {
  mode('ok');
  const rs = await Promise.allSettled([1, 2, 3].map(i => cc.json({ system: 's', user: 'u' + i, schema, model: 'm' })));
  assert.deepEqual(rs.map(r => r.value.echo), ['u1', 'u2', 'u3']);
});
test('status reports the version', async () => {
  assert.equal((await cc.status()).version, '9.9.9');
  process.env.SWITCHBOARD_CLAUDE = 'C:/nope/claude.exe';
  assert.match((await cc.status()).error, /isn't installed/);
});

test('addMcp removes the old entry, then adds with env flags', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  process.env.SWITCHBOARD_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
  const log = join(mkdtempSync(join(tmpdir(), 'switchboard-test-')), 'calls.log');
  process.env.FAKE_CLAUDE_LOG = log;
  await cc.addMcp({ name: 'switchboard', env: { A: '1', B: 'x y' }, command: 'C:/Apps/Switch board.exe', args: ['C:/x/mcp.mjs'] });
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['mcp', 'remove', 'switchboard', '-s', 'user']);
  assert.deepEqual(calls[1], ['mcp', 'add', 'switchboard', '--scope', 'user', '-e', 'A=1', '-e', 'B=x y', '--', 'C:/Apps/Switch board.exe', 'C:/x/mcp.mjs']);
});
