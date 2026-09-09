"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const alertEngine = require("../alertEngine");

test("young MEXC history never becomes a fake padded chart", async () => {
  const key = "MX:PFP_USDT";
  const minute = 60_000;
  const start = Math.floor(Date.now() / minute) * minute - 5 * minute;
  const samples = Array.from({ length: 11 }, (_, index) => ({
    t: start + index * 30_000,
    p: index < 9 ? 0.3046 : 0.3046 + (index - 8) * 0.0061,
  }));
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  alertEngine.priceHistory.setSeries(key, samples);
  alertEngine.init({
    tickers: new Map([[key, { key, p: samples.at(-1).p }]]),
    fetchCandles: async () => [],
  });
  alertEngine.stop();

  try {
    const candles = await alertEngine.getCandlesForAlert("MX", "PFP_USDT", "5m");
    assert.ok(candles && candles.length >= 5, "five minutes of real samples should produce a usable chart");
    assert.ok(candles[0].t >= start, "chart must not invent flat candles before the first real sample");
    assert.equal(candles.sourceTf, "1m", "fallback chart must disclose its real candle resolution");
  } finally {
    alertEngine.priceHistory.delete(key);
    global.fetch = previousFetch;
    alertEngine.stop();
  }
});

test("a stale cached candle is never stretched to the live MEXC price", async () => {
  const key = "MX:STALE_USDT";
  const minute = 60_000;
  const now = Date.now();
  const cached = Array.from({ length: 10 }, (_, index) => ({
    t: now - (18 - index) * minute,
    o: 100, h: 100.2, l: 99.8, c: 100, v: 10_000,
  }));
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  alertEngine.init({
    tickers: new Map([[key, { key, p: 104 }]]),
    fetchCandles: async () => cached,
  });
  alertEngine.stop();

  try {
    const candles = await alertEngine.getCandlesForAlert("MX", "STALE_USDT", "5m");
    assert.equal(candles, null, "stale history without a current candle should produce text-only alert");
  } finally {
    global.fetch = previousFetch;
    alertEngine.stop();
  }
});
