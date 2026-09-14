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

  // Establish a clean confirmed resistance (2 touches), break it, depart, and retest from above.
  candles[15] = candle(15, 99.1, 100, 98.9, 99.2, 1500);
  candles[23] = candle(23, 99.1, 100, 98.9, 99.2, 1500);
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

test("scanCandles does not alert a retest after price already ran far from the level", () => {
  const candles = [];
  for (let i = 0; i < 90; i++) candles.push(candle(i, 103, 103.4, 102.6, 103));

  for (const idx of [12, 30]) {
    candles[idx] = candle(idx, 103.5, 105, 103.2, 103.8, 1500);
    candles[idx - 1].h = 103;
    candles[idx + 1].h = 103;
  }
  candles[40] = candle(40, 104.8, 106.2, 104.7, 106, 5000);
  for (let i = 41; i < 90; i++) candles[i] = candle(i, 106, 107.4, 105.6, 107, 1600);
  candles[43] = candle(43, 106, 108, 105.8, 107, 2000);
  candles[65] = candle(65, 106, 106.3, 104.95, 105.7, 1800);

  const signals = scanCandles(
    { ex: "HL", sym: "KBONK", base: "KBONK", tf: "5m" },
    candles,
    { swingWindow: 1, minTouches: 1, levelTolerance: 0.003, breakoutVolMult: 1 }
  );

  assert.equal(
    signals.some(signal => signal.type === "retest" && Math.abs(signal.price - 105) < 0.5),
    false,
    "a completed move 1%+ away from the retest is no longer an actionable retest"
  );
});
