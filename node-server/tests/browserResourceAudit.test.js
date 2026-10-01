"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { JSDOM } = require("jsdom");
const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const block = name => new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`).exec(source)[0];
function alerts(drawings = []) {
  const dom = new JSDOM('<div id="toast-container"></div>');
  const c = { window: dom.window, document: dom.window.document, console, setTimeout: () => 1,
    $: id => dom.window.document.getElementById(id), normExCode: s => s, normSymCode: s => s,
    activeEx: "BN", activeSym: "ETHUSDT", activeTf: "5m", chartDrawings: drawings,
    priceAlerts: drawings.length ? [] : [{ ex: "BN", sym: "ETHUSDT", price: 100, dir: "gte" }],
    captureChartSnapshot: async () => null, savePriceAlerts() {}, saveDrawings() {}, playAlertSound() {},
    sendTelegramAlert() {}, requestAnimationFrame() {}, getFullExchangeName: () => "BINANCE", fP: String,
    localStorage: { getItem: () => null }, loadCoinChart(ex, sym) { c.opened = [ex, sym]; }, switchView() {} };
  const toast = source.slice(source.indexOf("function showToast("), source.indexOf("window.showToast = showToast;"));
  vm.createContext(c); vm.runInContext(toast + "\n" + block("checkPriceAlerts"), c);
  return c;
}
test("price alert displays text, not literal HTML, and opens the matching chart", async () => {
  const c = alerts(); await c.checkPriceAlerts("BN", "ETHUSDT", 101);
  const toast = c.document.querySelector(".toast-card");
  assert.ok(toast); assert.doesNotMatch(toast.textContent, /<\/?(?:b|div|span)\b/);
  toast.click(); assert.deepEqual(c.opened, ["BN", "ETHUSDT"]);
});
test("drawing alert fires without an undefined saved-alert reference", async () => {
  const c = alerts([{ type: "alert", p1: 100, createdP: 99, t1: 1 }]);
  await c.checkPriceAlerts("BN", "ETHUSDT", 101);
  assert.equal(c.document.querySelectorAll(".toast-card").length, 1);
});

test("a slow Telegram snapshot never delays the browser price alert", async () => {
  const c = alerts(); c.window.currentUser = { telegramChatId: 'fixture' };
  let release; c.captureChartSnapshot = () => new Promise(resolve => { release = resolve; });
  const pending = c.checkPriceAlerts('BN', 'ETHUSDT', 101);
  try { assert.equal(c.document.querySelectorAll('.toast-card').length, 1); }
  finally { await pending; release?.(null); await new Promise(resolve => setImmediate(resolve)); }
});

test("a malformed price cannot trigger an alert", async () => {
  const c = alerts();
  await c.checkPriceAlerts('BN', 'ETHUSDT', Infinity);
  assert.equal(c.document.querySelectorAll('.toast-card').length, 0);
});

test("an ETH alert does not fire for WETH or for another exchange", async () => {
  const c = alerts();
  await c.checkPriceAlerts('BN', 'WETHUSDT', 101);
  await c.checkPriceAlerts('BB', 'ETHUSDT', 101);
  assert.equal(c.document.querySelectorAll('.toast-card').length, 0);
  await c.checkPriceAlerts('BN', 'ETHUSDT', 101);
  assert.equal(c.document.querySelectorAll('.toast-card').length, 1);
});
test("a hidden screener does not update ticker table DOM during a 50000-market burst", () => {
  const c = { dirty: new Set(Array.from({ length: 50000 }, (_, i) => String(i))), needRebuild: false,
    interpActive: new Map(), coins: new Map(), chartTickerDirty: new Set(), chartInstances: [], tickerListChanged: false,
    activeView: "events", screenerView: "list", activeEx: "BN", activeSym: "BTCUSDT", candles: [],
    lastSort: 1000, lastRender: 1000, performance: { now: () => 1100 }, hasMainMarketStream: () => true,
    document: { hidden: false }, window: {}, calls: 0, updateRow() { c.calls++; }, rebuildList() { c.calls++; } };
  vm.createContext(c); vm.runInContext(block("processTickData"), c); c.processTickData(1 / 60);
  assert.equal(c.calls, 0, "hidden table must not consume the render budget");
});
test("density image retention stays within 32 MiB across updates, 4K resize and DPR changes", () => {
  let allocations = 0;
  const c = { densityLayoutVersion: 0, densityBubbleLayer: null, densityBubbleLayerVersion: '', densityW: 1600, densityH: 900,
    densityVisibleData: [{rx:10,ry:20}], window: { devicePixelRatio: 2 }, drawDensityBubble() {},
    document: { createElement: () => { allocations++; return { width: 0, height: 0, getContext: () => ({ setTransform() {}, clearRect() {} }) }; } } };
  vm.createContext(c); vm.runInContext(block('getDensityBubblesLayer'), c);
  for (let i = 0; i < 1000; i++) {
    c.densityLayoutVersion++; c.densityVisibleData[0].pct = i / 100;
    c.window.devicePixelRatio = i < 500 ? 2 : 1;
    c.densityW = i < 250 ? 1600 : 3840; c.densityH = i < 250 ? 900 : 2160;
    const layer = c.getDensityBubblesLayer();
    assert.ok(layer.width * layer.height * 4 <= 32 * 1024 * 1024);
  }
  assert.equal(allocations, 1, 'reuse one canvas instead of retaining historical images');
  c.densityVisibleData = []; assert.equal(c.getDensityBubblesLayer(), null);
});

test("a burst of chart invalidations coalesces to one paint and hidden tabs keep their pending draw", () => {
  const c = { chartNeedsDraw: false, lastRafTs: 0, performance: { now: () => 100 }, document: { hidden: false },
    requestAnimationFrame() {}, drawChart() { c.paints++; }, paints: 0, processTickData() {}, activeView: 'screener', screenerView: 'chart' };
  vm.createContext(c); vm.runInContext(block('requestDraw') + '\n' + block('rafLoop'), c);
  for (let i = 0; i < 10000; i++) c.requestDraw();
  c.rafLoop(); assert.equal(c.paints, 1);
  c.document.hidden = true; c.requestDraw(); c.rafLoop();
  assert.equal(c.paints, 1); assert.equal(c.chartNeedsDraw, true);
  c.document.hidden = false; c.performance.now = () => 200; c.rafLoop();
  assert.equal(c.paints, 2);
});

test("1000 unchanged density bubbles are rendered once across repeated radar frames", () => {
  const canvasContext = { scale() {}, setTransform() {}, clearRect() {}, drawImage() {} };
  const c = { densityLayoutVersion: 1, densityBubbleLayer: null, densityBubbleLayerVersion: '', densityW: 1600, densityH: 900,
    densityCtx: canvasContext, window: { devicePixelRatio: 2 }, getDensityStableKey: d => d.id,
    getDensitySizeType: () => 'large', getDensityScore: () => 10, findDensityAt: () => -1,
    densityMouseX: -1, densityMouseY: -1, densityHover: -1, densitySelectedKey: null, renders: 0,
    densityVisibleData: Array.from({length:1000},(_,i)=>({id:String(i),rx:i,ry:100,wallK:10,pct:1})),
    drawDensityBubble() { c.renders++; },
    document: { createElement: () => ({width:0,height:0,getContext:()=>canvasContext}) } };
  vm.createContext(c);
  const helper = block('getDensityBubblesLayer') + '\n' + block('findSelectedDensityIndex');
  const begin = source.indexOf('  // тФАтФА Draw badges');
  const end = source.indexOf('  // Active item for tooltip', begin);
  vm.runInContext(helper + '\nfunction frame(){const ctx=densityCtx;const bubbleLayer=getDensityBubblesLayer(),backdropCached=false;\n' + source.slice(begin,end) + '\n}', c);
  for (let i = 0; i < 30; i++) c.frame();
  assert.equal(c.renders, 1000, 'unchanged walls must not recreate sprites or gradients each frame');
  c.densityLayoutVersion++; c.densityVisibleData[0].wallK = 20; c.frame();
  assert.equal(c.renders, 2000, 'new source values must invalidate the layer');
});

test("only visible grid markets interpolate while real prices remain intact", () => {
  const c = { coins: new Map(), interpActive: new Map(), chartInstances: [{key:'BN:BTCUSDT'}],
    activeView:'screener', screenerView:'list', document:{hidden:false}, chartAnimationsEnabled:true,
    performance:{now:()=>100}, markTickerDirty() {} };
  vm.createContext(c); vm.runInContext(block('scheduleInterp'), c);
  const coin = {p:100,displayP:99}; c.coins.set('BN:BTCUSDT', coin);
  c.scheduleInterp('BN:BTCUSDT'); assert.equal(c.interpActive.size, 0); assert.equal(coin.displayP,100);
  c.screenerView='multichart'; c.scheduleInterp('BN:BTCUSDT'); assert.equal(c.interpActive.size,1);
  c.document.hidden=true; coin.p=101; c.scheduleInterp('BN:BTCUSDT');
  assert.equal(c.interpActive.size,0); assert.equal(coin.p,101); assert.equal(coin.displayP,101);
});

test("a burst of forced grid redraws only invalidates the cell until the next render frame", () => {
  const c={document:{hidden:false},activeView:'formations',screenerView:'multichart',window:{},coins:new Map(),
    TF_MS:{'1m':60000}};
  vm.createContext(c);vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(source)[0]+';this.Chart=ChartInstance;',c);
  const cell={candles:[{t:Date.now(),o:100,h:101,l:99,c:100,v:1}],tf:'1m',dirty:false,
    refreshFormationLevels(){throw new Error('expensive chart calculation ran outside the render frame');}};
  for(let i=0;i<500;i++) c.Chart.prototype.draw.call(cell,true);
  assert.equal(cell.dirty,true);
});

test('disabled pump alerts never allocate histories during a 50000-market burst',()=>{
  const c={pdSettings:{enabled:false,marketType:'both',periodMinutes:1},pdPriceRing:new Map(),pdIsSeeded:false,
    pdIsExchangeAllowed:ex=>ex==='BN',pdCheckLiveTick(){}};
  vm.createContext(c);
  const start=source.indexOf('  function pdTrackPrice('),end=source.indexOf('  function pdCheckLiveTick(',start);
  vm.runInContext(source.slice(start,end),c);
  for(let i=0;i<50000;i++)c.pdTrackPrice(`BN:TOKEN${i}USDT`,100);
  assert.equal(c.pdPriceRing.size,0);
});

test('pump histories only retain selected markets and the configured observation period',()=>{
  let time=1700000000000;
  const c={Date:{now:()=>time},pdSettings:{enabled:true,marketType:'futures',periodMinutes:1},pdPriceRing:new Map(),pdIsSeeded:false,
    pdIsExchangeAllowed:ex=>ex==='BN',pdCheckLiveTick(){}};
  vm.createContext(c);
  const start=source.indexOf('  function pdTrackPrice('),end=source.indexOf('  function pdCheckLiveTick(',start);
  vm.runInContext(source.slice(start,end),c);
  for(let i=0;i<1000;i++){c.pdTrackPrice('BN:BTCUSDT',100);c.pdTrackPrice('BB:BTCUSDT',100);c.pdTrackPrice('BN:BTCUSDT_SPOT',100);time+=2000;}
  assert.equal(c.pdPriceRing.size,1);assert.ok(c.pdPriceRing.get('BN:BTCUSDT').length<=33);
});

test('a hidden browser does not fetch and parse formation snapshots',async()=>{
  let calls=0;
  const c={document:{hidden:true},refreshFormationSnapshot:async()=>{calls++},formationsTf:'15m',
    formationTimeframes:['15m','1h'],formationBackgroundIndex:0};
  vm.createContext(c);vm.runInContext(/async function preloadFormationsInBackground\([^]*?\n  \}/.exec(source)[0],c);
  await c.preloadFormationsInBackground();assert.equal(calls,0);
});

test('unchanged formation candles reuse their detection despite elapsed wall time',()=>{
  let time=0,calls=0;const c={formationDetectionCache:new WeakMap(),performance:{now:()=>time}};
  vm.createContext(c);vm.runInContext(block('getCachedFormationDetection'),c);
  const bars=[{t:1700000000000,o:100,h:101,l:99,c:100,v:1000}];
  for(let i=0;i<1000;i++){time+=1000;c.getCachedFormationDetection(bars,'trendline:3',()=>{calls++;return []})}
  assert.equal(calls,1);
});
test('a closed-candle correction invalidates formation detection with an unchanged live candle',()=>{
  let calls=0;const c={formationDetectionCache:new WeakMap(),performance:{now:()=>0}};
  vm.createContext(c);vm.runInContext(block('getCachedFormationDetection')+'\n'+block('clearCandleCaches'),c);
  const bars=[{t:1700000000000,h:101,l:99,c:100},{t:1700000060000,h:101,l:99,c:100}];
  const detect=()=>{calls++;return [bars[0].h]};
  c.getCachedFormationDetection(bars,'trendline:3',detect);
  bars[0].h=102;c.clearCandleCaches(bars);
  assert.equal(c.getCachedFormationDetection(bars,'trendline:3',detect)[0],102);assert.equal(calls,2);
});
test('live grid streams do not run formation detection in a hidden browser',()=>{
  let calls=0;const c={document:{hidden:true},activeView:'formations',performance:{now:()=>2000},
    window:{detectChartLevelsFn(){calls++;return []}}};
  vm.createContext(c);vm.runInContext(/class ChartInstance \{[^]*?\n\}/.exec(source)[0]+';this.Chart=ChartInstance;',c);
  c.Chart.prototype.refreshFormationLevels.call({candles:Array(40).fill({}),_lastFormationDetectAt:0});
  assert.equal(calls,0);
});
