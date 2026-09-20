"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");

test("toast renders account and API text without interpreting HTML", () => {
  const start = source.indexOf("function showToast(");
  const end = source.indexOf("window.showToast = showToast;", start);
  assert.ok(start >= 0 && end > start);
  const dom = new JSDOM('<div id="toast-container"></div>');
  const context = {
    document: dom.window.document,
    window: dom.window,
    setTimeout: () => 1,
    console,
    $: id => dom.window.document.getElementById(id),
  };
  vm.runInNewContext(source.slice(start, end + "window.showToast = showToast;".length), context);
  const attack = '<img src=x onerror="window.pwned=1">';
  context.showToast({ title: attack, message: attack, type: "info" });
  const card = dom.window.document.querySelector(".toast-card");
  assert.equal(card.querySelectorAll("img").length, 0);
  assert.ok(card.querySelector(".toast-title").textContent.endsWith(attack));
  assert.equal(card.querySelector(".toast-body").textContent, attack);
});

test("browser WebSocket URL never carries the session token", () => {
  const start = source.indexOf("function connectWS() {");
  const end = source.indexOf("  ws.onopen = () => {", start);
  assert.ok(start >= 0 && end > start);
  const connectSetup = source.slice(start, end);
  assert.doesNotMatch(connectSetup, /tokenQuery|searchParams|encodeURIComponent\(curToken\)/);
  assert.match(source.slice(end, end + 500), /ws\.send\(JSON\.stringify\(\{ type: "auth", token: activeToken \}\)\)/);
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.doesNotMatch(server, /urlObj\.searchParams\.get\("(?:token|auth)"\)/);
});

test("market symbols in alert cards are text and cannot become event handlers", () => {
  const start = source.indexOf("function pdRenderCards() {");
  const end = source.indexOf("function pdUpdateBadge()", start);
  assert.ok(start >= 0 && end > start);
  const dom = new JSDOM('<div id="pd-alerts-list"></div>');
  const attack = '\"><img src=x onerror="window.pwned=1">';
  const context = {
    document: dom.window.document,
    window: dom.window,
    pdSettings: { minPct: 2, periodMinutes: 5 },
    pdAlertCards: [{ ex: "BN", sym: attack, exFull: "Binance", pct: 3, dateStr: "today", timeStr: "now", periodLabel: "5m", volStr: "100", pctStr: "+3%", price: "1" }],
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.pdRenderCards();
  const card = dom.window.document.querySelector(".pd-alert-card");
  assert.equal(card.querySelectorAll("img").length, 0);
  assert.equal(card.querySelector(".pd-card-sym").firstChild.textContent, attack);
  assert.equal(card.hasAttribute("onclick"), false);
});

test("orchestrator metrics reject public and proxied requests", () => {
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const start = server.indexOf('app.get("/api/orchestrator/status"');
  const end = server.indexOf("/**", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  vm.runInNewContext(server.slice(start, end), {
    app: { get: (_path, fn) => { handler = fn; } },
    securityShield: { normalizeIp: ip => ip },
    process,
    tickers: { size: 0 },
    clients: { size: 0 },
    exStatus: {},
  });
  const request = (remoteAddress, headers = {}) => {
    const result = { statusCode: 200 };
    const res = {
      setHeader() {},
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; return this; },
    };
    handler({ socket: { remoteAddress }, headers }, res);
    return result;
  };
  assert.equal(request("127.0.0.1").statusCode, 200);
  assert.equal(request("127.0.0.1", { "x-real-ip": "203.0.113.10" }).statusCode, 403);
  assert.equal(request("203.0.113.10").statusCode, 403);
});
