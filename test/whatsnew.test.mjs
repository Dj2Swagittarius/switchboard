// lib/whatsnew.mjs decides at load time whether this is a fresh install, so
// each case runs in its own process against its own throwaway data folder.
import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOD = new URL('../lib/whatsnew.mjs', import.meta.url).href;
const { version: NOW } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function run(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'switchboard-test-'));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const w = await import(${JSON.stringify(MOD)}); console.log(JSON.stringify(w.pending()));`],
    { env: { ...process.env, SWITCHBOARD_DATA: dir }, encoding: 'utf8' });
  return { notes: JSON.parse(out), dir };
}
const seenIn = (dir) => JSON.parse(readFileSync(join(dir, 'seen-version.json'), 'utf8')).version;

test('changelog has an entry for the current version', async () => {
  const w = await import('../lib/whatsnew.mjs');
  assert.ok(w.changelog().find(e => e.version === NOW)?.changes?.length);
});

test('fresh install: no popup, version recorded', () => {
  const { notes, dir } = run();
  assert.equal(notes, null);
  assert.equal(seenIn(dir), NOW);
});

test('install from before this feature: current notes only', () => {
  const { notes } = run({ 'profile.json': '{}' });
  assert.equal(notes.version, NOW);
  assert.deepEqual(notes.entries.map(e => e.version), [NOW]);
});

test('upgrade: every version since the last one seen', () => {
  const { notes } = run({ 'profile.json': '{}', 'seen-version.json': JSON.stringify({ version: '0.3.7' }) });
  assert.ok(notes.entries.length >= 2);
  assert.equal(notes.entries[0].version, NOW);
  assert.ok(!notes.entries.some(e => e.version === '0.3.7'));
});

test('already seen: nothing', () => {
  const { notes } = run({ 'profile.json': '{}', 'seen-version.json': JSON.stringify({ version: NOW }) });
  assert.equal(notes, null);
});

test('compare orders versions numerically', async () => {
  const { compare } = await import('../lib/whatsnew.mjs');
  assert.ok(compare('0.3.10', '0.3.9') > 0);
  assert.ok(compare('0.4.0', '0.3.99') > 0);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
});
