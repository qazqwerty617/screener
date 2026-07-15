"use strict";

const { default: fetch } = require("node-fetch");

async function apiFetch(url) {
  const r = await fetch(url, { timeout: 10000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function testOX() {
  const data = await apiFetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const filtered = (data.data || []).filter(d => d.instId.endsWith("-USDT")).map(d => ({
    sym: d.instId.replace("-", "") + "_SPOT",
    base: d.instId.split("-")[0],
    p: +d.last,
    v: +d.volCcy24h
  })).sort((a,b) => b.v - a.v).slice(0, 5);
  console.log("OX Spot:", filtered);
}

async function testBX() {
  const data = await apiFetch("https://open-api.bingx.com/openApi/spot/v1/ticker/24hr");
  const filtered = (data.data || []).filter(d => d.symbol.endsWith("-USDT")).map(d => ({
    sym: d.symbol.replace("-", "") + "_SPOT",
    base: d.symbol.split("-")[0],
    p: +d.lastPrice,
    v: +d.quoteVolume
  })).sort((a,b) => b.v - a.v).slice(0, 5);
  console.log("BX Spot:", filtered);
}

async function run() {
  console.log("Starting Spot tickers fetch tests (updated)...");
  await testOX();
  await testBX();
  console.log("Updated Spot fetch tests completed successfully!");
}

run().catch(console.error);
