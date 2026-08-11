"use strict";

/**
 * Wall Scanner v3 — Adaptive Dynamic Threshold Engine with Progressive Publication
 *
 * KEY PRINCIPLES:
 * 1. Progressive real-time publication: Walls published per exchange completion.
 * 2. Adaptive dynamic thresholds via Statistical Z-Score engine.
 * 3. Persistence tracking: walls must survive ≥2 scans (anti-spoofing).
 * 4. Wide distance range: 0.05% – 5.0% from current price.
 * 5. Isolated per-exchange caching with TTL fallback.
 * 6. Pure deterministic buildWallSnapshot pipeline.
 */

// ═══ Configuration ═══════════════════════════════════════════════════════════

const DEFAULT_SCAN_GAP_MS = 1000;
const DEFAULT_API_TIMEOUT = 8000;
const DEFAULT_POOL_EX = 4;
const POOL_COIN = 32;
const COIN_DELAY_MS = 5;
const DEFAULT_MAX_COINS_PER_EX = 40;

const BIN_STEP_PCT = 0.001; // 0.1% price bins
const Z_THRESHOLD = 3.5;   // mathematical Z-score (X - µ)/σ > 3.5

const MIN_DIST_PCT = 0.05;
const MAX_DIST_PCT = 5.0;

const MAX_OUTPUT = 500;
const MAX_PER_COIN = 5;

const CLUSTER_PCT = 0.1; // cluster walls within 0.1% of each other

// Base liquidity limits per exchange
const EX_LIMITS = {
  BN: 600000, BB: 400000, OX: 300000, BG: 250000,
  KC: 200000, BX: 250000, MX: 1200000, GT: 200000,
  HT: 1200000, HL: 300000, AD: 150000
};

const OB_DEPTH = {
  BN: 100, BB: 500, OX: 400, BG: 150,
  GT: 100, MX: 500, KC: 100, BX: 100,
  HT: 150, HL: 50, AD: 500,
};

const EXCLUDED_BASES = new Set([
  "USDT", "USDC", "DAI", "BUSD", "FDUSD", "TUSD", "USDP", "USDE", "PYUSD", "USD1", "EUR1", "USDC1", "BTC1",
  "XAUT", "PAXG", "XAG", "XAU", "SILVER", "GOLD",
  "EUR", "GBP", "JPY", "AUD", "USD", "CHF", "TRY", "RUB", "BRL",
]);

// ═══ State ═══════════════════════════════════════════════════════════════════

const levelHistory = new Map(); // "EX:SYM:PRICE8" → {firstSeen,lastSeen,scanId,consecutivePresent,misses}
const latestWallsByExchange = new Map();

let detectedWalls = [];
let detectedMetadata = {
  walls: [],
  updatedAt: 0,
  scanId: 0,
  partial: false,
  exchangesReady: 0,
  exchangesTotal: 11,
  exchangeStatuses: {}
};

let scanRunning = false;
let scanCount = 0;
let onUpdateCb = null;
let lastBinanceScanTime = 0;
let lastRawBinanceWalls = [];

// ═══ Helpers ═════════════════════════════════════════════════════════════════

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) * 0.5;
}

function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - pos) + s[hi] * (pos - lo);
}

// ═══ Fetch orderbook ═════════════════════════════════════════════════════════

async function fetchOB(ex, coin, apiFetch, useMaxDepth, timeoutMs) {
  const sym = coin.sym;
  const cs = Number(coin.cs || 1);
  const reqTimeout = timeoutMs || DEFAULT_API_TIMEOUT;
  let depth;
  if (ex === "BN") {
    depth = useMaxDepth ? 500 : 100;
  } else {
    depth = OB_DEPTH[ex] || 500;
  }
  try {
    let bids = [], asks = [];

    if (ex === "BN") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const base = isSpot ? "https://api.binance.com/api/v3" : "https://fapi.binance.com/fapi/v1";
      const d = await apiFetch(`${base}/depth?symbol=${realSym}&limit=${depth}`, reqTimeout, 0);
      if (d.bids) bids = d.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (d.asks) asks = d.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "BB") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const cat = isSpot ? "spot" : "linear";
      const d = await apiFetch(`https://api.bybit.com/v5/market/orderbook?category=${cat}&symbol=${realSym}&limit=${depth}`, reqTimeout, 0);
      const r = d.result || {};
      if (r.b) bids = r.b.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (r.a) asks = r.a.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "OX") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
      const actualCs = isSpot ? 1 : cs;
      const d = await apiFetch(`https://www.okx.com/api/v5/market/books?instId=${realSym}&sz=${depth}`, reqTimeout, 0);
      const book = (d.data || [])[0] || {};
      if (book.bids) bids = book.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (book.asks) asks = book.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "BG") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const url = isSpot
        ? `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${realSym}&limit=${depth}`
        : `https://api.bitget.com/api/v2/mix/market/merge-depth?productType=USDT-FUTURES&symbol=${realSym}&limit=${depth}`;
      const d = await apiFetch(url, reqTimeout, 0);
      const r = d.data || {};
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "GT") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "_USDT") : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${realSym}&limit=${depth}`
        : `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${realSym}&limit=${depth}`;
      const d = await apiFetch(url, reqTimeout, 0);
      if (d.bids) bids = d.bids.map(b => ({ price: +(b.p || b[0]), qty: +(b.s || b[1]), usd: +(b.p || b[0]) * (+(b.s || b[1]) * actualCs) }));
      if (d.asks) asks = d.asks.map(a => ({ price: +(a.p || a[0]), qty: +(a.s || a[1]), usd: +(a.p || a[0]) * (+(a.s || a[1]) * actualCs) }));
    } else if (ex === "MX") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.mexc.com/api/v3/depth?symbol=${realSym}&limit=${depth}`
        : `https://contract.mexc.com/api/v1/contract/depth/${realSym}?limit=${depth}`;
      const d = await apiFetch(url, reqTimeout, 0);
      if (d && d.success === false) {
        console.warn(`[WALL MX ERROR] ${sym}: ${d.message || JSON.stringify(d)}`);
      }
      const r = isSpot ? d : (d.data || {});
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "KC") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${realSym}`
        : `https://api-futures.kucoin.com/api/v1/level2/depth100?symbol=${realSym}`;
      const d = await apiFetch(url, reqTimeout, 0);
      const r = d.data || {};
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "BX") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "").replace(/USDT$/, "-USDT") : sym;
      const url = isSpot
        ? `https://open-api.bingx.com/openApi/spot/v1/market/depth?symbol=${realSym}&limit=${depth}`
        : `https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${realSym}&limit=${depth}`;
      const d = await apiFetch(url, reqTimeout, 0);
      const r = d.data || {};
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "HT") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "").toLowerCase() : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.huobi.pro/market/depth?symbol=${realSym}&type=step0`
        : `https://api.hbdm.vn/linear-swap-ex/market/depth?contract_code=${realSym}&type=step0`;
      const d = await apiFetch(url, reqTimeout, 0);
      const tick = d.tick || {};
      if (tick.bids) bids = tick.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (tick.asks) asks = tick.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "HL") {
      const coinName = sym.replace("-USDT", "").replace("USDT", "");
      const d = await apiFetch("https://api.hyperliquid.xyz/info", reqTimeout, 0, "POST", { type: "l2Book", coin: coinName, nSigFigs: 4 });
      const levels = d.levels || [[], []];
      bids = (levels[0] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
      asks = (levels[1] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
    } else if (ex === "AD") {
      const d = await apiFetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${sym}&limit=${depth}`, reqTimeout, 0);
      if (d.bids) bids = d.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (d.asks) asks = d.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    }

    return { bids, asks };
  } catch (e) {
    if (ex === "MX" || ex === "BG") console.warn(`[WALL ERROR] ${ex}:${sym} failed: ${e.message}`);
    return { bids: [], asks: [] };
  }
}

// ═══ Process one coin's orderbook ════════════════════════════════════════════

function binOrders(orders, currentPrice, side) {
  const bins = new Map();
  const step = currentPrice * BIN_STEP_PCT;

  for (const o of orders) {
    if (o.usd <= 0) continue;
    const distPct = Math.abs(o.price - currentPrice) / currentPrice;
    if (distPct > MAX_DIST_PCT / 100) continue;

    const binIdx = side === "bid" ? Math.floor(o.price / step) : Math.ceil(o.price / step);
    if (!bins.has(binIdx)) {
      const binPrice = side === "bid" ? (binIdx * step) + (step / 2) : (binIdx * step) - (step / 2);
      bins.set(binIdx, { price: binPrice, usd: 0, count: 0, maxOrderPrice: o.price, maxOrderUsd: o.usd });
    }
    const b = bins.get(binIdx);
    b.usd += o.usd;
    b.count++;
    if (o.usd > b.maxOrderUsd) {
      b.maxOrderUsd = o.usd;
      b.maxOrderPrice = o.price;
    }
  }
  return Array.from(bins.values());
}

function processOrderbook(ex, coin, bids, asks, currentScanId) {
  const price = coin.p;
  if (!price || price <= 0) return [];
  if (EXCLUDED_BASES.has(coin.base)) return [];

  const binnedBids = binOrders(bids.slice(2), price, "bid");
  const binnedAsks = binOrders(asks.slice(2), price, "ask");

  const calculateZStats = (arr) => {
    const vals = arr.filter(b => b.usd > 0).map(b => b.usd);
    if (!vals.length) return { mu: 0, sigma: 1 };

    const sum = vals.reduce((a, b) => a + b, 0);
    const mu = sum / vals.length;

    const sqDiffSum = vals.reduce((a, b) => a + Math.pow(b - mu, 2), 0);
    const variance = sqDiffSum / vals.length;
    let sigma = Math.sqrt(variance);

    if (sigma < 1) sigma = 1;
    return { mu, sigma };
  };

  const bidStats = calculateZStats(binnedBids);
  const askStats = calculateZStats(binnedAsks);

  const walls = [];

  const processBin = (bin, side) => {
    if (!bin.usd || isNaN(bin.usd)) return;

    const dist = Math.abs(bin.price - price) / price * 100;
    if (dist < MIN_DIST_PCT || dist > MAX_DIST_PCT) return;

    const stats = side === "bid" ? bidStats : askStats;
    const Z = (bin.usd - stats.mu) / stats.sigma;
    const minZ = ex === "HL" ? 1.0 : Z_THRESHOLD;
    if (Z < minZ) return;

    let minDust = 30000;
    if (ex === "BN" || ex === "BB") minDust = 50000;
    if (ex === "BX") minDust = 250000;

    if (coin.v && coin.v > 0) {
      const volReq = ex === "BX"
        ? Math.min(3000000, coin.v * 0.0015)
        : Math.min(3000000, coin.v * 0.0005);
      minDust = Math.max(minDust, volReq);
    }

    if (bin.usd < minDust) return;

    const tph = coin.trades || 0;
    let activityBonus = 1.0;

    if (tph < 50) {
      if (bin.usd > 500000) activityBonus = 0.5;
    } else if (tph > 2000) {
      activityBonus = 1.2;
    }

    const relSize = Z;

    const lk = `${ex}:${coin.sym}:${side}:${+bin.maxOrderPrice.toPrecision(7)}`;
    let h = levelHistory.get(lk);
    const now = Date.now();

    if (h && h.scanId === currentScanId) {
      return;
    }

    if (!h) {
      h = { firstSeen: now, lastSeen: now, scanId: currentScanId, consecutivePresent: 1, misses: 0 };
      levelHistory.set(lk, h);
    } else {
      const timeSinceLastSeen = now - h.lastSeen;
      const maxMissGapMs = 10000;

      if (h.scanId === currentScanId - 1) {
        h.consecutivePresent++;
        h.misses = 0;
      } else if (timeSinceLastSeen <= maxMissGapMs) {
        h.consecutivePresent++;
        h.misses = 0;
      } else {
        h.firstSeen = now;
        h.consecutivePresent = 1;
        h.misses = 1;
      }
      h.scanId = currentScanId;
      h.lastSeen = now;
    }

    if (ex === "BX" && h.consecutivePresent < 2) return;

    const wallScore = (relSize / Z_THRESHOLD) * 5 * activityBonus / (1 + dist * 0.5);
    let wallRank = 1;
    if (ex === "HL") {
      if (relSize <= 1.2) wallRank = 2;
      else if (relSize <= 1.5) wallRank = 3;
      else if (relSize <= 1.8) wallRank = 4;
      else if (relSize <= 2.2) wallRank = 5;
      else if (relSize <= 2.5) wallRank = 6;
      else if (relSize <= 3.2) wallRank = 7;
      else if (relSize <= 4.0) wallRank = 8;
      else if (relSize <= 5.0) wallRank = 9;
      else wallRank = 10;
    } else {
      if (relSize <= 3.8) wallRank = 2;
      else if (relSize <= 4.5) wallRank = 3;
      else if (relSize <= 5.0) wallRank = 4;
      else if (relSize <= 5.5) wallRank = 5;
      else if (relSize <= 6.0) wallRank = 6;
      else if (relSize <= 7.0) wallRank = 7;
      else if (relSize <= 8.5) wallRank = 8;
      else if (relSize <= 11.0) wallRank = 9;
      else wallRank = 10;
    }

    walls.push({
      base: coin.base,
      ex,
      sym: coin.sym,
      side,
      price: bin.price,
      S: bin.usd,
      wallK: Math.round(bin.usd / 1000),
      rtwi: +wallScore.toFixed(2),
      pct: +dist.toFixed(3),
      relSize: +relSize.toFixed(1),
      market: coin.sym.endsWith("_SPOT") ? "spot" : "futures",
      age: Math.round((now - h.firstSeen) / 1000),
      firstSeenAt: h.firstSeen,
      lastSeenAt: h.lastSeen,
      lifeMs: now - h.firstSeen,
      count: bin.count,
      rank: wallRank,
    });
  };

  binnedBids.forEach(b => processBin(b, "bid"));
  binnedAsks.forEach(b => processBin(b, "ask"));

  return walls;
}

// ═══ Cluster nearby walls ════════════════════════════════════════════════════

function clusterWalls(walls) {
  if (!Array.isArray(walls) || !walls.length) return [];
  const sorted = walls.slice().sort((a, b) => a.price - b.price);
  const out = [];
  let cur = { ...sorted[0], startPrice: sorted[0].price };

  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const gap = Math.abs(w.price - cur.startPrice) / cur.startPrice * 100;

    if (gap <= CLUSTER_PCT && w.side === cur.side) {
      cur.S += w.S;
      cur.wallK = Math.round(cur.S / 1000);
      cur.rtwi = Math.max(cur.rtwi, w.rtwi);
      cur.relSize = Math.max(cur.relSize, w.relSize);
      cur.count++;
      cur.price = (cur.price * (cur.count - 1) + w.price) / cur.count;
      cur.pct = +((cur.pct * (cur.count - 1) + w.pct) / cur.count).toFixed(3);
      cur.firstSeenAt = Math.min(cur.firstSeenAt || Infinity, w.firstSeenAt || Infinity);
      cur.lastSeenAt = Math.max(cur.lastSeenAt || 0, w.lastSeenAt || 0);
      if (Number.isFinite(cur.firstSeenAt) && cur.firstSeenAt !== Infinity && cur.lastSeenAt) {
        cur.lifeMs = Math.max(0, cur.lastSeenAt - cur.firstSeenAt);
        cur.age = Math.round(cur.lifeMs / 1000);
      } else {
        cur.age = Math.max(cur.age, w.age || 0);
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

// ═══ Pure Snapshot Builder ═══════════════════════════════════════════════════

function buildWallSnapshot(allWalls, options = {}) {
  if (!Array.isArray(allWalls) || allWalls.length === 0) return [];

  const maxOutput = Number.isInteger(options.maxOutput) && options.maxOutput > 0
    ? options.maxOutput
    : Math.max(50, Math.min(1000, parseInt(process.env.WALL_MAX_RESULTS, 10) || MAX_OUTPUT));
  const maxPerCoin = Number.isInteger(options.maxPerCoin) && options.maxPerCoin > 0
    ? options.maxPerCoin
    : MAX_PER_COIN;

  const validWalls = [];
  for (let i = 0; i < allWalls.length; i++) {
    const w = allWalls[i];
    if (!w || typeof w !== "object") continue;
    const price = Number(w.price);
    const S = Number(w.S);
    const pct = Number(w.pct);
    const rtwi = Number(w.rtwi);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(S) || S <= 0) continue;
    if (!Number.isFinite(pct) || pct < 0) continue;
    if (!Number.isFinite(rtwi)) continue;
    if (!w.base || typeof w.base !== "string") continue;
    if (!w.ex || typeof w.ex !== "string") continue;
    if (!w.sym || typeof w.sym !== "string") continue;
    if (w.side !== "bid" && w.side !== "ask") continue;

    validWalls.push({
      ...w,
      price,
      S,
      pct,
      rtwi,
      wallK: Math.round(S / 1000),
      market: w.market || (w.sym.endsWith("_SPOT") ? "spot" : "futures"),
    });
  }

  if (validWalls.length === 0) return [];

  const groups = new Map();
  for (const w of validWalls) {
    const k = `${w.ex}:${w.base}:${w.side}:${w.market}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(w);
  }

  const clustered = [];
  for (const [, cw] of groups) {
    clustered.push(...clusterWalls(cw));
  }

  clustered.sort((a, b) => b.rtwi - a.rtwi || b.S - a.S);

  const coinCount = new Map();
  const limited = [];
  for (const w of clustered) {
    const cnt = coinCount.get(w.base) || 0;
    if (cnt >= maxPerCoin) continue;
    coinCount.set(w.base, cnt + 1);
    limited.push(w);
  }

  return limited.slice(0, maxOutput);
}

// ═══ Progressive Snapshot Assembly & Callback ════════════════════════════════

function refreshSnapshotAndPublish(currentScanId, exchangesTotal) {
  const ttlMs = Math.max(10000, parseInt(process.env.WALL_EXCHANGE_CACHE_TTL_MS, 10) || 90000);
  const now = Date.now();
  const allActiveWalls = [];
  const exchangeStatuses = {};
  let exchangesReady = 0;

  const EXCHANGES = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];
  for (const ex of EXCHANGES) {
    const cached = latestWallsByExchange.get(ex);
    if (cached) {
      const isStale = (now - cached.updatedAt) > ttlMs;
      exchangeStatuses[ex] = {
        status: isStale ? "stale" : cached.status,
        updatedAt: cached.updatedAt,
        durationMs: cached.durationMs,
        count: cached.walls ? cached.walls.length : 0,
        error: cached.error || null
      };
      if (!isStale && cached.walls && cached.walls.length > 0) {
        allActiveWalls.push(...cached.walls);
      }
      if (!isStale && (cached.status === "ok" || cached.status === "stale")) {
        exchangesReady++;
      }
    } else {
      exchangeStatuses[ex] = {
        status: "pending",
        updatedAt: 0,
        durationMs: 0,
        count: 0,
        error: null
      };
    }
  }

  detectedWalls = buildWallSnapshot(allActiveWalls);
  detectedMetadata = {
    walls: detectedWalls,
    updatedAt: now,
    scanId: currentScanId,
    partial: exchangesReady < exchangesTotal,
    exchangesReady,
    exchangesTotal,
    exchangeStatuses
  };

  if (onUpdateCb) {
    try {
      onUpdateCb(detectedMetadata);
    } catch (err) {
      console.error("[WALL] Update callback error:", err.message);
    }
  }
}

// ═══ Scan one exchange ═══════════════════════════════════════════════════════

async function scanExchange(ex, tickers, apiFetch, currentScanId, symbolLimit, requestTimeoutMs) {
  const maxCoins = symbolLimit || Math.max(5, Math.min(200, parseInt(process.env.WALL_SCAN_SYMBOL_LIMIT, 10) || DEFAULT_MAX_COINS_PER_EX));

  const exCoins = [];
  for (const [, t] of tickers) {
    if (t.ex === ex && t.p > 0 && t.v >= 1000000) {
      if (EXCLUDED_BASES.has(t.base)) continue;
      if (ex === "BX" && t.sym.endsWith("_SPOT")) continue;
      exCoins.push(t);
    }
  }

  exCoins.sort((a, b) => (b.v || 0) - (a.v || 0));
  if (exCoins.length > maxCoins) exCoins.length = maxCoins;

  const chunkSize = ex === "MX" ? 2 : (ex === "BG" ? 4 : ((ex === "KC" || ex === "OX") ? 3 : POOL_COIN));
  const delayMs = ex === "MX" ? 380 : (ex === "BG" ? 250 : ((ex === "KC" || ex === "OX") ? 200 : COIN_DELAY_MS));

  const walls = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < exCoins.length; i += chunkSize) {
    const batch = exCoins.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      batch.map(async (coin) => {
        try {
          const coinIdx = exCoins.indexOf(coin);
          const useMaxDepth = coinIdx < 20 || (coin.v || 0) >= 50000000;
          const { bids, asks } = await fetchOB(ex, coin, apiFetch, useMaxDepth, requestTimeoutMs);
          if (!bids.length && !asks.length) { fail++; return []; }
          ok++;
          return processOrderbook(ex, coin, bids, asks, currentScanId);
        } catch (e) {
          if (ex === "MX" || ex === "BG") console.warn(`[WALL ERROR] ${ex}:${coin.sym} failed: ${e.message}`);
          fail++;
          return [];
        }
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) walls.push(...r.value);
    }
    if (i + chunkSize < exCoins.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`[WALL] ${ex}: ${exCoins.length} coins, ${ok} OK, ${fail} fail, ${walls.length} raw walls`);
  walls.symbolsScanned = exCoins.length;
  return walls;
}

// ═══ Full scan cycle ═════════════════════════════════════════════════════════

async function runFullScan(tickers, apiFetch) {
  if (scanRunning) return;
  scanRunning = true;
  const t0 = Date.now();
  scanCount++;
  const currentScanId = scanCount;

  const symbolLimit = Math.max(5, Math.min(200, parseInt(process.env.WALL_SCAN_SYMBOL_LIMIT, 10) || DEFAULT_MAX_COINS_PER_EX));
  const reqTimeout = Math.max(1000, Math.min(30000, parseInt(process.env.WALL_REQUEST_TIMEOUT_MS, 10) || DEFAULT_API_TIMEOUT));
  const concurrency = Math.max(1, Math.min(11, parseInt(process.env.WALL_SCAN_CONCURRENCY, 10) || DEFAULT_POOL_EX));

  const exchanges = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];

  try {
    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < exchanges.length; i += concurrency) {
      const chunk = exchanges.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async (ex) => {
          const exT0 = Date.now();
          try {
            let res = [];
            if (ex === "BN") {
              const now = Date.now();
              if (now - lastBinanceScanTime < 45000 && lastRawBinanceWalls.length > 0) {
                for (const w of lastRawBinanceWalls) {
                  const t = tickers.get(`BN:${w.sym}`);
                  if (t && t.p > 0) {
                    const dist = Math.abs(w.price - t.p) / t.p * 100;
                    w.pct = +dist.toFixed(3);
                  }
                }
                res = lastRawBinanceWalls;
              } else {
                lastBinanceScanTime = now;
                res = await scanExchange(ex, tickers, apiFetch, currentScanId, symbolLimit, reqTimeout);
                lastRawBinanceWalls = res;
              }
            } else {
              res = await scanExchange(ex, tickers, apiFetch, currentScanId, symbolLimit, reqTimeout);
            }

            const durationMs = Date.now() - exT0;
            latestWallsByExchange.set(ex, {
              walls: res,
              updatedAt: Date.now(),
              durationMs,
              status: "ok",
              error: null,
              symbolsScanned: res.symbolsScanned || symbolLimit
            });
            okCount++;

            refreshSnapshotAndPublish(currentScanId, exchanges.length);
          } catch (e) {
            const durationMs = Date.now() - exT0;
            console.warn(`[WALL] Exchange ${ex} failed after ${durationMs}ms: ${e.message}`);
            failCount++;

            const prev = latestWallsByExchange.get(ex);
            latestWallsByExchange.set(ex, {
              walls: prev ? prev.walls : [],
              updatedAt: prev ? prev.updatedAt : Date.now(),
              durationMs,
              status: e.name === "AbortError" || e.message?.includes("timeout") ? "timeout" : "error",
              error: e.message,
              symbolsScanned: 0
            });

            refreshSnapshotAndPublish(currentScanId, exchanges.length);
          }
        })
      );
    }

    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, h] of levelHistory) {
      if (h.lastSeen < cutoff) levelHistory.delete(key);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[WALL] Scan #${currentScanId} completed in ${elapsed}s: ${okCount} OK, ${failCount} fail, ${detectedWalls.length} output walls`);

  } catch (e) {
    console.error("[WALL] Scan error:", e.message);
  } finally {
    scanRunning = false;
  }
}

// ═══ Centralized Spot Tick Loading & Polling ═════════════════════════════════

async function updateSpotTickers(tickers) {
  const exchanges = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT"];
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
      else if (ex === "BX") url = "https://open-api.bingx.com/openApi/spot/v1/ticker/24hr";
      else if (ex === "HT") url = "https://api.huobi.pro/market/tickers";

      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      };

      const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const data = await r.json();

      let items = [];
      if (ex === "BN" || ex === "MX") {
        items = data.filter(d => d.symbol.endsWith("USDT")).map(d => ({
          sym: d.symbol + "_SPOT",
          base: d.symbol.replace(/USDT$/, ""),
          p: +d.lastPrice,
          v: +d.quoteVolume
        }));
      } else if (ex === "BB") {
        items = (data.result?.list || []).filter(d => d.symbol.endsWith("USDT")).map(d => ({
          sym: d.symbol + "_SPOT",
          base: d.symbol.replace(/USDT$/, ""),
          p: +d.lastPrice,
          v: +d.turnover24h
        }));
      } else if (ex === "OX") {
        items = (data.data || []).filter(d => d.instId.endsWith("-USDT")).map(d => ({
          sym: d.instId.replace("-", "") + "_SPOT",
          base: d.instId.split("-")[0],
          p: +d.last,
          v: +d.volCcy24h
        }));
      } else if (ex === "BG") {
        items = (data.data || []).filter(d => d.symbol.endsWith("USDT")).map(d => ({
          sym: d.symbol + "_SPOT",
          base: d.symbol.replace(/USDT$/, ""),
          p: +d.lastPr,
          v: +d.usdtVolume
        }));
      } else if (ex === "GT") {
        items = data.filter(d => d.currency_pair.endsWith("_USDT")).map(d => ({
          sym: d.currency_pair.replace("_", "") + "_SPOT",
          base: d.currency_pair.split("_")[0],
          p: +d.last,
          v: +d.quote_volume
        }));
      } else if (ex === "KC") {
        items = (data.data?.ticker || []).filter(d => d.symbol.endsWith("-USDT")).map(d => ({
          sym: d.symbol.replace("-", "") + "_SPOT",
          base: d.symbol.split("-")[0],
          p: +d.last,
          v: +d.volValue
        }));
      } else if (ex === "BX") {
        items = (data.data || []).filter(d => d.symbol.endsWith("-USDT")).map(d => ({
          sym: d.symbol.replace("-", "") + "_SPOT",
          base: d.symbol.split("-")[0],
          p: +d.lastPrice,
          v: +d.quoteVolume
        }));
      } else if (ex === "HT") {
        items = (data.data || []).filter(d => d.symbol.endsWith("usdt")).map(d => ({
          sym: d.symbol.toUpperCase() + "_SPOT",
          base: d.symbol.replace(/usdt$/, "").toUpperCase(),
          p: +d.close,
          v: +d.vol
        }));
      }

      for (const item of items) {
        if (!item.p || !item.v || isNaN(item.p) || isNaN(item.v)) continue;
        const key = `${ex}:${item.sym}`;
        tickers.set(key, {
          key,
          ex,
          sym: item.sym,
          base: item.base,
          p: item.p,
          chg: 0,
          v: item.v,
          h: item.p,
          l: item.p,
          o: item.p,
          funding: 0,
          nextFunding: 0,
          cs: 1
        });
      }
    } catch (e) {
      console.warn(`[SPOT] Failed to load spot symbols for ${ex}:`, e.message);
    }
  }
}

// ═══ Continuous scan loop ════════════════════════════════════════════════════

async function scanLoop(tickers, apiFetch) {
  while (true) {
    const scanInterval = Math.max(1000, Math.min(60000, parseInt(process.env.WALL_SCAN_INTERVAL_MS, 10) || DEFAULT_SCAN_GAP_MS));
    await runFullScan(tickers, apiFetch);
    await new Promise(r => setTimeout(r, scanInterval));
  }
}

// ═══ Public API ══════════════════════════════════════════════════════════════

module.exports = {
  getWalls: () => detectedWalls,
  getMetadata: () => detectedMetadata,
  buildWallSnapshot,
  clusterWalls,
  startScanning: (tickers, apiFetch, onUpdate) => {
    console.log("[WALL] Starting Wall Scanner v3 — Statistical Z-Score Engine with Progressive Publication");
    console.log("[WALL] Config: Limit=" + DEFAULT_MAX_COINS_PER_EX + ", Z_THRESHOLD=" + Z_THRESHOLD + ", dist=" + MIN_DIST_PCT + "%-" + MAX_DIST_PCT + "%");
    onUpdateCb = onUpdate || null;

    updateSpotTickers(tickers).catch(e => console.error("[SPOT] Initial load error:", e.message));

    setInterval(() => {
      updateSpotTickers(tickers).catch(e => console.error("[SPOT] Poll update error:", e.message));
    }, 60000);

    setTimeout(() => scanLoop(tickers, apiFetch), 6000);
  },
};
