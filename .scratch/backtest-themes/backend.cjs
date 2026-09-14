const fs = require('fs');
const file = 'node-server/server.js';
let s = fs.readFileSync(file,'utf8');
const start = s.indexOf('function scoreBacktestCandidate('), end = s.indexOf('function publicBacktestCandle(',start);
s = s.slice(0,start) + `function scoreBacktestCandidate(candles, cut, visibleBars, futureBars, tf) {
  if (cut < visibleBars || candles.length < cut + futureBars) return 0;
  const visible = candles.slice(cut - visibleBars, cut);
  const recent = visible.slice(-40);
  const last = recent.at(-1)?.c;
  if (!(last > 0)) return 0;
  const minMove = { '1m': .0004, '5m': .0008, '15m': .0012, '30m': .0015, '1h': .002, '4h': .003, '1d': .005 }[tf] || .0008;
  const moves = [], ranges = [];
  for (let i = 1; i < recent.length; i++) {
    const c = recent[i], previous = recent[i-1].c;
    if (!(c.h >= Math.max(c.o,c.c)) || !(c.l <= Math.min(c.o,c.c)) || !(c.l > 0)) return 0;
    moves.push(Math.max(Math.abs(c.c-c.o), Math.abs(c.c-previous)) / previous);
    ranges.push((c.h-c.l)/previous);
  }
  const active = moves.filter(move => move >= minMove).length;
  const medianRange = ranges.sort((a,b)=>a-b)[Math.floor(ranges.length/2)];
  const path = moves.reduce((sum, move) => sum + move, 0);
  // Activity must be sustained near the decision point, not one old impulse/wick.
  if (active < 14 || medianRange < minMove || path < minMove * 24) return 0;
  const range = (Math.max(...recent.map(c=>c.h)) - Math.min(...recent.map(c=>c.l))) / last;
  if (range < minMove * 8) return 0;
  // Rank using revealed history only: future bars do not select a favourable outcome.
  return active + medianRange * 3000 + Math.min(path, .6) * 100 + Math.min(range,.4) * 100;
}

function findBestBacktestWindow(candles, tf) {
  if (!candles || candles.length < 260) return null;
  const visibleBars = Math.min(200, Math.max(150, Math.floor(candles.length * .45)));
  const futureBars = Math.min(90, Math.max(50, Math.floor(candles.length * .18)));
  const maxCut = candles.length - futureBars;
  const stride = Math.max(1, Math.floor((maxCut - visibleBars) / 90));
  const candidates = [];
  for (let cut = visibleBars; cut <= maxCut; cut += stride) {
    const score = scoreBacktestCandidate(candles, cut, visibleBars, futureBars, tf);
    if (score > 0) candidates.push({cut, score});
  }
  if (!candidates.length) return null;
  candidates.sort((a,b)=>b.score-a.score);
  const best = candidates[Math.floor(Math.random() * Math.min(8,candidates.length))];
  return { ...best, visible: candles.slice(best.cut-visibleBars,best.cut), future: candles.slice(best.cut,best.cut+futureBars) };
}

const backtestPool = require('./backtestPool').createBacktestPool({
  getUniverse: getBacktestUniverse, loadCandles: fetchBacktestCandles, selectWindow: findBestBacktestWindow
});

` + s.slice(end);
const a = s.indexOf('    // Pick from the top active liquid coins',s.indexOf('app.get("/api/backtest/new"'));
const b = s.indexOf('        const id = randomUUID();',a);
s = s.slice(0,a) + `    const { ticker, best } = await backtestPool.take(exchange, tf);
    if (res.destroyed) return;
    while (backtestSessions.size >= 300) backtestSessions.delete(backtestSessions.keys().next().value);
` + s.slice(b);
const c = s.indexOf('      }\n    }\n\n    res.status(503).json({ error: lastError',a);
const d = s.indexOf('  } catch (err) {',c);
if(c<0 || d<0) throw Error('route end');
s = s.slice(0,c)+s.slice(d);
s = s.replace('if (!res.headersSent) res.status(503).json({ error: "Не удалось создать сессию бэктеста" });','if (!res.headersSent) res.status(503).json({ error: err.message || "Не удалось создать сессию бэктеста" });');
fs.writeFileSync(file,s);
