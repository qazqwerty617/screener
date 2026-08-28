"use strict";

/**
 * Density Engine v4 — professional order-book density detection.
 *
 * Rewritten from the ground up to behave like a desk-grade scanner
 * (TigerTrade Scanner / Deepscreener class) instead of a fixed-threshold
 * wall finder.
 *
 * DESIGN
 * ------
 * 1. FULL COVERAGE. Every one of the 11 exchanges and every tradable symbol
 *    (futures + spot) is continuously polled by an independent worker pool that
 *    is rate limited by a per-endpoint token bucket. There is no "60 symbols per
 *    exchange per cycle" batch any more: symbols are scheduled by liquidity tier
 *    and by how overdue they are, so leaders refresh in seconds and the long tail
 *    still gets full periodic coverage.
 *
 * 2. BIN-FREE LEVEL EXTRACTION. Fixed 0.1% bins split a single wall across two
 *    buckets whenever it straddles a bin edge. Instead we run a sliding window
 *    over the raw price levels, take the strongest windows first and claim their
 *    levels (greedy non-maximum suppression). A wall is found where the liquidity
 *    actually is, at its volume-weighted price.
 *
 * 3. RELATIVE, NOT ABSOLUTE. A density is interesting when it is large *for that
 *    book* and *for that coin's traded flow*, never because it crossed a dollar
 *    threshold. Five independent normalized signals are combined:
 *      z           - robust log Z-score against the book's own level distribution
 *      dominance   - size versus the local neighbourhood median
 *      depthShare  - share of the whole side's depth inside the scan band
 *      volMinutes  - size expressed in minutes of average traded volume
 *      percentile  - rank inside the book
 *    This removes the per-exchange magic numbers the old engine needed.
 *
 * 4. LIFECYCLE + ANTI-SPOOF. Every level is tracked across polls with exact
 *    miss accounting (a level can only be "missing" once its own symbol has
 *    actually been re-polled). When a level disappears we look at the fresh book
 *    to classify it: absorbed by price (filled), still partially there (faded),
 *    or yanked while price was far away (pulled = spoof). The pulled ratio feeds
 *    back as a penalty on every future density of that symbol.
 *
 * 5. CROSS-EXCHANGE CONFLUENCE. The same price defended on several venues is the
 *    strongest signal on the board and is scored as such.
 *
 * 6. FAIR PUBLICATION. Output slots are reserved per exchange before the global
 *    score fill, so all 11 venues stay visible instead of the loudest two
 *    flooding the map.
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

// Scan band around the mid price.
const MIN_DIST_PCT = envNum("WALL_MIN_DIST_PCT", 0.03, 0.0, 1);
const MAX_DIST_PCT = envNum("WALL_MAX_DIST_PCT", 5.0, 0.5, 20);

// Cluster geometry.
const BASE_CLUSTER_WIDTH_PCT = envNum("WALL_CLUSTER_WIDTH_PCT", 0.06, 0.01, 1);
const MAX_CLUSTER_WIDTH_PCT = 0.3;
const NEIGHBOURHOOD_PCT = envNum("WALL_NEIGHBOURHOOD_PCT", 0.9, 0.1, 5);

// Lifecycle geometry.
const MATCH_TOL_PCT = envNum("WALL_MATCH_TOL_PCT", 0.07, 0.01, 1);
const TOUCH_PCT = envNum("WALL_TOUCH_PCT", 0.12, 0.01, 1);
const MAX_MISSES = envInt("WALL_MAX_MISSES", 2, 1, 6);
const RESIDUAL_ALIVE_RATIO = 0.35;
const REFILL_DIP_RATIO = 0.72;

// Admission gates. Deliberately relative; the composite score does the work.
const MIN_SIGNIFICANCE = envNum("WALL_MIN_SIGNIFICANCE", 0.30, 0.05, 0.95);
const MIN_Z = envNum("WALL_MIN_Z", 1.15, 0.2, 8);
const MIN_DOMINANCE = envNum("WALL_MIN_DOMINANCE", 1.9, 1.0, 20);
const MIN_DEPTH_SHARE = envNum("WALL_MIN_DEPTH_SHARE", 0.025, 0.001, 0.9);
const MIN_VOL_MINUTES = envNum("WALL_MIN_VOL_MINUTES", 0.15, 0.0, 120);
const MIN_ABS_USD = envNum("WALL_MIN_ABS_USD", 15000, 0, 1e9);
const MIN_SYMBOL_VOLUME_USD = envNum("WALL_MIN_SYMBOL_VOLUME_USD", 150000, 0, 1e12);

// Snapshot shaping.
const MAX_OUTPUT = envInt("WALL_MAX_RESULTS", 2500, 50, 20000);
const MAX_PER_COIN = envInt("WALL_MAX_PER_COIN", 6, 1, 40);
const CLUSTER_PCT = envNum("WALL_SNAPSHOT_CLUSTER_PCT", 0.1, 0.01, 1);
const EX_RESERVE_RATIO = envNum("WALL_EX_RESERVE_RATIO", 0.45, 0, 0.9);
const PUBLISH_MIN_SCORE = envNum("WALL_PUBLISH_MIN_SCORE", 2.4, 0, 20);

// Scheduling / transport.
const REQUEST_TIMEOUT_MS = envInt("WALL_REQUEST_TIMEOUT_MS", 7000, 1000, 30000);
const PUBLISH_INTERVAL_MS = envInt("WALL_PUBLISH_INTERVAL_MS", 2500, 500, 30000);
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
const MIN_INTERVAL_MS = 8000;

/**
 * Per-exchange transport budget.
 *   budget    - token-bucket refill per second, in cost units
 *   costTail  - cost of a shallow book request
 *   costHot   - cost of a deep book request
 *   inflight  - concurrent requests
 *   aggregated- venue returns pre-merged price levels (level counts are unusable)
 */
const EX_PROFILE = {
  BN: { budget: 22, costTail: 5, costHot: 10, depthTail: 100, depthHot: 500, inflight: 4, aggregated: false, hasSpot: true },
  BB: { budget: 10, costTail: 1, costHot: 1, depthTail: 200, depthHot: 500, inflight: 5, aggregated: false, hasSpot: true },
  OX: { budget: 6, costTail: 1, costHot: 1, depthTail: 200, depthHot: 400, inflight: 3, aggregated: false, hasSpot: true },
  BG: { budget: 8, costTail: 1, costHot: 1, depthTail: 150, depthHot: 150, inflight: 4, aggregated: true, hasSpot: true },
  GT: { budget: 9, costTail: 1, costHot: 1, depthTail: 100, depthHot: 100, inflight: 4, aggregated: false, hasSpot: true },
  MX: { budget: 6, costTail: 1, costHot: 1, depthTail: 200, depthHot: 500, inflight: 3, aggregated: false, hasSpot: true },
  KC: { budget: 5, costTail: 1, costHot: 1, depthTail: 100, depthHot: 100, inflight: 3, aggregated: false, hasSpot: true },
  BX: { budget: 4, costTail: 1, costHot: 1, depthTail: 100, depthHot: 100, inflight: 2, aggregated: false, hasSpot: false },
  HT: { budget: 6, costTail: 1, costHot: 1, depthTail: 150, depthHot: 150, inflight: 3, aggregated: true, hasSpot: true },
  HL: { budget: 4, costTail: 1, costHot: 1, depthTail: 50, depthHot: 50, inflight: 2, aggregated: true, hasSpot: false },
  AD: { budget: 2, costTail: 1, costHot: 1, depthTail: 100, depthHot: 500, inflight: 2, aggregated: false, hasSpot: false },
};

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
  if (KNOWN_STOCK_BASES.has(token)) return true;

  let inner = token;
  if ((token.startsWith("R") || token.startsWith("X")) && token.length >= 4) {
    inner = token.slice(1);
    if (KNOWN_STOCK_BASES.has(inner)) return true;
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

function isTradableBase(base, sym) {
  if (!base) return false;
  const upper = String(base).toUpperCase();
  if (EXCLUDED_BASES.has(upper)) return false;
  if (isLeveragedOrSyntheticBase(upper)) return false;
  if (isStockOrEquityBase(upper, sym)) return false;
  return true;
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
 * Robust location/scale of a book's level sizes in log space.
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
 * Adaptive cluster width. Cheap coins quote on a coarse tick grid relative to
 * price, so a fixed percentage window would contain a single level. Widen the
 * window until it spans at least a few ticks.
 */
function clusterWidthPct(levels, mid) {
  if (!Number.isFinite(mid) || mid <= 0 || levels.length < 2) return BASE_CLUSTER_WIDTH_PCT;
  const gaps = [];
  for (let i = 1; i < levels.length && gaps.length < 64; i++) {
    const gap = Math.abs(levels[i].price - levels[i - 1].price);
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return BASE_CLUSTER_WIDTH_PCT;
  const tickPct = (median(gaps) / mid) * 100;
  return clamp(Math.max(BASE_CLUSTER_WIDTH_PCT, tickPct * 2.5), BASE_CLUSTER_WIDTH_PCT, MAX_CLUSTER_WIDTH_PCT);
}

/**
 * Sliding-window cluster search with greedy non-maximum suppression.
 *
 * Fixed bins are the classic failure mode of naive wall scanners: a single
 * resting order that straddles a bin edge gets halved and vanishes below the
 * threshold, while two unrelated orders that happen to share a bin get merged.
 * Here every level starts a candidate window of `widthPct`, the windows are
 * ranked by contained USD, and the strongest window claims its levels. What
 * comes out is the actual liquidity shelf at its volume-weighted price.
 */
function extractClusters(levels, mid, side, widthPct) {
  if (!levels.length) return [];
  const halfWidth = mid * (widthPct / 100) * 0.5;

  const candidates = [];
  for (let i = 0; i < levels.length; i++) {
    const anchor = levels[i].price;
    const from = lowerBound(levels, anchor - halfWidth);
    const to = upperBound(levels, anchor + halfWidth);
    let usd = 0;
    let qty = 0;
    let weighted = 0;
    let orders = 0;
    let peakUsd = 0;
    let peakPrice = anchor;
    for (let j = from; j < to; j++) {
      const lv = levels[j];
      usd += lv.usd;
      qty += lv.qty;
      weighted += lv.price * lv.usd;
      orders++;
      if (lv.usd > peakUsd) {
        peakUsd = lv.usd;
        peakPrice = lv.price;
      }
    }
    if (usd <= 0) continue;
    candidates.push({
      from,
      to,
      usd,
      qty,
      orders,
      peakUsd,
      peakPrice,
      price: weighted / usd,
      loPrice: levels[from].price,
      hiPrice: levels[to - 1].price,
    });
  }

  candidates.sort((a, b) => b.usd - a.usd);

  const claimed = new Uint8Array(levels.length);
  const clusters = [];
  for (const c of candidates) {
    let free = false;
    for (let j = c.from; j < c.to; j++) {
      if (!claimed[j]) { free = true; break; }
    }
    if (!free) continue;

    // Recompute over unclaimed levels only so overlapping windows never
    // double-count the same resting liquidity.
    let usd = 0;
    let qty = 0;
    let weighted = 0;
    let orders = 0;
    let peakUsd = 0;
    let peakPrice = c.price;
    let loPrice = Infinity;
    let hiPrice = -Infinity;
    for (let j = c.from; j < c.to; j++) {
      if (claimed[j]) continue;
      const lv = levels[j];
      usd += lv.usd;
      qty += lv.qty;
      weighted += lv.price * lv.usd;
      orders++;
      if (lv.usd > peakUsd) { peakUsd = lv.usd; peakPrice = lv.price; }
      if (lv.price < loPrice) loPrice = lv.price;
      if (lv.price > hiPrice) hiPrice = lv.price;
      claimed[j] = 1;
    }
    if (usd <= 0 || !orders) continue;

    clusters.push({
      side,
      usd,
      qty,
      orders,
      peakUsd,
      peakPrice,
      price: weighted / usd,
      loPrice,
      hiPrice,
    });
  }

  return clusters;
}

/**
 * Local dominance: cluster size versus the typical level around it.
 * A wall that is 10x its neighbours is a wall even if the whole book is thin;
 * a wall inside an already dense shelf is much less meaningful.
 */
function localDominance(levels, cluster, mid) {
  const span = mid * (NEIGHBOURHOOD_PCT / 100);
  const from = lowerBound(levels, cluster.price - span);
  const to = upperBound(levels, cluster.price + span);
  const around = [];
  for (let i = from; i < to; i++) {
    const lv = levels[i];
    if (lv.price >= cluster.loPrice && lv.price <= cluster.hiPrice) continue;
    if (lv.usd > 0) around.push(lv.usd);
  }
  if (around.length < 3) return { dominance: 3.0, neighbourMedian: 0, neighbourCount: around.length };
  const med = median(around);
  if (med <= 0) return { dominance: 3.0, neighbourMedian: 0, neighbourCount: around.length };
  // Compare against the cluster's own per-level average, not its total, so a
  // wide shelf of many small orders is not mistaken for one large order.
  const perLevel = cluster.usd / Math.max(1, cluster.orders);
  return {
    dominance: Math.max(cluster.usd / (med * Math.max(1, cluster.orders)), perLevel / med),
    neighbourMedian: med,
    neighbourCount: around.length,
  };
}

/**
 * Composite significance in 0..1 from five independent normalized signals.
 *
 * Each signal alone has a blind spot:
 *   z          misses walls in books that are uniformly thick
 *   dominance  fires on thin books with one ordinary order
 *   depthShare misses walls on venues that publish very deep books
 *   volMinutes is the trader's measure but ignores book context
 *   percentile saturates once several walls exist
 * Combining them with weights, then applying multiplicative context penalties,
 * is what removes the need for the per-exchange magic thresholds the previous
 * engine carried.
 */
function significanceOf(parts) {
  const zScore = norm(parts.z, MIN_Z, 6.5);
  const dominance = norm(Math.log2(Math.max(1, parts.dominance)), Math.log2(MIN_DOMINANCE), Math.log2(30));
  const depthShare = norm(parts.depthShare, MIN_DEPTH_SHARE, 0.30);
  const volMinutes = norm(Math.log1p(parts.volMinutes), Math.log1p(MIN_VOL_MINUTES), Math.log1p(45));
  const percentile = norm(parts.percentile, 0.70, 0.999);

  const raw =
    zScore * 0.26 +
    dominance * 0.24 +
    depthShare * 0.18 +
    volMinutes * 0.22 +
    percentile * 0.10;

  // Proximity: a level 4.5% away is real but not actionable today.
  const proximity = 0.55 + 0.45 * (1 - norm(parts.distPct, 0.15, MAX_DIST_PCT));
  // Books with very few distinct levels give unreliable statistics.
  const sample = 0.6 + 0.4 * norm(parts.levelCount, 12, 60);
  // A venue that reports pre-merged levels cannot prove a single large order.
  const granularity = parts.aggregated ? 0.9 : 1.0;

  return clamp(raw * proximity * sample * granularity, 0, 1);
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
  const significance = clamp(
    norm(z, MIN_Z, 6.5) * 0.6 + norm(pctFraction, 0.70, 0.999) * 0.4,
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
  const aggregated = input.aggregated !== undefined ? input.aggregated : profile.aggregated;

  const rawBids = Array.isArray(bids) ? bids : [];
  const rawAsks = Array.isArray(asks) ? asks : [];
  if (!rawBids.length && !rawAsks.length) return null;

  const base = String(coin && coin.base || "").toUpperCase();
  const sym = String(coin && coin.sym || "");
  if (!base || !sym) return null;
  if (!isTradableBase(base, sym)) return null;

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

  const candidates = [];

  const runSide = (levels, side, sideDepth) => {
    if (levels.length < 4) return;
    const widthPct = clusterWidthPct(levels, mid);
    const clusters = extractClusters(levels, mid, side, widthPct);
    if (!clusters.length) return;

    const stats = calculateRobustBookStats(clusters);
    if (!stats.count) return;

    for (const cluster of clusters) {
      const distPct = (Math.abs(cluster.price - mid) / mid) * 100;
      if (distPct < MIN_DIST_PCT || distPct > MAX_DIST_PCT) continue;
      if (cluster.usd < MIN_ABS_USD) continue;

      const z = (Math.log1p(cluster.usd) - stats.center) / stats.sigma;
      const percentile = percentileRank(stats.values, cluster.usd);
      const { dominance, neighbourMedian } = localDominance(levels, cluster, mid);
      const depthShare = sideDepth > 0 ? cluster.usd / sideDepth : 0;
      const volMinutes = vpm > 0 ? cluster.usd / vpm : 0;

      // Hard relative floors. Every one of these is a ratio, so the same code
      // works for BTC on Binance and a micro-cap on MEXC.
      if (z < MIN_Z) continue;
      if (dominance < MIN_DOMINANCE) continue;
      if (depthShare < MIN_DEPTH_SHARE) continue;
      if (vpm > 0 && volMinutes < MIN_VOL_MINUTES) continue;

      const significance = significanceOf({
        z,
        dominance,
        depthShare,
        volMinutes,
        percentile,
        distPct,
        levelCount: stats.count,
        aggregated,
      });
      if (significance < MIN_SIGNIFICANCE) continue;

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
        widthPct,
        pct: +distPct.toFixed(4),
        z: +z.toFixed(2),
        relSize: +z.toFixed(1),
        percentile: +(percentile * 100).toFixed(1),
        dominance: +dominance.toFixed(2),
        depthShare: +depthShare.toFixed(4),
        volMinutes: +volMinutes.toFixed(2),
        neighbourMedian,
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

/** USD still resting within `widthPct` of `price` on the given side. */
function residualUsdNear(analysis, side, price, widthPct) {
  const levels = analysis && analysis.bandLevels && analysis.bandLevels[side];
  if (!levels || !levels.length || !Number.isFinite(price) || price <= 0) return 0;
  const half = price * (Math.max(widthPct, BASE_CLUSTER_WIDTH_PCT) / 100) * 0.5;
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
 */
function matchTrackedLevel(state, candidate, token) {
  let best = null;
  let bestDist = Infinity;
  const tol = MATCH_TOL_PCT / 100;
  for (const level of state.levels.values()) {
    if (level.claimToken === token) continue;
    if (level.side !== candidate.side || level.market !== candidate.market) continue;
    const ref = Number(level.lastPrice) || Number(level.price) || 0;
    if (!(ref > 0)) continue;
    const dist = Math.abs(ref - candidate.price) / Math.max(ref, candidate.price);
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

    const residual = residualUsdNear(analysis, level.side, level.lastPrice, level.lastWidthPct || BASE_CLUSTER_WIDTH_PCT);
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
 * Final per-symbol scoring: apply lifecycle-derived context to raw significance.
 * `score` is the number the UI sorts by; it stays roughly on the old 0..15
 * `rtwi` scale so existing frontend sorting and sprite caches behave.
 */
function scoreSymbolWalls(state, analysis, tracked, now) {
  const spoofPenalty = 1 - clamp(pullRateOf(state) - 0.25, 0, 0.6) * 0.8;
  const imbalanceRef = analysis.bidDepth + analysis.askDepth;

  const walls = [];
  for (const { candidate, level } of tracked) {
    const persistence = persistenceOf(level, now);
    const eatenPct = level.peakUsd > 0
      ? clamp(1 - candidate.S / level.peakUsd, 0, 1)
      : 0;

    // Wide spreads mean the top of book is unreliable, so distance-based
    // significance is less trustworthy.
    const spreadPenalty = 1 - clamp((candidate.spreadPct - 0.05) / 1.5, 0, 0.35);
    const confirmed = clamp(0.55 + persistence * 0.45, 0, 1);
    const quality = clamp(candidate.significance * confirmed * spoofPenalty * spreadPenalty, 0, 1);

    const imbalance = imbalanceRef > 0
      ? (analysis.bidDepth - analysis.askDepth) / imbalanceRef
      : 0;

    walls.push({
      base: candidate.base,
      ex: candidate.ex,
      sym: candidate.sym,
      side: candidate.side,
      market: candidate.market,
      price: candidate.price,
      S: candidate.S,
      wallK: Math.round(candidate.S / 1000),
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
 * spoofing. Walls are grouped by coin/side and price proximity across venues,
 * then every member is boosted by how many venues and how much total USD agree.
 */
function applyConfluence(walls) {
  const byCoinSide = new Map();
  for (const w of walls) {
    const key = `${w.base}|${w.side}`;
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
    group.sort((a, b) => a.price - b.price);

    let i = 0;
    while (i < group.length) {
      const cluster = [group[i]];
      let j = i + 1;
      while (j < group.length) {
        const spanPct = Math.abs(group[j].price - cluster[0].price) / cluster[0].price * 100;
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
 * Deterministic snapshot builder.
 *
 * Fairness matters as much as ranking: with a single global "strongest first"
 * cut, two chatty venues fill the entire board and the user loses eight
 * exchanges. Each exchange therefore gets a reserved slice of the output
 * (round-robin by its own best walls) before the remainder is filled purely by
 * score.
 */
function buildWallSnapshot(allWalls, options = {}) {
  if (!Array.isArray(allWalls) || allWalls.length === 0) return [];

  const maxOutput = Number.isInteger(options.maxOutput) && options.maxOutput > 0 ? options.maxOutput : MAX_OUTPUT;
  const maxPerCoin = Number.isInteger(options.maxPerCoin) && options.maxPerCoin > 0 ? options.maxPerCoin : MAX_PER_COIN;
  const minScore = Number.isFinite(options.minScore) ? options.minScore : PUBLISH_MIN_SCORE;
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

    const score = Number.isFinite(Number(w.score)) ? Number(w.score) : Number(w.rtwi);
    if (!Number.isFinite(score)) continue;
    if (score < minScore) continue;

    const rank = Number(w.rank);
    if (Number.isFinite(rank) && rank > 0 && rank < 2) continue;

    validWalls.push({
      ...w,
      price,
      S,
      pct,
      score,
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
  const coinCount = new Map();
  const eligible = [];
  for (const w of clustered) {
    const coinKey = `${w.ex}:${w.base}`;
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
    if (d.bids) bids = d.bids.map(([p, q]) => pair(p, q));
    if (d.asks) asks = d.asks.map(([p, q]) => pair(p, q));
  } else if (ex === "BB") {
    const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
    const cat = isSpot ? "spot" : "linear";
    const d = await apiFetch(`https://api.bybit.com/v5/market/orderbook?category=${cat}&symbol=${realSym}&limit=${depth}`, reqTimeout, 0);
    const r = d.result || {};
    if (r.b) bids = r.b.map(([p, q]) => pair(p, q));
    if (r.a) asks = r.a.map(([p, q]) => pair(p, q));
  } else if (ex === "OX") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
    const d = await apiFetch(`https://www.okx.com/api/v5/market/books?instId=${realSym}&sz=${depth}`, reqTimeout, 0);
    const book = (d.data || [])[0] || {};
    if (book.bids) bids = book.bids.map(([p, q]) => pair(p, q, cs));
    if (book.asks) asks = book.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "BG") {
    const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
    const url = isSpot
      ? `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${realSym}&limit=${depth}`
      : `https://api.bitget.com/api/v2/mix/market/merge-depth?productType=USDT-FUTURES&symbol=${realSym}&limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    const r = d.data || {};
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q));
  } else if (ex === "GT") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "_USDT") : sym;
    const url = isSpot
      ? `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${realSym}&limit=${depth}`
      : `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${realSym}&limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    if (d.bids) bids = d.bids.map(b => pair(b.p !== undefined ? b.p : b[0], b.s !== undefined ? b.s : b[1], cs));
    if (d.asks) asks = d.asks.map(a => pair(a.p !== undefined ? a.p : a[0], a.s !== undefined ? a.s : a[1], cs));
  } else if (ex === "MX") {
    const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
    const url = isSpot
      ? `https://api.mexc.com/api/v3/depth?symbol=${realSym}&limit=${depth}`
      : `https://contract.mexc.com/api/v1/contract/depth/${realSym}?limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    if (d && d.success === false) throw new Error(d.message || "MEXC depth error");
    const r = isSpot ? d : (d.data || {});
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q, cs));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "KC") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
    const url = isSpot
      ? `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${realSym}`
      : `https://api-futures.kucoin.com/api/v1/level2/depth100?symbol=${realSym}`;
    const d = await apiFetch(url, reqTimeout, 0);
    const r = d.data || {};
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q, cs));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "BX") {
    const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
    const url = isSpot
      ? `https://open-api.bingx.com/openApi/spot/v1/market/depth?symbol=${realSym}&limit=${depth}`
      : `https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${realSym}&limit=${depth}`;
    const d = await apiFetch(url, reqTimeout, 0);
    const r = d.data || {};
    if (r.bids) bids = r.bids.map(([p, q]) => pair(p, q));
    if (r.asks) asks = r.asks.map(([p, q]) => pair(p, q));
  } else if (ex === "HT") {
    const realSym = isSpot ? sym.replace("_SPOT", "").toLowerCase() : sym;
    const url = isSpot
      ? `https://api.huobi.pro/market/depth?symbol=${realSym}&type=step0`
      : `https://api.hbdm.vn/linear-swap-ex/market/depth?contract_code=${realSym}&type=step0`;
    const d = await apiFetch(url, reqTimeout, 0);
    const tick = d.tick || {};
    if (tick.bids) bids = tick.bids.map(([p, q]) => pair(p, q, cs));
    if (tick.asks) asks = tick.asks.map(([p, q]) => pair(p, q, cs));
  } else if (ex === "HL") {
    const coinName = sym.replace("-USDT", "").replace("USDT", "");
    // nSigFigs is omitted: the aggregated view merges distinct resting orders
    // into buckets, which is precisely what the cluster search must not receive.
    const d = await apiFetch("https://api.hyperliquid.xyz/info", reqTimeout, 0, "POST", { type: "l2Book", coin: coinName });
    const levels = d.levels || [[], []];
    bids = (levels[0] || []).map(l => pair(l.px, l.sz));
    asks = (levels[1] || []).map(l => pair(l.px, l.sz));
  } else if (ex === "AD") {
    const d = await apiFetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${sym}&limit=${depth}`, reqTimeout, 0);
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

  for (const t of tickers.values()) {
    if (!t || !t.ex || !t.sym) continue;
    const list = byExchange.get(t.ex);
    if (!list) continue;
    if (!(Number(t.p) > 0)) continue;
    const vol = Number(t.v) || 0;
    if (vol < MIN_SYMBOL_VOLUME_USD) continue;
    if (!isTradableBase(t.base, t.sym)) continue;
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
    st.fails++;
    exState.failPolls++;
    exState.consecutiveFails++;
    exState.durationMs = now - t0;
    const message = String(err && err.message || err);
    const rateLimited = /429|418|rate|weight|banned|too many/i.test(message);
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
        symbolsScanned: 0, symbolsTotal: 0, coveragePct: 0, coverageCycles: 0,
        lastFullCoverageAt: 0, error: null,
      };
      continue;
    }

    const map = symbolStates.get(ex);
    let wallCount = 0;
    let freshSymbols = 0;
    if (map) {
      for (const symState of map.values()) {
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

    const coveragePct = st.symbolsTotal > 0
      ? Math.min(100, Math.round(freshSymbols / st.symbolsTotal * 100))
      : 0;

    statuses[ex] = {
      status,
      updatedAt: st.updatedAt,
      durationMs: st.durationMs,
      count: wallCount,
      symbolsScanned: freshSymbols,
      symbolsTotal: st.symbolsTotal,
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
  for (const ex of exchanges) {
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
      else continue;

      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      };

      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json();

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
        items = (data.data || []).filter(d => d.symbol && d.symbol.endsWith("USDT")).map(d => ({
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
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.warn(`[SPOT] Failed to load spot symbols for ${ex}:`, e.message);
    }
  }
}

// ═══ Public API ══════════════════════════════════════════════════════════════

function startScanning(tickers, apiFetch, onUpdate) {
  if (engineStarted) return;
  engineStarted = true;
  onUpdateCb = onUpdate || null;

  console.log("[WALL] Density Engine v4 — relative significance, full 11-exchange coverage");
  console.log(`[WALL] band=${MIN_DIST_PCT}%-${MAX_DIST_PCT}%, cluster>=${BASE_CLUSTER_WIDTH_PCT}%, minSignificance=${MIN_SIGNIFICANCE}, tiers=${TIERS.map(t => t.intervalMs).join("/")}ms`);

  updateSpotTickers(tickers).catch(e => console.error("[SPOT] Initial load error:", e.message));
  setInterval(() => {
    updateSpotTickers(tickers).catch(e => console.error("[SPOT] Poll update error:", e.message));
  }, SPOT_REFRESH_MS);

  startUniverseLoop(tickers);
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
  calculateRobustBookStats,
  rankWallByStatistics,
  rankFromSignificance,
  significanceOf,
  percentileRank,
  isTradableBase,
  getWallHistorySnapshot,
  getSymbolDiagnostics,
  resetSymbolState,
};
