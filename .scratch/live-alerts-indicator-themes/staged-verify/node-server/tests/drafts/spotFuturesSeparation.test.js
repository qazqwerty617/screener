"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// Spot / futures separation.
//
// The ticker map carries two kinds of key: real futures instruments, and the
// `*_SPOT` pseudo-tickers wallScanner injects so the density map can cover spot
// books. Three features must never confuse them:
//
//   pump/dump  - the user's "Только Фьючерсы" setting has to actually work
//   formations - futures-only product; spot must not be scanned at all
//   density    - both are valid, and the market filter is a UI choice
//
// The bug this suite pins: every spot/futures test in the codebase was written as
//
//     const isFutures = funding || oi || sym.includes("SWAP") || ...
//                       || (!sym.endsWith("_SPOT"));
//
// The final clause makes the whole expression true for *every* symbol, so
// "futures only" filtered nothing and spot pairs kept appearing in pump/dump.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "public", "js", "app.js"), "utf8");
const ENGINE = fs.readFileSync(path.join(ROOT, "alertEngine.js"), "utf8");

/** Strip comments so a comment describing the old bug is not a match. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1");
}
const SERVER_CODE = stripComments(SERVER);
const APP_CODE = stripComments(APP);
const ENGINE_CODE = stripComments(ENGINE);

// ── The tautology must be gone everywhere ────────────────────────────────────

test("no market-type test is short-circuited by a negated _SPOT clause", () => {
  // `x || (!sym.endsWith("_SPOT"))` is true for every futures symbol AND for
  // every spot symbol whose name does not end in _SPOT — i.e. always true once
  // any earlier clause is false. Any occurrence is the bug.
  for (const [name, src] of [["server.js", SERVER_CODE], ["app.js", APP_CODE], ["alertEngine.js", ENGINE_CODE]]) {
    const bad = src.match(/isFutures[^;]*\|\|\s*\(?\s*!\s*sym\.endsWith\(\s*["']_SPOT["']\s*\)/g);
    assert.equal(bad, null, `${name}: negated _SPOT clause makes isFutures always true:\n${bad}`);
  }
});

test("the futures/spot decision reads the _SPOT suffix directly", () => {
  // The suffix is the authoritative marker. Deriving it from funding/OI is
  // unreliable: several venues report funding 0 and OI 0 on live futures.
  assert.match(SERVER_CODE, /const isSpot = \/_SPOT\$\/i\.test\(sym\) \|\| \/_SPOT\$\/i\.test\(key\);/);
  assert.match(APP_CODE, /const isSpot = \/_SPOT\$\/i\.test\(sym\);/);
});

// ── pump/dump: server-side scan ──────────────────────────────────────────────

test("GET /api/market/pump-alerts honours marketType", () => {
  const start = SERVER_CODE.indexOf('app.get("/api/market/pump-alerts"');
  assert.ok(start > 0, "the route must exist");
  const body = SERVER_CODE.slice(start, SERVER_CODE.indexOf("\n});", start));
  assert.match(body, /if \(marketType !== "both"\)/);
  assert.match(body, /if \(marketType === "futures" && isSpot\) continue;/);
  assert.match(body, /if \(marketType === "spot" && !isSpot\) continue;/);
  // The cache key must include the filter, or a "both" response would be served
  // to a "futures only" caller.
  assert.match(body, /\$\{marketType\}/);
});

test("alertEngine filters spot per subscriber", () => {
  assert.match(ENGINE_CODE, /const isSpot = sym\.endsWith\("_SPOT"\) \|\| sym\.includes\("_SPOT"\);/);
  assert.match(ENGINE_CODE, /if \(marketFilter === "futures" && isSpot\) continue;/);
  assert.match(ENGINE_CODE, /if \(marketFilter === "spot" && !isSpot\) continue;/);
});

test("the WebSocket pump alert carries its market type", () => {
  // The push payload strips `_SPOT` from the display symbol, so without an
  // explicit field the browser cannot tell spot from futures and its own filter
  // is bypassed for every server-pushed alert.
  const start = ENGINE_CODE.indexOf('broadcastAlertFn("pump_dump_alert"');
  assert.ok(start > 0, "the broadcast must exist");
  const body = ENGINE_CODE.slice(start, ENGINE_CODE.indexOf("});", start));
  assert.match(body, /market: isSpot \? "spot" : "futures"/);
  assert.match(body, /sym: sym\.replace\("_SPOT", ""\)/, "the display symbol still drops the marker");
});

// ── pump/dump: client side ──────────────────────────────────────────────────

test("the client rejects a pushed alert that does not match its market filter", () => {
  const start = APP_CODE.indexOf("window.handleServerPumpDumpAlert = function");
  assert.ok(start > 0, "the handler must exist");
  const body = APP_CODE.slice(start, APP_CODE.indexOf("\n  };", start));
  assert.match(body, /const marketFilter = pdSettings\.marketType \|\| "both";/);
  assert.match(body, /if \(market !== marketFilter\) return;/);
  // A server that predates the `market` field must still be handled.
  assert.match(body, /data\.market === "spot" \|\| data\.market === "futures"/);
  assert.match(body, /\/_SPOT\$\/i\.test\(rawKey\)/);
});

test("the client's own live-tick scanner filters spot", () => {
  const start = APP_CODE.indexOf("function pdCheckLiveTick(key, currentPrice, ring, now)");
  assert.ok(start > 0);
  const body = APP_CODE.slice(start, APP_CODE.indexOf("\n  }", start));
  assert.match(body, /if \(pdSettings\.marketType === "futures" && isSpot\) return;/);
  assert.match(body, /if \(pdSettings\.marketType === "spot" && !isSpot\) return;/);
});

test("the market-type selector is still offered, defaulting to both", () => {
  // The user asked for the control to stay; only the filtering had to be fixed.
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(html, /id="pd-market-type-group"/);
  for (const val of ["both", "futures", "spot"]) {
    assert.match(html, new RegExp(`data-val="${val}"`), `the ${val} option must remain`);
  }
  assert.match(APP_CODE, /marketType: "both",/, "the default stays 'both'");
});

// ── formations: futures only, no selector ───────────────────────────────────

test("the formation scan universe excludes spot outright", () => {
  const start = SERVER_CODE.indexOf("const perCoin = new Map();");
  assert.ok(start > 0, "the scan universe builder must exist");
  const body = SERVER_CODE.slice(start, start + 900);
  assert.match(body, /\/_SPOT\$\/i\.test\(t\.key\)/);
  assert.match(body, /\/_SPOT\$\/i\.test\(String\(t\.sym \|\| ""\)\)/);
});

test("the formation alert handler rejects spot", () => {
  const start = APP_CODE.indexOf("window.handleServerFormationAlert = function");
  assert.ok(start > 0);
  const body = APP_CODE.slice(start, start + 700);
  assert.match(body, /\/_SPOT\$\/i\.test\(String\(data\.sym\)\)/);
});

test("every formation map consumer skips spot keys", () => {
  // Three scanners read /api/formations/map (trendline, level, retest). All three
  // must drop spot keys, not just one of them.
  const guards = APP_CODE.match(/if \(\/_SPOT\$\/i\.test\(sym\)\) continue;/g) || [];
  assert.ok(guards.length >= 3,
    `expected a spot guard in all three formation scanners, found ${guards.length}`);
});

// ── density: both markets stay valid ────────────────────────────────────────

test("the density map still covers spot, with market carried per wall", () => {
  const scanner = fs.readFileSync(path.join(ROOT, "wallScanner.js"), "utf8");
  // wallScanner injects the spot tickers, so it must keep doing so.
  assert.match(scanner, /async function updateSpotTickers\(tickers\)/);
  assert.match(scanner, /const market = sym\.endsWith\("_SPOT"\) \? "spot" : "futures";/);
  // And the client filters on that field rather than guessing.
  assert.match(APP_CODE, /if \(densityMarket !== "all" && d\.market !== densityMarket\) return false;/);
});
