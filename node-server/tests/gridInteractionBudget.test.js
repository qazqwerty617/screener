const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf('  draw(force = false) {');
const end = source.indexOf('    const last = this.candles', start);
assert.ok(start > 0 && end > start);

function simulate(interactive, hz = 120) {
  let now = 0, paints = 0;
  const context = { Date: { now: () => now }, document: { hidden: false }, window: {},
    activeView: 'formations', screenerView: 'multichart' };
  const prefix = source.slice(start, end).replace('  draw(force = false) {', 'function draw(force = false) {');
  const draw = vm.runInNewContext('(' + prefix + '\nthisPaint();\n})', { ...context, thisPaint: () => paints++ });
  const cell = { candles: [{}], lastDrawTs: 0, dirty: true, _interactionDirty: false };
  for (let i = 1; i <= hz; i++) {
    now = i * 1000 / hz;
    cell.dirty = true;
    if (interactive) cell._interactionDirty = true;
    draw.call(cell);
  }
  return paints;
}

test('formation-grid drag/zoom renders every requested frame on a 120 Hz display', () => {
  assert.equal(simulate(true), 120);
});

test('stream-driven grid paints retain their existing CPU budget', () => {
  assert.ok(simulate(false) <= 60);
});

test('loading grid cells paint once and reuse fractional-DPR backing dimensions', () => {
  let allocations = 0, width = 0, height = 0, paints = 0;
  const canvas = { clientWidth: 317, clientHeight: 243,
    get width() { return width; }, set width(v) { width = Math.trunc(v); allocations++; },
    get height() { return height; }, set height(v) { height = Math.trunc(v); allocations++; } };
  const context = { Date, document: { hidden: false }, window: { devicePixelRatio: 1.25 },
    activeView: 'formations', screenerView: 'multichart', getCanvasBgColorFor: () => '#000',
    thisPaint() { paints++; } };
  const prefix = source.slice(start, end).replace('  draw(force = false) {', 'function draw(force = false) {');
  const draw = vm.runInNewContext('(' + prefix + '\nthisPaint();\n})', context);
  const cell = { candles: [], loadingKlines: true, canvas, dirty: true,
    ctx: { setTransform() {}, fillRect() { paints++; }, fillText() {} } };
  for (let i = 0; i < 120; i++) if (cell.dirty) draw.call(cell);
  assert.equal(paints, 1); assert.equal(allocations, 2);
  cell.dirty = true; draw.call(cell); assert.equal(allocations, 2);
});
