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
  let stream;
  w.EventSource = class {
    constructor(url) { assert.equal(url, "/api/events/stream"); stream = this; }
    addEventListener(type, callback) { if (type === "update") this.notify = callback; }
    close() { this.closed = true; }
  };
  w.fetch = async () => ({ ok: true, json: async () => ({
    marketUpdatedAt: Date.now(), newsUpdatedAt: Date.now(),
    venues: { BN: { status: "ok" } },
    news: [{ title: "Exchange hack", titleRu: "Биржу взломали", source: "CoinDesk", url: "https://example.com/report",
      publishedAt: Date.now(), priority: "urgent" }],
    listings: [
      { exchange: "BN", type: "spot", symbol: "NEW/USDT", detectedAt: Date.now() },
      { exchange: "BB", type: "futures", symbol: "NEXT/USDT:USDT", detectedAt: Date.now(), launchAt: Date.now() + 86400000 }
    ]
  }) });
  w.eval(script);
  w.ObsidianEvents.activate();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(w.document.getElementById("events-urgent-list").textContent, /Exchange hack/);
  assert.match(w.document.getElementById("events-urgent-list").textContent, /Биржу взломали/);
  assert.equal(typeof stream.notify, "function");
  w.document.getElementById("events-tab-listings").click();
  assert.match(w.document.getElementById("events-upcoming").textContent, /NEXT\/USDT/);
  w.document.getElementById("events-market").value = "spot";
  w.document.getElementById("events-market").dispatchEvent(new w.Event("change"));
  assert.doesNotMatch(w.document.getElementById("events-upcoming").textContent, /NEXT\/USDT/);
  assert.match(w.document.getElementById("events-past").textContent, /NEW\/USDT/);
  w.ObsidianEvents.deactivate();
  assert.equal(stream.closed, true);
});
