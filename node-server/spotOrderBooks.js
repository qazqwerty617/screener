"use strict";
const { normalizeLevels } = require('./depthAnalyzer');
const { SPOT_VENUES } = require('./spotMarketData');

function bookRequest(ex,symbol){
  if(ex==='HL'){if(!/^(@\d{1,6}|PURR\/USDC)$/.test(symbol))throw Error('Invalid Hyperliquid spot market');return {url:'https://api.hyperliquid.xyz/info',method:'POST',body:{type:'l2Book',coin:symbol}};}
  if(!SPOT_VENUES[ex]||!/^([A-Z0-9][A-Z0-9.]{0,30})(?:[-_/]?USDT)$/.test(symbol))throw new Error('Invalid spot market');
  const s=encodeURIComponent(symbol);
  return ({BN:`https://api.binance.com/api/v3/depth?symbol=${s}&limit=500`,
    BX:`https://open-api.bingx.com/openApi/spot/v1/market/depth?symbol=${s}&limit=500`,
    AD:`https://sapi.asterdex.com/api/v3/depth?symbol=${s}&limit=500`,
    MX:`https://api.mexc.com/api/v3/depth?symbol=${s}&limit=500`,
    BB:`https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${s}&limit=200`,
    OX:`https://www.okx.com/api/v5/market/books?instId=${s}&sz=400`,
    BG:`https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${s}&type=step0&limit=150`,
    GT:`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${s}&limit=100&with_id=true`,
    KC:`https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${s}`,
    HT:`https://api.huobi.pro/market/depth?symbol=${s.toLowerCase()}&type=step0&depth=20`,
    PL:`https://api.poloniex.com/markets/${s}/orderBook?limit=150`,
    CD:`https://api.crypto.com/exchange/v1/public/get-book?instrument_name=${s}&depth=50`,
    KR:`https://api.kraken.com/0/public/Depth?pair=${s}&count=500`,
    BS:`https://www.bitstamp.net/api/v2/order_book/${symbol.replace('/','').toLowerCase()}/`})[ex];
}
function normalizeSpotBook(ex,payload,symbol,requestedAt,finishedAt){
  let data=payload,asks,bids,sourceAt=null;
  if(ex==='HL'){
    if(payload?.coin!==symbol||!Array.isArray(payload.levels)||payload.levels.length!==2)throw Error('Invalid Hyperliquid spot book');
    bids=payload.levels[0].map(l=>[l.px,l.sz]);asks=payload.levels[1].map(l=>[l.px,l.sz]);sourceAt=Number(payload.time);
  }else if(ex==='BX'){
    if(Number(payload?.code)!==0)throw Error('Invalid BingX spot book');data=payload.data;sourceAt=Number(data?.ts||payload.timestamp);
  }else if(ex==='AD'){
    if(payload?.symbol!==symbol)throw Error('Wrong Aster spot book');sourceAt=Number(payload.T||payload.E);
  }else if(ex==='BB'){
    if(Number(payload?.retCode)!==0||payload.result?.s!==symbol)throw new Error('Invalid Bybit spot book');
    data=payload.result;asks=data.a;bids=data.b;sourceAt=Number(data.ts);
  }else if(ex==='OX'){
    if(String(payload?.code)!=='0')throw new Error('Invalid OKX spot book');data=payload.data?.[0];sourceAt=Number(data?.ts);
  }else if(ex==='BG'){
    if(String(payload?.code)!=='00000')throw new Error('Invalid Bitget spot book');data=payload.data;sourceAt=Number(data?.ts);
  }else if(ex==='KC'){
    if(String(payload?.code)!=='200000')throw new Error('Invalid KuCoin spot book');data=payload.data;sourceAt=Number(data?.time);
  }else if(ex==='HT'){
    if(payload?.status!=='ok'||payload.ch!==`market.${symbol.toLowerCase()}.depth.step0`)throw new Error('Invalid HTX spot book');data=payload.tick;sourceAt=Number(payload.ts);
  }else if(ex==='CD'){
    if(Number(payload?.code)!==0||payload.result?.instrument_name!==symbol)throw new Error('Invalid Crypto.com spot book');data=payload.result?.data?.[0];sourceAt=Number(data?.t);
  }else if(ex==='KR'){
    if(!Array.isArray(payload?.error)||payload.error.length||Object.keys(payload.result||{}).length!==1)throw new Error('Invalid Kraken spot book');
    data=Object.values(payload.result)[0]; // per-level timestamps are last changes, not snapshot age
  }else if(ex==='PL'){
    const pairs=levels=>Array.isArray(levels)?Array.from({length:Math.floor(levels.length/2)},(_,i)=>[levels[i*2],levels[i*2+1]]):[];
    if(payload?.symbol&&payload.symbol!==symbol)throw new Error('Wrong Poloniex spot book');
    asks=pairs(data.asks);bids=pairs(data.bids);sourceAt=Number(data.ts||data.time);
  }else if(ex==='BS')sourceAt=Number(data.timestamp)*1000;
  else if(ex==='GT'){const current=Number(data.current);sourceAt=current>1e11?current:current*1000;}
  asks??=data?.asks;bids??=data?.bids;
  if(!Array.isArray(asks)||!Array.isArray(bids)||asks.length>2000||bids.length>2000)throw new Error('Invalid spot book levels');
  asks=normalizeLevels(asks);bids=normalizeLevels(bids,1,true);
  if(!asks.length||!bids.length||bids[0][0]>asks[0][0])throw new Error('Empty or crossed spot book');
  if(sourceAt>finishedAt+1000||sourceAt>0&&finishedAt-sourceAt>5000||finishedAt-requestedAt>5000)throw new Error('Stale spot book');
  return {asks,bids,at:sourceAt>0?Math.min(sourceAt,requestedAt):requestedAt};
}
function createSpotOrderBooks(apiFetch,{now=Date.now}={}){
  const cache=new Map(),pending=new Map();let active=0;const queue=[];
  async function slot(){if(active<6){active++;return;}if(queue.length>=48)throw new Error('Spot book queue busy');await new Promise(resolve=>queue.push(resolve));}
  function release(){const next=queue.shift();if(next)next();else active--;}
  async function get(ex,symbol){
    const url=bookRequest(ex,symbol),key=`${ex}:${symbol}`,cached=cache.get(key);
    if(cached&&now()-cached.at<2000)return cached;
    if(pending.has(key))return pending.get(key);
    const operation=(async()=>{
      await slot();
      try{const started=now(),payload=await apiFetch(typeof url==='string'?url:url.url,5000,1,typeof url==='string'?'GET':url.method,typeof url==='string'?null:url.body),book=normalizeSpotBook(ex,payload,symbol,started,now());
        cache.delete(key);cache.set(key,book);while(cache.size>200)cache.delete(cache.keys().next().value);return book;
      }finally{release();}
    })().finally(()=>pending.delete(key));pending.set(key,operation);return operation;
  }
  return {get};
}
module.exports={bookRequest,normalizeSpotBook,createSpotOrderBooks};
