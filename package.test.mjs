import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('.', import.meta.url);

test('package exposes one composite extension instead of only the drain hook', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, ['./index.ts']);
});

test('package entry preserves prompt refresh, upstream hooks, filtering and drain order', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hindsight-package-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const installed = join(home, '.hindsight/coding-agents');
  mkdirSync(join(installed, 'dist'), { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({
    name: '@vectorize-io/hindsight-coding-agents', version: '0.8.7', type: 'module',
  }));
  writeFileSync(join(installed, 'dist/pi.js'), `
    import { readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    export default function(pi) {
      pi.registerTool({ name: 'upstream-tool' });
      pi.on('before_agent_start', () => {
        const cache = JSON.parse(readFileSync(join(tmpdir(), 'hindsight-pi', 'package-test.json'), 'utf8'));
        if ('reflectAnswer' in cache || 'reflectAttempts' in cache) throw new Error('Refresh ran too late');
        globalThis.order.push('upstream-prompt');
        return { message: { customType: 'hindsight', content: globalThis.memory }, systemPrompt: 'preserved' };
      });
      pi.on('agent_end', () => globalThis.order.push('retain'));
      pi.on('session_shutdown', () => globalThis.order.push('upstream-shutdown'));
    }
  `);
  mkdirSync(join(home, '.config/hindsight'), { recursive: true });
  writeFileSync(join(home, '.config/hindsight/embedding-gateway.env'),
    'EMBEDDING_GATEWAY_TOKEN=test-control-token\n', { mode: 0o600 });
  const script = `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import extension from ${JSON.stringify(new URL('index.ts', root).href)};
    import { MEMORY_PREAMBLE } from ${JSON.stringify(new URL('relevance-gate.mjs', root).href)};
    const handlers = new Map(), tools = [], subscriptions = [];
    globalThis.order = [];
    globalThis.memory = MEMORY_PREAMBLE + 'The deployment color is violet.\\n</hindsight_memory>';
    const pi = {
      on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
      registerTool(tool) { tools.push(tool); },
      events: { on(name) { subscriptions.push(name); return () => {}; } },
    };
    globalThis.fetch = async (url, options) => {
      if (url === 'http://127.0.0.1:8890/control/drain') {
        assert.equal(options.headers.Authorization, 'Bearer test-control-token');
        assert.equal(globalThis.order.at(-1), 'upstream-shutdown');
        globalThis.order.push('drain');
        return new Response(JSON.stringify({ draining: true }), { status: 202 });
      }
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
      assert.equal(options.headers['x-goog-api-key'], 'test-google-key');
      globalThis.order.push('classify');
      const body = JSON.parse(options.body);
      return new Response(JSON.stringify({ answers: Object.fromEntries(
        Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.99 }])) }));
    };
    await extension(pi);
    assert.deepEqual(tools.map(tool => tool.name), ['upstream-tool']);
    assert.deepEqual(subscriptions, ['pi-multiprovider:service']);
    assert.equal(handlers.get('before_agent_start').length, 2);
    assert.equal(handlers.get('agent_end').length, 1);
    assert.equal(handlers.get('session_shutdown').length, 2);
    const ctx = {
      hasUI: false, sessionManager: { getSessionId: () => 'package-test', getBranch: () => [] },
      modelRegistry: { async getApiKeyForProvider(provider) { assert.equal(provider, 'google'); return 'test-google-key'; } },
    };
    const cachePath = join(tmpdir(), 'hindsight-pi', 'package-test.json');
    mkdirSync(join(tmpdir(), 'hindsight-pi'), { recursive: true });
    for (let turn = 0; turn < 2; turn++) {
      writeFileSync(cachePath, JSON.stringify({ reflectAnswer: 'stale', reflectAttempts: 1, turns: turn, pages: ['keep'] }));
      const outputs = [];
      for (const hook of handlers.get('before_agent_start')) outputs.push(await hook({ prompt: 'What color?' }, ctx));
      assert.equal(outputs.filter(result => result?.message).length, 1);
      assert.equal(outputs.at(-1).message.display, true);
      assert.equal(outputs.at(-1).systemPrompt, 'preserved');
      assert.deepEqual(JSON.parse(readFileSync(cachePath, 'utf8')), { turns: turn, pages: ['keep'] });
    }
    for (const hook of handlers.get('agent_end')) await hook({}, ctx);
    for (const hook of handlers.get('session_shutdown')) await hook({}, ctx);
    assert.deepEqual(globalThis.order, ['upstream-prompt', 'classify', 'upstream-prompt', 'classify',
      'retain', 'upstream-shutdown', 'drain']);
  `;
  const env = { ...process.env, HOME: home, TMPDIR: home };
  delete env.HINDSIGHT_DISABLE_HOOKS;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env, cwd: home, timeout: 10000, stdio: 'pipe',
  });
});
