"use strict";

/**
 * Density Engine v6 — professional order-book density detection.
 *
 * WHY v5 REPLACED v4
 * ------------------
 * v4 expressed both its cluster window and its scan band as a percentage of
 * price, while every venue quotes on an absolute tick grid. One 0.06 % window
 * therefore held 600 price levels on BTC and 7 on a $0.012 coin — an 85x spread.
 * Everything downstream inherited that: `dominance` divided by the level count,
 * the robust sigma was computed over clusters whose meaning changed per coin, and
 * on BTC-class books the entire near side collapsed into a single cluster whose
 * z-score was 0 by construction. Measured on live books: 36 of 45 Binance
 * symbols produced zero candidates, including BTC, ETH, SOL and DOGE, while the
 * few that did fire were near-random micro-caps. That is the "2 walls here, 0
 * there, 100 somewhere else" the map was showing.
 *
 * DESIGN
 * ------
 * 1. FULL COVERAGE. Every one of the 11 exchanges and every tradable symbol
 *    (futures + spot) is continuously polled by an independent worker pool that
 *    is rate limited by a per-endpoint token bucket. Symbols are scheduled by
 *    liquidity tier and by how overdue they are, so leaders refresh in seconds
 *    and the long tail still gets full periodic coverage.
 *
 * 2. TICK-RELATIVE GEOMETRY. The tick size is estimated from the book itself and
 *    every distance inside the detector is measured in ticks, never in percent.
 *    A wall is the same object whether the instrument trades at $100 000 or at
 *    $0.000012.
 *
 * 3. LOCAL EXPECTED LIQUIDITY. The band is split into segments of equal *level
 *    count*, and each segment's median level size is its "normal". A density is
 *    a run of levels that is a multiple of what that part of the book normally
 *    holds. This is the measure a desk actually uses — "there is 40x the usual
 *    size sitting at 0.4 % below" — and it is scale free by construction.
 *
 * 4. SEED AND GROW. The strongest level above the seed multiple starts a
 *    cluster, which then absorbs adjacent levels while they stay above a lower
 *    grow multiple and within a few ticks. A four-level shelf becomes one wall
 *    with the correct total; two walls a hundred ticks apart stay two walls.
 *    No fixed bins, so nothing is halved by a bin edge.
 *
 * 5. ADDITIVE SCORE. Signals are combined additively with a small proximity
 *    bonus. v4 multiplied the score by `proximity x sample x granularity`, which
 *    capped the achievable significance at 0.60 on any book with fewer than 12
 *    clusters — below its own 0.40 publication gate for every realistic signal
 *    combination.
 *
 * 6. LIFECYCLE + ANTI-SPOOF. Every level is tracked across polls with exact miss
 *    accounting. When a level disappears the fresh book decides why: absorbed by
 *    price (filled), still partly there (faded), or yanked while price was far
 *    away (pulled = spoof). The pulled ratio penalises that symbol's future
 *    densities.
 *
 * 7. CROSS-EXCHANGE CONFLUENCE. The same price defended on several venues cannot
 *    be one trader spoofing, and is scored as the strongest signal on the board.
 *
 * 8. VENUE-CALIBRATED QUALITY. Every venue has its own evidence bar derived
 *    from the depth and aggregation of the book it exposes. There is no target
 *    count and no production output cap: every published wall passed on merit.
 */

// ═══ Config ══════════════════════════════════════════════════════════════════

function envInt(name, def, min, max) {
  const v = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

function envNum(name, def, min, max) {
  const v = Number.parseFloat(process.env[name]);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

const EXCHANGES = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];

// ── Scan band ────────────────────────────────────────────────────────────────
// Still a percentage, because "how far from price is this level" is genuinely a
// percentage question for a trader. Everything *inside* the band is measured in
// ticks instead.
const MIN_DIST_PCT = envNum("WALL_MIN_DIST_PCT", 0.02, 0.0, 1);
const MAX_DIST_PCT = envNum("WALL_MAX_DIST_PCT", 5.0, 0.5, 20);

// ── Cluster geometry, in ticks ───────────────────────────────────────────────
// A cluster may absorb an adjacent level across at most this many ticks of empty
// grid. Real shelves are contiguous or near-contiguous; a gap of more than a few
// ticks means two separate orders.
const MAX_TICK_GAP = envInt("WALL_MAX_TICK_GAP", 4, 1, 40);
// Hard ceiling on how wide one density may grow, as a share of the scan band.
// Without it a monotonically thickening book becomes one enormous "wall".
const MAX_CLUSTER_BAND_SHARE = envNum("WALL_MAX_CLUSTER_BAND_SHARE", 0.22, 0.02, 1);

// ── Local expected liquidity ─────────────────────────────────────────────────
// The band is divided into segments of a FIXED number of price levels, and each
// segment's mean level size is the "normal" size for that part of the book.
//
// Fixed count, not a fraction of the book: with `n/8` segments a venue returning
// 500 levels gets 63-level segments and one returning 100 gets 13-level segments,
// and because a wall is itself inside the segment it dilutes its own baseline by
// `1/segN`. The wall multiple needed to reach a given dominance therefore moved
// with the venue's depth — 21x on a 12-level segment versus 7.6x on a 100-level
// one. A fixed 40 pins it at 8.8x everywhere. Measured cross-book spread of the
// strongest wall's dominance: 2.7x with fixed segments, 12.3x with fractional.
//
// Segments rather than one global figure because books are systematically thicker
// near the touch, and the mean rather than the median because on live books the
// median is frequently the exchange's minimum order size: on Binance BTC a
// quarter of all band levels sit at $77 while the largest is $1.49M, which turns
// `size / median` into a number in the thousands and destroys comparability
// (measured spread across nine books: 778x for the median, 11.3x for the mean).
const BASELINE_SEGMENT_LEVELS = envInt("WALL_BASELINE_SEGMENT_LEVELS", 40, 8, 400);
const BASELINE_MIN_LEVELS = envInt("WALL_BASELINE_MIN_LEVELS", 16, 4, 200);
// A cluster's dominance is measured against the segment levels it does not
// occupy. Below this many neighbours there is no meaningful "normal" to compare
// against and the cluster is not scored at all.
const BASELINE_MIN_NEIGHBOURS = envInt("WALL_BASELINE_MIN_NEIGHBOURS", 6, 2, 100);

// ── Admission gates ──────────────────────────────────────────────────────────
// Both multiples are of locally expected liquidity, so the same numbers mean the
// same thing on BTC and on a micro-cap.
//
// SEED_MULT starts a cluster; GROW_MULT lets it absorb its neighbours. GROW must
// be well below SEED or a wall's own shoulders are excluded from it.
const SEED_MULT = envNum("WALL_SEED_MULT", 5.0, 1.5, 100);
const GROW_MULT = envNum("WALL_GROW_MULT", 2.0, 1.0, 50);
// The one hard structural gate: total cluster size versus what that stretch of
// book would normally hold, excluding the cluster's own levels from that
// "normal". Measured across the live volume curve at this setting, 19 of 20
// instruments produce densities and the strongest wall per book lands between
// 12x and 43x — so 10x separates a genuine shelf from an ordinary thick level
// without biasing by coin size.
const MIN_DOMINANCE = envNum("WALL_MIN_DOMINANCE", 10.0, 1.5, 200);
// Dust floor. Deliberately low: it exists only to stop sub-$1k "walls" on dead
// micro-caps from reaching the map, not to rank anything.
const MIN_ABS_USD = envNum("WALL_MIN_ABS_USD", 15000, 0, 1e9);
// Minutes of the coin's own traded flow resting at one price.
//
// This is a *scoring* signal and a dust floor, NOT a structural gate — that was
// the other thing the live data disproved. BTC trades $7.6M every minute, so its
// single largest resting order is 0.08 minutes of flow; any floor above ~0.2
// makes a wall on a major mathematically impossible while every micro-cap clears
// it trivially. The floor here only rejects liquidity that is irrelevant even for
// its own instrument.
const MIN_VOL_MINUTES = envNum("WALL_MIN_VOL_MINUTES", 0.05, 0.0, 600);
// Composite score floor.
const MIN_SIGNIFICANCE = envNum("WALL_MIN_SIGNIFICANCE", 0.34, 0.05, 0.95);
// Per-venue 24h volume floors live in EX_PROFILE.minVolumeUsd, because the
// venues are not comparable in listing count or in how much of their tail is
// genuinely tradable. Setting WALL_MIN_SYMBOL_VOLUME_USD overrides all of them
// with one global figure, which is the escape hatch for a rate-limit emergency.
const MIN_SYMBOL_VOLUME_USD_OVERRIDE = process.env.WALL_MIN_SYMBOL_VOLUME_USD !== undefined
  ? envNum("WALL_MIN_SYMBOL_VOLUME_USD", 2000000, 0, 1e12)
  : null;

/**
 * Professional Tiered Wall Floor and Classification.
 * Adapts to the coin's market cap, liquidity, and trading flow.
 * Eliminates trivial noise like $1.8M on BTC or $220k on SOL.
 */
function getTierThresholds(base, vol24h = 0, ex = "") {
  if (process.env.WALL_MIN_ABS_USD !== undefined) {
    const override = Number(process.env.WALL_MIN_ABS_USD);
    if (Number.isFinite(override) && override >= 0) {
      return { minFloor: override, small: override, medium: override * 2.5, large: override * 5 };
    }
  }

  const b = String(base || "").toUpperCase();
  const vol = Number(vol24h) || 0;

  let thresholds;
  if (b === "BTC") {
    if (vol >= 300_000_000) {
      thresholds = { minFloor: 3_000_000, small: 3_000_000, medium: 7_000_000, large: 15_000_000 };
    } else {
      thresholds = { minFloor: 1_000_000, small: 1_000_000, medium: 3_000_000, large: 7_000_000 };
    }
  } else if (b === "ETH") {
    if (vol >= 150_000_000) {
      thresholds = { minFloor: 1_500_000, small: 1_500_000, medium: 3_500_000, large: 8_000_000 };
    } else {
      thresholds = { minFloor: 500_000, small: 500_000, medium: 1_500_000, large: 4_000_000 };
    }
  } else if (b === "SOL") {
    if (vol >= 80_000_000) {
      thresholds = { minFloor: 800_000, small: 800_000, medium: 2_000_000, large: 5_000_000 };
    } else {
      thresholds = { minFloor: 300_000, small: 300_000, medium: 800_000, large: 2_000_000 };
    }
  } else if (vol >= 100_000_000 || ["BNB", "XRP", "DOGE", "SUI", "ADA", "AVAX", "LINK", "NEAR"].includes(b)) {
    thresholds = { minFloor: 350_000, small: 350_000, medium: 900_000, large: 2_500_000 };
  } else if (vol >= 10_000_000) {
    thresholds = { minFloor: 100_000, small: 100_000, medium: 300_000, large: 800_000 };
  } else {
    thresholds = { minFloor: 30_000, small: 30_000, medium: 80_000, large: 200_000 };
  }

  const scale = qualityProfileFor(ex).floorScale;
  if (!ex || scale === 1) return thresholds;
  return Object.fromEntries(Object.entries(thresholds).map(([key, value]) => [key, Math.round(value * scale)]));
}

function classifyWallTier(usd, base, vol24h = 0, ex = "") {
  const t = getTierThresholds(base, vol24h, ex);
  if (usd >= t.large) return "large";
  if (usd >= t.medium) return "medium";
  return "small";
}

// ── Lifecycle geometry ───────────────────────────────────────────────────────
// Identity matching is in ticks: v4 used 0.07 % of price, which on BTC spans 539
// ticks — every cluster on the book matched every other one, so a level's
// identity hopped between neighbouring shelves on every poll and its
// confirmation count never accumulated.
const MATCH_TOL_TICKS = envInt("WALL_MATCH_TOL_TICKS", 6, 1, 200);
const TOUCH_PCT = envNum("WALL_TOUCH_PCT", 0.12, 0.01, 1);
const MAX_MISSES = envInt("WALL_MAX_MISSES", 2, 1, 6);
const RESIDUAL_ALIVE_RATIO = 0.35;
const REFILL_DIP_RATIO = 0.72;

/**
 * Publication stability gates.
 *
 * A density must be seen in at least MIN_CONFIRMATIONS separate polls before it
 * is published at all. This is the single most effective anti-flicker measure:
 * without it, every transient order that momentarily looks large appears on the
 * map for one refresh and vanishes, which reads as the map "jumping".
 *
 * MIN_QUALITY is applied to the final lifecycle-adjusted score, and once a level
 * is on the map it only needs KEEP_QUALITY_RATIO of that to stay. The hysteresis
 * band stops levels that hover around the threshold from blinking in and out on
 * every refresh.
 */
const MIN_CONFIRMATIONS = envInt("WALL_MIN_CONFIRMATIONS", 2, 1, 10);
const MIN_QUALITY = envNum("WALL_MIN_QUALITY", 0.26, 0.02, 0.95);
const KEEP_QUALITY_RATIO = envNum("WALL_KEEP_QUALITY_RATIO", 0.72, 0.2, 1.0);

// There is deliberately no default output cap. The number on the map must be an
// outcome of the evidence gates, never a quota. WALL_MAX_RESULTS remains an
// emergency-only transport fuse and is inactive unless explicitly configured.
const MAX_OUTPUT = process.env.WALL_MAX_RESULTS !== undefined
  ? envInt("WALL_MAX_RESULTS", 20000, 50, 20000)
  : Infinity;
const MAX_PER_COIN = envInt("WALL_MAX_PER_COIN", 3, 1, 40);
const CLUSTER_PCT = envNum("WALL_SNAPSHOT_CLUSTER_PCT", 0.1, 0.01, 1);
const EX_RESERVE_RATIO = envNum("WALL_EX_RESERVE_RATIO", 0.45, 0, 0.9);
// Optional global override on the 0..15 publication scale. Unset by default so
// the venue-calibrated bars remain authoritative.
const PUBLISH_MIN_SCORE_OVERRIDE = process.env.WALL_PUBLISH_MIN_SCORE !== undefined
  ? envNum("WALL_PUBLISH_MIN_SCORE", MIN_QUALITY * 15, 0, 20)
  : null;

// Scheduling / transport.
const REQUEST_TIMEOUT_MS = envInt("WALL_REQUEST_TIMEOUT_MS", 7000, 1000, 30000);
// Publish cadence. Every publish is a visible change on the client, so pushing
// faster than the eye can follow only makes the map look unstable.
const PUBLISH_INTERVAL_MS = envInt("WALL_PUBLISH_INTERVAL_MS", 4000, 500, 30000);
const UNIVERSE_REFRESH_MS = envInt("WALL_UNIVERSE_REFRESH_MS", 20000, 5000, 300000);
const SYMBOL_STALE_MS = envInt("WALL_SYMBOL_STALE_MS", 15 * 60 * 1000, 60000, 6 * 60 * 60 * 1000);
const EXCHANGE_STALE_MS = envInt("WALL_EXCHANGE_CACHE_TTL_MS", 5 * 60 * 1000, 30000, 60 * 60 * 1000);
const HISTORY_TTL_MS = envInt("WALL_HISTORY_TTL_MS", 24 * 60 * 60 * 1000, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const HISTORY_LIMIT = envInt("WALL_HISTORY_LIMIT", 5000, 100, 20000);
const RATE_SCALE = envNum("WALL_RATE_SCALE", 1.0, 0.1, 5.0);
const SPOT_REFRESH_MS = envInt("WALL_SPOT_REFRESH_MS", 180000, 60000, 3600000);

// Liquidity tiers: rank inside the exchange (by 24h volume) -> target interval.
const TIERS = [
  { maxRank: 30, intervalMs: envInt("WALL_TIER1_MS", 12000, 4000, 120000) },
  { maxRank: 120, intervalMs: envInt("WALL_TIER2_MS", 30000, 6000, 300000) },
  { maxRank: 350, intervalMs: envInt("WALL_TIER3_MS", 75000, 10000, 600000) },
  { maxRank: Infinity, intervalMs: envInt("WALL_TIER4_MS", 180000, 20000, 1800000) },
];
const ACTIVE_WALL_BOOST = 0.55; // symbols already holding densities are watched harder

/**
 * Symbols that answer with no levels at all are not markets this scanner can
 * use. Bitget lists ~760 tokenized-equity spot pairs — RNVDA, RLITE, RUTHR,
 * RCSIQ and so on — that report large "volume" and return an empty book on every
 * request. Polling them forever spent that venue's entire budget on dead
 * instruments and pinned its reported coverage at 7% (70 of 829 symbols) for as
 * long as the process ran. A curated equity list cannot keep up with that
 * catalogue, so behaviour is what disqualifies a symbol: a few empty books in a
 * row and it stands down for an hour, then gets one more chance.
 */
const EMPTY_BOOK_LIMIT = envInt("WALL_EMPTY_BOOK_LIMIT", 3, 1, 50);
const EMPTY_BOOK_PARK_MS = envInt("WALL_EMPTY_BOOK_PARK_MS", 60 * 60 * 1000, 60000, 24 * 60 * 60 * 1000);
const MIN_INTERVAL_MS = 8000;

/**
 * Per-exchange transport budget and admission floor.
 *   budget      - token-bucket refill per second, in cost units
 *   costTail    - cost of a shallow book request
 *   costHot     - cost of a deep book request
 *   depthTail   - levels requested for a routine poll
 *   depthHot    - levels requested for a leader / high-volume poll
 *   inflight    - concurrent requests
 *   aggregated  - venue returns pre-merged price levels (level counts are unusable)
 *   minVolumeUsd- 24h volume a symbol needs before it is scanned at all
 *
 * Depth values are the venue's *real* cap, verified against the live APIs:
 * Bitget's merge-depth returns at most 100 whatever you ask for, and Hyperliquid
 * always returns 20. Asking for more only misled the code that reasoned about
 * how much of the book it could see.
 *
 * `aggregated` is a statement about whether one returned level can be trusted to
 * be one resting order. BingX changes its aggregation *step* with `limit`
 * (median level size measured at 26 for limit=5 and 245 for limit=100, with the
 * price gap doubling), so its levels are pre-merged buckets and it is marked
 * accordingly — without that it was the single largest source of false walls.
 *
 * `minVolumeUsd` is per venue because the venues are not comparable: Binance
 * lists 713 USDT perps of which 525 clear $1M, while HTX lists 333 of which only
 * 15 clear $2M but 126 clear $200K. A single global floor either starved the
 * small venues of coverage or flooded the large ones. Measured against live
 * instrument lists these floors admit 2731 symbols in total, up from 1697.
 */
const EX_PROFILE = {
  BN: { budget: 22, costTail: 5, costHot: 10, depthTail: 100, depthHot: 500, inflight: 4, aggregated: false, hasSpot: true, minVolumeUsd: 50_000 },
  BB: { budget: 10, costTail: 1, costHot: 1, depthTail: 200, depthHot: 500, inflight: 5, aggregated: false, hasSpot: true, minVolumeUsd: 50_000 },
  OX: { budget: 6, costTail: 1, costHot: 1, depthTail: 400, depthHot: 400, inflight: 3, aggregated: false, hasSpot: true, minVolumeUsd: 50_000 },
  BG: { budget: 8, costTail: 1, costHot: 1, depthTail: 100, depthHot: 100, inflight: 4, aggregated: true, hasSpot: true, minVolumeUsd: 30_000 },
  GT: { budget: 9, costTail: 1, costHot: 1, depthTail: 100, depthHot: 100, inflight: 4, aggregated: false, hasSpot: true, minVolumeUsd: 30_000 },
  MX: { budget: 6, costTail: 1, costHot: 1, depthTail: 200, depthHot: 500, inflight: 3, aggregated: false, hasSpot: true, minVolumeUsd: 30_000 },
  KC: { budget: 5, costTail: 1, costHot: 1, depthTail: 100, depthHot: 100, inflight: 3, aggregated: false, hasSpot: true, minVolumeUsd: 30_000 },
  BX: { budget: 4, costTail: 1, costHot: 1, depthTail: 100, depthHot: 100, inflight: 2, aggregated: true, hasSpot: false, minVolumeUsd: 50_000 },
  HT: { budget: 6, costTail: 1, costHot: 1, depthTail: 150, depthHot: 150, inflight: 3, aggregated: true, hasSpot: true, minVolumeUsd: 20_000 },
  HL: { budget: 4, costTail: 1, costHot: 1, depthTail: 20, depthHot: 20, inflight: 2, aggregated: true, hasSpot: false, minVolumeUsd: 30_000 },
  AD: { budget: 2, costTail: 1, costHot: 1, depthTail: 100, depthHot: 500, inflight: 2, aggregated: false, hasSpot: false, minVolumeUsd: 25_000 },
};

/**
 * Evidence policy per venue.
 *
 * These are not quotas. A venue can publish zero or a hundred walls if that is
 * what its current books prove. The policy only translates different exchange
 * microstructure into comparable evidence:
 *   - deep, raw books must show a very exceptional shelf;
 *   - pre-merged books need stronger dominance because one level is a bucket;
 *   - Hyperliquid is the exception: its official API exposes at most 20 levels
 *     per side, so a 10x outlier and a major-venue dollar floor are structurally
 *     inappropriate there. It still needs three independent observations.
 */
const VENUE_QUALITY_PROFILE = Object.freeze({
  BN: Object.freeze({ minDominance: 13, minSignificance: 0.40, minQuality: 0.38, minConfirmations: 3, floorScale: 1.00 }),
  BB: Object.freeze({ minDominance: 16, minSignificance: 0.43, minQuality: 0.42, minConfirmations: 3, floorScale: 1.00 }),
  OX: Object.freeze({ minDominance: 14, minSignificance: 0.41, minQuality: 0.39, minConfirmations: 3, floorScale: 0.85 }),
  BG: Object.freeze({ minDominance: 14, minSignificance: 0.42, minQuality: 0.39, minConfirmations: 3, floorScale: 0.75 }),
  GT: Object.freeze({ minDominance: 14, minSignificance: 0.41, minQuality: 0.39, minConfirmations: 3, floorScale: 0.75 }),
  MX: Object.freeze({ minDominance: 14, minSignificance: 0.41, minQuality: 0.39, minConfirmations: 3, floorScale: 0.70 }),
  KC: Object.freeze({ minDominance: 13, minSignificance: 0.40, minQuality: 0.38, minConfirmations: 3, floorScale: 0.75 }),
  BX: Object.freeze({ minDominance: 16, minSignificance: 0.43, minQuality: 0.41, minConfirmations: 3, floorScale: 0.80 }),
  HT: Object.freeze({ minDominance: 15, minSignificance: 0.42, minQuality: 0.40, minConfirmations: 3, floorScale: 0.65 }),
  HL: Object.freeze({ minDominance: 6, minSignificance: 0.29, minQuality: 0.30, minConfirmations: 3, floorScale: 0.10 }),
  AD: Object.freeze({ minDominance: 13, minSignificance: 0.40, minQuality: 0.38, minConfirmations: 3, floorScale: 0.70 }),
});

const DEFAULT_VENUE_QUALITY_PROFILE = VENUE_QUALITY_PROFILE.BN;

function qualityProfileFor(ex) {
  const profile = VENUE_QUALITY_PROFILE[ex] || DEFAULT_VENUE_QUALITY_PROFILE;
  if (process.env.WALL_MIN_DOMINANCE === undefined &&
      process.env.WALL_MIN_SIGNIFICANCE === undefined &&
      process.env.WALL_MIN_QUALITY === undefined &&
      process.env.WALL_MIN_CONFIRMATIONS === undefined) return profile;
  return {
    ...profile,
    minDominance: process.env.WALL_MIN_DOMINANCE !== undefined ? MIN_DOMINANCE : profile.minDominance,
    minSignificance: process.env.WALL_MIN_SIGNIFICANCE !== undefined ? MIN_SIGNIFICANCE : profile.minSignificance,
    minQuality: process.env.WALL_MIN_QUALITY !== undefined ? MIN_QUALITY : profile.minQuality,
    minConfirmations: process.env.WALL_MIN_CONFIRMATIONS !== undefined ? MIN_CONFIRMATIONS : profile.minConfirmations,
  };
}

/** 24h volume floor for one venue. `WALL_MIN_SYMBOL_VOLUME_USD` overrides all. */
function minVolumeFor(ex) {
  if (MIN_SYMBOL_VOLUME_USD_OVERRIDE !== null) return MIN_SYMBOL_VOLUME_USD_OVERRIDE;
  const p = EX_PROFILE[ex];
  const perVenue = p && Number(p.minVolumeUsd);
  return Number.isFinite(perVenue) && perVenue >= 0 ? perVenue : 50_000;
}

function profileFor(ex) {
  return EX_PROFILE[ex] || EX_PROFILE.BN;
}

// ═══ Asset filters ═══════════════════════════════════════════════════════════

const EXCLUDED_BASES = new Set([
  "USDT", "USDC", "DAI", "BUSD", "FDUSD", "TUSD", "USDP", "USDE", "PYUSD", "USD1", "EUR1", "USDC1", "BTC1",
  "USTC", "USDD", "FRAX", "LUSD", "CRVUSD", "GUSD", "USDJ", "CUSD",
  "XAUT", "PAXG", "XAG", "XAU", "SILVER", "GOLD",
  "EUR", "GBP", "JPY", "AUD", "USD", "CHF", "TRY", "RUB", "BRL",
]);

// Runtime RWA catalogue, sourced from venue metadata. Curated names below are a
// fallback for venues that expose no asset-class field; this set is what keeps
// new stock listings out without requiring a code deploy for every ticker.
const DYNAMIC_NON_CRYPTO_BASES = new Set();

function registerVenueAssetMetadata(items) {
  let added = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const isRwa = item.isRwa === true || String(item.isRwa).toUpperCase() === "YES" ||
      String(item.isReality).toLowerCase() === "yes" || item.assetClass === "equity";
    if (!isRwa) continue;
    const values = [item.baseCoin, item.baseCcy, item.ctValCcy, item.base, item.symbol, item.instId];
    for (let value of values) {
      value = String(value || "").toUpperCase().trim();
      if (!value) continue;
      value = value.replace(/_SPOT$/i, "")
        .replace(/[-_]?(SWAP|PERP)$/i, "")
        .replace(/[-_]?(USDTM|USDT|USDC|BUSD|DAI|USD)$/i, "")
        .replace(/[-_]/g, "");
      if (!value || DYNAMIC_NON_CRYPTO_BASES.has(value)) continue;
      DYNAMIC_NON_CRYPTO_BASES.add(value);
      added++;
    }
  }
  return added;
}

async function refreshVenueAssetExclusions(fetchImpl = fetch) {
  const sources = [
    "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES",
    "https://api.bitget.com/api/v3/market/instruments?category=SPOT",
  ];
  const results = await Promise.allSettled(sources.map(async url => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload && payload.data) ? payload.data : [];
  }));
  let added = 0;
  for (const result of results) {
    if (result.status === "fulfilled") added += registerVenueAssetMetadata(result.value);
  }
  return added;
}

const KNOWN_STOCK_BASES = new Set([
  "AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOG", "GOOGL", "META", "NFLX", "COIN",
  "MSTR", "BAC", "AMD", "INTC", "PLTR", "BABA", "DIS", "PYPL", "UBER", "SPY",
  "QQQ", "IWM", "DIA", "V", "MA", "JPM", "WMT", "XOM", "CVX", "LLY",
  "UNH", "JNJ", "AVGO", "ORCL", "CRM", "CSCO", "ABT", "MRK", "PEP", "KO",
  "COST", "TMO", "MCD", "NKE", "ABBV", "DHR", "TXN", "NEE", "PM", "QCOM",
  "HON", "UNP", "LIN", "BMY", "AMGN", "LOW", "IBM", "SBUX", "GE", "CAT",
  "BA", "GS", "MS", "BLK", "C", "WFC", "AXP", "SCHW", "HOOD", "RBLX",
  "ARM", "SMCI", "SOFI", "MARA", "RIOT", "CLSK", "HUT", "BITF", "CRCL",
  "OXY", "SQ", "SHOP", "SE", "SNOW", "AFRM", "COINBASE", "MICROSTRATEGY",
  "SPOT", "TWTR", "PFE", "MRNA", "ZM", "DOCU", "ROKU", "SNAP", "BIDU", "JD", "PDD",
  "NIO", "XPEV", "LI", "BILI", "TME", "F", "GM", "RIVN", "LCID", "NKLA", "PLUG",
  // Tokenized public/private companies and Asian equities currently listed by
  // derivatives venues. Long names matter: unlike AAPL-style tickers they are
  // impossible to identify from a generic suffix.
  "SAMSUNG", "ANTHROPIC", "OPENAI", "SPACEX", "SPCX", "UNITREE", "FIGMA", "STRIPE",
  "SKHYNIX", "SKHY", "SNDK", "DELL", "RKLB", "AAOI", "MRVL", "NBIS", "CXMT",
  "XIAOMI", "TENCENT", "ALIBABA", "SONY", "TOYOTA", "TESLA", "NIULAI",
  "AVGOX", "AAPLX", "TSLAX", "NVDAX", "MSFTX", "AMZNX", "GOOGX", "GOOGLX", "METAX",
  "NFLXX", "COINX", "MSTRX", "BACX", "AMDX", "INTCX", "PLTRX", "BABAX", "DISX",
  "PYPLX", "UBERX", "SPYX", "QQQX", "ARMX", "SMCX", "HOODX",
  "TQQQ", "SQQQ", "SPXL", "SPXS", "SOXL", "SOXS", "UVXY", "SVXY", "VXX",
  "FAS", "FAZ", "LABU", "LABD", "NUGT", "DUST", "JNUG", "JDST",
  "XAU", "XAG", "GOLD", "SILVER", "OIL", "WTI", "BRENT", "COPPER", "NATGAS",
  "DOW", "SPX", "NDX", "US30", "US500", "USTECH", "DE40", "UK100", "JP225",
  "XAUT", "PAXG",
]);

function checkSingleStock(token) {
  if (!token) return false;
  if (token.endsWith("STOCK")) return true;
  if (KNOWN_STOCK_BASES.has(token) || DYNAMIC_NON_CRYPTO_BASES.has(token)) return true;

  let inner = token;
  if ((token.startsWith("R") || token.startsWith("X")) && token.length >= 4) {
    inner = token.slice(1);
    if (KNOWN_STOCK_BASES.has(inner) || DYNAMIC_NON_CRYPTO_BASES.has(inner)) return true;
  }

  for (const suffix of ["STOCK", "ON", "X", "B", "G", "M", "I"]) {
    if (inner.endsWith(suffix) && DYNAMIC_NON_CRYPTO_BASES.has(inner.slice(0, -suffix.length))) return true;
  }

  for (const root of KNOWN_STOCK_BASES) {
    if (root.length >= 3) {
      if (inner === root) return true;
      if (inner.startsWith(root) && inner.length <= root.length + 3) {
        const rem = inner.slice(root.length);
        if (["B", "X", "ON", "G", "M", "I", "STOCK"].includes(rem)) return true;
      }
    }
  }
  return false;
}

function isStockOrEquityBase(base, sym) {
  if (!base && !sym) return false;
  let s = String(sym || base).toUpperCase();
  const colonIdx = s.indexOf(":");
  if (colonIdx >= 0) s = s.slice(colonIdx + 1);

  s = s.replace(/_SPOT$/i, "")
    .replace(/[-_]?(SWAP|PERP)$/i, "")
    .replace(/[-_]?(USDT|USDC|BUSD|DAI|USD)$/i, "")
    .replace(/[-_]/g, "");

  const b = String(base || "").toUpperCase().replace(/[-_/]?(USDT|USD|PERP|SPOT)$/i, "").replace(/[-_]/g, "");

  return checkSingleStock(s) || checkSingleStock(b);
}

function isLeveragedOrSyntheticBase(base) {
  if (!base) return false;
  if (isStockOrEquityBase(base)) return true;
  return /(?:UP|DOWN|BULL|BEAR|HALF|HEDGE|[235]L|[235]S)$/i.test(String(base || ""));
}

function isTradableBase(base, sym, metadata) {
  if (!base) return false;
  if (metadata && (metadata.isRwa === true || String(metadata.isRwa).toUpperCase() === "YES" ||
      String(metadata.isReality).toLowerCase() === "yes" || metadata.assetClass === "equity")) return false;
  const upper = String(base).toUpperCase();
  if (EXCLUDED_BASES.has(upper)) return false;
  if (DYNAMIC_NON_CRYPTO_BASES.has(upper)) return false;
  if (isLeveragedOrSyntheticBase(upper)) return false;
  if (isStockOrEquityBase(upper, sym)) return false;
  return true;
}

/**
 * Canonical asset identity across venues, plus the price scale that identity
 * implies.
 *
 * The same asset is listed under different tickers: `1000PEPE` on BN/BB/BX,
 * `PEPE` on OX/GT/MX/KC/AD/HT/BG, `kPEPE` on HL; `BTC` everywhere except KuCoin,
 * which uses `XBT`. 26 assets are split this way.
 *
 * That matters because both the per-coin output cap and cross-exchange confluence
 * key on the base. Unnormalised, confluence — described as the strongest signal a
 * multi-venue scanner can produce — silently never fired for exactly the meme
 * coins where several venues quote the same level, while the per-coin cap let one
 * asset occupy three slots per naming variant.
 *
 * The multiplier matters just as much: `1000PEPE` at 0.008 and `PEPE` at
 * 0.000008 are the same price, so comparing raw prices across the group would
 * never find a shared level even after the names match.
 *
 * @returns {{base:string, scale:number}} canonical base, and the factor that
 *   converts a quoted price on this ticker into a price on one unit of the asset
 */
function canonicalAsset(base) {
  const raw = String(base || "").replace(/[-_]/g, "");
  if (!raw) return { base: "", scale: 1 };

  // Hyperliquid's 1000x marker is a *lowercase* `k` on an otherwise uppercase
  // ticker: kPEPE, kBONK, kSHIB, kFLOKI, kNEIRO. This has to be tested before
  // upper-casing, because KDA, KSM, KAS, KAVA and KNC are all real assets whose
  // names simply begin with K — stripping that K would merge them into DA, SM,
  // AS, AVA and NC.
  const hlKilo = /^k[A-Z0-9]{2,}$/.test(raw);

  let b = raw.toUpperCase();
  // Quote-currency suffix, if a caller passed a full symbol.
  b = b.replace(/(USDTM|USDT|USDC|BUSD|DAI|USD)$/i, "");

  let scale = 1;
  const numeric = /^(1000000|100000|10000|1000|100|10)(?=[A-Z])/.exec(b);
  if (numeric) {
    scale = 1 / Number(numeric[1]);
    b = b.slice(numeric[1].length);
  } else if (hlKilo) {
    scale = 1 / 1000;
    b = b.slice(1);
  }

  if (b === "XBT") b = "BTC";
  return { base: b, scale };
}

/** Canonical base only, for callers that do not need the price scale. */
function canonicalBase(base) {
  return canonicalAsset(base).base;
}

// ═══ Math helpers ════════════════════════════════════════════════════════════

function clamp(value, lo, hi) {
  return value < lo ? lo : (value > hi ? hi : value);
}

/** Linear 0..1 normalisation between a floor and a ceiling. */
function norm(value, lo, hi) {
  if (!Number.isFinite(value)) return 0;
  if (hi <= lo) return 0;
  return clamp((value - lo) / (hi - lo), 0, 1);
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) * 0.5;
}

function medianSorted(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  const m = n >> 1;
  return n & 1 ? sorted[m] : (sorted[m - 1] + sorted[m]) * 0.5;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return quantileSorted(s, q);
}

function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return 0;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

/**
 * Robust location/scale of a set of sizes in log space.
 *
 * No longer part of the detection path — the engine gates on locally expected
 * liquidity instead of a book-wide Z-score, because a Z-score over clusters is
 * only meaningful when "cluster" means the same thing on every instrument, and it
 * did not. Kept and exported because it is a correct, well-tested robust
 * estimator that the diagnostics and the legacy history ranker still use.
 *
 * Log space because order-book sizes are heavy tailed; MAD/IQR because a wall
 * must not inflate the very statistic that is supposed to detect it.
 */
function calculateRobustBookStats(bins) {
  const values = [];
  for (const bin of bins || []) {
    const usd = Number(bin && bin.usd);
    if (Number.isFinite(usd) && usd > 0) values.push(usd);
  }
  if (!values.length) return { center: 0, sigma: 1, values, q95: 0, q97: 0, count: 0 };
  values.sort((a, b) => a - b);

  const logs = values.map(v => Math.log1p(v));
  const center = medianSorted(logs.slice().sort((a, b) => a - b));
  const deviations = logs.map(v => Math.abs(v - center)).sort((a, b) => a - b);
  const mad = medianSorted(deviations);
  const sortedLogs = logs.slice().sort((a, b) => a - b);
  const iqrSigma = (quantileSorted(sortedLogs, 0.75) - quantileSorted(sortedLogs, 0.25)) / 1.349;

  return {
    center,
    sigma: Math.max(0.14, mad * 1.4826, iqrSigma),
    values,
    q95: quantileSorted(values, 0.95),
    q97: quantileSorted(values, 0.97),
    count: values.length,
  };
}

function percentileRank(sortedValues, value) {
  let lo = 0;
  let hi = sortedValues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedValues[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return sortedValues.length ? lo / sortedValues.length : 0;
}

function lowerBound(levels, price) {
  let lo = 0;
  let hi = levels.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (levels[mid].price < price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(levels, price) {
  let lo = 0;
  let hi = levels.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (levels[mid].price <= price) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ═══ Density extraction ══════════════════════════════════════════════════════

/**
 * Reference flow for a symbol: how many USD trade through it per minute.
 * `v` is 24h quote volume, so /1440 gives USD per minute. Used to express a
 * density as "minutes of traded volume", the single most transferable measure
 * of whether a resting order is actually big.
 */
function volumePerMinute(coin) {
  const vol = Number(coin && coin.v) || 0;
  return vol > 0 ? vol / 1440 : 0;
}

/**
 * Tick size, estimated from the book.
 *
 * The 10th percentile of consecutive price gaps, not the median: books have
 * empty grid slots, so the median gap on a sparse book is a multiple of the real
 * tick. The 10th percentile lands on the true increment as long as at least a
 * tenth of the neighbouring pairs are adjacent, which holds for every venue.
 */
function estimateTickSize(levels) {
  if (!levels || levels.length < 3) return 0;
  const gaps = [];
  for (let i = 1; i < levels.length; i++) {
    const gap = levels[i].price - levels[i - 1].price;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  const tick = gaps[Math.floor(gaps.length * 0.10)];
  return Number.isFinite(tick) && tick > 0 ? tick : gaps[0];
}

/**
 * Locally expected level size.
 *
 * Segments of a fixed level count, each contributing its mean. See the note on
 * BASELINE_SEGMENT_LEVELS for why both of those choices are load-bearing: a
 * fractional segment count makes the required wall multiple depend on the venue's
 * depth, and a median baseline is usually the exchange's minimum order size.
 *
 * This inclusive mean is used for *seeding* — deciding which level is unusual
 * enough to start a cluster. Final dominance uses the exclusive form below.
 *
 * @returns {{mean:Float64Array, total:Float64Array, count:Int32Array, segment:Int32Array}}
 */
function localBaseline(levels, segmentLevels = BASELINE_SEGMENT_LEVELS) {
  const n = levels.length;
  const mean = new Float64Array(n);
  const total = new Float64Array(n);
  const count = new Int32Array(n);
  const segment = new Int32Array(n);
  if (!n) return { mean, total, count, segment };

  const per = Math.max(BASELINE_MIN_LEVELS, Math.max(1, segmentLevels));

  // Segment boundaries. A trailing remainder shorter than BASELINE_MIN_LEVELS is
  // merged into the previous segment: its mean is computed from too few levels to
  // be a reliable "normal", and if the wall happens to land in it the wall becomes
  // its own baseline and disappears.
  const bounds = [];
  for (let start = 0; start < n; start += per) {
    bounds.push([start, Math.min(n, start + per)]);
  }
  if (bounds.length > 1) {
    const last = bounds[bounds.length - 1];
    if (last[1] - last[0] < BASELINE_MIN_LEVELS) {
      bounds[bounds.length - 2][1] = last[1];
      bounds.pop();
    }
  }

  for (let s = 0; s < bounds.length; s++) {
    const [start, end] = bounds[s];
    let sum = 0;
    for (let i = start; i < end; i++) sum += levels[i].usd;
    const k = Math.max(1, end - start);
    const m = sum / k;
    for (let i = start; i < end; i++) {
      mean[i] = m;
      total[i] = sum;
      count[i] = k;
      segment[i] = s;
    }
  }
  return { mean, total, count, segment };
}

/**
 * Dominance of a cluster: its average level size versus the average size of the
 * segment levels it does *not* occupy.
 *
 * Excluding the cluster's own levels from its own baseline matters more than it
 * looks. With an inclusive mean a cluster of `k` levels is mathematically capped
 * at `segmentLevels / k` however large it is — so with a 40-level segment a
 * four-level shelf could never exceed 10x and an 8x gate rejected a genuine
 * $800k shelf outright. Measured on the same live books, switching to the
 * exclusive form raised coverage from 85% to 95% and cut the cross-book spread of
 * the strongest wall's dominance from 12.3x to 3.7x.
 *
 * Returns 0 when the surrounding neighbourhood is too small to judge against.
 */
function clusterDominance(levels, lo, hi, baseline) {
  let clusterUsd = 0;
  // A cluster can straddle a segment boundary, so accumulate per segment.
  const bySegment = new Map();
  for (let i = lo; i <= hi; i++) {
    clusterUsd += levels[i].usd;
    const id = baseline.segment[i];
    let entry = bySegment.get(id);
    if (!entry) {
      entry = { usd: 0, k: 0, total: baseline.total[i], n: baseline.count[i] };
      bySegment.set(id, entry);
    }
    entry.usd += levels[i].usd;
    entry.k++;
  }

  let otherUsd = 0;
  let otherCount = 0;
  for (const entry of bySegment.values()) {
    otherUsd += Math.max(0, entry.total - entry.usd);
    otherCount += Math.max(0, entry.n - entry.k);
  }
  if (otherCount < BASELINE_MIN_NEIGHBOURS) return 0;

  const expectedPerLevel = otherUsd / otherCount;
  if (!(expectedPerLevel > 0)) return 0;
  const k = hi - lo + 1;
  return clusterUsd / (k * expectedPerLevel);
}

/**
 * Seed-and-grow density extraction.
 *
 * Every level whose size is at least SEED_MULT times the locally expected size
 * is a candidate seed. Seeds are taken strongest-first; each grows outward while
 * its neighbours are still at least GROW_MULT of expected and sit within
 * MAX_TICK_GAP ticks. Levels are claimed as they are absorbed, so nothing is
 * counted twice and two distinct walls never merge across a quiet stretch.
 *
 * Why this and not a fixed window: a window has to pick a width, and any width
 * expressed in price is a different number of levels on every instrument. Growth
 * from a seed lets the *data* decide how wide the shelf is — one level for a
 * single large order, four for a stacked shelf — while the tick-based gap limit
 * keeps unrelated liquidity out.
 *
 * @param {Array<{price:number,qty:number,usd:number}>} levels ascending by price
 * @param {number} tick estimated tick size
 * @param {string} side "bid" | "ask"
 * @param {number} bandSpan absolute price span of the scan band
 * @returns {Array} clusters with dominance already computed
 */
function extractClusters(levels, tick, side, bandSpan) {
  const n = levels ? levels.length : 0;
  if (n < 4) return [];

  const t = Number.isFinite(tick) && tick > 0 ? tick : estimateTickSize(levels);
  if (!(t > 0)) return [];

  const baseline = localBaseline(levels);
  const expectedPerLevel = baseline.mean;
  const maxSpan = Number.isFinite(bandSpan) && bandSpan > 0
    ? bandSpan * MAX_CLUSTER_BAND_SHARE
    : Infinity;
  const maxGap = t * MAX_TICK_GAP;

  const seeds = [];
  for (let i = 0; i < n; i++) {
    const expected = expectedPerLevel[i];
    if (expected > 0 && levels[i].usd >= expected * SEED_MULT) seeds.push(i);
  }
  if (!seeds.length) return [];
  seeds.sort((a, b) => levels[b].usd - levels[a].usd);

  const claimed = new Uint8Array(n);
  const clusters = [];

  for (const seed of seeds) {
    if (claimed[seed]) continue;

    let lo = seed;
    let hi = seed;
    // Grow down.
    while (lo - 1 >= 0 && !claimed[lo - 1]) {
      const prev = lo - 1;
      if (levels[lo].price - levels[prev].price > maxGap) break;
      if (!(expectedPerLevel[prev] > 0) || levels[prev].usd < expectedPerLevel[prev] * GROW_MULT) break;
      if (levels[hi].price - levels[prev].price > maxSpan) break;
      lo = prev;
    }
    // Grow up.
    while (hi + 1 < n && !claimed[hi + 1]) {
      const next = hi + 1;
      if (levels[next].price - levels[hi].price > maxGap) break;
      if (!(expectedPerLevel[next] > 0) || levels[next].usd < expectedPerLevel[next] * GROW_MULT) break;
      if (levels[next].price - levels[lo].price > maxSpan) break;
      hi = next;
    }

    let usd = 0;
    let qty = 0;
    let weighted = 0;
    let expected = 0;
    let peakUsd = 0;
    let peakPrice = levels[seed].price;
    for (let i = lo; i <= hi; i++) {
      claimed[i] = 1;
      const lv = levels[i];
      usd += lv.usd;
      qty += lv.qty;
      weighted += lv.price * lv.usd;
      expected += expectedPerLevel[i];
      if (lv.usd > peakUsd) { peakUsd = lv.usd; peakPrice = lv.price; }
    }
    if (!(usd > 0)) continue;

    clusters.push({
      side,
      usd,
      qty,
      orders: hi - lo + 1,
      peakUsd,
      peakPrice,
      price: weighted / usd,
      loPrice: levels[lo].price,
      hiPrice: levels[hi].price,
      // How many times the locally normal liquidity is resting here. This is the
      // headline number: "18x what this part of the book usually holds".
      // Measured against the neighbourhood the cluster does not occupy — see
      // `clusterDominance` for why that exclusion is essential.
      dominance: clusterDominance(levels, lo, hi, baseline),
      expectedUsd: expected,
      widthTicks: Math.max(1, Math.round((levels[hi].price - levels[lo].price) / t) + 1),
    });
  }

  return clusters.sort((a, b) => b.usd - a.usd);
}

/**
 * Composite significance in 0..1.
 *
 * Additive, not multiplicative. v4 multiplied its weighted signal sum by
 * `proximity * sample * granularity`, which put a hard ceiling on the achievable
 * score: on a book with fewer than 12 clusters the maximum possible significance
 * was 0.60, and for any realistic (non-maximal) signal combination it landed at
 * 0.15-0.37 — permanently below its own 0.40 gate. Here the context terms are
 * bounded bonuses and penalties, so a genuine wall can always clear the bar and
 * context only moves it up or down.
 *
 * Signals:
 *   dominance  - total size versus locally expected liquidity (the core measure)
 *   volMinutes - size in minutes of the coin's own traded flow (the trader's one)
 *   depthShare - share of the whole side's depth in the band (venue context)
 *   shape      - concentration: one big order beats a wide smear of ordinary ones
 *
 * The `volMinutes` ceiling is 20, not 120: on live books a wall on a major is
 * 0.1-0.5 minutes of flow while a micro-cap wall is 20-30, so a high ceiling
 * turns the signal into a proxy for "is this a small coin" and hands every
 * micro-cap a free 0.30. At 20 the signal still separates a genuinely large
 * resting order from an ordinary one within each liquidity class.
 */
function significanceOf(parts) {
  const dominanceFloor = Number.isFinite(Number(parts.minDominance))
    ? Number(parts.minDominance)
    : MIN_DOMINANCE;
  // Dominance now uses the exclusive baseline, so it is unbounded in principle;
  // live books put the strongest wall per instrument between 12x and 43x. The
  // ceiling is set well above that so a genuinely exceptional wall can still
  // separate itself, and log2 makes each doubling a constant step.
  const dominance = norm(Math.log2(Math.max(1, parts.dominance)), Math.log2(dominanceFloor), Math.log2(64));
  const volMinutes = norm(Math.log1p(parts.volMinutes), Math.log1p(0.05), Math.log1p(20));
  const depthShare = norm(parts.depthShare, 0.02, 0.35);

  // Concentration. `peakShare` is the largest single level's share of the
  // cluster; a wall that is one order is stronger evidence than the same dollars
  // smeared over twenty levels, which is ordinary book depth.
  const peakShare = clamp(Number(parts.peakShare) || 0, 0, 1);
  const shape = parts.aggregated
    // A venue that pre-merges levels cannot prove concentration either way, so it
    // gets the neutral value instead of a penalty it did not earn.
    ? 0.5
    : clamp(0.35 + 0.65 * peakShare, 0, 1);

  const raw =
    dominance * 0.44 +
    volMinutes * 0.24 +
    depthShare * 0.18 +
    shape * 0.14;

  // Proximity bonus, not a multiplier: a level 4.5 % away is real but not
  // actionable today, so it ranks lower — it is not disqualified.
  const proximity = 1 - norm(parts.distPct, 0.10, MAX_DIST_PCT);
  const score = raw * 0.86 + proximity * 0.14;

  // Aggregated venues get one modest, explicit haircut rather than having their
  // shape signal double-count against them.
  return clamp(parts.aggregated ? score * 0.94 : score, 0, 1);
}

/** 1..10 presentation rank derived from significance and confirmed persistence. */
function rankFromSignificance(significance, persistence) {
  const s = clamp(Number(significance) || 0, 0, 1);
  const p = clamp(Number(persistence) || 0, 0, 1);
  const blended = s * 0.82 + p * 0.18;
  if (blended < 0.20) return 2;
  if (blended < 0.28) return 3;
  if (blended < 0.36) return 4;
  if (blended < 0.45) return 5;
  if (blended < 0.55) return 6;
  if (blended < 0.66) return 7;
  if (blended < 0.77) return 8;
  if (blended < 0.88) return 9;
  return 10;
}

/** Backwards-compatible Z/percentile rank used by older cached records. */
function rankWallByStatistics(zScore, percentile) {
  const z = Number(zScore) || 0;
  const pct = Number(percentile) || 0;
  const pctFraction = pct > 1 ? pct / 100 : pct;
  // The v4 Z floor. Kept here, and only here, so history records written before
  // the engine stopped computing a Z-score still map onto a sensible rank.
  const LEGACY_MIN_Z = 1.9;
  const significance = clamp(
    norm(z, LEGACY_MIN_Z, 6.5) * 0.6 + norm(pctFraction, 0.70, 0.999) * 0.4,
    0,
    1
  );
  return rankFromSignificance(significance, 0.5);
}

// ═══ State ═══════════════════════════════════════════════════════════════════

/** ex -> Map(sym -> SymbolState) */
const symbolStates = new Map();
/** ex -> exchange runtime status */
const exchangeState = new Map();
/** stable wall id -> lifecycle record */
const wallTimeline = new Map();
let nextWallTimelineId = 1;

let detectedWalls = [];
let detectedMetadata = {
  walls: [],
  history: [],
  updatedAt: 0,
  scanId: 0,
  partial: true,
  exchangesReady: 0,
  exchangesTotal: EXCHANGES.length,
  exchangeStatuses: {},
};

let onUpdateCb = null;
let pollCounter = 0;
let engineStarted = false;

function getSymbolMap(ex) {
  let m = symbolStates.get(ex);
  if (!m) {
    m = new Map();
    symbolStates.set(ex, m);
  }
  return m;
}

function getSymbolState(ex, sym) {
  const m = getSymbolMap(ex);
  let st = m.get(sym);
  if (!st) {
    st = {
      ex,
      sym,
      levels: new Map(),   // levelKey -> tracked level
      walls: [],           // published densities for this symbol
      updatedAt: 0,
      nextDueAt: 0,
      lastPolledAt: 0,
      polls: 0,
      fails: 0,
      pulled: 0,
      filled: 0,
      faded: 0,
      inflight: false,
      lastMid: 0,
      emptyBooks: 0,      // consecutive responses with no levels at all
      parkedUntil: 0,     // set once a symbol proves it has no book to read
    };
    m.set(sym, st);
  }
  return st;
}

function getExchangeState(ex) {
  let st = exchangeState.get(ex);
  if (!st) {
    const profile = profileFor(ex);
    st = {
      ex,
      tokens: profile.budget,
      lastRefill: Date.now(),
      inflight: 0,
      status: "pending",
      error: null,
      updatedAt: 0,
      durationMs: 0,
      polls: 0,
      okPolls: 0,
      failPolls: 0,
      consecutiveFails: 0,
      cooldownUntil: 0,
      symbolsTotal: 0,
      symbolsCovered: 0,
      coverageCycles: 0,
      lastFullCoverageAt: 0,
      pendingUniverse: new Set(),
      lastLatencyMs: 0,
    };
    exchangeState.set(ex, st);
  }
  return st;
}

/**
 * Spoof rate for a symbol. Levels that vanish while price never came close are
 * pulled quotes; a venue/symbol that does this constantly gets its densities
 * discounted. This is measured, not assumed, so honest books are not punished.
 *
 * Four resolved lifecycles is enough evidence to act on: four consecutive pulls
 * with zero fills is already a clear pattern, and waiting longer means the first
 * wave of spoofed levels is published at full strength.
 */
function pullRateOf(st) {
  const resolved = st.pulled + st.filled + st.faded;
  if (resolved < 4) return 0.25; // neutral prior until there is evidence
  return st.pulled / resolved;
}

// ═══ Book analysis ═══════════════════════════════════════════════════════════

/**
 * Turn one raw order book into scored density candidates.
 * Pure: no I/O, no timers, no global mutation. This is the unit under test.
 */
function analyzeBook(input) {
  const { ex, coin, bids, asks } = input;
  const profile = profileFor(ex);
  const qualityProfile = qualityProfileFor(ex);
  const aggregated = input.aggregated !== undefined ? input.aggregated : profile.aggregated;

  const rawBids = Array.isArray(bids) ? bids : [];
  const rawAsks = Array.isArray(asks) ? asks : [];
  if (!rawBids.length && !rawAsks.length) return null;

  const base = String(coin && coin.base || "").toUpperCase();
  const sym = String(coin && coin.sym || "");
  if (!base || !sym) return null;
  if (!isTradableBase(base, sym, coin)) return null;

  const cleanBids = rawBids
    .map(l => ({ price: Number(l.price), qty: Number(l.qty) || 0, usd: Number(l.usd) }))
    .filter(l => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.usd) && l.usd > 0)
    .sort((a, b) => a.price - b.price);
  const cleanAsks = rawAsks
    .map(l => ({ price: Number(l.price), qty: Number(l.qty) || 0, usd: Number(l.usd) }))
    .filter(l => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.usd) && l.usd > 0)
    .sort((a, b) => a.price - b.price);

  const bestBid = cleanBids.length ? cleanBids[cleanBids.length - 1].price : 0;
  const bestAsk = cleanAsks.length ? cleanAsks[0].price : 0;

  // Mid from the book itself. The ticker price arrives over a separate WS and
  // can lag or lead the book by enough to shift every distance measurement.
  let mid;
  if (bestBid > 0 && bestAsk > 0 && bestAsk >= bestBid) mid = (bestBid + bestAsk) / 2;
  else mid = Number(coin.p) || bestBid || bestAsk;
  if (!Number.isFinite(mid) || mid <= 0) return null;

  const tickerPrice = Number(coin.p) || 0;
  // A book that disagrees with the ticker by >6% is stale or a wrong symbol map.
  if (tickerPrice > 0 && Math.abs(mid - tickerPrice) / tickerPrice > 0.06) return null;

  const spreadPct = bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / mid) * 100 : 0;

  const loBound = mid * (1 - MAX_DIST_PCT / 100);
  const hiBound = mid * (1 + MAX_DIST_PCT / 100);
  const bandBids = cleanBids.filter(l => l.price >= loBound && l.price < mid);
  const bandAsks = cleanAsks.filter(l => l.price <= hiBound && l.price > mid);

  const bidDepth = bandBids.reduce((sum, l) => sum + l.usd, 0);
  const askDepth = bandAsks.reduce((sum, l) => sum + l.usd, 0);

  const vpm = volumePerMinute(coin);
  const now = Number(input.now) || Date.now();
  const market = sym.endsWith("_SPOT") ? "spot" : "futures";

  // One tick estimate for the whole instrument. Both sides quote on the same
  // grid, and the combined sample is more robust than either side alone.
  const tick = estimateTickSize(cleanBids.length >= cleanAsks.length ? cleanBids : cleanAsks)
    || estimateTickSize(cleanBids.length >= cleanAsks.length ? cleanAsks : cleanBids);

  const candidates = [];

  const runSide = (levels, side, sideDepth) => {
    if (levels.length < 4) return;
    // The band the levels actually span, not the theoretical 5 %: venues return
    // wildly different depths and a cluster must not be allowed to swallow a
    // fixed fraction of a band it cannot even see.
    const bandSpan = levels[levels.length - 1].price - levels[0].price;
    const clusters = extractClusters(levels, tick, side, bandSpan);
    if (!clusters.length) return;

    // Percentile of this cluster among the side's clusters. Diagnostic only —
    // nothing gates on it — but it is what the tooltip shows and what history
    // records carry.
    const clusterUsd = clusters.map(c => c.usd).sort((a, b) => a - b);

    for (const cluster of clusters) {
      const distPct = (Math.abs(cluster.price - mid) / mid) * 100;
      if (distPct < MIN_DIST_PCT || distPct > MAX_DIST_PCT) continue;
      if (cluster.usd < MIN_ABS_USD) continue;

      const coinVol = Number(coin && coin.v) || 0;
      const dominance = cluster.dominance;
      const depthShare = sideDepth > 0 ? cluster.usd / sideDepth : 0;
      const volMinutes = vpm > 0 ? cluster.usd / vpm : 0;
      const peakShare = cluster.usd > 0 ? cluster.peakUsd / cluster.usd : 0;

      // One structural gate: "this is N times the liquidity this stretch of book
      // normally holds". Scale free, and the only measure that behaved
      // comparably across the whole live volume curve.
      //
      // `volMinutes` is deliberately *not* a structural gate — see MIN_VOL_MINUTES.
      // It contributes to the score and rejects only liquidity that is irrelevant
      // even for its own instrument.
      if (dominance < qualityProfile.minDominance) continue;
      if (vpm > 0 && volMinutes < MIN_VOL_MINUTES) continue;

      const significance = significanceOf({
        dominance,
        depthShare,
        volMinutes,
        peakShare,
        distPct,
        aggregated,
        minDominance: qualityProfile.minDominance,
      });
      if (significance < qualityProfile.minSignificance) continue;

      const percentile = percentileRank(clusterUsd, cluster.usd);
      const wallTier = classifyWallTier(cluster.usd, base, coinVol, ex);

      candidates.push({
        base,
        ex,
        sym,
        side,
        market,
        price: cluster.price,
        peakPrice: cluster.peakPrice,
        loPrice: cluster.loPrice,
        hiPrice: cluster.hiPrice,
        S: cluster.usd,
        qty: cluster.qty,
        count: cluster.orders,
        tier: wallTier,
        sizeType: wallTier,
        // Retained for the frontend and the lifecycle residual probe, which both
        // want the shelf's width as a percentage of price.
        widthPct: mid > 0 ? ((cluster.hiPrice - cluster.loPrice) / mid) * 100 : 0,
        widthTicks: cluster.widthTicks,
        tick,
        pct: +distPct.toFixed(4),
        // `relSize` is the frontend's legacy fallback for rank. Dominance is the
        // natural replacement: both are "how many times bigger than normal".
        relSize: +dominance.toFixed(1),
        percentile: +(percentile * 100).toFixed(1),
        dominance: +dominance.toFixed(2),
        expectedUsd: +cluster.expectedUsd.toFixed(2),
        peakShare: +peakShare.toFixed(3),
        depthShare: +depthShare.toFixed(4),
        volMinutes: +volMinutes.toFixed(2),
        significance: +significance.toFixed(4),
        mid,
        spreadPct: +spreadPct.toFixed(4),
        bidDepth,
        askDepth,
        observedAt: now,
      });
    }
  };

  runSide(bandBids, "bid", bidDepth);
  runSide(bandAsks, "ask", askDepth);

  return {
    ex,
    sym,
    base,
    market,
    mid,
    bestBid,
    bestAsk,
    spreadPct,
    bidDepth,
    askDepth,
    levelsBid: bandBids.length,
    levelsAsk: bandAsks.length,
    volumePerMinute: vpm,
    tick,
    candidates,
    observedAt: now,
    bandLow: loBound,
    bandHigh: hiBound,
    // Kept so the lifecycle stage can measure what is left at a level that no
    // longer qualifies as a density. Without it "gone" and "shrunk" are
    // indistinguishable, which is exactly how spoofs get counted as fills.
    bandLevels: { bid: bandBids, ask: bandAsks },
  };
}

/**
 * USD still resting at `price` on the given side, within the tracked level's own
 * width plus a small tick margin.
 *
 * Measured in ticks rather than a percentage of price, for the same reason as
 * everything else in the detector: a 0.06 % probe spans 600 ticks on BTC and one
 * tick on a cheap coin, so on majors it summed a large slice of the book and
 * every disappearing level looked "still mostly there".
 */
function residualUsdNear(analysis, side, price, widthPct) {
  const levels = analysis && analysis.bandLevels && analysis.bandLevels[side];
  if (!levels || !levels.length || !Number.isFinite(price) || price <= 0) return 0;
  const tick = Number(analysis.tick) > 0 ? Number(analysis.tick) : estimateTickSize(levels);
  const byWidth = Number.isFinite(widthPct) && widthPct > 0 ? price * (widthPct / 100) * 0.5 : 0;
  const byTicks = tick > 0 ? tick * MAX_TICK_GAP : 0;
  const half = Math.max(byWidth, byTicks, price * 1e-6);
  const from = lowerBound(levels, price - half);
  const to = upperBound(levels, price + half);
  let usd = 0;
  for (let i = from; i < to; i++) usd += levels[i].usd;
  return usd;
}

// ═══ Lifecycle tracking ══════════════════════════════════════════════════════

let ingestSeq = 0;

/**
 * Find the tracked level a fresh candidate belongs to.
 *
 * Matching is by price proximity, never by an exact price key: a cluster's
 * volume-weighted price legitimately drifts by a tick or two as the liquidity
 * around it changes. Keying on the exact price made every poll look like a
 * brand-new level, which destroyed confirmations, absorption and refill
 * tracking — the three things that separate a real level from a spoof.
 *
 * The tolerance is in *ticks*. With a percentage tolerance (v4 used 0.07 % of
 * price = 539 BTC ticks) every cluster on a major matched every other cluster,
 * so identity hopped between neighbouring shelves on every poll, `observations`
 * never accumulated past 1, and the confirmation gate blocked the whole
 * instrument permanently.
 */
function matchTrackedLevel(state, candidate, token) {
  let best = null;
  let bestDist = Infinity;
  const tick = Number(candidate.tick) > 0 ? Number(candidate.tick) : 0;
  // Fall back to a tight percentage only when the tick is unknown.
  const tol = tick > 0 ? tick * MATCH_TOL_TICKS : candidate.price * 0.0005;
  for (const level of state.levels.values()) {
    if (level.claimToken === token) continue;
    if (level.side !== candidate.side || level.market !== candidate.market) continue;
    const ref = Number(level.lastPrice) || Number(level.price) || 0;
    if (!(ref > 0)) continue;
    const dist = Math.abs(ref - candidate.price);
    if (dist <= tol && dist < bestDist) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Persistence 0..1 from confirmed observations and continuous lifetime.
 * Anti-spoof: a density has to be *seen again in a later poll* to gain weight.
 * One-shot appearances stay low no matter how large they are.
 */
function persistenceOf(level, now) {
  const confirmations = Math.max(0, (level.observations || 1) - 1);
  const lifeMs = Math.max(0, (level.lastSeenAt || now) - (level.firstSeenAt || now));
  const byCount = norm(confirmations, 0, 6);
  const byTime = norm(lifeMs, 0, 6 * 60 * 1000);
  const refillBonus = level.refills > 0 ? 0.12 : 0;
  return clamp(byCount * 0.55 + byTime * 0.45 + refillBonus, 0, 1);
}

/**
 * Fold one fresh book analysis into the symbol's tracked levels.
 *
 * Anti-spoof classification happens here, and it is only possible because we
 * hold the fresh book: when a tracked level is absent from the new candidate
 * set we look at what is physically left at that price.
 *   filled - price traded into it and the liquidity is gone   -> real
 *   faded  - shrank but a meaningful remainder still rests    -> real, weakening
 *   pulled - price never came close yet it vanished           -> spoof
 */
function updateSymbolLevels(state, analysis, now) {
  const token = ++ingestSeq;
  const tracked = [];

  for (const candidate of analysis.candidates) {
    let level = matchTrackedLevel(state, candidate, token);

    if (!level) {
      level = {
        key: `lvl-${state.ex}-${state.sym}-${token}-${tracked.length}`,
        side: candidate.side,
        market: candidate.market,
        firstSeenAt: now,
        lastSeenAt: now,
        observations: 1,
        misses: 0,
        peakUsd: candidate.S,
        firstUsd: candidate.S,
        minUsdSincePeak: candidate.S,
        refills: 0,
        peakSignificance: candidate.significance,
        touched: false,
        closestApproachPct: candidate.pct,
      };
      state.levels.set(level.key, level);
    } else {
      level.observations++;
      level.lastSeenAt = now;
      level.misses = 0;
      if (candidate.S > level.peakUsd) level.peakUsd = candidate.S;
      // Refill detection: the level was eaten down and then restored. Real
      // defended levels refill; spoofs simply disappear.
      if (candidate.S < level.minUsdSincePeak) level.minUsdSincePeak = candidate.S;
      if (level.minUsdSincePeak < level.peakUsd * REFILL_DIP_RATIO &&
          candidate.S > level.minUsdSincePeak * 1.25) {
        level.refills++;
        level.minUsdSincePeak = candidate.S;
      }
      if (candidate.significance > level.peakSignificance) level.peakSignificance = candidate.significance;
    }

    level.claimToken = token;
    if (candidate.pct < level.closestApproachPct) level.closestApproachPct = candidate.pct;
    if (candidate.pct <= TOUCH_PCT) level.touched = true;
    level.lastUsd = candidate.S;
    level.lastPrice = candidate.price;
    level.lastWidthPct = candidate.widthPct;

    tracked.push({ candidate, level });
  }

  // Resolve levels that were not re-detected in this fresh book.
  for (const [key, level] of state.levels) {
    if (level.claimToken === token) continue;
    level.misses++;

    // The level's own measured width, falling back to a single tick's worth when
    // the width is unknown. `residualUsdNear` widens this to the tick-gap window.
    const residual = residualUsdNear(analysis, level.side, level.lastPrice, level.lastWidthPct || 0);
    const stillMostlyThere = level.peakUsd > 0 && residual >= level.peakUsd * RESIDUAL_ALIVE_RATIO;

    if (stillMostlyThere && level.misses < MAX_MISSES + 2) {
      // Shrank below the density bar but the liquidity is genuinely present.
      level.lastUsd = residual;
      continue;
    }
    if (level.misses < MAX_MISSES) continue;

    const approach = Number(level.closestApproachPct);
    const wasTouched = level.touched || (Number.isFinite(approach) && approach <= TOUCH_PCT * 2);
    if (wasTouched) {
      if (residual > 0) state.faded++;
      else state.filled++;
      level.endReason = residual > 0 ? "faded" : "filled";
    } else {
      state.pulled++;
      level.endReason = "pulled";
    }
    state.levels.delete(key);
    closeTimelineRecord(state.ex, state.sym, level, now);
  }

  // Bound memory for symbols with pathological books.
  if (state.levels.size > 400) {
    const stale = Array.from(state.levels.entries())
      .sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0))
      .slice(0, state.levels.size - 400);
    for (const [key] of stale) state.levels.delete(key);
  }

  return tracked;
}

/**
 * Final per-symbol scoring: apply lifecycle-derived context to raw significance,
 * then decide what is stable enough to publish.
 *
 * `score` is the number the UI sorts by; it stays on the 0..15 scale the old
 * `rtwi` used so existing frontend sorting and sprite caches behave.
 *
 * Two things happen here beyond scoring, and both exist to stop the map from
 * churning:
 *   1. A level must be confirmed by MIN_CONFIRMATIONS separate polls before it
 *      is published at all. Transient orders that momentarily look large are the
 *      main source of one-refresh appearances.
 *   2. The score is smoothed (EMA) and admission uses hysteresis, so a level
 *      hovering at the threshold does not blink on and off between refreshes.
 */
function scoreSymbolWalls(state, analysis, tracked, now) {
  const spoofPenalty = 1 - clamp(pullRateOf(state) - 0.25, 0, 0.6) * 0.8;
  const imbalanceRef = analysis.bidDepth + analysis.askDepth;

  const walls = [];
  for (const { candidate, level } of tracked) {
    const qualityProfile = qualityProfileFor(candidate.ex);
    const persistence = persistenceOf(level, now);
    const eatenPct = level.peakUsd > 0
      ? clamp(1 - candidate.S / level.peakUsd, 0, 1)
      : 0;

    // Wide spreads mean the top of book is unreliable, so distance-based
    // significance is less trustworthy.
    const spreadPenalty = 1 - clamp((candidate.spreadPct - 0.05) / 1.5, 0, 0.35);
    const confirmed = clamp(0.55 + persistence * 0.45, 0, 1);
    const instant = clamp(candidate.significance * confirmed * spoofPenalty * spreadPenalty, 0, 1);

    // Smooth the quality across polls. The underlying book size fluctuates every
    // refresh; without this the score, rank and bubble size visibly twitch even
    // when the level itself is completely stable.
    const quality = Number.isFinite(level.smoothedQuality)
      ? level.smoothedQuality + (instant - level.smoothedQuality) * 0.35
      : instant;
    level.smoothedQuality = quality;

    // Confirmation gate: never publish a level seen only once.
    if (level.observations < qualityProfile.minConfirmations) continue;

    // Hysteresis: entering the map needs full quality, staying needs less.
    const bar = level.published
      ? qualityProfile.minQuality * KEEP_QUALITY_RATIO
      : qualityProfile.minQuality;
    if (quality < bar) {
      level.published = false;
      continue;
    }
    const coinVol = Number(state.coin && state.coin.v) || 0;
    const tierInfo = getTierThresholds(candidate.base, coinVol, candidate.ex);
    if (candidate.S < tierInfo.minFloor) {
      level.published = false;
      continue;
    }

    const imbalance = imbalanceRef > 0
      ? (analysis.bidDepth - analysis.askDepth) / imbalanceRef
      : 0;

    const wallTier = candidate.tier || classifyWallTier(candidate.S, candidate.base, coinVol, candidate.ex);

    walls.push({
      base: candidate.base,
      ex: candidate.ex,
      sym: candidate.sym,
      side: candidate.side,
      market: candidate.market,
      price: candidate.price,
      S: candidate.S,
      wallK: Math.round(candidate.S / 1000),
      tier: wallTier,
      sizeType: wallTier,
      pct: candidate.pct,
      // `rtwi` is retained as the frontend's sort/size key.
      rtwi: +(quality * 15).toFixed(2),
      score: +(quality * 15).toFixed(2),
      significance: +quality.toFixed(4),
      rawSignificance: candidate.significance,
      relSize: candidate.relSize,
      z: candidate.z,
      percentile: candidate.percentile,
      dominance: candidate.dominance,
      depthShare: candidate.depthShare,
      volMinutes: candidate.volMinutes,
      count: candidate.count,
      qty: candidate.qty,
      widthPct: +candidate.widthPct.toFixed(3),
      priceLow: candidate.loPrice,
      priceHigh: candidate.hiPrice,
      mid: candidate.mid,
      spreadPct: candidate.spreadPct,
      bookImbalance: +imbalance.toFixed(3),
      rank: rankFromSignificance(quality, persistence),
      persistence: +persistence.toFixed(3),
      confirmations: Math.max(1, level.observations),
      refills: level.refills,
      touched: !!level.touched,
      eatenPct: +(eatenPct * 100).toFixed(1),
      peakUsd: level.peakUsd,
      maxSizeUsd: level.peakUsd,
      pullRate: +pullRateOf(state).toFixed(3),
      firstSeenAt: level.firstSeenAt,
      lastSeenAt: level.lastSeenAt,
      lifeMs: Math.max(0, level.lastSeenAt - level.firstSeenAt),
      age: Math.round(Math.max(0, level.lastSeenAt - level.firstSeenAt) / 1000),
      qualityScore: +(quality * 100).toFixed(1),
      // The snapshot may honour the lifecycle hysteresis only for a wall that
      // previously cleared the strict entry bar.
      qualityAdmitted: true,
      active: true,
      updatedAt: now,
      levelKey: level.key,
    });
  }

  walls.sort((a, b) => b.score - a.score);
  return walls;
}

// ═══ Timeline (history) ══════════════════════════════════════════════════════

function timelineKey(ex, sym, level) {
  return `${ex}|${sym}|${level.key}`;
}

function upsertTimeline(ex, sym, walls, now) {
  for (const wall of walls) {
    const key = timelineKey(ex, sym, { key: wall.levelKey });
    let record = wallTimeline.get(key);
    if (!record) {
      record = {
        id: `wall-${nextWallTimelineId++}`,
        key,
        ex,
        sym,
        base: wall.base,
        side: wall.side,
        market: wall.market,
        startedAt: wall.firstSeenAt || now,
        observations: 0,
        maxSizeUsd: 0,
        maxScore: 0,
        active: true,
        endedAt: null,
        endReason: null,
      };
      wallTimeline.set(key, record);
    }
    record.active = true;
    record.endedAt = null;
    record.endReason = null;
    record.base = wall.base;
    record.price = wall.price;
    record.S = wall.S;
    record.wallK = wall.wallK;
    record.rtwi = wall.rtwi;
    record.score = wall.score;
    record.rank = wall.rank;
    record.pct = wall.pct;
    record.relSize = wall.relSize;
    record.lastSeenAt = wall.lastSeenAt || now;
    record.maxSizeUsd = Math.max(record.maxSizeUsd, wall.S);
    record.maxScore = Math.max(record.maxScore, wall.score);
    record.observations++;
    wall.wallId = record.id;
  }
}

function closeTimelineRecord(ex, sym, level, now) {
  const record = wallTimeline.get(timelineKey(ex, sym, level));
  if (!record || !record.active) return;
  record.active = false;
  record.endedAt = now;
  record.endReason = level.endReason || "removed";
}

function getWallHistorySnapshot(now = Date.now()) {
  for (const [key, record] of wallTimeline) {
    if (!record.active && record.endedAt && now - record.endedAt > HISTORY_TTL_MS) wallTimeline.delete(key);
  }
  if (wallTimeline.size > HISTORY_LIMIT * 3) {
    const drop = Array.from(wallTimeline.entries())
      .filter(([, r]) => !r.active)
      .sort((a, b) => (a[1].endedAt || 0) - (b[1].endedAt || 0))
      .slice(0, wallTimeline.size - HISTORY_LIMIT * 2);
    for (const [key] of drop) wallTimeline.delete(key);
  }

  return Array.from(wallTimeline.values())
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, HISTORY_LIMIT)
    .map(record => ({
      wallId: record.id,
      base: record.base,
      ex: record.ex,
      sym: record.sym,
      side: record.side,
      market: record.market,
      price: record.price,
      S: record.S || record.maxSizeUsd || 0,
      wallK: record.wallK || Math.round((record.maxSizeUsd || 0) / 1000),
      rtwi: record.rtwi || record.maxScore || 0,
      score: record.score || record.maxScore || 0,
      rank: record.rank || 0,
      pct: record.pct || 0,
      relSize: record.relSize || 0,
      firstSeenAt: record.startedAt,
      lastSeenAt: record.lastSeenAt,
      endedAt: record.endedAt,
      active: record.active,
      endReason: record.endReason || null,
      maxSizeUsd: record.maxSizeUsd || 0,
      observations: record.observations || 0,
    }));
}

// ═══ Snapshot assembly ═══════════════════════════════════════════════════════

/**
 * Merge densities that sit within CLUSTER_PCT of each other on the same
 * exchange/coin/side/market. Two adjacent shelves are one level to a trader.
 */
function clusterWalls(walls) {
  if (!Array.isArray(walls) || !walls.length) return [];
  const sorted = walls.slice().sort((a, b) => a.price - b.price);
  const out = [];
  let cur = { ...sorted[0], startPrice: sorted[0].price };

  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const gap = Math.abs(w.price - cur.startPrice) / cur.startPrice * 100;

    if (gap <= CLUSTER_PCT && w.side === cur.side) {
      const totalS = cur.S + w.S;
      // Volume-weighted price, so the merged level sits where the money is.
      cur.price = totalS > 0 ? (cur.price * cur.S + w.price * w.S) / totalS : cur.price;
      cur.pct = +(totalS > 0 ? (cur.pct * cur.S + w.pct * w.S) / totalS : cur.pct).toFixed(4);
      cur.S = totalS;
      cur.wallK = Math.round(totalS / 1000);
      cur.tier = classifyWallTier(totalS, cur.base, cur.v || 0, cur.ex);
      cur.sizeType = cur.tier;
      cur.count = (cur.count || 1) + (w.count || 1);
      cur.rtwi = Math.max(cur.rtwi || 0, w.rtwi || 0);
      cur.score = Math.max(cur.score || 0, w.score || 0);
      cur.significance = Math.max(cur.significance || 0, w.significance || 0);
      cur.relSize = Math.max(cur.relSize || 0, w.relSize || 0);
      cur.rank = Math.max(cur.rank || 0, w.rank || 0);
      cur.dominance = Math.max(cur.dominance || 0, w.dominance || 0);
      cur.volMinutes = (cur.volMinutes || 0) + (w.volMinutes || 0);
      cur.depthShare = (cur.depthShare || 0) + (w.depthShare || 0);
      cur.confirmations = Math.max(cur.confirmations || 0, w.confirmations || 0);
      cur.refills = Math.max(cur.refills || 0, w.refills || 0);
      cur.persistence = Math.max(cur.persistence || 0, w.persistence || 0);
      cur.peakUsd = (cur.peakUsd || 0) + (w.peakUsd || 0);
      cur.maxSizeUsd = (cur.maxSizeUsd || 0) + (w.maxSizeUsd || 0);
      // Recompute absorption against the merged peak; carrying either member's
      // percentage would misreport how much of the combined shelf is left.
      cur.eatenPct = cur.peakUsd > 0
        ? +clamp((1 - cur.S / cur.peakUsd) * 100, 0, 100).toFixed(1)
        : 0;
      cur.confluence = Math.max(cur.confluence || 1, w.confluence || 1);
      cur.firstSeenAt = Math.min(cur.firstSeenAt || Infinity, w.firstSeenAt || Infinity);
      cur.lastSeenAt = Math.max(cur.lastSeenAt || 0, w.lastSeenAt || 0);
      if (Number.isFinite(cur.firstSeenAt) && cur.firstSeenAt !== Infinity && cur.lastSeenAt) {
        cur.lifeMs = Math.max(0, cur.lastSeenAt - cur.firstSeenAt);
        cur.age = Math.round(cur.lifeMs / 1000);
      } else {
        cur.age = Math.max(cur.age || 0, w.age || 0);
      }
    } else {
      delete cur.startPrice;
      out.push(cur);
      cur = { ...w, startPrice: w.price };
    }
  }
  delete cur.startPrice;
  out.push(cur);
  return out;
}

/**
 * Cross-exchange confluence.
 *
 * The single most reliable signal a multi-venue scanner can produce: the same
 * price level defended on several independent order books cannot be one trader
 * spoofing. Walls are grouped by canonical asset and side, then by price
 * proximity across venues, and every member is boosted by how many venues and
 * how much total USD agree.
 *
 * Both the grouping key and the price comparison are normalised. Keyed on the raw
 * base, `1000PEPE` (Binance) and `PEPE` (OKX) were different assets; compared on
 * raw prices, 0.008 and 0.000008 were different levels. Either omission makes
 * confluence silently unreachable for the 26 assets whose ticker names differ
 * across venues — which is most of the meme coins where several books genuinely
 * do defend the same price.
 */
function applyConfluence(walls) {
  const byCoinSide = new Map();
  // Cache the canonical form: this runs over the whole snapshot on every publish.
  const normalised = new Map();
  const assetOf = (base) => {
    let a = normalised.get(base);
    if (!a) { a = canonicalAsset(base); normalised.set(base, a); }
    return a;
  };

  for (const w of walls) {
    const asset = assetOf(w.base);
    const key = `${asset.base}|${w.side}`;
    if (!byCoinSide.has(key)) byCoinSide.set(key, []);
    byCoinSide.get(key).push(w);
  }

  for (const group of byCoinSide.values()) {
    if (group.length < 2) {
      for (const w of group) {
        w.confluence = 1;
        w.confluenceUsd = w.S;
        w.confluenceExchanges = [w.ex];
      }
      continue;
    }

    // Compare on the price of one unit of the asset, so a 1000x contract
    // multiplier does not hide a shared level.
    const unitPrice = new Map();
    for (const w of group) unitPrice.set(w, w.price * assetOf(w.base).scale);
    group.sort((a, b) => unitPrice.get(a) - unitPrice.get(b));

    let i = 0;
    while (i < group.length) {
      const cluster = [group[i]];
      const anchor = unitPrice.get(group[i]);
      let j = i + 1;
      while (j < group.length) {
        const spanPct = Math.abs(unitPrice.get(group[j]) - anchor) / anchor * 100;
        // Different venues never quote identical prices; allow a real band.
        if (spanPct > 0.25) break;
        cluster.push(group[j]);
        j++;
      }

      const exchanges = Array.from(new Set(cluster.map(w => w.ex)));
      const totalUsd = cluster.reduce((sum, w) => sum + (Number(w.S) || 0), 0);
      const venues = exchanges.length;
      const boost = venues > 1 ? 1 + Math.min(0.45, (venues - 1) * 0.13) : 1;

      for (const w of cluster) {
        w.confluence = venues;
        w.confluenceUsd = totalUsd;
        w.confluenceExchanges = exchanges;
        if (venues > 1) {
          w.score = +(w.score * boost).toFixed(2);
          w.rtwi = w.score;
          w.significance = +clamp((w.significance || 0) * boost, 0, 1).toFixed(4);
          w.rank = Math.min(10, w.rank + (venues >= 4 ? 2 : 1));
        }
      }
      i = j;
    }
  }
  return walls;
}

/**
 * Deterministic snapshot builder. Production has no count target: admission is
 * exclusively evidence-based. The optional maxOutput argument and environment
 * fuse exist for deterministic tests and operational emergencies only.
 */
function buildWallSnapshot(allWalls, options = {}) {
  if (!Array.isArray(allWalls) || allWalls.length === 0) return [];

  const maxOutput = Number.isInteger(options.maxOutput) && options.maxOutput > 0 ? options.maxOutput : MAX_OUTPUT;
  const maxPerCoin = Number.isInteger(options.maxPerCoin) && options.maxPerCoin > 0 ? options.maxPerCoin : MAX_PER_COIN;
  const minScore = Number.isFinite(options.minScore)
    ? options.minScore
    : PUBLISH_MIN_SCORE_OVERRIDE;
  const reserveRatio = Number.isFinite(options.reserveRatio) ? options.reserveRatio : EX_RESERVE_RATIO;

  const validWalls = [];
  for (const w of allWalls) {
    if (!w || typeof w !== "object") continue;
    const price = Number(w.price);
    const S = Number(w.S);
    const pct = Number(w.pct);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(S) || S <= 0) continue;
    if (!Number.isFinite(pct) || pct < 0) continue;
    if (!w.base || typeof w.base !== "string") continue;
    if (!w.ex || typeof w.ex !== "string") continue;
    if (!w.sym || typeof w.sym !== "string") continue;
    if (w.side !== "bid" && w.side !== "ask") continue;
    if (!isTradableBase(w.base, w.sym, w)) continue;

    const score = Number.isFinite(Number(w.score)) ? Number(w.score) : Number(w.rtwi);
    if (!Number.isFinite(score)) continue;
    const venueScoreFloor = minScore === null
      ? qualityProfileFor(w.ex).minQuality * 15 * (w.qualityAdmitted ? KEEP_QUALITY_RATIO : 1)
      : minScore;
    if (score < venueScoreFloor) continue;

    const rank = Number(w.rank);
    if (Number.isFinite(rank) && rank > 0 && rank < 2) continue;

    const tierInfo = getTierThresholds(w.base, w.v || 0, w.ex);
    if (S < tierInfo.minFloor) continue;
    const wallTier = w.tier || classifyWallTier(S, w.base, w.v || 0, w.ex);

    validWalls.push({
      ...w,
      price,
      S,
      pct,
      score,
      tier: wallTier,
      sizeType: wallTier,
      rtwi: Number.isFinite(Number(w.rtwi)) ? Number(w.rtwi) : score,
      wallK: Math.round(S / 1000),
      market: w.market || (w.sym.endsWith("_SPOT") ? "spot" : "futures"),
    });
  }

  if (!validWalls.length) return [];

  const groups = new Map();
  for (const w of validWalls) {
    const k = `${w.ex}:${w.base}:${w.side}:${w.market}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }

  let clustered = [];
  for (const group of groups.values()) clustered.push(...clusterWalls(group));

  clustered = applyConfluence(clustered);
  clustered.sort((a, b) => b.score - a.score || b.S - a.S);

  // Per exchange+coin ladder cap, applied before allocation so the reserved
  // slots are spent on distinct levels rather than one noisy ladder.
  //
  // Keyed on the canonical base: otherwise `1000PEPE` and `PEPE` on the same
  // venue each got their own three slots, and an asset with three naming variants
  // could occupy nine.
  const coinCount = new Map();
  const eligible = [];
  for (const w of clustered) {
    const coinKey = `${w.ex}:${canonicalBase(w.base)}`;
    const cnt = coinCount.get(coinKey) || 0;
    if (cnt >= maxPerCoin) continue;
    coinCount.set(coinKey, cnt + 1);
    eligible.push(w);
  }

  if (eligible.length <= maxOutput) return eligible;

  const byExchange = new Map();
  for (const w of eligible) {
    if (!byExchange.has(w.ex)) byExchange.set(w.ex, []);
    byExchange.get(w.ex).push(w);
  }

  const selected = new Set();
  const out = [];
  const venues = Array.from(byExchange.keys());
  const reserved = Math.floor(maxOutput * clamp(reserveRatio, 0, 0.9));
  const perVenue = venues.length ? Math.max(1, Math.floor(reserved / venues.length)) : 0;

  // Pass 1: round-robin the reserved slice so every venue is represented.
  for (let slot = 0; slot < perVenue && out.length < maxOutput; slot++) {
    for (const ex of venues) {
      if (out.length >= maxOutput) break;
      const list = byExchange.get(ex);
      if (slot >= list.length) continue;
      const w = list[slot];
      if (selected.has(w)) continue;
      selected.add(w);
      out.push(w);
    }
  }

  // Pass 2: fill the rest strictly by score.
  for (const w of eligible) {
    if (out.length >= maxOutput) break;
    if (selected.has(w)) continue;
    selected.add(w);
    out.push(w);
  }

  out.sort((a, b) => b.score - a.score || b.S - a.S);
  return out;
}

/**
 * Full per-symbol pipeline for one fetched book: analyse, fold into the
 * lifecycle tracker, score, and record history. Returns the symbol's current
 * densities. Separated from the transport so the whole detection path can be
 * driven directly in tests without any network.
 */
function ingestBook(input) {
  const { ex, coin, bids, asks } = input;
  const now = Number(input.now) || Date.now();
  const st = getSymbolState(ex, String(coin.sym || ""));
  if (!st.coin) st.coin = coin;

  const analysis = analyzeBook({ ex, coin, bids, asks, now, aggregated: input.aggregated });
  if (!analysis) {
    st.walls = [];
    st.updatedAt = now;
    return [];
  }

  const tracked = updateSymbolLevels(st, analysis, now);
  const walls = scoreSymbolWalls(st, analysis, tracked, now);
  upsertTimeline(ex, st.sym, walls, now);
  st.walls = walls;
  st.lastMid = analysis.mid;
  st.updatedAt = now;
  return walls;
}

/** Test/diagnostic helper: lifecycle counters for one tracked symbol. */
function getSymbolDiagnostics(ex, sym) {
  const map = symbolStates.get(ex);
  const st = map && map.get(sym);
  if (!st) return null;
  return {
    ex,
    sym,
    polls: st.polls,
    fails: st.fails,
    filled: st.filled,
    faded: st.faded,
    pulled: st.pulled,
    pullRate: pullRateOf(st),
    trackedLevels: st.levels.size,
    walls: st.walls.length,
    updatedAt: st.updatedAt,
    emptyBooks: st.emptyBooks || 0,
    parkedUntil: st.parkedUntil || 0,
  };
}

/** Test helper: drop all tracked state for one symbol. */
function resetSymbolState(ex, sym) {
  const map = symbolStates.get(ex);
  if (map) map.delete(sym);
  for (const [key, record] of wallTimeline) {
    if (record.ex === ex && record.sym === sym) wallTimeline.delete(key);
  }
}

// ═══ Order book transport ════════════════════════════════════════════════════

/**
 * Fetch one order book and normalise it to `{ price, qty, usd }` levels.
 * `cs` is the contract multiplier: several venues quote size in contracts, and
 * ignoring it understates their books by orders of magnitude.
 */
/**
 * Venue error envelopes.
 *
 * Most of these APIs answer a rate limit, a delisted symbol or maintenance with
 * HTTP 200 and an error code in the body. The transport sees success, the parser
 * below finds no levels, and every cause surfaced as the same "empty book" —
 * which is how Bitget sat at 6-7% symbol coverage for twelve minutes while the
 * throttle never engaged, because `pollSymbol` cannot recognise a rate limit it
 * is never told about. Returning the venue's own code *and* message keeps that
 * detector working: it matches on /429|418|rate|weight|banned|too many/, and
 * every venue's throttle message carries one of those.
 */
const VENUE_ERROR = {
  BN: d => (d.code !== undefined && Number(d.code) < 0) ? `Binance ${d.code}: ${d.msg || ""}` : null,
  AD: d => (d.code !== undefined && Number(d.code) < 0) ? `Asterdex ${d.code}: ${d.msg || ""}` : null,
  BB: d => (d.retCode !== undefined && Number(d.retCode) !== 0) ? `Bybit ${d.retCode}: ${d.retMsg || ""}` : null,
  OX: d => (d.code !== undefined && String(d.code) !== "0") ? `OKX ${d.code}: ${d.msg || ""}` : null,
  BG: d => (d.code !== undefined && String(d.code) !== "00000") ? `Bitget ${d.code}: ${d.msg || ""}` : null,
  KC: d => (d.code !== undefined && String(d.code) !== "200000") ? `KuCoin ${d.code}: ${d.msg || ""}` : null,
  BX: d => (d.code !== undefined && Number(d.code) !== 0) ? `BingX ${d.code}: ${d.msg || ""}` : null,
  HT: d => (d.status && d.status !== "ok") ? `HTX ${d["err-code"] || ""}: ${d["err-msg"] || ""}` : null,
  MX: d => (d.success === false) ? `MEXC: ${d.message || d.msg || ""}` : null,
  // Gate and Hyperliquid have no success envelope: an error is a body that
  // carries a message and no book.
  GT: d => (!d.bids && !d.asks && (d.label || d.message)) ? `Gate ${d.label || ""}: ${d.message || ""}` : null,
  HL: d => (!d.levels && (d.error || d.message)) ? `Hyperliquid: ${d.error || d.message}` : null,
};

/** Throw the venue's own error instead of letting it look like a flat book. */
function assertVenueOk(ex, payload) {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    throw new Error(`${ex} empty response`);
  }
  const check = VENUE_ERROR[ex];
  const err = check ? check(payload) : null;
  if (err) throw new Error(err.trim().slice(0, 160));
}

async function fetchOB(ex, coin, apiFetch, deep, timeoutMs) {
  const sym = String(coin.sym || "");
  const isSpot = sym.endsWith("_SPOT");
  const cs = isSpot ? 1 : (Number(coin.cs) > 0 ? Number(coin.cs) : 1);
  const reqTimeout = timeoutMs || REQUEST_TIMEOUT_MS;
  const profile = profileFor(ex);
  const depth = deep ? profile.depthHot : profile.depthTail;

  let bids = [];
  let asks = [];

  const pair = (p, q, mult) => {
    const price = +p;
    const qty = +q * (mult === undefined ? 1 : mult);
    return { price, qty, usd: price * qty };
  };

  if (ex === "BN") {
    const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
    const base = isSpot ? "https://api.binance.com/api/v3" : "https://fapi.binance.com/fapi/v1";
    const d = await apiFetch(`${base}/depth?symbol=${realSym}&limit=${depth}`, reqTimeout, 0);
    assertVenueOk(ex, d);
    if (d.bids) bids = d.bids.map(([p, q]) => pair(p, q));
    if (d.asks) asks = d.asks.map(([p, q]) => pair(p, q));
  } else if (ex === "BB") {
    const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
    const cat = isSpot ? "spot" : "linear";
    const d = await apiFetch(`https://api.bybit.com/v5/market/orderbook?category=${cat}&symbol=${realSym}&limit=${depth}`, reqTimeout, 0);
    assertVenueOk(ex, d);
    const r = d.result || {};
    if (r.b) bids = r.b.map(([p, q]) => pair(p, q));
    if (r.a) asks = r.a.map(([p, q]) => pair(p, q));
  } else if (ex === "OX") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
    const d = await apiFetch(`https://www.okx.com/api/v5/market/books?instId=${realSym}&sz=${depth}`, reqTimeout, 0);
    assertVenueOk(ex, d);
    const book = (d.data || [])[0] || {};
    if (book.bids) bids = book.bids.map(([p, q]) => pair(p, q, cs));
    if (book.asks) asks = book.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "BG") {
    const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
    const url = isSpot
      ? `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${realSym}&limit=${depth}`
      : `https://api.bitget.com/api/v2/mix/market/merge-depth?productType=USDT-FUTURES&symbol=${realSym}&limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    assertVenueOk(ex, d);
    const r = d.data || {};
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q));
  } else if (ex === "GT") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "_USDT") : sym;
    const url = isSpot
      ? `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${realSym}&limit=${depth}`
      : `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${realSym}&limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    assertVenueOk(ex, d);
    if (d.bids) bids = d.bids.map(b => pair(b.p !== undefined ? b.p : b[0], b.s !== undefined ? b.s : b[1], cs));
    if (d.asks) asks = d.asks.map(a => pair(a.p !== undefined ? a.p : a[0], a.s !== undefined ? a.s : a[1], cs));
  } else if (ex === "MX") {
    const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
    const url = isSpot
      ? `https://api.mexc.com/api/v3/depth?symbol=${realSym}&limit=${depth}`
      : `https://contract.mexc.com/api/v1/contract/depth/${realSym}?limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    assertVenueOk(ex, d);
    const r = isSpot ? d : (d.data || {});
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q, cs));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "KC") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
    const url = isSpot
      ? `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${realSym}`
      : `https://api-futures.kucoin.com/api/v1/level2/depth100?symbol=${realSym}`;
    const d = await apiFetch(url, reqTimeout, 0);
    assertVenueOk(ex, d);
    const r = d.data || {};
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q, cs));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "BX") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
    const url = isSpot
      ? `https://open-api.bingx.com/openApi/spot/v1/market/depth?symbol=${realSym}&limit=${depth}`
      : `https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${realSym}&limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    assertVenueOk(ex, d);
    const r = d.data || {};
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q));
  } else if (ex === "HT") {
    const realSym = isSpot ? sym.replace("_SPOT", "").toLowerCase() : sym;
    const url = isSpot
      ? `https://api.huobi.pro/market/depth?symbol=${realSym}&type=step0`
      : `https://api.hbdm.vn/linear-swap-ex/market/depth?contract_code=${realSym}&type=step0`;
    const d = await apiFetch(url, reqTimeout, 0);
    assertVenueOk(ex, d);
    const tick = d.tick || {};
    if (tick.bids) bids = tick.bids.map(([p, q]) => pair(p, q, cs));
    if (tick.asks) asks = tick.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "HL") {
    const coinName = sym.replace("-USDT", "").replace("USDT", "");
    // nSigFigs is omitted: the aggregated view merges distinct resting orders
    // into buckets, which is precisely what the cluster search must not receive.
    const d = await apiFetch("https://api.hyperliquid.xyz/info", reqTimeout, 0, "POST", { type: "l2Book", coin: coinName });
    assertVenueOk(ex, d);
    const levels = d.levels || [[], []];
    bids = (levels[0] || []).map(l => pair(l.px, l.sz));
    asks = (levels[1] || []).map(l => pair(l.px, l.sz));
  } else if (ex === "AD") {
    const d = await apiFetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${sym}&limit=${depth}`, reqTimeout, 0);
    assertVenueOk(ex, d);
    if (d.bids) bids = d.bids.map(([p, q]) => pair(p, q));
    if (d.asks) asks = d.asks.map(([p, q]) => pair(p, q));
  } else {
    throw new Error(`unsupported exchange ${ex}`);
  }

  return { bids, asks };
}

// ═══ Scheduler ═══════════════════════════════════════════════════════════════

/** Token bucket. Keeps each venue inside its published REST weight budget. */
function takeTokens(exState, cost) {
  const profile = profileFor(exState.ex);
  const now = Date.now();
  const elapsed = (now - exState.lastRefill) / 1000;
  if (elapsed > 0) {
    const capacity = profile.budget * RATE_SCALE * 2;
    exState.tokens = Math.min(capacity, exState.tokens + elapsed * profile.budget * RATE_SCALE);
    exState.lastRefill = now;
  }
  if (exState.tokens < cost) return false;
  exState.tokens -= cost;
  return true;
}

function tierIntervalFor(rank) {
  for (const tier of TIERS) {
    if (rank < tier.maxRank) return tier.intervalMs;
  }
  return TIERS[TIERS.length - 1].intervalMs;
}

/**
 * Rebuild each exchange's symbol universe from the live ticker map and assign
 * refresh intervals. Every tradable symbol is included — there is no batch
 * ceiling — because coverage is limited by the token bucket, not by an
 * arbitrary "60 per cycle" constant.
 */
function refreshUniverse(tickers) {
  const byExchange = new Map();
  for (const ex of EXCHANGES) byExchange.set(ex, []);
  // Resolve the floor once per venue rather than once per ticker.
  const floors = new Map();
  for (const ex of EXCHANGES) floors.set(ex, minVolumeFor(ex));

  for (const t of tickers.values()) {
    if (!t || !t.ex || !t.sym) continue;
    const list = byExchange.get(t.ex);
    if (!list) continue;
    if (!(Number(t.p) > 0)) continue;
    const vol = Number(t.v) || 0;
    if (vol < floors.get(t.ex)) continue;
    if (!isTradableBase(t.base, t.sym, t)) continue;
    if (t.ex === "BX" && t.sym.endsWith("_SPOT")) continue;
    // A ticker map can hold alias keys (e.g. MEXC with and without "_").
    list.push(t);
  }

  const now = Date.now();
  for (const ex of EXCHANGES) {
    const list = byExchange.get(ex);
    const seen = new Set();
    const unique = [];
    for (const t of list) {
      if (seen.has(t.sym)) continue;
      seen.add(t.sym);
      unique.push(t);
    }
    unique.sort((a, b) => (Number(b.v) || 0) - (Number(a.v) || 0) || a.sym.localeCompare(b.sym));

    const exState = getExchangeState(ex);
    exState.symbolsTotal = unique.length;

    const map = getSymbolMap(ex);
    for (let i = 0; i < unique.length; i++) {
      const t = unique[i];
      const st = getSymbolState(ex, t.sym);
      st.coin = t;
      st.rank = i;
      st.baseIntervalMs = Math.max(MIN_INTERVAL_MS, tierIntervalFor(i));
      st.retired = false;
      if (!st.nextDueAt) {
        // Stagger the first sweep so a restart does not fire every request at once.
        st.nextDueAt = now + Math.floor((i / Math.max(1, unique.length)) * st.baseIntervalMs);
      }
    }

    // Drop symbols that left the venue.
    for (const [sym, st] of map) {
      if (!seen.has(sym)) {
        if (st.inflight) { st.retired = true; continue; }
        for (const level of st.levels.values()) {
          level.endReason = "delisted";
          closeTimelineRecord(ex, sym, level, now);
        }
        map.delete(sym);
      }
    }
  }
}

/** Effective refresh interval: symbols currently holding densities poll faster. */
function effectiveIntervalMs(st) {
  const base = st.baseIntervalMs || TIERS[TIERS.length - 1].intervalMs;
  let interval = base;
  if (st.walls.length) interval = base * ACTIVE_WALL_BOOST;
  // Exponential backoff on repeated failures keeps a broken symbol from
  // consuming the whole exchange budget.
  if (st.fails > 0) interval *= Math.min(8, Math.pow(2, Math.min(st.fails, 3)));
  return Math.max(MIN_INTERVAL_MS, Math.round(interval));
}

/**
 * Pick the most overdue symbols for one exchange, subject to the token bucket
 * and in-flight limit. Overdue ratio (not raw age) is used so tier-1 leaders do
 * not permanently starve the long tail.
 */
function selectDueSymbols(ex, now) {
  const exState = getExchangeState(ex);
  if (exState.cooldownUntil > now) return [];
  const profile = profileFor(ex);
  const slots = profile.inflight - exState.inflight;
  if (slots <= 0) return [];

  const map = getSymbolMap(ex);
  const due = [];
  for (const st of map.values()) {
    if (st.inflight || st.retired) continue;
    if (st.parkedUntil > now) continue;
    if (!st.coin) continue;
    if (st.nextDueAt > now) continue;
    const interval = effectiveIntervalMs(st);
    due.push({ st, overdue: (now - st.nextDueAt) / interval });
  }
  if (!due.length) return [];

  due.sort((a, b) => b.overdue - a.overdue || a.st.rank - b.st.rank);

  const picked = [];
  for (const item of due) {
    if (picked.length >= slots) break;
    const deep = item.st.rank < 40 || (Number(item.st.coin.v) || 0) >= 50000000;
    const cost = deep ? profile.costHot : profile.costTail;
    if (!takeTokens(exState, cost)) break;
    picked.push({ st: item.st, deep });
  }
  return picked;
}

// ═══ Poll one symbol ═════════════════════════════════════════════════════════

async function pollSymbol(ex, st, deep, apiFetch) {
  const exState = getExchangeState(ex);
  st.inflight = true;
  exState.inflight++;
  const t0 = Date.now();

  try {
    const { bids, asks } = await fetchOB(ex, st.coin, apiFetch, deep, REQUEST_TIMEOUT_MS);
    const now = Date.now();
    exState.lastLatencyMs = now - t0;

    if (!bids.length && !asks.length) throw new Error("empty book");

    ingestBook({ ex, coin: st.coin, bids, asks, now });

    st.polls++;
    st.fails = 0;
    st.emptyBooks = 0;
    exState.okPolls++;
    exState.consecutiveFails = 0;
    exState.status = "ok";
    exState.error = null;
    exState.updatedAt = now;
    exState.durationMs = now - t0;
    if (!exState.coveredThisCycle) exState.coveredThisCycle = new Set();
    exState.coveredThisCycle.add(st.sym);
    exState.symbolsCovered = exState.coveredThisCycle.size;
    if (exState.symbolsTotal > 0 && exState.symbolsCovered >= exState.symbolsTotal) {
      exState.coverageCycles++;
      exState.lastFullCoverageAt = now;
      exState.coveredThisCycle = new Set();
      exState.symbolsCovered = 0;
    }
  } catch (err) {
    const now = Date.now();
    const message = String(err && err.message || err);
    exState.durationMs = now - t0;

    if (message === "empty book") {
      // The venue answered correctly and the instrument simply has no book. That
      // is a fact about the listing, not a fault: counting it would inflate this
      // symbol's retry backoff (stretching three strikes across twenty minutes),
      // trip the venue's consecutive-failure cooldown, and paint the venue red —
      // which is exactly what 760 tokenized-equity listings on one venue did.
      st.emptyBooks++;
      if (st.emptyBooks >= EMPTY_BOOK_LIMIT && st.parkedUntil <= now) {
        st.parkedUntil = now + EMPTY_BOOK_PARK_MS;
        console.warn(`[WALL ${ex}] ${st.sym} parked for ${Math.round(EMPTY_BOOK_PARK_MS / 60000)}min — ${st.emptyBooks} empty books in a row`);
      }
      return;
    }

    st.fails++;
    exState.failPolls++;
    exState.consecutiveFails++;
    // Venue throttle wording varies: OKX says "Requests too frequent", Bybit
    // "Too many visits", MEXC "request frequency too fast", BingX "rate limit".
    // Bare `rate` used to match innocent words like "generate", so the token is
    // anchored to the phrases venues actually send.
    const rateLimited = /429|418|rate.?limit|rate exceeded|too many|too fast|frequen|weight|banned/i.test(message);
    exState.status = /abort|timeout/i.test(message) ? "timeout" : "error";
    exState.error = message.slice(0, 180);
    if (rateLimited) {
      // Back off the whole venue, not just this symbol: the limit is per IP.
      exState.cooldownUntil = now + Math.min(120000, 5000 * Math.min(8, exState.consecutiveFails));
      exState.tokens = 0;
      exState.status = "throttled";
    } else if (exState.consecutiveFails >= 12) {
      exState.cooldownUntil = now + 15000;
    }
  } finally {
    st.inflight = false;
    exState.inflight = Math.max(0, exState.inflight - 1);
    st.lastPolledAt = Date.now();
    st.nextDueAt = st.lastPolledAt + effectiveIntervalMs(st);
    exState.polls++;
    if (st.retired) getSymbolMap(ex).delete(st.sym);
  }
}

// ═══ Publication ═════════════════════════════════════════════════════════════

function collectActiveWalls(now) {
  const all = [];
  for (const ex of EXCHANGES) {
    const map = symbolStates.get(ex);
    if (!map) continue;
    for (const st of map.values()) {
      if (!st.walls.length) continue;
      // Drop densities whose symbol has not been re-polled in a long time: we
      // cannot claim a level is still resting if we have not looked.
      if (st.updatedAt && now - st.updatedAt > SYMBOL_STALE_MS) continue;
      all.push(...st.walls);
    }
  }
  return all;
}

function buildExchangeStatuses(now) {
  const statuses = {};
  let ready = 0;
  for (const ex of EXCHANGES) {
    const st = exchangeState.get(ex);
    if (!st) {
      statuses[ex] = {
        status: "pending", updatedAt: 0, durationMs: 0, count: 0,
        symbolsScanned: 0, symbolsTotal: 0, symbolsParked: 0, coveragePct: 0, coverageCycles: 0,
        lastFullCoverageAt: 0, error: null,
      };
      continue;
    }

    const map = symbolStates.get(ex);
    let wallCount = 0;
    let freshSymbols = 0;
    let parkedSymbols = 0;
    if (map) {
      for (const symState of map.values()) {
        if (symState.parkedUntil > now) parkedSymbols++;
        if (symState.updatedAt && now - symState.updatedAt <= SYMBOL_STALE_MS) {
          freshSymbols++;
          wallCount += symState.walls.length;
        }
      }
    }

    const isStale = st.updatedAt > 0 && now - st.updatedAt > EXCHANGE_STALE_MS;
    let status = st.status;
    if (isStale && status === "ok") status = "stale";
    if (st.cooldownUntil > now && status !== "error") status = "throttled";

    // Coverage is measured against the symbols that can actually be read. A
    // parked instrument has no order book to fetch, so counting it would report a
    // permanent shortfall the scanner has no way to close.
    const scannable = Math.max(0, st.symbolsTotal - parkedSymbols);
    const coveragePct = scannable > 0
      ? Math.min(100, Math.round(freshSymbols / scannable * 100))
      : 0;

    statuses[ex] = {
      status,
      updatedAt: st.updatedAt,
      durationMs: st.durationMs,
      count: wallCount,
      symbolsScanned: freshSymbols,
      symbolsTotal: st.symbolsTotal,
      symbolsParked: parkedSymbols,
      coveragePct,
      coverageCycles: st.coverageCycles,
      lastFullCoverageAt: st.lastFullCoverageAt,
      latencyMs: st.lastLatencyMs,
      error: st.error,
    };

    if (status === "ok" || status === "stale") ready++;
  }
  return { statuses, ready };
}

function publish() {
  const now = Date.now();
  const active = collectActiveWalls(now);
  detectedWalls = buildWallSnapshot(active);

  const { statuses, ready } = buildExchangeStatuses(now);
  detectedMetadata = {
    walls: detectedWalls,
    history: getWallHistorySnapshot(now),
    updatedAt: now,
    scanId: ++pollCounter,
    partial: ready < EXCHANGES.length,
    exchangesReady: ready,
    exchangesTotal: EXCHANGES.length,
    exchangeStatuses: statuses,
  };

  if (onUpdateCb) {
    try {
      onUpdateCb(detectedMetadata);
    } catch (err) {
      console.error("[WALL] Update callback error:", err.message);
    }
  }
}

// ═══ Engine loops ════════════════════════════════════════════════════════════

/**
 * One dispatcher per exchange. Independent loops mean a slow venue can never
 * hold back the other ten — the old sequential "chunk of 2 exchanges" design
 * made total latency the sum of the worst venues.
 */
function startExchangeLoop(ex, apiFetch) {
  const profile = profileFor(ex);
  const tick = async () => {
    try {
      const now = Date.now();
      const picked = selectDueSymbols(ex, now);
      for (const { st, deep } of picked) {
        pollSymbol(ex, st, deep, apiFetch).catch(() => {});
      }
    } catch (err) {
      console.error(`[WALL ${ex}] dispatcher error:`, err.message);
    }
  };

  // Dispatch cadence scales with the venue's budget: high-budget venues need
  // frequent wake-ups to spend their tokens, tight ones do not.
  const cadence = clamp(Math.round(1000 / Math.max(1, profile.inflight)), 120, 1000);
  setInterval(tick, cadence);
  tick();
}

function startUniverseLoop(tickers) {
  const run = () => {
    try {
      refreshUniverse(tickers);
    } catch (err) {
      console.error("[WALL] Universe refresh error:", err.message);
    }
  };
  run();
  setInterval(run, UNIVERSE_REFRESH_MS);
}

function startPublishLoop() {
  setInterval(() => {
    try {
      publish();
    } catch (err) {
      console.error("[WALL] Publish error:", err.message);
    }
  }, PUBLISH_INTERVAL_MS);
}

// ═══ Spot ticker loading ═════════════════════════════════════════════════════

async function updateSpotTickers(tickers) {
  const exchanges = EXCHANGES.filter(ex => profileFor(ex).hasSpot);
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };

  await Promise.allSettled(exchanges.map(async (ex) => {
    try {
      let url = "";
      if (ex === "BN") url = "https://api.binance.com/api/v3/ticker/24hr";
      else if (ex === "BB") url = "https://api.bybit.com/v5/market/tickers?category=spot";
      else if (ex === "OX") url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
      else if (ex === "BG") url = "https://api.bitget.com/api/v2/spot/market/tickers";
      else if (ex === "GT") url = "https://api.gateio.ws/api/v4/spot/tickers";
      else if (ex === "MX") url = "https://api.mexc.com/api/v3/ticker/24hr";
      else if (ex === "KC") url = "https://api.kucoin.com/api/v1/market/allTickers";
      else if (ex === "HT") url = "https://api.huobi.pro/market/tickers";
      else return;

      const r = await fetch(url, { headers, signal: AbortSignal.timeout(3500) });
      if (!r.ok) return;
      const data = await r.json();
      let venueExcludedSymbols = null;
      if (ex === "BG") {
        try {
          const metadataResponse = await fetch(
            "https://api.bitget.com/api/v3/market/instruments?category=SPOT",
            { headers, signal: AbortSignal.timeout(3500) }
          );
          if (metadataResponse.ok) {
            const metadata = await metadataResponse.json();
            registerVenueAssetMetadata(metadata.data || []);
            venueExcludedSymbols = new Set((metadata.data || [])
              .filter(item => String(item.isRwa).toUpperCase() === "YES" || String(item.isReality).toLowerCase() === "yes")
              .map(item => item.symbol));
          }
        } catch (_) {}
      }

      let items = [];
      if (ex === "BN" || ex === "MX") {
        items = (Array.isArray(data) ? data : []).filter(d => d.symbol && d.symbol.endsWith("USDT")).map(d => ({
          sym: d.symbol + "_SPOT", base: d.symbol.replace(/USDT$/, ""), p: +d.lastPrice, v: +d.quoteVolume,
        }));
      } else if (ex === "BB") {
        items = ((data.result && data.result.list) || []).filter(d => d.symbol && d.symbol.endsWith("USDT")).map(d => ({
          sym: d.symbol + "_SPOT", base: d.symbol.replace(/USDT$/, ""), p: +d.lastPrice, v: +d.turnover24h,
        }));
      } else if (ex === "OX") {
        items = (data.data || []).filter(d => d.instId && d.instId.endsWith("-USDT")).map(d => ({
          sym: d.instId.replace("-", "") + "_SPOT", base: d.instId.split("-")[0], p: +d.last, v: +d.volCcy24h,
        }));
      } else if (ex === "BG") {
        items = (data.data || []).filter(d => d.symbol && d.symbol.endsWith("USDT") &&
          !(venueExcludedSymbols && venueExcludedSymbols.has(d.symbol))).map(d => ({
          sym: d.symbol + "_SPOT", base: d.symbol.replace(/USDT$/, ""), p: +d.lastPr, v: +d.usdtVolume,
        }));
      } else if (ex === "GT") {
        items = (Array.isArray(data) ? data : []).filter(d => d.currency_pair && d.currency_pair.endsWith("_USDT")).map(d => ({
          sym: d.currency_pair.replace("_", "") + "_SPOT", base: d.currency_pair.split("_")[0], p: +d.last, v: +d.quote_volume,
        }));
      } else if (ex === "KC") {
        items = ((data.data && data.data.ticker) || []).filter(d => d.symbol && d.symbol.endsWith("-USDT")).map(d => ({
          sym: d.symbol.replace("-", "") + "_SPOT", base: d.symbol.split("-")[0], p: +d.last, v: +d.volValue,
        }));
      } else if (ex === "HT") {
        items = (data.data || []).filter(d => d.symbol && d.symbol.endsWith("usdt")).map(d => ({
          sym: d.symbol.toUpperCase() + "_SPOT", base: d.symbol.replace(/usdt$/, "").toUpperCase(), p: +d.close, v: +d.vol,
        }));
      }

      for (const item of items) {
        if (!item.p || !item.v || !Number.isFinite(item.p) || !Number.isFinite(item.v)) continue;
        if (!isTradableBase(item.base, item.sym)) continue;
        const key = `${ex}:${item.sym}`;
        tickers.set(key, {
          key, ex, sym: item.sym, base: item.base,
          p: item.p, chg: 0, v: item.v, h: item.p, l: item.p, o: item.p,
          funding: 0, nextFunding: 0, cs: 1,
        });
      }
    } catch (_) {}
  }));
}

// ═══ Public API ══════════════════════════════════════════════════════════════

function startScanning(tickers, apiFetch, onUpdate) {
  if (engineStarted) return;
  engineStarted = true;
  onUpdateCb = onUpdate || null;

  console.log("[WALL] Density Engine v6 — venue-calibrated evidence, no result quota");
  console.log(`[WALL] band=${MIN_DIST_PCT}%-${MAX_DIST_PCT}%, seed=${SEED_MULT}x grow=${GROW_MULT}x gap<=${MAX_TICK_GAP} ticks, output=${Number.isFinite(MAX_OUTPUT) ? MAX_OUTPUT : "unlimited"}, tiers=${TIERS.map(t => t.intervalMs).join("/")}ms`);
  console.log(`[WALL] volume floors: ${EXCHANGES.map(ex => `${ex} $${(minVolumeFor(ex) / 1000).toFixed(0)}K`).join(", ")}`);

  const assetMetadataReady = refreshVenueAssetExclusions()
    .catch(e => console.warn("[WALL] RWA metadata refresh failed; curated fallback active:", e.message));
  updateSpotTickers(tickers).catch(e => console.error("[SPOT] Initial load error:", e.message));
  setInterval(() => {
    updateSpotTickers(tickers).catch(e => console.error("[SPOT] Poll update error:", e.message));
    refreshVenueAssetExclusions().catch(() => {});
  }, SPOT_REFRESH_MS);

  // The first universe must not race the asset-class catalogue; otherwise a
  // fresh deploy spends its first sweep and confirmation budget on RWA books.
  assetMetadataReady.finally(() => startUniverseLoop(tickers));
  startPublishLoop();

  // Let the ticker WS feeds populate before the first book requests.
  setTimeout(() => {
    for (const ex of EXCHANGES) startExchangeLoop(ex, apiFetch);
  }, 6000);
}

module.exports = {
  getWalls: () => detectedWalls,
  getMetadata: () => detectedMetadata,
  startScanning,

  // Pure pipeline stages, exported for tests and reuse.
  analyzeBook,
  ingestBook,
  buildWallSnapshot,
  clusterWalls,
  applyConfluence,
  extractClusters,
  estimateTickSize,
  localBaseline,
  clusterDominance,
  canonicalAsset,
  canonicalBase,
  qualityProfileFor,
  registerVenueAssetMetadata,
  minVolumeFor,
  getTierThresholds,
  classifyWallTier,
  calculateRobustBookStats,
  rankWallByStatistics,
  rankFromSignificance,
  significanceOf,
  percentileRank,
  isTradableBase,
  assertVenueOk,
  getWallHistorySnapshot,
  getSymbolDiagnostics,
  resetSymbolState,
};
