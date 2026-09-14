"use strict";
// Verifies that the alert snapshot actually frames the formation it is about to
// announce. The old renderer always showed the trailing 140 candles, so any
// formation anchored further back was drawn off-screen or clipped away.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveVisibleCount,
  collectFormationIndices,
  collectFormationPrices,
  MAX_VISIBLE_CANDLES,
  DEFAULT_VISIBLE_CANDLES
} = require("../serverChartRenderer");

const W = 1200, H = 680, TOP = 52, PR = 105, PW = W - PR, BTM = 28, VOL_H = 105;
const PH = H - TOP - VOL_H - BTM;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeCandles(n) {
  const rnd = mulberry32(4242);
  const out = [];
  let p = 120;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p * (1 - 0.0012 + (rnd() - 0.5) * 0.002);
    out.push({ t: 1700000000000 + i * 300000, o, h: Math.max(o, c) * 1.0008, l: Math.min(o, c) * 0.9992, c, v: 1000 + rnd() * 500 });
    p = c;
  }
  return out;
}

// Recomputes the renderer's layout so we can assert on-screen coordinates.
function frame(candles, signal) {
  const numCandles = resolveVisibleCount(candles, signal);
  const list = candles.slice(-numCandles);
  let minP = Infinity, maxP = -Infinity;
  for (const c of list) { if (c.l < minP) minP = c.l; if (c.h > maxP) maxP = c.h; }

  const sigPrices = collectFormationPrices(signal);
  if (Number.isFinite(signal?.meta?.slope) && sigPrices.length > 0) {
    sigPrices.push((Number(signal.price) || sigPrices[0]) + Number(signal.meta.slope) * 3);
  }
  for (const p of sigPrices) { if (p < minP) minP = p; if (p > maxP) maxP = p; }

  const margin = (maxP - minP) * 0.06 || minP * 0.01;
  minP -= margin; maxP += margin;
  const range = maxP - minP || 1;
  const toY = p => TOP + (maxP - p) * (PH / range);

  const offset = candles.length - numCandles;
  const stepW = PW / Math.max(numCandles, 55);
  const xOffset = PW - numCandles * stepW;
  const toX = i => xOffset + i * stepW + stepW / 2;

  return { numCandles, offset, toY, toX, clipTop: TOP, clipBottom: TOP + PH, stepW };
}

const CANDLES = makeCandles(300);
const oldHigh = Math.max(...CANDLES.slice(0, 40).map(c => c.h));

function levelSignal(swingIdx, touchIndices, price) {
  return {
    type: "level",
    direction: "short",
    price,
    meta: { touches: touchIndices.length, swingIdx, touchIndices, levelType: "resistance", dist: 0.4 }
  };
}

test("a level anchored far back is brought into the window", () => {
  const sig = levelSignal(12, [12, 25, 38], +oldHigh.toFixed(4));
  const f = frame(CANDLES, sig);

  assert.ok(f.numCandles > DEFAULT_VISIBLE_CANDLES, `window must widen past ${DEFAULT_VISIBLE_CANDLES}, got ${f.numCandles}`);
  const originLocal = 12 - f.offset;
  assert.ok(originLocal >= 0, `anchor must be inside the window, local idx ${originLocal}`);
  const x = f.toX(originLocal);
  assert.ok(x >= 0 && x <= PW, `anchor x must be on canvas, got ${x}`);
});

test("a level priced outside the candle range is still inside the clip region", () => {
  const sig = levelSignal(12, [12, 25, 38], +oldHigh.toFixed(4));
  const f = frame(CANDLES, sig);
  const y = f.toY(sig.price);
  assert.ok(
    y >= f.clipTop && y <= f.clipBottom,
    `level y ${y.toFixed(1)} must land inside [${f.clipTop}, ${f.clipBottom}]`
  );
});

test("every touch dot of the level is inside the window", () => {
  const touchIndices = [12, 25, 38];
  const sig = levelSignal(12, touchIndices, +oldHigh.toFixed(4));
  const f = frame(CANDLES, sig);
  for (const idx of touchIndices) {
    const local = idx - f.offset;
    assert.ok(local >= 0 && local < f.numCandles, `touch ${idx} (local ${local}) must be visible`);
    const x = f.toX(local);
    assert.ok(x >= 0 && x <= PW, `touch ${idx} x ${x.toFixed(1)} must be on canvas`);
  }
});

test("a trendline's p1 anchor and projected end are both framed", () => {
  const p1Idx = 15, p2Idx = 90;
  const slope = (CANDLES[p2Idx].h - CANDLES[p1Idx].h) / (p2Idx - p1Idx);
  const endPrice = CANDLES[p1Idx].h + slope * (CANDLES.length - 1 - p1Idx);
  const sig = {
    type: "trendline",
    direction: "short",
    price: endPrice,
    meta: {
      touches: 3,
      p1Idx, p1Price: CANDLES[p1Idx].h,
      p2Idx, p2Price: CANDLES[p2Idx].h,
      swingIndices: [p1Idx, p2Idx, 150],
      slope,
      dist: 0.4
    }
  };
  const f = frame(CANDLES, sig);
  assert.ok(p1Idx - f.offset >= 0, "p1 must be inside the window");
  assert.ok(p2Idx - f.offset >= 0, "p2 must be inside the window");
  for (const y of [f.toY(sig.meta.p1Price), f.toY(sig.meta.p2Price), f.toY(endPrice)]) {
    assert.ok(y >= f.clipTop && y <= f.clipBottom, `trendline y ${y.toFixed(1)} must be inside the clip`);
  }
});

test("a recent formation keeps the default window", () => {
  const last = CANDLES.length - 1;
  const sig = levelSignal(last - 20, [last - 20, last - 10, last - 4], CANDLES[last - 20].h);
  const f = frame(CANDLES, sig);
  assert.equal(f.numCandles, DEFAULT_VISIBLE_CANDLES, "no need to widen for a recent formation");
});

test("the window never exceeds the readable cap", () => {
  const many = makeCandles(1500);
  const sig = levelSignal(0, [0, 5, 10], many[0].h);
  const n = resolveVisibleCount(many, sig);
  assert.ok(n <= MAX_VISIBLE_CANDLES, `window ${n} must be capped at ${MAX_VISIBLE_CANDLES}`);
  // Candles must stay wide enough to see.
  const stepW = PW / Math.max(n, 55);
  assert.ok(stepW >= 3, `candle step ${stepW.toFixed(2)}px is too narrow to read`);
});

test("a short history shows every candle it has", () => {
  // Newly listed coins: the scanner only needs 25 bars, so the window must
  // simply be the whole array rather than a fixed minimum.
  for (const n of [25, 40, 80]) {
    const candles = makeCandles(n);
    const sig = levelSignal(Math.max(0, n - 6), [n - 6, n - 3, n - 1], candles[n - 6].h);
    assert.equal(resolveVisibleCount(candles, sig), n, `${n} candles must all be shown`);
  }
});

test("the window never exceeds the candles available", () => {
  // Regression: a fixed minimum window larger than the array made the drawing
  // loop read past the end and threw. Newly listed coins hit this — the scanner
  // only requires 25 candles.
  const { renderServerChartSnapshot } = require("../serverChartRenderer");
  for (const n of [5, 6, 10, 25, 40, 59, 60, 61]) {
    const candles = makeCandles(n);
    const sig = levelSignal(1, [1, 3], candles[1].h);
    const want = resolveVisibleCount(candles, sig);
    assert.ok(want <= n, `window ${want} must not exceed ${n} available candles`);
    assert.ok(want > 0, "window must be positive");
    assert.doesNotThrow(
      () => renderServerChartSnapshot(candles, { ex: "BN", sym: "T", tf: "1M" }, sig),
      `rendering ${n} candles must not throw`
    );
  }
});

test("an empty candle array yields a zero window instead of throwing", () => {
  assert.equal(resolveVisibleCount([], { meta: {} }), 0);
  assert.equal(resolveVisibleCount(null, { meta: {} }), 0);
});

test("indices and prices are collected from every signal shape", () => {
  assert.deepEqual(
    collectFormationIndices({ meta: { swingIdx: 3, touchIndices: [3, 9], swingIndices: [4], p1Idx: 1, p2Idx: 7, touchIdx: 11, breakIdx: 5 } }).sort((a, b) => a - b),
    [1, 3, 3, 4, 5, 7, 9, 11]
  );
  // Garbage must not poison the framing maths.
  assert.deepEqual(collectFormationIndices({ meta: { swingIdx: -1, touchIndices: [NaN, undefined, 4] } }), [4]);
  assert.deepEqual(collectFormationPrices({ price: 10, meta: { endPrice: 12, p1Price: 0, p2Price: NaN } }), [10, 12]);
});

test("a signal with no geometry falls back to the default window", () => {
  const n = resolveVisibleCount(CANDLES, { type: "pump", meta: {} });
  assert.equal(n, DEFAULT_VISIBLE_CANDLES);
  assert.equal(resolveVisibleCount(CANDLES, null), DEFAULT_VISIBLE_CANDLES);
});
