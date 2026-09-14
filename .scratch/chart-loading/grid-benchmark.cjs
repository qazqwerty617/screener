"use strict";
// Public, read-only HTTP test through the production reverse proxy.
const symbols=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','AVAXUSDT','LTCUSDT','BCHUSDT','DOTUSDT','TRXUSDT'];
(async()=>{
  for(const pass of [1,2]) {
    const start=Date.now();
    const res=await fetch('http://169.58.138.33/api/klines/batch?'+new URLSearchParams({ex:'BN',symbols:symbols.join(','),tf:'5m',lite:'1',stream:'1'}),{signal:AbortSignal.timeout(20000)});
    if(!res.ok || !res.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('Streaming response unavailable: '+res.status);
    const decoder=new TextDecoder(),rows=[];let buffer='';
    const consume=line=>{if(!line.trim())return;const row=JSON.parse(line);const count=Array.isArray(row.data)?row.data.length/6:0;rows.push({sym:row.sym,count,ms:Date.now()-start});if(!count)process.exitCode=1;};
    for await(const chunk of res.body) {
      buffer+=decoder.decode(chunk,{stream:true});const lines=buffer.split('\n');buffer=lines.pop();lines.forEach(consume);
    }
    buffer+=decoder.decode();consume(buffer);
    console.log(JSON.stringify({pass,rows:rows.length,firstMs:rows[0]?.ms,totalMs:Date.now()-start,results:rows}));
    if(rows.length!==symbols.length)process.exitCode=1;
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
