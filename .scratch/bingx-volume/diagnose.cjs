// Read-only public-market probe. Run: node .scratch/bingx-volume/diagnose.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '../../node-server');
const WebSocket = createRequire(path.join(root, 'package.json'))('ws');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const context = vm.createContext({ normalizeTimestamp: Number });
vm.runInContext(server.slice(server.indexOf('function parseKlines('), server.indexOf('// Venues without a native three-day candle')), context);
const symbols = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'DOGE-USDT', 'ZIL-USDT', 'FIDA-USDT'];
const intervals = { '1m': 60000, '15m': 900000, '4h': 14400000 };
const captured = { capturedAt: new Date().toISOString(), rest: [], websocket: [] };
function stats(values) {
  const avg = values.reduce((a,b) => a+b, 0) / values.length;
  return { min: Math.min(...values), max: Math.max(...values),
    maxMin: +(Math.max(...values) / Math.min(...values)).toFixed(2),
    cvPercent: +(100 * Math.sqrt(values.reduce((s,v) => s + (v-avg)**2, 0) / values.length) / avg).toFixed(2) };
}
function checkHistogram(candles) {
  const heights = [];
  const ctx = vm.createContext({
    vis: candles, window: {}, indicatorsHeight: 0, PW: 1000, volumeHeight: 100,
    s: 0, viewStart: 0, candleW: 5, hw: 2, dpr: 1,
    getCanvasBgColor: () => 'black', hexToRgba: c => c,
    vCtx: { save(){},restore(){},beginPath(){},rect(){},clip(){},moveTo(){},lineTo(){},stroke(){},
      fillRect(x,y,w,h) { heights.push(h); } },
  });
  const start = app.indexOf('// Draw Volume (Clean Histogram');
  const end = app.indexOf('const timeYStart = volumeYStart + volumeHeight;', start);
  vm.runInContext(app.slice(start,end),ctx);
  const bars = heights.slice(1);
  const positive = candles.filter(c=>c.v>0);
  const max = Math.max(...positive.map(c=>c.v));
  if (bars.length !== positive.length) throw new Error('Missing histogram bars');
  const scale = bars[positive.findIndex(c=>c.v===max)] / max;
  for(let i=0;i<positive.length;i++) {
    if (Math.abs(bars[i] - positive[i].v * scale) > 1e-8)
      throw new Error('Histogram distorted source volumes');
  }
  return { proportional: true, minimumHeightBars: bars.filter(h=>h===1.5).length };
}
async function rest(symbol,interval) {
  const url = `https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${symbol}&interval=${interval}&limit=120`;
  const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
  const payload = await response.json();
  if (!response.ok || payload.code!==0 || !Array.isArray(payload.data)) throw new Error(`${symbol} ${interval}: ${payload.code}`);
  const closed = payload.data.filter(k=>+k.time + intervals[interval] <= Date.now());
  const parsed = context.parseKlines('BX',{data:closed});
  if (parsed.length!==closed.length) throw new Error('Parser dropped candles');
  for (const c of parsed) {
    const raw = closed.find(k=>+k.time===c.t);
    if (c.v !== +raw.volume * +raw.close) throw new Error('Parser changed source volume');
  }
  const result={symbol,interval,count:parsed.length,source:stats(closed.map(k=>+k.volume)), chart:stats(parsed.map(k=>k.v)),histogram:checkHistogram(parsed),payload};
  captured.rest.push(result);
  const {payload:_,...summary}=result;
  console.log(JSON.stringify(summary));
}
async function stream() {
  await new Promise(resolve=>{
    const ws=new WebSocket('wss://open-api-swap.bingx.com/swap-market');
    const timer=setTimeout(()=>{ws.terminate();resolve();},18000);
    ws.on('open',()=>symbols.forEach((symbol,i)=>ws.send(JSON.stringify({id:String(i),reqType:'sub',dataType:`${symbol}@kline_1m`}))));
    ws.on('message',raw=>{
      let txt;
      try {txt=zlib.gunzipSync(raw).toString();} catch {txt=raw.toString();}
      if (txt==='Ping') {captured.websocket.push({control:'Ping'});ws.send('Pong');return;}
      try {
        const d=JSON.parse(txt);
        if(d.ping) {ws.send(JSON.stringify({pong:d.ping}));return;}
        if(d.dataType?.includes('@kline') && d.data) captured.websocket.push(d);
      } catch {}
    });
    ws.on('error',e=>{captured.websocket.push({error:e.message});clearTimeout(timer);resolve();});
  });
  for(const symbol of symbols) {
    const messages=captured.websocket.filter(d=>d.dataType?.startsWith(symbol+'@'));
    console.log(JSON.stringify({stream:symbol,messages:messages.length,first:messages[0],last:messages.at(-1)}));
  }
  console.log(JSON.stringify({controls:captured.websocket.filter(d=>d.control||d.error)}));
}
(async()=>{
  if (process.argv.includes('--replay')) {
    const saved=JSON.parse(fs.readFileSync(path.join(__dirname,'capture.json'),'utf8'));
    let bars=0;
    for(const record of saved.rest) {
      const parsed=context.parseKlines('BX',record.payload).slice(0,record.count);
      checkHistogram(parsed);
      bars+=parsed.length;
    }
    console.log(`PASS: ${saved.rest.length} symbol/timeframe combinations, ${bars} closed candles preserve source volume proportions`);
    return;
  }
  const streamPromise=stream();
  const jobs=symbols.flatMap(s=>Object.keys(intervals).map(t=>[s,t]));
  const results=await Promise.allSettled(Array.from({length:3},async()=>{
    while(jobs.length) {const [s,t]=jobs.shift();await rest(s,t);}
  }));
  await streamPromise;
  for(const result of results) if(result.status==='rejected') console.error(result.reason);
  fs.writeFileSync(path.join(__dirname,'capture.json'),JSON.stringify(captured,null,2));
  if(results.some(r=>r.status==='rejected'))process.exitCode=1;
})();
