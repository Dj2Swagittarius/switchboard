// npm run release: build the installer for package.json's version and publish
// it as GitHub release v<version>, with the files installed copies update from
// (installer, .blockmap, latest.yml).
//
// electron-builder's own --publish runs two uploaders that race to create the
// release; the loser fails with 422 "already_exists" before latest.yml is
// written. So build with publishing off and upload everything in one go.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = 'v' + version;

if (out('git', ['status', '--porcelain'])) throw new Error('Commit your changes first.');
// The notes installed copies show after updating (lib/whatsnew.mjs) double as
// the release notes.
const entry = JSON.parse(readFileSync(join(root, 'changelog.json'), 'utf8')).find(e => e.version === version);
if (!entry?.changes?.length) throw new Error(`Add a changelog.json entry for ${version} first.`);
const notes = entry.changes.map(c => '- ' + c).join('\n');
try { out('gh', ['release', 'view', tag]); throw new Error(`${tag} is already released. Bump the version in package.json.`); }
catch (e) { if (e.message.includes('already released')) throw e; }

run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never']);

const exe = `dist/Switchboard-Setup-${version}.exe`;
const files = [exe, exe + '.blockmap', 'dist/latest.yml'];
for (const f of files) if (!existsSync(join(root, f))) throw new Error('missing ' + f);
if (!readFileSync(join(root, 'dist/latest.yml'), 'utf8').includes(`version: ${version}`))
  throw new Error('dist/latest.yml is not for ' + version);

run('git', ['push']);
// Through a file: run() goes through the shell on Windows, which would split
// the notes apart at spaces and quotes.
const notesFile = 'dist/release-notes.md';   // relative: the full path has a space
writeFileSync(join(root, notesFile), notes + '\n');
run('gh', ['release', 'create', tag, ...files, '--title', version, '--target', out('git', ['rev-parse', 'HEAD']), '--notes-file', notesFile]);
console.log(`\nReleased ${tag}. Installed copies pick it up within 4 hours (or at their next start).`);
