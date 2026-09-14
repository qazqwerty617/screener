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
      const [data, contracts] = await Promise.all([
        apiFetch("https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES", 15000, 2),
        apiFetch("https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES", 15000, 2),
      ]);
      if (data.code !== "00000" || !data.data) throw new Error(`Bitget API error: ${data.msg || "No data"}`);

      // Bitget exposes the authoritative RWA classification on contract
      // metadata. Preserve it on the ticker instead of guessing from an
      // ever-growing list of company names; the density scanner excludes it
      // while the rest of the terminal can continue displaying the market.
      const contractRows = contracts && contracts.code === "00000" && Array.isArray(contracts.data) ? contracts.data : [];
      const contractBySymbol = new Map(contractRows.map(item => [item.symbol, item]));
      const rwaSymbols = new Set(
        contractRows
          .filter(item => String(item.isRwa).toUpperCase() === "YES")
          .map(item => item.symbol)
      );

      bgSyms = [];
      let added = 0;
      for (const d of data.data) {
        if (!d.symbol || !d.symbol.endsWith("USDT")) continue;
        bgSyms.push(d.symbol);
        const p = +d.lastPr, o = +d.open24h, h = +d.high24h, l = +d.low24h;
        const contract = contractBySymbol.get(d.symbol);
        tickers.set("BG:" + d.symbol, {
          key: "BG:" + d.symbol, ex: "BG", sym: d.symbol, base: d.symbol.replace(/USDT$/, ""),
          p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : 0,
          v: +d.usdtVolume, h, l, o, funding: +d.fundingRate * 100 || 0, nextFunding: +d.nextFundingTime || 0,
          oi: +d.openInterest * p || 0,
          bid: +d.bidPr || 0, ask: +d.askPr || 0, quoteTs: Date.now(), fundingInterval: +contract?.fundInterval || 8,
          takerFeePct: +contract?.takerFeeRate > 0 ? +contract.takerFeeRate * 100 : 0,
          isRwa: rwaSymbols.has(d.symbol),
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
        if (Buffer.isBuffer(raw)) {
          if (raw[0] !== 123) return;
        } else if (typeof raw === "string") {
          if (raw.charCodeAt(0) !== 123) return;
        }
        const str = typeof raw === "string" ? raw : raw.toString();
        const d = JSON.parse(str);
        if ((d.action === "update" || d.action === "snapshot") && d.data && d.arg?.channel === "ticker") {
          const now = Date.now();
          for (let i = 0; i < d.data.length; i++) {
            const tick = d.data[i];
            const t = tickers.get("BG:" + tick.instId);
            if (!t) continue;
            if (tick.lastPr) t.p = +tick.lastPr; // LTP Anchor
            if (+tick.bidPr > 0) t.bid = +tick.bidPr;
            if (+tick.askPr > 0) t.ask = +tick.askPr;
            if (tick.lastPr || tick.bidPr || tick.askPr) t.quoteTs = now;
            if (tick.usdtVolume) t.v = +tick.usdtVolume; // USDT Turnover
            if (tick.high24h) t.h = +tick.high24h;
            if (tick.low24h) t.l = +tick.low24h;
            if (tick.open24h) t.o = +tick.open24h;
            if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
            dirtyKeys.add(t.key);
          }
        }
      } catch (_) {}
    }, (ws) => {
      let batchIdx = 0;
      for (let i = 0; i < bgSyms.length; i += 50) {
        const chunk = bgSyms.slice(i, i + 50);
        const args = [];
        chunk.forEach(s => {
          args.push({ instType: "USDT-FUTURES", channel: "ticker", instId: s });
        });
        const currentBatch = batchIdx++;
        setTimeout(() => {
          if (ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({ op: "subscribe", args }));
            } catch (_) {}
          }
        }, currentBatch * 50);
      }
      const ping = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); else clearInterval(ping); }, 20000);
    });
  }

  return { init };
};
