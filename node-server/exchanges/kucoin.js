"use strict";
/**
 * KuCoin Futures — Pro Terminal Speed
 * Mid-price from order book (bestBid+bestAsk)/2 for maximum accuracy
 * Level2 depth for instant BBO updates + ticker for stats
 */
module.exports = function (tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let kcSyms = [];

  async function init() {
    try {
      if (updateExStatus) updateExStatus("KC", "connecting");
      const data = await apiFetch("https://api-futures.kucoin.com/api/v1/contracts/active", 15000, 2);
      if (data.code !== "200000" || !Array.isArray(data.data)) throw new Error(`KuCoin API error: ${data.msg || "Invalid response"}`);

      kcSyms = [];
      let added = 0;
      for (const d of data.data) {
        if (!d.symbol || !d.symbol.endsWith("USDTM")) continue;
        if (d.status && d.status !== "Open") continue;
        kcSyms.push(d.symbol);
        const p = +(d.lastTradePrice || d.markPrice || d.indexPrice || 0);
        const changeRate = +(d.priceChgPct || 0);
        const o = p > 0 && Number.isFinite(changeRate) && changeRate > -1 ? p / (1 + changeRate) : 0;
        const h = +(d.highPrice || 0);
        const l = +(d.lowPrice || 0);
        const v = +(d.turnoverOf24h || 0) || (+(d.volumeOf24h || 0) * (p || 0));
        const multiplier = +(d.multiplier || 1);
        tickers.set("KC:" + d.symbol, {
          key: "KC:" + d.symbol, ex: "KC", sym: d.symbol, base: d.symbol.replace(/USDTM$/, ""),
          p, chg: Number.isFinite(changeRate) ? changeRate * 100 : (o > 0 && p > 0 ? ((p - o) / o) * 100 : 0),
          v: Number.isFinite(v) ? v : 0, h: h > 0 ? h : p, l: l > 0 ? l : p, o,
          funding: +d.fundingFeeRate * 100 || 0, nextFunding: d.nextFundingRateTime ? Date.now() + d.nextFundingRateTime : 0,
          oi: d.openInterest ? +d.openInterest * p * multiplier : 0,
          cs: multiplier
        });
        added++;
      }
      console.log(`[KC] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("KC:")) dirtyKeys.add(k); }
      connectWs();
      startRestPolling();
    } catch (e) {
      console.error("[KC] Init error:", e.message);
      setTimeout(init, 3000);
    }
  }

  async function connectWs() {
    try {
      const tokenResp = await apiFetch("https://api-futures.kucoin.com/api/v1/bullet-public", 10000, 1, "POST");
      if (!tokenResp.data?.instanceServers?.[0]) {
        console.warn("[KC] No WS token, REST-only mode");
        return;
      }
      const server = tokenResp.data.instanceServers[0];
      const url = `${server.endpoint}?token=${tokenResp.data.token}`;

      // Split into connections of ~100 symbols each
      const chunkSize = 100;
      for (let i = 0; i < kcSyms.length; i += chunkSize) {
        const chunk = kcSyms.slice(i, i + chunkSize);
        const connId = `KC${i === 0 ? "" : "_" + i}`;

        mkExWs(connId, url, (raw) => {
          try {
            const d = JSON.parse(raw.toString());
            if (d.type === "welcome" || d.type === "ack" || d.type === "error" || d.type === "pong") return;

            // tickerV2 — has bestBidPrice/bestAskPrice for mid-price
            if (d.subject === "tickerV2" && d.data) {
              const tick = d.data;
              const sym = tick.symbol;
              if (!sym) return;
              const t = tickers.get("KC:" + sym);
              if (!t) return;

              // Mid-price from best bid/ask (pro terminal accuracy)
              const bid = +(tick.bestBidPrice || 0);
              const ask = +(tick.bestAskPrice || 0);
              if (bid > 0 && ask > 0) {
                t.p = (bid + ask) / 2;
              } else {
                const lp = +(tick.price || 0);
                if (lp > 0) t.p = lp;
              }

              if (tick.turnover) t.v = +tick.turnover;
              if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
              return;
            }

            // ticker (legacy) — backup for stats
            if (d.subject === "ticker" && d.data) {
              const tick = d.data;
              const sym = tick.symbol || d.topic?.split(":")[1];
              if (!sym) return;
              const t = tickers.get("KC:" + sym);
              if (!t) return;

              const bid = +(tick.bestBidPrice || 0);
              const ask = +(tick.bestAskPrice || 0);
              if (bid > 0 && ask > 0) {
                t.p = (bid + ask) / 2;
              } else {
                const lp = +(tick.price || tick.lastTradePrice || 0);
                if (lp > 0) t.p = lp;
              }

              if (tick.volValue || tick.turnover) t.v = +(tick.volValue || tick.turnover);
              if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
              return;
            }

            // execution — real-time trade price as additional signal
            if (d.subject === "match" && d.data) {
              const tick = d.data;
              const sym = tick.symbol;
              if (!sym) return;
              const t = tickers.get("KC:" + sym);
              if (t) {
                const lp = +(tick.price || 0);
                if (lp > 0) {
                  t.p = lp;
                  if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
                  dirtyKeys.add(t.key);
                }
              }
            }
          } catch (_) { }
        }, (ws) => {
          // Subscribe to tickerV2 — best bid/ask mid-price (fastest, most accurate)
          ws.send(JSON.stringify({
            id: Date.now(), type: "subscribe",
            topic: `/contractMarket/tickerV2:${chunk.join(",")}`,
            privateChannel: false, response: true
          }));
          // Subscribe to execution — real-time trades
          ws.send(JSON.stringify({
            id: Date.now() + 1, type: "subscribe",
            topic: `/contractMarket/execution:${chunk.join(",")}`,
            privateChannel: false, response: true
          }));
          // Subscribe to ticker — stats backup
          ws.send(JSON.stringify({
            id: Date.now() + 2, type: "subscribe",
            topic: `/contractMarket/ticker:${chunk.join(",")}`,
            privateChannel: false, response: true
          }));
          const ping = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ id: Date.now(), type: "ping" }));
            else { clearInterval(ping); }
          }, 18000);
        });
      }
    } catch (e) {
      console.error("[KC] WS error:", e.message);
    }
  }

  function startRestPolling() {
    const poll = async () => {
      try {
        const data = await apiFetch("https://api-futures.kucoin.com/api/v1/contracts/active", 12000, 0);
        if (data.code !== "200000" || !Array.isArray(data.data)) return;
        for (const d of data.data) {
          if (!d.symbol || !d.symbol.endsWith("USDTM")) continue;
          const t = tickers.get("KC:" + d.symbol);
          if (!t) continue;
          const changeRate = +(d.priceChgPct || 0);
          const h = +(d.highPrice || t.h);
          const l = +(d.lowPrice || t.l);
          const p = +(d.lastTradePrice || d.markPrice || t.p);
          const o = p > 0 && Number.isFinite(changeRate) && changeRate > -1 ? p / (1 + changeRate) : t.o;
          const v = +(d.turnoverOf24h || 0) || (+(d.volumeOf24h || 0) * p);
          // Don't overwrite WS mid-price with REST lastTradePrice
          t.h = h > 0 ? h : t.h;
          t.l = l > 0 ? l : t.l;
          t.o = o > 0 ? o : t.o;
          t.v = Number.isFinite(v) ? v : t.v;
          if (d.fundingFeeRate !== undefined) t.funding = +d.fundingFeeRate * 100;
          if (d.openInterest) {
            const multiplier = +(d.multiplier || 1);
            t.oi = +d.openInterest * t.p * multiplier;
          }
          if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
          dirtyKeys.add(t.key);
        }
      } catch (_) { }
    };
    setInterval(poll, 5000);
  }

  return { init };
};
