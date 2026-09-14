"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const BACKTEST = fs.readFileSync(path.join(__dirname, "../public/js/backtest.js"), "utf8");

test("oscillator panels render value changes as candles", () => {
  assert.match(APP, /function drawIndicatorCandles\(/);
  for (const series of ["rsi", "atr", "cvd", "oiData"]) {
    assert.match(APP, new RegExp(`drawIndicatorCandles\\([^;]*${series}`));
  }
});

test("backtest sub-indicators share the candle renderer", () => {
  assert.match(BACKTEST, /function drawIndicatorCandles\(/);
  assert.match(BACKTEST, /drawIndicatorCandles\(vCtx, values/);
});
