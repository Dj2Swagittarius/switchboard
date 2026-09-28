import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SWITCHBOARD_CONNECTOR_TOKEN = 'a'.repeat(64);
const connector = await import('../lib/connector.mjs');
const store = await import('../lib/store.mjs');

const answer = { category: 'dispatch_request', urgency: 'urgent', from_role: 'customer',
  summary: 'Tech locked out', needs_human: true, reason: 'blocked', suggested_reply: 'On it.',
  situation: 'Tech at the gate, locked out.', open_items: ['gate code'], last_ask: 'code?', waiting_on: 'us' };

test('pending lists awaiting conversations oldest first', () => {
  store.upsert('c:5550001111', { remote: '+15550001111', at: 2, status: connector.AWAITING, known_role: 'technician' });
  store.upsert('c:5550002222', { remote: '+15550002222', at: 1, status: connector.AWAITING });
  store.upsert('c:5550003333', { remote: '+15550003333', at: 0 });
  assert.deepEqual(connector.pending().map(e => e.id), ['c:5550002222', 'c:5550001111']);
  assert.equal(connector.pending(1).length, 1);
});

test('saveTriage validates, applies, and uses the known role', () => {
  assert.equal(connector.saveTriage('nope', answer).code, 404);
  const bad = connector.saveTriage('c:5550001111', { ...answer, waiting_on: 'eh' });
  assert.equal(bad.code, 400);
  assert.match(bad.errors[0], /waiting_on/);
  const ok = connector.saveTriage('c:5550001111', answer);
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.from_role, 'technician');
  assert.equal('status' in ok.entry, false);
  assert.deepEqual(connector.pending().map(e => e.id), ['c:5550002222']);
  assert.ok(store.pending().some(e => e.id === 'c:5550001111' && e.summary === 'Tech locked out'));
});

test('a conversation asked for on request leaves the queue once answered', () => {
  store.upsert('c:5550004444', { remote: '+15550004444', at: 3, status: connector.AWAITING, keep_closed: true });
  assert.equal(connector.saveTriage('c:5550004444', answer).ok, true);
  assert.equal(store.all().find(e => e.id === 'c:5550004444').resolution, 'viewed');
});

test('authorized checks the bearer token', () => {
  assert.equal(connector.authorized({ headers: { authorization: 'Bearer ' + 'a'.repeat(64) } }), true);
  assert.equal(connector.authorized({ headers: { authorization: 'Bearer nope' } }), false);
  assert.equal(connector.authorized({ headers: {} }), false);
});

test('Claude Desktop bundle unzips to a valid manifest and the script', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const script = readFileSync(new URL('../mcp/switchboard-mcp.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-test-mcpb-'));
  writeFileSync(join(dir, 'x.zip'), connector.desktopBundle({ url: 'http://127.0.0.1:8787', version: '1.2.3', script }));
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${join(dir, 'x.zip')}' -DestinationPath '${join(dir, 'out')}'`]);
  const m = JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8'));
  assert.equal(m.manifest_version, '0.3');
  assert.equal(m.server.entry_point, 'server/switchboard-mcp.mjs');
  assert.deepEqual(m.server.mcp_config.args, ['${__dirname}/server/switchboard-mcp.mjs']);
  assert.equal(m.server.mcp_config.env.SWITCHBOARD_TOKEN, 'a'.repeat(64));
  assert.ok(readFileSync(join(dir, 'out', 'server', 'switchboard-mcp.mjs')).equals(script));
});

test('status reports the last Claude app and a newer rejected token', () => {
  assert.equal(connector.status().last, null);
  connector.noteContact({ headers: { 'x-switchboard-client': 'claude-ai 0.14.1' } }, 'hello');
  let s = connector.status();
  assert.equal(s.ready, true);
  assert.equal(s.last.app, 'Claude Desktop');
  assert.equal(s.last.did, 'connected');
  assert.equal(s.rejected, null);
  connector.authorized({ headers: { authorization: 'Bearer old', 'x-switchboard-client': 'claude-code 2.1' } });
  s = connector.status();
  assert.equal(s.rejected.app, 'Claude Code');
  connector.noteContact({ headers: { 'x-switchboard-client': 'claude-code 2.1' } }, 'triage');
  s = connector.status();
  assert.equal(s.rejected, null);
  assert.equal(s.last.did, 'saved triage');
});
