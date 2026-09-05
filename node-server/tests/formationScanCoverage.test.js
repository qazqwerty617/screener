"use strict";
// Guards the scanner's coverage model and the cooldown persistence that the
// user's report exposed:
//   * only ~5-10 coins ever alerted, because the 1500-ticker cap was consumed
//     by the same asset repeated across up to 12 venues
//   * a 5-15 minute cooldown behaved like 30 seconds, because the maps lived
//     only in memory and the process restarted constantly
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extractFn(signature, name) {
  const re = new RegExp(`function ${name}\\(${signature}\\) \\{[\\s\\S]*?\\n  \\}`);
  const m = re.exec(SRC);
  assert.ok(m, `${name} must exist in server.js`);
  return new Function(`${m[0]}; return ${name};`)();
}

const normalizeCoinKey = extractFn("t", "normalizeCoinKey");

function extractVenueAssigner() {
  const quota = /const SCAN_VENUE_QUOTA = \{[\s\S]*?\n  \};/.exec(SRC);
  const fallback = /const SCAN_VENUE_FALLBACK_QUOTA = ([\d.]+);/.exec(SRC);
  const fn = /function assignScanVenues\(perCoin\) \{[\s\S]*?\n  \}/.exec(SRC);
  assert.ok(quota && fallback && fn, "venue quota assignment must exist in server.js");
  const norm = /function normalizeCoinKey\(t\) \{[\s\S]*?\n  \}/.exec(SRC);
  const code = `
    ${quota[0]}
    const SCAN_VENUE_FALLBACK_QUOTA = ${fallback[1]};
    ${norm[0]}
    const scanAllPatterns = {};
    ${fn[0]}
    return { assignScanVenues, scanAllPatterns, SCAN_VENUE_QUOTA };
  `;
  return new Function(code)();
}

test("the same asset on different venues collapses to one coin", () => {
  const variants = [
    { key: "BN:BTCUSDT", base: "BTC" },
    { key: "MX:BTC_USDT", base: "BTC" },
    { key: "BB:BTCUSDT" },
    { key: "KC:XBTUSDTM", base: "BTC" },
    { key: "BX:BTC-USDT", base: "BTC" },
    { key: "HL:BTC", base: "BTC" }
  ];
  const keys = new Set(variants.map(normalizeCoinKey));
  assert.equal(keys.size, 1, `expected one coin, got ${[...keys].join(",")}`);
  assert.equal([...keys][0], "BTC");
});

test("1000x-multiplier symbols map to the underlying coin", () => {
  assert.equal(normalizeCoinKey({ key: "BN:1000PEPEUSDT" }), "PEPE");
  assert.equal(normalizeCoinKey({ key: "MX:PEPE_USDT" }), "PEPE");
  assert.equal(normalizeCoinKey({ key: "BB:1000000MOGUSDT" }), "MOG");
});

test("spot and futures of one asset are the same coin", () => {
  assert.equal(
    normalizeCoinKey({ key: "BN:ETHUSDT_SPOT" }),
    normalizeCoinKey({ key: "BN:ETHUSDT" })
  );
});

test("distinct assets stay distinct", () => {
  const seen = new Set(["BTC", "ETH", "SOL", "DOGE", "ADA", "LINK"].map(b => normalizeCoinKey({ key: `BN:${b}USDT` })));
  assert.equal(seen.size, 6);
});

test("the scanner no longer truncates the universe", () => {
  assert.ok(!SRC.includes(".slice(0, 1500); // Expanded"), "the 1500-ticker cap must be gone");
  assert.match(SRC, /const perCoin = new Map\(\);/);
  assert.match(SRC, /const list = assignScanVenues\(perCoin\);/);
});

test("every coin is scanned exactly once", () => {
  const { assignScanVenues } = extractVenueAssigner();
  const perCoin = new Map();
  for (let i = 0; i < 1800; i++) {
    const coin = "C" + i;
    // Each coin is listed on 1-4 venues, as in the live feed.
    const venues = ["BN", "BB", "MX", "GT"].slice(0, 1 + (i % 4));
    perCoin.set(coin, venues.map((ex, k) => ({ key: `${ex}:${coin}USDT`, base: coin, v: 1e8 - i * 1000 - k })));
  }
  const list = assignScanVenues(perCoin);
  assert.equal(list.length, perCoin.size, "one entry per coin");
  const coins = new Set(list.map(t => t.base));
  assert.equal(coins.size, perCoin.size, "no coin scanned twice");
});

test("no single exchange takes more than its quota", () => {
  const { assignScanVenues, SCAN_VENUE_QUOTA } = extractVenueAssigner();
  const perCoin = new Map();
  // Realistic feed: every coin is on Binance plus a few others, and Binance is
  // usually the most liquid — the exact shape that earned the IP ban.
  for (let i = 0; i < 1800; i++) {
    const coin = "C" + i;
    perCoin.set(coin, [
      { key: `BN:${coin}USDT`, base: coin, v: 1e9 - i },
      { key: `BB:${coin}USDT`, base: coin, v: 1e6 },
      { key: `MX:${coin}_USDT`, base: coin, v: 1e5 },
      { key: `GT:${coin}_USDT`, base: coin, v: 1e4 },
      { key: `BG:${coin}USDT`, base: coin, v: 1e3 },
      { key: `KC:${coin}USDTM`, base: coin, v: 900 },
      { key: `BX:${coin}-USDT`, base: coin, v: 800 },
      { key: `HT:${coin}-USDT`, base: coin, v: 700 },
      { key: `OX:${coin}-USDT-SWAP`, base: coin, v: 600 }
    ]);
  }
  const list = assignScanVenues(perCoin);
  const byEx = {};
  for (const t of list) {
    const ex = t.key.split(":")[0];
    byEx[ex] = (byEx[ex] || 0) + 1;
  }
  const bnShare = (byEx.BN || 0) / list.length;
  assert.ok(
    bnShare <= SCAN_VENUE_QUOTA.BN + 0.02,
    `Binance took ${(bnShare * 100).toFixed(0)}% of the scan, quota is ${(SCAN_VENUE_QUOTA.BN * 100).toFixed(0)}% (spread: ${JSON.stringify(byEx)})`
  );
  assert.ok(Object.keys(byEx).length >= 5, `expected spread across venues, got ${JSON.stringify(byEx)}`);
});

test("overflow goes to the least loaded venue, not the busiest", () => {
  const { assignScanVenues } = extractVenueAssigner();
  const perCoin = new Map();
  // Only two venues exist, so quotas (16% each) cannot cover 100 coins and every
  // coin past the quota is overflow.
  for (let i = 0; i < 100; i++) {
    const coin = "C" + i;
    perCoin.set(coin, [
      { key: `BN:${coin}USDT`, base: coin, v: 1e9 - i },
      { key: `BB:${coin}USDT`, base: coin, v: 1e8 - i }
    ]);
  }
  const list = assignScanVenues(perCoin);
  const byEx = {};
  for (const t of list) {
    const ex = t.key.split(":")[0];
    byEx[ex] = (byEx[ex] || 0) + 1;
  }
  assert.equal(list.length, 100, "all coins still covered");
  const ratio = (byEx.BN || 0) / (byEx.BB || 1);
  assert.ok(ratio > 0.7 && ratio < 1.4, `overflow must be balanced, got ${JSON.stringify(byEx)}`);
});

test("a coin listed on one venue only is still scanned there", () => {
  const { assignScanVenues } = extractVenueAssigner();
  const perCoin = new Map();
  // Saturate Binance with majors first.
  for (let i = 0; i < 500; i++) {
    perCoin.set("M" + i, [{ key: `BN:M${i}USDT`, base: "M" + i, v: 1e9 - i }]);
  }
  perCoin.set("ONLYBN", [{ key: "BN:ONLYBNUSDT", base: "ONLYBN", v: 1 }]);
  const list = assignScanVenues(perCoin);
  assert.ok(list.some(t => t.base === "ONLYBN"), "coverage must not drop a single-venue coin");
});

test("the most liquid venue still wins while quota allows", () => {
  const { assignScanVenues } = extractVenueAssigner();
  const perCoin = new Map([
    ["BTC", [
      { key: "MX:BTC_USDT", base: "BTC", v: 1e8 },
      { key: "BN:BTCUSDT", base: "BTC", v: 5e9 }
    ]]
  ]);
  const list = assignScanVenues(perCoin);
  assert.equal(list[0].key, "BN:BTCUSDT");
});

test("deduplication keeps the most liquid venue for each coin", () => {
  // Mirror the selection loop.
  const tickers = [
    { key: "BN:BTCUSDT", base: "BTC", v: 5e9, p: 1 },
    { key: "MX:BTC_USDT", base: "BTC", v: 1e8, p: 1 },
    { key: "GT:BTC_USDT", base: "BTC", v: 3e8, p: 1 }
  ];
  const perCoin = new Map();
  for (const t of tickers) {
    const coin = normalizeCoinKey(t);
    if (!perCoin.has(coin)) perCoin.set(coin, []);
    perCoin.get(coin).push(t);
  }
  assert.equal(perCoin.size, 1);
  const { assignScanVenues } = extractVenueAssigner();
  const list = assignScanVenues(perCoin);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, "BN:BTCUSDT", "the highest-volume venue must win");
});

test("the timeframe set is trimmed to what actually produces signal", () => {
  const m = /const activeTimeframes = (\[[^\]]*\]);/.exec(SRC);
  assert.ok(m, "activeTimeframes must be defined");
  const tfs = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(!tfs.includes("1m"), "1m was pure noise and a fifth of the cycle cost");
  assert.ok(tfs.length <= 3, `expected at most 3 timeframes, got ${tfs.join(",")}`);
  assert.ok(tfs.includes("5m") && tfs.includes("15m") && tfs.includes("1h"));
});

test("the per-coin cooldown key ignores the venue", () => {
  // Same coin on two exchanges must share one cooldown slot, otherwise the user
  // receives the same formation once per venue.
  assert.match(SRC, /const coinKey = `\$\{userId\}:\$\{normalizeCoinKey\(\{ base, key: `\$\{ex\}:\$\{sym\}` \}\)\}`;/);
});

test("cooldowns are persisted and restored across restarts", () => {
  assert.match(SRC, /const FORMATION_COOLDOWN_FILE = path\.join\(__dirname, "formation_cooldowns\.json"\);/);
  assert.match(SRC, /function loadFormationCooldowns\(\)/);
  assert.match(SRC, /function saveFormationCooldowns\(force = false\)/);
  assert.match(SRC, /loadFormationCooldowns\(\);/);
  assert.match(SRC, /saveFormationCooldowns\(\);/, "must save after arming a cooldown");
  // Flushed on the way out so a graceful restart keeps the windows.
  assert.match(SRC, /for \(const sig of \["SIGINT", "SIGTERM"\]\)/);
  assert.match(SRC, /saveFormationCooldowns\(true\);/);
});

test("restored cooldowns reject expired and future-dated entries", () => {
  const m = /function loadFormationCooldowns\(\) \{[\s\S]*?\n  \}/.exec(SRC);
  assert.ok(m);
  const body = m[0];
  assert.match(body, /n > now \+ 60000/, "clock-skewed future stamps must be dropped");
  assert.match(body, /now - n > FORMATION_COOLDOWN_TTL_MS/, "expired stamps must be dropped");
});

test("the persisted file is written atomically", () => {
  const m = /function saveFormationCooldowns\(force = false\) \{[\s\S]*?\n  \}/.exec(SRC);
  assert.ok(m);
  assert.match(m[0], /const tmp = `\$\{FORMATION_COOLDOWN_FILE\}\.tmp`;/);
  assert.match(m[0], /fs\.renameSync\(tmp, FORMATION_COOLDOWN_FILE\);/);
});

test("full-universe coverage is now feasible within the cooldown window", () => {
  // Measured on the server: ~128 ms per (coin x timeframe) fetch.
  const MS_PER_UNIT = 128;
  const COINS = 1825;   // unique assets behind ~7500 tickers
  const TFS = 3;
  const minutes = COINS * TFS * MS_PER_UNIT / 1000 / 60;
  assert.ok(minutes < 15, `a full pass takes ${minutes.toFixed(1)} min and must fit the 15-min coin window`);
});
