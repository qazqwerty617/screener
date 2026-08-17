"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../public/js/formationEngine");

function baseCandles(length = 90) {
  return Array.from({ length }, (_, i) => ({ t: i * 60_000, o: 100, h: 100.4, l: 99.6, c: 100, v: 1 }));
}

test("trendline is rejected when a closed wick crosses it", () => {
  const candles = baseCandles();
  for (const [idx, high] of [[10, 110], [30, 108], [50, 106]]) {
    candles[idx] = { ...candles[idx], h: high, c: high - 2, o: high - 2 };
    candles[idx - 1].h = high - 3;
    candles[idx + 1].h = high - 3;
  }
  candles[40].h = 112;
  assert.equal(engine.detectTrendlines(candles, 2).length, 0);
});

test("horizontal resistance uses outer wick boundary", () => {
  const candles = baseCandles();
  for (const [idx, high] of [[12, 105], [32, 104.9], [52, 104.95]]) {
    candles[idx] = { ...candles[idx], h: high, c: 103.5 };
    candles[idx - 1].h = 103;
    candles[idx + 1].h = 103;
  }
  candles[candles.length - 1].c = 102;
  const levels = engine.detectHorizontals(candles, 2);
  const resistance = levels.find(item => item.direction === "up");
  assert.ok(resistance);
  assert.equal(resistance.price, 105);
});

test("confirmed retest requires breakout, departure and hold from the new side", () => {
  const candles = baseCandles(75);
  for (const idx of [12, 30]) {
    candles[idx] = { ...candles[idx], h: 105, c: 103.8 };
    candles[idx - 1].h = 103;
    candles[idx + 1].h = 103;
  }
  for (let i = 40; i < candles.length; i++) candles[i] = { ...candles[i], o: 106, h: 106.5, l: 105.6, c: 106 };
  candles[40] = { ...candles[40], o: 104.8, c: 106, h: 106.2, l: 104.7 };
  candles[43] = { ...candles[43], h: 108, c: 107 };
  candles[65] = { ...candles[65], o: 106, h: 106.3, l: 104.95, c: 105.7 };
  const retests = engine.detectRetests(candles);
  assert.ok(retests.some(item => item.direction === "up" && item.touchIdx === 65));
});

test("cascades respect timeframe distance limit and filter distant macro levels on 1m", () => {
  const candles = baseCandles(100);
  // 1m candle intervals (60_000 ms)
  // Distant swing at 15% (idx 10, should be filtered on 1m chart because dist > 5%)
  candles[10] = { ...candles[10], h: 115, c: 101, o: 101 };
  candles[9].h = 101;
  candles[11].h = 101;

  // Nearby swing within 3% (idx 25, clean resistance)
  candles[25] = { ...candles[25], h: 103, c: 101, o: 101 };
  candles[24].h = 101;
  candles[26].h = 101;
  candles[candles.length - 1].c = 100;

  const cascades = engine.detectCascades(candles, 1);
  const upCascades = cascades.filter(c => c.direction === "up");
  assert.ok(upCascades.some(c => Math.abs(c.price - 103) < 0.1), "Should include nearby 3% cascade");
  assert.equal(upCascades.some(c => Math.abs(c.price - 115) < 0.1), false, "Should exclude distant 15% macro level on 1m timeframe");
});

