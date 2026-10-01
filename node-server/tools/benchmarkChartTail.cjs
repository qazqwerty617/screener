'use strict';
// Deterministic CPU microbenchmark; excludes end-to-end and laptop measurements.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const functions=['calcEMA','calcBB','calcRSI','calcATR','calcMACD','calcVWAP','calcCVD','calcVolumeSMA'];
const current=fs.readFileSync(path.join(__dirname,'../public/js/app.js'),'utf8');
const baseline=execFileSync('git',['show',`${process.argv[2]||'HEAD'}:node-server/public/js/app.js`],{cwd:path.join(__dirname,'../..'),encoding:'utf8'});
function run(source,count) {
  const c=vm.createContext({});
  vm.runInContext(functions.map(name=>source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n'),c);
  const data=Array.from({length:count},(_,i)=>({t:1700000000000+i*60000,o:100,h:102,l:98,c:100+Math.sin(i),v:1000+i}));
  for(const name of functions)c[name](data);
  const start=performance.now();
  for(let i=0;i<200;i++) {
    Object.assign(data.at(-1),{c:100+Math.sin(i),h:103+i/100,l:97-i/100,v:2000+i});
    for(const name of functions)c[name](data);
  }
  return performance.now()-start;
}
for(const count of [4000,20000]) {
  const beforeMs=run(baseline,count),afterMs=run(current,count);
  console.log(JSON.stringify({candles:count,liveUpdates:200,indicators:functions.length,beforeMs:+beforeMs.toFixed(2),afterMs:+afterMs.toFixed(2),ratio:+(beforeMs/afterMs).toFixed(1)}));
}
