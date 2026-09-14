"use strict";

const { WebSocket } = require("ws");

// Mock tickers and dirtyKeys
const tickers = new Map();
const dirtyKeys = new Set();

// Mock mkExWs
function mkExWs(url, onMsg, onOpen) {
  console.log(`[TEST] Connecting to WS: ${url}`);
  const ws = new WebSocket(url);
  ws.on("open", () => {
    console.log(`[TEST] WS Connected: ${url}`);
    if (onOpen) onOpen(ws);
  });
  ws.on("message", (data) => {
    onMsg(data);
    console.log(`[TEST] Received data from ${url.split('/')[2]} (${data.length} bytes)`);
    // After receiving first message, we can assume it works
    ws.close();
  });
  ws.on("error", (err) => console.error(`[TEST] WS Error ${url}:`, err.message));
  return { stop: () => ws.terminate(), send: (d) => ws.send(d) };
}

// Mock apiFetch
async function apiFetch(url) {
  console.log(`[TEST] Fetching REST: ${url}`);
  const { default: fetch } = await import("node-fetch");
  const r = await fetch(url);
  return r.json();
}

const exchanges = {
  BG: require("../exchanges/bitget"),
  GT: require("../exchanges/gate"),
  MX: require("../exchanges/mexc"),
  KC: require("../exchanges/kucoin"),
  BX: require("../exchanges/bingx"),
  HT: require("../exchanges/htx"),
  HL: require("../exchanges/hyperliquid"),
  AD: require("../exchanges/asterdex"),
};

async function runTests() {
  console.log("=== STARTING EXCHANGE INTEGRATION TESTS ===\n");
  
  for (const [id, module] of Object.entries(exchanges)) {
    console.log(`\n--- Testing ${id} ---`);
    try {
      const instance = module(tickers, dirtyKeys, mkExWs, apiFetch);
      await instance.init();
      console.log(`[PASS] ${id} initialized with ${Array.from(tickers.values()).filter(t => t.ex === id).length} tickers`);
    } catch (e) {
      console.error(`[FAIL] ${id} error:`, e.message);
    }
  }
  
  console.log("\n=== TESTS COMPLETED (Wait 10s for WS logs) ===");
  setTimeout(() => process.exit(0), 10000);
}

runTests();
