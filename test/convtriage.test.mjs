import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const store = await import('../lib/store.mjs');
const photonotes = await import('../lib/photonotes.mjs');

test('upsert creates, merges, and reopens', () => {
  store.upsert('c:5550001111', { remote: '+15550001111', urgency: 'low' });
  store.resolve('c:5550001111', 'replied');
  const e = store.upsert('c:5550001111', { urgency: 'high', resolution: undefined, resolved_at: undefined });
  assert.equal(e.urgency, 'high');
  assert.equal(e.remote, '+15550001111');
  assert.equal('resolution' in e, false);
  assert.ok(store.pending().some(x => x.id === 'c:5550001111'));
});

test('photo notes round-trip', () => {
  assert.equal(photonotes.get('m1'), null);
  photonotes.set('m1', ['a ladder', 'a gate']);
  assert.deepEqual(photonotes.get('m1'), ['a ladder', 'a gate']);
  assert.deepEqual(photonotes.all().m1, ['a ladder', 'a gate']);
});

const llm = await import('../lib/llm.mjs');
test('conversation schema and instructions', () => {
  const req = llm.CONVERSATION_SCHEMA.required;
  for (const k of ['summary', 'situation', 'open_items', 'last_ask', 'waiting_on', 'urgency', 'suggested_reply'])
    assert.ok(req.includes(k), k);
  assert.match(llm.conversationInstructions(), /whole SMS conversation/);
});

const ct = await import('../lib/convtriage.mjs');
const M = (id, at, inbound, text, media = []) => ({ id, at, inbound, text, media });

test('ids, transcript, recent, replied, stale', () => {
  assert.equal(ct.convId('+1 (555) 000-1111'), 'c:5550001111');
  const msgs = [M('a', Date.UTC(2026, 8, 28, 9), true, 'gate locked'),
                M('b', Date.UTC(2026, 8, 28, 10), false, 'sending someone'),
                M('c', Date.UTC(2026, 8, 28, 11), true, '', [{ id: 'x1', mime: 'image/jpeg' }])];
  const t = ct.transcript(msgs, { c: ['a broken gate'] });
  assert.match(t, /THEM: gate locked/);
  assert.match(t, /US: sending someone/);
  assert.match(t, /\[image 1: a broken gate\]/);
  assert.match(ct.transcript(msgs, {}), /\[1 photo attached\]/);
  assert.deepEqual(ct.recent(msgs, {}).map(r => r.text), ['[1 photo attached]']);
  assert.equal(ct.replied(msgs), false);
  assert.equal(ct.replied(msgs.slice(0, 2)), true);
  assert.equal(ct.stale(null, msgs), true);
  assert.equal(ct.stale({ through_at: msgs[2].at }, msgs), false);
});

test('migrate merges old per-message entries; closeReplied closes answered ones', () => {
  store.add({ id: 'old-msg', remote: '+15550002222' });
  store.upsert('c:5550003333', { remote: '+15550003333' });
  ct.migrate();
  assert.equal(store.all().find(e => e.id === 'old-msg').resolution, 'merged');
  const threads = new Map([['+15550003333', [M('q', 1, true, 'hi'), M('r', 2, false, 'hello')]]]);
  assert.equal(ct.closeReplied(threads), 1);
  assert.equal(store.all().find(e => e.id === 'c:5550003333').resolution, 'replied');
});

test('closeReplied leaves a conversation asked of Claude on request', () => {
  store.upsert('c:5550005555', { remote: '+15550005555', status: ct.AWAITING, keep_closed: true });
  const threads = new Map([['+15550005555', [M('s', 1, false, 'fyi')]]]);
  assert.equal(ct.closeReplied(threads), 0);
});
