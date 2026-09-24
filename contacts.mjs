// Bootstrap and inspect the contact roster.
//   node contacts.mjs            list
//   node contacts.mjs --sync     add unseen numbers from message history
//   node contacts.mjs +1555… technician "Dave"   set a role
import { loadSession, api } from './lib/kazoo.mjs';
import { normalize, mask } from './lib/message.mjs';
import { load, save, bootstrap, lookup, ROLES } from './lib/contacts.mjs';

const args = process.argv.slice(2);
const s = loadSession();

if (args[0]?.startsWith('+') && args[1]) {
  const [number, role, ...name] = args;
  if (!ROLES.includes(role)) { console.error(`role must be one of: ${ROLES.join(', ')}`); process.exit(1); }
  const roster = load();
  const k = number.replace(/[^\d+]/g, '');
  roster[k] = { ...(roster[k] ?? {}), role, name: name.join(' ') || (roster[k]?.name ?? '') };
  save(roster);
  console.log(`set ${mask(k)} -> ${role}${roster[k].name ? ' (' + roster[k].name + ')' : ''}`);
  process.exit(0);
}

if (args.includes('--sync')) {
  const me = (await api(s, `/users/${s.owner_id}`)).body.data;
  const raw = (await api(s, `/messaging?localNumber=${encodeURIComponent(me.phone_number)}`)).body.data ?? [];
  const { added } = bootstrap(raw.map(normalize));
  console.log(`synced — ${added} new number(s) added as "unknown"`);
}

const roster = load();
const entries = Object.entries(roster);
console.log(`${entries.length} contact(s)\n`);
for (const [num, c] of entries)
  console.log(`  ${mask(num).padEnd(16)} ${(c.role ?? 'unknown').padEnd(11)} ${c.name || ''}`);
if (entries.some(([, c]) => c.role === 'unknown'))
  console.log(`\nLabel them:  node contacts.mjs <number> <${ROLES.join('|')}> [name]`);
