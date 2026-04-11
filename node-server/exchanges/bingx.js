"use strict";
const zlib = require('zlib');

/**
 * BingX Futures — Pro Terminal Speed
 * Fixed WS URL + headers, REST fallback if WS fails
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let bxSyms = [];
  let wsFailCount = 0;
  let restMode = false;

  async function init() {
    try {
      if (updateExStatus) updateExStatus("BX", "connecting");
      const [contractsResp, tickersResp, premiumResp] = await Promise.all([
        apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/contracts", 15000, 2),
        apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", 15000, 2),
        apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex", 15000, 2),
      ]);
      if (contractsResp?.code !== 0 || tickersResp?.code !== 0) throw new Error("BingX API error");

      const tickersBySymbol = new Map((tickersResp.data || []).filter(item => item && item.symbol).map(item => [item.symbol, item]));
      const fundingBySymbol = new Map((premiumResp.data || []).filter(item => item && item.symbol).map(item => [item.symbol, item]));
      bxSyms = [];
      let added = 0;
      for (const contract of contractsResp.data || []) {
        if (!contract?.symbol || !contract.symbol.endsWith("-USDT")) continue;
        const ticker = tickersBySymbol.get(contract.symbol);
        if (!ticker) continue;
        const fm = fundingBySymbol.get(contract.symbol);
        bxSyms.push(contract.symbol);
        const p = +(ticker.lastPrice || 0), o = +(ticker.openPrice || 0), h = +(ticker.highPrice || 0), l = +(ticker.lowPrice || 0);
        tickers.set("BX:" + contract.symbol, {
          key: "BX:" + contract.symbol, ex: "BX", sym: contract.symbol, base: contract.symbol.replace(/-USDT$/, ""),
          p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : +(ticker.priceChangePercent || 0),
          v: +(ticker.quoteVolume || ticker.volume || 0), h, l, o, funding: fm ? +fm.lastFundingRate * 100 : 0, nextFunding: fm ? +fm.nextFundingTime : 0,
        });
        added++;
      }
      console.log(`[BX] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("BX:")) dirtyKeys.add(k); }
      connectWs();
      // Always start REST polling as backup
      startRestPolling();
    } catch (e) {
      console.error("[BX] Init error:", e.message);
      setTimeout(init, 5000);
    }
  }

  function connectWs() {
    if (restMode) return;
    const bxBatchSize = Math.ceil(bxSyms.length / 3);
    for (let i = 0; i < bxSyms.length; i += bxBatchSize) {
      const chunk = bxSyms.slice(i, i + bxBatchSize);
      const connId = `BX_${i}`;
      mkExWs(connId, "wss://open-api-swap.bingx.com/swap-market", (raw, ws) => {
        try {
          let d;
          try { d = JSON.parse(raw.toString()); } catch (_) {
            try { d = JSON.parse(zlib.gunzipSync(raw).toString()); } catch (__) { return; }
          }
          if (d.ping) { ws.send(JSON.stringify({ pong: d.ping })); return; }
          if (d.data && (d.dataType?.includes("trade") || d.dataType?.includes("ticker"))) {
             const ticks = Array.isArray(d.data) ? d.data : [d.data];
             for (const tick of ticks) {
               const sym = tick.s || tick.symbol;
               if (!sym) continue;
               const t = tickers.get("BX:" + sym);
               if (t) {
                 const lp = +(tick.p || tick.lastPrice || 0);
                 if (lp > 0) t.p = lp;
                 // NEVER use tick.q (single trade amount) for 24h volume.
                 // Only update volume if it's explicitly a ticker pushing 24h volume.
                 if (d.dataType?.includes("ticker") && (tick.quoteVolume || tick.v)) {
                   t.v = +(tick.quoteVolume || tick.v);
                 }
                 if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
                 dirtyKeys.add(t.key);
               }
             }
          }
        } catch (_) {}
      }, (ws) => {
        chunk.forEach(s => {
          ws.send(JSON.stringify({ id: s, reqType: "sub", dataType: `${s}@trade` }));
        });
      });
    }
  }

  function startRestPolling() {
    const poll = async () => {
      try {
        const [tickersResp, premiumResp] = await Promise.all([
          apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", 10000, 0),
          apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex", 10000, 0)
        ]);
        
        const fundingMap = new Map((premiumResp?.data || []).map(item => [item.symbol, item]));

        if (tickersResp?.code !== 0 || !tickersResp.data) return;
        for (const tick of tickersResp.data) {
          const t = tickers.get("BX:" + tick.symbol);
          if (!t) continue;
          const p = +(tick.lastPrice || 0);
          if (p > 0) t.p = p;
          if (tick.quoteVolume) t.v = +tick.quoteVolume;
          if (tick.highPrice) t.h = +tick.highPrice;
          if (tick.lowPrice) t.l = +tick.lowPrice;
          if (tick.openPrice) t.o = +tick.openPrice;
          
          const fm = fundingMap.get(tick.symbol);
          if (fm) {
            t.funding = +fm.lastFundingRate * 100;
            t.nextFunding = +fm.nextFundingTime;
          }
          if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
          dirtyKeys.add(t.key);
        }
      } catch (_) {}
    };
    // Poll every 3s
    setInterval(poll, 3000);
  }

  return { init };
};
