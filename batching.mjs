export const MAX_BATCH_TOKENS = 28000;
export const MAX_INPUT_TOKENS = 8192;
export const MAX_BATCH_ITEMS = 100;
export const INTERVAL_MS = 60000;

export class TokenBatchQueue {
  constructor({ embed, persist, now = () => performance.timeOrigin + performance.now(), lastDispatch = now() }) {
    this.embed = embed;
    this.persist = persist;
    this.now = now;
    this.lastDispatch = lastDispatch;
    this.entries = [];
    this.inFlight = 0;
    this.busy = false;
  }

  get queued() { return this.entries.length; }
  get queuedTokens() { return this.entries.reduce((n, e) => n + e.item.tokens, 0); }

  submit(items, { signal } = {}) {
    if (!items.length || items.some(x => !Number.isSafeInteger(x.tokens) || x.tokens < 0 || x.tokens > MAX_INPUT_TOKENS)) {
      return Promise.reject(new Error('Each input must have between 0 and 8192 Gemini tokens'));
    }
    return new Promise((resolve, reject) => {
      const group = { results: new Array(items.length), remaining: items.length, settled: false };
      const finish = (error) => {
        if (group.settled) return;
        group.settled = true;
        signal?.removeEventListener('abort', abort);
        this.entries = this.entries.filter(e => e.group !== group);
        if (error) reject(error); else resolve(group.results);
      };
      const abort = () => finish(new Error('Embedding caller disconnected'));
      group.finish = finish;
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.entries.push(...items.map((item, index) => ({ item, index, group })));
    });
  }

  async tick({ drain = false } = {}) {
    if (this.busy || !this.entries.length) return;
    if (!drain && this.now() - this.lastDispatch < INTERVAL_MS) return;
    this.busy = true;
    const batch = [];
    let tokens = 0;
    while (this.entries.length && batch.length < MAX_BATCH_ITEMS) {
      const next = this.entries[0];
      if (tokens + next.item.tokens > MAX_BATCH_TOKENS) break;
      batch.push(this.entries.shift());
      tokens += next.item.tokens;
    }
    this.inFlight = batch.length;
    try {
      // Persist before every attempt, including failed attempts and final-drain calls.
      this.lastDispatch = this.now();
      await this.persist(this.lastDispatch);
      const active = batch.filter(e => !e.group.settled);
      if (!active.length) return;
      const vectors = await this.embed(active.map(e => e.item), { drain });
      if (!Array.isArray(vectors) || vectors.length !== active.length) throw new Error('Embedding response count mismatch');
      active.forEach((entry, i) => {
        const group = entry.group;
        if (group.settled) return;
        group.results[entry.index] = vectors[i];
        if (--group.remaining === 0) group.finish();
      });
    } catch (error) {
      for (const { group } of batch) group.finish(error);
    } finally {
      // Start the next cooldown after completion, so disk/network latency cannot
      // move actual outbound attempts less than a minute apart.
      this.lastDispatch = Math.max(this.lastDispatch, this.now());
      this.inFlight = 0;
      this.busy = false;
    }
  }
}
