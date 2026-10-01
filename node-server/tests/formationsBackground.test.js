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
  const dom = new JSDOM(html, { url: "http://localhost", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  for (const [key, value] of Object.entries(saved)) w.localStorage.setItem(key, value);
  const timers = [];
  const requests = [];
  const klines = new Map();
  let response = { "BN:BTCUSDT": [{ price: 102, direction: "up", touches: 3 }, { price: 103, direction: "up", touches: 3 }] };
  let ranges;
  Object.assign(w, {
    $: id => w.document.getElementById(id), activeView: "screener", fullChartOpen: false,
    coins: new Map([["BN:BTCUSDT", { ex: "BN", sym: "BTCUSDT", p: 100, v: 1e8 }]]), chartInstances: [],
    formationMissesByCoin: new Map(), AbortController,
    isUsdtFutures: () => true, isStablecoinBase: () => false,
    schedulePreferencesSync() {}, requestAnimationFrame() {},
    setTimeout: fn => { timers.push(fn); return timers.length; }, setInterval: () => 0, clearTimeout() {},
    fetch: async url => { requests.push(url); if (response instanceof Error) throw response; return { ok: true, json: async () => url.includes('/snapshot') ? {
      tf: new URL(url, 'http://localhost').searchParams.get('tf'), updatedAt: Date.now(),
      maps: { cascades: response, levels: response, trendline: response, retest: response, approaching: {}, ...(ranges ? { range: ranges } : {}) }
    } : response }; },
    touchKlinesCache: key => klines.get(key), storeKlinesCache: (key, data) => klines.set(key, { data, ts: Date.now() }),
    fetchChartKlines: async () => Array.from({length: 40}, (_,i)=>({ t: 1+i*900000, o: 100, h: 101, l: 99, c: 100, v: 1 })),
    sanitizeCandles: data => data,
    ChartInstance: class { constructor(grid) { this.el = w.document.createElement("div"); grid.append(this.el); } update(c) { Object.assign(this, c); } draw() {} dispose() {} }
  });
  const overlayOptions = /window.getFormationsOverlayOpts = function[^]*?\n  };/.exec(source)[0];
  const geometry = ['getCachedFormationDetection', 'projectFormationOverlayLevels', 'qualifyFormationLevels']
    .map(name=>new RegExp('function '+name+'\\([^]*?\\n\\}').exec(source)[0]).join('\n');
  w.eval('const formationDetectionCache = new WeakMap();\n'+geometry+'\n'+section + '\n' + overlayOptions + "\nwindow.testRefresh = preloadFormationsInBackground;");
  return { w, timers, requests, klines, respond: data => { response = data; }, respondRange: data => { ranges = data; } };
}

test('Range workspace uses both live boundaries and per-side minimum touches', async t => {
  const h = build(t, { formations_active_tab: 'range', formations_min_cascade: '2' });
  h.respondRange({ 'BN:BTCUSDT': [{ lower: 99, upper: 102, lowerTouches: 3, upperTouches: 3, price: 99 }] });
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  assert.equal(h.w.chartInstances.length, 1);
  assert.equal(h.w.$('formations-select-text').textContent, 'Range / Боковик');
  h.w.$('formations-settings-menu').querySelector('[data-value="4"]').click(); await flush();
  assert.equal(h.w.chartInstances.length, 0, 'minimum touches applies to each side');
  h.w.$('formations-settings-menu').querySelector('[data-value="2"]').click(); await flush();
  assert.equal(h.w.chartInstances.length, 1);
  h.w.coins.get('BN:BTCUSDT').p = 103;
  h.w.loadFormations(); await flush();
  assert.equal(h.w.chartInstances.length, 0, 'cached range cannot survive a live breakout');
});

test('a range invalidated by the loaded candles cannot leave a blank formation card', async t => {
  const h = build(t, { formations_active_tab: 'range', formations_min_cascade: '3' });
  const engine = require('../public/js/formationEngine');
  const full = Array.from({length: 400}, (_, i) => {
    const c = 100 + 10 * Math.cos(i * Math.PI / 50), o = 100 + 10 * Math.cos((i - 1) * Math.PI / 50);
    return {t: 1700000000000 + i * 900000, o, h: Math.max(o,c)+.1, l: Math.min(o,c)-.1, c, v: 100};
  });
  const levels = engine.detectRanges(full, 3), short = full.slice(-300).map(c => ({...c}));
  assert.equal(levels.length, 1);
  short.at(-1).h = 120;
  h.respondRange({'BN:BTCUSDT': levels}); h.w.coins.get('BN:BTCUSDT').p = 109.98;
  await h.w.testRefresh(); await flush();
  h.klines.set('BN|BTCUSDT|15m', {data: short, ts: Date.now()});
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  assert.equal(h.w.chartInstances.length, 0, 'unconfirmed geometry must be removed, not displayed with a warning');
});

test("background prepares chart candles before the formations tab is opened", async t => {
  const h = build(t);
  await h.w.testRefresh();
  await flush();
  assert.ok(h.klines.has("BN|BTCUSDT|15m"), "opening the tab must not start its first candle download");
  assert.equal(h.w.chartInstances.length, 0, "background must not construct hidden charts");
});

test('cold or failed candle downloads never create unconfirmed chart placeholders', async t => {
  const h = build(t);
  let release;
  h.w.fetchChartKlines = () => new Promise(resolve => { release = resolve; });
  h.w.activeView = 'formations';
  await h.w.testRefresh(); await flush();
  assert.equal(h.w.chartInstances.length, 0);
  assert.ok(release);
  release([]); await flush();
  assert.equal(h.w.chartInstances.length, 0);
  assert.equal(h.klines.size, 0);
});

test('invalid geometry is removed and restored only after valid candle recovery', async t => {
  const h = build(t, {formations_active_tab: 'breakout'});
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations();
  assert.equal(h.w.chartInstances.length, 1);
  const cached = h.klines.get('BN|BTCUSDT|15m'), original = cached.data.at(-1).h;
  cached.data.at(-1).h = 110; h.w.loadFormations();
  assert.equal(h.w.chartInstances.length, 0);
  cached.data.at(-1).h = original; h.w.loadFormations();
  assert.equal(h.w.chartInstances.length, 1);
});

test('notification navigation cannot inject a coin without the selected formation', async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  h.w.coins.set('BB:ETHUSDT', {ex: 'BB', sym: 'ETHUSDT', p: 100, v: 1e9});
  h.w._formationPriorityCoin = {ex: 'BB', sym: 'ETHUSDT'};
  h.w.activeView = 'formations'; h.w.loadFormations();
  assert.deepEqual(Array.from(h.w.chartInstances, c=>c.sym), ['BTCUSDT']);
});

test('malformed snapshot rows preserve the last valid workspace instead of crashing it', async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  h.respond({'BN:BTCUSDT': [null]});
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations();
  assert.equal(h.w.chartInstances.length, 1);
  assert.match(h.w.$('formations-page-info').textContent, /Нет связи/);
});

test('invalid first candidates cannot prevent later confirmed markets from filling the page', async t => {
  const h = build(t);
  const maps = {};
  for (let i=0;i<30;i++) {
    const sym = 'TEST'+i+'USDT';
    h.w.coins.set('BN:'+sym, {ex:'BN',sym,p:100,v:1e9-i});
    maps['BN:'+sym] = [{price:102,direction:'up',touches:3},{price:103,direction:'up',touches:3}];
  }
  h.respond(maps);
  h.w.fetchChartKlines = async (ex,sym) => Array.from({length:40},(_,i)=>({t:1+i*900000,o:100,h:Number(sym.match(/\d+/)[0])<18?110:101,l:99,c:100}));
  await h.w.testRefresh(); await flush();
  h.w.activeView='formations'; h.w.loadFormations(); await flush();
  assert.ok(h.w.chartInstances.length);
  assert.ok(h.w.chartInstances.every(c=>Number(c.sym.match(/\d+/)[0])>=18));
});

test('large invalid candidate sets have bounded requests and resume at later markets', async t => {
  const h=build(t), maps={}, fetched=[];
  let now=Date.now(); h.w.Date.now=()=>now;
  for(let i=0;i<200;i++) {
    const sym='TEST'+i+'USDT';
    h.w.coins.set('BN:'+sym,{ex:'BN',sym,p:100,v:1e9-i});
    maps['BN:'+sym]=[{price:102,direction:'up',touches:3},{price:103,direction:'up',touches:3}];
  }
  h.respond(maps);
  h.w.fetchChartKlines=async(ex,sym)=>{fetched.push(sym);return Array.from({length:40},(_,i)=>({t:1+i*900000,o:100,c:100,h:110,l:99}));};
  const budget=Math.max(24,h.w.getFormationsPreferences().formationsCols*4);
  await h.w.testRefresh(); await flush();
  assert.equal(fetched.length,budget,'warmup must yield after its bounded cycle');
  h.w.loadFormations(); await flush(); assert.equal(fetched.length,budget);
  now+=16000; h.w.loadFormations(); await flush();
  assert.equal(fetched.length,budget*2);
  assert.equal(fetched[budget],'TEST'+budget+'USDT','later candidates must not starve behind the first rejected markets');
});

test('retest eligibility uses the same minimum touches as its chart overlay', async t => {
  const h = build(t, { formations_active_tab: 'retest', formations_min_cascade: '4' });
  h.respond({'BN:BTCUSDT': [{price: 99.5, direction: 'up', touches: 3}]});
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  assert.equal(h.w.chartInstances.length, 0, 'three-touch retests must not create blank four-touch chart cards');
  h.w.$('formations-settings-menu').querySelector('[data-value="3"]').click(); await flush();
  assert.equal(h.w.chartInstances.length, 1);
});

test('overlay options select the exact market and timeframe snapshot', async t => {
  const h = build(t, { formations_active_tab: 'breakout' });
  await h.w.testRefresh(); await flush();
  const same = h.w.getFormationsOverlayOpts('BN', 'BTCUSDT', '15m');
  assert.equal(same.levels.length, 2);
  assert.equal(h.w.getFormationsOverlayOpts('BB', 'BTCUSDT', '15m').levels.length, 0);
  assert.equal(h.w.getFormationsOverlayOpts('BN', 'ETHUSDT', '15m').levels.length, 0);
  assert.equal(h.w.getFormationsOverlayOpts('BN', 'BTCUSDT', '1h').levels.length, 0);
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

test('rendering ready results does not download formation maps again', async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  const before = h.requests.length;
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  assert.equal(h.w.chartInstances.length, 1);
  assert.equal(h.requests.length, before);
});

test('network failure preserves the last snapshot and reports offline state', async t => {
  const h = build(t);
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  h.respond(new Error('offline'));
  await h.w.testRefresh(); await flush();
  assert.equal(h.w.chartInstances.length, 1);
  assert.match(h.w.$('formations-page-info').textContent, /Нет связи/);
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
  h.respond({'BN:BTCUSDT': [{price: 99.5, direction: 'up', touches: 3}]});
  await h.w.testRefresh(); await flush();
  h.w.activeView = 'formations'; h.w.loadFormations(); await flush();
  assert.equal(h.w.chartInstances.length, 0);
  const toggle = h.w.$('formations-approaching-toggle');
  toggle.checked = false; toggle.dispatchEvent(new h.w.Event('change'));
  await flush();
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
