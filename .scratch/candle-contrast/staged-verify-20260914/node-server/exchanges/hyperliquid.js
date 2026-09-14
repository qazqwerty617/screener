"use strict";
/**
 * Hyperliquid Futures — Pro Terminal Speed
 * Uses allMids WS subscription for all prices at once (instead of 180 l2Book subscriptions)
 * + Fast REST polling for volume/funding/OI
 */
module.exports = function(tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus) {
  let hlSyms = [];

  async function init() {
    try {
      if (updateExStatus) updateExStatus("HL", "connecting");
      const [meta, mids, ctxData] = await Promise.all([
        apiFetch("https://api.hyperliquid.xyz/info", 15000, 2, "POST", { type: "meta" }),
        apiFetch("https://api.hyperliquid.xyz/info", 15000, 2, "POST", { type: "allMids" }),
        apiFetch("https://api.hyperliquid.xyz/info", 15000, 2, "POST", { type: "metaAndAssetCtxs" }),
      ]);
      if (!meta?.universe || !mids) throw new Error("Hyperliquid API error");

      hlSyms = meta.universe.map(s => s.name);
      
      // Build context map for volume/OI/funding
      const ctxMap = new Map();
      if (Array.isArray(ctxData) && ctxData.length >= 2) {
        const universe = ctxData[0].universe;
        const assetCtxs = ctxData[1];
        universe.forEach((s, i) => { ctxMap.set(s.name, assetCtxs[i]); });
      }

      let added = 0;
      for (const s of meta.universe) {
        const mid = +mids[s.name] || 0;
        if (mid === 0) continue;
        const ctx = ctxMap.get(s.name);
        const o = ctx ? +ctx.prevDayPx || mid : mid;
        tickers.set("HL:" + s.name, {
          key: "HL:" + s.name, ex: "HL", sym: s.name, base: s.name,
          p: mid, chg: o > 0 ? ((mid - o) / o) * 100 : 0,
          v: ctx ? +ctx.dayNtlVlm || 0 : 0,
          h: mid, l: mid, o,
          funding: ctx ? +ctx.funding * 100 : 0,
          nextFunding: Date.now() + (3600000 - (Date.now() % 3600000)),
          oi: ctx ? +ctx.openInterest * mid : 0,
        });
        added++;
      }
      console.log(`[HL] Loaded ${added} symbols`);
      for (const [k] of tickers) { if (k.startsWith("HL:")) dirtyKeys.add(k); }
      connectWs();
      startCtxPoller();
    } catch (e) {
      console.error("[HL] Init error:", e.message);
      setTimeout(init, 3000);
    }
  }

  function startCtxPoller() {
    // Full context poll for volume, OI, funding every 15s
    const poll = async () => {
      try {
        const data = await apiFetch("https://api.hyperliquid.xyz/info", 15000, 0, "POST", { type: "metaAndAssetCtxs" });
        if (Array.isArray(data) && data.length >= 2) {
          const universe = data[0].universe;
          const assetCtxs = data[1];
          universe.forEach((s, i) => {
            const ctx = assetCtxs[i];
            const t = tickers.get("HL:" + s.name);
            if (t && ctx) {
              t.funding = +ctx.funding * 100;
              t.oi = +ctx.openInterest * t.p;
              t.v = +ctx.dayNtlVlm || 0;
              const prevO = +ctx.prevDayPx;
              if (prevO > 0) t.o = prevO;
              if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
              t.nextFunding = Date.now() + (3600000 - (Date.now() % 3600000));
              dirtyKeys.add(t.key);
            }
          });
        }
      } catch (_) {}
    };
    setInterval(poll, 15000);
  }

  function connectWs() {
    // allMids subscription — real-time mid prices for all assets at once
    const chunkSize = 50;
    for (let i = 0; i < hlSyms.length; i += chunkSize) {
      const chunk = hlSyms.slice(i, i + chunkSize);
      mkExWs("HL" + (i===0?"":"_" + i), "wss://api.hyperliquid.xyz/ws", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.channel === "allMids" && msg.data?.mids) {
            for (const [sym, mid] of Object.entries(msg.data.mids)) {
              const t = tickers.get("HL:" + sym);
              if (t && mid) {
                t.p = +mid;
                if (t.o > 0) t.chg = ((t.p - t.o) / t.o) * 100;
                if (t.p > t.h) t.h = t.p;
                if (t.l === 0 || t.p < t.l) t.l = t.p;
                dirtyKeys.add(t.key);
              }
            }
          }
        } catch (_) {}
      }, (ws) => {
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
      });
      break; // allMids covers all symbols in one connection
    }
  }

  return { init };
};
