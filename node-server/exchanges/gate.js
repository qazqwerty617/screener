"use strict";
/**
 * Gate.io Futures — Pro Terminal Speed
 * WS ticker + REST funding/OI poller
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let gtSyms = [];

  async function init() {
    try {
      if (updateExStatus) updateExStatus("GT", "connecting");
      const [contracts, tickersResp] = await Promise.all([
        apiFetch("https://api.gateio.ws/api/v4/futures/usdt/contracts", 25000, 2),
        apiFetch("https://api.gateio.ws/api/v4/futures/usdt/tickers", 25000, 2),
      ]);
      if (!Array.isArray(contracts) || !Array.isArray(tickersResp)) throw new Error("Gate.io API error");

      const byContract = new Map(tickersResp.filter(item => item && item.contract).map(item => [item.contract, item]));
      gtSyms = [];
      let added = 0;
      for (const contract of contracts) {
        if (!contract?.name || !contract.name.endsWith("_USDT")) continue;
        const ticker24h = byContract.get(contract.name);
        gtSyms.push(contract.name);
        const p = +(ticker24h?.last || contract.last_price || 0);
        const changePct = +(ticker24h?.change_percentage || 0);
        const o = p && Number.isFinite(changePct) ? p / (1 + changePct / 100) : 0;
        const h = +(ticker24h?.high_24h || 0);
        const l = +(ticker24h?.low_24h || 0);
        let oi = 0;
        if (ticker24h?.total_size && ticker24h?.quanto_multiplier) {
          oi = (+ticker24h.total_size) * (+ticker24h.quanto_multiplier) * p;
        }
        tickers.set("GT:" + contract.name, {
          key: "GT:" + contract.name, ex: "GT", sym: contract.name, base: contract.name.replace(/_USDT$/, ""),
          p, chg: o > 0 && p > 0 ? ((p - o) / o) * 100 : changePct,
          v: +(ticker24h?.volume_24h_quote || ticker24h?.volume_24h_settle || 0), h, l, o,
          funding: +(ticker24h?.funding_rate || contract.funding_rate || 0) * 100,
          nextFunding: +(ticker24h?.funding_rate_next_apply || contract.funding_next_apply || 0) * 1000,
          oi,
          cs: +contract.quanto_multiplier || 1
        });
        added++;
      }
      console.log(`[GT] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("GT:")) dirtyKeys.add(k); }
      connectWs();
      startFundingPoller();
    } catch (e) {
      console.error("[GT] Init error:", e.message);
      setTimeout(init, 3000);
    }
  }

  function startFundingPoller() {
    const poll = async () => {
      try {
        const tickersResp = await apiFetch("https://api.gateio.ws/api/v4/futures/usdt/tickers", 15000, 0);
        if (!Array.isArray(tickersResp)) return;
        for (const tick of tickersResp) {
          const t = tickers.get("GT:" + tick.contract);
          if (!t) continue;
          if (tick.funding_rate) t.funding = +tick.funding_rate * 100;
          if (tick.funding_rate_next_apply) t.nextFunding = +tick.funding_rate_next_apply * 1000;
          if (tick.total_size && tick.quanto_multiplier) {
            t.oi = (+tick.total_size) * (+tick.quanto_multiplier) * t.p;
          }
          dirtyKeys.add(t.key);
        }
      } catch (_) {}
    };
    setInterval(poll, 30000);
  }

  function connectWs() {
    mkExWs("GT", "wss://fx-ws.gateio.ws/v4/ws/usdt", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.event === "update" && d.channel === "futures.tickers" && d.result) {
          const ticks = Array.isArray(d.result) ? d.result : [d.result];
          for (const tick of ticks) {
            const sym = tick.s || tick.contract;
            if (!sym) continue;
            const t = tickers.get("GT:" + sym);
            if (t) {
              if (tick.last) t.p = +tick.last;
              if (tick.v) t.v = +tick.v; // GT uses 'v' for stats in some versions
              if (tick.volume_24h_quote) t.v = +tick.volume_24h_quote;
              if (tick.h) t.h = +tick.h;
              if (tick.l) t.l = +tick.l;
              if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
            }
          }
        } else if (d.event === "update" && d.channel === "futures.book_ticker" && d.result) {
          // book_ticker disabled — using LTP only from futures.tickers
        }
      } catch (_) {}
    }, (ws) => {
      // Subscribe all at once for simplicity, Gate supports many per connection
      const sub = (ch) => {
          ws.send(JSON.stringify({
            time: Math.floor(Date.now()/1000),
            channel: ch,
            event: "subscribe",
            payload: gtSyms
          }));
      };
      sub("futures.tickers");
    });
  }

  return { init };
};
