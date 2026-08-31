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
      if (high) out.push({ idx: i, price: ih, type: "high" });
      if (low) out.push({ idx: i, price: il, type: "low" });
    }
    return out;
  }

  function tfProfile(candles) {
    if (candles.length < 3) return { maxDistPct: 0.12, maxLvl: 4, swW: 3, maxLook: 250, minSpPct: 0.0025 };
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
    if (med <= 1)   return { maxDistPct: 0.06, maxLvl: 4, swW: 3, maxLook: 200, minSpPct: 0.0015 };
    if (med <= 5)   return { maxDistPct: 0.12, maxLvl: 4, swW: 3, maxLook: 250, minSpPct: 0.0025 };
    if (med <= 15)  return { maxDistPct: 0.18, maxLvl: 5, swW: 3, maxLook: 300, minSpPct: 0.0040 };
    if (med <= 60)  return { maxDistPct: 0.28, maxLvl: 5, swW: 4, maxLook: 320, minSpPct: 0.0060 };
    if (med <= 240) return { maxDistPct: 0.38, maxLvl: 5, swW: 4, maxLook: 350, minSpPct: 0.0080 };
    return { maxDistPct: 0.65, maxLvl: 6, swW: 5, maxLook: 400, minSpPct: 0.0150 };
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

  function isClean(candles, level, startIdx, resistance, closeTol, wickTol) {
    let breaches = 0;
    for (let i = startIdx + 1, len = candles.length; i < len; i++) {
      const c = candles[i];
      if (resistance) {
        if (c.c > level + closeTol) return false;
        if (c.h > level + wickTol && ++breaches > 2) return false;
      } else {
        if (c.c < level - closeTol) return false;
        if (c.l < level - wickTol && ++breaches > 2) return false;
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

  // ── 1. Horizontal S/R ──────────────────────────────────────────────────────

  // ── 1. Horizontal S/R (Levels) ─────────────────────────────────────────────

  function _detectHorizontals(ctx, minTouches) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, highs, lows } = ctx;
    const clusterTol = range / lastPrice * 0.40;
    const ct = clusterTol < 0.0020 ? 0.0020 : (clusterTol > 0.0060 ? 0.0060 : clusterTol);
    const minT = minTouches > 1 ? minTouches : 2;
    const candidates = [];

    for (let side = 0; side < 2; side++) {
      const resistance = side === 0;
      const pts = resistance ? highs : lows;
      if (!pts || pts.length === 0) continue;

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
        // Unique swing indices (at least 2 bars apart)
        const uniqueIndices = [];
        const seen = new Set();
        for (let k = 0; k < cl.indices.length; k++) {
          const idx = cl.indices[k];
          if (!seen.has(idx)) {
            seen.add(idx);
            uniqueIndices.push(idx);
          }
        }
        uniqueIndices.sort((a, b) => a - b);

        const distinctTouches = [];
        for (let k = 0; k < uniqueIndices.length; k++) {
          if (distinctTouches.length === 0 || uniqueIndices[k] - distinctTouches[distinctTouches.length - 1] >= 2) {
            distinctTouches.push(uniqueIndices[k]);
          }
        }

        if (distinctTouches.length < minT) continue;

        const lvlPrice = resistance ? cl.maxP : cl.minP;
        const distPct = (lvlPrice - lastPrice) / lastPrice;
        const absDist = distPct < 0 ? -distPct : distPct;
        if (absDist > prof.maxDistPct * 1.5) continue;

        // Level must not be completely broken through by current price
        if (resistance && lastPrice > lvlPrice * 1.005) continue;
        if (!resistance && lastPrice < lvlPrice * 0.995) continue;

        const firstIdx = distinctTouches[0];
        const lastTouchIdx = distinctTouches[distinctTouches.length - 1];
        const age = n - 1 - lastTouchIdx;
        const dAtr = absDist * lastPrice / range;

        candidates.push({
          price: +lvlPrice.toFixed(6),
          endPrice: +lvlPrice.toFixed(6),
          swingIdx: firstIdx,
          direction: resistance ? "up" : "down", // "up" = resistance above, "down" = support below
          touchIndices: distinctTouches,
          touches: distinctTouches.length,
          distPct: +(absDist * 100).toFixed(2),
          age,
          strength: distinctTouches.length * 15 - (dAtr < 5 ? dAtr : 5) * 2 - age / 40,
          isHorizontal: true,
        });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    const minSp = range * 0.12 < lastPrice * 0.0025 ? range * 0.12 : lastPrice * 0.0025;
    for (let i = 0; i < candidates.length && kept.length < 10; i++) {
      const item = candidates[i];
      let dup = false;
      for (let k = 0; k < kept.length; k++) {
        if (kept[k].direction === item.direction) {
          const d = kept[k].price - item.price;
          if ((d < 0 ? -d : d) <= minSp) { dup = true; break; }
        }
      }
      if (!dup) kept.push(item);
    }
    return kept;
  }

  // ── 2. Cascades ────────────────────────────────────────────────────────────

  function _detectCascades(ctx, minCount) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, prof, sw } = ctx;
    const closeTol = range * 0.09 < lastPrice * 0.0015 ? range * 0.09 : lastPrice * 0.0015;
    const wickTol = range * 0.22 < lastPrice * 0.0035 ? range * 0.22 : lastPrice * 0.0035;
    const minC = minCount > 1 ? minCount : 1;
    const minStartIdx = n > prof.maxLook ? n - prof.maxLook : prof.swW;

    const ups = [], downs = [];
    for (let i = 0; i < sw.length; i++) {
      const s = sw[i];
      if (s.idx < minStartIdx) continue;
      if (s.type === "high") {
        if (s.price <= lastPrice * 0.999) continue;
        const dp = (s.price - lastPrice) / lastPrice;
        if (dp > prof.maxDistPct) continue;
        if (!isClean(candles, s.price, s.idx, true, closeTol, wickTol)) continue;
        const ti = countTouches(candles, s.price, s.idx, true, range);
        ups.push({ price: s.price, endPrice: s.price, swingIdx: s.idx, direction: "up",
          touchIndices: ti, touches: ti.length, distPct: +(dp * 100).toFixed(2), age: n - 1 - s.idx });
      } else {
        if (s.price >= lastPrice * 1.001) continue;
        const dp = (lastPrice - s.price) / lastPrice;
        if (dp > prof.maxDistPct) continue;
        if (!isClean(candles, s.price, s.idx, false, closeTol, wickTol)) continue;
        const ti = countTouches(candles, s.price, s.idx, false, range);
        downs.push({ price: s.price, endPrice: s.price, swingIdx: s.idx, direction: "down",
          touchIndices: ti, touches: ti.length, distPct: +(dp * 100).toFixed(2), age: n - 1 - s.idx });
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

  // ── 3. Trendlines ─────────────────────────────────────────────────────────

  function _detectTrendlines(ctx, minTouches) {
    if (!ctx) return [];
    const { candles, n, lastPrice, range, highs, lows } = ctx;
    const touchTol = range * 0.16 > lastPrice * 0.0028 ? range * 0.16 : lastPrice * 0.0028;
    const crossBodyTol = range * 0.08 > lastPrice * 0.0014 ? range * 0.08 : lastPrice * 0.0014;
    const crossWickTol = range * 0.20 > lastPrice * 0.0032 ? range * 0.20 : lastPrice * 0.0032;
    const minimum = minTouches > 2 ? minTouches : 2;
    const slopeLimit = range * 0.15;
    const minDeparture = range * 0.18;

    function collect(pts, resistance) {
      const candidates = [];
      const recent = pts.length > 120 ? pts.slice(-120) : pts;
      const pLen = recent.length;

      for (let i = 0; i < pLen - 1; i++) {
        for (let j = i + 1; j < pLen; j++) {
          const p1 = recent[i], p2 = recent[j];
          const span = p2.idx - p1.idx;
          if (span < 8) continue;
          const slope = (p2.price - p1.price) / span;
          if (resistance && slope > slopeLimit) continue;
          if (!resistance && slope < -slopeLimit) continue;

          // Check for crossing
          let crossed = false, breaches = 0;
          for (let k = p1.idx; k < n; k++) {
            const line = p1.price + slope * (k - p1.idx);
            if (!(line > 0)) { crossed = true; break; }
            const c = candles[k];
            if (resistance) {
              if (c.c > line + crossBodyTol) { crossed = true; break; }
              if (c.h > line + crossWickTol && ++breaches > 2) { crossed = true; break; }
            } else {
              if (c.c < line - crossBodyTol) { crossed = true; break; }
              if (c.l < line - crossWickTol && ++breaches > 2) { crossed = true; break; }
            }
          }
          if (crossed) continue;

          // Count touches
          const touches = [p1.idx];
          let departed = false, lastT = p1.idx;
          for (let k = p1.idx + 1; k < n; k++) {
            const line = p1.price + slope * (k - p1.idx);
            const c = candles[k];
            const dist = resistance ? (line - c.c) : (c.c - line);
            if (dist >= minDeparture) departed = true;
            if (departed) {
              const wick = resistance ? c.h : c.l;
              const d = wick - line;
              if ((d < 0 ? -d : d) <= touchTol && k - lastT >= 3) {
                touches.push(k);
                lastT = k;
                departed = false;
              }
            }
          }
          if (touches.length < minimum) continue;

          const lastTouchAge = n - 1 - touches[touches.length - 1];
          if (lastTouchAge > 120) continue;

          const endPrice = p1.price + slope * (n - 1 - p1.idx);
          if (!(endPrice > 0)) continue;
          if (resistance ? lastPrice > endPrice + crossBodyTol : lastPrice < endPrice - crossBodyTol) continue;

          const distPct = ((endPrice - lastPrice) / lastPrice);
          const absDist = distPct < 0 ? -distPct : distPct;
          const absDatr = absDist * lastPrice / range;
          const totalSpan = n - 1 - p1.idx;

          candidates.push({
            p1: { idx: p1.idx, price: p1.price, t: candles[p1.idx].t },
            p2: { idx: p2.idx, price: p2.price, t: candles[p2.idx].t },
            slope, endPrice: +endPrice.toFixed(6),
            direction: resistance ? "up" : "down",
            swingIndices: touches,
            touches: touches.length,
            distPct: +(absDist * 100).toFixed(2),
            isTrendline: true, span: totalSpan, lastTouchAge,
            strength: touches.length * 30 + (totalSpan < 180 ? totalSpan : 180) * 0.25 +
              (5 - (absDatr < 5 ? absDatr : 5)) * 8 + ((80 - lastTouchAge) > 0 ? 80 - lastTouchAge : 0) * 0.20,
          });
        }
      }

      candidates.sort((a, b) => b.strength - a.strength);
      const kept = [];
      for (let i = 0; i < candidates.length && kept.length < 2; i++) {
        const c = candidates[i];
        let dup = false;
        for (let k = 0; k < kept.length; k++) {
          const d = kept[k].endPrice - c.endPrice;
          if ((d < 0 ? -d : d) / c.endPrice < 0.008) { dup = true; break; }
          const sd = kept[k].slope - c.slope;
          if ((sd < 0 ? -sd : sd) < 0.0001) { dup = true; break; }
        }
        if (!dup) kept.push(c);
      }
      return kept;
    }

    return [...collect(highs, true), ...collect(lows, false)];
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
