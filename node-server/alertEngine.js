"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// alertEngine.js — 24/7 Background Server-Side Alert Engine with Ultra-HD Charts
// Operates 24/7 even when user browsers are completely closed / offline.
// ═══════════════════════════════════════════════════════════════════════════════

const telegramQueue = require("./telegramQueue");
const { sharedStore, SPAN_MS } = require("./priceHistoryStore");
const {
  normalizeExchanges,
  isExchangeAllowed,
  analyzeMove,
  SignalConfirmationGate
} = require("./public/js/pumpLogic");

let tickersMap = null;
let telegramBotModule = null;
let userStoreModule = null;
let fetchCandlesFn = null;
let isNonCryptoOrStockFn = null;
let serverChartRenderer = null;

try {
  serverChartRenderer = require("./serverChartRenderer");
} catch (e) {
  console.warn("[ALERT ENGINE] serverChartRenderer not available:", e.message);
}

// Compact shared price history (typed-array ring buffers). See
// priceHistoryStore.js for why the old Map<string, Array<{t,p}>> layout had to
// go: at the live ticker count it consumed hundreds of MB and triggered process
// recycles that wiped every in-memory alert cooldown.
const priceHistory = sharedStore;
const HISTORY_KEY_TTL_MS = 6 * 60 * 60 * 1000; // drop delisted/stale symbols
let lastHistoryPruneAt = 0;

// Cooldown tracker per chatId:key
// Map<string, number> (key: `${chatId}:${ex}:${sym}:${type}`) -> timestamp
const cooldownTracker = new Map();
const signalConfirmationGate = new SignalConfirmationGate({ minConfirmations: 2, minSpacingMs: 250, ttlMs: 10_000 });
const COOLDOWN_MAX_ENTRIES = 20000;
const COOLDOWN_TTL_MS = 60 * 60 * 1000;
// After a failed send, retry this soon instead of waiting out the full cooldown
// (which loses the alert) or retrying immediately (which hot-loops on outages).
const FAILED_SEND_RETRY_MS = 60 * 1000;
const CHART_RENDER_BUDGET_MS = 12_000;
const CHART_FAILED_RETRY_MS = 15_000;
let lastCooldownPruneAt = 0;

// Unconditional periodic prune. The previous version only ran inside the
// "an alert fired" branch, so a quiet market never reclaimed anything.
function pruneCooldownTracker(now) {
  if (now - lastCooldownPruneAt < 60000 && cooldownTracker.size < COOLDOWN_MAX_ENTRIES) return;
  lastCooldownPruneAt = now;
  for (const [key, ts] of cooldownTracker) {
    if (now - ts > COOLDOWN_TTL_MS) cooldownTracker.delete(key);
  }
  if (cooldownTracker.size > COOLDOWN_MAX_ENTRIES) {
    // Still oversized: evict oldest first to keep the map strictly bounded.
    const entries = Array.from(cooldownTracker.entries()).sort((a, b) => a[1] - b[1]);
    const excess = cooldownTracker.size - COOLDOWN_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) cooldownTracker.delete(entries[i][0]);
  }
}

// Default 24/7 Alert settings
const DEFAULT_USER_ALERT_SETTINGS = {
  tgEnabled: false,
  telegramChatId: "",
  pumpDump: {
    enabled: true,
    direction: "both", // "both" | "pump" | "dump"
    marketType: "both", // "both" | "futures" | "spot"
    minPct: 3,
    periodMinutes: 5,
    minVolume: 1000000,
    cooldownSeconds: 300,
    exchanges: ["all", "BN", "BB", "OX", "BG", "GT", "MX", "HL", "BX", "KC", "HT"]
  },
  priceAlerts: [],
  formationAlerts: {
    enabled: false,
    minTouches: 3,
    cooldownSeconds: 600
  }
};

function formatPrice(val) {
  if (val === undefined || val === null || isNaN(val)) return "0.00";
  const num = Number(val);
  if (num >= 1000) return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.0001) return num.toFixed(6);
  return num.toFixed(8);
}

function formatVolume(val) {
  const num = Number(val) || 0;
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(2)}K`;
  return `$${num.toFixed(0)}`;
}

function getExchangeFullName(code) {
  const map = {
    BN: "Binance",
    BB: "Bybit",
    OX: "OKX",
    BG: "Bitget",
    GT: "Gate.io",
    MX: "MEXC",
    HL: "Hyperliquid",
    BX: "BingX",
    KC: "KuCoin",
    HT: "HTX"
  };
  return map[code] || code || "Exchange";
}

// Low-level helper to send direct text message fallback
async function sendTelegramMessage(chatId, text) {
  if (!chatId || !text) return false;
  if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.ADMIN_BOT_TOKEN) return false;

  if (userStoreModule && typeof userStoreModule.isTelegramAlertsEnabled === "function") {
    if (!userStoreModule.isTelegramAlertsEnabled(chatId)) {
      return false;
    }
  }

  if (telegramBotModule && typeof telegramBotModule.sendMessage === "function") {
    try {
      const res = await telegramBotModule.sendMessage(chatId, text);
      return !!res;
    } catch (_) {
      return false;
    }
  }

  const res = await telegramQueue.enqueue({ chatId, text });
  return !!(res && res.ok);
}

// Full helper to send Photo (with chart) or fallback to text.
// Returns a Telegram file_id (string) when a chart was uploaded, `true` on a
// successful text-only send, and `false` when delivery ultimately failed.
// Callers must treat a falsy result as "not delivered" and refrain from arming
// an alert cooldown, otherwise the alert is silently lost.
async function sendTelegramAlert(chatId, text, photoBuffer = null, fileId = null, group = null, requirePhoto = false) {
  if (!chatId || !text) return false;
  if (requirePhoto && !Buffer.isBuffer(photoBuffer) && !fileId) return false;
  if (!process.env.TELEGRAM_BOT_TOKEN && !process.env.ADMIN_BOT_TOKEN && (!telegramBotModule || typeof telegramBotModule.sendAlert !== "function")) return false;

  if (userStoreModule && typeof userStoreModule.isTelegramAlertsEnabled === "function") {
    if (!userStoreModule.isTelegramAlertsEnabled(chatId)) {
      return false;
    }
  }

  if (telegramBotModule && typeof telegramBotModule.sendAlert === "function") {
    try {
      const res = await telegramBotModule.sendAlert(chatId, text, photoBuffer, null, group);
      return res || true;
    } catch (_) {
      return false;
    }
  }

  const res = await telegramQueue.enqueue({ chatId, text, photoBuffer, fileId, group, requirePhoto });
  if (!res || !res.ok) return false;
  return res.fileId || true;
}

// ── Direct Exchange Real Klines Fetcher (Fast lightweight 60 bars) ───────────
async function fetchDirectExchangeCandles(ex, sym, tf = "1m") {
  try {
    const isSpot = sym.endsWith("_SPOT") || sym.includes("_SPOT");
    const cleanSym = sym.replace(/_SPOT$/i, "");
    const urls = [];

    if (ex === "BN") {
      if (isSpot) {
        urls.push(`https://data-api.binance.vision/api/v3/klines?symbol=${cleanSym}&interval=${tf}&limit=60`);
        urls.push(`https://api.binance.com/api/v3/klines?symbol=${cleanSym}&interval=${tf}&limit=60`);
      } else {
        urls.push(`https://data-api.binance.vision/api/v3/klines?symbol=${cleanSym}&interval=${tf}&limit=60`);
        urls.push(`https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSym}&interval=${tf}&limit=60`);
        urls.push(`https://api.binance.com/api/v3/klines?symbol=${cleanSym}&interval=${tf}&limit=60`);
      }
    } else if (ex === "BB") {
      const bybitTf = tf === "1m" ? "1" : tf === "5m" ? "5" : tf === "15m" ? "15" : tf === "1h" ? "60" : "5";
      if (isSpot) {
        urls.push(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${cleanSym}&interval=${bybitTf}&limit=60`);
      } else {
        urls.push(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${cleanSym}&interval=${bybitTf}&limit=60`);
        urls.push(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${cleanSym}&interval=${bybitTf}&limit=60`);
      }
    } else if (ex === "OX") {
      const oxSym = cleanSym.includes("-") ? cleanSym : `${cleanSym.replace(/USDT$/, "")}-USDT-SWAP`;
      urls.push(`https://www.okx.com/api/v5/market/candles?instId=${oxSym}&bar=${tf}&limit=60`);
      urls.push(`https://www.okx.com/api/v5/market/candles?instId=${cleanSym.replace(/USDT$/, "")}-USDT&bar=${tf}&limit=60`);
    } else if (ex === "BG") {
      const bgSym = cleanSym.endsWith("USDT") ? `${cleanSym}_UMCBL` : cleanSym;
      urls.push(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${bgSym}&granularity=${tf}&limit=60`);
      urls.push(`https://api.bitget.com/api/v2/spot/market/candles?symbol=${cleanSym}&granularity=${tf}&limit=60`);
    } else if (ex === "GT") {
      urls.push(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${cleanSym}&interval=${tf}&limit=60`);
      urls.push(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${cleanSym.replace(/USDT$/, "_USDT")}&interval=${tf}&limit=60`);
    } else if (ex === "MX") {
      const mxSym = cleanSym.includes("_") ? cleanSym : (cleanSym.endsWith("USDT") ? cleanSym.replace(/USDT$/i, "_USDT") : cleanSym + "_USDT");
      const mxTf = tf === "1m" ? "Min1" : tf === "5m" ? "Min5" : tf === "15m" ? "Min15" : "Min60";
      urls.push(`https://contract.mexc.com/api/v1/contract/kline/${mxSym}?interval=${mxTf}&limit=60`);
    } else if (ex === "BX") {
      const bxSym = cleanSym.includes("-") ? cleanSym : `${cleanSym.replace(/USDT$/, "")}-USDT`;
      urls.push(`https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${bxSym}&interval=${tf}&limit=60`);
    } else if (ex === "KC") {
      const ksym = cleanSym.includes("-") ? cleanSym : `${cleanSym.replace(/USDT$/, "")}-USDT`;
      urls.push(`https://api.kucoin.com/api/v1/market/candles?type=${tf === "1m" ? "1min" : tf === "5m" ? "5min" : tf === "15m" ? "15min" : "1hour"}&symbol=${ksym}`);
    } else if (ex === "HT") {
      const hsym = cleanSym.toLowerCase();
      urls.push(`https://api.huobi.pro/market/history/kline?period=${tf === "1m" ? "1min" : tf === "5m" ? "5min" : tf === "15m" ? "15min" : "60min"}&size=60&symbol=${hsym}`);
    } else if (ex === "HL") {
      try {
        const tfMs = tf === "15m" ? 900000 : (tf === "5m" ? 300000 : 60000);
        const data = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "candleSnapshot", req: { coin: cleanSym, interval: tf, startTime: Date.now() - (60 * tfMs), endTime: Date.now() } }),
          signal: AbortSignal.timeout(4000)
        }).then(r => r.json());
        if (Array.isArray(data) && data.length >= 5) {
          return data.map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c }));
        }
      } catch (_) {}
    }

    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) continue;
        const data = await res.json();

        const candles = [];
        if ((ex === "BN" || url.includes("binance")) && Array.isArray(data)) {
          for (const k of data) {
            candles.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] * +k[4] });
          }
        } else if (ex === "BB" && data?.result?.list) {
          for (const k of data.result.list) {
            candles.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] * +k[4] });
          }
          candles.reverse();
        } else if (ex === "OX" && data?.data) {
          for (const k of data.data) {
            candles.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] * +k[4] });
          }
          candles.reverse();
        } else if (ex === "BG" && Array.isArray(data?.data)) {
          for (const k of data.data) {
            candles.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] * +k[4] });
          }
          candles.reverse();
        } else if (ex === "GT" && Array.isArray(data)) {
          for (const k of data) {
            candles.push({ t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c });
          }
        } else if (ex === "MX" && Array.isArray(data?.data?.time)) {
          for (let i = 0; i < data.data.time.length; i++) {
            const c = +data.data.close[i];
            candles.push({
              t: +data.data.time[i] * 1000,
              o: +data.data.open[i],
              h: +data.data.high[i],
              l: +data.data.low[i],
              c,
              v: data.data.vol ? +data.data.vol[i] * c : 1000
            });
          }
        } else if (ex === "BX" && Array.isArray(data?.data)) {
          for (const k of data.data) {
            const closeP = +(k.close || k.c || 0);
            candles.push({
              t: +(k.time || k.t || 0),
              o: +(k.open || k.o || 0),
              h: +(k.high || k.h || 0),
              l: +(k.low || k.l || 0),
              c: closeP,
              v: +(k.volume || k.v || 0) * closeP
            });
          }
        } else if (ex === "KC" && Array.isArray(data?.data)) {
          for (const k of data.data) {
            candles.push({ t: +k[0] * 1000, o: +k[1], c: +k[2], h: +k[3], l: +k[4], v: +k[5] * +k[2] });
          }
          candles.reverse();
        } else if (ex === "HT" && Array.isArray(data?.data)) {
          for (const k of data.data) {
            candles.push({ t: +k.id * 1000, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.vol });
          }
          candles.reverse();
        }

        if (candles.length >= 5) return candles;
      } catch (_) {}
    }

    return null;
  } catch (_) {
    return null;
  }
}

let broadcastAlertFn = null;
let sendUserAlertFn = null;

// ── 1. Price History Sampling ───────────────────────────────────────────────
function sampleTickers() {
  if (!tickersMap) return;
  const now = Date.now();

  for (const t of tickersMap.values()) {
    try {
      if (!t || !t.key) continue;
      priceHistory.push(t.key, now, t.p);
    } catch (err) {
      // Same rationale as the scan loop: one bad entry must not cost the whole
      // sampling pass, which would blind pump/dump detection for every symbol.
      console.warn(`[ALERT ENGINE] Sampling failed for a ticker: ${err.message}`);
    }
  }

  // Reclaim keys for symbols that stopped ticking (delistings, renamed pairs).
  if (now - lastHistoryPruneAt > 10 * 60 * 1000) {
    lastHistoryPruneAt = now;
    priceHistory.pruneStale(now, HISTORY_KEY_TTL_MS);
  }
}

// ── 2. Get All Active Alert Subscribers (Cached for 2.5s for zero CPU overhead) ──
let cachedSubscribers = null;
let lastSubscribersFetch = 0;

function getAllAlertSubscribers() {
  const now = Date.now();
  if (cachedSubscribers && (now - lastSubscribersFetch < 2500)) {
    return cachedSubscribers;
  }

  const subscribers = [];
  const seenChatIds = new Set();

  const adminChatId = String(process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_ID || "").trim();

  const getUsersFn = userStoreModule && (typeof userStoreModule.getAllUsersRaw === "function" ? userStoreModule.getAllUsersRaw : (typeof userStoreModule.getAllUsers === "function" ? userStoreModule.getAllUsers : null));
  if (getUsersFn) {
    const allUsers = getUsersFn.call(userStoreModule) || {};
    for (const u of Object.values(allUsers)) {
      if (!u || u.blocked) continue;
      const chatId = String(u.telegramChatId || u.telegramId || "").trim();
      if (!chatId) continue;

      const isAdminUser = adminChatId && (chatId === adminChatId || String(u.id) === "admin" || u.role === "admin");
      const prefs = u.preferences || {};
      const notifPrefs = prefs.notifications || u.notificationSettings || {};
      const pdUserPrefs = notifPrefs.pumpDump || notifPrefs.pumpAlerts || prefs.pumpAlerts || prefs.pumpDump || u.pumpAlerts || {};

      // If user is admin, alerts in telegram are always active
      const tgEnabled = isAdminUser
        ? true
        : (pdUserPrefs.tgEnabled !== undefined
            ? !!pdUserPrefs.tgEnabled
            : (notifPrefs.tgEnabled !== undefined
                ? !!notifPrefs.tgEnabled
                : (u.tgAlertsEnabled === true)));

      if (!tgEnabled) continue;

      const userMinPct = Number(pdUserPrefs.minPct) || (isAdminUser ? 5.0 : 3.0);
      const userPeriod = Number(pdUserPrefs.periodMinutes) || (isAdminUser ? 1 : 5);

      const pumpDump = {
        ...DEFAULT_USER_ALERT_SETTINGS.pumpDump,
        ...pdUserPrefs,
        enabled: pdUserPrefs.enabled !== undefined ? !!pdUserPrefs.enabled : true,
        minPct: userMinPct,
        periodMinutes: userPeriod,
        exchanges: pdUserPrefs.exchanges === undefined
          ? (isAdminUser ? ["BN"] : ["all"])
          : normalizeExchanges(pdUserPrefs.exchanges)
      };

      const priceAlerts = Array.isArray(u.priceAlerts) ? u.priceAlerts : (Array.isArray(prefs.priceAlerts) ? prefs.priceAlerts : []);

      seenChatIds.add(chatId);
      subscribers.push({
        userId: u.id,
        chatId: chatId,
        pumpDump,
        priceAlerts,
        formationAlerts: notifPrefs.formationAlerts || prefs.formationAlerts || DEFAULT_USER_ALERT_SETTINGS.formationAlerts
      });
    }
  }

  if (adminChatId && !seenChatIds.has(adminChatId)) {
    // Read admin alert preferences: prioritize admin user record, then admin_settings.json
    let adminExchanges = ["BN"];
    let adminMinPct = 5.0;
    let adminPeriod = 1;
    let adminDirection = "both";
    let adminMarket = "futures";

    // Check if any registered user has matching admin credentials
    if (getUsersFn) {
      try {
        const allUsers = getUsersFn.call(userStoreModule) || {};
        for (const u of Object.values(allUsers)) {
          if (String(u.telegramChatId || u.telegramId || "").trim() === adminChatId || String(u.id) === "admin") {
            const uPrefs = u.preferences?.pumpAlerts || u.preferences?.notifications?.pumpDump || {};
            if (uPrefs.minPct !== undefined) adminMinPct = Number(uPrefs.minPct) || 5.0;
            if (uPrefs.periodMinutes !== undefined) adminPeriod = Number(uPrefs.periodMinutes) || 1;
            if (uPrefs.exchanges) adminExchanges = normalizeExchanges(uPrefs.exchanges);
            if (uPrefs.direction) adminDirection = uPrefs.direction;
            if (uPrefs.marketType) adminMarket = uPrefs.marketType;
            break;
          }
        }
      } catch (_) {}
    }

    // Also read from admin_settings.json
    try {
      const _fs = require("fs"), _path = require("path");
      const _raw = JSON.parse(_fs.readFileSync(_path.join(__dirname, "admin_settings.json"), "utf8"));
      if (Array.isArray(_raw.alertExchanges) && _raw.alertExchanges.length > 0) {
        adminExchanges = normalizeExchanges(_raw.alertExchanges);
      }
      if (_raw.alertMinPct !== undefined) adminMinPct = Number(_raw.alertMinPct) || 5.0;
      if (_raw.alertPeriodMinutes !== undefined) adminPeriod = Number(_raw.alertPeriodMinutes) || 1;
      if (_raw.alertDirection !== undefined) adminDirection = _raw.alertDirection;
      if (_raw.alertMarketType !== undefined) adminMarket = _raw.alertMarketType;
    } catch (_) { /* keep defaults */ }

    subscribers.push({
      userId: "admin",
      chatId: adminChatId,
      pumpDump: {
        ...DEFAULT_USER_ALERT_SETTINGS.pumpDump,
        enabled: true,
        minPct: adminMinPct,
        periodMinutes: adminPeriod,
        exchanges: adminExchanges,
        direction: adminDirection,
        marketType: adminMarket
      },
      priceAlerts: [],
      formationAlerts: { enabled: true }
    });
  }


  cachedSubscribers = subscribers;
  lastSubscribersFetch = now;
  return subscribers;
}

// Build authentic candles from in-memory recorded price history if exchange APIs fail
function buildCandlesFromHistory(ex, sym, tf = "1m") {
  const key = `${ex}:${sym}`;
  let hist = priceHistory.toSeries(key);
  if (hist.length < 2) hist = priceHistory.toSeries(`${ex}:${sym.replace(/_SPOT$/i, "")}`);
  if (hist.length < 2) return null;

  // Buckets must not be finer than the sampling resolution, otherwise most
  // buckets hold a single sample and the chart looks like a staircase.
  const tfMs = tf === "15m" ? 900000 : (tf === "5m" ? 300000 : 60000);
  const buckets = new Map();

  for (const pt of hist) {
    const bucketStart = Math.floor(pt.t / tfMs) * tfMs;
    let b = buckets.get(bucketStart);
    if (!b) {
      b = { t: bucketStart, o: pt.p, h: pt.p, l: pt.p, c: pt.p, v: 1000 };
      buckets.set(bucketStart, b);
    } else {
      if (pt.p > b.h) b.h = pt.p;
      if (pt.p < b.l) b.l = pt.p;
      b.c = pt.p;
    }
  }

  let candles = Array.from(buckets.values()).sort((a, b) => a.t - b.t);
  if (candles.length === 0) return null;
  // Never invent a flat past for a young instrument. Fake padding made a real
  // MEXC impulse look like one absurd candle after twenty identical bars.
  candles.sourceTf = tf;
  return candles;
}

function alertTimeframeMs(tf) {
  return tf === "15m" ? 900000 : tf === "5m" ? 300000 : tf === "1h" ? 3600000 : 60000;
}

function normalizeAlertCandles(input) {
  if (!Array.isArray(input)) return null;
  const byTime = new Map();
  for (const raw of input) {
    let t = Number(raw?.t);
    if (t > 0 && t < 1e11) t *= 1000;
    const candle = {
      t,
      o: Number(raw?.o),
      h: Number(raw?.h),
      l: Number(raw?.l),
      c: Number(raw?.c),
      v: Number.isFinite(Number(raw?.v)) && Number(raw.v) >= 0 ? Number(raw.v) : 0,
    };
    if (!(candle.t > 0 && candle.o > 0 && candle.h > 0 && candle.l > 0 && candle.c > 0)) continue;
    if (candle.h < Math.max(candle.o, candle.c) || candle.l > Math.min(candle.o, candle.c) || candle.h < candle.l) continue;
    byTime.set(candle.t, candle);
  }
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  return candles.length ? candles : null;
}

function hasCurrentTail(candles, tf, now) {
  if (!Array.isArray(candles) || !candles.length) return false;
  const lastT = Number(candles[candles.length - 1]?.t) || 0;
  return lastT > 0 && now - lastT <= alertTimeframeMs(tf) + 90000;
}

// Helper to fetch chart candles fast (cached first, non-blocking fallback)
async function getCandlesForAlert(ex, sym, targetTf) {
  try {
    let candles = null;
    let sourceTf = targetTf;
    const now = Date.now();

    // 1. Instant check: is it in server klinesCache and fresh (< 2 mins)? (0ms)
    if (typeof fetchCandlesFn === "function") {
      const cached = await fetchCandlesFn(ex, sym, targetTf);
      const normalized = normalizeAlertCandles(cached);
      if (normalized && normalized.length >= 10 && hasCurrentTail(normalized, targetTf, now)) {
        candles = normalized;
      }
    }

    // 2. Direct exchange REST API (Binance Futures/Spot, Bybit, OKX, Bitget, Gate, etc.)
    if (!Array.isArray(candles) || candles.length < 10) {
      const direct = normalizeAlertCandles(await fetchDirectExchangeCandles(ex, sym, targetTf));
      if (direct && hasCurrentTail(direct, targetTf, now)) candles = direct;
    }

    // 3. If coin is newly listed or few candles (< 30) and timeframe is > 1m, try 1m candles for better resolution
    if ((!Array.isArray(candles) || candles.length < 30) && targetTf !== "1m") {
      const candles1m = normalizeAlertCandles(await fetchDirectExchangeCandles(ex, sym, "1m"));
      if (Array.isArray(candles1m) && candles1m.length > (candles ? candles.length : 0)) {
        candles = candles1m;
        sourceTf = "1m";
      }
    }

    // 4. In-memory history fallback. For a young 5m/15m instrument, use real
    // 1m buckets instead of fabricating older candles at the requested period.
    if (!Array.isArray(candles) || candles.length < 5) {
      const fallbackTf = "1m";
      const historyCandles = buildCandlesFromHistory(ex, sym, fallbackTf);
      if (Array.isArray(historyCandles) && historyCandles.length >= 5) {
        candles = historyCandles;
        sourceTf = fallbackTf;
      } else {
        candles = null;
      }
    }

    // Ensure all numeric fields are proper Numbers and synced with live ticker price
    if (Array.isArray(candles) && candles.length >= 3) {
      const mapped = normalizeAlertCandles(candles);
      if (!mapped || mapped.length < 5 || !hasCurrentTail(mapped, sourceTf, now)) return null;
      // Sync last candle close with live ticker price
      const t = tickersMap ? tickersMap.get(`${ex}:${sym}`) : null;
      if (t && t.p > 0 && mapped.length > 0) {
        const last = mapped[mapped.length - 1];
        last.c = t.p;
        if (t.p > last.h) last.h = t.p;
        if (t.p < last.l) last.l = t.p;
      }
      mapped.sourceTf = sourceTf;
      return mapped;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// ── 3. Scan Pump / Dump for Subscribers (With Fast Ultra-HD Charts & WS Push) ──
let isScanningPD = false;

async function scanPumpDump() {
  if (!tickersMap || isScanningPD) return;
  isScanningPD = true;

  try {
    const subscribers = getAllAlertSubscribers();
    const now = Date.now();
    const activeSubscribers = subscribers.filter(s => s.pumpDump && s.pumpDump.enabled);

    // If no subscribers and no WS clients, return early
    if (!activeSubscribers.length && !broadcastAlertFn) return;

  for (const t of tickersMap.values()) {
    try {
      processTicker(t, now, activeSubscribers);
    } catch (err) {
      // Isolate per ticker: a single malformed entry must not abort the
      // remaining thousands for this tick. The key is read defensively because
      // reading it is itself what may have thrown.
      let label = "unknown";
      try { label = String(t && t.key) || "unknown"; } catch (_) {}
      console.warn(`[ALERT ENGINE] Ticker scan failed for ${label}: ${err.message}`);
    }
  }

  } catch (err) {
    console.error("[ALERT ENGINE SCAN ERROR]", err);
  } finally {
    isScanningPD = false;
  }
}

function processTicker(t, now, activeSubscribers) {
  if (!t || !t.key || !t.p || t.p <= 0 || !Number.isFinite(t.p)) return;
  now = now || Date.now();
  if (!activeSubscribers) {
    const subscribers = getAllAlertSubscribers();
    activeSubscribers = subscribers.filter(s => s.pumpDump && s.pumpDump.enabled);
  }

  const [exCode, sym] = t.key.split(":");
  if (!exCode || !sym) return;

  // Filter out non-crypto or stock
  if (!/^[A-Za-z0-9_\-]+$/.test(sym)) return;
  if (typeof isNonCryptoOrStockFn === "function" && isNonCryptoOrStockFn(null, sym)) return;

  const sampleCount = priceHistory.sampleCount(t.key);
  if (sampleCount < 2) return;

  const isSpot = sym.endsWith("_SPOT") || sym.includes("_SPOT");
  let movementSamples = null;
  const analysisCache = new Map();
  const confirmationCache = new Map();

  function analyzeFor(periodMins, minPct, direction) {
    const cacheKey = `${periodMins}|${minPct}|${direction}`;
    if (analysisCache.has(cacheKey)) return analysisCache.get(cacheKey);
    if (!movementSamples) {
      movementSamples = priceHistory.toSeries(t.key);
      const last = movementSamples[movementSamples.length - 1];
      if (last && Math.abs(now - last.t) <= 2_000) movementSamples[movementSamples.length - 1] = { t: now, p: t.p };
      else movementSamples.push({ t: now, p: t.p });
    }
    const analysis = analyzeMove(movementSamples, {
      now,
      periodMs: periodMins * 60 * 1000,
      minPct,
      volume: t.v || 0,
      direction
    });
    analysisCache.set(cacheKey, analysis);
    return analysis;
  }

  function isConfirmed(periodMins, analysis) {
    if (!analysis || !analysis.accepted) return false;
    const cacheKey = `${periodMins}|${analysis.direction}`;
    if (!confirmationCache.has(cacheKey)) {
      confirmationCache.set(cacheKey, signalConfirmationGate.observe(
        `${t.key}:${periodMins}`,
        analysis.direction,
        now,
        analysis.pct
      ));
    }
    return confirmationCache.get(cacheKey);
  }

  // Check matching subscribers for this ticker
  const matchingSubs = [];

  for (const sub of activeSubscribers) {
    const pd = sub.pumpDump;
    const periodMins = Number(pd.periodMinutes) || 5;
    const minPct = Number(pd.minPct) || 3;
    const minVol = Number(pd.minVolume) || 0;
    const cooldownMs = (Number(pd.cooldownSeconds) || 300) * 1000;
    const dirFilter = pd.direction || "both";
    const marketFilter = pd.marketType || "both";

    if (!isExchangeAllowed(exCode, pd.exchanges)) continue;
    if (minVol > 0 && (t.v || 0) < minVol) continue;
    if (marketFilter === "futures" && isSpot) continue;
    if (marketFilter === "spot" && !isSpot) continue;

    const analysis = analyzeFor(periodMins, minPct, dirFilter);
    if (!analysis.accepted || !isConfirmed(periodMins, analysis)) continue;
    const pctChange = analysis.pct;
    const isPump = analysis.direction === "pump";

    const cooldownKey = `${sub.chatId}:${t.key}:${isPump ? "pump" : "dump"}`;
    const oppCooldownKey = `${sub.chatId}:${t.key}:${isPump ? "dump" : "pump"}`;
    const baseCooldownKey = `${sub.chatId}:${t.key}`;
    const lastFired = cooldownTracker.get(cooldownKey) || 0;
    const lastOppFired = cooldownTracker.get(oppCooldownKey) || 0;
    const lastBaseFired = cooldownTracker.get(baseCooldownKey) || 0;
    if (now - lastFired < cooldownMs) continue;
    if (now - lastOppFired < 120000) continue; // Whipsaw protection (opp direction within 2m)
    if (now - lastBaseFired < 60000) continue; // Min 60s cooldown per symbol

    // Arm the cooldown provisionally so concurrent 400ms ticks cannot dispatch
    // the same alert twice while this one is still in flight. On a failed
    // delivery it is shortened to a brief retry window (see below) rather
    // than left in place, so the alert is neither lost nor spammed.
    cooldownTracker.set(cooldownKey, now);
    cooldownTracker.set(baseCooldownKey, now);
    matchingSubs.push({
      sub,
      pctChange,
      pastPrice: analysis.referencePrice,
      isPump,
      periodMins,
      cooldownKey,
      baseCooldownKey,
      cooldownMs,
      quality: analysis.quality,
      referenceTs: analysis.referenceTime
    });
  }

  // Send targeted WebSocket alerts to matching subscribers' accounts
  if (matchingSubs.length > 0) {
    for (const entry of matchingSubs) {
      if (entry.sub && entry.sub.userId) {
        const userWsKey = `ws:${entry.sub.userId}:${t.key}:${entry.isPump ? "pump" : "dump"}`;
        const lastUserWsSent = cooldownTracker.get(userWsKey) || 0;
        if (now - lastUserWsSent >= Math.min(entry.cooldownMs, 30000)) {
          cooldownTracker.set(userWsKey, now);
          const userAlertData = {
            key: t.key,
            ex: exCode,
            sym: sym.replace("_SPOT", ""),
            market: isSpot ? "spot" : "futures",
            pct: Math.round(entry.pctChange * 100) / 100,
            price: t.p,
            pastPrice: entry.pastPrice,
            vol: t.v || 0,
            bars: entry.periodMins,
            quality: entry.quality,
            referenceTs: entry.referenceTs,
            ts: now,
            targetUserId: entry.sub.userId
          };
          if (typeof sendUserAlertFn === "function") {
            sendUserAlertFn(entry.sub.userId, "pump_dump_alert", userAlertData);
          } else if (typeof broadcastAlertFn === "function") {
            broadcastAlertFn("pump_dump_alert", userAlertData);
          }
        }
      }
    }
  }

  // Public real-time feed uses the same path-quality and persistence checks as
  // account alerts; no second, weaker detector can leak noisy signals.
  const coinVol = t.v || 0;
  const wsAnalysis = analyzeFor(5, 2.5, "both");
  const shouldBroadcastWs = coinVol >= 50_000 && wsAnalysis.accepted && isConfirmed(5, wsAnalysis);

  if (shouldBroadcastWs && typeof broadcastAlertFn === "function") {
    const wsPct = wsAnalysis.pct;
    if (Math.abs(wsPct) <= 200 && wsPct > -75 && Number.isFinite(wsPct)) {
      const wsIsPump = wsPct > 0;
      const baseKey = `ws:${t.key}`;
      const wsKey = `${baseKey}:${wsIsPump ? "pump" : "dump"}`;
      const oppKey = `${baseKey}:${wsIsPump ? "dump" : "pump"}`;
      const lastWsSent = cooldownTracker.get(wsKey) || 0;
      const lastOppSent = cooldownTracker.get(oppKey) || 0;
      const lastBaseSent = cooldownTracker.get(baseKey) || 0;

      // 60s min symbol cooldown, 120s per direction, 180s opposite-direction whipsaw guard
      if (now - lastBaseSent >= 60000 && now - lastWsSent >= 120000 && now - lastOppSent >= 180000) {
        cooldownTracker.set(baseKey, now);
        cooldownTracker.set(wsKey, now);
        broadcastAlertFn("pump_dump_alert", {
          key: t.key,
          ex: exCode,
          // The display symbol drops the `_SPOT` marker, so `market` has to carry
          // the instrument type explicitly. Without it the browser could not tell
          // a spot alert from a futures one and its "futures only" setting was
          // silently bypassed for every push alert.
          sym: sym.replace("_SPOT", ""),
          market: isSpot ? "spot" : "futures",
          pct: Math.round(wsPct * 100) / 100,
          price: t.p,
          pastPrice: wsAnalysis.referencePrice,
          vol: t.v || 0,
          bars: 5,
          quality: wsAnalysis.quality,
          referenceTs: wsAnalysis.referenceTime,
          ts: now
        });
      }
    }
  }

  if (matchingSubs.length === 0) return;

  pruneCooldownTracker(now);

  // Process and dispatch matching Telegram alerts asynchronously
  (async () => {
    const exFull = getExchangeFullName(exCode);
    const cleanSym = sym.replace("_SPOT", "");
    const timeStr = new Date().toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    // Render once for all matching subscribers. Exchange candle APIs commonly
    // take several seconds under load, so allow the real upstream timeouts to
    // finish instead of prematurely degrading the alert to text-only.
    let photoBuffer = null;
    if (serverChartRenderer && typeof serverChartRenderer.renderServerChartSnapshot === "function") {
      try {
        const primary = matchingSubs[0];
        const primaryPeriod = primary ? primary.periodMins : 5;
        const chartTask = (async () => {
          const targetTf = primaryPeriod >= 60 ? "1h" : (primaryPeriod >= 15 ? "15m" : (primaryPeriod >= 5 ? "5m" : "1m"));
          const tfStr = primaryPeriod >= 60 ? `${(primaryPeriod / 60).toFixed(0)}H` : `${primaryPeriod}M`;
          const candles = await getCandlesForAlert(exCode, sym, targetTf);
          if (Array.isArray(candles) && candles.length >= 5) {
            const meta = {
              ex: exCode,
              sym: cleanSym,
              tf: candles.sourceTf ? candles.sourceTf.toUpperCase() : tfStr,
              vol: t.v || 0,
              chg: t.chg !== undefined ? t.chg : (primary ? primary.pctChange : 0),
              funding: t.funding,
              natr: (t.h && t.l && t.p > 0) ? ((t.h - t.l) / t.p) * 100 : undefined
            };
            const signal = {
              type: (primary && primary.isPump) ? "pump" : "dump",
              direction: (primary && primary.isPump) ? "long" : "short",
              price: t.p,
              meta: { pctChange: primary ? primary.pctChange : 0, pastPrice: primary ? primary.pastPrice : t.p, periodMinutes: primaryPeriod, vol: t.v || 0 }
            };
            return serverChartRenderer.renderServerChartSnapshot(candles, meta, signal);
          }
          return null;
        })();
        let chartTimer = null;
        const chartTimeout = new Promise(resolve => {
          chartTimer = setTimeout(() => resolve(null), CHART_RENDER_BUDGET_MS);
          if (chartTimer && typeof chartTimer.unref === "function") chartTimer.unref();
        });
        photoBuffer = await Promise.race([chartTask, chartTimeout]);
        if (chartTimer) clearTimeout(chartTimer);
        if (photoBuffer) {
          console.log(`[ALERT ENGINE] Rendered chart for ${exCode}:${cleanSym} (${photoBuffer.length} bytes)`);
        } else {
          console.warn(`[ALERT ENGINE] Chart generation skipped or timed out for ${exCode}:${cleanSym}`);
        }
      } catch (err) {
        console.warn("[ALERT ENGINE] Chart render error:", err.message);
      }
    }

    // Pump/dump notifications are only useful with visual price confirmation.
    // If candle acquisition or rendering failed, defer the alert so the next
    // scan retries it; never emit a text-only substitute.
    if (!Buffer.isBuffer(photoBuffer) || photoBuffer.length === 0) {
      const retryAt = Date.now();
      for (const entry of matchingSubs) {
        cooldownTracker.set(entry.cooldownKey, retryAt - entry.cooldownMs + CHART_FAILED_RETRY_MS);
        cooldownTracker.set(entry.baseCooldownKey, retryAt - 60_000 + CHART_FAILED_RETRY_MS);
      }
      console.warn(`[ALERT ENGINE] Pump/dump alert deferred for ${exCode}:${cleanSym}; chart is required`);
      return;
    }

    // Dispatch to all matching subscribers. Every subscriber gets a message formatted
    // strictly with their OWN account-configured period and percentage change.
    for (const entry of matchingSubs) {
      const entryIsPump = entry.isPump;
      const entryPeriodMins = entry.periodMins;
      const entryPctChange = entry.pctChange;
      const entryPastPrice = entry.pastPrice;
      const entryIcon = entryIsPump ? "🟢" : "🔴";
      const entryTitle = entryIsPump ? "PUMP DETECTED" : "DUMP DETECTED";
      const entrySign = entryIsPump ? "+" : "";

      const msg =
        `${entryIcon} <b>${entryTitle} [${entrySign}${entryPctChange.toFixed(2)}%]</b>\n\n` +
        `• <b>Инструмент:</b> ${exFull} · <code>${cleanSym}</code>\n` +
        `• <b>Период:</b> ${entryPeriodMins} мин\n` +
        `• <b>Текущая цена:</b> $${formatPrice(t.p)}\n` +
        `• <b>Цена до импульса:</b> $${formatPrice(entryPastPrice)}\n` +
        `• <b>Объём 24ч:</b> ${formatVolume(t.v || 0)}\n` +
        `─────────────────────────\n` +
        `⚡ <b>Obsidian Screener</b>`;

      const groupToken = `pd:${t.key}:${entryIsPump ? "pump" : "dump"}:${entryPeriodMins}:${now}`;
      let delivered = false;
      try {
        const res = await sendTelegramAlert(entry.sub.chatId, msg, photoBuffer, null, groupToken, true);
        delivered = !!res;
      } catch (err) {
        console.warn(`[ALERT ENGINE] Send failed for ${entry.sub.chatId}: ${err.message}`);
      }
      if (!delivered) {
        // Shorten the cooldown to a brief retry window instead of consuming the
        // full one. Releasing it entirely would hot-loop against a dead
        // Telegram API on every 400ms tick.
        const retryAt = Date.now() - entry.cooldownMs + FAILED_SEND_RETRY_MS;
        cooldownTracker.set(entry.cooldownKey, retryAt);
        cooldownTracker.set(entry.baseCooldownKey, Date.now());
        console.warn(`[ALERT ENGINE] Alert not delivered to ${entry.sub.chatId} for ${t.key}; retry in ${Math.round(FAILED_SEND_RETRY_MS / 1000)}s`);
      }
    }
  })().catch(e => console.warn("[ALERT ENGINE] Dispatch error:", e.message));
}

// ── 4. Scan Price Level Alerts for Subscribers (With Authentic HD Charts) ───
let isScanningPriceAlerts = false;

async function scanPriceAlerts() {
  if (!tickersMap || isScanningPriceAlerts) return;
  isScanningPriceAlerts = true;

  try {
    const subscribers = getAllAlertSubscribers();
    if (!subscribers.length) return;

    const now = Date.now();

    for (const sub of subscribers) {
      if (!sub.priceAlerts || !sub.priceAlerts.length) continue;

      for (let i = sub.priceAlerts.length - 1; i >= 0; i--) {
        const alert = sub.priceAlerts[i];
        if (!alert || alert.triggered || !alert.targetPrice) continue;

        const ex = alert.ex || "BN";
        const sym = (alert.sym || "").toUpperCase();
        const key = `${ex}:${sym}`;

        const t = tickersMap.get(key);
        if (!t || !t.p || t.p <= 0) continue;

        const targetPrice = Number(alert.targetPrice);
        const curPrice = Number(t.p);
        const createdP = Number(alert.createdP || alert.startPrice || 0);

        let isHit = false;
        if (t.h && t.l && t.h >= targetPrice && t.l <= targetPrice) {
          isHit = true;
        } else if (Math.abs(curPrice - targetPrice) / targetPrice <= 0.001) {
          isHit = true;
        } else if (createdP > 0) {
          if (createdP < targetPrice && curPrice >= targetPrice) isHit = true;
          else if (createdP > targetPrice && curPrice <= targetPrice) isHit = true;
        }

        if (isHit) {
          // Mark as in-flight, not consumed: the alert is only removed from the
          // user's list once Telegram confirms delivery, so a failed send does
          // not destroy it.
          if (alert._dispatching) continue;
          alert._dispatching = true;

          const exFull = getExchangeFullName(ex);

          const msg =
            `🔔 <b>ЦЕЛЕВОЙ УРОВЕНЬ ДОСТИГНУТ!</b>\n\n` +
            `• <b>Инструмент:</b> ${exFull} · <code>${sym}</code>\n` +
            `• <b>Целевая цена:</b> $${formatPrice(targetPrice)}\n` +
            `• <b>Текущая цена:</b> $${formatPrice(curPrice)}\n` +
            `─────────────────────────\n` +
            `⚡ <b>Obsidian Screener</b>`;

          const targetAlert = alert;
          const targetSub = sub;

          (async () => {
            let photoBuffer = null;
            if (serverChartRenderer && typeof serverChartRenderer.renderServerChartSnapshot === "function") {
              try {
                const candles = await getCandlesForAlert(ex, sym, "15m");
                if (Array.isArray(candles) && candles.length >= 10) {
                  const meta = {
                    ex,
                    sym,
                    tf: candles.sourceTf ? candles.sourceTf.toUpperCase() : "15M",
                    vol: t.v || 0,
                    chg: t.chg || 0,
                    funding: t.funding,
                    natr: (t.h && t.l && t.p > 0) ? ((t.h - t.l) / t.p) * 100 : undefined
                  };
                  const signal = {
                    type: "price_level",
                    direction: curPrice >= targetPrice ? "long" : "short",
                    price: targetPrice,
                    meta: { targetPrice, curPrice, vol: t.v || 0 }
                  };
                  photoBuffer = serverChartRenderer.renderServerChartSnapshot(candles, meta, signal);
                }
              } catch (err) {
                console.warn(`[PRICE ALERT] Chart render failed for ${ex}:${sym}: ${err.message}`);
              }
            }

            let delivered = false;
            try {
              delivered = !!(await sendTelegramAlert(targetSub.chatId, msg, photoBuffer));
            } catch (err) {
              console.warn(`[PRICE ALERT] Send failed for ${targetSub.chatId}: ${err.message}`);
            }

            targetAlert._dispatching = false;
            if (!delivered) {
              console.warn(`[PRICE ALERT] Not delivered to ${targetSub.chatId} for ${ex}:${sym}; alert kept for retry`);
              return;
            }

            const idx = targetSub.priceAlerts.indexOf(targetAlert);
            if (idx >= 0) targetSub.priceAlerts.splice(idx, 1);
            persistPriceAlerts(targetSub);
          })().catch(err => {
            targetAlert._dispatching = false;
            console.warn("[PRICE ALERT] Dispatch error:", err.message);
          });
        }
      }
    }
  } catch (err) {
    console.error("[PRICE ALERT SCAN ERROR]", err);
  } finally {
    isScanningPriceAlerts = false;
  }
}

function persistPriceAlerts(sub) {
  if (!userStoreModule || !sub || !sub.userId || sub.userId === "admin") return;
  try {
    const stored = sub.priceAlerts.map(a => {
      const { _dispatching, ...rest } = a;
      return rest;
    });
    const u = userStoreModule.findUser(sub.userId);
    if (u) u.priceAlerts = stored;
    userStoreModule.updateUserPreferences(sub.userId, { priceAlerts: stored });
  } catch (err) {
    console.warn(`[ALERT ENGINE] Failed to persist alerts for ${sub.userId}: ${err.message}`);
  }
}

// ── 5. Main Alert Engine Initialization & Loop ─────────────────────────────
let samplingTimer = null;
let scanningTimer = null;

function stop() {
  if (samplingTimer) {
    clearInterval(samplingTimer);
    samplingTimer = null;
  }
  if (scanningTimer) {
    clearInterval(scanningTimer);
    scanningTimer = null;
  }
}

function init(options = {}) {
  tickersMap = options.tickers || null;
  telegramBotModule = options.telegramBot || null;
  userStoreModule = options.userStore || null;
  fetchCandlesFn = options.fetchCandles || null;
  isNonCryptoOrStockFn = options.isNonCryptoOrStock || null;
  broadcastAlertFn = typeof options.broadcastAlert === "function" ? options.broadcastAlert : null;
  sendUserAlertFn = typeof options.sendUserAlert === "function" ? options.sendUserAlert : null;
  cachedSubscribers = null;
  lastSubscribersFetch = 0;
  cooldownTracker.clear();
  signalConfirmationGate.clear();

  stop();

  samplingTimer = setInterval(() => {
    try {
      sampleTickers();
    } catch (err) {
      console.error("[ALERT ENGINE SAMPLER ERROR]", err.message);
    }
  }, 1000);
  if (samplingTimer && typeof samplingTimer.unref === "function") samplingTimer.unref();

  // Both scans are async and self-guarded against re-entry; attach a catch so a
  // rejection cannot escape as an unhandled promise rejection.
  scanningTimer = setInterval(() => {
    scanPumpDump().catch(err => console.error("[ALERT ENGINE PD ERROR]", err.message));
    scanPriceAlerts().catch(err => console.error("[ALERT ENGINE PRICE ERROR]", err.message));
  }, 1000);
  if (scanningTimer && typeof scanningTimer.unref === "function") scanningTimer.unref();

  console.log("⚡ [ALERT ENGINE] Ultra-Fast Real-Time 24/7 Background Alert Engine initialized (1000ms cycle).");
}

module.exports = {
  init,
  stop,
  processTicker,
  sampleTickers,
  scanPumpDump,
  scanPriceAlerts,
  sendTelegramMessage,
  sendTelegramAlert,
  getCandlesForAlert,
  getQueueStats: telegramQueue.getStats,
  priceHistory,
  getHistoryStats: () => priceHistory.stats(),
  DEFAULT_USER_ALERT_SETTINGS
};
