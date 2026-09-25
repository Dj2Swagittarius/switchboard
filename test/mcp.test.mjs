// Drives mcp/switchboard-mcp.mjs over stdio against a fake Switchboard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const TOKEN = 't'.repeat(64);
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
let server, port, seen = [];
before(async () => {
  server = createServer((req, res) => {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, body, client: req.headers['x-switchboard-client'] });
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{}'); }
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (req.url === '/api/connector/hello') return send(200, { ok: true });
      if (req.url === '/api/connector/instructions') return send(200, { triage: { instructions: 'BE BRIEF', schema:
        { type: 'object', properties: { urgency: { type: 'string', enum: ['low', 'high'] } }, required: ['urgency'] } },
        recap: { instructions: 'R', schema: { type: 'object' } } });
      if (req.url.startsWith('/api/connector/pending')) return send(200, { note: null, items: [{ id: 'm1', from: '+1555', known_role: 'customer',
        line: '+1999', at: '2026-09-25T10:00:00Z', text: 'help', history: [], media: [{ n: 0, mime: 'image/png', image: true }] }] });
      if (req.url.startsWith('/api/connector/media')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
      if (req.url.startsWith('/api/connector/triage')) {
        const j = JSON.parse(body);
        return j.urgency === 'high' ? send(200, { ok: true, remaining: 0 }) : send(400, { errors: ['urgency must be one of: low, high'] });
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

function start(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../mcp/switchboard-mcp.mjs', import.meta.url))],
    { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map(); let next = 1;
  createInterface({ input: child.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++; waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { rpc, stop: () => child.kill() };
}

test('initialize, tools, prompts, calls', async () => {
  const c = start({ SWITCHBOARD_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_TOKEN: TOKEN });
  try {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'switchboard');
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(seen.find(x => x.url === '/api/connector/hello')?.client, 't 1');
    const tools = (await c.rpc('tools/list', {})).result.tools;
    assert.deepEqual(tools.map(t => t.name), ['list_pending', 'save_triage', 'get_thread', 'get_day', 'save_recap']);
    assert.deepEqual(tools[1].inputSchema.required, ['id', 'urgency']);
    assert.ok(!tools.some(t => /send/.test(t.name)));

    const list = (await c.rpc('tools/call', { name: 'list_pending', arguments: {} })).result;
    assert.ok(!list.isError);
    assert.match(list.content[0].text, /BE BRIEF/);
    const img = list.content.find(b => b.type === 'image');
    assert.equal(img.data, PNG.toString('base64'));

    const bad = (await c.rpc('tools/call', { name: 'save_triage', arguments: { id: 'm1', urgency: 'meh' } })).result;
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /urgency must be one of/);
    const ok = (await c.rpc('tools/call', { name: 'save_triage', arguments: { id: 'm1', urgency: 'high' } })).result;
    assert.match(ok.content[0].text, /Saved\. 0 still waiting/);
    assert.deepEqual(JSON.parse(seen.at(-1).body), { urgency: 'high' });

    const prompts = (await c.rpc('prompts/list', {})).result.prompts.map(p => p.name);
    assert.deepEqual(prompts, ['triage-inbox', 'daily-recap']);
    const p = (await c.rpc('prompts/get', { name: 'daily-recap', arguments: { date: '2026-09-24' } })).result;
    assert.match(p.messages[0].content.text, /2026-09-24/);
    assert.equal((await c.rpc('nope/method', {})).error.code, -32601);
  } finally { c.stop(); }
});

test('wrong token and app not running give plain messages', async () => {
  const bad = start({ SWITCHBOARD_URL: `http://127.0.0.1:${port}`, SWITCHBOARD_TOKEN: 'wrong' });
  try {
    const r = (await bad.rpc('tools/call', { name: 'list_pending', arguments: {} })).result;
    assert.match(r.content[0].text, /token changed/);
  } finally { bad.stop(); }
  const down = start({ SWITCHBOARD_URL: 'http://127.0.0.1:1', SWITCHBOARD_TOKEN: TOKEN });
  try {
    const r = (await down.rpc('tools/call', { name: 'list_pending', arguments: {} })).result;
    assert.match(r.content[0].text, /isn't running/);
    assert.equal((await down.rpc('tools/list', {})).result.tools.length, 5);
  } finally { down.stop(); }
});
