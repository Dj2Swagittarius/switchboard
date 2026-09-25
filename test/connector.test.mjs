import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SWITCHBOARD_CONNECTOR_TOKEN = 'a'.repeat(64);
const connector = await import('../lib/connector.mjs');
const store = await import('../lib/store.mjs');

const msg = (id, at, text = 'Tech stuck at site, gate locked') =>
  ({ id, remote: '+15550001111', local: '+15559990000', at, inbound: true, forModel: () => text });
const answer = { category: 'dispatch_request', urgency: 'urgent', from_role: 'customer',
  summary: 'Tech locked out', needs_human: true, reason: 'blocked', suggested_reply: 'On it.' };

test('entryFor builds an awaiting entry with history and media refs', () => {
  const e = connector.entryFor(msg('m1', 2), { history: [msg('m0', 1, 'earlier')],
    contact: { name: 'Sam', role: 'technician' },
    rawMedia: [{ ooma_media_url: 'https://media/x', media: { mime_type: 'image/jpeg' } }] });
  assert.equal(e.status, connector.AWAITING);
  assert.equal(e.known_role, 'technician');
  assert.deepEqual(e.history, [{ at: 1, inbound: true, text: 'earlier' }]);
  assert.deepEqual(e.media, [{ url: 'https://media/x', mime: 'image/jpeg' }]);
  store.add(e);
});

test('pending lists awaiting entries oldest first', () => {
  store.add(connector.entryFor(msg('m-old', 1)));
  store.add({ id: 'done', status: undefined, at: 0 });
  assert.deepEqual(connector.pending().map(e => e.id), ['m-old', 'm1']);
  assert.equal(connector.pending(1).length, 1);
});

test('saveTriage validates, applies, and uses the known role', () => {
  assert.equal(connector.saveTriage('nope', answer).code, 404);
  const bad = connector.saveTriage('m1', { ...answer, urgency: 'eh' });
  assert.equal(bad.code, 400);
  assert.match(bad.errors[0], /urgency/);
  const ok = connector.saveTriage('m1', answer);
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.urgency, 'urgent');
  assert.equal(ok.entry.from_role, 'technician');
  assert.equal('status' in ok.entry, false);
  assert.equal('media' in ok.entry, false);
  assert.deepEqual(connector.pending().map(e => e.id), ['m-old']);
  // In the triage queue as an ordinary entry.
  assert.ok(store.pending().some(e => e.id === 'm1' && e.summary === 'Tech locked out'));
});

test('authorized checks the bearer token', () => {
  assert.equal(connector.authorized({ headers: { authorization: 'Bearer ' + 'a'.repeat(64) } }), true);
  assert.equal(connector.authorized({ headers: { authorization: 'Bearer nope' } }), false);
  assert.equal(connector.authorized({ headers: {} }), false);
});
