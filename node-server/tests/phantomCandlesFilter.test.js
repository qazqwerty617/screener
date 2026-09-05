"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Extract cleanPhantomWicksAndCandles from public/js/app.js
const appJs = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
const fnMatch = appJs.match(/function cleanPhantomWicksAndCandles\(candles\) \{[\s\S]*?\n\}/);
assert.ok(fnMatch, "cleanPhantomWicksAndCandles function must exist in app.js");
const cleanPhantomWicksAndCandles = new Function("candles", fnMatch[0] + "\nreturn cleanPhantomWicksAndCandles(candles);");

test("cleanPhantomWicksAndCandles clamps an isolated massive downward phantom wick (like BTC 64000)", () => {
  const candles = [
    { t: 1000, o: 81000, h: 81200, l: 80900, c: 81100, v: 10 },
    { t: 2000, o: 81100, h: 81150, l: 80800, c: 80900, v: 10 },
    { t: 3000, o: 80900, h: 81000, l: 79500, c: 79800, v: 10 },
    { t: 4000, o: 79800, h: 79900, l: 79300, c: 79600, v: 10 },
    { t: 5000, o: 79600, h: 79700, l: 64000, c: 79483, v: 10 }, // 64,000 phantom wick from user screenshot
    { t: 6000, o: 79483, h: 79600, l: 79300, c: 79550, v: 10 },
  ];

  const cleaned = cleanPhantomWicksAndCandles(candles);
  assert.equal(cleaned.length, 6);
  // The 64,000 wick must be clamped near the neighbor low (~79,300), NOT 64,000
  assert.ok(cleaned[4].l > 75000, `Expected low to be clamped above 75000, got ${cleaned[4].l}`);
  assert.ok(cleaned[4].l <= cleaned[4].c, "Low must be <= Close");
  assert.ok(cleaned[4].l <= cleaned[4].o, "Low must be <= Open");
});

test("cleanPhantomWicksAndCandles clamps an isolated upward phantom wick", () => {
  const candles = [
    { t: 1000, o: 100, h: 102, l: 99, c: 101, v: 10 },
    { t: 2000, o: 101, h: 103, l: 100, c: 102, v: 10 },
    { t: 3000, o: 102, h: 180, l: 101, c: 103, v: 10 }, // +75% isolated spike
    { t: 4000, o: 103, h: 104, l: 102, c: 103, v: 10 },
    { t: 5000, o: 103, h: 105, l: 102, c: 104, v: 10 },
  ];

  const cleaned = cleanPhantomWicksAndCandles(candles);
  assert.equal(cleaned.length, 5);
  // The 180 spike must be clamped
  assert.ok(cleaned[2].h < 120, `Expected high to be clamped below 120, got ${cleaned[2].h}`);
  assert.ok(cleaned[2].h >= cleaned[2].c, "High must be >= Close");
});

test("cleanPhantomWicksAndCandles preserves legitimate normal price action", () => {
  const candles = [
    { t: 1000, o: 100, h: 103, l: 97, c: 101, v: 10 },
    { t: 2000, o: 101, h: 104, l: 98, c: 102, v: 10 },
    { t: 3000, o: 102, h: 105, l: 99, c: 104, v: 10 },
    { t: 4000, o: 104, h: 106, l: 101, c: 105, v: 10 },
  ];

  const cleaned = cleanPhantomWicksAndCandles(candles);
  assert.deepEqual(cleaned, candles, "Normal candles must not be mutated");
});

test("cleanPhantomWicksAndCandles drops alien phantom candles from other coins", () => {
  const candles = [
    { t: 1000, o: 80000, h: 80500, l: 79800, c: 80200, v: 10 },
    { t: 2000, o: 80200, h: 80300, l: 79900, c: 80100, v: 10 },
    { t: 3000, o: 64, h: 65, l: 63, c: 64, v: 10 }, // DASH/ZEC price accidentally mixed in
    { t: 4000, o: 80100, h: 80400, l: 80000, c: 80300, v: 10 },
    { t: 5000, o: 80300, h: 80600, l: 80200, c: 80500, v: 10 },
  ];

  const cleaned = cleanPhantomWicksAndCandles(candles);
  assert.equal(cleaned.length, 4, "Alien phantom candle must be dropped");
  assert.ok(cleaned.every(c => c.c > 70000), "All remaining candles must have valid price");
});

test("server.js publishMarketTrade rejects outlier trade prints deviating > 35%", () => {
  const serverJs = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverJs, /ticker\.p \* 1\.35/);
  assert.match(serverJs, /ticker\.p \* 0\.65/);
});

test("app.js applyMainMarketTick rejects outlier ticks deviating > 15%", () => {
  assert.match(appJs, /price > refPrice \* \(1 \+ maxDev\)/);
  assert.match(appJs, /price < refPrice \* \(1 - maxDev\)/);
});

test("server.js rejects stale Go scanner klines and klines with huge gaps", () => {
  const serverJs = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverJs, /Date\.now\(\) - lastC\.t < maxStaleMs/);
  assert.match(serverJs, /dataGo\[i\]\.t - dataGo\[i - 1\]\.t > maxAllowedGapMs/);
});

test("sanitizeCandles truncates ancient disconnected historical candles (e.g. July 14 vs Sept 4)", () => {
  // Simulate candles array: 5 candles from July 14th at 64k, followed by 5 candles from Sept 4 at 79.5k
  const julyTs = 1784040540000;
  const septTs = 1788530400000;
  const rawList = [
    { t: julyTs, o: 64000, h: 64100, l: 63900, c: 64050, v: 10 },
    { t: julyTs + 60000, o: 64050, h: 64150, l: 63950, c: 64080, v: 10 },
    { t: julyTs + 120000, o: 64080, h: 64200, l: 64000, c: 64150, v: 10 },
    // 52-day time jump to September
    { t: septTs, o: 79400, h: 79500, l: 79350, c: 79450, v: 10 },
    { t: septTs + 60000, o: 79450, h: 79550, l: 79400, c: 79500, v: 10 },
    { t: septTs + 120000, o: 79500, h: 79600, l: 79450, c: 79550, v: 10 },
  ];

  // Extract sanitizeCandles and dependencies from app.js
  const fnSanitizeMatch = appJs.match(/function sanitizeCandles\(list, maxLimit = 3000\) \{[\s\S]*?\n\}/);
  assert.ok(fnSanitizeMatch, "sanitizeCandles function must exist in app.js");
  const fnSanitizeOneMatch = appJs.match(/function sanitizeCandle\(raw, prevClose = null\) \{[\s\S]*?\n\}/);
  const tfMsDef = "const TF_MS = { '1m': 60000 }; const activeTf = '1m';\n";
  const runner = new Function("list", tfMsDef + fnSanitizeOneMatch[0] + "\n" + fnMatch[0] + "\n" + fnSanitizeMatch[0] + "\nreturn sanitizeCandles(list);");

  const cleaned = runner(rawList);
  // The ancient July candles must be pruned, only September candles must remain!
  assert.equal(cleaned.length, 3, `Expected only 3 September candles, got ${cleaned.length}`);
  assert.ok(cleaned.every(c => c.c > 75000), "All retained candles must be around 79,500");
});

test("mergeCandles drops disconnected ancient remnants from existingList", () => {
  const julyTs = 1784040540000;
  const septTs = 1788530400000;
  const existingList = [
    { t: julyTs, o: 64000, h: 64100, l: 63900, c: 64050, v: 10 },
    { t: julyTs + 60000, o: 64050, h: 64150, l: 63950, c: 64080, v: 10 }
  ];
  const incomingList = [
    { t: septTs, o: 79400, h: 79500, l: 79350, c: 79450, v: 10 },
    { t: septTs + 60000, o: 79450, h: 79550, l: 79400, c: 79500, v: 10 }
  ];

  const fnSanitizeMatch = appJs.match(/function sanitizeCandles\(list, maxLimit = 3000\) \{[\s\S]*?\n\}/);
  const fnSanitizeOneMatch = appJs.match(/function sanitizeCandle\(raw, prevClose = null\) \{[\s\S]*?\n\}/);
  const fnMergeMatch = appJs.match(/function mergeCandles\(existingList, incomingList, maxLimit = 3000\) \{[\s\S]*?\n\}/);
  assert.ok(fnMergeMatch, "mergeCandles must exist in app.js");
  const tfMsDef = "const TF_MS = { '1m': 60000 }; const activeTf = '1m';\n";
  const runner = new Function("existing, incoming", tfMsDef + fnSanitizeOneMatch[0] + "\n" + fnMatch[0] + "\n" + fnSanitizeMatch[0] + "\n" + fnMergeMatch[0] + "\nreturn mergeCandles(existing, incoming);");

  const merged = runner(existingList, incomingList);
  assert.equal(merged.length, 2, `Expected only 2 incoming candles, got ${merged.length}`);
  assert.ok(merged.every(c => c.c > 75000), "Ancient July candles must not be merged into live series");
});
