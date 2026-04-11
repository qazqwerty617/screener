"use strict";
/**
 * OKX Futures — Pro Terminal Speed
 * Architecture matches Binance: trades WS for instant price + tickers WS for stats
 * 
 * 1. trades channel    → real-time price via executed trades (like BN aggTrade)
 * 2. tickers channel   → vol24h, high, low, open (stats, ~1s updates)
 * 3. funding-rate REST → funding rate polling (batched)
 */
const https = require("https");

async function okxFetch(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  const ctValMap = new Map();   // instId -> ctVal
  let initialized = false;
  let okSyms = [];

  async function init() {
    if (updateExStatus) updateExStatus("OX", "connecting");
    await new Promise(r => setTimeout(r, 2000));

    try {
      console.log("[OX] Fetching instruments...");
      const data = await okxFetch("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
      const swp = (data.data || []).filter(s => s.ctType === "linear" && s.settleCcy === "USDT");
      okSyms = [];
      for (const s of swp) {
        ctValMap.set(s.instId, +s.ctVal || 1);
        okSyms.push(s.instId);
        if (!tickers.has("OX:" + s.instId)) {
          tickers.set("OX:" + s.instId, {
            key: "OX:" + s.instId, ex: "OX", sym: s.instId, base: s.ctValCcy,
            p: 0, chg: 0, v: 0, h: 0, l: 0, o: 0, funding: 0, nextFunding: 0,
          });
        }
      }
      console.log(`[OX] Loaded ${okSyms.length} symbols`);

      // Fetch initial 24h stats via REST to populate immediately
      try {
        const tickerData = await okxFetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
        for (const tick of (tickerData.data || [])) {
          const t = tickers.get("OX:" + tick.instId);
          if (!t) continue;
          const p = +tick.last;
          if (p > 0) t.p = p;
          if (tick.open24h) t.o = +tick.open24h;
          if (tick.high24h) t.h = +tick.high24h;
          if (tick.low24h) t.l = +tick.low24h;
          if (tick.vol24h) {
            const ctVal = ctValMap.get(tick.instId) || 1;
            t.v = +tick.vol24h * ctVal * (t.p || 1);
          }
          if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
          dirtyKeys.add(t.key);
        }
        console.log("[OX] Initial ticker stats loaded");
      } catch (e) {
        console.warn("[OX] Initial stats fetch failed:", e.message);
      }
    } catch (e) {
      console.error("[OX] Instruments error:", e.message);
      setTimeout(init, 3000);
      return;
    }

    for (const [k] of tickers) { if (k.startsWith("OX:")) dirtyKeys.add(k); }
    connectWs();
    startFundingPoller();
  }

  function startFundingPoller() {
    let idx = 0;
    const poll = async () => {
      if (!okSyms.length) return;
      const batch = okSyms.slice(idx, idx + 5);
      idx = (idx + 5) % okSyms.length;
      try {
        const results = await Promise.allSettled(
          batch.map(sym => okxFetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${sym}`))
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value?.data?.[0]) {
            const d = r.value.data[0];
            const t = tickers.get("OX:" + d.instId);
            if (t) { t.funding = +d.fundingRate * 100; t.nextFunding = +d.nextFundingTime; dirtyKeys.add(t.key); }
          }
        }
      } catch (_) {}
    };
    setInterval(poll, 1000);
    poll();
  }

  function connectWs() {
    // ── 1. Trades: real-time price via executed trades (like BN aggTrade) ──
    // OKX allows up to 100 args per subscribe. Split into connections of ~80 symbols.
    const tradesBatch = 80;
    for (let i = 0; i < okSyms.length; i += tradesBatch) {
      const chunk = okSyms.slice(i, i + tradesBatch);
      mkExWs(`OX-Trades-${i}`, "wss://ws.okx.com:8443/ws/v5/public", (raw) => {
        if (raw.toString() === "pong") return;
        try {
          const d = JSON.parse(raw.toString());
          if (!d.data || d.arg?.channel !== "trades") return;
          for (const trade of d.data) {
            const instId = trade.instId || d.arg.instId;
            const t = tickers.get("OX:" + instId);
            if (!t) continue;
            const p = +trade.px;
            if (p > 0) {
              t.p = p;
              if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              dirtyKeys.add(t.key);
            }
          }
        } catch (_) {}
      }, (ws) => {
        // Subscribe in batches of 20 (OKX recommends small batches)
        for (let j = 0; j < chunk.length; j += 20) {
          const args = chunk.slice(j, j + 20).map(instId => ({ channel: "trades", instId }));
          ws.send(JSON.stringify({ op: "subscribe", args }));
        }
        setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 20000);
      });
    }

    // ── 2. Stats: tickers for vol, high, low, open (~1s updates) ──
    const statsBatch = Math.ceil(okSyms.length / 2);
    for (let i = 0; i < okSyms.length; i += statsBatch) {
      const chunk = okSyms.slice(i, i + statsBatch);
      mkExWs(`OX-Stats-${i}`, "wss://ws.okx.com:8443/ws/v5/public", (raw) => {
        if (raw.toString() === "pong") return;
        try {
          const d = JSON.parse(raw.toString());
          if (!d.data || d.arg?.channel !== "tickers") return;
          for (const tick of d.data) {
            const instId = tick.instId || d.arg.instId;
            const t = tickers.get("OX:" + instId);
            if (!t) continue;
            
            if (tick.vol24h) {
              const ctVal = ctValMap.get(instId) || 1;
              t.v = +tick.vol24h * ctVal * (t.p || +tick.last || 1);
            }
            if (tick.high24h) t.h = +tick.high24h;
            if (tick.low24h) t.l = +tick.low24h;
            if (tick.open24h) t.o = +tick.open24h;
            // Don't update price here — trades channel is faster & more accurate
            
            if (t.o > 0 && t.p > 0) t.chg = ((t.p - t.o) / t.o) * 100;
            dirtyKeys.add(t.key);
          }
          if (!initialized) {
             initialized = true;
             console.log("[OX] Live data flowing");
             for (const [k] of tickers) { if (k.startsWith("OX:")) dirtyKeys.add(k); }
          }
        } catch (_) {}
      }, (ws) => {
        for (let j = 0; j < chunk.length; j += 20) {
          const args = chunk.slice(j, j + 20).map(instId => ({ channel: "tickers", instId }));
          ws.send(JSON.stringify({ op: "subscribe", args }));
        }
        setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 20000);
      });
    }
  }

  return { init };
};
