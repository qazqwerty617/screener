"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PriceHistoryStore } = require("../priceHistoryStore");

test("samples are throttled to the configured resolution", () => {
  const s = new PriceHistoryStore(10, 1000);
  const t0 = 1_000_000;
  assert.equal(s.push("K", t0, 100), true);
  assert.equal(s.push("K", t0 + 500, 101), false, "sub-resolution sample must be skipped");
  assert.equal(s.push("K", t0 + 1000, 102), true);
  assert.equal(s.sampleCount("K"), 2);
});

test("corrupt 4x single-tick spikes are rejected", () => {
  const s = new PriceHistoryStore(10, 1000);
  s.push("K", 0, 100);
  assert.equal(s.push("K", 1000, 500), false, "5x jump must be rejected");
  assert.equal(s.push("K", 2000, 120), true);
});

test("the ring wraps and keeps only the newest capacity samples", () => {
  const s = new PriceHistoryStore(5, 1000);
  for (let i = 0; i < 12; i++) s.push("K", i * 1000, 100 + i);
  assert.equal(s.sampleCount("K"), 5);
  const series = s.toSeries("K");
  assert.deepEqual(series.map(x => x.p), [107, 108, 109, 110, 111]);
  assert.equal(series[0].t, 7000, "oldest retained sample is correct after wrap");
  assert.equal(s.oldestTime("K"), 7000);
  assert.equal(s.newestTime("K"), 11000);
});

test("findAtOrBefore returns the newest sample not later than the target", () => {
  const s = new PriceHistoryStore(10, 1000);
  for (let i = 0; i < 6; i++) s.push("K", i * 1000, 100 + i);
  const got = s.findAtOrBefore("K", 3500);
  assert.equal(got.t, 3000);
  assert.equal(got.p, 103);
});

test("findAtOrBefore falls back to the oldest sample when the target predates the window", () => {
  const s = new PriceHistoryStore(10, 1000);
  s.push("K", 10_000, 100);
  s.push("K", 11_000, 101);
  const got = s.findAtOrBefore("K", 5_000);
  assert.equal(got.t, 10_000, "callers detect this via the returned timestamp");
});

test("findNearest reports the distance so callers can reject stale references", () => {
  const s = new PriceHistoryStore(10, 1000);
  s.push("K", 0, 100);
  s.push("K", 5000, 105);
  const got = s.findNearest("K", 4000);
  assert.equal(got.t, 5000);
  assert.equal(got.diffMs, 1000);
});

test("a full window covers the whole configured span", () => {
  const s = new PriceHistoryStore(480, 30_000); // production configuration
  const start = 1_700_000_000_000;
  for (let i = 0; i < 480; i++) s.push("K", start + i * 30_000, 100);
  const spanMs = s.newestTime("K") - s.oldestTime("K");
  assert.ok(spanMs >= 4 * 60 * 60 * 1000 - 30_000, `span was ${spanMs}ms, expected ~4h`);

  // Every lookback offered by the pump/dump UI must resolve inside the window.
  const now = s.newestTime("K");
  for (const minutes of [1, 5, 15, 30, 60, 240]) {
    const ref = s.findAtOrBefore("K", now - minutes * 60_000);
    assert.ok(ref, `no reference point for ${minutes}m`);
    assert.ok(ref.t <= now - minutes * 60_000 + 30_000, `${minutes}m reference is too recent`);
  }
});

test("stale keys are pruned and live keys are kept", () => {
  const s = new PriceHistoryStore(10, 1000);
  s.push("OLD", 1000, 100);
  s.push("NEW", 500_000, 100);
  // now = 540s: OLD is 539s stale (> 60s ttl), NEW is only 40s stale.
  const removed = s.pruneStale(540_000, 60_000);
  assert.equal(removed, 1);
  assert.equal(s.size, 1);
  assert.equal(s.sampleCount("OLD"), 0);
  assert.equal(s.sampleCount("NEW"), 1);
});

test("setSeries replaces contents and honours capacity", () => {
  const s = new PriceHistoryStore(3, 1000);
  s.setSeries("K", [
    { t: 1000, p: 1 }, { t: 2000, p: 2 }, { t: 3000, p: 3 }, { t: 4000, p: 4 }
  ]);
  assert.deepEqual(s.toSeries("K").map(x => x.p), [2, 3, 4]);
});

test("memory footprint stays proportional to keys, not sample objects", () => {
  const s = new PriceHistoryStore(480, 30_000);
  const stats = s.stats();
  assert.equal(stats.capacity, 480);
  // 480 samples * (4 bytes uint32 + 8 bytes float64)
  s.push("K", 0, 100);
  assert.equal(s.stats().approxBytes, 480 * 12);
});
