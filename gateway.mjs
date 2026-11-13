import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { TokenBatchQueue, MAX_INPUT_TOKENS } from './batching.mjs';

const MODEL = 'models/gemini-embedding-2';
const PREFIX = `/v1beta/${MODEL}:`;
const GOOGLE = 'https://generativelanguage.googleapis.com';
const HINDSIGHT = 'http://127.0.0.1:8888';
const DRAIN_LIMIT = 300000;
const QUIET_MS = 3000;

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

// Check operation counts, not document payloads. A quiet queue alone is insufficient:
// a blocked append may finish and release another already-accepted retain later.
export async function hasPendingOperations({ signal, fetchStatus = fetch } = {}) {
  const get = async path => {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(5000);
    const response = await fetchStatus(HINDSIGHT + path, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error('Hindsight operation status unavailable');
    return response.json();
  };
  for (let offset = 0; ;) {
    const page = await get(`/v1/default/banks?limit=100&offset=${offset}`);
    if (!Array.isArray(page?.banks) || !Number.isSafeInteger(page.total) || page.total < 0 ||
        page.banks.some(bank => typeof bank?.bank_id !== 'string' || !bank.bank_id) ||
        (page.banks.length === 0 && offset < page.total)) throw new Error('Invalid Hindsight bank status');
    for (const bank of page.banks) {
      const id = encodeURIComponent(bank.bank_id);
      for (const state of ['pending', 'processing']) {
        for (const type of ['retain', 'consolidation', 'refresh_mental_model', 'file_convert_retain']) {
          const result = await get(`/v1/default/banks/${id}/operations?status=${state}&type=${type}&limit=1&exclude_parents=true`);
          if (!Number.isSafeInteger(result?.total) || result.total < 0 || !Array.isArray(result.operations) ||
              result.operations.length !== Math.min(result.total, 1)) throw new Error('Invalid Hindsight operation status');
          if (result.total > 0) return true;
        }
      }
    }
    offset += page.banks.length;
    if (offset >= page.total) return false;
  }
}

export async function createGateway({
  googleKey, controlToken, queryToken, passageToken, stateDir,
  now = () => performance.timeOrigin + performance.now(), fetchGoogle = fetch, hasPending = hasPendingOperations,
  background = true, log = console.log,
}) {
  if ([googleKey, controlToken, queryToken, passageToken].some(v => !v)) throw new Error('Missing gateway credentials');
  if (new Set([controlToken, queryToken, passageToken]).size !== 3) throw new Error('Gateway keys must be distinct');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, 'dispatch.json');
  let lastDispatch = now();
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (!Number.isFinite(saved.lastDispatch)) throw new Error('Invalid dispatch state');
    lastDispatch = Math.max(saved.lastDispatch, now()); // Conservative full minute after a restart.
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const persist = async timestamp => {
    const temporary = statePath + '.tmp';
    await writeFile(temporary, JSON.stringify({ lastDispatch: timestamp }) + '\n', { mode: 0o600, flush: true });
    await rename(temporary, statePath);
  };
  const google = async (operation, body) => {
    const response = await fetchGoogle(GOOGLE + PREFIX + operation, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': googleKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(300000), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status === 429 ? 429 : 502, `Google request failed (HTTP ${response.status})`);
    }
    return response.json();
  };
  const embed = async (items, mode = 'normal') => {
    const tokens = items.reduce((n, x) => n + x.tokens, 0);
    log(JSON.stringify({ event: 'passage_batch', at: now(), mode, tokens, inputs: items.length }));
    const data = await google('batchEmbedContents', { requests: items.map(x => x.request) });
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== items.length || data.embeddings.some(e =>
      !Array.isArray(e.values) || e.values.length !== 768 || e.values.some(v => !Number.isFinite(v)))) {
      throw new HttpError(502, 'Google embedding response count or dimensions mismatch');
    }
    // Keep native vectors; Hindsight performs its existing L2 normalization.
    return data.embeddings;
  };
  const queue = new TokenBatchQueue({ embed: (items, { drain }) => embed(items, drain ? 'drain' : 'normal'), persist, now, lastDispatch });
  let bootstrapUntil = 0, bootstrapBusy = false;
  let draining = false, drainStatus = 'idle', drainError = null, drainDeadline = 0;
  let drainFailedRequests = 0;
  let processingRequests = 0, lastArrival = now(), quietSince = null, nextStatusCheck = 0;
  let tickBusy = false;
  const status = () => ({
    queued: queue.queued, queuedTokens: queue.queuedTokens, inFlight: queue.inFlight,
    processingRequests, lastDispatch: queue.lastDispatch,
    draining, drainStatus, drainError, drainFailedRequests, bootstrap: now() < bootstrapUntil,
    intervalMs: 60000, maxBatchTokens: 28000,
  });
  const expireDrain = () => {
    if (draining && now() >= drainDeadline) {
      draining = false; drainStatus = 'failed'; drainError = 'Drain exceeded five minutes; pending work remains on normal cadence';
      log(JSON.stringify({ event: 'drain_failed', reason: drainError }));
    }
  };
  const tick = async () => {
    // A hanging upstream/status request must not prevent deadline expiration.
    expireDrain();
    if (tickBusy) return;
    tickBusy = true;
    try {
      await queue.tick({ drain: draining });
      expireDrain();
      if (!draining || now() < nextStatusCheck) return;
      nextStatusCheck = now() + 1000;
      try {
        const pending = await hasPending({ signal: AbortSignal.timeout(Math.max(1, Math.ceil(drainDeadline - now()))) });
        expireDrain();
        if (!draining) return;
        if (pending || queue.queued || queue.inFlight || processingRequests) { quietSince = null; return; }
        quietSince ??= now();
        if (now() - Math.max(quietSince, lastArrival) >= QUIET_MS) {
          draining = false;
          drainStatus = drainFailedRequests ? 'failed' : 'complete';
          drainError = drainFailedRequests ? 'One or more passage embedding requests failed during drain; inspect Hindsight operations' : null;
          log(JSON.stringify({ event: drainFailedRequests ? 'drain_failed' : 'drain_complete', failedRequests: drainFailedRequests }));
        }
      } catch {
        quietSince = null;
        expireDrain();
        if (draining) drainError = 'Cannot confirm Hindsight operation status; continuing drain until deadline';
      }
    } finally { tickBusy = false; }
  };
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    let passageRequest = false;
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/v1\//, '/v1beta/');
      if (req.method === 'GET' && path === '/health') { send(res, 200, status()); return; }
      if (req.method === 'POST' && ['/control/drain', '/control/bootstrap'].includes(path)) {
        if (!equal(req.headers.authorization, `Bearer ${controlToken}`)) throw new HttpError(401, 'Unauthorized');
        req.resume();
        if (path.endsWith('/bootstrap')) {
          bootstrapUntil = now() + DRAIN_LIMIT;
          send(res, 202, { bootstrap: true });
        } else {
          if (!draining) { drainFailedRequests = 0; drainError = null; }
          draining = true; drainStatus = 'draining';
          drainDeadline = now() + DRAIN_LIMIT; quietSince = null; nextStatusCheck = 0; lastArrival = now();
          send(res, 202, { draining: true });
        }
        return;
      }
      if (req.method !== 'POST' || ![PREFIX + 'batchEmbedContents', PREFIX + 'embedContent'].includes(path)) throw new HttpError(404, 'Unsupported route');
      const key = req.headers['x-goog-api-key'];
      const isQuery = equal(key, queryToken), isPassage = equal(key, passageToken);
      if (!isQuery && !isPassage) throw new HttpError(401, 'Unauthorized');
      passageRequest = isPassage;
      const body = await bodyOf(req);
      const batched = path.endsWith(':batchEmbedContents');
      const requests = batched ? body.requests : [body];
      if (!Array.isArray(requests) || requests.length < 1 || requests.length > 1000) throw new HttpError(400, 'Expected 1–1000 embedding inputs');
      const inputs = requests.map(validateRequest);
      if (isQuery) {
        const response = await google(batched ? 'batchEmbedContents' : 'embedContent', batched ? { requests: inputs } : inputs[0]);
        send(res, 200, response); return;
      }
      processingRequests++; lastArrival = now();
      try {
        const counted = [];
        // Counting calls are not embedding calls. They never spend a dispatch slot.
        for (let i = 0; i < inputs.length; i += 4) {
          controller.signal.throwIfAborted();
          const slice = await Promise.all(inputs.slice(i, i + 4).map(async request => {
            const result = await google('countTokens', { contents: [request.content] });
            if (!Number.isSafeInteger(result.totalTokens) || result.totalTokens < 0) throw new HttpError(502, 'Invalid Google token count');
            if (result.totalTokens > MAX_INPUT_TOKENS) throw new HttpError(422, 'Individual embedding input exceeds 8192 Gemini tokens');
            return { request, tokens: result.totalTokens };
          }));
          counted.push(...slice);
        }
        controller.signal.throwIfAborted();
        let vectors;
        if (now() < bootstrapUntil && !bootstrapBusy && counted.length === 1) {
          bootstrapBusy = true;
          try { vectors = await embed(counted, 'bootstrap'); bootstrapUntil = 0; }
          finally { bootstrapBusy = false; }
        } else {
          vectors = await queue.submit(counted, { signal: controller.signal });
        }
        send(res, 200, batched ? { embeddings: vectors } : { embedding: vectors[0] });
      } finally { processingRequests--; }
    } catch (error) {
      if (passageRequest && draining) {
        drainFailedRequests++;
        drainError = 'One or more passage embedding requests failed during drain; inspect Hindsight operations';
      }
      send(res, error.status ?? 502, { error: { message: error instanceof HttpError ? error.message : 'Embedding gateway request failed' } });
    }
  });
  const timer = background ? setInterval(() => { void tick().catch(() => log(JSON.stringify({ event: 'gateway_tick_failed' }))); }, 250) : null;
  return { server, tick, status, close() { clearInterval(timer); server.closeAllConnections(); server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = await createGateway({
    googleKey: process.env.HINDSIGHT_API_EMBEDDINGS_GEMINI_API_KEY,
    controlToken: process.env.EMBEDDING_GATEWAY_TOKEN,
    queryToken: process.env.EMBEDDING_GATEWAY_QUERY_TOKEN,
    passageToken: process.env.EMBEDDING_GATEWAY_PASSAGE_TOKEN,
    stateDir: join(homedir(), '.local/state/pi-hindsight-embedding-batcher'),
  });
  gateway.server.listen(8890, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { gateway.close(); process.exit(0); });
}
