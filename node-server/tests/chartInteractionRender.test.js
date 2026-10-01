const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
const begin = source.indexOf('function rafLoop() {');
const end = source.indexOf('\nfunction isUsdtFutures', begin);
assert.ok(begin > 0 && end > begin);

function runFrames({ hidden = false, dirty = true, grid = false, expanded = false, hz = 60 } = {}) {
  let now = 0, painted = 0, tables = 0, cells = 0;
  const ctx = { performance: { now: () => now }, requestAnimationFrame() {},
    document: { hidden }, window: { isFormationFullChartOpen: () => expanded }, lastRafTs: 0, chartNeedsDraw: dirty,
    drawChart: () => painted++, processTickData: () => tables++,
    activeView: grid ? 'formations' : 'screener', screenerView: 'chart',
    chartInstances: [{ dirty, draw() { cells++; this.dirty = false; } }] };
  vm.runInNewContext(source.slice(begin, end), ctx);
  for (let i = 1; i <= hz; i++) {
    now = i * 1000 / hz;
    ctx.chartNeedsDraw = dirty;
    ctx.chartInstances[0].dirty = dirty;
    ctx.rafLoop();
  }
  return { painted, tables, cells };
}

test('pointer/zoom invalidations paint every display frame instead of stuttering at 20–30 FPS', () => {
  const { painted } = runFrames();
  assert.ok(painted >= 58, `only ${painted} of 60 requested frames painted`);
});

test('hidden tab never paints charts or ticker rows', () => {
  assert.deepEqual(runFrames({ hidden: true }), { painted: 0, tables: 0, cells: 0 });
});

test('clean charts do not repaint continuously', () => {
  assert.equal(runFrames({ dirty: false }).painted, 0);
});

for (const hz of [60, 120, 144]) test(`ticker table retains its independent 30 Hz budget on a ${hz} Hz display`, () => {
  const { painted, tables } = runFrames({ hz });
  assert.equal(painted, hz);
  assert.ok(tables <= 31 && tables >= 28, `${tables} table passes in one second`);
});

test('formation grid input frames are not dropped by the ticker-table throttle', () => {
  assert.equal(runFrames({ grid: true }).cells, 60);
});

test('expanding a formation paints its main canvas without painting the covered grid cells', () => {
  const { painted, cells } = runFrames({ grid: true, expanded: true, hz: 120 });
  assert.equal(painted, 120); assert.equal(cells, 0);
});
