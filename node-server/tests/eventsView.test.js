"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

test("events tab renders sourced news and filters spot and futures listings", async t => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/js/events.js"), "utf8");
  const dom = new JSDOM(html, { url: "https://obsidianscreener.com", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  assert.ok(w.document.getElementById("events-calendar"), "listings have a month calendar");
  assert.doesNotMatch(w.document.querySelector(".events-heading").textContent, /Важные новости и новые торговые пары/);
  assert.equal(w.document.querySelector(".events-filters select"), null, "event filters use the screener-style menu");
  let stream;
  w.EventSource = class {
    constructor(url) { assert.equal(url, "/api/events/stream"); stream = this; }
    addEventListener(type, callback) { (this.callbacks ||= {})[type] = callback; }
    close() { this.closed = true; }
  };
  w.fetch = async () => ({ ok: true, json: async () => ({
    marketUpdatedAt: Date.now(), newsUpdatedAt: Date.now(),
    venues: { BN: { status: "ok" } },
    news: [{ title: "Exchange hack", titleRu: "Биржу взломали", source: "CoinDesk", url: "https://example.com/report",
      publishedAt: Date.now(), priority: "urgent", verification: { status: "corroborated", sources: [] } }],
    listings: [
      { exchange: "BN", type: "spot", symbol: "NEW/USDT", detectedAt: Date.now() },
      { exchange: "BB", type: "futures", symbol: "NEXT/USDT:USDT", detectedAt: Date.now(), launchAt: Date.now() + 86400000 },
      { exchange: "BB", type: "futures", symbol: "REMOVE/USDT:USDT", kind: "delisting", detectedAt: Date.now(), delistAt: Date.now() + 86400000 },
      { exchange: "BN", type: "spot", symbol: "GONE/USDT", kind: "delisting", detectedAt: Date.now(), launchAt: null }
    ]
  }) });
  w.eval(script);
  assert.ok(stream, "alerts connect on every tab");
  assert.equal(w.document.querySelectorAll(".toast-urgent-news").length, 0, "old feed rows are not replayed");
  w.ObsidianEvents.activate();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(w.document.getElementById("events-urgent-list").textContent, /Exchange hack/);
  assert.match(w.document.getElementById("events-urgent-list").textContent, /Биржу взломали/);
  assert.equal(typeof stream.callbacks.update, "function");
  w.document.getElementById("events-tab-listings").click();
  assert.match(w.document.getElementById("events-day-list").textContent, /NEW\/USDT/);
  assert.match(w.document.getElementById("events-day-list").textContent, /GONE\/USDT/);
  w.document.querySelector('.events-segment [data-kind="delisting"]').click();
  assert.doesNotMatch(w.document.getElementById("events-day-list").textContent, /NEW\/USDT/);
  assert.match(w.document.getElementById("events-day-list").textContent, /исчезла из каталога/);
  w.document.querySelector('.events-segment [data-kind="all"]').click();
  w.document.getElementById("events-market").click();
  assert.equal(w.document.getElementById("events-market").getAttribute("aria-expanded"), "true");
  w.document.querySelector('.events-picker[data-picker="market"] [data-value="spot"]').click();
  assert.equal(w.document.getElementById("events-market").getAttribute("aria-expanded"), "false");
  assert.match(w.document.getElementById("events-day-list").textContent, /NEW\/USDT/);
  w.document.getElementById("events-exchange").click();
  w.document.querySelector('.events-picker[data-picker="exchange"] [data-value="BB"]').click();
  assert.doesNotMatch(w.document.getElementById("events-day-list").textContent, /NEW\/USDT/);
  w.document.querySelector('.events-picker[data-picker="market"] [data-value="futures"]').click();
  const tomorrow = new Date(Date.now() + 86400000);
  const key = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  if (!w.document.querySelector(`[data-date="${key}"]`)) w.document.getElementById("events-next-month").click();
  w.document.querySelector(`[data-date="${key}"]`).click();
  assert.match(w.document.getElementById("events-day-list").textContent, /NEXT\/USDT/);
  assert.match(w.document.getElementById("events-day-list").textContent, /REMOVE\/USDT/);
  assert.match(w.document.getElementById("events-day-list").textContent, /делистинг · дата биржи/);
  w.ObsidianEvents.deactivate();
  assert.equal(stream.closed, undefined, "alerts stay connected outside Events");
  w.ObsidianEvents.stopAlerts();
  assert.equal(stream.closed, true);
});

test("urgent toast appears site-wide once and translation updates its text", t => {
  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "../public/js/events.js"), "utf8");
  const dom = new JSDOM(html, { url: "https://obsidianscreener.com", runScripts: "outside-only" });
  const w = dom.window;
  let stream;
  w.EventSource = class {
    constructor() { stream = this; }
    addEventListener(type, callback) { (this.callbacks ||= {})[type] = callback; }
    close() { this.closed = true; }
  };
  t.after(() => { w.ObsidianEvents.stopAlerts(); w.close(); });
  w.eval(script);
  const item = { title: "Exchange suffers a hack", url: "https://example.com/hack", source: "Test Wire",
    publishedAt: Date.now(), alertKind: "security", verification: { status: "corroborated", sources: [] } };
  stream.callbacks.urgent({ data: JSON.stringify(item) });
  const card = w.document.querySelector(".toast-urgent-news");
  assert.ok(card);
  assert.match(card.textContent, /Возможный взлом/);
  assert.match(card.textContent, /Test Wire/);
  assert.equal(card.querySelector("a").href, item.url);
  stream.callbacks.translation({ data: JSON.stringify({ ...item, titleRu: "Биржу взломали" }) });
  assert.match(card.textContent, /Биржу взломали/);
  stream.callbacks.urgent({ data: JSON.stringify(item) });
  assert.equal(w.document.querySelectorAll(".toast-urgent-news").length, 1);
  stream.callbacks.urgent({ data: JSON.stringify({ ...item, url: "javascript:alert(1)" }) });
  assert.equal(w.document.querySelectorAll(".toast-urgent-news").length, 1);
  stream.callbacks.urgent({ data: JSON.stringify({ ...item, url: "https://example.com/pending", verification: { status: "pending" } }) });
  assert.equal(w.document.querySelectorAll(".toast-urgent-news").length, 1);
  stream.callbacks.retract({ data: JSON.stringify(item) });
  assert.equal(w.document.querySelectorAll(".toast-urgent-news").length, 0);
});
