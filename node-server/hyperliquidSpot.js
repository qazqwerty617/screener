"use strict";

const WebSocket = require('ws');
const URL = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const MAX_AGE = 15000, META_AGE = 120000;
const STABLE = new Set(['USDC','USDT','USDT0','USDH','USDE','DAI','FEUSD','FDUSD','USD1']);

function spotMetadata(payload) {
  const [meta,contexts] = Array.isArray(payload) ? payload : [];
  if(!Array.isArray(meta?.tokens)||!Array.isArray(meta.universe)||!Array.isArray(contexts)||meta.tokens.length>10000||meta.universe.length>10000||contexts.length>10000)throw Error('Invalid Hyperliquid spot metadata');
  const tokens=new Map(meta.tokens.map(t=>[t.index,t])),ctx=new Map(contexts.map(c=>[c.coin,c]));
  const markets=new Map(),identities=new Map();let unsupported=0;
  for(const m of meta.universe){
    const token=tokens.get(m.tokens?.[0]),quote=tokens.get(m.tokens?.[1]),base=String(token?.name||'').toUpperCase();
    if(quote?.name!=='USDC'){unsupported++;continue;}
    // Spot coin IDs are distinct from perp names. Never rename UBTC/UETH to BTC/ETH.
    if(!/^[A-Z0-9][A-Z0-9.]{0,30}$/.test(base)||STABLE.has(base)||!Number.isInteger(m.index)||m.index<0||m.index>999999)continue;
    const symbol=m.index===0?'PURR/USDC':`@${m.index}`;
    if(m.name!==symbol)continue;
    const volume=Number(ctx.get(symbol)?.dayNtlVlm);
    if(!Number.isFinite(volume)||volume<5000)continue;
    if(!token.tokenId)continue;
    if(!identities.has(base))identities.set(base,new Set());identities.get(base).add(token.tokenId);
    markets.set(symbol,{base,symbol,quote:'USDC',volume,tokenId:token.tokenId,contractAddress:token.evmContract?.address||null});
  }
  // Ambiguous tickers must not silently select a different token with a higher volume.
  for(const [symbol,m] of markets)if(identities.get(m.base).size>1)markets.delete(symbol);
  return {markets,totalMarkets:meta.universe.length,unsupportedQuoteMarkets:unsupported};
}

function spotBbo(data,market,observedAt) {
  if(!market||data?.coin!==market.symbol||!Array.isArray(data.bbo)||data.bbo.length!==2)return null;
  const bid=Number(data.bbo[0]?.px),ask=Number(data.bbo[1]?.px),at=Number(data.time);
  const bidSize=Number(data.bbo[0]?.sz),askSize=Number(data.bbo[1]?.sz);
  if(!(bid>0&&ask>=bid&&bidSize>0&&askSize>0&&[bid,ask,bidSize,askSize,at].every(Number.isFinite)&&at>0)||at>observedAt+1000||observedAt-at>MAX_AGE)return null;
  return {...market,ex:'HL',bid,ask,bidSize,askSize,at:Math.min(at,observedAt),sourceAt:at,observedAt,feePct:.07};
}

function convertUsdcQuote(quote,fx,time) {
  if(!fx||fx.base!=='USDC'||!(fx.bid>0&&fx.ask>=fx.bid)||![fx.bid,fx.ask,quote.bid,quote.ask,quote.at,fx.at].every(Number.isFinite)||time-fx.at>MAX_AGE||fx.at>time+1000||quote.at>time+1000||time-quote.at>MAX_AGE||Math.abs(fx.at-quote.at)>10000)return null;
  const fee=Number(fx.feePct)/100;
  if(!Number.isFinite(fee)||fee<0||fee>=1)return null;
  // Reference-market valuation with directional bid/ask and a modelled FX fee.
  // USDC is never treated as USDT at par. This is not a verified bridge route.
  return {...quote,nativeBid:quote.bid,nativeAsk:quote.ask,bid:quote.bid*fx.bid*(1-fee),ask:quote.ask*fx.ask/(1-fee),
    volume:quote.volume*fx.bid,at:Math.min(quote.at,fx.at),
    quoteConversion:{ex:fx.ex,symbol:fx.symbol,bid:fx.bid,ask:fx.ask,at:fx.at,feePct:fx.feePct}};
}

function createHyperliquidSpot({json,now=Date.now,socketFactory=(url,options)=>new WebSocket(url,options)}={}) {
  let metadata={markets:new Map(),totalMarkets:0,unsupportedQuoteMarkets:0},metadataAt=0,metadataDue=0,pending=null,metadataStatus='pending',requestedSubscriptions=0;
  let socket=null,heartbeat=null,reconnect=null,stopped=false,lastMessageAt=0,failures=0,revision=0,status='pending',retryAt=0;
  const quotes=new Map(),subscriptions=new Set();
  const send=(method,coin)=>socket?.send(JSON.stringify({method,subscription:{type:'bbo',coin}}));
  function reconcile(){
    for(const [coin,q] of quotes)if(metadata.markets.get(coin)?.tokenId!==q.tokenId)quotes.delete(coin);
    if(socket?.readyState!==1)return;
    for(const coin of subscriptions)if(!metadata.markets.has(coin)){send('unsubscribe',coin);subscriptions.delete(coin);quotes.delete(coin);}
    for(const coin of metadata.markets.keys())if(!subscriptions.has(coin)){send('subscribe',coin);subscriptions.add(coin);}
  }
  function connect(){
    if(stopped||socket||now()<retryAt||!metadata.markets.size)return;
    clearTimeout(reconnect);reconnect=null;
    status='connecting';revision++;
    const ws=socketFactory(WS_URL,{maxPayload:65536,handshakeTimeout:8000,perMessageDeflate:false});socket=ws;
    ws.on('open',()=>{
      if(stopped||socket!==ws){ws.terminate();return;}
      lastMessageAt=now();status='pending';reconcile();
      heartbeat=setInterval(()=>{
        if(socket!==ws)return;
        if(now()-lastMessageAt>60000){ws.terminate();return;}
        if(ws.readyState===1)ws.send(JSON.stringify({method:'ping'}));
      },20000);heartbeat.unref?.();
    });
    ws.on('message',raw=>{
      if(stopped||socket!==ws)return;
      lastMessageAt=now();
      try{
        const msg=JSON.parse(raw.toString());
        if(msg.channel==='error'){
          status=/limit|too many/i.test(String(msg.data))?'rate_limited':'error';
          retryAt=now()+60000;revision++;ws.terminate();return;
        }
        if(msg.channel!=='bbo')return;
        const q=spotBbo(msg.data,metadata.markets.get(msg.data?.coin),now());
        const old=quotes.get(msg.data?.coin);
        if(q&&(!old||q.sourceAt>=old.sourceAt)){quotes.set(q.symbol,q);status='ok';failures=0;revision++;}
        else if(!q&&old&&Number(msg.data?.time)>=old.sourceAt){quotes.delete(old.symbol);revision++;}
      }catch(_){} // Invalid messages cannot renew a quote's freshness.
    });
    ws.on('error',()=>{}); // close handles reconnect; no duplicate reconnect timers.
    ws.on('close',()=>{
      if(socket!==ws)return;
      clearInterval(heartbeat);heartbeat=null;socket=null;subscriptions.clear();quotes.clear();revision++;
      if(stopped)return;
      if(status!=='rate_limited')status='disconnected';retryAt=Math.max(retryAt,now()+Math.min(60000,3000*2**Math.min(failures++,4)));
      clearTimeout(reconnect);reconnect=setTimeout(()=>{reconnect=null;connect();},Math.max(0,retryAt-now()));reconnect.unref?.();
    });
  }
  function refresh(){
    if(stopped)return Promise.resolve();
    if(pending)return pending;
    if(now()<metadataDue){connect();return Promise.resolve();}
    pending=(async()=>{
      try{
        const next=spotMetadata(await json(URL,{method:'POST',body:{type:'spotMetaAndAssetCtxs'}}));
        if(stopped)return;
        // Reserve budget for existing perp streams under the provider's 1000-subscription limit.
        requestedSubscriptions=next.markets.size;
        if(next.markets.size>800){const error=Error('Hyperliquid spot subscription capacity');error.code='SUBSCRIPTION_CAPACITY';throw error;}
        metadata=next;metadataAt=now();metadataDue=now()+60000;metadataStatus='ok';revision++;reconcile();connect();
      }catch(error){
        if(stopped)return;
        metadataDue=now()+Math.min(3600000,Math.max(60000,error.retryMs||0));
        metadataStatus=error.code==='SUBSCRIPTION_CAPACITY'?'capacity_limited':[403,418,429,503].includes(error.status)?'rate_limited':'error';
        status=metadataStatus;revision++;
      }
    })().finally(()=>pending=null);return pending;
  }
  function snapshot(fx){
    const time=now(),byBase=new Map();
    if(time-metadataAt<=META_AGE)for(const q of quotes.values()){
      const m=metadata.markets.get(q.symbol);if(!m)continue;
      const converted=convertUsdcQuote({...q,volume:m.volume},fx,time),previous=byBase.get(q.base);
      if(converted&&(!previous||converted.volume>previous.volume))byBase.set(q.base,converted);
    }
    const rawFresh=[...quotes.values()].some(q=>time-q.at<=MAX_AGE);
    const fresh=[...byBase.values()];
    return {revision,quotes:fresh,source:{name:'Hyperliquid',status:metadataStatus==='capacity_limited'||time-metadataAt>META_AGE&&metadataStatus!=='ok'?metadataStatus:fresh.length?'ok':rawFresh&&!fx?'fx_unavailable':status==='ok'?'stale':status,
      markets:fresh.length,updatedAt:metadataAt,quote:'USDC',indicative:true,totalMarkets:metadata.totalMarkets,
      metadataStatus,requestedSubscriptions,subscribedMarkets:subscriptions.size,unsupportedQuoteMarkets:metadata.unsupportedQuoteMarkets,retryAt}};
  }
  function stop(){stopped=true;clearTimeout(reconnect);clearInterval(heartbeat);quotes.clear();subscriptions.clear();const ws=socket;socket=null;ws?.terminate();revision++;}
  function start(){stopped=false;void refresh();}
  return {refresh,snapshot,start,stop};
}
module.exports={spotMetadata,spotBbo,convertUsdcQuote,createHyperliquidSpot};
