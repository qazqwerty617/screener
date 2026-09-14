// Local fixture server: real application assets, synthetic market data, no outbound services.
const express = require('../../node-server/node_modules/express');
const { WebSocketServer } = require('../../node-server/node_modules/ws');
const fs = require('fs');
const path = require('path');
const app = express();
const root = path.resolve(__dirname, '../../node-server/public');
const user = { id: 'formation-preview', username: 'Preview', plan: 'pro', preferences: {} };
const markets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const prices = [60000, 2400, 140, 520];
let hits = { snapshots: 0, candles: 0 };
app.use(express.json());
app.get('/', (req, res) => res.type('html').send(fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('</head>', '<script>localStorage.setItem("obsidian_auth_token", "local-preview");</script></head>')));
app.get('/api/auth/me', (req,res) => res.json({ success: true, user }));
app.get('/api/formations/snapshot', (req,res) => {
  hits.snapshots++;
  const maps = { cascades: {}, levels: {}, trendline: {}, retest: {}, approaching: {} };
  markets.forEach((sym, i) => {
    const levels = [1.003, 1.008, 1.012].map((factor, n) => ({ price: prices[i] * factor, direction: 'up', touches: 3, swingIdx: 50 + n * 10 }));
    maps.cascades['BN:' + sym] = levels;
    maps.levels['BN:' + sym] = levels;
  });
  res.json({ tf: req.query.tf, maps, updatedAt: Date.now(), scanned: 4, coverage: 'all-assets' });
});
function candles(sym, tf) {
  const p = prices[Math.max(0, markets.indexOf(sym))];
  const seconds = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '3d': 259200, '1w': 604800 }[tf] || 900;
  const end = Math.floor(Date.now()/1000/seconds)*seconds;
  return Array.from({length:300}, (_,i) => {
    const c = p * (1 + Math.sin(i/8)*0.008), o = p * (1 + Math.sin((i-1)/8)*0.008);
    return { t: end-(299-i)*seconds, o, h: Math.max(o,c)*1.001, l: Math.min(o,c)*0.999, c, v: 100+i%20 };
  });
}
app.get('/api/klines', (req,res) => { hits.candles++; res.json(candles(req.query.sym, req.query.tf)); });
app.get('/api/klines/batch', (req,res) => res.type('application/x-ndjson').send(String(req.query.symbols).split(',').map(sym => JSON.stringify({ sym, candles: candles(sym, req.query.tf) })).join('\n') + '\n'));
let caseId=0;
app.get('/api/backtest/new', (req,res)=> { hits.backtests=(hits.backtests||0)+1; const rows=candles('BTCUSDT',req.query.tf).map(c=>[c.t*1000,c.o,c.h,c.l,c.c,c.v]); res.json({id:String(++caseId),sym:'BTCUSDT',exchange:'Bybit',tf:req.query.tf,candles:rows.slice(0,200),cutoffTime:rows[199][0],futureCount:90,universeSize:80}); });
app.post('/api/backtest/:id/step',(req,res)=>res.json({candles:[],done:false}));
app.post('/api/backtest/:id/reveal',(req,res)=>res.json({candles:[],done:true}));
app.get('/__metrics', (req,res) => res.json(hits));
app.use('/api', (req,res) => res.json({ success: true, settings: null, preferences: {}, data: [], walls: [] }));
app.use(express.static(root));
const server = app.listen(3198, '127.0.0.1', () => console.log('Formation fixture: http://127.0.0.1:3198'));
const ws = new WebSocketServer({ server });
ws.on('connection', client => {
  const flat = markets.flatMap((sym,i) => ['BN:'+sym, prices[i], 2+i, 1e9/(i+1), prices[i]*1.03, prices[i]*.97, prices[i]*.99, .01, Date.now()+3600000, 1e8, 100000]);
  client.send(JSON.stringify({ type:'snapshot', data:flat }));
});

