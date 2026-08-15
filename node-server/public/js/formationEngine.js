(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FormationEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalize(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      const c = Array.isArray(item)
        ? { t: +item[0], o: +item[1], h: +item[2], l: +item[3], c: +item[4], v: +item[5] || 0 }
        : { t: +item.t, o: +item.o, h: +item.h, l: +item.l, c: +item.c, v: +item.v || 0 };
      if ([c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.c > 0 && c.h >= c.l) out.push(c);
    }
    return out;
  }

  function atr(candles, period) {
    const n = candles.length;
    const start = Math.max(1, n - (period || 24));
    let sum = 0;
    for (let i = start; i < n; i++) {
      sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    }
    return sum / Math.max(1, n - start) || candles[n - 1].c * 0.005;
  }

  function swings(candles, windowSize) {
    const w = windowSize || 3;
    const out = [];
    const start = Math.max(w, candles.length - 360);
    for (let i = start; i < candles.length - w; i++) {
      let high = true, low = true;
      for (let j = i - w; j <= i + w; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) high = false;
        if (candles[j].l <= candles[i].l) low = false;
      }
      if (high) out.push({ idx: i, price: candles[i].h, type: "high" });
      if (low) out.push({ idx: i, price: candles[i].l, type: "low" });
    }
    return out;
  }

  function makeClusters(points, tolerance, resistance) {
    const clusters = [];
    for (const point of points) {
      let best = null;
      for (const cluster of clusters) {
        if (Math.abs(point.price - cluster.center) / cluster.center <= tolerance) {
          best = cluster;
          break;
        }
      }
      if (!best) {
        best = { center: point.price, prices: [], swingIndices: [] };
        clusters.push(best);
      }
      best.prices.push(point.price);
      best.swingIndices.push(point.idx);
      best.center = best.prices.reduce((sum, value) => sum + value, 0) / best.prices.length;
      // The visible line is the outer tangent, never the average through wicks.
      best.price = resistance ? Math.max(...best.prices) : Math.min(...best.prices);
      best.touches = best.swingIndices.length;
    }
    return clusters;
  }

  function cleanHorizontal(candles, level, start, resistance, epsilon, end) {
    const last = Math.min(end == null ? candles.length - 2 : end, candles.length - 1);
    for (let i = start; i <= last; i++) {
      if (resistance && candles[i].h > level + epsilon) return false;
      if (!resistance && candles[i].l < level - epsilon) return false;
    }
    return true;
  }

  function detectHorizontals(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 40) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const clusterTol = Math.max(0.0008, Math.min(0.0045, range / lastPrice * 0.28));
    const epsilon = range * 0.035;
    const points = swings(candles, 3);
    const candidates = [];

    for (const resistance of [true, false]) {
      const side = points.filter(item => item.type === (resistance ? "high" : "low"));
      for (const cluster of makeClusters(side, clusterTol, resistance)) {
        if (cluster.touches < Math.max(2, Number(minTouches) || 2)) continue;
        const first = Math.min(...cluster.swingIndices);
        const last = Math.max(...cluster.swingIndices);
        if (!cleanHorizontal(candles, cluster.price, last + 1, resistance, epsilon)) continue;
        if (resistance ? cluster.price <= lastPrice : cluster.price >= lastPrice) continue;
        const distanceAtr = Math.abs(cluster.price - lastPrice) / range;
        if (distanceAtr > 8) continue;
        candidates.push({
          price: cluster.price,
          endPrice: cluster.price,
          swingIdx: first,
          lastTouch: last,
          direction: resistance ? "up" : "down",
          touchIndices: cluster.swingIndices.slice().sort((a, b) => a - b),
          touches: cluster.touches,
          strength: cluster.touches * 5 - distanceAtr - (candles.length - 1 - last) / 80,
          isHorizontal: true,
        });
      }
    }
    candidates.sort((a, b) => b.strength - a.strength);
    return candidates.slice(0, 10);
  }

  function detectCascades(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 40) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const epsilon = range * 0.035;
    const candidates = [];
    for (const sw of swings(candles, 3)) {
      let departed = false;
      for (let i = sw.idx + 1; i <= Math.min(sw.idx + 6, candles.length - 1); i++) {
        if (sw.type === "high" ? sw.price - candles[i].c >= range * 0.75 : candles[i].c - sw.price >= range * 0.75) {
          departed = true;
          break;
        }
      }
      if (!departed) continue;
      const resistance = sw.type === "high";
      if (!cleanHorizontal(candles, sw.price, sw.idx + 1, resistance, epsilon)) continue;
      if (resistance ? sw.price <= lastPrice : sw.price >= lastPrice) continue;
      const touchIndices = [sw.idx];
      const touchTol = range * 0.18;
      for (let i = sw.idx + 2; i < candles.length - 1; i++) {
        const wick = resistance ? candles[i].h : candles[i].l;
        if (Math.abs(wick - sw.price) <= touchTol && i - touchIndices[touchIndices.length - 1] > 1) touchIndices.push(i);
      }
      if (touchIndices.length < Math.max(1, Number(minTouches) || 1)) continue;
      const age = candles.length - 1 - sw.idx;
      if (age > 220) continue;
      candidates.push({
        price: sw.price, endPrice: sw.price, swingIdx: sw.idx,
        direction: resistance ? "up" : "down", touchIndices,
        touches: touchIndices.length, age,
        strength: touchIndices.length * 4 - age / 90 - Math.abs(sw.price - lastPrice) / range,
      });
    }
    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    for (const item of candidates) {
      if (!kept.some(other => other.direction === item.direction && Math.abs(other.price - item.price) <= range * 0.2)) kept.push(item);
      if (kept.length >= 10) break;
    }
    return kept;
  }

  function detectTrendlines(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 40) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const touchTol = range * 0.14;
    const crossTol = range * 0.025;
    const minimum = Math.max(2, Number(minTouches) || 2);
    const candidates = [];

    function collect(points, resistance) {
      const recent = points.slice(-30);
      for (let i = 0; i < recent.length - 1; i++) {
        for (let j = i + 1; j < recent.length; j++) {
          const p1 = recent[i], p2 = recent[j];
          const span = p2.idx - p1.idx;
          if (span < 10) continue;
          if (resistance ? p2.price >= p1.price : p2.price <= p1.price) continue;
          const slope = (p2.price - p1.price) / span;
          if (Math.abs(slope) > range * 0.35) continue;
          const touches = [];
          let crossed = false;
          for (let k = p1.idx; k < candles.length - 1; k++) {
            const line = p1.price + slope * (k - p1.idx);
            if (!(line > 0)) { crossed = true; break; }
            const wick = resistance ? candles[k].h : candles[k].l;
            if (resistance ? wick > line + crossTol : wick < line - crossTol) { crossed = true; break; }
            if (Math.abs(wick - line) <= touchTol && (!touches.length || k - touches[touches.length - 1] >= 3)) touches.push(k);
          }
          if (crossed || touches.length < minimum) continue;
          const endPrice = p1.price + slope * (candles.length - 1 - p1.idx);
          if (!(endPrice > 0)) continue;
          if (resistance ? lastPrice > endPrice + crossTol : lastPrice < endPrice - crossTol) continue;
          const distanceAtr = Math.abs(endPrice - lastPrice) / range;
          if (distanceAtr > 4) continue;
          candidates.push({
            p1, p2, slope, endPrice, direction: resistance ? "up" : "down",
            swingIndices: touches, touches: touches.length, isTrendline: true,
            strength: touches.length * 6 + span / 25 - distanceAtr * 2 - (candles.length - 1 - p2.idx) / 100,
          });
        }
      }
    }

    const points = swings(candles, 3);
    collect(points.filter(item => item.type === "high"), true);
    collect(points.filter(item => item.type === "low"), false);
    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    for (const item of candidates) {
      if (!kept.some(other => other.direction === item.direction && Math.abs(other.endPrice - item.endPrice) <= range * 0.2 && Math.abs(other.slope - item.slope) <= range * 0.02)) kept.push(item);
      if (kept.length >= 8) break;
    }
    return kept;
  }

  function detectRetestSet(raw, approaching) {
    const candles = normalize(raw);
    if (candles.length < 45) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const zone = range * 0.16;
    const breakBuffer = range * 0.12;
    const candidates = [];
    const points = swings(candles, 3);

    for (const bullish of [true, false]) {
      const clusters = makeClusters(points.filter(item => item.type === (bullish ? "high" : "low")), Math.max(0.0008, range / lastPrice * 0.3), bullish);
      for (const cluster of clusters) {
        if (cluster.touches < 2) continue;
        const level = cluster.price;
        const lastTouch = Math.max(...cluster.swingIndices);
        let breakIdx = -1;
        for (let i = lastTouch + 1; i < candles.length - 2; i++) {
          if (bullish ? candles[i].c > level + breakBuffer : candles[i].c < level - breakBuffer) { breakIdx = i; break; }
        }
        if (breakIdx < 0) continue;
        let departed = false, touchIdx = -1, failed = false;
        for (let i = breakIdx + 1; i < candles.length - 1 && i <= breakIdx + 45; i++) {
          const candle = candles[i];
          if (bullish ? candle.c < level - zone : candle.c > level + zone) { failed = true; break; }
          if (bullish ? candle.h >= level + range * 0.65 : candle.l <= level - range * 0.65) departed = true;
          if (!departed || i < breakIdx + 2) continue;
          const touched = bullish ? candle.l <= level + zone : candle.h >= level - zone;
          const held = bullish ? candle.c >= level : candle.c <= level;
          if (touched && held) { touchIdx = i; break; }
        }
        if (failed) continue;
        if (approaching) {
          if (touchIdx >= 0 || !departed) continue;
          const distance = bullish ? lastPrice - level : level - lastPrice;
          if (distance <= 0 || distance > range * 0.8) continue;
          candidates.push({ price: level, direction: bullish ? "up" : "down", swingIdx: Math.min(...cluster.swingIndices), breakIdx, touches: cluster.touches, isApproachingRetest: true, outcome: "approaching", strength: cluster.touches * 5 - distance / range });
          continue;
        }
        if (touchIdx < 0 || candles.length - 1 - touchIdx > 20) continue;
        let held = true;
        for (let i = touchIdx; i < candles.length - 1; i++) {
          if (bullish ? candles[i].c < level - zone : candles[i].c > level + zone) { held = false; break; }
        }
        if (!held) continue;
        candidates.push({ price: level, direction: bullish ? "up" : "down", swingIdx: Math.min(...cluster.swingIndices), breakIdx, touchIdx, touches: cluster.touches, isRetest: true, outcome: "confirmed", strength: cluster.touches * 7 - (candles.length - 1 - touchIdx) / 4 });
      }
    }
    candidates.sort((a, b) => b.strength - a.strength);
    return candidates.slice(0, approaching ? 3 : 4);
  }

  return {
    normalize,
    detectCascades,
    detectHorizontals,
    detectTrendlines,
    detectRetests: raw => detectRetestSet(raw, false),
    detectApproachingRetests: raw => detectRetestSet(raw, true),
  };
});
