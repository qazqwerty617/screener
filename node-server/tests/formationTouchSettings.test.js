"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../public/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

test("each chart formation has its own minimum-touch context menu", () => {
  for (const type of ["cascades", "levels", "trendlines", "retests"]) {
    assert.match(app, new RegExp(`case "${type}":`));
  }
  assert.doesNotMatch(html, /data-fmt-touch-type=/);
  assert.match(app, /addEventListener\("contextmenu"/);
  assert.match(app, /openFormationTouchMenu/);
});

test("chart touch settings persist independently", () => {
  const start = app.indexOf("function saveFovSettings() {");
  const end = app.indexOf("// Formation detection", start);
  assert.ok(start >= 0 && end > start);
  const saved = new Map();
  const context = {
    localStorage: { setItem: (key, value) => saved.set(key, value) },
    chartFormationsOnChart: true,
    chartActiveFormations: new Set(["cascades", "trendlines"]),
    chartFovCascadesMin: 1,
    chartFovBreakoutMin: 2,
    chartFovTrendlineMin: 3,
    chartFovRetestMin: 4,
    chartFovRetestApproaching: false,
    chartFovNearest: false,
    chartFovShowLabels: true,
    chartFovShowTouches: true,
  };
  vm.runInNewContext(`${app.slice(start, end)}\nsaveFovSettings();`, context);
  const state = JSON.parse(saved.get("fov_settings"));
  assert.deepEqual([state.cascadesMin, state.breakoutMin, state.trendlineMin, state.retestMin], [1, 2, 3, 4]);
});

test("overlay applies trendline and retest thresholds instead of the cascade threshold", () => {
  assert.match(app, /detectTrendlines\(candles, trendlineMin\)/);
  assert.match(app, /\(Number\(rt\.touches\) \|\| 0\) >= retestMin/);
  assert.match(app, /detectCascades\(candles, cascadeMin\)/);
});
