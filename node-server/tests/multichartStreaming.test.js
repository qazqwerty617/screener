"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const block=(src,name)=>new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(src)[0];
const flat=[1788800000000,1,2,1,2,1,1788800300000,1,2,1,2,1];
function browserHarness(fetch,fallback=async()=>[]){
  return new Function('fetch','fetchChartKlines','AbortController','TextDecoder','setTimeout','clearTimeout',`
    const GRID_KLINE_QUEUE=new Map(),KLINE_REQUESTS=new Map();
    const sanitizeCandles=x=>x;
    ${['decodeKlinePayload','consumeGridRequest','fetchGridKlines','flushGridKlines'].map(n=>block(app,n)).join('\n')}
    return fetchGridKlines;
  `)(fetch,fallback,AbortController,TextDecoder,setTimeout,clearTimeout);
}
test('twelve distinct chart cells use one HTTP history request',async()=>{
  let calls=0;
  const load=browserHarness(async url=>{
    calls++;const symbols=new URL(url,'http://local').searchParams.get('symbols').split(',');
    return new Response(symbols.map(sym=>JSON.stringify({sym,data:flat})).join('\n')+'\n');
  });
  const results=await Promise.all(Array.from({length:12},(_,i)=>load('BN',`COIN${i}USDT`,'5m')));
  assert.equal(calls,1);assert.ok(results.every(r=>r.length===2));
});
test('a ready cell renders before another cell finishes its response',async()=>{
  let controller,ready;
  const opened=new Promise(r=>ready=r);
  const load=browserHarness(async()=>{const body=new ReadableStream({start(c){controller=c;ready();}});return new Response(body);});
  const first=load('BN','BTCUSDT','5m');let secondDone=false;
  const second=load('BN','ETHUSDT','5m').then(r=>{secondDone=true;return r;});
  await opened;
  const bytes=new TextEncoder().encode(JSON.stringify({sym:'BTCUSDT',data:flat})+'\n');
  // Exercise a row split across transport chunks.
  controller.enqueue(bytes.slice(0,15));controller.enqueue(bytes.slice(15));
  assert.equal((await first).length,2);assert.equal(secondDone,false);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({sym:'ETHUSDT',data:flat})+'\n'));controller.close();
  assert.equal((await second).length,2);
});
test('a broken stream retries only unfinished cells',async()=>{
  const fallback=[];
  const load=browserHarness(async()=>new Response(JSON.stringify({sym:'BTCUSDT',data:flat})+'\n'),async(ex,sym)=>{fallback.push(sym);return [{t:1},{t:2}]});
  await Promise.all([load('BN','BTCUSDT','5m'),load('BN','ETHUSDT','5m')]);
  assert.deepEqual(fallback,['ETHUSDT']);
});
test('batch grouping keeps exchange and timeframe identities separate',async()=>{
  const requests=[];
  const load=browserHarness(async url=>{const q=new URL(url,'http://local').searchParams;requests.push(`${q.get('ex')}|${q.get('tf')}`);return new Response(JSON.stringify({sym:'BTCUSDT',data:flat})+'\n')});
  await Promise.all([load('BN','BTCUSDT','5m'),load('BB','BTCUSDT','5m'),load('BN','BTCUSDT','1h')]);
  assert.deepEqual(requests.sort(),['BB|5m','BN|1h','BN|5m']);
});
test('server flushes cached cells without waiting for a cold cell',async()=>{
  const routeSrc=/app\.get\("\/api\/klines\/batch", async \(req, res\) => \{[^]*?\n\}\);/.exec(server)[0];
  const cache=new Map([['BN|BTCUSDT|5m|true',{at:Date.now(),data:flat}]]);
  let finish;
  const refresh=()=>new Promise(r=>finish=r);
  const route=new Function('klinesCache','startKlinesRefresh',`
    let handler;const app={get(_,fn){handler=fn}},setPublicCors=()=>{};
    const normalizeExchangeSymbol=(_,s)=>s,cacheKey=(ex,sym,tf,lite)=>[ex,sym,tf,lite].join('|');
    const KLINES_RESPONSE_DEADLINE_MS=6000,raceWithTimeout=p=>p;
    ${block(server,'mapConcurrent')}
    ${block(server,'encodeFlatCandles')}
    ${routeSrc}
    return handler;
  `)(cache,refresh);
  const rows=[],headers={};let ended=false,flushes=0;
  const res={setHeader(k,v){headers[k]=v},flushHeaders(){},write(row){rows.push(JSON.parse(row))},flush(){flushes++},end(){ended=true}};
  const work=route({query:{ex:'BN',symbols:'BTCUSDT,ETHUSDT',tf:'5m',lite:'1',stream:'1'}},res);
  await Promise.resolve();
  assert.equal(rows[0].sym,'BTCUSDT');assert.equal(ended,false);assert.equal(flushes,1);
  finish([{t:1,o:1,h:2,l:1,c:2,v:1}]);await work;
  assert.equal(rows.length,2);assert.equal(ended,true);assert.equal(headers['X-Accel-Buffering'],'no');
});
