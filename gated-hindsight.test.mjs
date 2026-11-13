import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test, { beforeEach } from 'node:test';
import { registerGatedHindsight } from './gated-hindsight.ts';
import { MEMORY_PREAMBLE } from './relevance-gate.mjs';

const nativeHosts = new Map();
beforeEach((t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
    const respond = nativeHosts.get(options.headers['x-goog-api-key']);
    return new Response(JSON.stringify(respond(JSON.parse(options.body))));
  });
});
function host(probability = 0, announceAtLoad = true) {
  const handlers = new Map();
  const registered = [];
  let announce;
  const events = { on(name, handler) {
    assert.equal(name, 'pi-multiprovider:service');
    announce = handler;
    if (announceAtLoad) handler({ hasPool: () => false });
    return () => {};
  } };
  const api = {
    events,
    on(name, handler) { assert.equal(this, api); handlers.set(name, handler); },
    registerTool(tool) { assert.equal(this, api); registered.push(tool); },
    opaque: { keep: true },
  };
  let calls = 0;
  const apiKey = 'fake-google-host-' + nativeHosts.size;
  nativeHosts.set(apiKey, (body) => {
    calls++;
    return { answers: Object.fromEntries(Object.keys(body.questions)
      .map((id) => [id, { type: 'noul', noul: probability }])) };
  });
  const ctx = {
    cwd: '/tmp',
    sessionManager: { getSessionId: () => 'session', getBranch: () => [] },
    ui: { notify() {} },
    modelRegistry: {
      async getApiKeyForProvider(provider) { assert.equal(provider, 'google'); return apiKey; },
      findOfType: (_type, provider, id) => ({ provider, id }),
      classify: async (_model, input) => {
        calls++;
        return { stopReason: 'stop', answers: Object.fromEntries(Object.keys(input.questions)
          .map((id) => [id, { type: 'bool', probability }])) };
      },
    },
  };
  return { api, handlers, registered, ctx, apiKey, announce: value => announce(value), calls: () => calls };
}
const injection = { message: { customType: 'hindsight', content: MEMORY_PREAMBLE + 'A fact.\n</hindsight_memory>' } };

test('wraps only before_agent_start; awaits upstream exactly once before classifying', async () => {
  const h = host();
  let calls = 0;
  let finish;
  const barrier = new Promise((resolve) => { finish = resolve; });
  const end = () => 'retain';
  const shutdown = () => 'flush';
  const tool = { name: 'hindsight_retain', execute: end };
  const original = { ...injection, systemPrompt: 'unchanged', unknown: { keep: true } };
  const upstream = (pi) => {
    assert.equal(pi.opaque, h.api.opaque);
    pi.registerTool(tool);
    pi.on('agent_end', end);
    pi.on('session_shutdown', shutdown);
    pi.on('before_agent_start', async (event, ctx) => {
      assert.equal(ctx, h.ctx);
      assert.equal(event.prompt, 'goal');
      calls++;
      await barrier;
      return original;
    });
  };
  await registerGatedHindsight(h.api, upstream, '0.8.7');
  assert.equal(h.handlers.get('agent_end'), end);
  assert.equal(h.handlers.get('session_shutdown'), shutdown);
  assert.equal(h.registered[0], tool);
  const pending = h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
  assert.equal(calls, 1);
  assert.equal(h.calls(), 0);
  finish();
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(h.calls(), 1);
  assert.deepEqual(result, { systemPrompt: 'unchanged', unknown: { keep: true } });
  assert.equal(result.unknown, original.unknown);
  assert.equal(await h.handlers.get('agent_end')(), 'retain');
  assert.equal(await h.handlers.get('session_shutdown')(), 'flush');
});

test('preserves unrelated results and upstream exceptions without re-running the hook', async () => {
  const h = host();
  const result = { systemPrompt: 'keep', unknown: 12 };
  await registerGatedHindsight(h.api, (pi) => pi.on('before_agent_start', () => result), '0.8.7');
  assert.equal(await h.handlers.get('before_agent_start')({}, h.ctx), result);
  let calls = 0;
  const error = new Error('upstream failure');
  await registerGatedHindsight(h.api, (pi) => pi.on('before_agent_start', () => { calls++; throw error; }), '0.8.7');
  await assert.rejects(() => h.handlers.get('before_agent_start')({}, h.ctx), (actual) => actual === error);
  assert.equal(calls, 1);
});

test('unsupported version suppresses injection but leaves tools and hooks registered', async () => {
  const h = host(1);
  await registerGatedHindsight(h.api, (pi) => {
    pi.registerTool({ name: 'retain' });
    pi.on('before_agent_start', () => injection);
    pi.on('session_shutdown', () => 'done');
  }, '0.8.8');
  assert.equal(await h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx), undefined);
  assert.equal(h.calls(), 0);
  assert.equal(h.registered.length, 1);
  assert.equal(h.handlers.get('session_shutdown')(), 'done');
});

test('default entry imports the absolute installed path under HOME unchanged', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'gated-hindsight-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = join(root, '.hindsight/coding-agents');
  fs.mkdirSync(join(installed, 'dist'), { recursive: true });
  fs.writeFileSync(join(installed, 'package.json'), JSON.stringify({ type: 'module', version: '0.8.7' }));
  fs.writeFileSync(join(installed, 'dist/pi.js'), `export default function(pi) {
    pi.registerTool({name:'installed-tool'});
    pi.on('before_agent_start', async () => ({message:{customType:'hindsight',content:'<hindsight_pages>roster</hindsight_pages>'}}));
  }`);
  const script = `
    const {default: extension} = await import(${JSON.stringify(new URL('./gated-hindsight.ts', import.meta.url).href)});
    const handlers = new Map(), tools = [];
    await extension({events:{on(){}},on:(n,h)=>handlers.set(n,h),registerTool:t=>tools.push(t)});
    const result = await handlers.get('before_agent_start')({prompt:'goal'}, {});
    if (tools[0].name !== 'installed-tool' || result !== undefined) throw new Error('entry regression');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: root }, cwd: root, timeout: 10000,
  });

  fs.writeFileSync(join(installed, 'dist/pi.js'), `export default function(pi) {
    pi.registerTool({name:'installed-tool'});
    pi.on('before_agent_start', async () => ({message:{customType:'hindsight-v2',content:'must not leak'}, unknown:42}));
  }`);
  for (const version of [undefined, null, 87]) {
    fs.writeFileSync(join(installed, 'package.json'), JSON.stringify({ type: 'module', version }));
    const unversioned = `
      const {default: extension} = await import(${JSON.stringify(new URL('./gated-hindsight.ts', import.meta.url).href)});
      const handlers = new Map(), tools = [];
      await extension({events:{on(){}},on:(n,h)=>handlers.set(n,h),registerTool:t=>tools.push(t)});
      let warnings = 0;
      const result = await handlers.get('before_agent_start')({prompt:'goal'}, {
        ui:{notify(){warnings++;}}, modelRegistry:{findOfType(){throw new Error('must not classify');}}
      });
      if (tools[0].name !== 'installed-tool' || result.message !== undefined || result.unknown !== 42 || warnings !== 1)
        throw new Error('unversioned entry regression');
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', unversioned], {
      env: { ...process.env, HOME: root }, cwd: root, timeout: 10000, stdio: 'pipe',
    });
  }
});

// Expose existing functions from a temporary bundle copy, never modify the installation.
test('installed 0.8.7 extension factory preserves tools, retention, shutdown and exact injection parsing', async (t) => {
  const installed = join(homedir(), '.hindsight/coding-agents');
  assert.equal(JSON.parse(fs.readFileSync(join(installed, 'package.json'), 'utf8')).version, '0.8.7');
  const root = fs.mkdtempSync(join(tmpdir(), 'gated-hindsight-actual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = Object.fromEntries(['HOME', 'TMPDIR', 'HINDSIGHT_LOG_FILE', 'HINDSIGHT_DIAG_FILE']
    .map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  Object.assign(process.env, { HOME: root, TMPDIR: root,
    HINDSIGHT_LOG_FILE: join(root, 'log'), HINDSIGHT_DIAG_FILE: join(root, 'diag') });
  const copy = join(root, 'pi-test.mjs');
  fs.writeFileSync(copy, fs.readFileSync(join(installed, 'dist/pi.js'), 'utf8') +
    '\nexport { createPiExtension, buildSystemInjection, formatPageFallback, formatRecallFallback };\n');
  const { createPiExtension, buildSystemInjection, formatPageFallback, formatRecallFallback } = await import(pathToFileURL(copy).href);
  assert.equal(buildSystemInjection('A fact.'), MEMORY_PREAMBLE + 'A fact.\n</hindsight_memory>');
  const h = host(0.99);
  const calls = [];
  const core = {
    seedIfCold: async () => { calls.push('seed'); },
    toolSpecs: () => [{ name: 'hindsight_retain', description: 'retain', inputSchema: {},
      handler: async () => ({ content: [{ type: 'text', text: 'tool retained' }] }) }],
    onPrompt: async (id, prompt) => { calls.push(['prompt', id, prompt]); },
    getInjection: () => '<hindsight_pages>roster</hindsight_pages>\n' + buildSystemInjection('A useful fact.'),
    onTranscript: async (...args) => { calls.push(['retain', ...args]); },
    flush: async () => { calls.push('flush'); },
  };
  await registerGatedHindsight(h.api, createPiExtension('pi', () => core), '0.8.7');
  await h.handlers.get('session_start')({}, h.ctx);
  const result = await h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
  assert.match(result.message.content, /A useful fact\./);
  assert.doesNotMatch(result.message.content, /roster|Automatically retrieved/);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === 'prompt').length, 1);
  assert.equal(h.calls(), 1);
  const toolResult = await h.registered[0].execute('tool-id', {}, undefined, undefined, h.ctx);
  assert.equal(toolResult.content[0].text, 'tool retained');
  const branch = [{ type: 'message', message: { role: 'user', content: 'earlier real user' } },
    { type: 'custom_message', customType: 'hindsight', content: 'memory not retained as user' }];
  h.ctx.sessionManager.getBranch = () => branch;
  await h.handlers.get('agent_end')({ messages: [{ role: 'user', content: 'event only' }] }, h.ctx);
  assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'retain'),
    ['retain', 'session', [{ role: 'user', content: 'earlier real user' }], true]);
  await h.handlers.get('session_shutdown')({}, h.ctx);
  assert.ok(calls.includes('flush'));

  for (const lead of [undefined, '(These pages matched the goal by search. Read one with hindsight_read_page(<id>) if it looks relevant.)']) {
    await t.test('actual page search/fallback roster skips classification', async () => {
      core.getInjection = () => buildSystemInjection(formatPageFallback([{ name: 'Page', id: 'p', snippet: 'A useful fact.' }], lead));
      const before = h.calls();
      assert.equal(await h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx), undefined);
      assert.equal(h.calls(), before);
    });
  }
  for (const lead of [undefined, '(These memories were recalled from the bank for the goal, unsynthesized.)']) {
    await t.test('actual recall/fallback strips status lead but preserves original observation bullets', async () => {
      core.getInjection = () => buildSystemInjection(formatRecallFallback(['A useful fact.'], lead));
      const before = h.calls();
      const result = await h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
      assert.match(result.message.content, /- A useful fact\./);
      assert.doesNotMatch(result.message.content, /unsynthesized|synthesis was unavailable|These memories/);
      assert.equal(h.calls(), before + 1);
    });
  }
});

test('wrapper follows pool announcements and fails closed before readiness', async () => {
  const h = host(0.97);
  h.ctx.modelRegistry.findOfType = () => undefined;
  await registerGatedHindsight(h.api, pi => pi.on('before_agent_start', () => injection), '0.8.7');
  h.announce(undefined);
  const run = () => h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
  assert.equal(await run(), undefined);
  assert.equal(h.calls(), 0);
  let leases = 0;
  h.announce({
    hasPool: () => true,
    async runWithAccount(provider, ctx, options, request) {
      leases++;
      assert.equal(provider, 'google');
      assert.equal(ctx, h.ctx);
      return request({ accountId: 'pooled', auth: { apiKey: h.apiKey }, signal: options.signal });
    },
  });
  h.ctx.modelRegistry.getApiKeyForProvider = () => { throw new Error('pool bypass'); };
  assert.equal((await run()).message.display, true);
  assert.equal(leases, 1);
  assert.equal(h.calls(), 1);
});

test('wrapper rechecks readiness even when the service object is unchanged', async () => {
  const h = host(0.97);
  let pooled = false;
  const service = { hasPool: () => pooled };
  h.ctx.modelRegistry.findOfType = () => undefined;
  await registerGatedHindsight(h.api, pi => pi.on('before_agent_start', () => injection), '0.8.7');
  h.announce(service);
  const run = () => h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
  assert.ok((await run()).message);
  pooled = undefined;
  assert.equal(await run(), undefined);
  pooled = true; // An old service without the request bridge must not bypass pooling.
  assert.equal(await run(), undefined);
  assert.equal(h.calls(), 1);
});

test('exhausted Google pool falls back to StartLux without ordinary Google auth', async () => {
  const h = host(0.97);
  await registerGatedHindsight(h.api, pi => pi.on('before_agent_start', () => injection), '0.8.7');
  h.announce({ hasPool: () => true, async runWithAccount() { throw new Error('exhausted'); } });
  h.ctx.modelRegistry.getApiKeyForProvider = () => { throw new Error('pool bypass'); };
  let fallback = 0;
  const classify = h.ctx.modelRegistry.classify;
  h.ctx.modelRegistry.classify = (model, input, options) => {
    assert.equal(model.provider, 'startlux');
    fallback++;
    return classify(model, input, options);
  };
  const result = await h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
  assert.ok(result.message);
  assert.equal(fallback, 1);
});

test('no service announcement by the first prompt uses ordinary Google auth', async () => {
  const h = host(0.97, false);
  h.ctx.modelRegistry.findOfType = () => { throw new Error('must use Google, not fallback'); };
  let authCalls = 0;
  const getKey = h.ctx.modelRegistry.getApiKeyForProvider;
  h.ctx.modelRegistry.getApiKeyForProvider = provider => { authCalls++; return getKey(provider); };
  await registerGatedHindsight(h.api, pi => pi.on('before_agent_start', () => injection), '0.8.7');
  const result = await h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
  assert.equal(result.message.display, true);
  assert.equal(authCalls, 1);
  assert.equal(h.calls(), 1);
});

test('a late announcement replaces standalone fallback and remains authoritative', async () => {
  const h = host(0.97, false);
  h.ctx.modelRegistry.findOfType = () => undefined;
  await registerGatedHindsight(h.api, pi => pi.on('before_agent_start', () => injection), '0.8.7');
  const run = () => h.handlers.get('before_agent_start')({ prompt: 'goal' }, h.ctx);
  assert.ok((await run()).message);
  let leases = 0;
  h.announce({
    hasPool: () => true,
    async runWithAccount(_provider, _ctx, options, request) {
      leases++;
      return request({ accountId: 'pooled', auth: { apiKey: h.apiKey }, signal: options.signal });
    },
  });
  h.ctx.modelRegistry.getApiKeyForProvider = () => { throw new Error('must not bypass late pool'); };
  assert.ok((await run()).message);
  assert.equal(leases, 1);
  for (const service of [undefined, {}, { hasPool: () => undefined },
    { hasPool: () => true, async runWithAccount() { throw new Error('exhausted'); } }]) {
    h.announce(service);
    assert.equal(await run(), undefined);
  }
  assert.equal(h.calls(), 2);
});
