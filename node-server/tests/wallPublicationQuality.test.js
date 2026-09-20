"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildWallSnapshot,
  isTradableBase,
  qualityProfileFor,
  getTierThresholds,
  registerVenueAssetMetadata,
} = require("../wallScanner");

function wall(overrides = {}) {
  const base = overrides.base || "AAA";
  const ex = overrides.ex || "BB";
  return {
    base,
    ex,
    sym: overrides.sym || `${base}USDT`,
    side: "bid",
    market: "futures",
    price: 100,
    S: 2_000_000,
    pct: 0.5,
    score: 12,
    rtwi: 12,
    rank: 8,
    v: 20_000_000,
    dominance: 30,
    depthShare: 0.25,
    volMinutes: 3,
    persistence: 0.5,
    confirmations: 5,
    ...overrides,
  };
}

test("publication never cuts genuine walls merely to hit an output count", () => {
  const input = Array.from({ length: 420 }, (_, i) => wall({
    base: `Q${String(i).padStart(4, "0")}`,
    sym: `Q${String(i).padStart(4, "0")}USDT`,
    price: 100 + i,
  }));

  const snapshot = buildWallSnapshot(input);
  assert.equal(snapshot.length, input.length,
    "a count target must not discard walls that independently pass every quality gate");
});

test("stablecoins and tokenized companies are rejected by base identity", () => {
  const excluded = [
    ["USDT", "USDTUSDT"],
    ["USDE", "USDEUSDT"],
    ["SAMSUNG", "SAMSUNGUSDT"],
    ["ANTHROPIC", "ANTHROPICUSDT"],
    ["OPENAI", "OPENAIUSDT"],
    ["RSAMSUNG", "RSAMSUNGUSDT"],
  ];

  for (const [base, sym] of excluded) {
    assert.equal(isTradableBase(base, sym), false, `${base} must not enter the crypto density universe`);
  }

  assert.equal(isTradableBase("BTC", "BTCUSDT"), true);
  assert.equal(isTradableBase("SOL", "SOLUSDT"), true);
  assert.equal(isTradableBase("FUTURECOMPANY", "FUTURECOMPANYUSDT", { isRwa: "YES" }), false,
    "venue metadata must exclude newly listed equities before a curated name exists");
});

test("Bitget propagates its authoritative RWA flag into the density universe", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "exchanges", "bitget.js"), "utf8");
  assert.match(source, /market\/contracts\?productType=USDT-FUTURES/);
  assert.match(source, /String\(item\.isRwa\)\.toUpperCase\(\) === "YES"/);
  assert.match(source, /isRwa: rwaSymbols\.has\(d\.symbol\)/);
});

test("venue metadata blacklists future stock tickers across every exchange", () => {
  const uniqueEquity = "FUTUREEQUITYXYZ";
  assert.equal(isTradableBase(uniqueEquity, `${uniqueEquity}USDT`), true);
  registerVenueAssetMetadata([{ symbol: `${uniqueEquity}USDT`, baseCoin: uniqueEquity, isRwa: "YES" }]);
  assert.equal(isTradableBase(uniqueEquity, `${uniqueEquity}USDT`), false);
  assert.equal(isTradableBase(`R${uniqueEquity}`, `R${uniqueEquity}_USDT`), false,
    "another venue's R-prefixed alias must inherit the metadata exclusion");
});

test("the existing client blacklist is seeded and migrated with non-crypto bases", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  assert.match(source, /const DEFAULT_DENSITY_BLACKLIST = DENSITY_NON_TRADABLE\.slice\(\);/);
  assert.match(source, /density_blacklist_non_crypto_v2/);
  for (const base of ["USDT", "USDC", "SAMSUNG", "ANTHROPIC", "OPENAI"]) {
    assert.match(source, new RegExp(`"${base}"`));
  }
});

test("snapshot filtering is authoritative even for stale cached walls", () => {
  const input = [
    wall({ base: "BTC", sym: "BTCUSDT", ex: "BN" }),
    wall({ base: "USDC", sym: "USDCUSDT", ex: "BB" }),
    wall({ base: "SAMSUNG", sym: "SAMSUNGUSDT", ex: "BG" }),
    wall({ base: "ANTHROPIC", sym: "ANTHROPICUSDT", ex: "HL" }),
  ];

  assert.deepEqual(buildWallSnapshot(input).map(item => item.base), ["BTC"]);
});

test("venue policy compares evidence instead of forcing equal result counts", () => {
  const binance = qualityProfileFor("BN");
  const bybit = qualityProfileFor("BB");
  const bingx = qualityProfileFor("BX");
  const bitget = qualityProfileFor("BG");
  const hyperliquid = qualityProfileFor("HL");

  assert.ok(bybit.minQuality > hyperliquid.minQuality,
    "a 200-level raw book and a 20-level book must not share one quality bar");
  assert.ok(bitget.minDominance > hyperliquid.minDominance,
    "pre-merged 100-level buckets need more dominance than Hyperliquid's shallow book");
  assert.equal(binance.minConfirmations, 3);
  assert.equal(bybit.minConfirmations, 3);
  assert.equal(bingx.minConfirmations, 3);
  assert.equal(bitget.minConfirmations, 3);
  assert.equal(hyperliquid.minConfirmations, 3,
    "lower structural thresholds must never weaken anti-spoof confirmation");
  assert.ok(bybit.minQuality > binance.minQuality);
  assert.ok(bingx.minQuality > bybit.minQuality,
    "BingX's aggregated book needs the strictest evidence bar of the noisy venues");
});

test("high-output venues reject borderline walls while keeping strong evidence", () => {
  const input = [
    wall({ base: "BNWEAK", sym: "BNWEAKUSDT", ex: "BN", score: 6.3, rtwi: 6.3 }),
    wall({ base: "BNSTRONG", sym: "BNSTRONGUSDT", ex: "BN", score: 9, rtwi: 9 }),
    wall({ base: "BBWEAK", sym: "BBWEAKUSDT", ex: "BB", score: 7, rtwi: 7 }),
    wall({ base: "BBSTRONG", sym: "BBSTRONGUSDT", ex: "BB", score: 9, rtwi: 9 }),
    wall({ base: "BXWEAK", sym: "BXWEAKUSDT", ex: "BX", score: 7.2, rtwi: 7.2 }),
    wall({ base: "BXSTRONG", sym: "BXSTRONGUSDT", ex: "BX", score: 9, rtwi: 9 }),
    wall({ base: "OXWEAK", sym: "OXWEAK-USDT-SWAP", ex: "OX", score: 6.5, rtwi: 6.5 }),
    wall({ base: "OXSTRONG", sym: "OXSTRONG-USDT-SWAP", ex: "OX", score: 9, rtwi: 9 }),
    wall({ base: "MXWEAK", sym: "MXWEAK_USDT", ex: "MX", score: 6.5, rtwi: 6.5 }),
    wall({ base: "MXSTRONG", sym: "MXSTRONG_USDT", ex: "MX", score: 9, rtwi: 9 }),
  ];

  assert.deepEqual(
    new Set(buildWallSnapshot(input).map(item => item.base)),
    new Set(["BNSTRONG", "BBSTRONG", "BXSTRONG", "OXSTRONG", "MXSTRONG"])
  );
});

test("the venue evidence bar removes borderline Bybit noise without starving Hyperliquid", () => {
  const input = [
    wall({ base: "BBWEAK", sym: "BBWEAKUSDT", ex: "BB", score: 6.1, rtwi: 6.1 }),
    wall({ base: "BBSTRONG", sym: "BBSTRONGUSDT", ex: "BB", score: 9, rtwi: 9 }),
    wall({ base: "HLSTRONG", sym: "HLSTRONG", ex: "HL", score: 4.6, rtwi: 4.6, S: 800_000 }),
  ];

  assert.deepEqual(
    new Set(buildWallSnapshot(input).map(item => item.base)),
    new Set(["BBSTRONG", "HLSTRONG"])
  );
});

test("snapshot honours hysteresis only for walls admitted by the lifecycle", () => {
  const borderline = wall({ base: "STEADY", sym: "STEADYUSDT", ex: "BB", score: 5.5, rtwi: 5.5 });
  assert.equal(buildWallSnapshot([borderline]).length, 0,
    "an unverified cached record must clear the full entry bar");
  assert.equal(buildWallSnapshot([{ ...borderline, qualityAdmitted: true }]).length, 1,
    "a previously admitted wall may stay inside the anti-flicker hysteresis band");
});

test("absolute wall floors scale with venue liquidity, not desired result count", () => {
  const bybitBtc = getTierThresholds("BTC", 1_000_000_000, "BB");
  const binanceBtc = getTierThresholds("BTC", 1_000_000_000, "BN");
  const hyperliquidBtc = getTierThresholds("BTC", 1_000_000_000, "HL");
  assert.deepEqual(bybitBtc, { minFloor: 3_750_000, small: 3_750_000, medium: 8_750_000, large: 24_375_000 });
  assert.equal(binanceBtc.minFloor, 3_000_000);
  assert.equal(hyperliquidBtc.minFloor, 300_000);
});

test("Bybit drops a borderline BTC wall that remains eligible on Binance", () => {
  const candidate = { base: "BTC", sym: "BTCUSDT", S: 3_500_000, v: 1_000_000_000 };
  assert.equal(buildWallSnapshot([wall({ ...candidate, ex: "BB" })]).length, 0);
  assert.equal(buildWallSnapshot([wall({ ...candidate, ex: "BN" })]).length, 1);
  assert.equal(buildWallSnapshot([wall({ ...candidate, ex: "BB", S: 4_000_000 })]).length, 1);
});
