// Read-only. What webhook event types exist, what apps are installed,
// and where does messaging actually live?
import { loadSession, api } from './lib/kazoo.mjs';
const s = loadSession();

console.log('=== available webhook event types (system) ===');
const hooks = await api(s, `${s.base}/v2/webhooks`);
if (Array.isArray(hooks.body?.data)) {
  for (const h of hooks.body.data)
    console.log(`  ${(h.id ?? h.name ?? '?').padEnd(24)} ${h.description ?? ''}`);
} else console.log(' ', hooks.status, JSON.stringify(hooks.body)?.slice(0, 200));

console.log('\n=== installed apps (name -> id) ===');
const apps = await api(s, '/apps_store');
for (const a of (apps.body?.data ?? []))
  console.log(`  ${(a.name ?? '?').padEnd(22)} ${a.label ?? ''}`);

console.log('\n=== messaging endpoint hunt ===');
const owner = s.owner_id;
for (const p of [
  '/sms?paginate=false', `/users/${owner}/sms`, '/messaging', '/notify',
  '/chat', '/im', '/threads', '/sms_messages', '/text_messages',
  `/users/${owner}/devices`, '/service_plans', '/metaflows',
]) {
  const r = await api(s, p);
  console.log(`  ${String(r.status).padEnd(5)} ${p.padEnd(34)} ${r.body?.message ?? (Array.isArray(r.body?.data) ? r.body.data.length + ' item(s)' : 'ok')}`);
}
