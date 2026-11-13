import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBatchQueue } from './batching.mjs';

function setup(options = {}) {
  let now = 0;
  const calls = [], saved = [];
  const queue = new TokenBatchQueue({ now: () => now, persist: async t => saved.push(t), embed: async items => { calls.push(items); return items.map(x => x.id); }, ...options });
  return { queue, calls, saved, time: t => { now = t; } };
}
const item = (id, tokens = 7000) => ({ id, tokens });

test('waits one minute, caps at 28000, preserves results across batches', async () => {
  const s = setup();
  const result = s.queue.submit([1,2,3,4,5].map(n => item(n)));
  await s.queue.tick(); assert.equal(s.calls.length, 0);
  s.time(59999); await s.queue.tick(); assert.equal(s.calls.length, 0);
  s.time(60000); await s.queue.tick(); assert.equal(s.calls[0].length, 4);
  await s.queue.tick(); assert.equal(s.calls.length, 1);
  s.time(120000); await s.queue.tick();
  assert.deepEqual(await result, [1,2,3,4,5]);
  assert.deepEqual(s.saved, [60000,120000]);
});
test('never bursts to catch up after delayed timers', async () => {
  const s=setup(); const p=s.queue.submit(Array.from({length:9},(_,i)=>item(i)));
  s.time(300000); await s.queue.tick(); await s.queue.tick(); assert.equal(s.calls.length,1);
  await s.queue.tick({drain:true}); await s.queue.tick({drain:true}); await p;
});
test('drain bypasses cadence and still caps tokens and item count', async () => {
  const s=setup(); const p=s.queue.submit(Array.from({length:101},(_,i)=>item(i,1)));
  await s.queue.tick({drain:true}); assert.equal(s.calls[0].length,100);
  await s.queue.tick({drain:true}); assert.equal((await p).length,101);
  const q=s.queue.submit([item(200)]); await s.queue.tick(); assert.equal(s.calls.length,2);
  s.time(60000); await s.queue.tick(); await q;
});
test('rejects oversized or invalid individual tokens without dispatch', async () => {
  const s=setup();
  for(const tokens of [8193,-1,1.5,NaN]) await assert.rejects(s.queue.submit([item(1,tokens)]));
  const p=s.queue.submit([item(1,8192)]); await s.queue.tick({drain:true}); await p;
  assert.equal(s.calls.length,1);
});
test('a failed upstream attempt consumes a minute and removes its whole request', async () => {
  let calls=0; const s=setup({embed:async()=>{ calls++; throw new Error('upstream failed'); }});
  const p=s.queue.submit(Array.from({length:5},(_,i)=>item(i))); const failed=assert.rejects(p,/upstream failed/);
  s.time(60000); await s.queue.tick(); await failed; assert.equal(s.queue.queued,0);
  const q=s.queue.submit([item(10)]); const second=assert.rejects(q);
  s.time(60001); await s.queue.tick(); assert.equal(calls,1);
  s.time(120000); await s.queue.tick(); await second; assert.equal(calls,2);
});
test('removes disconnected requests before spending tokens', async () => {
  const s=setup(), controller=new AbortController();
  const p=s.queue.submit([item(1)],{signal:controller.signal}); const cancelled=assert.rejects(p);
  controller.abort(); await cancelled; s.time(60000); await s.queue.tick();
  assert.equal(s.calls.length,0); assert.equal(s.queue.queued,0);
});
test('concurrent ticks cannot dispatch twice', async () => {
  let done; const s=setup({embed:items=>new Promise(r=>{done=()=>r(items.map(x=>x.id));})});
  const p=s.queue.submit([item(1)]); s.time(60000); const tick=s.queue.tick();
  await new Promise(r=>setImmediate(r)); await s.queue.tick({drain:true});
  assert.equal(s.queue.inFlight,1); done(); await tick; await p;
});
test('restored timestamp prevents dispatch after quick restart', async () => {
  const s=setup({lastDispatch:50000}); const p=s.queue.submit([item(1)]);
  s.time(109999); await s.queue.tick(); assert.equal(s.calls.length,0);
  s.time(110000); await s.queue.tick(); await p;
});
test('cannot send if durable timestamp write fails', async () => {
  const s=setup({persist:async()=>{throw new Error('disk full');}});
  const p=s.queue.submit([item(1)]); const failed=assert.rejects(p,/disk full/);
  await s.queue.tick({drain:true}); await failed; assert.equal(s.calls.length,0);
});

test('storage and upstream latency cannot shorten the rolling minute', async () => {
  let now=0, calls=0;
  const queue=new TokenBatchQueue({now:()=>now,persist:async()=>{now+=100;},embed:async items=>{calls++;now+=500;return items.map(x=>x.id);}});
  const a=queue.submit([item(1)]);now=60000;await queue.tick();await a;
  const b=queue.submit([item(2)]);now=120000;await queue.tick();assert.equal(calls,1);
  now=120600;await queue.tick();await b;assert.equal(calls,2);
});
