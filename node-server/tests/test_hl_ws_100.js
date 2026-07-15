"use strict";

const { WebSocket } = require("ws");

function run() {
  const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
  
  ws.on("open", () => {
    console.log("Connected to Hyperliquid WS");
    ws.send(JSON.stringify({
      method: "subscribe",
      subscription: {
        type: "l2Book",
        coin: "BTC",
        nLevels: 100
      }
    }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.channel === "l2Book" && msg.data) {
      console.log("Coin:", msg.data.coin);
      console.log("Levels count:", msg.data.levels[0].length);
      if (msg.data.levels[0].length > 0) {
        console.log("First Bid:", msg.data.levels[0][0]);
        console.log("Last Bid:", msg.data.levels[0][msg.data.levels[0].length - 1]);
        const mid = +msg.data.levels[0][0].px;
        const last = +msg.data.levels[0][msg.data.levels[0].length - 1].px;
        console.log("Max distance:", ((mid - last) / mid * 100).toFixed(4) + "%");
      }
      ws.close();
      process.exit(0);
    }
  });

  ws.on("error", (e) => {
    console.error("WS Error:", e.message);
  });
}

run();
