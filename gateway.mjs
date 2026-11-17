import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parsePool, quotaFailure } from './keys.mjs';

const MODEL = 'models/gemini-embedding-2';
const PREFIX = `/v1beta/${MODEL}:`;
const GOOGLE = 'https://generativelanguage.googleapis.com';
const HINDSIGHT = 'http://127.0.0.1:8888';
const BOOTSTRAP_MS = 300000;
const MAX_BATCH_ITEMS = 100;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function equal(a, b) {
  return typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function send(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function bodyOf(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new HttpError(413, 'Embedding request exceeds 8 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
function validateRequest(value) {
  if (!value || typeof value !== 'object' || (value.model && value.model !== MODEL)) throw new HttpError(400, 'Unsupported embedding model');
  const parts = value.content?.parts;
  if (!Array.isArray(parts) || !parts.length || parts.some(p => typeof p.text !== 'string' || Object.keys(p).some(k => k !== 'text'))) {
    throw new HttpError(400, 'Only text embedding inputs are supported');
  }
  if (value.outputDimensionality !== 768) throw new HttpError(400, 'Expected 768 embedding dimensions');
  return { ...value, model: MODEL };
}

export async function createGateway({
  googleKey, controlToken, queryToken, passageToken, stateDir, poolPath,
  now = () => performance.timeOrigin + performance.now(), fetchGoogle = fetch, log = console.log,
}) {
  if ([googleKey, controlToken, queryToken, passageToken].some(v => !v)) throw new Error('Missing gateway credentials');
  if (new Set([controlToken, queryToken, passageToken]).size !== 3) throw new Error('Gateway keys must be distinct');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // A daily cap must outlive a restart, or each restart spends requests rediscovering it.
  const quotaPath = join(stateDir, 'quota.json');
  const blocked = new Map();
  try {
    for (const [id, until] of Object.entries(JSON.parse(await readFile(quotaPath, 'utf8')).blocked)) {
      if (Number.isFinite(until)) blocked.set(id, until);
    }
  } catch { /* A missing or damaged cache costs one rejected request per capped key. */ }
  let saving = Promise.resolve();
  const saveBlocked = () => saving = saving.then(async () => {
    const temporary = quotaPath + '.tmp';
    const current = [...blocked].filter(([, until]) => until > now());
    await writeFile(temporary, JSON.stringify({ blocked: Object.fromEntries(current) }) + '\n', { mode: 0o600 });
    await rename(temporary, quotaPath);
  }).catch(() => log(JSON.stringify({ event: 'quota_state_save_failed' })));
  const reserved = { id: 'reserved', label: 'reserved', key: googleKey };
  let pool = [], poolRead = -Infinity, poolError = false, turn = 0;
  const candidates = async role => {
    if (poolPath && now() - poolRead >= 60000) {
      poolRead = now();
      try {
        pool = parsePool(await readFile(poolPath, 'utf8')).filter(a => a.key !== googleKey);
        poolError = false;
      } catch {
        pool = [];
        if (!poolError) log(JSON.stringify({ event: 'pool_unavailable' }));
        poolError = true;
      }
    }
    // The reserved key serves queries first. Stored text uses it only when there is no pool.
    if (role === 'query' || !pool.length) return [reserved, ...pool];
    // Each stored-text batch starts at the next pool key, so load spreads across keys.
    const start = turn++ % pool.length;
    return [...pool.slice(start), ...pool.slice(0, start)];
  };
  await candidates('query');
  const google = async (operation, body, role, entry) => {
    let until = Infinity;
    for (const account of await candidates(role)) {
      const blockedUntil = blocked.get(account.id) ?? 0;
      if (blockedUntil > now()) { until = Math.min(until, blockedUntil); continue; }
      const record = { ...entry, key: account.label };
      let response;
      try {
        response = await fetchGoogle(GOOGLE + PREFIX + operation, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': account.key },
          body: JSON.stringify(body), signal: AbortSignal.timeout(300000), redirect: 'error',
        });
      } catch (error) {
        log(JSON.stringify({ ...record, at: now(), status: 'no_response' }));
        throw error;
      }
      record.at = now(); record.status = response.status;
      if (response.ok) {
        log(JSON.stringify(record));
        return response.json();
      }
      if (response.status !== 429) {
        await response.body?.cancel();
        log(JSON.stringify(record));
        throw new HttpError(502, `Google request failed (HTTP ${response.status})`);
      }
      const { quotaId, blockMs } = quotaFailure(await response.text().catch(() => ''));
      blocked.set(account.id, now() + blockMs);
      until = Math.min(until, now() + blockMs);
      log(JSON.stringify({ ...record, quotaId, blockedUntil: now() + blockMs }));
      await saveBlocked();
    }
    throw new HttpError(429, `Google embedding quota exhausted until ${new Date(until).toISOString()}`);
  };
  const embed = async (requests, mode = 'normal') => {
    const embeddings = [];
    // Google's batch endpoint takes at most 100 inputs per request.
    for (let i = 0; i < requests.length; i += MAX_BATCH_ITEMS) {
      const batch = requests.slice(i, i + MAX_BATCH_ITEMS);
      // Hindsight's startup probe must not depend on the stored-text quota.
      const data = await google('batchEmbedContents', { requests: batch },
        mode === 'bootstrap' ? 'query' : 'passage', { event: 'passage_batch', mode, inputs: batch.length });
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== batch.length || data.embeddings.some(e =>
        !Array.isArray(e.values) || e.values.length !== 768 || e.values.some(v => !Number.isFinite(v)))) {
        throw new HttpError(502, 'Google embedding response count or dimensions mismatch');
      }
      // Keep native vectors; Hindsight performs its existing L2 normalization.
      embeddings.push(...data.embeddings);
    }
    return embeddings;
  };
  let bootstrapUntil = 0, bootstrapBusy = false;
  const status = () => ({
    bootstrap: now() < bootstrapUntil,
    keys: [reserved, ...pool].map(a => ({ key: a.label, blockedUntil: blocked.get(a.id) > now() ? blocked.get(a.id) : null })),
  });
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/v1\//, '/v1beta/');
      if (req.method === 'GET' && path === '/health') { send(res, 200, status()); return; }
      if (req.method === 'POST' && path === '/control/bootstrap') {
        if (!equal(req.headers.authorization, `Bearer ${controlToken}`)) throw new HttpError(401, 'Unauthorized');
        req.resume();
        bootstrapUntil = now() + BOOTSTRAP_MS;
        send(res, 202, { bootstrap: true });
        return;
      }
      if (req.method !== 'POST' || ![PREFIX + 'batchEmbedContents', PREFIX + 'embedContent'].includes(path)) throw new HttpError(404, 'Unsupported route');
      const key = req.headers['x-goog-api-key'];
      const isQuery = equal(key, queryToken), isPassage = equal(key, passageToken);
      if (!isQuery && !isPassage) throw new HttpError(401, 'Unauthorized');
      const body = await bodyOf(req);
      const batched = path.endsWith(':batchEmbedContents');
      const requests = batched ? body.requests : [body];
      if (!Array.isArray(requests) || requests.length < 1 || requests.length > 1000) throw new HttpError(400, 'Expected 1–1000 embedding inputs');
      const inputs = requests.map(validateRequest);
      if (isQuery) {
        const response = await google(batched ? 'batchEmbedContents' : 'embedContent', batched ? { requests: inputs } : inputs[0],
          'query', { event: 'query_embed', inputs: inputs.length });
        send(res, 200, response); return;
      }
      let vectors;
      if (now() < bootstrapUntil && !bootstrapBusy && inputs.length === 1) {
        bootstrapBusy = true;
        try { vectors = await embed(inputs, 'bootstrap'); bootstrapUntil = 0; }
        finally { bootstrapBusy = false; }
      } else {
        vectors = await embed(inputs);
      }
      send(res, 200, batched ? { embeddings: vectors } : { embedding: vectors[0] });
    } catch (error) {
      send(res, error.status ?? 502, { error: { message: error instanceof HttpError ? error.message : 'Embedding gateway request failed' } });
    }
  });
  return { server, status, close() { server.closeAllConnections(); server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = await createGateway({
    googleKey: process.env.HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY,
    controlToken: process.env.EMBEDDING_GATEWAY_TOKEN,
    queryToken: process.env.EMBEDDING_GATEWAY_QUERY_TOKEN,
    passageToken: process.env.EMBEDDING_GATEWAY_PASSAGE_TOKEN,
    stateDir: join(homedir(), '.local/state/pi-hindsight-embedding-batcher'),
    poolPath: join(homedir(), '.local/share/pi/agent/multiprovider-auth.json'),
  });
  gateway.server.listen(8890, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { gateway.close(); process.exit(0); });
}
