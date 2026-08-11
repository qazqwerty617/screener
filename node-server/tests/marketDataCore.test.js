"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTimestamp,
  normalizeCandle,
  validSubscription,
  mergeMarketTick,
} = require("../marketDataCore");

test("normalizes exchange timestamps without losing milliseconds", () => {
  assert.equal(normalizeTimestamp(1_720_000_000), 1_720_000_000_000);
  assert.equal(normalizeTimestamp(1_720_000_000_123), 1_720_000_000_123);
  assert.equal(normalizeTimestamp(1_720_000_000_123_000), 1_720_000_000_123);
  assert.equal(normalizeTimestamp(1_720_000_000_123_000_000), 1_720_000_000_123);
});

test("keeps official candle open instead of cosmetically joining candles", () => {
  const candle = normalizeCandle({ t: 1_720_000_000, o: 101, h: 103, l: 100, c: 102, v: 55 });
  assert.deepEqual(candle, { t: 1_720_000_000_000, o: 101, h: 103, l: 100, c: 102, v: 55 });
});

test("validates exchange market subscriptions", () => {
  assert.equal(validSubscription("BN", "BTCUSDT", "1m"), true);
  assert.equal(validSubscription("HL", "kPEPE", "4h"), true);
  assert.equal(validSubscription("XX", "BTCUSDT", "1m"), false);
  assert.equal(validSubscription("BN", "https://example.com", "1m"), false);
  assert.equal(validSubscription("BN", "BTCUSDT", "2m"), false);
});

test("coalesces trades while preserving exact high, low and newest trade", () => {
  let batch = mergeMarketTick(null, { t: 1000, p: 100, volume: 2 });
  batch = mergeMarketTick(batch, { t: 1002, p: 104, volume: 3 });
  batch = mergeMarketTick(batch, { t: 1001, p: 98, volume: 1 });
  assert.equal(batch.first, 100);
  assert.equal(batch.last, 104);
  assert.equal(batch.high, 104);
  assert.equal(batch.low, 98);
  assert.equal(batch.trades, 3);
  assert.equal(batch.volume, 6);
});

test("coalescer retains the earliest trade as candle open", () => {
  let batch = mergeMarketTick(null, { t: 2002, p: 102 });
  batch = mergeMarketTick(batch, { t: 2000, p: 100 });
  assert.equal(batch.firstTime, 2_000_000);
  assert.equal(batch.first, 100);
  assert.equal(batch.last, 102);
});
