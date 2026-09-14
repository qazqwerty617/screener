"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('const serverFormationsMap =');
const end = source.indexOf('// ── Persistent disk cache', start);
const routeStart = source.indexOf('app.get("/api/formations/snapshot"');
const routeEnd = source.indexOf('app.get("/api/formations/map"', routeStart);
function build() {
  return new Function(`let handler;
    const app = { get(path, fn) { handler = fn; } };
    const setPublicCors = () => {};
    ${source.slice(start, end)}
    ${source.slice(routeStart, routeEnd)}
    return { updateFormationSnapshot, formationUpdatedAt, cachedFormationMaps, get(tf) {
      let result, status = 200;
      handler({ query: {tf} }, { setHeader() {}, status(code) { status = code; return this; }, json(value) { result = value; } });
      return { result, status };
    } };`)();
}
test('server snapshot replaces removed formations including 4h and approaching retests', () => {
  const h = build();
  h.updateFormationSnapshot('BN:BTCUSDT', '4h', { cascades: [{ price: 100 }], approachingRetests: [{ price: 105 }] });
  assert.equal(h.get('4h').result.maps.approaching['BN:BTCUSDT'].length, 1);
  h.updateFormationSnapshot('BN:BTCUSDT', '4h', {});
  assert.deepEqual(h.get('4h').result.maps.cascades, {});
  assert.deepEqual(h.get('4h').result.maps.approaching, {});
  assert.ok(h.get('4h').result.updatedAt, 'empty completed scans still have freshness metadata');
});
test('expired cached signals are excluded without waiting for another scan', () => {
  const h = build();
  h.updateFormationSnapshot('BN:BTCUSDT', '15m', { trendlines: [{ price: 100 }] });
  h.formationUpdatedAt['15m']['BN:BTCUSDT'] = Date.now() - 31 * 60000;
  assert.deepEqual(h.get('15m').result.maps.trendline, {});
  assert.equal(h.get('15m').result.scanned, 0);
});
test('all UI timeframes have snapshot responses; unknown timeframes fail explicitly', () => {
  const h = build();
  for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d', '3d', '1w']) assert.equal(h.get(tf).status, 200);
  assert.equal(h.get('__proto__').status, 400);
});

test('additional timeframe scans populate results and dispatch alerts without any browser', async () => {
  const a = source.indexOf('  let isScanning4h = false;');
  const b = source.indexOf('  // 24/7 Autonomous Server-Side Formation Alert Dispatcher', a);
  const run = new Function(`
    const scanned = [], dispatched = [];
    const tickers = new Map([['BN:BTCUSDT', {key:'BN:BTCUSDT',base:'BTC',p:100}]]);
    const normalizeCoinKey = t => t.base;
    const assignScanVenues = perCoin => Array.from(perCoin.values()).map(venues => venues[0]);
    const cachedFormationMaps = { cascades:{}, levels:{}, trendline:{}, retest:{} }, cachedTfMaps = {};
    const getCachedCandlesForScanner = async () => Array(30).fill({c:100});
    const serverLevels = { scanAll: () => ({cascades:[]}) };
    const updateFormationSnapshot = (key,tf) => scanned.push(tf);
    const patternDetector = {scanCandles: meta => [{tf:meta.tf}]};
    const checkAndDispatchServerFormationAlerts = signals => dispatched.push(signals[0].tf);
    const saveFormationMaps = () => {};
    const setTimeout = () => {};
    ${source.slice(a,b)}
    return scan4hPatterns().then(() => ({scanned,dispatched}));
  `);
  const result = await run();
  assert.deepEqual(result.scanned, ['4h','1m','1d','3d','1w']);
  assert.deepEqual(result.dispatched, result.scanned);
});
