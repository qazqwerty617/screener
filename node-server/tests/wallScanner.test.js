"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildWallSnapshot,
  clusterWalls,
  applyConfluence,
} = require("../wallScanner");

function wall(over = {}) {
  return {
    base: "AAA",
    ex: "BN",
    sym: "AAAUSDT",
    side: "bid",
    market: "futures",
    price: 100,
    S: 500000,
    pct: 1.0,
    score: 8,
    rtwi: 8,
    rank: 6,
    significance: 0.5,
    count: 4,
    confirmations: 3,
    ...over,
  };
}

test("buildWallSnapshot tolerates empty and non-array input", () => {
  assert.deepEqual(buildWallSnapshot([]), []);
  assert.deepEqual(buildWallSnapshot(null), []);
  assert.deepEqual(buildWallSnapshot(undefined), []);
});

test("filters out invalid, NaN, Infinity and negative values", () => {
  const input = [
    wall(),
    wall({ base: "BBB", sym: "BBBUSDT", price: NaN }),
    wall({ base: "CCC", sym: "CCCUSDT", S: Infinity }),
    wall({ base: "DDD", sym: "DDDUSDT", price: -5 }),
    wall({ base: "EEE", sym: "EEEUSDT", S: -100 }),
    wall({ base: "FFF", sym: "FFFUSDT", pct: -1 }),
    wall({ base: "GGG", sym: "GGGUSDT", side: "middle" }),
    wall({ base: 123, sym: "HHHUSDT" }),
    null,
    "invalid string",
  ];

  const result = buildWallSnapshot(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].base, "AAA");
  assert.equal(result[0].price, 100);
});

test("walls below the publication score floor are dropped", () => {
  const result = buildWallSnapshot([
    wall({ score: 0.4, rtwi: 0.4 }),
    wall({ base: "BBB", sym: "BBBUSDT", score: 9, rtwi: 9 }),
  ]);
  assert.deepEqual(result.map(w => w.base), ["BBB"]);
});

test("the publication score floor is configurable per call", () => {
  const input = [
    wall({ base: "LOW", sym: "LOWUSDT", score: 3, rtwi: 3 }),
    wall({ base: "HIGH", sym: "HIGHUSDT", score: 9, rtwi: 9 }),
  ];
  assert.deepEqual(
    buildWallSnapshot(input, { minScore: 8 }).map(w => w.base),
    ["HIGH"]
  );
  assert.deepEqual(
    new Set(buildWallSnapshot(input, { minScore: 1 }).map(w => w.base)),
    new Set(["LOW", "HIGH"])
  );
});

test("score falls back to rtwi for legacy records without score", () => {
  const legacy = wall();
  delete legacy.score;
  legacy.rtwi = 7.5;
  const [item] = buildWallSnapshot([legacy]);
  assert.equal(item.score, 7.5);
});

test("clustering merges close levels and uses a volume weighted price", () => {
  const result = buildWallSnapshot([
    wall({ price: 100, S: 100000, pct: 1.0 }),
    wall({ price: 100.04, S: 300000, pct: 1.04 }),
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].S, 400000);
  assert.equal(result[0].count, 8);
  // Weighted toward the larger 300k level rather than a plain average.
  assert.ok(result[0].price > 100.02 && result[0].price <= 100.04);
});

test("different symbols, sides and markets are never merged", () => {
  const result = buildWallSnapshot([
    wall({ base: "AAA", sym: "AAAUSDT" }),
    wall({ base: "BBB", sym: "BBBUSDT" }),
    wall({ base: "AAA", sym: "AAAUSDT", side: "ask" }),
    wall({ base: "AAA", sym: "AAAUSDT_SPOT", market: "spot" }),
  ]);
  assert.equal(result.length, 4);
});

test("snapshot generation does not mutate input objects", () => {
  const original = wall();
  delete original.wallK;
  const result = buildWallSnapshot([original]);
  assert.notEqual(result[0], original);
  assert.equal(original.wallK, undefined);
});

test("per-coin ladder cap applies per exchange, not globally", () => {
  const input = [];
  for (const ex of ["BN", "BB", "OX"]) {
    for (let i = 0; i < 4; i++) {
      input.push(wall({
        ex,
        sym: `${ex}-AAAUSDT`,
        price: 100 + i * 5,
        pct: 0.5 + i * 0.5,
        score: 9 - i,
        rtwi: 9 - i,
      }));
    }
  }

  const result = buildWallSnapshot(input, { maxPerCoin: 2, maxOutput: 50 });
  assert.equal(result.length, 6);
  assert.deepEqual(new Set(result.map(w => w.ex)), new Set(["BN", "BB", "OX"]));
});

test("cluster preserves the full first-seen to last-seen lifetime", () => {
  const [item] = buildWallSnapshot([
    wall({ price: 100, S: 100000, firstSeenAt: 1000, lastSeenAt: 4000 }),
    wall({ price: 100.05, S: 120000, pct: 1.05, firstSeenAt: 2000, lastSeenAt: 5000 }),
  ]);
  assert.equal(item.firstSeenAt, 1000);
  assert.equal(item.lastSeenAt, 5000);
  assert.equal(item.lifeMs, 4000);
});

test("every exchange keeps output slots when a loud venue dominates", () => {
  const input = [];
  // Two very loud venues with many strong walls.
  for (const ex of ["BX", "OX"]) {
    for (let i = 0; i < 60; i++) {
      input.push(wall({
        ex,
        base: `L${i}`,
        sym: `L${i}USDT`,
        price: 10 + i,
        score: 14 - i * 0.01,
        rtwi: 14 - i * 0.01,
      }));
    }
  }
  // Nine quiet venues with weaker but still publishable walls.
  for (const ex of ["BN", "BB", "BG", "GT", "MX", "KC", "HT", "HL", "AD"]) {
    for (let i = 0; i < 4; i++) {
      input.push(wall({
        ex,
        base: `Q${ex}${i}`,
        sym: `Q${ex}${i}USDT`,
        price: 500 + i,
        score: 6.0,
        rtwi: 6.0,
      }));
    }
  }

  const result = buildWallSnapshot(input, { maxOutput: 40, maxPerCoin: 6 });
  assert.equal(result.length, 40);
  const venues = new Set(result.map(w => w.ex));
  assert.equal(venues.size, 11, `expected all 11 venues, got ${venues.size}`);
});

test("reserved slots are skipped when everything fits", () => {
  const input = [wall(), wall({ ex: "BB", sym: "AAAUSDT-BB" })];
  const result = buildWallSnapshot(input, { maxOutput: 100 });
  assert.equal(result.length, 2);
});

test("clusterWalls returns an empty array for empty input", () => {
  assert.deepEqual(clusterWalls([]), []);
  assert.deepEqual(clusterWalls(null), []);
});

test("confluence boosts a level defended on several exchanges", () => {
  const shared = [
    wall({ ex: "BN", price: 100, score: 6, rtwi: 6, significance: 0.5, rank: 6 }),
    wall({ ex: "BB", sym: "AAAUSDT-BB", price: 100.1, score: 6, rtwi: 6, significance: 0.5, rank: 6 }),
    wall({ ex: "OX", sym: "AAA-USDT-SWAP", price: 100.15, score: 6, rtwi: 6, significance: 0.5, rank: 6 }),
  ];
  const [first] = applyConfluence(shared);
  assert.equal(first.confluence, 3);
  assert.ok(first.score > 6);
  assert.deepEqual(new Set(first.confluenceExchanges), new Set(["BN", "BB", "OX"]));
});

test("confluence leaves an isolated single-venue level untouched", () => {
  const [only] = applyConfluence([wall({ score: 6, rtwi: 6 })]);
  assert.equal(only.confluence, 1);
  assert.equal(only.score, 6);
});

test("confluence does not group prices that are far apart", () => {
  const result = applyConfluence([
    wall({ ex: "BN", price: 100 }),
    wall({ ex: "BB", sym: "AAAUSDT-BB", price: 140 }),
  ]);
  assert.equal(result[0].confluence, 1);
  assert.equal(result[1].confluence, 1);
});
