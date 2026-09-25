import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Stands in for the claude CLI. FAKE_CLAUDE picks the behaviour.
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const args = process.argv.slice(2);
  const mode = process.env.FAKE_CLAUDE || 'ok';
  if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); return; }
  if (args[0] === 'mcp') {
    const log = process.env.FAKE_CLAUDE_LOG;
    if (log) require('node:fs').appendFileSync(log, JSON.stringify(args) + String.fromCharCode(10));
    if (args[1] === 'remove') { process.stderr.write('No MCP server found'); process.exit(1); }
    return;
  }
  const out = (j) => process.stdout.write(JSON.stringify({ type: 'result', ...j }));
  if (mode === 'ok') {
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]);
    return out({ is_error: false, result: '', structured_output: { ok: true, echo: input, keys: Object.keys(schema.properties),
      tools: args[args.indexOf('--tools') + 1], model: args[args.indexOf('--model') + 1] } });
  }
  if (mode === 'vision') return out({ is_error: false, result: '  A red pump. ' + args.includes('Read') + ' ' + /photo\.png/.test(input) + '  ' });
  if (mode === 'login') return out({ is_error: true, result: 'Invalid API key · Please run /login' });
  if (mode === 'long') return out({ is_error: true, result: 'Prompt is too long' });
  if (mode === 'garbage') { process.stderr.write('boom'); process.exit(3); }
});
