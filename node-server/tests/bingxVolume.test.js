"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

test("BingX direct websocket preserves REST dollar volume instead of inflating cheap-coin bars", async () => {
  const timestamp = 1789884900000;
  const context = vm.createContext({
    console, klWs: null, klPoll: null, mainMarketKey: "", mainMarketUnsubscribe: null,
    marketKey: () => "BX:ZIL-USDT:5m", subscribeMarketData: () => () => {},
    applyMainMarketStatus: () => {}, normalizeTimestamp: Number,
    WebSocket: class { close() {} send() {} },
    activeEx: "BX", activeSym: "ZIL-USDT", activeTf: "5m", TF_MS: { "5m": 300000 },
    isLoadingKlines: false, lastMarketEventAt: 0, sanitizeCandle: c => c,
    clearCandleCaches: () => {}, updateOHLC: () => {}, checkPriceAlerts: () => {},
  });
  vm.runInContext(server.slice(server.indexOf("function parseKlines("), server.indexOf("// Venues without a native three-day candle")), context);
  const history = context.parseKlines("BX", { data: [{ time: timestamp,
    open: "0.003684", high: "0.003696", low: "0.003672", close: "0.003690", volume: "1899222" }] });
  context.candles = history;
  vm.runInContext(app.slice(app.indexOf("function appendCandle("), app.indexOf("let lastAppliedTradeTime")), context);
  vm.runInContext(app.slice(app.indexOf("function connectKlWs("), app.indexOf("function updateOHLC()")), context);
  context.connectKlWs("BX", "ZIL-USDT", "5m");
  const send = volume => context.klWs.onmessage({ data: JSON.stringify({
    dataType: "ZIL-USDT@kline_5m", data: [{ T: timestamp,
      o: "0.003684", h: "0.003696", l: "0.003672", c: "0.003690", v: String(volume) }],
  }) });
  await send(1899222);
  assert.equal(context.candles[0].v, 1899222 * 0.003690);
  await send(2000000);
  assert.equal(context.candles[0].v, 7380);
});
