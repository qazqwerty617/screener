"use strict";

// Dedicated USDT spot quotes. Futures symbols and ticker last prices never
// substitute for a missing ask/bid. Shared by arbitrage and the wall universe.
const SPOT_VENUES = Object.freeze({
  BN:{name:"Binance",feePct:.1,url:"https://api.binance.com/api/v3/ticker/bookTicker"},
  BB:{name:"Bybit",feePct:.1,url:"https://api.bybit.com/v5/market/tickers?category=spot"},
  OX:{name:"OKX",feePct:.1,url:"https://www.okx.com/api/v5/market/tickers?instType=SPOT"},
  BG:{name:"Bitget",feePct:.2,url:"https://api.bitget.com/api/v2/spot/market/tickers"},
  GT:{name:"Gate.io",feePct:.2,url:"https://api.gateio.ws/api/v4/spot/tickers"},
  MX:{name:"MEXC",feePct:.1,url:"https://api.mexc.com/api/v3/ticker/bookTicker"},
  KC:{name:"KuCoin",feePct:.1,url:"https://api.kucoin.com/api/v1/market/allTickers"},
  HT:{name:"HTX",feePct:.2,url:"https://api.huobi.pro/market/tickers"},
  PL:{name:"Poloniex",feePct:.2,url:"https://api.poloniex.com/markets/ticker24h"},
  CD:{name:"Crypto.com",feePct:.5,url:"https://api.crypto.com/exchange/v1/public/get-tickers"},
  KR:{name:"Kraken",feePct:.4,url:"https://api.kraken.com/0/public/Ticker?assetVersion=1"},
  BS:{name:"Bitstamp",feePct:.4,url:"https://www.bitstamp.net/api/v2/ticker/"},
});
const VOLUME_URLS={BN:"https://api.binance.com/api/v3/ticker/24hr",MX:"https://api.mexc.com/api/v3/ticker/24hr"};
const MAX_QUOTE_AGE_MS=15000;
const number=v=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(Number(v))?Number(v):null;

function normalizeSpotQuotes(ex,payload,observedAt,volumes=new Map()) {
  let rows;
  if(["BN","MX","GT","PL","BS"].includes(ex))rows=payload;
  else if(ex==="BB"){if(Number(payload?.retCode)!==0)throw new Error("Invalid Bybit response");rows=payload.result?.list;}
  else if(ex==="OX"){if(String(payload?.code)!=="0")throw new Error("Invalid OKX response");rows=payload.data;}
  else if(ex==="BG"){if(String(payload?.code)!=="00000")throw new Error("Invalid Bitget response");rows=payload.data;}
  else if(ex==="KC"){if(String(payload?.code)!=="200000")throw new Error("Invalid KuCoin response");rows=payload.data?.ticker;}
  else if(ex==="HT"){if(payload?.status!=="ok")throw new Error("Invalid HTX response");rows=payload.data;}
  else if(ex==="CD"){if(Number(payload?.code)!==0)throw new Error("Invalid Crypto.com response");rows=payload.result?.data;}
  else if(ex==="KR"){
    if(!Array.isArray(payload?.error)||payload.error.length||!payload.result||typeof payload.result!=="object")throw new Error("Invalid Kraken response");
    rows=Object.entries(payload.result).map(([symbol,row])=>({...row,symbol}));
  }
  if(!Array.isArray(rows)||rows.length>25000)throw new Error("Invalid spot ticker list");
  const quotes=new Map();
  for(const r of rows){
    let symbol,bid,ask,bidSize,askSize,volume,sourceAt=null;
    if(["BN","MX"].includes(ex)){symbol=r.symbol;bid=r.bidPrice;ask=r.askPrice;bidSize=r.bidQty;askSize=r.askQty;volume=volumes.get(symbol);}
    else if(ex==="BB"){symbol=r.symbol;bid=r.bid1Price;ask=r.ask1Price;bidSize=r.bid1Size;askSize=r.ask1Size;volume=r.turnover24h;}
    else if(ex==="OX"){symbol=r.instId;bid=r.bidPx;ask=r.askPx;bidSize=r.bidSz;askSize=r.askSz;volume=r.volCcy24h;sourceAt=number(r.ts);}
    else if(ex==="BG"){symbol=r.symbol;bid=r.bidPr;ask=r.askPr;bidSize=r.bidSz;askSize=r.askSz;volume=r.usdtVolume;}
    else if(ex==="GT"){symbol=r.currency_pair;bid=r.highest_bid;ask=r.lowest_ask;volume=r.quote_volume;}
    else if(ex==="KC"){symbol=r.symbol;bid=r.buy;ask=r.sell;volume=r.volValue;}
    else if(ex==="HT"){symbol=String(r.symbol||"").toUpperCase();bid=r.bid;ask=r.ask;bidSize=r.bidSize;askSize=r.askSize;volume=r.vol;}
    else if(ex==="PL"){symbol=r.symbol;bid=r.bid;ask=r.ask;bidSize=r.bidQuantity;askSize=r.askQuantity;volume=r.amount;sourceAt=number(r.ts);}
    else if(ex==="CD"){symbol=r.i;bid=r.b;ask=r.k;volume=r.vv;/* t is last trade time, not the age of the BBO. */}
    else if(ex==="KR"){symbol=r.symbol;bid=r.b?.[0];ask=r.a?.[0];bidSize=r.b?.[2];askSize=r.a?.[2];volume=number(r.v?.[1])*number(r.p?.[1]);}
    else if(ex==="BS"){symbol=r.market||r.pair;if(r.market_type&&r.market_type!=="SPOT")continue;bid=r.bid;ask=r.ask;volume=number(r.volume)*number(r.vwap);sourceAt=number(r.timestamp)*1000;}
    symbol=String(symbol||"").toUpperCase();
    const match=/^([A-Z0-9][A-Z0-9.]{0,30})(?:[-_/]?USDT)$/.exec(symbol);
    if(!match)continue;
    const base=ex==="KR"&&match[1]==="XBT"?"BTC":match[1];
    if(/(?:[235][LS]|BULL|BEAR)$/.test(base)||/^(?:BTC|ETH|BNB|XRP|TRX|EOS|ADA|LTC|DOT|LINK|BCH)(?:UP|DOWN)$/.test(base)||["USDT","USDC","BUSD","DAI","TUSD","FDUSD","USDE","USD1"].includes(base))continue;
    bid=number(bid);ask=number(ask);volume=number(volume);
    if(!(bid>0&&ask>=bid))continue;
    const at=sourceAt>0?Math.min(observedAt,sourceAt):observedAt;
    if(sourceAt>observedAt+1000)continue;
    const q={ex,symbol,base,bid,ask,bidSize:number(bidSize),askSize:number(askSize),volume:volume>0?volume:0,
      observedAt,at,sourceAt:sourceAt>0?sourceAt:null,feePct:SPOT_VENUES[ex].feePct};
    const existing=quotes.get(base);
    if(!existing||q.at>existing.at||q.at===existing.at&&q.volume>existing.volume)quotes.set(base,q);
  }
  return quotes;
}

function spotTradeUrl(ex,symbol){
  const s=encodeURIComponent(symbol),plain=encodeURIComponent(symbol.replace(/[-_/]/g,""));
  return ({BN:`https://www.binance.com/en/trade/${s.replace(/USDT$/,"_USDT")}?type=spot`,
    BB:`https://www.bybit.com/en/trade/spot/${s.replace(/USDT$/,"/USDT")}`,
    OX:`https://www.okx.com/trade-spot/${s.toLowerCase()}`,BG:`https://www.bitget.com/spot/${plain}`,
    GT:`https://www.gate.com/trade/${s}`,MX:`https://www.mexc.com/exchange/${s.replace(/USDT$/,"_USDT")}`,
    KC:`https://www.kucoin.com/trade/${s}`,HT:`https://www.htx.com/trade/${s.toLowerCase()}`,
    PL:`https://poloniex.com/trade/${s}`,CD:`https://crypto.com/exchange/trade/${s}`,
    KR:`https://pro.kraken.com/app/trade/${encodeURIComponent(symbol.replace('/','-').toLowerCase())}`,
    BS:`https://www.bitstamp.net/markets/${encodeURIComponent(symbol.replace('/','').toLowerCase())}/`})[ex]||null;
}

function createSpotMarketData({request=fetch,now=Date.now,pollMs=5000,venues=SPOT_VENUES}={}){
  const quotes=new Map(),health=new Map(),volumes=new Map(),volumeAt=new Map(),due=new Map(),pending=new Map();
  let timer=null,stopped=false,revision=0,snapshotCache=null,snapshotAt=-Infinity,snapshotRevision=-1;
  const controllers=new Set();
  async function json(url){
    const controller=new AbortController();controllers.add(controller);const timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const r=await request(url,{signal:controller.signal,redirect:"error",headers:{Accept:"application/json"}});
      if(!r.ok){
        const retry=r.headers?.get("retry-after"),seconds=Number(retry);
        const delay=retry&&Number.isFinite(seconds)?seconds*1000:retry?Date.parse(retry)-now():null;
        await r.body?.cancel().catch(()=>{});
        const e=new Error(`HTTP ${r.status}`);e.status=r.status;e.retryMs=Number.isFinite(delay)?delay:null;throw e;
      }
      if(Number(r.headers?.get("content-length"))>6000000){await r.body?.cancel().catch(()=>{});throw new Error("Spot response too large");}
      const chunks=[];let size=0;
      for await(const chunk of r.body){size+=chunk.length;if(size>6000000){controller.abort();throw new Error("Spot response too large");}chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }finally{clearTimeout(timeout);controllers.delete(controller);}
  }
  async function poll(ex){
    if(stopped||pending.has(ex)||now()<(due.get(ex)||0))return pending.get(ex);
    const op=(async()=>{
      const started=now();
      try{
        if(VOLUME_URLS[ex]&&(!volumeAt.has(ex)||started-volumeAt.get(ex)>=60000)){
          const data=await json(VOLUME_URLS[ex]);
          if(stopped)return;
          if(!Array.isArray(data)||data.length>25000)throw new Error("Invalid spot volume list");
          volumes.set(ex,new Map(data.filter(r=>typeof r.symbol==="string"&&number(r.quoteVolume)>=0).map(r=>[r.symbol,Number(r.quoteVolume)])));
          volumeAt.set(ex,now());
        }
        const requestedAt=now(),data=await json(venues[ex].url);
        const next=normalizeSpotQuotes(ex,data,requestedAt,volumes.get(ex));
        if(stopped)return;
        const freshCount=[...next.values()].filter(q=>now()-q.at<=MAX_QUOTE_AGE_MS).length;
        quotes.set(ex,next);health.set(ex,{name:venues[ex].name,status:freshCount?'ok':next.size?'stale':'empty',updatedAt:requestedAt,markets:freshCount});
        due.set(ex,now()+Math.max(3000,pollMs));revision++;
      }catch(error){
        if(stopped)return;
        const previous=health.get(ex)||{name:venues[ex].name,updatedAt:0,markets:0};
        const limited=[403,418,429,503].includes(error.status);
        const delay=limited?Math.min(3600000,Math.max(30000,error.retryMs||60000)):Math.min(60000,5000*2**Math.min(4,previous.failures||0));
        due.set(ex,now()+delay);health.set(ex,{...previous,status:limited?"rate_limited":"error",failures:(previous.failures||0)+1,retryAt:due.get(ex)});revision++;
      }
    })().finally(()=>pending.delete(ex));pending.set(ex,op);return op;
  }
  function refresh(){
    if(stopped)return Promise.resolve();
    // Each venue advances independently: a slow exchange must not hold fresh
    // Binance/Bybit quotes behind a global batch. poll() shares in-flight work.
    return Promise.allSettled(Object.keys(venues).map(ex=>poll(ex)));
  }
  function getTickers(maxAgeMs=MAX_QUOTE_AGE_MS){
    const time=now(),rows=[];
    for(const map of quotes.values())for(const q of map.values())if(time-q.at<=maxAgeMs&&q.at<=time+1000)rows.push(q);
    return rows;
  }
  function snapshot(){
    const time=now();
    if(snapshotCache&&snapshotRevision===revision&&time-snapshotAt<250)return snapshotCache;
    const fresh=getTickers(),counts=new Map();for(const q of fresh)counts.set(q.ex,(counts.get(q.ex)||0)+1);
    snapshotCache={revision,generatedAt:time,quotes:fresh,sources:Object.fromEntries(Object.keys(venues).map(ex=>{
      const source=health.get(ex)||{name:venues[ex].name,status:'pending',markets:0,updatedAt:0};
      return [ex,{...source,markets:counts.get(ex)||0,status:source.status==='ok'&&!counts.get(ex)?'stale':source.status}];
    }))};
    snapshotAt=time;snapshotRevision=revision;return snapshotCache;
  }
  function start(){if(timer)return;stopped=false;void refresh();timer=setInterval(()=>void refresh(),1000);timer.unref?.();}
  function stop(){stopped=true;clearInterval(timer);timer=null;for(const controller of controllers)controller.abort();}
  return {start,stop,refresh,snapshot,getTickers};
}
module.exports={SPOT_VENUES,MAX_QUOTE_AGE_MS,normalizeSpotQuotes,spotTradeUrl,createSpotMarketData};
