import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../lib/schema.mjs';
const { TRIAGE_SCHEMA } = await import('../lib/llm.mjs');
const { RECAP_SCHEMA } = await import('../lib/review.mjs');

const good = { category: 'billing', urgency: 'high', from_role: 'customer', summary: 's',
  needs_human: true, reason: 'r', suggested_reply: '' };

test('valid triage answer passes', () => assert.deepEqual(validate(TRIAGE_SCHEMA, good), []));
test('missing field', () => {
  const { reason, ...rest } = good;
  assert.deepEqual(validate(TRIAGE_SCHEMA, rest), ['reason is missing']);
});
test('bad enum', () => assert.match(validate(TRIAGE_SCHEMA, { ...good, urgency: 'meh' })[0], /^urgency must be one of/));
test('extra key', () => assert.deepEqual(validate(TRIAGE_SCHEMA, { ...good, x: 1 }), ['x is not allowed']));
test('wrong type', () => assert.deepEqual(validate(TRIAGE_SCHEMA, { ...good, needs_human: 'yes' }), ['needs_human must be a boolean']));
test('not an object', () => assert.deepEqual(validate(TRIAGE_SCHEMA, null), ['answer must be an object']));
test('nested array item', () => {
  const recap = { headline: 'h', overview: 'o', notable: [], watch: [],
    follow_ups: [{ who: 'a', number: '1', what: 'w', why: 'y', priority: 'urgent', source: 'text' }] };
  assert.match(validate(RECAP_SCHEMA, recap)[0], /^follow_ups\[0\]\.priority must be one of/);
});
