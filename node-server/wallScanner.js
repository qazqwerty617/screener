"use strict";

/**
 * Wall Scanner v4 — Robust MAD Z-Score Engine
 *
 * МАТЕМАТИЧЕСКАЯ ФОРМУЛА (идеальная):
 * ═══════════════════════════════════
 * 1. Binning: ордера группируются в ценовые бины шириной 0.25% от цены
 * 2. Robust Z-Score: вместо σ (standard deviation) используем MAD:
 *      MAD = median(|Xi - median(X)|)
 *      ModifiedZ = 0.6745 × (Xi - median) / MAD
 *    Это устойчиво к выбросам (фейковые стены MEXC/HTX не раздувают σ)
 * 3. Multi-layer фильтрация:
 *    a) ModifiedZ ≥ 4.0 (статистически значимый выброс)
 *    b) Минимум USD = max(ExchangeFloor, Volume×Ratio)
 *    c) Минимум 2 ордера в бине (одиночный гигант = спуфинг)
 *    d) Дистанция 0.08% – 5.0% от цены
 * 4. WallScore = (Z/4)^0.8 × VolumeFraction × 1/(1 + dist×0.3)
 *    VolumeFraction = binUSD / (coin24hVol × exWeight) — нормализация по ликвидности
 *
 * ANTI-SPOOF:
 *   - Одиночный ордер > 80% бина → score × 0.3 (вероятный спуф)
 *   - MEXC/HTX: жёсткие потолки + x3 минимумы
 *   - Бины с < 2 ордерами штрафуются
 */

// ═══ Timing ══════════════════════════════════════════════════════════════════

const REST_SCAN_GAP_MS = {
  BN: 120000, BB: 5000, OX: 6000, BG: 5000,
  MX: 8000,  KC: 6000, BX: 5000, HT: 8000,
  GT: 8000,  HL: 5000, AD: 5000,
};
const GLOBAL_SCAN_LOOP_MS = 1500;  // faster loop

const API_TIMEOUT    = 2500;
const POOL_EX        = 11;
const POOL_COIN      = 30;
const COIN_DELAY_MS  = 30;
const MAX_COINS_PER_EX = 9999; // ALL coins

// ═══ Physics Constants ═══════════════════════════════════════════════════════

const BIN_STEP_PCT   = 0.0035;  // 0.35% bins
const MAD_Z_THRESH   = 9.5;     // Stricter Z-score (was 6.0)
const MIN_DIST_PCT   = 0.10;    // Min distance from price (%)
const MAX_DIST_PCT   = 5.0;     // Max distance from price (%)
const CLUSTER_PCT    = 0.40;    // Merge walls within 0.40% (better aggregation)
const MAX_OUTPUT     = 80;      // Top walls
const MAX_PER_COIN   = 3;       // Max walls per coin
const MIN_ORDERS_IN_BIN = 2;    // Min orders in a bin

// EX_CONFIG: floor (absolute min USD), vr (% of 24h vol), ceil (absolute max), depth, sp (spoof penalty)
// vr heavily limits high-volume coins like BTC: e.g. vr:0.008 on $2B vol requires $16M absolute min wall
const EX_CONFIG = {
  //           floor        volRatio  ceiling       depth  spoofPenalty
  BN: { floor: 1000000,  vr: 0.0120, ceil: 80000000,  depth: 1000, sp: 1.0  }, 
  BB: { floor: 700000,   vr: 0.0100, ceil: 50000000,  depth: 500,  sp: 0.85 },
  OX: { floor: 600000,   vr: 0.0100, ceil: 40000000,  depth: 400,  sp: 0.9  },
  BG: { floor: 500000,   vr: 0.0120, ceil: 20000000,  depth: 100,  sp: 0.8  },
  GT: { floor: 400000,   vr: 0.0120, ceil: 15000000,  depth: 100,  sp: 0.7  },
  KC: { floor: 400000,   vr: 0.0120, ceil: 10000000,  depth: 100,  sp: 0.7  },
  // "Шумные" биржи — ультра-жёсткие
  MX: { floor: 5000000,  vr: 0.0220, ceil: 90000000,  depth: 500,  sp: 0.3  }, 
  BX: { floor: 600000,   vr: 0.0150, ceil: 20000000,  depth: 100,  sp: 0.5  }, 
  HT: { floor: 5000000,  vr: 0.0220, ceil: 70000000,  depth: 150,  sp: 0.3  },
  // DEX / Новые
  HL: { floor: 300000,   vr: 0.0075, ceil: 15000000,  depth: 50,   sp: 1.0  },
  AD: { floor: 250000,   vr: 0.0090, ceil: 8000000,   depth: 100,  sp: 0.8  },
};

const EXCLUDED_BASES = new Set([
  "USDT","USDC","DAI","BUSD","FDUSD","TUSD","USDP","USDE","PYUSD","USD1","EUR1","USDC1","BTC1",
  "XAUT","PAXG","XAG","XAU","SILVER","GOLD",
  "EUR","GBP","JPY","AUD","USD","CHF","TRY","RUB","BRL",
]);

// ═══ State ═══════════════════════════════════════════════════════════════════

let detectedWalls = [];
let scanRunning = false;
let scanCount = 0;
let onUpdateCb = null;
const wsWalls = new Map();

// ═══ Robust Statistics ═══════════════════════════════════════════════════════

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : (s[m - 1] + s[m]) * 0.5;
}

/**
 * MAD = Median Absolute Deviation
 * Modified Z-score = 0.6745 × (x - median) / MAD
 * 0.6745 is the 0.75th quantile of the standard normal distribution,
 * making MAD consistent with σ for normal distributions.
 * 
 * Key advantage: single outlier (spoof order) doesn't inflate the scale.
 */
function madStats(values) {
  if (values.length < 3) return { med: 0, mad: 1 };
  const med = median(values);
  const absDevs = values.map(v => Math.abs(v - med));
  let mad = median(absDevs);
  // CRITICAL: floor MAD to 5% of median to prevent Z-score explosion
  // on deep uniform orderbooks (e.g. BTC on Binance where every level ≈ $1M)
  const madFloor = Math.max(med * 0.05, 100);
  if (mad < madFloor) mad = madFloor;
  return { med, mad };
}

function modifiedZScore(value, med, mad) {
  const raw = 0.6745 * (value - med) / mad;
  return Math.min(raw, 50); // Cap at 50 to prevent score explosion
}

// ═══ Fetch Orderbook ═════════════════════════════════════════════════════════

async function fetchOB(ex, coin, apiFetch) {
  const sym = coin.sym;
  const cs = Number(coin.cs || 1);
  const cfg = EX_CONFIG[ex] || EX_CONFIG.AD;
  const depth = cfg.depth;
  try {
    let bids = [], asks = [];

    if (ex === "BN") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const base = isSpot ? "https://api.binance.com/api/v3" : "https://fapi.binance.com/fapi/v1";
      const d = await apiFetch(`${base}/depth?symbol=${realSym}&limit=${depth}`, API_TIMEOUT, 0);
      if (d.bids) bids = d.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (d.asks) asks = d.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "BB") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const cat = isSpot ? "spot" : "linear";
      const d = await apiFetch(`https://api.bybit.com/v5/market/orderbook?category=${cat}&symbol=${realSym}&limit=${depth}`, API_TIMEOUT, 0);
      const r = d.result || {};
      if (r.b) bids = r.b.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (r.a) asks = r.a.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "OX") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const actualCs = isSpot ? 1 : cs;
      const d = await apiFetch(`https://www.okx.com/api/v5/market/books?instId=${realSym}&sz=${depth}`, API_TIMEOUT, 0);
      const book = (d.data || [])[0] || {};
      if (book.bids) bids = book.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (book.asks) asks = book.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "BG") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const url = isSpot
        ? `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${realSym}&limit=${depth}`
        : `https://api.bitget.com/api/v2/mix/market/orderbook?productType=USDT-FUTURES&symbol=${realSym}&limit=${depth}`;
      const d = await apiFetch(url, API_TIMEOUT, 0);
      const r = d.data || {};
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "GT") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${realSym}&limit=${depth}`
        : `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${realSym}&limit=${depth}`;
      const d = await apiFetch(url, API_TIMEOUT, 0);
      if (d.bids) bids = d.bids.map(b => ({ price: +(b.p || b[0]), qty: +(b.s || b[1]), usd: +(b.p || b[0]) * (+(b.s || b[1]) * actualCs) }));
      if (d.asks) asks = d.asks.map(a => ({ price: +(a.p || a[0]), qty: +(a.s || a[1]), usd: +(a.p || a[0]) * (+(a.s || a[1]) * actualCs) }));
    } else if (ex === "MX") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.mexc.com/api/v3/depth?symbol=${realSym}&limit=${depth}`
        : `https://contract.mexc.com/api/v1/contract/depth/${realSym}?limit=${depth}`;
      const d = await apiFetch(url, API_TIMEOUT, 0);
      const r = isSpot ? d : (d.data || {});
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "KC") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${realSym}`
        : `https://api-futures.kucoin.com/api/v1/level2/depth100?symbol=${realSym}`;
      const d = await apiFetch(url, API_TIMEOUT, 0);
      const r = d.data || {};
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "BX") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "") : sym;
      const url = isSpot
        ? `https://open-api.bingx.com/openApi/spot/v1/market/depth?symbol=${realSym}&limit=${depth}`
        : `https://open-api.bingx.com/openApi/swap/v2/quote/depth?symbol=${realSym}&limit=${depth}`;
      const d = await apiFetch(url, API_TIMEOUT, 0);
      const r = d.data || {};
      if (r.bids) bids = r.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (r.asks) asks = r.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    } else if (ex === "HT") {
      const isSpot = sym.endsWith("_SPOT");
      const realSym = isSpot ? sym.replace("_SPOT", "").toLowerCase() : sym;
      const actualCs = isSpot ? 1 : cs;
      const url = isSpot
        ? `https://api.huobi.pro/market/depth?symbol=${realSym}&type=step0`
        : `https://api.hbdm.com/linear-swap-ex/market/depth?contract_code=${realSym}&type=step0`;
      const d = await apiFetch(url, API_TIMEOUT, 0);
      const tick = d.tick || {};
      if (tick.bids) bids = tick.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (tick.asks) asks = tick.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "HL") {
      const hlCoin = sym.replace("-USDT","").replace("USDT","");
      const d = await apiFetch("https://api.hyperliquid.xyz/info", API_TIMEOUT, 0, "POST", { type: "l2Book", coin: hlCoin });
      const levels = d.levels || [[], []];
      bids = (levels[0] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
      asks = (levels[1] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
    } else if (ex === "AD") {
      const d = await apiFetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${sym}&limit=${depth}`, API_TIMEOUT, 0);
      if (d.bids) bids = d.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (d.asks) asks = d.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    }

    return { bids, asks };
  } catch (_) {
    return { bids: [], asks: [] };
  }
}

// ═══ Binning Engine ══════════════════════════════════════════════════════════

const refPriceCache = new Map();

function binOrders(sym, orders, currentPrice, side) {
  const bins = new Map();

  // Anchor step to prevent jitter
  if (!refPriceCache.has(sym)) refPriceCache.set(sym, currentPrice);
  const refPrice = refPriceCache.get(sym);
  const step = refPrice * BIN_STEP_PCT;

  for (const o of orders) {
    if (o.usd <= 0) continue;
    const distPct = Math.abs(o.price - currentPrice) / currentPrice * 100;
    if (distPct > MAX_DIST_PCT || distPct < MIN_DIST_PCT * 0.5) continue;

    const binIdx = Math.round(o.price / step);
    if (!bins.has(binIdx)) {
      bins.set(binIdx, { price: binIdx * step, usd: 0, count: 0, maxSingle: 0 });
    }
    const b = bins.get(binIdx);
    b.usd += o.usd;
    b.count++;
    if (o.usd > b.maxSingle) b.maxSingle = o.usd;
  }

  return Array.from(bins.values());
}

// ═══ Process One Coin ════════════════════════════════════════════════════════

function processOrderbook(ex, coin, bids, asks) {
  const price = coin.p;
  if (!price || price <= 0) return [];
  if (EXCLUDED_BASES.has(coin.base)) return [];

  const cfg = EX_CONFIG[ex] || EX_CONFIG.AD;

  // Skip first 3 levels (spread noise)
  const binnedBids = binOrders(coin.sym, bids.slice(3), price, "bid");
  const binnedAsks = binOrders(coin.sym, asks.slice(3), price, "ask");

  // ── Robust Z-Score stats per side ──
  const getStats = (bins) => {
    const vals = bins.filter(b => b.usd > 0).map(b => b.usd);
    return madStats(vals);
  };

  const bidStats = getStats(binnedBids);
  const askStats = getStats(binnedAsks);

  // ── Dynamic minimum USD ──
  // = max(exchangeFloor, coin24hVol × volRatio)
  // Caps at ceiling to reject impossible values
  const vol24 = coin.v || 0;
  const volMin = vol24 > 0 ? vol24 * cfg.vr : 0;
  const minUSD = Math.max(cfg.floor, volMin);

  const walls = [];

  const processBin = (bin, side) => {
    if (!bin.usd || isNaN(bin.usd)) return;

    // 1. Distance filter
    const dist = Math.abs(bin.price - price) / price * 100;
    if (dist < MIN_DIST_PCT || dist > MAX_DIST_PCT) return;

    // 2. Ceiling filter — reject impossibly large walls (API errors / fake data)
    if (bin.usd > cfg.ceil) return;

    // 3. Minimum USD filter
    if (bin.usd < minUSD) return;

    // 4. Robust Z-Score filter
    const stats = side === "bid" ? bidStats : askStats;
    const Z = modifiedZScore(bin.usd, stats.med, stats.mad);
    if (Z < MAD_Z_THRESH) return;

    // 5. Anti-spoof: single order dominance penalty
    let spoofMult = 1.0;
    if (bin.count < MIN_ORDERS_IN_BIN) {
      spoofMult *= 0.4; // Single order = very suspicious
    }
    if (bin.maxSingle > bin.usd * 0.80 && bin.count > 1) {
      spoofMult *= 0.5; // One order is >80% of the bin
    }

    // 6. Exchange spoof penalty (noisy exchanges)
    spoofMult *= cfg.sp;

    // 7. Activity bonus (trade velocity)
    const tph = coin.trades || 0;
    let activityMult = 1.0;
    if (tph < 30) activityMult = 0.6;       // Dead coin
    else if (tph > 2000) activityMult = 1.15; // Very active

    // ═══ WALL SCORE FORMULA ═══
    // WallScore = log(1 + Z/threshold) × volumeSignificance × distanceFactor × modifiers
    // log1p prevents explosion: log(1+4)=1.6, log(1+10)=2.4, log(1+50)=3.9
    const zNorm = Math.log1p(Z / MAD_Z_THRESH);
    const volSignificance = vol24 > 0 ? Math.min(1, Math.sqrt(bin.usd / vol24) * 10) : 0.5;
    const distFactor = 1 / (1 + dist * 0.3);
    const wallScore = zNorm * volSignificance * distFactor * spoofMult * activityMult * 5;

    // Final quality gate — only real meaningful walls pass
    if (wallScore < 5.0) return;

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
      relSize: +Z.toFixed(1),
      market: coin.sym.endsWith("_SPOT") ? "spot" : "futures",
      age: 0,
      count: bin.count,
    });
  };

  binnedBids.forEach(b => processBin(b, "bid"));
  binnedAsks.forEach(b => processBin(b, "ask"));

  return walls;
}

// ═══ Cluster Nearby Walls ════════════════════════════════════════════════════

function clusterWalls(walls) {
  if (!walls.length) return [];
  walls.sort((a, b) => a.price - b.price);
  const out = [];
  let cur = { ...walls[0] };

  for (let i = 1; i < walls.length; i++) {
    const w = walls[i];
    const gap = Math.abs(w.price - cur.price) / cur.price * 100;
    if (gap <= CLUSTER_PCT && w.side === cur.side) {
      // Merge: weighted average price, sum USD
      const totalS = cur.S + w.S;
      cur.price = (cur.price * cur.S + w.price * w.S) / totalS;
      cur.S = totalS;
      cur.wallK = Math.round(cur.S / 1000);
      cur.rtwi = Math.max(cur.rtwi, w.rtwi);
      cur.relSize = Math.max(cur.relSize, w.relSize);
      cur.count += w.count;
      cur.pct = +((Math.abs(cur.price - (cur._refP || cur.price)) / (cur._refP || cur.price)) * 100).toFixed(3) || cur.pct;
      cur.age = Math.max(cur.age, w.age);
    } else {
      out.push(cur);
      cur = { ...w };
    }
  }
  out.push(cur);
  return out;
}

// ═══ WS Integration ══════════════════════════════════════════════════════════

function injectWsOrderbook(ex, base, tickers, bids, asks) {
  const key = `${ex}:${base}`;
  const t = tickers.get(key);
  if (!t || t.p <= 0 || t.v <= 0) return;
  const walls = processOrderbook(ex, t,
    bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q })),
    asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }))
  );
  if (walls && walls.length > 0) {
    wsWalls.set(key, walls);
  } else {
    wsWalls.delete(key);
  }
}

// ═══ Spot Symbols Loader (only for density map) ═════════════════════════════

const spotTickers = new Map(); // ex:SYM_SPOT → {sym, base, ex, p, v, ...}
let spotLoaded = false;

async function loadSpotSymbols(apiFetch) {
  if (spotLoaded) return;
  spotLoaded = true;
  console.log("[WALL] Loading spot symbols for density map...");
  let total = 0;
  try {
    // ── Binance Spot
    const bnData = await apiFetch("https://api.binance.com/api/v3/ticker/24hr", 5000, 0);
    if (Array.isArray(bnData)) {
      for (const t of bnData) {
        if (!t.symbol.endsWith("USDT")) continue;
        const base = t.symbol.replace("USDT", "");
        if (EXCLUDED_BASES.has(base)) continue;
        const key = `BN:${t.symbol}_SPOT`;
        spotTickers.set(key, {
          key, sym: t.symbol + "_SPOT", base, ex: "BN",
          p: +t.lastPrice, v: +t.quoteVolume, trades: +t.count / 24 || 0,
        });
        total++;
      }
    }
  } catch (_) {}
  try {
    // ── Bybit Spot
    const bbData = await apiFetch("https://api.bybit.com/v5/market/tickers?category=spot", 5000, 0);
    for (const t of (bbData?.result?.list || [])) {
      if (!t.symbol.endsWith("USDT")) continue;
      const base = t.symbol.replace("USDT", "");
      if (EXCLUDED_BASES.has(base)) continue;
      const key = `BB:${t.symbol}_SPOT`;
      spotTickers.set(key, {
        key, sym: t.symbol + "_SPOT", base, ex: "BB",
        p: +t.lastPrice, v: +t.turnover24h, trades: 0,
      });
      total++;
    }
  } catch (_) {}
  try {
    // ── OKX Spot
    const oxData = await apiFetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT", 5000, 0);
    for (const t of (oxData?.data || [])) {
      if (!t.instId.endsWith("-USDT")) continue;
      const base = t.instId.replace("-USDT", "");
      if (EXCLUDED_BASES.has(base)) continue;
      const key = `OX:${t.instId}_SPOT`;
      spotTickers.set(key, {
        key, sym: t.instId + "_SPOT", base, ex: "OX",
        p: +t.last, v: +t.volCcy24h, trades: 0,
      });
      total++;
    }
  } catch (_) {}
  try {
    // ── Bitget Spot
    const bgData = await apiFetch("https://api.bitget.com/api/v2/spot/market/tickers", 5000, 0);
    for (const t of (bgData?.data || [])) {
      if (!t.symbol.endsWith("USDT")) continue;
      const base = t.symbol.replace("USDT", "");
      if (EXCLUDED_BASES.has(base)) continue;
      const key = `BG:${t.symbol}_SPOT`;
      spotTickers.set(key, {
        key, sym: t.symbol + "_SPOT", base, ex: "BG",
        p: +t.lastPr, v: +t.usdtVolume, trades: 0,
      });
      total++;
    }
  } catch (_) {}
  try {
    // ── Gate Spot
    const gtData = await apiFetch("https://api.gateio.ws/api/v4/spot/tickers", 5000, 0);
    if (Array.isArray(gtData)) {
      for (const t of gtData) {
        if (!t.currency_pair?.endsWith("_USDT")) continue;
        const base = t.currency_pair.replace("_USDT", "");
        if (EXCLUDED_BASES.has(base)) continue;
        const key = `GT:${t.currency_pair}_SPOT`;
        spotTickers.set(key, {
          key, sym: t.currency_pair + "_SPOT", base, ex: "GT",
          p: +t.last, v: +t.quote_volume, trades: 0,
        });
        total++;
      }
    }
  } catch (_) {}
  console.log(`[WALL] Loaded ${total} spot symbols for density scanning`);
}

const MAX_SPOT_PER_EX = 9999;    // Top 100 spot by volume per exchange
const MIN_SPOT_VOL    = 0; // Min $2M 24h volume for spot

// ═══ Scan Exchange ═══════════════════════════════════════════════════════════

const exLastScan = {};
const exCachedWalls = {};

async function scanExchange(ex, tickers, apiFetch, currentScanId) {
  const gap = REST_SCAN_GAP_MS[ex] || 5000;
  const now = Date.now();
  const cached = exCachedWalls[ex] || [];

  if (exLastScan[ex] && now - exLastScan[ex] < gap) {
    return cached;
  }

  exLastScan[ex] = now;

  // Get ALL coins for this exchange — futures from tickers + spot from spotTickers
  const exCoins = [];
  const cfg = EX_CONFIG[ex] || EX_CONFIG.AD;
  const volMin = cfg.floor * 1.5; // Dynamic pre-filter to drastically save IP requests

  for (const [, t] of tickers) {
    if (t.ex === ex && t.p > 0 && t.v > volMin) {
      if (EXCLUDED_BASES.has(t.base)) continue;
      exCoins.push(t);
    }
  }
  // Add spot coins — top by volume, capped per exchange
  const spotForEx = [];
  for (const [, t] of spotTickers) {
    if (t.ex === ex && t.p > 0 && t.v > volMin) {
      if (EXCLUDED_BASES.has(t.base)) continue;
      spotForEx.push(t);
    }
  }
  spotForEx.sort((a, b) => (b.v || 0) - (a.v || 0));
  for (let si = 0; si < Math.min(spotForEx.length, MAX_SPOT_PER_EX); si++) {
    exCoins.push(spotForEx[si]);
  }

  // Sort by volume — highest volume first
  exCoins.sort((a, b) => (b.v || 0) - (a.v || 0));

  if (exCoins.length > MAX_COINS_PER_EX) {
    exCoins.length = MAX_COINS_PER_EX;
  }

  // Per-exchange rate limit: batch size + delay
  const EX_RATE = {
    BN: { batch: 3, delay: 1000 },  // Binance: Smart fast limit
    OX: { batch: 12, delay: 200 },  // OKX: moderate
    GT: { batch: 10, delay: 300 },  // Gate: strict
    KC: { batch: 12, delay: 200 },  // KuCoin: moderate
    MX: { batch: 10, delay: 300 },  // MEXC: strict
    HT: { batch: 15, delay: 200 },  // HTX: moderate
  };
  const rate = EX_RATE[ex] || { batch: POOL_COIN, delay: COIN_DELAY_MS };

  const walls = [];
  let ok = 0, fail = 0;

  for (let i = 0; i < exCoins.length; i += rate.batch) {
    const batch = exCoins.slice(i, i + rate.batch);
    const results = await Promise.allSettled(
      batch.map(async (coin) => {
        try {
          const { bids, asks } = await fetchOB(ex, coin, apiFetch);
          if (!bids.length && !asks.length) { fail++; return []; }
          ok++;
          return processOrderbook(ex, coin, bids, asks);
        } catch (_) {
          fail++;
          return [];
        }
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) walls.push(...r.value);
    }
    if (i + rate.batch < exCoins.length) {
      // Early abort: if >50% fail, exchange is rate-limiting us — stop
      const failRate = fail / (ok + fail + 1);
      if (failRate > 0.5 && (ok + fail) > 20) {
        console.log(`[WALL] ${ex}: Aborting — ${Math.round(failRate*100)}% fail rate (rate limit)`);
        break;
      }
      const extraDelay = failRate > 0.3 ? 200 : 0;
      await new Promise(r => setTimeout(r, rate.delay + extraDelay));
    }
  }

  exCachedWalls[ex] = walls;
  const spotCount = exCoins.filter(c => c.sym.endsWith("_SPOT")).length;
  const futCount = exCoins.length - spotCount;
  console.log(`[WALL] ${ex}: ${futCount}F+${spotCount}S=${exCoins.length} coins, ${ok} OK, ${fail} fail, ${walls.length} walls`);
  return walls;
}

// ═══ Quick Cluster & Publish Loop (Instant) ════════════════════════════════

async function runCombinerLoop() {
  if (scanRunning) return;
  scanRunning = true;
  scanCount++;
  
  try {
    const t0 = Date.now();
    const allWalls = [];
    
    // Merge from cached REST results
    for (const ex in exCachedWalls) {
      allWalls.push(...exCachedWalls[ex]);
    }

    // Merge WebSocket walls
    for (const [, wsArr] of wsWalls) {
      allWalls.push(...wsArr);
    }

    // Cluster by coin+side
    const groups = new Map();
    for (const w of allWalls) {
      const k = `${w.ex}:${w.base}:${w.side}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(w);
    }

    let clustered = [];
    for (const [, cw] of groups) {
      clustered.push(...clusterWalls(cw));
    }

    // Sort by wall score
    clustered.sort((a, b) => b.rtwi - a.rtwi || b.S - a.S);

    // Limit per base
    const coinCount = new Map();
    const limited = [];
    for (const w of clustered) {
      const cnt = coinCount.get(w.base) || 0;
      if (cnt >= MAX_PER_COIN) continue;
      coinCount.set(w.base, cnt + 1);
      limited.push(w);
    }

    detectedWalls = limited.slice(0, MAX_OUTPUT);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    // console.log(`[WALL] Output #${scanCount}: ${allWalls.length} raw → ${clustered.length} clustered → ${detectedWalls.length} output`);
    if (detectedWalls.length > 0 && scanCount % 5 === 0) {
      const top = detectedWalls[0];
      console.log(`[WALL] Top: ${top.base} ${top.side} ${top.wallK}K$ ${top.pct}% (${top.ex}) score=${top.rtwi.toFixed(2)} Z=${top.relSize}`);
    }

    if (onUpdateCb) onUpdateCb(detectedWalls);

  } catch (e) {
    console.error("[WALL] Combine error:", e.message);
  } finally {
    scanRunning = false;
  }
}

// ═══ Independent Exchange Loops ══════════════════════════════════════════════

function startScannerLoops(tickers, apiFetch) {
  const exchanges = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];
  
  // 1. Independent fetch loops for each API
  for (const ex of exchanges) {
    (async () => {
      let runId = 0;
      while (true) {
        runId++;
        try {
          await scanExchange(ex, tickers, apiFetch, runId);
        } catch (e) {
          console.error(`[WALL] Loop error ${ex}: ${e.message}`);
        }
        const gap = REST_SCAN_GAP_MS[ex] || 5000;
        await new Promise(r => setTimeout(r, gap));
      }
    })();
  }
  
  // 2. Fast continuous combinator loop
  setInterval(() => {
    runCombinerLoop();
  }, GLOBAL_SCAN_LOOP_MS);
}

// ═══ Public API ══════════════════════════════════════════════════════════════

module.exports = {
  getWalls: () => detectedWalls,
  injectWsOrderbook,
  startScanning: (tickers, apiFetch, onUpdate) => {
    console.log("[WALL] Starting Wall Scanner v4 — Full Coverage MAD Z-Score Engine");
    console.log(`[WALL] Config: ALL coins (futures+spot), MAD_Z≥${MAD_Z_THRESH}, bins=${BIN_STEP_PCT*100}%, dist=${MIN_DIST_PCT}-${MAX_DIST_PCT}%`);
    onUpdateCb = onUpdate || null;
    // Load spot symbols first, then start independent loops
    setTimeout(async () => {
      await loadSpotSymbols(apiFetch);
      startScannerLoops(tickers, apiFetch);
    }, 8000);
    // Refresh spot prices every 5 minutes
    setInterval(() => { spotLoaded = false; loadSpotSymbols(apiFetch); }, 300000);
  },
};
