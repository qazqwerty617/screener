const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const block = name => new RegExp(`function ${name}\\([^]*?\\n\\}`).exec(source)[0];

test('unchanged radar hover does not scan 5000 walls on every animation frame', () => {
  let reads = 0;
  const ctx = { densityLayoutVersion: 1, densityVisibleData: Array.from({length:5000},(_,i)=>({rx:i,ry:100})),
    getDensityBubbleRadius: () => { reads++; return 10; } };
  vm.createContext(ctx); vm.runInContext(block('findDensityAt'), ctx);
  for (let i = 0; i < 120; i++) assert.equal(ctx.findDensityAt(100,100), 100);
  assert.equal(reads, 5000);
  ctx.densityVisibleData[100].rx = 200; ctx.densityLayoutVersion++;
  assert.equal(ctx.findDensityAt(100,100), 99); assert.equal(reads, 10000);
  assert.equal(ctx.findDensityAt(150,100), 150); assert.equal(reads, 15000);
});

function radarFrames(moving, hidden = false, empty = false) {
  let callback, paints = 0;
  const ctx = { densityAnimFrame: null, densityMouseX: 10, densityMouseY: 10,
    activeView: 'map', densityVisibleData: empty ? [] : [{}], document: { hidden }, drawDensityMap: () => paints++,
    requestAnimationFrame(fn) { callback = fn; return 1; } };
  vm.createContext(ctx); vm.runInContext(block('startDensityLoop'), ctx); ctx.startDensityLoop();
  for (let i = 1; i <= 120; i++) { if (moving) ctx.densityMouseX++; callback(i*1000/120); }
  return paints;
}

test('radar tooltip interaction follows 120 Hz input frames', () => { assert.equal(radarFrames(true),120); });
test('idle radar animation retains its existing paint budget', () => { assert.ok(radarFrames(false)<=31); });
test('hidden radar consumes no painting work', () => { assert.equal(radarFrames(true,true),0); });
test('an empty radar does not spend extra frames reacting to a cursor with no walls to hover', () => { assert.ok(radarFrames(true,false,true)<=31); });

test('a selected radar wall does not trigger two full identity scans on every frame', () => {
  let reads = 0, highlights = 0;
  const ctx = { densityLayoutVersion: 1, densityVisibleData: Array.from({length:5000},(_,i)=>({wallId:String(i),rx:i,ry:100})),
    densitySelectedKey: '4999', densityMouseX: -1, densityMouseY: -1, densityHover: -1,
    findDensityAt: () => -1, getDensityBubblesLayer: () => null, bubbleLayer: null, backdropCached: false, ctx: {}, densityW:1000,densityH:700,
    drawDensityBubble() { highlights++; }, getDensityStableKey(d) { reads++; return d.wallId; } };
  const start = source.indexOf('  const filtered = densityVisibleData;', source.indexOf('function drawDensityMap'));
  const end = source.indexOf('  if (activeItemIndex >= 0', start);
  vm.createContext(ctx);
  if (source.includes('function findSelectedDensityIndex(')) vm.runInContext(block('findSelectedDensityIndex'),ctx);
  const frame = new vm.Script(source.slice(start,end));
  for(let i=0;i<120;i++) frame.runInContext(vm.createContext({...ctx, findSelectedDensityIndex: ctx.findSelectedDensityIndex}));
  assert.equal(reads, 5000); assert.equal(highlights,120);
});

test('selected-wall lookup invalidates after sorting, filtering and selection changes', () => {
  const ctx={densityLayoutVersion:1,densitySelectedKey:'a',densityVisibleData:[{id:'a'},{id:'b'},{id:'c'}],getDensityStableKey:d=>d.id};
  vm.createContext(ctx);vm.runInContext(block('findSelectedDensityIndex'),ctx);
  assert.equal(ctx.findSelectedDensityIndex(),0);
  ctx.densityVisibleData.reverse();ctx.densityLayoutVersion++;assert.equal(ctx.findSelectedDensityIndex(),2);
  ctx.densityVisibleData.pop();ctx.densityLayoutVersion++;assert.equal(ctx.findSelectedDensityIndex(),-1);
  ctx.densitySelectedKey='b';assert.equal(ctx.findSelectedDensityIndex(),1);
  ctx.densitySelectedKey=null;assert.equal(ctx.findSelectedDensityIndex(),-1);
});
