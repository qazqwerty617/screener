// Controlled network timings, actual grid loader. Not a production latency SLA.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'../..');
const current = fs.readFileSync(path.join(root,'node-server/public/js/app.js'),'utf8');
const baseline = execFileSync('git',['show','HEAD:node-server/public/js/app.js'],{cwd:root,encoding:'utf8',maxBuffer:4000000});
const names = ['decodeKlinePayload','consumeGridRequest','fetchGridKlines','flushGridKlines'];
function functions(source) {
  return names.map(name=>new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(source)[0]).join('\n');
}
async function run(source,markets,serverDelay) {
  let directCalls=0,serverCalls=0;
  const bar={t:1789924800000,o:1,h:2,l:1,c:2,v:100};
  const ctx=vm.createContext({Map,AbortController,TextDecoder,setTimeout,clearTimeout,
    GRID_KLINE_QUEUE:new Map(),KLINE_REQUESTS:new Map(),sanitizeCandles:x=>x,
    fetchChartKlines:async()=>[],
    fetchDirectKlines:async(ex,sym,tf,signal)=>{
      directCalls++;
      return new Promise(resolve=>{
        const timer=setTimeout(()=>resolve([bar]),120);
        signal.addEventListener('abort',()=>{clearTimeout(timer);resolve([])},{once:true});
      });
    },
    fetch:async(url,{signal})=>{
      serverCalls++;
      const symbols=new URL(url,'http://test').searchParams.get('symbols').split(',');
      return new Response(new ReadableStream({start(controller){
        const timer=setTimeout(()=>{
          controller.enqueue(new TextEncoder().encode(symbols.map(sym=>JSON.stringify({sym,data:[bar]})).join('\n')+'\n'));
          controller.close();
        },serverDelay);
        signal.addEventListener('abort',()=>{
          clearTimeout(timer);
          try {controller.error(new Error('aborted'));} catch {}
        },{once:true});
      }}));
    },
  });
  vm.runInContext(functions(source),ctx);
  const start=performance.now(),painted=[];
  await Promise.all(markets.map(([ex,sym])=>ctx.fetchGridKlines(ex,sym,'1m').then(data=>{
    if(!data.length)throw new Error('History lost');painted.push(performance.now()-start);
  })));
  return {firstMs:Math.round(Math.min(...painted)),allMs:Math.round(Math.max(...painted)),serverCalls,directCalls};
}
(async()=>{
  const mixed=['BN','OX','BG','MX','GT','KC','BX','AD','AD'].map((ex,i)=>[ex,'COIN'+i]);
  const same=Array.from({length:12},(_,i)=>['BN','COIN'+i]);
  const results=[];
  for(const [scenario,markets,delay] of [['9 mixed exchanges / slow stream',mixed,1500],['12 same exchange / slow stream',same,1500],['9 mixed exchanges / warm cache',mixed,20]]) {
    const before=await run(baseline,markets,delay),after=await run(current,markets,delay);
    results.push({scenario,before,after});
  }
  fs.writeFileSync(path.join(__dirname,'benchmark-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
