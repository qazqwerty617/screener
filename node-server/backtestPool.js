'use strict';

// Prepared cases and candle histories stay on the server, including hidden bars.
function createBacktestPool({ getUniverse, loadCandles, selectWindow, target = 3, concurrency = 3, timeoutMs = 12000 }) {
  const pools = new Map(), history = new Map(), flights = new Map(), slots = [];
  let active = 0;
  async function limited(work) {
    if (active >= concurrency) await new Promise(resolve => slots.push(resolve));
    else active++;
    try { return await work(); }
    finally { const next = slots.shift(); if (next) next(); else active--; }
  }
  async function candlesFor(ticker, tf) {
    const key = `${ticker.ex}:${ticker.sym}:${tf}`;
    const cached = history.get(key);
    if (cached && Date.now() - cached.at < 600000) return cached.candles;
    if (flights.has(key)) return flights.get(key);
    const request = limited(async () => {
      let timer;
      try {
        const candles = await Promise.race([
          loadCandles(ticker.ex, ticker.sym, tf),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('История временно недоступна')), timeoutMs); })
        ]);
        if (candles?.length >= 260) {
          history.delete(key); history.set(key, { at: Date.now(), candles });
          while (history.size > 80) history.delete(history.keys().next().value);
        }
        return candles;
      } finally { clearTimeout(timer); }
    }).finally(() => flights.delete(key));
    flights.set(key, request);
    return request;
  }
  function poolFor(ex, tf) {
    const key = `${ex}:${tf}`;
    if (!pools.has(key)) {
      // Evict idle pools only; never detach a caller waiting for a case.
      for (const [id, pool] of pools) {
        if (pools.size < 16) break;
        if (!pool.filling && !pool.waiters.length) pools.delete(id);
      }
      pools.set(key, { ex, tf, ready: [], waiters: [], seen: new Set(), cursor: 0, filling: null });
    }
    return pools.get(key);
  }
  function fill(pool) {
    if (pool.filling || pool.ready.length >= target) return pool.filling;
    const universe = getUniverse(pool.ex).slice(0, 80);
    let index = 0;
    const worker = async () => {
      while (index < Math.min(18, universe.length) && (pool.ready.length < target || pool.waiters.length)) {
        const ticker = universe[(pool.cursor + index++) % universe.length];
        try {
          const candles = await candlesFor(ticker, pool.tf);
          const best = selectWindow(candles, pool.tf);
          if (!best?.visible?.length || !best.future?.length) continue;
          const fingerprint = `${ticker.sym}:${best.visible.at(-1).t}`;
          if (pool.seen.has(fingerprint)) continue;
          pool.seen.add(fingerprint);
          while (pool.seen.size > 100) pool.seen.delete(pool.seen.values().next().value);
          const item = { ticker, best, universeSize: universe.length, preparedAt: Date.now() };
          const waiter = pool.waiters.shift();
          if (waiter) waiter.resolve(item);
          else if (pool.ready.length < target) pool.ready.push(item);
        } catch (_) { /* One unavailable venue/symbol must not stall other candidates. */ }
      }
    };
    pool.filling = Promise.all(Array.from({ length: concurrency }, worker)).finally(() => {
      pool.cursor = (pool.cursor + index) % Math.max(1, universe.length);
      pool.filling = null;
      for (const waiter of pool.waiters.splice(0)) waiter.reject(new Error('Активный участок пока не найден. Попробуйте другой таймфрейм или биржу.'));
    });
    return pool.filling;
  }
  function take(ex, tf) {
    const pool = poolFor(ex, tf);
    pool.ready = pool.ready.filter(item => Date.now() - item.preparedAt < 900000);
    const item = pool.ready.shift();
    if (item) { fill(pool); return Promise.resolve(item); }
    const result = new Promise((resolve, reject) => {
      const waiter = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        const index = pool.waiters.indexOf(waiter);
        if (index >= 0) pool.waiters.splice(index, 1);
        reject(new Error('Подготовка продолжается. Повторите через несколько секунд.'));
      }, timeoutMs);
      pool.waiters.push(waiter);
    });
    fill(pool);
    return result;
  }
  return { take, warm: (ex, tf) => fill(poolFor(ex, tf)) };
}
module.exports = { createBacktestPool };
