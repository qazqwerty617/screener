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
    const effW = n < 25 ? 1 : (n < 50 ? 2 : (w || 3));
    const start = n > 400 + effW ? n - 400 : effW;
    for (let i = start; i < n - effW; i++) {
      let high = true, low = true;
      const ih = candles[i].h, il = candles[i].l;
      for (let j = 1; j <= effW; j++) {
        if (high && (candles[i - j].h >= ih || candles[i + j].h > ih)) high = false;
        if (low && (candles[i - j].l <= il || candles[i + j].l < il)) low = false;
        if (!high && !low) break;
      }
      if (high) {
        let prom = effW;
        for (let j = effW + 1; j <= 60; j++) {
          const leftOk = (i - j < 0) || (candles[i - j].h < ih);
          const rightOk = (i + j >= n) || (candles[i + j].h <= ih);
          if (leftOk && rightOk) prom = j;
          else break;
        }
        out.push({ idx: i, price: ih, type: "high", prominence: prom });
      }
      if (low) {
        let prom = effW;
        for (let j = effW + 1; j <= 60; j++) {
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
    if (candles.length < 3) return { maxDistPct: 0.15, maxLvl: 5, swW: 2, maxLook: 150, minSpPct: 0.0025 };
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
    if (med <= 1)   return { maxDistPct: 0.06, maxLvl: 4, swW: 3, maxLook: 120, minSpPct: 0.0015 };
    if (med <= 5)   return { maxDistPct: 0.08, maxLvl: 4, swW: 3, maxLook: 150, minSpPct: 0.0025 };
    if (med <= 15)  return { maxDistPct: 0.10, maxLvl: 5, swW: 3, maxLook: 180, minSpPct: 0.0040 };
    if (med <= 60)  return { maxDistPct: 0.15, maxLvl: 5, swW: 4, maxLook: 200, minSpPct: 0.0060 };
    if (med <= 240) return { maxDistPct: 0.20, maxLvl: 5, swW: 4, maxLook: 220, minSpPct: 0.0080 };
    return { maxDistPct: 0.250, maxLvl: 6, swW: 5, maxLook: 250, minSpPct: 0.0120 };
  }

  // ── Precomputed context (shared across all detectors in a single scan) ─────

  function buildCtx(raw) {
    const candles = normalize(raw);
    if (candles.length < 10) return null;
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

  function isClean(candles, level, startIdx, resistance, tol = 0) {
    const lastPrice = candles[candles.length - 1]?.c || level;
    const eps = Math.max(1e-7, lastPrice * 0.0001);
    for (let i = startIdx + 1, len = candles.length; i < len; i++) {
      const c = candles[i];
      if (resistance) {
        if (c.h > level + eps || c.c > level) return false;
      } else {
        if (c.l < level - eps || c.c < level) return false;
      }
    }
    return true;
  }

  function countTouches(candles, level, startIdx, resistance, range) {
    const lastPrice = candles[candles.length - 1]?.c || level;
    const touchTol = Math.max(lastPrice * 0.0005, range * 0.04);
    const pullbackMin = Math.max(lastPrice * 0.0030, range * 0.35);
    const minSpacing = candles.length < 50 ? 6 : 8;

    const rawTouches = [startIdx];
    for (let i = startIdx + 1, len = candles.length; i < len; i++) {
      const c = candles[i];
      const wick = resistance ? c.h : c.l;
      if (Math.abs(wick - level) <= touchTol) {
        rawTouches.push(i);
      }
    }
    if (rawTouches.length <= 1) return rawTouches;

    const clusters = [];
    let curCluster = [];
    for (let ti = 0; ti < rawTouches.length; ti++) {
      const tIdx = rawTouches[ti];
      if (curCluster.length === 0) {
        curCluster.push(tIdx);
      } else {
        const lastInCluster = curCluster[curCluster.length - 1];
        let hadPullback = false;
        if (tIdx - lastInCluster >= minSpacing) {
          for (let pb = lastInCluster + 1; pb < tIdx; pb++) {
            if (resistance ? (level - candles[pb].h >= pullbackMin) : (candles[pb].l - level >= pullbackMin)) {
              hadPullback = true;
              break;
            }
          }
        }
        if (hadPullback) {
          clusters.push(curCluster);
          curCluster = [tIdx];
        } else {
          curCluster.push(tIdx);
        }
      }
    }
    if (curCluster.length > 0) clusters.push(curCluster);

    const touches = [];
    for (let ci = 0; ci < clusters.length; ci++) {
      const cl = clusters[ci];
      let bestIdx = cl[0];
      let bestWick = resistance ? candles[bestIdx].h : candles[bestIdx].l;
      for (let k = 1; k < cl.length; k++) {
        const idx = cl[k];
        const wick = resistance ? candles[idx].h : candles[idx].l;
        if (resistance ? wick > bestWick : wick < bestWick) {
          bestWick = wick;
          bestIdx = idx;
        }
      }
      touches.push(bestIdx);
    }
    return touches;
  }

  // ── 1. Horizontal S/R (Levels) ─────────────────────────────────────────────

  function _detectHorizontals(ctx, minTouches) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, highs, lows } = ctx;
    const touchTol = Math.max(range * 0.05, lastPrice * 0.0005);
    const eps = Math.max(1e-7, lastPrice * 0.0001);
    const minT = minTouches > 1 ? minTouches : 1;
    const maxDist = prof.maxDistPct || 0.10;
    const minSpacing = n < 50 ? 6 : 8;
    const pullbackMin = Math.max(range * 0.35, lastPrice * 0.0030);
    const out = [];

    for (let side = 0; side < 2; side++) {
      const resistance = side === 0;
      const pts = resistance ? highs : lows;
      if (!pts || pts.length === 0) continue;
      const candidates = [];

      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        const lvlPrice = p.price;
        const distPct = Math.abs(lvlPrice - lastPrice) / lastPrice;
        if (distPct > maxDist) continue;

        if (resistance) {
          if (lastPrice >= lvlPrice || candles[n - 1].c >= lvlPrice) continue;
        } else {
          if (lastPrice <= lvlPrice || candles[n - 1].c <= lvlPrice) continue;
        }

        // Collect all potential touch indices within touchTol of this swing level
        const rawTouches = [p.idx];
        for (let k = 0; k < pts.length; k++) {
          const pt = pts[k];
          if (pt.idx === p.idx) continue;
          if (Math.abs(pt.price - lvlPrice) <= touchTol) {
            rawTouches.push(pt.idx);
          }
        }
        for (let k = 0; k < n; k++) {
          if (rawTouches.includes(k)) continue;
          const wick = resistance ? candles[k].h : candles[k].l;
          if (Math.abs(wick - lvlPrice) <= touchTol) {
            rawTouches.push(k);
          }
        }
        rawTouches.sort((a, b) => a - b);

        // Cluster raw touches into distinct visits (minimum spacing + deep pullback)
        const clusters = [];
        let curCluster = [];
        for (let ti = 0; ti < rawTouches.length; ti++) {
          const tIdx = rawTouches[ti];
          if (curCluster.length === 0) {
            curCluster.push(tIdx);
          } else {
            const lastInCluster = curCluster[curCluster.length - 1];
            let hadPullback = false;
            if (tIdx - lastInCluster >= minSpacing) {
              for (let pb = lastInCluster + 1; pb < tIdx; pb++) {
                if (resistance ? (lvlPrice - candles[pb].h >= pullbackMin) : (candles[pb].l - lvlPrice >= pullbackMin)) {
                  hadPullback = true;
                  break;
                }
              }
            }
            if (hadPullback) {
              clusters.push(curCluster);
              curCluster = [tIdx];
            } else {
              curCluster.push(tIdx);
            }
          }
        }
        if (curCluster.length > 0) clusters.push(curCluster);

        // Pick best extreme touch from each cluster
        const distinctTouches = [];
        for (let ci = 0; ci < clusters.length; ci++) {
          const cl = clusters[ci];
          let bestIdx = cl[0];
          let bestWick = resistance ? candles[bestIdx].h : candles[bestIdx].l;
          for (let k = 1; k < cl.length; k++) {
            const idx = cl[k];
            const wick = resistance ? candles[idx].h : candles[idx].l;
            if (resistance ? wick > bestWick : wick < bestWick) {
              bestWick = wick;
              bestIdx = idx;
            }
          }
          distinctTouches.push(bestIdx);
        }

        if (distinctTouches.length < minT) continue;

        // Outer wick boundary for this touch cluster
        const outerPrice = resistance
          ? Math.max(...distinctTouches.map(ti => candles[ti].h))
          : Math.min(...distinctTouches.map(ti => candles[ti].l));

        const outerDistPct = Math.abs(outerPrice - lastPrice) / lastPrice;
        if (outerDistPct > maxDist) continue;

        if (resistance) {
          if (lastPrice >= outerPrice || candles[n - 1].c >= outerPrice) continue;
        } else {
          if (lastPrice <= outerPrice || candles[n - 1].c <= outerPrice) continue;
        }

        // Re-filter touches to ensure all touches are within touchTol of outerPrice
        const validTouches = distinctTouches.filter(ti => {
          const wick = resistance ? candles[ti].h : candles[ti].l;
          return Math.abs(wick - outerPrice) <= touchTol;
        });
        if (validTouches.length < minT) continue;

        // Check if level was pierced by ANY candle between first touch and n - 1
        const firstTouch = validTouches[0];
        const lastTouch = validTouches[validTouches.length - 1];
        let levelPierced = false;
        for (let k = firstTouch + 1; k < n; k++) {
          const c = candles[k];
          if (resistance) {
            if (c.h > outerPrice + eps || c.c > outerPrice) {
              levelPierced = true; break;
            }
          } else {
            if (c.l < outerPrice - eps || c.c < outerPrice) {
              levelPierced = true; break;
            }
          }
        }
        if (levelPierced) continue;

        const age = n - 1 - lastTouch;
        const proxScore = Math.max(0, 1 - (outerDistPct / maxDist)) * 50;

        candidates.push({
          price: +outerPrice.toFixed(6),
          endPrice: +outerPrice.toFixed(6),
          direction: resistance ? "up" : "down",
          swingIdx: p.idx,
          swingTime: candles[p.idx].t,
          touchIndices: validTouches,
          touchTimes: validTouches.map(ti => candles[ti].t),
          touches: validTouches.length,
          distPct: +(outerDistPct * 100).toFixed(2),
          isCascade: false, age,
          strength: validTouches.length * 30 + proxScore + Math.max(0, 50 - age * 0.2),
        });
      }

      candidates.sort((a, b) => b.strength - a.strength);
      const sp = lastPrice * 0.003;
      let keptForSide = 0;
      for (let i = 0; i < candidates.length && keptForSide < 4; i++) {
        const cand = candidates[i];
        let dupIdx = -1;
        for (let k = 0; k < out.length; k++) {
          if (out[k].direction !== cand.direction) continue;
          const d = Math.abs(out[k].price - cand.price);
          if (d <= sp) { dupIdx = k; break; }
        }
        if (dupIdx >= 0) {
          if (resistance ? cand.price > out[dupIdx].price : cand.price < out[dupIdx].price) {
            out[dupIdx] = cand;
          }
        } else {
          out.push(cand);
          keptForSide++;
        }
      }
    }

    return out;
  }

  // ── 2. Cascades ────────────────────────────────────────────────────────────

  function _detectCascades(ctx, minCount) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, sw } = ctx;
    const minC = minCount > 1 ? minCount : 1;
    const minStartIdx = n > (prof.maxLook * 2) ? n - (prof.maxLook * 2) : 0;
    const maxDist = prof.maxDistPct || 0.08;

    const ups = [], downs = [];
    for (let i = 0; i < sw.length; i++) {
      const s = sw[i];
      if (s.idx < minStartIdx) continue;
      if (s.type === "high") {
        if (s.price <= lastPrice) continue;
        const dp = (s.price - lastPrice) / lastPrice;
        if (dp > maxDist) continue;
        if (!isClean(candles, s.price, s.idx, true, 0)) continue;
        const ti = countTouches(candles, s.price, s.idx, true, range);
        if (ti.length >= minC) {
          ups.push({
            price: +s.price.toFixed(6),
            endPrice: +s.price.toFixed(6),
            swingIdx: s.idx,
            swingTime: candles[s.idx].t,
            direction: "up",
            touchIndices: ti,
            touchTimes: ti.map(t => candles[t].t),
            touches: ti.length,
            distPct: +(dp * 100).toFixed(2),
            age: n - 1 - s.idx,
            isCascade: true,
            strength: 100 + ti.length * 10 - (dp / maxDist) * 10
          });
        }
      } else {
        if (s.price >= lastPrice) continue;
        const dp = (lastPrice - s.price) / lastPrice;
        if (dp > maxDist) continue;
        if (!isClean(candles, s.price, s.idx, false, 0)) continue;
        const ti = countTouches(candles, s.price, s.idx, false, range);
        if (ti.length >= minC) {
          downs.push({
            price: +s.price.toFixed(6),
            endPrice: +s.price.toFixed(6),
            swingIdx: s.idx,
            swingTime: candles[s.idx].t,
            direction: "down",
            touchIndices: ti,
            touchTimes: ti.map(t => candles[t].t),
            touches: ti.length,
            distPct: +(dp * 100).toFixed(2),
            age: n - 1 - s.idx,
            isCascade: true,
            strength: 100 + ti.length * 10 - (dp / maxDist) * 10
          });
        }
      }
    }

    function dedup(list, isUp) {
      list.sort((a, b) => b.touches - a.touches || a.age - b.age);
      const kept = [];
      const sp = lastPrice * 0.003;
      for (let i = 0; i < list.length; i++) {
        let dup = false;
        for (let k = 0; k < kept.length; k++) {
          const d = kept[k].price - list[i].price;
          if (Math.abs(d) <= sp) { dup = true; break; }
        }
        if (!dup) kept.push(list[i]);
      }
      kept.sort((a, b) => isUp ? a.price - b.price : b.price - a.price);
      return kept;
    }

    const du = dedup(ups, true), dd = dedup(downs, false);
    const out = [];
    for (let i = 0; i < du.length && i < 4; i++) out.push(du[i]);
    for (let i = 0; i < dd.length && i < 4; i++) out.push(dd[i]);
    return out;
  }

  // ── 3. Trendlines (Clean Unbroken Diagonal S/R Channels) ──────────────────

  function _detectTrendlines(ctx, minTouches) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, highs, lows } = ctx;
    const minimum = minTouches > 1 ? minTouches : 2;
    const slopeLimit = range * 0.25;
    const maxLookback = prof.maxLook ? prof.maxLook * 2 : 300;
    const maxDist = prof.maxDistPct || 0.10;
    const touchTol = Math.max(range * 0.04, lastPrice * 0.0005);
    const eps = Math.max(1e-7, lastPrice * 0.0001);
    const pullbackMin = Math.max(range * 0.08, lastPrice * 0.0008);

    function linesIntersectSameSide(l1, l2) {
      const dSlope = l1.slope - l2.slope;
      if (Math.abs(dSlope) < 1e-9) {
        const dPrice = Math.abs(l1.endPrice - l2.endPrice) / l2.endPrice;
        return dPrice < 0.010;
      }
      const intersectX = ((l2.p1.price - l2.slope * l2.p1.idx) - (l1.p1.price - l1.slope * l1.p1.idx)) / dSlope;
      const startX = Math.min(l1.p1.idx, l2.p1.idx);
      const endX = n + 20;
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
          if (span < (n < 40 ? 3 : 6)) continue;
          if (n - 1 - p1.idx > maxLookback) continue;

          const slope = (p2.price - p1.price) / span;
          // Resistance (highs) MUST be descending (slope < 0, Lower Highs)
          // Support (lows) MUST be ascending (slope > 0, Higher Lows)
          if (isHigh && (slope >= 0 || slope < -slopeLimit)) continue;
          if (!isHigh && (slope <= 0 || slope > slopeLimit)) continue;
          if (Math.abs(p1.price - p2.price) / p1.price < 0.001) continue;

          // Check non-piercing: no candle or wick can pierce through the line
          // Also back-project by min(span, 50) bars before p1 to ensure p1 is a true swing extremum
          let crossed = false;
          const checkStart = Math.max(0, p1.idx - Math.min(span, 50));
          for (let k = checkStart; k < n; k++) {
            const line = p1.price + slope * (k - p1.idx);
            if (!(line > 0)) { crossed = true; break; }
            const c = candles[k];
            if (isHigh ? (c.h > line + eps || c.c > line) : (c.l < line - eps || c.c < line)) {
              crossed = true; break;
            }
          }
          if (crossed) continue;

          // Anchor points p1 and p2 form the 2 primary structural touches
          const touches = [p1.idx, p2.idx];

          for (let pi = 0; pi < pLen; pi++) {
            const s = recent[pi];
            if (s.idx === p1.idx || s.idx === p2.idx || s.idx < p1.idx) continue;

            const line = p1.price + slope * (s.idx - p1.idx);
            if (line <= 0) continue;
            const wick = isHigh ? candles[s.idx].h : candles[s.idx].l;
            const wickDiff = Math.abs(wick - line);
            if (wickDiff > touchTol) continue;

            // Find surrounding touches to check distance & pullback
            let prevTouch = -1;
            let nextTouch = Infinity;
            for (const t of touches) {
              if (t < s.idx && t > prevTouch) prevTouch = t;
              if (t > s.idx && t < nextTouch) nextTouch = t;
            }
            if (prevTouch !== -1 && s.idx - prevTouch < (n < 40 ? 2 : 3)) continue;
            if (nextTouch !== Infinity && nextTouch - s.idx < (n < 40 ? 2 : 3)) continue;

            // Check that price pulled back between prevTouch and s.idx
            let hadPullback = false;
            const pbStart = prevTouch !== -1 ? prevTouch + 1 : p1.idx + 1;
            for (let pb = pbStart; pb < s.idx; pb++) {
              const linePb = p1.price + slope * (pb - p1.idx);
              if (isHigh ? (linePb - candles[pb].h >= pullbackMin) : (candles[pb].l - linePb >= pullbackMin)) {
                hadPullback = true; break;
              }
            }
            if (!hadPullback) continue;

            touches.push(s.idx);
          }

          touches.sort((a, b) => a - b);
          if (touches.length < minimum) continue;

          const endPrice = p1.price + slope * (n - 1 - p1.idx);
          if (!(endPrice > 0)) continue;

          if (isHigh) {
            if (lastPrice > endPrice + eps || candles[n - 1].c > endPrice + eps || candles[n - 1].h > endPrice + eps) continue;
          } else {
            if (lastPrice < endPrice - eps || candles[n - 1].c < endPrice - eps || candles[n - 1].l < endPrice - eps) continue;
          }

          const distPct = Math.abs(endPrice - lastPrice) / lastPrice;
          if (distPct > maxDist) continue;

          const totalSpan = n - 1 - p1.idx;
          const strength = touches.length * 30 + Math.min(totalSpan, 150) * 0.3 - (distPct / maxDist) * 10;

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
            isTrendline: true, span: totalSpan,
            strength
          });
        }
      }

      candidates.sort((a, b) => b.strength - a.strength);
      const kept = [];
      for (let i = 0; i < candidates.length && kept.length < 3; i++) {
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

    // Cross-side intersection & apex resolution:
    // Prevent resistance and support trendlines from crossing through each other!
    const filteredUpLines = [...upLines];
    const filteredDownLines = [];

    for (const dl of downLines) {
      let valid = true;
      for (const ul of filteredUpLines) {
        if (ul.endPrice <= dl.endPrice) {
          valid = false;
          break;
        }
        const dSlope = ul.slope - dl.slope;
        if (Math.abs(dSlope) > 1e-9) {
          const intersectX = ((dl.p1.price - dl.slope * dl.p1.idx) - (ul.p1.price - ul.slope * ul.p1.idx)) / dSlope;
          // If they already crossed within past candles (before n - 1), drop the invalid one
          if (intersectX <= n - 1 && intersectX >= Math.max(ul.p1.idx, dl.p1.idx)) {
            valid = false;
            break;
          }
        }
      }
      if (valid) filteredDownLines.push(dl);
    }

    // For converging lines (triangle/wedge), calculate apex and clamp maxExtX
    // so neither line continues past the intersection point!
    for (const ul of filteredUpLines) {
      for (const dl of filteredDownLines) {
        const dSlope = ul.slope - dl.slope;
        if (Math.abs(dSlope) > 1e-9) {
          const intersectX = ((dl.p1.price - dl.slope * dl.p1.idx) - (ul.p1.price - ul.slope * ul.p1.idx)) / dSlope;
          if (intersectX > n - 1) {
            const apexX = Math.floor(intersectX);
            const intersectPrice = +(ul.p1.price + ul.slope * (intersectX - ul.p1.idx)).toFixed(6);
            ul.maxExtX = typeof ul.maxExtX === "number" ? Math.min(ul.maxExtX, apexX) : apexX;
            dl.maxExtX = typeof dl.maxExtX === "number" ? Math.min(dl.maxExtX, apexX) : apexX;
            ul.apex = { x: +intersectX.toFixed(2), price: intersectPrice };
            dl.apex = { x: +intersectX.toFixed(2), price: intersectPrice };
          }
        }
      }
    }

    return [...filteredUpLines, ...filteredDownLines];
  }

  // ── 4. Retests ─────────────────────────────────────────────────────────────

  function _detectRetests(ctx, approaching) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, highs, lows } = ctx;
    const touchTol = Math.max(range * 0.12, lastPrice * 0.0020);
    const breakBuf = Math.max(range * 0.06, lastPrice * 0.0010);
    const holdBuf = Math.max(range * 0.08, lastPrice * 0.0012);
    const minDep = Math.max(range * 0.22, lastPrice * 0.0030);
    const bounceMin = Math.max(range * 0.12, lastPrice * 0.0018);
    const minSpacing = n < 50 ? 5 : 8;
    const pullbackMin = Math.max(range * 0.25, lastPrice * 0.0025);
    const candidates = [];

    for (let side = 0; side < 2; side++) {
      const bullish = side === 0;
      const pts = bullish ? highs : lows;
      if (!pts || pts.length < 2) continue;

      for (let pi = 0; pi < pts.length; pi++) {
        const p = pts[pi];
        const lvlPrice = p.price;
        if (n - 1 - p.idx < 8) continue;

        // Find breakout candle breakIdx after p.idx + minSpacing
        let breakIdx = -1;
        for (let i = p.idx + minSpacing; i < n - 1; i++) {
          const c = candles[i];
          if (bullish ? c.c > lvlPrice + breakBuf : c.c < lvlPrice - breakBuf) {
            breakIdx = i;
            break;
          }
        }
        if (breakIdx < 0 || breakIdx - p.idx < minSpacing) continue;

        // Before breakout, check if price closed beyond lvlPrice (level integrity)
        let levelRespected = true;
        for (let k = p.idx; k < breakIdx; k++) {
          if (bullish ? candles[k].c > lvlPrice : candles[k].c < lvlPrice) {
            levelRespected = false;
            break;
          }
        }
        if (!levelRespected) continue;

        // In pre-breakout window [p.idx, breakIdx - 1], collect all touches within touchTol
        const rawTouches = [];
        for (let k = p.idx; k < breakIdx; k++) {
          const wick = bullish ? candles[k].h : candles[k].l;
          if (Math.abs(wick - lvlPrice) <= touchTol) {
            rawTouches.push(k);
          }
        }
        if (rawTouches.length < 2) continue;

        // Cluster raw touches: must have at least 2 distinct visits with spacing and pullback
        const clusters = [];
        let curCluster = [];
        for (let ti = 0; ti < rawTouches.length; ti++) {
          const tIdx = rawTouches[ti];
          if (curCluster.length === 0) {
            curCluster.push(tIdx);
          } else {
            const lastInCluster = curCluster[curCluster.length - 1];
            let hadPullback = false;
            if (tIdx - lastInCluster >= minSpacing) {
              for (let pb = lastInCluster + 1; pb < tIdx; pb++) {
                if (bullish ? (lvlPrice - candles[pb].h >= pullbackMin) : (candles[pb].l - lvlPrice >= pullbackMin)) {
                  hadPullback = true;
                  break;
                }
              }
            }
            if (hadPullback) {
              clusters.push(curCluster);
              curCluster = [tIdx];
            } else {
              curCluster.push(tIdx);
            }
          }
        }
        if (curCluster.length > 0) clusters.push(curCluster);
        if (clusters.length < 2) continue; // Requires at least 2 distinct touches before breakout!

        const priorTouches = [];
        for (let ci = 0; ci < clusters.length; ci++) {
          const cl = clusters[ci];
          let bestIdx = cl[0];
          let bestWick = bullish ? candles[bestIdx].h : candles[bestIdx].l;
          for (let k = 1; k < cl.length; k++) {
            const idx = cl[k];
            const wick = bullish ? candles[idx].h : candles[idx].l;
            if (bullish ? wick > bestWick : wick < bestWick) {
              bestWick = wick;
              bestIdx = idx;
            }
          }
          priorTouches.push(bestIdx);
        }

        // Refined outer level boundary
        const level = bullish
          ? Math.max(...priorTouches.map(ti => candles[ti].h))
          : Math.min(...priorTouches.map(ti => candles[ti].l));

        // Impulse departure: price must depart by minDep after breakIdx
        let departed = false, departIdx = -1;
        const depEnd = Math.min(n - 1, breakIdx + 45);
        for (let i = breakIdx; i < depEnd; i++) {
          const c = candles[i];
          if (bullish ? c.h >= level + minDep : c.l <= level - minDep) {
            departed = true;
            departIdx = i;
            break;
          }
          if (bullish ? c.c < level - holdBuf : c.c > level + holdBuf) break;
        }
        if (!departed || departIdx < 0) continue;

        if (approaching) {
          const dist = bullish ? lastPrice - level : level - lastPrice;
          if (dist > touchTol * 0.2 && dist <= range * 0.45) {
            let brokenBack = false;
            for (let i = departIdx + 1; i < n; i++) {
              if (bullish ? candles[i].c < level - holdBuf : candles[i].c > level + holdBuf) {
                brokenBack = true;
                break;
              }
            }
            if (!brokenBack) {
              const distPct = Math.abs(lastPrice - level) / lastPrice;
              candidates.push({
                price: +level.toFixed(6),
                endPrice: +level.toFixed(6),
                direction: bullish ? "up" : "down",
                levelTouches: priorTouches.length,
                swingIdx: priorTouches[0],
                swingTime: candles[priorTouches[0]].t,
                breakIdx,
                touchIndices: priorTouches,
                touchTimes: priorTouches.map(t => candles[t].t),
                touches: priorTouches.length,
                distPct: +(distPct * 100).toFixed(2),
                isApproachingRetest: true,
                outcome: "approaching",
                strength: 20 - (dist / range) * 5 + priorTouches.length * 5,
              });
            }
          }
          continue;
        }

        // Look for retest touch after departIdx
        let touchIdx = -1, failed = false;
        for (let i = departIdx + 1; i < n; i++) {
          const c = candles[i];
          const tl = bullish ? c.l <= level + touchTol : c.h >= level - touchTol;
          const hl = bullish ? c.c >= level - holdBuf : c.c <= level + holdBuf;
          const deepBreach = bullish ? c.l < level - touchTol * 1.5 : c.h > level + touchTol * 1.5;
          if (tl && hl && !deepBreach) {
            touchIdx = i;
            break;
          }
          if (bullish ? c.c < level - holdBuf * 1.5 : c.c > level + holdBuf * 1.5) {
            failed = true;
            break;
          }
        }
        if (failed || touchIdx < 0) continue;

        // Level must hold after touchIdx up to current candle
        let held = true;
        for (let i = touchIdx; i < n; i++) {
          const c = candles[i];
          if (bullish ? c.c < level - holdBuf * 1.5 : c.c > level + holdBuf * 1.5) {
            held = false;
            break;
          }
        }
        if (!held) continue;
        if (bullish ? lastPrice < level - holdBuf : lastPrice > level + holdBuf) continue;

        // Reaction / Bounce check:
        // Either rejection wick on touchCandle or candle closing away in breakout direction
        const touchCandle = candles[touchIdx];
        const touchRange = touchCandle.h - touchCandle.l + 1e-9;
        const lowerWick = touchCandle.c >= touchCandle.o ? touchCandle.o - touchCandle.l : touchCandle.c - touchCandle.l;
        const upperWick = touchCandle.c >= touchCandle.o ? touchCandle.h - touchCandle.c : touchCandle.h - touchCandle.o;
        const hasPinbarRejection = bullish
          ? (touchCandle.c >= level && lowerWick / touchRange >= 0.35)
          : (touchCandle.c <= level && upperWick / touchRange >= 0.35);

        let hasBounceCandle = false;
        const bounceCheckEnd = Math.min(n, touchIdx + 6);
        for (let k = touchIdx; k < bounceCheckEnd; k++) {
          const c = candles[k];
          if (bullish ? c.c >= level + bounceMin : c.c <= level - bounceMin) {
            hasBounceCandle = true;
            break;
          }
        }
        if (bullish ? lastPrice >= level + bounceMin * 0.8 : lastPrice <= level - bounceMin * 0.8) {
          hasBounceCandle = true;
        }

        if (!hasPinbarRejection && !hasBounceCandle) continue;

        const age = n - 1 - touchIdx;
        if (age > 45) continue;

        const distPct = Math.abs(lastPrice - level) / lastPrice;
        const allTouches = [...priorTouches, touchIdx];
        candidates.push({
          price: +level.toFixed(6),
          endPrice: +level.toFixed(6),
          direction: bullish ? "up" : "down",
          levelTouches: priorTouches.length,
          swingIdx: priorTouches[0],
          swingTime: candles[priorTouches[0]].t,
          breakIdx,
          touchIdx,
          touchTime: candles[touchIdx].t,
          touchIndices: allTouches,
          touchTimes: allTouches.map(t => candles[t].t),
          touches: allTouches.length,
          distPct: +(distPct * 100).toFixed(2),
          isRetest: true,
          outcome: "confirmed",
          lastTouchAge: age,
          strength: 35 + priorTouches.length * 10 - age / 4,
        });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const sp = Math.max(range * 0.15, lastPrice * 0.0030);
    for (let i = 0; i < candidates.length && kept.length < 4; i++) {
      let dup = false;
      for (let k = 0; k < kept.length; k++) {
        if (kept[k].direction === candidates[i].direction) {
          const d = Math.abs(kept[k].price - candidates[i].price);
          if (d <= sp) { dup = true; break; }
        }
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
