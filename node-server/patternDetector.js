"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// patternDetector.js — Price Action Pattern Detection
// Works on closed candles only. Fully deterministic, no external calls.
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  swingWindow:       3,
  levelTolerance:    0.0035,
  minTouches:        2,
  trendlineBars:     120,
  minTrendlineAngle: 0.5,
  breakoutVolMult:   1.4,
  breakoutVolBars:   20,
  retestMaxBars:     20,
  retestConfirmBars: 3,
  impulseATRMult:    2.5,
  impulseBars:       4,
  atrPeriod:         14,
  atrSmooth:         50,
  maxSignalsPerScan: 30,
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function calcATR(candles, period) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    out[i] = i < period ? tr : (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function avgVol(candles, endIdx, bars) {
  let sum = 0, count = 0;
  for (let i = Math.max(0, endIdx - bars); i < endIdx; i++) {
    sum += candles[i].v;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function linePrice(p1, p2, idx) {
  if (p2.idx === p1.idx) return p1.price;
  const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
  return p1.price + slope * (idx - p1.idx);
}

function slopeDegrees(p1, p2) {
  const dx = p2.idx - p1.idx;
  if (dx === 0) return 0;
  const dy = (p2.price - p1.price) / p1.price;
  return Math.atan2(dy * 100, dx) * (180 / Math.PI);
}

// ─── 1. Swing Point Detection ─────────────────────────────────────────────────

function detectSwings(candles, window = 3) {
  const swings = [];
  for (let i = window; i < candles.length - window; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow  = true;
    for (let j = 1; j <= window; j++) {
      if (candles[i - j].h >= c.h || candles[i + j].h > c.h) isHigh = false;
      if (candles[i - j].l <= c.l || candles[i + j].l < c.l) isLow  = false;
    }
    if (isHigh) swings.push({ idx: i, price: c.h, type: 'high', t: c.t, v: c.v });
    if (isLow)  swings.push({ idx: i, price: c.l, type: 'low',  t: c.t, v: c.v });
  }
  return swings;
}

// ─── 2. Horizontal S/R Levels ─────────────────────────────────────────────────

function detectLevels(candles, swings, cfg = DEFAULT_CONFIG) {
  const tol = cfg.levelTolerance || 0.0035;
  const minDep = tol * 1.8;
  const clusters = [];

  for (const sw of swings) {
    const found = clusters.find(cl => Math.abs(cl.price - sw.price) / cl.price <= tol);
    if (found) {
      found.swings.push(sw);
      found.lastTouch = Math.max(found.lastTouch, sw.idx);
      found.volSum += sw.v;
      found.price = found.swings.reduce((s, x) => s + x.price, 0) / found.swings.length;
    } else {
      clusters.push({
        price: sw.price,
        lastTouch: sw.idx,
        volSum: sw.v,
        swings: [sw]
      });
    }
  }

  const last = candles.length - 1;
  const result = [];

  for (const cl of clusters) {
    const sortedSwings = cl.swings.slice().sort((a, b) => a.idx - b.idx);
    const firstIdx = sortedSwings[0].idx;

    // Count distinct touches with clear price departure
    let distinctTouches = 1;
    let lastIdx = firstIdx;
    let departed = false;

    for (let i = firstIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const dist = Math.abs(c.c - cl.price) / cl.price;
      if (dist >= minDep) {
        departed = true;
      }
      if (departed && (i - lastIdx >= 4)) {
        const wickDist = Math.min(Math.abs(c.h - cl.price), Math.abs(c.l - cl.price)) / cl.price;
        if (wickDist <= tol * 1.4) {
          distinctTouches++;
          lastIdx = i;
          departed = false;
        }
      }
    }

    const minT = typeof cfg.minTouches === "number" ? cfg.minTouches : 2;
    if (distinctTouches < minT) continue;

    const zone = [cl.price * (1 - tol), cl.price * (1 + tol)];
    const recency = Math.max(0, 1 - (last - cl.lastTouch) / candles.length);
    const strength = Math.min(5, Math.round(
      (Math.min(distinctTouches, 6) / 6) * 2.5 +
      recency * 1.5 +
      (cl.volSum / sortedSwings.length > avgVol(candles, last, 50) ? 1 : 0)
    ));

    result.push({
      price: cl.price,
      zone,
      touches: distinctTouches,
      lastTouch: cl.lastTouch,
      avgVol: cl.volSum / sortedSwings.length,
      strength
    });
  }

  return result.sort((a, b) => b.strength - a.strength);
}

// ─── 3. Trendline Detection ───────────────────────────────────────────────────

function detectTrendlines(candles, swings, cfg = DEFAULT_CONFIG) {
  const bars     = cfg.trendlineBars || 120;
  const start    = Math.max(0, candles.length - bars);
  const minAngle = cfg.minTrendlineAngle || 0.5;
  const recent   = swings.filter(s => s.idx >= start);
  const lows     = recent.filter(s => s.type === 'low');
  const highs    = recent.filter(s => s.type === 'high');
  const candidateLines = [];

  function tryPair(p1, p2, type) {
    const span = p2.idx - p1.idx;
    if (span < 12) return null;
    const angle = Math.abs(slopeDegrees(p1, p2));
    if (angle < minAngle) return null;

    const tol = cfg.levelTolerance || 0.0035;
    const minDeparturePct = tol * 1.6;

    // Check piercing along the trendline: closes and wicks must stay on correct side
    for (let i = p1.idx + 1; i < candles.length; i++) {
      const lp = linePrice(p1, p2, i);
      const c = candles[i];
      if (type === 'asc'  && (c.c < lp || c.l < lp - 1e-7)) return null;
      if (type === 'desc' && (c.c > lp || c.h > lp + 1e-7)) return null;
    }

    // Anchor points p1 and p2 form 2 initial touches
    let touches = 2;
    let lastTouch = p2.idx;
    let departed = false;

    for (let i = p1.idx + 1; i < candles.length; i++) {
      const lp = linePrice(p1, p2, i);
      const c = candles[i];

      // Measure departure from line
      const dist = type === 'asc' ? (c.c - lp) / lp : (lp - c.c) / lp;
      if (dist >= minDeparturePct) {
        departed = true;
      }

      // Check discrete touch after departure (at least 4 candles away from last touch)
      const wickDist = type === 'asc' ? Math.abs(c.l - lp) / lp : Math.abs(c.h - lp) / lp;
      if (departed && i > p2.idx && (i - lastTouch >= 4) && wickDist <= 0.00025) {
        touches++;
        lastTouch = i;
        departed = false;
      }
    }

    return { type, p1, p2, touches, slope: slopeDegrees(p1, p2) };
  }

  const scanLows = lows.slice(-15);
  const scanHighs = highs.slice(-15);

  for (let i = 0; i < scanLows.length - 1; i++) {
    for (let j = i + 1; j < scanLows.length; j++) {
      if (scanLows[j].price > scanLows[i].price) {
        const line = tryPair(scanLows[i], scanLows[j], 'asc');
        if (line) candidateLines.push(line);
      }
    }
  }
  for (let i = 0; i < scanHighs.length - 1; i++) {
    for (let j = i + 1; j < scanHighs.length; j++) {
      if (scanHighs[j].price < scanHighs[i].price) {
        const line = tryPair(scanHighs[i], scanHighs[j], 'desc');
        if (line) candidateLines.push(line);
      }
    }
  }

  // Deduplicate overlapping / nearly identical trendlines
  candidateLines.sort((a, b) => {
    if (b.touches !== a.touches) return b.touches - a.touches;
    const spanA = a.p2.idx - a.p1.idx;
    const spanB = b.p2.idx - b.p1.idx;
    return spanB - spanA;
  });

  const filteredLines = [];
  for (const line of candidateLines) {
    const overlaps = filteredLines.some(existing => {
      if (existing.type !== line.type) return false;
      if (existing.p1.idx === line.p1.idx || existing.p2.idx === line.p2.idx) return true;
      const slopeDiff = Math.abs(existing.slope - line.slope);
      const p2Diff = Math.abs(existing.p2.idx - line.p2.idx);
      if (slopeDiff < 3.0 && p2Diff < 8) return true;
      return false;
    });

    if (!overlaps) {
      filteredLines.push(line);
    }
  }

  return filteredLines.slice(0, 10);
}

// ─── 4. Breakout Detection ────────────────────────────────────────────────────

function detectBreakouts(candles, levels, trendlines, cfg = DEFAULT_CONFIG) {
  const events  = [];
  const last    = candles.length - 1;
  const lookback = Math.min(cfg.retestMaxBars + 5, last);
  const avVol   = avgVol(candles, last, cfg.breakoutVolBars);

  for (let i = last - lookback; i <= last; i++) {
    const c = candles[i];
    if (!c || !candles[i - 1]) continue;
    const body_hi     = Math.max(c.o, c.c);
    const body_lo     = Math.min(c.o, c.c);
    const volConfirmed = c.v > avVol * cfg.breakoutVolMult;

    levels.forEach((lv, lvIdx) => {
      if (i - lv.lastTouch > 50) return;
      if (lv.touches > 4) return;
      const [zLo, zHi] = lv.zone;
      if (body_hi > zHi && candles[i - 1].c <= zHi) {
        events.push({ sourceType: 'level', sourceIdx: lvIdx, barIdx: i, direction: 'up', breakPrice: lv.price, volConfirmed });
      } else if (body_lo < zLo && candles[i - 1].c >= zLo) {
        events.push({ sourceType: 'level', sourceIdx: lvIdx, barIdx: i, direction: 'down', breakPrice: lv.price, volConfirmed });
      }
    });

    trendlines.forEach((tl, tlIdx) => {
      const lp  = linePrice(tl.p1, tl.p2, i);
      const lp1 = linePrice(tl.p1, tl.p2, i - 1);
      const tol = lp * cfg.levelTolerance;
      if (tl.type === 'asc'  && body_lo < lp - tol && candles[i - 1].l >= lp1 - tol) {
        events.push({ sourceType: 'trendline', sourceIdx: tlIdx, barIdx: i, direction: 'down', breakPrice: lp, volConfirmed });
      } else if (tl.type === 'desc' && body_hi > lp + tol && candles[i - 1].h <= lp1 + tol) {
        events.push({ sourceType: 'trendline', sourceIdx: tlIdx, barIdx: i, direction: 'up', breakPrice: lp, volConfirmed });
      }
    });
  }
  return events;
}

function detectRetests(candles, breakEvents, cfg = DEFAULT_CONFIG) {
  const results = [];
  const last    = candles.length - 1;
  const MIN_DEPARTURE = 0.0020; // price must travel at least 0.20% away after breakout
  const MAX_OVERSHOOT = 0.0030; // max 0.30% deep breach during retest

  for (const ev of breakEvents) {
    const searchEnd  = Math.min(last, ev.barIdx + cfg.retestMaxBars);
    const zonePrice  = ev.breakPrice;
    const zoneTol    = zonePrice * cfg.levelTolerance;

    // GLOBAL LEVEL CLEANLINESS: level cannot have more than 2 total crossovers across history before breakout
    let totalCrosses = 0;
    for (let k = 0; k < ev.barIdx; k++) {
      if ((candles[k].c < zonePrice && candles[k + 1].c > zonePrice) ||
          (candles[k].c > zonePrice && candles[k + 1].c < zonePrice)) {
        totalCrosses++;
      }
    }
    if (totalCrosses > 2) continue; // Dirty level / chop zone -> REJECT!

    // Retest MUST happen at least 3 bars after breakout (ev.barIdx + 3)
    for (let i = ev.barIdx + 3; i <= searchEnd; i++) {
      const c = candles[i];

      if (ev.direction === 'up') {
        // Breakout invalidated: any close back BELOW the level = false upward breakout
        if (c.c < zonePrice) break;

        // Check departure away from level before retest
        let maxAbove = 0;
        for (let k = ev.barIdx; k < i; k++) {
          const distAbove = (candles[k].h - zonePrice) / zonePrice;
          if (distAbove > maxAbove) maxAbove = distAbove;
        }
        if (maxAbove < MIN_DEPARTURE) continue;

        // Touch from above: price came back down to the level
        if (c.l <= zonePrice + zoneTol) {
          if (c.l < zonePrice * (1 - MAX_OVERSHOOT)) break; // Candle deep-breaches on contact

          // CRITICAL: retest candle must CLOSE above the level (= rejection/bounce confirmed)
          // If it closes below, price broke through = not a retest of support
          if (c.c < zonePrice) break;

          // Retest is INVALID if price re-breaks the level at any point after this
          let reBreak = false;
          for (let k = i + 1; k <= last; k++) {
            if (candles[k].c < zonePrice) { reBreak = true; break; }
          }
          if (!reBreak) {
            results.push({ event: ev, retestBar: i, status: 'confirmed' });
          }
          break;
        }
      } else if (ev.direction === 'down') {
        // Breakout invalidated: any close back ABOVE the level = false downward breakout (BNB/BTC case)
        if (c.c > zonePrice) break;

        // Check departure away from level before retest
        let maxBelow = 0;
        for (let k = ev.barIdx; k < i; k++) {
          const distBelow = (zonePrice - candles[k].l) / zonePrice;
          if (distBelow > maxBelow) maxBelow = distBelow;
        }
        if (maxBelow < MIN_DEPARTURE) continue;

        // Touch from below: price came back up to the level
        if (c.h >= zonePrice - zoneTol) {
          if (c.h > zonePrice * (1 + MAX_OVERSHOOT)) break; // Candle deep-breaches on contact

          // CRITICAL: retest candle must CLOSE below the level (= rejection confirmed)
          // If it closes above, price broke through = not a retest of resistance
          if (c.c > zonePrice) break;

          // Retest is INVALID if price re-breaks the level at any point after this
          let reBreak = false;
          for (let k = i + 1; k <= last; k++) {
            if (candles[k].c > zonePrice) { reBreak = true; break; }
          }
          if (!reBreak) {
            results.push({ event: ev, retestBar: i, status: 'confirmed' });
          }
          break;
        }
      }
    }
  }
  return results;
}

// ─── 6. Structure Break (BOS / CHoCH) ────────────────────────────────────────

function detectStructureBreaks(candles, swings) {
  const events  = [];
  if (swings.length < 4) return events;

  const sorted    = [...swings].sort((a, b) => a.idx - b.idx);
  const lastIdx   = candles.length - 1;
  const recentH   = sorted.filter(s => s.type === 'high').slice(-4);
  const recentL   = sorted.filter(s => s.type === 'low').slice(-4);
  if (recentH.length < 2 || recentL.length < 2) return events;

  const hhTrend = recentH[recentH.length - 1].price > recentH[recentH.length - 2].price;
  const hlTrend = recentL[recentL.length - 1].price  > recentL[recentL.length - 2].price;
  const llTrend = recentL[recentL.length - 1].price  < recentL[recentL.length - 2].price;
  const lhTrend = recentH[recentH.length - 1].price  < recentH[recentH.length - 2].price;

  const lastHigh = recentH[recentH.length - 1];
  const lastLow  = recentL[recentL.length - 1];

  if (hhTrend && hlTrend) {
    for (let i = lastHigh.idx + 1; i <= lastIdx; i++) {
      if (candles[i].c > lastHigh.price) {
        events.push({ type: 'bos', direction: 'up', barIdx: i, price: lastHigh.price }); break;
      }
    }
    for (let i = lastLow.idx + 1; i <= lastIdx; i++) {
      if (candles[i].c < lastLow.price) {
        events.push({ type: 'choch', direction: 'down', barIdx: i, price: lastLow.price }); break;
      }
    }
  }
  if (lhTrend && llTrend) {
    for (let i = lastLow.idx + 1; i <= lastIdx; i++) {
      if (candles[i].c < lastLow.price) {
        events.push({ type: 'bos', direction: 'down', barIdx: i, price: lastLow.price }); break;
      }
    }
    for (let i = lastHigh.idx + 1; i <= lastIdx; i++) {
      if (candles[i].c > lastHigh.price) {
        events.push({ type: 'choch', direction: 'up', barIdx: i, price: lastHigh.price }); break;
      }
    }
  }
  return events;
}

// ─── 7. Impulse / Knife Detection ────────────────────────────────────────────

function detectImpulses(candles, cfg = DEFAULT_CONFIG) {
  const events = [];
  const atrArr = calcATR(candles, cfg.atrPeriod);
  const last   = candles.length - 1;
  const lookback = Math.min(20, last);

  for (let i = last - lookback; i <= last - cfg.impulseBars + 1; i++) {
    let rangeHi = -Infinity, rangeLo = Infinity, volSum = 0;
    for (let j = i; j < i + cfg.impulseBars; j++) {
      rangeHi = Math.max(rangeHi, candles[j].h);
      rangeLo = Math.min(rangeLo, candles[j].l);
      volSum  += candles[j].v;
    }
    const totalRange = rangeHi - rangeLo;
    const baseATR    = atrArr[i] || 1e-9;
    const atrRatio   = totalRange / baseATR;
    if (atrRatio < cfg.impulseATRMult) continue;

    const direction = candles[i + cfg.impulseBars - 1].c > candles[i].o ? 'up' : 'down';
    const avV       = avgVol(candles, i, cfg.atrSmooth);
    const volSpike  = avV > 0 && (volSum / cfg.impulseBars) > avV * 1.5;
    events.push({ direction, barIdx: i + cfg.impulseBars - 1, range: totalRange, atrRatio, volSpike });
  }

  const deduped = [];
  for (const ev of events) {
    const overlap = deduped.find(d => Math.abs(d.barIdx - ev.barIdx) < cfg.impulseBars);
    if (!overlap) deduped.push(ev);
    else if (ev.atrRatio > overlap.atrRatio) deduped.splice(deduped.indexOf(overlap), 1, ev);
  }
  return deduped;
}

// ─── Master Scan ─────────────────────────────────────────────────────────────

const formationEngine = require("./public/js/formationEngine");

function scanCandles(meta, candles, cfgOverride = {}, precomputedFormations) {
  const cfg    = { ...DEFAULT_CONFIG, ...cfgOverride };
  if (!candles || candles.length < 30) return [];

  const signals = [];
  const now     = Date.now();
  const last    = candles.length - 1;
  const lastC   = candles[candles.length - 1];
  const { ex, sym, base, tf } = meta;
  const priceNow = lastC.c;

  const swings     = detectSwings(candles, cfg.swingWindow);
  const levels     = detectLevels(candles, swings, cfg);
  const trendlines = detectTrendlines(candles, swings, cfg);
  const breakouts  = detectBreakouts(candles, levels, trendlines, cfg);
  const structs    = detectStructureBreaks(candles, swings);
  const impulses   = detectImpulses(candles, cfg);
  // detectRetests(candles, breakouts, cfg) is intentionally NOT called here.
  // Its result was never read — retest signals come from formationEngine below —
  // yet it accounted for ~45% of this function's runtime on every scanned
  // (coin, timeframe) pair.

  // ── FormationEngine unified scan (1 normalize + 1 swings pass for all 3) ──
  try {
    const fmAll = precomputedFormations || formationEngine.scanAll(candles, 2);

    // 1. Dominant Unbroken Trendlines
    if (fmAll.trendlines) {
      for (const tl of fmAll.trendlines) {
        const endPrice = tl.endPrice;
        const isResistance = tl.direction === 'up'; // 'up' = resistance (Short); 'down' = support (Long)

        // Unviolated check: candle body must not close beyond the line
        if (isResistance && (priceNow > endPrice * 1.002 || lastC.c > endPrice * 1.0015)) continue;
        if (!isResistance && (priceNow < endPrice * 0.998 || lastC.c < endPrice * 0.9985)) continue;

        const dist = Math.abs(priceNow - endPrice) / priceNow;
        if (dist <= 0.15) {
          signals.push({
            type: 'trendline', ex, sym, base, tf,
            price: endPrice,
            direction: isResistance ? 'short' : 'long',
            confidence: Math.min(5, Math.max(2, tl.touches || 2)),
            ts: now,
            meta: {
              tlType: isResistance ? 'desc' : 'asc',
              slope: Number(tl.slope || 0),
              touches: tl.touches || 2,
              swingIndices: tl.swingIndices || [tl.p1?.idx, tl.p2?.idx],
              dist: +(dist * 100).toFixed(2),
              p1Idx: tl.p1?.idx, p1Price: tl.p1?.price,
              p2Idx: tl.p2?.idx, p2Price: tl.p2?.price,
              isHigh: isResistance
            }
          });
        }
      }
    }

    // 2. Clean Unbroken Horizontal Levels
    if (fmAll.horizontals && Array.isArray(fmAll.horizontals)) {
      for (const hl of fmAll.horizontals) {
        const isSupport = hl.direction === 'down'; // 'down' = support (Long); 'up' = resistance (Short)

        // Unviolated check: candle body must not close beyond the level
        if (!isSupport && (priceNow > hl.price * 1.002 || lastC.c > hl.price * 1.0015)) continue;
        if (isSupport && (priceNow < hl.price * 0.998 || lastC.c < hl.price * 0.9985)) continue;

        const dist = Math.abs(priceNow - hl.price) / priceNow;
        if (dist <= 0.15) {
          signals.push({
            type: 'level', ex, sym, base, tf,
            price: hl.price,
            direction: isSupport ? 'long' : 'short',
            confidence: Math.min(5, Math.max(2, hl.touches || 2)),
            ts: now,
            meta: {
              touches: hl.touches || 2,
              touchIndices: hl.touchIndices || [hl.swingIdx],
              swingIdx: hl.swingIdx,
              dist: +(dist * 100).toFixed(2),
              direction: hl.direction,
              levelType: isSupport ? 'support' : 'resistance'
            }
          });
        }
      }
    }

    // 3. Confirmed Retests
    if (fmAll.retests) {
      for (const rt of [...fmAll.retests, ...(fmAll.approachingRetests || [])]) {
        const dist = Math.abs(priceNow - rt.price) / priceNow;
        const retestAge = rt.isApproachingRetest ? 0 : Number(rt.lastTouchAge);
        // A retest is an entry event, not a historical decoration. Once price
        // has already travelled >1% from the level, or the reaction is older
        // than the largest supported user age, it cannot match any subscriber.
        if (dist > 0.01 || !Number.isFinite(retestAge) || retestAge > 35) continue;
        signals.push({
          type: 'retest', ex, sym, base, tf,
          price: Number(rt.price),
          direction: rt.direction === 'up' ? 'long' : 'short',
          confidence: 5, ts: rt.touchTime || now,
          meta: {
            status: rt.isApproachingRetest ? 'approaching' : 'confirmed', touches: rt.touches || 2,
            dist: +(dist * 100).toFixed(2),
            touchIdx: rt.touchIdx, swingIdx: rt.swingIdx,
            breakIdx: rt.breakIdx, lastTouchAge: retestAge,
            sourceType: 'level'
          }
        });
      }
    }
  } catch (_) {}

  // Breakouts
  for (const br of breakouts) {
    signals.push({
      type: 'breakout', ex, sym, base, tf, price: +br.breakPrice.toFixed(4),
      direction: br.direction === 'up' ? 'long' : 'short',
      confidence: br.volConfirmed ? 5 : 3, ts: lastC.t || now,
      meta: { sourceType: br.sourceType, volConfirmed: br.volConfirmed, barIdx: br.barIdx }
    });
  }

  // Structure breaks
  for (const sb of structs) {
    signals.push({
      type: sb.type, ex, sym, base, tf, price: +sb.price.toFixed(4),
      direction: sb.direction === 'up' ? 'long' : 'short',
      confidence: sb.type === 'choch' ? 4 : 3, ts: lastC.t || now,
      meta: { structType: sb.type }
    });
  }

  // Impulses
  for (const imp of impulses) {
    signals.push({
      type: 'impulse', ex, sym, base, tf, price: +priceNow.toFixed(4),
      direction: imp.direction === 'up' ? 'long' : 'short',
      confidence: Math.min(5, Math.round(imp.atrRatio / cfg.impulseATRMult * 2 + (imp.volSpike ? 1 : 0))),
      ts: lastC.t || now,
      meta: { atrRatio: +imp.atrRatio.toFixed(2), volSpike: imp.volSpike }
    });
  }

  return signals.slice(0, cfg.maxSignalsPerScan);
}

module.exports = {
  scanCandles, detectSwings, detectLevels, detectTrendlines,
  detectBreakouts, detectRetests, detectStructureBreaks, detectImpulses,
  DEFAULT_CONFIG
};
