"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const calcVWAP = new Function(`${source.match(/function calcVWAP\([^]*?\n\}/)[0]}; return calcVWAP;`)();
const candle = (t, p, v) => ({ t, o: p, h: p, l: p, c: p, v: p * v, baseVolume: v });
const day = Date.UTC(2026, 8, 25);
test("VWAP resets at midnight UTC, independently of loaded history", () => {
  const data = [candle(day - 60000, 100, 100), candle(day, 10, 2), candle(day + 60000, 20, 1)];
  const values = calcVWAP(data);
  assert.equal(values[1], 10);
  assert.ok(Math.abs(values[2] - 40 / 3) < 1e-10);
});
test("VWAP updates when volume or high changes without a new closing price", () => {
  const data = [candle(day, 10, 2), candle(day + 60000, 20, 1)];
  calcVWAP(data);
  data[1].v = 4;
  data[1].baseVolume = 4;
  assert.ok(Math.abs(calcVWAP(data)[1] - 100 / 6) < 1e-10);
  data[1].h = 26;
  assert.equal(calcVWAP(data)[1], 18);
});
test("quote turnover is converted to estimated base volume, not used as base volume", () => {
  const data = [candle(day, 10, 2), candle(day + 60000, 20, 1)];
  data.forEach(bar => { delete bar.baseVolume; });
  assert.ok(Math.abs(calcVWAP(data)[1] - 40 / 3) < 1e-10);
});
test("VWAP ignores invalid volume without poisoning the session", () => {
  const data = [candle(day, 10, 0), candle(day + 60000, 20, NaN), candle(day + 120000, 30, 2)];
  assert.equal(calcVWAP(data)[2], 30);
});

test("backtest VWAP draws separate paths at UTC boundaries using the shared calculation", () => {
  const backtest = fs.readFileSync(path.join(__dirname, "../public/js/backtest.js"), "utf8");
  const calls = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() {}, moveTo: (...p) => calls.push(["move", ...p]), lineTo: (...p) => calls.push(["line", ...p]) };
  const drawSeries = new Function("ctx", `${backtest.match(/  function drawSeries\([^]*?\n  \}/)[0]}; return drawSeries;`)(ctx);
  const data = [candle(day - 120000, 10, 1), candle(day - 60000, 20, 1), candle(day, 30, 1)];
  drawSeries({ data, start: 0, xForIndex: i => i, yForPrice: v => v }, calcVWAP(data), "blue", v => v, 1, true);
  assert.deepEqual(calls, [["move", 0, 10], ["line", 1, 15], ["move", 2, 30]]);
  assert.match(backtest, /drawSeries\(m, calcVWAP\(state.candles\)/);
});
