"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { detectChartLevelsAndTouches } = require("../serverLevels");

function makeCandles() {
  const candles = [];
  for (let i = 0; i < 60; i++) {
    candles.push({ t: 1_700_000_000_000 + i * 60_000, o: 97, h: 97.3, l: 96.7, c: 97, v: 1000 });
  }
  candles[20] = { ...candles[20], o: 97, h: 100, l: 96.9, c: 99 };
  candles[21] = { ...candles[21], o: 99, h: 99.1, l: 97.4, c: 97.6 };
  candles[35] = { ...candles[35], o: 97, h: 100.3, l: 96.9, c: 97.2 };
  return candles;
}

test("server levels survive a wick but require confirmed closes to mitigate", () => {
  const wickOnly = makeCandles();
  const levels = detectChartLevelsAndTouches(wickOnly);
  const original = levels.find(level => Math.abs(level.price - 100) / 100 < 0.004);
  assert.ok(original);
  assert.ok([20, 35].includes(original.swingIdx));
  assert.ok(original.touchIndices.includes(20));
  assert.ok(original.touchIndices.includes(35));

  const confirmed = makeCandles();
  confirmed[35] = { ...confirmed[35], c: 100.4 };
  confirmed[36] = { ...confirmed[36], o: 100.4, h: 100.8, l: 100.2, c: 100.5 };
  const afterBreak = detectChartLevelsAndTouches(confirmed);
  assert.equal(afterBreak.some(level => Math.abs(level.price - 100) / 100 < 0.004), false);
});
