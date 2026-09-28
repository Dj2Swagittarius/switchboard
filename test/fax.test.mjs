import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { explain } = await import('../lib/fax.mjs');

test('fax failure codes read as plain words', () => {
  assert.match(explain('NORMAL_CLEARING', 0), /isn't a fax machine/);
  assert.match(explain('NORMAL_CLEARING', 2), /before the whole fax/);
  assert.equal(explain('USER_BUSY', 0), 'The line was busy.');
  assert.equal(explain('SOME_NEW_CAUSE'), 'Some new cause.');
  assert.equal(explain('Far end cannot receive at this resolution'), 'Far end cannot receive at this resolution');
  assert.equal(explain(''), '');
});
