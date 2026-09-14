"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregateExecutionsIntoTrades } = require("../journalAggregator");

test("140 partial exits remain one round-trip trade", () => {
  const executions = [{
    id: "entry", exchange: "Binance", symbol: "BTCUSDT", side: "BUY",
    positionSide: "LONG", price: 100, qty: 140, time: 1_700_000_000_000, fee: 1,
  }];
  for (let i = 0; i < 140; i++) {
    executions.push({
      id: `exit-${i}`, exchange: "Binance", symbol: "BTCUSDT", side: "SELL",
      positionSide: "LONG", price: 101, qty: 1, time: 1_700_000_060_000 + i,
      realizedPnl: 1, fee: 0.01,
    });
  }
  const result = aggregateExecutionsIntoTrades(executions);
  assert.equal(result.length, 1);
  assert.equal(result[0].executions.length, 141);
  assert.equal(result[0].entry, 100);
  assert.equal(result[0].exit, 101);
  assert.equal(result[0].pnl, 137.6);
});

test("long and short hedge positions are aggregated independently", () => {
  const base = { exchange: "Bybit", symbol: "ETHUSDT" };
  const result = aggregateExecutionsIntoTrades([
    { ...base, id: "l1", side: "BUY", positionSide: "LONG", price: 2000, qty: 1, time: 1000 },
    { ...base, id: "s1", side: "SELL", positionSide: "SHORT", price: 2100, qty: 2, time: 1100 },
    { ...base, id: "l2", side: "SELL", positionSide: "LONG", price: 2010, qty: 1, time: 1200, realizedPnl: 10 },
    { ...base, id: "s2", side: "BUY", positionSide: "SHORT", price: 2050, qty: 2, time: 1300, realizedPnl: 100 },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(t => t.side).sort(), ["LONG", "SHORT"]);
});

test("duplicate fill ids are ignored", () => {
  const items = [
    { id: "1", exchange: "OKX", symbol: "SOLUSDT", side: "BUY", price: 10, qty: 2, time: 1000 },
    { id: "1", exchange: "OKX", symbol: "SOLUSDT", side: "BUY", price: 10, qty: 2, time: 1000 },
    { id: "2", exchange: "OKX", symbol: "SOLUSDT", side: "SELL", price: 11, qty: 2, time: 2000, realizedPnl: 2 },
  ];
  const result = aggregateExecutionsIntoTrades(items);
  assert.equal(result.length, 1);
  assert.equal(result[0].size, 2);
});
