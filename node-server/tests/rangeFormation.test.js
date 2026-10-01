const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../public/js/formationEngine');
const serverLevels = require('../serverLevels');
const { scanCandles } = require('../patternDetector');

function waves({ count = 180, scale = 1, drift = 0, period = 32 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const c = (0.9 + 0.1 * Math.cos(i * Math.PI * 2 / period) + drift * i) * scale;
    const o = (0.9 + 0.1 * Math.cos((i - 1) * Math.PI * 2 / period) + drift * (i - 1)) * scale;
    return { t: 1700000000000 + i * 900000, o, c, h: Math.max(o, c) + 0.001 * scale,
      l: Math.min(o, c) - 0.001 * scale, v: 100 };
  });
}

test('Range detects repeated alternating support/resistance visits without mutating candles', () => {
  const candles = waves();
  const before = JSON.stringify(candles);
  const [box] = engine.detectRanges(candles);
  assert.ok(box);
  assert.equal(box.upper, 1.001);
  assert.equal(box.lower, 0.799);
  assert.ok(box.upperTouches >= 4 && box.lowerTouches >= 4);
  assert.equal(box.touches, Math.min(box.upperTouches, box.lowerTouches));
  assert.ok(box.touchIndices.every((i, n, all) => n === 0 || i > all[n - 1]));
  assert.equal(JSON.stringify(candles), before);
});

test('Range minimum is required independently on BOTH boundaries', () => {
  const candles = waves({ count: 90 });
  assert.equal(engine.detectRanges(candles, 2).length, 1);
  assert.equal(engine.detectRanges(candles, 3).length, 0);
  assert.ok(engine.detectRanges(candles, 1)[0].touches >= 2);
});

test('Range rejects a rising channel', () => {
  assert.deepEqual(engine.detectRanges(waves({ drift: 0.0007 })), []);
});

for (const boundary of ['upper', 'lower']) test(`Range invalidates a live ${boundary} breakout immediately`, () => {
  const candles = waves();
  const last = candles[candles.length - 1];
  last.c = boundary === 'upper' ? 1.04 : 0.76;
  last.h = Math.max(last.o, last.c) + 0.001;
  last.l = Math.min(last.o, last.c) - 0.001;
  assert.deepEqual(engine.detectRanges(candles), []);
});

test('A major wick outside the box is not silently ignored', () => {
  const candles = waves();
  candles[candles.length - 6].h = 1.2;
  assert.deepEqual(engine.detectRanges(candles), []);
});

test('Range preserves tiny token prices without rounding bounds to zero', () => {
  const [box] = engine.detectRanges(waves({ scale: 1e-9 }));
  assert.ok(box && box.lower > 0 && box.upper > box.lower);
  assert.ok(Math.abs(box.widthPct - 22.44444444444444) < 1e-8);
});

test('Flat candles and insufficient history cannot create a range', () => {
  assert.deepEqual(engine.detectRanges(waves({ count: 20 })), []);
  assert.deepEqual(engine.detectRanges(waves().map(c => ({ ...c, o: 1, c: 1, h: 1, l: 1 }))), []);
});

test('Malformed raw rows cannot be dropped to fabricate uninterrupted range history', () => {
  const rows = waves().map(c => [c.t, c.o, c.h, c.l, c.c, c.v]);
  rows[rows.length - 1][4] = 'invalid';
  assert.deepEqual(engine.detectRanges(rows), []);
  assert.deepEqual(engine.scanAll(rows).ranges, []);
  const candles = waves(); candles[80] = null;
  assert.deepEqual(engine.detectRanges(candles), []);
});

for (const defect of ['nan', 'duplicate', 'gap', 'invalidOHLC']) test(`Range rejects incomplete/invalid history: ${defect}`, () => {
  const candles = waves();
  if (defect === 'nan') candles[80].c = NaN;
  if (defect === 'duplicate') candles[80].t = candles[79].t;
  if (defect === 'gap') candles.splice(80, 5);
  if (defect === 'invalidOHLC') candles[80].h = candles[80].l - 1;
  assert.deepEqual(engine.detectRanges(candles), []);
});

test('Range uses the same geometry in standalone, unified scan and server wrapper', () => {
  const candles = waves();
  assert.deepEqual(engine.scanAll(candles, 2).ranges, engine.detectRanges(candles, 2));
  assert.deepEqual(serverLevels.detectRanges(candles, 2), engine.detectRanges(candles, 2));
});

test('Long histories retain original anchor indices and bounded range output', () => {
  const candles = waves({ count: 20000 });
  const [box] = engine.detectRanges(candles);
  assert.ok(box && box.swingIdx >= candles.length - 400);
  assert.equal(box.swingTime, candles[box.swingIdx].t);
});

test('Range signal carries both bounds and neutral direction for subscriber matching', () => {
  const signals = scanCandles({ ex: 'BN', sym: 'TESTUSDT', base: 'TEST', tf: '15m' }, waves());
  const signal = signals.find(s => s.type === 'range');
  assert.ok(signal);
  assert.equal(signal.direction, 'neutral');
  assert.equal(signal.meta.lower, 0.799);
  assert.equal(signal.meta.upper, 1.001);
  assert.ok([signal.meta.lower, signal.meta.upper].includes(signal.price));
});

module.exports = { waves };
