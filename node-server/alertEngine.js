"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// alertEngine.js — 24/7 Background Server-Side Alert Engine with Ultra-HD Charts
// Operates 24/7 even when user browsers are completely closed / offline.
// ═══════════════════════════════════════════════════════════════════════════════

const https = require("https");

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

// Ring buffer of price history per key "EX:SYM"
// Map<string, Array<{ t: number, p: number }>>
const priceHistoryMap = new Map();
const MAX_HISTORY_MS = 4 * 60 * 60 * 1000; // 4 hours history

// Cooldown tracker per chatId:key
// Map<string, number> (key: `${chatId}:${ex}:${sym}:${type}`) -> timestamp
const cooldownTracker = new Map();

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

  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN;
  if (!botToken) return false;

  if (userStoreModule && typeof userStoreModule.isTelegramAlertsEnabled === "function") {
    if (!userStoreModule.isTelegramAlertsEnabled(chatId)) {
      return false;
    }
  }

  if (telegramBotModule && typeof telegramBotModule.sendTelegramMessage === "function") {
    try {
      const res = await telegramBotModule.sendTelegramMessage(chatId, text);
      if (res && res.ok) return true;
    } catch (_) {}
  }

  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });

      const req = https.request(
        {
          hostname: "api.telegram.org",
          port: 443,
          path: `/bot${botToken}/sendMessage`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          },
          timeout: 8000
        },
        (res) => {
          let data = "";
          res.on("data", chunk => data += chunk);
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve(!!parsed.ok);
            } catch (_) {
              resolve(false);
            }
          });
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.write(payload);
      req.end();
    } catch (_) {
      resolve(false);
    }
  });
}

// Full helper to send Photo (with chart) or fallback to text
async function sendTelegramAlert(chatId, text, photoBuffer = null) {
  if (!chatId || !text) return false;

  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.ADMIN_BOT_TOKEN;
  if (!botToken) return false;

  if (userStoreModule && typeof userStoreModule.isTelegramAlertsEnabled === "function") {
    if (!userStoreModule.isTelegramAlertsEnabled(chatId)) {
      return false;
    }
  }

  if (photoBuffer && Buffer.isBuffer(photoBuffer)) {
    try {
      const blob = new Blob([photoBuffer], { type: "image/png" });
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("caption", text);
      form.append("parse_mode", "HTML");
      form.append("photo", blob, "chart_alert.png");

      const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(10000)
      });
      const parsed = await tgRes.json();
      if (parsed.ok) {
        return true;
      }
      console.warn("[ALERT ENGINE] sendPhoto fail:", parsed.description);
    } catch (e) {
      console.warn("[ALERT ENGINE] sendPhoto error:", e.message);
    }
  }

  return sendTelegramMessage(chatId, text);
}

// ── Direct Exchange Real Klines Fetcher (Fallback if server cache misses) ────
async function fetchDirectExchangeCandles(ex, sym, tf = "1m") {
  try {
    let cleanSym = sym.replace("_SPOT", "");
    let url = "";

    if (ex === "BN") {
      url = `https://fapi.binance.com/fapi/v1/klines?symbol=${cleanSym}&interval=${tf}&limit=100`;
    } else if (ex === "BB") {
      const bybitTf = tf === "1m" ? "1" : tf === "5m" ? "5" : tf === "15m" ? "15" : tf === "1h" ? "60" : "5";
      url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${cleanSym}&interval=${bybitTf}&limit=100`;
    } else if (ex === "OX") {
      const oxSym = cleanSym.includes("-") ? cleanSym : `${cleanSym.replace(/USDT$/, "")}-USDT-SWAP`;
      url = `https://www.okx.com/api/v5/market/candles?instId=${oxSym}&bar=${tf}&limit=100`;
    } else if (ex === "BG") {
      const bgSym = cleanSym.endsWith("USDT") ? `${cleanSym}_UMCBL` : cleanSym;
      url = `https://api.bitget.com/api/v2/mix/market/candles?symbol=${bgSym}&granularity=${tf}&limit=100`;
    } else if (ex === "GT") {
      url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${cleanSym}&interval=${tf}&limit=100`;
    }

    if (!url) return null;

    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    const data = await res.json();

    const candles = [];
    if (ex === "BN" && Array.isArray(data)) {
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
    }

    return candles.length >= 10 ? candles : null;
  } catch (_) {
    return null;
  }
}

// ── 1. Price History Sampling ───────────────────────────────────────────────
function sampleTickers() {
  if (!tickersMap) return;
  const now = Date.now();

  for (const t of tickersMap.values()) {
    if (!t || !t.key || !t.p || t.p <= 0) continue;

    let hist = priceHistoryMap.get(t.key);
    if (!hist) {
      hist = [];
      priceHistoryMap.set(t.key, hist);
    }

    const last = hist[hist.length - 1];
    if (!last || (now - last.t >= 3000) || (Math.abs(t.p - last.p) / last.p >= 0.0005)) {
      hist.push({ t: now, p: t.p });
    }

    const cutoff = now - MAX_HISTORY_MS;
    while (hist.length > 2 && hist[0].t < cutoff) {
      hist.shift();
    }
  }
}

// ── 2. Get All Active Alert Subscribers ─────────────────────────────────────
function getAllAlertSubscribers() {
  const subscribers = [];
  const seenChatIds = new Set();

  if (userStoreModule && typeof userStoreModule.getAllUsersRaw === "function") {
    const allUsers = userStoreModule.getAllUsersRaw() || {};
    for (const u of Object.values(allUsers)) {
      if (!u || u.blocked) continue;
      const chatId = u.telegramChatId || u.telegramId;
      if (!chatId) continue;

      const prefs = (u.preferences && u.preferences.notifications) || {};
      const tgEnabled = prefs.tgEnabled !== undefined ? prefs.tgEnabled : (u.isTelegramAlertsEnabled !== false);

      if (!tgEnabled) continue;

      const pumpDump = {
        ...DEFAULT_USER_ALERT_SETTINGS.pumpDump,
        ...(prefs.pumpDump || {})
      };

      const priceAlerts = Array.isArray(u.priceAlerts) ? u.priceAlerts : (Array.isArray(prefs.priceAlerts) ? prefs.priceAlerts : []);

      seenChatIds.add(String(chatId));
      subscribers.push({
        userId: u.id,
        chatId: String(chatId),
        pumpDump,
        priceAlerts,
        formationAlerts: prefs.formationAlerts || DEFAULT_USER_ALERT_SETTINGS.formationAlerts
      });
    }
  }

  const adminChatId = String(process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_ID || "").trim();
  if (adminChatId && !seenChatIds.has(adminChatId)) {
    subscribers.push({
      userId: "admin",
      chatId: adminChatId,
      pumpDump: { ...DEFAULT_USER_ALERT_SETTINGS.pumpDump, enabled: true },
      priceAlerts: [],
      formationAlerts: { enabled: true }
    });
  }

  return subscribers;
}

// ── 3. Scan Pump / Dump for Subscribers (With Authentic Ultra-HD Charts) ────
async function scanPumpDump() {
  if (!tickersMap) return;
  const subscribers = getAllAlertSubscribers();
  if (!subscribers.length) return;

  const now = Date.now();

  for (const sub of subscribers) {
    const pd = sub.pumpDump;
    if (!pd || !pd.enabled) continue;

    const periodMins = Number(pd.periodMinutes) || 5;
    const periodMs = periodMins * 60 * 1000;
    const minPct = Number(pd.minPct) || 3;
    const minVol = Number(pd.minVolume) || 0;
    const cooldownMs = (Number(pd.cooldownSeconds) || 300) * 1000;
    const dirFilter = pd.direction || "both";
    const marketFilter = pd.marketType || "both";
    const allowedExs = Array.isArray(pd.exchanges) ? pd.exchanges : ["all"];
    const isAllEx = allowedExs.includes("all");

    for (const t of tickersMap.values()) {
      if (!t || !t.key || !t.p || t.p <= 0) continue;

      const [exCode, sym] = t.key.split(":");
      if (!exCode || !sym) continue;

      // Filter out non-crypto, stock or weird non-ASCII unicode glyph tokens
      if (!/^[A-Za-z0-9_\-]+$/.test(sym)) continue;
      if (typeof isNonCryptoOrStockFn === "function" && isNonCryptoOrStockFn(null, sym)) continue;

      if (!isAllEx && !allowedExs.includes(exCode)) continue;
      if (minVol > 0 && (t.v || 0) < minVol) continue;

      const isSpot = sym.includes("_SPOT") || (!sym.endsWith("USDT") && !sym.endsWith("PERP"));
      if (marketFilter === "futures" && isSpot) continue;
      if (marketFilter === "spot" && !isSpot) continue;

      const hist = priceHistoryMap.get(t.key);
      if (!hist || hist.length < 2) continue;

      const targetTime = now - periodMs;
      let pastPoint = hist[0];
      for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].t <= targetTime) {
          pastPoint = hist[i];
          break;
        }
      }

      if (!pastPoint || pastPoint.p <= 0) continue;

      const pctChange = ((t.p - pastPoint.p) / pastPoint.p) * 100;
      const absPct = Math.abs(pctChange);

      if (absPct < minPct) continue;

      const isPump = pctChange > 0;
      if (dirFilter === "pump" && !isPump) continue;
      if (dirFilter === "dump" && isPump) continue;

      const cooldownKey = `${sub.chatId}:${t.key}:${isPump ? "pump" : "dump"}`;
      const lastFired = cooldownTracker.get(cooldownKey) || 0;
      if (now - lastFired < cooldownMs) continue;

      cooldownTracker.set(cooldownKey, now);

      if (cooldownTracker.size > 10000) {
        for (const [k, ts] of cooldownTracker.entries()) {
          if (now - ts > 3600000) cooldownTracker.delete(k);
        }
      }

      const timeStr = new Date().toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const exFull = getExchangeFullName(exCode);
      const cleanSym = sym.replace("_SPOT", "");
      const icon = isPump ? "🟢" : "🔴";
      const title = isPump ? "PUMP DETECTED" : "DUMP DETECTED";
      const sign = isPump ? "+" : "";
      const tfStr = periodMins >= 60 ? `${(periodMins / 60).toFixed(0)}H` : `${periodMins}M`;

      const msg =
        `${icon} <b>${title} [${sign}${pctChange.toFixed(2)}%]</b>\n\n` +
        `• <b>Инструмент:</b> ${exFull} · <code>${cleanSym}</code>\n` +
        `• <b>Период:</b> ${periodMins} мин\n` +
        `• <b>Текущая цена:</b> $${formatPrice(t.p)}\n` +
        `• <b>Цена до импульса:</b> $${formatPrice(pastPoint.p)}\n` +
        `• <b>Объём 24ч:</b> ${formatVolume(t.v || 0)}\n` +
        `• <b>Время:</b> ${timeStr}\n` +
        `─────────────────────────\n` +
        `⚡ <b>Obsidian 24/7 Screener Radar</b>`;

      // Fetch 100% Real Exchange Candlesticks (First from server klinesCache, then direct exchange API)
      let photoBuffer = null;
      if (serverChartRenderer && typeof serverChartRenderer.renderServerChartSnapshot === "function") {
        try {
          let candles = null;
          const targetTf = periodMins >= 60 ? "1h" : (periodMins >= 15 ? "15m" : (periodMins >= 5 ? "5m" : "1m"));

          if (typeof fetchCandlesFn === "function") {
            candles = await fetchCandlesFn(exCode, sym, targetTf);
            if (!candles || candles.length < 15) {
              candles = await fetchCandlesFn(exCode, sym, "1m");
            }
          }

          if (!candles || candles.length < 15) {
            candles = await fetchDirectExchangeCandles(exCode, sym, targetTf);
          }

          if (Array.isArray(candles) && candles.length >= 10) {
            const meta = {
              ex: exCode,
              sym: cleanSym,
              tf: tfStr,
              vol: t.v || 0,
              chg: t.chg !== undefined ? t.chg : pctChange,
              funding: t.funding,
              natr: (t.h && t.l && t.p > 0) ? ((t.h - t.l) / t.p) * 100 : undefined
            };
            const signal = {
              type: isPump ? "pump" : "dump",
              direction: isPump ? "long" : "short",
              price: t.p,
              meta: { pctChange, pastPrice: pastPoint.p, periodMinutes: periodMins, vol: t.v || 0 }
            };
            photoBuffer = serverChartRenderer.renderServerChartSnapshot(candles, meta, signal);
          }

        } catch (err) {
          console.warn("[ALERT ENGINE] Chart render error:", err.message);
        }
      }

      sendTelegramAlert(sub.chatId, msg, photoBuffer).catch(() => {});
    }
  }
}

// ── 4. Scan Price Level Alerts for Subscribers (With Authentic HD Charts) ───
async function scanPriceAlerts() {
  if (!tickersMap) return;
  const subscribers = getAllAlertSubscribers();
  if (!subscribers.length) return;

  const now = Date.now();

  for (const sub of subscribers) {
    if (!sub.priceAlerts || !sub.priceAlerts.length) continue;

    let changed = false;

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
        alert.triggered = true;
        changed = true;

        const timeStr = new Date().toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const exFull = getExchangeFullName(ex);

        const msg =
          `🔔 <b>ЦЕЛЕВОЙ УРОВЕНЬ ДОСТИГНУТ!</b>\n\n` +
          `• <b>Инструмент:</b> ${exFull} · <code>${sym}</code>\n` +
          `• <b>Целевая цена:</b> $${formatPrice(targetPrice)}\n` +
          `• <b>Текущая цена:</b> $${formatPrice(curPrice)}\n` +
          `• <b>Время:</b> ${timeStr}\n` +
          `─────────────────────────\n` +
          `⚡ <b>Obsidian 24/7 Screener Radar</b>`;

        let photoBuffer = null;
        if (serverChartRenderer && typeof serverChartRenderer.renderServerChartSnapshot === "function") {
          try {
            let candles = null;
            if (typeof fetchCandlesFn === "function") {
              candles = await fetchCandlesFn(ex, sym, "15m");
              if (!candles || candles.length < 15) {
                candles = await fetchCandlesFn(ex, sym, "1m");
              }
            }
            if (!candles || candles.length < 15) {
              candles = await fetchDirectExchangeCandles(ex, sym, "15m");
            }

            if (Array.isArray(candles) && candles.length >= 10) {
              const meta = {
                ex,
                sym,
                tf: "15M",
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

          } catch (_) {}
        }

        sendTelegramAlert(sub.chatId, msg, photoBuffer).catch(() => {});
        sub.priceAlerts.splice(i, 1);
      }
    }

    if (changed && userStoreModule && sub.userId && sub.userId !== "admin") {
      try {
        const u = userStoreModule.findUser(sub.userId);
        if (u) {
          u.priceAlerts = sub.priceAlerts;
          userStoreModule.updateUserPreferences(sub.userId, { priceAlerts: sub.priceAlerts });
        }
      } catch (_) {}
    }
  }
}

// ── 5. Main Alert Engine Initialization & Loop ─────────────────────────────
let samplingTimer = null;
let scanningTimer = null;

function init(options = {}) {
  tickersMap = options.tickers || null;
  telegramBotModule = options.telegramBot || null;
  userStoreModule = options.userStore || null;
  fetchCandlesFn = options.fetchCandles || null;
  isNonCryptoOrStockFn = options.isNonCryptoOrStock || null;

  if (samplingTimer) clearInterval(samplingTimer);
  if (scanningTimer) clearInterval(scanningTimer);

  samplingTimer = setInterval(sampleTickers, 3000);

  scanningTimer = setInterval(() => {
    try {
      scanPumpDump();
      scanPriceAlerts();
    } catch (err) {
      console.error("[ALERT ENGINE ERROR]", err.message);
    }
  }, 4000);

  console.log("⚡ [ALERT ENGINE] 24/7 Authentic Ultra-HD Chart Background Alert Engine initialized successfully.");
}

module.exports = {
  init,
  sampleTickers,
  scanPumpDump,
  scanPriceAlerts,
  sendTelegramMessage,
  sendTelegramAlert,
  DEFAULT_USER_ALERT_SETTINGS
};
