"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { buildRows, extractBaseAndMultiplier } = require("../arbitrageEngine");
const { createDepthAnalyzer } = require("../depthAnalyzer");
const { analyzeBooks } = require("../depthAnalyzer");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const now = Date.now();
function pair() {
  return new Map([
    ["BN:BREWUSDT", { ex: "BN", sym: "BREWUSDT", base: "BREW", p: 1, bid: .999, ask: 1, v: 1e6, quoteTs: now, bboTs: now }],
    ["BB:BREWUSDT", { ex: "BB", sym: "BREWUSDT", base: "BREW", p: 1.01, bid: 1.01, ask: 1.011, v: 1e6, quoteTs: now, bboTs: now }],
  ]);
}
test("CEX arbitrage rejects old BBO even while last trades continue", () => {
  const rows = pair(); assert.equal(buildRows(rows, now).spreads.length, 1);
  rows.get("BN:BREWUSDT").bboTs = now - 60000;
  assert.equal(buildRows(rows, now).spreads.length, 0);
});
test("crossed and future-dated quotes cannot create executable CEX edges", () => {
  const crossed = pair(); crossed.get("BN:BREWUSDT").bid = 1.02;
  assert.equal(buildRows(crossed, now).spreads.length, 0);
  const future = pair(); future.get("BN:BREWUSDT").bboTs = now + 60000;
  assert.equal(buildRows(future, now).spreads.length, 0);
});
test("a price ratio alone is not evidence of a token-unit multiplier", () => {
  const rows = pair(); Object.assign(rows.get("BN:BREWUSDT"), { p: 10, bid: 9.99, ask: 10 });
  assert.equal(buildRows(rows, now).spreads.length, 0);
});
test("a digit-prefixed token name alone does not establish bundled token units", () => {
  assert.equal(extractBaseAndMultiplier({ base: "1INCH", sym: "1INCHUSDT" }).base, "1INCH");
  assert.equal(extractBaseAndMultiplier({ base: "10SET", sym: "10SETUSDT" }).base, "10SET");
});
test("depth analysis uses the same base units as a 1000-token arbitrage route", async () => {
  const route = { key: "spread:PEPE:BN:BB", buyEx: "BN", sellEx: "BB", buySymbol: "1000PEPEUSDT", sellSymbol: "PEPEUSDT",
    buyMultiplier: 1000, sellMultiplier: 1, fees: .1, buyFunding: 0, sellFunding: 0 };
  const service = createDepthAnalyzer(async url => url.includes("binance")
    ? { bids: [[.0099, 1e6]], asks: [[.01, 1e6]] }
    : { result: { b: [[.0000101, 1e9]], a: [[.0000102, 1e9]] } },
  new Map(), { getOpportunity: () => route });
  const result = await service.analyze(route.key, 100);
  assert.ok(Math.abs(result.grossPct - 1) < 1e-8, `wrong unit conversion: ${result.grossPct}%`);
  assert.ok(Math.abs(result.executableQty - 1e7) < .001);
});
test("concurrent depth readers share in-flight book requests", async () => {
  let calls = 0;
  const service = createDepthAnalyzer(async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return { bids: [[1, 1]], asks: [[1.01, 1]] }; }, new Map(), {});
  await Promise.all(Array.from({ length: 50 }, () => service.fetchBook("BN", "BTCUSDT")));
  assert.equal(calls, 1);
});
test("depth respects the USD budget including slippage", () => {
  const result = analyzeBooks({ asks: [[100, 2], [101, 10]], bids: [[102, 20]], notional: 500 });
  assert.ok(Math.abs(result.executableNotional - 500) < 1e-8);
  assert.ok(result.executableQty < 5);
  assert.equal(result.complete, true);
});
test("micropriced routes retain executable nonzero quote prices", () => {
  const rows = pair();
  for (const row of rows.values()) for (const field of ["p", "bid", "ask"]) row[field] *= 1e-9;
  const route = buildRows(rows, now).spreads[0];
  assert.equal(route.buyAsk, 1e-9);
  assert.ok(route.sellBid > route.buyAsk);
});
test("missing funding stays unknown instead of becoming a zero rate", async () => {
  const route = buildRows(pair(), now).spreads[0];
  assert.equal(route.buyFunding, null);
  const service = createDepthAnalyzer(async url => url.includes("binance")
    ? { bids: [[.99, 1e4]], asks: [[1, 1e4]] }
    : { result: { b: [[1.01, 1e4]], a: [[1.02, 1e4]] } }, new Map(), { getOpportunity: () => route });
  const result = await service.analyze(route.key, 100);
  assert.equal(result.netAfterFundingHourPct, null);
  assert.ok(Number.isFinite(result.netPct));
});
test("a delayed second leg cannot turn an old book into a fresh depth calculation", async () => {
  let clock = now;
  const context = { module: { exports: {} }, Date: { now: () => clock } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../depthAnalyzer.js"), "utf8"), context);
  const route = { buyEx: "BN", buySymbol: "BREWUSDT", sellEx: "BB", sellSymbol: "BREWUSDT", fees: .1 };
  const service = context.module.exports.createDepthAnalyzer(async url => {
    if (url.includes("bybit")) { clock += 6000; return { result: { b: [[1, 1e4]], a: [[1.01, 1e4]] } }; }
    return { bids: [[.99, 1e4]], asks: [[1, 1e4]] };
  }, new Map(), { getOpportunity: () => route });
  await service.fetchBook("BN", "BREWUSDT");
  await assert.rejects(service.analyze("spread:BREW:BN:BB", 100), /stale|old|slow/i);
});
test("a cached provider response cannot be relabelled as a fresh book", async () => {
  const service = createDepthAnalyzer(async () => ({ retCode: 0, result: { s: "BREWUSDT", ts: now - 60000, b: [[1, 1]], a: [[1.01, 1]] } }), new Map(), {});
  await assert.rejects(service.fetchBook("BB", "BREWUSDT"), /stale|old/i);
});
