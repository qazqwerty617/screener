const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const block = name => new RegExp(`function ${name}\\([^]*?\\n\\}`).exec(source)[0];

function tooltip(candles) {
  const start=source.indexOf('    const visIdx =',source.indexOf('// compute average volume'));
  const end=source.indexOf('      // Draw fixed volume box',start);
  assert.ok(start>0&&end>start);
  const ctx={candles,vis:candles,mX:0,candleW:1,futureGap:0,clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),formationDetectionCache:new WeakMap()};
  vm.createContext(ctx);
  if(source.includes('function getAverageCandleVolume(')) vm.runInContext(block('getAverageCandleVolume'),ctx);
  vm.runInContext(block('clearCandleCaches'),ctx);
  const frame=vm.runInContext('(function(){'+source.slice(start,end)+'return {average:avgV,mult};\n}})',ctx);
  return {ctx,frame};
}

test('volume tooltip uses the current live volume instead of a permanently stale average', () => {
  const candles=[{t:1,v:10},{t:2,v:20},{t:3,v:30}],h=tooltip(candles);
  assert.equal(h.frame().average,20);
  candles[2].v=90;h.ctx.clearCandleCaches(candles,true);
  assert.equal(h.frame().average,40);
  candles[0].v=40;h.ctx.clearCandleCaches(candles);
  assert.equal(h.frame().average,50);
});

test('zero-volume history has a finite tooltip multiplier', () => {
  const h=tooltip([{t:1,v:0},{t:2,v:0}]);assert.equal(h.frame().mult,'0.0');
});

test('live volume updates on 20000 bars reuse closed volume work', () => {
  let reads=0;
  const candles=Array.from({length:20000},(_,i)=>({t:i+1,get v(){reads++;return 10;}}));
  const h=tooltip(candles);assert.equal(h.frame().average,10);
  const first=reads;for(let i=0;i<100;i++){h.ctx.clearCandleCaches(candles,true);assert.equal(h.frame().average,10);}
  assert.ok(reads-first<=300,`live updates reread ${reads-first} volume values`);
  candles.push({t:20001,v:30});assert.equal(h.frame().average,(20000*10+30)/20001);
  candles.shift();assert.equal(h.frame().average,(19999*10+30)/20000);
});
