"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
function fixture(activeTf='1m') {
  const ctx=vm.createContext({activeTf,TF_MS:{'1m':60000,'5m':300000,'3d':259200000},sanitizeCandle:c=>c,cleanPhantomWicksAndCandles:c=>c});
  vm.runInContext(source.slice(source.indexOf('function sanitizeCandles('),source.indexOf('let currentLoadedEx')),ctx);
  return ctx;
}
const bar=t=>({t,o:100,h:102,l:99,c:101,v:10});
test('three-day history is not deleted based on an unrelated active one-minute chart',()=>{
  const bars=[0,1,2,3].map(i=>bar(1700000000000+i*259200000));
  assert.equal(fixture().sanitizeCandles(bars).length,4);
});
test('missing history does not become invented zero-volume exchange candles',()=>{
  const bars=[0,1,2,5,6,7].map(i=>bar(1700000000000+i*60000));
  assert.deepEqual(Array.from(fixture().sanitizeCandles(bars),c=>c.t),bars.map(c=>c.t));
});

test('merging older history preserves the newer non-overlapping history',()=>{
  const ctx=fixture();
  vm.runInContext(source.slice(source.indexOf('function mergeCandles('),source.indexOf('async function refetchMissingHistory(')),ctx);
  const older=[0,1,2].map(i=>bar(1700000000000+i*259200000));
  const newer=[3,4,5].map(i=>bar(1700000000000+i*259200000));
  assert.equal(ctx.mergeCandles(newer,older).length,6);
});

test('real isolated wick and volatile candle prices survive history decoding',()=>{
  const ctx=fixture();
  vm.runInContext(source.slice(source.indexOf('function cleanPhantomWicksAndCandles('),source.indexOf('function sanitizeCandles(')),ctx);
  const bars=[0,1,2,3,4].map(i=>bar(1700000000000+i*60000));
  bars[2].h=180; bars[2].l=60;
  const decoded=ctx.sanitizeCandles(bars);
  assert.equal(decoded[2].h,180); assert.equal(decoded[2].l,60);
});

for (const grid of [false,true]) test(`${grid?'grid':'single'} late closed-candle update never truncates newer candles`,()=>{
  const bars=[0,1,2,3,4,5].map(i=>bar(1700000000000+i*60000));
  const ctx=vm.createContext({candles:bars,activeTf:'1m',activeEx:'BN',activeSym:'BTCUSDT',TF_MS:{'1m':60000},sanitizeCandle:c=>c,
    isLoadingKlines:false,lastMarketEventAt:0,clearCandleCaches:()=>{},updateOHLC:()=>{},checkPriceAlerts:()=>{},fP:String});
  if(grid) {
    vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(source)[0]+';this.Chart=ChartInstance;',ctx);
    const cell={candles:bars,tf:'1m',headerPrice:{},refreshFormationLevels:()=>{},draw:()=>{}};
    ctx.Chart.prototype.applyOfficialKline.call(cell,[bars[2].t,100,103,98,102,11]);
  } else {
    vm.runInContext(source.slice(source.indexOf('function appendCandle('),source.indexOf('let lastAppliedTradeTime')),ctx);
    ctx.appendCandle({...bars[2],c:102,h:103});
  }
  assert.equal(bars.length,6); assert.equal(bars.at(-1).t,1700000300000);
});
