// wsWallScanner.js
const WebSocket = require('ws');

let activeWs = null;

function startWsScanner(tickers, wallScanner) {
  setInterval(() => {
    if (!activeWs || activeWs.readyState === WebSocket.CLOSED) {
      connectBinanceWs(tickers, wallScanner);
    }
  }, 10000);
  
  connectBinanceWs(tickers, wallScanner);
}

function connectBinanceWs(tickers, wallScanner) {
  // Only connect to Top 35 BN coins
  const bn = Array.from(tickers.values()).filter(t => t.ex === "BN" && typeof t.v === "number").sort((a,b) => b.v - a.v).slice(0, 35);
  if (bn.length === 0) return;
  
  const streams = bn.map(t => `${t.sym.toLowerCase()}@depth20@100ms`);
  const wsUrl = "wss://fstream.binance.com/stream?streams=" + streams.join("/");
  
  try {
    activeWs = new WebSocket(wsUrl);
    
    activeWs.on('open', () => {
      console.log(`[WS-WALL] Binance WebSocket Connected (Top ${bn.length} coins, 20 levels @ 100ms)`);
    });
    
    activeWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg && msg.stream && msg.data) {
          const sym = msg.data.s; 
          if (!sym) return;
          // Parse string levels to match format expected by processOrderbook [[price, amount]]
          const bids = msg.data.b.map(x => [parseFloat(x[0]), parseFloat(x[1])]);
          const asks = msg.data.a.map(x => [parseFloat(x[0]), parseFloat(x[1])]);
          const base = sym.replace("USDT", "");
          
          wallScanner.injectWsOrderbook("BN", base, tickers, bids, asks);
        }
      } catch (e) {}
    });
    
    activeWs.on('error', (e) => {
      console.error("[WS-WALL] Error:", e.message);
      activeWs.close();
    });
  } catch (e) {
    console.error("[WS-WALL] Init Error:", e.message);
  }
}

module.exports = { startWsScanner };
