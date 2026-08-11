"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalBase, buildRows } = require("../arbitrageEngine");

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
