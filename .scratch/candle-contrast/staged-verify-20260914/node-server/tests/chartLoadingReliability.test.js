"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
function block(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(src);
  assert.ok(m, name);
  return m[0];
}
function apiHarness(fetchImpl) {
  const start = server.indexOf('const venueBanUntil =');
  const end = server.indexOf('const USE_NATIVE_FETCH', start);
  return new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout', `
    const console={warn(){}};
    ${server.slice(start,end)}
    const USE_NATIVE_FETCH=true, API_FETCH_HEADERS_GET={}, API_FETCH_HEADERS_POST={};
    async function getFetchImpl(){return fetch;}
    ${block(server,'apiFetch')}
    return {apiFetch,binanceFallbackUrl};
  `)(fetchImpl, AbortController, setTimeout, clearTimeout);
}
test('a futures request never falls back to a spot market', () => {
  const h = apiHarness(async()=>{});
  assert.equal(h.binanceFallbackUrl('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT'), null);
});
test('HTTP 429 stops all retries within the same request', async () => {
  let calls=0;
  const h=apiHarness(async()=>{calls++;return new Response('rate limited',{status:429,headers:{'retry-after':'60'}});});
  await assert.rejects(h.apiFetch('https://api.bybit.com/v5/market/kline',1000,2));
  assert.equal(calls,1);
});
test('HTTP 200 throttle envelope triggers cooldown before another caller', async () => {
  let calls=0;
  const h=apiHarness(async()=>{calls++;return Response.json({retCode:10006,retMsg:'Too many visits!',result:{}});});
  await assert.rejects(h.apiFetch('https://api.bybit.com/v5/market/kline',1000,0));
  await assert.rejects(h.apiFetch('https://api.bybit.com/v5/market/kline',1000,0));
  assert.equal(calls,1);
});
test('a late expired refresh cannot replace newer cached candles', async () => {
  let resolveFirst,calls=0;
  const h=new Function('fetchFullHistory',`
    const klinesInFlight=new Map(),klinesCache=new Map();
    const KLINES_INFLIGHT_TTL_MS=15000;
    function pruneKlinesCache(){}
    ${block(server,'encodeFlatCandles')}
    ${block(server,'startKlinesRefresh')}
    return {klinesInFlight,klinesCache,startKlinesRefresh};
  `)(async()=> ++calls===1?new Promise(r=>resolveFirst=r):[{t:9,o:1,h:2,l:1,c:2,v:1}]);
  const first=h.startKlinesRefresh('BB','BTCUSDT','5m',true,'key');
  h.klinesInFlight.get('key').startedAt=0;
  await h.startKlinesRefresh('BB','BTCUSDT','5m',true,'key');
  resolveFirst([{t:1,o:1,h:2,l:1,c:2,v:1}]);await first;
  assert.equal(h.klinesCache.get('key').data[0],9);
});
function clientHarness(fetchImpl) {
  return new Function('fetch','AbortController','setTimeout','clearTimeout',`
    const sanitizeCandles=x=>x, KLINE_REQUESTS=new Map();
    ${app.includes('function decodeKlinePayload(')?block(app,'decodeKlinePayload'):''}
    ${block(app,'fetchServerKlines')}
    return fetchServerKlines;
  `)(fetchImpl,AbortController,setTimeout,clearTimeout);
}
test('twelve chart consumers share one pending history request', async () => {
  let calls=0;
  const f=clientHarness(async()=>{calls++;return Response.json([1,1,2,1,2,1,2,1,2,1,2,1]);});
  const result=await Promise.all(Array.from({length:12},()=>f('BB','BTCUSDT','5m')));
  assert.equal(calls,1);
  assert.ok(result.every(x=>x.length===2));
});
test('a pending server response is retried and decoded, not treated as empty history', async () => {
  let calls=0;
  const f=clientHarness(async()=>++calls===1?Response.json([],{headers:{'X-Klines-Pending':'1','Retry-After':'0.01'}}):Response.json([1,1,2,1,2,1,2,1,2,1,2,1]));
  const result=await f('BB','BTCUSDT','5m');
  assert.equal(result.length,2);
  assert.equal(calls,2);
});

test('upstream work that ignores abort still has a hard deadline', async () => {
  const h=apiHarness(()=>new Promise(()=>{}));
  let timer;
  const result=await Promise.race([
    h.apiFetch('https://api.bitget.com/api/v2/mix/market/tickers',20,0).then(()=> 'resolved',()=> 'rejected'),
    new Promise(r=>timer=setTimeout(()=>r('hung'),150))
  ]);
  clearTimeout(timer);
  assert.equal(result,'rejected');
});

function socketHarness() {
  const sockets=[];const emitted=[];const intervals=[];
  class Socket extends require('node:events').EventEmitter {
    constructor(url){super();this.url=url;this.readyState=1;this.sent=[];sockets.push(this);}
    send(data){this.sent.push(JSON.parse(data));}
  }
  const connect = new Function('WebSocket','broadcastKline','getKuCoinToken','recordInterval',`
    const TF_MAP={KC:{'5m':'5'}},markMarketOpen=()=>{},closeSocket=()=>{},startKlinePolling=()=>{},scheduleKlineReconnect=()=>{};
    const setInterval=(_,ms)=>{recordInterval(ms);return 1},clearInterval=()=>{},clearTimeout=()=>{};
    ${block(server,'syntheticSourceTf')}
    ${block(server,'connectKlineWs')}
    return connectKlineWs;
  `)(Socket,(...args)=>emitted.push(args),async()=>({endpoint:'wss://example.test',token:'fixture'}),ms=>intervals.push(ms));
  return {connect,sockets,emitted,intervals};
}
test('KuCoin subscribes to documented futures candles and decodes candle.stick', async () => {
  const h=socketHarness();h.connect({ex:'KC',sym:'XBTUSDTM',tf:'5m'});
  await Promise.resolve();const ws=h.sockets[0];ws.emit('open');
  assert.equal(ws.sent[0].topic,'/contractMarket/limitCandle:XBTUSDTM_5min');
  ws.emit('message',Buffer.from(JSON.stringify({subject:'candle.stick',topic:ws.sent[0].topic,data:{candles:['1788813000','10','12','13','9','7','84']}})));
  assert.equal(h.emitted.length,1);
  assert.deepEqual(h.emitted[0].slice(0,3),['KC','XBTUSDTM','5m']);
  assert.deepEqual(h.emitted[0][3],{t:1788813000000,o:10,c:12,h:13,l:9,v:84});
});

test('a warm server result avoids direct exchange calls for all 11 venues', async () => {
  let directCalls=0,serverCalls=0;
  const load=new Function('fetchDirectKlines','fetchServerKlines','AbortController','setTimeout','clearTimeout',`
    const KLINE_REQUESTS=new Map();${block(app,'fetchChartKlines')}return fetchChartKlines;
  `)(async()=>{directCalls++;return [1,2]},async()=>{serverCalls++;return [1,2]},AbortController,setTimeout,clearTimeout);
  await Promise.all(['BN','BB','OX','BG','GT','MX','KC','BX','HT','HL','AD'].map(ex=>load(ex,'BTC','5m')));
  assert.equal(directCalls,0);assert.equal(serverCalls,11);
});

test('each venue HTTP-200 throttle envelope starts a cooldown', async () => {
  const cases=[
    ['fapi.binance.com',{code:-1003,msg:'Too many requests'}],
    ['api.bybit.com',{retCode:10006,retMsg:'Too many visits!'}],
    ['www.okx.com',{code:'50011',msg:'Rate limit reached'}],
    ['api.bitget.com',{code:'429',msg:'Too many requests'}],
    ['api.gateio.ws',{label:'TOO_MANY_REQUESTS',message:'Too many requests'}],
    ['contract.mexc.com',{code:510,message:'Request frequency too fast'}],
    ['api-futures.kucoin.com',{code:'429000',msg:'Too many requests'}],
    ['open-api.bingx.com',{code:100410,msg:'Rate limit'}],
    ['api.hbdm.vn',{'err-code':'429','err-msg':'Too many requests',status:'error'}],
    ['api.hyperliquid.xyz',{error:'Too many requests'}],
    ['fapi.asterdex.com',{code:-1003,msg:'Too many requests'}],
  ];
  for(const [host,body]of cases){
    let calls=0;const h=apiHarness(async()=>{calls++;return Response.json(body)});
    await assert.rejects(h.apiFetch(`https://${host}/candles`,1000,2));
    await assert.rejects(h.apiFetch(`https://${host}/candles`,1000,2));
    assert.equal(calls,1,host);
  }
});

test('Bitget initial snapshot publishes only the newest live candle', () => {
  const h=socketHarness();h.connect({ex:'BG',sym:'BTCUSDT',tf:'5m'});
  const ws=h.sockets[0];ws.emit('open');
  ws.emit('message',Buffer.from(JSON.stringify({action:'snapshot',arg:{channel:'candle5m'},data:[
    ['1788813300000','10','13','9','12','1','84'],
    ['1788813000000','9','11','8','10','1','70'],
  ]})));
  assert.equal(h.emitted.length,1);
  assert.equal(h.emitted[0][3].t,1788813300000);
});

test('KuCoin heartbeat is sent before its 18-second session timeout', async () => {
  const h=socketHarness();h.connect({ex:'KC',sym:'XBTUSDTM',tf:'5m'});
  await Promise.resolve();h.sockets[0].emit('open');
  assert.ok(h.intervals[0]<=9000);
});
