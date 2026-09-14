"use strict";

const zlib = require("zlib");

/**
 * HTX (Huobi) Futures
 * Uses market tickers API for initial data +Detail WS for active updates
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let htSyms = [];
  const wsToSym = new Map();

  async function init() {
    try {
      if (updateExStatus) updateExStatus("HT", "connecting");
      // Use standard futures API domain
      const [data, fundingResp, contractInfo] = await Promise.all([
        apiFetch("https://api.hbdm.vn/linear-swap-ex/market/detail/batch_merged", 15000, 2),
        apiFetch("https://api.hbdm.vn/linear-swap-api/v1/swap_batch_funding_rate", 15000, 2),
        apiFetch("https://api.hbdm.vn/linear-swap-api/v1/swap_contract_info", 15000, 2)
      ]);
      if (data.status !== "ok") {
         console.log("[HT] Raw response keys:", Object.keys(data));
         throw new Error("Invalid response status: " + (data.status || "no data"));
      }
      
      const ticks = data.data || data.ticks || (data.tick ? [data.tick] : []);
      if (!Array.isArray(ticks) || ticks.length === 0) {
         console.log("[HT] Data detail:", JSON.stringify(data).substring(0, 500));
         throw new Error("Response data/ticks is not a valid array");
      }
      
      const fundingBySymbol = new Map((fundingResp?.data || []).map(i => [i.contract_code, i]));

      const sizeMap = new Map();
      if (contractInfo && Array.isArray(contractInfo.data)) {
        for (const item of contractInfo.data) {
          if (item.contract_code && item.contract_size) {
            sizeMap.set(item.contract_code, +item.contract_size);
          }
        }
      }

      for (const tick of ticks) {
        const sym = tick.symbol || tick.contract_code;
        if (!sym) continue;
        const fm = fundingBySymbol.get(sym);
        const p = +tick.close, o = +tick.open, h = +tick.high, l = +tick.low;
        const v = +tick.trade_turnover || (+tick.amount * p);
        const cs = sizeMap.get(sym) || 1;
        tickers.set("HT:" + sym, {
          key: "HT:" + sym, ex: "HT", sym, base: sym.split("-")[0],
          p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : 0,
          v, h, l, o, funding: fm ? +fm.funding_rate * 100 : 0, nextFunding: fm ? +fm.next_funding_time : 0,
          cs
        });
        htSyms.push(sym);
      }

      console.log(`[HT] Loaded ${htSyms.length} symbols (domain: api.hbdm.vn)`);
      for (const [k] of tickers) { if (k.startsWith("HT:")) dirtyKeys.add(k); }
      connectWs();
      startPolling(); // Fallback polling every 5s for stats
    } catch (e) {
      console.error("[HT] Init error:", e.message);
      // Retry faster
      setTimeout(init, 5000);
    }
  }

  function startPolling() {
      setInterval(async () => {
          try {
              const [data, fundingResp] = await Promise.all([
                  apiFetch("https://api.hbdm.vn/linear-swap-ex/market/detail/batch_merged", 5000, 0),
                  apiFetch("https://api.hbdm.vn/linear-swap-api/v1/swap_batch_funding_rate", 5000, 0)
              ]);
              
              const fundingMap = new Map((fundingResp?.data || []).map(i => [i.contract_code, i]));

              if (data.status === "ok" && data.data) {
                  for (const tick of data.data) {
                      const sym = tick.symbol || tick.contract_code;
                      const t = tickers.get("HT:" + sym);
                      if (t) {
                          if (tick.close) t.p = +tick.close;
                          if (tick.trade_turnover) t.v = +tick.trade_turnover; // USDT Turnover
                          else if (tick.amount && t.p) t.v = +tick.amount * t.p;
                          if (tick.high) t.h = +tick.high;
                          if (tick.low) t.l = +tick.low;
                          
                          const fm = fundingMap.get(sym);
                          if (fm) {
                              t.funding = +fm.funding_rate * 100;
                              t.nextFunding = +fm.next_funding_time;
                          }
                          if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
                          dirtyKeys.add(t.key);
                      }
                  }
              }
          } catch (_) {}
      }, 5000);
  }

    function connectWs() {
    mkExWs("HT", "wss://api.hbdm.vn/linear-swap-ws", (raw, ws) => {
      try {
        const d = JSON.parse(zlib.gunzipSync(raw).toString());
        if (d.ping) { ws.send(JSON.stringify({ pong: d.ping })); return; }

        if (d.tick && d.ch) {
          const symKey = wsToSym.get(d.ch);
          if (!symKey) return;
          const t = tickers.get(symKey);
          if (!t) return;
          
          const tick = d.tick;
          if (d.ch.includes(".trade.detail")) {
            if (tick.data?.[0]?.price) t.p = +tick.data[0].price; // Accurate Trade Price
          } else {
            if (tick.trade_turnover) t.v = +tick.trade_turnover;
            else if (tick.amount && t.p) t.v = +tick.amount * t.p;
            if (tick.high) t.h = +tick.high;
            if (tick.low) t.l = +tick.low;
            if (!t.p && tick.close) t.p = +tick.close;
          }
          if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
          dirtyKeys.add(t.key);
        }
      } catch (_) {}
    }, (ws) => {
      for (const s of htSyms) {
        const detailCh = `market.${s}.detail`; 
        const tradeCh = `market.${s}.trade.detail`;
        wsToSym.set(detailCh, "HT:" + s);
        wsToSym.set(tradeCh, "HT:" + s);
        ws.send(JSON.stringify({ sub: detailCh, id: s + "_det" }));
        ws.send(JSON.stringify({ sub: tradeCh, id: s + "_trd" }));
      }
    });
  }

  return { init };
};
