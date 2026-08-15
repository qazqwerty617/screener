"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateRobustBookStats, rankWallByStatistics, buildWallSnapshot } = require("../wallScanner");

test("log robust score stays finite for a sparse skewed book", () => {
  const bins = Array.from({ length: 100 }, (_, i) => ({ usd: 50_000 + (i % 7) * 2_000 }));
  bins.push({ usd: 5_000_000 });
  const stats = calculateRobustBookStats(bins);
  const z = (Math.log1p(5_000_000) - stats.center) / stats.sigma;
  assert.ok(Number.isFinite(z));
  assert.ok(z > 5 && z < 50);
  assert.ok(rankWallByStatistics(z, 1) >= 7);
});

test("snapshot rejects weak and unconfirmed statistical noise", () => {
  const base = { base: "X", ex: "BN", sym: "XUSDT", side: "bid", price: 1, S: 100000, pct: 1, rtwi: 1, market: "futures" };
  const result = buildWallSnapshot([
    { ...base, rank: 3, confirmations: 5 },
    { ...base, sym: "YUSDT", base: "Y", rank: 7, confirmations: 1 },
    { ...base, sym: "ZUSDT", base: "Z", rank: 6, confirmations: 2 },
  ]);
  assert.deepEqual(result.map(item => item.base), ["Z"]);
});

test("snapshot keeps persistent top-percentile rank-three walls", () => {
  const result = buildWallSnapshot([{
    base: "X", ex: "BN", sym: "XUSDT", side: "bid", price: 1,
    S: 150000, pct: 1, rtwi: 2, market: "futures", rank: 3,
    relSize: 2.9, percentile: 95.2, confirmations: 2,
  }]);
  assert.equal(result.length, 1);
});

test("Z ranks retain useful small, medium and large bands", () => {
  assert.equal(rankWallByStatistics(3.9, 0.97), 3);
  assert.equal(rankWallByStatistics(9.5, 0.90), 5);
  assert.equal(rankWallByStatistics(13, 0.99), 7);
});
