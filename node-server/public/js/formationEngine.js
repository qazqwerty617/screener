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
    if (n < 2) return candles[0]?.c * 0.01 || 1;
    const start = Math.max(1, n - (period || 24));
    let sum = 0;
    for (let i = start; i < n; i++) {
      sum += Math.max(
        candles[i].h - candles[i].l,
        Math.abs(candles[i].h - candles[i - 1].c),
        Math.abs(candles[i].l - candles[i - 1].c)
      );
    }
    return sum / Math.max(1, n - start) || candles[n - 1].c * 0.005;
  }

  function swings(candles, windowSize) {
    const w = windowSize || 3;
    const out = [];
    const n = candles.length;
    const start = Math.max(w, n - 400);
    for (let i = start; i < n - w; i++) {
      let high = true, low = true;
      for (let j = 1; j <= w; j++) {
        if (candles[i - j].h >= candles[i].h || candles[i + j].h > candles[i].h) high = false;
        if (candles[i - j].l <= candles[i].l || candles[i + j].l < candles[i].l) low = false;
      }
      if (high) out.push({ idx: i, price: candles[i].h, type: "high", t: candles[i].t, v: candles[i].v });
      if (low) out.push({ idx: i, price: candles[i].l, type: "low", t: candles[i].t, v: candles[i].v });
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
        best = { center: point.price, prices: [], swingIndices: [], points: [] };
        clusters.push(best);
      }
      best.prices.push(point.price);
      best.swingIndices.push(point.idx);
      best.points.push(point);
      best.center = best.prices.reduce((sum, val) => sum + val, 0) / best.prices.length;
      best.price = resistance ? Math.max(...best.prices) : Math.min(...best.prices);
      best.touches = best.swingIndices.length;
    }
    return clusters;
  }

  function isLevelClean(candles, level, startIdx, resistance, closeTol, wickTol) {
    const last = candles.length - 1;
    let breachCount = 0;
    for (let i = startIdx + 1; i <= last; i++) {
      const c = candles[i];
      if (resistance) {
        if (c.c > level + closeTol) return false;
        if (c.h > level + wickTol) {
          breachCount++;
          if (breachCount > 2) return false;
        }
      } else {
        if (c.c < level - closeTol) return false;
        if (c.l < level - wickTol) {
          breachCount++;
          if (breachCount > 2) return false;
        }
      }
    }
    return true;
  }

  function getDistinctTouches(candles, level, startIdx, resistance, range) {
    const touchTol = Math.max(range * 0.15, level * 0.0025);
    const minDeparture = Math.max(range * 0.20, level * 0.0030);
    const touches = [startIdx];
    let departed = false;
    let lastTouch = startIdx;

    for (let i = startIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const wick = resistance ? c.h : c.l;
      const close = c.c;

      const dist = resistance ? (level - close) : (close - level);
      if (dist >= minDeparture) {
        departed = true;
      }

      if (departed && Math.abs(wick - level) <= touchTol && (i - lastTouch) >= 3) {
        touches.push(i);
        lastTouch = i;
        departed = false;
      }
    }

    return touches;
  }

  function getCandleTfMinutes(candles) {
    if (!candles || candles.length < 2) return 1;
    const diffs = [];
    for (let i = Math.max(1, candles.length - 25); i < candles.length; i++) {
      const dt = candles[i].t - candles[i - 1].t;
      if (dt > 0) diffs.push(dt);
    }
    if (diffs.length === 0) return 1;
    diffs.sort((a, b) => a - b);
    const medianMs = diffs[Math.floor(diffs.length / 2)];
    return Math.max(1, Math.round(medianMs / 60000));
  }

  function getTimeframeProfile(candles) {
    const tfMins = getCandleTfMinutes(candles);
    if (tfMins <= 1) {
      return { tfMins: 1, maxDistPct: 0.06, maxLevelsPerSide: 4, swingW: 3, maxLookback: 200, minSpacingPct: 0.0015 };
    } else if (tfMins <= 5) {
      return { tfMins: 5, maxDistPct: 0.12, maxLevelsPerSide: 4, swingW: 3, maxLookback: 250, minSpacingPct: 0.0025 };
    } else if (tfMins <= 15) {
      return { tfMins: 15, maxDistPct: 0.18, maxLevelsPerSide: 5, swingW: 3, maxLookback: 300, minSpacingPct: 0.0040 };
    } else if (tfMins <= 60) {
      return { tfMins: 60, maxDistPct: 0.28, maxLevelsPerSide: 5, swingW: 4, maxLookback: 320, minSpacingPct: 0.0060 };
    } else if (tfMins <= 240) {
      return { tfMins: 240, maxDistPct: 0.38, maxLevelsPerSide: 5, swingW: 4, maxLookback: 350, minSpacingPct: 0.0080 };
    } else {
      return { tfMins: 1440, maxDistPct: 0.65, maxLevelsPerSide: 6, swingW: 5, maxLookback: 400, minSpacingPct: 0.0150 };
    }
  }

  // ── 1. Horizontal S/R Levels Detection ──────────────────────────────────────
  function detectHorizontals(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 25) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const profile = getTimeframeProfile(candles);
    const clusterTol = Math.max(0.0012, Math.min(0.0045, (range / lastPrice) * 0.35));
    const closeTol = Math.min(range * 0.08, lastPrice * 0.0012);
    const wickTol = Math.min(range * 0.20, lastPrice * 0.0030);
    const points = swings(candles, profile.swingW);
    const minT = Math.max(1, Number(minTouches) || 1);
    const candidates = [];

    for (const resistance of [true, false]) {
      const side = points.filter(item => item.type === (resistance ? "high" : "low"));
      for (const cluster of makeClusters(side, clusterTol, resistance)) {
        const first = Math.min(...cluster.swingIndices);
        if (resistance ? cluster.price <= lastPrice * 0.999 : cluster.price >= lastPrice * 1.001) continue;

        const distPct = Math.abs(cluster.price - lastPrice) / lastPrice;
        if (distPct > profile.maxDistPct * 1.5) continue;

        if (!isLevelClean(candles, cluster.price, first, resistance, closeTol, wickTol)) continue;

        const touchIndices = getDistinctTouches(candles, cluster.price, first, resistance, range);
        if (touchIndices.length < minT) continue;

        const distanceAtr = Math.abs(cluster.price - lastPrice) / Math.max(1e-9, range);
        const lastTouchIdx = touchIndices[touchIndices.length - 1];
        const age = candles.length - 1 - lastTouchIdx;

        candidates.push({
          price: cluster.price,
          endPrice: cluster.price,
          swingIdx: first,
          direction: resistance ? "up" : "down", // "up" = resistance above, "down" = support below
          touchIndices,
          touches: touchIndices.length,
          distPct: +(distPct * 100).toFixed(2),
          age,
          strength: touchIndices.length * 8 - Math.min(distanceAtr, 10) * 1.5 - (age / 30),
          isHorizontal: true,
        });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const minSpacing = Math.min(range * 0.12, lastPrice * 0.0025);
    for (const item of candidates) {
      if (!kept.some(other => other.direction === item.direction && Math.abs(other.price - item.price) <= minSpacing)) {
        kept.push(item);
      }
      if (kept.length >= 10) break;
    }
    return kept;
  }

  // ── 2. Cascades (Multi-level Stacked S/R Levels) ─────────────────────────────
  function detectCascades(raw, minCount) {
    const candles = normalize(raw);
    if (candles.length < 25) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const profile = getTimeframeProfile(candles);
    const closeTol = Math.min(range * 0.09, lastPrice * 0.0015);
    const wickTol = Math.min(range * 0.22, lastPrice * 0.0035);
    const minCascadeCount = Math.max(1, Number(minCount) || 1);
    
    const minStartIdx = Math.max(profile.swingW, candles.length - profile.maxLookback);
    const allSwings = swings(candles, profile.swingW).filter(sw => sw.idx >= minStartIdx);
    
    const upCandidates = [];
    const downCandidates = [];

    for (const sw of allSwings) {
      if (sw.type === "high") {
        if (sw.price <= lastPrice * 0.999) continue;
        const distPct = (sw.price - lastPrice) / lastPrice;
        if (distPct > profile.maxDistPct) continue;

        if (!isLevelClean(candles, sw.price, sw.idx, true, closeTol, wickTol)) continue;

        const touchIndices = getDistinctTouches(candles, sw.price, sw.idx, true, range);

        upCandidates.push({
          price: sw.price,
          endPrice: sw.price,
          swingIdx: sw.idx,
          direction: "up",
          touchIndices,
          touches: touchIndices.length,
          distPct: +(distPct * 100).toFixed(2),
          age: candles.length - 1 - sw.idx,
        });
      } else if (sw.type === "low") {
        if (sw.price >= lastPrice * 1.001) continue;
        const distPct = (lastPrice - sw.price) / lastPrice;
        if (distPct > profile.maxDistPct) continue;

        if (!isLevelClean(candles, sw.price, sw.idx, false, closeTol, wickTol)) continue;

        const touchIndices = getDistinctTouches(candles, sw.price, sw.idx, false, range);

        downCandidates.push({
          price: sw.price,
          endPrice: sw.price,
          swingIdx: sw.idx,
          direction: "down",
          touchIndices,
          touches: touchIndices.length,
          distPct: +(distPct * 100).toFixed(2),
          age: candles.length - 1 - sw.idx,
        });
      }
    }

    function dedupeLevels(list, isUp) {
      list.sort((a, b) => b.touches - a.touches || a.age - b.age);
      const kept = [];
      const minSpacing = Math.max(lastPrice * profile.minSpacingPct, Math.min(range * 0.10, lastPrice * 0.0020));
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
      out.push(...dedupedUp.slice(0, profile.maxLevelsPerSide));
    }
    if (dedupedDown.length >= minCascadeCount) {
      out.push(...dedupedDown.slice(0, profile.maxLevelsPerSide));
    }

    return out;
  }

  // ── 3. Dominant & Active Trendline Detection ────────────────────────────────
  function detectTrendlines(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 25) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const touchTol = Math.max(range * 0.16, lastPrice * 0.0028);
    const crossBodyTol = Math.max(range * 0.08, lastPrice * 0.0014);
    const crossWickTol = Math.max(range * 0.20, lastPrice * 0.0032);
    const minimum = Math.max(2, Number(minTouches) || 2);
    const N = candles.length;

    function collectForSide(points, resistance) {
      const candidates = [];
      const pts = points.slice(-120);

      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const p1 = pts[i], p2 = pts[j];
          const span = p2.idx - p1.idx;
          if (span < 8) continue;

          const slope = (p2.price - p1.price) / span;
          if (resistance && slope > range * 0.15) continue; // Resistance shouldn't slope upwards too steeply
          if (!resistance && slope < -range * 0.15) continue; // Support shouldn't slope downwards too steeply

          let crossed = false;
          let breachCount = 0;

          for (let k = p1.idx; k < N; k++) {
            const line = p1.price + slope * (k - p1.idx);
            if (!(line > 0)) { crossed = true; break; }
            const c = candles[k];
            if (resistance) {
              if (c.c > line + crossBodyTol) { crossed = true; break; }
              if (c.h > line + crossWickTol) {
                breachCount++;
                if (breachCount > 2) { crossed = true; break; }
              }
            } else {
              if (c.c < line - crossBodyTol) { crossed = true; break; }
              if (c.l < line - crossWickTol) {
                breachCount++;
                if (breachCount > 2) { crossed = true; break; }
              }
            }
          }
          if (crossed) continue;

          const minDeparture = range * 0.18;
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

            if (departed && Math.abs(wick - line) <= touchTol && (k - lastTouch) >= 3) {
              touches.push(k);
              lastTouch = k;
              departed = false;
            }
          }

          if (touches.length < minimum) continue;

          const lastTouchAge = N - 1 - touches[touches.length - 1];
          if (lastTouchAge > 120) continue;

          const endPrice = p1.price + slope * (N - 1 - p1.idx);
          if (!(endPrice > 0)) continue;

          // Reject if price has already cleanly broken through
          if (resistance ? lastPrice > endPrice + crossBodyTol : lastPrice < endPrice - crossBodyTol) continue;

          const distPct = Math.abs(endPrice - lastPrice) / lastPrice * 100;
          const distanceAtr = Math.abs(endPrice - lastPrice) / Math.max(1e-9, range);

          const totalSpan = N - 1 - p1.idx;
          const strength =
            touches.length * 30.0 +
            Math.min(totalSpan, 180) * 0.25 +
            Math.max(0, 5.0 - distanceAtr) * 8.0 +
            Math.max(0, 80 - lastTouchAge) * 0.20;

          candidates.push({
            p1: { idx: p1.idx, price: p1.price, t: candles[p1.idx]?.t },
            p2: { idx: p2.idx, price: p2.price, t: candles[p2.idx]?.t },
            slope,
            endPrice: +endPrice.toFixed(6),
            direction: resistance ? "up" : "down", // "up" = resistance / short, "down" = support / long
            swingIndices: touches,
            touchTimes: touches.map(idx => candles[idx]?.t),
            touches: touches.length,
            distPct: +distPct.toFixed(2),
            isTrendline: true,
            span: totalSpan,
            lastTouchAge,
            strength,
          });
        }
      }

      candidates.sort((a, b) => b.strength - a.strength);

      // Keep up to 2 distinct top trendlines (e.g. inner vs outer slope)
      const kept = [];
      for (const cand of candidates) {
        const tooClose = kept.some(other => 
          Math.abs(other.endPrice - cand.endPrice) / cand.endPrice < 0.008 ||
          Math.abs(other.slope - cand.slope) < 0.0001
        );
        if (!tooClose) kept.push(cand);
        if (kept.length >= 2) break;
      }

      return kept;
    }

    const allSwings = swings(candles, 3);
    const topResistances = collectForSide(allSwings.filter(item => item.type === "high"), true);
    const bottomSupports = collectForSide(allSwings.filter(item => item.type === "low"), false);

    return [...topResistances, ...bottomSupports];
  }

  // ── 4. Retests & Approaching Retests Detection ──────────────────────────────
  function detectRetestSet(raw, approaching) {
    const candles = normalize(raw);
    if (candles.length < 25) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const touchTol = Math.max(range * 0.16, lastPrice * 0.0028);
    const breakBuffer = Math.max(range * 0.07, lastPrice * 0.0012);
    const holdBuffer = Math.max(range * 0.08, lastPrice * 0.0014);
    const minDeparture = Math.max(range * 0.22, lastPrice * 0.0030);
    const candidates = [];
    const points = swings(candles, 3);
    const N = candles.length;

    for (const bullish of [true, false]) {
      const sideSwings = points.filter(item => item.type === (bullish ? "high" : "low"));

      for (const sw of sideSwings) {
        const origIdx = sw.idx;
        const level = sw.price;
        if (N - 1 - origIdx < 6) continue;

        // 1. Find breakout bar
        let breakIdx = -1;
        for (let i = origIdx + 1; i < N - 1; i++) {
          const c = candles[i];
          if (bullish) {
            if (c.c > level + breakBuffer) { breakIdx = i; break; }
          } else {
            if (c.c < level - breakBuffer) { breakIdx = i; break; }
          }
        }

        if (breakIdx < 0 || breakIdx - origIdx < 2) continue;

        // 2. Breakout departure: price must move away from the level
        let departed = false;
        let departIdx = -1;
        for (let i = breakIdx; i < Math.min(N - 1, breakIdx + 50); i++) {
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
          const distPct = Math.abs(lastPrice - level) / lastPrice * 100;
          if (dist > 0 && dist <= range * 0.60) {
            candidates.push({
              price: level,
              endPrice: level,
              direction: bullish ? "up" : "down",
              swingIdx: origIdx,
              swingTime: candles[origIdx]?.t,
              breakIdx,
              touches: 1,
              distPct: +distPct.toFixed(2),
              isApproachingRetest: true,
              outcome: "approaching",
              strength: 15 - (dist / range) * 5 - (N - 1 - breakIdx) / 15,
            });
          }
          continue;
        }

        // 3. Retest touch & hold: price returns back to touch the level
        let touchIdx = -1;
        let retestFailed = false;

        for (let i = departIdx + 1; i < N; i++) {
          const c = candles[i];
          const touchesLevel = bullish ? (c.l <= level + touchTol) : (c.h >= level - touchTol);
          const holdsLevel = bullish ? (c.c >= level - holdBuffer) : (c.c <= level + holdBuffer);

          if (touchesLevel && holdsLevel) {
            touchIdx = i;
            break;
          }

          if (bullish ? (c.c < level - holdBuffer * 1.5) : (c.c > level + holdBuffer * 1.5)) {
            retestFailed = true;
            break;
          }
        }

        if (retestFailed || touchIdx < 0) continue;

        // 4. Must hold from touchIdx to current candle
        let heldTillNow = true;
        for (let i = touchIdx; i < N; i++) {
          const c = candles[i];
          if (bullish ? (c.c < level - holdBuffer * 1.5) : (c.c > level + holdBuffer * 1.5)) {
            heldTillNow = false;
            break;
          }
        }
        if (!heldTillNow) continue;

        const lastTouchAge = N - 1 - touchIdx;
        if (lastTouchAge > 45) continue;

        if (bullish ? (lastPrice < level - holdBuffer) : (lastPrice > level + holdBuffer)) continue;

        const distPct = Math.abs(lastPrice - level) / lastPrice * 100;
        candidates.push({
          price: level,
          endPrice: level,
          direction: bullish ? "up" : "down",
          swingIdx: origIdx,
          swingTime: candles[origIdx]?.t,
          touchIdx,
          touchTime: candles[touchIdx]?.t,
          touchIndices: [origIdx, touchIdx],
          touchTimes: [candles[origIdx]?.t, candles[touchIdx]?.t],
          touches: 2,
          distPct: +distPct.toFixed(2),
          isRetest: true,
          outcome: "confirmed",
          lastTouchAge,
          strength: 25 - (lastTouchAge / 4) + (breakIdx - origIdx) / 8,
        });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const minSpacing = Math.min(range * 0.15, lastPrice * 0.0030);
    for (const cand of candidates) {
      if (!kept.some(other => Math.abs(other.price - cand.price) <= minSpacing)) {
        kept.push(cand);
      }
      if (kept.length >= 4) break;
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
