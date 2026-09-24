// Signs in with your own account login (from .env) and caches a session token.
// Prints nothing secret — token is masked.
import { loadEnv, authenticate } from './lib/kazoo.mjs';
import * as profile from './lib/profile.mjs';

const env = loadEnv();
if (!env.OOMA_USERNAME || !env.OOMA_PASSWORD) {
  console.error('Fill OOMA_USERNAME and OOMA_PASSWORD in .env first.');
  process.exit(1);
}

// The servers saved in the app (profile.json) win over .env, as for the other tools.
const p = profile.get();
if (p.apiServer) env.OOMA_API_BASE = p.apiServer;
if (p.realm) env.OOMA_ACCOUNT_REALM = p.realm;

let session, attempts;
try { ({ session, attempts } = await authenticate(env)); }
catch (e) { console.error(e.message); process.exit(1); }

console.log('Auth attempts:');
for (const a of attempts) console.log(`  ${a.status}  ${a.label}${a.message ? '  — ' + a.message : ''}`);

if (!session) {
  console.error('\nAll attempts failed. Most likely the account scope is wrong.');
  console.error('Try a different OOMA_ACCOUNT_REALM / _NAME / _PHONE_NUMBER value in .env.');
  process.exit(1);
}

console.log('\nAuthenticated.');
console.log('  method     :', session.method);
console.log('  account_id :', session.account_id);
console.log('  owner_id   :', session.owner_id);
console.log('  auth_token : ' + session.auth_token.slice(0, 6) + '…(masked, saved to .token.json)');
