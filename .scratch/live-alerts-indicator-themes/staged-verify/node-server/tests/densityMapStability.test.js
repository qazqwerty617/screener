"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");

function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return source.slice(from, to);
}

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

test("density hit testing chooses the nearest overlapping wall", () => {
  const helpers = sourceBetween("function getDensityRelativeRank", "try {\n  const savedChartDensity");
  const layout = sourceBetween("function layoutDensityBadges()", "function drawDensityMap()");
  const context = { Math };
  vm.runInNewContext(`
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
