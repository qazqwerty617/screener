'use strict';
// Public, read-only smoke check of the production historical route. No server boot,
// accounts, credentials, subscriptions or production writes are involved.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHistoryPageStore,parseHistoryResponse}=require('../historyPages');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const block=name=>source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];
const c=vm.createContext({console,historicalPages:createHistoryPageStore(),parseHistoryResponse,
  normalizeTimestamp:value=>Number(value)<1e11?Number(value)*1000:Number(value),setPublicCors(){},
  apiFetch:async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}});
const tfStart=source.indexOf('const TF_MAP =');
vm.runInContext(source.slice(tfStart,source.indexOf('function getTfMs',tfStart)),c);
for(const name of ['getTfMs','normalizeExchangeSymbol','getKlinesUrl','parseKlines','syntheticSourceTf'])vm.runInContext(block(name),c);
const start=source.indexOf('  let { ex = "BN", sym = "BTCUSDT", tf = "4h", lite = "0", before }');
const route=vm.runInContext('(async(req,res)=>{'+source.slice(start,source.indexOf('  const useLite =',start))+'})',c);
const before=Date.now()-40*86400000;
Promise.all(['BN','BB','OX','BG','KC','HT'].map(async ex=>{
  const start=performance.now();
  const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
  const request={query:{ex,sym:'BTCUSDT',tf:'1m',before:String(before)}};
  await route(request,res);
  const rows=Array.isArray(res.data)?res.data:[];
  const coldMs=Math.round(performance.now()-start),cachedStart=performance.now();
  const warm={...res};await route(request,warm);
  const cachedMs=+(performance.now()-cachedStart).toFixed(2);
  if(res.code!==200||!rows.length||rows.at(-1).t>=before)process.exitCode=1;
  console.log(JSON.stringify({ex,status:res.code,candles:rows.length,earliest:rows[0]?.t,latest:rows.at(-1)?.t,coldMs,cachedMs}));
})).catch(err=>{console.error(err.message);process.exitCode=1});
