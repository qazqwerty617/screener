"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8").replace(/\r\n/g, "\n");
function slice(a, b) { return source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a))); }
test("crowded density layouts bound collision work without dropping walls", () => {
  let distances = 0;
  const math = Object.create(Math); math.hypot = (...args) => { distances++; return Math.hypot(...args); };
  const context = { Math: math };
  vm.runInNewContext(`
    let densityW = 1000, densityH = 700, densitySort = "score", densityVisibleData = [], densityLayoutVersion = 0;
    function getFilteredDensity() { return Array.from({length: 1000}, (_, i) => ({wallId: "wall-"+i, pct: 1+(i%40)/10, score: i, S: 100, sizeType: "small"})); }
    function getDensityLiveAgeSec() { return 60; }
    function $(id) { return null; }
    ${slice("function getDensityRelativeRank", "try {\n  const savedChartDensity")}
    ${slice("function layoutDensityBadges()", "function drawDensityMap()")}
    layoutDensityBadges(); result = densityVisibleData;
  `, context);
  assert.equal(context.result.length, 1000);
  assert.ok(context.result.every(row => Number.isFinite(row.rx) && Number.isFinite(row.ry)));
  assert.ok(distances < 1000000, `${distances} collision calculations`);
});
