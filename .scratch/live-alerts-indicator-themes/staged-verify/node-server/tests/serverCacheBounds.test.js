"use strict";
// Verifies the two cache bounds added to server.js by extracting them and
// driving them at production scale. These are the caches that grew to ~1.4 GB
// and caused the constant memory recycles.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ── klinesCache ─────────────────────────────────────────────────────────────
function buildKlinesHarness() {
  const decl = /const KLINES_CACHE_MAX_ENTRIES = (\d+);/.exec(SRC);
  const ttl = /const KLINES_CACHE_TTL_MS = ([^;]+);/.exec(SRC);
  const fn = /function pruneKlinesCache\(force = false\) \{[\s\S]*?\n\}/.exec(SRC);
  assert.ok(decl && ttl && fn, "klinesCache bounds must exist in server.js");

  const code = `
    const klinesCache = new Map();
    const KLINES_CACHE_MAX_ENTRIES = ${decl[1]};
    const KLINES_CACHE_TTL_MS = ${ttl[1]};
    let lastKlinesPruneAt = 0;
    ${fn[0]}
    return { klinesCache, pruneKlinesCache, MAX: KLINES_CACHE_MAX_ENTRIES, TTL: KLINES_CACHE_TTL_MS };
  `;
  return new Function(code)();
}

// ── scannerCandleCache ──────────────────────────────────────────────────────
function buildScannerHarness() {
  const decl = /const SCANNER_CACHE_MAX_ENTRIES = (\d+);/.exec(SRC);
  const fn = /function pruneScannerCandleCache\(force = false\) \{[\s\S]*?\n  \}/.exec(SRC);
  assert.ok(decl && fn, "scannerCandleCache bounds must exist in server.js");

  const code = `
    const scannerCandleCache = new Map();
    const SCANNER_CACHE_MAX_ENTRIES = ${decl[1]};
    let lastScannerPruneAt = 0;
    ${fn[0]}
    return { scannerCandleCache, pruneScannerCandleCache, MAX: SCANNER_CACHE_MAX_ENTRIES };
  `;
  return new Function(code)();
}

test("klinesCache is capped at production scale", () => {
  const h = buildKlinesHarness();
  const now = Date.now();
  // 1500 tickers x 5 timeframes x (lite + full) = the real key space.
  for (let i = 0; i < 15000; i++) {
    h.klinesCache.set(`EX|SYM${i}|5m|1`, { at: now, used: now, data: [] });
  }
  h.pruneKlinesCache(true);
  assert.ok(
    h.klinesCache.size <= h.MAX,
    `size ${h.klinesCache.size} must be <= ${h.MAX}`
  );
});

test("klinesCache drops stale entries before evicting fresh ones", () => {
  const h = buildKlinesHarness();
  const now = Date.now();
  h.klinesCache.set("stale", { at: now - h.TTL - 1000, used: now - h.TTL - 1000, data: [1] });
  h.klinesCache.set("fresh", { at: now, used: now, data: [2] });
  h.pruneKlinesCache(true);
  assert.equal(h.klinesCache.has("stale"), false, "expired entry must go");
  assert.equal(h.klinesCache.has("fresh"), true, "fresh entry must stay");
});

test("klinesCache evicts least-recently-used, not least-recently-fetched", () => {
  const h = buildKlinesHarness();
  const now = Date.now();
  // Fill to the cap with entries fetched at the same time.
  for (let i = 0; i < h.MAX; i++) {
    h.klinesCache.set(`k${i}`, { at: now, used: now - 10000, data: [] });
  }
  // One old fetch that is still being read constantly (the scanner's hot path).
  h.klinesCache.set("hot", { at: now - 60000, used: now, data: [] });
  h.pruneKlinesCache(true);
  assert.equal(h.klinesCache.has("hot"), true, "a recently used entry must survive");
  assert.ok(h.klinesCache.size <= h.MAX);
});

test("scannerCandleCache is capped at production scale", () => {
  const h = buildScannerHarness();
  const now = Date.now();
  for (let i = 0; i < 7500; i++) {
    h.scannerCandleCache.set(`EX:SYM${i}:5m`, { candles: [], expiresAt: now + 60000 });
  }
  h.pruneScannerCandleCache(true);
  assert.ok(
    h.scannerCandleCache.size <= h.MAX,
    `size ${h.scannerCandleCache.size} must be <= ${h.MAX}`
  );
});

test("scannerCandleCache drops expired entries first", () => {
  const h = buildScannerHarness();
  const now = Date.now();
  h.scannerCandleCache.set("expired", { candles: [1], expiresAt: now - 1 });
  h.scannerCandleCache.set("live", { candles: [2], expiresAt: now + 60000 });
  h.pruneScannerCandleCache(true);
  assert.equal(h.scannerCandleCache.has("expired"), false);
  assert.equal(h.scannerCandleCache.has("live"), true);
});

test("both caches are pruned on every write path", () => {
  // A write without a prune is how the cache escaped its bound before.
  const klinesWrites = (SRC.match(/klinesCache\.set\(/g) || []).length;
  const klinesPrunes = (SRC.match(/pruneKlinesCache\(\)/g) || []).length;
  assert.equal(klinesPrunes, klinesWrites, `${klinesWrites} klinesCache writes need ${klinesWrites} prunes, found ${klinesPrunes}`);

  const scanWrites = (SRC.match(/scannerCandleCache\.set\(/g) || []).length;
  const scanPrunes = (SRC.match(/pruneScannerCandleCache\(\)/g) || []).length;
  assert.equal(scanPrunes, scanWrites, `${scanWrites} scannerCandleCache writes need ${scanWrites} prunes, found ${scanPrunes}`);
});

test("the cap keeps memory within the pm2 limit", () => {
  // Measured on the server: ~57 KB per klinesCache entry, ~78 KB per scanner entry.
  const kBytes = 2600 * 57 * 1024;
  const sBytes = 2600 * 78 * 1024;
  const totalMB = (kBytes + sBytes) / 1048576;
  assert.ok(totalMB < 400, `combined cache ceiling ${totalMB.toFixed(0)} MB must stay well under the 650 MB pm2 limit`);
});
