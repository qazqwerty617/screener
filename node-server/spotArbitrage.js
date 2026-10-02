"use strict";

const { SPOT_VENUES, MAX_QUOTE_AGE_MS, spotTradeUrl } = require('./spotMarketData');
const { canonicalNetwork } = require('./arbitrageTransferStatus');
const { fillQuantity } = require('./depthAnalyzer');

// Native asset identity is only established on its own chain. A BTC token on
// Ethereum/BSC still requires matching contracts on both exchange catalogues.
const NATIVE = Object.freeze({BTC:'BTC',ETH:'ETH',SOL:'SOL',TRX:'TRX',LTC:'LTC',BCH:'BCH',DOGE:'DOGE',
  XRP:'XRP',XLM:'XLM',ADA:'ADA',DOT:'DOT',ATOM:'ATOM',NEAR:'NEAR',SUI:'SUI',APT:'APT',TON:'TON',
  ETC:'ETC',ALGO:'ALGO',KSM:'KSM',ICP:'ICP',HBAR:'HBAR',XTZ:'XTZ'});
const amount=v=>v!==null&&v!==undefined&&String(v).trim()!==''&&Number.isFinite(Number(v))&&Number(v)>=0?Number(v):null;
function assetIdentity(base,a,b){
  const clean=value=>{const s=String(value||'').trim();return /^(?:-|null|none|n\/a|0x0{40})$/i.test(s)?'':s;};
  const left=clean(a.contractAddress),right=clean(b.contractAddress);
  if(left&&right){
    const evm=/^0x[0-9a-f]{40}$/i;
    const network=canonicalNetwork(a.network);
    const valid=value=>{
      if(['ETH','BSC','ARB','OP','BASE','POLYGON','AVAXC','FTM','LINEA','SCROLL','ZKSYNC','OPBNB','MANTLE','BLAST','CELO'].includes(network))return evm.test(value)&&!/^0x0{40}$/i.test(value);
      if(network==='SOL')return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
      if(network==='TRX')return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
      if(['APT','SUI'].includes(network))return /^0x[0-9a-f]{1,64}(?:::[a-z0-9_:]+)?$/i.test(value);
      if(network==='NEAR')return /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
      if(network==='TON')return /^(?:[EU]Q[a-z0-9_-]{46}|0:[0-9a-f]{64})$/i.test(value);
      if(network==='ATOM')return /^ibc\/[0-9a-f]{64}$/i.test(value);
      return false; // unsupported identity formats remain explicitly unverified
    };
    if(!valid(left)||!valid(right))return 'unverified';
    return (evm.test(left)&&evm.test(right)?left.toLowerCase()===right.toLowerCase():left===right)?'contract':'mismatch';
  }
  if(!left&&!right&&NATIVE[base]===canonicalNetwork(a.network))return 'native';
  return 'unverified';
}
function transferPaths(catalogs,base,buyEx,sellEx){
  const buy=catalogs.get(buyEx)?.get(base),sell=catalogs.get(sellEx)?.get(base);
  if(!buy?.length||!sell?.length)return {status:'unknown',paths:[]};
  const paths=[];let mismatch=false,unknown=false;
  for(const a of buy)for(const b of sell){
    if(canonicalNetwork(a.network)!==canonicalNetwork(b.network))continue;
    const identity=assetIdentity(base,a,b);
    if(identity==='mismatch'){mismatch=true;continue;}
    if(a.withdraw==null||b.deposit==null)unknown=true;
    if(a.withdraw!==true||b.deposit!==true)continue;
    paths.push({network:canonicalNetwork(a.network),identity,fee:amount(a.fee),variableFee:amount(a.variableFee),
      depositFee:amount(b.depositFee),minWithdraw:amount(a.minWithdraw),minDeposit:amount(b.minDeposit),
      step:amount(a.withdrawStep),precision:amount(a.withdrawPrecision),confirmations:amount(b.confirmations),
      needTag:b.needTag===true,contractAddress:a.contractAddress||b.contractAddress||null});
  }
  return {status:paths.length?'open':unknown?'unknown':mismatch?'mismatch':'closed',paths};
}
function feeFor(ex,override){
  if(override===null||override===undefined||override==='')return SPOT_VENUES[ex]?.feePct??null;
  const v=amount(override);if(v===null||v>5)throw new Error('Invalid trading fee');return v;
}
function validNotional(value=500){const n=Number(value);if(!Number.isFinite(n)||n<10||n>1e6)throw new Error('Invalid notional');return n;}
function fillBudget(asks,budget){
  let left=budget,quantity=0,value=0,levelsUsed=0;
  for(const [price,size] of asks){if(left<=budget*1e-10)break;const take=Math.min(size,left/price);quantity+=take;value+=take*price;left-=take*price;levelsUsed++;}
  return {quantity,value,avg:quantity?value/quantity:null,complete:left<=budget*1e-9,levelsUsed};
}
function calculateSpotFlow({asks,bids,notional=500,buyFeePct,sellFeePct,path=null,buyFeeAsset='base'}){
  notional=validNotional(notional);
  const bf=amount(buyFeePct),sf=amount(sellFeePct);
  if(bf===null||sf===null||bf>5||sf>5)throw new Error('Invalid trading fee');
  // Exchanges commonly charge spot BUY commission in the received base asset.
  // Quote commission is supported explicitly; budget always includes the fee.
  const budget=buyFeeAsset==='quote'?notional/(1+bf/100):notional;
  const buy=fillBudget(asks,budget),buyFeeBase=buyFeeAsset==='quote'?0:buy.quantity*bf/100;
  const buyFeeUsdt=buyFeeAsset==='quote'?buy.value*bf/100:buyFeeBase*(buy.avg||0);
  const acquired=buy.quantity-buyFeeBase,spent=buy.value+(buyFeeAsset==='quote'?buyFeeUsdt:0);
  const reasons=[];if(!buy.complete)reasons.push('buy_depth');
  if(!path)reasons.push('transfer_unknown');
  else{
    if(!['native','contract'].includes(path.identity))reasons.push('identity_unverified');
    if(path.fee===null||path.fee===undefined)reasons.push('withdraw_fee_unknown');
    if(path.variableFee>0)reasons.push('variable_fee');
    if(path.minWithdraw>acquired)reasons.push('withdraw_min');
  }
  let withdrawal=acquired,dust=0;
  const step=path?.step>0?path.step:Number.isInteger(path?.precision)&&path.precision>=0&&path.precision<=18?10**-path.precision:null;
  if(step){withdrawal=Math.floor(acquired/step+1e-8)*step;withdrawal=Math.min(acquired,withdrawal);dust=Math.max(0,acquired-withdrawal);}
  if(path?.minWithdraw>withdrawal&&!reasons.includes('withdraw_min'))reasons.push('withdraw_min');
  const withdrawFee=amount(path?.fee),depositFee=amount(path?.depositFee);
  const received=withdrawFee===null?null:Math.max(0,withdrawal-withdrawFee-(depositFee||0));
  if(withdrawFee!==null&&withdrawFee+(depositFee||0)>=withdrawal)reasons.push('withdraw_fee_exceeds');
  if(received!==null&&path?.minDeposit>received)reasons.push('deposit_min');
  const sell=fillQuantity(bids,received===null?acquired:received),sellFeeUsdt=sell.value*sf/100;
  if(!sell.complete)reasons.push('sell_depth');
  const proceeds=sell.value-sellFeeUsdt,unspent=Math.max(0,notional-spent);
  // Unsold base/dust is disclosed separately, never counted as realised USDT.
  const complete=reasons.length===0;
  return {notional,buyFeePct:bf,sellFeePct:sf,buyFeeAsset,bought:buy.quantity,buyAverage:buy.avg,buyCost:buy.value,
    buyFeeBase,buyFeeUsdt,acquired,withdrawal,withdrawFee,withdrawFeeUsdt:withdrawFee===null?null:withdrawFee*(buy.avg||0),
    dust,received,sold:received===null?null:sell.qty,sellAverage:received===null?null:sell.avg||null,
    sellGross:received===null?null:sell.value,sellFeeUsdt:received===null?null:sellFeeUsdt,
    proceeds:complete?proceeds:null,unspent,profitUsdt:complete?proceeds+unspent-notional:null,
    netPct:complete?(proceeds+unspent-notional)/notional*100:null,complete,reasons,
    preTransferNetPct:((fillQuantity(bids,acquired).value*(1-sf/100)+unspent)/notional-1)*100,
    assumptions:['model_trading_fees',...(depositFee===null?['no_deposit_fee_model']:[]),'current_prices_after_transfer','order_limits_unchecked'],
    buyComplete:buy.complete,sellComplete:sell.complete,buyLevels:buy.levelsUsed,sellLevels:sell.levelsUsed};
}
function bestPath(paths,args,network){
  const selected=network?paths.filter(p=>p.network===network):paths;
  const evaluated=selected.map(path=>({path,flow:calculateSpotFlow({...args,path})}));
  evaluated.sort((a,b)=>Number(b.flow.complete)-Number(a.flow.complete)||(b.flow.profitUsdt??-Infinity)-(a.flow.profitUsdt??-Infinity)||
    Number(['native','contract'].includes(b.path.identity))-Number(['native','contract'].includes(a.path.identity))||
    Number(a.path.fee===null)-Number(b.path.fee===null)||(a.path.fee??Infinity)-(b.path.fee??Infinity));
  return evaluated[0]||{path:null,flow:calculateSpotFlow({...args,path:null})};
}
function routeRow(row){
  const {buy,sell,base,key,gross,spreadSince,spreadSamples}=row;
  return {key,base,symbol:`${base}/USDT`,buyEx:buy.ex,sellEx:sell.ex,buyName:SPOT_VENUES[buy.ex].name,sellName:SPOT_VENUES[sell.ex].name,
    buySymbol:buy.symbol,sellSymbol:sell.symbol,buyAsk:buy.ask,sellBid:sell.bid,gross,liquidity:Math.min(buy.volume,sell.volume),
    buyAt:buy.at,sellAt:sell.at,buyUrl:spotTradeUrl(buy.ex,buy.symbol),sellUrl:spotTradeUrl(sell.ex,sell.symbol),spreadSince,spreadSamples};
}
// Bounded top-N heap: inspecting every pair does not retain thousands of full
// execution ledgers per user/filter. Unknown routes rank after verified ones.
function rankCompare(a,b){return a.rank[0]-b.rank[0]||a.rank[1]-b.rank[1];}
function heapPush(heap,item,limit){
  if(heap.length>=limit){if(rankCompare(item,heap[0])<=0)return;heap[0]=item;
    let i=0;while(true){let next=i,left=2*i+1,right=left+1;if(left<heap.length&&rankCompare(heap[left],heap[next])<0)next=left;
      if(right<heap.length&&rankCompare(heap[right],heap[next])<0)next=right;if(next===i)break;[heap[i],heap[next]]=[heap[next],heap[i]];i=next;}
  }else{heap.push(item);let i=heap.length-1;while(i>0){const parent=(i-1)>>1;if(rankCompare(heap[i],heap[parent])>=0)break;[heap[i],heap[parent]]=[heap[parent],heap[i]];i=parent;}}
}
function createSpotArbitrage(market,transfers,books,{now=Date.now,assetAllowed=()=>true}={}){
  const lives=new Map(),snapshots=new Map();let cached=null,builtAt=-Infinity,revision=-1,timer=null;
  function getMarkets(){
    const time=now(),snap=market.snapshot();
    if(cached&&time-builtAt<1000&&revision===snap.revision)return cached;
    const groups=new Map(),rows=[],seen=new Set();
    for(const q of snap.quotes){
      if(time-q.at>MAX_QUOTE_AGE_MS||q.at>time+1000||q.volume<5000||!assetAllowed(q.base,q))continue;
      if(!groups.has(q.base))groups.set(q.base,[]);groups.get(q.base).push(q);
    }
    for(const [base,quotes] of groups)for(let i=0;i<quotes.length;i++)for(let j=i+1;j<quotes.length;j++){
      const a=quotes[i],b=quotes[j];
      const [buy,sell]=b.bid>a.ask?[a,b]:[b,a];
      if(buy.ex===sell.ex||Math.abs(buy.at-sell.at)>10000)continue;
      const gross=(sell.bid/buy.ask-1)*100;if(gross<=0||gross>30)continue;
      const key=`spot:${base}:${buy.ex}:${sell.ex}`;seen.add(key);
      let life=lives.get(key);
      if(!life||time-life.lastObservedAt>MAX_QUOTE_AGE_MS)life=lives.has(key)||lives.size<50000?{since:time,samples:0,lastObservedAt:time,lastSampleAt:null}:null;
      const sampleAt=Math.min(buy.at,sell.at);
      if(life){if(life.lastSampleAt!==sampleAt){life.samples++;life.lastSampleAt=sampleAt;}
        life.lastObservedAt=time;lives.set(key,life);}
      rows.push({key,base,buy,sell,gross,spreadSince:life?.since??null,spreadSamples:life?.samples??0});
    }
    for(const key of lives.keys())if(!seen.has(key))lives.delete(key);
    while(lives.size>50000)lives.delete(lives.keys().next().value);
    cached={generatedAt:time,rows,sources:snap.sources,marketCount:groups.size};builtAt=time;revision=snap.revision;return cached;
  }
  function snapshot(options={}){
    const notional=validNotional(options.notional??500),time=now(),full=getMarkets(),catalogs=transfers.getCatalogSnapshot();
    const cacheKey=JSON.stringify(options),metadataVersion=Object.values(catalogs.sources).map(s=>`${s.checkedAt}:${s.status}:${s.stale}`).join('|');
    const saved=snapshots.get(cacheKey);
    if(saved&&saved.full===full&&saved.metadataVersion===metadataVersion&&time-saved.at<500)return saved.value;
    const selected=new Set(options.exchanges||[]),search=String(options.search||'').toUpperCase();
    const heap=[],limit=Math.min(1000,Math.max(1,Math.floor(options.limit||400)));let total=0;
    for(const row of full.rows){
      if(time-Math.min(row.buy.at,row.sell.at)>MAX_QUOTE_AGE_MS)continue;
      if(selected.size&&(!selected.has(row.buy.ex)||!selected.has(row.sell.ex))||search&&!row.base.includes(search)||Math.min(row.buy.volume,row.sell.volume)<(options.minVolume||0))continue;
      const buyFeePct=feeFor(row.buy.ex,options.buyFeePct),sellFeePct=feeFor(row.sell.ex,options.sellFeePct);
      const upperNet=(row.sell.bid/row.buy.ask*(1-buyFeePct/100)*(1-sellFeePct/100)-1)*100;
      if(upperNet<(options.minNet??0))continue;
      const transfer=transferPaths(catalogs.catalogs,row.base,row.buy.ex,row.sell.ex);
      if(transfer.status==='mismatch')continue;
      // Without any network the ranking is known from fees and BBO alone.
      // Build a detailed ledger only for candidates that survive pagination.
      const args={asks:[[row.buy.ask,Infinity]],bids:[[row.sell.bid,Infinity]],notional,buyFeePct,sellFeePct};
      const evaluated=transfer.paths.length?bestPath(transfer.paths,args):null;
      const net=evaluated?.flow.netPct??evaluated?.flow.preTransferNetPct??upperNet;
      if(net<(options.minNet??0))continue;total++;
      const rank=[evaluated?.flow.complete?1:0,net];
      if(heap.length>=limit&&rankCompare({rank},heap[0])<=0)continue;
      heapPush(heap,{row,args,transfer,evaluated,rank},limit);
    }
    const rows=heap.sort((a,b)=>rankCompare(b,a)).map(item=>{
      const {row,transfer,args}=item,{path,flow}=item.evaluated||bestPath([],args);
      return {...routeRow(row),ageMs:Math.max(time-row.buy.at,time-row.sell.at),
        transferStatus:transfer.status,path,flow,networkCount:transfer.paths.length,estimate:'bbo',
        spreadAgeMs:row.spreadSince===null?null:Math.max(0,time-row.spreadSince)};
    });
    const value={generatedAt:full.generatedAt,notional,total,rows,
      sources:full.sources,transferSources:catalogs.sources,marketCount:full.marketCount,
      exchangeCount:Object.values(full.sources).filter(s=>s.status==='ok').length,venues:SPOT_VENUES};
    snapshots.set(cacheKey,{value,full,metadataVersion,at:time});while(snapshots.size>32)snapshots.delete(snapshots.keys().next().value);
    return value;
  }
  async function quote(key,options={},overlays=new Map()){
    validNotional(options.notional??500);
    let raw=getMarkets().rows.find(r=>r.key===key);if(!raw)throw new Error('Route no longer available');
    let row=routeRow(raw);
    const [buy,sell]=await Promise.all([books.get(row.buyEx,row.buySymbol),books.get(row.sellEx,row.sellSymbol)]);
    const time=now();raw=getMarkets().rows.find(r=>r.key===key);row=raw?routeRow(raw):null;
    if(!row||time-Math.min(row.buyAt,row.sellAt)>MAX_QUOTE_AGE_MS||time-buy.at>5000||time-sell.at>5000||Math.abs(buy.at-sell.at)>5000)throw new Error('Stale spot quotes');
    const metadata=transfers.getCatalogSnapshot(),catalogs=new Map([...metadata.catalogs,...overlays]);
    const transfer=transferPaths(catalogs,row.base,row.buyEx,row.sellEx);
    const args={asks:buy.asks,bids:sell.bids,notional:options.notional??500,
      buyFeePct:feeFor(row.buyEx,options.buyFeePct),sellFeePct:feeFor(row.sellEx,options.sellFeePct)};
    const {path,flow}=bestPath(transfer.paths,args,options.network);
    return {...row,generatedAt:time,buyAsk:buy.asks[0][0],sellBid:sell.bids[0][0],
      gross:(sell.bids[0][0]/buy.asks[0][0]-1)*100,spreadAgeMs:row.spreadSince===null?null:Math.max(0,time-row.spreadSince),
      ageMs:Math.max(time-buy.at,time-sell.at),transferStatus:transfer.status,paths:transfer.paths,path,flow,estimate:'depth',
      booksAt:{buy:buy.at,sell:sell.at},transferSources:metadata.sources};
  }
  function start(){if(timer)return;getMarkets();timer=setInterval(getMarkets,1000);timer.unref?.();}
  function stop(){clearInterval(timer);timer=null;}
  return {snapshot,quote,getMarkets,start,stop};
}
module.exports={assetIdentity,transferPaths,calculateSpotFlow,bestPath,feeFor,validNotional,createSpotArbitrage};
