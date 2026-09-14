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

test("arbitrage table exposes entry, exit and transfer availability", () => {
  assert.match(html, /Спред входа/);
  assert.match(html, /Спред выхода/);
  assert.match(html, /Депозит \/ вывод/);
  assert.match(html, /id="arb-transfer-only"/);
  assert.match(client, /r\.exitNet/);
  assert.match(client, /\/api\/arbitrage\/transfers\?routes=/);
});

test("spread chart uses recorded executable entry and exit BBO", () => {
  assert.match(chart, /point\[5\]/);
  assert.match(chart, /drawSeries\('spread', '#24d383'/);
  assert.match(chart, /drawSeries\('exit', '#ef556a'/);
  assert.doesNotMatch(chart, /Robust historical timeframe timeline merger with forward-fill/);
});

test("transfer status endpoint is public read-only data", () => {
  assert.match(server, /app\.get\("\/api\/arbitrage\/transfers"/);
  assert.match(server, /createTransferStatusService\(apiFetch\)/);
});
