"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app.js"), "utf8");
const densityStart = appSource.indexOf("const CHART_EXCHANGE_NAMES");
const densityEnd = appSource.indexOf("// Formations Overlay", densityStart);

function createCanvasRecorder() {
  return {
    arcs: [],
    fills: [],
    labels: [],
    strokes: [],
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    rect() {},
    clip() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    setLineDash() {},
    measureText(text) { return { width: String(text).length * 6 }; },
    stroke() { this.strokes.push({ width: this.lineWidth, color: this.strokeStyle }); },
    fill() { this.fills.push(this.fillStyle); },
    arc(x, y, radius) { this.arcs.push({ x, y, radius }); },
    fillText(text, x, y) { this.labels.push({ text, x, y, color: this.fillStyle }); },
  };
}

function loadDensityRenderer(walls) {
  const sandbox = {
    chartDensityEnabled: true,
    chartDensitySide: "all",
    chartDensityMarket: "all",
    chartDensityExes: new Set(["BB"]),
    chartDensitySizes: new Set(["small", "medium", "large"]),
    densityData: walls,
    densityHistoryData: [],
    isBaseInDensityBlacklist: () => false,
    getDensitySizeType: wall => wall.sizeType,
    getDensityScore: wall => wall.score,
    getIdxFromTime: (timestamp, candles) => {
      const index = candles.findIndex(candle => candle.t >= timestamp);
      return index < 0 ? candles.length - 1 : index;
    },
    roundRect() {},
    fP: value => Number(value).toFixed(2),
  };
  vm.runInNewContext(
    `${appSource.slice(densityStart, densityEnd)}\nthis.drawDensityTimeline = drawDensityTimelineOnChart; this.drawScaleBadge = drawDensityScaleBadge;`,
    sandbox,
  );
  return sandbox;
}

test("chart density is rendered as one anchored order level with useful inline details", () => {
  const walls = [{
    base: "BTC",
    ex: "BB",
    sym: "BTCUSDT",
    market: "futures",
    side: "bid",
    price: 99.82,
    S: 10_300_000,
    firstSeenAt: 1_000,
    sizeType: "large",
    score: 100,
  }];
  const renderer = loadDensityRenderer(walls);
  const ctx = createCanvasRecorder();

  const badges = renderer.drawDensityTimeline(ctx, {
    candles: [{ t: 1_000, c: 100 }, { t: 2_000, c: 100 }],
    base: "BTC",
    candleWidth: 10,
    viewStart: 0,
    toY: price => 100 + (100 - price) * 10,
    PW: 800,
    PH: 300,
    TOP: 0,
  });

  assert.deepEqual(ctx.labels.map(label => label.text), ["$10.3M  ·  ↓0.18%  ·  Bybit"]);
  assert.deepEqual(ctx.arcs.map(arc => arc.radius), [5.7, 3.2]);
  assert.ok(ctx.strokes.some(stroke => stroke.width === 7), "large wall should have a stronger glow");
  assert.ok(ctx.strokes.some(stroke => stroke.width === 1.8), "large wall should have a stronger core line");
  assert.equal(badges.length, 1);
});

test("nearby walls keep their lines but do not stack duplicate labels and price badges", () => {
  const common = {
    base: "BTC", ex: "BB", sym: "BTCUSDT", market: "futures", side: "ask",
    S: 600_000, firstSeenAt: 1_000, sizeType: "medium",
  };
  const renderer = loadDensityRenderer([
    { ...common, price: 100.2, score: 80 },
    { ...common, price: 100.25, score: 70 },
  ]);
  const ctx = createCanvasRecorder();

  const badges = renderer.drawDensityTimeline(ctx, {
    candles: [{ t: 1_000, c: 100 }, { t: 2_000, c: 100 }],
    base: "BTC",
    candleWidth: 10,
    viewStart: 0,
    toY: price => 100 + (100 - price) * 10,
    PW: 800,
    PH: 300,
    TOP: 0,
  });

  assert.equal(ctx.labels.filter(label => label.text.includes("$600K")).length, 1);
  assert.equal(ctx.labels.some(label => /BID|ASK/.test(label.text)), false);
  assert.equal(ctx.strokes.filter(stroke => stroke.width === 1.35).length, 2);
  assert.equal(badges.length, 1);
});

test("density price badge uses the side color and a connector notch", () => {
  const renderer = loadDensityRenderer([]);
  const ctx = createCanvasRecorder();
  renderer.drawScaleBadge(ctx, { y: 50, price: 99.82, baseColorArr: [38, 201, 122] }, 800, 78, 18);

  assert.equal(ctx.labels[0].text, "99.82");
  assert.ok(ctx.fills.length > 0);
  assert.ok(ctx.strokes.some(stroke => stroke.color && stroke.color.includes("38") && stroke.color.includes("201")));
});
