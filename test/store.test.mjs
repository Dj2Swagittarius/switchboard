import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const store = await import('../lib/store.mjs');

test('update merges, drops undefined keys, null for unknown', () => {
  store.add({ id: 'a1', status: 'awaiting_triage', text: 'hi' });
  const e = store.update('a1', { urgency: 'low', status: undefined });
  assert.equal(e.urgency, 'low');
  assert.equal('status' in e, false);
  assert.equal(store.all().find(x => x.id === 'a1').urgency, 'low');
  assert.equal(store.update('nope', { a: 1 }), null);
});
