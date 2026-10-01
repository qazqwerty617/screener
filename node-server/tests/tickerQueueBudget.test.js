const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const block = name => new RegExp(`function ${name}\\([^]*?\\n\\}`).exec(source)[0];

function build(overrides = {}) {
  let rowUpdates = 0, sorts = 0;
  const ctx = { dirty: new Set(), chartTickerDirty: new Set(), tickerListChanged: false,
    rowEls: new Map([['BN:VISIBLE', {}]]), coins: new Map(), chartInstances: [], interpActive: new Map(),
    activeView: 'screener', screenerView: 'chart', activeEx:'BN',activeSym:'VISIBLE', candles:[],
    needRebuild: false,lastSort:1000,lastRender:1000, document:{hidden:false}, performance:{now:()=>1100},
    hasMainMarketStream:()=>true,updateRow(){rowUpdates++;},rebuildList(){sorts++;}, ...overrides };
  vm.createContext(ctx);vm.runInContext(block('markTickerDirty')+'\n'+block('processTickData'),ctx);
  return {ctx, rows:()=>rowUpdates, sorts:()=>sorts};
}

test('a 50000-market burst queues DOM work only for retained visible rows', () => {
  const h = build();
  for(let i=0;i<50000;i++) h.ctx.markTickerDirty('BN:OFFSCREEN'+i);
  h.ctx.markTickerDirty('BN:VISIBLE');
  assert.equal(h.ctx.dirty.size,1); assert.equal(h.ctx.chartTickerDirty.size,0);
  h.ctx.processTickData(1/30); assert.equal(h.rows(),1);
  h.ctx.performance.now=()=>2100; h.ctx.processTickData(1/30); assert.equal(h.sorts(),1);
});

test('an off-screen market change still triggers ranking even when the row queue is empty', () => {
  const h=build();h.ctx.markTickerDirty('BN:OFFSCREEN'); h.ctx.performance.now=()=>2100;
  h.ctx.processTickData(1/30);assert.equal(h.sorts(),1);assert.equal(h.ctx.tickerListChanged,false);
});

test('hidden views keep a ranking invalidation without building a row backlog', () => {
  const h=build({activeView:'events'});h.ctx.markTickerDirty('BN:OFFSCREEN');h.ctx.processTickData(1/30);
  assert.equal(h.ctx.needRebuild,true);assert.equal(h.ctx.dirty.size,0);assert.equal(h.rows(),0);assert.equal(h.sorts(),0);
});

test('only displayed chart markets receive grid ticker invalidations', () => {
  const h=build({activeView:'formations',chartInstances:[{key:'BN:VISIBLE',update(){}}]});
  h.ctx.markTickerDirty('BN:OFFSCREEN');h.ctx.markTickerDirty('BN:VISIBLE');
  assert.deepEqual([...h.ctx.chartTickerDirty],['BN:VISIBLE']);
});
