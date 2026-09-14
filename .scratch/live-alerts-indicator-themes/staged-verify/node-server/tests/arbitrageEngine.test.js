"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalBase, buildRows, createArbitrageEngine } = require("../arbitrageEngine");

test("normalizes exchange-specific perpetual symbols", () => {
  assert.equal(canonicalBase({ sym: "BTC-USDT-SWAP" }), "BTC");
  assert.equal(canonicalBase({ sym: "ETH_USDT" }), "ETH");
  assert.equal(canonicalBase({ sym: "XBTUSDTM" }), "BTC");
  assert.equal(canonicalBase({ base: "1000PEPE" }), "1000PEPE");
  assert.equal(canonicalBase({ sym: "BTCUSDT_SPOT", base: "BTC" }), "");
});

test("uses executable ask and bid and subtracts both taker fees", () => {
  const now = Date.now();
  const tickers = new Map([
    ["BN:BTCUSDT", { ex: "BN", sym: "BTCUSDT", base: "BTC", p: 100, bid: 99.9, ask: 100, v: 10e6, quoteTs: now }],
    ["BB:BTCUSDT", { ex: "BB", sym: "BTCUSDT", base: "BTC", p: 101, bid: 101, ask: 101.1, v: 20e6, quoteTs: now }],
  ]);
  const row = buildRows(tickers, now).spreads[0];
  assert.equal(row.buyAsk, 100);
  assert.equal(row.sellBid, 101);
  assert.equal(row.gross, 1);
  assert.equal(row.fees, 0.105);
  assert.equal(row.net, 0.895);
  assert.equal(row.quality, "bbo");
});

test("deduplicates ticker aliases that point to one object", () => {
  const now = Date.now();
  const mexc = { ex: "MX", sym: "ETH_USDT", base: "ETH", p: 2000, bid: 1999, ask: 2000, v: 1e6, quoteTs: now };
  const map = new Map([
    ["MX:ETH_USDT", mexc], ["MX:ETHUSDT", mexc],
    ["BN:ETHUSDT", { ex: "BN", sym: "ETHUSDT", base: "ETH", p: 2010, bid: 2010, ask: 2011, v: 2e6, quoteTs: now }],
  ]);
  assert.equal(buildRows(map, now).spreads.length, 1);
});

test("normalizes funding intervals before comparing venues", () => {
  const now = Date.now();
  const map = new Map([
    ["HL:BTC", { ex: "HL", sym: "BTC", base: "BTC", p: 100, funding: 0.005, fundingInterval: 1, v: 1e6, quoteTs: now }],
    ["BN:BTCUSDT", { ex: "BN", sym: "BTCUSDT", base: "BTC", p: 100, funding: 0.02, fundingInterval: 8, v: 1e6, quoteTs: now }],
  ]);
  const row = buildRows(map, now).funding[0];
  assert.equal(row.longEx, "BN");
  assert.equal(row.shortEx, "HL");
  assert.equal(row.daily, 0.06);
});

test("filters out zero and dead liquidity pairs (<$5,000)", () => {
  const now = Date.now();
  const map = new Map([
    ["GT:CAT_USDT", { ex: "GT", sym: "CAT_USDT", base: "CAT", p: 0.000321, bid: 0.000320, ask: 0.000321, v: 100, quoteTs: now }],
    ["HL:CAT", { ex: "HL", sym: "CAT", base: "CAT", p: 0.002321, bid: 0.002320, ask: 0.002321, v: 0, quoteTs: now }],
  ]);
  const result = buildRows(map, now);
  assert.equal(result.spreads.length, 0);
});

test("auto-normalizes power-of-10 contract multiplier discrepancy", () => {
  const now = Date.now();
  const map = new Map([
    ["BN:1000PEPEUSDT", { ex: "BN", sym: "1000PEPEUSDT", base: "1000PEPE", p: 0.0100, bid: 0.0099, ask: 0.0100, v: 5e6, quoteTs: now }],
    ["MX:PEPE_USDT", { ex: "MX", sym: "PEPE_USDT", base: "PEPE", p: 0.0000101, bid: 0.0000101, ask: 0.0000102, v: 2e6, quoteTs: now }],
  ]);
  const result = buildRows(map, now);
  assert.equal(result.spreads.length, 1);
  const row = result.spreads[0];
  assert.equal(row.base, "PEPE");
  assert.equal(row.gross > 0, true);
});

test("chooses the best executable direction instead of the lowest ask", () => {
  const now = Date.now();
  const map = new Map([
    ["BN:EDGEUSDT", { ex: "BN", sym: "EDGEUSDT", base: "EDGE", p: 100, bid: 99.99, ask: 100, v: 2e6, quoteTs: now }],
    ["BB:EDGEUSDT", { ex: "BB", sym: "EDGEUSDT", base: "EDGE", p: 95, bid: 90, ask: 100.01, v: 2e6, quoteTs: now }],
  ]);

  const row = buildRows(map, now).spreads[0];
  assert.equal(row.buyEx, "BB");
  assert.equal(row.sellEx, "BN");
  assert.ok(row.net > -0.2, `expected the tighter reverse route, got ${row.net}%`);
});

test("spread rows expose executable entry and exit prices", () => {
  const now = Date.now();
  const map = new Map([
    ["BN:BTCUSDT", { ex: "BN", sym: "BTCUSDT", base: "BTC", p: 100, bid: 99.9, ask: 100, v: 10e6, quoteTs: now }],
    ["BB:BTCUSDT", { ex: "BB", sym: "BTCUSDT", base: "BTC", p: 101, bid: 101, ask: 101.1, v: 20e6, quoteTs: now }],
  ]);

  const row = buildRows(map, now).spreads[0];
  assert.equal(row.buyBid, 99.9);
  assert.equal(row.sellAsk, 101.1);
  assert.ok(Number.isFinite(row.exitNet));
});

test("watching a route keeps collecting it outside the ranked history window", () => {
  let now = Date.now();
  const map = new Map([
    ["BN:TESTUSDT", { ex: "BN", sym: "TESTUSDT", base: "TEST", p: 100, bid: 99.9, ask: 100, v: 1e6, quoteTs: now }],
    ["BB:TESTUSDT", { ex: "BB", sym: "TESTUSDT", base: "TEST", p: 101, bid: 101, ask: 101.1, v: 1e6, quoteTs: now }],
  ]);
  const engine = createArbitrageEngine(map, new Map(), { now: () => now, rankedHistoryLimit: 0 });
  engine.refresh();
  const key = engine.getSnapshot().spreads[0].key;
  engine.getHistory(key);

  for (let i = 0; i < 90; i++) {
    now += 5_000;
    for (const ticker of map.values()) ticker.quoteTs = now;
    engine.refresh();
  }

  assert.ok(engine.getHistory(key).length >= 90, "selected route history must exceed the old 60-point cap");
});

test("tokenized stocks and exchange RWA instruments never become arbitrage routes", () => {
  const now = Date.now();
  const map = new Map([
    ["OX:ANTHROPIC-USDT-SWAP", { ex: "OX", sym: "ANTHROPIC-USDT-SWAP", base: "ANTHROPIC", p: 200, bid: 200, ask: 201, v: 2e6, quoteTs: now }],
    ["BG:ANTHROPICUSDT", { ex: "BG", sym: "ANTHROPICUSDT", base: "ANTHROPIC", p: 2000, bid: 1999, ask: 2000, v: 2e6, quoteTs: now, isRwa: true }],
  ]);
  assert.equal(buildRows(map, now).spreads.length, 0);
});
