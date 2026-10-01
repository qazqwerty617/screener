const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createCanvas } = require('@napi-rs/canvas');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const begin = source.indexOf('  const bodyRatio = candleW > 4');
// Encoding-independent end marker for the production candle block.
const blockEnd = source.indexOf('  ctx.save();', begin);
assert.ok(begin > 0 && blockEnd > begin);

function paint(dpr, candleW = 1, grid = false, options = {}) {
  const canvas = createCanvas(24, 24), ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = options.candle || { o: 12, c: 16, h: 20, l: 8 };
  const gridStart = source.indexOf('    const defaultCs =');
  const gridEnd = source.indexOf('    const lastCandle =', gridStart);
  vm.runInNewContext(grid ? source.slice(gridStart, gridEnd) : source.slice(begin, blockEnd),
    { ctx, dpr, candleW, candleWidth: candleW, hw: Math.max(0.5 / dpr, candleW * 0.88 / 2), PW: 24,
      s: 0, viewStart: options.viewStart ?? -7, vis: [c], window: { candleSettings: options.settings }, hexToRgba: hex => hex, toY: price => 24 - price });
  return ctx.getImageData(0, 0, 24, 24).data;
}

test('one-pixel zoomed-out candle and its wick occupy ONE device-pixel column', () => {
  const pixels = paint(1), columns = new Set();
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (pixels[(y * 24 + x) * 4 + 3]) columns.add(x);
  assert.equal(columns.size, 1, `one-pixel candle leaked across ${columns.size} columns`);
});

test('fractional zoom does not make candle width flicker while panning', () => {
  for (const viewStart of [-7, -7.1, -7.2, -7.3, -7.4]) {
    const pixels = paint(1, 1.5, false, { viewStart }), columns = new Set();
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) if (pixels[(y * 24 + x) * 4 + 3]) columns.add(x);
    assert.equal(columns.size, 1, `width changed to ${columns.size} at offset ${viewStart}`);
  }
});

test('grid zoomed-out candles use the same sharp pixel geometry as the main chart', () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    assert.deepEqual(paint(dpr, 1, true), paint(dpr, 1), `different geometry at DPR ${dpr}`);
  }
});

test('main and grid candles agree on fractional price/body-height geometry', () => {
  for (const dpr of [1, 1.25, 1.5, 2]) for (const candleW of [1.5, 3, 8]) {
    const options = { viewStart: -1.2, candle: { o: 12.3, c: 16.6, h: 20.1, l: 8.7 } };
    assert.deepEqual(paint(dpr, candleW, true, options), paint(dpr, candleW, false, options), `different geometry at DPR ${dpr}, width ${candleW}`);
  }
});

test('border-only candle style remains visible at a one-pixel zoom', () => {
  const settings = { body: { show: false, up: '#00ff00', down: '#ff0000' },
    wick: { show: false, up: '#00ff00', down: '#ff0000' },
    border: { show: true, up: '#00ff00', down: '#ff0000' } };
  for (const grid of [false, true]) {
    const pixels = paint(1, 1, grid, { settings });
    assert.ok(pixels.some((a, i) => i % 4 === 3 && a > 0));
  }
});

for (const dpr of [1, 1.25, 1.5, 2]) test(`zoomed-out candle has no half-transparent blur at DPR ${dpr}`, () => {
  const pixels = paint(dpr);
  const alpha = [];
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) alpha.push(pixels[i]);
  assert.ok(alpha.length);
  assert.ok(alpha.every(a => a === 255), `partially covered pixels: ${alpha.filter(a => a < 255).length}`);
});

test('fractional Windows display scaling does not recreate a grid canvas on every frame', () => {
  const begin = source.indexOf('    const rect = this.canvas.parentElement', source.indexOf('    this.refreshFormationLevels();', source.indexOf('    this.lastDrawTs = now;')));
  const end = source.indexOf('    const ctx = this.ctx;', begin);
  assert.ok(begin > 0 && end > begin, 'production canvas sizing block must be found');
  let reallocations = 0, width = 0, height = 0;
  const canvas = { clientWidth: 317, clientHeight: 243,
    get width() { return width; }, set width(value) { width = Math.trunc(value); reallocations++; },
    get height() { return height; }, set height(value) { height = Math.trunc(value); reallocations++; } };
  const ctx = { setTransform() {} };
  const run = new Function('dpr', `return function() { ${source.slice(begin, end)} };`)(1.25);
  for (let i = 0; i < 60; i++) run.call({ canvas, ctx });
  assert.equal(reallocations, 2, `canvas reallocated ${reallocations} times in 60 frames`);
});

test('CSS serialization at fractional scaling does not rewrite canvas styles on every frame', () => {
  const begin = source.indexOf('    const rect = this.canvas.parentElement', source.indexOf('    this.refreshFormationLevels();', source.indexOf('    this.lastDrawTs = now;')));
  const end = source.indexOf('    const ctx = this.ctx;', begin);
  assert.ok(begin > 0 && end > begin);
  let writes = 0;
  const style = new Proxy({}, {set(o, key, value) { writes++; o[key] = Number(parseFloat(value).toFixed(3)) + 'px'; return true; }});
  const canvas = { clientWidth: 317, clientHeight: 243, width: 0, height: 0, style,
    parentElement: {getBoundingClientRect: () => ({width: 317.4, height: 243.4, left: 10.3, top: 11.3})} };
  const cell = { canvas, ctx: {setTransform() {}} };
  const run = new Function('dpr', `return function() { ${source.slice(begin, end)} };`)(1.5);
  for (let i = 0; i < 60; i++) run.call(cell);
  assert.equal(writes, 4, 'only the first paint should set width, height, left and top');
});
