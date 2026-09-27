"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
function harness(withDictionary = false) {
  // Source may be checked out with CRLF.
  const normalized = source.replace(/\r\n/g, "\n");
  const from = normalized.indexOf('setInterval(() => {\n  if (clients.size === 0 || dirtyKeys.size === 0)');
  const code = normalized.slice(from, normalized.indexOf("}, 50);", from) + 7);
  const queued = [];
  const socket = { readyState: 1, bufferedAmount: 0, send: buffer => queued.push(buffer), terminate() { this.terminated = true; } };
  const context = { Buffer, WebSocket: { OPEN: 1 }, clients: new Set([socket]), dirtyKeys: new Set(["BN:X"]),
    tickers: new Map([["BN:X", { p: 100 }]]), reusableBroadcastBuffer: Buffer.alloc(880), getTickerIndex: () => 1,
    flushTickerMap: () => {},
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
    setInterval: fn => { context.tick = fn; } };
  if (withDictionary) {
    const start = normalized.indexOf("const tickerIndex = new Map()");
    vm.runInNewContext(normalized.slice(start, normalized.indexOf("// Broadcast loop:", start)), context);
  }
  vm.runInNewContext(code, context);
  return { context, queued, socket };
}
test("a queued WebSocket binary frame cannot be overwritten by the next tick", () => {
  const { context, queued } = harness();
  context.tick();
  context.tickers.get("BN:X").p = 200; context.dirtyKeys.add("BN:X"); context.tick();
  assert.equal(queued[0].readDoubleLE(8), 100);
  assert.equal(queued[1].readDoubleLE(8), 200);
});
test("an overloaded client reconnects instead of silently losing deltas", () => {
  const { context, socket } = harness();
  socket.bufferedAmount = 3000000; context.tick();
  assert.equal(socket.terminated, true);
});

test("broadcast deltas invalidate cached snapshots before a new client joins", () => {
  const { context } = harness();
  context.cachedSnapshotMsg = "snapshot from before this delta";
  context.tick();
  assert.equal(context.cachedSnapshotMsg, null);
});
test("new ticker IDs arrive before the binary frame that uses them", () => {
  const { context, queued } = harness(true);
  context.tickers.set("BB:Y", { p: 200 }); context.dirtyKeys.add("BB:Y");
  context.tick();
  assert.equal(typeof queued[0], "string", "ticker dictionary must precede binary data");
  const dictionary = JSON.parse(queued[0]);
  assert.equal(dictionary.type, "ticker_map");
  assert.equal(dictionary.data["BN:X"], queued[1].readDoubleLE(0));
  assert.equal(dictionary.data["BB:Y"], queued[1].readDoubleLE(88));
  assert.equal(queued.length, 2, "one batched dictionary, one data frame");
});
test("browser rejects truncated and non-finite binary frames without corrupting the last price", () => {
  const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
  const start = app.indexOf("if (e.data instanceof ArrayBuffer)");
  const branch = app.slice(start, app.indexOf("let msg;", start));
  const coin = { p: 100, ex: "BN", sym: "X" };
  const context = { ArrayBuffer, Float64Array, idToKey: { 0: "BN:X" }, coins: new Map([["BN:X", coin]]),
    markTickerDirty() {}, scheduleInterp() {}, checkPriceAlerts() {}, window: {}, activeEx: "BB", activeSym: "Y" };
  vm.runInNewContext(`function receive(e) { ${branch} }`, context);
  assert.doesNotThrow(() => context.receive({ data: new ArrayBuffer(17) }));
  context.receive({ data: new Float64Array([0, NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer });
  assert.equal(coin.p, 100);
  context.receive({ data: new Float64Array([0, 101, 0, 1e6, 102, 99, 100, 0, 0, 0, 0]).buffer });
  assert.equal(coin.p, 101);
});
