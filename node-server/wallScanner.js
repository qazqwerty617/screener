"use strict";

/**
 * Wall Scanner v2 — Adaptive Dynamic Threshold Engine
 *
 * KEY PRINCIPLES:
 * 1. ALL coins on every exchange are scanned (no artificial limit)
 * 2. Dynamic thresholds: wall = level significantly above MEDIAN orderbook level
 *    → $500K on Binance BTC might be noise, but $10K on Asterdex ALT is a wall
 * 3. Persistence tracking: walls must survive ≥2 scans (anti-spoofing)
 * 4. Wide distance range: 0.05% – 12% from current price
 * 5. Parallel scanning across exchanges + coins for maximum speed
 * 6. Real-time callback for WebSocket broadcast
 *
 * FORMULA:
 *   WallScore = RelativeSize^1.3 × DistanceFactor × PersistenceBonus
 *   RelativeSize = LevelUSD / MedianUSD  (must be ≥ WALL_MULT)
 *   DistanceFactor = 1 / (1 + 1.5 × |dist%|)
 *   PersistenceBonus = min(2, 1 + (consecutiveScans - 2) × 0.1)
 */

// ═══ Configuration ═══════════════════════════════════════════════════════════

const SCAN_GAP_MS    = 10000;  // minimum gap between scan cycles
const API_TIMEOUT    = 3500;   // per-request timeout
const POOL_EX        = 4;     // exchanges scanned in parallel
const POOL_COIN      = 10;    // coins per exchange in parallel
const COIN_DELAY_MS  = 120;   // delay between coin batches (avoid rate limits)
const MAX_COINS_PER_EX = 60;  // Process top 60 coins max per exchange

// ── Z-Score & Physics Constants ──
const BIN_STEP_PCT   = 0.001; // 0.1% price bins
const Z_THRESHOLD    = 3.5;   // mathematical Z-score (X - µ)/σ > 3.5

const MIN_LIFETIME_MS = 120000; // 120s Time-In-Force (Anti-Spoofing)
const MIN_DIST_PCT   = 0.05;  
const MAX_DIST_PCT   = 5.0;
const MIN_SCANS      = 2;     // must survive 2 consecutive scans
const FLICKER_PENALTY = 0.5;  // penalty for walls that flicker

const MAX_OUTPUT      = 120;   // max walls sent to frontend
const MAX_PER_COIN    = 5;    // max walls per base symbol

const CLUSTER_PCT     = 0.15; // cluster walls within 0.15% of each other

// Base liquidity limits per exchange
const EX_LIMITS = {
  BN: 600000, BB: 400000, OX: 300000, BG: 250000,
  KC: 200000, BX: 150000, MX: 1200000, GT: 200000,
  HT: 1200000, HL: 300000, AD: 150000
};

// Orderbook depth per exchange (max supported / reasonable)
const OB_DEPTH = {
  BN: 100, BB: 100, OX: 100, BG: 100,
  GT: 50,  MX: 100, KC: 100, BX: 100,
  HT: 100, HL: 50,  AD: 100,
};

const EXCLUDED_BASES = new Set([
  "USDT","USDC","DAI","BUSD","FDUSD","TUSD","USDP","USDE","PYUSD", "USD1", "EUR1", "USDC1", "BTC1",
  "XAUT","PAXG","XAG","XAU","SILVER","GOLD",
  "EUR","GBP","JPY","AUD","USD","CHF","TRY","RUB","BRL",
]);

// ═══ State ═══════════════════════════════════════════════════════════════════

const levelHistory = new Map(); // "EX:SYM:PRICE8" → {firstSeen,lastSeen,scanId,consecutivePresent,misses}
let detectedWalls = [];
let scanRunning = false;
let scanCount = 0;
let onUpdateCb = null;

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

async function fetchOB(ex, coin, apiFetch) {
  const sym = coin.sym;
  const cs = Number(coin.cs || 1);
  const depth = OB_DEPTH[ex] || 100;
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
        ? `https://api.bitget.com/api/v2/spot/market/depth?symbol=${realSym}&limit=${depth}`
        : `https://api.bitget.com/api/v2/mix/market/merge-depth?productType=usdt-futures&symbol=${realSym}&limit=${depth}`;
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
      if (d && d.success === false) {
        console.warn(`[WALL MX ERROR] ${sym}: ${d.message || JSON.stringify(d)}`);
      }
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
        : `https://api.hbdm.vn/linear-swap-ex/market/depth?contract_code=${realSym}&type=step0`;
      const d = await apiFetch(url, API_TIMEOUT, 0);
      const tick = d.tick || {};
      if (tick.bids) bids = tick.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
      if (tick.asks) asks = tick.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * (+q * actualCs) }));
    } else if (ex === "HL") {
      const coin = sym.replace("-USDT","").replace("USDT","");
      const d = await apiFetch("https://api.hyperliquid.xyz/info", API_TIMEOUT, 0, "POST", { type: "l2Book", coin });
      const levels = d.levels || [[], []];
      bids = (levels[0] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
      asks = (levels[1] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
    } else if (ex === "AD") {
      const d = await apiFetch(`https://fapi.asterdex.com/fapi/v1/depth?symbol=${sym}&limit=${depth}`, API_TIMEOUT, 0);
      if (d.bids) bids = d.bids.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
      if (d.asks) asks = d.asks.map(([p, q]) => ({ price: +p, qty: +q, usd: +p * +q }));
    }

    return { bids, asks };
  } catch (e) {
    if (ex === "MX") console.warn(`[WALL ERROR] ${ex}:${sym} failed: ${e.message}`);
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
      const binPrice = side === "bid" ? (binIdx * step) + (step/2) : (binIdx * step) - (step/2);
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

  // Calculate orderbook side statistics for Z-Score
  const calculateZStats = (arr) => {
    const vals = arr.filter(b => b.usd > 0).map(b => b.usd);
    if (!vals.length) return { mu: 0, sigma: 1 };
    
    // Mean (µ)
    const sum = vals.reduce((a, b) => a + b, 0);
    const mu = sum / vals.length;
    
    // Standard Deviation (σ)
    const sqDiffSum = vals.reduce((a, b) => a + Math.pow(b - mu, 2), 0);
    const variance = sqDiffSum / vals.length;
    let sigma = Math.sqrt(variance);

    // Guard against sigma being effectively 0 (zero variance in empty books)
    if (sigma < 1) sigma = 1;

    return { mu, sigma };
  };

  const bidStats = calculateZStats(binnedBids);
  const askStats = calculateZStats(binnedAsks);

  const walls = [];

  const processBin = (bin, side) => {
    if (!bin.usd || isNaN(bin.usd)) return;

    // 1. Distance check
    const dist = Math.abs(bin.price - price) / price * 100;
    if (dist < MIN_DIST_PCT || dist > MAX_DIST_PCT) return;

    // 2. Statistical Z-Score filter (X - µ) / σ
    const stats = side === "bid" ? bidStats : askStats;
    const Z = (bin.usd - stats.mu) / stats.sigma;
    if (Z < Z_THRESHOLD) return;
    
    // 3. Dynamic absolute liquidity floor to stop fake walls on high-cap coins
    let minDust = 30000;
    if (ex === "BN" || ex === "BB") minDust = 50000;
    if (ex === "BX") minDust = 250000; // Keep BingX as requested
    
    // A wall must be at least 0.05% of the coin's 24H volume (0.15% for BX)
    if (coin.v && coin.v > 0) {
      const volReq = ex === "BX"
        ? Math.min(3000000, coin.v * 0.0015)
        : Math.min(3000000, coin.v * 0.0005);
      minDust = Math.max(minDust, volReq);
    }
    
    if (bin.usd < minDust) return;
    
    // 4. Honest Trade Activity Filter (New)
    // If a coin has very low TPH (Trades Per Hour) relative to its size, 
    // we penalize the wall score or filter it out entirely if it's likely spoofing.
    const tph = coin.trades || 0;
    let activityBonus = 1.0;
    
    if (tph < 50) {
      // Very low activity: might be a spoof or dead coin
      if (bin.usd > 500000) activityBonus = 0.5; // Large wall on dead coin = suspicious
    } else if (tph > 2000) {
      activityBonus = 1.2; // High activity: walls are more likely to be real
    }

    // pass Z as relSize so UI shows "Z=4.5"
    const relSize = Z;

    // ── Anti-Spoofing Timer ──
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
      const maxMissGapMs = 10000; // 10s tolerance to retain age

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

    // BingX (BX) still requires at least 2 consecutive scans to show (anti-spoofing)
    if (ex === "BX" && h.consecutivePresent < 2) return;

    // Output visual properties
    const wallScore = (relSize / Z_THRESHOLD) * 5 * activityBonus / (1 + dist * 0.5);

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
      count: bin.count,
    });
  };

  binnedBids.forEach(b => processBin(b, "bid"));
  binnedAsks.forEach(b => processBin(b, "ask"));

  return walls;
}

// ═══ Cluster nearby walls ════════════════════════════════════════════════════

function clusterWalls(walls) {
  if (!walls.length) return [];
  walls.sort((a, b) => a.price - b.price);
  const out = [];
  let cur = { ...walls[0] };

  for (let i = 1; i < walls.length; i++) {
    const w = walls[i];
    const gap = Math.abs(w.price - cur.price) / cur.price * 100;
    if (gap <= CLUSTER_PCT && w.side === cur.side) {
      cur.S += w.S;
      cur.wallK = Math.round(cur.S / 1000);
      cur.rtwi = Math.max(cur.rtwi, w.rtwi);
      cur.relSize = Math.max(cur.relSize, w.relSize);
      cur.count++;
      cur.price = (cur.price * (cur.count - 1) + w.price) / cur.count;
      cur.pct = +((cur.pct * (cur.count - 1) + w.pct) / cur.count).toFixed(3);
      cur.age = Math.max(cur.age, w.age);
    } else {
      out.push(cur);
      cur = { ...w };
    }
  }
  out.push(cur);
  return out;
}

// ═══ Scan one exchange ═══════════════════════════════════════════════════════

async function scanExchange(ex, tickers, apiFetch, currentScanId) {
  // Get ALL coins for this exchange
  const exCoins = [];
  for (const [, t] of tickers) {
    if (t.ex === ex && t.p > 0 && t.v > 0) {
      if (EXCLUDED_BASES.has(t.base)) continue;
      exCoins.push(t);
    }
  }
  // Sort by volume — process highest volume first
  exCoins.sort((a, b) => (b.v || 0) - (a.v || 0));

  // Limit to MAX_COINS_PER_EX (e.g. top 60) to avoid IP ban!
  if (exCoins.length > MAX_COINS_PER_EX) {
    exCoins.length = MAX_COINS_PER_EX;
  }

  const chunkSize = ex === "MX" ? 2 : POOL_COIN;
  const delayMs = ex === "MX" ? 380 : COIN_DELAY_MS;

  const walls = [];
  let ok = 0, fail = 0;

  // Parallel batches
  for (let i = 0; i < exCoins.length; i += chunkSize) {
    const batch = exCoins.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      batch.map(async (coin) => {
        try {
          const { bids, asks } = await fetchOB(ex, coin, apiFetch);
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
    // Small delay to avoid rate limits
    if (i + chunkSize < exCoins.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`[WALL] ${ex}: ${exCoins.length} coins, ${ok} OK, ${fail} fail, ${walls.length} raw walls`);
  return walls;
}

// ═══ Full scan cycle ═════════════════════════════════════════════════════════

async function runFullScan(tickers, apiFetch) {
  if (scanRunning) return;
  scanRunning = true;
  const t0 = Date.now();
  scanCount++;
  const currentScanId = scanCount;

  try {
    const allWalls = [];
    const exchanges = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];

    // Scan exchanges in parallel pools of POOL_EX
    for (let i = 0; i < exchanges.length; i += POOL_EX) {
      const chunk = exchanges.slice(i, i + POOL_EX);
      const chunkResults = await Promise.all(
        chunk.map(ex => scanExchange(ex, tickers, apiFetch, currentScanId))
      );
      for (const w of chunkResults) allWalls.push(...w);
    }

    // ── Cluster by coin+side ──
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

    // Sort by wall score (strongest first)
    clustered.sort((a, b) => b.rtwi - a.rtwi || b.S - a.S);

    // Limit per base symbol
    const coinCount = new Map();
    const limited = [];
    for (const w of clustered) {
      const cnt = coinCount.get(w.base) || 0;
      if (cnt >= MAX_PER_COIN) continue;
      coinCount.set(w.base, cnt + 1);
      limited.push(w);
    }

    detectedWalls = limited.slice(0, MAX_OUTPUT);

    // ── Cleanup old history ──
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [key, h] of levelHistory) {
      if (h.lastSeen < cutoff) levelHistory.delete(key);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[WALL] Scan #${currentScanId} done in ${elapsed}s: ${allWalls.length} raw → ${clustered.length} clustered → ${detectedWalls.length} output`);
    if (detectedWalls.length > 0) {
      const top = detectedWalls[0];
      console.log(`[WALL] Top: ${top.base} ${top.side} ${top.wallK}K$ at ${top.pct}% dist (${top.ex}) score=${top.rtwi} relSize=${top.relSize}x`);
    }

    // Broadcast to clients
    if (onUpdateCb) onUpdateCb(detectedWalls);

  } catch (e) {
    console.error("[WALL] Scan error:", e.message);
  } finally {
    scanRunning = false;
  }
}

// ═══ Continuous scan loop ════════════════════════════════════════════════════

async function scanLoop(tickers, apiFetch) {
  while (true) {
    await runFullScan(tickers, apiFetch);
    await new Promise(r => setTimeout(r, SCAN_GAP_MS));
  }
}

// ═══ Public API ══════════════════════════════════════════════════════════════

module.exports = {
  getWalls: () => detectedWalls,
  startScanning: (tickers, apiFetch, onUpdate) => {
    console.log("[WALL] Starting Wall Scanner v3 — Statistical Z-Score Engine (Binning + ADV + TIF)");
    console.log("[WALL] Config: Top " + MAX_COINS_PER_EX + " coins per exchange, Z_THRESHOLD=" + Z_THRESHOLD + ", dist=" + MIN_DIST_PCT + "%-" + MAX_DIST_PCT + "%");
    onUpdateCb = onUpdate || null;
    // Initial delay to let exchanges populate tickers
    setTimeout(() => scanLoop(tickers, apiFetch), 6000);
  },
};
