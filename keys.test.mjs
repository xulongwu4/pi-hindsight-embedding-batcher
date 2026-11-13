import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePool, quotaFailure } from './keys.mjs';

const account = (id, extra = {}) => ({ id, label: id.toUpperCase(), authKind: 'api-key', credential: { type: 'api_key', key: `key-${id}` }, enabled: true, ...extra });
const file = accounts => JSON.stringify({ version: 1, providers: { google: { accounts }, antigravity: { accounts: [account('x')] } } });

test('pool keeps enabled Google API-key accounts in file order', () => {
  const pool = parsePool(file([
    account('a'), account('off', { enabled: false }),
    account('oauth', { credential: { type: 'oauth', access: 'token' } }), account('b'),
  ]));
  assert.deepEqual(pool, [{ id: 'a', label: 'A', key: 'key-a' }, { id: 'b', label: 'B', key: 'key-b' }]);
});
test('pool file without Google accounts or with invalid JSON is rejected', () => {
  assert.throws(() => parsePool('{"providers":{}}'));
  assert.throws(() => parsePool('not json'));
});
test('quota failure exposes the quota ID and retry delay', () => {
  const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '55567.5s' },
  ] } });
  assert.deepEqual(quotaFailure(body), { quotaId: 'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier', blockMs: 55567500 });
});
test('quota failure without details uses a default block', () => {
  assert.deepEqual(quotaFailure('<html>'), { quotaId: null, blockMs: 60000 });
  assert.deepEqual(quotaFailure(JSON.stringify({ error: { details: [{ violations: [{ quotaId: 'XPerDayY' }] }] } })), { quotaId: 'XPerDayY', blockMs: 3600000 });
});
