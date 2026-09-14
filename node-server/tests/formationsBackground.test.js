"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const section = source.slice(source.indexOf("  let formationsCols ="), source.indexOf("// ── OBSIDIAN PRO MODALS"));
const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)); };

function build(t, saved = {}) {
  const dom = new JSDOM(html, { url: "http://localhost", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const w = dom.window;
  for (const [key, value] of Object.entries(saved)) w.localStorage.setItem(key, value);
  const timers = [];
  const requests = [];
  const klines = new Map();
  let response = { "BN:BTCUSDT": [{ price: 102, direction: "up", touches: 3 }, { price: 103, direction: "up", touches: 3 }] };
  Object.assign(w, {
    $: id => w.document.getElementById(id), activeView: "screener", fullChartOpen: false,
    coins: new Map([["BN:BTCUSDT", { ex: "BN", sym: "BTCUSDT", p: 100, v: 1e8 }]]), chartInstances: [],
    formationMissesByCoin: new Map(), AbortController,
    isUsdtFutures: () => true, isStablecoinBase: () => false,
    schedulePreferencesSync() {}, requestAnimationFrame() {},
    setTimeout: fn => { timers.push(fn); return timers.length; }, setInterval: () => 0, clearTimeout() {},
    fetch: async url => { requests.push(url); if (response instanceof Error) throw response; return { ok: true, json: async () => url.includes('/snapshot') ? {
      tf: new URL(url, 'http://localhost').searchParams.get('tf'), updatedAt: Date.now(),
      maps: { cascades: response, levels: response, trendline: response, retest: response, approaching: {} }
    } : response }; },
    touchKlinesCache: key => klines.get(key), storeKlinesCache: (key, data) => klines.set(key, { data, ts: Date.now() }),
    fetchChartKlines: async () => [{ t: 1, o: 100, h: 101, l: 99, c: 100, v: 1 }],
    sanitizeCandles: data => data,
    ChartInstance: class { constructor(grid) { this.el = w.document.createElement("div"); grid.append(this.el); } update(c) { Object.assign(this, c); } draw() {} dispose() {} }
  });
  w.eval(section + "\nwindow.testRefresh = preloadFormationsInBackground;");
  return { w, timers, requests, klines, respond: data => { response = data; } };
}

test("background prepares chart candles before the formations tab is opened", async t => {
  const h = build(t);
  await h.w.testRefresh();
  await flush();
  assert.ok(h.klines.has("BN|BTCUSDT|15m"), "opening the tab must not start its first candle download");
  assert.equal(h.w.chartInstances.length, 0, "background must not construct hidden charts");
});

test("an empty server snapshot removes vanished formations and ends loading", async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  h.w.activeView = "formations"; h.w.loadFormations(); await flush();
  h.respond({});
  await h.w.testRefresh(); await flush();
  assert.equal(h.w.chartInstances.length, 0, "vanished signals must disappear");
  assert.doesNotMatch(h.w.$("formations-grid").textContent, /Загрузка/);
});

test("timeframe changes rebuild even when the same coins qualify", async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  h.w.activeView = "formations"; h.w.loadFormations(); await flush();
  h.w.document.querySelector('.fg-tf-btn[data-tf="1h"]').click(); await flush();
  assert.equal(h.w.chartInstances[0]?.tf, "1h");
});

test('search, volume and distance filter ready results without downloading maps again', async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  const before = h.requests.length;
  const input = h.w.$('formations-volume');
  input.value = '200000000'; input.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.w.chartInstances.length, 0);
  input.value = '0'; input.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.w.chartInstances.length, 1);
  const distance = h.w.$('formations-distance');
  distance.value = '0.5'; distance.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.w.chartInstances.length, 0);
  distance.value = '15'; distance.dispatchEvent(new h.w.Event('input'));
  const search = h.w.$('formations-search');
  search.value = 'ETH'; search.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.w.chartInstances.length, 0);
  await flush();
  assert.equal(h.requests.length, before);
});

test('network failure preserves the last snapshot and reports offline state', async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  h.respond(new Error('offline'));
  await h.w.testRefresh(); await flush();
  assert.equal(h.w.chartInstances.length, 1);
  assert.match(h.w.$('formations-status').textContent, /Нет связи/);
});

test('reload restores the selected workspace and its warmed chart candles', async t => {
  const first = build(t);
  await first.w.testRefresh(); await flush();
  const saved = first.w.localStorage.getItem('formations_workspace_v1');
  assert.ok(saved);
  const second = build(t, { formations_workspace_v1: saved, formations_nearest: 'true' });
  assert.ok(second.klines.has('BN|BTCUSDT|15m'));
  second.w.activeView = 'formations'; second.w.loadFormations();
  assert.equal(second.w.chartInstances.length, 1);
  assert.equal(second.w.$('formations-nearest-toggle').checked, true);
});

test('approaching retest mode uses its own map and keeps a valid empty result', async t => {
  const h = build(t, { formations_active_tab: 'retest', formations_approaching: 'true' });
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  assert.equal(h.w.chartInstances.length, 0);
  const toggle = h.w.$('formations-approaching-toggle');
  toggle.checked = false; toggle.dispatchEvent(new h.w.Event('change'));
  assert.equal(h.w.chartInstances.length, 1);
});

test('account preferences update the actual background workspace before opening the tab', async t => {
  const h = build(t);
  h.w.applyFormationsPreferences({ formationsTf: '1h', formationsActiveTab: 'breakout', formationsCols: 4,
    formationsMinCascade: 3, formationsExchanges: ['BN'], formationsFilters: { search: 'BTC', minVolume: 1000000, distancePct: 5 } });
  await flush();
  assert.equal(h.w.getFormationsPreferences().formationsTf, '1h');
  assert.equal(h.w.getFormationsPreferences().formationsActiveTab, 'breakout');
  assert.ok(h.klines.has('BN|BTCUSDT|1h'));
  h.w.activeView = 'formations'; h.w.loadFormations();
  assert.equal(h.w.chartInstances[0]?.tf, '1h');
});
