"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const client = fs.readFileSync(path.join(root, "public", "js", "arbitrage.js"), "utf8");
const chart = fs.readFileSync(path.join(root, "public", "js", "arbitrage-pro.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const arbitrageHtml = html.slice(html.indexOf('id="arbitrage-view"'), html.indexOf('id="backtest-view"'));

test("arbitrage table exposes entry, round-trip result, immediate close and transfer availability", () => {
  assert.match(html, /Вход после fees/);
  assert.match(html, /Net при схождении/);
  assert.match(html, /Закрыть сейчас/);
  assert.match(html, /Депозит \/ вывод/);
  assert.match(html, /id="arb-transfer-only"/);
  assert.match(client, /r\.roundTripNet/);
  assert.match(client, /r\.closeNowNet/);
  assert.match(client, /\/api\/arbitrage\/transfers\?routes=/);
});

test("spread chart uses only synchronized server history for entry and exit", () => {
  assert.match(chart, /raw\[5\]/);
  assert.match(chart, /key: 'spread', label: 'Вход'/);
  assert.match(chart, /key: 'exit', label: 'Выход'/);
  assert.match(chart, /\/api\/arbitrage\/history\?key=/);
  assert.doesNotMatch(chart, /window\.coins/);
  assert.doesNotMatch(chart, /recordLivePoint/);
});

test("arbitrage drawer has one unified spread and normalized price chart", () => {
  assert.match(html, /data-arb-chart-view="spread"/);
  assert.match(html, /data-arb-chart-view="index"/);
  assert.match(html, /id="arb-chart-min"/);
  assert.match(html, /id="arb-chart-avg"/);
  assert.match(chart, /buyIndex: point\.buyP \/ baseBuy \* 100/);
  assert.match(chart, /Ориентировочный.*Mid/);
  assert.doesNotMatch(html, /id="arb-buy-chart"/);
  assert.doesNotMatch(html, /id="arb-sell-chart"/);
});

test("spread chart makes break-even and profitable time visually explicit", () => {
  assert.match(html, /id="arb-chart-positive"/);
  assert.match(html, /id="arb-chart-age"/);
  assert.match(chart, /values\.push\(0\)/);
  assert.match(chart, /БЕЗУБЫТОК/);
  assert.match(chart, /rgba\(43,217,138/);
  assert.match(chart, /rgba\(239,100,122/);
});

test("arbitrage exposes a separate contract-verified CEX to DEX workspace", () => {
  assert.match(arbitrageHtml, /data-arb-mode="dex"/);
  assert.match(arbitrageHtml, /id="arb-dex-table"/);
  assert.match(arbitrageHtml, /Точный контракт/);
  assert.match(client, /\/api\/arbitrage\/dex\?/);
  assert.match(client, /contractMatch/);
  assert.match(server, /app\.get\("\/api\/arbitrage\/dex"/);
  assert.match(server, /createDexArbitrageService/);
});

test("CEX to DEX rows open a detail drawer with their own price history", () => {
  assert.match(client, /data-dex-id=/);
  assert.match(client, /function openDexDetail\(row\)/);
  assert.match(client, /window\.ArbitragePro\?\.openDex\(row\)/);
  assert.match(chart, /async function openDex\(row\)/);
  assert.match(server, /app\.get\("\/api\/arbitrage\/dex\/history"/);
});

test("arbitrage header has one quiet freshness indicator instead of repeated live lights", () => {
  assert.doesNotMatch(arbitrageHtml, /LIVE BBO/i);
  assert.doesNotMatch(arbitrageHtml, /Рынок онлайн/i);
  assert.doesNotMatch(arbitrageHtml, /ask → bid/i);
  assert.match(arbitrageHtml, /id="arb-update-age"/);
});

test("settings do not expose an empty trading tab", () => {
  assert.doesNotMatch(html, /data-tab="trading"/);
  assert.doesNotMatch(html, /id="tab-trading"/);
});

test("transfer status endpoint is public read-only data", () => {
  assert.match(server, /app\.get\("\/api\/arbitrage\/transfers"/);
  assert.match(server, /createTransferStatusService\(apiFetch\)/);
});

test("funding UI is event-based and never projects a temporary rate for a month or year", () => {
  assert.match(arbitrageHtml, /Ближайшая выплата/);
  assert.match(arbitrageHtml, /Edge \/ ч/);
  assert.match(arbitrageHtml, /Окупаемость fees/);
  assert.doesNotMatch(arbitrageHtml, /30 дней/i);
  assert.doesNotMatch(arbitrageHtml, /APR/i);
  assert.match(client, /r\.nextEventEdge/);
  assert.match(client, /r\.breakEvenHours/);
  assert.doesNotMatch(client, /r\.monthly/);
  assert.doesNotMatch(client, /r\.apr/);
});
