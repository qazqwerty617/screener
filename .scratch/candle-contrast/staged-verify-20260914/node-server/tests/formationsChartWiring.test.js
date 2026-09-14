"use strict";
// Static verification of the Formations-tab chart wiring. No DOM needed: this
// checks that the code paths exist, are wired to each other, and that the old
// duplicate renderer is gone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(__dirname, "..", "public", "css", "app.css"), "utf8");

test("formations mini charts render through the screener overlay renderer", () => {
  // The private duplicate renderer that drew this.levels with its own colors is
  // gone; both views now call renderFormationsOnChart.
  assert.ok(
    !APP.includes('if (activeView === "formations" && this.levels && this.levels.length > 0)'),
    "the duplicate formations overlay in ChartInstance.draw must be removed"
  );
  assert.match(APP, /const fmOpts = window\.getFormationsOverlayOpts\?\.\(\);/);
  assert.match(APP, /cellFormationBadges = renderFormationsOnChart\(/);
});

test("renderFormationsOnChart accepts per-view options", () => {
  assert.match(
    APP,
    /function renderFormationsOnChart\(ctx, candles, s, candleW, futureGap, toY, PW, PH, TOP, viewStart, opts\)/
  );
  // Every formation type must consult hasType() rather than the global sets, so
  // the tab can request exactly one type.
  for (const name of ["cascades", "levels", "trendlines", "retests"]) {
    assert.ok(APP.includes(`hasType('${name}')`), `type ${name} must go through hasType()`);
  }
  // Touch dots and nearest/min-touches must be overridable too.
  assert.ok(APP.includes("if (fovShowTouches)"), "touch dots must use the resolved option");
  assert.ok(APP.includes("if (fovNearest &&"), "nearest must use the resolved option");
});

test("the tab's toolbar maps onto overlay options", () => {
  const idx = APP.indexOf("window.getFormationsOverlayOpts = function");
  assert.ok(idx > 0, "getFormationsOverlayOpts must be defined");
  const body = APP.slice(idx, idx + 900);
  assert.match(body, /breakout:\s*"levels"/);
  assert.match(body, /trendline:\s*"trendlines"/);
  assert.match(body, /retest:\s*"retests"/);
  assert.match(body, /minTouches: formationsMinCascade/);
  assert.match(body, /formations-nearest-toggle/);
  assert.match(body, /formations-approaching-toggle/);
});

test("approaching retests are reachable from the overlay renderer", () => {
  assert.match(APP, /wantApproaching\s*$|const wantApproaching = !!\(cfg && cfg\.approaching\);/m);
  assert.match(APP, /detectApproachingRetests\(candles\)/);
});

test("expanding a formation moves the real chart, not a copy", () => {
  assert.match(HTML, /<div id="formations-fullchart"><\/div>/);
  assert.match(APP, /window\.openFormationFullChart = function \(ex, sym, tf\)/);
  assert.match(APP, /host\.appendChild\(chartArea\)/, "the real #chart-area must be relocated");
  assert.match(APP, /toggleScreenerView\("single"\)/, "expanded view must be the single chart");
  assert.match(APP, /window\.openFormationFullChart\?\.\(this\.ex, this\.sym, this\.tf\)/);
});

test("the expanded chart is always returned to #main", () => {
  assert.match(APP, /window\.closeFormationFullChart = function \(\)/);
  assert.match(APP, /main\.insertBefore\(chartArea, main\.firstChild\)/);
  // Back arrow, Esc and leaving the tab must all close it.
  assert.match(APP, /if \(window\.closeFormationFullChart\?\.\(\)\) return;/);
  assert.match(APP, /if \(e\.key !== "Escape"\) return;/);
  assert.match(APP, /if \(view !== "formations" && window\.isFormationFullChartOpen\?\.\(\)\)/);
});

test("grid rebuild is suppressed while the chart is expanded", () => {
  const idx = APP.indexOf("function renderCurrentPage()");
  assert.ok(idx > 0);
  const body = APP.slice(idx, idx + 500);
  assert.match(body, /if \(fullChartOpen\)/, "renderCurrentPage must bail out when expanded");
});

test("CSS hides the grid and shows the borrowed chart", () => {
  assert.match(CSS, /#formations-view\.fullchart-active #formations-fullchart\s*\{\s*display: flex;/);
  assert.match(CSS, /#formations-view\.fullchart-active #formations-grid,\s*#formations-view\.fullchart-active #formations-pagination \{\s*display: none !important;/);
  assert.match(CSS, /#formations-fullchart #view-toggle,\s*#formations-fullchart #grid-config \{\s*display: none !important;/);
});

test("the dead expanded-cell CSS and state are gone", () => {
  // Expanding no longer stretches a mini cell, so the old rules would silently
  // fight the new layout.
  assert.ok(!CSS.includes("#formations-grid.has-expanded"), "has-expanded rules must be removed");
  assert.ok(!APP.includes("has-expanded"), "no code should reference has-expanded anymore");
  assert.ok(
    !APP.includes('this.el.classList.contains("expanded")'),
    "ChartInstance must not treat a cell as the focused chart"
  );
});

test("the formations grid matches the screener grid metrics", () => {
  const screener = /#chart-grid-container \{[^}]*\}/.exec(CSS);
  const formations = /#formations-grid \{[^}]*\}/.exec(CSS);
  assert.ok(screener && formations, "both grid rules must exist");
  for (const prop of ["gap: 4px", "padding: 4px"]) {
    assert.ok(
      formations[0].includes(prop),
      `#formations-grid must use the screener's "${prop}"`
    );
  }
  assert.match(
    CSS,
    /\[data-appearance-theme\] #formations-grid\s*\{[^}]*background:\s*var\(--formations-bg, var\(--bg\)\)/,
    "#formations-grid must use the active formations workspace theme"
  );
});

test("restoring the screener view does not rebuild its grid", () => {
  // Rebuilding would create screener cells into chartInstances moments before
  // loadFormations() replaces them, orphaning live WS subscriptions.
  assert.match(APP, /function toggleScreenerView\(view, rebuildGrid = true\)/);
  assert.match(APP, /if \(rebuildGrid\) initChartGrid\(\);/);
  assert.match(APP, /toggleScreenerView\(fullChartPrevScreenerView, false\);/);
});

test("every DOM id the new code touches exists in index.html", () => {
  for (const id of [
    "formations-view",
    "formations-fullchart",
    "formations-grid",
    "formations-pagination",
    "chart-area",
    "main",
    "chart-canvas",
    "vol-canvas",
    "draw-tools",
    "chart-back-btn",
    "formations-nearest-toggle",
    "formations-approaching-toggle"
  ]) {
    assert.ok(HTML.includes(`id="${id}"`), `index.html must define id="${id}"`);
  }
});

test("#chart-area is a direct child of #main so it can be put back", () => {
  const mainOpen = HTML.indexOf('<div id="main">');
  assert.ok(mainOpen > 0, "#main must exist");
  const chartArea = HTML.indexOf('id="chart-area"', mainOpen);
  assert.ok(chartArea > mainOpen, "#chart-area must live inside #main");
  // Nothing but whitespace/comments between #main and #chart-area, so
  // insertBefore(chartArea, main.firstChild) restores the original order.
  const between = HTML.slice(mainOpen + '<div id="main">'.length, chartArea);
  const stripped = between.replace(/<!--[\s\S]*?-->/g, "").replace(/<main[^>]*$/, "").trim();
  assert.equal(stripped, "", `unexpected markup before #chart-area: ${stripped.slice(0, 80)}`);
});

test("the drawing toolbar travels with the chart", () => {
  // #draw-tools must be nested inside #chart-area, otherwise moving the chart
  // into the Formations tab would leave the tools behind on the screener.
  const areaStart = HTML.indexOf('id="chart-area"');
  const cwrap = HTML.indexOf('id="cwrap"', areaStart);
  const drawTools = HTML.indexOf('id="draw-tools"', cwrap);
  assert.ok(areaStart > 0 && cwrap > areaStart, "#cwrap must be inside #chart-area");
  assert.ok(drawTools > cwrap, "#draw-tools must be inside #cwrap");
});
