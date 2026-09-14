"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// Density map coverage: per-venue admission floors.
//
// One global $2M floor admitted 1697 of 7427 listed symbols, but it landed very
// differently per venue: 53% of Binance's book passed and 5% of HTX's, because
// the venues are not comparable in listing count or in how much of their tail is
// genuinely tradable. Per-venue floors admit 2731 symbols.
//
// The scheduler is what makes that safe. `selectDueSymbols` sorts by overdue
// *ratio* rather than by rank, so a venue whose token budget cannot fund its tier
// schedule slows every tier proportionally instead of starving the long tail —
// verified by discrete-event simulation, not assumed.
// ═══════════════════════════════════════════════════════════════════════════════

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "wallScanner.js"), "utf8");
const { minVolumeFor } = require("../wallScanner");

const VENUES = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];

// The floors as specified. Kept here as an independent copy so a silent edit to
// EX_PROFILE fails this test rather than passing by construction.
const EXPECTED = {
  BN: 50_000, BB: 50_000, OX: 50_000,
  BG: 30_000,
  GT: 30_000, MX: 30_000, KC: 30_000,
  BX: 50_000,
  HT: 20_000,
  HL: 30_000,
  AD: 25_000,
};

test("every venue has its own volume floor", () => {
  for (const ex of VENUES) {
    assert.equal(minVolumeFor(ex), EXPECTED[ex],
      `${ex}: floor is ${minVolumeFor(ex)}, expected ${EXPECTED[ex]}`);
  }
});

test("an unknown venue falls back to a conservative floor", () => {
  // A venue added to EXCHANGES but not to EX_PROFILE must not be admitted with no
  // floor at all.
  const fallback = minVolumeFor("ZZ");
  assert.ok(fallback >= 50_000, `fallback floor ${fallback} is too permissive`);
});

test("the floors are declared on EX_PROFILE, not scattered through the code", () => {
  for (const ex of VENUES) {
    const re = new RegExp(`${ex}:\\s*\\{[^}]*minVolumeUsd:\\s*[0-9_]+`);
    assert.match(SRC, re, `${ex} must carry minVolumeUsd in EX_PROFILE`);
  }
});

test("a single global override is still available for a rate-limit emergency", () => {
  // Setting WALL_MIN_SYMBOL_VOLUME_USD must beat every per-venue value, so the
  // scan can be throttled from the environment without a deploy.
  assert.match(SRC, /const MIN_SYMBOL_VOLUME_USD_OVERRIDE = process\.env\.WALL_MIN_SYMBOL_VOLUME_USD !== undefined/);
  assert.match(SRC, /if \(MIN_SYMBOL_VOLUME_USD_OVERRIDE !== null\) return MIN_SYMBOL_VOLUME_USD_OVERRIDE;/);
  // Absent the variable, the override must be null rather than a default value —
  // otherwise it would silently mask every per-venue floor.
  assert.equal(process.env.WALL_MIN_SYMBOL_VOLUME_USD, undefined,
    "this test assumes the variable is unset in the test environment");
  assert.notEqual(minVolumeFor("HT"), minVolumeFor("BX"),
    "with no override the per-venue floors must differ");
});

test("the universe filter reads the per-venue floor, resolved once per venue", () => {
  const start = SRC.indexOf("function refreshUniverse(tickers)");
  assert.ok(start > 0, "refreshUniverse must exist");
  const body = SRC.slice(start, SRC.indexOf("\n  const now = Date.now();", start));
  assert.match(body, /const floors = new Map\(\);/);
  assert.match(body, /for \(const ex of EXCHANGES\) floors\.set\(ex, minVolumeFor\(ex\)\);/);
  assert.match(body, /if \(vol < floors\.get\(t\.ex\)\) continue;/);
  // The old single-constant comparison must be gone.
  assert.ok(!/vol < MIN_SYMBOL_VOLUME_USD\b/.test(SRC),
    "the global-constant comparison must be replaced");
});

test("no venue is silently excluded by a floor above its whole book", () => {
  // HTX lists 333 perps of which only 15 clear $2M. A floor must never be set so
  // high that a venue contributes nothing.
  for (const ex of VENUES) {
    assert.ok(minVolumeFor(ex) <= 2_000_000,
      `${ex}: a floor of ${minVolumeFor(ex)} is at or above the old global one, which defeats the point`);
    assert.ok(minVolumeFor(ex) > 0, `${ex}: a zero floor would admit dead listings`);
  }
});

// ── The scheduler property that makes a larger universe safe ─────────────────

test("symbols are selected by overdue ratio, not by rank", () => {
  // This is the load-bearing detail. Sorting by raw age or by rank would let the
  // leaders consume the whole budget and the tail would never be polled at all.
  const start = SRC.indexOf("function selectDueSymbols(ex, now)");
  assert.ok(start > 0);
  const body = SRC.slice(start, SRC.indexOf("\n}", start));
  assert.match(body, /overdue: \(now - st\.nextDueAt\) \/ interval/);
  assert.match(body, /due\.sort\(\(a, b\) => b\.overdue - a\.overdue/);
});

test("a starved venue degrades proportionally instead of dropping its tail", () => {
  // Discrete-event simulation of selectDueSymbols against Binance's real numbers:
  // 525 symbols, 22 tok/s, tail cost 5, hot cost 10 — 3.1x oversubscribed.
  const TIERS = [[30, 12000], [120, 30000], [350, 75000], [Infinity, 180000]];
  const tierMs = (r) => { for (const [m, ms] of TIERS) if (r < m) return ms; return 180000; };

  const universe = 525, budget = 22, costTail = 5, costHot = 10, inflight = 4, latency = 264;
  const MINUTES = 40;
  const syms = Array.from({ length: universe }, (_, i) => ({
    rank: i,
    base: Math.max(8000, tierMs(i)),
    deep: i < 40,
    nextDue: Math.floor((i / universe) * tierMs(i)),
    inflight: false,
    polls: 0,
    lastPoll: -1,
    maxGap: 0,
  }));

  let tokens = budget, lastRefill = 0, busy = 0;
  const done = [];
  for (let t = 0; t <= MINUTES * 60000; t += 120) {
    tokens = Math.min(budget * 2, tokens + (t - lastRefill) / 1000 * budget);
    lastRefill = t;
    while (done.length && done[0].at <= t) {
      const c = done.shift();
      c.sym.inflight = false; busy--; c.sym.polls++;
      if (c.sym.lastPoll >= 0) c.sym.maxGap = Math.max(c.sym.maxGap, t - c.sym.lastPoll);
      c.sym.lastPoll = t;
      c.sym.nextDue = t + c.sym.base;
    }
    const slots = inflight - busy;
    if (slots <= 0) continue;
    const due = [];
    for (const s of syms) if (!s.inflight && s.nextDue <= t) due.push({ s, o: (t - s.nextDue) / s.base });
    if (!due.length) continue;
    due.sort((a, b) => b.o - a.o || a.s.rank - b.s.rank);
    let picked = 0;
    for (const it of due) {
      if (picked >= slots) break;
      const cost = it.s.deep ? costHot : costTail;
      if (tokens < cost) break;
      tokens -= cost; it.s.inflight = true; busy++; picked++;
      done.push({ at: t + latency, sym: it.s });
    }
    done.sort((a, b) => a.at - b.at);
  }

  // 1. Nothing is abandoned. This is the property the overdue-ratio sort buys.
  const unpolled = syms.filter(s => s.polls === 0);
  assert.equal(unpolled.length, 0,
    `${unpolled.length} of ${universe} symbols were never polled in ${MINUTES} minutes`);

  // 2. Every symbol clears the confirmation gate, so the tail can publish at all.
  const minPolls = Math.min(...syms.map(s => s.polls));
  assert.ok(minPolls >= 2,
    `every symbol must reach MIN_CONFIRMATIONS: worst is ${minPolls} polls in ${MINUTES} min`);

  // 3. The slowdown is uniform across tiers rather than concentrated on the tail.
  const bandAvg = (lo, hi) => {
    const g = syms.filter(s => s.rank >= lo && s.rank < hi && s.polls >= 2);
    if (!g.length) return null;
    return g.reduce((a, s) => a + s.maxGap / s.base, 0) / g.length;
  };
  const leaders = bandAvg(0, 30);
  const tail = bandAvg(350, Infinity);
  assert.ok(leaders && tail, "both bands must have polled symbols");
  assert.ok(tail / leaders < 2,
    `the tail must not be starved relative to the leaders: ` +
    `leaders ${leaders.toFixed(1)}x their target, tail ${tail.toFixed(1)}x`);
});

/**
 * Read a numeric constant out of wallScanner.js.
 *
 * The defaults are written as arithmetic (`15 * 60 * 1000`), so a bare `(\d+)`
 * capture silently returns the first factor — 15 rather than 900000 — and any
 * assertion built on it passes or fails for the wrong reason.
 */
function envDefault(name) {
  const m = new RegExp(`"${name}",\\s*([0-9_*\\s.]+?)\\s*[,)]`).exec(SRC);
  assert.ok(m, `${name} must be locatable in wallScanner.js`);
  const expr = m[1].replace(/_/g, "").trim();
  assert.match(expr, /^[0-9.\s*]+$/, `${name} default is not simple arithmetic: ${expr}`);
  const value = expr.split("*").reduce((a, part) => a * Number(part.trim()), 1);
  assert.ok(Number.isFinite(value) && value > 0, `${name} resolved to ${value}`);
  return value;
}

test("the numeric-constant reader handles the arithmetic defaults", () => {
  // Guards the helper itself: SYMBOL_STALE_MS is written `15 * 60 * 1000`.
  assert.equal(envDefault("WALL_SYMBOL_STALE_MS"), 900000);
  assert.equal(envDefault("WALL_TIER4_MS"), 180000);
  assert.equal(envDefault("WALL_MIN_CONFIRMATIONS"), 2);
});

test("the tail's poll interval stays inside the staleness window", () => {
  // `collectActiveWalls` drops a symbol whose last poll is older than
  // SYMBOL_STALE_MS. If the slowest tier's real cadence exceeded that, a published
  // density would blink off between polls even though the level is still tracked.
  const tier4 = envDefault("WALL_TIER4_MS");
  const stale = envDefault("WALL_SYMBOL_STALE_MS");

  // Worst measured slowdown across all 11 venues is 3.1x (Binance, 525 symbols
  // against a 22 tok/s budget).
  const WORST_SLOWDOWN = 3.1;
  const realCadence = tier4 * WORST_SLOWDOWN;
  assert.ok(realCadence < stale,
    `tier-4 cadence at ${WORST_SLOWDOWN}x is ${(realCadence / 1000).toFixed(0)}s, ` +
    `beyond the ${(stale / 1000).toFixed(0)}s staleness window — tail densities would flicker`);

  // And there must be real headroom, not a coincidence.
  assert.ok(realCadence < stale * 0.75,
    `only ${((1 - realCadence / stale) * 100).toFixed(0)}% headroom between the tail cadence ` +
    `and the staleness window; a further floor cut would break it`);
});

test("a level survives a slow poll cadence without losing its identity", () => {
  // The tail is polled every ~9 minutes. Tick-based identity matching has to hold
  // across that gap or `observations` resets and the level never publishes.
  const { ingestBook, resetSymbolState, getSymbolDiagnostics } = require("../wallScanner");

  const MID = 200, TICK = 0.01, LEVELS = 400, BASE = 4000;
  const wallAt = +(MID - 150 * TICK).toFixed(10);
  const coin = { sym: "TAILUSDT", base: "TAIL", p: MID, v: 2_500_000, cs: 1 };

  const makeBook = (seed) => {
    let s = seed;
    const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const bids = [], asks = [];
    for (let i = 1; i <= LEVELS; i++) {
      const bp = +(MID - i * TICK).toFixed(10), ap = +(MID + i * TICK).toFixed(10);
      const bu = BASE * (1 + (r() - 0.5) * 0.5), au = BASE * (1 + (r() - 0.5) * 0.5);
      bids.push({ price: bp, qty: bu / bp, usd: bu });
      asks.push({ price: ap, qty: au / ap, usd: au });
    }
    const target = bids.reduce((b, l) => (Math.abs(l.price - wallAt) < Math.abs(b.price - wallAt) ? l : b), bids[0]);
    target.usd += BASE * 40;
    target.qty = target.usd / target.price;
    bids.sort((a, b) => a.price - b.price);
    asks.sort((a, b) => a.price - b.price);
    return { bids, asks };
  };

  for (const gapMinutes of [0.2, 9, 14]) {
    resetSymbolState("BN", "TAILUSDT");
    let t = 1_700_000_000_000;
    let publishedAt = -1;
    for (let k = 0; k < 4; k++) {
      // A different noise seed each poll: the book moves, the wall stays.
      const { bids, asks } = makeBook(3 + k);
      const walls = ingestBook({ ex: "BN", coin, bids, asks, now: t });
      const bid = walls.filter(x => x.side === "bid");
      if (publishedAt < 0 && bid.length) publishedAt = k;
      // Exactly one tracked level throughout: the identity must not fork.
      assert.equal(getSymbolDiagnostics("BN", "TAILUSDT").trackedLevels, 1,
        `gap ${gapMinutes} min, poll ${k + 1}: identity forked`);
      t += gapMinutes * 60000;
    }
    assert.equal(publishedAt, 2,
      `gap ${gapMinutes} min: expected the density on the 3rd poll, got poll ${publishedAt + 1}`);
  }
});
