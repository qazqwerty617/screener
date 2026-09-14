"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-venue asset identity.
//
// The same asset trades under different tickers: `1000PEPE` on BN/BB/BX, `PEPE`
// on OX/GT/MX/KC/AD/HT/BG, `kPEPE` on HL; `BTC` everywhere except KuCoin, which
// uses `XBT`. 26 assets are split this way.
//
// Two features key on the base, and both were silently broken by it:
//   - cross-exchange confluence, the strongest signal a multi-venue scanner can
//     produce, never fired for any of those assets
//   - the per-coin output cap gave each naming variant its own three slots, so one
//     asset could occupy nine
//
// Normalising the name is only half of it: `1000PEPE` at 0.008 and `PEPE` at
// 0.000008 are the same price, so the price comparison has to be normalised too.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalAsset,
  canonicalBase,
  applyConfluence,
  buildWallSnapshot,
} = require("../wallScanner");

function wall(over = {}) {
  return {
    base: "PEPE",
    ex: "BN",
    sym: "PEPEUSDT",
    side: "bid",
    market: "futures",
    price: 0.000008,
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

// ── Name normalisation ───────────────────────────────────────────────────────

test("contract-multiplier prefixes collapse to one asset", () => {
  for (const [input, expected, scale] of [
    ["1000PEPE", "PEPE", 1 / 1000],
    ["10000SATS", "SATS", 1 / 10000],
    ["1000000MOG", "MOG", 1 / 1000000],
    ["kPEPE", "PEPE", 1 / 1000],
    ["kBONK", "BONK", 1 / 1000],
    ["PEPE", "PEPE", 1],
  ]) {
    const a = canonicalAsset(input);
    assert.equal(a.base, expected, `${input} -> ${a.base}`);
    assert.ok(Math.abs(a.scale - scale) < 1e-12, `${input} scale ${a.scale}, expected ${scale}`);
  }
});

test("assets whose names begin with K are not treated as kilo tickers", () => {
  // Hyperliquid's 1000x marker is a lowercase `k` on an uppercase ticker. KDA,
  // KSM, KAS, KAVA and KNC are real assets; stripping their K would merge them
  // into DA, SM, AS, AVA and NC.
  for (const base of ["KDA", "KSM", "KAS", "KAVA", "KNC", "KAIA"]) {
    const a = canonicalAsset(base);
    assert.equal(a.base, base, `${base} must survive intact, got ${a.base}`);
    assert.equal(a.scale, 1, `${base} must not carry a multiplier`);
  }
});

test("XBT is BTC", () => {
  assert.equal(canonicalBase("XBT"), "BTC");
  assert.equal(canonicalBase("BTC"), "BTC");
});

test("separators and quote suffixes are stripped", () => {
  assert.equal(canonicalBase("BTC-USDT"), "BTC");
  assert.equal(canonicalBase("BTC_USDT"), "BTC");
  assert.equal(canonicalBase("XBTUSDTM"), "BTC");
  assert.equal(canonicalBase("SOLUSDC"), "SOL");
});

test("a single-letter or short name is not mangled", () => {
  assert.equal(canonicalBase("K"), "K");
  assert.equal(canonicalBase("OP"), "OP");
  assert.equal(canonicalBase(""), "");
  assert.equal(canonicalBase(null), "");
  assert.equal(canonicalBase(undefined), "");
});

test("the kilo marker requires at least two characters after it", () => {
  // `kX` is not a Hyperliquid kilo ticker.
  assert.equal(canonicalAsset("kX").base, "KX");
  assert.equal(canonicalAsset("kX").scale, 1);
});

test("a numeric prefix is only stripped when a name follows", () => {
  // "1000" on its own is not an asset with a multiplier.
  assert.equal(canonicalAsset("1000").base, "1000");
  assert.equal(canonicalAsset("1000").scale, 1);
});

// ── Confluence across naming variants ────────────────────────────────────────

test("the same level on differently-named tickers is one confluence group", () => {
  // 1000PEPE at 0.008 on Binance is the same price as PEPE at 0.000008 on OKX.
  const walls = [
    wall({ ex: "BN", base: "1000PEPE", sym: "1000PEPEUSDT", price: 0.008 }),
    wall({ ex: "OX", base: "PEPE", sym: "PEPE-USDT-SWAP", price: 0.000008 }),
    wall({ ex: "HL", base: "kPEPE", sym: "kPEPE", price: 0.008 }),
  ];
  applyConfluence(walls);
  for (const w of walls) {
    assert.equal(w.confluence, 3, `${w.ex}/${w.base}: confluence ${w.confluence}, expected 3`);
    assert.deepEqual(new Set(w.confluenceExchanges), new Set(["BN", "OX", "HL"]));
  }
});

test("confluence boosts score, significance and rank", () => {
  const walls = [
    wall({ ex: "BN", base: "1000PEPE", price: 0.008, score: 8, significance: 0.5, rank: 6 }),
    wall({ ex: "OX", base: "PEPE", price: 0.000008, score: 8, significance: 0.5, rank: 6 }),
  ];
  applyConfluence(walls);
  for (const w of walls) {
    assert.ok(w.score > 8, `score must be boosted, got ${w.score}`);
    assert.ok(w.significance > 0.5, `significance must be boosted, got ${w.significance}`);
    assert.ok(w.rank > 6, `rank must be boosted, got ${w.rank}`);
    assert.equal(w.rtwi, w.score, "rtwi must track score");
  }
});

test("genuinely different prices are not merged just because the name matches", () => {
  const walls = [
    wall({ ex: "BN", base: "1000PEPE", price: 0.008 }),
    // 5% away on the unit scale — a different level entirely.
    wall({ ex: "OX", base: "PEPE", price: 0.0000084 }),
  ];
  applyConfluence(walls);
  assert.equal(walls[0].confluence, 1);
  assert.equal(walls[1].confluence, 1);
});

test("different assets are never merged", () => {
  const walls = [
    wall({ ex: "BN", base: "PEPE", price: 0.000008 }),
    wall({ ex: "OX", base: "SHIB", price: 0.000008 }),
  ];
  applyConfluence(walls);
  assert.equal(walls[0].confluence, 1);
  assert.equal(walls[1].confluence, 1);
});

test("opposite sides of the book are never merged", () => {
  const walls = [
    wall({ ex: "BN", base: "1000PEPE", price: 0.008, side: "bid" }),
    wall({ ex: "OX", base: "PEPE", price: 0.000008, side: "ask" }),
  ];
  applyConfluence(walls);
  assert.equal(walls[0].confluence, 1);
  assert.equal(walls[1].confluence, 1);
});

test("a lone wall reports confluence 1 with its own USD", () => {
  const walls = [wall({ S: 250000 })];
  applyConfluence(walls);
  assert.equal(walls[0].confluence, 1);
  assert.equal(walls[0].confluenceUsd, 250000);
  assert.deepEqual(walls[0].confluenceExchanges, ["BN"]);
});

// ── Per-coin cap ─────────────────────────────────────────────────────────────

test("the per-coin cap counts naming variants as one asset", () => {
  // Same venue, same asset, three ticker spellings, four ladder levels each.
  const input = [];
  for (const base of ["1000PEPE", "PEPE", "kPEPE"]) {
    for (let i = 0; i < 4; i++) {
      input.push(wall({
        ex: "BN",
        base,
        sym: `${base}USDT`,
        // Distinct prices so clusterWalls does not merge them.
        price: 0.008 * (1 + i * 0.05),
        pct: 0.5 + i * 0.5,
        score: 9 - i * 0.1,
        rtwi: 9 - i * 0.1,
      }));
    }
  }
  const result = buildWallSnapshot(input, { maxPerCoin: 3, maxOutput: 100 });
  assert.equal(result.length, 3,
    `one asset on one venue must occupy at most 3 slots, got ${result.length}`);
});

test("the same asset on different venues keeps its own slots", () => {
  const input = [];
  for (const ex of ["BN", "OX", "MX"]) {
    for (let i = 0; i < 4; i++) {
      input.push(wall({
        ex,
        base: "PEPE",
        sym: `${ex}-PEPEUSDT`,
        price: 0.000008 * (1 + i * 0.05),
        pct: 0.5 + i * 0.5,
        score: 9 - i * 0.1,
        rtwi: 9 - i * 0.1,
      }));
    }
  }
  const result = buildWallSnapshot(input, { maxPerCoin: 2, maxOutput: 100 });
  assert.equal(result.length, 6, "the cap is per exchange+asset, not global");
  assert.deepEqual(new Set(result.map(w => w.ex)), new Set(["BN", "OX", "MX"]));
});
