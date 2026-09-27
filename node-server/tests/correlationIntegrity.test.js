"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../correlationEngine.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
function harness() {
  let now = 1_790_000_000_000;
  const context = { require, __dirname, module: { exports: {} }, console: { log() {}, warn() {} },
    process, Date: { now: () => now } };
  vm.runInNewContext(source, context);
  const engine = context.module.exports, messages = [];
  engine.tickers = new Map(); engine.broadcastFn = (type, data) => messages.push(data);
  function sample(i, includeToken = true) {
    now += 5000;
    engine.tickers.set("BN:BTCUSDT", { key: "BN:BTCUSDT", p: 100 + i, quoteTs: now });
    if (includeToken) engine.tickers.set("BN:BREWUSDT", { key: "BN:BREWUSDT", p: 10 + i, quoteTs: now });
    engine.tick();
  }
  for (let i = 0; i < 10; i++) sample(i);
  return { engine, messages, sample, advance: ms => { now += ms; } };
}
test("stale prices stop producing live correlations and broadcast removal", () => {
  const { engine, messages, sample } = harness();
  assert.equal(engine.getCorrelation("BN:BREWUSDT"), 100);
  for (let i = 10; i < 20; i++) sample(i, false);
  assert.equal(engine.getCorrelation("BN:BREWUSDT"), undefined);
  assert.ok(messages.some(m => m["BN:BREWUSDT"] === null));
});
test("a missing sampling interval cannot join unrelated periods", () => {
  const { engine, sample, advance } = harness();
  advance(60000); sample(20);
  assert.equal(engine.getCorrelation("BN:BREWUSDT"), undefined);
  for (let i = 21; i < 25; i++) sample(i);
  assert.equal(engine.getCorrelation("BN:BREWUSDT"), 100);
});
test("eviction works even when the entire ticker feed disappears", () => {
  const { engine, advance } = harness();
  engine.tickers.clear();
  for (let i = 0; i < 26; i++) { advance(5000); engine.tick(); }
  assert.equal(engine.priceHistories.size, 0);
  assert.equal(engine.correlationMap.size, 0);
});
test("correlation removal reaches the visible coin state", () => {
  const coin = { corr: 98 };
  const context = { coins: new Map([["BN:BREWUSDT", coin]]), activeEx: "BN", activeSym: "BTCUSDT", needRebuild: false };
  vm.runInNewContext(/function applyServerCorrelations\([^]*?\n\}/.exec(app)[0], context);
  context.applyServerCorrelations({ "BN:BREWUSDT": null });
  assert.equal(coin.corr, undefined);
  assert.equal(context.needRebuild, true);
});
test("browser timers cannot overwrite the server correlation with a second sample window", () => {
  assert.doesNotMatch(app, /setInterval\(updatePriceHistory/);
});
test("reconnect snapshot clears correlations no longer present on the server", () => {
  const coin = { corr: 98 };
  const context = { coins: new Map([["BN:BREWUSDT", coin]]), activeEx: "BN", activeSym: "BTCUSDT", needRebuild: false };
  vm.runInNewContext(/function applyServerCorrelations\([^]*?\n\}/.exec(app)[0], context);
  context.applyServerCorrelations({}, true);
  assert.equal(coin.corr, undefined);
});
