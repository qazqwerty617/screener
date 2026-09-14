"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const bar=t=>({t,o:100,h:101,l:99,c:100,v:1});
test('zoomed-out single chart requests missing left history even without dragging',()=>{
  let calls=0;
  const ctx=vm.createContext({PW:1000,candleW:2,candles:Array.from({length:300},(_,i)=>bar(1700000000000+i*60000)),offsetX:0,
    isLoadingOlderCandles:false,hasReachedStartOfHistory:false,activeEx:'BN',activeSym:'BTCUSDT',activeTf:'1m',loadOlderHistory:()=>calls++});
  const start=src.indexOf('  const n = Math.max(1, PW / candleW);');
  vm.runInContext('(function(){'+src.slice(start,src.indexOf('  let autoMn',start))+'})()',ctx);
  assert.equal(calls,1);
});
function mainFixture(fetcher){
  const cache=new Map();
  const ctx=vm.createContext({console:{warn(){}},isLoadingOlderCandles:false,hasReachedStartOfHistory:false,candles:[bar(1700000600000),bar(1700000660000)],
    klFetchToken:1,activeEx:'BN',activeSym:'BTCUSDT',activeTf:'1m',TF_MS:{'1m':60000},offsetX:0,
    AbortController,setTimeout,clearTimeout,fetch:fetcher,sanitizeCandles:c=>c,drawChart(){},requestAnimationFrame(){},window:{requestMainChartDraw(){}},
    KLINES_CACHE:cache,storeKlinesCache:(key,data)=>cache.set(key,{ts:Date.now(),data}),KLINE_REQUESTS:new Map(),decodeKlinePayload:x=>x,mergeCandles:(a,b)=>[...b,...a]});
  const helper=/(?:async )?function fetchOlderKlines\([^]*?\n\}/.exec(src);if(helper)vm.runInContext(helper[0],ctx);
  const start=src.indexOf('async function loadOlderHistory(');
  vm.runInContext(src.slice(start,src.indexOf('function appendCandle(',start)),ctx);
  return ctx;
}
test('temporary history HTTP failure is not treated as the beginning of the market',async()=>{
  const ctx=mainFixture(async()=>({ok:false,status:503,headers:{get:()=>null}}));
  await ctx.loadOlderHistory('BN','BTCUSDT','1m');
  assert.equal(ctx.hasReachedStartOfHistory,false);
});
test('history completion schedules a new draw after releasing the loading lock',async()=>{
  const ctx=mainFixture(async()=>({ok:true,json:async()=>[bar(1700000540000)]}));
  const states=[];ctx.requestAnimationFrame=()=>states.push(ctx.isLoadingOlderCandles);ctx.window.requestMainChartDraw=()=>states.push(ctx.isLoadingOlderCandles);ctx.drawChart=()=>states.push(ctx.isLoadingOlderCandles);
  await ctx.loadOlderHistory('BN','BTCUSDT','1m');
  assert.equal(states.at(-1),false);
});
test('prepending a grid history page preserves distance from the newest candle',async()=>{
  const ctx=mainFixture(async()=>({ok:true,json:async()=>[bar(1700000480000),bar(1700000540000)]}));
  vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(src)[0]+';this.Chart=ChartInstance;',ctx);
  const cell={ex:'BN',sym:'BTCUSDT',tf:'1m',candles:[...ctx.candles],offsetX:1,refreshFormationLevels(){},draw(){}};
  await ctx.Chart.prototype.loadOlderHistory.call(cell);
  assert.equal(cell.candles.length,4);assert.equal(cell.offsetX,1);
});

test('server reports a failed older-page request as retryable, not successful empty history',async()=>{
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const start=server.indexOf('  let { ex = "BN", sym = "BTCUSDT", tf = "4h", lite = "0", before }');
  const ctx=vm.createContext({normalizeExchangeSymbol:(ex,sym)=>sym,syntheticSourceTf:()=>null,setPublicCors(){},getKlinesUrl:()=> 'https://example.invalid',apiFetch:async()=>{throw new Error('temporary upstream failure');},parseKlines:()=>[]});
  const route=vm.runInContext('(async (req,res)=>{'+server.slice(start,server.indexOf('  const useLite =',start))+'})',ctx);
  const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(){return this;}};
  await route({query:{ex:'BN',sym:'BTCUSDT',tf:'1m',before:'1700000000000'}},res);
  assert.equal(res.code,503);
});

test('a wide single-chart viewport fills across multiple pages without dragging or live ticks',async()=>{
  let calls=0;
  const ctx=mainFixture(async()=>{
    calls++;const first=ctx.candles[0].t;
    return {ok:true,json:async()=>Array.from({length:200},(_,i)=>bar(first-(200-i)*60000))};
  });
  const frames=[];ctx.requestAnimationFrame=callback=>frames.push(callback);
  ctx.PW=1000;ctx.candleW=2;
  const start=src.indexOf('  const n = Math.max(1, PW / candleW);');
  const render='(function(){'+src.slice(start,src.indexOf('  let autoMn',start))+'})()';
  ctx.drawChart=()=>vm.runInContext(render,ctx);
  ctx.drawChart();
  for(let i=0;i<12;i++) {await new Promise(r=>setImmediate(r));for(const callback of frames.splice(0))callback();}
  assert.equal(calls,3);assert.equal(ctx.candles.length,602);assert.equal(ctx.offsetX,0);
  assert.equal(ctx.loadOlderHistory.retry,null);
});

test('HTX historical requests advance their time range instead of repeating the latest page',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const ctx=vm.createContext({getTfMs:()=>60000,normalizeExchangeSymbol:(ex,sym)=>sym,TF_MAP:{HT:{'1m':'1min'}}});
  vm.runInContext(/function getKlinesUrl\([^]*?\n\}/.exec(server)[0],ctx);
  const url=new URL(ctx.getKlinesUrl('HT','BTC-USDT','1m',1000,1700000000000));
  assert.equal(url.searchParams.get('to'),'1700000000');
  assert.equal(url.searchParams.get('from'),'1699940000');
  assert.equal(url.searchParams.has('size'),false,'HTX ignores from/to when size is included');
});
