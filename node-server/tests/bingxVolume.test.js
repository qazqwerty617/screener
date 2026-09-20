"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { EventEmitter } = require("node:events");
const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");

// Exercise the actual REST parser and canvas histogram together: a volume
// transform must not turn unequal exchange volumes into equal-height bars.
function renderBingxVolumes(rows) {
  const rectangles = [];
  const context = vm.createContext({
    normalizeTimestamp: Number,
    window: {}, indicatorsHeight: 0, PW: 500, volumeHeight: 100,
    s: 0, viewStart: 0, candleW: 10, hw: 4, dpr: 1,
    getCanvasBgColor: () => "black", hexToRgba: color => color,
    vCtx: {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
      moveTo() {}, lineTo() {}, stroke() {},
      fillRect(x, y, width, height) { rectangles.push({ x, y, width, height }); },
    },
  });
  vm.runInContext(server.slice(server.indexOf("function parseKlines("), server.indexOf("// Venues without a native three-day candle")), context);
  context.vis = context.parseKlines("BX", { data: rows });
  const start = app.indexOf("// Draw Volume (Clean Histogram");
  const end = app.indexOf("const timeYStart = volumeYStart + volumeHeight;", start);
  assert.ok(start >= 0 && end > start, "Main chart volume renderer must be exercised");
  vm.runInContext(app.slice(start, end), context);
  return rectangles.slice(1); // The first rectangle is the panel background.
}

test("BingX histogram preserves different volumes and omits zero-volume bars", () => {
  const rows = [100, 800, 0].map((volume, i) => ({
    time: 1789905600000 + i * 60000,
    open: "0.02030", high: "0.02044", low: "0.02014", close: "0.02043",
    volume: String(volume),
  }));
  const bars = renderBingxVolumes(rows);
  assert.equal(bars.length, 2);
  assert.ok(Math.abs(bars[1].height / bars[0].height - 8) < 1e-10,
    "Eight times the volume must produce eight times the height");
});

test("Small volumes beside a spike retain their relative heights", () => {
  const rows = [1, 2, 4, 1000].map((volume, i) => ({
    time: 1789905600000 + i * 60000,
    open: "1", high: "1", low: "1", close: "1", volume: String(volume),
  }));
  const bars = renderBingxVolumes(rows);
  assert.equal(bars.length, 4);
  assert.ok(Math.abs(bars[1].height / bars[0].height - 2) < 1e-10);
  assert.ok(Math.abs(bars[2].height / bars[0].height - 4) < 1e-10);
  assert.ok(Math.abs(bars[3].height / bars[0].height - 1000) < 1e-10);
});

function functionSource(source, name) {
  const match = new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(source);
  assert.ok(match, `${name} must exist`);
  return match[0];
}

// Public BingX stream samples captured on 2026-09-20. Both adapters must
// preserve quote-volume units across expensive and sub-dollar assets.
const streamSamples = [
  ["BTC-USDT", "81222.8", "2.1971"],
  ["ETH-USDT", "2633.78", "4560.06"],
  ["SOL-USDT", "109.812", "1971.90"],
  ["DOGE-USDT", "0.08710", "19757"],
  ["ZIL-USDT", "0.003549", "329181"],
  ["FIDA-USDT", "0.02080", "48835.27"],
];

for (const [symbol, close, volume] of streamSamples) {
  test(`BingX ${symbol} browser answers compressed heartbeat and retains live volume`, async () => {
    const sent = [], candles = [];
    const context = vm.createContext({
      console, ArrayBuffer, Blob, Response, DecompressionStream,
      klWs: null, klPoll: null, mainMarketKey: "", mainMarketUnsubscribe: null,
      marketKey: () => `BX:${symbol}:1m`, subscribeMarketData: () => () => {},
      applyMainMarketStatus() {}, appendCandle: c => candles.push(c),
      WebSocket: class { readyState = 1; close() {} send(value) { sent.push(value); } },
    });
    vm.runInContext(functionSource(app, "connectKlWs"), context);
    context.connectKlWs("BX", symbol, "1m");
    const send = async message => {
      const compressed = zlib.gzipSync(message);
      await context.klWs.onmessage({ data: compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) });
    };
    await send("Ping");
    assert.deepEqual(sent, ["Pong"]);
    await send(JSON.stringify({ dataType: `${symbol}@kline_1m`, data: [{
      T: 1789924800000, o: close, h: close, l: close, c: close, v: volume,
    }] }));
    assert.equal(candles.length, 1);
    assert.equal(candles[0].v, +volume * +close);
  });

  test(`BingX ${symbol} server answers compressed heartbeat and retains live volume`, async () => {
    const sockets = [], candles = [], pending = [];
    class Socket extends EventEmitter {
      readyState = 1;
      sent = [];
      constructor() { super(); sockets.push(this); }
      send(value) { this.sent.push(value); }
    }
    const context = vm.createContext({
      WebSocket: Socket, console, closeSocket() {}, markMarketOpen() {},
      syntheticSourceTf: () => null, startKlinePolling() {}, scheduleKlineReconnect() {},
      setInterval: () => 1, clearInterval() {}, clearTimeout() {},
      broadcastKline: (ex, sym, tf, candle) => candles.push(candle),
      zlib: { gunzip(raw, callback) {
        pending.push(new Promise(resolve => zlib.gunzip(raw, (error, data) => {
          callback(error, data); resolve();
        })));
      } },
    });
    vm.runInContext(functionSource(server, "connectKlineWs"), context);
    context.connectKlineWs({ ex: "BX", sym: symbol, tf: "1m" });
    const socket = sockets[0];
    socket.emit("message", zlib.gzipSync("Ping"));
    await Promise.all(pending);
    assert.deepEqual(socket.sent, ["Pong"]);
    socket.emit("message", zlib.gzipSync(JSON.stringify({ dataType: `${symbol}@kline_1m`, data: [{
      T: 1789924800000, o: close, h: close, l: close, c: close, v: volume,
    }] })));
    await Promise.all(pending);
    assert.equal(candles.length, 1);
    assert.equal(candles[0].v, +volume * +close);
  });
}

test("BingX FIDA four-hour history retains the exchange's near-equal volumes", () => {
  // Closed bars from /openApi/swap/v2/quote/klines, FIDA-USDT, 4h.
  // The last bar's 10,728,311.39 FIDA also equals its 240 one-minute bars.
  const rows = [
    { time: 1789891200000, open: "0.02054", high: "0.02060", low: "0.02020", close: "0.02030", volume: "10797186.98" },
    { time: 1789905600000, open: "0.02030", high: "0.02044", low: "0.02014", close: "0.02043", volume: "10728311.39" },
  ];
  const bars = renderBingxVolumes(rows);
  assert.equal(bars.length, 2);
  const expectedRatio = (10728311.39 * 0.02043) / (10797186.98 * 0.02030);
  assert.ok(Math.abs(bars[1].height / bars[0].height - expectedRatio) < 1e-10,
    "Similar source volumes must stay similar, without invented variation");
});

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
