'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createHistoryPageStore}=require('../historyPages');
const bar=t=>({t,o:100,h:101,l:99,c:100,v:0});
const key={ex:'BN',sym:'BTCUSDT',tf:'1m',before:1000};

test('closed history pages validate, sort, deduplicate and exclude newer timestamps',async()=>{
  const store=createHistoryPageStore();
  const page=await store.get(key,async()=>[bar(900),bar(1001),bar(800),{...bar(900),c:100.5}]);
  assert.deepEqual(page.map(c=>c.t),[800,900]);assert.equal(page[1].c,100.5);
});
test('a malformed or non-advancing page is retryable and never cached as end of history',async()=>{
  const store=createHistoryPageStore();
  for(const rows of [null,[bar(1001)],[{...bar(900),v:Infinity}],[bar(800),null],[bar(800),{...bar(700),h:90}]]) await assert.rejects(store.get(key,async()=>rows));
  assert.deepEqual(store.stats(),{entries:0,candles:0,pending:0});
  assert.equal((await store.get(key,async()=>[bar(900)])).length,1);
});
test('history pages have bounded memory, LRU eviction and fixed expiration',async()=>{
  let time=100,calls=0;
  const store=createHistoryPageStore({maxEntries:3,maxCandles:4,ttlMs:100,now:()=>time});
  const get=before=>store.get({...key,before},async()=>{calls++;return [bar(before-2),bar(before-1)];});
  await get(100);await get(200);await get(100);await get(300);
  assert.deepEqual(store.stats(),{entries:2,candles:4,pending:0});
  await get(100);assert.equal(calls,3);await get(200);assert.equal(calls,4);
  time+=101;await get(200);assert.equal(calls,5);assert.equal(store.stats().entries,1);
});
test('independent venue, market, timeframe and cursor pages never share candle data',async()=>{
  let calls=0;const store=createHistoryPageStore();
  for(const item of [key,{...key,ex:'BB'},{...key,sym:'BTCUSDT_SPOT'},{...key,tf:'5m'},{...key,before:2000}])
    await store.get(item,async()=>{calls++;return [bar(900)];});
  assert.equal(calls,5);
});
test('pending requests are bounded while identical readers still share the owner',async()=>{
  let release;const store=createHistoryPageStore({maxPending:1});
  const first=store.get(key,()=>new Promise(r=>release=r));
  assert.equal(store.get(key,()=>assert.fail('duplicate loader')),first);
  await assert.rejects(store.get({...key,before:2000},async()=>[]),/capacity/);
  release([bar(900)]);await first;assert.equal(store.stats().pending,0);
});
test('timeouts release capacity and late upstream responses never poison a retry',async()=>{
  let release;const store=createHistoryPageStore({timeoutMs:10});
  await assert.rejects(store.get(key,()=>new Promise(r=>release=r)),/timed out/);
  await store.get(key,async()=>[bar(800)]);release([bar(900)]);
  await new Promise(r=>setImmediate(r));
  assert.equal((await store.get(key,()=>assert.fail('cache missed')))[0].t,800);
});
test('a valid empty page expires quickly and an upstream failure is never cached',async()=>{
  let time=100,calls=0;const store=createHistoryPageStore({now:()=>time});
  await assert.rejects(store.get(key,async()=>{throw new Error('offline');}),/offline/);
  const get=()=>store.get(key,async()=>{calls++;return []});
  await get();time+=29999;await get();assert.equal(calls,1);
  time+=2;await get();assert.equal(calls,2);
});
