"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8").replace(/\r\n/g, "\n");

function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return source.slice(from, to);
}

test("fresh density controls reflect the actual default filters", t => {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8'));
  t.after(() => dom.window.close());
  const c = { document: dom.window.document, $: id => dom.window.document.getElementById(id),
    localStorage: {getItem:()=>null}, densityFilter:'all', densityMarket:'all', densitySize:'all', densitySort:'score',
    densitySearch:'', densityMinUsd:0, densityMaxDistance:5, densityMinAge:0, densityMinRank:0, densityMinConfluence:1 };
  vm.runInNewContext(sourceBetween('function loadDensityFilters()', 'function resetDensityFilters()') + '\nloadDensityFilters();', c);
  assert.equal(c.$('density-max-distance').value, '5');
  assert.equal(c.$('density-min-age').value, '0');
});

test("the full-band filter migration survives a subsequent reload", () => {
  const values = new Map([['density_filters_v2', JSON.stringify({densityMaxDistance:3})]]);
  const c = {localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},
    densityFilter:'all',densityMarket:'all',densitySize:'all',densitySort:'score',densitySearch:'',
    densityMinUsd:0,densityMaxDistance:5,densityMinAge:0,densityMinRank:0,densityMinConfluence:1,densityExFilter:new Set(['BN']),syncDensityFilterUI() {}};
  vm.createContext(c); vm.runInContext(sourceBetween('function saveDensityFilters()', 'function syncDensityFilterUI()'), c);
  c.loadDensityFilters(); assert.equal(c.densityMaxDistance,5);
  c.loadDensityFilters(); assert.equal(c.densityMaxDistance,5);
  assert.equal(JSON.parse(values.get('density_filters_v2')).densityMaxDistance,5);
});

test("density size filters use the server's dollar tier instead of relative rank", () => {
  const helpers = sourceBetween("function getDensityRelativeRank", "try {\n  const savedChartDensity");
  const context = {};
  vm.runInNewContext(`${helpers}\nresult = [
    getDensitySizeType({ sizeType: "small", tier: "small", rank: 10 }),
    getDensitySizeType({ sizeType: "medium", tier: "medium", rank: 2 }),
    getDensitySizeType({ sizeType: "large", tier: "large", rank: 3 }),
  ];`, context);
  assert.deepEqual(Array.from(context.result), ["small", "medium", "large"]);
});

test("small, medium and large density bubbles have distinct geometry", () => {
  const helpers = sourceBetween("function getDensityRelativeRank", "try {\n  const savedChartDensity");
  const context = {};
  vm.runInNewContext(`${helpers}\nresult = [
    getDensityBubbleRadius({ sizeType: "small" }),
    getDensityBubbleRadius({ sizeType: "medium" }),
    getDensityBubbleRadius({ sizeType: "large" }),
  ];`, context);
  assert.deepEqual(Array.from(context.result), [21, 27, 34]);
});

test("density coordinates stay attached to a wall when live scores reorder", () => {
  const helpers = sourceBetween("function getDensityRelativeRank", "try {\n  const savedChartDensity");
  const layout = sourceBetween("function layoutDensityBadges()", "function drawDensityMap()");
  const context = {
    Math,
  };
  vm.createContext(context);
  vm.runInContext(`
    let densityW = 1000;
    let densityH = 700;
    let densitySort = "score";
    let densityVisibleData = [];
    let densityLayoutVersion = 0;
    let current = [];
    function getFilteredDensity() { return current.map(item => ({ ...item })); }
    function getDensityLiveAgeSec() { return 60; }
    function $(id) { return null; }
    ${helpers}
    ${layout}
    current = [{ levelKey: "A", pct: 1, score: 10, S: 100 }, { levelKey: "B", pct: 1, score: 9, S: 90 }];
    layoutDensityBadges();
    const before = Object.fromEntries(densityVisibleData.map(w => [w.levelKey, [w.rx, w.ry]]));
    current = [{ levelKey: "A", pct: 1, score: 8, S: 100 }, { levelKey: "B", pct: 1, score: 11, S: 90 }];
    layoutDensityBadges();
    const after = Object.fromEntries(densityVisibleData.map(w => [w.levelKey, [w.rx, w.ry]]));
    result = { before, after };
  `, context);

  assert.deepEqual(Array.from(context.result.after.A), Array.from(context.result.before.A));
  assert.deepEqual(Array.from(context.result.after.B), Array.from(context.result.before.B));
});

test("badges separate when two walls initially receive the same radar coordinate", () => {
  const helpers = sourceBetween("function getDensityRelativeRank", "try {\n  const savedChartDensity");
  const layout = sourceBetween("function layoutDensityBadges()", "function drawDensityMap()");
  const context = { Math };
  vm.runInNewContext(`
    let densityW = 1000;
    let densityH = 700;
    let densitySort = "score";
    let densityVisibleData = [];
    let densityLayoutVersion = 0;
    function getFilteredDensity() { return [
      { wallId: "a", pct: 1, score: 10, S: 100, sizeType: "small" },
      { wallId: "b", pct: 1, score: 9, S: 100, sizeType: "small" },
    ]; }
    function getDensityLiveAgeSec() { return 60; }
    function $(id) { return null; }
    ${helpers}
    ${layout}
    getDensityStableAngle = () => 0;
    layoutDensityBadges();
    const [a, b] = densityVisibleData;
    result = Math.hypot(a.rx - b.rx, a.ry - b.ry);
  `, context);
  assert.ok(context.result >= 44.9, `expected near-separated badges, got ${context.result}px`);
});

test("density hit testing chooses the nearest overlapping wall", () => {
  const helpers = sourceBetween("function getDensityRelativeRank", "try {\n  const savedChartDensity");
  const layout = sourceBetween("function layoutDensityBadges()", "function drawDensityMap()");
  const context = { Math };
  vm.runInNewContext(`
    let densityLayoutVersion = 0;
    let densityVisibleData = [
      { wallId: "far", rx: 120, ry: 100, sizeType: "large" },
      { wallId: "near", rx: 104, ry: 100, sizeType: "small" },
    ];
    ${helpers}
    ${layout}
    result = findDensityAt(100, 100);
  `, context);

  assert.equal(context.result, 1);
});
