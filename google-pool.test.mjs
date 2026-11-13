import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGoogleDecision } from './google-decision.mjs';

const input = { state: { prompt: 'Color?' }, questions: { relevant: { type: 'bool', instructions: 'Useful?' } } };
const native = { answers: { relevant: { type: 'noul', noul: 0.95 } } };
const failure = /Google decision classification failed/;

function fixture(t) {
  const auth = [];
  const requests = [];
  const ctx = { modelRegistry: { async getApiKeyForProvider(provider) { auth.push(provider); return 'upstream-key'; } } };
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(options);
    return new Response(JSON.stringify(native));
  });
  const controller = new AbortController();
  const options = { signal: controller.signal };
  return { ctx, auth, requests, fetch, controller, options };
}

test('native Decisions uses the shared Google lease, not ordinary auth', async (t) => {
  const h = fixture(t);
  let calls = 0;
  const service = {
    hasPool(provider) { assert.equal(provider, 'google'); return true; },
    async runWithAccount(provider, ctx, options, request) {
      calls++;
      assert.equal(provider, 'google');
      assert.equal(ctx, h.ctx);
      assert.equal(options.signal, h.controller.signal);
      assert.equal(options.modelId, 'gemini-decision-1');
      return request({ accountId: 'pooled', auth: { apiKey: 'pool-key' }, signal: options.signal });
    },
  };
  const result = await classifyGoogleDecision(h.ctx, input, { ...h.options, getPoolService: () => service });
  assert.equal(result.answers.relevant.probability, 0.95);
  assert.equal(calls, 1);
  assert.deepEqual(h.auth, []);
  assert.equal(h.requests[0].headers['x-goog-api-key'], 'pool-key');
});

test('unknown or unsupported pool state never bypasses the pool', async (t) => {
  const h = fixture(t);
  for (const service of [undefined, {}, { hasPool: () => undefined }, { hasPool: () => true },
    { hasPool() { throw new Error('private details'); } }]) {
    await assert.rejects(classifyGoogleDecision(h.ctx, input, { ...h.options, getPoolService: () => service }), failure);
  }
  assert.deepEqual(h.auth, []);
  assert.equal(h.requests.length, 0);
});

test('only explicitly unpooled Google uses ordinary credentials', async (t) => {
  const h = fixture(t);
  await classifyGoogleDecision(h.ctx, input, { ...h.options, getPoolService: () => ({ hasPool: () => false }) });
  assert.deepEqual(h.auth, ['google']);
  assert.equal(h.requests[0].headers['x-goog-api-key'], 'upstream-key');
});

test('exhausted pool never retries through ordinary credentials', async (t) => {
  const h = fixture(t);
  const service = { hasPool: () => true, async runWithAccount() { throw new Error('exhausted'); } };
  await assert.rejects(classifyGoogleDecision(h.ctx, input, { ...h.options, getPoolService: () => service }), failure);
  assert.deepEqual(h.auth, []);
  assert.equal(h.requests.length, 0);
});

test('pool receives only safe HTTP failure metadata before another account attempt', async (t) => {
  const h = fixture(t);
  let attempts = 0;
  let firstError;
  let bodyRead = false;
  h.fetch.mock.mockImplementation(async (_url, options) => {
    h.requests.push(options);
    if (++attempts === 1) return {
      ok: false, status: 429, statusText: 'private-key-and-prompt',
      headers: new Headers({ 'retry-after': '30', 'x-secret': 'private-key-and-prompt' }),
      async json() { bodyRead = true; throw new Error('private-key-and-prompt'); },
    };
    return new Response(JSON.stringify(native));
  });
  const service = {
    hasPool: () => true,
    async runWithAccount(_provider, _ctx, options, request) {
      try { return await request({ accountId: 'one', auth: { apiKey: 'one-key' }, signal: options.signal }); }
      catch (error) { firstError = error; }
      return request({ accountId: 'two', auth: { apiKey: 'two-key' }, signal: options.signal });
    },
  };
  await classifyGoogleDecision(h.ctx, input, { ...h.options, getPoolService: () => service });
  assert.equal(firstError.status, 429);
  assert.deepEqual(firstError.headers, { 'retry-after': '30' });
  assert.doesNotMatch(firstError.message + JSON.stringify(firstError), /private-key-and-prompt/);
  assert.equal(firstError.cause, undefined);
  assert.equal(bodyRead, false);
  assert.deepEqual(h.requests.map(r => r.headers['x-goog-api-key']), ['one-key', 'two-key']);
  assert.deepEqual(h.auth, []);
});

test('invalid local input does not acquire or penalize a pooled account', async (t) => {
  const h = fixture(t);
  let leases = 0;
  const service = { hasPool: () => true, async runWithAccount() { leases++; throw new Error('unexpected'); } };
  await assert.rejects(classifyGoogleDecision(h.ctx, { state: 1n, questions: input.questions },
    { ...h.options, getPoolService: () => service }), failure);
  assert.equal(leases, 0);
  assert.equal(h.requests.length, 0);
});

test('invalid native answers reject inside the lease, before success is reported', async (t) => {
  const h = fixture(t);
  let successes = 0;
  let failures = 0;
  const service = {
    hasPool: () => true,
    async runWithAccount(_provider, _ctx, options, request) {
      try {
        const value = await request({ accountId: 'one', auth: { apiKey: 'key' }, signal: options.signal });
        successes++; return value;
      } catch (error) { failures++; throw error; }
    },
  };
  for (const answers of [{}, { relevant: { type: 'noul', noul: 1.1 } }]) {
    h.fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ answers })));
    await assert.rejects(classifyGoogleDecision(h.ctx, input, { ...h.options, getPoolService: () => service }), failure);
  }
  assert.equal(successes, 0);
  assert.equal(failures, 2);
});

test('late lease callbacks cannot start requests after cancellation', async (t) => {
  const h = fixture(t);
  const service = {
    hasPool: () => true,
    async runWithAccount(_provider, _ctx, options, request) {
      h.controller.abort();
      return request({ accountId: 'one', auth: { apiKey: 'key' }, signal: options.signal });
    },
  };
  await assert.rejects(classifyGoogleDecision(h.ctx, input, { ...h.options, getPoolService: () => service }), failure);
  assert.deepEqual(h.auth, []);
  assert.equal(h.requests.length, 0);
});

test('pool readiness is re-read for every classification', async (t) => {
  const h = fixture(t);
  let ready = false;
  const service = { hasPool: () => ready ? false : undefined };
  const options = { ...h.options, getPoolService: () => service };
  await assert.rejects(classifyGoogleDecision(h.ctx, input, options), failure);
  ready = true;
  await classifyGoogleDecision(h.ctx, input, options);
  assert.deepEqual(h.auth, ['google']);
});

test('an omitted service getter is unknown, not permission to bypass pooling', async (t) => {
  const h = fixture(t);
  await assert.rejects(classifyGoogleDecision(h.ctx, input, h.options), failure);
  assert.deepEqual(h.auth, []);
  assert.equal(h.requests.length, 0);
});
