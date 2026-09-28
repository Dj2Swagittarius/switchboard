import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { clean, suggest } = await import('../lib/suggest.mjs');

test('clean keeps three distinct trimmed replies', () => {
  assert.deepEqual(clean(['  Yes,  on my way ', '"Yes, on my way"', '', 'What time works?', 'Not yet', 'Extra']),
    ['Yes, on my way', 'What time works?', 'Not yet']);
  assert.deepEqual(clean(null), []);
});

test('nothing to suggest when we spoke last', async () => {
  assert.deepEqual(await suggest('+15550001111', [{ id: 'a', at: 1, inbound: false, text: 'hi', media: [] }]), []);
  assert.deepEqual(await suggest('+15550001111', []), []);
});
