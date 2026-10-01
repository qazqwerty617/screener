'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const engine = require('../public/js/formationEngine');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const renderer = /function renderFormationsOnChart\([^]*?\n\}/.exec(source)[0];
function waves(count = 400) {
  return Array.from({length: count}, (_, i) => {
    const c = 100 + 10 * Math.cos(i * Math.PI * 2 / 100), o = 100 + 10 * Math.cos((i-1) * Math.PI * 2 / 100);
    return {t: 1700000000000 + i * 60000, o, h: Math.max(o,c)+.1, l: Math.min(o,c)-.1, c, v: 100};
  });
}
function render(candles, levels, type = 'ranges', minTouches = 3) {
  const ctx = new Proxy({measureText: () => ({width: 100})}, {get: (o,k) => k in o ? o[k] : () => {}});
  const c = {window: {FormationEngine: engine}, chartFovRangeMin: 3, chartFovNearest: false, chartFovShowTouches: true,
    chartFovCascadesMin: 2, getCachedFormationDetection: (a,k,f) => f(),
    hexToRgba: x => x};
  vm.createContext(c); vm.runInContext(renderer, c);
  vm.runInContext(/function projectFormationOverlayLevels\([^]*?\n\}/.exec(source)[0], c);
  vm.runInContext(/function qualifyFormationLevels\([^]*?\n\}/.exec(source)[0], c);
  return c.renderFormationsOnChart(ctx, candles, 0, 2, 0, p => (115-p)*10, 600, 300, 0, 0,
    {types: new Set([type]), minTouches, showTouches: true, levels});
}
function project(candles, levels, type = 'ranges') {
  const c = {}; vm.createContext(c); vm.runInContext(/function projectFormationOverlayLevels\([^]*?\n\}/.exec(source)[0], c);
  return c.projectFormationOverlayLevels(candles, levels, type);
}

function qualify(levels, type, price, touches=2, distance=15) {
  const c={}; vm.createContext(c);
  vm.runInContext(/function qualifyFormationLevels\([^]*?\n\}/.exec(source)[0],c);
  return c.qualifyFormationLevels(levels,type,price,touches,distance);
}
for (const type of ['levels','trendlines','retests']) test(`${type} eligibility rejects the broken live side and shares touch/distance settings`,()=>{
  const support = type==='retests'?'up':'down', resistance = type==='retests'?'down':'up';
  const row={price:100,endPrice:100,direction:support,touches:3};
  assert.equal(qualify([row],type,100.1,3).length,1);
  assert.equal(qualify([row],type,99.9,3).length,0);
  assert.equal(qualify([row],type,100.1,4).length,0);
  assert.equal(qualify([row],type,100.1,3,.01).length,0);
  assert.equal(qualify([{...row,direction:resistance}],type,99.9,3).length,1);
  assert.equal(qualify([{...row,direction:resistance}],type,100.1,3).length,0);
});
test('cascade minimum counts only clean nearby levels on the same side',()=>{
  const rows=[{price:101,direction:'up'},{price:102,direction:'up'},{price:99,direction:'down'}];
  assert.equal(qualify(rows,'cascades',100,2,5).length,2);
  assert.equal(qualify(rows,'cascades',101.5,2,5).length,0,'a pierced first step invalidates the two-step cascade');
  assert.equal(qualify(rows,'cascades',100,2,.5).length,0,'distant steps cannot satisfy the cascade minimum');
});
test('projection rejects null candle rows without crashing the formations list',()=>{
  const full=waves(),levels=engine.detectRanges(full,3); full[250]=null;
  assert.equal(project(full,levels).length,0);
});

for (const detector of ['detectHorizontals', 'detectCascades']) test(`${detector} preserves tiny token prices instead of rounding the formation to zero`, () => {
  const cs = waves().map(c => ({ ...c, o: c.o * 1e-9, h: c.h * 1e-9, l: c.l * 1e-9, c: c.c * 1e-9 }));
  const levels = engine[detector](cs, 2);
  assert.ok(levels.length);
  assert.equal(levels[0].price, Math.max(...cs.map(c => c.h)));
  assert.ok(levels.every(l => l.price > 0 && l.endPrice > 0));
});

for (const [type, detector] of [['levels', 'detectHorizontals'], ['cascades', 'detectCascades']]) test(`confirmed ${type} use the selected snapshot after earlier anchors leave the loaded page`, () => {
  const full = waves(), levels = engine[detector](full, 2), short = full.slice(-100);
  assert.ok(levels.length);
  assert.ok(render(short, levels, type, type === 'cascades' ? 1 : 2).length, 'short client history must still draw the original level');
  assert.equal(render(short, [], type, 2).length, 0);
});

test('a confirmed trendline draws with both anchors outside the loaded page', () => {
  const full = waves(), short = full.slice(-100), line = {
    p1: { idx: 10, t: full[10].t, price: 111 }, p2: { idx: 50, t: full[50].t, price: 111.1 },
    direction: 'up', isHigh: true, touches: 3, touchTimes: [full[10].t,full[50].t,full[100].t]
  };
  assert.equal(render(short, [line], 'trendlines').length, 1);
});
test('a server-confirmed range is drawn when the short chart history cannot rediscover its earlier visits', () => {
  const full = waves(), short = full.slice(-300), levels = engine.detectRanges(full, 3);
  assert.equal(levels.length, 1); assert.equal(engine.detectRanges(short, 3).length, 0);
  assert.equal(render(short, levels).length, 2, 'the selected server range must supply both chart boundaries');
});
test('an authoritative empty result must not draw a locally rediscovered range', () => {
  assert.equal(render(waves(), []).length, 0, 'server removal must not leave a different local overlay');
});
test('snapshot touch indices are rebased by timestamp, including after older history is prepended', () => {
  const full = waves(), box = engine.detectRanges(full, 3)[0], before = JSON.stringify(box);
  for (const offset of [100, 40, 0]) {
    const candles = full.slice(offset), [mapped] = project(candles, [box]);
    assert.ok(mapped);
    assert.deepEqual([...mapped.upperTouchIndices], box.upperTouchIndices.map(i => i - offset).filter(i => i >= 0));
    assert.deepEqual([...mapped.lowerTouchIndices], box.lowerTouchIndices.map(i => i - offset).filter(i => i >= 0));
  }
  assert.equal(JSON.stringify(box), before, 'shared server geometry must remain unchanged');
});
for (const side of ['upper', 'lower', 'wick']) test(`a cached server range is invalidated by a live ${side} break`, () => {
  const full = waves(), box = engine.detectRanges(full, 3)[0], short = full.slice(-300).map(c => ({...c}));
  const last = short.at(-1);
  if (side === 'wick') last.h = box.upper * 1.1;
  else { last.c = side === 'upper' ? box.upper * 1.01 : box.lower * .99; last.h = Math.max(last.o, last.c); last.l = Math.min(last.o, last.c); }
  assert.equal(render(short, [box]).length, 0);
});
for (const fault of ['gap', 'duplicate', 'badOHLC']) test(`incomplete chart history cannot certify a server range: ${fault}`, () => {
  const full = waves(), box = engine.detectRanges(full, 3)[0], short = full.slice(-300).map(c => ({...c}));
  if (fault === 'gap') short.splice(50, 2);
  else if (fault === 'duplicate') short[50].t = short[49].t;
  else short[50].h = short[50].l - 1;
  assert.equal(render(short, [box]).length, 0);
});
test('a newer snapshot invalidates cached overlay geometry even when candles have not changed', () => {
  const full = waves(), context = {}; vm.createContext(context);
  vm.runInContext('const formationDetectionCache = new WeakMap();\n' + /function getCachedFormationDetection\([^]*?\n\}/.exec(source)[0], context);
  const first = [1], second = []; let calls = 0;
  const lookup = levels => context.getCachedFormationDetection(full, 'snapshot:ranges', () => { calls++; return levels; }, levels);
  assert.equal(lookup(first), first); assert.equal(lookup(first), first); assert.equal(calls, 1);
  assert.equal(lookup(second), second); assert.equal(calls, 2);
});
test('trendline anchors older than loaded history retain their price slope through time', () => {
  const full = waves(), short = full.slice(100), a = {idx: 10, t: full[10].t, price: 111}, b = {idx: 50, t: full[50].t, price: 111.4};
  const line = {p1: a, p2: b, isHigh: true, direction: 'up', touchTimes: [a.t,b.t], touches: 3};
  const [mapped] = project(short, [line], 'trendlines');
  assert.ok(mapped); assert.equal(mapped.p1.idx, 0); assert.equal(mapped.p2.idx, short.length - 1);
  assert.ok(Math.abs(mapped.p1.price - 111.9) < 1e-9);
  assert.ok(Math.abs(mapped.endPrice - 114.89) < 1e-9);
});
test('fractional grid canvas dimensions use the actual CSS box at Windows scaling', () => {
  const draw = /  draw\(force = false\) \{[^]*?\n  \}/.exec(source)[0];
  const canvas = {clientWidth: 300, clientHeight: 200, width: 0, height: 0,
    getBoundingClientRect: () => ({width: 300.4, height: 200.4})};
  const c = {document: {hidden: false}, window: {devicePixelRatio: 1.25}, activeView: 'formations', screenerView: 'multichart',
    getCanvasBgColorFor: () => '#000'};
  vm.createContext(c); vm.runInContext('function paint(force = false) '+draw.slice(draw.indexOf('{')), c);
  const cell = {canvas, candles: [], loadingKlines: true, ctx: new Proxy({},{get: () => () => {}})};
  c.paint.call(cell);
  assert.equal(canvas.width, Math.round(300.4 * 1.25));
  assert.equal(canvas.height, Math.round(200.4 * 1.25));
});

test('the main chart bitmap and CSS size agree at fractional display scaling', () => {
  const rect = { width: 300.4, height: 200.4, left: 10.3, top: 11.3, bottom: 211.7 };
  const canvas = { width: 0, height: 0, style: {} }, volCv = { width: 0, height: 0, style: {} };
  const c = { $: () => ({ clientWidth: 300, clientHeight: 200, getBoundingClientRect: () => rect }),
    canvas, volCv, ctx: { setTransform() {} }, vCtx: { setTransform() {} },
    window: { devicePixelRatio: 1.25 }, candles: [], chartW: 0, chartH: 0, volH: 87 };
  vm.createContext(c); vm.runInContext(/function resizeChart\([^]*?\n\}/.exec(source)[0], c);
  c.resizeChart();
  assert.equal(canvas.width, Math.round(rect.width * 1.25));
  assert.equal(parseFloat(canvas.style.width) * 1.25, canvas.width);
  assert.equal(parseFloat(canvas.style.height) * 1.25, canvas.height);
  assert.equal(parseFloat(volCv.style.height) * 1.25, volCv.height);
});

for (const approaching of [false, true]) test(`snapshot ${approaching ? 'approaching ' : ''}retests invalidate a failed hold while allowing valid rejection wicks`, () => {
  const cs = Array.from({ length: 40 }, (_, i) => ({ t: 1700000000000 + i * 60000, o: 100.1, c: 100.1, h: 100.5, l: 99.9, v: 100 }));
  const rt = { price: 100, direction: 'up', touches: 3, holdTolerance: .2, swingTime: cs[1].t,
    touchTime: approaching ? undefined : cs[20].t, departTime: cs[10].t, isApproachingRetest: approaching };
  assert.equal(project(cs, [rt], 'retests').length, 1);
  cs.at(-1).c = 99.7; cs.at(-1).l = 99.6;
  assert.equal(project(cs, [rt], 'retests').length, 0, 'a failed hold must invalidate the old snapshot');
});
