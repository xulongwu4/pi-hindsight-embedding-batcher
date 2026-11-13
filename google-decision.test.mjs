import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGoogleDecision as actualClassifyGoogleDecision } from './google-decision.mjs';

// Unit fixtures explicitly model an unpooled provider; absence is tested separately.
function classifyGoogleDecision(ctx, input, options = {}) {
  return actualClassifyGoogleDecision(ctx, input, { getPoolService: () => ({ hasPool: () => false }), ...options });
}

const SECRET = 'private-key-do-not-leak';
const PROMPT = 'private-prompt-do-not-leak';
const FAILURE = 'Google decision classification failed';
const input = {
  state: { prompt: PROMPT, candidates: [{ id: 'unit:α', text: 'A complete memory.' }] },
  questions: {
    'unit:α': {
      type: 'bool', instructions: 'Is this relevant?\nUse the whole unit.',
      criteria: { true: 'Directly useful.', false: 'Unrelated or uncertain.' },
    },
    negative: { type: 'bool', instructions: 'Is this unrelated?' },
  },
};
const nativeAnswers = {
  'unit:α': { type: 'noul', noul: 0.97, confidence: 0.97 },
  negative: { type: 'noul', noul: 0.03, confidence: 0.97 },
};

function fixture(t, response = { answers: nativeAnswers }) {
  const auth = [];
  const requests = [];
  const ctx = {
    modelRegistry: {
      async getApiKeyForProvider(provider) {
        auth.push(provider);
        return SECRET;
      },
    },
  };
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => response };
  });
  return { ctx, auth, requests, fetch };
}

async function rejectsSanitized(promise) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, FAILURE);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, new RegExp(SECRET + '|' + PROMPT));
    return true;
  });
}

test('uses only Pi Google auth and maps the native request and response', async (t) => {
  const h = fixture(t);
  const controller = new AbortController();
  const original = structuredClone(input);
  const result = await classifyGoogleDecision(h.ctx, input, { signal: controller.signal });
  assert.deepEqual(h.auth, ['google']);
  assert.equal(h.requests.length, 1);
  const { url, options } = h.requests[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
  assert.ok(!url.includes(SECRET));
  assert.equal(new URL(url).search, '');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.signal, controller.signal);
  assert.deepEqual(options.headers, {
    'Content-Type': 'application/json',
    'x-goog-api-key': SECRET,
  });
  assert.deepEqual(JSON.parse(options.body), {
    model: 'gemini-decision-1',
    input: JSON.stringify(input.state),
    questions: {
      'unit:α': {
        type: 'noul', instructions: input.questions['unit:α'].instructions,
        criteria: { true_description: 'Directly useful.', false_description: 'Unrelated or uncertain.' },
      },
      negative: { type: 'noul', instructions: 'Is this unrelated?' },
    },
  });
  assert.deepEqual(result, {
    provider: 'google', model: 'gemini-decision-1', stopReason: 'stop',
    answers: {
      'unit:α': { type: 'bool', probability: 0.97 },
      negative: { type: 'bool', probability: 0.03 },
    },
  });
  assert.deepEqual(input, original);
});

test('preserves special question IDs as own properties', async (t) => {
  const questions = JSON.parse('{"__proto__":{"type":"bool","instructions":"Relevant?"}}');
  const answers = JSON.parse('{"__proto__":{"type":"noul","noul":0.9}}');
  const h = fixture(t, { answers });
  const result = await classifyGoogleDecision(h.ctx, { state: {}, questions });
  assert.deepEqual(Object.keys(result.answers), ['__proto__']);
  assert.equal(result.answers.__proto__.probability, 0.9);
  assert.deepEqual(Object.keys(JSON.parse(h.requests[0].options.body).questions), ['__proto__']);
});

test('rejects omitted answers before a pooled request can report success', async (t) => {
  for (const answers of [{}, { negative: nativeAnswers.negative }]) {
    const h = fixture(t, { answers });
    await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
  }
});

test('rejects invalid probabilities before a pooled request can report success', async (t) => {
  for (const noul of [-0.1, 1.1, NaN, Infinity]) {
    const h = fixture(t, { answers: { negative: { type: 'noul', noul } } });
    await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
  }
});

test('rejects missing or invalid Google credentials without HTTP', async (t) => {
  for (const key of [undefined, null, '', '   ', 12, {}]) {
    const h = fixture(t);
    h.ctx.modelRegistry.getApiKeyForProvider = async () => key;
    await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
    assert.equal(h.requests.length, 0);
  }
});

test('sanitizes credential lookup exceptions without HTTP', async (t) => {
  const h = fixture(t);
  h.ctx.modelRegistry.getApiKeyForProvider = async () => {
    throw new Error(SECRET + PROMPT);
  };
  await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
  assert.equal(h.requests.length, 0);
});

test('already aborted requests do not resolve auth or start HTTP', async (t) => {
  const h = fixture(t);
  const controller = new AbortController();
  controller.abort(new Error(SECRET + PROMPT));
  await rejectsSanitized(classifyGoogleDecision(h.ctx, input, { signal: controller.signal }));
  assert.deepEqual(h.auth, []);
  assert.equal(h.requests.length, 0);
});

test('auth resolving after abort cannot start HTTP', async (t) => {
  const h = fixture(t);
  let resolveAuth;
  h.ctx.modelRegistry.getApiKeyForProvider = () => new Promise((resolve) => { resolveAuth = resolve; });
  const controller = new AbortController();
  const pending = classifyGoogleDecision(h.ctx, input, { signal: controller.signal });
  controller.abort(new Error(SECRET + PROMPT));
  resolveAuth(SECRET);
  await rejectsSanitized(pending);
  assert.equal(h.requests.length, 0);
});

test('checks abort again after serializing state and before HTTP', async (t) => {
  const h = fixture(t);
  const controller = new AbortController();
  const state = { toJSON() { controller.abort(); return {}; } };
  await rejectsSanitized(classifyGoogleDecision(h.ctx, { ...input, state }, { signal: controller.signal }));
  assert.equal(h.requests.length, 0);
});

test('passes cancellation to fetch and sanitizes its rejection without retry', async (t) => {
  const h = fixture(t);
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  h.fetch.mock.mockImplementation(async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    started();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  const pending = classifyGoogleDecision(h.ctx, input, { signal: controller.signal });
  await ready;
  controller.abort(new Error(SECRET + PROMPT));
  await rejectsSanitized(pending);
  assert.equal(h.fetch.mock.callCount(), 1);
});

test('sanitizes HTTP errors without reading their response bodies', async (t) => {
  const h = fixture(t);
  let bodyRead = false;
  h.fetch.mock.mockImplementation(async () => ({
    ok: false, status: 403, statusText: SECRET + PROMPT,
    async json() { bodyRead = true; throw new Error(SECRET); },
    async text() { bodyRead = true; return SECRET + PROMPT; },
  }));
  await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
  assert.equal(bodyRead, false);
  assert.equal(h.fetch.mock.callCount(), 1);
});

test('sanitizes transport and invalid JSON exceptions', async (t) => {
  const h = fixture(t);
  h.fetch.mock.mockImplementation(async () => { throw new Error(SECRET + PROMPT); });
  await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
  h.fetch.mock.mockImplementation(async () => ({
    ok: true, async json() { throw new SyntaxError(SECRET + PROMPT); },
  }));
  await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
});

test('rejects malformed native response shapes and answer types', async (t) => {
  const invalid = [
    null, [], {}, { answers: null }, { answers: [] }, { answers: SECRET },
    ...[null, [], {}, { type: 'bool', probability: 0.97 },
      { type: 'choice', noul: 0.97 }, { type: 'noul', confidence: 0.97 },
      { type: 'noul', noul: '0.97' }, { type: 'noul', noul: null },
      { type: 'noul', noul: true },
    ].map((answer) => ({ answers: { negative: answer } })),
  ];
  for (const response of invalid) {
    const h = fixture(t, response);
    await rejectsSanitized(classifyGoogleDecision(h.ctx, input));
  }
});

test('rejects malformed inputs and non-boolean question types without HTTP', async (t) => {
  const invalid = [
    null, [], {}, { state: {}, questions: null }, { state: {}, questions: [] },
    { state: undefined, questions: input.questions },
    ...[null, [], {}, { type: 'noul', instructions: 'No native passthrough.' },
      { type: 'choice', instructions: 'No choices.' },
      { type: 'bool', instructions: 12 }, { type: 'bool', instructions: 'Check', criteria: null },
      { type: 'bool', instructions: 'Check', criteria: { true: 1, false: 'No' } },
      { type: 'bool', instructions: 'Check', criteria: { true: 'Yes' } },
    ].map((question) => ({ state: {}, questions: { bad: question } })),
  ];
  for (const value of invalid) {
    const h = fixture(t);
    await rejectsSanitized(classifyGoogleDecision(h.ctx, value));
    assert.equal(h.requests.length, 0);
  }
});

test('sanitizes serialization errors without HTTP', async (t) => {
  const circular = {};
  circular.self = circular;
  for (const state of [circular, 1n, { toJSON() { throw new Error(SECRET + PROMPT); } }]) {
    const h = fixture(t);
    await rejectsSanitized(classifyGoogleDecision(h.ctx, { ...input, state }));
    assert.equal(h.requests.length, 0);
  }
});
