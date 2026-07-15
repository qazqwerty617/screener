"use strict";

const { WebSocket } = require("ws");

function run() {
  const ws = new WebSocket("wss://api.hyperliquid.xyz/ws");
  
  ws.on("open", () => {
    console.log("Connected to Hyperliquid WS");
    // Subscribe to BTC l2Book
    ws.send(JSON.stringify({
      method: "subscribe",
      subscription: {
        type: "l2Book",
        coin: "BTC"
      }
    }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    console.log("Received channel:", msg.channel);
    if (msg.channel === "l2Book" && msg.data) {
      console.log("Coin:", msg.data.coin);
      console.log("Levels count:", msg.data.levels[0].length);
      console.log("First Bid level:", msg.data.levels[0][0]);
      console.log("Last Bid level:", msg.data.levels[0][msg.data.levels[0].length - 1]);
      ws.close();
      process.exit(0);
    }
  });

  ws.on("error", (e) => {
    console.error("WS Error:", e.message);
  });
}

run();
