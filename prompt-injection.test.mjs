import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { registerPromptInjection } from './prompt-injection.mjs';

const installedRoot = join(homedir(), '.hindsight/coding-agents');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'prompt-injection-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheRoot = join(root, 'hindsight-pi');
  fs.mkdirSync(cacheRoot);
  const packageFile = join(root, 'package.json');
  fs.writeFileSync(packageFile, JSON.stringify({
    name: '@vectorize-io/hindsight-coding-agents', version: '0.8.7',
  }));
  const handlers = new Map();
  const warnings = [];
  registerPromptInjection({ on: (name, handler) => handlers.set(name, handler) }, {
    cacheRoot, packageFile, warn: (message) => warnings.push(message), ...options,
  });
  const id = randomUUID();
  const file = (sessionId = id) => join(cacheRoot, `${sessionId}.json`);
  const save = (cache, sessionId) => fs.writeFileSync(file(sessionId), JSON.stringify(cache));
  const read = (sessionId) => JSON.parse(fs.readFileSync(file(sessionId), 'utf8'));
  const emit = (prompt = 'current goal', sessionId = id, context = {}) =>
    handlers.get('before_agent_start')({ prompt }, {
      hasUI: false, sessionManager: { getSessionId: () => sessionId }, ...context,
    });
  return { root, cacheRoot, packageFile, handlers, warnings, id, file, save, read, emit };
}

test('only registers before_agent_start and removes only the retrieval gate', async (t) => {
  const h = fixture(t);
  assert.deepEqual([...h.handlers.keys()], ['before_agent_start']);
  const preserved = {
    turns: 19, pages: { atTurn: 16, list: [{ id: 'page' }] },
    deferInitialReflect: true, unknown: { nested: ['keep', 42] },
  };
  h.save({ ...preserved, reflectAnswer: 'old memory', reflectAttempts: 5 });
  assert.equal(await h.emit(), undefined);
  assert.deepEqual(h.read(), preserved);
  assert.deepEqual(h.warnings, []);
});

test('invalidates successive prompts independently and isolates sessions', async (t) => {
  const h = fixture(t);
  const second = randomUUID();
  h.save({ reflectAnswer: 'first', reflectAttempts: 1, turns: 1 });
  h.save({ reflectAnswer: 'other session', reflectAttempts: 2 }, second);
  await h.emit('first prompt');
  assert.deepEqual(h.read(), { turns: 1 });
  assert.equal(h.read(second).reflectAnswer, 'other session');
  h.save({ reflectAnswer: 'second', reflectAttempts: 1, turns: 2 });
  await h.emit('different prompt');
  assert.deepEqual(h.read(), { turns: 2 });
  await h.emit('third prompt', second);
  assert.deepEqual(h.read(second), {});
});

test('missing cache and missing cache directory are normal, with no writes', async (t) => {
  const h = fixture(t);
  await h.emit();
  fs.rmdirSync(h.cacheRoot);
  await h.emit();
  assert.equal(fs.existsSync(h.cacheRoot), false);
  assert.deepEqual(h.warnings, []);
});

test('empty, whitespace, missing, and custom-message prompts leave cache untouched', async (t) => {
  const h = fixture(t);
  h.save({ reflectAnswer: 'keep', reflectAttempts: 3 });
  for (const prompt of ['', ' \n\t', null, 17]) await h.emit(prompt);
  await h.handlers.get('before_agent_start')({ messageType: 'custom' }, {});
  assert.deepEqual(h.read(), { reflectAnswer: 'keep', reflectAttempts: 3 });
  assert.deepEqual(h.warnings, []);
});

test('unsafe or missing session IDs cannot select any cache file', async (t) => {
  const h = fixture(t);
  h.save({ reflectAnswer: 'keep' });
  for (const id of ['../escape', '/tmp/escape', '..', 'a/b', 'a\\b', '', null, 23, 'x'.repeat(129)]) {
    await h.emit('secret prompt', id);
  }
  assert.equal(h.read().reflectAnswer, 'keep');
  assert.ok(h.warnings.length > 0);
  assert.doesNotMatch(h.warnings.join(' '), /secret prompt|escape/);
});

test('cache with no retrieval fields is not rewritten', async (t) => {
  const h = fixture(t, { fs: { ...fs, renameSync: () => assert.fail('unexpected write') } });
  h.save({ turns: 1, pages: { list: [] } });
  await h.emit();
  assert.deepEqual(h.warnings, []);
});

for (const body of ['{broken secret-content', 'null', '[]', '"secret-content"', '42']) {
  test(`rejects invalid or nonobject cache JSON: ${body.slice(0, 8)}`, async (t) => {
    const h = fixture(t);
    fs.writeFileSync(h.file(), body);
    await h.emit('secret prompt');
    assert.equal(fs.readFileSync(h.file(), 'utf8'), body);
    assert.equal(h.warnings.length, 1);
    assert.doesNotMatch(h.warnings[0], /secret-content|secret prompt/);
  });
}

for (const target of ['cache', 'directory']) {
  test(`rejects symlink ${target} without changing its target`, async (t) => {
    const h = fixture(t);
    const outside = join(h.root, 'outside');
    if (target === 'cache') {
      fs.writeFileSync(outside, '{"reflectAnswer":"keep"}');
      fs.symlinkSync(outside, h.file());
    } else {
      fs.mkdirSync(outside);
      fs.writeFileSync(join(outside, `${h.id}.json`), '{"reflectAnswer":"keep"}');
      fs.rmdirSync(h.cacheRoot);
      fs.symlinkSync(outside, h.cacheRoot);
    }
    await h.emit();
    assert.equal(h.read().reflectAnswer, 'keep');
    assert.equal(h.warnings.length, 1);
  });
}

for (const operation of ['writeFileSync', 'renameSync']) {
  test(`atomic ${operation} failure keeps original and cleans temporary file`, async (t) => {
    const h = fixture(t, {
      fs: { ...fs, [operation]: () => { throw new Error('credential=secret'); } },
    });
    h.save({ reflectAnswer: 'keep', reflectAttempts: 2 });
    await h.emit();
    assert.deepEqual(h.read(), { reflectAnswer: 'keep', reflectAttempts: 2 });
    assert.deepEqual(fs.readdirSync(h.cacheRoot), [`${h.id}.json`]);
    assert.equal(h.warnings.length, 1);
    assert.doesNotMatch(h.warnings[0], /credential|secret/);
  });
}

test('unsupported version warns once, does not mutate, and rechecks after auto-update', async (t) => {
  const h = fixture(t);
  h.save({ reflectAnswer: 'keep' });
  fs.writeFileSync(h.packageFile, '{"version":"0.9.0-secret"}');
  await h.emit();
  await h.emit();
  assert.equal(h.warnings.length, 1);
  assert.equal(h.read().reflectAnswer, 'keep');
  assert.doesNotMatch(h.warnings[0], /secret/);
  fs.writeFileSync(h.packageFile, JSON.stringify({
    name: '@vectorize-io/hindsight-coding-agents', version: '0.8.7',
  }));
  await h.emit();
  assert.deepEqual(h.read(), {});
  h.save({ reflectAnswer: 'keep after update' });
  fs.writeFileSync(h.packageFile, '{"version":"0.8.8"}');
  await h.emit();
  assert.equal(h.read().reflectAnswer, 'keep after update');
});

test('unreadable package and failing warning sinks fail safely', async (t) => {
  const h = fixture(t, { warn: () => { throw new Error('broken warning sink'); } });
  h.save({ reflectAnswer: 'keep' });
  fs.unlinkSync(h.packageFile);
  await h.emit();
  assert.equal(h.read().reflectAnswer, 'keep');
});

test('context failures warn without leaking exception text', async (t) => {
  const h = fixture(t);
  await h.emit('secret prompt', h.id, {
    sessionManager: { getSessionId: () => { throw new Error('secret credential'); } },
  });
  assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(h.warnings[0], /secret|credential/);
});

test('UI warnings are sanitized and headless runs use the warning sink', async (t) => {
  const h = fixture(t);
  fs.writeFileSync(h.file(), 'secret invalid JSON');
  const notifications = [];
  await h.emit('private goal', h.id, { hasUI: true, ui: { notify: (...args) => notifications.push(args) } });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][1], 'warning');
  assert.doesNotMatch(notifications[0][0], /secret|private/);
  assert.deepEqual(h.warnings, []);
});

test('disabled hooks preserve cache without checking installed version', async (t) => {
  const h = fixture(t);
  const previous = process.env.HINDSIGHT_DISABLE_HOOKS;
  t.after(() => {
    if (previous === undefined) delete process.env.HINDSIGHT_DISABLE_HOOKS;
    else process.env.HINDSIGHT_DISABLE_HOOKS = previous;
  });
  process.env.HINDSIGHT_DISABLE_HOOKS = '1';
  h.save({ reflectAnswer: 'keep' });
  fs.unlinkSync(h.packageFile);
  await h.emit();
  assert.equal(h.read().reflectAnswer, 'keep');
  assert.deepEqual(h.warnings, []);
});

test('TypeScript entry point registers only the invalidator', async () => {
  const { default: extension } = await import('./prompt-injection.ts');
  const names = [];
  extension({ on: (name) => names.push(name) });
  assert.deepEqual(names, ['before_agent_start']);
});

// Import a temporary copy with test-only named exports. Never patch the installation.
test('installed Hindsight 0.8.7 hook regression', {
  skip: !fs.existsSync(join(installedRoot, 'dist/pi.js')) && 'installed bundle unavailable',
}, async (t) => {
  assert.equal(JSON.parse(fs.readFileSync(join(installedRoot, 'package.json'), 'utf8')).version, '0.8.7');
  const root = fs.mkdtempSync(join(tmpdir(), 'hindsight-actual-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalEnv = Object.fromEntries(['TMPDIR', 'HINDSIGHT_LOG_FILE', 'HINDSIGHT_DIAG_FILE',
    'HINDSIGHT_DISABLE_HOOKS'].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.TMPDIR = root;
  process.env.HINDSIGHT_LOG_FILE = join(root, 'plugin.log');
  process.env.HINDSIGHT_DIAG_FILE = join(root, 'diag.jsonl');
  delete process.env.HINDSIGHT_DISABLE_HOOKS;
  const bundle = join(root, 'pi-under-test.mjs');
  fs.writeFileSync(bundle, fs.readFileSync(join(installedRoot, 'dist/pi.js'), 'utf8')
    + '\nexport { buildHookOutput, createPiHooks, RuntimeCore, ReflectError };\n');
  const { createPiHooks, RuntimeCore, ReflectError } = await import(pathToFileURL(bundle).href);

  function actual(st, autoInject, overrides = {}) {
    const h = fixture(st);
    const queries = [];
    const cfg = { autoInject, injectTimeoutMs: 100, reflectTimeoutMs: 100,
      pageRefreshEveryTurns: 3, retainSessions: false, logLevel: 'error' };
    const client = {
      bank: 'test-bank',
      listPages: async () => [],
      searchPages: async (query) => {
        queries.push(query);
        return [{ id: 'p', name: 'page', snippet: `memory for ${query}` }];
      },
      recallObservations: async (query) => {
        queries.push(query);
        return [`memory for ${query}`];
      },
      reflect: async (query) => {
        queries.push(query);
        return `memory for ${query}`;
      },
      ...overrides,
    };
    const core = new RuntimeCore(client, 'test-bank', cfg, 'pi', root);
    const hooks = createPiHooks(core, 'pi', Promise.resolve());
    // RuntimeCore uses tmpdir()/hindsight-pi; point only the invalidator there.
    const cacheRoot = join(root, 'hindsight-pi');
    const handlers = new Map();
    registerPromptInjection({ on: (name, handler) => handlers.set(name, handler) }, {
      cacheRoot, packageFile: h.packageFile, warn: (message) => h.warnings.push(message),
    });
    const ctx = { hasUI: false, sessionManager: { getSessionId: () => h.id } };
    const send = async (prompt, invalidate = true) => {
      if (invalidate) await handlers.get('before_agent_start')({ prompt }, ctx);
      return hooks.beforeAgentStart({ prompt }, h.id);
    };
    const cache = () => JSON.parse(fs.readFileSync(join(cacheRoot, `${h.id}.json`), 'utf8'));
    return { h, core, send, cache, queries };
  }

  for (const mode of ['pages', 'recall', 'reflect']) {
    await t.test(`${mode}: actual hook retrieves for two distinct prompts`, async (st) => {
      const a = actual(st, mode);
      const first = await a.send('alpha goal');
      const second = await a.send('beta goal');
      assert.equal(a.queries.length, 2);
      assert.match(a.queries[0], /alpha goal/);
      assert.match(a.queries[1], /beta goal/);
      assert.match(first.message.content, /alpha goal/);
      assert.match(second.message.content, /beta goal/);
      assert.equal(a.cache().turns, 2);
      assert.equal(a.cache().reflectAttempts, 1);
      assert.deepEqual(a.h.warnings, []);
    });
  }

  await t.test('control: without invalidator the actual second hook does not retrieve', async (st) => {
    const a = actual(st, 'pages');
    await a.send('alpha goal', false);
    await a.send('beta goal', false);
    assert.deepEqual(a.queries, ['alpha goal']);
  });

  await t.test('none mode and disabled hooks retain builtin behavior', async (st) => {
    const a = actual(st, 'none');
    await a.send('alpha goal');
    await a.send('beta goal');
    assert.deepEqual(a.queries, []);
    assert.equal(a.cache().turns, 2);
    process.env.HINDSIGHT_DISABLE_HOOKS = '1';
    try {
      await a.send('disabled goal');
      assert.equal(a.cache().turns, 2);
    } finally {
      delete process.env.HINDSIGHT_DISABLE_HOOKS;
    }
  });

  await t.test('cold bank defers only first retrieval, preserving upstream deferral', async (st) => {
    const a = actual(st, 'pages');
    a.core.deferInitialReflect = true;
    await a.send('cold goal');
    assert.deepEqual(a.queries, []);
    await a.send('warm goal');
    assert.deepEqual(a.queries, ['warm goal']);
  });

  await t.test('reflect failure uses upstream fallback afresh for each prompt', async (st) => {
    const a = actual(st, 'reflect', {
      reflect: async () => { throw new ReflectError('test failure', 503, false); },
    });
    assert.match((await a.send('alpha fallback')).message.content, /alpha fallback/);
    assert.match((await a.send('beta fallback')).message.content, /beta fallback/);
    assert.deepEqual(a.queries, ['alpha fallback', 'beta fallback']);
  });

  await t.test('total retrieval failure is fail-open and attempts reset on next prompt', async (st) => {
    let attempts = 0;
    const a = actual(st, 'reflect', {
      reflect: async () => { attempts++; throw new ReflectError('test failure', 503, false); },
      searchPages: async () => { throw new Error('test failure'); },
      recallObservations: async () => { throw new Error('test failure'); },
    });
    await a.send('alpha unavailable');
    await a.send('beta unavailable');
    assert.equal(attempts, 2);
    assert.equal(a.cache().reflectAttempts, 1);
    assert.equal(a.cache().turns, 2);
  });
});
