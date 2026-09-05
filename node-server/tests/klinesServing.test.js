"use strict";
// Guards the /api/klines serving strategy. The bug this locks down: a stalled
// in-flight promise poisoned its cache key forever, so the chart's default
// symbols (BTC/ETH 5m) hung for 20+ seconds while colder symbols answered fine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function harness() {
  const bits = [
    /const KLINES_INFLIGHT_TTL_MS = \d+;/,
    /const KLINES_RESPONSE_DEADLINE_MS = \d+;/,
    /function encodeFlatCandles\(candles\) \{[\s\S]*?\n\}/,
    /function startKlinesRefresh\(ex, sym, tf, useLite, key\) \{[\s\S]*?\n\}/
  ].map(re => {
    const m = re.exec(SRC);
    assert.ok(m, `missing source block: ${re}`);
    return m[0];
  });

  return new Function("fetchFullHistory", `
    const klinesInFlight = new Map();
    const klinesCache = new Map();
    function pruneKlinesCache() {}
    ${bits.join("\n")}
    return { klinesInFlight, klinesCache, startKlinesRefresh, encodeFlatCandles,
             KLINES_INFLIGHT_TTL_MS, KLINES_RESPONSE_DEADLINE_MS };
  `);
}

const candle = t => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });

test("the flat wire format packs 6 numbers per candle", () => {
  const h = harness()(async () => []);
  const flat = h.encodeFlatCandles([candle(1), candle(2)]);
  assert.equal(flat.length, 12);
  assert.deepEqual(flat.slice(0, 6), [1, 1, 2, 0.5, 1.5, 10]);
});

test("concurrent callers share one upstream request", async () => {
  let calls = 0;
  const h = harness()(async () => { calls++; return [candle(1)]; });
  await Promise.all([
    h.startKlinesRefresh("BB", "BTCUSDT", "5m", true, "k"),
    h.startKlinesRefresh("BB", "BTCUSDT", "5m", true, "k"),
    h.startKlinesRefresh("BB", "BTCUSDT", "5m", true, "k")
  ]);
  assert.equal(calls, 1, "deduplication must still hold");
});

test("a stalled request cannot poison its key forever", async () => {
  let calls = 0;
  const h = harness()(async () => {
    calls++;
    if (calls === 1) return new Promise(() => {}); // never settles
    return [candle(2)];
  });

  h.startKlinesRefresh("BB", "BTCUSDT", "5m", true, "k").catch(() => {});
  assert.equal(h.klinesInFlight.size, 1);

  // Age the entry past its TTL, as a real stall would.
  const entry = h.klinesInFlight.get("k");
  entry.startedAt = Date.now() - h.KLINES_INFLIGHT_TTL_MS - 1;

  const result = await h.startKlinesRefresh("BB", "BTCUSDT", "5m", true, "k");
  assert.equal(calls, 2, "a second attempt must be allowed");
  assert.deepEqual(result, [candle(2)]);
});

test("a successful refresh populates the cache", async () => {
  const h = harness()(async () => [candle(1), candle(2)]);
  await h.startKlinesRefresh("BB", "ETHUSDT", "5m", true, "k2");
  const hit = h.klinesCache.get("k2");
  assert.ok(hit, "cache must be written");
  assert.equal(hit.data.length, 12);
  assert.ok(hit.at > 0 && hit.used > 0, "both freshness and LRU stamps set");
});

test("a failed refresh clears its slot and leaves no cache entry", async () => {
  const h = harness()(async () => { throw new Error("upstream down"); });
  await assert.rejects(h.startKlinesRefresh("BB", "X", "5m", true, "k3"));
  assert.equal(h.klinesInFlight.has("k3"), false, "the slot must be released");
  assert.equal(h.klinesCache.has("k3"), false);
});

test("an empty upstream result is not cached as valid data", async () => {
  const h = harness()(async () => []);
  await h.startKlinesRefresh("BB", "X", "5m", true, "k4");
  assert.equal(h.klinesCache.has("k4"), false, "an empty array must not become a cache hit");
});

test("a newer attempt is not cleared by an older one finishing late", async () => {
  let resolveFirst;
  let n = 0;
  const h = harness()(async () => {
    n++;
    if (n === 1) return new Promise(r => { resolveFirst = () => r([candle(1)]); });
    return [candle(9)];
  });

  const first = h.startKlinesRefresh("BB", "X", "5m", true, "k5");
  h.klinesInFlight.get("k5").startedAt = Date.now() - h.KLINES_INFLIGHT_TTL_MS - 1;
  const second = h.startKlinesRefresh("BB", "X", "5m", true, "k5");
  const secondStarted = h.klinesInFlight.get("k5").startedAt;

  resolveFirst();
  await first;
  await second;

  // The late first attempt must not have removed the second attempt's slot
  // while it was still the owner.
  const after = h.klinesInFlight.get("k5");
  assert.ok(!after || after.startedAt === secondStarted, "ownership must be respected");
});

test("the route serves stale data instead of blocking", () => {
  // Stale-while-revalidate: the canvas is painted from cache and the refresh
  // happens in the background.
  assert.match(SRC, /if \(cached && cached\.data && cached\.data\.length > 0\) \{/);
  assert.match(SRC, /startKlinesRefresh\(ex, sym, tf, useLite, key\)\.catch\(\(\) => \{\}\);/);
});

test("the route has a hard response deadline", () => {
  assert.match(SRC, /const candles = await raceWithTimeout\(/);
  assert.match(SRC, /KLINES_RESPONSE_DEADLINE_MS,\s*\r?\n\s*null\s*\r?\n\s*\);/);
  assert.match(SRC, /res\.setHeader\("X-Klines-Pending", "1"\);/);
  const m = /const KLINES_RESPONSE_DEADLINE_MS = (\d+);/.exec(SRC);
  assert.ok(m && Number(m[1]) <= 6000, `deadline ${m && m[1]}ms must stay under 6s`);
});

test("racing a timeout must not leak the losing timer", () => {
  // `Promise.race([work, new Promise(r => setTimeout(...))])` keeps the timeout
  // armed after `work` settles. The scanner races once per coin per timeframe,
  // so the leaked timers accumulated in the thousands.
  assert.match(SRC, /function raceWithTimeout\(promise, timeoutMs, timeoutValue = null\)/);
  assert.match(SRC, /\.finally\(\(\) => \{\s*\r?\n\s*if \(timer\) \{ clearTimeout\(timer\); timer = null; \}/);
  const leaked = SRC.match(/Promise\.race\(\[[^\]]*setTimeout/g);
  assert.equal(leaked, null, `every Promise.race timeout must go through raceWithTimeout, found: ${leaked}`);
});

test("the old unbounded in-flight pattern is gone", () => {
  assert.ok(
    !SRC.includes("pending = fetchFullHistory(ex, sym, tf, useLite).finally(() => klinesInFlight.delete(key));"),
    "the promise-only in-flight map must be replaced"
  );
});
