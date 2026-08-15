"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildWallSnapshot, clusterWalls } = require("../wallScanner");

test("buildWallSnapshot([]) returns []", () => {
  assert.deepEqual(buildWallSnapshot([]), []);
  assert.deepEqual(buildWallSnapshot(null), []);
  assert.deepEqual(buildWallSnapshot(undefined), []);
});

test("filters out invalid, NaN, Infinity, and negative values", () => {
  const input = [
    { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0 },
    { base: "ETH", ex: "BN", sym: "ETHUSDT", side: "ask", price: NaN, S: 100000, pct: 1.0, rtwi: 5.0 },
    { base: "SOL", ex: "BN", sym: "SOLUSDT", side: "bid", price: 100, S: Infinity, pct: 1.0, rtwi: 5.0 },
    { base: "XRP", ex: "BN", sym: "XRPUSDT", side: "bid", price: -5, S: 100000, pct: 1.0, rtwi: 5.0 },
    { base: "ADA", ex: "BN", sym: "ADAUSDT", side: "bid", price: 0.5, S: -100, pct: 1.0, rtwi: 5.0 },
    null,
    "invalid string",
    { base: 123, ex: "BN", sym: "BTCUSDT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0 },
  ];

  const result = buildWallSnapshot(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].base, "BTC");
  assert.equal(result[0].price, 50000);
});

test("clustering merges close levels on same exchange, base, side", () => {
  const input = [
    { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0, count: 1, age: 10 },
    { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 50020, S: 150000, pct: 1.04, rtwi: 6.0, count: 1, age: 12 }, // gap = 0.04% <= 0.1%
  ];

  const result = buildWallSnapshot(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].S, 250000);
  assert.equal(result[0].count, 2);
});

test("different symbols are not merged", () => {
  const input = [
    { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0 },
    { base: "ETH", ex: "BN", sym: "ETHUSDT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0 },
  ];

  const result = buildWallSnapshot(input);
  assert.equal(result.length, 2);
  const bases = result.map(r => r.base).sort();
  assert.deepEqual(bases, ["BTC", "ETH"]);
});

test("different market types (spot vs futures) are not erroneously merged", () => {
  const input = [
    { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0, market: "futures" },
    { base: "BTC", ex: "BN", sym: "BTCUSDT_SPOT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0, market: "spot" },
  ];

  const result = buildWallSnapshot(input);
  assert.equal(result.length, 2);
  const markets = result.map(r => r.market).sort();
  assert.deepEqual(markets, ["futures", "spot"]);
});

test("pure snapshot generation does not mutate input array or objects", () => {
  const originalWall = { base: "BTC", ex: "BN", sym: "BTCUSDT", side: "bid", price: 50000, S: 100000, pct: 1.0, rtwi: 5.0 };
  const input = [originalWall];

  const result = buildWallSnapshot(input);
  assert.notEqual(result[0], originalWall); // must be a new cloned object
  assert.equal(originalWall.wallK, undefined); // input not mutated
});

test("respects per-coin limit and max output", () => {
  const input = [];
  for (let i = 0; i < 10; i++) {
    input.push({ base: "BTC", ex: "BN", sym: `BTCUSDT`, side: "bid", price: 50000 + i * 1000, S: 100000, pct: 1.0 + i * 0.1, rtwi: 10 - i });
  }

  const result = buildWallSnapshot(input, { maxPerCoin: 3, maxOutput: 5 });
  assert.equal(result.length, 3); // Max per coin capped at 3
});

test("per-coin limit does not hide the same asset on other exchanges", () => {
  const input = [];
  for (const ex of ["BN", "BB", "OX"]) {
    for (let i = 0; i < 3; i++) {
      input.push({
        base: "BTC", ex, sym: `${ex}-BTCUSDT`, side: i % 2 ? "ask" : "bid",
        price: 50000 + i * 500, S: 200000 + i * 10000, pct: 0.5 + i * 0.1, rtwi: 9 - i,
      });
    }
  }

  const result = buildWallSnapshot(input, { maxPerCoin: 2, maxOutput: 20 });
  assert.equal(result.length, 6);
  assert.deepEqual(new Set(result.map(w => w.ex)), new Set(["BN", "BB", "OX"]));
});

test("cluster preserves the complete first-seen to last-seen lifetime", () => {
  const input = [
    { base: "SOL", ex: "BB", sym: "SOLUSDT", side: "bid", market: "futures", price: 100, S: 100000, pct: 1, rtwi: 6, count: 1, firstSeenAt: 1000, lastSeenAt: 4000 },
    { base: "SOL", ex: "BB", sym: "SOLUSDT", side: "bid", market: "futures", price: 100.05, S: 120000, pct: 1.05, rtwi: 7, count: 1, firstSeenAt: 2000, lastSeenAt: 5000 },
  ];
  const [wall] = buildWallSnapshot(input);
  assert.equal(wall.firstSeenAt, 1000);
  assert.equal(wall.lastSeenAt, 5000);
  assert.equal(wall.lifeMs, 4000);
});
