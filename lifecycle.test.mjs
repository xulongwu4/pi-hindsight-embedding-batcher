import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DRAIN_TIMEOUT_MS,
  DRAIN_URL,
  registerLifecycle,
  requestDrain,
} from './lifecycle.mjs';

const token = 'test-only-secret-token';
const env = `EMBEDDING_GATEWAY_TOKEN=${token}\n`;
const accepted = () => new Response('{"draining":true}', { status: 202 });

function harness(options = {}) {
  const handlers = new Map();
  const requests = [];
  const warnings = [];
  const notifications = [];
  const pi = { on: (name, handler) => handlers.set(name, handler) };
  registerLifecycle(pi, {
    readFile: async () => env,
    fetch: async (...args) => {
      requests.push(args);
      return accepted();
    },
    warn: (message) => warnings.push(message),
    ...options,
  });
  const ctx = {
    hasUI: true,
    ui: { notify: (...args) => notifications.push(args) },
  };
  const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
  return { handlers, requests, warnings, notifications, ctx, emit };
}

test('registers only session_shutdown, leaving Pi signal handling untouched', async () => {
  const signals = ['SIGINT', 'SIGHUP', 'SIGTERM', 'exit', 'beforeExit'];
  const listeners = signals.map((signal) => process.listeners(signal));
  const h = harness();
  assert.deepEqual([...h.handlers.keys()], ['session_shutdown']);
  assert.deepEqual(signals.map((signal) => process.listeners(signal)), listeners);
  for (const name of ['session_start', 'session_before_switch', 'session_before_fork',
    'session_tree', 'agent_end', 'agent_settled']) {
    await h.emit(name);
  }
  assert.equal(h.requests.length, 0);
});

for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
  test(`requests one drain for session_shutdown reason ${reason}`, async () => {
    const h = harness();
    await Promise.all([
      h.emit('session_shutdown', { reason }),
      h.emit('session_shutdown', { reason }),
    ]);
    await h.emit('session_shutdown', { reason });
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(h.notifications, []); // Accepted is not a claim of completion.
  });
}

test('a replacement extension runtime gets its own drain request', async () => {
  const old = harness();
  const replacement = harness();
  await old.emit('session_shutdown', { reason: 'new' });
  await replacement.emit('session_shutdown', { reason: 'quit' });
  assert.equal(old.requests.length, 1);
  assert.equal(replacement.requests.length, 1);
});

test('reads the local token file and sends bearer auth only to the fixed endpoint', async () => {
  let reads = 0;
  let calls = 0;
  const result = await requestDrain({
    readFile: async (path, options) => {
      reads++;
      assert.equal(path, join(homedir(), '.config/hindsight/embedding-gateway.env'));
      assert.equal(options.encoding, 'utf8');
      assert.ok(options.signal instanceof AbortSignal);
      return env;
    },
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:8890/control/drain');
      assert.equal(url, DRAIN_URL);
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.headers, { Authorization: `Bearer ${token}` });
      assert.equal(options.redirect, 'error'); // Never redirect credentials.
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.body, undefined);
      return accepted();
    },
  });
  assert.deepEqual(result, { accepted: true });
  assert.equal(reads, 1);
  assert.equal(calls, 1); // No health polling or completion wait.
  assert.equal(JSON.stringify(result).includes(token), false);
});

for (const value of [token, `"${token}"`, `'${token}'`]) {
  test(`reads env token with quoting style ${value[0] === token[0] ? 'bare' : value[0]}`, async () => {
    const result = await requestDrain({
      readFile: async () => `# local gateway\nUNRELATED=value\nEMBEDDING_GATEWAY_TOKEN=${value}\n`,
      fetch: async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        return accepted();
      },
    });
    assert.deepEqual(result, { accepted: true });
  });
}

for (const content of ['', 'EMBEDDING_GATEWAY_TOKEN=', 'EMBEDDING_GATEWAY_TOKEN="bad token"']) {
  test('missing or invalid token warns without sending a request', async () => {
    const h = harness({ readFile: async () => content });
    await h.emit('session_shutdown', { reason: 'quit' });
    assert.equal(h.requests.length, 0);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /token/i);
    assert.equal(h.warnings[0].includes('bad token'), false);
    assert.deepEqual(h.notifications, [[h.warnings[0], 'warning']]);
  });
}

for (const status of [200, 204, 302, 401, 503]) {
  test(`HTTP ${status} is not a drain acknowledgement and leaks no response text`, async () => {
    const h = harness({
      fetch: async () => new Response(status === 204 ? null : token, { status }),
    });
    await h.emit('session_shutdown', { reason: 'quit' });
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], new RegExp(`HTTP ${status}`));
    assert.equal(h.warnings[0].includes(token), false);
  });
}

for (const body of ['{"draining":false}', '{}', 'null', token]) {
  test('rejects malformed or unconfirmed 202 without exposing its body', async () => {
    const h = harness({ fetch: async () => new Response(body, { status: 202 }) });
    await h.emit('session_shutdown', { reason: 'quit' });
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0].includes(token), false);
  });
}

for (const boundary of ['readFile', 'fetch']) {
  test(`${boundary} failure warns safely and does not prevent teardown`, async () => {
    const h = harness({ [boundary]: async () => { throw new Error(token); } });
    await h.emit('session_shutdown', { reason: 'quit' });
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0].includes(token), false);
    assert.deepEqual(h.notifications, [[h.warnings[0], 'warning']]);
    assert.match(h.warnings[0], /not confirmed/i);
  });
}

test('headless failures go to stderr warning sink, not stdout or UI', async () => {
  const h = harness({ fetch: async () => { throw new Error(token); } });
  h.ctx.hasUI = false;
  await h.emit('session_shutdown', { reason: 'quit' });
  assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.notifications, []);
});

for (const boundary of ['readFile', 'fetch', 'json']) {
  test(`two-second deadline includes a stalled ${boundary} even when it ignores abort`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    let requests = 0;
    let finishRead;
    const options = {
      readFile: async (_path, opts) => {
        signal = opts.signal;
        if (boundary === 'readFile') return new Promise((resolve) => { finishRead = resolve; });
        return env;
      },
      fetch: async (_url, opts) => {
        requests++;
        signal = opts.signal;
        if (boundary === 'fetch') return new Promise(() => {});
        return { status: 202, json: () => new Promise(() => {}) };
      },
    };
    let settled = false;
    const pending = requestDrain(options).then((result) => { settled = true; return result; });
    await nextTurn();
    assert.equal(DRAIN_TIMEOUT_MS, 2000);
    t.mock.timers.tick(1999);
    await nextTurn();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(result.accepted, false);
    assert.match(result.warning, /timed out/i);
    assert.equal(signal.aborted, true);
    assert.equal(JSON.stringify(result).includes(token), false);
    if (finishRead) {
      finishRead(env);
      await nextTurn();
      assert.equal(requests, 0); // Late file reads must not start a post-timeout request.
    }
  });
}

test('TypeScript entry point loads and registers the lifecycle without runtime dependencies', async () => {
  const { default: extension } = await import('./extension.ts');
  const handlers = new Map();
  extension({ on: (name, handler) => handlers.set(name, handler) });
  assert.deepEqual([...handlers.keys()], ['session_shutdown']);
});
