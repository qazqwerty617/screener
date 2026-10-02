'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {SPOT_VENUES}=require('../spotMarketData'),{feeFor,validNotional}=require('../spotArbitrage');
const source=fs.readFileSync(require.resolve('../server'),'utf8');
function endpoints(){
  const routes=new Map(),calls=[],ctx={SPOT_VENUES,feeFor,validNotional,app:{get:(path,handler)=>routes.set(path,handler)},
    spotArbitrage:{snapshot:options=>{calls.push({method:'snapshot',options});return {rows:[],notional:options.notional};},
      quote:async(key,options,overlay)=>{calls.push({method:'quote',key,options,overlay});return {key,flow:{}};}},
    loadAuthenticatedTransferCatalogs:async()=>{calls.push({method:'auth'});return new Map();}};
  const start=source.indexOf('function spotOptions(query)'),end=source.indexOf('app.get("/api/arbitrage/history"',start);
  vm.runInNewContext(source.slice(start,end),ctx);
  return {routes,calls,ctx};
}
function response(){return {code:200,headers:{},status(code){this.code=code;return this;},setHeader(k,v){this.headers[k]=v;},json(body){this.body=body;return this;}};}
test('spot snapshot validates budget and fees before expensive work; explicit zero is preserved',()=>{
  const {routes,calls}=endpoints(),handler=routes.get('/api/arbitrage/spot');
  for(const query of [{notional:0},{notional:'NaN'},{buyFeePct:-1},{sellFeePct:6}]){const res=response();handler({query},res);assert.equal(res.code,400);}
  assert.equal(calls.length,0);const res=response();handler({query:{notional:1000,buyFeePct:'0',sellFeePct:'0'}},res);
  assert.equal(calls[0].options.buyFeePct,0);assert.equal(res.headers['Cache-Control'],'no-store');
});
test('exchange filters accept new spot venues, remove unsupported futures venues, and preserve explicit NONE',()=>{
  const {routes,calls}=endpoints(),handler=routes.get('/api/arbitrage/spot');
  handler({query:{exchanges:'PL,KR,BS,CD,HL,BN,BN'}},response());assert.equal(calls[0].options.exchanges.join(','),'BN,BS,CD,KR,PL');
  handler({query:{exchanges:'NONE'}},response());assert.equal(calls[1].options.exchanges.join(','),'NONE');
});
test('invalid routes and ineligible spot exchanges do not access linked private accounts',async()=>{
  const {routes,calls}=endpoints(),handler=routes.get('/api/arbitrage/spot/quote');
  for(const key of ['spread:BTC:BN:BG','spot:BTC:HL:BN','spot:BTC:BN:BN','spot:BTC:<script>:BG']){const res=response();await handler({query:{key}},res);assert.equal(res.code,400);}
  assert.equal(calls.length,0);
});
test('spot depth results are private and include selected network and account overlays',async()=>{
  const {routes,calls}=endpoints(),res=response();
  await routes.get('/api/arbitrage/spot/quote')({query:{key:'spot:BTC:BN:BG',network:'BTC',notional:'500'}},res);
  assert.equal(res.code,200);assert.equal(res.headers['Cache-Control'],'private, no-store');assert.equal(calls[0].method,'auth');
  assert.equal(calls[1].options.network,'BTC');assert.equal(calls[1].options.notional,500);
});
test('upstream book failures return explicit unavailability rather than a successful old ledger',async()=>{
  const {routes,ctx}=endpoints(),res=response();ctx.spotArbitrage.quote=async()=>{throw Error('secret private provider response');};
  await routes.get('/api/arbitrage/spot/quote')({query:{key:'spot:BTC:BN:BG'}},res);
  assert.equal(res.code,502);assert.doesNotMatch(res.body.error,/secret/);
});
