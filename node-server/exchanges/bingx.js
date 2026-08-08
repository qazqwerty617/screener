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
      const [contractsResp, tickersResp, premiumResp, spot24Resp] = await Promise.all([
        apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/contracts", 15000, 2),
        apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", 15000, 2),
        apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex", 15000, 2),
        apiFetch("https://open-api.bingx.com/openApi/spot/v1/ticker/24hr", 15000, 2).catch(() => null),
      ]);
      if (contractsResp?.code !== 0 || tickersResp?.code !== 0) throw new Error("BingX API error");

      const tickersBySymbol = new Map((tickersResp.data || []).filter(item => item && item.symbol).map(item => [item.symbol, item]));
      const fundingBySymbol = new Map((premiumResp.data || []).filter(item => item && item.symbol).map(item => [item.symbol, item]));
      const spotOpenMap = new Map((spot24Resp?.data || []).filter(item => item && item.symbol).map(item => [item.symbol, +item.openPrice]));

      bxSyms = [];
      let added = 0;
      for (const contract of contractsResp.data || []) {
        if (!contract?.symbol || !contract.symbol.endsWith("-USDT") || contract.symbol.startsWith("NC")) continue;
        const ticker = tickersBySymbol.get(contract.symbol);
        if (!ticker) continue;
        const fm = fundingBySymbol.get(contract.symbol);
        bxSyms.push(contract.symbol);
        const p = +(ticker.lastPrice || 0);
        const spotOpen = spotOpenMap.get(contract.symbol);
        const o = spotOpen && spotOpen > 0 ? spotOpen : +(ticker.openPrice || 0);
        const h = +(ticker.highPrice || 0), l = +(ticker.lowPrice || 0);
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
          if (!d.data || !d.dataType) return;

          const dataType = d.dataType;
          const tick = d.data;
          const sym = tick.s || tick.symbol || dataType.split("@")[0];
          if (!sym) return;
          const t = tickers.get("BX:" + sym);
          if (!t) return;

          if (dataType.includes("bookTicker")) {
            const bp = +tick.b, ap = +tick.a;
            if (bp > 0 && ap > 0) {
              const midP = (bp + ap) / 2;
              t.p = midP;
              if (t.o > 0) t.chg = ((midP - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
            }
          } else if (dataType.includes("ticker")) {
            if (tick.c) t.p = +tick.c;
            if (tick.q) t.v = +tick.q;
            if (tick.h) t.h = +tick.h;
            if (tick.l) t.l = +tick.l;
            if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
            dirtyKeys.add(t.key);
          }
        } catch (_) {}
      }, (ws) => {
        chunk.forEach(s => {
          ws.send(JSON.stringify({ id: `${s}-b`, reqType: "sub", dataType: `${s}@bookTicker` }));
          ws.send(JSON.stringify({ id: `${s}-t`, reqType: "sub", dataType: `${s}@ticker` }));
        });
      });
    }
  }

  function startRestPolling() {
    const poll = async () => {
      try {
        const [tickersResp, premiumResp, spot24Resp] = await Promise.all([
          apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/ticker", 10000, 0),
          apiFetch("https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex", 10000, 0),
          apiFetch("https://open-api.bingx.com/openApi/spot/v1/ticker/24hr", 10000, 0).catch(() => null),
        ]);
        
        const fundingMap = new Map((premiumResp?.data || []).map(item => [item.symbol, item]));
        const spotOpenMap = new Map((spot24Resp?.data || []).map(item => [item.symbol, +item.openPrice]));

        if (tickersResp?.code !== 0 || !tickersResp.data) return;
        for (const tick of tickersResp.data) {
          const t = tickers.get("BX:" + tick.symbol);
          if (!t) continue;
          const p = +(tick.lastPrice || 0);
          if (p > 0) t.p = p;
          if (tick.quoteVolume) t.v = +tick.quoteVolume;
          if (tick.highPrice) t.h = +tick.highPrice;
          if (tick.lowPrice) t.l = +tick.lowPrice;
          
          const spotOpen = spotOpenMap.get(tick.symbol);
          if (spotOpen && spotOpen > 0) t.o = spotOpen;

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
