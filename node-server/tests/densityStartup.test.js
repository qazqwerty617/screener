"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const { createRequire } = require("node:module");
const { pm2Environment, memoryLimitMB } = require("../pm2Environment");

test("density universe and publication start even when metadata requests never settle", () => {
  const filename = path.resolve(__dirname, "../wallScanner.js");
  const intervals = [], timeouts = [], snapshots = [];
  const context = {
    module: { exports: {} }, require: createRequire(filename), process: { env: {} },
    console: { log() {}, warn() {}, error: console.error }, AbortSignal,
    fetch: () => new Promise(() => {}),
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  const scanner = context.module.exports;
  const tickers = new Map([["BN:BTCUSDT", { ex: "BN", sym: "BTCUSDT", base: "BTC", p: 90000, v: 1e9 }]]);
  scanner.startScanning(tickers, () => new Promise(() => {}), meta => snapshots.push(meta));
  for (const interval of [...intervals]) interval.fn();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].exchangeStatuses.BN.symbolsTotal, 1);
  // Ticker feeds populate after startup too, without a metadata completion.
  tickers.set("BB:ETHUSDT", { ex: "BB", sym: "ETHUSDT", base: "ETH", p: 3000, v: 1e8 });
  for (const interval of [...intervals]) interval.fn();
  assert.equal(snapshots.at(-1).exchangeStatuses.BB.symbolsTotal, 1);
  const count = intervals.length;
  scanner.startScanning(tickers, () => {}, () => {});
  assert.equal(intervals.length, count, "start remains idempotent");
});

test("PM2 recovery cannot inherit the orchestrator's process limits or identity", () => {
  const env = { PATH: "bin", PM2_HOME: "/pm2", NODE_ENV: "production", CUSTOM_TOKEN: "keep",
    max_memory_restart: "367001600", name: "orchestrator", node_args: "--max-old-space-size=512",
    pm_exec_path: "/orchestrator.js", pm_id: "1", restart_time: "9", NODE_APP_INSTANCE: "0" };
  assert.deepEqual(pm2Environment(env), { PATH: "bin", PM2_HOME: "/pm2", NODE_ENV: "production", CUSTOM_TOKEN: "keep" });
  assert.equal(env.name, "orchestrator");
});

test("memory limits are normalized from the ecosystem configuration, including PM2 byte values", () => {
  assert.equal(memoryLimitMB("1800M"), 1800);
  assert.equal(memoryLimitMB(1258291200), 1200);
  assert.equal(memoryLimitMB("1.5G"), 1536);
  assert.throws(() => memoryLimitMB("unlimited"));
  const app = require("../ecosystem.config").apps.find(item => item.name === "server");
  const heapMB = Number(/--max-old-space-size=(\d+)/.exec(app.node_args)[1]);
  assert.ok(memoryLimitMB(app.max_memory_restart) >= heapMB + 512, "leave room for buffers, native libraries and compilation");
});
