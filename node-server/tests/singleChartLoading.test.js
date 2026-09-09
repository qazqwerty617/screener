"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const code=source.slice(source.indexOf('async function fetchKlines('),source.indexOf('async function loadOlderHistory('));
function fixture(cached,fetchHistory) {
  const cache=new Map(cached?[['BN|BTCUSDT|5m',cached]]:[]);
  const events=[],timers=[],ctx=vm.createContext({console,klFetchToken:0,klWs:null,klPoll:null,currentLoadedEx:null,currentLoadedSym:null,currentLoadedTf:null,
    activeEx:'BN',activeSym:'BTCUSDT',activeTf:'5m',candles:[],coins:new Map(),interpActive:new Set(),chartW:500,chartH:300,volH:100,
    ctx:{clearRect(){},fillText(){}},vCtx:{clearRect(){}},KLINES_CACHE:cache,touchKlinesCache:key=>cache.get(key),storeKlinesCache:(key,data)=>cache.set(key,{ts:Date.now(),data}),KLINES_CACHE_TTL_MS:300000,
    sanitizeCandles:c=>c,fetchChartKlines:()=>{events.push('history');return fetchHistory();},fetchServerKlines:async(ex,sym,tf,lite)=>{events.push(`server:${lite}`);return [];},
    updateOHLC(){},drawChart(){events.push('draw');},resizeChart(){},connectKlWs(){events.push('live');},setTimeout:fn=>timers.push(fn),clearInterval(){}});
  vm.runInContext(code,ctx);return {ctx,events,timers};
}
const bars=[{t:1700000000000,c:100},{t:1700000300000,c:101}];
test('single chart starts live subscription before waiting for cold history',async()=>{
  let complete;const f=fixture(null,()=>new Promise(r=>complete=r));
  const pending=f.ctx.fetchKlines('BN','BTCUSDT','5m');
  const liveBeforeHistory=f.events.indexOf('live')>=0;
  complete(bars);await pending;
  assert.equal(liveBeforeHistory,true);
});
test('switching back renders old cache immediately and avoids full-history preload',async()=>{
  const f=fixture({ts:Date.now()-360000,data:bars},async()=>bars);
  await f.ctx.fetchKlines('BN','BTCUSDT','5m');
  assert.equal(f.events.includes('history'),false);
  assert.equal(f.events.includes('draw'),true);
  for(const callback of f.timers)callback();
  await Promise.resolve();
  assert.equal(f.events.includes('server:0'),false);
  assert.equal(f.events.includes('server:1'),true);
});
