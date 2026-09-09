"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");

function block(name) {
  const match = new RegExp(`function ${name}\\([^]*?\\n\\}`).exec(source);
  assert.ok(match, `missing ${name}`);
  return match[0];
}

function cacheHarness() {
  return new Function(`
    const KLINES_CACHE_TTL_MS = 300000;
    const KLINES_CACHE_MAX_ENTRIES = 128;
    const KLINES_CACHE_MAX_CANDLES = 120000;
    const KLINES_CACHE = new Map();
    ${block("countCachedCandles")}
    ${block("pruneClientKlinesCache")}
    ${block("touchKlinesCache")}
    ${block("storeKlinesCache")}
    return { KLINES_CACHE, touchKlinesCache, storeKlinesCache };
  `)();
}

test("browser candle cache stays bounded after visiting many markets", () => {
  const h = cacheHarness();
  for (let i = 0; i < 300; i++) {
    h.storeKlinesCache(`BN|COIN${i}USDT|1m`, Array.from({ length: 300 }, (_, t) => ({ t })));
  }
  assert.ok(h.KLINES_CACHE.size <= 128);
});

test("deep histories cannot make the browser candle cache grow without bound", () => {
  const h = cacheHarness();
  for (let i = 0; i < 20; i++) {
    h.storeKlinesCache(`BN|COIN${i}USDT|1m`, Array.from({ length: 20000 }, (_, t) => ({ t })));
  }
  const total = [...h.KLINES_CACHE.values()].reduce((sum, entry) => sum + entry.data.length, 0);
  assert.ok(total <= 120000, `retained ${total} candles`);
});

test("reading a cache entry refreshes its LRU position", () => {
  const h = cacheHarness();
  for (let i = 0; i < 128; i++) h.storeKlinesCache(`key-${i}`, [{ t: i }]);
  assert.ok(h.touchKlinesCache("key-0"));
  h.storeKlinesCache("new-key", [{ t: 999 }]);
  assert.ok(h.KLINES_CACHE.has("key-0"));
  assert.equal(h.KLINES_CACHE.has("key-1"), false);
});
