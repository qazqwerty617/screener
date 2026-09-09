"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8'),server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const block=(s,n)=>new RegExp(`(?:async )?function ${n}\\([^]*?\\n\\}`).exec(s)[0];
const start=1788800040000,bar=()=>({t:start,o:100,h:102,l:99,c:101,v:10});
test('grid trade in the next interval leaves the closed candle unchanged',()=>{
  const ctx=vm.createContext({TF_MS:{'1m':60000},fP:String,clearCandleCaches:data=>{delete data._cache}});
  vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(app)[0]+';this.Chart=ChartInstance',ctx);
  const closed=bar(),cell={candles:[closed],tf:'1m',headerPrice:{},draw(){},refreshFormationLevels(){}};
  ctx.Chart.prototype.applyOfficialTick.call(cell,[start+65000,105,105,105]);
  assert.deepEqual(closed,bar());assert.equal(cell.candles.length,2);assert.equal(cell.candles[1].t,start+60000);
  ctx.Chart.prototype.applyOfficialTick.call(cell,[start+64000,104,104,104]);
  assert.equal(cell.candles[1].c,105,'delayed tick cannot rewind the current close');
});
test('server MEXC tick after the cached candle interval does not repaint that old bar',()=>{
  const published=[],ctx=vm.createContext({normalizeTimestamp:t=>t,cacheKey:()=> 'key',getTfMs:()=>60000,klinesCache:new Map([['key',{data:[start,100,102,99,101,10]}]]),broadcastKline:(...args)=>published.push(args)});
  vm.runInContext(block(server,'updateLiveTradeTick'),ctx);
  ctx.updateLiveTradeTick('MX','SOPH_USDT','1m',start+65000,105,1);
  assert.equal(published.length,0,'do not label the new price with the historical timestamp');
});
test('single chart ignores a trade from before the current candle',()=>{
  const current=bar(),ctx=vm.createContext({candles:[current],TF_MS:{'1m':60000},activeTf:'1m',activeEx:'BN',activeSym:'BTCUSDT',isLoadingKlines:false,
    coins:new Map(),lastAppliedTradeTime:0,lastMarketEventAt:0,klWs:null,updateOHLC(){},checkPriceAlerts(){},performance:{now:()=>0},lastLatencyPaintAt:0});
  vm.runInContext(block(app,'applyMainMarketTick'),ctx);
  ctx.applyMainMarketTick([start-1000,105,105,105]);
  assert.deepEqual(current,bar());
});
