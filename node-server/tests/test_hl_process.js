"use strict";

const { default: fetch } = require("node-fetch");

async function apiFetch(url, timeout, retries, method = "GET", body = null) {
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    timeout
  };
  if (body) options.body = JSON.stringify(body);
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function run() {
  const depth = 50;
  
  // Fetch L2 Book with coin as string
  const d = await apiFetch("https://api.hyperliquid.xyz/info", 10000, 0, "POST", { type: "l2Book", coin: "BTC", nSigFigs: 4 });
  const levels = d.levels || [[], []];
  const bids = (levels[0] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
  const asks = (levels[1] || []).slice(0, depth).map(l => ({ price: +l.px, qty: +l.sz, usd: +l.px * +l.sz }));
  
  console.log(`Fetched Bids count: ${bids.length}, Asks count: ${asks.length}`);
  if (bids.length > 0) {
    console.log("Top 5 Bids USD:", bids.slice(0, 5).map(b => `${b.price}: $${Math.round(b.usd)}`));
  }
  
  // Let's run a simulation of processOrderbook binning
  const price = (bids[0].price + asks[0].price) * 0.5;
  console.log("Calculated Mid Price:", price);
  
  const bidsByBin = new Map();
  const asksByBin = new Map();
  
  const BIN_STEP_PCT = 0.001; // 0.1% price bins
  
  for (const b of bids) {
    const dist = (price - b.price) / price * 100;
    if (dist < 0.05 || dist > 5.0) continue;
    const binIdx = Math.floor(dist / 0.1);
    const cur = bidsByBin.get(binIdx) || { usd: 0, maxPr: 0 };
    cur.usd += b.usd;
    cur.maxPr = Math.max(cur.maxPr, b.price);
    bidsByBin.set(binIdx, cur);
  }
  
  console.log("Binned Bids:", Array.from(bidsByBin.entries()).map(([k, v]) => `Bin ${k} (dist ${(k*0.1).toFixed(1)}%): $${Math.round(v.usd)}`));
}

run().catch(console.error);
