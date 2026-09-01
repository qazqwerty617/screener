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

test("valid descending resistance trendline is detected near price", () => {
  const candles = baseCandles(90);
  for (const [idx, high] of [[10, 104], [35, 103], [60, 102]]) {
    candles[idx] = { ...candles[idx], h: high, c: 100.5, o: 100.5 };
    candles[idx - 1].h = 100.4;
    candles[idx + 1].h = 100.4;
  }
  candles[candles.length - 1].c = 100.8;
  const tls = engine.detectTrendlines(candles, 2);
  assert.ok(tls.length > 0);
  assert.equal(tls[0].direction, "up");
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

test("horizontal resistance is rejected when an intermediate candle pierces through it", () => {
  const candles = baseCandles(90);
  for (const [idx, high] of [[12, 105], [52, 104.95]]) {
    candles[idx] = { ...candles[idx], h: high, c: 103.5 };
    candles[idx - 1].h = 103;
    candles[idx + 1].h = 103;
  }
  // Intermediate bar piercing straight through 105
  candles[32] = { ...candles[32], o: 104, h: 108, c: 107 };
  candles[candles.length - 1].c = 102;
  const levels = engine.detectHorizontals(candles, 2);
  const resistance = levels.find(item => item.direction === "up" && Math.abs(item.price - 105) < 1);
  assert.equal(resistance, undefined, "Pierced level must be rejected");
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

test("valid ascending support trendline is detected on lows", () => {
  const candles = baseCandles(90);
  for (const [idx, low] of [[15, 94], [40, 95], [65, 96]]) {
    candles[idx] = { ...candles[idx], l: low, c: 98, o: 98 };
    candles[idx - 1].l = 97.5;
    candles[idx + 1].l = 97.5;
  }
  candles[candles.length - 1].c = 97.5;
  const tls = engine.detectTrendlines(candles, 2);
  const support = tls.find(t => t.direction === "down" || !t.isHigh);
  assert.ok(support, "Should detect ascending support trendline");
  assert.ok(support.touches >= 2);
});

test("trendlines never intersect on the same side", () => {
  const candles = baseCandles(100);
  for (const [idx, high] of [[10, 106], [30, 104], [50, 102]]) {
    candles[idx] = { ...candles[idx], h: high, c: 100, o: 100 };
    candles[idx - 1].h = 99;
    candles[idx + 1].h = 99;
  }
  candles[candles.length - 1].c = 100;
  const tls = engine.detectTrendlines(candles, 2);
  const upLines = tls.filter(t => t.direction === "up");
  for (let i = 0; i < upLines.length; i++) {
    for (let j = i + 1; j < upLines.length; j++) {
      const l1 = upLines[i], l2 = upLines[j];
      const dSlope = l1.slope - l2.slope;
      if (Math.abs(dSlope) > 1e-9) {
        const x = ((l2.p1.price - l2.slope * l2.p1.idx) - (l1.p1.price - l1.slope * l1.p1.idx)) / dSlope;
        const inRange = (x >= Math.min(l1.p1.idx, l2.p1.idx) && x <= candles.length + 20);
        assert.equal(inRange, false, "Returned same-side trendlines must not intersect");
      }
    }
  }
});

test("triangle pattern detects both descending resistance and ascending support", () => {
  const candles = baseCandles(85);
  // Descending highs: (10, 106), (35, 104), (60, 102) -> slope = -0.08
  for (const [idx, high] of [[10, 106], [35, 104], [60, 102]]) {
    candles[idx] = { ...candles[idx], h: high, c: 99, o: 99 };
    candles[idx - 1].h = 99;
    candles[idx + 1].h = 99;
  }
  // Ascending lows: (15, 94), (40, 95.5), (65, 97) -> slope = +0.06
  for (const [idx, low] of [[15, 94], [40, 95.5], [65, 97]]) {
    candles[idx] = { ...candles[idx], l: low, c: 99, o: 99 };
    candles[idx - 1].l = 98.5;
    candles[idx + 1].l = 98.5;
  }
  for (let i = 66; i < candles.length; i++) {
    candles[i] = { ...candles[i], o: 99, h: 99.5, l: 98.5, c: 99 };
  }
  candles[candles.length - 1].c = 99;
  const tls = engine.detectTrendlines(candles, 2);
  const res = tls.find(t => t.direction === "up" || t.isHigh);
  const sup = tls.find(t => t.direction === "down" || !t.isHigh);
  assert.ok(res, "Triangle must have resistance line");
  assert.ok(sup, "Triangle must have support line");
});

test("trendline with two anchors and no intermediate departure has exactly 2 touches", () => {
  const candles = baseCandles(90);
  for (const [idx, high] of [[10, 104], [60, 102]]) {
    candles[idx] = { ...candles[idx], h: high, c: 100.5, o: 100.5 };
    candles[idx - 1].h = 100.4;
    candles[idx + 1].h = 100.4;
  }
  candles[candles.length - 1].c = 100.8;
  const tls = engine.detectTrendlines(candles, 2);
  assert.ok(tls.length > 0);
  assert.equal(tls[0].touches, 2, "Should have exactly 2 touches");
});

test("trendline pierced by earlier peak before p1 is rejected", () => {
  const candles = baseCandles(90);
  // Earlier huge peak at index 15 (115)
  candles[15] = { ...candles[15], h: 115, c: 112, o: 110 };
  // Trendline anchors at (30, 105) and (60, 102) -> slope = -0.1
  // Back-projected to index 15: 105 - (-0.1 * 15) = 106.5.
  // Since candle 15 reached 115, it pierces the line!
  for (const [idx, high] of [[30, 105], [60, 102]]) {
    candles[idx] = { ...candles[idx], h: high, c: 100.5, o: 100.5 };
    candles[idx - 1].h = 100.4;
    candles[idx + 1].h = 100.4;
  }
  candles[candles.length - 1].c = 100.8;
  const tls = engine.detectTrendlines(candles, 2);
  const found = tls.find(t => t.p1?.idx === 30 || t.p2?.idx === 60);
  assert.equal(found, undefined, "Trendline pierced by earlier peak must be rejected");
});

function flatCandles(length = 90) {
  return Array.from({ length }, (_, i) => ({ t: i * 60_000, o: 98.5, h: 98.7, l: 98.3, c: 98.5, v: 1 }));
}

test("horizontal touches must each reach the level, not merely share a cluster", () => {
  const candles = flatCandles(90);
  // Rising highs inside one cluster: level price becomes maxP = 100.2, but the
  // earliest member only reached 100.0 (20 bps away vs ~6 bps tolerance).
  for (const [idx, high] of [[12, 100.0], [32, 100.1], [52, 100.2]]) {
    candles[idx] = { ...candles[idx], h: high, c: 99, o: 99, l: 98.9 };
  }
  candles[candles.length - 1] = { ...candles[candles.length - 1], o: 99, h: 99.6, l: 98.9, c: 99.5 };

  const levels = engine.detectHorizontals(candles, 2);
  for (const lv of levels) {
    const tol = Math.max(lv.price * 0.0006, 0.001);
    for (const idx of lv.touchIndices) {
      const wick = lv.direction === "up" ? candles[idx].h : candles[idx].l;
      assert.ok(
        Math.abs(wick - lv.price) <= tol * 1.05,
        `touch at idx ${idx} (wick ${wick}) never reached level ${lv.price}`
      );
    }
  }
});

test("horizontal support is still detected when swing highs are present", () => {
  function build(withSwingHigh) {
    const candles = flatCandles(90);
    for (const [idx, low] of [[12, 95], [32, 95.02], [52, 95.01]]) {
      candles[idx] = { ...candles[idx], l: low, c: 96.5, o: 96.5, h: 96.6 };
    }
    if (withSwingHigh) {
      candles[70] = { ...candles[70], h: 99.9, c: 98.6, o: 98.5, l: 98.3 };
    }
    candles[candles.length - 1] = { ...candles[candles.length - 1], o: 97.9, h: 98.1, l: 97.8, c: 98 };
    return candles;
  }

  const withoutHigh = engine.detectHorizontals(build(false), 2);
  const withHigh = engine.detectHorizontals(build(true), 2);

  assert.ok(withoutHigh.some(lv => lv.direction === "down"), "baseline support must be detected");
  assert.ok(
    withHigh.some(lv => lv.direction === "down"),
    "support must survive the presence of an unrelated swing high"
  );
});
