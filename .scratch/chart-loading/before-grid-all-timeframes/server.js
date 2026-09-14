"use strict";
// ─── Load .env FIRST — before any other require() that reads process.env ───────
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
// ─────────────────────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => console.error("[SERVER EXCEPTION]", err ? err.message || err : err));
process.on("unhandledRejection", (reason) => console.error("[SERVER REJECTION]", reason ? reason.message || reason : reason));

// ─── Защита: проверка обязательных секретов ──────────────────────────────────
(function checkRequiredEnv() {
  const PLACEHOLDER_PATTERNS = /ВСТАВЬ|replace_with|YOUR_|<|>/i;
  const required = [
    "TELEGRAM_BOT_TOKEN",
    "ADMIN_BOT_TOKEN",
    "ADMIN_CHAT_ID",
    "ADMIN_API_SECRET",
  ];
  const missing = [];
  for (const key of required) {
    const val = process.env[key];
    if (!val || val.trim() === "" || PLACEHOLDER_PATTERNS.test(val)) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    console.error("═══════════════════════════════════════════════════════════");
    console.error("  ❌ КРИТИЧЕСКАЯ ОШИБКА: Не заданы обязательные переменные!");
    console.error("  Заполни node-server/.env файл:");
    missing.forEach(k => console.error(`     • ${k}`));
    console.error("═══════════════════════════════════════════════════════════");
    process.exit(1);
  }
  console.log("[ENV] ✅ Все обязательные переменные окружения загружены");
})();
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { WebSocketServer, WebSocket } = require("ws");
const zlib = require("zlib");
const { randomUUID, timingSafeEqual, createHash } = require("crypto");

const PORT = process.env.PORT || 3000;

// тФАтФАтФА Persistent HTTPS agent тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 50,
  timeout: 60000,
});

try {
  const { setGlobalDispatcher, Agent } = require("undici");
  setGlobalDispatcher(new Agent({
    connections: 256,
    pipelining: 1,
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 120000,
  }));
  console.log("[HTTP] Undici global dispatcher initialized with 256 connections.");
} catch (_) {}

const compression = require('compression');
const patternDetector = require("./patternDetector");
const serverLevels = require("./serverLevels");
const wallScanner = require("./wallScanner");
const { createArbitrageEngine } = require("./arbitrageEngine");
let alertEngine = null;
try {
  alertEngine = require("./alertEngine");
} catch (e) {
  console.warn("[ALERT ENGINE] Could not load alertEngine:", e.message);
}



const { createDepthAnalyzer } = require("./depthAnalyzer");
const marketDataCore = require("./marketDataCore");
const { syncJournal } = require("./journalSync");
const { createJournalCredentialStore } = require("./journalCredentialStore");
const journalCredentials = createJournalCredentialStore();
/**
 * `userId:exchange` -> { at, result, pending }.
 *
 * `maxAge` (8s) is a freshness check, not an eviction policy, so entries used to
 * live for the whole process lifetime — each holding a full sync result with up
 * to 600 executions plus every derived trade. A pruning sweep bounds it.
 */
const journalSyncCache = new Map();
const JOURNAL_CACHE_TTL_MS = 15 * 60 * 1000;
const JOURNAL_CACHE_MAX_ENTRIES = 500;

function pruneJournalSyncCache() {
  const now = Date.now();
  for (const [k, v] of journalSyncCache) {
    if (v.pending) continue; // an in-flight sync owns its slot
    if (now - (v.at || 0) > JOURNAL_CACHE_TTL_MS) journalSyncCache.delete(k);
  }
  if (journalSyncCache.size <= JOURNAL_CACHE_MAX_ENTRIES) return;
  let excess = journalSyncCache.size - JOURNAL_CACHE_MAX_ENTRIES;
  for (const [k, v] of journalSyncCache) {
    if (v.pending) continue;
    journalSyncCache.delete(k);
    if (--excess <= 0) break;
  }
}
setInterval(pruneJournalSyncCache, 5 * 60 * 1000).unref?.();
const serverFormationsMap = new Map(); // "EX:SYM:TF" -> levels[]
const cachedTfMaps = Object.create(null); // tf -> { "EX:SYM": levels[] }
const cachedFormationMaps = {
  cascades: Object.create(null),
  levels: Object.create(null),
  trendline: Object.create(null),
  retest: Object.create(null)
};

// ── Persistent disk cache for 24/7 instant formations availability across restarts ──
const FORMATION_CACHE_FILE = path.join(__dirname, "formation_maps_cache.json");
let lastFormationCacheSaveAt = 0;

function loadFormationMaps() {
  try {
    if (!fs.existsSync(FORMATION_CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FORMATION_CACHE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return;
    const now = Date.now();
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    if (raw.savedAt && (now - raw.savedAt > MAX_AGE_MS)) {
      console.log("[FORMATION CACHE] Disk cache is older than 24h, skipping restore");
      return;
    }
    let restoredCoins = 0;
    if (raw.cachedFormationMaps && typeof raw.cachedFormationMaps === "object") {
      for (const type of ["cascades", "levels", "trendline", "retest"]) {
        const typeObj = raw.cachedFormationMaps[type];
        if (!typeObj || typeof typeObj !== "object") continue;
        if (!cachedFormationMaps[type]) cachedFormationMaps[type] = Object.create(null);
        for (const tf in typeObj) {
          if (!cachedFormationMaps[type][tf]) cachedFormationMaps[type][tf] = Object.create(null);
          Object.assign(cachedFormationMaps[type][tf], typeObj[tf]);
        }
      }
    }
    if (raw.cachedTfMaps && typeof raw.cachedTfMaps === "object") {
      for (const tf in raw.cachedTfMaps) {
        if (!cachedTfMaps[tf]) cachedTfMaps[tf] = Object.create(null);
        Object.assign(cachedTfMaps[tf], raw.cachedTfMaps[tf]);
        for (const coinKey in raw.cachedTfMaps[tf]) {
          serverFormationsMap.set(`${coinKey}:${tf}`, raw.cachedTfMaps[tf][coinKey]);
          restoredCoins++;
        }
      }
    }
    console.log(`[FORMATION CACHE] Restored formation maps from disk: ${restoredCoins} entries`);
  } catch (e) {
    console.warn(`[FORMATION CACHE] Could not restore from disk: ${e.message}`);
  }
}

function saveFormationMaps(force = false) {
  const now = Date.now();
  if (!force && now - lastFormationCacheSaveAt < 20000) return;
  lastFormationCacheSaveAt = now;
  try {
    const payload = {
      savedAt: now,
      cachedFormationMaps: {
        cascades: cachedFormationMaps.cascades,
        levels: cachedFormationMaps.levels,
        trendline: cachedFormationMaps.trendline,
        retest: cachedFormationMaps.retest
      },
      cachedTfMaps
    };
    const json = JSON.stringify(payload);
    const tmp = `${FORMATION_CACHE_FILE}.tmp`;
    if (force) {
      fs.writeFileSync(tmp, json, "utf8");
      fs.renameSync(tmp, FORMATION_CACHE_FILE);
      return;
    }
    fs.writeFile(tmp, json, "utf8", (err) => {
      if (err) return;
      fs.rename(tmp, FORMATION_CACHE_FILE, () => {});
    });
  } catch (e) {
    console.warn(`[FORMATION CACHE] Could not persist: ${e.message}`);
  }
}

loadFormationMaps();

/**
 * Drop cached formations for symbols that are no longer in the ticker map.
 * Called once per completed scan cycle — cheap relative to the scan itself, and
 * the only thing that stops these five maps growing monotonically as venues
 * delist pairs.
 */
function pruneFormationCaches() {
  let removed = 0;
  for (const key of serverFormationsMap.keys()) {
    // key is "EX:SYM:TF"
    const lastColon = key.lastIndexOf(":");
    if (lastColon <= 0) continue;
    if (!tickers.has(key.slice(0, lastColon))) {
      serverFormationsMap.delete(key);
      removed++;
    }
  }
  const buckets = [cachedTfMaps, cachedFormationMaps.cascades, cachedFormationMaps.levels,
                   cachedFormationMaps.trendline, cachedFormationMaps.retest];
  for (const bucket of buckets) {
    for (const tf in bucket) {
      const byCoin = bucket[tf];
      for (const coinKey in byCoin) {
        if (!tickers.has(coinKey)) { delete byCoin[coinKey]; removed++; }
      }
    }
  }
  return removed;
}
let currentWallsCache = [];
let currentWallsMeta = { walls: [], updatedAt: 0, partial: false, exchangesReady: 0, exchangesTotal: 11, exchangeStatuses: {} };
global.__obsidianWallsMeta = currentWallsMeta;
let patternsCache = []; // Global in-memory patterns/signals cache

// ═══ Global Non-Crypto / Stock & Commodity Filter ═══
const EXCLUDED_NON_CRYPTO_BASES = new Set([
  // Popular US Stocks & Equities:
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
  // Tokenized Stocks & Synthetics (Gate x-stocks, OKX, Bitget):
  "AVGOX", "AAPLX", "TSLAX", "NVDAX", "MSFTX", "AMZNX", "GOOGX", "GOOGLX", "METAX",
  "NFLXX", "COINX", "MSTRX", "BACX", "AMDX", "INTCX", "PLTRX", "BABAX", "DISX",
  "PYPLX", "UBERX", "SPYX", "QQQX", "ARMX", "SMCX", "HOODX",
  // ETFs / Leveraged Index Funds:
  "TQQQ", "SQQQ", "SPXL", "SPXS", "SOXL", "SOXS", "UVXY", "SVXY", "VXX",
  "FAS", "FAZ", "LABU", "LABD", "NUGT", "DUST", "JNUG", "JDST",
  // Commodities & Indices:
  "XAU", "XAG", "GOLD", "SILVER", "OIL", "WTI", "BRENT", "COPPER", "NATGAS",
  "DOW", "SPX", "NDX", "US30", "US500", "USTECH", "DE40", "UK100", "JP225",
  "XAUT", "PAXG"
]);

function checkSingleNonCrypto(token) {
  if (!token) return false;
  if (token.endsWith("STOCK")) return true;
  if (EXCLUDED_NON_CRYPTO_BASES.has(token)) return true;

  let inner = token;
  if ((token.startsWith("R") || token.startsWith("X")) && token.length >= 4) {
    inner = token.slice(1);
    if (EXCLUDED_NON_CRYPTO_BASES.has(inner)) return true;
  }

  for (const root of EXCLUDED_NON_CRYPTO_BASES) {
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

const nonCryptoCheckCache = new Map();
function isNonCryptoOrStock(base, sym) {
  if (!base && !sym) return false;
  const cacheKey = `${base || ""}:${sym || ""}`;
  const hit = nonCryptoCheckCache.get(cacheKey);
  if (hit !== undefined) return hit;

  let s = String(sym || base).toUpperCase();
  const colonIdx = s.indexOf(":");
  if (colonIdx >= 0) s = s.slice(colonIdx + 1);

  s = s.replace(/_SPOT$/i, "")
       .replace(/[-_]?(SWAP|PERP)$/i, "")
       .replace(/[-_]?(USDT|USDC|BUSD|DAI|USD)$/i, "")
       .replace(/[-_]/g, "");

  let b = String(base || "").toUpperCase().replace(/[-_/]?(USDT|USD|PERP|SPOT)$/i, "").replace(/[-_]/g, "");

  const result = checkSingleNonCrypto(s) || checkSingleNonCrypto(b);
  if (nonCryptoCheckCache.size > 10000) nonCryptoCheckCache.clear();
  nonCryptoCheckCache.set(cacheKey, result);
  return result;
}

// ─── In-memory store ────────────────────────────────────────────────────────
const tickers = new Map();
global.__obsidianTickers = tickers; // expose for telegramBot digest engine
const dirtyKeys = new Set();
const clients = new Set();

// тФАтФАтФА Kline streaming state тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const klineSubs = new Map(); // "ex|sym|tf" => pooled upstream stream + subscribed browser clients
const klineClients = new Set(); // clients subscribed to kline updates
const pendingMarketTicks = new Map();
const marketFeedStats = new Map();
let marketSequence = 0;

// тФАтФАтФА Monitoring тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const exStatus = new Map();
const arbitrageEngine = createArbitrageEngine(tickers, exStatus);
const correlationEngine = require("./correlationEngine");
correlationEngine.init(tickers, (type, data) => {
  if (clients.size > 0) {
    const msg = JSON.stringify({ type, data });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch (_) {}
      }
    }
  }
});
let depthAnalyzer = null;
let statusBroadcastTimer = null;

function updateExStatus(id, status, error = null) {
  const prev = exStatus.get(id);
  const now = Date.now();
  let changed = !prev || prev.status !== status || prev.error !== error;
  exStatus.set(id, { status, error, lastUpdate: now });

  const parentId = id.split(/[-_]/)[0];
  if (parentId !== id) {
    let anyOnline = false;
    let anyConnecting = false;
    for (const [k, v] of exStatus) {
      if (k.startsWith(parentId + '-') || k.startsWith(parentId + '_')) {
        if (v.status === "online") anyOnline = true;
        else if (v.status === "connecting") anyConnecting = true;
      }
    }
    const aggregateStatus = anyOnline ? "online" : (anyConnecting ? "connecting" : "offline");
    const parentPrev = exStatus.get(parentId);
    if (!parentPrev || parentPrev.status !== aggregateStatus) {
      exStatus.set(parentId, { status: aggregateStatus, error: null, lastUpdate: now });
      changed = true;
    }
  }

  if (changed) scheduleStatusBroadcast();
}

function scheduleStatusBroadcast() {
  if (statusBroadcastTimer) return;
  statusBroadcastTimer = setTimeout(() => {
    statusBroadcastTimer = null;
    broadcastStatus();
  }, 100);
  statusBroadcastTimer.unref?.();
}

function broadcastStatus() {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ type: "ex_status", data: Object.fromEntries(exStatus) });
  for (const ws of clients) {
    // Unlike every sibling broadcaster this had no try/catch. A socket that
    // transitions to CLOSING between the readyState check and `send` throws, and
    // this runs from a timer — so the throw became an uncaughtException.
    if (ws.readyState !== WebSocket.OPEN) continue;
    try { ws.send(msg); } catch (_) {}
  }
}

// тФАтФАтФА Ultra-fast broadcast: push-based, batched, flat arrays тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА

// Pre-built ticker index for fast lookup.
//
// This is monotonic by design (a client's `idToKey` map must stay valid for the
// life of its connection), but the `ticker_map` broadcast used to serialise the
// *entire* index on every insert. On a venue listing burst that meant repeatedly
// shipping an ~8.5k-entry object to every client. Only the new keys are sent now;
// the client already merges rather than replaces.
const tickerIndex = new Map(); // key => numeric index
let tickerIndexCounter = 0;
const newKeysBuffer = new Map(); // key -> idx, pending announcement
let tickerMapBroadcastTimer = null;

function getTickerIndex(key) {
  let idx = tickerIndex.get(key);
  if (idx === undefined) {
    idx = tickerIndexCounter++;
    tickerIndex.set(key, idx);
    // Schedule a ticker_map broadcast so clients learn about new keys
    newKeysBuffer.set(key, idx);
    if (!tickerMapBroadcastTimer) {
      tickerMapBroadcastTimer = setTimeout(() => {
        tickerMapBroadcastTimer = null;
        if (clients.size === 0 || newKeysBuffer.size === 0) { newKeysBuffer.clear(); return; }
        const msg = JSON.stringify({ type: "ticker_map", data: Object.fromEntries(newKeysBuffer) });
        newKeysBuffer.clear();
        for (const ws of clients) {
          if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch (_) {} }
        }
      }, 500);
      tickerMapBroadcastTimer.unref?.();
    }
  }
  return idx;
}

// Broadcast loop: 50ms = 20fps (optimized from 6ms/166fps to reduce CPU)
let snapshotSent = false;

// Pre-allocated broadcast buffer (reused to avoid GC pressure)
const MAX_TICKERS_ESTIMATE = 5000;
let reusableBroadcastBuffer = Buffer.alloc(MAX_TICKERS_ESTIMATE * 11 * 8);

// Send snapshot to all connected clients
function broadcastSnapshot() {
  if (tickers.size === 0) return;
  const snap = ["s"];
  for (const t of tickers.values()) {
    snap.push(t.key, t.p, t.chg, t.v, t.h, t.l, t.o, t.funding || 0, t.nextFunding || 0, t.oi || 0, t.trades || 0);
  }
  const msg = JSON.stringify({ type: "snapshot", data: snap });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) {}
    }
  }
  snapshotSent = true;
}

setInterval(() => {
  if (clients.size === 0 || dirtyKeys.size === 0) {
    dirtyKeys.clear();
    return;
  }
  // Build binary buffer: [ID, p, chg, v, h, l, o, funding, nextFunding, oi, trades] x N
  const count = dirtyKeys.size;
  const requiredBytes = count * 11 * 8;

  // Grow reusable buffer only if needed
  if (reusableBroadcastBuffer.length < requiredBytes) {
    reusableBroadcastBuffer = Buffer.alloc(requiredBytes + 1024);
  }
  let offset = 0;

  for (const key of dirtyKeys) {
    const t = tickers.get(key);
    if (!t) continue;
    const idx = getTickerIndex(key);
    
    reusableBroadcastBuffer.writeDoubleLE(idx, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.p || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.chg || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.v || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.h || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.l || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.o || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.funding || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.nextFunding || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.oi || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.trades || 0, offset); offset += 8;
  }
  dirtyKeys.clear();

  // Slice to actual used bytes
  const sendBuf = reusableBroadcastBuffer.subarray(0, offset);

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        if (ws.bufferedAmount > 2_000_000) continue;
        ws.send(sendBuf, { binary: true });
      } catch (_) {
        clients.delete(ws);
        try { ws.terminate(); } catch (__) {}
      }
    }
  }
}, 50);

// The 1s `heartbeat` at the bottom of this file already keeps browser watchdogs
// honest; a second independent 3s `ping` broadcast to every client was pure
// duplicate work (the client ignores `ping` entirely — see the `heartbeat`
// early-return in app.js's onmessage).

// тФАтФАтФА Kline broadcast to clients тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function normalizeTimestamp(t) {
  return marketDataCore.normalizeTimestamp(t);
}

function broadcastKline(ex, sym, tf, candle) {
  const clean = marketDataCore.normalizeCandle(candle);
  if (!clean) return;
  const normT = clean.t;

  // ── Update server-side klines cache in real-time ──────────────
  const updateCacheForLite = (useLite) => {
    const key = cacheKey(ex, sym, tf, useLite);
    const cached = klinesCache.get(key);
    if (cached && Array.isArray(cached.data) && cached.data.length >= 6) {
      const flat = cached.data;
      const lastT = flat[flat.length - 6];
      if (lastT === normT) {
        flat[flat.length - 5] = clean.o;
        flat[flat.length - 4] = clean.h;
        flat[flat.length - 3] = clean.l;
        flat[flat.length - 2] = clean.c;
        flat[flat.length - 1] = clean.v;
      } else if (normT > lastT) {
        const tfMs = getTfMs(tf);
        if (normT > lastT + tfMs * 10) {
          klinesCache.delete(key);
          return;
        }
        flat.push(normT, clean.o, clean.h, clean.l, clean.c, clean.v);
        if (flat.length > 7200) flat.splice(0, 6);
      }
      cached.at = Date.now();
    }
  };
  updateCacheForLite(false);
  updateCacheForLite(true);

  const targetKey = `${ex}|${sym}|${tf}`;
  const sub = klineSubs.get(targetKey);
  if (!sub) return;
  sub.lastEventAt = Date.now();
  const stat = marketFeedStats.get(ex) || { messages: 0, trades: 0, klines: 0, lastEventAt: 0, lastSourceAt: 0 };
  stat.messages++;
  stat.klines++;
  stat.lastEventAt = Date.now();
  stat.lastSourceAt = normT;
  marketFeedStats.set(ex, stat);
  const seq = ++marketSequence;
  const msg = JSON.stringify({
    type: "kline", ex, sym, tf,
    data: [normT, clean.o, clean.h, clean.l, clean.c, clean.v, seq, Date.now()],
  });
  for (const ws of sub.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_000_000) continue;
    try { ws.send(msg); } catch (_) {}
  }
}

function publishMarketTrade(ex, sym, tf, eventTime, price, volume = 0) {
  const targetKey = `${ex}|${sym}|${tf}`;
  const sub = klineSubs.get(targetKey);
  if (!sub || sub.clients.size === 0) return;
  const t = normalizeTimestamp(eventTime) || Date.now();
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;

  // Sanity check: drop outlier trade prints > 35% from current ticker price (bad prints / cross-stream glitch)
  const ticker = tickers.get(`${ex}:${sym}`);
  if (ticker && ticker.p > 0) {
    if (p > ticker.p * 1.35 || p < ticker.p * 0.65) return;
  }

  sub.lastEventAt = Date.now();
  sub.lastSourceAt = t;
  const stat = marketFeedStats.get(ex) || { messages: 0, trades: 0, klines: 0, lastEventAt: 0, lastSourceAt: 0 };
  stat.messages++;
  stat.trades++;
  stat.lastEventAt = Date.now();
  stat.lastSourceAt = t;
  marketFeedStats.set(ex, stat);

  const existing = pendingMarketTicks.get(targetKey);
  const merged = marketDataCore.mergeMarketTick(existing?.batch || null, { t, p, volume });
  if (!merged) return;
  if (existing) {
    existing.batch = merged;
    return;
  }
  const pending = { batch: merged, timer: null };
  pendingMarketTicks.set(targetKey, pending);
  // Zero-delay immediate dispatch (Vataga model)
  setImmediate(() => flushMarketTick(targetKey));
}

function flushMarketTick(targetKey) {
  const pending = pendingMarketTicks.get(targetKey);
  pendingMarketTicks.delete(targetKey);
  const sub = klineSubs.get(targetKey);
  if (!pending?.batch || !sub || sub.clients.size === 0) return;
  const b = pending.batch;
  const seq = ++marketSequence;
  const serverTime = Date.now();
  const msg = JSON.stringify({
    type: "market_tick", ex: sub.ex, sym: sub.sym, tf: sub.tf,
    data: [b.eventTime, b.last, b.high, b.low, b.first, b.firstTime, b.trades, seq, serverTime],
  });
  for (const ws of sub.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_000_000) continue;
    try { ws.send(msg); } catch (_) {}
  }
}

function updateLiveTradeTick(ex, sym, tf, tradeTime, price, volume) {
  const normT = normalizeTimestamp(tradeTime);
  if (!normT || price <= 0) return;

  const key = cacheKey(ex, sym, tf, false);
  const cached = klinesCache.get(key);
  if (cached && Array.isArray(cached.data) && cached.data.length >= 6) {
    const flat = cached.data;
    const lastT = flat[flat.length - 6];
    let o = flat[flat.length - 5];
    let h = flat[flat.length - 4];
    let l = flat[flat.length - 3];
    let c = flat[flat.length - 2];
    let v = flat[flat.length - 1];

    if (normT >= lastT && normT < lastT + getTfMs(tf)) {
      const refP = c > 0 ? c : o;
      if (refP > 0 && (price > refP * 1.35 || price < refP * 0.65)) return;

      h = Math.max(h, price);
      l = Math.min(l, price);
      c = price;
      v += (volume || 0);
      broadcastKline(ex, sym, tf, { t: lastT, o, h, l, c, v });
    }
  }
}

const userStore = require("./userStore");
const telegramBot = require("./telegramBot");
const paymentGateway = require("./paymentGateway");
const adminBot = require("./adminBot");
const { registerPaymentRoutes, createSlidingWindowLimiter } = require("./paymentRoutes");
const { renderServerChartSnapshot } = require("./serverChartRenderer");
const telegramQueue = require("./telegramQueue");
const priceHistoryStore = require("./priceHistoryStore");
const securityShield = require("./securityShield");

// ── HTTP + WebSocket server ──
const app = express();
app.disable("x-powered-by");
app.use(securityShield.securityShieldMiddleware);
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || "0", 10);
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0 && trustProxyHops <= 10) {
  app.set("trust proxy", trustProxyHops);
}
// level 1 was chosen when this also had to compress the static bundle. Static
// assets are now pre-compressed in memory, so this only sees JSON API responses
// where level 6 costs ~0.1 ms extra and cuts the payload noticeably. The
// threshold skips tiny bodies where framing overhead dominates.
//
// The filter also honours `X-No-Compression`, which the routes that serve an
// already-gzipped cached buffer set. `compression` does bail on its own once it
// sees `Content-Encoding`, but being explicit keeps the intent readable and
// avoids relying on header ordering.
app.use(compression({
  level: 6,
  threshold: 2048,
  filter(req, res) {
    if (res.getHeader("X-No-Compression")) return false;
    return compression.filter(req, res);
  }
}));
// Hoisted out of the middleware below: `express.json(...)` was being *called*
// per request, allocating a fresh parser, options object and verify closure for
// every request including static GETs.
const jsonBodyParser = express.json({
  limit: "128kb",
  verify(req, _res, buffer) {
    // Only the CryptoBot webhook needs the raw bytes for HMAC verification;
    // copying every body was pure overhead.
    if (req.path.startsWith("/api/pay/webhook/")) {
      req.rawBody = Buffer.from(buffer);
    }
  }
});
app.use((req, res, next) => {
  // Skip global JSON parser for endpoints requiring larger payload limits
  if (req.path === "/api/notifications/telegram-photo" || req.path === "/api/bug-report") return next();
  jsonBodyParser(req, res, next);
});

// Per-route parsers, built once at startup rather than per request. Note these
// are no-ops when the global parser above already consumed the body (body-parser
// short-circuits on `req._body`), so the effective limit for everything except
// the two skipped paths remains 128 KB.
const formationAlertsBodyParser = express.json({ limit: "5mb" });
app.use((error, _req, res, next) => {
  if (error && (error.type === "entity.parse.failed" || error.type === "entity.too.large")) {
    return res.status(error.type === "entity.too.large" ? 413 : 400).json({ error: "Некорректное тело запроса" });
  }
  next(error);
});
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob: https:; connect-src 'self' wss: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Public market-data endpoints opt into CORS only for origins explicitly
// listed in CORS_ORIGINS (comma-separated). Without the variable browsers
// stay same-origin, which is all this deployment needs.
const corsOrigins = String(process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
function setPublicCors(req, res) {
  if (!corsOrigins.length) return;
  const origin = req.headers.origin;
  if (origin && corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // `res.vary` appends; `setHeader("Vary", ...)` would clobber the
    // `Accept-Encoding` value that the cached-JSON responder sets.
    res.vary("Origin");
  }
}

/**
 * Preflight. `Access-Control-Allow-Origin` was being emitted by 15 handlers but
 * there was no `OPTIONS` route anywhere, so every cross-origin request that
 * triggers a preflight (any custom header — including the `Authorization` header
 * the journal and alert endpoints require) failed regardless of `CORS_ORIGINS`.
 */
if (corsOrigins.length) {
  app.options("/api/*", (req, res) => {
    setPublicCors(req, res);
    if (!res.getHeader("Access-Control-Allow-Origin")) return res.status(403).end();
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    res.status(204).end();
  });
}

const apiIpLimit = createSlidingWindowLimiter({ windowMs: 60_000, max: 1200, key: req => req.ip });
const journalSyncLimit = createSlidingWindowLimiter({ windowMs: 60 * 60_000, max: 2000, key: req => req.ip });
const journalLiveLimit = createSlidingWindowLimiter({ windowMs: 60_000, max: 600, key: req => req.ip });
app.use("/api", apiIpLimit);
app.use(["/api/journal/sync", "/api/journal/credentials"], journalSyncLimit);
app.use("/api/journal/live", journalLiveLimit);
const server = http.createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
const wss = new WebSocketServer({
  server,
  path: "/ws",
  perMessageDeflate: false,
  maxPayload: 16 * 1024,
});

let cachedTickerMapMsg = null;
let cachedTickerMapSize = 0;
function getTickerMapPayload() {
  if (!cachedTickerMapMsg || cachedTickerMapSize !== tickerIndex.size) {
    for (const key of tickers.keys()) getTickerIndex(key);
    cachedTickerMapMsg = JSON.stringify({ type: "ticker_map", data: Object.fromEntries(tickerIndex) });
    cachedTickerMapSize = tickerIndex.size;
  }
  return cachedTickerMapMsg;
}

let cachedSnapshotMsg = null;
let cachedSnapshotAt = 0;
function getSnapshotPayload() {
  const now = Date.now();
  if (!cachedSnapshotMsg || (now - cachedSnapshotAt > 1000)) {
    const snap = ["s"];
    for (const t of tickers.values()) {
      snap.push(t.key, t.p, t.chg, t.v, t.h, t.l, t.o, t.funding || 0, t.nextFunding || 0, t.oi || 0, t.trades || 0);
    }
    cachedSnapshotMsg = JSON.stringify({ type: "snapshot", data: snap, correlations: correlationEngine.getCorrelations() });
    cachedSnapshotAt = now;
  }
  return cachedSnapshotMsg;
}

const wsClientsByIp = new Map();
wss.on("connection", (ws, req) => {
  const ip = String(req.socket.remoteAddress || "unknown");
  if (!securityShield.registerWsConnection(ip)) {
    return ws.close(1008, "Banned by Security Shield");
  }
  const ipCount = wsClientsByIp.get(ip) || 0;
  if (ipCount >= 50) {
    securityShield.unregisterWsConnection(ip);
    return ws.close(1013, "connection limit");
  }
  wsClientsByIp.set(ip, ipCount + 1);
  ws._clientIp = ip;
  ws._messagesInWindow = 0;
  ws._messageWindowAt = Date.now();
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  clients.add(ws);
  klineClients.add(ws);
  ws._klineSubs = new Set();
  console.log(`[WS CLIENT] Connected. Total: ${clients.size}`);
  try {
    ws.send(JSON.stringify({ type: "ex_status", data: Object.fromEntries(exStatus) }));
    if (tickers.size > 0) {
      ws.send(getTickerMapPayload());
      ws.send(getSnapshotPayload());
    }
  } catch (err) {
    console.error("[WS CLIENT] Error sending initial data:", err.message);
  }
  try {
    const urlObj = new URL(req.url, "http://localhost");
    const token = urlObj.searchParams.get("token") || urlObj.searchParams.get("auth");
    const clientIp = ws._clientIp;
    if (token) {
      const u = userStore.getUserByToken(token, { ip: clientIp });
      if (u) {
        ws._userId = u.id;
        userStore.registerActiveSocket(u.id, ws, clientIp);
      } else {
        userStore.registerActiveSocket(null, ws, clientIp);
      }
    } else {
      userStore.registerActiveSocket(null, ws, clientIp);
    }
  } catch (_) {
    userStore.registerActiveSocket(null, ws, ws._clientIp);
  }

  ws.on("message", (data) => {
    try {
      const now = Date.now();
      if (now - ws._messageWindowAt >= 60_000) { ws._messageWindowAt = now; ws._messagesInWindow = 0; }
      if (++ws._messagesInWindow > 180) return ws.close(1008, "message rate limit");
      const msg = JSON.parse(data.toString());
      if (msg.type === "auth" && msg.token) {
        const u = userStore.getUserByToken(msg.token, { ip: ws._clientIp });
        if (u) {
          if (ws._userId && ws._userId !== u.id) {
            userStore.unregisterActiveSocket(ws._userId, ws);
          }
          ws._userId = u.id;
          userStore.registerActiveSocket(u.id, ws, ws._clientIp);
        }
      } else if (msg.type === "subscribe_kline") {
        subscribeKline(ws, msg.ex, msg.sym, msg.tf);
      } else if (msg.type === "unsubscribe_kline") {
        unsubscribeKline(ws, msg.ex, msg.sym, msg.tf);
      } else if (msg.type === "ping") {
        if (msg.token) {
          const u = userStore.getUserByToken(msg.token, { ip: ws._clientIp });
          if (u) {
            ws._userId = u.id;
            userStore.registerActiveSocket(u.id, ws, ws._clientIp);
          }
        } else if (ws._userId) {
          userStore.touchUserActivity(ws._userId, { ip: ws._clientIp });
        }
        try { ws.send(JSON.stringify({ type: "pong", t: Date.now() })); } catch (_) {}
      } else if (msg.type === "get_snapshot") {
        if (tickers.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(getTickerMapPayload());
          ws.send(getSnapshotPayload());
        }
      }
    } catch (_) {}
  });
  ws.on("close", () => {
    clients.delete(ws);
    klineClients.delete(ws);
    userStore.unregisterActiveSocket(ws._userId || null, ws);
    const clientIp = ws._clientIp;
    if (clientIp) {
      securityShield.unregisterWsConnection(clientIp);
      const remaining = Math.max(0, (wsClientsByIp.get(clientIp) || 1) - 1);
      if (remaining) wsClientsByIp.set(clientIp, remaining); else wsClientsByIp.delete(clientIp);
    }
    if (ws._klineSubs) {
      for (const subKey of ws._klineSubs) {
        const [ex, sym, tf] = subKey.split("|");
        unsubscribeKline(ws, ex, sym, tf);
      }
    }
    console.log(`[WS CLIENT] Disconnected. Total: ${clients.size}`);
  });
  ws.on("error", (err) => {
    console.error("[WS CLIENT] Error:", err.message);
    clients.delete(ws);
    klineClients.delete(ws);
    try { ws.terminate(); } catch (_) {}
  });
});

const wsHeartbeat = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30_000);
wsHeartbeat.unref?.();

// Application heartbeat keeps browser watchdogs honest even when a market is quiet.
const browserHeartbeat = setInterval(() => {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: "heartbeat", serverTime: Date.now(), seq: ++marketSequence });
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512_000) continue;
    try { ws.send(payload); } catch (_) {}
  }
}, 1000);
browserHeartbeat.unref?.();

// тФАтФАтФА Kline subscription management тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function subscribeKline(ws, ex, sym, tf) {
  if (!ws || !marketDataCore.validSubscription(ex, sym, tf)) return;
  if (!tickers.has(`${ex}:${sym}`)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "market_status", ex, sym, tf, status: "rejected", reason: "unknown_symbol" }));
    }
    return;
  }
  klineClients.add(ws);
  const subKey = `${ex}|${sym}|${tf}`;
  ws._klineSubs.add(subKey);

  let sub = klineSubs.get(subKey);
  if (!sub) {
    sub = createKlineWs(ex, sym, tf);
    klineSubs.set(subKey, sub);
  }
  if (sub.idleTimer) { clearTimeout(sub.idleTimer); sub.idleTimer = null; }
  sub.clients.add(ws);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "market_status", ex, sym, tf,
      status: sub.ws?.readyState === WebSocket.OPEN ? "live" : "connecting",
    }));
  }
}

function unsubscribeKline(ws, ex, sym, tf) {
  const subKey = `${ex}|${sym}|${tf}`;
  if (ws?._klineSubs) ws._klineSubs.delete(subKey);
  const sub = klineSubs.get(subKey);
  if (!sub) return;
  sub.clients.delete(ws);
  if (sub.clients.size === 0 && !sub.idleTimer) {
    sub.idleTimer = setTimeout(() => closeKlineSub(sub), 15_000);
    sub.idleTimer.unref?.();
  }
}

function createKlineWs(ex, sym, tf) {
  const sub = {
    key: `${ex}|${sym}|${tf}`,
    ex, sym, tf,
    ws: null,
    extraWs: null,
    clients: new Set(),
    reconnectTimer: null,
    pingTimer: null,
    pollTimer: null,
    idleTimer: null,
    closing: false,
    reconnects: 0,
    lastEventAt: 0,
    lastSourceAt: 0,
  };
  connectKlineWs(sub);
  return sub;
}

function closeSocket(socket) {
  if (!socket) return;
  try { socket.removeAllListeners(); socket.terminate(); } catch (_) {}
}

function closeKlineSub(sub) {
  if (!sub || sub.clients.size > 0) return;
  sub.closing = true;
  if (sub.reconnectTimer) clearTimeout(sub.reconnectTimer);
  if (sub.pingTimer) clearInterval(sub.pingTimer);
  if (sub.pollTimer) clearInterval(sub.pollTimer);
  if (sub.idleTimer) clearTimeout(sub.idleTimer);
  closeSocket(sub.ws);
  closeSocket(sub.extraWs);
  pendingMarketTicks.delete(sub.key);
  if (klineSubs.get(sub.key) === sub) klineSubs.delete(sub.key);
}

function scheduleKlineReconnect(sub, delay = 1500) {
  if (!sub || sub.closing || sub.clients.size === 0 || sub.reconnectTimer) return;
  sub.reconnects++;
  sub.reconnectTimer = setTimeout(() => {
    sub.reconnectTimer = null;
    if (!sub.closing && sub.clients.size > 0) connectKlineWs(sub);
  }, Math.min(15_000, delay * Math.min(6, sub.reconnects)));
  sub.reconnectTimer.unref?.();
}

function markMarketOpen(sub) {
  sub.reconnects = 0;
  for (const client of sub.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "market_status", ex: sub.ex, sym: sub.sym, tf: sub.tf, status: "live" }));
    }
  }
}

function connectKlineWs(sub) {
  sub.closing = false;
  if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; }
  if (sub.pingTimer) { clearInterval(sub.pingTimer); sub.pingTimer = null; }
  if (sub.pollTimer) { clearInterval(sub.pollTimer); sub.pollTimer = null; }
  closeSocket(sub.ws);
  closeSocket(sub.extraWs);
  sub.ws = null;
  sub.extraWs = null;

  const { ex, sym, tf } = sub;
  const sourceTf = syntheticSourceTf(ex, tf) || tf;
  const emitSourceCandle = (...args) => sourceTf === tf ? broadcastKline(...args) : broadcastSyntheticKline(...args);
  
  if (ex === "BN") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    const bnTf = tfMap[tf] || tf;
    const stream = `${sym.toLowerCase()}@kline_${bnTf}/${sym.toLowerCase()}@aggTrade`;
    sub.ws = new WebSocket(`wss://fstream.binance.com/market/stream?streams=${stream}`, { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BN:${sym}`, e.message));
    sub.ws.on("open", () => markMarketOpen(sub));
    sub.ws.on("message", (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        const d = envelope.data || envelope;
        if (d.e === "aggTrade") {
          publishMarketTrade(ex, sym, tf, d.T || d.E, d.p, Number(d.q) * Number(d.p));
        } else if (d.k) {
          const k = d.k;
          broadcastKline(ex, sym, tf, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
  } else if (ex === "BB") {
    const tfMap = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "3d": "3", "1w": "W" };
    sub.ws = new WebSocket("wss://stream.bybit.com/v5/public/linear", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BB:${sym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [`kline.${tfMap[sourceTf] || "60"}.${sym}`, `publicTrade.${sym}`] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send('{"op":"ping"}'); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.data?.length) return;
        if (d.topic?.startsWith("kline.")) {
          const k = d.data[0];
          emitSourceCandle(ex, sym, tf, { t: k.start, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.turnover });
        } else if (d.topic?.startsWith("publicTrade.")) {
          for (const trade of d.data) publishMarketTrade(ex, sym, tf, trade.T || d.ts, trade.p, Number(trade.v) * Number(trade.p));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "OX") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" };
    const ch = "candle" + (tfMap[tf] || "1H");
    sub.ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/business", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: ch, instId: sym }] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send("ping"); }, 25000);

      sub.extraWs = new WebSocket("wss://ws.okx.com:8443/ws/v5/public", { perMessageDeflate: false });
      sub.extraWs.on("open", () => sub.extraWs.send(JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId: sym }] })));
      sub.extraWs.on("message", (tradeRaw) => {
        const tradeStr = tradeRaw.toString();
        if (tradeStr === "pong") return;
        try {
          const message = JSON.parse(tradeStr);
          if (message.arg?.channel !== "trades") return;
          for (const trade of (message.data || [])) publishMarketTrade(ex, sym, tf, trade.ts, trade.px, Number(trade.sz) * Number(trade.px));
        } catch (_) {}
      });
      sub.extraWs.on("error", () => {});
    });
    sub.ws.on("message", (raw) => {
      const str = raw.toString();
      if (str === "pong") return;
      try {
        const d = JSON.parse(str);
        if (!d.data || d.arg?.channel !== ch) return;
        const k = d.data[0];
        broadcastKline(ex, sym, tf, { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +(k[7] || k[6]) });
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); closeSocket(sub.extraWs); sub.extraWs = null; scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "BG") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" };
    sub.ws = new WebSocket("wss://ws.bitget.com/v2/ws/public", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BG:${sym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [
        { instType: "USDT-FUTURES", channel: "candle" + (tfMap[tf] || "1H"), instId: sym },
        { instType: "USDT-FUTURES", channel: "trade", instId: sym },
      ] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send("ping"); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.action || !d.arg?.channel) return;
        if (d.arg.channel === "candle" + (tfMap[tf] || "1H")) {
          // The initial snapshot can contain 500 historical bars. History is
          // loaded over REST; the live channel publishes only its newest bar.
          const k = (d.data || []).reduce((last, row) => !last || +row[0] >= +last[0] ? row : last, null);
          if (k) broadcastKline(ex, sym, tf, { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] });
        } else if (d.arg.channel === "trade") {
          for (const trade of (d.data || [])) publishMarketTrade(ex, sym, tf, trade.ts, trade.price, Number(trade.size) * Number(trade.price));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "GT") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    sub.ws = new WebSocket("wss://fx-ws.gateio.ws/v4/ws/usdt", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.candlesticks", event: "subscribe", payload: [tfMap[tf] || "4h", sym] }));
      sub.ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.trades", event: "subscribe", payload: [sym] }));
      sub.pingTimer = setInterval(() => {
        if (sub.ws?.readyState === 1) {
          sub.ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.ping" }));
        }
      }, 15000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.event !== "update") return;
        if (d.channel === "futures.candlesticks") {
          const candles = Array.isArray(d.result) ? d.result : [d.result];
          for (const k of candles) broadcastKline(ex, sym, tf, { t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +(k.a || k.v) });
        } else if (d.channel === "futures.trades") {
          const trades = Array.isArray(d.result) ? d.result : [d.result];
          for (const trade of trades) publishMarketTrade(ex, sym, tf, trade.create_time_ms || trade.create_time, trade.price, Number(trade.size || trade.amount) * Number(trade.price));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
    sub.ws.on("error", () => {});
  } else if (ex === "MX") {
    const mxSym = sym.includes("_") ? sym : (sym.endsWith("USDT") ? sym.replace(/USDT$/i, "_USDT") : sym + "_USDT");
    const tfMap = { "1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1", "3d": "Day3", "1w": "Week1" };
    sub.ws = new WebSocket("wss://contract.mexc.com/edge", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] MX:${mxSym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ method: "sub.kline", param: { symbol: mxSym, interval: tfMap[sourceTf] || "Hour4" } }));
      sub.ws.send(JSON.stringify({ method: "sub.deal", param: { symbol: mxSym } }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ method: "ping" })); }, 15000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.channel === "push.deal" && Array.isArray(d.data)) {
          for (const deal of d.data) {
            const tp = +deal.p;
            const tv = +deal.v * tp;
            const tt = +deal.t || Date.now();
            if (tp > 0) {
              const t = tickers.get("MX:" + mxSym);
              if (t) { t.p = tp; dirtyKeys.add(t.key); }
              publishMarketTrade(ex, sym, tf, tt, tp, tv);
              if (sourceTf === tf) updateLiveTradeTick(ex, sym, tf, tt, tp, tv);
            }
          }
        }
        if (d.channel === "push.kline" && d.data) {
          const k = d.data;
          emitSourceCandle(ex, sym, tf, { t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.a || (+k.q * +k.c) });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "HL") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    sub.ws = new WebSocket("wss://api.hyperliquid.xyz/ws", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: sym, interval: tfMap[tf] || "4h" } }));
      sub.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: sym } }));
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.data) return;
        if (d.channel === "candle") {
          const candles = Array.isArray(d.data) ? d.data : [d.data];
          const k = candles.reduce((last, row) => !last || +row.t >= +last.t ? row : last, null);
          if (k) broadcastKline(ex, sym, tf, { t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: Number(k.v) * Number(k.c) });
        } else if (d.channel === "trades") {
          for (const trade of d.data) publishMarketTrade(ex, sym, tf, trade.time, trade.px, Number(trade.sz) * Number(trade.px));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
    sub.ws.on("error", () => {});
  } else if (ex === "AD") {
    const stream = `${sym.toLowerCase()}@kline_${tf}/${sym.toLowerCase()}@aggTrade`;
    sub.ws = new WebSocket(`wss://fstream.asterdex.com/stream?streams=${stream}`, { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] AD:${sym}`, e.message));
    sub.ws.on("open", () => markMarketOpen(sub));
    sub.ws.on("message", (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        const d = envelope.data || envelope;
        if (d.e === "aggTrade") publishMarketTrade(ex, sym, tf, d.T || d.E, d.p, Number(d.q) * Number(d.p));
        else if (d.k) {
          const k = d.k;
          broadcastKline(ex, sym, tf, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
    sub.ws.on("error", () => {});
  } else if (ex === "KC") {
    // KuCoin needs a token
    const generation = sub.generation = (sub.generation || 0) + 1;
    getKuCoinToken().then(tk => {
      if (sub.closing || sub.generation !== generation) return;
      if (!tk) return startKlinePolling(sub);
      const url = `${tk.endpoint}?token=${tk.token}`;
      sub.ws = new WebSocket(url, { perMessageDeflate: false });
      sub.ws.on("error", (e) => console.warn(`[KL ERROR] KC:${sym}`, e.message));
      sub.ws.on("open", () => {
        markMarketOpen(sub);
        const periods = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "4h": "4hour", "1d": "1day", "1w": "1week" };
        sub.ws.send(JSON.stringify({ id: Date.now(), type: "subscribe", topic: `/contractMarket/limitCandle:${sym}_${periods[sourceTf] || "1hour"}`, privateChannel: false, response: true }));
        sub.ws.send(JSON.stringify({ id: Date.now() + 1, type: "subscribe", topic: `/contractMarket/execution:${sym}`, privateChannel: false, response: true }));
        // Keep comfortably inside KuCoin's 18s per-session heartbeat window.
        sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ id: Date.now(), type: "ping" })); }, 9000);
      });
      sub.ws.on("message", (raw) => {
        try {
          const d = JSON.parse(raw.toString());
          if (d.subject === "candle.stick" && Array.isArray(d.data?.candles)) {
            const k = d.data.candles;
            emitSourceCandle(ex, sym, tf, { t: +k[0] * 1000, o: +k[1], h: +k[3], l: +k[4], c: +k[2], v: +k[6] });
          } else if ((d.subject === "match" || d.subject === "match.update") && d.data) {
            const trade = d.data;
            publishMarketTrade(ex, sym, tf, trade.ts || trade.time || trade.timestamp, trade.price, Number(trade.size || trade.value || 0) * Number(trade.price));
          }
        } catch (_) {}
      });
      sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub, 2000); });
    }).catch(() => { if (!sub.closing && sub.generation === generation) startKlinePolling(sub); });
  } else if (ex === "BX") {
    const bxSym = sym.includes("-") ? sym : (sym.endsWith("USDT") ? sym.replace(/USDT$/, "-USDT") : sym + "-USDT");
    sub.ws = new WebSocket("wss://open-api-swap.bingx.com/swap-market", { perMessageDeflate: false });
    sub.ws.on("error", (e) => {
      console.warn(`[KL ERROR] BX:${sym}:`, e.message);
      startKlinePolling(sub); 
    });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      // BingX expects symbol WITH hyphen (e.g. BTC-USDT@kline_1m)
      sub.ws.send(JSON.stringify({ id: "id1", reqType: "sub", dataType: `${bxSym}@kline_${tf}` }));
      sub.ws.send(JSON.stringify({ id: "id2", reqType: "sub", dataType: `${bxSym}@trade` }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ ping: Date.now() })); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      zlib.gunzip(raw, (err, buf) => {
        if (err) return;
        try {
          const d = JSON.parse(buf.toString());
          // Handle BingX Ping-Pong
          if (d.ping) {
            sub.ws.send(JSON.stringify({ pong: d.ping }));
            return;
          }
          if (d.dataType?.includes("@kline") && d.data) {
            // BingX sends kline data as an array. Grab the latest element (last in array).
            const k = Array.isArray(d.data) ? d.data[d.data.length - 1] : d.data;
            if (!k) return;
            
            // BingX Cluster Fix: Use base volume * close price. Never use k.q because on some altcoins BingX sends 24h cumulative volume.
            const closeP = +(k.c || k.close || 0);
            const baseVol = +(k.v || k.volume || 0);
            const quoteVol = baseVol * closeP;
            
            const candle = {
              t: +(k.time || k.T || k.t || 0),
              o: +(k.open || k.o || 0),
              h: +(k.high || k.h || 0),
              l: +(k.low || k.l || 0),
              c: closeP,
              v: quoteVol
            };
            if (candle.t) {
              broadcastKline(ex, sym, tf, candle);
            }
          } else if (d.dataType?.includes("@trade") && d.data) {
            const trades = Array.isArray(d.data) ? d.data : [d.data];
            for (const trade of trades) {
              const p = +(trade.p || trade.price || 0);
              publishMarketTrade(ex, sym, tf, trade.T || trade.t || trade.time, p, +(trade.q || trade.v || trade.volume || 0) * p);
            }
          }
        } catch (_) {}
      });
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub, 2000); });
  } else if (ex === "HT") {
    sub.ws = new WebSocket("wss://api.hbdm.vn/linear-swap-ws", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] HT:${sym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ sub: `market.${sym}.kline.${TF_MAP.HT[sourceTf] || "60min"}`, id: "id1" }));
      sub.ws.send(JSON.stringify({ sub: `market.${sym}.trade.detail`, id: "id2" }));
    });
    sub.ws.on("message", (raw) => {
      zlib.gunzip(raw, (err, buf) => {
        if (err) return;
        try {
          const d = JSON.parse(buf.toString());
          if (d.ping) return sub.ws.send(JSON.stringify({ pong: d.ping }));
          if (d.tick && d.ch?.includes(".kline.")) {
            const k = d.tick;
            emitSourceCandle(ex, sym, tf, { t: k.id * 1000, o: k.open, h: k.high, l: k.low, c: k.close, v: +(k.trade_turnover || k.amount || k.vol) });
          } else if (d.tick && d.ch?.includes(".trade.detail")) {
            for (const trade of (d.tick.data || [])) publishMarketTrade(ex, sym, tf, trade.ts, trade.price, Number(trade.amount) * Number(trade.price));
          }
        } catch (_) {}
      });
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub, 2000));
  } else {
    startKlinePolling(sub);
  }
}
async function getKuCoinToken() {
  try {
    const r = await apiFetch("https://api-futures.kucoin.com/api/v1/bullet-public", 5000, 0, "POST");
    if (r?.data?.token) return { token: r.data.token, endpoint: r.data.instanceServers[0].endpoint };
  } catch (e) {}
  return null;
}

function startKlinePolling(sub) {
  if (sub.pollTimer) clearInterval(sub.pollTimer);
  markMarketOpen(sub);
  // Re-entrancy guard: `apiFetch` has a 3s budget but the interval fired every
  // 1s, so up to three overlapping fetches per subscription could pile up — and
  // one such interval exists per `klineSubs` entry for every venue without a WS
  // branch. The period also now matches the fetch budget.
  sub.pollInFlight = false;
  sub.pollTimer = setInterval(async () => {
    if (sub.pollInFlight || sub.closing) return;
    sub.pollInFlight = true;
    try {
      if (syntheticSourceTf(sub.ex, sub.tf)) {
        const candles = await fetchSyntheticHistory(sub.ex, sub.sym, sub.tf);
        if (!sub.closing && candles.length) broadcastKline(sub.ex, sub.sym, sub.tf, candles.at(-1));
        return;
      }
      const url = getKlinesUrl(sub.ex, sub.sym, sub.tf, 3);
      if (!url) return;
      const data = await apiFetch(url, 3000, 0);
      const candles = parseKlines(sub.ex, data);
      if (candles.length) {
        const last = candles[candles.length - 1];
        broadcastKline(sub.ex, sub.sym, sub.tf, last);
      }
    } catch (_) {} finally {
      sub.pollInFlight = false;
    }
  }, 2000);
  sub.pollTimer.unref?.();
}

// тФАтФАтФА Reconnecting WebSocket helper тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function mkExWs(exId, url, onMsg, onOpen) {
  let ws, alive = true, retryMs = 1000, lastMsg = 0;
  let connectTime = 0; // track when connection was established
  let rapidFailCount = 0; // count rapid disconnects for backoff
  
  function connect() {
    if (!alive) return;
    updateExStatus(exId, "connecting");
    
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    };
    if (url.includes("bingx")) {
      delete headers["User-Agent"];
      headers["Origin"] = "https://www.bingx.com";
    } else if (url.includes("gate")) {
      headers["Origin"] = "https://www.gate.io";
    }
    ws = new WebSocket(url, { 
      handshakeTimeout: 15000,
      perMessageDeflate: false,
      // Thousands of public ticker frames may arrive in one socket read.
      // Yield between them so HTTP history and chart timers can also run.
      allowSynchronousEvents: false,
      headers
    });

    ws.on("error", (err) => {
      console.warn(`[WS ERROR] ${exId}:`, err.message);
      updateExStatus(exId, "error");
    });

    ws.on("open", () => {
      retryMs = 1000;
      lastMsg = Date.now();
      connectTime = Date.now();
      updateExStatus(exId, "online");
      console.log(`[WS OPEN] ${exId}`);
      if (onOpen) onOpen(ws);
    });

    ws.on("message", (data) => {
      lastMsg = Date.now();
      onMsg(data, ws);
    });

    ws.on("error", (err) => {
      updateExStatus(exId, "offline", err.message);
    });

    ws.on("close", (code, reason) => {
      updateExStatus(exId, "offline", "Connection closed");
      if (alive) {
        // Rapid-fail detection: if connection lived < 10s, it's a storm
        const lifetime = Date.now() - (connectTime || 0);
        if (lifetime < 10000) {
          rapidFailCount++;
          // Aggressive backoff for rapid failures
          retryMs = Math.min(retryMs * 2, 60000);
          if (rapidFailCount >= 5) {
            retryMs = Math.max(retryMs, 30000); // at least 30s after 5 rapid fails
          }
          if (rapidFailCount % 10 === 0) {
            console.warn(`[WS STORM] ${exId}: ${rapidFailCount} rapid disconnects, backing off ${(retryMs/1000).toFixed(0)}s`);
          }
        } else {
          // Normal disconnect тАФ reset rapid fail counter
          rapidFailCount = Math.max(0, rapidFailCount - 1);
          retryMs = Math.min(retryMs * 1.5, 30000);
        }
        setTimeout(connect, retryMs);
      }
    });
  }

  // Watchdog: check every 30s, reconnect if no data for 45s
  const watchdog = setInterval(() => {
    if (!alive) return clearInterval(watchdog);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const silent = Date.now() - lastMsg;
    if (lastMsg > 0 && silent > 45000) {
      console.warn(`[WS WATCHDOG] ${exId}: No data for ${(silent/1000).toFixed(0)}s, reconnecting...`);
      try { ws.terminate(); } catch (_) {}
    }
  }, 30000);

  connect();
  return {
    stop: () => { alive = false; clearInterval(watchdog); try { ws.terminate(); } catch (_) {} },
    send: (d) => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); } catch (_) {} }
  };
}

// тФАтФАтФА Fetch helper тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
// ─── Per-venue circuit breaker ────────────────────────────────────────────────
// Binance answers a rate-limit breach with HTTP 418 and an hour-long IP ban, and
// it reports the remaining time in `retry-after`. The old code retried through
// the ban with a 3-second backoff, which kept the ban alive and made every
// klines request hang. This tracks a pause and honours `retry-after`.
//
// Scope matters. A 418/403 is an IP-level ban and has to park the whole host. A
// 429 only means "too fast on this endpoint": OKX answers a burst of order-book
// requests with 429 and no retry-after, and parking `www.okx.com` for a minute
// took its klines and tickers down with it — measured at 6180 pause-seconds
// across 103 hits in a 12-minute run, while OKX's own limit would have cleared
// in seconds. Rate limits therefore park one endpoint, briefly.
const venueBanUntil = new Map(); // "host" (whole venue) | "host/path" (one endpoint) -> timestamp
const VENUE_DEFAULT_BAN_MS = 60000;
const VENUE_RATE_LIMIT_MS = 10000;

function hostOf(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
}

// MEXC and a few others put the instrument in the path, so a raw pathname would
// mint a key per symbol and a rate limit would only ever park one of them.
// Instrument-looking segments collapse to `*`, which keeps the key set at one
// entry per endpoint.
const SYMBOL_PATH_SEGMENT = /^[A-Z0-9]{2,20}(?:[-_][A-Z0-9]{1,10})*$/;

/** Host + normalised path, query stripped: one endpoint's own limit bucket. */
function endpointOf(url) {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(String(url || ""));
  if (!m) return "";
  const segments = String(m[2] || "").split("/").filter(Boolean)
    .map(seg => (SYMBOL_PATH_SEGMENT.test(seg) ? "*" : seg));
  return m[1].toLowerCase() + "/" + segments.join("/");
}

/** Remaining pause for one key, self-clearing once it expires. */
function pausedUntil(key) {
  if (!key) return 0;
  const until = venueBanUntil.get(key) || 0;
  if (until <= Date.now()) {
    if (until) venueBanUntil.delete(key);
    return 0;
  }
  return until;
}

function isVenuePaused(url) {
  // A host-wide ban outranks an endpoint pause, so check both.
  return pausedUntil(hostOf(url)) > 0 || pausedUntil(endpointOf(url)) > 0;
}

function pauseVenue(url, ms, reason, scope = "host") {
  const key = scope === "endpoint" ? endpointOf(url) : hostOf(url);
  if (!key) return;
  const until = Date.now() + Math.max(1000, ms);
  const prev = venueBanUntil.get(key) || 0;
  if (until <= prev) return;
  venueBanUntil.set(key, until);
  console.warn(`[VENUE PAUSED] ${key} for ${Math.round(ms / 1000)}s (${reason})`);
}

function venuePauseSnapshot() {
  const now = Date.now();
  const out = {};
  for (const [host, until] of venueBanUntil) {
    if (until > now) out[host] = Math.round((until - now) / 1000);
  }
  return out;
}

/**
 * Only spot candles can use Binance's spot market-data endpoint. Futures must
 * never silently fall back to spot prices, even for the same symbol.
 */
function binanceFallbackUrl(url) {
  const s = String(url || "");
  if (!s.startsWith("https://api.binance.com/api/v3/klines?")) return null;
  return s.replace("https://api.binance.com", "https://data-api.binance.vision");
}

function isVenueThrottle(url, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const host = hostOf(url);
  const code = String(data.retCode ?? data.code ?? data["err-code"] ?? data.label ?? "");
  const message = String(data.retMsg ?? data.msg ?? data.message ?? data["err-msg"] ?? data.error ?? "");
  if ((host.includes("binance") || host.includes("asterdex")) && code === "-1003") return true;
  if (host.includes("bybit") && ["10006", "10429"].includes(code)) return true;
  if (host.includes("okx") && ["50011", "50040"].includes(code)) return true;
  if (host.includes("mexc") && code === "510") return true;
  if (host.includes("bingx") && code === "100410") return true;
  return /^(429|429000|TOO_MANY_REQUESTS)$/.test(code) ||
    /too many (requests|visits)|rate limit|requests too frequent|request frequency too fast/i.test(message);
}

/**
 * Resolved once per process instead of on every request. The previous code
 * re-imported node-fetch inside the retry loop AND declared `fetchImpl` inside
 * the `try` block, so the catch-path mirror fallback threw
 * `ReferenceError: fetchImpl is not defined` into a bare `catch (_) {}` — the
 * Binance mirror fallback on network errors had never actually worked.
 */
const USE_NATIVE_FETCH = typeof fetch === "function";
let _fetchImpl = USE_NATIVE_FETCH ? fetch.bind(globalThis) : null;
let _fetchImplPromise = null;
async function getFetchImpl() {
  if (_fetchImpl) return _fetchImpl;
  if (!_fetchImplPromise) {
    _fetchImplPromise = import("node-fetch").then((m) => {
      _fetchImpl = m.default;
      return _fetchImpl;
    });
  }
  return _fetchImplPromise;
}

// Shared request headers — one frozen object instead of a fresh literal per call.
const API_FETCH_HEADERS_GET = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Cache-Control": "no-cache",
});
const API_FETCH_HEADERS_POST = Object.freeze({
  ...API_FETCH_HEADERS_GET,
  "Content-Type": "application/json",
});

async function apiFetch(url, timeoutMs = 8000, retries = 1, method = "GET", body = null) {
  const headers = method === "POST" ? API_FETCH_HEADERS_POST : API_FETCH_HEADERS_GET;
  const fetchImpl = await getFetchImpl();
  const payload = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));

  // Refuse instantly while the venue is banned. Waiting on a doomed request is
  // what made /api/klines hang for 35 seconds.
  if (isVenuePaused(url)) {
    const fallback = binanceFallbackUrl(url);
    if (!fallback || isVenuePaused(fallback)) throw new Error("VENUE_PAUSED");
    url = fallback;
  }

  // Every attempt gets its own controller; the fallback must never reuse an
  // already-aborted signal (that made the old fallback reject immediately).
  const attempt = async (targetUrl) => {
    if (isVenuePaused(targetUrl)) throw new Error("VENUE_PAUSED");
    const ctrl = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error("UPSTREAM_TIMEOUT"));
      }, timeoutMs);
    });
    try {
      // native fetch (Node 18+) does NOT support `agent` — omit it
      const options = { method, signal: ctrl.signal, headers };
      if (!USE_NATIVE_FETCH) options.agent = httpsAgent;
      if (payload) options.body = payload;
      const work = (async () => {
        const res = await fetchImpl(targetUrl, options);
        if (!res.ok) res._cachedText = await res.text().catch(() => "");
        else res._cachedJson = await res.json();
        return res;
      })();
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  for (let i = 0; i <= retries; i++) {
    try {
      const r = await attempt(url);
      if (!r.ok) {
        const text = r._cachedText !== undefined ? r._cachedText : (await r.text());
        if (r.status === 400 || r.status === 404) {
          throw new Error(`HTTP ${r.status}: ${text.slice(0, 100)}`);
        }
        if (r.status === 418 || r.status === 429 || r.status === 403) {
          const retryAfter = Number(r.headers.get("retry-after"));
          const reported = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 :
            Math.max(0, Date.parse(r.headers.get("retry-after")) - Date.now()) || 0;
          if (r.status === 429) {
            // Soft limit: park this endpoint only, and only for as long as the
            // venue asks (or 2 seconds), so one hot order-book burst cannot
            // take the venue's klines and tickers down with it.
            pauseVenue(url, reported || VENUE_RATE_LIMIT_MS, "HTTP 429", "endpoint");
          } else {
            // 418/403 is an IP-level ban: the whole host has to stand down.
            pauseVenue(url, reported || VENUE_DEFAULT_BAN_MS, `HTTP ${r.status}`);
          }
        }
        const fallbackUrl = binanceFallbackUrl(url);
        if (fallbackUrl && !isVenuePaused(fallbackUrl)) {
          try {
            const r2 = await attempt(fallbackUrl);
            if (r2.ok) return r2._cachedJson !== undefined ? r2._cachedJson : (await r2.json());
          } catch (_) {}
        }
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 100)}`);
      }
      const data = r._cachedJson !== undefined ? r._cachedJson : (await r.json());
      if (isVenueThrottle(url, data)) {
        pauseVenue(url, VENUE_RATE_LIMIT_MS, "API rate limit", "endpoint");
        throw new Error("VENUE_PAUSED: API rate limit");
      }
      return data;
    } catch (e) {
      if (isVenuePaused(url) || e.message?.startsWith("VENUE_PAUSED")) throw e;
      if (e.message && (e.message.startsWith("HTTP 400") || e.message.startsWith("HTTP 404"))) throw e;
      const fallbackUrl = binanceFallbackUrl(url);
      if (fallbackUrl && !isVenuePaused(fallbackUrl)) {
        try {
          const r2 = await attempt(fallbackUrl);
          if (r2.ok) return r2._cachedJson !== undefined ? r2._cachedJson : (await r2.json());
        } catch (_) {}
      }
      if (i === retries) throw e;
      // Jittered backoff: without jitter every concurrent failure retries in
      // lockstep and re-triggers the same rate limit.
      const backoff = 500 * (i + 1);
      await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff));
    }
  }
}

// тФАтФАтФА Klines REST helpers тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const TF_MAP = {
  BB: { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D", "3d": "3", "1w": "W" },
  OX: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" },
  BG: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" },
  GT: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" },
  MX: { "1m": "Min1", "5m": "Min5", "15m": "Min15", "30m": "Min30", "1h": "Min60", "4h": "Hour4", "1d": "Day1", "3d": "Day3", "1w": "Week1" },
  KC: { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "1440", "3d": "4320", "1w": "10080" },
  BX: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" },
  HT: { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "60min", "4h": "4hour", "1d": "1day", "3d": "3day", "1w": "1week" },
};

function getTfMs(tf) {
  const low = String(tf || "").toLowerCase();
  const num = parseInt(low, 10) || 1;
  if (low.endsWith("m")) return num * 60 * 1000;
  if (low.endsWith("h")) return num * 60 * 60 * 1000;
  if (low.endsWith("d")) return num * 24 * 60 * 60 * 1000;
  if (low.endsWith("w")) return num * 7 * 24 * 60 * 60 * 1000;
  return 60000;
}

function normalizeExchangeSymbol(ex, rawSym) {
  let s = String(rawSym || "").trim();
  if (!s) return s;
  s = s.replace(/\.[FS]$/i, "");
  if (ex === "OX") {
    if (!s.includes("-") && !s.includes("_SPOT")) {
      s = s.replace(/[-_]?USDT$/i, "") + "-USDT-SWAP";
    }
  } else if (ex === "GT") {
    if (!s.includes("_")) s = s.endsWith("USDT") ? s.replace(/USDT$/i, "_USDT") : s + "_USDT";
  } else if (ex === "BX" || ex === "HT") {
    if (!s.includes("-")) s = s.replace(/[-_]?USDT$/i, "") + "-USDT";
    if (ex === "BX" && !s.startsWith("1000")) {
      const base = s.split("-")[0].toUpperCase();
      if (base === "PEPE" || base === "BONK" || base === "FLOKI" || base === "LUNC" || base === "SHIB" || base === "RATS" || base === "SATS" || base === "CHEEMS" || base === "CAT" || base === "WHY" || base === "MOG") {
        s = "1000" + s;
      }
    }
  } else if (ex === "MX") {
    if (!s.includes("_")) s = s.replace(/[-_]?USDT$/i, "") + "_USDT";
  } else if (ex === "KC") {
    if (rawSym.includes("_SPOT")) {
      s = s.replace(/_SPOT$/i, "");
      if (!s.includes("-")) s = s.replace(/[-_]?USDT$/i, "") + "-USDT";
    } else {
      if (s === "BTCUSDT" || s === "BTC-USDT" || s === "BTC_USDT" || s === "BTC") {
        s = "XBTUSDTM";
      } else if (s.startsWith("BTC") && !s.startsWith("BTC-")) {
        s = s.replace(/^BTC/, "XBT");
      }
      s = s.replace(/[-_]/g, "");
      if (!s.endsWith("USDTM")) {
        s = s.endsWith("USDT") ? s + "M" : s + "USDTM";
      }
    }
  }
  return s;
}

function getKlinesUrl(ex, sym, tf, limit, before) {
  const tfMs = getTfMs(tf);
  const isSpot = sym.endsWith("_SPOT") || sym.includes("_SPOT");
  const cleanSym = normalizeExchangeSymbol(ex, sym);
  const endMs = Number.isFinite(+before) && +before > 0 ? +before : Date.now();
  const effectiveLimit = (ex === "KC" && !isSpot) ? Math.min(Number(limit) || 200, 200) : (Number(limit) || 1000);
  const startMs = endMs - (effectiveLimit * tfMs);

  if (ex === "BN" || ex === "AD") {
    if (isSpot) {
      return `https://data-api.binance.vision/api/v3/klines?symbol=${cleanSym}&interval=${tf}&limit=${limit}` + (before ? `&endTime=${before - 1}` : "");
    }
    const base = ex === "BN" ? "fapi.binance.com" : "fapi.asterdex.com";
    return `https://${base}/fapi/v1/klines?symbol=${cleanSym}&interval=${tf}&limit=${limit}` + (before ? `&endTime=${before - 1}` : "");
  }
  if (ex === "BB") {
    return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${cleanSym}&interval=${TF_MAP.BB[tf] || "60"}&limit=${limit}` + (before ? `&end=${before - 1}` : "");
  }
  if (ex === "OX") {
    return `https://www.okx.com/api/v5/market/candles?instId=${cleanSym}&bar=${TF_MAP.OX[tf] || "1H"}&limit=${limit}` + (before ? `&after=${before}` : "");
  }
  if (ex === "BG") {
    return `https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${cleanSym}&granularity=${TF_MAP.BG[tf] || "1H"}&limit=${limit}` + (before ? `&endTime=${before - 1}` : "");
  }
  if (ex === "GT") {
    const gtTf = (TF_MAP.GT[tf] || tf || "1h").toLowerCase();
    return `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${cleanSym}&interval=${gtTf}&limit=${limit}` + (before ? `&to=${Math.floor(before / 1000)}` : "");
  }
  if (ex === "MX") {
    if (before) {
      const startSec = Math.floor(startMs / 1000);
      const endSec = Math.floor(endMs / 1000);
      return `https://contract.mexc.com/api/v1/contract/kline/${cleanSym}?interval=${TF_MAP.MX[tf] || "Min60"}&start=${startSec}&end=${endSec}`;
    }
    return `https://contract.mexc.com/api/v1/contract/kline/${cleanSym}?interval=${TF_MAP.MX[tf] || "Min60"}`;
  }
  if (ex === "KC") {
    if (isSpot) {
      const TF_KC_SPOT = { "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1hour", "2h": "2hour", "4h": "4hour", "6h": "6hour", "8h": "8hour", "12h": "12hour", "1d": "1day", "1w": "1week" };
      const startSec = Math.floor(startMs / 1000);
      const endSec = Math.floor(endMs / 1000);
      return `https://api.kucoin.com/api/v1/market/candles?type=${TF_KC_SPOT[tf] || "1hour"}&symbol=${cleanSym}&startAt=${startSec}&endAt=${endSec}`;
    }
    return `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${cleanSym}&granularity=${TF_MAP.KC[tf] || "60"}&from=${startMs}&to=${endMs}`;
  }
  if (ex === "BX") {
    const qs = before ? `&startTime=${startMs}&endTime=${endMs}` : "";
    return `https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${cleanSym}&interval=${TF_MAP.BX[tf] || "1h"}&limit=${limit}${qs}`;
  }
  if (ex === "HT") {
    // HTX ignores from/to if size is also supplied.
    const range = before ? `&from=${Math.floor(startMs / 1000)}&to=${Math.floor(endMs / 1000)}` : `&size=${limit}`;
    return `https://api.hbdm.vn/linear-swap-ex/market/history/kline?contract_code=${cleanSym}&period=${TF_MAP.HT[tf] || "60min"}${range}`;
  }
  if (ex === "HL") {
    return null; // HL uses POST
  }
  return null;
}

function parseKlines(ex, data) {
  try {
    let rawList = [];
    if (ex === "BN" || ex === "AD") rawList = (Array.isArray(data) ? data : []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[7] || k[5] }));
    else if (ex === "BB") rawList = (data?.result?.list || []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[6] || k[5] }));
    else if (ex === "OX") rawList = (data?.data || []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[7] || k[6] || k[5] }));
    else if (ex === "BG") rawList = (data?.data || []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[6] || k[5] }));
    else if (ex === "GT") rawList = (Array.isArray(data) ? data : []).map(k => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.sum ? +k.sum : (k.a || (k.v ? +k.v * +k.c : 0)) }));
    else if (ex === "MX") {
      if (data?.data?.time && Array.isArray(data.data.time)) {
        const d = data.data;
        rawList = d.time.map((t, i) => {
          const c = +(d.close?.[i] ?? 0);
          const v = d.amount ? +(d.amount[i] ?? 0) : (+(d.vol?.[i] ?? 0) * c);
          return { t: t * 1000, o: +(d.open?.[i] ?? c), h: +(d.high?.[i] ?? c), l: +(d.low?.[i] ?? c), c, v };
        });
      } else if (Array.isArray(data?.data)) {
        rawList = data.data.map(k => Array.isArray(k)
          ? { t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }
          : { t: k.t || k.time, o: k.o || k.open, h: k.h || k.high, l: k.l || k.low, c: k.c || k.close, v: k.v || k.vol || k.amount }
        );
      }
    }
    else if (ex === "KC") {
      if (Array.isArray(data?.data)) {
        const first = data.data[0];
        const isSpotData = first && (+first[0] < 1e11);
        if (isSpotData) {
          // KuCoin Spot: [time, open, close, high, low, volume, turnover]
          rawList = data.data.map(k => ({ t: +k[0] * 1000, o: +k[1], h: +k[3], l: +k[4], c: +k[2], v: +k[6] || +k[5] }));
        } else {
          // KuCoin Futures: [time, open, high, low, close, volume, turnover]
          rawList = data.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] }));
        }
      }
    }
    else if (ex === "BX") rawList = (data?.data || []).map(k => {
      const closeP = +(k.close || k.c || 0);
      const baseVol = +(k.volume || k.v || 0);
      return { t: k.time || k.t || 0, o: k.open || k.o || 0, h: k.high || k.h || 0, l: k.low || k.l || 0, c: closeP, v: baseVol * closeP };
    });
    else if (ex === "HT") rawList = (data?.data || []).map(k => ({ t: k.id, o: k.open, h: k.high, l: k.low, c: k.close, v: k.trade_turnover || k.amount || k.vol }));
    else if (ex === "HL") rawList = (Array.isArray(data) ? data : []).map(k => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: Number(k.v) * Number(k.c) }));

    const cleaned = [];
    for (const k of rawList) {
      const t = normalizeTimestamp(k.t);
      const o = +k.o, h = +k.h, l = +k.l, c = +k.c, v = +k.v;
      if (t > 0 && o > 0 && h > 0 && l > 0 && c > 0) {
        cleaned.push({ t, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 });
      }
    }
    cleaned.sort((a, b) => a.t - b.t);
    return cleaned;
  } catch (e) {
    console.error(`[KLINES] Parse error for ${ex}:`, e.message);
    return [];
  }
}

// Venues without a native three-day candle use real lower-interval OHLCV.
// HTX daily candles are UTC+8; four-hour bars allow UTC-aligned aggregation.
function syntheticSourceTf(ex, tf) {
  if (tf !== "3d") return null;
  if (["BB", "MX", "KC"].includes(ex)) return "1d";
  return ex === "HT" ? "4h" : null;
}

function aggregateTimeframeCandles(candles, tf) {
  const width = getTfMs(tf), buckets = new Map();
  const unique = new Map(candles.map(c => [c.t, c]));
  for (const c of [...unique.values()].sort((a, b) => a.t - b.t)) {
    const t = Math.floor(c.t / width) * width;
    const prev = buckets.get(t);
    if (!prev) buckets.set(t, { ...c, t });
    else { prev.h = Math.max(prev.h, c.h); prev.l = Math.min(prev.l, c.l); prev.c = c.c; prev.v += c.v; }
  }
  return [...buckets.values()];
}

function seedSyntheticCandles(sub, source) {
  if (!sub || sub.closing) return;
  // WebSocket updates received while REST was in flight own their timestamp.
  const merged = new Map(source.map(c => [c.t, c]));
  for (const [t, c] of sub.syntheticCandles || []) merged.set(t, c);
  sub.syntheticCandles = new Map([...merged].sort((a, b) => a[0] - b[0]).slice(-64));
  sub.syntheticReady = true;
}

async function fetchSyntheticHistory(ex, sym, tf, before) {
  const sourceTf = syntheticSourceTf(ex, tf);
  const key = `${ex}|${sym}|${tf}|${before || 'latest'}`;
  const requests = fetchSyntheticHistory.requests ||= new Map();
  if (requests.has(key)) return requests.get(key);
  const request = (async () => {
    const limit = ex === "KC" ? 198 : (ex === "HT" ? 990 : 900);
    const url = getKlinesUrl(ex, sym, sourceTf, limit, before || Date.now());
    const data = await apiFetch(url, 4000, 0);
    if (data?.success === false || data?.status === 'error' || (data?.retCode && data.retCode !== 0) || (ex === 'KC' && data?.code !== '200000')) {
      throw new Error('Source candle request rejected');
    }
    const source = parseKlines(ex, data).filter(c => !before || c.t < before);
    if (!before && !source.length) throw new Error('Source candle history is pending');
    let result = aggregateTimeframeCandles(source, tf);
    // Do not publish a truncated first bucket at a page boundary. Short pages
    // can be new listings, whose first partial bucket is legitimate history.
    if (source.length >= limit && result.length > 1 && source[0].t > result[0].t) result.shift();
    if (!before) seedSyntheticCandles(klineSubs.get(`${ex}|${sym}|${tf}`), source);
    return result;
  })();
  requests.set(key, request);
  try { return await request; }
  finally { if (requests.get(key) === request) requests.delete(key); }
}

function broadcastSyntheticKline(ex, sym, tf, candle) {
  const sub = klineSubs.get(`${ex}|${sym}|${tf}`);
  const clean = marketDataCore.normalizeCandle(candle);
  if (!sub || sub.closing || !clean) return;
  sub.syntheticCandles ||= new Map();
  sub.syntheticCandles.set(clean.t, clean);
  sub.syntheticCandles = new Map([...sub.syntheticCandles].sort((a, b) => a[0] - b[0]).slice(-64));
  if (!sub.syntheticReady) {
    if (!sub.syntheticSeed && !(sub.syntheticRetryAt > Date.now())) {
      sub.syntheticSeed = fetchSyntheticHistory(ex, sym, tf).then(() => {
        if (klineSubs.get(sub.key) !== sub || sub.closing) return;
        const latest = [...sub.syntheticCandles.values()].at(-1);
        if (latest) broadcastSyntheticKline(ex, sym, tf, latest);
      }).catch(() => { sub.syntheticRetryAt = Date.now() + 5000; }).finally(() => { sub.syntheticSeed = null; });
    }
    return;
  }
  const latest = aggregateTimeframeCandles([...sub.syntheticCandles.values()], tf).at(-1);
  if (latest) broadcastKline(ex, sym, tf, latest);
}

async function fetchFullHistory(ex, sym, tf, lite = false) {
  if (syntheticSourceTf(ex, tf)) return fetchSyntheticHistory(ex, sym, tf);
  let fetchEx = ex;
  let fetchSym = sym;
  
  const tfMs = (() => {
    const low = tf.toLowerCase();
    const num = parseInt(low, 10) || 1;
    if (low.endsWith("m")) return num * 60 * 1000;
    if (low.endsWith("h")) return num * 60 * 60 * 1000;
    if (low.endsWith("d")) return num * 24 * 60 * 60 * 1000;
    if (low.endsWith("w")) return num * 7 * 24 * 60 * 60 * 1000;
    return 60000;
  })();

  const pages = { BN: 3, BB: 3, OX: 5, BG: 3, GT: 3, MX: 1, KC: 4, BX: 3, HT: 1, AD: 3 };
  const limits = { BN: 1000, BB: 1000, OX: 100, BG: 1000, GT: 1000, MX: 1000, KC: 200, BX: 1000, HT: 1000, AD: 1000 };
  const maxP = lite ? 1 : (pages[fetchEx] || 3);
  const limit = limits[fetchEx] || 1000;
  
  const hlCoin = sym.replace(/[-_]?(?:USDTM|USDT|USDC|BUSD|DAI|USD)(?:[-_]?(?:SWAP|PERP|PERPETUAL|SPOT))?$/i, "") || sym;

  if (lite) {
    const tFetch0 = Date.now();
    // 0. Ultra-fast local Go scanner (<30ms vs 1500ms external network)
    try {
      const cleanGoSym = normalizeExchangeSymbol(fetchEx, fetchSym);
      const goUrl = `${GO_SCANNER_URL}/api/klines?ex=${encodeURIComponent(fetchEx)}&sym=${encodeURIComponent(cleanGoSym)}&tf=${encodeURIComponent(tf)}&limit=300`;
      const rGo = await fetch(goUrl, { signal: AbortSignal.timeout(350) }).catch(() => null);
      if (rGo && rGo.ok) {
        const dataGo = await rGo.json().catch(() => null);
        if (Array.isArray(dataGo) && dataGo.length >= 20) {
          const lastC = dataGo[dataGo.length - 1];
          const maxStaleMs = Math.max(tfMs * 5, 10 * 60 * 1000);
          const isFresh = lastC && Number.isFinite(lastC.t) && (Date.now() - lastC.t < maxStaleMs);

          let hasHugeGap = false;
          const maxAllowedGapMs = Math.max(tfMs * 50, 4 * 3600000);
          for (let i = 1; i < dataGo.length; i++) {
            if (dataGo[i].t - dataGo[i - 1].t > maxAllowedGapMs) {
              hasHugeGap = true;
              break;
            }
          }

          if (isFresh && !hasHugeGap) {
            console.log(`[FETCH LITE GO SCANNER OK] ${fetchEx}:${fetchSym} took ${Date.now() - tFetch0}ms, candles=${dataGo.length}`);
            return dataGo;
          } else {
            console.warn(`[GO SCANNER STALE/GAPPED] ${fetchEx}:${fetchSym} isFresh=${isFresh} (last=${lastC ? new Date(lastC.t).toISOString() : 'none'}) gap=${hasHugeGap}`);
          }
        }
      }
    } catch (_) {}

    try {
      let data;
      const liteLimit = fetchEx === "KC" ? 400 : (fetchEx === "OX" ? 100 : 300);
      if (fetchEx === "HL") {
        data = await apiFetch("https://api.hyperliquid.xyz/info", 4000, 0, "POST", {
          type: "candleSnapshot",
          req: { coin: hlCoin, interval: tf.toLowerCase(), startTime: Date.now() - (liteLimit * tfMs), endTime: Date.now() }
        });
        const parsed = parseKlines(ex, data);
        return parsed.length > liteLimit ? parsed.slice(-liteLimit) : parsed;
      } else if (fetchEx === "KC") {
        const isSpot = sym.endsWith("_SPOT") || sym.includes("_SPOT");
        if (isSpot) {
          const url = getKlinesUrl(ex, sym, tf, 400);
          data = url ? await apiFetch(url, 4000, 0) : null;
          const parsed = parseKlines(ex, data);
          return parsed.length > 400 ? parsed.slice(-400) : parsed;
        }
        const nowMs = Date.now();
        const start0 = nowMs - (200 * tfMs);
        const cleanSym = normalizeExchangeSymbol(ex, sym);
        const gran = TF_MAP.KC[tf] || "60";
        const url0 = `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${cleanSym}&granularity=${gran}&from=${start0}&to=${nowMs}`;
        const r0 = await apiFetch(url0, 3500, 0).catch(() => null);
        const parsed = r0 ? parseKlines(ex, r0) : [];
        const resCandles = parsed.length > 300 ? parsed.slice(-300) : parsed;
        console.log(`[FETCH LITE OK] ${ex}:${sym} took ${Date.now() - tFetch0}ms, candles=${resCandles.length}`);
        return resCandles;
      } else if (fetchEx === "MX") {
        const cleanSym = normalizeExchangeSymbol(ex, sym);
        const interval = TF_MAP.MX[tf] || "Min60";
        const url = `https://contract.mexc.com/api/v1/contract/kline/${cleanSym}?interval=${interval}`;
        const data = await apiFetch(url, 4000, 1).catch(() => null);
        const parsed = data ? parseKlines(ex, data) : [];
        const resCandles = parsed.length > 300 ? parsed.slice(-300) : parsed;
        console.log(`[FETCH LITE OK] ${ex}:${sym} took ${Date.now() - tFetch0}ms, candles=${resCandles.length}`);
        return resCandles;
      } else {
        const url = getKlinesUrl(ex, sym, tf, liteLimit);
        if (!url) {
          console.log(`[FETCH NO URL] ${ex}:${sym}`);
          return [];
        }
        data = await apiFetch(url, 3500, 0);
        let parsed = parseKlines(ex, data);
        if (ex === "BX" && parsed.length === 0 && !sym.startsWith("1000")) {
          // BingX meme coins often use 1000 prefix (1000PEPE-USDT, 1000BONK-USDT, etc.)
          const cleanNo1000 = sym.replace(/^1000/, "");
          const fallbackSym = "1000" + cleanNo1000;
          const fallbackUrl = getKlinesUrl(ex, fallbackSym, tf, liteLimit);
          if (fallbackUrl) {
            try {
              const fbData = await apiFetch(fallbackUrl, 4000, 0);
              const fbParsed = parseKlines(ex, fbData);
              if (fbParsed.length > 0) parsed = fbParsed;
            } catch (_) {}
          }
        }
        const resCandles = parsed.length > liteLimit ? parsed.slice(-liteLimit) : parsed;
        console.log(`[FETCH LITE OK] ${ex}:${sym} took ${Date.now() - tFetch0}ms, candles=${resCandles.length}`);
        return resCandles;
      }
    } catch (e) {
      console.log(`[FETCH LITE ERR] ${ex}:${sym} took ${Date.now() - tFetch0}ms: ${e.message}`);
      return [];
    }
  }

  let all = [];
  const nowTs = Date.now();
  if (maxP === 1) {
    try {
      const url = getKlinesUrl(fetchEx, fetchSym, tf, limit, nowTs);
      if (url) {
        const data = await apiFetch(url, 4000, 0);
        all = parseKlines(fetchEx, data);
      }
    } catch (e) {}
  } else {
    const promises = [];
    for (let p = 0; p < maxP; p++) {
      const before = nowTs - (p * limit * tfMs);
      if (fetchEx === "HL") {
        promises.push(apiFetch("https://api.hyperliquid.xyz/info", 3500, 0, "POST", { type: "candleSnapshot", req: { coin: hlCoin, interval: tf.toLowerCase(), startTime: before - (limit * tfMs), endTime: before } }).then(data => (Array.isArray(data) ? data : []).map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c }))).catch(() => []));
      } else {
        const url = getKlinesUrl(fetchEx, fetchSym, tf, limit, before);
        if (url) {
          promises.push(apiFetch(url, 3500, 0).then(data => parseKlines(fetchEx, data)).catch(() => []));
        }
      }
    }
    const results = await Promise.all(promises);
    for (const batch of results) {
      if (Array.isArray(batch)) all.push(...batch);
    }
  }
  const seen = new Set();
  return all.filter(c => c && Number.isFinite(c.t) && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0 && (seen.has(c.t) ? false : seen.add(c.t))).sort((a,b) => a.t - b.t);
}

// Candle cache keyed by `${ex}|${sym}|${tf}|${lite}`. Each entry holds up to
// 7200 numbers (1200 candles), measured at ~57 KB. With 1500 scanned tickers x
// 5 timeframes x (lite + full) that is 15000 entries ≈ 834 MB, which is why the
// process kept being recycled for memory. LRU-bounded below.
const klinesCache = new Map();
// 1500 x ~57 KB ≈ 85 MB. Deliberately conservative: the process shares a 650 MB
// pm2 budget with the ticker map, the wall scanner and the scanner cache below.
const KLINES_CACHE_MAX_ENTRIES = 1500;
const KLINES_CACHE_TTL_MS = 30 * 60 * 1000;
let lastKlinesPruneAt = 0;

/**
 * Bound klinesCache. Age-based first, then least-recently-used eviction so the
 * cache can never outgrow the heap. `at` is the fetch time and drives freshness
 * (do not touch it); `used` is the access time and drives eviction only.
 */
function pruneKlinesCache(force = false) {
  const now = Date.now();
  if (!force && now - lastKlinesPruneAt < 30000 && klinesCache.size <= KLINES_CACHE_MAX_ENTRIES) return;
  lastKlinesPruneAt = now;

  for (const [key, entry] of klinesCache) {
    if (!entry || now - (entry.at || 0) > KLINES_CACHE_TTL_MS) klinesCache.delete(key);
  }
  if (klinesCache.size <= KLINES_CACHE_MAX_ENTRIES) return;

  const entries = Array.from(klinesCache.entries())
    .sort((a, b) => (a[1].used || a[1].at || 0) - (b[1].used || b[1].at || 0));
  const excess = klinesCache.size - KLINES_CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i++) klinesCache.delete(entries[i][0]);
}
const klinesInFlight = new Map();

// Backtest sessions keep unrevealed candles on the server. The browser receives
// only the historical context and cannot peek at the result before replaying it.
const backtestSessions = new Map();
const BACKTEST_TTL = 2 * 60 * 60 * 1000;

const BACKTEST_EXCHANGES = {
  BN: "Binance Futures", BB: "Bybit Futures", OX: "OKX Futures", BG: "Bitget Futures", GT: "Gate Futures",
  MX: "MEXC Futures", KC: "KuCoin Futures", BX: "BingX Futures", HT: "HTX Futures",
  HL: "Hyperliquid", AD: "Asterdex",
};
const NON_CRYPTO_BASES = new Set([
  "AAPL", "TSLA", "NVDA", "AMZN", "META", "MSFT", "GOOG", "GOOGL", "NFLX", "AMD", "INTC", "AVGO",
  "ARM", "MU", "QCOM", "TSM", "ASML", "SMCI", "ORCL", "IBM", "CSCO", "CRM", "ADBE", "NOW",
  "COIN", "MSTR", "MARA", "RIOT", "HOOD", "PLTR", "BABA", "SHOP", "PYPL", "SQ", "SOFI",
  "JPM", "BAC", "GS", "MS", "V", "MA", "AXP", "WMT", "COST", "HD", "NKE", "SBUX", "MCD",
  "LLY", "JNJ", "PFE", "MRNA", "ABBV", "UNH", "KO", "PEP", "PG", "XOM", "CVX", "CAT", "GE",
  "DIS", "UBER", "ABNB", "RBLX", "SNAP", "GME", "AMC", "RDDT", "F", "GM", "BA",
  "SPY", "QQQ", "DIA", "IWM", "SQQQ", "TQQQ", "DXYZ", "XYZ", "GLD", "SLV", "XAU", "XAG",
  "WTI", "BRENT", "USOIL", "UKOIL",
  "SOXL", "SOXS", "SNDK", "SPCX", "SKHYNIX", "SKHY", "SNXX", "CYS", "CL", "KORU", "HEI",
  "MU", "UB", "CRCL", "DRAM", "NBIS", "RDW", "EWY", "EWJ", "AAOI", "SSPC", "CXMT", "AXTI",
  "RKLB", "XLK", "WDC", "BIIB", "ALAB", "AEHR", "COHR", "APP", "REGN", "DELL", "AMGN", "GILD",
  "SOXX", "MRVL",
]);

function backtestBase(ticker) {
  if (ticker?.base) return String(ticker.base).toUpperCase();
  return String(ticker?.sym || "").toUpperCase()
    .replace(/-USDT-SWAP$/, "").replace(/[-_]USDT$/, "").replace(/USDTM?$/, "").replace(/-PERP$/, "");
}

function isNonCryptoBacktestBase(base) {
  const candidates = new Set([String(base || "").toUpperCase()]);
  for (const value of Array.from(candidates)) {
    candidates.add(value.replace(/STOCK/g, "").replace(/2USD$/, ""));
    candidates.add(value.replace(/^NCSK/, "").replace(/2USD$/, ""));
  }
  for (const value of Array.from(candidates)) {
    if (/^[RX]/.test(value)) candidates.add(value.slice(1));
    if (/[XM]$/.test(value)) candidates.add(value.slice(0, -1));
  }
  return Array.from(candidates).some(value => NON_CRYPTO_BASES.has(value));
}

function isEligibleBacktestTicker(ticker, exchange) {
  if (!ticker || ticker.ex !== exchange || !ticker.sym || !(ticker.p > 0) || !(ticker.v > 0)) return false;
  const symbol = ticker.sym.toUpperCase();
  const base = backtestBase(ticker);
  const stableBases = new Set(["USDT", "USDC", "USD1", "USDE", "USDD", "DAI", "FDUSD", "TUSD", "BUSD", "PYUSD", "EUR", "USDP", "USDX", "USDF"]);
  if (exchange !== "HL" && !/USDT|USDTM|USDT-SWAP/i.test(symbol)) return false;
  if (/_SPOT$/.test(symbol)) return false;
  if (stableBases.has(base) || isNonCryptoBacktestBase(base)) return false;
  if (/^(STOCK|EQUITY|INDEX|FOREX|COMMODITY)[-_:]/.test(symbol)) return false;
  if (/(BULL|BEAR|UP|DOWN|3L|3S)$/.test(base)) return false;
  return true;
}

function getBacktestUniverse(exchange) {
  return Array.from(tickers.values())
    .filter(ticker => isEligibleBacktestTicker(ticker, exchange))
    .sort((a, b) => {
      const volA = Number(a.v) || 0;
      const volB = Number(b.v) || 0;
      const chgA = Math.abs(Number(a.chg) || 0);
      const chgB = Math.abs(Number(b.chg) || 0);
      const scoreA = Math.log10(Math.max(1000, volA)) * 2.5 + chgA * 2.0;
      const scoreB = Math.log10(Math.max(1000, volB)) * 2.5 + chgB * 2.0;
      return scoreB - scoreA;
    });
}

async function fetchBacktestCandles(ex, sym, tf) {
  const tfMs = (() => {
    const low = tf.toLowerCase();
    const num = parseInt(low, 10) || 1;
    if (low.endsWith("m")) return num * 60 * 1000;
    if (low.endsWith("h")) return num * 60 * 60 * 1000;
    if (low.endsWith("d")) return num * 24 * 60 * 60 * 1000;
    return 60000;
  })();

  const nowTs = Date.now();
  const pages = (ex === "OX" || ex === "KC") ? 4 : 2;
  const limit = (ex === "OX") ? 100 : ((ex === "KC") ? 200 : 1000);

  const promises = [];
  for (let p = 0; p < pages; p++) {
    const before = nowTs - (p * limit * tfMs);
    if (ex === "HL") {
      promises.push(
        apiFetch("https://api.hyperliquid.xyz/info", 3500, 0, "POST", {
          type: "candleSnapshot",
          req: { coin: sym, interval: tf.toLowerCase(), startTime: before - (limit * tfMs), endTime: before }
        }).then(data => (Array.isArray(data) ? data : []).map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c }))).catch(() => [])
      );
    } else {
      const url = getKlinesUrl(ex, sym, tf, limit, before);
      if (url) {
        promises.push(apiFetch(url, 3500, 0).then(data => parseKlines(ex, data)).catch(() => []));
      }
    }
  }

  const results = await Promise.all(promises);
  const all = [];
  for (const batch of results) {
    if (Array.isArray(batch)) all.push(...batch);
  }
  const seen = new Set();
  return all
    .filter(c => c && Number.isFinite(c.t) && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0 && (seen.has(c.t) ? false : seen.add(c.t)))
    .sort((a, b) => a.t - b.t)
    .slice(0, -1);
}

function scoreBacktestCandidate(candles, cut, visibleBars, futureBars, tf) {
  const visible = candles.slice(cut - visibleBars, cut);
  const future = candles.slice(cut, cut + futureBars);
  if (visible.length < visibleBars || future.length < futureBars) return 0;

  const lastClose = visible[visible.length - 1].c;
  if (!lastClose || lastClose <= 0) return 0;

  const visHigh = Math.max(...visible.map(c => c.h));
  const visLow = Math.min(...visible.map(c => c.l));
  const visRangePct = (visHigh - visLow) / lastClose;

  const futHigh = Math.max(...future.map(c => c.h));
  const futLow = Math.min(...future.map(c => c.l));
  const futRangePct = (futHigh - futLow) / lastClose;

  // Strict dynamic filters: guarantees active, volatile market, not a boring flat channel
  const minVisRange = { "1m": 0.035, "5m": 0.055, "15m": 0.080, "30m": 0.100, "1h": 0.130, "4h": 0.180, "1d": 0.250 }[tf] || 0.06;
  const minFutRange = { "1m": 0.020, "5m": 0.030, "15m": 0.045, "30m": 0.060, "1h": 0.080, "4h": 0.120, "1d": 0.160 }[tf] || 0.035;

  if (visRangePct < minVisRange || futRangePct < minFutRange) return 0;

  // Check activity near cutoff (last 25 bars must have movement)
  const recent = visible.slice(-25);
  const recHigh = Math.max(...recent.map(c => c.h));
  const recLow = Math.min(...recent.map(c => c.l));
  const recRangePct = (recHigh - recLow) / lastClose;
  if (recRangePct < minFutRange * 0.4) return 0;

  // Measure ATR and Candle Bodies
  let trSum = 0;
  let bodySum = 0;
  for (let i = 1; i < visible.length; i++) {
    const cur = visible[i];
    const prev = visible[i - 1].c;
    trSum += Math.max(cur.h - cur.l, Math.abs(cur.h - prev), Math.abs(cur.l - prev));
    bodySum += Math.abs(cur.c - cur.o);
  }
  const avgTr = trSum / (visible.length - 1);
  const avgBody = bodySum / (visible.length - 1);
  const atrPct = avgTr / lastClose;
  const bodyPct = avgBody / lastClose;

  const firstOpen = visible[0].o;
  const trendPct = Math.abs(lastClose - firstOpen) / firstOpen;

  return (visRangePct * 100) * 2.5 
       + (futRangePct * 100) * 3.5 
       + (recRangePct * 100) * 2.0 
       + (atrPct * 1000) * 3.0 
       + (bodyPct * 1000) * 2.0 
       + (trendPct * 100) * 1.5;
}

function findBestBacktestWindow(candles, tf) {
  if (!candles || candles.length < 260) return null;
  const visibleBars = Math.min(200, Math.max(150, Math.floor(candles.length * 0.45)));
  const futureBars = Math.min(90, Math.max(50, Math.floor(candles.length * 0.18)));
  const minCut = visibleBars;
  const maxCut = candles.length - futureBars;
  if (maxCut <= minCut) return null;

  const candidates = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    const candidateCut = minCut + Math.floor(Math.random() * (maxCut - minCut + 1));
    const score = scoreBacktestCandidate(candles, candidateCut, visibleBars, futureBars, tf);
    if (score > 0) {
      candidates.push({
        cut: candidateCut,
        visible: candles.slice(candidateCut - visibleBars, candidateCut),
        future: candles.slice(candidateCut, candidateCut + futureBars),
        score,
      });
    }
  }

  // Fallback with slightly relaxed criteria if strict filter didn't match in this specific batch
  if (candidates.length === 0) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidateCut = minCut + Math.floor(Math.random() * (maxCut - minCut + 1));
      const visible = candles.slice(candidateCut - visibleBars, candidateCut);
      const future = candles.slice(candidateCut, candidateCut + futureBars);
      const lastClose = visible[visible.length - 1].c;
      const visHigh = Math.max(...visible.map(c => c.h));
      const visLow = Math.min(...visible.map(c => c.l));
      const visRangePct = (visHigh - visLow) / lastClose;
      const futHigh = Math.max(...future.map(c => c.h));
      const futLow = Math.min(...future.map(c => c.l));
      const futRangePct = (futHigh - futLow) / lastClose;

      if (visRangePct > 0.035 && futRangePct > 0.02) {
        candidates.push({ cut: candidateCut, visible, future, score: visRangePct + futRangePct });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, Math.min(3, candidates.length));
  return top[Math.floor(Math.random() * top.length)];
}

function publicBacktestCandle(c) {
  return [c.t, c.o, c.h, c.l, c.c, c.v];
}

setInterval(() => {
  const cutoff = Date.now() - BACKTEST_TTL;
  for (const [id, session] of backtestSessions) {
    if (session.createdAt < cutoff) backtestSessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ─── Go Scanner Proxy ─────────────────────────────────────────────────────────────
const GO_SCANNER_URL = "http://127.0.0.1:8082";
// Both proxies previously used a bare `fetch` with no signal. If the Go scanner
// accepts the TCP connection but never answers, the request hung until
// `server.requestTimeout` (30 s) — on a user-facing chart path.
const GO_SCANNER_TIMEOUT_MS = 2500;

app.get("/api/go-status", async (req, res) => {
  setPublicCors(req, res);
  try {
    const r = await fetch(`${GO_SCANNER_URL}/api/klines?ex=BN&sym=BTCUSDT&tf=1m&limit=1`, {
      signal: AbortSignal.timeout(GO_SCANNER_TIMEOUT_MS)
    });
    if (r.ok) {
      res.json({ status: "online" });
    } else {
      res.json({ status: "error", code: r.status });
    }
  } catch (e) {
    res.json({ status: "offline", error: e.message });
  }
});

app.get("/api/go-klines", async (req, res) => {
  setPublicCors(req, res);
  const { ex = "BN", sym = "BTCUSDT", tf = "1h", limit = "200" } = req.query;
  try {
    const goUrl = `${GO_SCANNER_URL}/api/klines?ex=${encodeURIComponent(ex)}&sym=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}&limit=${encodeURIComponent(limit)}`;
    const r = await fetch(goUrl, { signal: AbortSignal.timeout(GO_SCANNER_TIMEOUT_MS * 2) });
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      const lastC = data[data.length - 1];
      const maxStaleMs = 30 * 60 * 1000;
      if (lastC && Number.isFinite(lastC.t) && (Date.now() - lastC.t > maxStaleMs)) {
        return res.status(503).json({ error: "Go scanner klines are stale" });
      }
    }
    // Go returns [{t,o,h,l,c,v}] – convert to flat array for frontend compatibility
    const flat = [];
    for (const c of data) flat.push(c.t, c.o, c.h, c.l, c.c, c.v);
    res.json(flat);
  } catch (e) {
    res.status(503).json({ error: "Go scanner offline: " + e.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────────

function cacheKey(ex, sym, tf, lite) {
  return `${ex}|${sym}|${tf}|${lite ? "1" : "0"}`;
}

// An in-flight entry that never settles used to poison its key forever: the
// promise stayed in the map because `.finally()` never ran, so every later
// request for the same key awaited it and timed out. That is why exactly the
// hottest symbols (BTC/ETH on 5m — the chart defaults) hung for 20+ seconds
// while colder ones answered in 4. Entries now carry a start time and expire.
const KLINES_INFLIGHT_TTL_MS = 15000;
// A chart request must never hold the browser longer than this.
const KLINES_RESPONSE_DEADLINE_MS = 6000;

/** Pack candle objects into the flat numeric wire format. */
function encodeFlatCandles(candles) {
  const flat = new Array(candles.length * 6);
  for (let i = 0, j = 0; i < candles.length; i++, j += 6) {
    const c = candles[i];
    flat[j] = c.t; flat[j + 1] = c.o; flat[j + 2] = c.h;
    flat[j + 3] = c.l; flat[j + 4] = c.c; flat[j + 5] = c.v;
  }
  return flat;
}

/**
 * `Promise.race([work, timeout])` leaves the losing timer armed — the timeout
 * callback and its closure stay alive for the full duration even after `work`
 * settles. The scanner races per coin per timeframe, so at scan volume that meant
 * thousands of pending timers held simultaneously. This clears the timer as soon
 * as either side settles.
 */
function raceWithTimeout(promise, timeoutMs, timeoutValue = null) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) { clearTimeout(timer); timer = null; }
  });
}

/**
 * Fetch klines once per key, writing the result into klinesCache.
 * Concurrent callers share the same request; a stalled one cannot block the key
 * beyond KLINES_INFLIGHT_TTL_MS.
 */
function startKlinesRefresh(ex, sym, tf, useLite, key) {
  const existing = klinesInFlight.get(key);
  if (existing && Date.now() - existing.startedAt < KLINES_INFLIGHT_TTL_MS) {
    return existing.promise;
  }

  const startedAt = Date.now();
  const promise = fetchFullHistory(ex, sym, tf, useLite)
    .then(candles => {
      if (klinesInFlight.get(key)?.promise === promise && Array.isArray(candles) && candles.length > 0) {
        const at = Date.now();
        const encoded = encodeFlatCandles(candles);
        klinesCache.set(key, { at, used: at, data: encoded });
        // Dual-cache for MEXC: a single request returns full history (up to 2000 candles).
        // Seed both lite and full caches so the background full fetch hits cache instantly in 0ms!
        if (ex === "MX") {
          const otherKey = cacheKey(ex, sym, tf, !useLite);
          if (!klinesCache.has(otherKey)) {
            const otherData = useLite ? encoded : (encoded.length > 1800 ? encoded.slice(-1800) : encoded);
            klinesCache.set(otherKey, { at, used: at, data: otherData });
            pruneKlinesCache();
          }
        }
        pruneKlinesCache();
      }
      return candles;
    })
    .finally(() => {
      // Only clear our own entry: a newer attempt may already own the key.
      const cur = klinesInFlight.get(key);
      if (cur && cur.promise === promise) klinesInFlight.delete(key);
    });

  klinesInFlight.set(key, { promise, startedAt });
  return promise;
}

app.get("/api/klines", async (req, res) => {
  let { ex = "BN", sym = "BTCUSDT", tf = "4h", lite = "0", before } = req.query;
  sym = normalizeExchangeSymbol(ex, sym);
  setPublicCors(req, res);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  if (before) {
    const beforeTs = Number(before);
    if (Number.isFinite(beforeTs) && beforeTs > 0) {
      try {
        if (syntheticSourceTf(ex, tf)) {
          return res.json(await fetchSyntheticHistory(ex, sym, tf, beforeTs));
        } else if (ex === "HL") {
          const tfMs = (() => {
            const low = tf.toLowerCase();
            const num = parseInt(low, 10) || 1;
            if (low.endsWith("m")) return num * 60 * 1000;
            if (low.endsWith("h")) return num * 60 * 60 * 1000;
            if (low.endsWith("d")) return num * 24 * 60 * 60 * 1000;
            return 60000;
          })();
          const data = await apiFetch("https://api.hyperliquid.xyz/info", 4000, 0, "POST", {
            type: "candleSnapshot",
            req: { coin: sym, interval: tf.toLowerCase(), startTime: beforeTs - (1000 * tfMs), endTime: beforeTs }
          });
          const parsed = (Array.isArray(data) ? data : []).map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c }));
          return res.json(parsed);
        } else if (ex === "KC") {
          const tfMs = getTfMs(tf);
          const isSpot = sym.endsWith("_SPOT") || sym.includes("_SPOT");
          if (isSpot) {
            const url = getKlinesUrl(ex, sym, tf, 400, beforeTs);
            const data = url ? await apiFetch(url, 4000, 0) : null;
            return res.json(parseKlines(ex, data));
          }
          const cleanSym = normalizeExchangeSymbol(ex, sym.replace(/_SPOT$/i, ""));
          const gran = TF_MAP.KC[tf] || "60";
          const start0 = beforeTs - (200 * tfMs);
          const start1 = start0 - (200 * tfMs);
          const url0 = `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${cleanSym}&granularity=${gran}&from=${start0}&to=${beforeTs}`;
          const url1 = `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${cleanSym}&granularity=${gran}&from=${start1}&to=${start0}`;
          const [r0, r1] = await Promise.all([
            apiFetch(url0, 4000, 0),
            apiFetch(url1, 4000, 0)
          ]);
          const p0 = r0 ? parseKlines(ex, r0) : [];
          const p1 = r1 ? parseKlines(ex, r1) : [];
          const combined = [...p1, ...p0].sort((a, b) => a.t - b.t);
          return res.json(combined);
        } else {
          const lim = ex === "OX" ? 100 : 1000;
          const url = getKlinesUrl(ex, sym, tf, lim, beforeTs);
          if (!url) return res.json([]);
          const data = await apiFetch(url, 4000, 0);
          const parsed = parseKlines(ex, data);
          return res.json(parsed);
        }
      } catch (e) {
        res.setHeader("Retry-After", "2");
        return res.status(503).json({ error: "Historical candles temporarily unavailable" });
      }
    }
  }
  
  const useLite = lite === "1";
  const key = cacheKey(ex, sym, tf, useLite);
  const now = Date.now();

  const cached = klinesCache.get(key);
  // TTL: 10s for 1m/5m fast scanning, 5 minutes for higher TFs
  const ttl = (tf === "1m" || tf === "5m") ? 10000 : 300000;

  if (cached && now - cached.at < ttl) {
    cached.used = now;
    return res.json(cached.data);
  }

  // Cross-cache hit: If lite is requested, check if full history exists in cache!
  if (useLite) {
    const fullKey = cacheKey(ex, sym, tf, false);
    const fullCached = klinesCache.get(fullKey);
    if (fullCached && fullCached.data && Array.isArray(fullCached.data) && fullCached.data.length > 0) {
      fullCached.used = now;
      if (now - fullCached.at >= ttl) startKlinesRefresh(ex, sym, tf, useLite, key).catch(() => {});
      const liteCount = 300 * 6;
      const liteData = fullCached.data.length > liteCount ? fullCached.data.slice(-liteCount) : fullCached.data;
      return res.json(liteData);
    }
  }

  // Stale-while-revalidate: paint the chart from whatever we already have and
  // refresh in the background. A professional terminal never blocks the canvas
  // on a network round trip, and the exchange feed keeps the live candle current
  // over the WebSocket anyway.
  if (cached && cached.data && cached.data.length > 0) {
    cached.used = now;
    startKlinesRefresh(ex, sym, tf, useLite, key).catch(() => {});
    return res.json(cached.data);
  }


  const tStart = Date.now();
  console.log(`[KLINES REQ] ${ex}:${sym}:${tf} lite=${lite}`);
  try {
    const candles = await raceWithTimeout(
      startKlinesRefresh(ex, sym, tf, useLite, key),
      KLINES_RESPONSE_DEADLINE_MS,
      null
    );
    console.log(`[KLINES RES] ${ex}:${sym}:${tf} took ${Date.now() - tStart}ms, candles=${Array.isArray(candles) ? candles.length : candles}`);

    if (Array.isArray(candles) && candles.length > 0) {
      return res.json(encodeFlatCandles(candles));
    }

    // The refresh may have landed in the cache just now.
    const fresh = klinesCache.get(key);
    if (fresh && fresh.data && fresh.data.length > 0) {
      fresh.used = Date.now();
      return res.json(fresh.data);
    }
    // Return pending status gracefully so client retries seamlessly without failing
    res.setHeader("X-Klines-Pending", "1");
    res.setHeader("Retry-After", "1");
    return res.json([]);
  } catch (e) {
    console.error(`[KLINES ERROR] ${ex} ${sym} ${tf}:`, e.message);
    if (cached) return res.json(cached.data);
    res.setHeader("X-Klines-Pending", "1");
    res.setHeader("Retry-After", "1");
    return res.json([]);
  }
});

async function mapConcurrent(items, limit, fn) {
  let idx = 0;
  const results = [];
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

app.get("/api/klines/batch", async (req, res) => {
  let { ex = "KC", symbols = "", tf = "1m", lite = "1" } = req.query;
  setPublicCors(req, res);
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  const rawList = symbols.split(",").map(s => s.trim()).filter(Boolean).slice(0, 32);
  if (!rawList.length) return res.json({});

  const useLite = lite === "1";
  const now = Date.now();
  const ttl = (tf === "1m" || tf === "5m") ? 10000 : 300000;
  const results = {};
  const streaming = req.query.stream === "1";
  if (streaming) {
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }

  // Stagger MEXC requests by 80ms to avoid MEXC anti-DDoS rate-limit tarpit; parallelize others
  const isPaced = (ex === "MX");
  await mapConcurrent(rawList, streaming ? 6 : rawList.length, async (rawSym, i) => {
    if (isPaced && i > 0) await new Promise(r => setTimeout(r, i * 80));
    const sym = normalizeExchangeSymbol(ex, rawSym);
    const key = cacheKey(ex, sym, tf, useLite);
    const cached = klinesCache.get(key);

    const storeResult = (flat) => {
      if (!flat || !flat.length) return;
      if (streaming) {
        if (!res.destroyed && !res.writableEnded) {
          res.write(JSON.stringify({ sym: rawSym, data: flat }) + "\n");
          res.flush?.();
        }
        return;
      }
      results[rawSym] = flat;
      results[sym] = flat;
      const clean = sym.replace(/[-_]/g, "");
      results[clean] = flat;
      const rawClean = rawSym.replace(/[-_]/g, "");
      results[rawClean] = flat;
    };

    if (cached && cached.data && cached.data.length > 0) {
      cached.used = now;
      if (now - cached.at >= ttl) startKlinesRefresh(ex, sym, tf, useLite, key).catch(() => {});
      storeResult(cached.data);
      return;
    }

    if (useLite) {
      const fullKey = cacheKey(ex, sym, tf, false);
      const fullCached = klinesCache.get(fullKey);
      if (fullCached && fullCached.data && Array.isArray(fullCached.data) && fullCached.data.length > 0) {
        fullCached.used = now;
        if (now - fullCached.at >= ttl) startKlinesRefresh(ex, sym, tf, useLite, key).catch(() => {});
        const liteCount = 300 * 6;
        const liteData = fullCached.data.length > liteCount ? fullCached.data.slice(-liteCount) : fullCached.data;
        storeResult(liteData);
        return;
      }
    }

    try {
      const candles = await raceWithTimeout(
        startKlinesRefresh(ex, sym, tf, useLite, key),
        streaming ? KLINES_RESPONSE_DEADLINE_MS : (useLite ? 3500 : 8000),
        null
      );
      if (Array.isArray(candles) && candles.length > 0) {
        storeResult(encodeFlatCandles(candles));
      } else {
        const fresh = klinesCache.get(key);
        if (fresh && fresh.data && fresh.data.length > 0) {
          fresh.used = Date.now();
          storeResult(fresh.data);
        }
      }
    } catch (_) {}
  });

  if (streaming) return res.end();
  return res.json(results);
});

// ─── Blind backtest / bar replay ──────────────────────────────────────────────────
app.get("/api/backtest/new", async (req, res) => {
  // Express 4 does not catch rejected async handlers. Everything after the first
  // `await` runs synchronous window-selection code that can throw on a malformed
  // candle series, and an unguarded throw would send no response at all.
  try {
    const allowedTf = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);
    const tf = allowedTf.has(req.query.tf) ? req.query.tf : "5m";
    const exchange = BACKTEST_EXCHANGES[req.query.ex] ? req.query.ex : "BB";
    const universe = getBacktestUniverse(exchange);
    res.setHeader("Cache-Control", "no-store");

    if (universe.length < 10) {
      return res.status(503).json({ error: "Рынок ещё загружается. Повторите через несколько секунд." });
    }

    // Pick from the top active liquid coins (ranked by volume & volatility)
    const topPool = universe.slice(0, Math.min(80, universe.length)).sort(() => Math.random() - 0.5);
    let lastError = null;

    // A batch of 3 meant up to 27 strictly sequential round trips before the
    // first usable candidate — seconds of latency on a cold cache for a route
    // that aims at sub-300ms. 8 keeps the burst modest while cutting the worst
    // case to 10 rounds, and the first acceptable candidate still short-circuits.
    const BATCH_SIZE = 8;
    for (let i = 0; i < topPool.length; i += BATCH_SIZE) {
      const batch = topPool.slice(i, i + BATCH_SIZE);
      const fetchPromises = batch.map(ticker =>
        fetchBacktestCandles(ticker.ex, ticker.sym, tf)
          .then(candles => ({ ticker, candles }))
          .catch(err => { lastError = err; return null; })
      );

      const results = await Promise.all(fetchPromises);

      for (const resItem of results) {
        if (!resItem || !resItem.candles || resItem.candles.length < 260) continue;
        const best = findBestBacktestWindow(resItem.candles, tf);
        if (!best || !best.visible || best.visible.length === 0) continue;

        const ticker = resItem.ticker;
        const id = randomUUID();
        backtestSessions.set(id, {
          id,
          createdAt: Date.now(),
          ex: ticker.ex,
          sym: ticker.sym,
          base: ticker.base || ticker.sym.replace(/USDT$/, ""),
          tf,
          future: best.future,
          revealed: 0,
        });

        return res.json({
          id,
          ex: ticker.ex,
          exchange: BACKTEST_EXCHANGES[exchange],
          sym: ticker.sym,
          base: ticker.base || ticker.sym.replace(/USDT$/, ""),
          tf,
          cutoffTime: best.visible[best.visible.length - 1].t,
          candles: best.visible.map(publicBacktestCandle),
          futureCount: best.future.length,
          universeSize: universe.length,
        });
      }
    }

    res.status(503).json({ error: lastError?.message || "Не удалось подобрать активный исторический участок. Попробуйте еще раз." });
  } catch (err) {
    console.error("[BACKTEST NEW]", err && err.message);
    if (!res.headersSent) res.status(503).json({ error: "Не удалось создать сессию бэктеста" });
  }
});

app.post("/api/backtest/:id/step", (req, res) => {
  const session = backtestSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Сессия бэктеста устарела" });
  const requested = Math.max(1, Math.min(200, parseInt(req.query.count, 10) || 1));
  const from = session.revealed;
  const to = Math.min(session.future.length, from + requested);
  session.revealed = to;
  res.setHeader("Cache-Control", "no-store");
  res.json({ candles: session.future.slice(from, to).map(publicBacktestCandle), done: to >= session.future.length, remaining: session.future.length - to });
});

app.post("/api/backtest/:id/reveal", (req, res) => {
  const session = backtestSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Сессия бэктеста устарела" });
  const rest = session.future.slice(session.revealed);
  session.revealed = session.future.length;
  res.setHeader("Cache-Control", "no-store");
  res.json({ candles: rest.map(publicBacktestCandle), done: true, remaining: 0 });
});

app.get("/api/walls", (req, res) => {
  setPublicCors(req, res);
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");
  if (req.query.format === "full" || req.query.format === "object") {
    res.json(currentWallsMeta);
  } else {
    res.json(currentWallsCache);
  }
});

app.get("/api/walls/status", (req, res) => {
  setPublicCors(req, res);
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");
  const { walls: _walls, history: _history, ...status } = currentWallsMeta || {};
  res.json({ ...status, count: currentWallsCache.length });
});

app.get("/api/arbitrage/snapshot", (req, res) => {
  const full = arbitrageEngine.getSnapshot();
  const search = String(req.query.search || "").trim().toUpperCase().slice(0, 32);
  const minNet = Math.max(-1, Math.min(100, Number(req.query.minNet) || 0));
  const minVolume = Math.max(0, Math.min(1e12, Number(req.query.minVolume) || 0));
  const exchanges = new Set(String(req.query.exchanges || "").split(",").filter(Boolean).slice(0, 11));
  const limit = Math.max(25, Math.min(1000, parseInt(req.query.limit, 10) || 500));
  const includesExchange = row => {
    if (!exchanges.size) return true;
    const legs = [row.buyEx || row.longEx, row.sellEx || row.shortEx].filter(Boolean);
    return legs.length === 2 && legs.every(exchange => exchanges.has(exchange));
  };
  const matches = row => (!search || row.base.includes(search) || row.symbol.includes(search)) &&
    row.liquidity >= minVolume && includesExchange(row);
  const spreads = full.spreads.filter(row => matches(row) && row.net >= minNet).slice(0, limit);
  const funding = full.funding.filter(row => matches(row) && row.daily >= minNet).slice(0, limit);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    generatedAt: full.generatedAt,
    exchangeCount: full.exchangeCount,
    exchanges: full.exchanges,
    marketCount: full.groups,
    totals: { spreads: full.spreads.length, funding: full.funding.length },
    spreads,
    funding,
    methodology: {
      spread: "buy ask -> sell bid -> taker fees",
      funding: "hour-normalized funding differential; APR is an estimate, not a guarantee",
      quoteQuality: "bbo means executable best bid/ask; indicative uses the latest midpoint",
    },
  });
});

app.get("/api/arbitrage/history", (req, res) => {
  const key = String(req.query.key || "").slice(0, 160);
  if (!/^(spread|funding):[A-Z0-9_.-]{1,40}:[A-Z0-9]{2}:[A-Z0-9]{2}$/i.test(key)) {
    return res.status(400).json({ error: "Invalid route key" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ key, points: arbitrageEngine.getHistory(key) });
});

app.get("/api/arbitrage/depth", async (req, res) => {
  const key = String(req.query.key || "").slice(0, 160);
  if (!/^spread:[A-Z0-9_.-]{1,40}:[A-Z0-9]{2}:[A-Z0-9]{2}$/i.test(key)) {
    return res.status(400).json({ error: "Invalid spread route key" });
  }
  const notional = Math.max(10, Math.min(1_000_000, Number(req.query.notional) || 500));
  try {
    if (!depthAnalyzer) depthAnalyzer = createDepthAnalyzer(apiFetch, tickers, arbitrageEngine);
    const result = await depthAnalyzer.analyze(key, notional);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: "Order book unavailable", detail: String(error?.message || error).slice(0, 160) });
  }
});

/**
 * `/api/tickers` and `/api/correlations` are polled by every client on connect
 * and on every WS reconnect. Building the response meant walking ~8.5k tickers
 * into a ~93,500-element array, running `JSON.stringify` over it and then
 * gzipping the result at level 6 — all synchronously, on every single request,
 * for a payload whose own `Cache-Control` already declares it stale after 1s.
 *
 * Both are now serialised at most once per second and served from a pre-gzipped
 * buffer, so N concurrent clients cost the same as one.
 */
const SNAPSHOT_CACHE_TTL_MS = 1000;

function makeJsonSnapshotCache(build, ttlMs = SNAPSHOT_CACHE_TTL_MS) {
  let at = 0;
  let raw = null;
  let gzipped = null;
  let etag = "";
  return function get() {
    const now = Date.now();
    if (raw && now - at < ttlMs) return { raw, gzipped, etag };
    raw = Buffer.from(JSON.stringify(build()), "utf8");
    // Level 1 is deliberate here: this is regenerated every second and the
    // payload is highly repetitive numeric text, where l1 gets within a few
    // percent of l6 for a fraction of the CPU.
    gzipped = raw.length >= 2048 ? zlib.gzipSync(raw, { level: 1 }) : null;
    etag = `W/"${raw.length.toString(36)}-${createHash("sha1").update(raw).digest("base64url").slice(0, 16)}"`;
    at = now;
    return { raw, gzipped, etag };
  };
}

function sendCachedJson(req, res, entry, cacheControl) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.vary("Accept-Encoding");
  res.setHeader("ETag", entry.etag);
  if (req.headers["if-none-match"] === entry.etag) return res.status(304).end();
  if (entry.gzipped && String(req.headers["accept-encoding"] || "").includes("gzip")) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", entry.gzipped.length);
    return res.end(entry.gzipped);
  }
  res.setHeader("Content-Length", entry.raw.length);
  return res.end(entry.raw);
}

const getTickersSnapshotJson = makeJsonSnapshotCache(() => {
  const flat = new Array(tickers.size * 11);
  let i = 0;
  for (const t of tickers.values()) {
    flat[i++] = t.key; flat[i++] = t.p; flat[i++] = t.chg; flat[i++] = t.v;
    flat[i++] = t.h; flat[i++] = t.l; flat[i++] = t.o;
    flat[i++] = t.funding || 0; flat[i++] = t.nextFunding || 0;
    flat[i++] = t.oi || 0; flat[i++] = t.trades || 0;
  }
  flat.length = i;
  return flat;
});

const getCorrelationsJson = makeJsonSnapshotCache(
  () => correlationEngine.getCorrelations(),
  2000
);

app.get("/api/tickers", (req, res) => {
  setPublicCors(req, res);
  // `compression` must not try to re-encode an already-gzipped body.
  res.setHeader("X-No-Compression", "1");
  sendCachedJson(req, res, getTickersSnapshotJson(), "private, max-age=1");
});

app.get("/api/correlations", (req, res) => {
  setPublicCors(req, res);
  res.setHeader("X-No-Compression", "1");
  sendCachedJson(req, res, getCorrelationsJson(), "public, max-age=2");
});
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", tickers: tickers.size, clients: clients.size, dirty: dirtyKeys.size, exchanges: Object.fromEntries(exStatus) });
});
app.get("/api/market-data/health", (req, res) => {
  const now = Date.now();
  const subscriptions = Array.from(klineSubs.values()).map(sub => ({
    ex: sub.ex,
    sym: sub.sym,
    tf: sub.tf,
    clients: sub.clients.size,
    connected: sub.ws?.readyState === WebSocket.OPEN,
    eventAgeMs: sub.lastEventAt ? now - sub.lastEventAt : null,
    sourceAgeMs: sub.lastSourceAt ? Math.max(0, now - sub.lastSourceAt) : null,
    reconnects: sub.reconnects,
  }));
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    serverTime: now,
    browserClients: clients.size,
    activeSubscriptions: subscriptions.length,
    subscriptions,
    exchanges: Object.fromEntries(marketFeedStats),
  });
});

app.get("/api/patterns", (req, res) => {
  setPublicCors(req, res);
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");

  let result = [...patternsCache];
  const { tf, type, dir, limit = "100" } = req.query;

  if (tf) {
    const tfs = tf.split(",");
    result = result.filter(p => tfs.includes(p.tf));
  }
  if (type) {
    const types = type.split(",");
    result = result.filter(p => types.includes(p.type));
  }
  if (dir) {
    const dirs = dir.split(",");
    result = result.filter(p => dirs.includes(p.direction));
  }

  const lim = parseInt(limit, 10) || 100;
  res.json(result.slice(0, lim));
});

app.get("/api/kucoin-token", async (req, res) => {
  // Express 4 does not catch rejected async handlers: an unguarded rejection
  // sends nothing at all and the client hangs until `requestTimeout` (30s).
  try {
    const tk = await getKuCoinToken();
    if (tk) res.json(tk);
    else res.status(502).json({ error: "Failed to get token" });
  } catch (err) {
    res.status(502).json({ error: "Failed to get token" });
  }
});

// тФАтФАтФА Traders Journal API Sync тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function getJournalUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  return userStore.getUserByToken(token);
}

function findLinkedJournalCredentials(userId, exchange) {
  // Credentials are private to the authenticated account. IP, role and profile
  // fields are not proof of ownership and must never trigger key migration.
  return journalCredentials.get(userId, exchange);
}

function findLinkedJournalExchanges(userId) {
  return journalCredentials.list(userId);
}

async function runJournalSync(userId, exchangeInput, options = {}) {
  const exchange = journalCredentials.canonicalExchange(exchangeInput);
  if (!exchange) throw Object.assign(new Error("Биржа не поддерживается"), { statusCode: 400 });
  const credentials = options.credentials || findLinkedJournalCredentials(userId, exchange);
  if (!credentials) throw Object.assign(new Error("API-ключи для биржи не подключены"), { statusCode: 404 });
  const cacheKey = `${userId}:${exchange}`;
  const current = journalSyncCache.get(cacheKey);
  const maxAge = typeof options.maxAge === "number" ? options.maxAge : 8000;
  if (!options.force && current?.result && Date.now() - current.at < maxAge) return current.result;
  if (!options.force && current?.pending) return current.pending;
  const pending = syncJournal({ exchange, ...credentials, fast: !!options.fast }).then(result => {
    journalSyncCache.set(cacheKey, { at: Date.now(), result });
    return result;
  }).catch(error => {
    journalSyncCache.delete(cacheKey);
    throw error;
  });
  journalSyncCache.set(cacheKey, { at: current?.at || 0, result: current?.result, pending });
  return pending;
}

function journalPayload(result, symbol = "") {
  const normalizedSymbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const items = normalizedSymbol ? result.items.filter(item => String(item.symbol).replace(/[^A-Z0-9]/g, "") === normalizedSymbol) : result.items;
  return { success: true, count: result.trades.length, executionCount: result.executions, executions: items.slice(-600), trades: result.trades, syncedAt: Date.now() };
}

app.get("/api/journal/credentials", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = getJournalUser(req);
  if (!user) return res.status(401).json({ error: "Необходима авторизация" });
  return res.json({ success: true, ownerId: user.id, exchanges: findLinkedJournalExchanges(user.id) });
});

app.put("/api/journal/credentials/:exchange", express.json(), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = getJournalUser(req);
  if (!user) return res.status(401).json({ error: "Необходима авторизация" });
  const exchange = journalCredentials.canonicalExchange(req.params.exchange);
  const credentials = { apiKey: String(req.body?.apiKey || "").trim(), apiSecret: String(req.body?.apiSecret || "").trim(), passphrase: String(req.body?.passphrase || "").trim() };
  if (!exchange || !credentials.apiKey || !credentials.apiSecret || credentials.apiKey.length > 256 || credentials.apiSecret.length > 256 || credentials.passphrase.length > 256) return res.status(400).json({ error: "Некорректные API-ключи" });
  try {
    const result = await runJournalSync(user.id, exchange, { credentials, force: true });
    const credential = journalCredentials.save(user.id, exchange, credentials);
    journalSyncCache.set(`${user.id}:${exchange}`, { at: Date.now(), result });
    return res.json({ ...journalPayload(result), credential });
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: String(error.message || "Ошибка проверки API-ключей").slice(0, 300) });
  }
});

app.delete("/api/journal/credentials/:exchange", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = getJournalUser(req);
  if (!user) return res.status(401).json({ error: "Необходима авторизация" });
  const exchange = journalCredentials.canonicalExchange(req.params.exchange);
  if (!exchange) return res.status(400).json({ error: "Биржа не поддерживается" });
  journalSyncCache.delete(`${user.id}:${exchange}`);
  return res.json({ success: true, removed: journalCredentials.remove(user.id, exchange) });
});

app.get("/api/journal/live", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = getJournalUser(req);
  if (!user) return res.status(401).json({ error: "Необходима авторизация" });
  const exchange = journalCredentials.canonicalExchange(req.query.exchange);
  if (!exchange) return res.status(400).json({ error: "Биржа не поддерживается" });
  try {
    return res.json(journalPayload(await runJournalSync(user.id, exchange, { maxAge: 2500, fast: true }), req.query.symbol));
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: String(error.message || "Ошибка синхронизации").slice(0, 300) });
  }
});

app.post("/api/journal/sync", express.json(), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { exchange, apiKey, apiSecret, passphrase } = req.body || {};

  const journalUser = getJournalUser(req);
  if (!journalUser) return res.status(401).json({ error: "Необходима авторизация" });
  const storedExchange = journalCredentials.canonicalExchange(exchange);
  if (!storedExchange) return res.status(400).json({ error: "Биржа не поддерживается" });
  try {
    if (apiKey || apiSecret) {
      const suppliedCredentials = { apiKey, apiSecret, passphrase: passphrase || "" };
      const suppliedResult = await runJournalSync(journalUser.id, storedExchange, { credentials: suppliedCredentials, force: true });
      journalCredentials.save(journalUser.id, storedExchange, suppliedCredentials);
      journalSyncCache.set(`${journalUser.id}:${storedExchange}`, { at: Date.now(), result: suppliedResult });
      return res.json(journalPayload(suppliedResult));
    }
    return res.json(journalPayload(await runJournalSync(journalUser.id, storedExchange)));
  } catch (error) {
    return res.status(error.statusCode || 502).json({ error: String(error.message || "Ошибка синхронизации").slice(0, 300) });
  }
  // NOTE: ~160 lines of unreachable code used to follow this point — a second,
  // older implementation that signed Bybit/Binance/OKX requests inline. Every
  // path above returns, so it could never execute. It also fabricated PnL values
  // (`execPrice * 1.02`, hardcoded `+25`/`-15`, `pnlPercent: 2.15`) which must
  // never come back. The real implementation is journalSync.js + runJournalSync.
});

// ─── High-Capacity Background Pre-Fetcher Engine ─────────────────────────────
// `await` inside `setInterval` with no guard: `fetchFullHistory` does up to 3
// paged requests per ticker and the loop sleeps 200 ms between the 10 tickers, so
// a slow venue could easily exceed the 60s period and overlap with itself.
let prefetchRunning = false;
setInterval(async () => {
  if (prefetchRunning || tickers.size === 0) return;
  prefetchRunning = true;
  try {
    const topTickers = Array.from(tickers.values())
      .sort((a, b) => (b.v || 0) - (a.v || 0))
      .slice(0, 10);

    for (const t of topTickers) {
      const key = cacheKey(t.ex, t.sym, "1m", false);
      if (klinesCache.has(key)) continue;
      try {
        const candles = await fetchFullHistory(t.ex, t.sym, "1m", false);
        if (candles && candles.length) {
          const flat = encodeFlatCandles(candles);
          klinesCache.set(key, { at: Date.now(), used: Date.now(), data: flat });
          pruneKlinesCache();
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 200));
    }
  } finally {
    prefetchRunning = false;
  }
}, 60000).unref();

function constantTimeSecretEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdminApi(req, res, next) {
  const configuredSecret = String(process.env.ADMIN_API_SECRET || "");
  const suppliedSecret = String(req.headers["x-admin-secret"] || "");
  if (configuredSecret.length < 32) {
    return res.status(503).json({ error: "Admin API is not configured" });
  }
  if (!constantTimeSecretEqual(configuredSecret, suppliedSecret)) {
    return res.status(403).json({ error: "Доступ запрещён" });
  }
  next();
}

const loginIpLimit = createSlidingWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  key: req => req.ip
});
const loginIdentityLimit = createSlidingWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: req => String(req.body && req.body.emailOrUsername || "").trim().toLowerCase()
});
const registrationLimit = createSlidingWindowLimiter({
  windowMs: 60 * 60 * 1000,
  max: 8,
  key: req => req.ip
});
const telegramAuthLimit = createSlidingWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  key: req => req.ip
});

// ── Authentication Endpoints ──
// `registerUser`/`loginUser` are async because scrypt runs on the threadpool
// instead of blocking the event loop. Express 4 does not catch rejected async
// handlers (the client would hang until requestTimeout), so both are wrapped.
app.post("/api/auth/register", registrationLimit, async (req, res) => {
  try {
    const result = await userStore.registerUser({ ...(req.body || {}), ip: req.ip });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", loginIpLimit, loginIdentityLimit, async (req, res) => {
  try {
    const result = await userStore.loginUser({ ...(req.body || {}), ip: req.ip });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/telegram", telegramAuthLimit, (req, res) => {
  try {
    const tgData = req.body || {};
    if (!telegramBot.verifyTelegramAuth(tgData)) {
      return res.status(400).json({ error: "Подпись Telegram не прошла проверку подлинности" });
    }
    const result = userStore.telegramAuth(tgData, null, req.ip);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/auth/logs", requireAdminApi, (req, res) => {
  res.json({ success: true, logs: userStore.getAuditLogs() });
});

app.post("/api/auth/telegram-verify", telegramAuthLimit, (req, res) => {
  try {
    const tgData = req.body || {};
    const isValid = telegramBot.verifyTelegramAuth(tgData);
    if (!isValid) {
      return res.status(400).json({ error: "Подпись Telegram не прошла проверку подлинности" });
    }
    const result = userStore.telegramAuth(tgData);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/telegram-start", telegramAuthLimit, (req, res) => {
  try {
    const regToken = telegramBot.createRegToken();
    const botUrl = `https://t.me/${telegramBot.BOT_USERNAME}?start=${regToken}`;
    res.json({ success: true, regToken, botUrl, botUsername: telegramBot.BOT_USERNAME });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/auth/telegram-poll", (req, res) => {
  const token = req.query.token;
  const statusInfo = telegramBot.getRegTokenStatus(token);
  res.json(statusInfo);
});

app.post("/api/auth/telegram-link-token", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const linkToken = telegramBot.createLinkToken(user.id);
  const botUrl = `https://t.me/${telegramBot.BOT_USERNAME}?start=${linkToken}`;
  res.json({ success: true, linkToken, botUrl, botUsername: telegramBot.BOT_USERNAME });
});

app.get("/api/auth/me", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const user = userStore.getUserByToken(token, { ip: clientIp });
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  res.json({ success: true, user });
});

// Real-time client activity heartbeat
app.all("/api/user/heartbeat", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || (req.body && req.body.token) || (req.query && req.query.token);
  const clientIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (token) {
    const user = userStore.getUserByToken(token, { ip: clientIp });
    if (user) {
      return res.json({ success: true, online: true, userId: user.id });
    }
  }
  res.json({ success: true, online: false });
});

app.get("/api/notifications/unread", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.json({ success: true, notifications: [] });
  }
  const notifs = Array.isArray(user.notifications) ? user.notifications.filter(n => !n.read) : [];
  res.json({ success: true, notifications: notifs });
});

app.post("/api/notifications/mark-read", express.json(), (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.json({ success: true });
  }
  const { notificationId } = req.body || {};
  if (notificationId && typeof userStore.markNotificationRead === "function") {
    userStore.markNotificationRead(user.id, notificationId);
  }
  res.json({ success: true });
});

app.post("/api/auth/update-profile", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  try {
    const updated = userStore.updateProfile(user.id, req.body || {});
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/user/preferences", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const preferences = userStore.getUserPreferences(user.id) || {};
  res.json({ success: true, preferences });
});

app.post("/api/user/preferences", express.json({ limit: "5mb" }), (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const { preferences } = req.body || {};
  if (!preferences || typeof preferences !== "object") {
    return res.status(400).json({ error: "Некорректные параметры preferences" });
  }
  const updated = userStore.updateUserPreferences(user.id, preferences);
  res.json({ success: true, preferences: updated });
});

app.get("/api/user/formation-alerts", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const preferences = userStore.getUserPreferences(user.id) || {};
  res.json({ success: true, settings: preferences.formationAlerts || null });
});

app.get("/api/orchestrator/status", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const memUsage = process.memoryUsage();
  res.json({
    success: true,
    server: {
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      memory: {
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024)
      },
      tickersCount: tickers.size,
      connectedWsClients: clients.size,
      exchangesCount: Object.keys(exStatus).length
    }
  });
});

/**
 * Formation-alert subscriber registry keyed by Telegram chat id.
 *
 * This used to be `global._formationAlertsByChatId`, an unbounded Map that
 * `POST /api/user/formation-alerts` wrote to **without any authentication** —
 * any anonymous caller could insert an arbitrary chat id with an arbitrary
 * settings object and have it treated as a live alert subscriber by the dispatch
 * loop. That was both an unbounded memory-growth vector and an alert-injection
 * path. Writes now require either a valid session token or a chat id that is
 * already linked to a real account, and the map is size-bounded either way.
 */
const FORMATION_CHAT_PREFS_MAX = 5000;
const formationAlertsByChatId = new Map(); // chatId -> { settings, at }
// Kept for backwards compatibility with anything still reading the global.
global._formationAlertsByChatId = formationAlertsByChatId;

function setFormationChatPrefs(chatId, settings) {
  if (!chatId) return;
  if (!formationAlertsByChatId.has(chatId) && formationAlertsByChatId.size >= FORMATION_CHAT_PREFS_MAX) {
    // Drop the least recently written entry instead of growing without bound.
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of formationAlertsByChatId) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }
    if (oldestKey !== null) formationAlertsByChatId.delete(oldestKey);
  }
  formationAlertsByChatId.set(chatId, { settings, at: Date.now() });
}

function getFormationChatPrefs(chatId) {
  const entry = chatId ? formationAlertsByChatId.get(chatId) : null;
  return entry ? entry.settings : null;
}

app.post("/api/user/formation-alerts", formationAlertsBodyParser, (req, res) => {
  setPublicCors(req, res);
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const settings = req.body || {};
  const tgId = String(settings.telegramChatId || settings.tgChatId || settings.chatId || "").trim();

  let user = token ? userStore.getUserByToken(token) : null;
  if (!user && tgId && typeof userStore.getAllUsersRaw === "function") {
    const all = userStore.getAllUsersRaw() || {};
    for (const id in all) {
      const u = all[id];
      if (u && (String(u.telegramChatId) === tgId || String(u.telegramId) === tgId)) {
        user = u;
        break;
      }
    }
  }

  if (user) {
    if (tgId) {
      // Must go through userStore: `user` may be a sanitized copy whose fields
      // are never persisted.
      userStore.setTelegramChatId(user.id, tgId);
    }
    const currentPrefs = userStore.getUserPreferences(user.id) || {};
    currentPrefs.formationAlerts = settings;
    const updated = userStore.updateUserPreferences(user.id, currentPrefs);
    if (tgId) setFormationChatPrefs(tgId, settings);
    return res.json({ success: true, preferences: updated });
  }

  // No session and no account owns this chat id: refuse instead of silently
  // registering an unauthenticated alert subscriber.
  return res.status(401).json({
    error: "Требуется авторизация или привязанный Telegram-аккаунт"
  });
});

app.get("/api/user/pump-alerts", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const preferences = userStore.getUserPreferences(user.id) || {};
  res.json({ success: true, settings: preferences.pumpAlerts || null });
});

app.post("/api/user/pump-alerts", express.json({ limit: "5mb" }), (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const settings = req.body || {};
  const currentPrefs = userStore.getUserPreferences(user.id) || {};
  currentPrefs.pumpAlerts = settings;
  if (!currentPrefs.notifications) currentPrefs.notifications = {};
  currentPrefs.notifications.pumpDump = {
    ...(currentPrefs.notifications.pumpDump || {}),
    ...settings
  };
  if (settings.tgEnabled !== undefined) {
    currentPrefs.notifications.tgEnabled = !!settings.tgEnabled;
  }
  const updated = userStore.updateUserPreferences(user.id, currentPrefs);
  console.log(`[USER PREFS] Updated pumpAlerts for user ${user.id}:`, JSON.stringify(settings));
  res.json({ success: true, preferences: updated });
});

// ── 24/7 Offline Notification Settings & Price Alerts API ──
app.get("/api/user/notification-settings", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const preferences = userStore.getUserPreferences(user.id) || {};
  // `alertEngine` is `null` when its module failed to load (that failure is
  // explicitly tolerated at require time), so it must be guarded like every other
  // consumer in this file.
  const notifications = preferences.notifications
    || (alertEngine && alertEngine.DEFAULT_USER_ALERT_SETTINGS)
    || {};
  res.json({
    success: true,
    settings: {
      ...notifications,
      telegramChatId: user.telegramChatId || user.telegramId || notifications.telegramChatId || ""
    }
  });
});

app.post("/api/user/notification-settings", express.json({ limit: "2mb" }), (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const incoming = req.body || {};
  const preferences = userStore.getUserPreferences(user.id) || {};
  preferences.notifications = {
    ...(preferences.notifications || {}),
    ...incoming
  };
  if (incoming.pumpDump) {
    preferences.pumpAlerts = {
      ...(preferences.pumpAlerts || {}),
      ...incoming.pumpDump
    };
  } else if (incoming.pumpAlerts) {
    preferences.pumpAlerts = {
      ...(preferences.pumpAlerts || {}),
      ...incoming.pumpAlerts
    };
  }

  if (incoming.telegramChatId && String(incoming.telegramChatId).trim()) {
    userStore.setTelegramChatId(user.id, String(incoming.telegramChatId).trim());
  }

  const updated = userStore.updateUserPreferences(user.id, preferences);
  res.json({ success: true, settings: preferences.notifications });
});

app.get("/api/user/price-alerts", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const prefs = userStore.getUserPreferences(user.id) || {};
  const alerts = Array.isArray(user.priceAlerts)
    ? user.priceAlerts
    : (Array.isArray(prefs.priceAlerts) ? prefs.priceAlerts : []);
  res.json({ success: true, alerts });
});

app.post("/api/user/price-alerts", express.json({ limit: "5mb" }), (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const { alerts } = req.body || {};
  let count = Array.isArray(user.priceAlerts) ? user.priceAlerts.length : 0;
  if (Array.isArray(alerts)) {
    // Persist on the real record, not on the sanitized copy.
    userStore.setUserPriceAlerts(user.id, alerts);
    const preferences = userStore.getUserPreferences(user.id) || {};
    preferences.priceAlerts = alerts;
    userStore.updateUserPreferences(user.id, preferences);
    count = alerts.length;
  }
  res.json({ success: true, count });
});


// ─── High-Speed Market Pump / Dump Scanner Engine ───────────────────────────
// Shares alertEngine's compact typed-array history instead of keeping a second
// object-per-sample ring buffer. The duplicate store was the other half of the
// memory growth that made the orchestrator recycle this process (and wipe every
// in-memory alert cooldown) several times an hour.
const tickerPriceRing = priceHistoryStore.sharedStore;
const RING_KEY_TTL_MS = 60 * 60 * 1000;
let lastRingPruneAt = 0;

// The store only retains one sample per 30s (`RESOLUTION_MS`), so sampling at
// 1 Hz threw away 29 of every 30 passes while still doing a Map lookup per
// ticker — ~8.5k lookups/second of pure waste. 5s keeps every stored sample
// within 5s of its ideal timestamp at a fifth of the cost.
setInterval(() => {
  const now = Date.now();
  for (const [key, t] of tickers.entries()) {
    if (!t || !t.p || t.p <= 0) continue;
    tickerPriceRing.push(key, now, t.p);
  }

  if (now - lastRingPruneAt > 10 * 60 * 1000) {
    lastRingPruneAt = now;
    tickerPriceRing.pruneStale(now, RING_KEY_TTL_MS);
  }
}, 5000).unref?.();

/**
 * Every connected client polls this every 2 seconds, and most of them poll with
 * the identical default parameters. The scan itself is O(tickers · log samples)
 * after the binary-search change in priceHistoryStore, but there is no reason to
 * repeat it per client — results are cached for one second per parameter tuple.
 */
const PUMP_ALERT_CACHE_TTL_MS = 1000;
const PUMP_ALERT_CACHE_MAX = 64;
const pumpAlertCache = new Map(); // paramKey -> { at, payload }

app.get("/api/market/pump-alerts", (req, res) => {
  setPublicCors(req, res);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  const periodMinutes = Math.max(1, parseFloat(req.query.period) || 5);
  const minPct = Math.max(0.1, parseFloat(req.query.minPct) || 1.0);
  const direction = (req.query.dir || req.query.direction || "both").toLowerCase();
  const marketType = (req.query.marketType || req.query.mt || "both").toLowerCase();
  const rawExchanges = req.query.ex || req.query.exchanges || "";
  const allowedEx = rawExchanges ? rawExchanges.split(",").map(e => e.trim().toUpperCase()).filter(Boolean) : null;
  const isAllEx = !allowedEx || allowedEx.length === 0 || allowedEx.includes("ALL");
  const minVol = parseFloat(req.query.minVol) || 0;
  const now = Date.now();

  const cacheKey = `${periodMinutes}|${minPct}|${direction}|${marketType}|${isAllEx ? "*" : allowedEx.join(",")}|${minVol}`;
  const hit = pumpAlertCache.get(cacheKey);
  if (hit && now - hit.at < PUMP_ALERT_CACHE_TTL_MS) {
    return res.json(hit.payload);
  }

  const allowedExSet = isAllEx ? null : new Set(allowedEx);
  const lookbackMs = periodMinutes * 60 * 1000;
  const targetTs = now - lookbackMs;
  const maxDiffMs = Math.max(lookbackMs * 0.7, 45000);
  const maxDrop = periodMinutes <= 1 ? 35 : periodMinutes <= 5 ? 50 : 75;
  const wantPump = direction !== "dump";
  const wantDump = direction !== "pump";

  const alerts = [];

  for (const [key, t] of tickers.entries()) {
    if (!t || !t.p || t.p <= 0) continue;
    const colon = key.indexOf(":");
    const ex = t.ex || (colon > 0 ? key.slice(0, colon) : "");
    // Cheapest filters first: exchange and volume reject most rows without
    // touching the history store.
    if (allowedExSet && !allowedExSet.has(ex)) continue;
    if (minVol > 0 && t.v && t.v < minVol) continue;
    if ((t.v || 0) < (minVol > 0 ? minVol : 25000)) continue; // Filter dead illiquid pairs (<$25K) under all conditions

    const sym = t.sym || (colon > 0 ? key.slice(colon + 1) : key);

    // Spot vs futures. `_SPOT` is the marker wallScanner appends to the spot
    // pseudo-tickers it injects; every other key in the map is a futures
    // instrument.
    //
    // The previous test OR-ed `!sym.endsWith("_SPOT")` into `isFutures`, which
    // made the expression true for *every* symbol — so "futures only" never
    // filtered anything and spot pairs kept appearing in pump/dump results.
    if (marketType !== "both") {
      const isSpot = /_SPOT$/i.test(sym) || /_SPOT$/i.test(key);
      if (marketType === "futures" && isSpot) continue;
      if (marketType === "spot" && !isSpot) continue;
    }

    let pastPrice = 0;
    const nearest = tickerPriceRing.findNearest(key, targetTs);
    // Require the historical sample to be reasonably close to the target timeframe
    if (nearest && nearest.p > 0 && nearest.diffMs <= maxDiffMs) {
      pastPrice = nearest.p;
    } else if (t.o > 0 && periodMinutes >= 60) {
      pastPrice = t.o;
    }

    if (!(pastPrice > 0)) continue;

    const changePct = ((t.p - pastPrice) / pastPrice) * 100;
    const absPct = changePct < 0 ? -changePct : changePct;

    // Anomaly / Glitch Filter: Reject physical impossibilities (e.g. -100% dump on live coins or > 250% 1m spike)
    if (changePct <= -maxDrop || changePct >= 250 || absPct < minPct || !Number.isFinite(changePct)) continue;
    if (changePct > 0 ? !wantPump : !wantDump) continue;

    alerts.push({
      key,
      ex,
      sym,
      pct: Math.round(changePct * 100) / 100,
      price: t.p,
      vol: t.v || 0,
      bars: periodMinutes,
      ts: now
    });
  }

  // Only the top 100 are returned, so a full sort of every match is wasted work
  // once the match count is large. `sort` on the slice boundary is still the
  // simplest correct approach and the array is now much smaller than the ticker
  // count, so keep it — but sort by the precomputed magnitude.
  alerts.sort((a, b) => (b.pct < 0 ? -b.pct : b.pct) - (a.pct < 0 ? -a.pct : a.pct));

  const payload = {
    success: true,
    count: alerts.length,
    periodMinutes,
    minPct,
    alerts: alerts.slice(0, 100)
  };

  if (pumpAlertCache.size >= PUMP_ALERT_CACHE_MAX) {
    // Simple bound: drop the oldest entry.
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of pumpAlertCache) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }
    if (oldestKey !== null) pumpAlertCache.delete(oldestKey);
  }
  pumpAlertCache.set(cacheKey, { at: now, payload });

  res.json(payload);
});


app.post("/api/user/set-plan", requireAdminApi, (req, res) => {
  const { userId, plan } = req.body || {};
  if (!userId || !plan) {
    return res.status(400).json({ error: "Необходимы параметры userId и plan" });
  }
  const updated = userStore.setUserPlan(userId, plan);
  if (!updated) {
    return res.status(404).json({ error: "Пользователь не найден" });
  }
  res.json({ success: true, user: updated });
});

app.post("/api/bug-report", express.json({
  limit: "15mb",
  verify(req, _res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}), async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    let user = userStore.getUserByToken(token);

    if (!user && req.body && req.body.userId) {
      user = userStore.getUserById ? userStore.getUserById(req.body.userId) : null;
    }

    if (!user) {
      user = {
        id: "GUEST_" + Math.random().toString(36).slice(2, 7).toUpperCase(),
        username: "Гость",
        email: "—",
        authMethod: "Гость (Без аккаунта)",
        plan: "free"
      };
    }

    const { description, image } = req.body || {};
    const cleanDesc = String(description || "").trim();
    if (!cleanDesc || cleanDesc.length < 3) {
      return res.status(400).json({ error: "Пожалуйста, опишите проблему (минимум 3 символа)" });
    }

    const reportId = "bug_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    const reportData = {
      id: reportId,
      userId: user.id,
      username: user.username || "Трейдер",
      telegramId: user.telegramId || null,
      authMethod: user.authMethod || "Логин/Пароль",
      email: user.email || "—",
      plan: user.plan || "free",
      description: cleanDesc,
      image: image || null,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    let adminBotModule = typeof adminBot !== "undefined" ? adminBot : null;
    if (!adminBotModule) {
      try { adminBotModule = require("./adminBot"); } catch (_) {}
    }

    if (adminBotModule && typeof adminBotModule.notifyBugReport === "function") {
      await adminBotModule.notifyBugReport(reportData);
    }

    res.json({ success: true, message: "Ваш баг-репорт успешно отправлен!" });
  } catch (err) {
    console.error("[BUG REPORT API ERROR]", err);
    res.status(500).json({ error: "Ошибка при отправке баг-репорта: " + err.message });
  }
});

function sendTextMessage(token, chatId, text, res, disableHtmlRetry = false) {
  const postData = JSON.stringify({
    chat_id: String(chatId),
    text: String(text),
    parse_mode: disableHtmlRetry ? undefined : "HTML",
    disable_web_page_preview: true
  });

  const options = {
    hostname: "api.telegram.org",
    port: 443,
    path: `/bot${token}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData)
    },
    // Without this a stalled Telegram socket held the Express response open
    // until `server.requestTimeout` (30 s).
    timeout: 10000
  };

  let settled = false;
  const finish = (fn) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const reqTg = https.request(options, (resTg) => {
    let body = "";
    resTg.on("data", (chunk) => body += chunk);
    resTg.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.ok) {
          console.log(`[TELEGRAM ALERT SENT] Chat: ${chatId}`);
          return finish(() => res.json({ success: true, chatId, messageId: parsed.result?.message_id }));
        }
        // If HTML parsing failed, retry once as plain text
        if (!disableHtmlRetry && parsed.description && /parse entities|can't parse/i.test(parsed.description)) {
          const plain = text.replace(/<[^>]*>/g, "");
          settled = true; // the retry owns the response from here
          return sendTextMessage(token, chatId, plain, res, true);
        }
        console.warn(`[TELEGRAM ALERT FAIL] Chat: ${chatId}, Error: ${parsed.description}`);
        return finish(() => res.status(400).json({ error: parsed.description || "Telegram API error", chatId }));
      } catch (_) {
        return finish(() => res.status(500).json({ error: "Failed to parse Telegram response" }));
      }
    });
  });

  reqTg.on("timeout", () => {
    reqTg.destroy(new Error("Telegram request timed out"));
  });

  reqTg.on("error", (err) => {
    console.error("[TELEGRAM ALERT ERROR]", err.message);
    finish(() => res.status(504).json({ error: err.message }));
  });

  reqTg.write(postData);
  reqTg.end();
}

function resolveTelegramTargetChatId(req) {
  const bodyChatId = req.body && req.body.chatId ? String(req.body.chatId).trim() : "";
  if (bodyChatId) return bodyChatId;

  const authHeader = req.headers && req.headers.authorization ? req.headers.authorization : "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (bearerToken && typeof userStore.getUserByToken === "function") {
    const user = userStore.getUserByToken(bearerToken);
    if (user && (user.telegramChatId || user.telegramId || user.tgChatId || user.chatId)) {
      return String(user.telegramChatId || user.telegramId || user.tgChatId || user.chatId).trim();
    }
  }

  // No explicit target and no authenticated caller: refuse rather than guess.
  // Falling back to "the first user that has a Telegram id" delivered one
  // person's alerts into an unrelated stranger's chat and let unauthenticated
  // callers push arbitrary HTML through the bot.
  return "";
}

app.post("/api/notifications/telegram", express.json(), (req, res) => {
  setPublicCors(req, res);
  const { message, botToken } = req.body || {};
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN;
  const targetChatId = resolveTelegramTargetChatId(req);

  if (!token) return res.status(400).json({ error: "Telegram bot token is not configured on server" });
  if (!targetChatId) return res.status(400).json({ error: "Chat ID не указан. Подключите бота или введите ваш Telegram Chat ID" });
  if (!message) return res.status(400).json({ error: "Message is required" });

  if (typeof userStore.isTelegramAlertsEnabled === "function" && !userStore.isTelegramAlertsEnabled(targetChatId)) {
    return res.json({ success: false, disabled: true, reason: "Alerts muted in Telegram bot" });
  }

  return sendTextMessage(token, targetChatId, message, res);
});

app.post("/api/notifications/telegram-photo", express.json({ limit: "15mb" }), async (req, res) => {
  setPublicCors(req, res);
  const { caption, photoDataUrl, botToken } = req.body || {};
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN;
  const targetChatId = resolveTelegramTargetChatId(req);

  if (!token) return res.status(400).json({ error: "Telegram bot token is not configured on server" });
  if (!targetChatId) return res.status(400).json({ error: "Chat ID не указан. Подключите бота или введите ваш Telegram Chat ID" });
  if (!caption) return res.status(400).json({ error: "Caption is required" });

  if (typeof userStore.isTelegramAlertsEnabled === "function" && !userStore.isTelegramAlertsEnabled(targetChatId)) {
    return res.json({ success: false, disabled: true, reason: "Alerts muted in Telegram bot" });
  }

  if (!photoDataUrl || typeof photoDataUrl !== "string" || !photoDataUrl.includes(";base64,")) {
    return sendTextMessage(token, targetChatId, caption, res);
  }

  try {
    const parts = photoDataUrl.split(";base64,");
    if (parts.length !== 2) {
      return sendTextMessage(token, targetChatId, caption, res);
    }

    const mimeMatch = parts[0].match(/data:(image\/\w+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
    const ext = mimeType.includes("png") ? "png" : "jpg";

    const imgBuffer = Buffer.from(parts[1].trim(), "base64");
    const blob = new Blob([imgBuffer], { type: mimeType });

    const form = new FormData();
    form.append("chat_id", String(targetChatId));
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    form.append("photo", blob, `chart_alert.${ext}`);

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
      // A 15 MB upload with no timeout could hold the response for 30 s.
      signal: AbortSignal.timeout(15000)
    });

    const parsed = await tgRes.json();
    if (parsed.ok) {
      console.log(`[TELEGRAM PHOTO SENT] Chat: ${targetChatId}`);
      return res.json({ success: true, chatId: targetChatId, messageId: parsed.result?.message_id });
    }

    console.warn(`[TELEGRAM PHOTO FAIL] Chat: ${targetChatId}, Error: ${parsed.description}`);
    return sendTextMessage(token, targetChatId, caption, res);
  } catch (err) {
    console.error("[TELEGRAM PHOTO EXCEPTION]", err.message);
    return sendTextMessage(token, targetChatId, caption, res);
  }
});

// Payment routes must be registered before the static catch-all route.
registerPaymentRoutes(app, { userStore, paymentGateway });

// Formation data is consumed by the screener, so this API route must be
// registered before the SPA catch-all below.
//
// It used to mount its own `compression()` instance. The inner instance wins the
// race to set `Content-Encoding`, and it carries library defaults (level -1,
// threshold 1024) — so this route silently opted out of the tuned global options
// while doing all the same work. The global middleware already covers it.
app.get("/api/formations/map", (req, res) => {
  setPublicCors(req, res);
  res.setHeader("Cache-Control", "public, max-age=3");
  const tf = String(req.query.tf || "15m");
  const type = String(req.query.type || "cascades");

  if (cachedFormationMaps[type] && cachedFormationMaps[type][tf] && Object.keys(cachedFormationMaps[type][tf]).length > 0) {
    return res.json(cachedFormationMaps[type][tf]);
  }
  if (type === "breakout" && cachedFormationMaps.levels && cachedFormationMaps.levels[tf]) {
    return res.json(cachedFormationMaps.levels[tf]);
  }
  if (type === "levels" && cachedFormationMaps.levels && cachedFormationMaps.levels[tf]) {
    return res.json(cachedFormationMaps.levels[tf]);
  }
  if (type === "cascades" && cachedTfMaps[tf]) {
    return res.json(cachedTfMaps[tf]);
  }

  const map = Object.create(null);
  const maxSignalAge = 30 * 60 * 1000;
  const now = Date.now();
  for (const signal of patternsCache) {
    if (!signal || signal.tf !== tf || signal.type !== type) continue;
    if (signal.ts && (now - signal.ts > maxSignalAge)) continue;
    const key = `${signal.ex}:${signal.sym}`;
    if (!map[key]) map[key] = [];
    if (map[key].length >= 8) continue;
    const meta = signal.meta || {};

    if (type === "trendline" && Number.isFinite(meta.p1Idx) && Number.isFinite(meta.p2Idx)) {
      map[key].push({
        p1: { idx: meta.p1Idx, price: meta.p1Price },
        p2: { idx: meta.p2Idx, price: meta.p2Price },
        slope: Number(meta.p2Price - meta.p1Price) / Math.max(1, meta.p2Idx - meta.p1Idx),
        endPrice: signal.price,
        direction: signal.direction === "long" ? "down" : "up",
        touches: meta.touches || 2,
        swingIndices: [meta.p1Idx, meta.p2Idx],
        isTrendline: true,
      });
    } else {
      map[key].push({
        price: signal.price,
        endPrice: signal.price,
        swingIdx: Number.isFinite(meta.barIdx) ? meta.barIdx : 0,
        touchIdx: Number.isFinite(meta.retestBar) ? meta.retestBar : undefined,
        direction: signal.direction === "long" ? "up" : "down",
        touches: meta.touches || 1,
        isRetest: type === "retest",
        outcome: meta.status || "confirmed",
      });
    }
  }
  res.json(map);
});

// ── Pre-compressed static assets (compress once, serve from memory) ──
// Brotli beats gzip on this codebase and every current browser accepts it; both
// encodings are kept so old clients still get a compressed response.
//
// Quality is 9, not 11: measured on the real assets, q11 saves 23% over gzip but
// costs 5.3s of startup, while q9 saves 15% for 0.36s. Startup latency matters
// more here because the process is recycled regularly. The remaining files are
// compressed lazily in the background right after boot.
const staticCache = new Map();
const BROTLI_QUALITY = 9;
const BROTLI_TEXT_EXT = new Set([".js", ".css", ".html", ".svg", ".json"]);
// woff2 and png are already deflate/brotli-compressed internally; re-compressing
// them wastes CPU for <1%. They are still cached in memory to skip the fs hit.
const NO_RECOMPRESS_EXT = new Set([".woff2", ".png", ".ico", ".jpg", ".jpeg", ".webp", ".avif", ".gz", ".br"]);

function brotliOf(raw) {
  return zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
    }
  });
}

const STATIC_MIME_TYPES = {
  ".js": "application/javascript; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".html": "text/html; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=UTF-8",
  ".webmanifest": "application/manifest+json; charset=UTF-8",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".txt": "text/plain; charset=UTF-8",
  ".map": "application/json; charset=UTF-8"
};

function preCompressStatic(relPath, withBrotli = true) {
  try {
    const absPath = path.join(__dirname, "public", relPath);
    // Stat *before* reading: if the file changes between the two calls the entry
    // keeps the older stamp, so the next revalidation re-reads it. Statting
    // afterwards would pin new metadata onto old bytes and lose the edit.
    const stamp = fs.statSync(absPath);
    const raw = fs.readFileSync(absPath);
    const ext = path.extname(relPath).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || "application/octet-stream";
    const compressible = BROTLI_TEXT_EXT.has(ext) && !NO_RECOMPRESS_EXT.has(ext);
    const gzipped = compressible ? zlib.gzipSync(raw, { level: 9 }) : null;
    const brotli = (withBrotli && compressible) ? brotliOf(raw) : null;
    // Content-derived ETag: a restart no longer busts every browser cache.
    const etag = `"${createHash("sha1").update(raw).digest("base64url").slice(0, 20)}"`;
    staticCache.set(relPath, {
      raw, gzipped, brotli, contentType, etag, compressible,
      mtimeMs: stamp.mtimeMs, size: stamp.size, checkedAt: Date.now(),
    });
  } catch (_) {}
}

// The cache above is filled once, at boot. Nothing invalidated it, so every edit
// to public/js/app.js, public/css/app.css or public/index.html stayed invisible
// until the process was restarted — the server kept answering with the bytes it
// had read at startup, under the *current* `?v=` URL. Versioned URLs are served
// `immutable` for a year, so a browser that fetched pre-edit bytes under a
// post-edit version string pinned the stale file for a year and no restart could
// dislodge it. That is how a working density engine ends up drawing an empty map.
//
// Re-stat an asset at most once a second and re-read it when it moved. One
// syscall per asset per second is nothing next to serving 280 KB from RAM.
const STATIC_REVALIDATE_MS = 1000;

function freshStatic(relPath) {
  const entry = staticCache.get(relPath);
  if (!entry) return undefined;
  const now = Date.now();
  if (now - entry.checkedAt < STATIC_REVALIDATE_MS) return entry;
  entry.checkedAt = now;
  try {
    const stamp = fs.statSync(path.join(__dirname, "public", relPath));
    if (stamp.mtimeMs === entry.mtimeMs && stamp.size === entry.size) return entry;
    // Recompress at the same level this asset already had: dropping brotli here
    // would quietly downgrade the hot assets to gzip after the first edit.
    preCompressStatic(relPath, !!entry.brotli);
    return staticCache.get(relPath) || entry;
  } catch (_) {
    // Gone from disk: drop it and let the static/404 layers answer instead of
    // serving a file that no longer exists.
    staticCache.delete(relPath);
    return undefined;
  }
}

// Collect every asset the SPA loads: text assets get compressed, binary assets
// are cached raw so fonts/icons no longer fall through to `express.static` and
// hit the filesystem on every request.
const staticAssetList = [];
try {
  for (const f of fs.readdirSync(path.join(__dirname, "public"), { withFileTypes: true })) {
    if (f.isFile() && /\.(html|json|txt|svg|png|ico|webmanifest)$/i.test(f.name)) staticAssetList.push(f.name);
  }
} catch (_) {}
for (const dir of ["js", "css", "fonts", "img"]) {
  try {
    const abs = path.join(__dirname, "public", dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (/\.(js|css|svg|json|woff2|png|ico|jpg|jpeg|webp|avif)$/i.test(f)) staticAssetList.push(`${dir}/${f}`);
    }
  } catch (_) {}
}

// Boot fast: gzip everything now, brotli only the two assets that dominate a
// cold load. The rest get brotli on an idle tick so startup is not delayed.
const BROTLI_EAGER = new Set(["index.html", "js/app.js", "css/app.css"]);
for (const rel of staticAssetList) preCompressStatic(rel, BROTLI_EAGER.has(rel));
setTimeout(() => {
  for (const rel of staticAssetList) {
    const entry = staticCache.get(rel);
    if (!entry || entry.brotli || !entry.compressible) continue;
    try { entry.brotli = brotliOf(entry.raw); } catch (_) {}
  }
}, 5000).unref();
console.log(`[STATIC] Pre-compressed ${staticCache.size} static assets into memory cache.`);

/**
 * index.html references every asset with a `?v=` query string, so a versioned
 * URL identifies immutable content. Serving those with `max-age=0,
 * must-revalidate` (the previous behaviour) forced 7 conditional round-trips on
 * every single page load — ~1.2 MB of assets that all answered 304. Anything
 * requested with a version marker is now cached for a year; unversioned requests
 * keep revalidating so a deploy is still picked up immediately.
 */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate";
// Fonts and icons are content-addressed by filename (Google's hashed woff2
// names) or effectively static, and are never referenced with a version query.
const LONG_CACHE_DIRS = /^(fonts|img)\//;

// Serve pre-compressed assets with ~0ms latency
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let urlPath = req.path;
  if (urlPath === "/") urlPath = "index.html";
  else if (urlPath.startsWith("/")) urlPath = urlPath.substring(1);

  const cached = freshStatic(urlPath);
  if (!cached) return next();

  const accept = String(req.headers["accept-encoding"] || "");
  res.setHeader("Content-Type", cached.contentType);
  res.setHeader("ETag", cached.etag);
  if (cached.compressible) res.vary("Accept-Encoding");

  if (urlPath.endsWith(".html")) {
    // The shell must never be cached: it references the asset URLs.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  } else if (req.query.v !== undefined || LONG_CACHE_DIRS.test(urlPath)) {
    res.setHeader("Cache-Control", IMMUTABLE_CACHE_CONTROL);
  } else {
    res.setHeader("Cache-Control", REVALIDATE_CACHE_CONTROL);
  }

  // Check ETag (304 Not Modified)
  if (req.headers["if-none-match"] === cached.etag) {
    return res.status(304).end();
  }

  if (cached.brotli && accept.includes("br")) {
    res.setHeader("Content-Encoding", "br");
    res.setHeader("Content-Length", cached.brotli.length);
    return res.end(req.method === "HEAD" ? undefined : cached.brotli);
  }
  if (cached.gzipped && accept.includes("gzip")) {
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", cached.gzipped.length);
    return res.end(req.method === "HEAD" ? undefined : cached.gzipped);
  }
  res.setHeader("Content-Length", cached.raw.length);
  return res.end(req.method === "HEAD" ? undefined : cached.raw);
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "1d",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    }
  }
}));
// Unknown API paths answer with JSON, not the SPA shell.
app.use("/api", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(404).json({ error: "Метод не найден" });
});
app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  // Serve the pre-compressed shell from memory instead of re-reading and
  // re-compressing 282 KB from disk on every deep-link load. Goes through
  // freshStatic so a deep link cannot hand out a shell older than "/" does.
  const shell = freshStatic("index.html");
  if (!shell) return res.sendFile(path.join(__dirname, "public", "index.html"));

  const accept = String(req.headers["accept-encoding"] || "");
  res.setHeader("Content-Type", shell.contentType);
  res.setHeader("ETag", shell.etag);
  res.vary("Accept-Encoding");
  if (req.headers["if-none-match"] === shell.etag) return res.status(304).end();
  if (shell.brotli && accept.includes("br")) {
    res.setHeader("Content-Encoding", "br");
    return res.end(shell.brotli);
  }
  if (shell.gzipped && accept.includes("gzip")) {
    res.setHeader("Content-Encoding", "gzip");
    return res.end(shell.gzipped);
  }
  return res.end(shell.raw);
});
// Any unhandled error returns a generic message; details stay in the log.
// MUST be registered last: Express propagates errors forward, so an error
// thrown by the SPA catch-all above would otherwise skip this handler and leak a
// stack trace through Express's default finalhandler.
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
    // Per-route body parsers are registered after the early copy of this check,
    // so their 413/400 conditions land here instead. Answer with the right code.
    if (!res.headersSent) {
      return res.status(err.type === "entity.too.large" ? 413 : 400).json({ error: "Некорректное тело запроса" });
    }
  }

  // Client-fault errors carry their own status. Express's router sets 400 on a
  // malformed percent-escape in the path (`GET /%E0%A4%A`, trivially triggerable
  // by any scanner) — answering 500 there both misreported the fault and made
  // routine scanner noise look like a server defect in the logs.
  const status = Number(err && (err.status || err.statusCode));
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    if (!res.headersSent) {
      return res.status(status).json({ error: status === 400 ? "Некорректный запрос" : "Запрос отклонён" });
    }
  }

  console.error("[UNHANDLED]", req.method, req.originalUrl, err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Внутренняя ошибка сервера" });
});

// тФАтФАтФА Exchange Modules тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const exchanges = {
  BN: require("./exchanges/binance"),
  BB: require("./exchanges/bybit"),
  OX: require("./exchanges/okx"),
  BG: require("./exchanges/bitget"),
  GT: require("./exchanges/gate"),
  MX: require("./exchanges/mexc"),
  KC: require("./exchanges/kucoin"),
  BX: require("./exchanges/bingx"),
  HT: require("./exchanges/htx"),
  HL: require("./exchanges/hyperliquid"),
  AD: require("./exchanges/asterdex"),
};

// тФАтФАтФА Start тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
server.listen(PORT, () => {
  console.log(`\nтХФтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЧ`);
  console.log(`тХС  CryptoScreen Pro  тЖТ  port ${PORT}                      тХС`);
  console.log(`тХС  Exchanges: ${Object.keys(exchanges).length} modules (parallel init)            тХС`);
  console.log(`тХС  Protocol: Flat Array (ultra-fast)                      тХС`);
  console.log(`тХС  Broadcast: 50ms (20fps, CPU-optimized)                 тХС`);
  console.log(`тХЪтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЭ\n`);
  
  arbitrageEngine.start();

  // Parallel init тАФ all exchanges start simultaneously
  for (const name in exchanges) {
    try {
      console.log(`[INIT] Starting exchange: ${name}`);
      const instance = exchanges[name](tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus);
      instance.init();
      exchanges[name] = instance;
    } catch (e) {
      console.error(`[INIT] Failed to start ${name}:`, e.message);
    }
  }
  
  // A second `sendTextMessage` used to be declared here, shadowing the
  // module-level one. It was dead — the routes that used it were removed — and it
  // lacked the timeout and double-response guards of the real implementation.

  // Start Wall Scanner Engine
  wallScanner.startScanning(tickers, apiFetch, (payload) => {
    const walls = Array.isArray(payload) ? payload : (payload.walls || []);
    const meta = Array.isArray(payload) ? {} : { ...payload };
    // The full payload already contains `walls`; do not send the same large
    // array twice in every WebSocket message.
    delete meta.walls;
    currentWallsCache = walls;
    currentWallsMeta = Array.isArray(payload) ? { walls, updatedAt: Date.now() } : payload;
    // Re-point the global on every publish. It used to be bound once at startup
    // to the initial empty object, so every consumer reading it (the Telegram
    // digest) saw a permanently empty density set.
    global.__obsidianWallsMeta = currentWallsMeta;
    const msg = JSON.stringify({ type: "walls", data: walls, meta });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch (e) {}
      }
    }
  });

  // ═══ Pattern Scanner Engine (24/7 Continuous Parallel Pool with Smart Caching) ═══
  let isScanningPatterns = false;
  // key -> { candles, expiresAt }. Each entry holds up to ~1000 candle objects,
  // measured at ~78 KB; 1500 tickers x 5 timeframes would be ~573 MB. Entries
  // are dropped once expired and the map is hard-capped.
  const scannerCandleCache = new Map();
  // 1800 x ~78 KB ≈ 140 MB. The scan is now coin-deduplicated, so a single pass
  // touches ~1825 coins x 3 timeframes; entries expire by timeframe TTL anyway.
  const SCANNER_CACHE_MAX_ENTRIES = 1800;
  let lastScannerPruneAt = 0;

  function pruneScannerCandleCache(force = false) {
    const now = Date.now();
    if (!force && now - lastScannerPruneAt < 30000 && scannerCandleCache.size <= SCANNER_CACHE_MAX_ENTRIES) return;
    lastScannerPruneAt = now;

    // Expired entries are useless: the scanner refetches them anyway.
    for (const [key, entry] of scannerCandleCache) {
      if (!entry || entry.expiresAt <= now) scannerCandleCache.delete(key);
    }
    if (scannerCandleCache.size <= SCANNER_CACHE_MAX_ENTRIES) return;

    const entries = Array.from(scannerCandleCache.entries()).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const excess = scannerCandleCache.size - SCANNER_CACHE_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) scannerCandleCache.delete(entries[i][0]);
  }

  const exchangeBackoffs = new Map(); // ex -> backoffUntilTimestamp

  /**
   * Canonical coin identity for a ticker, so the same asset on several venues
   * collapses to one scan target. "BN:1000PEPEUSDT", "MX:PEPE_USDT" and
   * "BB:PEPEUSDT" all reduce to "PEPE".
   */
  function normalizeCoinKey(t) {
    const raw = t && t.base ? String(t.base) : String((t && t.key || "").split(":")[1] || "");
    return raw
      .replace(/_SPOT$/i, "")
      .replace(/[-_]/g, "")
      .replace(/(USDTM|USDT|USDC|BUSD|DAI|USD)$/i, "")
      .replace(/^1000+/, "")
      .toUpperCase();
  }

  // Share of the scan universe each venue may serve. Binance is deliberately
  // capped well below its natural share: its klines endpoint has the tightest
  // weight budget (2400/min, 10 per limit=1000 request) and it is the only venue
  // that answers a breach with an hour-long IP ban rather than a 429.
  const SCAN_VENUE_QUOTA = {
    BN: 0.16, BB: 0.16, OX: 0.12, BG: 0.12, GT: 0.12,
    MX: 0.12, KC: 0.08, BX: 0.08, HT: 0.08, HL: 0.04, AD: 0.04
  };
  const SCAN_VENUE_FALLBACK_QUOTA = 0.06;

  /**
   * Pick one venue per coin without overloading any single exchange.
   *
   * Coins are processed most-liquid-first so majors keep their best venue, and
   * each venue has a hard slot budget. When a venue is full the coin falls
   * through to its next-most-liquid venue; if every candidate venue is full the
   * coin still gets scanned on its best venue (coverage beats perfect balance).
   *
   * @param {Map<string, Array>} perCoin coin -> candidate tickers
   * @returns {Array} one ticker per coin, ordered by liquidity
   */
  function assignScanVenues(perCoin) {
    const coins = [];
    for (const [coin, venues] of perCoin) {
      venues.sort((a, b) => (b.v || 0) - (a.v || 0));
      coins.push({ coin, venues, topVol: venues[0] ? (venues[0].v || 0) : 0 });
    }
    coins.sort((a, b) => b.topVol - a.topVol);

    const total = coins.length || 1;
    const budget = new Map();
    const used = new Map();
    for (const ex of Object.keys(SCAN_VENUE_QUOTA)) {
      budget.set(ex, Math.ceil(total * SCAN_VENUE_QUOTA[ex]));
      used.set(ex, 0);
    }

    const quotaFor = (ex) => {
      if (!budget.has(ex)) {
        budget.set(ex, Math.ceil(total * SCAN_VENUE_FALLBACK_QUOTA));
        used.set(ex, 0);
      }
      return budget.get(ex);
    };

    const out = [];
    for (const { venues } of coins) {
      let chosen = null;
      for (const t of venues) {
        const ex = String(t.key || "").split(":")[0];
        if (!ex) continue;
        if (used.get(ex) < quotaFor(ex)) {
          used.set(ex, used.get(ex) + 1);
          chosen = t;
          break;
        }
      }
      // Every candidate venue is saturated. Keep the coin — coverage beats
      // perfect balance — but hand it to the *least* loaded candidate rather
      // than to venues[0], which is systematically the busiest exchange and
      // would take the entire overflow.
      if (!chosen && venues.length > 0) {
        let bestLoad = Infinity;
        for (const t of venues) {
          const ex = String(t.key || "").split(":")[0];
          if (!ex) continue;
          const load = (used.get(ex) || 0) / Math.max(1, quotaFor(ex));
          if (load < bestLoad) { bestLoad = load; chosen = t; }
        }
        if (!chosen) chosen = venues[0];
        const ex = String(chosen.key || "").split(":")[0];
        if (ex) used.set(ex, (used.get(ex) || 0) + 1);
      }
      if (chosen) out.push(chosen);
    }
    scanAllPatterns._venueSpread = Object.fromEntries(used);
    return out;
  }

  function broadcastAlert(type, data) {
    if (!clients || clients.size === 0 || !data) return;
    const msg = JSON.stringify({ type, data });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch (_) {}
      }
    }
  }

  function sendUserAlert(userId, type, data) {
    if (!clients || clients.size === 0 || !userId || !data) return;
    const msg = JSON.stringify({ type, data });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN && ws._userId === userId) {
        try { ws.send(msg); } catch (_) {}
      }
    }
  }

  function getTfTtlMs(tf) {
    const low = String(tf || "").toLowerCase();
    // Longer TTLs than before: a full scan pass now takes minutes, so a 30s TTL
    // guaranteed a refetch on every pass and burned the exchange rate budget for
    // data that had not meaningfully changed. A 5m candle only closes every 5
    // minutes; caching it for 2 is still fresh and cuts requests ~4x.
    if (low === "1d") return 30 * 60 * 1000;
    if (low === "4h") return 15 * 60 * 1000;
    if (low === "1h") return 8 * 60 * 1000;
    if (low === "15m") return 4 * 60 * 1000;
    if (low === "5m") return 2 * 60 * 1000;
    return 45 * 1000;
  }

  async function getCachedCandlesForScanner(ex, sym, tf) {
    const key = `${ex}:${sym}:${tf}`;
    const now = Date.now();
    const cached = scannerCandleCache.get(key);
    if (cached && cached.expiresAt > now && Array.isArray(cached.candles) && cached.candles.length >= 20) {
      return cached.candles;
    }

    // Refresh the LRU stamp so hot keys survive eviction.
    // 1. Fast in-memory check in main klinesCache
    const kKey = cacheKey(ex, sym, tf, true);
    try {
      const kCached = klinesCache.get(kKey);
      if (kCached && kCached.data && Array.isArray(kCached.data) && kCached.data.length >= 30) {
        kCached.used = now;
        const candles = [];
        for (let i = 0; i < kCached.data.length; i += 6) {
          candles.push({
            t: kCached.data[i],
            o: kCached.data[i + 1],
            h: kCached.data[i + 2],
            l: kCached.data[i + 3],
            c: kCached.data[i + 4],
            v: kCached.data[i + 5]
          });
        }
        scannerCandleCache.set(key, { candles, expiresAt: now + getTfTtlMs(tf) });
        pruneScannerCandleCache();
        return candles;
      }
    } catch (_) {}

    const backoffUntil = exchangeBackoffs.get(ex) || 0;
    if (backoffUntil > now) {
      return cached ? cached.candles : [];
    }

    try {
      const candles = await raceWithTimeout(startKlinesRefresh(ex, sym, tf, true, kKey), 2500, []);
      if (Array.isArray(candles) && candles.length >= 20) {
        scannerCandleCache.set(key, {
          candles,
          expiresAt: now + getTfTtlMs(tf)
        });
        pruneScannerCandleCache();
        return candles;
      }
    } catch (e) {
      const msg = String(e);
      if (msg.includes("418") || msg.includes("429") || msg.includes("VENUE_PAUSED")) {
        // apiFetch already parked the host for the duration reported by
        // `retry-after`. Park the logical exchange too so the scan skips it
        // instead of queueing thousands of doomed requests behind it.
        exchangeBackoffs.set(ex, now + 60000);
      }
    }
    return cached ? cached.candles : [];
  }

  async function scanAllPatterns() {
    if (isScanningPatterns) return;
    isScanningPatterns = true;
    const startTime = Date.now();
    let nextDelayMs = 1500;

    try {
      // ── Build the scan universe ────────────────────────────────────────────
      // The ticker feed carries ~7500 keys but only ~1825 distinct coins: the
      // same asset appears on up to 12 venues. Scanning per ticker wasted the
      // budget on duplicates, so the old 1500-ticker cap covered only a few
      // hundred coins.
      //
      // Deduplicating by coin and always picking the most liquid venue sent
      // ~55% of all requests to Binance and earned an IP ban (HTTP 418, "Way
      // too many requests"). So the venue is chosen per coin under a quota:
      // each exchange may host at most its share of the universe, and coins
      // fall through to the next-best venue once a quota is full. Same coin
      // coverage, load spread across all exchanges.
      const perCoin = new Map();
      for (const t of tickers.values()) {
        if (!t || !t.key || !t.p || t.p <= 0) continue;
        // Formations are a futures-only product. The ticker map also carries the
        // `*_SPOT` pseudo-tickers wallScanner injects for the density map, and
        // scanning them meant every formation alert could fire on a spot pair —
        // on an instrument the user cannot trade from this screener.
        if (/_SPOT$/i.test(t.key) || /_SPOT$/i.test(String(t.sym || ""))) continue;
        if (typeof isNonCryptoOrStock === "function" && isNonCryptoOrStock(t.base, t.key)) continue;
        const k = String(t.key).toUpperCase();
        if (k.includes("STOCK") || k.includes("INDEX") || k.includes("ETF") || k.includes("NVIDIA") ||
            k.includes("TSLA") || k.includes("AAPL") || k.includes("SOXL") || k.includes("SNDK") || k.includes("SKHY")) continue;

        const coin = normalizeCoinKey(t);
        if (!coin) continue;
        let venues = perCoin.get(coin);
        if (!venues) { venues = []; perCoin.set(coin, venues); }
        venues.push(t);
      }

      const list = assignScanVenues(perCoin);

      if (list.length === 0) {
        // Deliberately no reschedule here: the `finally` block below always
        // re-arms the loop. Scheduling in both places spawned duplicate scan
        // chains on every empty-ticker cycle during startup.
        nextDelayMs = 10000;
        return;
      }

      // 1m produced almost nothing but noise (measured: 4-6 retests per coin,
      // all describing the same price area) and cost a fifth of the whole cycle.
      // Dropping it and 4h brings a full pass over every coin to ~10 minutes.
      const activeTimeframes = ["5m", "15m", "1h"];
      const now = Date.now();
      let newSignalsCount = 0;
      const PARALLEL_CONCURRENCY = 3;

      // Use a Map for O(1) keyed replacement instead of O(n) .filter() on every coin
      if (!scanAllPatterns._pMap) scanAllPatterns._pMap = new Map();
      const pMap = scanAllPatterns._pMap;

      // Yield to the event loop every N detection units so HTTP and WebSocket
      // traffic is never stuck behind a long synchronous burst.
      const YIELD_EVERY_UNITS = 8;
      let yieldCountdown = YIELD_EVERY_UNITS;

      for (let i = 0; i < list.length; i += PARALLEL_CONCURRENCY) {
        const batch = list.slice(i, i + PARALLEL_CONCURRENCY);
        await Promise.all(batch.map(async (t) => {
          const colonIdx = t.key.indexOf(':');
          if (colonIdx <= 0) return;
          const ex = t.key.substring(0, colonIdx);
          const sym = t.key.substring(colonIdx + 1);
          const base = t.base || sym.replace(/[-_]?(?:USDTM|USDT|USDC|BUSD|DAI|USD)(?:[-_]?(?:SWAP|PERP|PERPETUAL|SPOT))?$/i, '') || sym;
          const coinKey = `${ex}:${sym}`;

          // Signals from every timeframe are pooled and dispatched once per coin
          // so the strongest formation wins. Dispatching inside the timeframe
          // loop always let 1m (the noisiest) speak first and produced a burst.
          const coinSignals = [];
          const candlesByTf = Object.create(null);
          let coinCurPrice = 0;

          for (const tf of activeTimeframes) {
            try {
              const candles = await getCachedCandlesForScanner(ex, sym, tf);
              if (!candles || candles.length < 25) continue;

              const lastCandle = candles[candles.length - 1];
              const curPrice = (t && t.p > 0) ? t.p : (lastCandle ? lastCandle.c : 0);

              // ── Unified single-pass formation scan (1 normalize + 1 swings + 1 ATR) ──
              const formations = serverLevels.scanAll(candles, 2);
              const { cascades: detectedCascades, horizontals: detectedHorizontals,
                      trendlines: detectedTrendlines, retests: detectedRetests } = formations;

              if (!cachedFormationMaps.cascades[tf]) cachedFormationMaps.cascades[tf] = Object.create(null);
              if (!cachedFormationMaps.levels[tf]) cachedFormationMaps.levels[tf] = Object.create(null);
              if (!cachedFormationMaps.trendline[tf]) cachedFormationMaps.trendline[tf] = Object.create(null);
              if (!cachedFormationMaps.retest[tf]) cachedFormationMaps.retest[tf] = Object.create(null);
              if (!cachedTfMaps[tf]) cachedTfMaps[tf] = Object.create(null);

              if (detectedCascades.length > 0) {
                cachedFormationMaps.cascades[tf][coinKey] = detectedCascades;
                cachedTfMaps[tf][coinKey] = detectedCascades;
                serverFormationsMap.set(`${coinKey}:${tf}`, detectedCascades);
              } else {
                delete cachedFormationMaps.cascades[tf][coinKey];
                delete cachedTfMaps[tf][coinKey];
                serverFormationsMap.delete(`${coinKey}:${tf}`);
              }

              if (detectedHorizontals.length > 0) {
                cachedFormationMaps.levels[tf][coinKey] = detectedHorizontals;
              } else {
                delete cachedFormationMaps.levels[tf][coinKey];
              }

              if (detectedTrendlines.length > 0) {
                cachedFormationMaps.trendline[tf][coinKey] = detectedTrendlines;
              } else {
                delete cachedFormationMaps.trendline[tf][coinKey];
              }

              if (detectedRetests.length > 0) {
                cachedFormationMaps.retest[tf][coinKey] = detectedRetests;
              } else {
                delete cachedFormationMaps.retest[tf][coinKey];
              }

              // ── Pattern signals ──
              const meta = { ex, sym, base, tf };
              const signals = patternDetector.scanCandles(meta, candles);

              if (signals && signals.length > 0) {
                const mapKey = `${coinKey}:${tf}`;
                pMap.set(mapKey, signals);
                newSignalsCount += signals.length;
                for (const sig of signals) coinSignals.push(sig);
                candlesByTf[tf] = candles;
                if (curPrice > 0) coinCurPrice = curPrice;
              }

              // Detection is fully synchronous (~0.6 ms per coin+timeframe) and
              // 40 coins x 3 timeframes ran back-to-back before the loop yielded,
              // blocking the event loop for ~72 ms at a time. That is what made
              // every HTTP request wait seconds while a scan was in flight.
              // Yielding per timeframe caps the blocking burst at ~0.6 ms.
              if (--yieldCountdown <= 0) {
                yieldCountdown = YIELD_EVERY_UNITS;
                await new Promise(r => setImmediate(r));
              }
            } catch (_) {}
          }

          // One dispatch per coin, across all timeframes.
          if (coinSignals.length > 0) {
            try {
              checkAndDispatchServerFormationAlerts(coinSignals, coinCurPrice, candlesByTf);
            } catch (_) {}
          }
        }));
        // The per-unit yield above already keeps latency low; this only paces
        // outbound exchange requests between batches.
        if (i + PARALLEL_CONCURRENCY < list.length) {
          await new Promise(r => setTimeout(r, 250));
        }
      }

      // Rebuild flat patternsCache from map
      const allSignals = [];
      for (const sigs of pMap.values()) {
        for (let i = 0; i < sigs.length; i++) allSignals.push(sigs[i]);
      }
      allSignals.sort((a, b) => b.ts - a.ts);
      patternsCache = allSignals.length > 5000 ? allSignals.slice(0, 5000) : allSignals;

      // Evict stale entries from pMap
      if (pMap.size > 5000) {
        const cutoff = Date.now() - 600000;
        for (const [key, sigs] of pMap) {
          if (!sigs.length || (sigs[0].ts && sigs[0].ts < cutoff)) pMap.delete(key);
        }
      }

      // Reconcile the formation caches against the live ticker map.
      //
      // Entries are only deleted above when detection returns *empty* for a key
      // that is still in the scan universe. A coin that leaves the universe
      // (delisting, or venue reassignment by `assignScanVenues`) is never
      // revisited, so its levels/trendlines/retests stayed resident for the whole
      // process lifetime across five separate maps.
      pruneFormationCaches();
      saveFormationMaps(false);

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      if (newSignalsCount > 0 || Math.random() < 0.05) {
        console.log(`[PATTERNS 24/7] Fast cycle done in ${elapsedSec}s. ${newSignalsCount} signals. Formations: ${serverFormationsMap.size}. Liquid coins: ${list.length}`);
      }
    } catch (err) {
      console.error("[PATTERNS] Error during scan:", err);
    } finally {
      isScanningPatterns = false;
      setTimeout(scanAllPatterns, nextDelayMs);
    }
  }

  // ── Periodic 4h Formations Scanner (Top liquid coins, cached for instant UI view) ──
  let isScanning4h = false;
  async function scan4hPatterns() {
    if (isScanning4h) return;
    isScanning4h = true;
    try {
      const perCoin = new Map();
      for (const t of tickers.values()) {
        if (!t || !t.key || !t.p || t.p <= 0) continue;
        if (/_SPOT$/i.test(t.key) || /_SPOT$/i.test(String(t.sym || ""))) continue;
        if (typeof isNonCryptoOrStock === "function" && isNonCryptoOrStock(t.base, t.key)) continue;
        const k = String(t.key).toUpperCase();
        if (k.includes("STOCK") || k.includes("INDEX") || k.includes("ETF") || k.includes("NVIDIA") ||
            k.includes("TSLA") || k.includes("AAPL") || k.includes("SOXL") || k.includes("SNDK") || k.includes("SKHY")) continue;
        const coin = normalizeCoinKey(t);
        if (!coin) continue;
        let venues = perCoin.get(coin);
        if (!venues) { venues = []; perCoin.set(coin, venues); }
        venues.push(t);
      }
      const fullList = assignScanVenues(perCoin);
      const list4h = fullList.slice(0, 300);
      const tf = "4h";
      if (!cachedFormationMaps.cascades[tf]) cachedFormationMaps.cascades[tf] = Object.create(null);
      if (!cachedFormationMaps.levels[tf]) cachedFormationMaps.levels[tf] = Object.create(null);
      if (!cachedFormationMaps.trendline[tf]) cachedFormationMaps.trendline[tf] = Object.create(null);
      if (!cachedFormationMaps.retest[tf]) cachedFormationMaps.retest[tf] = Object.create(null);
      if (!cachedTfMaps[tf]) cachedTfMaps[tf] = Object.create(null);

      for (let i = 0; i < list4h.length; i += 3) {
        const batch = list4h.slice(i, i + 3);
        await Promise.all(batch.map(async (t) => {
          const colonIdx = t.key.indexOf(':');
          if (colonIdx <= 0) return;
          const ex = t.key.substring(0, colonIdx);
          const sym = t.key.substring(colonIdx + 1);
          const coinKey = `${ex}:${sym}`;
          try {
            const candles = await getCachedCandlesForScanner(ex, sym, tf);
            if (!candles || candles.length < 25) return;
            const formations = serverLevels.scanAll(candles, 2);
            const { cascades: detectedCascades, horizontals: detectedHorizontals,
                    trendlines: detectedTrendlines, retests: detectedRetests } = formations;
            if (detectedCascades.length > 0) {
              cachedFormationMaps.cascades[tf][coinKey] = detectedCascades;
              cachedTfMaps[tf][coinKey] = detectedCascades;
              serverFormationsMap.set(`${coinKey}:${tf}`, detectedCascades);
            }
            if (detectedHorizontals.length > 0) cachedFormationMaps.levels[tf][coinKey] = detectedHorizontals;
            if (detectedTrendlines.length > 0) cachedFormationMaps.trendline[tf][coinKey] = detectedTrendlines;
            if (detectedRetests.length > 0) cachedFormationMaps.retest[tf][coinKey] = detectedRetests;
          } catch (_) {}
        }));
        if (i + 3 < list4h.length) await new Promise(r => setTimeout(r, 200));
      }
      saveFormationMaps(false);
    } catch (e) {
      console.warn("[PATTERNS 4H] Error:", e.message);
    } finally {
      isScanning4h = false;
      setTimeout(scan4hPatterns, 10 * 60 * 1000);
    }
  }

  // 24/7 Autonomous Server-Side Formation Alert Dispatcher
  const serverFormationAlertCooldown = new Map();
  // Second, coarser gate keyed by (user, coin) only. Without it a single scan of
  // one coin emits an alert per (type x timeframe) — measured at 12-17 signals
  // per coin across 5 timeframes — and they all leave at once, which is the
  // "alerts arrive in batches" behaviour. With it, a coin produces one alert:
  // the strongest formation found, then silence for this window.
  const serverFormationCoinCooldown = new Map();
  const FORMATION_COIN_COOLDOWN_MS = 15 * 60 * 1000;
  // Pacing per subscriber. The per-coin gate alone is not enough: a full cycle
  // scans 1500 tickers, and measurements on live data show 25-95% of them carry
  // some formation, so even one alert per coin still queues 150-550 messages
  // back to back — which is the batch the user sees. This spaces them out so an
  // alert arrives on its own; the scanner re-runs every ~1.5s, so a formation
  // skipped now is simply picked up by the next cycle.
  const serverFormationLastSentAt = new Map();
  const FORMATION_MIN_GAP_MS = 45 * 1000;
  const FORMATION_COOLDOWN_MAX = 40000;
  const FORMATION_COOLDOWN_TTL_MS = 2 * 60 * 60 * 1000;
  const FORMATION_FAILED_RETRY_MS = 60 * 1000;
  let lastFormationCooldownPruneAt = 0;

  // The cooldowns must survive a restart. The process is recycled several times
  // an hour (memory ceiling, deploys, auto-heal), and every restart used to
  // clear these maps — which is why the same coin was re-announced every 30
  // seconds despite a 5-15 minute cooldown being configured.
  const FORMATION_COOLDOWN_FILE = path.join(__dirname, "formation_cooldowns.json");
  let lastCooldownSaveAt = 0;

  function loadFormationCooldowns() {
    try {
      if (!fs.existsSync(FORMATION_COOLDOWN_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(FORMATION_COOLDOWN_FILE, "utf8"));
      const now = Date.now();
      let restored = 0;
      for (const [mapName, target] of [
        ["pair", serverFormationAlertCooldown],
        ["coin", serverFormationCoinCooldown],
        ["paced", serverFormationLastSentAt]
      ]) {
        const src = raw && raw[mapName];
        if (!src || typeof src !== "object") continue;
        for (const [key, ts] of Object.entries(src)) {
          const n = Number(ts);
          // Drop anything already expired or implausibly far in the future.
          if (!Number.isFinite(n) || n > now + 60000 || now - n > FORMATION_COOLDOWN_TTL_MS) continue;
          target.set(key, n);
          restored++;
        }
      }
      if (restored > 0) console.log(`[FORMATION COOLDOWN] Restored ${restored} entries from disk`);
    } catch (e) {
      console.warn(`[FORMATION COOLDOWN] Could not restore: ${e.message}`);
    }
  }

  function saveFormationCooldowns(force = false) {
    const now = Date.now();
    if (!force && now - lastCooldownSaveAt < 20000) return;
    lastCooldownSaveAt = now;
    try {
      const payload = {
        savedAt: now,
        pair: Object.fromEntries(serverFormationAlertCooldown),
        coin: Object.fromEntries(serverFormationCoinCooldown),
        paced: Object.fromEntries(serverFormationLastSentAt)
      };
      const json = JSON.stringify(payload);
      const tmp = `${FORMATION_COOLDOWN_FILE}.tmp`;
      if (force) {
        // Shutdown path: async I/O would never complete.
        fs.writeFileSync(tmp, json, "utf8");
        fs.renameSync(tmp, FORMATION_COOLDOWN_FILE);
        return;
      }
      // The throttled path runs from inside the alert-dispatch loop, where a
      // blocking write of a file holding up to 40k pair entries plus the coin and
      // paced maps stalls the event loop.
      fs.writeFile(tmp, json, "utf8", (err) => {
        if (err) return;
        fs.rename(tmp, FORMATION_COOLDOWN_FILE, () => {});
      });
    } catch (e) {
      console.warn(`[FORMATION COOLDOWN] Could not persist: ${e.message}`);
    }
  }

  loadFormationCooldowns();
  /**
   * Graceful shutdown.
   *
   * This used to be `process.on(sig, () => saveFormationCooldowns(true))` and it
   * never ran: `correlationEngine.init()` (invoked during `require`, long before
   * this line) registered its own SIGINT/SIGTERM handlers that called
   * `process.exit()` synchronously. Signal listeners fire in registration order,
   * so the process was already gone. correlationEngine now only hooks `exit`, and
   * this handler owns the ordered shutdown: flush state, stop accepting
   * connections, drain sockets, then exit.
   */
  let shuttingDown = false;
  function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${signal} received — flushing state`);

    try { saveFormationCooldowns(true); } catch (_) {}
    try { saveFormationMaps(true); } catch (_) {}
    try { correlationEngine.saveCacheSync?.(); } catch (_) {}
    try { correlationEngine.stop?.(); } catch (_) {}

    // Stop accepting new work, then close live sockets.
    try { server.close(); } catch (_) {}
    for (const ws of clients) {
      try { ws.close(1001, "server restarting"); } catch (_) {}
    }

    // pm2 sends SIGKILL after `kill_timeout` (5s); exit well before that.
    const bail = setTimeout(() => process.exit(0), 2000);
    bail.unref?.();
  }
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => gracefulShutdown(sig));
  }

  // The key space is subscribers x 1500 tickers x 5 timeframes x 3 pattern
  // types, so this map has to be pruned or it grows without bound for the whole
  // process lifetime.
  function pruneFormationCooldowns(now) {
    if (now - lastFormationCooldownPruneAt < 60000 && serverFormationAlertCooldown.size < FORMATION_COOLDOWN_MAX) return;
    lastFormationCooldownPruneAt = now;
    for (const [key, ts] of serverFormationAlertCooldown) {
      if (now - ts > FORMATION_COOLDOWN_TTL_MS) serverFormationAlertCooldown.delete(key);
    }
    for (const [key, ts] of serverFormationCoinCooldown) {
      if (now - ts > FORMATION_COOLDOWN_TTL_MS) serverFormationCoinCooldown.delete(key);
    }
    for (const [key, ts] of serverFormationLastSentAt) {
      if (now - ts > FORMATION_COOLDOWN_TTL_MS) serverFormationLastSentAt.delete(key);
    }
    if (serverFormationAlertCooldown.size > FORMATION_COOLDOWN_MAX) {
      const entries = Array.from(serverFormationAlertCooldown.entries()).sort((a, b) => a[1] - b[1]);
      const excess = serverFormationAlertCooldown.size - FORMATION_COOLDOWN_MAX;
      for (let i = 0; i < excess; i++) serverFormationAlertCooldown.delete(entries[i][0]);
    }
    // The cap above only covered the pair map. `serverFormationCoinCooldown` is
    // keyed (userId x coin) and `serverFormationLastSentAt` by subscriber, so both
    // need a ceiling too, not just a TTL.
    if (serverFormationCoinCooldown.size > FORMATION_COOLDOWN_MAX) {
      const entries = Array.from(serverFormationCoinCooldown.entries()).sort((a, b) => a[1] - b[1]);
      const excess = serverFormationCoinCooldown.size - FORMATION_COOLDOWN_MAX;
      for (let i = 0; i < excess; i++) serverFormationCoinCooldown.delete(entries[i][0]);
    }
    if (serverFormationLastSentAt.size > FORMATION_COOLDOWN_MAX) {
      const entries = Array.from(serverFormationLastSentAt.entries()).sort((a, b) => a[1] - b[1]);
      const excess = serverFormationLastSentAt.size - FORMATION_COOLDOWN_MAX;
      for (let i = 0; i < excess; i++) serverFormationLastSentAt.delete(entries[i][0]);
    }
  }

  // Rank formations so that, when several are found at once, the one that gets
  // sent is the most meaningful: more touches first, then closest to price.
  function scoreFormationSignal(signal) {
    const meta = signal.meta || {};
    const touches = Number(meta.touches) || (meta.p1Idx !== undefined ? 2 : 1);
    const dist = meta.dist !== undefined ? Number(meta.dist) : 1.0;
    // Structural formations outrank a bare retest at equal touch count.
    const typeWeight = signal.type === "trendline" ? 2 : signal.type === "level" ? 2 : 0;
    return touches * 100 + typeWeight * 10 - Math.min(dist, 5) * 8;
  }

  // ── In-Play Movers Cache (top active gainers + losers by |chg%| with 24h vol) ──
  let inPlayMoversSet = new Set();
  let inPlayLastUpdate = 0;
  function refreshInPlayMovers() {
    const now = Date.now();
    if (now - inPlayLastUpdate < 8000) return; // refresh every 8s
    inPlayLastUpdate = now;
    const all = Array.from(tickers.values())
      .filter(t => t && t.key && t.p > 0 && typeof t.chg === "number" && Number.isFinite(t.chg))
      .sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
    const topMovers = all.slice(0, 100); // top 100 movers
    const newSet = new Set();
    for (const t of topMovers) {
      newSet.add(t.key);
      const colonIdx = t.key.indexOf(':');
      if (colonIdx > 0) {
        const ex = t.key.substring(0, colonIdx);
        const sym = t.key.substring(colonIdx + 1);
        const cleanSym = sym.replace(/_SPOT$/i, "");
        const base = t.base || cleanSym.replace(/[-_]?(?:USDTM|USDT|USDC|BUSD|DAI|USD)(?:[-_]?(?:SWAP|PERP|PERPETUAL|SPOT))?$/i, '');
        newSet.add(sym);
        newSet.add(cleanSym);
        newSet.add(base);
        newSet.add(`${ex}:${cleanSym}`);
      }
    }
    inPlayMoversSet = newSet;
  }

  // Routes formation alerts through the shared outbound queue so they obey the
  // same global/per-chat Telegram rate limits as pump/dump alerts and honour
  // retry_after instead of being dropped on 429. Returns true only on confirmed
  // delivery — callers rely on that to decide whether to arm a cooldown.
  async function sendServerTelegramAlert(chatId, caption, photoBuffer, group) {
    if (userStore && typeof userStore.isTelegramAlertsEnabled === "function") {
      if (!userStore.isTelegramAlertsEnabled(chatId)) {
        return false;
      }
    }

    const res = await telegramQueue.enqueue({ chatId, text: caption, photoBuffer, group });
    return !!(res && res.ok);
  }

  // `candlesByTf` maps timeframe -> candle array. Each signal is rendered with
  // the candles of its own timeframe, which is what makes the snapshot match
  // the alert text. A bare array is still accepted for backward compatibility.
  function checkAndDispatchServerFormationAlerts(signals, fallbackCurPrice, candlesByTf) {
    if (!Array.isArray(signals) || signals.length === 0) return;
    const now = Date.now();
    pruneFormationCooldowns(now);

    const candlesFor = (tf) => {
      if (Array.isArray(candlesByTf)) return candlesByTf;
      if (candlesByTf && Array.isArray(candlesByTf[tf])) return candlesByTf[tf];
      return null;
    };

    // ── Validated Instant WebSocket Broadcast to Website Clients ──
    for (const signal of signals) {
      if (!signal || !signal.type || !signal.sym) continue;
      const actualPrice = signal.curPrice || fallbackCurPrice || signal.price;
      const touches = signal.meta?.touches || (signal.meta?.p1Idx !== undefined ? 2 : 1);
      const dist = signal.meta?.dist !== undefined ? Number(signal.meta.dist) : 0.5;

      // Filter out signals that are too far away or not enough touches
      if (dist > 1.0 || touches < 2) continue;

      let typeName = "";
      if (signal.type === "trendline") {
        typeName = "Наклонный уровень (Наклонка)";
        const isResistance = signal.direction === "short" || signal.meta?.tlType === "desc" || signal.meta?.direction === "up";
        if (isResistance && actualPrice >= signal.price) continue;
        if (!isResistance && actualPrice <= signal.price) continue;
      } else if (signal.type === "level") {
        typeName = "Горизонтальный уровень (Горизонталка)";
        const isSupport = signal.direction === "long" || signal.meta?.levelType === "support" || signal.meta?.direction === "down";
        if (!isSupport && actualPrice >= signal.price) continue;
        if (isSupport && actualPrice <= signal.price) continue;
      } else if (signal.type === "retest") {
        typeName = "Подтвержденный ретест (Ретест)";
      } else {
        continue;
      }

      broadcastAlert("formation_alert", {
        ex: signal.ex,
        sym: signal.sym,
        base: signal.base,
        tf: signal.tf,
        type: signal.type,
        typeName,
        price: signal.price,
        targetPrice: signal.price,
        curPrice: actualPrice,
        touches,
        distPct: dist.toFixed(2),
        direction: signal.direction,
        meta: signal.meta,
        ts: now
      });
    }

    const allUsers = Object.values(userStore.getAllUsersRaw ? userStore.getAllUsersRaw() : {});
    const subscribers = [];
    const seenChatIds = new Set();

    for (const u of allUsers) {
      if (!u || u.blocked) continue;
      const userChatId = String(u.telegramChatId || u.telegramId || u.tgChatId || u.chatId || "").trim();
      const globalOverride = userChatId ? getFormationChatPrefs(userChatId) : null;
      const prefs = {
        ...((u.preferences && u.preferences.formationAlerts) || 
            (u.preferences && u.preferences.notifications && u.preferences.notifications.formationAlerts) || 
            u.formationAlerts || {}),
        ...(globalOverride || {})
      };
      const chatId = String(userChatId || prefs.telegramChatId || "").trim();
      if (!chatId) continue;

      const isMasterAdmin = chatId === String(process.env.ADMIN_CHAT_ID || "").trim() || chatId === String(process.env.TELEGRAM_ADMIN_ID || "").trim();
      const tgEnabled = prefs.tgEnabled !== undefined ? !!prefs.tgEnabled : (isMasterAdmin ? true : false);
      if (!tgEnabled) continue;

      subscribers.push({
        userId: u.id,
        chatId,
        settings: {
          tgEnabled,
          cooldownSeconds: Number(prefs.cooldownSeconds) || 300,
          exchanges: Array.isArray(prefs.exchanges) && prefs.exchanges.length > 0 ? prefs.exchanges : ["all"],
          blacklist: Array.isArray(prefs.blacklist) ? prefs.blacklist : [],
          blacklistCustom: typeof prefs.blacklistCustom === "string" ? prefs.blacklistCustom : "",
          inPlayOnly: !!prefs.inPlayOnly,
          trendline: {
            enabled: prefs.trendline?.enabled !== undefined ? !!prefs.trendline.enabled : true,
            timeframes: Array.isArray(prefs.trendline?.timeframes) && prefs.trendline.timeframes.length > 0 ? prefs.trendline.timeframes : ["5m", "15m", "1h", "4h"],
            minTouches: (prefs.trendline?.minTouches !== undefined && Number(prefs.trendline?.minTouches) > 0) ? Number(prefs.trendline.minTouches) : 4,
            distancePct: (prefs.trendline?.distancePct !== undefined && Number(prefs.trendline?.distancePct) > 0) ? Number(prefs.trendline.distancePct) : 0.5,
            direction: prefs.trendline?.direction || "all"
          },
          level: {
            enabled: prefs.level?.enabled !== undefined ? !!prefs.level.enabled : true,
            timeframes: Array.isArray(prefs.level?.timeframes) && prefs.level.timeframes.length > 0 ? prefs.level.timeframes : ["5m", "15m", "1h", "4h"],
            minTouches: (prefs.level?.minTouches !== undefined && Number(prefs.level?.minTouches) > 0) ? Number(prefs.level.minTouches) : 4,
            distancePct: (prefs.level?.distancePct !== undefined && Number(prefs.level?.distancePct) > 0) ? Number(prefs.level.distancePct) : 0.5,
            direction: prefs.level?.direction || "all"
          },
          retest: {
            enabled: prefs.retest?.enabled !== undefined ? !!prefs.retest.enabled : true,
            timeframes: Array.isArray(prefs.retest?.timeframes) && prefs.retest.timeframes.length > 0 ? prefs.retest.timeframes : ["5m", "15m", "1h", "4h"],
            direction: prefs.retest?.direction || "all"
          }
        }
      });
      seenChatIds.add(chatId);
    }

    // Also include any standalone configured chatIds from memory. Entries can
    // only get here via an authenticated write (see setFormationChatPrefs).
    for (const [cId, entry] of formationAlertsByChatId) {
      const s = entry.settings;
      if (!seenChatIds.has(cId) && s && s.tgEnabled !== false) {
        subscribers.push({
          userId: `chat_${cId}`,
          chatId: cId,
          settings: {
            tgEnabled: true,
            cooldownSeconds: Number(s.cooldownSeconds) || 300,
            exchanges: Array.isArray(s.exchanges) && s.exchanges.length > 0 ? s.exchanges : ["all"],
            blacklist: Array.isArray(s.blacklist) ? s.blacklist : [],
            blacklistCustom: typeof s.blacklistCustom === "string" ? s.blacklistCustom : "",
            inPlayOnly: !!s.inPlayOnly,
            trendline: {
              enabled: s.trendline?.enabled !== undefined ? !!s.trendline.enabled : true,
              timeframes: Array.isArray(s.trendline?.timeframes) && s.trendline.timeframes.length > 0 ? s.trendline.timeframes : ["5m", "15m", "1h", "4h"],
              minTouches: (s.trendline?.minTouches !== undefined && Number(s.trendline?.minTouches) > 0) ? Number(s.trendline.minTouches) : 4,
              distancePct: (s.trendline?.distancePct !== undefined && Number(s.trendline?.distancePct) > 0) ? Number(s.trendline.distancePct) : 0.5,
              direction: s.trendline?.direction || "all"
            },
            level: {
              enabled: s.level?.enabled !== undefined ? !!s.level.enabled : true,
              timeframes: Array.isArray(s.level?.timeframes) && s.level.timeframes.length > 0 ? s.level.timeframes : ["5m", "15m", "1h", "4h"],
              minTouches: (s.level?.minTouches !== undefined && Number(s.level?.minTouches) > 0) ? Number(s.level.minTouches) : 4,
              distancePct: (s.level?.distancePct !== undefined && Number(s.level?.distancePct) > 0) ? Number(s.level.distancePct) : 0.5,
              direction: s.level?.direction || "all"
            },
            retest: {
              enabled: s.retest?.enabled !== undefined ? !!s.retest.enabled : true,
              timeframes: Array.isArray(s.retest?.timeframes) && s.retest.timeframes.length > 0 ? s.retest.timeframes : ["5m", "15m", "1h", "4h"],
              direction: s.retest?.direction || "all"
            }
          }
        });
        seenChatIds.add(cId);
      }
    }

    const adminChatId = String(process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_ID || "").trim();
    if (adminChatId && !seenChatIds.has(adminChatId)) {
      subscribers.push({
        userId: "admin",
        chatId: adminChatId,
        settings: {
          tgEnabled: true,
          cooldownSeconds: 180,
          exchanges: ["all"],
          blacklist: [],
          blacklistCustom: "",
          trendline: { enabled: true, timeframes: ["1m", "5m", "15m", "1h", "4h"], minTouches: 4, distancePct: 0.5, direction: "all" },
          level: { enabled: true, timeframes: ["1m", "5m", "15m", "1h", "4h"], minTouches: 4, distancePct: 0.5, direction: "all" },
          retest: { enabled: true, timeframes: ["1m", "5m", "15m", "1h", "4h"], direction: "all" }
        }
      });
      seenChatIds.add(adminChatId);
    }

    if (subscribers.length === 0) return;

    // Refresh In-Play movers set before processing signals
    refreshInPlayMovers();

    // One scan of a coin routinely yields a dozen formations across timeframes
    // and types. Send the single strongest one instead of the whole batch: they
    // describe the same price area, so the rest is noise.
    const rankedSignals = signals
      .filter(s => s && s.type && s.sym)
      .sort((a, b) => scoreFormationSignal(b) - scoreFormationSignal(a));

    for (const signal of rankedSignals) {
      const { ex, sym, base, tf, type, price, meta } = signal;
      const touches = meta?.touches || (meta?.p1Idx !== undefined ? 2 : 1);
      const dist = meta?.dist !== undefined ? Number(meta.dist) : 0.5;

      // Filter out distant signals before checking subscriber settings
      if (dist > 1.2 || touches < 2) continue;

      const matchingSubsForSignal = [];

      for (const sub of subscribers) {
        const { chatId, settings: s, userId } = sub;
        if (!s || !s.tgEnabled) continue;

        // Check In-Play filter: skip if user wants only active movers and this coin is not in the set
        if (s.inPlayOnly) {
          const cleanSym = String(sym || "").replace(/_SPOT$/i, "");
          const baseSym = String(base || sym).replace(/[-_]?(?:USDTM|USDT|USDC|BUSD|DAI|USD)(?:[-_]?(?:SWAP|PERP|PERPETUAL|SPOT))?$/i, "");
          const isInPlay = inPlayMoversSet.has(`${ex}:${sym}`) ||
                           inPlayMoversSet.has(`${ex}:${cleanSym}`) ||
                           inPlayMoversSet.has(sym) ||
                           inPlayMoversSet.has(cleanSym) ||
                           inPlayMoversSet.has(baseSym);
          if (!isInPlay) continue;
        }

        // Check exchange filter
        const allowedExs = Array.isArray(s.exchanges) && s.exchanges.length > 0 ? s.exchanges : ["all"];
        if (!allowedExs.includes("all") && !allowedExs.includes(ex) && !allowedExs.includes(String(ex).toUpperCase())) continue;

        // Check blacklist
        const rawSym = String(sym).toUpperCase().replace(/[^A-Z0-9]/g, "");
        const baseSym = String(base || sym).toUpperCase().replace(/[^A-Z0-9]/g, "");
        const bl = Array.isArray(s.blacklist) ? s.blacklist.map(x => x.toUpperCase()) : [];
        const customBl = typeof s.blacklistCustom === "string" ? s.blacklistCustom.toUpperCase().split(/[,;\s]+/).map(x => x.trim()).filter(Boolean) : [];
        const allBl = new Set([...bl, ...customBl]);
        if (allBl.has(rawSym) || allBl.has(baseSym)) continue;

        const actualPrice = (fallbackCurPrice && fallbackCurPrice > 0) ? fallbackCurPrice : (signal.curPrice || price);

        // Check pattern type enabled & thresholds
        if (type === "trendline") {
          if (!s.trendline?.enabled) continue;
          const allowedTfs = Array.isArray(s.trendline.timeframes) && s.trendline.timeframes.length > 0 ? s.trendline.timeframes : ["5m", "15m", "1h", "4h"];
          if (!allowedTfs.includes(tf)) continue;
          const minT = Number(s.trendline.minTouches) || 4;
          const maxD = Number(s.trendline.distancePct) || 0.5;
          const targetDir = s.trendline.direction || "all";

          // Calculate LIVE distance using real-time price
          const liveDist = actualPrice > 0 ? (Math.abs(actualPrice - price) / actualPrice) * 100 : dist;
          if (touches < minT || liveDist > maxD) continue;

          // Reject if price has already broken through or crossed past the trendline
          const isResistance = signal.direction === "short" || meta?.tlType === "desc" || meta?.direction === "up" || meta?.isHigh === true;
          if (isResistance && actualPrice >= price) continue;
          if (!isResistance && actualPrice <= price) continue;

          if (targetDir !== "all") {
            const sigDir = signal.direction === "long" ? "down" : "up";
            if ((targetDir === "down" || targetDir === "support" || targetDir === "long") && sigDir !== "down") continue;
            if ((targetDir === "up" || targetDir === "resistance" || targetDir === "short") && sigDir !== "up") continue;
          }
        } else if (type === "level") {
          if (!s.level?.enabled) continue;
          const allowedTfs = Array.isArray(s.level.timeframes) && s.level.timeframes.length > 0 ? s.level.timeframes : ["5m", "15m", "1h", "4h"];
          if (!allowedTfs.includes(tf)) continue;
          const minT = Number(s.level.minTouches) || 4;
          const maxD = Number(s.level.distancePct) || 0.5;
          const targetDir = s.level.direction || "all";

          const liveDist = actualPrice > 0 ? (Math.abs(actualPrice - price) / actualPrice) * 100 : dist;
          if (touches < minT || liveDist > maxD) continue;

          // Reject if price has already broken through the horizontal level
          const isSupport = signal.direction === "long" || meta?.levelType === "support" || meta?.direction === "down";
          if (!isSupport && actualPrice >= price) continue;
          if (isSupport && actualPrice <= price) continue;

          if (targetDir !== "all") {
            if ((targetDir === "support" || targetDir === "down" || targetDir === "long" || targetDir === "Long") && !isSupport) continue;
            if ((targetDir === "resistance" || targetDir === "up" || targetDir === "short" || targetDir === "Short") && isSupport) continue;
          }
        } else if (type === "retest") {
          if (!s.retest?.enabled) continue;
          const allowedTfs = Array.isArray(s.retest.timeframes) && s.retest.timeframes.length > 0 ? s.retest.timeframes : ["5m", "15m", "1h", "4h"];
          if (!allowedTfs.includes(tf)) continue;
          const targetDir = s.retest.direction || "all";
          if (targetDir !== "all") {
            const sigDir = signal.direction === "long" ? "up" : "down";
            if ((targetDir === "up" || targetDir === "long" || targetDir === "Long") && sigDir !== "up") continue;
            if ((targetDir === "down" || targetDir === "short" || targetDir === "Short") && sigDir !== "down") continue;
          }
        } else {
          continue;
        }

        // Per-coin gate keyed by the coin itself, not by venue. Otherwise the
        // same asset on Binance and Bybit counts as two coins and the user gets
        // the same formation twice.
        const coinKey = `${userId}:${normalizeCoinKey({ base, key: `${ex}:${sym}` })}`;
        const lastCoinSent = serverFormationCoinCooldown.get(coinKey) || 0;
        const coinWindowMs = Math.max(FORMATION_COIN_COOLDOWN_MS, (Number(s.cooldownSeconds) || 300) * 1000);
        if (now - lastCoinSent < coinWindowMs) continue;

        // Global pacing per subscriber: one alert at a time, not a queue of them.
        const lastAnySent = serverFormationLastSentAt.get(userId) || 0;
        if (now - lastAnySent < FORMATION_MIN_GAP_MS) continue;

        // Cooldown check per user + coin + pattern + tf
        const cooldownSec = Number(s.cooldownSeconds) || 300;
        const cdKey = `${userId}:${ex}:${sym}:${type}:${tf}`;
        const lastSent = serverFormationAlertCooldown.get(cdKey) || 0;
        if (now - lastSent < cooldownSec * 1000) continue;

        // Armed provisionally to prevent duplicate dispatch from overlapping
        // scans; shortened to a brief retry window below if the send fails, so
        // a 429 or network error does not silently swallow the alert for the
        // whole cooldown period.
        serverFormationAlertCooldown.set(cdKey, now);
        serverFormationCoinCooldown.set(coinKey, now);
        serverFormationLastSentAt.set(userId, now);
        saveFormationCooldowns();
        matchingSubsForSignal.push({
          chatId,
          userId,
          actualPrice,
          cdKey,
          coinKey,
          prevCoinSentAt: lastCoinSent,
          prevAnySentAt: lastAnySent,
          cooldownMs: cooldownSec * 1000
        });
      }

      if (matchingSubsForSignal.length === 0) continue;

      // Asynchronously render chart ONCE and send to all matching subscribers
      (async () => {
        const exNames = {
          BN: "Binance",
          BB: "Bybit",
          OX: "OKX",
          BG: "Bitget",
          GT: "Gate.io",
          MX: "MEXC",
          HL: "Hyperliquid",
          BX: "BingX",
          KC: "KuCoin",
          HT: "HTX",
          AD: "AsterDex"
        };
        const exFull = exNames[ex] || ex;
        const actualPrice = matchingSubsForSignal[0].actualPrice;

        function formatDynamicPrice(p) {
          const num = Number(p);
          if (!Number.isFinite(num) || num === 0) return "0";
          if (num >= 100) return num.toFixed(2);
          if (num >= 1) return num.toFixed(4);
          if (num >= 0.01) return num.toFixed(5);
          if (num >= 0.0001) return num.toFixed(7);
          return num.toFixed(8);
        }

        const priceStr = formatDynamicPrice(price);
        const actualPriceStr = formatDynamicPrice(actualPrice);

        let msg = "";
        if (type === "trendline") {
          msg =
            `⚡ <b>Сигнал формации: Наклонный уровень (Наклонка)</b>\n\n` +
            `• <b>Монета:</b> ${sym.toUpperCase()} (${exFull})\n` +
            `• <b>Таймфрейм:</b> ${tf}\n` +
            `• <b>Касания:</b> ${touches} касания\n` +
            `• <b>Дистанция:</b> ${dist}% до линии\n` +
            `• <b>Цена наклона:</b> $${priceStr}\n` +
            `• <b>Текущая цена:</b> $${actualPriceStr}\n` +
            `─────────────────────────\n` +
            `⚡ <b>Obsidian Screener</b>`;
        } else if (type === "level") {
          const isSupport = signal.direction === "long" || meta?.levelType === "support" || meta?.direction === "down";
          const dirLabel = isSupport ? "Long (Поддержка)" : "Short (Сопротивление)";
          msg =
            `⚡ <b>Сигнал формации: Горизонтальный уровень (Горизонталка)</b>\n\n` +
            `• <b>Монета:</b> ${sym.toUpperCase()} (${exFull})\n` +
            `• <b>Таймфрейм:</b> ${tf}\n` +
            `• <b>Тип уровня:</b> ${dirLabel}\n` +
            `• <b>Касания:</b> ${touches} касания\n` +
            `• <b>Дистанция:</b> ${dist}% до уровня\n` +
            `• <b>Цена уровня:</b> $${priceStr}\n` +
            `• <b>Текущая цена:</b> $${actualPriceStr}\n` +
            `─────────────────────────\n` +
            `⚡ <b>Obsidian Screener</b>`;
        } else if (type === "retest") {
          const dirLabel = signal.direction === "long" ? "Long (Отскок вверх)" : "Short (Отскок вниз)";
          const srcLabel = meta?.sourceType === "trendline" ? "Пробой трендовой линии" : "Пробой уровня";
          msg =
            `⚡ <b>Сигнал формации: Подтвержденный ретест (Ретест)</b>\n\n` +
            `• <b>Монета:</b> ${sym.toUpperCase()} (${exFull})\n` +
            `• <b>Таймфрейм:</b> ${tf}\n` +
            `• <b>Тип ретеста:</b> ${dirLabel}\n` +
            `• <b>Основа:</b> ${srcLabel}\n` +
            `• <b>Статус:</b> Подтвержденный отскок (Confirmed)\n` +
            `• <b>Цена уровня:</b> $${priceStr}\n` +
            `• <b>Текущая цена:</b> $${actualPriceStr}\n` +
            `─────────────────────────\n` +
            `⚡ <b>Obsidian Screener</b>`;
        }

        let photoBuffer = null;
        // Render with the candles of this signal's own timeframe.
        const sigCandles = candlesFor(tf);
        if (Array.isArray(sigCandles) && sigCandles.length > 5 && typeof renderServerChartSnapshot === "function") {
          try {
            const t = tickers ? tickers.get(`${ex}:${sym}`) : null;
            photoBuffer = renderServerChartSnapshot(sigCandles, {
              ex,
              sym,
              tf,
              base,
              vol: t?.v || 0,
              chg: t?.chg || 0,
              funding: t?.funding,
              natr: (t && t.h && t.l && t.p > 0) ? ((t.h - t.l) / t.p) * 100 : undefined
            }, signal);
          } catch (e) {
            console.warn(`[24/7 CHART RENDER FAIL]`, e.message);
          }
        }

        if (msg) {
          // One shared group token => the chart is uploaded once and reused via
          // file_id for every other recipient of this same signal.
          const groupToken = `fm:${ex}:${sym}:${type}:${tf}:${now}`;
          const results = await Promise.allSettled(
            matchingSubsForSignal.map(({ chatId }) => sendServerTelegramAlert(chatId, msg, photoBuffer, groupToken))
          );
          results.forEach((r, i) => {
            const delivered = r.status === "fulfilled" && r.value === true;
            if (delivered) return;
            const target = matchingSubsForSignal[i];
            // Retry soon rather than after the full cooldown, without releasing
            // the key entirely (which would hot-loop on a Telegram outage).
            const retryAt = Date.now() - target.cooldownMs + FORMATION_FAILED_RETRY_MS;
            serverFormationAlertCooldown.set(target.cdKey, retryAt);
            // The per-coin gate must also be released, otherwise a failed send
            // silences the whole coin for the full window.
            if (target.prevCoinSentAt) serverFormationCoinCooldown.set(target.coinKey, target.prevCoinSentAt);
            else serverFormationCoinCooldown.delete(target.coinKey);
            // Same for the pacing slot: a failed send must not consume this
            // subscriber's turn.
            if (target.prevAnySentAt) serverFormationLastSentAt.set(target.userId, target.prevAnySentAt);
            else serverFormationLastSentAt.delete(target.userId);
            console.warn(`[24/7 ALERT NOT DELIVERED] ${ex}:${sym} ${type} ${tf} -> ${target.chatId}; retry in ${Math.round(FORMATION_FAILED_RETRY_MS / 1000)}s`);
          });
        }
      })().catch(err => {
        console.warn(`[24/7 ALERT ERROR]`, err.message);
      });
    }
  }

  // 24/7 Server-Side Offline Alert Engine (Operates 24/7 with Ultra-HD Charts even when user screener tabs are closed)
  if (alertEngine && typeof alertEngine.init === "function") {
    alertEngine.init({
      tickers,
      telegramBot,
      userStore,
      isNonCryptoOrStock,
      broadcastAlert: (type, data) => broadcastAlert(type, data),
      sendUserAlert: (userId, type, data) => sendUserAlert(userId, type, data),
      fetchCandles: async (ex, sym, tf) => {
        try {
          const cleanSym = String(sym || "").replace(/_SPOT$/i, "");
          const key = cacheKey(ex, cleanSym, tf || "1m", true);
          const cached = klinesCache.get(key) || klinesCache.get(cacheKey(ex, sym, tf || "1m", true));
          const now = Date.now();
          if (cached && cached.at && (now - cached.at < 30000) && cached.data && Array.isArray(cached.data) && cached.data.length >= 30) {
            const candles = [];
            for (let i = 0; i < cached.data.length; i += 6) {
              candles.push({
                t: cached.data[i],
                o: cached.data[i + 1],
                h: cached.data[i + 2],
                l: cached.data[i + 3],
                c: cached.data[i + 4],
                v: cached.data[i + 5]
              });
            }
            return candles;
          }
          // Direct live exchange history fetch
          const fetched = await raceWithTimeout(
            fetchFullHistory(ex, cleanSym, tf || "1m", true),
            3500,
            null
          );
          if (Array.isArray(fetched) && fetched.length >= 5) {
            return fetched;
          }
        } catch (_) {}
        return null;
      }
    });
  }

  // Initial trigger after 2 seconds
  setTimeout(scanAllPatterns, 2000);
  setTimeout(scan4hPatterns, 5000);

  // Periodic snapshots as data arrives
  let snapCount = 0;
  const snapTimer = setInterval(() => {
    if (tickers.size > 0 && clients.size > 0) {
      broadcastSnapshot();
      snapCount++;
    }
    if (snapCount >= 5) clearInterval(snapTimer);
  }, 2000);
});
