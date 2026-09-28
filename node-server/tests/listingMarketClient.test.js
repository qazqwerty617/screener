"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createListingMarketClient } = require("../listingMarketClient");
const { normalizeMarkets } = require("../eventsHub");

test("listing scans avoid retaining CCXT trading models and preserve scheduling semantics", async () => {
  const now = Date.now(), inputs = [
    { symbol: "NEW/USDT", base: "NEW", quote: "USDT", spot: true, active: false,
      info: { listTime: now + 3600000, contTdSwTime: now + 7200000, filters: new Array(100).fill({ unused: true }) } },
    { symbol: "OLD/USDT:USDT", base: "OLD", quote: "USDT", settle: "USDT", swap: true, active: true,
      info: { expTime: now + 86400000, deliveryTime: now + 86400000 } },
    { symbol: "OLD/USDT", base: "OLD", quote: "USDT", spot: true, active: true, info: { delisting_time: (now + 86400000) / 1000 } },
    { symbol: "BTC/USDC", base: "BTC", quote: "USDC", spot: true, info: {} },
    { symbol: "BTC/USDT:USDT-261225", base: "BTC", quote: "USDT", future: true, info: {} }
  ];
  let calls = 0, closed = 0, options;
  class Exchange {
    constructor(config) { options = config; this.options = config.options; }
    loadMarkets() { throw new Error("full trading models must not be built for listing detection"); }
    async fetchMarkets() { calls++; return inputs; }
    close() { closed++; }
  }
  const client = createListingMarketClient("okx", { okx: Exchange });
  for (let i = 0; i < 20; i++) {
    const result = await client.loadMarkets(i > 0);
    for (const venue of ["OX", "BB", "GT"]) assert.deepEqual(normalizeMarkets(result, venue, now), normalizeMarkets(inputs, venue, now));
    assert.equal(Object.keys(result).length, 3);
    assert.equal(result["NEW/USDT"].info.filters, undefined);
    assert.notEqual(result["NEW/USDT"], inputs[0]);
  }
  assert.equal(calls, 20);
  assert.equal(options.enableLastHttpResponse, false);
  assert.deepEqual(options.options.fetchMarkets.types, ["spot", "swap"]);
  await client.close(); assert.equal(closed, 1);
});

test("Hyperliquid resolves currency identifiers before reading markets and retries failures", async () => {
  const order = []; let fails = true;
  class Exchange {
    constructor() { this.options = {}; }
    async fetchCurrencies() { order.push("currencies"); }
    async fetchMarkets() { order.push("markets"); if (fails) throw new Error("unavailable"); return []; }
  }
  const client = createListingMarketClient("hyperliquid", { hyperliquid: Exchange });
  await assert.rejects(client.loadMarkets(), /unavailable/);
  fails = false; assert.deepEqual(await client.loadMarkets(true), {});
  assert.deepEqual(order, ["currencies", "markets", "currencies", "markets"]);
});
