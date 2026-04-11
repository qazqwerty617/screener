"use strict";
/**
 * Bitget Futures — Pro Terminal Speed
 * WS ticker + REST funding poller
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let bgSyms = [];

  async function init() {
    try {
      if (updateExStatus) updateExStatus("BG", "connecting");
      const data = await apiFetch("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES", 15000, 2);
      if (data.code !== "00000" || !data.data) throw new Error(`Bitget API error: ${data.msg || "No data"}`);

      bgSyms = [];
      let added = 0;
      for (const d of data.data) {
        if (!d.symbol || !d.symbol.endsWith("USDT")) continue;
        bgSyms.push(d.symbol);
        const p = +d.lastPr, o = +d.open24h, h = +d.high24h, l = +d.low24h;
        tickers.set("BG:" + d.symbol, {
          key: "BG:" + d.symbol, ex: "BG", sym: d.symbol, base: d.symbol.replace(/USDT$/, ""),
          p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : 0,
          v: +d.usdtVolume, h, l, o, funding: +d.fundingRate * 100 || 0, nextFunding: +d.nextFundingTime || 0,
          oi: +d.openInterest * p || 0,
        });
        added++;
      }
      console.log(`[BG] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("BG:")) dirtyKeys.add(k); }
      connectWs();
      startFundingPoller();
    } catch (e) {
      console.error("[BG] Init error:", e.message);
      setTimeout(init, 3000);
    }
  }

  function startFundingPoller() {
    const poll = async () => {
      try {
        const data = await apiFetch("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES", 15000, 0);
        if (data.code !== "00000" || !data.data) return;
        for (const d of data.data) {
          const t = tickers.get("BG:" + d.symbol);
          if (!t) continue;
          if (d.fundingRate) t.funding = +d.fundingRate * 100;
          if (d.nextFundingTime) t.nextFunding = +d.nextFundingTime;
          if (d.openInterest) t.oi = +d.openInterest * t.p;
          dirtyKeys.add(t.key);
        }
      } catch (_) {}
    };
    setInterval(poll, 30000);
  }

  function connectWs() {
    mkExWs("BG", "wss://ws.bitget.com/v2/ws/public", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if ((d.action === "update" || d.action === "snapshot")) {
          if (d.arg?.channel === "ticker") {
            for (const tick of d.data) {
              const t = tickers.get("BG:" + tick.instId);
              if (!t) continue;
              if (tick.lastPr) t.p = +tick.lastPr; // LTP Anchor
              if (tick.usdtVolume) t.v = +tick.usdtVolume; // USDT Turnover
              if (tick.high24h) t.h = +tick.high24h;
              if (tick.low24h) t.l = +tick.low24h;
              if (tick.open24h) t.o = +tick.open24h;
              if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
            }
          } else if (d.arg?.channel === "books1") {
            // books1 disabled — using LTP only from ticker channel
          }
        }
      } catch (_) {}
    }, (ws) => {
      for (let i = 0; i < bgSyms.length; i += 50) {
        const chunk = bgSyms.slice(i, i + 50);
        const args = [];
        chunk.forEach(s => {
          args.push({ instType: "USDT-FUTURES", channel: "ticker", instId: s });
        });
        ws.send(JSON.stringify({ op: "subscribe", args }));
      }
      const ping = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); else clearInterval(ping); }, 20000);
    });
  }

  return { init };
};
