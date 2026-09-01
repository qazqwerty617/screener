"use strict";

const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "correlation_cache.json");
const MAX_SAMPLES = 120; // 120 samples * 5s = 10 minutes of history
const SAMPLE_INTERVAL_MS = 5000;

const BTC_KEY = {
  BN: "BN:BTCUSDT",
  BB: "BB:BTCUSDT",
  OX: "OX:BTC-USDT-SWAP",
  BG: "BG:BTCUSDT",
  GT: "GT:BTC_USDT",
  MX: "MX:BTC_USDT",
  KC: "KC:XBTUSDTM",
  BX: "BX:BTC-USDT",
  HT: "HT:BTC-USDT",
  HL: "HL:BTC",
  AD: "AD:BTCUSDT",
};

function pearsonCorrelationAbs(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  const rx = x.slice(-n);
  const ry = y.slice(-n);

  let meanX = 0, meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += rx[i];
    meanY += ry[i];
  }
  meanX /= n;
  meanY /= n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

class CorrelationEngine {
  constructor() {
    this.priceHistories = new Map(); // key -> [price1, price2, ...]
    this.correlationMap = new Map(); // key -> integer (-100 to 100)
    this.tickers = null;
    this.broadcastFn = null;
    this.timer = null;
    this.saveTimer = null;
  }

  init(tickers, broadcastFn) {
    this.tickers = tickers;
    this.broadcastFn = broadcastFn;

    this.loadCache();

    // Start 5-second sampling & calculation loop
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), SAMPLE_INTERVAL_MS);
    this.timer.unref();

    // Periodic state save every 30 seconds
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = setInterval(() => this.saveCache(), 30000);
    this.saveTimer.unref();

    // Do immediate first tick
    setTimeout(() => this.tick(), 500);

    // Save on exit
    const cleanup = () => {
      this.saveCache();
    };
    process.once("exit", cleanup);
    process.once("SIGINT", () => { cleanup(); process.exit(); });
    process.once("SIGTERM", () => { cleanup(); process.exit(); });

    console.log("[CORRELATION ENGINE] 24/7 Server Correlation Engine initialized.");
  }

  loadCache() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const age = Date.now() - (parsed.savedAt || 0);
        // Only restore if cache is less than 20 minutes old
        if (age < 1200000 && parsed.histories && typeof parsed.histories === "object") {
          let count = 0;
          for (const [k, arr] of Object.entries(parsed.histories)) {
            if (Array.isArray(arr) && arr.length > 0) {
              this.priceHistories.set(k, arr.slice(-MAX_SAMPLES));
              count++;
            }
          }
          if (parsed.correlations && typeof parsed.correlations === "object") {
            for (const [k, v] of Object.entries(parsed.correlations)) {
              if (typeof v === "number") {
                this.correlationMap.set(k, v);
              }
            }
          }
          console.log(`[CORRELATION ENGINE] Restored ${count} price histories & ${this.correlationMap.size} correlations from cache (age: ${(age / 1000).toFixed(0)}s).`);
        }
      }
    } catch (e) {
      console.warn("[CORRELATION ENGINE] Failed to load cache:", e.message);
    }
  }

  saveCache() {
    try {
      if (this.priceHistories.size === 0) return;
      const historiesObj = {};
      for (const [k, arr] of this.priceHistories.entries()) {
        if (arr.length >= 5) {
          historiesObj[k] = arr.slice(-60); // persist last 5 minutes
        }
      }
      const data = {
        savedAt: Date.now(),
        correlations: Object.fromEntries(this.correlationMap),
        histories: historiesObj
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
    } catch (_) {}
  }

  tick() {
    if (!this.tickers || this.tickers.size === 0) return;

    // 1. Record current price sample for each ticker
    for (const t of this.tickers.values()) {
      if (!t || !t.key || !t.p || t.p <= 0 || !Number.isFinite(t.p)) continue;

      let hist = this.priceHistories.get(t.key);
      if (!hist) {
        hist = [];
        this.priceHistories.set(t.key, hist);
      }
      hist.push(t.p);
      if (hist.length > MAX_SAMPLES) {
        hist.shift();
      }
    }

    // 2. Identify available BTC reference series
    const btcHistories = {};
    for (const [ex, btcKey] of Object.entries(BTC_KEY)) {
      const h = this.priceHistories.get(btcKey);
      if (h && h.length >= 5) {
        btcHistories[ex] = h;
      }
    }
    const defaultBtcHist = btcHistories["BN"] || this.priceHistories.get("BN:BTCUSDT") || Object.values(btcHistories)[0] || null;

    if (!defaultBtcHist || defaultBtcHist.length < 5) return;

    // 3. Compute Pearson correlation vs BTC for every ticker
    const updatedCorrs = {};
    let computedCount = 0;

    for (const [key, hist] of this.priceHistories.entries()) {
      if (!hist || hist.length < 5) continue;

      const colonIdx = key.indexOf(":");
      const ex = colonIdx > 0 ? key.substring(0, colonIdx) : "BN";
      const btcKey = BTC_KEY[ex] || "BN:BTCUSDT";

      if (key === btcKey) {
        this.correlationMap.set(key, 100);
        updatedCorrs[key] = 100;
        continue;
      }

      const refBtc = btcHistories[ex] || defaultBtcHist;
      if (!refBtc || refBtc.length < 5) continue;

      const corrVal = Math.round(pearsonCorrelationAbs(hist, refBtc) * 100);
      this.correlationMap.set(key, corrVal);
      updatedCorrs[key] = corrVal;
      computedCount++;
    }

    // 4. If broadcast callback provided, push to WebSocket clients
    if (typeof this.broadcastFn === "function" && computedCount > 0) {
      try {
        this.broadcastFn("correlations", updatedCorrs);
      } catch (_) {}
    }
  }

  getCorrelations() {
    return Object.fromEntries(this.correlationMap);
  }

  getCorrelation(key) {
    return this.correlationMap.get(key);
  }
}

const correlationEngine = new CorrelationEngine();
module.exports = correlationEngine;
