"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// Density Engine v5 — detection geometry.
//
// The v4 engine expressed its cluster window and lifecycle tolerances as
// percentages of price while venues quote on absolute tick grids. One 0.06%
// window held 600 levels on BTC and 7 on a $0.012 coin, so `dominance`, the
// robust sigma and the identity tolerance all meant something different on every
// instrument. Measured against live books, 36 of 45 Binance symbols produced zero
// candidates — including BTC, ETH, SOL and DOGE — while the handful that fired
// were near-random micro-caps.
//
// These tests pin the property that fixes it: the detector must behave
// identically across five orders of magnitude of price.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeBook,
  extractClusters,
  estimateTickSize,
  localBaseline,
  significanceOf,
} = require("../wallScanner");

// ── Book builders ────────────────────────────────────────────────────────────

/** Deterministic noise so the suite never flakes. */
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/**
 * A flat ladder: `levels` price steps of `tick`, each holding roughly `baseUsd`.
 * This is an ordinary book — it must produce no densities at all.
 */
function ladder(opts) {
  const { mid, tick, levels, baseUsd, jitter = 0.3, seed = 7, walls = [], skip = 0 } = opts;
  const rand = rng(seed);
  const bids = [];
  const asks = [];
  for (let i = 1; i <= levels; i++) {
    // `skip` leaves empty grid slots so the tick estimator has to cope with gaps.
    if (skip > 0 && i % (skip + 1) === 0) continue;
    const bp = round(mid - i * tick, tick);
    const ap = round(mid + i * tick, tick);
    const bu = baseUsd * (1 + (rand() - 0.5) * jitter * 2);
    const au = baseUsd * (1 + (rand() - 0.5) * jitter * 2);
    bids.push({ price: bp, qty: bu / bp, usd: bu });
    asks.push({ price: ap, qty: au / ap, usd: au });
  }
  for (const w of walls) {
    const list = w.side === "ask" ? asks : bids;
    // Spread the wall over `span` adjacent levels (1 = a single large order).
    const span = Math.max(1, w.span || 1);
    const idx = nearestIndex(list, w.price);
    if (idx < 0) continue;
    const per = w.usd / span;
    for (let k = 0; k < span; k++) {
      const target = list[idx + (w.side === "ask" ? k : -k)];
      if (!target) break;
      target.usd += per;
      target.qty = target.usd / target.price;
    }
  }
  bids.sort((a, b) => a.price - b.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks };
}

function round(v, tick) {
  // Snap to the grid so floating point never invents sub-tick gaps.
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)) + 2);
  return +v.toFixed(Math.min(12, decimals));
}

function nearestIndex(list, price) {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i].price - price);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Five instruments spanning 7 orders of magnitude of price. */
const SCALES = [
  { name: "BTC",   mid: 100000,  tick: 0.1,      levels: 900, baseUsd: 20000 },
  { name: "ETH",   mid: 3500,    tick: 0.01,     levels: 600, baseUsd: 8000 },
  { name: "SOL",   mid: 200,     tick: 0.01,     levels: 400, baseUsd: 4000 },
  { name: "DOGE",  mid: 0.4,     tick: 0.00001,  levels: 400, baseUsd: 2000 },
  { name: "MICRO", mid: 0.012,   tick: 0.000001, levels: 300, baseUsd: 800 },
];

function coinFor(scale, over = {}) {
  return {
    sym: `${scale.name}USDT`,
    base: scale.name,
    p: scale.mid,
    // Chosen so a wall of ~40x the base level size clears MIN_VOL_MINUTES on
    // every scale: vpm = v/1440, and the wall is baseUsd*40.
    v: scale.baseUsd * 40 * 1440 / 6,
    cs: 1,
    ...over,
  };
}

const asideBids = (a) => a.candidates.filter(c => c.side === "bid");

// ── Tick estimation ──────────────────────────────────────────────────────────

test("tick size is recovered on every price scale", () => {
  for (const s of SCALES) {
    const { bids } = ladder({ ...s });
    const tick = estimateTickSize(bids);
    assert.ok(Math.abs(tick - s.tick) / s.tick < 0.01,
      `${s.name}: estimated ${tick}, real ${s.tick}`);
  }
});

test("tick size survives a sparse book with empty grid slots", () => {
  // The median gap on a book with every 3rd level missing is 1.5 ticks; the 10th
  // percentile still lands on the real increment.
  for (const s of SCALES) {
    const { bids } = ladder({ ...s, skip: 2 });
    const tick = estimateTickSize(bids);
    assert.ok(Math.abs(tick - s.tick) / s.tick < 0.01,
      `${s.name}: estimated ${tick} from a sparse book, real ${s.tick}`);
  }
});

test("tick estimation is defensive about degenerate input", () => {
  assert.equal(estimateTickSize([]), 0);
  assert.equal(estimateTickSize(null), 0);
  assert.equal(estimateTickSize([{ price: 1, usd: 1 }]), 0);
  // All levels at one price: no positive gap exists.
  assert.equal(estimateTickSize([{ price: 5, usd: 1 }, { price: 5, usd: 1 }, { price: 5, usd: 1 }]), 0);
});

// ── Local baseline ───────────────────────────────────────────────────────────

test("the baseline tracks a book that thickens toward the touch", () => {
  // A single global figure would over-state the thin far side and under-state the
  // thick near side, which is why the baseline is segmented.
  const levels = [];
  for (let i = 0; i < 200; i++) {
    levels.push({ price: 100 + i * 0.01, qty: 1, usd: 1000 + i * 100 });
  }
  const base = localBaseline(levels);
  assert.ok(base.mean[10] < base.mean[190], "baseline must rise with the book");
  assert.ok(base.mean[0] >= 1000 && base.mean[0] <= 1000 + 199 * 100);
  // Segment bookkeeping must be internally consistent: the per-level mean is the
  // segment total over the segment count.
  for (const i of [0, 50, 120, 199]) {
    assert.ok(Math.abs(base.mean[i] - base.total[i] / base.count[i]) < 1e-6,
      `level ${i}: mean does not match total/count`);
    assert.ok(base.count[i] >= 16, `segment at ${i} is too small: ${base.count[i]}`);
  }
});

test("baseline segments are a fixed level count, not a fraction of the book", () => {
  // This is what keeps the required wall multiple independent of venue depth.
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ price: 100 + i * 0.01, qty: 1, usd: 5000 }));
  const shallow = localBaseline(mk(100));
  const deep = localBaseline(mk(500));
  assert.equal(shallow.count[0], deep.count[0],
    `segment size must not depend on book depth: ${shallow.count[0]} vs ${deep.count[0]}`);
});

test("a short trailing segment is folded into its neighbour", () => {
  // A 6-level remainder would be its own "normal", so a wall landing in it would
  // become its own baseline and vanish.
  const levels = Array.from({ length: 46 }, (_, i) => ({ price: 100 + i * 0.01, qty: 1, usd: 5000 }));
  const base = localBaseline(levels);
  const ids = new Set(Array.from(base.segment));
  assert.equal(ids.size, 1, `46 levels must be one segment, got ${ids.size}`);
  assert.equal(base.count[45], 46);
});

test("dust levels never produce a zero baseline", () => {
  // A zero expected size would make every neighbouring level infinitely dominant.
  const levels = [];
  for (let i = 0; i < 60; i++) levels.push({ price: 100 + i * 0.01, qty: 1, usd: 0 });
  for (let i = 60; i < 120; i++) levels.push({ price: 100 + i * 0.01, qty: 1, usd: 5000 });
  const base = localBaseline(levels);
  for (let i = 0; i < levels.length; i++) {
    assert.ok(Number.isFinite(base.mean[i]), `baseline[${i}] must be finite`);
    assert.ok(base.mean[i] >= 0, `baseline[${i}] must not be negative`);
  }
  // And an all-zero segment cannot seed a cluster.
  const clusters = extractClusters(levels, 0.01, "bid", 1.2);
  for (const c of clusters) {
    assert.ok(c.usd > 0, "a cluster of dust must never be emitted");
  }
});

// ── Detection: the core scale-invariance property ─────────────────────────────

test("a flat book produces no densities on any price scale", () => {
  for (const s of SCALES) {
    const book = ladder({ ...s });
    const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
    assert.ok(a, `${s.name}: analysis must be produced`);
    assert.equal(a.candidates.length, 0,
      `${s.name}: a flat ladder must not produce densities, got ${a.candidates.length}`);
  }
});

test("a real wall is detected on every price scale", () => {
  // Identical shape everywhere: one order 40x the local level size, half way
  // down the visible band. v4 found this on none of the five.
  for (const s of SCALES) {
    const wallPrice = round(s.mid - Math.round(s.levels * 0.4) * s.tick, s.tick);
    const wallUsd = s.baseUsd * 40;
    const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: wallUsd }] });
    const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
    const found = asideBids(a);
    assert.ok(found.length >= 1, `${s.name}: the wall must be detected`);
    const top = found.reduce((b, c) => (c.S > b.S ? c : b), found[0]);
    assert.ok(Math.abs(top.price - wallPrice) / wallPrice < 0.002,
      `${s.name}: wall price off — got ${top.price}, expected ${wallPrice}`);
    assert.ok(top.dominance >= 6, `${s.name}: dominance ${top.dominance} below the gate`);
  }
});

test("the same wall shape scores comparably across price scales", () => {
  // This is the property v4 lacked: the significance of an identical wall varied
  // from "not detected" to 0.57 purely because of the instrument's price.
  const scores = [];
  for (const s of SCALES) {
    const wallPrice = round(s.mid - Math.round(s.levels * 0.4) * s.tick, s.tick);
    const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * 40 }] });
    const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
    const found = asideBids(a);
    assert.ok(found.length >= 1, `${s.name}: wall must be found`);
    const top = found.reduce((b, c) => (c.S > b.S ? c : b), found[0]);
    scores.push({ name: s.name, sig: top.significance, dom: top.dominance });
  }
  const sigs = scores.map(x => x.sig);
  const spread = Math.max(...sigs) / Math.min(...sigs);
  assert.ok(spread < 1.6,
    `significance must not depend on price scale, spread ${spread.toFixed(2)}x: ` +
    scores.map(x => `${x.name}=${x.sig}`).join(" "));
});

test("detection count does not explode or collapse with price scale", () => {
  // Three walls in, three walls out — on every instrument.
  for (const s of SCALES) {
    const prices = [0.25, 0.5, 0.75].map(f => round(s.mid - Math.round(s.levels * f) * s.tick, s.tick));
    const book = ladder({
      ...s,
      walls: prices.map(p => ({ side: "bid", price: p, usd: s.baseUsd * 40 })),
    });
    const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
    const found = asideBids(a);
    assert.equal(found.length, 3,
      `${s.name}: expected exactly 3 densities, got ${found.length} at ` +
      found.map(c => c.price).join(", "));
  }
});

// ── Clustering behaviour ─────────────────────────────────────────────────────

test("a stacked shelf is one density with the correct total", () => {
  const s = SCALES[2]; // SOL-like
  const wallPrice = round(s.mid - 150 * s.tick, s.tick);
  const total = s.baseUsd * 60;
  const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: total, span: 4 }] });
  const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
  const found = asideBids(a);
  assert.equal(found.length, 1, `a 4-level shelf must be one wall, got ${found.length}`);
  assert.ok(found[0].count >= 3, `must span the shelf, got ${found[0].count} levels`);
  // Total within 10% of the injected size plus the ladder underneath it.
  assert.ok(found[0].S > total * 0.9, `total ${found[0].S} lost the shelf`);
});

test("two walls far apart stay two walls", () => {
  const s = SCALES[2];
  const p1 = round(s.mid - 100 * s.tick, s.tick);
  const p2 = round(s.mid - 300 * s.tick, s.tick);
  const book = ladder({ ...s, walls: [
    { side: "bid", price: p1, usd: s.baseUsd * 40 },
    { side: "bid", price: p2, usd: s.baseUsd * 50 },
  ] });
  const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
  const found = asideBids(a).sort((x, y) => y.price - x.price);
  assert.equal(found.length, 2);
  assert.ok(Math.abs(found[0].price - p1) / p1 < 0.002);
  assert.ok(Math.abs(found[1].price - p2) / p2 < 0.002);
});

test("clusters never double count a level", () => {
  const s = SCALES[2];
  const book = ladder({ ...s, walls: [
    { side: "bid", price: round(s.mid - 100 * s.tick, s.tick), usd: s.baseUsd * 40 },
    { side: "bid", price: round(s.mid - 104 * s.tick, s.tick), usd: s.baseUsd * 40 },
  ] });
  const bandBids = book.bids.filter(l => l.price < s.mid);
  const clusters = extractClusters(bandBids, s.tick, "bid", s.levels * s.tick);
  const claimedUsd = clusters.reduce((sum, c) => sum + c.usd, 0);
  const bookUsd = bandBids.reduce((sum, l) => sum + l.usd, 0);
  assert.ok(claimedUsd <= bookUsd + 1,
    `clusters claim ${claimedUsd} of a ${bookUsd} book — levels counted twice`);
});

test("one density cannot swallow the whole visible band", () => {
  // A monotonically thickening book has no wall in it; without the span cap the
  // grow phase would run from one end to the other and report it as one density.
  const levels = [];
  for (let i = 0; i < 400; i++) {
    levels.push({ price: 100 - (400 - i) * 0.01, qty: 1, usd: 500 * Math.pow(1.012, i) });
  }
  const bandSpan = levels[levels.length - 1].price - levels[0].price;
  const clusters = extractClusters(levels, 0.01, "bid", bandSpan);
  for (const c of clusters) {
    const span = c.hiPrice - c.loPrice;
    assert.ok(span <= bandSpan * 0.23,
      `cluster spans ${(span / bandSpan * 100).toFixed(0)}% of the band`);
  }
});

test("extractClusters is defensive about degenerate input", () => {
  assert.deepEqual(extractClusters([], 0.01, "bid", 1), []);
  assert.deepEqual(extractClusters(null, 0.01, "bid", 1), []);
  // Below the minimum level count.
  assert.deepEqual(extractClusters([{ price: 1, qty: 1, usd: 1 }], 0.01, "bid", 1), []);
  // No usable tick: every level at the same price.
  const same = Array.from({ length: 20 }, () => ({ price: 5, qty: 1, usd: 100 }));
  assert.deepEqual(extractClusters(same, 0, "bid", 1), []);
});

// ── Gates ────────────────────────────────────────────────────────────────────

test("a wall must be material relative to the coin's traded flow", () => {
  const s = SCALES[2];
  const wallPrice = round(s.mid - 150 * s.tick, s.tick);
  const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * 40 }] });

  // Same book, same wall. On a quiet coin it is minutes of flow; on a
  // hyper-liquid one it is seconds and must not be published.
  const quiet = analyzeBook({ ex: "BN", coin: coinFor(s, { v: 5_000_000 }), ...book });
  const busy = analyzeBook({ ex: "BN", coin: coinFor(s, { v: 20_000_000_000 }), ...book });

  assert.ok(asideBids(quiet).length >= 1, "the wall matters on a quiet coin");
  assert.equal(asideBids(busy).length, 0, "the same wall is noise on a $20B coin");
});

test("volMinutes is inversely proportional to traded volume", () => {
  const s = SCALES[2];
  const wallPrice = round(s.mid - 150 * s.tick, s.tick);
  const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * 80 }] });
  const a = analyzeBook({ ex: "BN", coin: coinFor(s, { v: 10_000_000 }), ...book });
  const b = analyzeBook({ ex: "BN", coin: coinFor(s, { v: 100_000_000 }), ...book });
  const ta = asideBids(a)[0];
  const tb = asideBids(b)[0];
  assert.ok(ta && tb, "both must detect the wall");
  assert.ok(ta.volMinutes > tb.volMinutes * 8,
    `${ta.volMinutes} vs ${tb.volMinutes} — 10x the volume must mean ~10x fewer minutes`);
});

test("dominance measures resting size against its own neighbourhood", () => {
  const s = SCALES[2];
  const wallPrice = round(s.mid - 150 * s.tick, s.tick);
  // A quiet coin, so `volMinutes` is never the binding gate and this test
  // measures dominance alone.
  const quiet = { v: 2_500_000 };

  // The cluster's own levels are excluded from the baseline it is measured
  // against, so a level holding `m` times the normal size reports ~`m`. (Not
  // exactly: the ladder has jitter, and the seed level already held one normal
  // unit before the wall was added.)
  let previous = 0;
  for (const mult of [16, 20, 40, 80]) {
    const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * mult }] });
    const a = analyzeBook({ ex: "BN", coin: coinFor(s, quiet), ...book });
    const top = asideBids(a)[0];
    assert.ok(top, `${mult}x wall must be detected`);
    assert.ok(top.dominance > previous, `dominance must rise with wall size at ${mult}x`);
    previous = top.dominance;
    const want = mult + 1;
    assert.ok(Math.abs(top.dominance - want) < want * 0.35,
      `${mult}x wall: dominance ${top.dominance.toFixed(1)}, expected ~${want}`);
  }
});

test("dominance does not depend on how deep the venue is", () => {
  // The whole point of a fixed-size baseline segment. With a fractional segment
  // count the same wall scored 21x on a shallow book and 7.6x on a deep one.
  const s = SCALES[1];
  const wallPrice = round(s.mid - 120 * s.tick, s.tick);
  const full = ladder({ ...s, levels: 600, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * 40 }] });

  const doms = [];
  for (const depth of [200, 400, 600]) {
    const a = analyzeBook({
      ex: "BN", coin: coinFor(s, { v: 2_500_000 }),
      bids: full.bids.slice(-depth),
      asks: full.asks.slice(0, depth),
    });
    const top = asideBids(a).reduce((b, c) => (!b || c.S > b.S ? c : b), null);
    assert.ok(top, `depth=${depth}: the wall must be found`);
    doms.push(top.dominance);
  }
  assert.ok(Math.max(...doms) / Math.min(...doms) < 1.3,
    `dominance must not move with depth: ${doms.map(d => d.toFixed(1)).join(" ")}`);
});

test("a multi-level shelf is not penalised for its width", () => {
  // With an inclusive baseline a k-level cluster was mathematically capped at
  // segmentLevels/k, so a 4-level shelf could never exceed 10x and an 8x gate
  // rejected a genuine $800k shelf outright.
  const s = SCALES[2];
  const wallPrice = round(s.mid - 150 * s.tick, s.tick);
  const total = s.baseUsd * 64;

  const single = analyzeBook({
    ex: "BN", coin: coinFor(s, { v: 2_500_000 }),
    ...ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: total, span: 1 }] }),
  });
  const shelf = analyzeBook({
    ex: "BN", coin: coinFor(s, { v: 2_500_000 }),
    ...ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: total, span: 4 }] }),
  });

  const a = asideBids(single)[0];
  const b = asideBids(shelf)[0];
  assert.ok(a, "the single-level wall must be detected");
  assert.ok(b, "the 4-level shelf of the same total must also be detected");
  assert.ok(b.count >= 3, `the shelf must span its levels, got ${b.count}`);
  // Same dollars spread over 4 levels: dominance per level is ~1/4, but it must
  // still be comfortably above the gate rather than mathematically capped out.
  assert.ok(b.dominance >= 10, `shelf dominance ${b.dominance.toFixed(1)} must clear the gate`);
});

test("a wall just below the dominance gate is rejected", () => {
  const s = SCALES[2];
  const wallPrice = round(s.mid - 150 * s.tick, s.tick);
  // 3x local size: unusual but not a wall.
  const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * 3 }] });
  const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
  assert.equal(asideBids(a).length, 0, "3x local liquidity is not a density");
});

// ── Scoring ──────────────────────────────────────────────────────────────────

test("significance is reachable — no multiplicative ceiling", () => {
  // v4 multiplied by proximity*sample*granularity, capping the maximum at 0.60 on
  // books with under 12 clusters — below its own 0.40 gate for every realistic
  // signal combination. A strong wall must be able to score high.
  const strong = significanceOf({
    dominance: 60, volMinutes: 60, depthShare: 0.3, peakShare: 0.9,
    distPct: 0.2, aggregated: false,
  });
  assert.ok(strong > 0.85, `a maximal wall must score high, got ${strong}`);

  // And a realistic mid-strength wall must clear the publication gate.
  const realistic = significanceOf({
    dominance: 12, volMinutes: 5, depthShare: 0.10, peakShare: 0.6,
    distPct: 0.5, aggregated: false,
  });
  assert.ok(realistic >= 0.34,
    `a 12x / 5-minute wall must be publishable, got ${realistic}`);
});

test("significance rises monotonically with each signal", () => {
  const base = { dominance: 12, volMinutes: 5, depthShare: 0.1, peakShare: 0.5, distPct: 1, aggregated: false };
  const up = (over) => significanceOf({ ...base, ...over });
  assert.ok(up({ dominance: 40 }) > up({}), "dominance");
  assert.ok(up({ volMinutes: 40 }) > up({}), "volMinutes");
  assert.ok(up({ depthShare: 0.3 }) > up({}), "depthShare");
  assert.ok(up({ peakShare: 1 }) > up({}), "peakShare");
  assert.ok(up({ distPct: 0.1 }) > up({}), "proximity");
});

test("significance stays inside 0..1 for absurd input", () => {
  const huge = significanceOf({ dominance: 1e9, volMinutes: 1e9, depthShare: 50, peakShare: 9, distPct: -5, aggregated: false });
  assert.ok(huge >= 0 && huge <= 1, `got ${huge}`);
  const nothing = significanceOf({ dominance: 0, volMinutes: 0, depthShare: 0, peakShare: 0, distPct: 99, aggregated: false });
  assert.ok(nothing >= 0 && nothing <= 1, `got ${nothing}`);
  const junk = significanceOf({});
  assert.ok(Number.isFinite(junk) && junk >= 0 && junk <= 1, `got ${junk}`);
});

test("one concentrated order outranks the same dollars smeared thin", () => {
  const concentrated = significanceOf({ dominance: 20, volMinutes: 8, depthShare: 0.12, peakShare: 0.95, distPct: 0.5, aggregated: false });
  const smeared = significanceOf({ dominance: 20, volMinutes: 8, depthShare: 0.12, peakShare: 0.15, distPct: 0.5, aggregated: false });
  assert.ok(concentrated > smeared, `${concentrated} vs ${smeared}`);
});

test("an aggregated venue is discounted but not disqualified", () => {
  const parts = { dominance: 20, volMinutes: 8, depthShare: 0.12, peakShare: 0.9, distPct: 0.5 };
  const sharp = significanceOf({ ...parts, aggregated: false });
  const merged = significanceOf({ ...parts, aggregated: true });
  assert.ok(merged < sharp, "pre-merged levels cannot prove concentration");
  assert.ok(merged > sharp * 0.6, "the discount must be modest, not fatal");
});

test("a closer density outranks an identical distant one", () => {
  const near = significanceOf({ dominance: 20, volMinutes: 8, depthShare: 0.12, peakShare: 0.7, distPct: 0.3, aggregated: false });
  const far = significanceOf({ dominance: 20, volMinutes: 8, depthShare: 0.12, peakShare: 0.7, distPct: 4.6, aggregated: false });
  assert.ok(near > far);
});

// ── Book-level plumbing that must not regress ────────────────────────────────

test("mid comes from the book, and a stale book is rejected", () => {
  const s = SCALES[2];
  const book = ladder({ ...s });
  const ok = analyzeBook({ ex: "BN", coin: coinFor(s, { p: s.mid * 1.004 }), ...book });
  assert.ok(Math.abs(ok.mid - s.mid) / s.mid < 0.001, `mid=${ok.mid}`);
  const stale = analyzeBook({ ex: "BN", coin: coinFor(s, { p: s.mid * 1.4 }), ...book });
  assert.equal(stale, null, "a book 40% away from the ticker is a wrong symbol map");
});

test("candidates carry the tick and width the lifecycle stage needs", () => {
  const s = SCALES[0]; // BTC — where a percentage tolerance broke identity
  const wallPrice = round(s.mid - 300 * s.tick, s.tick);
  const book = ladder({ ...s, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * 40 }] });
  const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
  const top = asideBids(a)[0];
  assert.ok(top, "wall must be detected");
  assert.ok(Math.abs(top.tick - s.tick) / s.tick < 0.01, `tick ${top.tick}`);
  assert.ok(Number.isFinite(top.widthPct) && top.widthPct >= 0, `widthPct ${top.widthPct}`);
  assert.ok(Number.isInteger(top.widthTicks) && top.widthTicks >= 1, `widthTicks ${top.widthTicks}`);
  assert.ok(Number.isFinite(top.expectedUsd) && top.expectedUsd > 0, `expectedUsd ${top.expectedUsd}`);
  assert.ok(top.peakShare > 0 && top.peakShare <= 1, `peakShare ${top.peakShare}`);
  assert.equal(a.tick, top.tick, "the analysis must expose the tick for residual probing");
});

test("levels outside the band never become candidates", () => {
  const s = SCALES[2];
  const book = ladder({ ...s, levels: 2000 });
  const a = analyzeBook({ ex: "BN", coin: coinFor(s), ...book });
  for (const c of a.candidates) {
    assert.ok(c.pct <= 5.0 + 1e-9, `candidate at ${c.pct}% is outside the 5% band`);
    assert.ok(c.pct >= 0, `negative distance ${c.pct}`);
  }
});

test("garbage levels are discarded without throwing", () => {
  const a = analyzeBook({
    ex: "BN",
    coin: { sym: "AAAUSDT", base: "AAA", p: 100, v: 50_000_000, cs: 1 },
    bids: [
      { price: NaN, qty: 1, usd: 5000 },
      { price: 99.9, qty: 1, usd: NaN },
      { price: -5, qty: 1, usd: 5000 },
      { price: 99.8, qty: 1, usd: 0 },
    ],
    asks: [{ price: 100.1, qty: 1, usd: 5000 }],
  });
  assert.ok(!a || a.candidates.every(c => c.side !== "bid"));
});

test("stablecoins, leveraged tokens and stocks are still rejected", () => {
  const s = SCALES[2];
  for (const base of ["USDT", "USDC", "BTC3L", "AAPL", "TSLAX", "ETHUP"]) {
    const a = analyzeBook({
      ex: "BN",
      coin: { sym: `${base}USDT`, base, p: s.mid, v: 50_000_000, cs: 1 },
      ...ladder({ ...s }),
    });
    assert.equal(a, null, `${base} must be filtered out`);
  }
});

test("an empty book produces no analysis", () => {
  const coin = { sym: "AAAUSDT", base: "AAA", p: 100, v: 5e7, cs: 1 };
  assert.equal(analyzeBook({ ex: "BN", coin, bids: [], asks: [] }), null);
  assert.equal(analyzeBook({ ex: "BN", coin, bids: null, asks: null }), null);
});

// ── Venue depth must not change the answer ───────────────────────────────────

test("truncating the book depth does not invent or destroy the wall", () => {
  // v4 divided by whatever depth the venue happened to return, so the same book
  // at limit=100 and limit=500 produced 0 and 1 candidates respectively.
  const s = SCALES[1];
  const wallPrice = round(s.mid - 120 * s.tick, s.tick);
  const full = ladder({ ...s, levels: 600, walls: [{ side: "bid", price: wallPrice, usd: s.baseUsd * 40 }] });

  const results = [];
  for (const depth of [150, 300, 600]) {
    const bids = full.bids.slice(-depth);   // nearest `depth` levels
    const asks = full.asks.slice(0, depth);
    const a = analyzeBook({ ex: "BN", coin: coinFor(s), bids, asks });
    const top = asideBids(a).reduce((b, c) => (!b || c.S > b.S ? c : b), null);
    results.push({ depth, found: !!top, sig: top ? top.significance : 0 });
  }
  for (const r of results) {
    assert.ok(r.found, `depth=${r.depth}: the wall must still be found`);
  }
  const sigs = results.map(r => r.sig);
  assert.ok(Math.max(...sigs) / Math.min(...sigs) < 1.5,
    `depth must not swing the score: ${results.map(r => `${r.depth}=${r.sig}`).join(" ")}`);
});
