'use strict';
const {performance} = require('node:perf_hooks');
const path = require('node:path');
const engine = require(process.argv[2] ? path.resolve(process.argv[2]) : '../public/js/formationEngine');
let seed = 617;
const random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
function candles(n,noisy) {
  let price=100;
  return Array.from({length:n},(_,i)=>{
    const o=price;
    price=noisy?Math.max(10,price+(random()-.5)*.8):100+10*Math.cos(i*Math.PI/50);
    return {t:1700000000000+i*60000,o,c:price,h:Math.max(o,price)+.1,l:Math.min(o,price)-.1,v:100};
  });
}
for (const [scenario,data] of [['400 bars',candles(400,true)],['20000 bars',candles(20000,false)]]) {
  for(let i=0;i<20;i++) engine.scanAll(data,2);
  const times=[]; let results;
  for(let i=0;i<51;i++) { const start=performance.now();results=engine.scanAll(data,2);times.push(performance.now()-start); }
  times.sort((a,b)=>a-b);
  console.log(JSON.stringify({scenario,medianMs:+times[25].toFixed(3),p95Ms:+times[48].toFixed(3),
    results:Object.fromEntries(Object.entries(results).map(([type,rows])=>[type,rows.length]))}));
}
