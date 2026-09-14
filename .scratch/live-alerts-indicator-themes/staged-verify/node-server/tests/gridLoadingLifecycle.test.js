"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const app=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const block=n=>new RegExp(`(?:async )?function ${n}\\([^]*?\\n\\}`).exec(app)?.[0]||'';
const bar={t:1788800040000,o:1,h:2,l:1,c:2,v:1};
function harness(fetch,fallback=async()=>[bar]){
  const ctx=vm.createContext({fetch,fetchChartKlines:fallback,Map,AbortController,TextDecoder,setTimeout,clearTimeout,KLINE_REQUESTS:new Map(),GRID_KLINE_QUEUE:new Map(),sanitizeCandles:x=>x});
  for(const n of ['decodeKlinePayload','consumeGridRequest','fetchGridKlines','flushGridKlines'])vm.runInContext(block(n),ctx);
  return ctx;
}
test('obsolete queued pages do not launch history requests when the visible page changes',async()=>{
  const urls=[];const ctx=harness(async url=>{urls.push(url);const symbols=new URL(url,'http://test').searchParams.get('symbols').split(',');return new Response(symbols.map(sym=>JSON.stringify({sym,data:[bar]})).join('\n'));});
  const controller=new AbortController();
  const old=Array.from({length:12},(_,i)=>ctx.fetchGridKlines('BN',`OLD${i}`,'1m',controller.signal));
  controller.abort();
  const fresh=Array.from({length:12},(_,i)=>ctx.fetchGridKlines('BN',`NEW${i}`,'5m'));
  const visible=await Promise.all(fresh);await Promise.all(old);
  assert.equal(visible.length,12);assert.ok(visible.every(x=>x.length===1));
  assert.equal(urls.some(url=>url.includes('OLD')),false,'obsolete work competes with the visible page');
});
test('a pending cell starts recovery before another cell ends its stalled stream',async()=>{
  let stream,opened;const ready=new Promise(r=>opened=r),fallback=[];
  const ctx=harness(async()=>new Response(new ReadableStream({start(c){stream=c;opened()}})),async(ex,sym)=>{fallback.push(sym);return [bar]});
  const waiting=ctx.fetchGridKlines('MX','SOPH_USDT','15m');
  const other=ctx.fetchGridKlines('MX','VVV_USDT','15m');
  await ready;
  stream.enqueue(new TextEncoder().encode(JSON.stringify({sym:'SOPH_USDT',data:[],pending:true})+'\n'));
  await new Promise(r=>setTimeout(r,10));
  const observed=[...fallback];
  stream.enqueue(new TextEncoder().encode(JSON.stringify({sym:'VVV_USDT',data:[bar]})+'\n'));stream.close();
  await Promise.all([waiting,other]);assert.deepEqual(observed,['SOPH_USDT']);
});
test('grid does not borrow hidden main-chart candles after the selected timeframe changed',async()=>{
  let fetched=0;const cache=new Map();const ctx=vm.createContext({Map,KLINES_CACHE:cache,touchKlinesCache:key=>cache.get(key),storeKlinesCache:(key,data)=>cache.set(key,{ts:Date.now(),data}),AbortController,clearTimeout,setTimeout,activeView:'screener',screenerView:'multichart',
    activeEx:'BN',activeSym:'BTCUSDT',activeTf:'1m',currentLoadedEx:'BN',currentLoadedSym:'BTCUSDT',currentLoadedTf:'4h',candles:[{...bar,t:1788758400000}],
    sanitizeCandles:x=>x,window:{detectChartLevelsFn:()=>[]},fetchGridKlines:async()=>{fetched++;return [bar]}});
  vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(app)[0]+';this.Chart=ChartInstance',ctx);
  const cell={ex:'BN',sym:'BTCUSDT',tf:'1m',candles:[],headerTf:{},subscribeLive(){},draw(){}};
  await ctx.Chart.prototype.loadKlines.call(cell);
  assert.equal(cell.candles[0].t,bar.t,'1m cell must not render cached 4h history');assert.equal(fetched,1);
});

test('cancelling one consumer preserves another cell sharing the same history',async()=>{
  let calls=0;const ctx=harness(async()=>{calls++;return new Response(JSON.stringify({sym:'BTCUSDT',data:[bar]})+'\n')});
  const abort=new AbortController();const first=ctx.fetchGridKlines('BN','BTCUSDT','1h',abort.signal),second=ctx.fetchGridKlines('BN','BTCUSDT','1h');
  abort.abort();assert.equal((await first).length,0);assert.equal((await second).length,1);assert.equal(calls,1);
});

test('discarding an in-flight page aborts its stream without starting fallback requests',async()=>{
  let opened,aborted=false,fallback=0;const ready=new Promise(r=>opened=r);
  const ctx=harness(async(url,{signal})=>new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>{aborted=true;controller.error(new Error('aborted'))});opened();}})),async()=>{fallback++;return [bar]});
  const abort=new AbortController();const request=ctx.fetchGridKlines('BN','BTCUSDT','4h',abort.signal);await ready;abort.abort();
  assert.equal((await request).length,0);await new Promise(r=>setImmediate(r));assert.equal(aborted,true);assert.equal(fallback,0);
});

test('rapid switching across all eight timeframes sends only the final visible grid',async()=>{
  const urls=[],ctx=harness(async url=>{urls.push(url);const symbols=new URL(url,'http://test').searchParams.get('symbols').split(',');return new Response(symbols.map(sym=>JSON.stringify({sym,data:[bar]})).join('\n'));});
  const tasks=[];let controller;
  for(const tf of ['1m','5m','15m','1h','4h','1d','3d','1w']){controller?.abort();controller=new AbortController();for(let i=0;i<12;i++)tasks.push(ctx.fetchGridKlines('BN','COIN'+i,tf,controller.signal));}
  const result=await Promise.all(tasks);assert.equal(urls.length,1);assert.ok(urls[0].includes('tf=1w'));assert.equal(result.filter(x=>x.length).length,12);
});

function serverRoute(refresh){
  const src=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');let handler;
  const ctx=vm.createContext({app:{get:(_,fn)=>handler=fn},klinesCache:new Map(),startKlinesRefresh:refresh,setPublicCors(){},
    normalizeExchangeSymbol:(_,sym)=>sym,cacheKey:(...parts)=>parts.join('|'),KLINES_RESPONSE_DEADLINE_MS:6000,raceWithTimeout:p=>p,setTimeout});
  for(const name of ['mapConcurrent','encodeFlatCandles'])vm.runInContext(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(src)[0],ctx);
  vm.runInContext(/app\.get\("\/api\/klines\/batch", async \(req, res\) => \{[^]*?\n\}\);/.exec(src)[0],ctx);return handler;
}
test('server signals a pending cell while another symbol is still fetching',async()=>{
  let finish;const route=serverRoute(async(ex,sym)=>sym==='FIRST'?[]:new Promise(r=>finish=r));
  const rows=[],res={setHeader(){},flushHeaders(){},write(line){rows.push(JSON.parse(line))},flush(){},end(){}};
  const work=route({query:{ex:'BN',symbols:'FIRST,SECOND',tf:'5m',lite:'1',stream:'1'}},res);
  await new Promise(r=>setImmediate(r));const snapshot=[...rows];finish([bar]);await work;
  assert.equal(snapshot.length,1);assert.equal(snapshot[0].sym,'FIRST');assert.equal(snapshot[0].pending,true);
});
test('server stops starting queued symbols when the grid connection is discarded',async()=>{
  let calls=0;const res={destroyed:false,setHeader(){},flushHeaders(){},write(){},flush(){},end(){}};
  const route=serverRoute(async()=>{calls++;if(calls===6)res.destroyed=true;return []});
  await route({query:{ex:'BN',symbols:Array.from({length:12},(_,i)=>'COIN'+i).join(','),tf:'1m',stream:'1'}},res);
  assert.equal(calls,6);
});
