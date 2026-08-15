"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scanCandles } = require("../patternDetector");

function candle(i, o, h, l, c, v = 1000) {
  return { t: 1_700_000_000_000 + i * 60_000, o, h, l, c, v };
}

test("scanCandles handles a recent confirmed retest and returns finite signals", () => {
  const candles = [];
  for (let i = 0; i < 40; i++) candles.push(candle(i, 99, 99.4, 98.7, 99));

  // Establish a clean resistance, break it, depart, and retest from above.
  candles[15] = candle(15, 99.1, 100, 98.9, 99.2, 1500);
  candles[30] = candle(30, 99.2, 101.2, 99.1, 101, 5000);
  candles[31] = candle(31, 101, 101.4, 100.8, 101.2, 1800);
  candles[32] = candle(32, 101.2, 101.3, 100.6, 100.8, 1600);
  candles[33] = candle(33, 100.8, 100.9, 100.05, 100.45, 1700);
  for (let i = 34; i < 40; i++) candles[i] = candle(i, 100.45, 100.9, 100.2, 100.6, 1300);

  const signals = scanCandles(
    { ex: "BN", sym: "TESTUSDT", base: "TEST", tf: "15m" },
    candles,
    { swingWindow: 1, minTouches: 1, levelTolerance: 0.003, breakoutVolMult: 1 }
  );

  assert.ok(Array.isArray(signals));
  for (const signal of signals) {
    assert.ok(Number.isFinite(signal.price));
    assert.ok(Number.isFinite(signal.ts));
  }
  assert.ok(signals.some(signal => signal.type === "retest"));
});
