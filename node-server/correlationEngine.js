"use strict";

const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "correlation_cache.json");
const CACHE_TMP = CACHE_FILE + ".tmp";
const MAX_SAMPLES = 120; // 120 samples * 5s = 10 minutes of history
const SAMPLE_INTERVAL_MS = 5000;
const PERSIST_SAMPLES = 60; // last 5 minutes survive a restart
/**
 * A key that stops receiving samples is a delisted/renamed symbol. Without this
 * both `priceHistories` and `correlationMap` grew monotonically for the process
 * lifetime (~8.5k keys x 120 doubles, plus a Map entry each) which is a large
 * slice of the 650M pm2 restart ceiling.
 */
const STALE_TICKS_BEFORE_EVICT = 24; // 24 * 5s = 2 minutes of silence

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

/**
 * Fixed-capacity ring over a Float64Array. The previous implementation used a
 * plain array with `push` + `shift`; `shift` is O(n) and ran once per ticker per
 * 5s tick, i.e. ~1M element moves per tick at production ticker counts.
 */
function makeSeries() {
  return { buf: new Float64Array(MAX_SAMPLES), len: 0, head: 0, missed: 0 };
}

function seriesPush(s, v) {
  s.buf[s.head] = v;
  s.head = s.head + 1 === MAX_SAMPLES ? 0 : s.head + 1;
  if (s.len < MAX_SAMPLES) s.len++;
  s.missed = 0;
}

/** Physical index of logical sample `j` counted from the oldest retained one. */
function seriesIndex(s, j) {
  const start = s.head - s.len;
  const i = start + j;
  return i < 0 ? i + MAX_SAMPLES : i;
}

function seriesToArray(s, limit) {
  const n = Math.min(s.len, limit || s.len);
  const out = new Array(n);
  const base = s.len - n;
  for (let j = 0; j < n; j++) out[j] = s.buf[seriesIndex(s, base + j)];
  return out;
}

/**
 * Pearson correlation over the newest `n` aligned samples of two rings.
 * Allocation-free: the old version did two `.slice(-n)` calls per pair, which at
 * ~8.5k tickers meant 17k transient arrays every 5 seconds.
 */
function pearsonAbsRings(x, y) {
  const n = x.len < y.len ? x.len : y.len;
  if (n < 2) return 0;

  const xb = x.buf, yb = y.buf;
  const xBase = x.len - n, yBase = y.len - n;

  let meanX = 0, meanY = 0;
  for (let j = 0; j < n; j++) {
    meanX += xb[seriesIndex(x, xBase + j)];
    meanY += yb[seriesIndex(y, yBase + j)];
  }
  meanX /= n;
  meanY /= n;

  let num = 0, denX = 0, denY = 0;
  for (let j = 0; j < n; j++) {
    const dx = xb[seriesIndex(x, xBase + j)] - meanX;
    const dy = yb[seriesIndex(y, yBase + j)] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  if (denX === 0 || denY === 0) return 0;
  return Math.abs(num / Math.sqrt(denX * denY));
}

class CorrelationEngine {
  constructor() {
    this.priceHistories = new Map(); // key -> ring series
    this.correlationMap = new Map(); // key -> integer (-100 to 100)
    this.tickers = null;
    this.broadcastFn = null;
    this.timer = null;
    this.saveTimer = null;
    this._saving = false;
    this._cleanupBound = null;
    this._cachedObj = null;
    this._dirty = true;
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
    setTimeout(() => this.tick(), 500).unref?.();

    /**
     * Save on exit. This used to register `SIGINT`/`SIGTERM` handlers that
     * called `process.exit()` immediately. Because this module is required
     * before the rest of server.js wires up its own signal handlers, that
     * `process.exit()` killed the process before `saveFormationCooldowns()`
     * ever ran — the formation cooldown persistence was silently dead. Only
     * `exit` is hooked now; orderly shutdown is server.js's job.
     */
    if (!this._cleanupBound) {
      this._cleanupBound = () => { this.saveCacheSync(); };
      process.once("exit", this._cleanupBound);
    }

    console.log("[CORRELATION ENGINE] 24/7 Server Correlation Engine initialized.");
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null; }
  }

  loadCache() {
    try {
      if (!fs.existsSync(CACHE_FILE)) return;
      const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      const age = Date.now() - (parsed.savedAt || 0);
      // Only restore if cache is less than 20 minutes old
      if (age >= 1200000 || !parsed.histories || typeof parsed.histories !== "object") return;

      let count = 0;
      for (const [k, arr] of Object.entries(parsed.histories)) {
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const s = makeSeries();
        const from = Math.max(0, arr.length - MAX_SAMPLES);
        for (let i = from; i < arr.length; i++) {
          const v = arr[i];
          if (Number.isFinite(v)) seriesPush(s, v);
        }
        if (s.len > 0) { this.priceHistories.set(k, s); count++; }
      }
      if (parsed.correlations && typeof parsed.correlations === "object") {
        for (const [k, v] of Object.entries(parsed.correlations)) {
          if (typeof v === "number") this.correlationMap.set(k, v);
        }
      }
      console.log(`[CORRELATION ENGINE] Restored ${count} price histories & ${this.correlationMap.size} correlations from cache (age: ${(age / 1000).toFixed(0)}s).`);
    } catch (e) {
      console.warn("[CORRELATION ENGINE] Failed to load cache:", e.message);
    }
  }

  _buildCachePayload() {
    const historiesObj = {};
    for (const [k, s] of this.priceHistories.entries()) {
      if (s.len >= 5) historiesObj[k] = seriesToArray(s, PERSIST_SAMPLES);
    }
    return JSON.stringify({
      savedAt: Date.now(),
      correlations: Object.fromEntries(this.correlationMap),
      histories: historiesObj,
    });
  }

  /** Non-blocking periodic save. The old `writeFileSync` stalled the event loop
   *  for the whole serialize+write of a multi-MB payload every 30 seconds. */
  saveCache() {
    if (this._saving || this.priceHistories.size === 0) return;
    this._saving = true;
    let json;
    try {
      json = this._buildCachePayload();
    } catch (_) {
      this._saving = false;
      return;
    }
    fs.writeFile(CACHE_TMP, json, (err) => {
      if (err) { this._saving = false; return; }
      fs.rename(CACHE_TMP, CACHE_FILE, () => { this._saving = false; });
    });
  }

  /** Only used from the `exit` hook, where async I/O can no longer complete. */
  saveCacheSync() {
    try {
      if (this.priceHistories.size === 0) return;
      fs.writeFileSync(CACHE_TMP, this._buildCachePayload());
      fs.renameSync(CACHE_TMP, CACHE_FILE);
    } catch (_) {}
  }

  tick() {
    if (!this.tickers || this.tickers.size === 0) return;

    const histories = this.priceHistories;

    // 1. Record current price sample for each live ticker
    for (const t of this.tickers.values()) {
      if (!t || !t.key || !(t.p > 0) || !Number.isFinite(t.p)) continue;
      let s = histories.get(t.key);
      if (!s) { s = makeSeries(); histories.set(t.key, s); }
      seriesPush(s, t.p);
    }

    // 2. Identify available BTC reference series
    const btcHistories = Object.create(null);
    for (const ex in BTC_KEY) {
      const h = histories.get(BTC_KEY[ex]);
      if (h && h.len >= 5) btcHistories[ex] = h;
    }
    const defaultBtcHist =
      btcHistories.BN || histories.get("BN:BTCUSDT") || Object.values(btcHistories)[0] || null;

    if (!defaultBtcHist || defaultBtcHist.len < 5) return;

    // 3. Compute Pearson correlation vs BTC + evict silent keys in one pass.
    //    Only changed values go on the wire; the old code broadcast all ~8.5k
    //    keys every 5 seconds regardless of whether anything moved.
    const changed = {};
    let changedCount = 0;
    let computedCount = 0;
    let evicted = 0;

    for (const [key, s] of histories) {
      // The sampling pass above resets `missed` to 0 for every live ticker.
      if (++s.missed > STALE_TICKS_BEFORE_EVICT) {
        histories.delete(key);
        this.correlationMap.delete(key);
        evicted++;
        continue;
      }
      if (s.len < 5) continue;

      const colonIdx = key.indexOf(":");
      const ex = colonIdx > 0 ? key.substring(0, colonIdx) : "BN";
      const btcKey = BTC_KEY[ex] || "BN:BTCUSDT";

      let corrVal;
      if (key === btcKey) {
        corrVal = 100;
      } else {
        const refBtc = btcHistories[ex] || defaultBtcHist;
        if (!refBtc || refBtc.len < 5) continue;
        corrVal = Math.round(pearsonAbsRings(s, refBtc) * 100);
        computedCount++;
      }

      if (this.correlationMap.get(key) !== corrVal) {
        this.correlationMap.set(key, corrVal);
        changed[key] = corrVal;
        changedCount++;
      }
    }

    if (changedCount > 0 || evicted > 0) {
      this._dirty = true;
    }

    if (evicted > 0 && process.env.NODE_ENV !== "production") {
      console.log(`[CORRELATION ENGINE] evicted ${evicted} stale key(s); ${histories.size} tracked`);
    }

    // 4. Push only the delta to WebSocket clients
    if (typeof this.broadcastFn === "function" && changedCount > 0 && computedCount > 0) {
      try {
        this.broadcastFn("correlations", changed);
      } catch (_) {}
    }
  }

  getCorrelations() {
    if (this._dirty || !this._cachedObj) {
      this._cachedObj = Object.fromEntries(this.correlationMap);
      this._dirty = false;
    }
    return this._cachedObj;
  }

  getCorrelation(key) {
    return this.correlationMap.get(key);
  }
}

const correlationEngine = new CorrelationEngine();
module.exports = correlationEngine;
