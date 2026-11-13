import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './gateway.mjs';
const model='models/gemini-embedding-2';
const input=(text)=>({model,content:{parts:[{text}]},outputDimensionality:768});
const body=(...texts)=>({requests:texts.map(input)});
const url='/v1beta/models/gemini-embedding-2:batchEmbedContents';
const waitFor=async(check)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not reached');};
async function setup(t,extra={}) {
 let now=0; const calls=[]; const stateDir=await mkdtemp(join(tmpdir(),'embedding-test-'));
 const google=async(u,options)=>{
  const data=JSON.parse(options.body); calls.push({url:u,headers:options.headers,data});
  if(u.endsWith(':countTokens'))return Response.json({totalTokens:Number(data.contents[0].parts[0].text)||1});
  const texts=data.requests?.map(x=>x.content.parts[0].text)??[data.content.parts[0].text];
  return Response.json(data.requests?{embeddings:texts.map(s=>({values:Array(768).fill(Number(s)||1)}))}:{embedding:{values:Array(768).fill(1)}});
 };
 const gateway=await createGateway({googleKey:'real-google-key',controlToken:'control-key',queryToken:'query-key',passageToken:'passage-key',stateDir,now:()=>now,fetchGoogle:google,hasPending:async()=>false,background:false,log:()=>{},...extra});
 await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${gateway.server.address().port}`;
 const post=(path,data,key='passage-key')=>fetch(base+path,{method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const control=(path)=>fetch(base+'/control/'+path,{method:'POST',headers:{Authorization:'Bearer control-key'}});
 t.after(async()=>{gateway.close();await rm(stateDir,{recursive:true,force:true});});
 return {gateway,calls,stateDir,base,post,control,time:t=>{now=t;}};
}
test('query is immediate, passage waits, upstream receives real key only',async t=>{
 const s=await setup(t);
 assert.equal((await s.post(url,body('1'),'query-key')).status,200);
 const pending=s.post(url,body('7000'));
 await waitFor(()=>s.gateway.status().queued===1);
 await s.gateway.tick(); assert.equal(s.calls.filter(c=>c.url.endsWith(':batchEmbedContents')).length,1);
 s.time(60000);await s.gateway.tick();assert.equal((await pending).status,200);
 assert(s.calls.every(c=>c.headers['x-goog-api-key']==='real-google-key'));
 assert.equal(JSON.parse(await readFile(join(s.stateDir,'dispatch.json'),'utf8')).lastDispatch,60000);
});
test('splits large incoming requests and reconstructs ordered native responses',async t=>{
 const s=await setup(t);const pending=s.post(url,body('8192','8191','8190','8189'));
 await waitFor(()=>s.gateway.status().queued===4);
 s.time(60000);await s.gateway.tick();assert.equal(s.gateway.status().queued,1);
 s.time(120000);await s.gateway.tick();const d=await (await pending).json();
 assert.deepEqual(d.embeddings.map(e=>e.values[0]),[8192,8191,8190,8189]);
});
test('rejects bad auth, input length, models and routes without embedding',async t=>{
 const s=await setup(t);
 assert.equal((await s.post(url,body('1'),'wrong')).status,401);
 assert.equal((await s.post(url,body('8193'))).status,422);
 assert.equal((await s.post(url,{requests:[{...input('1'),model:'models/wrong'}]})).status,400);
 assert.equal((await s.post('/v1beta/models/gemini-embedding-2:generateContent',{})).status,404);
 assert.equal(s.calls.filter(c=>c.url.endsWith(':batchEmbedContents')).length,0);
});
test('bootstrap is explicit, expiring, single-success and not inferred from text',async t=>{
 const s=await setup(t);assert.equal((await s.control('bootstrap')).status,202);
 assert.equal((await s.post(url,body('initialization'))).status,200);
 const pending=s.post(url,body('test'));await waitFor(()=>s.gateway.status().queued===1);
 s.time(60000);await s.gateway.tick();await pending;
 await s.control('bootstrap');s.time(360001);
 const second=s.post(url,body('test'));await waitFor(()=>s.gateway.status().queued===1);
 await s.gateway.tick();await second;
});
test('drain stays open for accepted server work and late embeddings',async t=>{
 let busy=true;const s=await setup(t,{hasPending:async()=>busy});
 const response=await s.control('drain');assert.equal(response.status,202);assert.equal((await response.json()).draining,true);
 s.time(5000);await s.gateway.tick();assert.equal(s.gateway.status().draining,true);
 const pending=s.post(url,body('1'));await waitFor(()=>s.gateway.status().queued===1);await s.gateway.tick();await pending;
 busy=false;s.time(6000);await s.gateway.tick();s.time(9001);await s.gateway.tick();
 assert.equal(s.gateway.status().drainStatus,'complete');
});
test('drain status fails visibly on deadline rather than claiming completion',async t=>{
 const s=await setup(t,{hasPending:async()=>true});await s.control('drain');s.time(300001);await s.gateway.tick();
 assert.equal(s.gateway.status().draining,false);assert.equal(s.gateway.status().drainStatus,'failed');
});
test('upstream vector mismatch fails request rather than returning fabricated data',async t=>{
 const s=await setup(t,{fetchGoogle:async(u)=>Response.json(u.endsWith(':countTokens')?{totalTokens:1}:{embeddings:[]})});
 const pending=s.post(url,body('1'));await waitFor(()=>s.gateway.status().queued===1);s.time(60000);await s.gateway.tick();
 assert.equal((await pending).status,502);
});

test('supports the installed SDK v1 route as well as v1beta',async t=>{
 const s=await setup(t);
 const response=await s.post(url.replace('/v1beta/','/v1/'),body('1'),'query-key');
 assert.equal(response.status,200);
});

test('a status check crossing the drain deadline cannot report completion',async t=>{
 let advance=()=>{};const s=await setup(t,{hasPending:async()=>{advance();return false;}});
 await s.control('drain');await s.gateway.tick();s.time(4000);advance=()=>s.time(300001);
 await s.gateway.tick();assert.equal(s.gateway.status().drainStatus,'failed');
});
test('a hanging status check does not prevent deadline expiration',async t=>{
 let release;const s=await setup(t,{hasPending:()=>new Promise(r=>{release=r;})});
 await s.control('drain');const pending=s.gateway.tick();await waitFor(()=>release);
 s.time(300001);await s.gateway.tick();assert.equal(s.gateway.status().drainStatus,'failed');
 release(false);await pending;assert.equal(s.gateway.status().drainStatus,'failed');
});

test('fractional monotonic timestamps still permit confirmed drain completion',async t=>{
 const s=await setup(t);s.time(0.25);await s.control('drain');
 s.time(1.5);await s.gateway.tick();s.time(4001.75);await s.gateway.tick();
 assert.equal(s.gateway.status().drainStatus,'complete');
});

test('an upstream failure during drain cannot turn an empty queue into success',async t=>{
 const s=await setup(t,{fetchGoogle:async u=>u.endsWith(':countTokens')?Response.json({totalTokens:1}):Response.json({error:{}},{status:503})});
 await s.control('drain');const request=s.post(url,body('1'));
 await waitFor(()=>s.gateway.status().queued===1);await s.gateway.tick();assert.equal((await request).status,502);
 s.time(1000);await s.gateway.tick();s.time(5000);await s.gateway.tick();
 assert.equal(s.gateway.status().draining,false);assert.equal(s.gateway.status().drainStatus,'failed');
 assert.equal(s.gateway.status().drainFailedRequests,1);assert.match(s.gateway.status().drainError,/embedding request.*failed/);
});
test('counting failure during drain is reported even when nothing reached the queue',async t=>{
 const s=await setup(t,{fetchGoogle:async()=>Response.json({error:{}},{status:429})});
 await s.control('drain');assert.equal((await s.post(url,body('1'))).status,429);
 await s.gateway.tick();s.time(4000);await s.gateway.tick();assert.equal(s.gateway.status().drainStatus,'failed');
});

const poolFile=async(s,accounts)=>{const path=join(s.stateDir,'pool.json');await writeFile(path,JSON.stringify({version:1,providers:{google:{accounts:accounts.map(id=>({id,label:id.toUpperCase(),credential:{type:'api_key',key:'key-'+id},enabled:true}))}}}));return path;};
const capped=(seconds)=>Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[{violations:[{quotaId:'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier'}]},{retryDelay:seconds+'s'}]}},{status:429});
const pooled=async(t,down,extra={})=>{
 const logs=[];const dir={stateDir:await mkdtemp(join(tmpdir(),'embedding-pool-'))};t.after(()=>rm(dir.stateDir,{recursive:true,force:true}));
 const poolPath=await poolFile(dir,['a','b']);let base;
 const options={poolPath,log:x=>logs.push(JSON.parse(x)),fetchGoogle:async(u,o)=>{const key=o.headers['x-goog-api-key'];base.calls.push({url:u,key});
  if(!u.endsWith(':countTokens')&&down[key])return capped(down[key]);
  if(u.endsWith(':countTokens'))return Response.json({totalTokens:1});
  const data=JSON.parse(o.body);return Response.json(data.requests?{embeddings:data.requests.map(()=>({values:Array(768).fill(1)}))}:{embedding:{values:Array(768).fill(1)}});},...extra};
 base=await setup(t,options);base.calls.length=0;
 const passage=async(at)=>{const pending=base.post(url,body('1'));pending.catch(()=>{});
  // Rejected requests never reach the queue, so wait for either outcome.
  const done=await Promise.race([pending,waitFor(()=>base.gateway.status().queued===1).then(()=>null)]);
  if(done)return done;base.time(at);await base.gateway.tick();return pending;};
 return {...base,logs,poolPath,options,passage,embeds:()=>base.calls.filter(c=>!c.url.endsWith(':countTokens')).map(c=>c.key)};
};
test('stored text uses pool keys and queries use the reserved key',async t=>{
 const s=await pooled(t,{});
 assert.equal((await s.post(url,body('1'),'query-key')).status,200);
 assert.equal((await s.passage(60000)).status,200);
 assert.deepEqual(s.calls.map(c=>c.key),['real-google-key','key-a','key-a']);
 assert.deepEqual(s.logs.filter(x=>x.event==='passage_batch').map(x=>[x.key,x.status,x.inputs]),[['A',200,1]]);
 assert.deepEqual(s.logs.filter(x=>x.event==='query_embed').map(x=>[x.key,x.status,x.inputs]),[['reserved',200,1]]);
});
test('a capped key fails over, then all capped keys fail fast until the reported reset',async t=>{
 const down={'key-a':3600};const s=await pooled(t,down);
 assert.equal((await s.passage(60000)).status,200);
 assert.deepEqual(s.embeds(),['key-a','key-b']);
 const blocked=s.logs.find(x=>x.event==='passage_batch'&&x.status===429);
 assert.equal(blocked.key,'A');assert.match(blocked.quotaId,/PerDay/);assert.equal(blocked.blockedUntil,60000+3600000);
 down['key-b']=7200;
 const failed=await s.passage(120000);assert.equal(failed.status,429);assert.match((await failed.json()).error.message,/quota exhausted until/);
 const before=s.calls.length;
 assert.equal((await s.passage(180000)).status,429);assert.equal(s.calls.length,before,'no upstream call while every key is capped');
 assert.equal((await s.post(url,body('1'),'query-key')).status,200,'reserved key still serves queries');
 assert.equal(s.gateway.status().keys.find(k=>k.key==='B').blockedUntil,120000+7200000);
 delete down['key-a'];s.time(60000+3600000);
 assert.equal((await s.passage(60000+3600000+60000)).status,200);assert.equal(s.embeds().at(-1),'key-a');
});
test('caps survive a gateway restart',async t=>{
 const s=await pooled(t,{'key-a':3600,'key-b':3600});
 assert.equal((await s.passage(60000)).status,429);s.gateway.close();
 const calls=[];const gateway=await createGateway({googleKey:'real-google-key',controlToken:'control-key',queryToken:'query-key',passageToken:'passage-key',stateDir:s.stateDir,poolPath:s.poolPath,now:()=>120000,fetchGoogle:async()=>{calls.push(1);return Response.json({totalTokens:1});},hasPending:async()=>false,background:false,log:()=>{}});
 await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));t.after(()=>gateway.close());
 const response=await fetch(`http://127.0.0.1:${gateway.server.address().port}${url}`,{method:'POST',headers:{'x-goog-api-key':'passage-key'},body:JSON.stringify(body('1'))});
 assert.equal(response.status,429);assert.equal(calls.length,0);
});
test('queries fall back to pool keys when the reserved key is capped',async t=>{
 const s=await pooled(t,{'real-google-key':3600});
 assert.equal((await s.post(url,body('1'),'query-key')).status,200);
 assert.deepEqual(s.embeds(),['real-google-key','key-a']);
});
test('an unreadable pool file falls back to the single key',async t=>{
 const logs=[];const s=await setup(t,{poolPath:'/nonexistent/pool.json',log:x=>logs.push(JSON.parse(x))});
 const pending=s.post(url,body('1'));await waitFor(()=>s.gateway.status().queued===1);s.time(60000);await s.gateway.tick();
 assert.equal((await pending).status,200);assert(s.calls.every(c=>c.headers['x-goog-api-key']==='real-google-key'));
 assert.equal(logs.filter(x=>x.event==='pool_unavailable').length,1);
});
test('Hindsight startup embedding uses the reserved key',async t=>{
 const s=await pooled(t,{'key-a':3600,'key-b':3600});
 await s.control('bootstrap');
 assert.equal((await s.post(url,body('1'))).status,200);
 assert.deepEqual(s.embeds(),['real-google-key']);
});
