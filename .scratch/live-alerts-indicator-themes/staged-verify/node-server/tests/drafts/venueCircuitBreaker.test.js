"use strict";
// Guards the venue circuit breaker: a 418 from Binance must park the host for
// the duration it reports, and every subsequent request must fail instantly
// instead of hanging until the client timeout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function buildHarness() {
  const parts = [
    /const venueBanUntil = new Map\(\);[^\n]*\n/,
    /const VENUE_DEFAULT_BAN_MS = \d+;/,
    /const VENUE_RATE_LIMIT_MS = \d+;/,
    /function hostOf\(url\) \{[\s\S]*?\n\}/,
    /const SYMBOL_PATH_SEGMENT = [^\n]+\n/,
    /function endpointOf\(url\) \{[\s\S]*?\n\}/,
    /function pausedUntil\(key\) \{[\s\S]*?\n\}/,
    /function isVenuePaused\(url\) \{[\s\S]*?\n\}/,
    /function pauseVenue\(url, ms, reason, scope = "host"\) \{[\s\S]*?\n\}/,
    /function venuePauseSnapshot\(\) \{[\s\S]*?\n\}/,
    /function binanceFallbackUrl\(url\) \{[\s\S]*?\n\}/
  ].map(re => {
    const m = re.exec(SRC);
    assert.ok(m, `missing source block: ${re}`);
    return m[0];
  });

  return new Function(`
    const console = { warn() {} };
    ${parts.join("\n")}
    return { venueBanUntil, isVenuePaused, pauseVenue, venuePauseSnapshot, binanceFallbackUrl,
             hostOf, endpointOf, VENUE_DEFAULT_BAN_MS, VENUE_RATE_LIMIT_MS };
  `)();
}

test("a paused host is reported as paused until its window expires", () => {
  const h = buildHarness();
  const url = "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT";
  assert.equal(h.isVenuePaused(url), false, "not paused initially");
  h.pauseVenue(url, 5000, "HTTP 418");
  assert.equal(h.isVenuePaused(url), true);
  // Same host, different path -> still paused.
  assert.equal(h.isVenuePaused("https://fapi.binance.com/fapi/v1/ticker/24hr"), true);
  // Different host -> unaffected.
  assert.equal(h.isVenuePaused("https://api.bybit.com/v5/market/kline"), false);
});

test("an expired pause clears itself", () => {
  const h = buildHarness();
  const url = "https://fapi.binance.com/fapi/v1/klines";
  h.pauseVenue(url, 1000, "test");
  h.venueBanUntil.set("fapi.binance.com", Date.now() - 1);
  assert.equal(h.isVenuePaused(url), false);
  assert.equal(h.venueBanUntil.has("fapi.binance.com"), false, "the entry must be removed");
});

test("a longer pause is never shortened by a later shorter one", () => {
  const h = buildHarness();
  const url = "https://fapi.binance.com/fapi/v1/klines";
  h.pauseVenue(url, 3600000, "HTTP 418 with retry-after 3600");
  const long = h.venueBanUntil.get("fapi.binance.com");
  h.pauseVenue(url, 1000, "HTTP 429");
  assert.equal(h.venueBanUntil.get("fapi.binance.com"), long, "the hour-long ban must win");
});

test("retry-after drives the pause length", () => {
  // The handler must read the header rather than always using the default.
  assert.match(SRC, /const retryAfter = Number\(r\.headers\.get\("retry-after"\)\);/);
  assert.match(SRC, /const reported = Number\.isFinite\(retryAfter\) && retryAfter > 0 \? retryAfter \* 1000 : 0;/);
  assert.match(SRC, /pauseVenue\(url, reported \|\| VENUE_RATE_LIMIT_MS, "HTTP 429", "endpoint"\);/);
  assert.match(SRC, /pauseVenue\(url, reported \|\| VENUE_DEFAULT_BAN_MS, `HTTP \$\{r\.status\}`\);/);
  assert.match(SRC, /if \(r\.status === 418 \|\| r\.status === 429 \|\| r\.status === 403\)/);
});

// ── scope: a soft rate limit must not take a whole venue down ────────────────

test("a 429 parks one endpoint, not the venue", () => {
  const h = buildHarness();
  const books = "https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=400";
  const klines = "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT";
  h.pauseVenue(books, 10000, "HTTP 429", "endpoint");

  assert.equal(h.isVenuePaused(books), true, "the throttled endpoint stands down");
  assert.equal(h.isVenuePaused("https://www.okx.com/api/v5/market/books?instId=ETH-USDT&sz=400"), true,
    "the pause covers the endpoint for every symbol: the limit is per IP, not per instrument");
  assert.equal(h.isVenuePaused(klines), false, "other endpoints on the same host keep working");
});

test("a 418 still parks the whole host", () => {
  const h = buildHarness();
  const depth = "https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=500";
  h.pauseVenue(depth, 3600000, "HTTP 418");
  assert.equal(h.isVenuePaused(depth), true);
  assert.equal(h.isVenuePaused("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT"), true,
    "an IP-level ban applies to every endpoint");
});

test("an endpoint key ignores the query and folds instruments in the path", () => {
  const h = buildHarness();
  // MEXC puts the symbol in the path; without folding, each symbol would mint
  // its own key and a rate limit would park exactly one of ~260 symbols.
  assert.equal(
    h.endpointOf("https://contract.mexc.com/api/v1/contract/depth/BTCUSDT?limit=200"),
    h.endpointOf("https://contract.mexc.com/api/v1/contract/depth/ETHUSDT?limit=200")
  );
  assert.match(h.endpointOf("https://contract.mexc.com/api/v1/contract/depth/BTC_USDT"), /\/\*$/);
  // Distinct endpoints stay distinct.
  assert.notEqual(
    h.endpointOf("https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT"),
    h.endpointOf("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT")
  );
  h.pauseVenue("https://contract.mexc.com/api/v1/contract/depth/BTCUSDT?limit=200", 5000, "HTTP 429", "endpoint");
  assert.equal(h.isVenuePaused("https://contract.mexc.com/api/v1/contract/depth/SOLUSDT?limit=200"), true);
  assert.equal(h.isVenuePaused("https://contract.mexc.com/api/v1/contract/ticker?symbol=BTCUSDT"), false);
});

test("a rate-limit pause is short, an IP ban is not", () => {
  const h = buildHarness();
  assert.ok(h.VENUE_RATE_LIMIT_MS <= 15000,
    `a 429 without retry-after must clear quickly (got ${h.VENUE_RATE_LIMIT_MS}ms)`);
  assert.ok(h.VENUE_DEFAULT_BAN_MS >= 60000,
    `a 418 must park the host for at least a minute (got ${h.VENUE_DEFAULT_BAN_MS}ms)`);
});

test("apiFetch refuses instantly while a venue is paused", () => {
  // Without this the request waits out the full client timeout — that is what
  // made /api/klines hang for 35 seconds during the ban.
  assert.match(SRC, /if \(isVenuePaused\(url\)\) \{/);
  assert.match(SRC, /if \(!fallback \|\| isVenuePaused\(fallback\)\) throw new Error\("VENUE_PAUSED"\);/);
});

test("the Binance futures mirror is used as a fallback", () => {
  const h = buildHarness();
  const futures = "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=1000";
  const mirror = h.binanceFallbackUrl(futures);
  assert.ok(mirror && mirror.includes("data-api.binance.vision"), `unexpected mirror: ${mirror}`);
  assert.notEqual(h.hostOf(mirror), h.hostOf(futures), "the mirror must be a different host, so it has its own budget");
  // Not applicable to other venues.
  assert.equal(h.binanceFallbackUrl("https://api.bybit.com/v5/market/kline"), null);
});

test("a paused mirror is not used either", () => {
  const h = buildHarness();
  const futures = "https://fapi.binance.com/fapi/v1/klines";
  const mirror = h.binanceFallbackUrl(futures);
  h.pauseVenue(futures, 60000, "418");
  h.pauseVenue(mirror, 60000, "429");
  assert.equal(h.isVenuePaused(mirror), true);
});

test("the scanner parks the exchange on a venue pause", () => {
  assert.match(SRC, /msg\.includes\("VENUE_PAUSED"\)/);
  assert.match(SRC, /exchangeBackoffs\.set\(ex, now \+ 60000\);/);
  assert.ok(
    !SRC.includes("exchangeBackoffs.set(ex, now + 3000)"),
    "the 3-second backoff that kept hammering a banned host must be gone"
  );
});

test("candle TTLs are long enough to stop refetching every pass", () => {
  const m = /function getTfTtlMs\(tf\) \{[\s\S]*?\n  \}/.exec(SRC);
  assert.ok(m);
  const body = m[0];
  // A full scan pass takes minutes; a 30s TTL guaranteed a refetch every pass.
  assert.match(body, /if \(low === "5m"\) return 2 \* 60 \* 1000;/);
  assert.match(body, /if \(low === "15m"\) return 4 \* 60 \* 1000;/);
  assert.match(body, /if \(low === "1h"\) return 8 \* 60 \* 1000;/);
});

test("grid cells no longer chase a deep-history request", () => {
  const APP = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  // 12 cells x (lite + 3 paged full requests) = 48 upstream calls on open.
  assert.match(APP, /const wantsDeepHistory = activeView === "screener" && screenerView === "single";/);
  assert.match(APP, /if \(!wantsDeepHistory\) return;/);
});

test("kline payload decoding is centralised", () => {
  const APP = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
  assert.match(APP, /function decodeKlinePayload\(payload, maxLimit = 3000\)/);
  // The four hand-rolled copies of the same loop are gone.
  const inlineCopies = (APP.match(/for \(let i = 0; i < \w+\.length; i \+= 6\) \{\s*\w+\.push\(\{ t:/g) || []).length;
  assert.equal(inlineCopies, 0, `found ${inlineCopies} inline decoders still in place`);
});
