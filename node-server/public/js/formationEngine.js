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
    const start = Math.max(w, candles.length - 500);
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

  function isLevelClean(candles, level, startIdx, resistance, epsilon) {
    const last = candles.length - 1;
    for (let i = startIdx + 1; i <= last; i++) {
      const c = candles[i];
      if (resistance) {
        if (c.c > level || c.h > level + epsilon) return false;
      } else {
        if (c.c < level || c.l < level - epsilon) return false;
      }
    }
    return true;
  }

  function getDistinctTouches(candles, level, startIdx, resistance, range) {
    const touchTol = Math.min(range * 0.12, level * 0.002);
    const minDeparture = range * 0.28;
    const touches = [startIdx];
    let departed = false;
    let lastTouch = startIdx;

    for (let i = startIdx + 1; i < candles.length - 1; i++) {
      const c = candles[i];
      const wick = resistance ? c.h : c.l;
      const close = c.c;

      const dist = resistance ? (level - close) : (close - level);
      if (dist >= minDeparture) {
        departed = true;
      }

      if (departed && Math.abs(wick - level) <= touchTol && (i - lastTouch) >= 5) {
        touches.push(i);
        lastTouch = i;
        departed = false;
      }
    }

    return touches;
  }

  function detectHorizontals(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 30) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const clusterTol = Math.max(0.0008, Math.min(0.0035, (range / lastPrice) * 0.25));
    const epsilon = Math.min(range * 0.02, lastPrice * 0.0004);
    const points = swings(candles, 3);
    const minT = Math.max(1, Number(minTouches) || 1);
    const candidates = [];

    for (const resistance of [true, false]) {
      const side = points.filter(item => item.type === (resistance ? "high" : "low"));
      for (const cluster of makeClusters(side, clusterTol, resistance)) {
        const first = Math.min(...cluster.swingIndices);
        if (resistance ? cluster.price <= lastPrice : cluster.price >= lastPrice) continue;
        if (!isLevelClean(candles, cluster.price, first, resistance, epsilon)) continue;

        // Get TRUE distinct touches with full wave departure between each touch
        const touchIndices = getDistinctTouches(candles, cluster.price, first, resistance, range);
        if (touchIndices.length < minT) continue;

        const distanceAtr = Math.abs(cluster.price - lastPrice) / range;
        if (distanceAtr > 15) continue;

        candidates.push({
          price: cluster.price,
          endPrice: cluster.price,
          swingIdx: first,
          direction: resistance ? "up" : "down",
          touchIndices,
          touches: touchIndices.length,
          strength: touchIndices.length * 6 - distanceAtr,
          isHorizontal: true,
        });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const minSpacing = Math.min(range * 0.10, lastPrice * 0.002);
    for (const item of candidates) {
      if (!kept.some(other => other.direction === item.direction && Math.abs(other.price - item.price) <= minSpacing)) {
        kept.push(item);
      }
      if (kept.length >= 8) break;
    }
    return kept;
  }

  function detectCascades(raw, minCount) {
    const candles = normalize(raw);
    if (candles.length < 30) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const epsilon = Math.min(range * 0.025, lastPrice * 0.0005);
    const minCascadeCount = Math.max(1, Number(minCount) || 1);
    const allSwings = swings(candles, 3);
    const upCandidates = [];
    const downCandidates = [];

    for (const sw of allSwings) {
      if (sw.type === "high") {
        if (sw.price <= lastPrice) continue;
        if (!isLevelClean(candles, sw.price, sw.idx, true, epsilon)) continue;

        const touchIndices = [sw.idx];
        const touchTol = Math.min(range * 0.12, lastPrice * 0.002);
        for (let i = sw.idx + 2; i < candles.length - 1; i++) {
          if (Math.abs(candles[i].h - sw.price) <= touchTol && i - touchIndices[touchIndices.length - 1] > 1) {
            touchIndices.push(i);
          }
        }

        upCandidates.push({
          price: sw.price,
          endPrice: sw.price,
          swingIdx: sw.idx,
          direction: "up",
          touchIndices,
          touches: touchIndices.length,
          age: candles.length - 1 - sw.idx,
        });
      } else if (sw.type === "low") {
        if (sw.price >= lastPrice) continue;
        if (!isLevelClean(candles, sw.price, sw.idx, false, epsilon)) continue;

        const touchIndices = [sw.idx];
        const touchTol = Math.min(range * 0.12, lastPrice * 0.002);
        for (let i = sw.idx + 2; i < candles.length - 1; i++) {
          if (Math.abs(candles[i].l - sw.price) <= touchTol && i - touchIndices[touchIndices.length - 1] > 1) {
            touchIndices.push(i);
          }
        }

        downCandidates.push({
          price: sw.price,
          endPrice: sw.price,
          swingIdx: sw.idx,
          direction: "down",
          touchIndices,
          touches: touchIndices.length,
          age: candles.length - 1 - sw.idx,
        });
      }
    }

    function dedupeLevels(list, isUp) {
      list.sort((a, b) => b.touches - a.touches || a.age - b.age);
      const kept = [];
      const minSpacing = Math.min(range * 0.08, lastPrice * 0.0015);
      for (const item of list) {
        if (!kept.some(other => Math.abs(other.price - item.price) <= minSpacing)) {
          kept.push(item);
        }
      }
      if (isUp) kept.sort((a, b) => a.price - b.price);
      else kept.sort((a, b) => b.price - a.price);
      return kept;
    }

    const dedupedUp = dedupeLevels(upCandidates, true);
    const dedupedDown = dedupeLevels(downCandidates, false);

    const out = [];
    if (dedupedUp.length >= minCascadeCount) {
      out.push(...dedupedUp.slice(0, 10));
    }
    if (dedupedDown.length >= minCascadeCount) {
      out.push(...dedupedDown.slice(0, 10));
    }

    return out;
  }

  function detectTrendlines(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 30) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const touchTol = Math.min(range * 0.14, lastPrice * 0.0022);
    const crossTol = Math.min(range * 0.02, lastPrice * 0.0004);
    const minimum = Math.max(2, Number(minTouches) || 2);
    const candidates = [];

    function collect(points, resistance) {
      const recent = points.slice(-100);
      for (let i = 0; i < recent.length - 1; i++) {
        for (let j = i + 1; j < recent.length; j++) {
          const p1 = recent[i], p2 = recent[j];
          const span = p2.idx - p1.idx;
          if (span < 14) continue;

          const slope = (p2.price - p1.price) / span;
          // Filter out steep near-vertical angles (cliffs)
          if (Math.abs(slope) > range * 0.18 || Math.abs(slope) < range * 0.0005) continue;

          // Check that trendline is STRICTLY unbroken from p1.idx to current candle
          let crossed = false;
          for (let k = p1.idx; k < candles.length; k++) {
            const line = p1.price + slope * (k - p1.idx);
            if (!(line > 0)) { crossed = true; break; }
            const c = candles[k];
            if (resistance) {
              if (c.c > line || c.h > line + crossTol) { crossed = true; break; }
            } else {
              if (c.c < line || c.l < line - crossTol) { crossed = true; break; }
            }
          }
          if (crossed) continue;

          // Count distinct bounces with wave departure
          const minDeparture = range * 0.25;
          const touches = [p1.idx];
          let departed = false;
          let lastTouch = p1.idx;

          for (let k = p1.idx + 1; k < candles.length; k++) {
            const line = p1.price + slope * (k - p1.idx);
            const c = candles[k];
            const wick = resistance ? c.h : c.l;
            const close = c.c;

            const dist = resistance ? (line - close) : (close - line);
            if (dist >= minDeparture) {
              departed = true;
            }

            if (departed && Math.abs(wick - line) <= touchTol && (k - lastTouch) >= 5) {
              touches.push(k);
              lastTouch = k;
              departed = false;
            }
          }

          if (touches.length < minimum) continue;

          // The last touch MUST be active / recent (within last 35 candles)
          const lastTouchAge = candles.length - 1 - touches[touches.length - 1];
          if (lastTouchAge > 35) continue;

          const endPrice = p1.price + slope * (candles.length - 1 - p1.idx);
          if (!(endPrice > 0)) continue;
          if (resistance ? lastPrice > endPrice : lastPrice < endPrice) continue;

          const distanceAtr = Math.abs(endPrice - lastPrice) / range;
          if (distanceAtr > 4.5) continue;

          candidates.push({
            p1, p2, slope, endPrice, direction: resistance ? "up" : "down",
            swingIndices: touches, touches: touches.length, isTrendline: true,
            span: candles.length - 1 - p1.idx,
            lastTouchAge,
            strength: touches.length * 10 + (candles.length - 1 - p1.idx) / 20 - distanceAtr * 2 - lastTouchAge / 10,
          });
        }
      }
    }

    const points = swings(candles, 3);
    collect(points.filter(item => item.type === "high"), true);
    collect(points.filter(item => item.type === "low"), false);

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const minSpacing = Math.min(range * 0.25, lastPrice * 0.005);
    let resCount = 0, supCount = 0;

    for (const item of candidates) {
      if (item.direction === "up" && resCount >= 2) continue;
      if (item.direction === "down" && supCount >= 2) continue;
      if (!kept.some(other => other.direction === item.direction && (Math.abs(other.endPrice - item.endPrice) <= minSpacing || Math.abs(other.slope - item.slope) <= range * 0.01))) {
        kept.push(item);
        if (item.direction === "up") resCount++;
        else supCount++;
      }
      if (kept.length >= 3) break;
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
