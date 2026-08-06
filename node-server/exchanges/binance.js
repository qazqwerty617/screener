"use strict";
/**
 * Binance Futures — Pro Terminal Speed
 * Uses !ticker@arr for full data + !markPrice@arr@1s for funding
 */
module.exports = function (tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let tradingSet = new Set();

  async function init() {
    try {
      if (updateExStatus) updateExStatus("BN", "connecting");
      const [info, arr, premium] = await Promise.all([
        apiFetch("https://fapi.binance.com/fapi/v1/exchangeInfo", 15000, 2),
        apiFetch("https://fapi.binance.com/fapi/v1/ticker/24hr", 15000, 2),
        apiFetch("https://fapi.binance.com/fapi/v1/premiumIndex", 15000, 2),
      ]);

      const premiumMap = new Map();
      if (Array.isArray(premium)) {
        for (const p of premium) premiumMap.set(p.symbol, { r: +p.lastFundingRate * 100, T: +p.nextFundingTime });
      }

      tradingSet = new Set(
        (info.symbols || []).filter(s => s.status === "TRADING" && s.quoteAsset === "USDT" && s.contractType === "PERPETUAL").map(s => s.symbol)
      );

      let added = 0;
      for (const d of arr) {
        if (!tradingSet.has(d.symbol)) continue;
        const p = +d.lastPrice, o = +d.openPrice, h = +d.highPrice, l = +d.lowPrice;
        const prem = premiumMap.get(d.symbol) || { r: 0, T: 0 };
        tickers.set("BN:" + d.symbol, {
          key: "BN:" + d.symbol, ex: "BN", sym: d.symbol, base: d.symbol.replace(/USDT$/, ""),
          p, chg: (() => { const v = parseFloat(d.priceChangePercent); return (!isNaN(v) && v !== 0) ? v : (o > 0 && p > 0 ? ((p - o) / o) * 100 : 0); })(),
          v: +d.quoteVolume, h, l, o, funding: prem.r, nextFunding: prem.T, trades: +d.count || 0,
        });
        added++;
      }
      console.log(`[BN] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("BN:")) dirtyKeys.add(k); }
      initStreams();
    } catch (e) {
      console.error("[BN] REST error:", e.message);
      setTimeout(init, 3000);
    }
  }

  function initStreams() {
    // 1. Price stream: !miniTicker@arr sends ALL symbols' last price in one batch (~1s)
    // This replaces aggTrade per-symbol subscriptions (thousands of events → 1 event/sec)
    mkExWs("BN-MiniTicker", "wss://fstream.binance.com/market/ws/!miniTicker@arr", (raw) => {
      try {
        const batch = JSON.parse(raw.toString());
        if (!Array.isArray(batch)) return;
        for (const d of batch) {
          if (!tradingSet.has(d.s)) continue;
          const t = tickers.get("BN:" + d.s);
          if (t) {
            const p = +d.c; // close price = latest price
            if (p > 0) {
              t.p = p;
              if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
            }
          }
        }
      } catch (_) {}
    });


    // 2. Stats stream: 24h tickers every 1s (Volumes, OHLC, Count)
    mkExWs("BN-Stats", "wss://fstream.binance.com/market/ws/!ticker@arr", (raw) => {
      try {
        const batch = JSON.parse(raw.toString());
        if (!Array.isArray(batch)) return;
        for (const tick of batch) {
          const t = tickers.get("BN:" + tick.s);
          if (!t) continue;
          // Set initial price if not yet set by BBA
          if (!t.p) t.p = +tick.c;
          t.v = +tick.q; // 24h USDT Turnover
          t.h = Math.max(t.h || 0, +tick.h);
          t.l = t.l > 0 ? Math.min(t.l, +tick.l) : +tick.l;
          t.o = +tick.o;
          t.trades = +tick.n;
          dirtyKeys.add(t.key);
        }
      } catch (_) { }
    });

    // 3. Funding: markPrice@arr every 1 second
    mkExWs("BN-MP", "wss://fstream.binance.com/market/ws/!markPrice@arr@1s", (raw) => {
      try {
        const batch = JSON.parse(raw.toString());
        for (const d of batch) {
          const t = tickers.get("BN:" + d.s);
          if (t) { t.funding = +d.r * 100; t.nextFunding = +d.T; dirtyKeys.add(t.key); }
        }
      } catch (_) { }
    });

  }

  return { init };
};
