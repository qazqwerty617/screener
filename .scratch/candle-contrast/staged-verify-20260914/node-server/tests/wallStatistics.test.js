"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeBook,
  extractClusters,
  calculateRobustBookStats,
  rankWallByStatistics,
  rankFromSignificance,
  significanceOf,
  percentileRank,
  isTradableBase,
} = require("../wallScanner");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a realistic book: a flat ladder of small levels with optional walls.
 * step is expressed in absolute price units.
 */
function makeBook(opts) {
  const {
    mid = 100,
    step = 0.01,
    levels = 200,
    baseUsd = 3000,
    jitter = 0.15,
    walls = [],
  } = opts || {};

  const bids = [];
  const asks = [];
  // Deterministic pseudo-noise so tests never flake.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (let i = 1; i <= levels; i++) {
    const bidPrice = +(mid - i * step).toFixed(8);
    const askPrice = +(mid + i * step).toFixed(8);
    const bidUsd = baseUsd * (1 + (rand() - 0.5) * jitter * 2);
    const askUsd = baseUsd * (1 + (rand() - 0.5) * jitter * 2);
    bids.push({ price: bidPrice, qty: bidUsd / bidPrice, usd: bidUsd });
    asks.push({ price: askPrice, qty: askUsd / askPrice, usd: askUsd });
  }

  for (const w of walls) {
    const list = w.side === "bid" ? bids : asks;
    let best = null;
    let bestDist = Infinity;
    for (const level of list) {
      const dist = Math.abs(level.price - w.price);
      if (dist < bestDist) { bestDist = dist; best = level; }
    }
    if (best) {
      best.usd += w.usd;
      best.qty = best.usd / best.price;
    }
  }

  return { bids, asks };
}

const COIN = { sym: "AAAUSDT", base: "AAA", p: 100, v: 50_000_000, cs: 1 };

// ── Robust statistics ────────────────────────────────────────────────────────

test("robust log stats stay finite and resistant on a skewed book", () => {
  const bins = Array.from({ length: 100 }, (_, i) => ({ usd: 50_000 + (i % 7) * 2_000 }));
  bins.push({ usd: 5_000_000 });
  const stats = calculateRobustBookStats(bins);
  const z = (Math.log1p(5_000_000) - stats.center) / stats.sigma;
  assert.ok(Number.isFinite(z));
  assert.ok(z > 5 && z < 60, `z out of range: ${z}`);
});

test("robust stats handle an empty or all-zero book", () => {
  assert.equal(calculateRobustBookStats([]).count, 0);
  assert.equal(calculateRobustBookStats([{ usd: 0 }, { usd: -5 }]).count, 0);
  assert.equal(calculateRobustBookStats(null).count, 0);
});

test("one huge outlier cannot inflate sigma enough to hide itself", () => {
  const flat = Array.from({ length: 60 }, () => ({ usd: 10_000 }));
  const withWall = flat.concat([{ usd: 2_000_000 }]);
  const stats = calculateRobustBookStats(withWall);
  const z = (Math.log1p(2_000_000) - stats.center) / stats.sigma;
  assert.ok(z > 3, `outlier should remain detectable, z=${z}`);
});

test("percentileRank is monotonic and bounded", () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.equal(percentileRank(sorted, 0), 0);
  assert.equal(percentileRank(sorted, 5), 1);
  assert.ok(percentileRank(sorted, 3) > percentileRank(sorted, 2));
});

// ── Cluster extraction ───────────────────────────────────────────────────────
//
// `extractClusters(levels, tick, side, bandSpan)` — the geometry is tick-relative
// as of engine v5. These tests cover the invariants that survive from the
// fixed-bin era; the full scale-invariance suite is in wallDetection.test.js.

test("adjacent large levels are one cluster, never split in two", () => {
  // The original fixed-bin engine halved a wall that straddled a bin boundary.
  // Seed-and-grow has no boundaries, so two adjacent large levels must merge.
  const levels = [];
  for (let i = 0; i < 40; i++) {
    levels.push({ price: +(99.5 + i * 0.01).toFixed(4), qty: 1, usd: 4000 });
  }
  // Two neighbouring ticks in the middle of the ladder, each holding 100x the
  // local normal.
  levels[20].usd += 400_000;
  levels[21].usd += 400_000;

  const clusters = extractClusters(levels, 0.01, "bid", 0.4);
  assert.ok(clusters.length >= 1, "the wall must be found");
  const biggest = clusters.reduce((best, c) => (c.usd > best.usd ? c : best), clusters[0]);
  assert.ok(biggest.usd >= 800_000, `expected merged wall, got ${biggest.usd}`);
  assert.ok(biggest.orders >= 2, `expected a multi-level shelf, got ${biggest.orders}`);
});

test("clusters never claim the same price level twice", () => {
  const levels = [];
  for (let i = 0; i < 60; i++) {
    levels.push({ price: +(100 + i * 0.01).toFixed(4), qty: 1, usd: 10_000 });
  }
  // Two separate walls, far enough apart to stay separate.
  levels[10].usd = 500_000;
  levels[45].usd = 700_000;

  const clusters = extractClusters(levels, 0.01, "ask", 0.6);
  const claimed = clusters.reduce((sum, c) => sum + c.usd, 0);
  const bookTotal = levels.reduce((sum, l) => sum + l.usd, 0);
  assert.ok(claimed <= bookTotal + 1,
    `clusters claim ${claimed} of a ${bookTotal} book — a level was counted twice`);
  assert.equal(clusters.length, 2, `expected 2 distinct walls, got ${clusters.length}`);
});

test("extractClusters returns an empty array for an empty side", () => {
  assert.deepEqual(extractClusters([], 0.01, "bid", 1), []);
});

test("cluster price is volume weighted toward the biggest order", () => {
  const levels = [];
  for (let i = 0; i < 30; i++) {
    levels.push({ price: +(100 + i * 0.01).toFixed(4), qty: 1, usd: 5_000 });
  }
  // A shelf whose mass sits overwhelmingly on the upper of two adjacent ticks.
  levels[15].usd = 60_000;
  levels[16].usd = 940_000;

  const clusters = extractClusters(levels, 0.01, "ask", 0.3);
  const cluster = clusters.reduce((best, c) => (c.usd > best.usd ? c : best), clusters[0]);
  const heavyPrice = levels[16].price;
  assert.ok(Math.abs(cluster.price - heavyPrice) < 0.004,
    `expected weighting toward ${heavyPrice}, got ${cluster.price}`);
});

// ── analyzeBook ──────────────────────────────────────────────────────────────

test("a genuine wall is detected and an ordinary book yields nothing", () => {
  const flat = analyzeBook({ ex: "BN", coin: COIN, ...makeBook({}) });
  assert.ok(flat, "analysis should be produced");
  assert.equal(flat.candidates.length, 0, "a flat book must not produce densities");

  const withWall = analyzeBook({
    ex: "BN",
    coin: COIN,
    ...makeBook({ walls: [{ side: "bid", price: 99.5, usd: 900_000 }] }),
  });
  const found = withWall.candidates.filter(c => c.side === "bid");
  assert.ok(found.length >= 1, "the wall must be detected");
  const top = found.reduce((best, c) => (c.S > best.S ? c : best), found[0]);
  assert.ok(Math.abs(top.price - 99.5) < 0.05, `wall price off: ${top.price}`);
  assert.ok(top.dominance > 1.9, `dominance too low: ${top.dominance}`);
  assert.ok(top.significance >= 0.30);
});

test("mid price comes from the book, not from a stale ticker", () => {
  const book = makeBook({ mid: 100 });
  const analysis = analyzeBook({ ex: "BN", coin: { ...COIN, p: 100.4 }, ...book });
  // Best bid 99.99 / best ask 100.01 -> mid 100, not the 100.4 ticker value.
  assert.ok(Math.abs(analysis.mid - 100) < 0.02, `mid=${analysis.mid}`);
});

test("a book that disagrees wildly with the ticker is rejected as stale", () => {
  const book = makeBook({ mid: 100 });
  const analysis = analyzeBook({ ex: "BN", coin: { ...COIN, p: 140 }, ...book });
  assert.equal(analysis, null);
});

test("levels outside the scan band are ignored", () => {
  const analysis = analyzeBook({
    ex: "BN",
    coin: COIN,
    ...makeBook({ walls: [{ side: "ask", price: 100 + 200 * 0.01, usd: 5_000_000 }] }),
  });
  // The book only spans 2%, so a wall at its far edge is inside the band;
  // verify the band bound itself instead.
  assert.ok(analysis.bandHigh <= 100 * 1.0501);
  assert.ok(analysis.bandLow >= 100 * 0.9499);
  for (const c of analysis.candidates) {
    assert.ok(c.pct <= 5.0 + 1e-9, `candidate outside band: ${c.pct}`);
  }
});

test("stablecoins, leveraged tokens and stocks are rejected", () => {
  for (const base of ["USDT", "USDC", "BTC3L", "AAPL", "TSLAX", "ETHUP"]) {
    const analysis = analyzeBook({
      ex: "BN",
      coin: { ...COIN, base, sym: `${base}USDT` },
      ...makeBook({}),
    });
    assert.equal(analysis, null, `${base} should be filtered out`);
  }
  assert.equal(isTradableBase("SOL", "SOLUSDT"), true);
  assert.equal(isTradableBase("USDC", "USDCUSDT"), false);
});

test("an empty book produces no analysis", () => {
  assert.equal(analyzeBook({ ex: "BN", coin: COIN, bids: [], asks: [] }), null);
  assert.equal(analyzeBook({ ex: "BN", coin: COIN, bids: null, asks: null }), null);
});

test("garbage levels are discarded without throwing", () => {
  const analysis = analyzeBook({
    ex: "BN",
    coin: COIN,
    bids: [
      { price: NaN, qty: 1, usd: 5000 },
      { price: 99.9, qty: 1, usd: NaN },
      { price: -5, qty: 1, usd: 5000 },
      { price: 99.8, qty: 1, usd: 0 },
    ],
    asks: [{ price: 100.1, qty: 1, usd: 5000 }],
  });
  // Every bid was invalid, so no bid-side density can exist.
  assert.ok(!analysis || analysis.candidates.every(c => c.side !== "bid"));
});

test("volMinutes scales the same wall by the coin's traded flow", () => {
  const book = makeBook({ walls: [{ side: "bid", price: 99.5, usd: 900_000 }] });
  const thin = analyzeBook({ ex: "BN", coin: { ...COIN, v: 2_000_000 }, ...book });
  const thick = analyzeBook({ ex: "BN", coin: { ...COIN, v: 900_000_000 }, ...book });

  const pick = (a) => a.candidates.filter(c => c.side === "bid")
    .reduce((best, c) => (!best || c.S > best.S ? c : best), null);

  const thinWall = pick(thin);
  const thickWall = pick(thick);
  assert.ok(thinWall, "wall must exist on the low-volume coin");
  if (thickWall) {
    // Same dollar wall is far less meaningful on a high-turnover coin.
    assert.ok(thinWall.volMinutes > thickWall.volMinutes * 10);
    assert.ok(thinWall.significance > thickWall.significance);
  }
});

test("aggregated venues receive a granularity discount", () => {
  const parts = {
    z: 4, dominance: 8, depthShare: 0.15, volMinutes: 10,
    percentile: 0.99, distPct: 1, levelCount: 40,
  };
  const sharp = significanceOf({ ...parts, aggregated: false });
  const merged = significanceOf({ ...parts, aggregated: true });
  assert.ok(merged < sharp);
});

test("significance rises with every underlying signal and stays in 0..1", () => {
  const weak = significanceOf({ z: 1.2, dominance: 2, depthShare: 0.03, volMinutes: 0.2, percentile: 0.72, distPct: 4.5, levelCount: 12, aggregated: false });
  const strong = significanceOf({ z: 6, dominance: 25, depthShare: 0.3, volMinutes: 40, percentile: 0.999, distPct: 0.2, levelCount: 80, aggregated: false });
  assert.ok(weak >= 0 && weak <= 1);
  assert.ok(strong > weak);
  assert.ok(strong <= 1);
});

test("closer densities score higher than identical distant ones", () => {
  const near = significanceOf({ z: 4, dominance: 8, depthShare: 0.1, volMinutes: 6, percentile: 0.98, distPct: 0.3, levelCount: 40, aggregated: false });
  const far = significanceOf({ z: 4, dominance: 8, depthShare: 0.1, volMinutes: 6, percentile: 0.98, distPct: 4.6, levelCount: 40, aggregated: false });
  assert.ok(near > far);
});

// ── Ranking ──────────────────────────────────────────────────────────────────

test("ranks span the small, medium and large UI buckets", () => {
  assert.ok(rankFromSignificance(0.15, 0.2) <= 3);
  const medium = rankFromSignificance(0.5, 0.5);
  assert.ok(medium >= 5 && medium < 7, `medium rank was ${medium}`);
  assert.ok(rankFromSignificance(0.95, 0.9) >= 9);
});

test("rank increases monotonically with significance", () => {
  let previous = 0;
  for (const s of [0.1, 0.25, 0.35, 0.45, 0.6, 0.7, 0.8, 0.95]) {
    const rank = rankFromSignificance(s, 0.5);
    assert.ok(rank >= previous, `rank dropped at significance ${s}`);
    previous = rank;
  }
  assert.ok(previous <= 10);
});

test("persistence lifts the rank of an otherwise equal density", () => {
  assert.ok(rankFromSignificance(0.55, 1) >= rankFromSignificance(0.55, 0));
});

test("legacy Z/percentile ranking still returns a usable band", () => {
  assert.ok(rankWallByStatistics(1.0, 70) <= 4);
  assert.ok(rankWallByStatistics(8, 99.9) >= 7);
  assert.ok(rankWallByStatistics(0, 0) >= 1);
});
