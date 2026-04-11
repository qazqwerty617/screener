"use strict";
/**
 * Asterdex Futures (Binance Multi-exchange Wrapper)
 * Uses Binance aggTrade streams for 100% price synchronization.
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let adSyms = [];

  async function init() {
    try {
      if (updateExStatus) updateExStatus("AD", "connecting");
      const [infoResp, tickerResp, premiumResp] = await Promise.all([
        apiFetch("https://fapi.asterdex.com/fapi/v1/exchangeInfo", 15000, 2),
        apiFetch("https://fapi.asterdex.com/fapi/v1/ticker/24hr", 15000, 2),
        apiFetch("https://fapi.asterdex.com/fapi/v1/premiumIndex", 15000, 2),
      ]);
      if (!infoResp?.symbols || !Array.isArray(tickerResp)) throw new Error("Asterdex API error");

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
      console.error("[AD] Init error:", e.message);
      setTimeout(init, 5000);
    }
  }

  function startPolling() {
      setInterval(async () => {
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
      }, 2000);
  }

  function connectWs() {
    mkExWs("AD", "wss://fstream.binance.com/stream", (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        const d = payload.data;
        if (!d || !d.s || !d.p) return;
        const t = tickers.get("AD:" + d.s);
        if (t) {
            t.p = +d.p;
            if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
            dirtyKeys.add(t.key);
        }
      } catch (_) {}
    }, (ws) => {
      for (let j = 0; j < adSyms.length; j += 100) {
          const streams = adSyms.slice(j, j + 100).map(s => `${s.toLowerCase()}@aggTrade`);
          ws.send(JSON.stringify({ method: "SUBSCRIBE", params: streams, id: Date.now() + j }));
      }
    });
  }

  return { init };
};
