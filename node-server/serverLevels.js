"use strict";

/**
 * Server-side 24/7 Level Detection Engine
 * Calculates unmitigated liquidity levels and touch counts across all coins & timeframes
 */

function detectChartLevelsAndTouches(candles) {
  if (!candles || candles.length < 40) return [];

  const N = candles.length;

  let atrSum = 0;
  for (let i = Math.max(1, N - 14); i < N; i++) {
    const c = candles[i], p = candles[i - 1];
    atrSum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  const atr = atrSum / 14;
  const tol = atr * 0.4;
  const minDep = atr * 0.8;

  const W = 3;
  const swings = [];
  for (let i = W; i < N - W; i++) {
    let isH = true, isL = true;
    for (let j = i - W; j <= i + W; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isH = false;
      if (candles[j].l <= candles[i].l) isL = false;
    }
    if (isH) swings.push({ idx: i, price: candles[i].h, type: 'high' });
    if (isL) swings.push({ idx: i, price: candles[i].l, type: 'low' });
  }

  const lastPrice = candles[N - 1].c;
  const candidates = [];

  for (const sw of swings) {
    const lvl = sw.price;

    let departed = false;
    let departureIdx = sw.idx;
    for (let i = sw.idx + 1; i < Math.min(sw.idx + 6, N); i++) {
      if (sw.type === 'high') {
        if (lvl - candles[i].c >= minDep) { departed = true; departureIdx = i; break; }
      } else {
        if (candles[i].c - lvl >= minDep) { departed = true; departureIdx = i; break; }
      }
    }
    if (!departed) continue;

    let mitigated = false;
    for (let i = sw.idx + 1; i < N; i++) {
      if (sw.type === 'high') {
        if (candles[i].h > lvl) { mitigated = true; break; }
      } else {
        if (candles[i].l < lvl) { mitigated = true; break; }
      }
    }
    if (mitigated) continue;

    let touches = 0;
    for (let i = sw.idx + 1; i < N; i++) {
      const c = candles[i];
      if (sw.type === 'high') {
        if (c.h >= lvl - tol && c.h <= lvl) touches++;
      } else {
        if (c.l <= lvl + tol && c.l >= lvl) touches++;
      }
    }

    const direction = sw.type === 'high' ? 'up' : 'down';
    const distPct = ((lvl - lastPrice) / lastPrice) * 100;

    candidates.push({
      price: lvl,
      endPrice: lvl,
      startIdx: sw.idx,
      type: sw.type,
      direction: direction,
      touches: touches,
      distPct: distPct,
      age: N - 1 - sw.idx
    });
  }

  const merged = [];
  const distTol = 0.003;
  for (const cand of candidates) {
    let match = null;
    for (const existing of merged) {
      if (existing.direction === cand.direction && Math.abs(existing.price - cand.price) / existing.price < distTol) {
        match = existing;
        break;
      }
    }
    if (match) {
      if (cand.age < match.age) {
        match.price = cand.price;
        match.endPrice = cand.price;
        match.startIdx = cand.startIdx;
        match.age = cand.age;
      }
      match.touches += cand.touches + 1;
    } else {
      merged.push({ ...cand });
    }
  }

  merged.sort((a, b) => Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice));
  return merged.slice(0, 10);
}

module.exports = { detectChartLevelsAndTouches };
