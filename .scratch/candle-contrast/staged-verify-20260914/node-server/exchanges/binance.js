"use strict";
/**
 * Binance Futures — Pro Terminal Speed
 * Uses !ticker@arr for full data + !markPrice@arr@1s for funding + !bookTicker for real-time BBO
 * Stream-first initialization ensures instant ticker availability even if REST is rate-limited.
 */
module.exports = function (tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let tradingSet = new Set();
  let initialized = false;

  async function fetchRestInfo() {
    try {
      const [info, arr, premium] = await Promise.all([
        apiFetch("https://fapi.binance.com/fapi/v1/exchangeInfo", 10000, 1),
        apiFetch("https://fapi.binance.com/fapi/v1/ticker/24hr", 10000, 1),
        apiFetch("https://fapi.binance.com/fapi/v1/premiumIndex", 10000, 1),
      ]);

      const premiumMap = new Map();
      if (Array.isArray(premium)) {
        for (const p of premium) premiumMap.set(p.symbol, { r: +p.lastFundingRate * 100, T: +p.nextFundingTime });
      }

      if (info && Array.isArray(info.symbols)) {
        tradingSet = new Set(
          info.symbols.filter(s => s.status === "TRADING" && s.quoteAsset === "USDT" && s.contractType === "PERPETUAL").map(s => s.symbol)
        );
      }

      if (Array.isArray(arr)) {
        for (const d of arr) {
          if (tradingSet.size > 0 && !tradingSet.has(d.symbol)) continue;
          if (!d.symbol || !d.symbol.endsWith("USDT")) continue;
          const p = +d.lastPrice, o = +d.openPrice, h = +d.highPrice, l = +d.lowPrice;
          const prem = premiumMap.get(d.symbol) || { r: 0, T: 0 };
          const existing = tickers.get("BN:" + d.symbol);
          if (existing) {
            if (!existing.p || existing.p === 0) existing.p = p;
            if (o > 0) existing.o = o;
            if (h > 0) existing.h = h;
            if (l > 0) existing.l = l;
            if (+d.quoteVolume > 0) existing.v = +d.quoteVolume;
            if (prem.r) existing.funding = prem.r;
            if (prem.T) existing.nextFunding = prem.T;
            if (+d.count) existing.trades = +d.count;
          } else {
            tickers.set("BN:" + d.symbol, {
              key: "BN:" + d.symbol, ex: "BN", sym: d.symbol, base: d.symbol.replace(/USDT$/, ""),
              p, chg: (() => { const v = parseFloat(d.priceChangePercent); return (!isNaN(v) && v !== 0) ? v : (o > 0 && p > 0 ? ((p - o) / o) * 100 : 0); })(),
              v: +d.quoteVolume || 0, h: h || p, l: l || p, o: o || p, funding: prem.r, nextFunding: prem.T, trades: +d.count || 0,
              bid: +d.bidPrice || 0, ask: +d.askPrice || 0, quoteTs: Date.now(), fundingInterval: 8,
            });
          }
          dirtyKeys.add("BN:" + d.symbol);
        }
      }
      if (updateExStatus) updateExStatus("BN", "online");
    } catch (e) {
      // REST rate limit or failure — streams are already running
      setTimeout(fetchRestInfo, 30000);
    }
  }

  function init() {
    if (updateExStatus) updateExStatus("BN", "connecting");
    initStreams();
    fetchRestInfo();
  }

  function initStreams() {
    // 0. Real-time instant price stream: !bookTicker sends best bid/ask for ALL symbols instantly (~10-50ms)
    mkExWs("BN-BookTicker", "wss://fstream.binance.com/public/ws/!bookTicker", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.s || !d.s.endsWith("USDT")) return;
        const bp = +d.b, ap = +d.a;
        if (bp > 0 && ap > 0) {
          const midP = (bp + ap) / 2;
          let t = tickers.get("BN:" + d.s);
          if (!t) {
            t = {
              key: "BN:" + d.s, ex: "BN", sym: d.s, base: d.s.replace(/USDT$/, ""),
              p: midP, chg: 0, v: 0, h: midP, l: midP, o: midP,
              funding: 0, nextFunding: 0, trades: 0,
              bid: bp, ask: ap, quoteTs: Date.now(), fundingInterval: 8,
            };
            tickers.set("BN:" + d.s, t);
          } else {
            t.bid = bp; t.ask = ap; t.quoteTs = Date.now();
            t.p = midP;
            if (t.o > 0) t.chg = ((midP - t.o) / t.o) * 100;
          }
          dirtyKeys.add(t.key);
          if (!initialized) {
            initialized = true;
            if (updateExStatus) updateExStatus("BN", "online");
          }
        }
      } catch (_) {}
    });

    // 1. Price stream: !miniTicker@arr sends ALL symbols' last price in one batch (~1s)
    mkExWs("BN-MiniTicker", "wss://fstream.binance.com/market/ws/!miniTicker@arr", (raw) => {
      try {
        const batch = JSON.parse(raw.toString());
        if (!Array.isArray(batch)) return;
        for (const d of batch) {
          if (!d.s || !d.s.endsWith("USDT")) continue;
          const p = +d.c;
          if (p <= 0) continue;
          let t = tickers.get("BN:" + d.s);
          if (!t) {
            const o = +d.o || p;
            t = {
              key: "BN:" + d.s, ex: "BN", sym: d.s, base: d.s.replace(/USDT$/, ""),
              p, chg: o > 0 ? ((p - o) / o) * 100 : 0, v: +d.q || 0, h: +d.h || p, l: +d.l || p, o,
              funding: 0, nextFunding: 0, trades: 0,
              bid: 0, ask: 0, quoteTs: Date.now(), fundingInterval: 8,
            };
            tickers.set("BN:" + d.s, t);
          } else {
            t.p = p;
            if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
          }
          dirtyKeys.add(t.key);
        }
      } catch (_) {}
    });

    // 2. Stats stream: 24h tickers every 1s (Volumes, OHLC, Count)
    mkExWs("BN-Stats", "wss://fstream.binance.com/market/ws/!ticker@arr", (raw) => {
      try {
        const batch = JSON.parse(raw.toString());
        if (!Array.isArray(batch)) return;
        for (const tick of batch) {
          if (!tick.s || !tick.s.endsWith("USDT")) continue;
          let t = tickers.get("BN:" + tick.s);
          if (!t) {
            const p = +tick.c || 0, o = +tick.o || 0;
            t = {
              key: "BN:" + tick.s, ex: "BN", sym: tick.s, base: tick.s.replace(/USDT$/, ""),
              p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : 0,
              v: +tick.q || 0, h: +tick.h || p, l: +tick.l || p, o,
              funding: 0, nextFunding: 0, trades: +tick.n || 0,
              bid: 0, ask: 0, quoteTs: Date.now(), fundingInterval: 8,
            };
            tickers.set("BN:" + tick.s, t);
          } else {
            if (!t.p) t.p = +tick.c;
            t.v = +tick.q;
            t.h = Math.max(t.h || 0, +tick.h);
            t.l = t.l > 0 ? Math.min(t.l, +tick.l) : +tick.l;
            t.o = +tick.o;
            if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
            t.trades = +tick.n;
          }
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
