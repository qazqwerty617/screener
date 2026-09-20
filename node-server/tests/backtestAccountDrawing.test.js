"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "../public/js/backtest.js"), "utf8");
const mainChart = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

test("backtest cannot open a position larger than balance times selected leverage", () => {
  const start = source.indexOf("  function openPosition(");
  const end = source.indexOf("  function updateTrade(", start);
  assert.ok(start >= 0 && end > start);
  const state = {
    loading: false, session: { id: "case" }, position: null, done: false,
    candles: [{ c: 100, t: 123 }], plannedDirection: "long", balance: 10000,
    leverage: 2,
  };
  const fields = { "bt-size": { value: "1000000000" }, "bt-commit-plan": { disabled: false } };
  const openPosition = new Function("state", "$", "getPlannedLevels", "renderPosition", "draw",
    "maxPositionSize", "showResult", "updatePositionLimits", "money",
    `${source.slice(start, end)}; return openPosition;`)(state, id => fields[id], () => ({ sl: 0, tp: 0 }),
      () => {}, () => {}, () => state.balance * state.leverage, () => {}, () => {}, value => `$${value}`);
  openPosition();
  assert.ok(!state.position || state.position.size <= 20000);
  fields["bt-size"].value = "20000";
  openPosition();
  assert.equal(state.position?.size, 20000);
});

test("ruler preview follows both candle time and price like the main chart", () => {
  assert.doesNotMatch(source, /state\.draft\.b = state\.draft\.type === "ruler" \? \{ \.\.\.point, t: state\.draft\.a\.t \} : point/);
});

test("backtest exposes every drawing tool from the main chart", () => {
  const main = html.slice(html.indexOf('<div id="draw-tools">'), html.indexOf('<div id="chart-density-panel"'));
  const backtest = html.slice(html.indexOf('<div id="bt-draw-tools"'), html.indexOf('<div id="bt-loader"'));
  const names = [...main.matchAll(/data-tool="([^"]+)"/g)].map(match => match[1]);
  const backtestNames = [...backtest.matchAll(/data-bt-tool="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(backtestNames, names);
});

test("Fibonacci drawing in backtest opens the main chart's level editor", () => {
  assert.match(mainChart, /window\.openSharedFibEditor = configureFibDrawing/);
  assert.match(source, /window\.openSharedFibEditor\(adapter,/);
  assert.match(source, /window\.getSharedFibRows\(o\)/);
});

test("drawing points can anchor in the future gap instead of snapping to the last candle", () => {
  const start = source.indexOf("  function drawingPointFromMouse(");
  const end = source.indexOf("  function drawUserObjects(", start);
  assert.ok(start >= 0 && end > start);
  const metrics = () => ({ plot: { w: 100, priceH: 100 }, stepX: 10, data: [0, 10, 20, 30, 40].map(t => ({ t })), min: 0, max: 100,
    xForIndex: index => (index + .5) * 10 });
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const point = new Function("metrics", "canvas", "state", `${source.slice(start, end)}; return drawingPointFromMouse;`)(
    metrics, canvas, { magnet: false })({ clientX: 85, clientY: 50 });
  assert.equal(point.t, 80);
});

test("backtest account restores balance instead of starting at ten thousand on every load", () => {
  const start = source.indexOf("  function loadBacktestAccount() {");
  const end = source.indexOf("  const savedAccount =", start);
  assert.ok(start >= 0 && end > start);
  const load = new Function("localStorage", "BACKTEST_ACCOUNT_KEY",
    `${source.slice(start, end)}; return loadBacktestAccount;`)(
      { getItem: () => JSON.stringify({ balance: 15000, leverage: 5 }) }, "test-account");
  assert.deepEqual(load(), { balance: 15000, leverage: 5 });
  const bad = new Function("localStorage", "BACKTEST_ACCOUNT_KEY",
    `${source.slice(start, end)}; return loadBacktestAccount;`)(
      { getItem: () => JSON.stringify({ balance: -1, leverage: 100 }) }, "test-account");
  assert.deepEqual(bad(), { balance: 10000, leverage: 1 });
});

test("closing a profitable training trade saves the new balance", () => {
  const start = source.indexOf("  function closePosition(");
  const end = source.indexOf("  function renderPosition(", start);
  assert.ok(start >= 0 && end > start);
  const state = { balance: 10000, candles: [{ t: 123 }], position: { direction: "long", entry: 100, qty: 100 },
    plannedDirection: "long", trades: [] };
  const fields = { "bt-long": { classList: { remove() {} } }, "bt-short": { classList: { remove() {} } } };
  let saved = 0;
  const close = new Function("state", "$", "saveBacktestAccount", "renderPosition", "renderStats", "draw",
    `${source.slice(start, end)}; return closePosition;`)(state, id => fields[id], () => { saved = state.balance; },
      () => {}, () => {}, () => {});
  close(150);
  assert.equal(state.balance, 15000);
  assert.equal(saved, 15000);
});

test("backtest UI restores saved balance and leverage and resets only on request", t => {
  const dom = new JSDOM(html, { url: "http://localhost", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.localStorage.setItem("obsidian_backtest_account_v1", JSON.stringify({ balance: 15000, leverage: 5 }));
  const gradient = { addColorStop() {} };
  const context = new Proxy({ canvas: null, measureText: value => ({ width: String(value).length * 6 }), createLinearGradient: () => gradient }, {
    get(target, key) { return key in target ? target[key] : () => {}; },
  });
  w.HTMLCanvasElement.prototype.getContext = function () { context.canvas = this; return context; };
  w.ResizeObserver = class { observe() {} };
  w.setTimeout = () => 0;
  w.setInterval = () => 0;
  w.confirm = () => true;
  w.eval(source);
  assert.equal(w.document.getElementById("bt-balance").textContent, "$15,000.00");
  assert.equal(w.document.getElementById("bt-leverage").value, "5");
  assert.equal(w.document.getElementById("bt-size").max, "75000");
  const leverageInput = w.document.getElementById("bt-leverage");
  leverageInput.value = "50";
  leverageInput.dispatchEvent(new w.Event("change"));
  assert.equal(w.document.getElementById("bt-size").max, "750000");
  assert.equal(JSON.parse(w.localStorage.getItem("obsidian_backtest_account_v1")).leverage, 50);
  w.document.getElementById("bt-reset-balance").click();
  assert.equal(w.document.getElementById("bt-balance").textContent, "$10,000.00");
  assert.equal(JSON.parse(w.localStorage.getItem("obsidian_backtest_account_v1")).balance, 10000);
});
