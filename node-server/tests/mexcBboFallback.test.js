"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createMexc = require("../exchanges/mexc");
const { buildRows } = require("../arbitrageEngine");

test("MEXC REST BBO keeps Gate to MEXC arbitrage executable before websocket updates", async () => {
  const tickers = new Map();
  const dirtyKeys = new Set();
  const intervals = [];
  const originalSetInterval = global.setInterval;
  global.setInterval = callback => { intervals.push(callback); return 0; };

  try {
    let tickerRequest = 0;
    const apiFetch = async url => {
      if (url.includes("/detail")) return { success: true, data: [] };
      if (url.includes("/funding_rate")) {
        return {
          success: true,
          code: 0,
          data: [{ symbol: "BREW_USDT", fundingRate: 0.0002, collectCycle: 4, nextSettleTime: Date.now() + 3600000 }],
        };
      }
      const isPoll = tickerRequest++ > 0;
      return {
        success: true,
        code: 0,
        data: [{
          symbol: "BREW_USDT",
          lastPrice: isPoll ? 0.018409 : 0.018313,
          bid1: isPoll ? 0.018401 : 0.018307,
          ask1: isPoll ? 0.018409 : 0.018313,
          amount24: 418522.61,
          volume24: 3489243,
          fundingRate: 0.000126,
        }],
      };
    };
    const mkExWs = (_exchange, _url, _onMessage, onOpen) => onOpen({ send() {}, readyState: 1 });
    await createMexc(tickers, dirtyKeys, mkExWs, apiFetch, () => {}).init();

    const mexc = tickers.get("MX:BREW_USDT");
    assert.equal(mexc.bid, 0.018307);
    assert.equal(mexc.ask, 0.018313);
    assert.equal(mexc.funding, 0.02);
    assert.equal(mexc.fundingInterval, 4);

    const restPoll = intervals.at(-1);
    await restPoll();
    assert.equal(mexc.bid, 0.018401);
    assert.equal(mexc.ask, 0.018409);

    const now = Date.now();
    tickers.set("GT:BREW_USDT", {
      ex: "GT",
      sym: "BREW_USDT",
      base: "BREW",
      p: 0.0174975,
      bid: 0.017464,
      ask: 0.017531,
      v: 5270633,
      quoteTs: now,
    });

    const route = buildRows(tickers, now).spreads.find(row => row.key === "spread:BREW:GT:MX");
    assert.ok(route, "BREW Gate to MEXC route should be present");
    assert.equal(route.quality, "bbo");
    assert.ok(route.net > 4, `expected executable spread above 4%, got ${route.net}%`);
  } finally {
    global.setInterval = originalSetInterval;
  }
});
