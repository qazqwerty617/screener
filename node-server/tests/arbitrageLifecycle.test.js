"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { JSDOM } = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../public/js/arbitrage.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(t) {
  const dom = new JSDOM(html, { url: "https://obsidianscreener.com", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.localStorage.setItem("arbFavorites", "{broken");
  w.console.warn = () => {};
  w.eval(script);
  t.after(() => { w.CryptoArbitrage.deactivate(); w.close(); });
  return w;
}
test("mode changes discard late responses and leaving arbitrage stops rendering", async t => {
  const w = setup(t), requests = [];
  w.fetch = url => new Promise(resolve => requests.push({ url, resolve }));
  w.CryptoArbitrage.activate();
  assert.equal(requests.length, 1, "malformed favorites must not break initialization");
  w.document.querySelector('[data-arb-mode="dex"]').click();
  requests[0].resolve({ ok: true, json: async () => ({ spreads: [], funding: [], generatedAt: Date.now() }) });
  await tick();
  assert.equal(requests.length, 2); assert.match(requests[1].url, /\/dex\?/);
  const badge = w.document.getElementById("arb-dex-badge").textContent;
  w.CryptoArbitrage.deactivate();
  requests[1].resolve({ ok: true, json: async () => ({ rows: [], total: 999, generatedAt: Date.now() }) });
  await tick();
  assert.equal(w.document.getElementById("arb-dex-badge").textContent, badge);
  await w.CryptoArbitrage.refresh(); assert.equal(requests.length, 2);
});
test("offline arbitrage remains labelled offline when the user changes sorting", async t => {
  const w = setup(t);
  w.fetch = async () => ({ ok: true, json: async () => ({ spreads: [], funding: [], generatedAt: Date.now() }) });
  w.CryptoArbitrage.activate(); await tick();
  w.fetch = async () => { throw new Error("offline"); };
  await w.CryptoArbitrage.refresh();
  const age = w.document.getElementById("arb-update-age");
  assert.match(age.textContent, /Нет связи/);
  w.document.getElementById("arb-sort").dispatchEvent(new w.Event("change"));
  assert.match(age.textContent, /Нет связи/);
});
