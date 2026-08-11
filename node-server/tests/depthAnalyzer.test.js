"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeLevels, fillQuantity, capacityAtImpact, analyzeBooks } = require("../depthAnalyzer");

test("normalizes object and array levels with a contract multiplier", () => {
  assert.deepEqual(normalizeLevels([[101, 2], [100, 1]], 0.1), [[100, 0.1], [101, 0.2]]);
  assert.deepEqual(normalizeLevels([{ p: "99", s: "3" }], 2, true), [[99, 6]]);
});

test("calculates a volume weighted fill across multiple levels", () => {
  const fill = fillQuantity([[100, 2], [101, 3]], 4);
  assert.equal(fill.complete, true);
  assert.equal(fill.qty, 4);
  assert.equal(fill.value, 402);
  assert.equal(fill.avg, 100.5);
  assert.equal(fill.levelsUsed, 2);
});

test("safe capacity stops when average slippage reaches the limit", () => {
  const cap = capacityAtImpact([[100, 1], [101, 10]], "buy", 0.5);
  assert.ok(cap.notional > 199 && cap.notional < 202);
});

test("depth analysis subtracts fees and adds normalized daily funding", () => {
  const result = analyzeBooks({
    asks: [[100, 2], [101, 10]],
    bids: [[102, 2], [101, 10]],
    notional: 500,
    feesPct: 0.1,
    fundingDailyPct: 0.2,
  });
  assert.equal(result.complete, true);
  assert.ok(result.buy.average > 100);
  assert.ok(result.sell.average < 102);
  assert.equal(Number((result.netAfterFundingDayPct - result.netPct).toFixed(6)), 0.2);
  assert.equal(result.bands.length, 5);
});
