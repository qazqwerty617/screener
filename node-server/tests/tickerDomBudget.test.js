const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const block = name => new RegExp(`function ${name}\\([^]*?\\n\\}`).exec(source)[0];

function setup(t) {
  const dom = new JSDOM('<div id="coin-list"></div><span id="cnt"></span>');
  t.after(() => dom.window.close());
  let formats = 0, timers = 0;
  const ctx = { document: dom.window.document, window: { currentUser: { plan: 'pro' } },
    coins: new Map(), rowEls: new Map(), coinTags: {}, TAG_PALETTE: [], activeEx: 'BN', activeSym: 'BTCUSDT',
    listEx: 'BN', searchQ: '', activeColorFilters: new Set(), sortCol: 'chg', sortDir: 1, sortedList: [],
    isHoveringScreener: false, needRebuild: false, fC: v => { formats++; return String(v); },
    fV: v => { formats++; return String(v); }, isUsdtFutures: () => true, updateSymInfo() {}, updateSymInfoInterp() {},
    $: id => dom.window.document.getElementById(id), setTimeout: () => { timers++; return timers; }, clearTimeout() {} };
  ctx.createRow = c => {
    const el = dom.window.document.createElement('div');
    el.innerHTML = '<i></i><b></b><b></b><b></b><b></b><b></b>';
    const children = [...el.children];
    return { el, cells: { dot: children[0], chg: children[1], vol: children[2], trades: children[3], funding: children[4], corr: children[5] } };
  };
  vm.createContext(ctx);
  vm.runInContext(block('fillRow') + '\n' + block('rebuildList') + '\n' + block('updateRow'), ctx);
  const coin = i => ({ key: `BN:C${i}USDT`, sym: `C${i}USDT`, base: `C${i}`, ex: 'BN', p: 100, prev: 100, chg: i, v: 1e8, h: 101, l: 99, funding: .01, corr: 42 });
  return { ctx, dom, coin, formats: () => formats, timers: () => timers };
}

test('unchanged retained rows do not repeat numeric formatting on every list pass', t => {
  const h = setup(t);
  for (let i = 0; i < 300; i++) { const c = h.coin(i); h.ctx.coins.set(c.key, c); }
  h.ctx.rebuildList(); const first = h.formats();
  for (let i = 0; i < 10; i++) h.ctx.rebuildList();
  assert.equal(h.formats(), first);
});

test('a one-row rank change does not detach all 300 retained list elements', t => {
  const h = setup(t);
  for (let i = 0; i < 300; i++) { const c = h.coin(i); h.ctx.coins.set(c.key, c); }
  h.ctx.rebuildList();
  const cl = h.dom.window.document.getElementById('coin-list');
  const observer = new h.dom.window.MutationObserver(() => {}); observer.observe(cl, { childList: true });
  h.ctx.coins.get('BN:C0USDT').chg = 1000; h.ctx.rebuildList();
  const records = observer.takeRecords(); observer.disconnect();
  const removed = records.reduce((n, r) => n + r.removedNodes.length, 0);
  assert.ok(removed <= 1, `moving one row detached ${removed} elements`);
  assert.equal(cl.firstElementChild, h.ctx.rowEls.get('BN:C0USDT').el);
  assert.equal(cl.childElementCount, 300);
});

test('the same real price update does not restart its flash timer on interpolation passes', t => {
  const h = setup(t), c = h.coin(1); h.ctx.coins.set(c.key, c); h.ctx.rebuildList();
  c.p = 101;
  for (let i = 0; i < 100; i++) h.ctx.updateRow(c.key);
  assert.equal(h.timers(), 1);
  c.prev = c.p; c.p = 102; h.ctx.updateRow(c.key);
  assert.equal(h.timers(), 2);
});

test('row input changes, selection and tags remain visible after cache reuse', t => {
  const h = setup(t), c = h.coin(1); h.ctx.coins.set(c.key, c); h.ctx.rebuildList();
  const row = h.ctx.rowEls.get(c.key);
  c.chg = -2; c.v = 1234; c.corr = 10; c.funding = -.03; h.ctx.activeSym = c.sym;
  h.ctx.TAG_PALETTE.push('#ff0000'); h.ctx.coinTags[c.key] = 0;
  h.ctx.fillRow(c, row);
  assert.equal(row.cells.chg.textContent, '-2'); assert.equal(row.cells.vol.textContent, '1234');
  assert.equal(row.cells.corr.textContent, '10'); assert.equal(row.cells.funding.textContent, '-0.030%');
  assert.equal(row.el.classList.contains('sel'), true); assert.equal(row.cells.dot.classList.contains('tagged'), true);
});

test('list diff handles removals, empty filters and a new leading instrument', t => {
  const h = setup(t);
  for (let i = 0; i < 5; i++) { const c = h.coin(i); h.ctx.coins.set(c.key, c); }
  h.ctx.rebuildList();
  h.ctx.coins.delete('BN:C3USDT'); const next = h.coin(9); h.ctx.coins.set(next.key, next);
  h.ctx.rebuildList();
  const cl = h.dom.window.document.getElementById('coin-list');
  assert.deepEqual([...cl.children], Array.from(h.ctx.sortedList, c => h.ctx.rowEls.get(c.key).el));
  assert.equal(cl.childElementCount, 5);
  h.ctx.searchQ = 'nonexistent'; h.ctx.rebuildList(); assert.equal(cl.childElementCount, 0);
  h.ctx.searchQ = ''; h.ctx.rebuildList(); assert.equal(cl.childElementCount, 5);
});

test('unchanged symbol headers do not create a new text node on every ticker frame', t => {
  const h = setup(t);
  h.dom.window.document.body.insertAdjacentHTML('beforeend', '<span id="sn"></span><span id="sc"></span><span id="schg"></span><span id="sv"></span><span id="snatr"></span><span id="scorr"></span><span id="sfun"></span><span id="soi"></span>');
  h.ctx.getDisplayP = c => c.p; h.ctx.Date = { now: () => 1000 };
  vm.runInContext(block('updateSymInfoInterp'), h.ctx);
  const c = { ...h.coin(1), o: 100, nextFunding: 61000, oi: 100 };
  h.ctx.updateSymInfoInterp(c);
  const observer = new h.dom.window.MutationObserver(() => {}); observer.observe(h.dom.window.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  for (let i = 0; i < 100; i++) h.ctx.updateSymInfoInterp(c);
  assert.equal(observer.takeRecords().length, 0); observer.disconnect();
  h.ctx.Date.now = () => 2000; h.ctx.updateSymInfoInterp(c);
  assert.match(h.dom.window.document.getElementById('sfun').textContent, /0:00:59/);
});
