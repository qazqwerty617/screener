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

  function linesCross(l1, l2, startK, endK) {
    const p1Start = l1.p1.price + l1.slope * (startK - l1.p1.idx);
    const p2Start = l2.p1.price + l2.slope * (startK - l2.p1.idx);
    const p1End   = l1.p1.price + l1.slope * (endK - l1.p1.idx);
    const p2End   = l2.p1.price + l2.slope * (endK - l2.p1.idx);
    const diffStart = p1Start - p2Start;
    const diffEnd   = p1End - p2End;
    return (diffStart * diffEnd) < 0;
  }

  function detectTrendlines(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 30) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const touchTol = Math.min(range * 0.16, lastPrice * 0.0025);
    const crossBodyTol = Math.min(range * 0.06, lastPrice * 0.0010);
    const crossWickTol = Math.min(range * 0.14, lastPrice * 0.0022);
    const minimum = Math.max(2, Number(minTouches) || 2);
    const N = candles.length;

    function collectForSide(points, resistance) {
      const candidates = [];
      const pts = points.slice(-120);

      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const p1 = pts[i], p2 = pts[j];
          const span = p2.idx - p1.idx;
          if (span < 12) continue;

          const slope = (p2.price - p1.price) / span;
          if (Math.abs(slope) > range * 0.22 || Math.abs(slope) < range * 0.0003) continue;

          let crossed = false;
          for (let k = p1.idx; k < N; k++) {
            const line = p1.price + slope * (k - p1.idx);
            if (!(line > 0)) { crossed = true; break; }
            const c = candles[k];
            if (resistance) {
              if (c.c > line + crossBodyTol || c.h > line + crossWickTol) { crossed = true; break; }
            } else {
              if (c.c < line - crossBodyTol || c.l < line - crossWickTol) { crossed = true; break; }
            }
          }
          if (crossed) continue;

          const minDeparture = range * 0.20;
          const touches = [p1.idx];
          let departed = false;
          let lastTouch = p1.idx;

          for (let k = p1.idx + 1; k < N; k++) {
            const line = p1.price + slope * (k - p1.idx);
            const c = candles[k];
            const wick = resistance ? c.h : c.l;
            const close = c.c;

            const dist = resistance ? (line - close) : (close - line);
            if (dist >= minDeparture) {
              departed = true;
            }

            if (departed && Math.abs(wick - line) <= touchTol && (k - lastTouch) >= 4) {
              touches.push(k);
              lastTouch = k;
              departed = false;
            }
          }

          if (touches.length < minimum) continue;

          if (touches.length === 2 && span > 130) continue;
          let maxGap = 0;
          for (let t = 1; t < touches.length; t++) {
            maxGap = Math.max(maxGap, touches[t] - touches[t - 1]);
          }
          if (maxGap > 150) continue;

          const lastTouchAge = N - 1 - touches[touches.length - 1];
          if (lastTouchAge > 80) continue;

          const endPrice = p1.price + slope * (N - 1 - p1.idx);
          if (!(endPrice > 0)) continue;
          if (resistance ? lastPrice > endPrice + crossBodyTol : lastPrice < endPrice - crossBodyTol) continue;

          const distanceAtr = Math.abs(endPrice - lastPrice) / range;
          if (distanceAtr > 4.0) continue;

          candidates.push({
            p1: { idx: p1.idx, price: p1.price, t: candles[p1.idx]?.t },
            p2: { idx: p2.idx, price: p2.price, t: candles[p2.idx]?.t },
            slope,
            endPrice,
            direction: resistance ? "up" : "down",
            swingIndices: touches,
            touchTimes: touches.map(idx => candles[idx]?.t),
            touches: touches.length,
            isTrendline: true,
            span: N - 1 - p1.idx,
            lastTouchAge,
            strength: touches.length * 14 + (N - 1 - p1.idx) / 15 - distanceAtr * 3.0 - (lastTouchAge / 12),
          });
        }
      }

      candidates.sort((a, b) => b.strength - a.strength);

      // Select up to 2 cleanest NON-INTERSECTING trendlines
      const kept = [];
      const minSpacing = Math.min(range * 0.20, lastPrice * 0.004);

      for (const cand of candidates) {
        if (kept.length >= 2) break;

        let conflict = false;
        for (const existing of kept) {
          if (Math.abs(existing.endPrice - cand.endPrice) <= minSpacing && Math.abs(existing.slope - cand.slope) <= range * 0.012) {
            conflict = true;
            break;
          }
          const startK = Math.max(existing.p1.idx, cand.p1.idx);
          const endK = N - 1 + 8;
          if (startK < endK && linesCross(existing, cand, startK, endK)) {
            conflict = true;
            break;
          }
        }

        if (!conflict) {
          kept.push(cand);
        }
      }

      return kept;
    }

    const allSwings = swings(candles, 3);
    const topResistances = collectForSide(allSwings.filter(item => item.type === "high"), true);
    const bottomSupports = collectForSide(allSwings.filter(item => item.type === "low"), false);

    return [...topResistances, ...bottomSupports];
  }

  function detectRetestSet(raw, approaching) {
    const candles = normalize(raw);
    if (candles.length < 30) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const touchTol = Math.min(range * 0.14, lastPrice * 0.0022);
    const breakBuffer = Math.min(range * 0.08, lastPrice * 0.0012);
    const holdBuffer = Math.min(range * 0.05, lastPrice * 0.0008);
    const minDeparture = range * 0.30;
    const candidates = [];
    const points = swings(candles, 3);
    const N = candles.length;

    for (const bullish of [true, false]) {
      const sideSwings = points.filter(item => item.type === (bullish ? "high" : "low"));

      for (const sw of sideSwings) {
        const origIdx = sw.idx;
        const level = sw.price;
        if (N - 1 - origIdx < 10) continue;

        // 1. Before breakout: price must NEVER cross to the other side of level
        let breakIdx = -1;
        let preFailed = false;

        for (let i = origIdx + 1; i < N - 1; i++) {
          const c = candles[i];
          if (bullish) {
            if (c.c > level + breakBuffer) {
              breakIdx = i;
              break;
            }
          } else {
            if (c.c < level - breakBuffer) {
              breakIdx = i;
              break;
            }
          }
        }

        if (breakIdx < 0 || breakIdx - origIdx < 3) continue;

        // 2. Breakout departure: price must move away from the level by at least minDeparture
        let departed = false;
        let departIdx = -1;
        for (let i = breakIdx; i < Math.min(N - 1, breakIdx + 45); i++) {
          const c = candles[i];
          if (bullish ? (c.h >= level + minDeparture) : (c.l <= level - minDeparture)) {
            departed = true;
            departIdx = i;
            break;
          }
          if (bullish ? (c.c < level - holdBuffer) : (c.c > level + holdBuffer)) {
            break;
          }
        }

        if (!departed || departIdx < 0) continue;

        if (approaching) {
          const dist = bullish ? (lastPrice - level) : (level - lastPrice);
          if (dist > 0 && dist <= range * 0.40) {
            candidates.push({
              price: level,
              direction: bullish ? "up" : "down",
              swingIdx: origIdx,
              swingTime: candles[origIdx]?.t,
              breakIdx,
              touches: 1,
              isApproachingRetest: true,
              outcome: "approaching",
              strength: 10 - (dist / range) * 5 - (N - 1 - breakIdx) / 20,
            });
          }
          continue;
        }

        // 3. Retest touch & hold: price returns back to touch the level from the new side
        let touchIdx = -1;
        let retestFailed = false;

        for (let i = departIdx + 1; i < N; i++) {
          const c = candles[i];
          const touchesLevel = bullish ? (c.l <= level + touchTol) : (c.h >= level - touchTol);
          const holdsLevel   = bullish ? (c.c >= level - holdBuffer) : (c.c <= level + holdBuffer);

          if (touchesLevel && holdsLevel) {
            touchIdx = i;
            break;
          }

          if (bullish ? (c.c < level - holdBuffer) : (c.c > level + holdBuffer)) {
            retestFailed = true;
            break;
          }
        }

        if (retestFailed || touchIdx < 0) continue;

        // 4. Must hold continuously from touchIdx to current candle (NOW)
        let heldTillNow = true;
        for (let i = touchIdx; i < N; i++) {
          const c = candles[i];
          if (bullish ? (c.c < level - holdBuffer) : (c.c > level + holdBuffer)) {
            heldTillNow = false;
            break;
          }
        }
        if (!heldTillNow) continue;

        // 5. Current price must be on the right side and retest must be recent
        const lastTouchAge = N - 1 - touchIdx;
        if (lastTouchAge > 35) continue;

        if (bullish ? (lastPrice < level - holdBuffer) : (lastPrice > level + holdBuffer)) continue;

        candidates.push({
          price: level,
          direction: bullish ? "up" : "down",
          swingIdx: origIdx,
          swingTime: candles[origIdx]?.t,
          touchIdx,
          touchTime: candles[touchIdx]?.t,
          touchIndices: [origIdx, touchIdx],
          touchTimes: [candles[origIdx]?.t, candles[touchIdx]?.t],
          touches: 2,
          isRetest: true,
          outcome: "confirmed",
          lastTouchAge,
          strength: 20 - (lastTouchAge / 5) + (breakIdx - origIdx) / 10,
        });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const minSpacing = Math.min(range * 0.20, lastPrice * 0.004);
    for (const cand of candidates) {
      if (!kept.some(other => Math.abs(other.price - cand.price) <= minSpacing)) {
        kept.push(cand);
      }
      if (kept.length >= 2) break;
    }
    return kept;
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
