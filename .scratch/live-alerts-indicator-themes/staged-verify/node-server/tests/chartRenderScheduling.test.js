"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");

function block(name) {
  const match = new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(source);
  assert.ok(match, `missing ${name}`);
  return match[0];
}

function runTickerFrame(pendingKeys = []) {
  return new Function(`
    const interpActive = new Map();
    const coins = new Map([["BN:BTCUSDT", { p: 100 }]]);
    const dirty = new Set();
    const chartTickerDirty = new Set(${JSON.stringify(pendingKeys)});
    const chartInstances = [{ key: "BN:BTCUSDT", update() { calls++; } }];
    let calls = 0;
    let needRebuild = false, screenerView = "multichart", activeView = "screener";
    let activeEx = "BN", activeSym = "BTCUSDT", candles = [], klWs = null;
    const hasMainMarketStream = () => true;
    ${block("processTickData")}
    processTickData(1 / 60);
    return { calls, pending: chartTickerDirty.size };
  `)();
}

test("an idle animation frame does not update or repaint every multichart cell", () => {
  assert.deepEqual(runTickerFrame(), { calls: 0, pending: 0 });
});

test("one changed ticker schedules exactly one multichart update", () => {
  assert.deepEqual(runTickerFrame(["BN:BTCUSDT"]), { calls: 1, pending: 0 });
});

test("a live grid candle mutation invalidates cached indicator data", () => {
  const klass = /class ChartInstance \{[^]*?\n\}/.exec(source);
  assert.ok(klass, "missing ChartInstance");
  const Chart = new Function("TF_MS", "clearCandleCaches", `
    const activeView = "screener", screenerView = "multichart";
    const sanitizeCandle = value => value;
    const fP = String;
    ${klass[0]}
    return ChartInstance;
  `)({ "1m": 60000 }, data => { delete data._cache; });

  const candle = { t: 1_700_000_000_000, o: 100, h: 101, l: 99, c: 100, v: 10 };
  const candles = [candle];
  candles._cache = { atr_14: [123], cvd: [456] };
  const cell = {
    candles,
    tf: "1m",
    _lastTradeTime: 0,
    offsetX: 0,
    headerPrice: { textContent: "" },
    refreshFormationLevels() {},
    draw() {},
  };

  Chart.prototype.applyOfficialTick.call(cell, [candle.t + 1, 100, 102, 98]);
  assert.equal(candles._cache, undefined);
});

test("the global ticker feed only updates headers when an official chart stream is active", () => {
  const klass = /class ChartInstance \{[^]*?\n\}/.exec(source);
  assert.ok(klass, "missing ChartInstance");
  const Chart = new Function("TF_MS", `
    const activeView = "screener", screenerView = "multichart";
    const fP = String, fC = String, clearCandleCaches = () => {};
    ${klass[0]}
    return ChartInstance;
  `)({ "1m": 60000 });

  let draws = 0;
  const cell = {
    dirty: false,
    ex: "BN",
    sym: "BTCUSDT",
    key: "BN:BTCUSDT",
    tf: "1m",
    candles: [{ t: Date.now() - 1000, o: 100, h: 101, l: 99, c: 100, v: 1 }],
    _marketUnsub() {},
    headerExIcon: { style: {} },
    headerSym: { textContent: "" },
    headerTf: { textContent: "" },
    headerPrice: { textContent: "" },
    headerChg: { textContent: "", className: "" },
    draw() { draws++; },
    loadKlines() { throw new Error("identity did not change"); },
  };

  Chart.prototype.update.call(cell, { ex: "BN", sym: "BTCUSDT", p: 101, chg: 1 });
  assert.equal(draws, 0);
  assert.equal(cell.dirty, false);
  assert.equal(cell.headerPrice.textContent, "101");
});
