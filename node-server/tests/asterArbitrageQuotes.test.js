"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createAster = require("../exchanges/asterdex");

test("Aster publishes a fresh executable book quote for arbitrage", async () => {
  const tickers = new Map(), dirty = new Set(), streams = new Map();
  const apiFetch = async url => {
    if (url.endsWith("exchangeInfo")) return { symbols: [{ symbol: "BREWUSDT", status: "TRADING", quoteAsset: "USDT", contractType: "PERPETUAL" }] };
    if (url.endsWith("ticker/24hr")) return [{ symbol: "BREWUSDT", lastPrice: "1", openPrice: "1", highPrice: "1", lowPrice: "1", quoteVolume: "500000" }];
    return [{ symbol: "BREWUSDT", lastFundingRate: "0.0001", nextFundingTime: Date.now() + 3600000 }];
  };
  await createAster(tickers, dirty, (name, url, handler) => streams.set(name, { url, handler }), apiFetch).init();
  assert.match(streams.get("AD-BookTicker").url, /!bookTicker$/);
  assert.equal(tickers.get("AD:BREWUSDT").bboTs, undefined);
  streams.get("AD-BookTicker").handler(Buffer.from(JSON.stringify({ s: "BREWUSDT", b: "0.99", a: "1.01" })));
  assert.equal(tickers.get("AD:BREWUSDT").bid, 0.99);
  assert.equal(tickers.get("AD:BREWUSDT").ask, 1.01);
  assert.ok(Date.now() - tickers.get("AD:BREWUSDT").bboTs < 1000);
  const before = tickers.get("AD:BREWUSDT").bboTs;
  streams.get("AD-BookTicker").handler(Buffer.from(JSON.stringify({ s: "BREWUSDT", b: "2", a: "1" })));
  assert.equal(tickers.get("AD:BREWUSDT").bboTs, before, "crossed quotes are rejected");
});
