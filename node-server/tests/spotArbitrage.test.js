'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SPOT_VENUES,normalizeSpotQuotes,createSpotMarketData}=require('../spotMarketData');
const {transferPaths,calculateSpotFlow,bestPath,createSpotArbitrage}=require('../spotArbitrage');
const {bookRequest,normalizeSpotBook,createSpotOrderBooks}=require('../spotOrderBooks');
const {normalizeBinance,normalizeGate,normalizeKucoin,normalizePoloniex,createTransferStatusService,PUBLIC_SOURCES}=require('../arbitrageTransferStatus');
const path={network:'BTC',identity:'native',fee:.1,variableFee:0,depositFee:0};
const args={asks:[[100,100]],bids:[[105,100]],notional:1000,buyFeePct:.1,sellFeePct:.2,path};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
const fixtures=at=>({
  BN:[{symbol:'BTCUSDT',bidPrice:'100',askPrice:'101',bidQty:'2',askQty:'3'}],
  MX:[{symbol:'BTCUSDT',bidPrice:'100',askPrice:'101'}],
  BX:{code:0,data:[{symbol:'BTC-USDT',bidPrice:'100',askPrice:'101',bidVolume:'2',askVolume:'3',time:at}]},
  AD:[{symbol:'BTCUSDT',bidPrice:'100',askPrice:'101',time:at}],
  BB:{retCode:0,result:{list:[{symbol:'BTCUSDT',bid1Price:'100',ask1Price:'101',turnover24h:'50000'}]}},
  OX:{code:'0',data:[{instId:'BTC-USDT',bidPx:'100',askPx:'101',volCcy24h:'50000',ts:at}]},
  BG:{code:'00000',data:[{symbol:'BTCUSDT',bidPr:'100',askPr:'101',usdtVolume:'50000'}]},
  GT:[{currency_pair:'BTC_USDT',highest_bid:'100',lowest_ask:'101',quote_volume:'50000'}],
  KC:{code:'200000',data:{ticker:[{symbol:'BTC-USDT',buy:'100',sell:'101',volValue:'50000'}]}},
  HT:{status:'ok',data:[{symbol:'btcusdt',bid:100,ask:101,vol:50000}]},
  PL:[{symbol:'BTC_USDT',bid:'100',ask:'101',amount:'50000',ts:at}],
  CD:{code:0,result:{data:[{i:'BTC_USDT',b:100,k:101,vv:50000,t:at-86400000},{i:'BTCUSD-PERP',b:1,k:2,vv:50000}]}},
  KR:{error:[],result:{'BTC/USDT':{a:['101','1','2'],b:['100','1','2'],v:['0','500'],p:['0','100']},'BTC/USD':{a:['1'],b:['1']}}},
  BS:[{market:'BTC/USDT',market_type:'SPOT',bid:'100',ask:'101',volume:'500',vwap:'100',timestamp:at/1000}],
});
for(const ex of Object.keys(SPOT_VENUES).filter(ex=>ex!=='HL'))test(`USDT spot BBO and volume normalize correctly: ${ex}`,()=>{
  const result=normalizeSpotQuotes(ex,fixtures(100000)[ex],100000,new Map([['BTCUSDT',50000],['BTC-USDT',50000]]));
  assert.equal(result.size,1);const q=result.get('BTC');assert.equal(q.bid,100);assert.equal(q.ask,101);assert.equal(q.volume,50000);assert.equal(q.at,100000);
});
test('spot normalization rejects futures, leverage, USD conversions, invalid/future BBO; JUP is a genuine token',()=>{
  const rows=['JUPUSDT','BTCUSDT_SPOT','1000PEPEUSDT_PERP','ETHUPUSDT','BTC3LUSDT','BTCUSD','10SETUSDT'].map(symbol=>({symbol,bidPrice:1,askPrice:2}));
  const result=normalizeSpotQuotes('BN',rows,100000);assert.deepEqual([...result.keys()],['JUP','10SET']);
  assert.equal(normalizeSpotQuotes('BN',[{symbol:'BTCUSDT',bidPrice:2,askPrice:1}],100000).size,0);
  assert.equal(normalizeSpotQuotes('OX',{code:'0',data:[{instId:'BTC-USDT',bidPx:1,askPx:2,ts:102000}]},100000).size,0);
  assert.throws(()=>normalizeSpotQuotes('BB',{retCode:10000},100000));
});
test('complete ledger subtracts BUY fee in base, withdrawal in coins, SELL fee in quote',()=>{
  const f=calculateSpotFlow(args);near(f.bought,10);near(f.buyFeeBase,.01);near(f.acquired,9.99);near(f.received,9.89);
  near(f.sold,9.89);near(f.sellFeeUsdt,2.0769);near(f.proceeds,1036.3731);near(f.profitUsdt,36.3731);assert.equal(f.complete,true);
});
test('quote-denominated BUY fee includes commission inside budget; explicit zero overrides remain zero',()=>{
  const f=calculateSpotFlow({...args,buyFeeAsset:'quote'});near(f.buyCost+f.buyFeeUsdt,1000);
  const zero=calculateSpotFlow({...args,buyFeePct:0,sellFeePct:0,path:{...path,fee:0}});near(zero.profitUsdt,50);
});
test('unknown fee/identity and variable withdrawal fees never generate confirmed profit',()=>{
  for(const p of [null,{...path,fee:null},{...path,identity:'unverified'},{...path,variableFee:.01}]){
    const f=calculateSpotFlow({...args,path:p});assert.equal(f.complete,false);assert.equal(f.profitUsdt,null);assert.equal(f.netPct,null);
    if(p===null||p.fee===null){assert.equal(f.received,null);assert.equal(f.sold,null);assert.equal(f.sellFeeUsdt,null);}
  }
});
test('rounding dust is disclosed and never counted as realised sale profit; withdrawal/deposit minimums respected',()=>{
  const f=calculateSpotFlow({...args,path:{...path,step:1}});near(f.withdrawal,9);near(f.dust,.99);near(f.received,8.9);
  near(f.profitUsdt,8.9*105*.998-1000);
  for(const p of [{...path,minWithdraw:11},{...path,minDeposit:10},{...path,fee:10}])assert.equal(calculateSpotFlow({...args,path:p}).profitUsdt,null);
});
test('insufficient BUY or received SELL depth fails closed; slippage walks every consumed level',()=>{
  assert.equal(calculateSpotFlow({...args,asks:[[100,1]]}).profitUsdt,null);
  assert.equal(calculateSpotFlow({...args,bids:[[105,1]]}).profitUsdt,null);
  const f=calculateSpotFlow({...args,asks:[[100,5],[110,100]]});assert.ok(f.buyAverage>100);assert.equal(f.buyLevels,2);assert.ok(f.profitUsdt<36);
});
test('network choice considers fixed fees and minimums, rather than choosing an unusable cheapest network',()=>{
  const cheap={...path,network:'FAST',fee:0,minWithdraw:100},valid={...path,network:'BTC',fee:.2};
  assert.equal(bestPath([cheap,valid],args).path.network,'BTC');
  assert.equal(bestPath([cheap,valid],args,'FAST').flow.complete,false);
});
test('chain match alone is insufficient: native coin or exact matching contract is required',()=>{
  const catalogs=new Map([['BN',new Map([['BTC',[{network:'BTC',withdraw:true,fee:.1}]],['ABC',[{network:'ETH',withdraw:true,fee:1,contractAddress:'0x'+'a'.repeat(40)}]]])],
    ['BG',new Map([['BTC',[{network:'BTC',deposit:true}]],['ABC',[{network:'ERC20',deposit:true,contractAddress:'0x'+'A'.repeat(40)}]]])]]);
  assert.equal(transferPaths(catalogs,'BTC','BN','BG').paths[0].identity,'native');
  assert.equal(transferPaths(catalogs,'ABC','BN','BG').paths[0].identity,'contract');
  catalogs.get('BG').get('ABC')[0].contractAddress='0x'+'b'.repeat(40);assert.equal(transferPaths(catalogs,'ABC','BN','BG').status,'mismatch');
  delete catalogs.get('BG').get('ABC')[0].contractAddress;assert.equal(transferPaths(catalogs,'ABC','BN','BG').paths[0].identity,'unverified');
});
test('matching malformed EVM contracts never verify token identity',()=>{
  const {assetIdentity}=require('../spotArbitrage');
  for(const address of ['0x123','garbage','-','0x'+'0'.repeat(40)])assert.equal(assetIdentity('ABC',{network:'ETH',contractAddress:address},{network:'ETH',contractAddress:address}),'unverified');
});
test('Gate book accepts documented epoch seconds or milliseconds without fabricating a future timestamp',()=>{
  const at=1790934000000;
  for(const current of [at,at/1000])assert.equal(normalizeSpotBook('GT',{current,asks:[[2,5]],bids:[[1,5]]},'BTC_USDT',at,at+10).at,at);
});
test('top-N heap returns the best routes and counts the full universe beyond the page limit',()=>{
  const at=100000,quotes=[];
  for(let i=0;i<20;i++)quotes.push({ex:'BN',base:'T'+i,symbol:'T'+i+'USDT',bid:99,ask:100,volume:1e6,at},
    {ex:'BG',base:'T'+i,symbol:'T'+i+'USDT',bid:101+i,ask:102+i,volume:1e6,at});
  const engine=createSpotArbitrage({snapshot:()=>({quotes,revision:1,sources:{}})},{getCatalogSnapshot:()=>({catalogs:new Map(),sources:{}})},{},{now:()=>at});
  const result=engine.snapshot({limit:3});assert.equal(result.total,20);assert.deepEqual(result.rows.map(r=>r.base),['T19','T18','T17']);
  assert.equal(engine.snapshot({limit:3}),result,'concurrent identical requests reuse the computed page');
  assert.equal(engine.snapshot({exchanges:['NONE']}).rows.length,0);
});
test('missing catalogue fees/status are null, Gate unknown flags are never an open network, KuCoin chainId is canonical',()=>{
  const b=normalizeBinance([{coin:'BTC',networkList:[{network:'BTC'}]}]).get('BTC')[0];assert.equal(b.fee,null);assert.equal(b.withdraw,null);
  assert.equal(normalizeGate([{currency:'BTC',chain:'BTC'}]).get('BTC')[0].deposit,null);
  assert.equal(normalizeKucoin({data:[{currency:'ETH',chains:[{chainName:'Ethereum',chainId:'eth'}]}]}).get('ETH')[0].network,'ETH');
});
test('Poloniex child-chain wallets attach to the traded parent asset without asserting missing contracts',()=>{
  const p=normalizePoloniex([{BTC:{blockchain:'BTC',walletDepositState:'ENABLED',walletWithdrawalState:'ENABLED',withdrawalFee:'.00004'}},
    {BTCB:{parentChain:'BTC',blockchain:'BSC',walletDepositState:'ENABLED',walletWithdrawalState:'ENABLED',withdrawalFee:'.00002'}}]);
  assert.equal(p.get('BTC').length,2);assert.equal(p.has('BTCB'),false);assert.equal(p.get('BTC')[1].contractAddress,null);
});
test('failed metadata refresh does not renew the age of an old catalogue',async()=>{
  let time=100000,failed=false;
  const service=createTransferStatusService(async url=>{
    if(failed)throw Error('offline');
    if(url===PUBLIC_SOURCES.BN)return [{coin:'BTC',networkList:[{network:'BTC',depositEnable:true,withdrawEnable:true}]}];
    return null;
  },{now:()=>time,ttlMs:60000,retryMs:5000});
  await service.refresh();assert.equal(service.getCatalogSnapshot().catalogs.has('BN'),true);
  time+=60001;failed=true;await service.refresh();assert.equal(service.getCatalogSnapshot().catalogs.has('BN'),false);
  assert.equal(service.getCatalogSnapshot().sources.BN.checkedAt,100000);
});
test('bulk feeds share in-flight work, cache 24h volumes, and progress while another venue is slow',async()=>{
  let time=100000,calls=[],release;
  const market=createSpotMarketData({now:()=>time,venues:{BN:SPOT_VENUES.BN,BB:SPOT_VENUES.BB},request:async url=>{
    calls.push(url);if(url.includes('bybit'))await new Promise(r=>release=r);
    return new Response(JSON.stringify(url.includes('24hr')?[{symbol:'BTCUSDT',quoteVolume:50000}]:url.includes('bybit')?fixtures(time).BB:fixtures(time).BN));
  }});
  const one=market.refresh(),two=market.refresh();await new Promise(r=>setImmediate(r));assert.equal(calls.filter(u=>u.includes('bybit')).length,1);
  assert.equal(market.getTickers().length,1);time+=6000;const three=market.refresh();await new Promise(r=>setImmediate(r));
  assert.equal(calls.filter(u=>u.includes('bookTicker')).length,2);assert.equal(calls.filter(u=>u.includes('24hr')).length,1);
  release();await Promise.all([one,two,three]);assert.equal(market.getTickers().length,2);
  time+=16000;assert.equal(market.getTickers().length,0);market.stop();
});
test('rate-limited feed honours Retry-After and never restores stale quotes',async()=>{
  let time=100000,calls=0;
  const market=createSpotMarketData({now:()=>time,venues:{BB:SPOT_VENUES.BB},request:async()=>{
    calls++;return new Response('{}',{status:429,headers:{'Retry-After':'120'}});
  }});
  await market.refresh();time+=60000;await market.refresh();assert.equal(calls,1);assert.equal(market.snapshot().sources.BB.status,'rate_limited');
  time+=60001;await market.refresh();assert.equal(calls,2);market.stop();
});
test('directed spread lifetime resets on nonpositive prices, a data gap, or a direction change',()=>{
  let time=100000,revision=1;
  const q=(ex,bid,ask)=>({ex,base:'BTC',symbol:'BTCUSDT',bid,ask,volume:1e6,at:time});let quotes=[q('BN',99,100),q('BG',103,104)];
  const market={snapshot:()=>({quotes,revision,sources:{}})},transfers={getCatalogSnapshot:()=>({catalogs:new Map(),sources:{}})};
  const engine=createSpotArbitrage(market,transfers,{} ,{now:()=>time});
  assert.equal(engine.snapshot().rows[0].spreadAgeMs,0);time+=5000;revision++;quotes=[q('BN',99,100),q('BG',103,104)];
  assert.equal(engine.snapshot().rows[0].spreadAgeMs,5000);assert.equal(engine.snapshot().rows[0].spreadSamples,2);
  time+=1000;revision++;quotes=[q('BN',99,100),q('BG',99,100)];assert.equal(engine.snapshot().rows.length,0);
  time+=1000;revision++;quotes=[q('BN',99,100),q('BG',103,104)];assert.equal(engine.snapshot().rows[0].spreadAgeMs,0);
  time+=16000;revision++;quotes=[q('BN',99,100),q('BG',103,104)];assert.equal(engine.snapshot().rows[0].spreadAgeMs,0);
  time+=1000;revision++;quotes=[q('BN',106,107),q('BG',103,104)];assert.equal(engine.snapshot().rows[0].buyEx,'BG');assert.equal(engine.snapshot().rows[0].spreadAgeMs,0);
});
test('spot quote rechecks fresh market/metadata after awaiting books; old cached rows expire',async()=>{
  let time=100000;const quotes=[{ex:'BN',base:'BTC',symbol:'BTCUSDT',bid:99,ask:100,volume:1e6,at:time},
    {ex:'BG',base:'BTC',symbol:'BTCUSDT',bid:103,ask:104,volume:1e6,at:time}];
  const market={snapshot:()=>({quotes,revision:1,sources:{}})},transfers={getCatalogSnapshot:()=>({catalogs:new Map(),sources:{}})};
  const engine=createSpotArbitrage(market,transfers,{get:async()=>{time+=9000;return {asks:[[100,100]],bids:[[103,100]],at:time};}},{now:()=>time});
  await assert.rejects(engine.quote('spot:BTC:BN:BG'),/Stale/);assert.equal(engine.snapshot().rows.length,0);
});
test('spot books reject wrong symbol, stale source, crossed markets, and never call futures endpoints',()=>{
  assert.ok(!bookRequest('BB','BTCUSDT').includes('linear'));assert.throws(()=>bookRequest('BN','BTCUSDT_SPOT'));
  const payload={retCode:0,result:{s:'BTCUSDT',a:[[101,3]],b:[[100,3]],ts:100000}};
  assert.equal(normalizeSpotBook('BB',payload,'BTCUSDT',100000,100100).asks[0][0],101);
  assert.throws(()=>normalizeSpotBook('BB',payload,'ETHUSDT',100000,100100));
  assert.throws(()=>normalizeSpotBook('BB',payload,'BTCUSDT',107000,107100));
  assert.throws(()=>normalizeSpotBook('BN',{asks:[[1,1]],bids:[[2,1]]},'BTCUSDT',100000,100100));
});
test('spot book cache coalesces users and notional changes into one request per venue market',async()=>{
  let calls=0,release;const books=createSpotOrderBooks(async()=>{calls++;await new Promise(r=>release=r);return {asks:[[101,100]],bids:[[100,100]]};},{now:()=>100000});
  const a=books.get('BN','BTCUSDT'),b=books.get('BN','BTCUSDT');await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();await Promise.all([a,b]);
  await books.get('BN','BTCUSDT');assert.equal(calls,1);
});
