"use strict";
// DOM round-trip test for the Formations tab's expanded chart.
//
// The risky part of the feature is that #chart-area is physically moved out of
// #main and into #formations-fullchart, then moved back. This exercises that
// against the real index.html so a future markup change that breaks the
// round-trip fails here instead of in the browser.
//
// jsdom is optional: it lives outside node-server's dependencies, so the test
// skips rather than failing the suite when it is not installed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

function loadJsdom() {
  const candidates = [
    "jsdom",
    "/tmp/domtest/node_modules/jsdom",
    path.join(process.env.HOME || "", "domtest/node_modules/jsdom")
  ];
  for (const id of candidates) {
    try { return require(id); } catch (_) {}
  }
  // Also honour an explicit override so CI can point at any install.
  if (process.env.JSDOM_PATH) {
    try { return require(process.env.JSDOM_PATH); } catch (_) {}
  }
  return null;
}

const jsdomModule = loadJsdom();
const skip = jsdomModule ? false : "jsdom is not installed";

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function build() {
  const { JSDOM } = jsdomModule;
  const dom = new JSDOM(HTML, { runScripts: "outside-only" });
  return dom.window.document;
}

test("expanding moves #chart-area into the formations host", { skip }, () => {
  const doc = build();
  const main = doc.getElementById("main");
  const host = doc.getElementById("formations-fullchart");
  const chartArea = doc.getElementById("chart-area");
  const view = doc.getElementById("formations-view");

  assert.equal(chartArea.parentElement, main, "baseline: chart lives in #main");

  host.appendChild(chartArea);
  view.classList.add("fullchart-active");

  assert.equal(chartArea.parentElement, host);
  assert.ok(view.classList.contains("fullchart-active"));
  // The canvases and the drawing toolbar travel with it.
  assert.ok(chartArea.querySelector("#chart-canvas"));
  assert.ok(chartArea.querySelector("#vol-canvas"));
  assert.ok(chartArea.querySelector("#draw-tools"));
  assert.ok(chartArea.querySelector("#ctbar .tfb"), "timeframe buttons move too");
});

test("collapsing restores the original #main child order exactly", { skip }, () => {
  const doc = build();
  const main = doc.getElementById("main");
  const host = doc.getElementById("formations-fullchart");
  const chartArea = doc.getElementById("chart-area");
  const view = doc.getElementById("formations-view");

  const before = Array.from(main.children).map(el => el.id || el.className);

  host.appendChild(chartArea);
  view.classList.add("fullchart-active");
  // Round trip, exactly as closeFormationFullChart does it.
  main.insertBefore(chartArea, main.firstChild);
  view.classList.remove("fullchart-active");

  const after = Array.from(main.children).map(el => el.id || el.className);
  assert.deepEqual(after, before, "#main children must return to their original order");
  assert.equal(chartArea.parentElement, main);
  assert.equal(host.children.length, 0, "the host must be left empty");
});

test("repeated expand/collapse cycles stay stable", { skip }, () => {
  const doc = build();
  const main = doc.getElementById("main");
  const host = doc.getElementById("formations-fullchart");
  const chartArea = doc.getElementById("chart-area");

  const before = Array.from(main.children).map(el => el.id || el.className);
  for (let i = 0; i < 5; i++) {
    host.appendChild(chartArea);
    main.insertBefore(chartArea, main.firstChild);
  }
  const after = Array.from(main.children).map(el => el.id || el.className);
  assert.deepEqual(after, before);
  assert.equal(host.children.length, 0);
});

test("the formations host sits between the grid and the pagination bar", { skip }, () => {
  const doc = build();
  const view = doc.getElementById("formations-view");
  const ids = Array.from(view.children).map(el => el.id);
  const gridIdx = ids.indexOf("formations-grid");
  const hostIdx = ids.indexOf("formations-fullchart");
  const pagIdx = ids.indexOf("formations-pagination");
  assert.ok(gridIdx >= 0 && hostIdx >= 0 && pagIdx >= 0, `unexpected children: ${ids.join(",")}`);
  assert.ok(gridIdx < hostIdx && hostIdx < pagIdx, "host must be ordered grid → host → pagination");
});
