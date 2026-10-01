'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const block=name=>new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(source)?.[0] || '';
const bar=t=>({t,o:100,h:101,l:99,c:100,v:1});
function initialFixture() {
  const tasks=[],cache=new Map();
  const c={console,window:{},document:{hidden:false},activeView:'screener',screenerView:'chart',
    activeEx:'BN',activeSym:'BTCUSDT',activeTf:'1m',klFetchToken:0,lastAppliedTradeTime:0,klWs:null,klPoll:null,
    currentLoadedEx:null,currentLoadedSym:null,currentLoadedTf:null,candles:[],coins:new Map(),interpActive:new Map(),
    ctx:{clearRect(){},fillText(){}},vCtx:{clearRect(){}},chartW:1000,chartH:600,volH:100,
    setTimeout(fn){tasks.push(fn);return 1;},clearTimeout(){},clearInterval(){},connectKlWs(){},updateOHLC(){},drawChart(){},
    touchKlinesCache:key=>cache.get(key),sanitizeCandles:rows=>rows,storeKlinesCache:(key,data)=>cache.set(key,{data,ts:Date.now()}),
    fetchChartKlines:async()=>Array.from({length:300},(_,i)=>bar(1700000000000+i*60000)),
    olderCalls:0,loadOlderHistory:async()=>{c.olderCalls++;c.candles=[...Array.from({length:1000},(_,i)=>bar(1699940000000+i*60000)),...c.candles];},
    fetchOlderKlines:async()=>[],mainHistoryWarmKey:null,hasReachedStartOfHistory:false};
  vm.createContext(c);vm.runInContext(block('fetchKlines')+'\n'+block('primeMainHistory')+'\n'+block('prefetchMainHistory'),c);
  return {c,tasks,cache};
}
test('opening a single chart starts older history loading immediately after its first paint',async()=>{
  const {c,tasks}=initialFixture();await c.fetchKlines('BN','BTCUSDT','1m');
  for(const run of tasks.splice(0)) await run();
  assert.equal(c.olderCalls,1,'history only starts when the user reaches the left edge');
});
test('a stale initial-chart task does not preload after switching market',async()=>{
  const {c,tasks}=initialFixture();await c.fetchKlines('BN','BTCUSDT','1m');c.klFetchToken++;c.activeSym='ETHUSDT';
  for(const run of tasks.splice(0)) await run();assert.equal(c.olderCalls,0);
});

test('small venue pages warm gradually with a strict three-page budget',async()=>{
  const {c}=initialFixture();c.candles=Array.from({length:300},(_,i)=>bar(1700000000000+i*60000));
  c.loadOlderHistory=async()=>{c.olderCalls++;c.candles=[...Array.from({length:100},(_,i)=>bar(c.candles[0].t-(100-i)*60000)),...c.candles]};
  await c.primeMainHistory('BN','BTCUSDT','1m',c.klFetchToken);
  assert.equal(c.olderCalls,3);assert.equal(c.candles.length,600);
});
test('priming stops after an error, a hidden tab, a grid switch or a changed chart',async()=>{
  for(const state of ['no-progress','hidden','grid','market']) {
    const {c}=initialFixture();c.candles=[bar(1700000000000)];
    c.loadOlderHistory=async()=>{c.olderCalls++;if(state!=='no-progress')c.candles.unshift(bar(c.candles[0].t-60000));
      if(state==='hidden')c.document.hidden=true;if(state==='grid')c.screenerView='multichart';if(state==='market')c.activeSym='ETHUSDT';};
    await c.primeMainHistory('BN','BTCUSDT','1m',c.klFetchToken);assert.equal(c.olderCalls,1);
  }
});
