'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {spotMetadata,spotBbo,convertUsdcQuote,createHyperliquidSpot}=require('../hyperliquidSpot');
const {SPOT_VENUES,createSpotMarketData,normalizeSpotQuotes}=require('../spotMarketData');
const {bookRequest,normalizeSpotBook,createSpotOrderBooks}=require('../spotOrderBooks');
const {createSpotArbitrage}=require('../spotArbitrage');
const metadata=()=>[{
  tokens:[{index:0,name:'USDC',tokenId:'usdc'},{index:150,name:'HYPE',tokenId:'hype'},{index:197,name:'UBTC',tokenId:'unit-btc'},
    {index:268,name:'USDT0',tokenId:'usdt0'}],
  universe:[{index:107,name:'@107',tokens:[150,0]},{index:142,name:'@142',tokens:[197,0]},
    {index:207,name:'@207',tokens:[150,268]}]},
  [{coin:'@142',dayNtlVlm:'800000'},{coin:'@3',dayNtlVlm:'1'}, {coin:'@107',dayNtlVlm:'50000'},{coin:'@207',dayNtlVlm:'900000'}]];
const fx=at=>({ex:'BN',base:'USDC',symbol:'USDCUSDT',bid:.98,ask:.99,feePct:.1,volume:1e8,at});
const bbo=(time,bid=100,ask=101)=>({coin:'@107',time,bbo:[{px:String(bid),sz:'100'},{px:String(ask),sz:'100'}]});
class Socket extends EventEmitter{
  readyState=0;sent=[];
  send(raw){this.sent.push(JSON.parse(raw));}
  open(){this.readyState=1;this.emit('open');}
  message(data){this.emit('message',Buffer.from(JSON.stringify({channel:'bbo',data})));}
  terminate(){this.readyState=3;this.emit('close');}
}
function service(t){
  let time=100000,calls=0,fail=false,payload=metadata();const sockets=[];
  const feed=createHyperliquidSpot({now:()=>time,json:async(url,options)=>{
    calls++;assert.equal(url,'https://api.hyperliquid.xyz/info');assert.equal(options.method,'POST');assert.equal(options.body.type,'spotMetaAndAssetCtxs');
    if(fail)throw Error('offline');return payload;
  },socketFactory:()=>{const ws=new Socket();sockets.push(ws);return ws;}});
  t.after(()=>feed.stop());return {feed,sockets,setTime:value=>time=value,setPayload:value=>payload=value,setFail:value=>fail=value,calls:()=>calls};
}

test('Hyperliquid sparse contexts join by coin ID, not array position; wrapped assets keep their identity',()=>{
  const result=spotMetadata(metadata());assert.equal(result.markets.get('@107').volume,50000);assert.equal(result.markets.get('@142').volume,800000);
  assert.equal(result.markets.get('@142').base,'UBTC');assert.equal(result.markets.has('@207'),false);assert.equal(result.unsupportedQuoteMarkets,1);
  assert.equal(Object.keys(SPOT_VENUES).length,15);
});

test('ambiguous token names, unknown spot IDs, missing/illiquid contexts and error envelopes fail closed',()=>{
  const p=metadata();p[0].tokens.push({index:999,name:'HYPE',tokenId:'different'});p[0].universe.push({index:500,name:'@500',tokens:[999,0]});
  p[1].push({coin:'@500',dayNtlVlm:6000});assert.equal(spotMetadata(p).markets.has('@107'),false);
  const q=metadata();q[0].universe[0].name='HYPE';assert.equal(spotMetadata(q).markets.has('@107'),false);
  assert.throws(()=>spotMetadata({error:'unavailable'}));const empty=metadata();empty[1]=[];assert.equal(spotMetadata(empty).markets.size,0);
});

test('spot BBO rejects perp names, crossed/empty books and stale/future data; mark/mid cannot supply BBO',()=>{
  const m=spotMetadata(metadata()).markets.get('@107');
  assert.equal(spotBbo(bbo(100000),m,100001).base,'HYPE');
  for(const data of [{...bbo(100000),coin:'HYPE'},bbo(100000,102,101),bbo(80000),bbo(102000),{coin:'@107',time:100000,midPx:100},
    {coin:'@107',time:100000,bbo:[null,null]}])assert.equal(spotBbo(data,m,100000),null);
});

test('USDC depeg is reflected with directional FX bid/ask and fees; unavailable or skewed FX excludes routes',()=>{
  const q=spotBbo(bbo(100000),spotMetadata(metadata()).markets.get('@107'),100000),result=convertUsdcQuote(q,fx(100000),100000);
  assert.ok(Math.abs(result.bid-97.902)<1e-8);assert.ok(Math.abs(result.ask-101*.99/.999)<1e-8);
  assert.equal(result.nativeAsk,101);assert.equal(result.quote,'USDC');assert.equal(result.quoteConversion.ex,'BN');
  assert.equal(convertUsdcQuote(q,null,100000),null);assert.equal(convertUsdcQuote(q,fx(80000),100000),null);
  assert.equal(convertUsdcQuote(q,fx(89999),101000),null);assert.equal(convertUsdcQuote(q,fx(102000),100000),null);
  assert.equal(convertUsdcQuote(q,{...fx(100000),ask:Infinity},100000),null);
});

test('one shared socket subscribes once, avoids per-pair REST polling and invalidates out-of-order/invalid data safely',async t=>{
  const {feed,sockets,calls}=service(t);await Promise.all([feed.refresh(),feed.refresh()]);assert.equal(calls(),1);assert.equal(sockets.length,1);
  const ws=sockets[0];ws.open();assert.deepEqual(ws.sent.map(x=>x.subscription.coin),['@107','@142']);
  ws.message(bbo(100000));assert.equal(feed.snapshot(fx(100000)).quotes.length,1);
  ws.message(bbo(99999,99,100));assert.equal(feed.snapshot(fx(100000)).quotes[0].nativeBid,100);
  await feed.refresh();assert.equal(calls(),1);assert.equal(ws.sent.length,2);
  ws.message(bbo(100001,102,101));assert.equal(feed.snapshot(fx(100000)).quotes.length,0);
});

test('socket disconnect clears all quotes; reconnect has backoff and does not replay old BBO',async t=>{
  const {feed,sockets,setTime}=service(t);await feed.refresh();sockets[0].open();sockets[0].message(bbo(100000));
  sockets[0].terminate();assert.equal(feed.snapshot(fx(100000)).quotes.length,0);assert.equal(feed.snapshot(fx(100000)).source.status,'disconnected');
  await feed.refresh();assert.equal(sockets.length,1);setTime(103001);await feed.refresh();assert.equal(sockets.length,2);
  sockets[1].open();assert.equal(feed.snapshot(fx(103001)).quotes.length,0);sockets[1].message(bbo(103001));assert.equal(feed.snapshot(fx(103001)).quotes.length,1);
  sockets[0].message(bbo(103001));assert.equal(feed.snapshot(fx(103001)).quotes.length,1);
});
test('upstream websocket rate limits clear quotes and respect a minute backoff without duplicate sockets',async t=>{
  const {feed,sockets,setTime}=service(t);await feed.refresh();sockets[0].open();sockets[0].message(bbo(100000));
  sockets[0].emit('message',Buffer.from(JSON.stringify({channel:'error',data:'Too many subscriptions: rate limit'})));
  assert.equal(feed.snapshot(fx(100000)).quotes.length,0);assert.equal(feed.snapshot(fx(100000)).source.status,'rate_limited');
  setTime(150000);await feed.refresh();assert.equal(sockets.length,1);setTime(160001);await feed.refresh();assert.equal(sockets.length,2);
});
test('provider subscription budget is explicit instead of silently truncating the universe or causing a ban',async t=>{
  const {feed,sockets,setPayload}=service(t),p=metadata();p[0].tokens=[p[0].tokens[0]];p[0].universe=[];p[1]=[];
  for(let i=1;i<=801;i++){p[0].tokens.push({index:i,name:'TOKEN'+i,tokenId:'id'+i});p[0].universe.push({index:i,name:'@'+i,tokens:[i,0]});p[1].push({coin:'@'+i,dayNtlVlm:6000});}
  setPayload(p);await feed.refresh();assert.equal(sockets.length,0);assert.equal(feed.snapshot(fx(100000)).source.status,'capacity_limited');
  assert.equal(feed.snapshot(fx(100000)).source.requestedSubscriptions,801);
});

test('missing FX is visible in health; stale quotes and expired metadata cannot be renewed by ping or failed fetch',async t=>{
  const {feed,sockets,setTime,setFail}=service(t);await feed.refresh();sockets[0].open();sockets[0].message(bbo(100000));
  assert.equal(feed.snapshot(null).source.status,'fx_unavailable');assert.equal(feed.snapshot(null).quotes.length,0);
  setTime(116000);assert.equal(feed.snapshot(fx(116000)).quotes.length,0);
  setTime(220001);setFail(true);await feed.refresh();sockets[0].message(bbo(220001));
  assert.equal(feed.snapshot(fx(220001)).quotes.length,0);assert.equal(feed.snapshot(fx(220001)).source.updatedAt,100000);
});

test('metadata refresh removes delisted subscriptions and rebinds volume without positional corruption',async t=>{
  const {feed,sockets,setTime,setPayload}=service(t);await feed.refresh();sockets[0].open();sockets[0].message(bbo(100000));
  const p=metadata();p[0].universe=p[0].universe.filter(x=>x.name!=='@107');setPayload(p);setTime(160001);await feed.refresh();
  assert.ok(sockets[0].sent.some(x=>x.method==='unsubscribe'&&x.subscription.coin==='@107'));assert.equal(feed.snapshot(fx(160001)).quotes.length,0);
});

test('stop during a pending metadata fetch never opens a late socket',async()=>{
  let release,opened=0;const feed=createHyperliquidSpot({json:()=>new Promise(resolve=>release=resolve),socketFactory:()=>{opened++;return new Socket();}});
  const pending=feed.refresh();feed.stop();release(metadata());await pending;assert.equal(opened,0);
});

test('BingX and Aster use real spot BBO/volume; timestamps and error envelopes are checked',()=>{
  const q=normalizeSpotQuotes('BX',{code:0,data:[{symbol:'BTC-USDT',bidPrice:100,askPrice:101,time:100000}]},100000,new Map([['BTC-USDT',9000]])).get('BTC');
  assert.equal(q.volume,9000);assert.equal(q.quote,'USDT');assert.throws(()=>normalizeSpotQuotes('BX',{code:100410,data:[]},100000));
  assert.equal(normalizeSpotQuotes('AD',[{symbol:'BTCUSDT',bidPrice:100,askPrice:101,time:102000}],100000).size,0);
  assert.equal(normalizeSpotQuotes('AD',[{symbol:'BTC_UP_DOWN_5M_1790906100_YUSDT',bidPrice:1,askPrice:2}],100000).size,0);
});

test('native spot books use BingX/Aster spot endpoints and Hyperliquid POST with spot IDs, never perps',async()=>{
  assert.match(bookRequest('BX','BTC-USDT'),/\/spot\/v1\/market\/depth/);assert.match(bookRequest('AD','BTCUSDT'),/sapi\.asterdex\.com\/api\/v3\/depth/);
  assert.throws(()=>bookRequest('HL','HYPE'));let args;
  const payload={coin:'@107',time:100000,levels:[[{px:'100',sz:'5'}],[{px:'101',sz:'5'}]]};
  const books=createSpotOrderBooks(async(...a)=>{args=a;return payload;},{now:()=>100000});
  const book=await books.get('HL','@107');assert.equal(args[3],'POST');assert.deepEqual(args[4],{type:'l2Book',coin:'@107'});assert.equal(book.asks[0][0],101);
  assert.throws(()=>normalizeSpotBook('HL',{...payload,coin:'HYPE'},'@107',100000,100001));
  assert.throws(()=>normalizeSpotBook('AD',{symbol:'ETHUSDT',asks:[[101,1]],bids:[[100,1]]},'BTCUSDT',100000,100001));
  const bx=normalizeSpotBook('BX',{code:0,timestamp:100000,data:{asks:[[101,1]],bids:[[100,1]]}},'BTC-USDT',100000,100001);assert.equal(bx.at,100000);
});

test('Hyperliquid market merge uses a shared live stablecoin quote and expires both legs',async t=>{
  let time=100000;const sockets=[];
  const market=createSpotMarketData({now:()=>time,venues:{BN:SPOT_VENUES.BN,HL:SPOT_VENUES.HL},socketFactory:()=>{const ws=new Socket();sockets.push(ws);return ws;},request:async(url,options)=>{
    if(url.endsWith('/info')){assert.equal(options.method,'POST');return new Response(JSON.stringify(metadata()));}
    if(url.includes('24hr'))return new Response(JSON.stringify([{symbol:'HYPEUSDT',quoteVolume:1e6},{symbol:'USDCUSDT',quoteVolume:1e9}]));
    return new Response(JSON.stringify([{symbol:'HYPEUSDT',bidPrice:99,askPrice:100},{symbol:'USDCUSDT',bidPrice:.98,askPrice:.99}]));
  }});
  t.after(()=>market.stop());await market.refresh();sockets[0].open();sockets[0].message(bbo(time));
  assert.equal(market.getTickers().length,2);assert.equal(market.getTickers().some(q=>q.base==='USDC'),false);assert.equal(market.snapshot().sources.HL.status,'ok');
  time+=16000;assert.equal(market.getTickers().length,0);
});

test('USDC routes stay indicative even with fabricated complete wallet metadata; detail values native depth in USDT',async()=>{
  const time=100000,h=convertUsdcQuote(spotBbo(bbo(time,110,111),spotMetadata(metadata()).markets.get('@107'),time),fx(time),time);
  const quotes=[{ex:'BN',base:'HYPE',symbol:'HYPEUSDT',bid:99,ask:100,at:time,volume:1e6},h];
  const contract='0x'+'a'.repeat(40),catalogs=new Map(['BN','HL'].map(ex=>[ex,new Map([['HYPE',[{network:'ETH',deposit:true,withdraw:true,fee:0,contractAddress:contract}]]])]));
  const engine=createSpotArbitrage({snapshot:()=>({quotes,revision:1,sources:{}})},{getCatalogSnapshot:()=>({catalogs,sources:{}})},
    {get:async ex=>({asks:[[ex==='HL'?111:100,100]],bids:[[ex==='HL'?110:99,100]],at:time})},{now:()=>time});
  const row=engine.snapshot().rows[0];assert.equal(row.sellQuote,'USDC');assert.equal(row.flow.complete,false);assert.equal(row.flow.profitUsdt,null);
  assert.ok(row.flow.reasons.includes('quote_conversion_unverified'));assert.equal(row.flow.reasons.filter(x=>x==='bridge_unverified').length,1);
  assert.equal(row.recommendations.cheapest,null,'unverified bridge cannot be recommended as a usable cheap transfer');
  const detail=await engine.quote(row.key);assert.ok(Math.abs(detail.sellBid-110*.98*.999)<1e-8);assert.equal(detail.flow.profitUsdt,null);
  assert.equal(detail.recommendations.cheapest,null);
});

test('an asset identity or spot coin change during async depth fetching rejects the old order book',async()=>{
  let revision=1;const at=100000;
  const quotes=[{ex:'BN',base:'HYPE',symbol:'HYPEUSDT',bid:99,ask:100,at,volume:1e6},
    {...convertUsdcQuote(spotBbo(bbo(at,110,111),spotMetadata(metadata()).markets.get('@107'),at),fx(at),at)}];
  const engine=createSpotArbitrage({snapshot:()=>({quotes,revision,sources:{}})},{getCatalogSnapshot:()=>({catalogs:new Map(),sources:{}})},
    {get:async()=>{quotes[1].tokenId='another-token';revision++;return {asks:[[100,100]],bids:[[110,100]],at};}},{now:()=>at});
  await assert.rejects(engine.quote('spot:HYPE:BN:HL'),/market changed/);
});
