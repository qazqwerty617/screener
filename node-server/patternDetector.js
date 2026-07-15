"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// patternDetector.js — Price Action Pattern Detection
// Works on closed candles only. Fully deterministic, no external calls.
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG = {
  swingWindow:       3,
  levelTolerance:    0.0015,
  minTouches:        2,
  trendlineBars:     60,
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
  return p1.price + (p2.price - p1.price) * (idx - p1.idx) / (p2.idx - p1.idx);
}

function slopeDegrees(p1, p2) {
  const rise = p2.price - p1.price;
  const run  = Math.max(1, p2.idx - p1.idx);
  return Math.atan2(rise, run) * 180 / Math.PI;
}

// ─── 1. Swing Detection ───────────────────────────────────────────────────────

function detectSwings(candles, window = 3) {
  const swings = [];
  for (let i = window; i < candles.length - window; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isHigh = false;
      if (candles[j].l <= c.l) isLow  = false;
    }
    if (isHigh) swings.push({ idx: i, price: c.h, type: 'high' });
    if (isLow)  swings.push({ idx: i, price: c.l, type: 'low'  });
  }
  return swings;
}

// ─── 2. Level Detection ───────────────────────────────────────────────────────

function detectLevels(candles, swings, cfg = DEFAULT_CONFIG) {
  const tol = cfg.levelTolerance;
  const clusters = [];

  for (const sw of swings) {
    let merged = false;
    for (const cl of clusters) {
      if (Math.abs(sw.price - cl.price) / cl.price < tol) {
        cl.price    = (cl.price * cl.touches + sw.price) / (cl.touches + 1);
        cl.touches++;
        cl.lastTouch = Math.max(cl.lastTouch, sw.idx);
        cl.volSum   += candles[sw.idx].v;
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ price: sw.price, touches: 1, lastTouch: sw.idx, volSum: candles[sw.idx].v });
    }
  }

  const last = candles.length - 1;
  return clusters
    .filter(cl => cl.touches >= cfg.minTouches)
    .map(cl => {
      const zone = [cl.price * (1 - tol), cl.price * (1 + tol)];
      const recency = Math.max(0, 1 - (last - cl.lastTouch) / candles.length);
      const strength = Math.min(5, Math.round(
        (Math.min(cl.touches, 6) / 6) * 2.5 +
        recency * 1.5 +
        (cl.volSum / cl.touches > avgVol(candles, last, 50) ? 1 : 0)
      ));
      return { price: cl.price, zone, touches: cl.touches, lastTouch: cl.lastTouch, avgVol: cl.volSum / cl.touches, strength };
    })
    .sort((a, b) => b.strength - a.strength);
}

// ─── 3. Trendline Detection ───────────────────────────────────────────────────

function detectTrendlines(candles, swings, cfg = DEFAULT_CONFIG) {
  const bars     = cfg.trendlineBars;
  const start    = Math.max(0, candles.length - bars);
  const minAngle = cfg.minTrendlineAngle;
  const recent   = swings.filter(s => s.idx >= start);
  const lows     = recent.filter(s => s.type === 'low');
  const highs    = recent.filter(s => s.type === 'high');
  const lines    = [];

  function tryPair(p1, p2, type) {
    const angle = Math.abs(slopeDegrees(p1, p2));
    if (angle < minAngle) return null;

    let touches = 2;
    for (let i = p1.idx + 1; i < p2.idx; i++) {
      const lp = linePrice(p1, p2, i);
      if (type === 'asc'  && candles[i].l < lp * (1 - cfg.levelTolerance)) return null;
      if (type === 'desc' && candles[i].h > lp * (1 + cfg.levelTolerance)) return null;
      const dist = type === 'asc'
        ? Math.abs(candles[i].l - lp) / lp
        : Math.abs(candles[i].h - lp) / lp;
      if (dist < cfg.levelTolerance * 2) touches++;
    }
    return { type, p1, p2, touches, slope: slopeDegrees(p1, p2) };
  }

  for (let i = 0; i < lows.length - 1; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      if (lows[j].price > lows[i].price) {
        const line = tryPair(lows[i], lows[j], 'asc');
        if (line) lines.push(line);
      }
    }
  }
  for (let i = 0; i < highs.length - 1; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      if (highs[j].price < highs[i].price) {
        const line = tryPair(highs[i], highs[j], 'desc');
        if (line) lines.push(line);
      }
    }
  }

  return lines.sort((a, b) => b.touches - a.touches).slice(0, 10);
}

// ─── 4. Breakout Detection ────────────────────────────────────────────────────

function detectBreakouts(candles, levels, trendlines, cfg = DEFAULT_CONFIG) {
  const events  = [];
  const last    = candles.length - 1;
  const lookback = Math.min(5, last);
  const avVol   = avgVol(candles, last, cfg.breakoutVolBars);

  for (let i = last - lookback; i <= last; i++) {
    const c = candles[i];
    if (!c || !candles[i - 1]) continue;
    const body_hi     = Math.max(c.o, c.c);
    const body_lo     = Math.min(c.o, c.c);
    const volConfirmed = c.v > avVol * cfg.breakoutVolMult;

    levels.forEach((lv, lvIdx) => {
      if (i - lv.lastTouch > 100) return;
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

// ─── 5. Retest Detection ─────────────────────────────────────────────────────

function detectRetests(candles, breakEvents, cfg = DEFAULT_CONFIG) {
  const results = [];
  const last    = candles.length - 1;

  for (const ev of breakEvents) {
    const searchEnd  = Math.min(last, ev.barIdx + cfg.retestMaxBars);
    const zonePrice  = ev.breakPrice;
    const zoneTol    = zonePrice * cfg.levelTolerance;

    for (let i = ev.barIdx + 1; i <= searchEnd; i++) {
      const c = candles[i];
      if (c.l > zonePrice + zoneTol || c.h < zonePrice - zoneTol) continue;

      let confirmed = false, failed = false;
      const confirmEnd = Math.min(last, i + cfg.retestConfirmBars);
      for (let k = i + 1; k <= confirmEnd; k++) {
        if (ev.direction === 'up'   && candles[k].c > zonePrice + zoneTol) { confirmed = true; break; }
        if (ev.direction === 'down' && candles[k].c < zonePrice - zoneTol) { confirmed = true; break; }
        if (ev.direction === 'up'   && candles[k].c < zonePrice - zoneTol) { failed    = true; break; }
        if (ev.direction === 'down' && candles[k].c > zonePrice + zoneTol) { failed    = true; break; }
      }

      if (confirmed || failed) {
        results.push({ event: ev, retestBar: i, status: confirmed ? 'confirmed' : 'failed' });
        break;
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

function scanCandles(meta, candles, cfgOverride = {}) {
  const cfg    = { ...DEFAULT_CONFIG, ...cfgOverride };
  if (candles.length < 30) return [];

  const signals = [];
  const now     = Date.now();
  const lastC   = candles[candles.length - 1];
  const { ex, sym, base, tf } = meta;
  const priceNow = lastC.c;

  const swings     = detectSwings(candles, cfg.swingWindow);
  const levels     = detectLevels(candles, swings, cfg);
  const trendlines = detectTrendlines(candles, swings, cfg);
  const breakouts  = detectBreakouts(candles, levels, trendlines, cfg);
  const retests    = detectRetests(candles, breakouts, cfg);
  const structs    = detectStructureBreaks(candles, swings);
  const impulses   = detectImpulses(candles, cfg);

  // Levels near price
  for (const lv of levels.slice(0, 10)) {
    const dist = Math.abs(priceNow - lv.price) / priceNow;
    if (dist > 0.05) continue;
    signals.push({
      type: 'level', ex, sym, base, tf, price: lv.price,
      direction: priceNow >= lv.price ? 'long' : 'short',
      confidence: lv.strength, ts: now,
      meta: { touches: lv.touches, zone: lv.zone, dist: +(dist * 100).toFixed(2) }
    });
  }

  // Active trendlines near price
  for (const tl of trendlines.slice(0, 5)) {
    const tlPrice = linePrice(tl.p1, tl.p2, candles.length - 1);
    const dist    = Math.abs(priceNow - tlPrice) / priceNow;
    if (dist > 0.04) continue;
    signals.push({
      type: 'trendline', ex, sym, base, tf, price: +tlPrice.toFixed(4),
      direction: tl.type === 'asc' ? 'long' : 'short',
      confidence: Math.min(5, Math.round(tl.touches / 2 + 1)), ts: now,
      meta: {
        tlType: tl.type,
        slope: +tl.slope.toFixed(2),
        touches: tl.touches,
        dist: +(dist * 100).toFixed(2),
        p1Idx: tl.p1.idx,
        p1Price: tl.p1.price,
        p2Idx: tl.p2.idx,
        p2Price: tl.p2.price
      }
    });
  }

  // Breakouts
  for (const br of breakouts) {
    signals.push({
      type: 'breakout', ex, sym, base, tf, price: +br.breakPrice.toFixed(4),
      direction: br.direction === 'up' ? 'long' : 'short',
      confidence: br.volConfirmed ? 5 : 3, ts: lastC.t || now,
      meta: { sourceType: br.sourceType, volConfirmed: br.volConfirmed }
    });
  }

  // Retests
  for (const rt of retests) {
    signals.push({
      type: 'retest', ex, sym, base, tf, price: +rt.event.breakPrice.toFixed(4),
      direction: rt.event.direction === 'up' ? 'long' : 'short',
      confidence: rt.status === 'confirmed' ? 5 : 2, ts: lastC.t || now,
      meta: { status: rt.status, sourceType: rt.event.sourceType }
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
