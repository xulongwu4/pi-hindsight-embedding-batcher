import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './gateway.mjs';
const model='models/gemini-embedding-2';
const input=(text)=>({model,content:{parts:[{text}]},outputDimensionality:768});
const body=(...texts)=>({requests:texts.map(input)});
const url='/v1beta/models/gemini-embedding-2:batchEmbedContents';
async function setup(t,extra={}) {
 let now=0; const calls=[]; const stateDir=await mkdtemp(join(tmpdir(),'embedding-test-'));
 const google=async(u,options)=>{
  const data=JSON.parse(options.body); calls.push({url:u,headers:options.headers,data});
  const texts=data.requests?.map(x=>x.content.parts[0].text)??[data.content.parts[0].text];
  return Response.json(data.requests?{embeddings:texts.map(s=>({values:Array(768).fill(Number(s)||1)}))}:{embedding:{values:Array(768).fill(1)}});
 };
 const gateway=await createGateway({googleKey:'real-google-key',controlToken:'control-key',queryToken:'query-key',passageToken:'passage-key',stateDir,now:()=>now,fetchGoogle:google,log:()=>{},...extra});
 await new Promise(r=>gateway.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${gateway.server.address().port}`;
 const post=(path,data,key='passage-key')=>fetch(base+path,{method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},body:JSON.stringify(data)});
 const control=(path)=>fetch(base+'/control/'+path,{method:'POST',headers:{Authorization:'Bearer control-key'}});
 t.after(async()=>{gateway.close();await rm(stateDir,{recursive:true,force:true});});
 return {gateway,calls,stateDir,base,post,control,time:t=>{now=t;}};
}
test('stored text is forwarded at once without token counting, upstream receives real key only',async t=>{
 const s=await setup(t);
 assert.equal((await s.post(url,body('1'),'query-key')).status,200);
 assert.equal((await s.post(url,body('7000','7000','7000','7000','7000'))).status,200);
 assert.deepEqual(s.calls.map(c=>c.url.split(':').at(-1)),['batchEmbedContents','batchEmbedContents']);
 assert.equal(s.calls[1].data.requests.length,5);
 assert(s.calls.every(c=>c.headers['x-goog-api-key']==='real-google-key'));
});
test('splits requests above 100 inputs and reconstructs ordered native responses',async t=>{
 const s=await setup(t);const texts=Array.from({length:250},(_,i)=>String(i+1));
 const d=await (await s.post(url,body(...texts))).json();
 assert.deepEqual(s.calls.map(c=>c.data.requests.length),[100,100,50]);
 assert.deepEqual(d.embeddings.map(e=>e.values[0]),texts.map(Number));
});
test('rejects bad auth, models and routes without embedding',async t=>{
 const s=await setup(t);
 assert.equal((await s.post(url,body('1'),'wrong')).status,401);
 assert.equal((await s.post(url,{requests:[{...input('1'),model:'models/wrong'}]})).status,400);
 assert.equal((await s.post('/v1beta/models/gemini-embedding-2:generateContent',{})).status,404);
 assert.equal((await s.control('drain')).status,404);
 assert.equal(s.calls.length,0);
});
test('upstream vector mismatch fails request rather than returning fabricated data',async t=>{
 const s=await setup(t,{fetchGoogle:async()=>Response.json({embeddings:[]})});
 assert.equal((await s.post(url,body('1'))).status,502);
});

test('supports the installed SDK v1 route as well as v1beta',async t=>{
 const s=await setup(t);
 const response=await s.post(url.replace('/v1beta/','/v1/'),body('1'),'query-key');
 assert.equal(response.status,200);
});

const poolFile=async(s,accounts)=>{const path=join(s.stateDir,'pool.json');await writeFile(path,JSON.stringify({version:1,providers:{google:{accounts:accounts.map(id=>({id,label:id.toUpperCase(),credential:{type:'api_key',key:'key-'+id},enabled:true}))}}}));return path;};
const capped=(seconds)=>Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[{violations:[{quotaId:'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier'}]},{retryDelay:seconds+'s'}]}},{status:429});
const pooled=async(t,down,extra={})=>{
 const logs=[];const dir={stateDir:await mkdtemp(join(tmpdir(),'embedding-pool-'))};t.after(()=>rm(dir.stateDir,{recursive:true,force:true}));
 const poolPath=await poolFile(dir,['a','b']);let base;
 const options={poolPath,log:x=>logs.push(JSON.parse(x)),fetchGoogle:async(u,o)=>{const key=o.headers['x-goog-api-key'];base.calls.push({url:u,key});
  if(down[key])return capped(down[key]);
  const data=JSON.parse(o.body);return Response.json(data.requests?{embeddings:data.requests.map(()=>({values:Array(768).fill(1)}))}:{embedding:{values:Array(768).fill(1)}});},...extra};
 base=await setup(t,options);base.calls.length=0;
 const passage=(at)=>{base.time(at);return base.post(url,body('1'));};
 return {...base,logs,poolPath,options,passage,embeds:()=>base.calls.map(c=>c.key)};
};
test('stored text uses pool keys and queries use the reserved key',async t=>{
 const s=await pooled(t,{});
 assert.equal((await s.post(url,body('1'),'query-key')).status,200);
 assert.equal((await s.passage(60000)).status,200);
 assert.deepEqual(s.embeds(),['real-google-key','key-a']);
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
 delete down['key-a'];
 assert.equal((await s.passage(60000+3600000)).status,200);assert.equal(s.embeds().at(-1),'key-a');
});
test('caps survive a gateway restart',async t=>{
 const s=await pooled(t,{'key-a':3600,'key-b':3600});
 assert.equal((await s.passage(60000)).status,429);s.gateway.close();
 const calls=[];const gateway=await createGateway({googleKey:'real-google-key',controlToken:'control-key',queryToken:'query-key',passageToken:'passage-key',stateDir:s.stateDir,poolPath:s.poolPath,now:()=>120000,fetchGoogle:async()=>{calls.push(1);return Response.json({embeddings:[]});},log:()=>{}});
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
 assert.equal((await s.post(url,body('1'))).status,200);assert(s.calls.every(c=>c.headers['x-goog-api-key']==='real-google-key'));
 assert.equal(logs.filter(x=>x.event==='pool_unavailable').length,1);
});
test('Hindsight startup embedding uses the reserved key once, only while the lease lasts',async t=>{
 const s=await pooled(t,{});
 assert.equal((await s.control('bootstrap')).status,202);
 assert.equal((await s.passage(0)).status,200);
 assert.equal((await s.passage(0)).status,200);
 await s.control('bootstrap');
 assert.equal((await s.passage(300001)).status,200);
 assert.deepEqual(s.embeds(),['real-google-key','key-a','key-a']);
});
test('Hindsight startup embedding still works when every pool key is capped',async t=>{
 const s=await pooled(t,{'key-a':3600,'key-b':3600});
 await s.control('bootstrap');
 assert.equal((await s.post(url,body('1'))).status,200);
 assert.deepEqual(s.embeds(),['real-google-key']);
});
