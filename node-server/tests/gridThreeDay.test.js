"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),app=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const block=(src,name)=>new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(src)?.[0]||'';
const day=86400000,base=Math.floor(1788800000000/(3*day))*3*day;
const bars=Array.from({length:6},(_,i)=>({t:base+i*day,o:10+i,h:12+i,l:9+i,c:11+i,v:100+i}));
function serverHarness(ex){
  const calls=[];
  const ctx=vm.createContext({URL,Date,Map,AbortSignal,console:{log(){},warn(){},error(){}},GO_SCANNER_URL:'http://scanner',fetch:async()=>null,klineSubs:new Map(),normalizeTimestamp:t=>+t<1e11?+t*1000:+t});
  ctx.apiFetch=async url=>{
    const u=new URL(url);calls.push(u);
    const param={BB:'interval',MX:'interval',KC:'granularity',HT:'period'}[ex];
    const expected={BB:'D',MX:'Day1',KC:'1440',HT:'4hour'}[ex];
    if(u.searchParams.get(param)!==expected) return {data:[],result:{list:[]}};
    const rows=ex==='HT'?Array.from({length:36},(_,i)=>({...bars[Math.floor(i/6)],t:base+i*4*3600000,v:10})):bars;
    if(ex==='BB')return {retCode:0,result:{list:rows.map(k=>[k.t,k.o,k.h,k.l,k.c,k.v,k.v]).reverse()}};
    if(ex==='MX')return {success:true,data:{time:rows.map(k=>k.t/1000),open:rows.map(k=>k.o),high:rows.map(k=>k.h),low:rows.map(k=>k.l),close:rows.map(k=>k.c),amount:rows.map(k=>k.v)}};
    if(ex==='HT')return {status:'ok',data:rows.map(k=>({id:k.t/1000,open:k.o,high:k.h,low:k.l,close:k.c,amount:k.v}))};
    return {code:'200000',data:rows.map(k=>[k.t,k.o,k.h,k.l,k.c,k.v,k.v])};
  };
  const mapStart=server.indexOf('const TF_MAP =');
  vm.runInContext(server.slice(mapStart,server.indexOf('function getTfMs',mapStart)),ctx);
  for(const name of ['getTfMs','normalizeExchangeSymbol','getKlinesUrl','parseKlines','syntheticSourceTf','aggregateTimeframeCandles','seedSyntheticCandles','fetchSyntheticHistory','fetchFullHistory'])vm.runInContext(block(server,name),ctx);
  return {ctx,calls};
}
for(const ex of ['BB','MX','KC','HT'])test(`${ex} 3d history uses supported source candles and returns true three-day OHLCV`,async()=>{
  const {ctx,calls}=serverHarness(ex);const result=await ctx.fetchFullHistory(ex,'SOPHUSDT','3d',true);
  assert.equal(result.length,2);assert.equal(result[1].t-result[0].t,3*day);
  assert.equal(result[0].o,10);assert.equal(result[0].c,13);assert.equal(result[0].h,14);assert.equal(result[0].l,9);
  assert.equal(result[0].v,ex==='HT'?180:303);assert.equal(calls.length,1);
});
test('one-candle streamed history reaches the grid cell without a fallback request',async()=>{
  let fallback=0;
  const cache=new Map();
  const ctx=vm.createContext({Map,AbortController,TextDecoder,setTimeout,clearTimeout,KLINE_REQUESTS:new Map(),GRID_KLINE_QUEUE:new Map(),KLINES_CACHE:cache,touchKlinesCache:key=>cache.get(key),storeKlinesCache:(key,data)=>cache.set(key,{ts:Date.now(),data}),sanitizeCandles:x=>x,activeView:'screener',screenerView:'multichart',window:{detectChartLevelsFn:()=>[]},
    fetch:async()=>new Response(JSON.stringify({sym:'STONKUSDT',data:[base,1,2,1,2,3]})+'\n'),fetchChartKlines:async()=>{fallback++;return [];}});
  for(const n of ['decodeKlinePayload','consumeGridRequest','fetchGridKlines','flushGridKlines'])vm.runInContext(block(app,n),ctx);
  vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(app)[0]+';this.Chart=ChartInstance',ctx);
  const cell={ex:'AD',sym:'STONKUSDT',tf:'3d',candles:[],headerTf:{},subscribeLive(){},draw(){}};
  await ctx.Chart.prototype.loadKlines.call(cell);
  assert.equal(cell.candles.length,1);assert.equal(cell.loadingKlines,false);assert.equal(fallback,0);
});
test('single-chart loader accepts the one real candle of a new listing',async()=>{
  const ctx=vm.createContext({KLINE_REQUESTS:new Map(),AbortController,setTimeout,clearTimeout,fetchServerKlines:async()=>[bars[0]],fetchDirectKlines:async()=>[]});
  vm.runInContext(block(app,'fetchChartKlines'),ctx);
  assert.equal((await ctx.fetchChartKlines('AD','STONKUSDT','3d')).length,1);
});
test('unsupported 3d interval cannot win the direct-exchange fallback race with short bars',async()=>{
  let direct=0;
  const ctx=vm.createContext({KLINE_REQUESTS:new Map(),AbortController,setTimeout,clearTimeout,fetchServerKlines:async()=>[],fetchDirectKlines:async()=>{direct++;return bars;}});
  vm.runInContext(block(app,'fetchChartKlines'),ctx);
  assert.equal((await ctx.fetchChartKlines('BB','SOPHUSDT','3d')).length,0);assert.equal(direct,0);
});

test('synthetic live daily updates preserve full 3d OHLCV without double-counting snapshots',async()=>{
  const {ctx}=serverHarness('BB'),emitted=[];
  ctx.marketDataCore={normalizeCandle:x=>x};ctx.broadcastKline=(...args)=>emitted.push(args[3]);
  vm.runInContext(block(server,'broadcastSyntheticKline'),ctx);
  const sub={key:'BB|SOPHUSDT|3d',clients:new Set()};ctx.klineSubs.set(sub.key,sub);
  await ctx.fetchFullHistory('BB','SOPHUSDT','3d',true);
  const update={...bars[5],c:18,h:19,v:110};
  ctx.broadcastSyntheticKline('BB','SOPHUSDT','3d',update);
  ctx.broadcastSyntheticKline('BB','SOPHUSDT','3d',update);
  assert.equal(emitted.length,2);assert.equal(emitted[1].t,base+3*day);
  assert.equal(emitted[1].o,13);assert.equal(emitted[1].c,18);assert.equal(emitted[1].h,19);assert.equal(emitted[1].v,103+104+110);
  ctx.broadcastSyntheticKline('BB','SOPHUSDT','3d',{...update,t:base+6*day,o:20,h:21,l:19,c:20,v:1});
  assert.equal(emitted[2].t,base+6*day);assert.equal(emitted[2].o,20);assert.equal(emitted[2].v,1);
});

test('an empty grid attempt retries, but a disposed cell cannot restart loading',async()=>{
  const scheduled=[],cache=new Map(),ctx=vm.createContext({Map,AbortController,KLINES_CACHE:cache,touchKlinesCache:key=>cache.get(key),storeKlinesCache:(key,data)=>cache.set(key,{ts:Date.now(),data}),activeView:'screener',screenerView:'multichart',window:{detectChartLevelsFn:()=>[]},fetchGridKlines:async()=>[],setTimeout:fn=>{scheduled.push(fn);return 1},clearTimeout(){}});
  vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(app)[0]+';this.Chart=ChartInstance',ctx);
  let retries=0;const cell={ex:'MX',sym:'SOPH_USDT',tf:'3d',candles:[],headerTf:{},subscribeLive(){},draw(){},loadKlines(){retries++}};
  await ctx.Chart.prototype.loadKlines.call(cell);assert.equal(scheduled.length,1);
  scheduled[0]();assert.equal(retries,1);cell._disposed=true;scheduled[0]();assert.equal(retries,1);
});

test('historical 3d pagination goes through source aggregation and stops before the cursor',async()=>{
  const {ctx}=serverHarness('KC');let handler;
  ctx.app={get:(_,fn)=>handler=fn};ctx.setPublicCors=()=>{};
  vm.runInContext(/app\.get\("\/api\/klines", async \(req, res\) => \{[^]*?\n\}\);/.exec(server)[0],ctx);
  let received,code=200;const res={setHeader(){},status(n){code=n;return this},json(x){received=x;return this}};
  await handler({query:{ex:'KC',sym:'SOPHUSDTM',tf:'3d',before:base+3*day-1}},res);
  assert.equal(code,200);assert.equal(received.length,1);assert.equal(received[0].t,base);assert.equal(received[0].v,303);
});

for(const ex of ['BB','MX','KC'])test(`${ex} 3d live subscription requests daily candles, keeping the chart identity 3d`,async()=>{
  const sockets=[],emitted=[];
  class Socket extends require('node:events').EventEmitter{constructor(){super();this.sent=[];this.readyState=1;sockets.push(this)}send(d){this.sent.push(JSON.parse(d))}}
  const ctx=vm.createContext({WebSocket:Socket,console:{warn(){}},getKuCoinToken:async()=>({endpoint:'wss://fixture',token:'fixture'}),markMarketOpen(){},closeSocket(){},startKlinePolling(){},scheduleKlineReconnect(){},setInterval:()=>1,clearInterval(){},clearTimeout(){},broadcastSyntheticKline:(...args)=>emitted.push(args),broadcastKline:()=>assert.fail('source bar must not be published as a 3d candle')});
  vm.runInContext(block(server,'syntheticSourceTf')+'\n'+block(server,'connectKlineWs'),ctx);
  ctx.connectKlineWs({ex,sym:'SOPHUSDT',tf:'3d'});await Promise.resolve();const ws=sockets[0];ws.emit('open');
  const serialized=JSON.stringify(ws.sent[0]);assert.match(serialized,{BB:/kline\.D\./,MX:/Day1/,KC:/_1day/}[ex]);
  const data={BB:{topic:'kline.D.SOPHUSDT',data:[{start:base,open:10,high:12,low:9,close:11,turnover:100}]},MX:{channel:'push.kline',data:{t:base/1000,o:10,h:12,l:9,c:11,a:100}},KC:{subject:'candle.stick',data:{candles:[base/1000,10,11,12,9,1,100]}}}[ex];
  ws.emit('message',Buffer.from(JSON.stringify(data)));assert.equal(emitted.length,1);assert.equal(emitted[0][2],'3d');
});
