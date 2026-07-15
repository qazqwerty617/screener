"use strict";
/**
 * MEXC Futures — Pro Terminal Speed
 * Mid-price from order book (bid1+ask1)/2 for maximum accuracy
 * push.ticker has bid1/ask1 — used for instant mid-price calculation
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let mxSyms = [];

  async function init() {
    try {
      if (updateExStatus) updateExStatus("MX", "connecting");
      const [data, detailResp] = await Promise.all([
        apiFetch("https://contract.mexc.com/api/v1/contract/ticker", 15000, 2),
        apiFetch("https://contract.mexc.com/api/v1/contract/detail", 15000, 2),
      ]);
      if (!data?.success || data.code !== 0 || !Array.isArray(data.data)) throw new Error("MEXC API error");

      const detailMap = new Map();
      if (detailResp?.success && Array.isArray(detailResp.data)) {
        for (const item of detailResp.data) {
          if (item.symbol && item.contractSize) {
            detailMap.set(item.symbol, +item.contractSize);
          }
        }
      }

      let added = 0;
      for (const d of data.data) {
        if (!d.symbol || !d.symbol.endsWith("_USDT")) continue;
        const p = +d.lastPrice, changeRate = +d.riseFallRate;
        const o = p && Number.isFinite(changeRate) ? p / (1 + changeRate) : 0;
        const h = +d.high24Price, l = +(d.lower24Price || 0);
        let oi = 0;
        if (d.holdVol && d.volume24 && d.amount24 && +d.volume24 !== 0) {
          oi = (+d.holdVol / +d.volume24) * +d.amount24;
        }
        mxSyms.push(d.symbol);
        const cs = detailMap.get(d.symbol) || 1;
        tickers.set("MX:" + d.symbol, {
          key: "MX:" + d.symbol, ex: "MX", sym: d.symbol, base: d.symbol.replace(/_USDT$/, ""),
          p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : changeRate * 100,
          v: +d.amount24, h, l, o, funding: +d.fundingRate * 100 || 0, nextFunding: +d.nextFundingTime || 0,
          oi,
          cs
        });
        added++;
      }
      console.log(`[MX] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("MX:")) dirtyKeys.add(k); }
      connectWs();
      startRestPolling();
    } catch (e) {
      console.error("[MX] Init error:", e.message);
      setTimeout(init, 5000);
    }
  }

  function startRestPolling() {
    const poll = async () => {
      try {
        const data = await apiFetch("https://contract.mexc.com/api/v1/contract/ticker", 5000, 0);
        if (!data?.success || data.code !== 0 || !Array.isArray(data.data)) return;
        
        for (const tick of data.data) {
          const t = tickers.get("MX:" + tick.symbol);
          if (!t) continue;
          
          const p = +tick.lastPrice;
          if (p > 0 && !t._wsMid) t.p = p; // only REST fallback if no WS mid-price
          if (tick.amount24) t.v = +tick.amount24;
          if (tick.holdVol && tick.volume24 && tick.amount24 && +tick.volume24 !== 0) {
            t.oi = (+tick.holdVol / +tick.volume24) * +tick.amount24;
          }
          if (tick.high24Price) t.h = +tick.high24Price;
          if (tick.lower24Price) t.l = +tick.lower24Price;
          if (tick.riseFallRate && t.p > 0) t.o = t.p / (1 + +tick.riseFallRate);
          if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
          if (tick.fundingRate) t.funding = +tick.fundingRate * 100;
          
          dirtyKeys.add(t.key);
        }
      } catch (_) {}
    };
    setInterval(poll, 3000);
  }

  function connectWs() {
    if (updateExStatus) updateExStatus("MX", "online");

    // Split into 3 connections
    const connCount = 3;
    const chunkSize = Math.ceil(mxSyms.length / connCount);
    
    for (let c = 0; c < connCount; c++) {
      const connSyms = mxSyms.slice(c * chunkSize, (c + 1) * chunkSize);
      if (!connSyms.length) continue;

      mkExWs(`MX${c === 0 ? "" : "_" + c}`, "wss://contract.mexc.com/edge", (raw) => {
        try {
          const d = JSON.parse(raw.toString());
          
          // push.ticker — has bid1/ask1 for mid-price + stats
          if (d.channel === "push.ticker" && d.data) {
            const tick = d.data;
            const sym = d.symbol || tick.symbol;
            if (!sym) return;
            const t = tickers.get("MX:" + sym);
            if (!t) return;

            // Mid-price from best bid/ask (pro terminal accuracy)
            const bid = +(tick.bid1 || 0);
            const ask = +(tick.ask1 || 0);
            if (bid > 0 && ask > 0) {
              t.p = (bid + ask) / 2;
              t._wsMid = true; // flag: WS mid-price active
            } else {
              const lp = +(tick.lastPrice || 0);
              if (lp > 0) t.p = lp;
            }

            if (tick.amount24) t.v = +tick.amount24;
            if (tick.high24Price) t.h = +tick.high24Price;
            if (tick.lower24Price) t.l = +tick.lower24Price;
            if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
            dirtyKeys.add(t.key);
          }

          // push.deal — also update price from actual trades as backup
          if (d.channel === "push.deal" && d.data) {
            const tick = d.data;
            const sym = d.symbol || tick.symbol;
            if (!sym) return;
            const t = tickers.get("MX:" + sym);
            if (t && !t._wsMid) {
              const lp = +(tick.p || 0);
              if (lp > 0) {
                t.p = lp;
                if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
                dirtyKeys.add(t.key);
              }
            }
          }
        } catch (_) {}
      }, (ws) => {
        const subBatch = 20;
        for (let i = 0; i < connSyms.length; i += subBatch) {
          const batch = connSyms.slice(i, i + subBatch);
          setTimeout(() => {
            if (ws.readyState === 1) {
              batch.forEach(sym => {
                ws.send(JSON.stringify({ method: "sub.ticker", param: { symbol: sym } }));
                ws.send(JSON.stringify({ method: "sub.deal", param: { symbol: sym } }));
              });
            }
          }, (i / subBatch) * 50);
        }
        const ping = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ method: "ping" })); else clearInterval(ping); }, 15000);
      });
    }
  }

  return { init };
};
