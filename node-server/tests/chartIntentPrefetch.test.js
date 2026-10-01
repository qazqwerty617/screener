const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf('const chartIntentRequests =');
const end = source.indexOf('\nasync function primeMainHistory', start);
assert.ok(start > 0 && end > start);

function build(overrides = {}) {
  const cache = new Map(), requests = [], releases = [];
  const ctx = { document: { hidden: false }, activeView: 'screener', screenerView: 'chart', Date,
    touchKlinesCache: key => cache.get(key), storeKlinesCache: (key, data) => cache.set(key, { data, ts: Date.now() }),
    mergeCandles: (old, recent) => [...old, ...recent],
    fetchServerKlines: (...args) => { requests.push(args); return new Promise(resolve => releases.push(resolve)); },
    ...overrides };
  vm.runInNewContext(source.slice(start, end), ctx);
  return { cache, requests, releases, warm: ctx.warmChartOnIntent };
}

test('intent prefetch shares an in-flight request and retains accumulated history', async () => {
  const h = build(), key = 'BN|BTCUSDT|15m';
  h.cache.set(key, { data: [{ t: 1 }], ts: Date.now() - 20000 });
  const a = h.warm('BN', 'BTCUSDT', '15m'), b = h.warm('BN', 'BTCUSDT', '15m');
  assert.equal(h.requests.length, 1);
  h.releases[0]([{ t: 2 }]);
  await Promise.all([a, b]);
  assert.equal(h.cache.get(key).data.length, 2);
  assert.equal(h.cache.get(key).data[0].t, 1);
  await h.warm('BN', 'BTCUSDT', '15m');
  assert.equal(h.requests.length, 1, 'a fresh cache hit adds no request');
});

test('moving across a large list cannot open more than two prefetches', async () => {
  const h = build();
  const tasks = Array.from({ length: 1000 }, (_, i) => h.warm('BN', 'COIN' + i, '15m'));
  assert.equal(h.requests.length, 2);
  h.releases.forEach(resolve => resolve([])); await Promise.all(tasks);
  const next = h.warm('BN', 'NEXT', '15m');
  assert.equal(h.requests.length, 3); h.releases[2]([]); await next;
});

for (const overrides of [{ document: { hidden: true } }, { activeView: 'events' }, { screenerView: 'multichart' }]) {
  test(`intent prefetch skips inactive views: ${JSON.stringify(overrides)}`, async () => {
    const h = build(overrides); await h.warm('BN', 'BTCUSDT', '15m'); assert.equal(h.requests.length, 0);
  });
}

test('failed prefetch leaves the existing cache usable and releases its concurrency slot', async () => {
  let attempts = 0;
  const h = build({ fetchServerKlines: async () => { if (++attempts === 1) throw new Error('offline'); return [{ t: 3 }]; } });
  h.cache.set('BN|BTCUSDT|15m', { data: [{ t: 1 }], ts: 0 });
  await h.warm('BN', 'BTCUSDT', '15m');
  assert.equal(h.cache.get('BN|BTCUSDT|15m').data[0].t, 1);
  await h.warm('BN', 'BTCUSDT', '15m');
  assert.equal(attempts, 2);
});
