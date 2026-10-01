'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const {createHistoryPageStore,parseHistoryResponse}=require('../historyPages');
const bar = t => ({t,o:100,h:101,l:99,c:100,v:1});
function routeFixture(upstream) {
  const start = source.indexOf('  let { ex = "BN", sym = "BTCUSDT", tf = "4h", lite = "0", before }');
  const end = source.indexOf('  const useLite =', start);
  const c = {normalizeExchangeSymbol:(_ex,sym)=>sym,syntheticSourceTf:()=>null,setPublicCors(){},
    getKlinesUrl:()=> 'https://exchange.test/history',apiFetch:upstream,parseKlines:(_ex,data)=>Array.isArray(data)?data:data.data,
    historicalPages:createHistoryPageStore(),parseHistoryResponse};
  vm.createContext(c);
  c.route = vm.runInContext('(async(req,res)=>{'+source.slice(start,end)+'})',c);
  c.request = async (query={}) => { const res={code:200,setHeader(){},status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
    await c.route({query:{ex:'BN',sym:'BTCUSDT',tf:'1m',before:'1700000000000',...query}},res); return res; };
  return c;
}
test('concurrent readers of the same older candle page share the upstream request',async()=>{
  let calls=0,release;
  const c=routeFixture(async()=>{calls++;await new Promise(r=>release=r);return [bar(1699999940000)];});
  const a=c.request(),b=c.request();
  await new Promise(r=>setImmediate(r));
  assert.equal(calls,1,'the history endpoint repeats the exchange request for every reader');
  release(); await Promise.all([a,b]);
});
test('revisiting an older page serves cached candles without another exchange round trip',async()=>{
  let calls=0;
  const c=routeFixture(async()=>{calls++;return [bar(1699999940000)];});
  await c.request(); await c.request();
  assert.equal(calls,1,'closed history is fetched repeatedly instead of served from cache');
});

for(const [ex,path,limit] of [['OX','/api/v5/market/history-candles',100],['BG','/api/v2/mix/market/history-candles',200]]) {
  test(`${ex} deep history uses its historical endpoint and supported page size`,async()=>{
    let requested;
    const c=routeFixture(async url=>{requested=new URL(url);return {code:ex==='BG'?'00000':'0',data:[bar(1699999940000)]};});
    c.URL=URL;
    c.getKlinesUrl=(_ex,_sym,_tf,size)=>`https://exchange.test${path.replace('history-candles','candles')}?limit=${size}`;
    assert.equal((await c.request({ex})).code,200);
    assert.equal(requested.pathname,path);assert.equal(+requested.searchParams.get('limit'),limit);
  });
}

test('an invalid history cursor fails instead of returning unrelated latest candles',async()=>{
  const c=routeFixture(async()=>[]);
  assert.equal((await c.request({before:'not-a-timestamp'})).code,400);
});

for(const [ex,payload] of [['BB',{retCode:10006,result:{list:[]}}],['OX',{code:'50011',data:[]}],
  ['BG',{code:'429',data:[]}],['BN',{code:-1003,msg:'Too many requests'}],['BB',{retCode:0,result:{list:[['bad']]}}]]) {
  test(`${ex} rejected or corrupt API payload does not masquerade as end of history (${JSON.stringify(payload)})`,async()=>{
    const c=routeFixture(async()=>payload);c.console=console;c.normalizeTimestamp=Number;
    const start=source.indexOf('function parseKlines('),end=source.indexOf('// Venues without a native',start);
    vm.runInContext(source.slice(start,end),c);
    assert.equal((await c.request({ex})).code,503);
  });
}
