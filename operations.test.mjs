import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPendingOperations } from './gateway.mjs';

test('malformed operation counts cannot falsely confirm idle',async()=>{
 for(const result of [{},{total:'0',operations:[]},{total:-1,operations:[]},{total:0,operations:[{}]}]){
  const fetchStatus=async u=>Response.json(u.includes('/operations?')?result:{banks:[{bank_id:'probe'}],total:1});
  await assert.rejects(hasPendingOperations({fetchStatus}));
 }
});
test('malformed bank pagination fails closed',async()=>{
 for(const page of [{banks:[]},{banks:[],total:1},{banks:[{}],total:1},{banks:[],total:'0'}]){
  await assert.rejects(hasPendingOperations({fetchStatus:async()=>Response.json(page)}));
 }
});
test('valid empty bank and operation lists are idle, positive count is pending',async()=>{
 assert.equal(await hasPendingOperations({fetchStatus:async()=>Response.json({banks:[],total:0})}),false);
 for(const total of [0,1]){
  const fetchStatus=async u=>Response.json(u.includes('/operations?')?{total,operations:total?[{}]:[]}:{banks:[{bank_id:'probe'}],total:1});
  assert.equal(await hasPendingOperations({fetchStatus}),Boolean(total));
 }
});
test('partial bank pages do not skip later pending banks',async()=>{
 const fetchStatus=async u=>{
  if(u.includes('/banks?'))return Response.json({banks:[{bank_id:u.includes('offset=0')?'a':'b'}],total:2});
  return Response.json(u.includes('/banks/b/')?{total:1,operations:[{}]}:{total:0,operations:[]});
 };
 assert.equal(await hasPendingOperations({fetchStatus}),true);
});
