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
      // 1m: max 5% up/down, top 3 levels per side, recent 180 bars (~3 hours)
      return { tfMins: 1, maxDistPct: 0.05, maxLevelsPerSide: 3, swingW: 3, maxLookback: 180, minSpacingPct: 0.0015 };
    } else if (tfMins <= 5) {
      // 3m-5m: max 10% up/down, top 3 levels per side, recent 220 bars
      return { tfMins: 5, maxDistPct: 0.10, maxLevelsPerSide: 3, swingW: 3, maxLookback: 220, minSpacingPct: 0.0025 };
    } else if (tfMins <= 15) {
      // 15m: max 16% up/down, top 3-4 levels per side, recent 250 bars
      return { tfMins: 15, maxDistPct: 0.16, maxLevelsPerSide: 4, swingW: 3, maxLookback: 250, minSpacingPct: 0.0040 };
    } else if (tfMins <= 60) {
      // 30m-1h: max 22% up/down, top 4 levels per side, recent 280 bars
      return { tfMins: 60, maxDistPct: 0.22, maxLevelsPerSide: 4, swingW: 4, maxLookback: 280, minSpacingPct: 0.0060 };
    } else if (tfMins <= 240) {
      // 2h-4h: max 30% up/down, top 4 levels per side, recent 300 bars
      return { tfMins: 240, maxDistPct: 0.30, maxLevelsPerSide: 4, swingW: 4, maxLookback: 300, minSpacingPct: 0.0080 };
    } else {
      // 1d+: max 55% up/down, top 5 levels per side, recent 360 bars
      return { tfMins: 1440, maxDistPct: 0.55, maxLevelsPerSide: 5, swingW: 5, maxLookback: 360, minSpacingPct: 0.0150 };
    }
  }

  function detectHorizontals(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 30) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const profile = getTimeframeProfile(candles);
    const clusterTol = Math.max(0.0008, Math.min(0.0035, (range / lastPrice) * 0.25));
    const epsilon = Math.min(range * 0.02, lastPrice * 0.0004);
    const points = swings(candles, profile.swingW);
    const minT = Math.max(1, Number(minTouches) || 1);
    const candidates = [];

    for (const resistance of [true, false]) {
      const side = points.filter(item => item.type === (resistance ? "high" : "low"));
      for (const cluster of makeClusters(side, clusterTol, resistance)) {
        const first = Math.min(...cluster.swingIndices);
        if (resistance ? cluster.price <= lastPrice : cluster.price >= lastPrice) continue;

        const distPct = Math.abs(cluster.price - lastPrice) / lastPrice;
        if (distPct > profile.maxDistPct * 1.3) continue;

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
    const profile = getTimeframeProfile(candles);
    const epsilon = Math.min(range * 0.025, lastPrice * 0.0005);
    const minCascadeCount = Math.max(1, Number(minCount) || 1);
    
    // Lookback constraint according to timeframe
    const minStartIdx = Math.max(profile.swingW, candles.length - profile.maxLookback);
    const allSwings = swings(candles, profile.swingW).filter(sw => sw.idx >= minStartIdx);
    
    const upCandidates = [];
    const downCandidates = [];

    for (const sw of allSwings) {
      if (sw.type === "high") {
        if (sw.price <= lastPrice) continue;
        // Limit max distance from current price for this timeframe!
        const distPct = (sw.price - lastPrice) / lastPrice;
        if (distPct > profile.maxDistPct) continue;

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
        // Limit max distance from current price for this timeframe!
        const distPct = (lastPrice - sw.price) / lastPrice;
        if (distPct > profile.maxDistPct) continue;

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
      const minSpacing = Math.max(lastPrice * profile.minSpacingPct, Math.min(range * 0.08, lastPrice * 0.0015));
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

  function linesCross(l1, l2, startK, endK) {
    const p1Start = l1.p1.price + l1.slope * (startK - l1.p1.idx);
    const p2Start = l2.p1.price + l2.slope * (startK - l2.p1.idx);
    const p1End = l1.p1.price + l1.slope * (endK - l1.p1.idx);
    const p2End = l2.p1.price + l2.slope * (endK - l2.p1.idx);
    const diffStart = p1Start - p2Start;
    const diffEnd = p1End - p2End;
    return (diffStart * diffEnd) < 0;
  }

  function detectTrendlines(raw, minTouches) {
    const candles = normalize(raw);
    if (candles.length < 30) return [];
    const range = atr(candles, 24);
    const lastPrice = candles[candles.length - 1].c;
    const touchTol = Math.min(range * 0.15, lastPrice * 0.0022);
    const crossBodyTol = Math.min(range * 0.05, lastPrice * 0.0008);
    const crossWickTol = Math.min(range * 0.12, lastPrice * 0.0018);
    const minimum = Math.max(2, Number(minTouches) || 2);
    const N = candles.length;

    function collectForSide(points, resistance) {
      const candidates = [];
      const pts = points.slice(-140);

      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const p1 = pts[i], p2 = pts[j];
          const span = p2.idx - p1.idx;
          // Must span at least 18 bars to represent a real structure, not micro-pump noise
          if (span < 18) continue;

          const slope = (p2.price - p1.price) / span;
          // Forbid excessively steep lines (vertical impulse wicks)
          if (Math.abs(slope) > range * 0.11 || Math.abs(slope) < range * 0.0004) continue;

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

          const minDeparture = range * 0.22;
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

            if (departed && Math.abs(wick - line) <= touchTol && (k - lastTouch) >= 5) {
              touches.push(k);
              lastTouch = k;
              departed = false;
            }
          }

          if (touches.length < minimum) continue;

          if (touches.length === 2 && span > 140) continue;
          let maxGap = 0;
          for (let t = 1; t < touches.length; t++) {
            maxGap = Math.max(maxGap, touches[t] - touches[t - 1]);
          }
          if (maxGap > 160) continue;

          const lastTouchAge = N - 1 - touches[touches.length - 1];
          if (lastTouchAge > 85) continue;

          const endPrice = p1.price + slope * (N - 1 - p1.idx);
          if (!(endPrice > 0)) continue;
          if (resistance ? lastPrice > endPrice + crossBodyTol : lastPrice < endPrice - crossBodyTol) continue;

          const distanceAtr = Math.abs(endPrice - lastPrice) / range;
          if (distanceAtr > 3.8) continue;

          const totalSpan = N - 1 - p1.idx;
          // Priority ranking:
          // 1. Touches count (touches * 35)
          // 2. Structural size / span (totalSpan * 0.4)
          // 3. Proximity to current price (closer = higher score)
          // 4. Freshness of touch
          const strength =
            touches.length * 35.0 +
            Math.min(totalSpan, 200) * 0.35 +
            Math.max(0, 4.0 - distanceAtr) * 12.0 +
            Math.max(0, 80 - lastTouchAge) * 0.25;

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
            span: totalSpan,
            lastTouchAge,
            strength,
          });
        }
      }

      candidates.sort((a, b) => b.strength - a.strength);

      // Select ONLY the single best dominant trendline on this side (No clutter, no overlapping fans!)
      const kept = [];
      if (candidates.length > 0) {
        kept.push(candidates[0]);
      }

      return kept;
    }

    const allSwings = swings(candles, 3);
    const topResistances = collectForSide(allSwings.filter(item => item.type === "high"), true);
    const bottomSupports = collectForSide(allSwings.filter(item => item.type === "low"), false);

    // Cross-check: If top resistance and bottom support cross each other in visible chart, keep the higher-scored one
    if (topResistances.length > 0 && bottomSupports.length > 0) {
      const r = topResistances[0];
      const s = bottomSupports[0];
      const startK = Math.max(r.p1.idx, s.p1.idx);
      const endK = N - 1 + 8;
      if (startK < endK && linesCross(r, s, startK, endK)) {
        if (r.strength >= s.strength) {
          return [r];
        } else {
          return [s];
        }
      }
    }

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
          const holdsLevel = bullish ? (c.c >= level - holdBuffer) : (c.c <= level + holdBuffer);

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
