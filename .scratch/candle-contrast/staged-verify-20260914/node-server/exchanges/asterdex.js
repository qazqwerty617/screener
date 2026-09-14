"use strict";
/**
 * Asterdex Futures (Binance Multi-exchange Wrapper)
 * Uses Binance aggTrade streams for 100% price synchronization.
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let adSyms = [];
  let initRetryAttempt = 0;
  let initRetryTimer = null;
  let fundingTimer = null;

  function getInitRetryDelay(error) {
    const message = String(error && error.message || "");
    const banMatch = message.match(/banned until\s+(\d{10,13})/i);
    if (banMatch) {
      const bannedUntil = Number(banMatch[1]);
      if (Number.isFinite(bannedUntil) && bannedUntil > Date.now()) {
        return Math.min(24 * 60 * 60 * 1000, bannedUntil - Date.now() + 5000);
      }
    }

    const exponentialDelay = 5000 * Math.pow(2, Math.min(initRetryAttempt, 6));
    return Math.min(5 * 60 * 1000, exponentialDelay);
  }

  async function init() {
    try {
      if (updateExStatus) updateExStatus("AD", "connecting");
      const [infoResp, tickerResp, premiumResp] = await Promise.all([
        apiFetch("https://fapi.asterdex.com/fapi/v1/exchangeInfo", 15000, 2),
        apiFetch("https://fapi.asterdex.com/fapi/v1/ticker/24hr", 15000, 2),
        apiFetch("https://fapi.asterdex.com/fapi/v1/premiumIndex", 15000, 2),
      ]);
      if (!infoResp?.symbols || !Array.isArray(tickerResp)) throw new Error("Asterdex API error");

      initRetryAttempt = 0;
      adSyms = [];

      const fundingBySymbol = new Map(Array.isArray(premiumResp) ? premiumResp.map(i => [i.symbol, i]) : []);
      const tradingSet = new Set(
        (infoResp.symbols || []).filter(s => s.status === "TRADING" && s.quoteAsset === "USDT" && s.contractType === "PERPETUAL").map(s => s.symbol)
      );

      let added = 0;
      for (const d of tickerResp) {
        const sym = d.symbol;
        if (!tradingSet.has(sym)) continue;
        adSyms.push(sym);
        const fm = fundingBySymbol.get(sym);
        const p = +d.lastPrice, o = +d.openPrice, h = +d.highPrice, l = +d.lowPrice;
        tickers.set("AD:" + sym, {
          key: "AD:" + sym, ex: "AD", sym, base: sym.replace(/USDT$/, "").replace(/1000/g, ""),
          p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : +d.priceChangePercent,
          v: +d.quoteVolume, h, l, o, funding: fm ? +fm.lastFundingRate * 100 : 0, nextFunding: fm ? +fm.nextFundingTime : 0,
        });
        added++;
      }
      console.log(`[AD] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("AD:")) dirtyKeys.add(k); }
      connectWs();
      startPolling();
    } catch (e) {
      const retryDelay = getInitRetryDelay(e);
      initRetryAttempt++;
      if (updateExStatus) updateExStatus("AD", "offline", e.message);
      console.error(`[AD] Init error: ${e.message}. Retry in ${Math.ceil(retryDelay / 1000)}s`);
      clearTimeout(initRetryTimer);
      initRetryTimer = setTimeout(init, retryDelay);
    }
  }

  function startPolling() {
      if (fundingTimer) return;
      // Funding does not need a 2-second full-market REST poll. A slower poll
      // leaves request capacity for order books and prevents HTTP 418 IP bans.
      fundingTimer = setInterval(async () => {
          try {
              const premiumResp = await apiFetch("https://fapi.asterdex.com/fapi/v1/premiumIndex", 5000, 0);
              if (Array.isArray(premiumResp)) {
                  for (const fm of premiumResp) {
                      const t = tickers.get("AD:" + fm.symbol);
                      if (t) {
                          t.funding = +fm.lastFundingRate * 100;
                          t.nextFunding = +fm.nextFundingTime;
                          dirtyKeys.add(t.key);
                      }
                  }
              }
          } catch (_) {}
      }, 30000);
  }

  function connectWs() {
    // Single !miniTicker@arr stream replaces 7 aggTrade connections
    // One batch message per second instead of thousands of individual trade events
    mkExWs("AD-MiniTicker", "wss://fstream.asterdex.com/ws/!miniTicker@arr", (raw) => {
      try {
        const batch = JSON.parse(raw.toString());
        if (!Array.isArray(batch)) return;
        for (const d of batch) {
          const t = tickers.get("AD:" + d.s);
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
  }

  return { init };
};
