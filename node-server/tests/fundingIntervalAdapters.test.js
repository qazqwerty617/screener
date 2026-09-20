"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createGate = require("../exchanges/gate");
const createBingx = require("../exchanges/bingx");
const createOkx = require("../exchanges/okx");
const createBinance = require("../exchanges/binance");
const createBitget = require("../exchanges/bitget");
const createKucoin = require("../exchanges/kucoin");

function websocketStub(_exchange, _url, _onMessage, onOpen) {
  if (onOpen) onOpen({ send() {}, readyState: 1 });
}

test("Gate uses the contract funding interval and taker fee", async () => {
  const tickers = new Map();
  const originalSetInterval = global.setInterval;
  global.setInterval = () => 0;
  try {
    const apiFetch = async url => url.includes("/contracts")
      ? [{ name: "BREW_USDT", last_price: "0.0158", funding_rate: "0.000012", funding_next_apply: 1789243200, funding_interval: 3600, taker_fee_rate: "0.00075", quanto_multiplier: "100" }]
      : [{ contract: "BREW_USDT", last: "0.0158", volume_24h_quote: "500000" }];
    await createGate(tickers, new Set(), websocketStub, apiFetch, () => {}).init();
    const ticker = tickers.get("GT:BREW_USDT");
    assert.equal(ticker.fundingInterval, 1);
    assert.equal(ticker.takerFeePct, 0.075);
    assert.ok(ticker.fundingTs > 0);
  } finally {
    global.setInterval = originalSetInterval;
  }
});

test("BingX uses fundingIntervalHours from premium index", async () => {
  const tickers = new Map();
  const intervals = [];
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  global.setInterval = callback => { intervals.push(callback); return 0; };
  global.setTimeout = callback => { callback(); return 0; };
  try {
    const apiFetch = async url => {
      if (url.includes("premiumIndex")) return { code: 0, data: [{ symbol: "BTC-USDT", lastFundingRate: "0.0001", nextFundingTime: Date.now() + 3600000, fundingIntervalHours: 4 }] };
      if (url.includes("spot/")) return { code: 0, data: [] };
      return { code: 0, data: [{ symbol: "BTC-USDT", lastPrice: "100", openPrice: "99", quoteVolume: "1000000" }] };
    };
    await createBingx(tickers, new Set(), websocketStub, apiFetch, () => {}).init();
    await intervals.at(-1)();
    assert.equal(tickers.get("BX:BTC-USDT").fundingInterval, 4);
    assert.ok(tickers.get("BX:BTC-USDT").fundingTs > 0);
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
  }
});

test("OKX derives the current interval from adjacent funding timestamps", async () => {
  const tickers = new Map();
  const intervals = [];
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  global.setInterval = callback => { intervals.push(callback); return 0; };
  global.setTimeout = callback => { callback(); return 0; };
  try {
    const apiFetch = async url => {
      if (url.includes("/instruments")) return { data: [{ instId: "BTC-USDT-SWAP", ctType: "linear", settleCcy: "USDT", ctValCcy: "BTC", ctVal: "0.01" }] };
      if (url.includes("/funding-rate")) return { data: [{ instId: "BTC-USDT-SWAP", fundingRate: "0.0001", fundingTime: "1000000", nextFundingTime: String(1000000 + 4 * 3600000) }] };
      return { data: [{ instId: "BTC-USDT-SWAP", last: "100", bidPx: "99.9", askPx: "100.1", vol24h: "100000" }] };
    };
    await createOkx(tickers, new Set(), websocketStub, apiFetch, () => {}).init();
    await intervals.at(-1)();
    assert.equal(tickers.get("OX:BTC-USDT-SWAP").fundingInterval, 4);
    assert.ok(tickers.get("OX:BTC-USDT-SWAP").fundingTs > 0);
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
  }
});

test("Binance applies per-symbol funding interval adjustments", async () => {
  const tickers = new Map();
  const apiFetch = async url => {
    if (url.includes("exchangeInfo")) return { symbols: [{ symbol: "LPTUSDT", status: "TRADING", quoteAsset: "USDT", contractType: "PERPETUAL" }] };
    if (url.includes("ticker/24hr")) return [{ symbol: "LPTUSDT", lastPrice: "10", openPrice: "9", quoteVolume: "1000000" }];
    if (url.includes("premiumIndex")) return [{ symbol: "LPTUSDT", lastFundingRate: "0.0002", nextFundingTime: Date.now() + 3600000 }];
    if (url.includes("fundingInfo")) return [{ symbol: "LPTUSDT", fundingIntervalHours: 4 }];
    return [];
  };
  createBinance(tickers, new Set(), websocketStub, apiFetch, () => {}).init();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tickers.get("BN:LPTUSDT").fundingInterval, 4);
  assert.ok(tickers.get("BN:LPTUSDT").fundingTs > 0);
});

test("Bitget uses contract funding interval and taker fee", async () => {
  const tickers = new Map();
  const originalSetInterval = global.setInterval;
  global.setInterval = () => 0;
  try {
    const apiFetch = async url => url.includes("/contracts")
      ? { code: "00000", data: [{ symbol: "TONUSDT", fundInterval: "4", takerFeeRate: "0.0007", isRwa: "NO" }] }
      : { code: "00000", data: [{ symbol: "TONUSDT", lastPr: "1", open24h: "1", usdtVolume: "1000000", fundingRate: "0.0002", nextFundingTime: Date.now() + 3600000 }] };
    await createBitget(tickers, new Set(), websocketStub, apiFetch, () => {}).init();
    assert.equal(tickers.get("BG:TONUSDT").fundingInterval, 4);
    assert.ok(Math.abs(tickers.get("BG:TONUSDT").takerFeePct - 0.07) < 1e-12);
    assert.ok(tickers.get("BG:TONUSDT").fundingTs > 0);
  } finally {
    global.setInterval = originalSetInterval;
  }
});

test("KuCoin uses the contract's current funding granularity and taker fee", async () => {
  const tickers = new Map();
  const originalSetInterval = global.setInterval;
  global.setInterval = () => 0;
  try {
    const apiFetch = async url => url.includes("contracts/active")
      ? { code: "200000", data: [{ symbol: "LABUSDTM", status: "Open", lastTradePrice: "1", turnoverOf24h: "1000000", fundingFeeRate: "0.0002", nextFundingRateTime: 3600000, currentFundingRateGranularity: 3600000, takerFeeRate: "0.0008" }] }
      : { code: "200000", data: {} };
    await createKucoin(tickers, new Set(), websocketStub, apiFetch, () => {}).init();
    assert.equal(tickers.get("KC:LABUSDTM").fundingInterval, 1);
    assert.equal(tickers.get("KC:LABUSDTM").takerFeePct, 0.08);
    assert.ok(tickers.get("KC:LABUSDTM").fundingTs > 0);
  } finally {
    global.setInterval = originalSetInterval;
  }
});
