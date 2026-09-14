const { performance } = require('perf_hooks');
const engine = require('../../node-server/public/js/formationEngine');
const detector = require('../../node-server/patternDetector');
const candles = Array.from({length: 600}, (_, i) => {
  const o = 100 + Math.sin(i / 13) * 3 + i / 600;
  const c = o + Math.sin(i * 0.7) * 0.3;
  return { t: 1700000000000 + i * 900000, o, c, h: Math.max(o, c) + 0.4, l: Math.min(o, c) - 0.4, v: 1000 + i % 50 };
});
const meta = { ex:'BN', sym:'TESTUSDT', base:'TEST', tf:'15m' };
function run(reuse) {
  for (let i = 0; i < 20; i++) detector.scanCandles(meta, candles, {}, engine.scanAll(candles, 1));
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    const formations = engine.scanAll(candles, 1);
    detector.scanCandles(meta, candles, {}, reuse ? formations : undefined);
  }
  return (performance.now() - start) / 200;
}
const repeatedMs = run(false), reusedMs = run(true);
console.log(JSON.stringify({ candleCount: candles.length, iterations: 200, repeatedMs, reusedMs, reductionPct: (1-reusedMs/repeatedMs)*100 }, null, 2));
