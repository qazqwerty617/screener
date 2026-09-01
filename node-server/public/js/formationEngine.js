(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FormationEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ── Shared helpers (zero-alloc where possible) ─────────────────────────────

  function normalize(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const first = raw[0];
    // Fast path: already normalized objects
    if (first && typeof first === "object" && !Array.isArray(first) &&
        typeof first.c === "number" && first.c > 0 && first.h >= first.l) {
      return raw;
    }
    const out = [];
    for (let i = 0, len = raw.length; i < len; i++) {
      const item = raw[i];
      let t, o, h, l, c, v;
      if (Array.isArray(item)) {
        t = +item[0]; o = +item[1]; h = +item[2]; l = +item[3]; c = +item[4]; v = +item[5] || 0;
      } else {
        t = +item.t; o = +item.o; h = +item.h; l = +item.l; c = +item.c; v = +item.v || 0;
      }
      if (c > 0 && h >= l && t === t && o === o && h === h && l === l && c === c) {
        out.push({ t, o, h, l, c, v });
      }
    }
    return out;
  }

  function atr(candles, period) {
    const n = candles.length;
    if (n < 2) return candles[0] ? candles[0].c * 0.01 : 1;
    const start = n > period ? n - period : 1;
    let sum = 0;
    for (let i = start; i < n; i++) {
      const hi = candles[i].h, lo = candles[i].l, pc = candles[i - 1].c;
      const a = hi - lo, b = hi - pc, c = pc - lo;
      sum += (a > b ? (a > c ? a : c) : (b > c ? b : c));
    }
    return sum / (n - start) || candles[n - 1].c * 0.005;
  }

  function swings(candles, w) {
    const out = [];
    const n = candles.length;
    const start = n > 400 + w ? n - 400 : w;
    for (let i = start; i < n - w; i++) {
      let high = true, low = true;
      const ih = candles[i].h, il = candles[i].l;
      for (let j = 1; j <= w; j++) {
        if (high && (candles[i - j].h >= ih || candles[i + j].h > ih)) high = false;
        if (low && (candles[i - j].l <= il || candles[i + j].l < il)) low = false;
        if (!high && !low) break;
      }
      if (high) {
        let prom = w;
        for (let j = w + 1; j <= 60; j++) {
          const leftOk = (i - j < 0) || (candles[i - j].h < ih);
          const rightOk = (i + j >= n) || (candles[i + j].h <= ih);
          if (leftOk && rightOk) prom = j;
          else break;
        }
        out.push({ idx: i, price: ih, type: "high", prominence: prom });
      }
      if (low) {
        let prom = w;
        for (let j = w + 1; j <= 60; j++) {
          const leftOk = (i - j < 0) || (candles[i - j].l > il);
          const rightOk = (i + j >= n) || (candles[i + j].l >= il);
          if (leftOk && rightOk) prom = j;
          else break;
        }
        out.push({ idx: i, price: il, type: "low", prominence: prom });
      }
    }
    return out;
  }

  function tfProfile(candles) {
    if (candles.length < 3) return { maxDistPct: 0.08, maxLvl: 4, swW: 3, maxLook: 150, minSpPct: 0.0025 };
    // Sample median diff from last 10 candles
    let med = 0;
    const end = candles.length - 1;
    const s = end > 10 ? end - 10 : 1;
    const diffs = [];
    for (let i = s; i <= end; i++) {
      const d = candles[i].t - candles[i - 1].t;
      if (d > 0) diffs.push(d);
    }
    if (diffs.length > 0) {
      diffs.sort((a, b) => a - b);
      med = diffs[diffs.length >> 1] / 60000;
    }
    if (med <= 1)   return { maxDistPct: 0.035, maxLvl: 4, swW: 3, maxLook: 120, minSpPct: 0.0015 };
    if (med <= 5)   return { maxDistPct: 0.055, maxLvl: 4, swW: 3, maxLook: 150, minSpPct: 0.0025 };
    if (med <= 15)  return { maxDistPct: 0.085, maxLvl: 5, swW: 3, maxLook: 180, minSpPct: 0.0040 };
    if (med <= 60)  return { maxDistPct: 0.120, maxLvl: 5, swW: 4, maxLook: 200, minSpPct: 0.0060 };
    if (med <= 240) return { maxDistPct: 0.180, maxLvl: 5, swW: 4, maxLook: 220, minSpPct: 0.0080 };
    return { maxDistPct: 0.250, maxLvl: 6, swW: 5, maxLook: 250, minSpPct: 0.0120 };
  }

  // ── Precomputed context (shared across all detectors in a single scan) ─────

  function buildCtx(raw) {
    const candles = normalize(raw);
    if (candles.length < 25) return null;
    const n = candles.length;
    const lastPrice = candles[n - 1].c;
    const range = atr(candles, 24);
    const prof = tfProfile(candles);
    const sw = swings(candles, prof.swW);
    const highs = [];
    const lows = [];
    for (let i = 0; i < sw.length; i++) {
      if (sw[i].type === "high") highs.push(sw[i]);
      else lows.push(sw[i]);
    }
    return { candles, n, lastPrice, range, prof, sw, highs, lows };
  }

  // ── Level cleanliness & touch tracking ─────────────────────────────────────

  function isClean(candles, level, startIdx, resistance) {
    for (let i = startIdx + 1, len = candles.length; i < len; i++) {
      const c = candles[i];
      if (resistance) {
        if (c.c > level || c.o > level || c.h > level) return false;
      } else {
        if (c.c < level || c.o < level || c.l < level) return false;
      }
    }
    return true;
  }

  function countTouches(candles, level, startIdx, resistance, range) {
    const touchTol = range * 0.15 > level * 0.0025 ? range * 0.15 : level * 0.0025;
    const minDep = range * 0.20 > level * 0.0030 ? range * 0.20 : level * 0.0030;
    const touches = [startIdx];
    let departed = false, last = startIdx;
    for (let i = startIdx + 1, len = candles.length; i < len; i++) {
      const c = candles[i];
      const dist = resistance ? (level - c.c) : (c.c - level);
      if (dist >= minDep) departed = true;
      if (departed) {
        const wick = resistance ? c.h : c.l;
        const d = wick - level; // signed
        if ((d < 0 ? -d : d) <= touchTol && i - last >= 3) {
          touches.push(i);
          last = i;
          departed = false;
        }
      }
    }
    return touches;
  }

  // ── 1. Horizontal S/R (Levels) ─────────────────────────────────────────────

  function _detectHorizontals(ctx, minTouches) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, highs, lows } = ctx;
    const clusterTol = range / lastPrice * 0.40;
    const ct = clusterTol < 0.0020 ? 0.0020 : (clusterTol > 0.0060 ? 0.0060 : clusterTol);
    const minT = minTouches > 1 ? minTouches : 2;
    const out = [];

    for (let side = 0; side < 2; side++) {
      const resistance = side === 0;
      const pts = resistance ? highs : lows;
      if (!pts || pts.length === 0) continue;
      const candidates = [];

      // Group swing points into price clusters
      const clusters = [];
      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        let best = null;
        for (let ci = 0; ci < clusters.length; ci++) {
          const cl = clusters[ci];
          const d = p.price - cl.center;
          if ((d < 0 ? -d : d) / cl.center <= ct) { best = cl; break; }
        }
        if (!best) {
          best = { center: p.price, prices: [p.price], indices: [p.idx], maxP: p.price, minP: p.price };
          clusters.push(best);
        } else {
          best.prices.push(p.price);
          best.indices.push(p.idx);
          if (p.price > best.maxP) best.maxP = p.price;
          if (p.price < best.minP) best.minP = p.price;
          best.center = (best.center * (best.prices.length - 1) + p.price) / best.prices.length;
        }
      }

      for (let ci = 0; ci < clusters.length; ci++) {
        const cl = clusters[ci];
        const lvlPrice = resistance ? cl.maxP : cl.minP;
        const sortedIndices = Array.from(new Set(cl.indices)).sort((a, b) => a - b);
        if (sortedIndices.length === 0) continue;

        const touchTol = Math.max(range * 0.06, lastPrice * 0.0006);
        const minDep = Math.max(range * 0.20, lastPrice * 0.0020);

        // The anchor must itself sit within touch tolerance of the level price.
        // Cluster membership only guarantees closeness to the drifting cluster
        // mean (up to 0.60%), not to maxP/minP, so it is validated explicitly.
        let firstIdx = -1;
        for (let ii = 0; ii < sortedIndices.length; ii++) {
          const cand = sortedIndices[ii];
          const cw = resistance ? candles[cand].h : candles[cand].l;
          if (Math.abs(cw - lvlPrice) <= touchTol) { firstIdx = cand; break; }
        }
        if (firstIdx < 0) continue;

        const pLen = pts.length;
        const distinctTouches = [firstIdx];

        for (let pi = 0; pi < pLen; pi++) {
          const s = pts[pi];
          if (s.idx <= firstIdx) continue;
          const wick = resistance ? candles[s.idx].h : candles[s.idx].l;
          const wickDiff = Math.abs(wick - lvlPrice);
          if (wickDiff <= touchTol) {
            const lastT = distinctTouches[distinctTouches.length - 1];
            if (s.idx - lastT >= 5) {
              let hadDeparture = false;
              for (let k = lastT + 1; k < s.idx; k++) {
                const dist = resistance ? (lvlPrice - candles[k].c) : (candles[k].c - lvlPrice);
                if (dist >= minDep) {
                  hadDeparture = true;
                  break;
                }
              }
              if (hadDeparture) {
                distinctTouches.push(s.idx);
              }
            }
          }
        }

        if (distinctTouches.length < minT) continue;

        const distPct = Math.abs(lvlPrice - lastPrice) / lastPrice;
        if (distPct > prof.maxDistPct) continue;

        const lastTouchIdx = distinctTouches[distinctTouches.length - 1];
        const age = n - 1 - lastTouchIdx;
        if (age > 60) continue;

        if (resistance) {
          if (lastPrice >= lvlPrice || candles[n - 1].c >= lvlPrice || candles[n - 1].h > lvlPrice) continue;
        } else {
          if (lastPrice <= lvlPrice || candles[n - 1].c <= lvlPrice || candles[n - 1].l < lvlPrice) continue;
        }

        let levelPierced = false;
        // Scan from the earliest cluster member, not just the validated anchor,
        // so a pierce between the cluster start and the anchor is still caught.
        for (let k = sortedIndices[0]; k < n; k++) {
          const c = candles[k];
          if (resistance) {
            if (c.c > lvlPrice || c.o > lvlPrice || c.h > lvlPrice) { levelPierced = true; break; }
          } else {
            if (c.c < lvlPrice || c.o < lvlPrice || c.l < lvlPrice) { levelPierced = true; break; }
          }
        }
        if (levelPierced) continue;

        const dAtr = distPct * lastPrice / range;

        candidates.push({
          price: +lvlPrice.toFixed(6),
          endPrice: +lvlPrice.toFixed(6),
          direction: resistance ? "up" : "down",
          swingIdx: firstIdx,
          swingTime: candles[firstIdx].t,
          touchIndices: distinctTouches,
          touchTimes: distinctTouches.map(ti => candles[ti].t),
          touches: distinctTouches.length,
          distPct: +(distPct * 100).toFixed(2),
          isCascade: false, age,
          strength: distinctTouches.length * 28 + (5 - (dAtr < 5 ? dAtr : 5)) * 8 + ((60 - age) > 0 ? 60 - age : 0) * 0.25,
        });
      }

      candidates.sort((a, b) => b.strength - a.strength);
      const sp = lastPrice * 0.003;
      let keptForSide = 0;
      for (let i = 0; i < candidates.length && keptForSide < 3; i++) {
        let dup = false;
        for (let k = 0; k < out.length; k++) {
          if (out[k].direction !== candidates[i].direction) continue;
          const d = out[k].price - candidates[i].price;
          if ((d < 0 ? -d : d) <= sp) { dup = true; break; }
        }
        if (!dup) { out.push(candidates[i]); keptForSide++; }
      }
    }

    return out;
  }

  // ── 2. Cascades ────────────────────────────────────────────────────────────

  function _detectCascades(ctx, minCount) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, sw } = ctx;
    const minC = minCount > 1 ? minCount : 1;
    const minStartIdx = n > prof.maxLook ? n - prof.maxLook : prof.swW;

    function isClean(candles, level, startIdx, resistance) {
      for (let i = startIdx + 1, len = candles.length; i < len; i++) {
        const c = candles[i];
        if (resistance) { if (c.c > level || c.o > level || c.h > level) return false; }
        else { if (c.c < level || c.o < level || c.l < level) return false; }
      }
      return true;
    }

    function countTouches(candles, level, startIdx, resistance, range) {
      const touchTol = range * 0.15 > level * 0.0025 ? range * 0.15 : level * 0.0025;
      const minDep = range * 0.20 > level * 0.0030 ? range * 0.20 : level * 0.0030;
      const touches = [startIdx];
      let departed = false, last = startIdx;
      for (let i = startIdx + 1, len = candles.length; i < len; i++) {
        const c = candles[i];
        const dist = resistance ? (level - c.c) : (c.c - level);
        if (dist >= minDep) departed = true;
        if (departed) {
          const wick = resistance ? c.h : c.l;
          const d = wick - level;
          if ((d < 0 ? -d : d) <= touchTol && i - last >= 3) { touches.push(i); last = i; departed = false; }
        }
      }
      return touches;
    }

    const ups = [], downs = [];
    for (let i = 0; i < sw.length; i++) {
      const s = sw[i];
      if (s.idx < minStartIdx) continue;
      if (s.type === "high") {
        if (s.price <= lastPrice * 0.999) continue;
        const dp = (s.price - lastPrice) / lastPrice;
        if (dp > prof.maxDistPct) continue;
        if (!isClean(candles, s.price, s.idx, true)) continue;
        const ti = countTouches(candles, s.price, s.idx, true, range);
        ups.push({ price: s.price, endPrice: s.price, swingIdx: s.idx, swingTime: candles[s.idx].t, direction: "up",
          touchIndices: ti, touchTimes: ti.map(t => candles[t].t), touches: ti.length, distPct: +(dp * 100).toFixed(2), age: n - 1 - s.idx });
      } else {
        if (s.price >= lastPrice * 1.001) continue;
        const dp = (lastPrice - s.price) / lastPrice;
        if (dp > prof.maxDistPct) continue;
        if (!isClean(candles, s.price, s.idx, false)) continue;
        const ti = countTouches(candles, s.price, s.idx, false, range);
        downs.push({ price: s.price, endPrice: s.price, swingIdx: s.idx, swingTime: candles[s.idx].t, direction: "down",
          touchIndices: ti, touchTimes: ti.map(t => candles[t].t), touches: ti.length, distPct: +(dp * 100).toFixed(2), age: n - 1 - s.idx });
      }
    }

    function dedup(list, isUp) {
      list.sort((a, b) => b.touches - a.touches || a.age - b.age);
      const kept = [];
      const sp = lastPrice * prof.minSpPct > range * 0.10 ? lastPrice * prof.minSpPct : (range * 0.10 < lastPrice * 0.0020 ? range * 0.10 : lastPrice * 0.0020);
      for (let i = 0; i < list.length; i++) {
        let dup = false;
        for (let k = 0; k < kept.length; k++) {
          const d = kept[k].price - list[i].price;
          if ((d < 0 ? -d : d) <= sp) { dup = true; break; }
        }
        if (!dup) kept.push(list[i]);
      }
      kept.sort((a, b) => isUp ? a.price - b.price : b.price - a.price);
      return kept;
    }

    const du = dedup(ups, true), dd = dedup(downs, false);
    const out = [];
    if (du.length >= minC) { for (let i = 0; i < du.length && i < prof.maxLvl; i++) out.push(du[i]); }
    if (dd.length >= minC) { for (let i = 0; i < dd.length && i < prof.maxLvl; i++) out.push(dd[i]); }
    return out;
  }

  // ── 3. Trendlines (Clean Unbroken Diagonal S/R Channels) ──────────────────

  function _detectTrendlines(ctx, minTouches) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, highs, lows } = ctx;
    const minimum = minTouches > 2 ? minTouches : 2;
    const slopeLimit = range * 0.12;
    const maxLookback = prof.maxLook ? prof.maxLook * 1.5 : 180;
    const maxExtX = n - 1 + 25;

    // Strict geometric rule: Lines on the SAME side (two resistances or two supports) MUST NOT cross or intersect
    function linesIntersectSameSide(l1, l2) {
      const startX = Math.min(l1.p1.idx, l2.p1.idx);
      const endX = maxExtX;
      const dSlope = l1.slope - l2.slope;
      if (Math.abs(dSlope) < 1e-9) {
        const dPrice = Math.abs(l1.endPrice - l2.endPrice) / l2.endPrice;
        return dPrice < 0.015;
      }
      const intersectX = ((l2.p1.price - l2.slope * l2.p1.idx) - (l1.p1.price - l1.slope * l1.p1.idx)) / dSlope;
      return (intersectX >= startX && intersectX <= endX);
    }

    function collect(pts, isHigh) {
      const candidates = [];
      const recent = pts.length > 90 ? pts.slice(-90) : pts;
      const pLen = recent.length;

      for (let i = 0; i < pLen - 1; i++) {
        for (let j = i + 1; j < pLen; j++) {
          const p1 = recent[i], p2 = recent[j];
          const span = p2.idx - p1.idx;
          if (span < 20) continue;
          if (n - 1 - p1.idx > maxLookback) continue;

          const slope = (p2.price - p1.price) / span;

          // Resistance (highs) MUST be descending (slope < 0, Lower Highs)
          // Support (lows) MUST be ascending (slope > 0, Higher Lows)
          if (isHigh && (slope >= 0 || slope < -slopeLimit)) continue;
          if (!isHigh && (slope <= 0 || slope > slopeLimit)) continue;

          // Reject lines that are almost flat (require at least 0.35% real price diagonal across the span)
          if (Math.abs(p1.price - p2.price) / p1.price < 0.0035) continue;
          if (Math.abs(slope * span) < range * 0.20) continue;

          const tolPrice = Math.max(range * 0.025, lastPrice * 0.0005);
          let crossed = false;
          // Check from the earliest relevant candle (p1.idx - 25) through latest candle n - 1
          const checkStart = Math.max(0, p1.idx - 25);
          for (let k = checkStart; k < n; k++) {
            const line = p1.price + slope * (k - p1.idx);
            if (!(line > 0)) { crossed = true; break; }
            const c = candles[k];
            if (isHigh) {
              if (c.c > line + tolPrice || c.o > line + tolPrice || c.h > line + tolPrice * 1.5) { crossed = true; break; }
            } else {
              if (c.c < line - tolPrice || c.o < line - tolPrice || c.l < line - tolPrice * 1.5) { crossed = true; break; }
            }
          }
          if (crossed) continue;

          // Anchor points p1 and p2 form the 2 primary structural touches
          const touches = [p1.idx, p2.idx];
          const touchTol = Math.max(range * 0.025, lastPrice * 0.0012);
          const minDep = Math.max(range * 0.06, lastPrice * 0.003);

          // Find genuine intermediate or subsequent touches with mandatory price departure
          for (let pi = 0; pi < pLen; pi++) {
            const s = recent[pi];
            if (s.idx === p1.idx || s.idx === p2.idx || s.idx < p1.idx) continue;

            const line = p1.price + slope * (s.idx - p1.idx);
            if (line <= 0) continue;
            const wick = isHigh ? candles[s.idx].h : candles[s.idx].l;
            const wickDiff = Math.abs(wick - line);
            if (wickDiff > touchTol) continue;

            // Find closest existing touches before and after s.idx
            let prevTouch = -1;
            let nextTouch = Infinity;
            for (const t of touches) {
              if (t < s.idx && t > prevTouch) prevTouch = t;
              if (t > s.idx && t < nextTouch) nextTouch = t;
            }
            if (prevTouch === -1 || s.idx - prevTouch < 6) continue;
            if (nextTouch !== Infinity && nextTouch - s.idx < 6) continue;

            // Must have departed from the line before s.idx (between prevTouch and s.idx)
            let hadDepartureBefore = false;
            for (let k = prevTouch + 1; k < s.idx; k++) {
              const lineK = p1.price + slope * (k - p1.idx);
              const dist = isHigh ? (lineK - candles[k].c) : (candles[k].c - lineK);
              if (dist >= minDep) {
                hadDepartureBefore = true;
                break;
              }
            }
            if (!hadDepartureBefore) continue;

            // If there is an existing touch after s.idx (e.g. p2), price must also depart after s.idx before nextTouch
            if (nextTouch !== Infinity) {
              let hadDepartureAfter = false;
              for (let k = s.idx + 1; k < nextTouch; k++) {
                const lineK = p1.price + slope * (k - p1.idx);
                const dist = isHigh ? (lineK - candles[k].c) : (candles[k].c - lineK);
                if (dist >= minDep) {
                  hadDepartureAfter = true;
                  break;
                }
              }
              if (!hadDepartureAfter) continue;
            }

            if (!touches.includes(s.idx)) {
              touches.push(s.idx);
              touches.sort((a, b) => a - b);
            }
          }

          touches.sort((a, b) => a - b);

          if (touches.length < minimum) continue;

          const lastTouchAge = n - 1 - touches[touches.length - 1];
          if (lastTouchAge > 90) continue;

          const endPrice = p1.price + slope * (n - 1 - p1.idx);
          if (!(endPrice > 0)) continue;

          if (isHigh) {
            if (lastPrice > endPrice * 1.002 || candles[n - 1].c > endPrice * 1.0015) continue;
          } else {
            if (lastPrice < endPrice * 0.998 || candles[n - 1].c < endPrice * 0.9985) continue;
          }

          const distPct = Math.abs(endPrice - lastPrice) / lastPrice;
          if (distPct > prof.maxDistPct) continue;

          const totalSpan = n - 1 - p1.idx;
          const p1Prom = p1.prominence || 3;
          const p2Prom = p2.prominence || 3;
          const touchCoverage = (touches[touches.length - 1] - touches[0]) / Math.max(1, totalSpan);

          // Structural strength:
          // 1. High prominence anchor (major peak/trough)
          // 2. Number of touches
          // 3. Wide span covering the active trend cycle
          // 4. Good touch distribution
          const p1Bonus = Math.min(p1Prom, 40) * 3.0;
          const p2Bonus = Math.min(p2Prom, 30) * 1.0;
          const touchScore = touches.length * 35;
          const spanScore = Math.min(totalSpan, 150) * 0.4;
          const coverageScore = touchCoverage * 25;
          const recencyScore = Math.max(0, 60 - lastTouchAge) * 0.25;
          const distPenalty = (distPct / prof.maxDistPct) * 12;

          const strength = p1Bonus + p2Bonus + touchScore + spanScore + coverageScore + recencyScore - distPenalty;

          candidates.push({
            p1: { idx: p1.idx, price: p1.price, t: candles[p1.idx].t },
            p2: { idx: p2.idx, price: p2.price, t: candles[p2.idx].t },
            slope, endPrice: +endPrice.toFixed(6),
            direction: isHigh ? "up" : "down",
            isHigh: isHigh,
            swingIndices: touches,
            touchTimes: touches.map(ti => candles[ti].t),
            touchPrices: touches.map(ti => (isHigh ? candles[ti].h : candles[ti].l)),
            touches: touches.length,
            distPct: +(distPct * 100).toFixed(2),
            isTrendline: true, span: totalSpan, lastTouchAge,
            strength
          });
        }
      }

      candidates.sort((a, b) => b.strength - a.strength);
      const kept = [];
      for (let i = 0; i < candidates.length && kept.length < 2; i++) {
        const c = candidates[i];
        let hasConflict = false;
        for (let k = 0; k < kept.length; k++) {
          if (linesIntersectSameSide(kept[k], c)) { hasConflict = true; break; }
        }
        if (!hasConflict) kept.push(c);
      }
      return kept;
    }

    const upLines = collect(highs, true);
    const downLines = collect(lows, false);

    // Cross-validate Resistance vs Support: within past candles (up to n-1), resistance must stay above support
    const validDownLines = downLines.filter(dl => {
      for (const ul of upLines) {
        if (ul.endPrice < dl.endPrice) return false;
      }
      return true;
    });

    return [...upLines, ...validDownLines];
  }

  // ── 4. Retests ─────────────────────────────────────────────────────────────

  function _detectRetests(ctx, approaching) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, sw } = ctx;
    const touchTol = range * 0.16 > lastPrice * 0.0028 ? range * 0.16 : lastPrice * 0.0028;
    const breakBuf = range * 0.07 > lastPrice * 0.0012 ? range * 0.07 : lastPrice * 0.0012;
    const holdBuf = range * 0.08 > lastPrice * 0.0014 ? range * 0.08 : lastPrice * 0.0014;
    const minDep = range * 0.22 > lastPrice * 0.0030 ? range * 0.22 : lastPrice * 0.0030;
    const candidates = [];

    for (let si = 0; si < sw.length; si++) {
      const s = sw[si];
      const bullish = s.type === "high";
      const level = s.price;
      if (n - 1 - s.idx < 6) continue;

      let breakIdx = -1;
      for (let i = s.idx + 1; i < n - 1; i++) {
        const c = candles[i];
        if (bullish ? c.c > level + breakBuf : c.c < level - breakBuf) { breakIdx = i; break; }
      }
      if (breakIdx < 0 || breakIdx - s.idx < 2) continue;

      let departed = false, departIdx = -1;
      const depEnd = breakIdx + 50 < n - 1 ? breakIdx + 50 : n - 1;
      for (let i = breakIdx; i < depEnd; i++) {
        const c = candles[i];
        if (bullish ? c.h >= level + minDep : c.l <= level - minDep) {
          departed = true; departIdx = i; break;
        }
        if (bullish ? c.c < level - holdBuf : c.c > level + holdBuf) break;
      }
      if (!departed) continue;

      if (approaching) {
        const dist = bullish ? lastPrice - level : level - lastPrice;
        if (dist > 0 && dist <= range * 0.60) {
          const distPct = (lastPrice - level) / lastPrice;
          candidates.push({
            price: level, endPrice: level, direction: bullish ? "up" : "down",
            swingIdx: s.idx, breakIdx, touches: 1,
            distPct: +((distPct < 0 ? -distPct : distPct) * 100).toFixed(2),
            isApproachingRetest: true, outcome: "approaching",
            strength: 15 - dist / range * 5 - (n - 1 - breakIdx) / 15,
          });
        }
        continue;
      }

      let touchIdx = -1, failed = false;
      for (let i = departIdx + 1; i < n; i++) {
        const c = candles[i];
        const tl = bullish ? c.l <= level + touchTol : c.h >= level - touchTol;
        const hl = bullish ? c.c >= level - holdBuf : c.c <= level + holdBuf;
        if (tl && hl) { touchIdx = i; break; }
        if (bullish ? c.c < level - holdBuf * 1.5 : c.c > level + holdBuf * 1.5) { failed = true; break; }
      }
      if (failed || touchIdx < 0) continue;

      let held = true;
      for (let i = touchIdx; i < n; i++) {
        const c = candles[i];
        if (bullish ? c.c < level - holdBuf * 1.5 : c.c > level + holdBuf * 1.5) { held = false; break; }
      }
      if (!held) continue;
      const age = n - 1 - touchIdx;
      if (age > 45) continue;
      if (bullish ? lastPrice < level - holdBuf : lastPrice > level + holdBuf) continue;

      const distPct = (lastPrice - level) / lastPrice;
      candidates.push({
        price: level, endPrice: level, direction: bullish ? "up" : "down",
        swingIdx: s.idx, swingTime: candles[s.idx].t,
        touchIdx, touchTime: candles[touchIdx].t,
        touchIndices: [s.idx, touchIdx],
        touches: 2, distPct: +((distPct < 0 ? -distPct : distPct) * 100).toFixed(2),
        isRetest: true, outcome: "confirmed", lastTouchAge: age,
        strength: 25 - age / 4 + (breakIdx - s.idx) / 8,
      });
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const sp = range * 0.15 < lastPrice * 0.0030 ? range * 0.15 : lastPrice * 0.0030;
    for (let i = 0; i < candidates.length && kept.length < 4; i++) {
      let dup = false;
      for (let k = 0; k < kept.length; k++) {
        const d = kept[k].price - candidates[i].price;
        if ((d < 0 ? -d : d) <= sp) { dup = true; break; }
      }
      if (!dup) kept.push(candidates[i]);
    }
    return kept;
  }

  // ── 5. Unified scan (one normalize + one swings pass) ──────────────────────

  function scanAll(raw, minTouches) {
    const ctx = buildCtx(raw);
    if (!ctx) return { horizontals: [], cascades: [], trendlines: [], retests: [] };
    const mt = minTouches || 2;
    return {
      horizontals: _detectHorizontals(ctx, mt),
      cascades: _detectCascades(ctx, mt),
      trendlines: _detectTrendlines(ctx, mt),
      retests: _detectRetests(ctx, false),
    };
  }

  // ── Public API (individual methods still work for backward compat) ─────────

  return {
    normalize,
    scanAll,
    detectCascades: (raw, min) => _detectCascades(buildCtx(raw), min || 2),
    detectHorizontals: (raw, min) => _detectHorizontals(buildCtx(raw), min || 2),
    detectTrendlines: (raw, min) => _detectTrendlines(buildCtx(raw), min || 2),
    detectRetests: raw => _detectRetests(buildCtx(raw), false),
    detectApproachingRetests: raw => _detectRetests(buildCtx(raw), true),
  };
});
