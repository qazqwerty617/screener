"use strict";

const { EventEmitter } = require("events");
const ccxt = require("ccxt");
const WebSocket = require("ws");

/**
 * TradeCounter manages a sliding window of trades for a specific ticker.
 * Optimized for performance: stores timestamps and removes old ones via GC.
 */
class TradeCounter {
  constructor(symbol, windowMs = 3600000) {
    this.symbol = symbol;
    this.windowMs = windowMs;
    this.trades = []; // Array of { t: timestamp } objects
  }

  addTrade(timestamp) {
    if (!timestamp) return;
    this.trades.push({ t: timestamp });
  }

  addBatch(timestamps) {
    if (!timestamps || !timestamps.length) return;
    for (const t of timestamps) {
      if (t) this.trades.push({ t });
    }
    this.trades.sort((a, b) => a.t - b.t);
  }

  /**
   * Garbage Collector: removes trades older than windowMs.
   * Uses binary search for O(log N) efficiency.
   */
  cleanUp() {
    if (this.trades.length === 0) return;

    const cutoff = Date.now() - this.windowMs;
    let left = 0;
    let right = this.trades.length - 1;
    let removeCount = 0;

    while (left <= right) {
      let mid = (left + right) >> 1;
      if (this.trades[mid].t < cutoff) {
        removeCount = mid + 1;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    if (removeCount > 0) {
      this.trades.splice(0, removeCount);
    }
  }

  getCount() {
    return this.trades.length;
  }
}

/**
 * ExchangeManager handles multiple exchange connections and broadcasts updates.
 */
class ExchangeManager extends EventEmitter {
  constructor() {
    super();
    this.counters = new Map(); // key: "INTERNAL_ID:INTERNAL_SYMBOL" -> TradeCounter
    this.exchanges = new Map(); // internalId -> ccxt instance
    this.symbolMaps = new Map(); // internalId -> Map<CCXT_SYMBOL, INTERNAL_SYMBOL>
    
    // Mapping internal IDs to CCXT IDs
    this.idMap = {
      "BN": "binance",
      "BB": "bybit",
      "OX": "okx",
      "BG": "bitget",
      "GT": "gateio",
      "MX": "mexc",
      "KC": "kucoin",
      "BX": "bingx",
      "HT": "htx"
    };

    this.gcTimer = setInterval(() => this.runGC(), 5000);
  }

  runGC() {
    const start = performance.now();
    let totalCleaned = 0;
    
    for (const counter of this.counters.values()) {
      const before = counter.getCount();
      counter.cleanUp();
      totalCleaned += (before - counter.getCount());
    }

    this.emit("update", this.getAllCounts());
  }

  getAllCounts() {
    const results = {};
    for (const [key, counter] of this.counters.entries()) {
      results[key] = counter.getCount();
    }
    return results;
  }

  getCounter(internalId, internalSymbol) {
    const key = `${internalId}:${internalSymbol}`;
    if (!this.counters.has(key)) {
      this.counters.set(key, new TradeCounter(internalSymbol));
    }
    return this.counters.get(key);
  }

  /**
   * Initialize CEX via CCXT Pro
   * @param {string} internalId - e.g. "BN"
   * @param {Array<{ccxt: string, internal: string}>} symbolPairs 
   */
  async initCex(internalId, symbolPairs) {
    const ccxtId = this.idMap[internalId];
    if (!ccxtId) return;

    try {
      const ccxtSymbols = symbolPairs.map(p => p.ccxt);
      const map = new Map();
      symbolPairs.forEach(p => map.set(p.ccxt, p.internal));
      this.symbolMaps.set(internalId, map);

      console.log(`[TPH:${internalId}] Initializing for ${ccxtSymbols.length} symbols...`);
      
      const exchange = new ccxt.pro[ccxtId]({
        enableRateLimit: true,
        options: { defaultType: 'future' }
      });
      this.exchanges.set(internalId, exchange);

      await this.initialLoadRest(internalId, ccxtSymbols);
      this.startWsLoop(internalId, ccxtSymbols);

    } catch (e) {
      console.error(`[TPH:${internalId}] Initialization failed:`, e.message);
    }
  }

  async initialLoadRest(internalId, ccxtSymbols) {
    const exchange = this.exchanges.get(internalId);
    const map = this.symbolMaps.get(internalId);
    if (!exchange || !map) return;

    const cutoff = Date.now() - 3600000;
    const batchSize = 15;
    
    for (let i = 0; i < ccxtSymbols.length; i += batchSize) {
      const batch = ccxtSymbols.slice(i, i + batchSize);
      const tasks = batch.map(async (ccxtSym) => {
        try {
          const ohlcv = await exchange.fetchOHLCV(ccxtSym, '1m', cutoff, 60);
          const internalSym = map.get(ccxtSym);
          const counter = this.getCounter(internalId, internalSym);
          
          for (const candle of ohlcv) {
            const [timestamp, , , , , , tradeCount] = candle;
            if (tradeCount > 0) {
              for (let j = 0; j < tradeCount; j++) {
                counter.addTrade(timestamp + Math.floor(Math.random() * 60000));
              }
            }
          }
        } catch (e) {}
      });
      await Promise.allSettled(tasks);
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`[TPH:${internalId}] Initial load completed.`);
  }

  async startWsLoop(internalId, ccxtSymbols) {
    const exchange = this.exchanges.get(internalId);
    const map = this.symbolMaps.get(internalId);
    if (!exchange || !map) return;

    while (true) {
      try {
        const trades = await exchange.watchTradesForSymbols(ccxtSymbols);
        for (const trade of trades) {
          const internalSym = map.get(trade.symbol);
          if (internalSym) {
            const counter = this.getCounter(internalId, internalSym);
            counter.addTrade(trade.timestamp);
          }
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  /**
   * Hyperliquid (DEX)
   */
  async initHyperliquid(symbols) {
    const internalId = "HL";
    const url = "wss://api.hyperliquid.xyz/ws";
    
    const connect = () => {
      const ws = new WebSocket(url);
      ws.on("open", () => {
        for (const sym of symbols) {
          ws.send(JSON.stringify({
            method: "subscribe",
            subscription: { type: "trades", coin: sym }
          }));
        }
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.channel === "trades" && Array.isArray(msg.data)) {
            for (const t of msg.data) {
              const counter = this.getCounter(internalId, t.coin);
              counter.addTrade(t.time);
            }
          }
        } catch (e) {}
      });
      ws.on("close", () => setTimeout(connect, 5000));
    };
    connect();
  }

  /**
   * Asterdex (DEX - Binance compatible)
   */
  async initAsterdex(symbols) {
    const internalId = "AD";
    const url = "wss://fstream.asterdex.com/ws/!miniTicker@arr"; // Using ticker stream for trades estimate or separate trades
    // Better to use individual trade streams for accuracy
    
    const connect = () => {
      const ws = new WebSocket(url);
      ws.on("message", (data) => {
        try {
          const batch = JSON.parse(data);
          if (Array.isArray(batch)) {
            for (const d of batch) {
              if (d.s && symbols.includes(d.s)) {
                // Since !miniTicker doesn't give trade count, we'd need @trade for every symbol
                // For performance, we might want to subscribe to individual @trade if possible
              }
            }
          }
        } catch (e) {}
      });
      // Implementation note: for AD we'll subscribe to @trade for each symbol
      // but only for the top ones to avoid hitting WS limits if any
    };

    // Refined AD: subscribe to @trade for all requested symbols
    const subscribeTrades = () => {
      const streams = symbols.map(s => `${s.toLowerCase()}@trade`).join("/");
      const ws = new WebSocket(`wss://fstream.asterdex.com/stream?streams=${streams}`);
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.data && msg.data.e === "trade") {
            const counter = this.getCounter(internalId, msg.data.s);
            counter.addTrade(msg.data.E);
          }
        } catch (e) {}
      });
      ws.on("close", () => setTimeout(subscribeTrades, 5000));
    };
    subscribeTrades();
  }

  destroy() {
    clearInterval(this.gcTimer);
    for (const exchange of this.exchanges.values()) {
      exchange.close();
    }
  }
}

module.exports = { TradeCounter, ExchangeManager };
