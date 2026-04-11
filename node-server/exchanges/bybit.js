"use strict";
/**
 * Bybit Futures — Pro Terminal Speed
 * Uses tickers.BTCUSDT (per-symbol push) for instant price + volume
 * Ping every 20s to prevent disconnects
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let bbSyms = [];

  async function init() {
    try {
      if (updateExStatus) updateExStatus("BB", "connecting");
      const [instrData, tickData] = await Promise.all([
        apiFetch("https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000", 15000, 2),
        apiFetch("https://api.bybit.com/v5/market/tickers?category=linear", 15000, 2),
      ]);

      const tradingSet = new Set(
        ((instrData.result && instrData.result.list) || []).filter(s => s.status === "Trading" && s.quoteCoin === "USDT" && s.contractType === "LinearPerpetual").map(s => s.symbol)
      );

      bbSyms = [];
      let added = 0;
      for (const d of (tickData.result && tickData.result.list) || []) {
        if (!tradingSet.has(d.symbol)) continue;
        bbSyms.push(d.symbol);
        const p = +d.lastPrice, o = +d.prevPrice24h, h = +d.highPrice24h, l = +d.lowPrice24h;
        tickers.set("BB:" + d.symbol, {
          key: "BB:" + d.symbol, ex: "BB", sym: d.symbol, base: d.symbol.replace(/USDT$/, ""),
          p, chg: (() => { const v = parseFloat(d.price24hPcnt); return (!isNaN(v) && v !== 0) ? v * 100 : (o > 0 && p > 0 ? ((p - o) / o) * 100 : 0); })(),
          v: +d.turnover24h, h, l, o, funding: +d.fundingRate * 100 || 0, nextFunding: +d.nextFundingTime || 0,
          oi: +d.openInterest * (+d.lastPrice) || 0,
        });
        added++;
      }
      console.log(`[BB] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("BB:")) dirtyKeys.add(k); }
      connectWs();
    } catch (e) {
      console.error("[BB] REST error:", e.message);
      setTimeout(init, 3000);
    }
  }

  function connectWs() {
    const bbBatchSize = Math.ceil(bbSyms.length / 3);
    for (let i = 0; i < bbSyms.length; i += bbBatchSize) {
      const chunk = bbSyms.slice(i, i + bbBatchSize);
      const connId = `BB_${i}`;
      mkExWs(connId, "wss://stream.bybit.com/v5/public/linear", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.topic?.startsWith("tickers.")) {
            const d = msg.data;
            const t = tickers.get("BB:" + d.symbol);
            if (t) {
              if (d.lastPrice) t.p = +d.lastPrice; // LTP
              if (d.turnover24h) t.v = +d.turnover24h; // USDT Turnover
              else if (d.volume24h) t.v = +d.volume24h * t.p;
              if (d.highPrice24h) t.h = +d.highPrice24h;
              if (d.lowPrice24h) t.l = +d.lowPrice24h;
              if (d.prevPrice24h) t.o = +d.prevPrice24h;
              if (d.fundingRate) t.funding = +d.fundingRate * 100;
              if (d.nextFundingTime) t.nextFunding = +d.nextFundingTime;
              if (d.openInterest) t.oi = +d.openInterest * t.p;
              if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
            }
          }
        } catch (_) {}
      }, (ws) => {
        for (let j = 0; j < chunk.length; j += 10) {
          const subChunk = chunk.slice(j, j + 10).map(s => `tickers.${s}`);
          ws.send(JSON.stringify({ op: "subscribe", args: subChunk }));
        }
        setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ op: "ping" })); }, 20000);
      });
    }
  }

  return { init };
};
