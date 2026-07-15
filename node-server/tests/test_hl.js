"use strict";

const { default: fetch } = require("node-fetch");

async function apiFetch(url, timeoutMs = 8000, retries = 1, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function testCoin(coinName) {
  console.log(`\n--- Testing coin: ${coinName} ---`);
  try {
    const d = await apiFetch("https://api.hyperliquid.xyz/info", 8000, 0, "POST", {
      type: "l2Book",
      coin: coinName,
      nSigFigs: 4
    });
    const levels = d.levels || [[], []];
    const bids = (levels[0] || []).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
    const asks = (levels[1] || []).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));

    console.log("Bids count:", bids.length, "Asks count:", asks.length);
    if (bids.length > 0) {
      console.log("First Bid:", bids[0]);
      console.log("Last Bid:", bids[bids.length - 1]);
      
      const mid = bids[0].price;
      const lastBidDist = Math.abs(bids[bids.length - 1].price - mid) / mid * 100;
      console.log(`Max bid distance: ${lastBidDist.toFixed(4)}%`);
      
      let countPassDist = 0;
      for (const b of bids) {
        const dist = Math.abs(b.price - mid) / mid * 100;
        if (dist >= 0.05 && dist <= 5.0) countPassDist++;
      }
      console.log(`Bids passing distance check (0.05% - 5.0%): ${countPassDist} / ${bids.length}`);
    }
  } catch (e) {
    console.error(`Error for ${coinName}:`, e.message);
  }
}

async function run() {
  await testCoin("BTC");
  await testCoin("ETH");
  await testCoin("SOL");
  await testCoin("HYPE");
  await testCoin("POPCAT");
}

run().catch(console.error);
