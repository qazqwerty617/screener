"use strict";
const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const zlib = require("zlib");

const PORT = process.env.PORT || 3000;

// ─── Persistent HTTPS agent ─────────────────────────────────────────────────
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 50,
  timeout: 60000,
});

const compression = require('compression');
const wallScanner = require("./wallScanner");
const patternDetector = require("./patternDetector");
let currentWallsCache = [];
let patternsCache = []; // Global in-memory patterns/signals cache

// ─── In-memory store ────────────────────────────────────────────────────────
const tickers = new Map();
const dirtyKeys = new Set();
const clients = new Set();

// ─── Kline streaming state ──────────────────────────────────────────────────
const klineSubs = new Map(); // "ex|sym|tf" => { ws, ex, sym, tf }
const klineClients = new Set(); // clients subscribed to kline updates

// ─── Monitoring ─────────────────────────────────────────────────────────────
const exStatus = new Map();
let statusBroadcastTimer = null;

function updateExStatus(id, status, error = null) {
  const prev = exStatus.get(id);
  const now = Date.now();
  let changed = !prev || prev.status !== status || prev.error !== error;
  exStatus.set(id, { status, error, lastUpdate: now });

  const parentId = id.split(/[-_]/)[0];
  if (parentId !== id) {
    let anyOnline = false;
    let anyConnecting = false;
    for (const [k, v] of exStatus) {
      if (k.startsWith(parentId + '-') || k.startsWith(parentId + '_')) {
        if (v.status === "online") anyOnline = true;
        else if (v.status === "connecting") anyConnecting = true;
      }
    }
    const aggregateStatus = anyOnline ? "online" : (anyConnecting ? "connecting" : "offline");
    const parentPrev = exStatus.get(parentId);
    if (!parentPrev || parentPrev.status !== aggregateStatus) {
      exStatus.set(parentId, { status: aggregateStatus, error: null, lastUpdate: now });
      changed = true;
    }
  }

  if (changed) scheduleStatusBroadcast();
}

function scheduleStatusBroadcast() {
  if (statusBroadcastTimer) return;
  statusBroadcastTimer = setTimeout(() => {
    statusBroadcastTimer = null;
    broadcastStatus();
  }, 100);
}

function broadcastStatus() {
  const msg = JSON.stringify({ type: "ex_status", data: Object.fromEntries(exStatus) });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── Ultra-fast broadcast: push-based, batched, flat arrays ─────────────────
const NUM_FIELDS = new Set(["p", "chg", "v", "h", "l", "o", "funding", "nextFunding", "oi", "trades"]);

function numReplacer(key, value) {
  if (NUM_FIELDS.has(key) && (value == null || (typeof value === "number" && isNaN(value)))) return 0;
  return value;
}

// Pre-built ticker index for fast lookup
const tickerIndex = new Map(); // key => numeric index
let tickerIndexCounter = 0;
let newKeysBuffer = new Set(); // keys added since last ticker_map broadcast
let tickerMapBroadcastTimer = null;

function getTickerIndex(key) {
  let idx = tickerIndex.get(key);
  if (idx === undefined) {
    idx = tickerIndexCounter++;
    tickerIndex.set(key, idx);
    // Schedule a ticker_map broadcast so clients learn about new keys
    newKeysBuffer.add(key);
    if (!tickerMapBroadcastTimer) {
      tickerMapBroadcastTimer = setTimeout(() => {
        tickerMapBroadcastTimer = null;
        if (clients.size === 0 || newKeysBuffer.size === 0) { newKeysBuffer.clear(); return; }
        // Send full updated map (clients need to merge it)
        const idMap = Object.fromEntries(tickerIndex);
        const msg = JSON.stringify({ type: "ticker_map", data: idMap });
        for (const ws of clients) {
          if (ws.readyState === WebSocket.OPEN) { try { ws.send(msg); } catch (_) {} }
        }
        newKeysBuffer.clear();
      }, 500);
    }
  }
  return idx;
}

// Broadcast loop: 8ms = 125fps for ultra-smooth price updates
let broadcastBuf = null;
let broadcastDirty = false;
let snapshotSent = false;

// Send snapshot to all connected clients
function broadcastSnapshot() {
  if (tickers.size === 0) return;
  const snap = ["s"];
  for (const t of tickers.values()) {
    snap.push(t.key, t.p, t.chg, t.v, t.h, t.l, t.o, t.funding || 0, t.nextFunding || 0, t.oi || 0, t.trades || 0);
  }
  const msg = JSON.stringify({ type: "snapshot", data: snap });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) {}
    }
  }
  snapshotSent = true;
}

setInterval(() => {
  if (clients.size === 0 || dirtyKeys.size === 0) {
    dirtyKeys.clear();
    return;
  }

  // Build binary buffer: [ID, p, chg, v, h, l, o, funding, nextFunding, oi, trades] x N
  // 11 fields: ID as Float64 (8 bytes), all others as Float64 (8 bytes) for full precision
  const count = dirtyKeys.size;
  const buffer = Buffer.alloc(count * 11 * 8);
  let offset = 0;

  for (const key of dirtyKeys) {
    const t = tickers.get(key);
    if (!t) continue;
    const idx = getTickerIndex(key);
    
    buffer.writeDoubleLE(idx, offset); offset += 8;
    buffer.writeDoubleLE(t.p || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.chg || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.v || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.h || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.l || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.o || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.funding || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.nextFunding || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.oi || 0, offset); offset += 8;
    buffer.writeDoubleLE(t.trades || 0, offset); offset += 8;
  }
  dirtyKeys.clear();

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        if (ws.bufferedAmount > 2_000_000) continue;
        ws.send(buffer, { binary: true });
      } catch (_) {
        clients.delete(ws);
        try { ws.terminate(); } catch (__) {}
      }
    }
  }
}, 6);

// ─── Kline broadcast to clients ─────────────────────────────────────────────
function broadcastKline(ex, sym, tf, candle) {
  const msg = JSON.stringify({ type: "kline", ex, sym, tf, data: [candle.t, candle.o, candle.h, candle.l, candle.c, candle.v] });
  for (const ws of klineClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) {}
    }
  }
}

// ─── HTTP + WebSocket server ────────────────────────────────────────────────
const app = express();
app.use(compression());
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  perMessageDeflate: false,
  maxPayload: 64 * 1024 * 1024,
});

wss.on("connection", (ws) => {
  clients.add(ws);
  klineClients.add(ws);
  console.log(`[WS CLIENT] Connected. Total: ${clients.size}`);
  try {
    ws.send(JSON.stringify({ type: "ex_status", data: Object.fromEntries(exStatus) }));
    if (tickers.size > 0) {
      // Pre-build tickerIndex for ALL known tickers before sending map
      for (const key of tickers.keys()) getTickerIndex(key);

      const idMap = Object.fromEntries(tickerIndex);
      ws.send(JSON.stringify({ type: "ticker_map", data: idMap }));

      const snap = ["s"];
      for (const t of tickers.values()) {
        snap.push(t.key, t.p, t.chg, t.v, t.h, t.l, t.o, t.funding || 0, t.nextFunding || 0, t.oi || 0, t.trades || 0);
      }
      ws.send(JSON.stringify({ type: "snapshot", data: snap }));
    }
  } catch (err) {
    console.error("[WS CLIENT] Error sending initial data:", err.message);
  }
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "subscribe_kline") {
        subscribeKline(ws, msg.ex, msg.sym, msg.tf);
      } else if (msg.type === "unsubscribe_kline") {
        unsubscribeKline(ws, msg.ex, msg.sym, msg.tf);
      } else if (msg.type === "ping") {
        // keepalive — no-op
      } else if (msg.type === "get_snapshot") {
        if (tickers.size > 0 && ws.readyState === WebSocket.OPEN) {
          // Ensure all tickers have an index before sending map
          for (const key of tickers.keys()) getTickerIndex(key);
          const idMap = Object.fromEntries(tickerIndex);
          ws.send(JSON.stringify({ type: "ticker_map", data: idMap }));
          const snap = ["s"];
          for (const t of tickers.values()) {
            snap.push(t.key, t.p, t.chg, t.v, t.h, t.l, t.o, t.funding || 0, t.nextFunding || 0, t.oi || 0, t.trades || 0);
          }
          ws.send(JSON.stringify({ type: "snapshot", data: snap }));
        }
      }
    } catch (_) {}
  });
  ws.on("close", () => {
    clients.delete(ws);
    klineClients.delete(ws);
    console.log(`[WS CLIENT] Disconnected. Total: ${clients.size}`);
  });
  ws.on("error", (err) => {
    console.error("[WS CLIENT] Error:", err.message);
    clients.delete(ws);
    klineClients.delete(ws);
    try { ws.terminate(); } catch (_) {}
  });
});

// ─── Kline subscription management ──────────────────────────────────────────
function subscribeKline(ws, ex, sym, tf) {
  const key = `${ex}|${sym}|tf`;
  const subKey = `${ex}|${sym}|${tf}`;
  
  // Check if we already have a WS connection for this kline
  let sub = klineSubs.get(subKey);
  if (!sub) {
    sub = createKlineWs(ex, sym, tf);
    klineSubs.set(subKey, sub);
  }
}

function unsubscribeKline(ws, ex, sym, tf) {
  const subKey = `${ex}|${sym}|${tf}`;
  // Simple: don't unsubscribe for now, connections are lightweight
}

function createKlineWs(ex, sym, tf) {
  const sub = { ex, sym, tf, ws: null, reconnectTimer: null, pingTimer: null };
  connectKlineWs(sub);
  return sub;
}

function connectKlineWs(sub) {
  if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; }
  if (sub.pingTimer) { clearInterval(sub.pingTimer); sub.pingTimer = null; }
  if (sub.ws) { try { sub.ws.close(); } catch (_) {} sub.ws = null; }

  const { ex, sym, tf } = sub;
  
  if (ex === "BN") {
    sub.ws = new WebSocket(`wss://fstream.binance.com/ws/${sym.toLowerCase()}@kline_${tf}`, { perMessageDeflate: false });
    sub.ws.on("message", (raw) => {
      try {
        const k = JSON.parse(raw.toString()).k;
        broadcastKline(ex, sym, tf, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q });
      } catch (_) {}
    });
    sub.ws.on("close", () => { sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "BB") {
    const tfMap = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "3d": "3", "1w": "W" };
    sub.ws = new WebSocket("wss://stream.bybit.com/v5/public/linear", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BB:${sym}`, e.message));
    sub.ws.on("open", () => {
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [`kline.${tfMap[tf] || "60"}.${sym}`] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send('{"op":"ping"}'); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.topic?.startsWith("kline.") || !d.data?.length) return;
        const k = d.data[0];
        broadcastKline(ex, sym, tf, { t: k.start, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.turnover });
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "OX") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" };
    const ch = "candle" + (tfMap[tf] || "1H");
    sub.ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/public", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: ch, instId: sym }] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send("ping"); }, 25000);
    });
    sub.ws.on("message", (raw) => {
      const str = raw.toString();
      if (str === "pong") return;
      try {
        const d = JSON.parse(str);
        if (!d.data || d.arg?.channel !== ch) return;
        const k = d.data[0];
        broadcastKline(ex, sym, tf, { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] });
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "BG") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" };
    sub.ws = new WebSocket("wss://ws.bitget.com/v2/ws/public", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BG:${sym}`, e.message));
    sub.ws.on("open", () => {
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [{ instType: "USDT-FUTURES", channel: "candle" + (tfMap[tf] || "1H"), instId: sym }] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send("ping"); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.action !== "update" || d.arg?.channel !== "candle" + (tfMap[tf] || "1H")) return;
        for (const k of (d.data || [])) {
          broadcastKline(ex, sym, tf, { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "GT") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    sub.ws = new WebSocket("wss://fx-ws.gateio.ws/v4/ws/usdt", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      sub.ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.candlesticks", event: "subscribe", payload: [sym], params: { interval: tfMap[tf] || "4h" } }));
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.channel !== "futures.candlesticks" || d.event !== "update") return;
        for (const k of (d.result || [])) {
          broadcastKline(ex, sym, tf, { t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "MX") {
    const tfMap = { "1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1", "3d": "Day3", "1w": "Week1" };
    sub.ws = new WebSocket("wss://contract.mexc.com/edge", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] MX:${sym}`, e.message));
    sub.ws.on("open", () => {
      sub.ws.send(JSON.stringify({ method: `sub.kline.${tfMap[tf] || "Hour4"}`, param: { symbol: sym } }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ method: "ping" })); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.channel?.startsWith("push.kline")) return;
        const k = d.data;
        broadcastKline(ex, sym, tf, { t: +k.time, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.amount });
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "HL") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
    sub.ws = new WebSocket("wss://api.hyperliquid.xyz/ws", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      sub.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: sym, interval: tfMap[tf] || "4h" } }));
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.channel !== "candle" || !d.data) return;
        for (const k of d.data) {
          broadcastKline(ex, sym, tf, { t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "AD") {
    sub.ws = new WebSocket(`wss://fstream.asterdex.com/ws/${sym.toLowerCase()}@kline_${tf}`, { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] AD:${sym}`, e.message));
    sub.ws.on("message", (raw) => {
      try {
        const k = JSON.parse(raw.toString()).k;
        broadcastKline(ex, sym, tf, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q });
      } catch (_) {}
    });
    sub.ws.on("close", () => { sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
    sub.ws.on("error", () => {});
  } else if (ex === "KC") {
    // KuCoin needs a token
    getKuCoinToken().then(tk => {
      if (!tk) return startKlinePolling(sub);
      const url = `${tk.endpoint}?token=${tk.token}`;
      sub.ws = new WebSocket(url, { perMessageDeflate: false });
      sub.ws.on("error", (e) => console.warn(`[KL ERROR] KC:${sym}`, e.message));
      sub.ws.on("open", () => {
        sub.ws.send(JSON.stringify({ id: Date.now(), type: "subscribe", topic: `/contractMarket/kline:${sym}_${TF_MAP.KC[tf] || "60"}` }));
        sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ id: Date.now(), type: "ping" })); }, 20000);
      });
      sub.ws.on("message", (raw) => {
        try {
          const d = JSON.parse(raw.toString());
          if (d.subject === "kline.update") {
            const k = d.data;
            broadcastKline(ex, sym, tf, { t: k.timestamp, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.vol });
          }
        } catch (_) {}
      });
      sub.ws.on("close", () => { clearInterval(sub.pingTimer); sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 2000); });
    }).catch(() => startKlinePolling(sub));
  } else if (ex === "BX") {
    // Pro Terminal Feature: Proxy BingX charts to Binance for perfect clusters
    const bnSym = sym.replace("-", "");
    if (tickers.has("BN:" + bnSym)) {
      sub.ws = new WebSocket(`wss://fstream.binance.com/ws/${bnSym.toLowerCase()}@kline_${tf}`, { perMessageDeflate: false });
      sub.ws.on("message", (raw) => {
        try {
          const k = JSON.parse(raw.toString()).k;
          broadcastKline(ex, sym, tf, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q });
        } catch (_) {}
      });
      sub.ws.on("close", () => { sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 1500); });
      sub.ws.on("error", () => {});
      return;
    }

    sub.ws = new WebSocket("wss://open-api-swap.bingx.com/swap-market", { perMessageDeflate: false });
    sub.ws.on("error", (e) => {
      console.warn(`[KL ERROR] BX:${sym}:`, e.message);
      startKlinePolling(sub); 
    });
    sub.ws.on("open", () => {
      // BingX expects symbol WITH hyphen (e.g. BTC-USDT@kline_1m)
      sub.ws.send(JSON.stringify({ id: "id1", reqType: "sub", dataType: `${sym}@kline_${tf}` }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ ping: Date.now() })); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      zlib.gunzip(raw, (err, buf) => {
        if (err) return;
        try {
          const d = JSON.parse(buf.toString());
          // Handle BingX Ping-Pong
          if (d.ping) {
            sub.ws.send(JSON.stringify({ pong: d.ping }));
            return;
          }
          if (d.dataType?.includes("@kline") && d.data) {
            // BingX sends kline data as an array. Grab the latest element (last in array).
            const k = Array.isArray(d.data) ? d.data[d.data.length - 1] : d.data;
            if (!k) return;
            
            // BingX Cluster Fix: Use base volume * close price. Never use k.q because on some altcoins BingX sends 24h cumulative volume.
            const closeP = +(k.c || k.close || 0);
            const baseVol = +(k.v || k.volume || 0);
            const quoteVol = baseVol * closeP;
            
            const candle = {
              t: +(k.time || k.T || k.t || 0),
              o: +(k.open || k.o || 0),
              h: +(k.high || k.h || 0),
              l: +(k.low || k.l || 0),
              c: closeP,
              v: quoteVol
            };
            if (candle.t) {
              broadcastKline(ex, sym, tf, candle);
            }
          }
        } catch (_) {}
      });
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 2000); });
  } else if (ex === "HT") {
    sub.ws = new WebSocket("wss://api.hbdm.vn/linear-swap-ws", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] HT:${sym}`, e.message));
    sub.ws.on("open", () => {
      sub.ws.send(JSON.stringify({ sub: `market.${sym}.kline.${TF_MAP.HT[tf] || "60min"}`, id: "id1" }));
    });
    sub.ws.on("message", (raw) => {
      zlib.gunzip(raw, (err, buf) => {
        if (err) return;
        try {
          const d = JSON.parse(buf.toString());
          if (d.ping) return sub.ws.send(JSON.stringify({ pong: d.ping }));
          if (d.tick) {
            const k = d.tick;
            broadcastKline(ex, sym, tf, { t: k.id * 1000, o: k.open, h: k.high, l: k.low, c: k.close, v: k.vol });
          }
        } catch (_) {}
      });
    });
    sub.ws.on("close", () => { sub.reconnectTimer = setTimeout(() => connectKlineWs(sub), 2000); });
  } else {
    startKlinePolling(sub);
  }
}
async function getKuCoinToken() {
  try {
    const r = await apiFetch("https://api-futures.kucoin.com/api/v1/bullet-public", 5000, 0, "POST");
    if (r?.data?.token) return { token: r.data.token, endpoint: r.data.instanceServers[0].endpoint };
  } catch (e) {}
  return null;
}

function startKlinePolling(sub) {
  sub.pollTimer = setInterval(async () => {
    try {
      const url = getKlinesUrl(sub.ex, sub.sym, sub.tf, 3);
      if (!url) return;
      const data = await apiFetch(url, 3000, 0);
      const candles = parseKlines(sub.ex, data);
      if (candles.length) {
        const last = candles[candles.length - 1];
        broadcastKline(sub.ex, sub.sym, sub.tf, last);
      }
    } catch (_) {}
  }, 5000);
}

// ─── Reconnecting WebSocket helper ──────────────────────────────────────────
function mkExWs(exId, url, onMsg, onOpen) {
  let ws, alive = true, retryMs = 1000, lastMsg = 0;
  
  function connect() {
    if (!alive) return;
    updateExStatus(exId, "connecting");
    
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    };
    if (url.includes("bingx")) {
      delete headers["User-Agent"];
      headers["Origin"] = "https://www.bingx.com";
    } else if (url.includes("gate")) {
      headers["Origin"] = "https://www.gate.io";
    }
    ws = new WebSocket(url, { 
      handshakeTimeout: 15000,
      perMessageDeflate: false,
      headers
    });

    ws.on("error", (err) => {
      console.warn(`[WS ERROR] ${exId}:`, err.message);
      updateExStatus(exId, "error");
    });

    ws.on("open", () => {
      retryMs = 1000;
      lastMsg = Date.now();
      updateExStatus(exId, "online");
      console.log(`[WS OPEN] ${exId}`);
      if (onOpen) onOpen(ws);
    });

    ws.on("message", (data) => {
      lastMsg = Date.now();
      onMsg(data, ws);
    });

    ws.on("error", (err) => {
      updateExStatus(exId, "offline", err.message);
    });

    ws.on("close", (code, reason) => {
      console.log(`[WS CLOSE] ${exId}: code=${code} ${reason||""}`);
      updateExStatus(exId, "offline", "Connection closed");
      if (alive) {
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 1.5, 30000);
      }
    });
  }

  // Watchdog: check every 15s, reconnect if no data for 20s
  const watchdog = setInterval(() => {
    if (!alive) return clearInterval(watchdog);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const silent = Date.now() - lastMsg;
    if (lastMsg > 0 && silent > 20000) {
      console.warn(`[WS WATCHDOG] ${exId}: No data for ${(silent/1000).toFixed(0)}s, reconnecting...`);
      try { ws.terminate(); } catch (_) {}
    }
  }, 15000);

  connect();
  return {
    stop: () => { alive = false; clearInterval(watchdog); try { ws.terminate(); } catch (_) {} },
    send: (d) => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); } catch (_) {} }
  };
}

// ─── Fetch helper ───────────────────────────────────────────────────────────
async function apiFetch(url, timeoutMs = 8000, retries = 1, method = "GET", body = null) {
  const useNativeFetch = typeof fetch === "function";
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Cache-Control": "no-cache",
  };
  if (method === "POST") headers["Content-Type"] = "application/json";

  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // native fetch (Node 18+) does NOT support `agent` — omit it
      const options = { method, signal: ctrl.signal, headers };
      if (!useNativeFetch) options.agent = httpsAgent;
      if (body) options.body = typeof body === "string" ? body : JSON.stringify(body);

      const fetchImpl = useNativeFetch
        ? fetch.bind(globalThis)
        : (await import("node-fetch")).default;

      const r = await fetchImpl(url, options);
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 100)}`);
      }
      return await r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Klines REST helpers ────────────────────────────────────────────────────
const TF_MAP = {
  BB: { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "3d": "3", "1w": "W" },
  OX: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" },
  BG: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" },
  GT: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" },
  MX: { "1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1", "3d": "Day3", "1w": "Week1" },
  KC: { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "1440", "3d": "4320", "1w": "10080" },
  BX: { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" },
  HT: { "1m": "1min", "5m": "5min", "15m": "15min", "1h": "60min", "4h": "4hour", "1d": "1day", "3d": "3day", "1w": "1week" },
};

function getKlinesUrl(ex, sym, tf, limit, before) {
  if (ex === "BN" || ex === "AD") {
    const base = ex === "BN" ? "fapi.binance.com" : "fapi.asterdex.com";
    return `https://${base}/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${limit}` + (before ? `&endTime=${before - 1}` : "");
  }
  if (ex === "BB") {
    return `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${TF_MAP.BB[tf] || "60"}&limit=${limit}` + (before ? `&end=${before - 1}` : "");
  }
  if (ex === "OX") {
    return `https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=${TF_MAP.OX[tf] || "1H"}&limit=${limit}` + (before ? `&after=${before}` : "");
  }
  if (ex === "BG") {
    return `https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${sym}&granularity=${TF_MAP.BG[tf] || "1H"}&limit=${limit}` + (before ? `&endTime=${before - 1}` : "");
  }
  if (ex === "GT") {
    return `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${sym}&interval=${TF_MAP.GT[tf] || "1h"}&limit=${limit}` + (before ? `&to=${Math.floor(before / 1000)}` : "");
  }
  if (ex === "MX") {
    return `https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=${TF_MAP.MX[tf] || "Min60"}` + (before ? `&end=${Math.floor(before / 1000)}` : "");
  }
  if (ex === "KC") {
    return `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${sym}&granularity=${TF_MAP.KC[tf] || "60"}` + (before ? `&to=${before}` : "");
  }
  if (ex === "BX") {
    return `https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${sym}&interval=${TF_MAP.BX[tf] || "1h"}&limit=${limit}` + (before ? `&endTime=${before}` : "");
  }
  if (ex === "HT") {
    return `https://api.hbdm.vn/linear-swap-ex/market/history/kline?contract_code=${sym}&period=${TF_MAP.HT[tf] || "60min"}&size=${limit}`;
  }
  if (ex === "HL") {
    return null; // HL uses POST
  }
  return null;
}

function parseKlines(ex, data) {
  try {
    if (ex === "BN" || ex === "AD") return data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));
    if (ex === "BB") return (data.result?.list || []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
    if (ex === "OX") return (data.data || []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
    if (ex === "BG") return (data.data || []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
    if (ex === "GT") return (Array.isArray(data) ? data : []).map(k => ({ t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
    if (ex === "MX") return (data.data?.time || []).map((t, i) => ({ t: t * 1000, o: +data.data.open[i], h: +data.data.high[i], l: +data.data.low[i], c: +data.data.close[i], v: +data.data.vol[i] }));
    if (ex === "KC") return (data.data || []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    if (ex === "BX") return (data.data || []).map(k => {
      const closeP = +(k.close || k.c || 0);
      const baseVol = +(k.volume || k.v || 0);
      const quoteVol = baseVol * closeP;
      return {
        t: +(k.time || k.t || 0),
        o: +(k.open || k.o || 0),
        h: +(k.high || k.h || 0),
        l: +(k.low || k.l || 0),
        c: closeP,
        v: quoteVol
      };
    });
    if (ex === "HT") return (data.data || []).map(k => ({ t: +k.id * 1000, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.vol }));
  } catch (e) {
    console.error(`[KLINES] Parse error for ${ex}:`, e.message);
  }
  return [];
}

async function fetchFullHistory(ex, sym, tf, lite = false) {
  let fetchEx = ex;
  let fetchSym = sym;
  
  if (ex === "BX") {
    const bnSym = sym.replace("-", "");
    if (tickers.has("BN:" + bnSym)) {
      fetchEx = "BN";
      fetchSym = bnSym;
    }
  }

  const pages = { BN: 3, BB: 3, OX: 5, BG: 3, GT: 3, MX: 2, KC: 3, BX: 3, HT: 1, AD: 3 };
  const limits = { BN: 1000, BB: 1000, OX: 100, BG: 1000, GT: 1000, MX: 1000, KC: 1000, BX: 1000, HT: 1000, AD: 1000 };
  const maxP = lite ? 1 : (pages[fetchEx] || 3);
  const limit = lite ? 300 : (limits[fetchEx] || 1000);
  
  if (lite) {
    try {
      if (fetchEx === "BN" || fetchEx === "AD") {
        const base = fetchEx === "BN" ? "fapi.binance.com" : "fapi.asterdex.com";
        const url = `https://${base}/fapi/v1/klines?symbol=${fetchSym}&interval=${tf}&limit=${limit}`;
        const data = await apiFetch(url, 4000, 0);
        return Array.isArray(data) ? data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] })) : [];
      } else if (ex === "BB") {
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${TF_MAP.BB[tf] || "60"}&limit=${limit}`;
        const data = await apiFetch(url, 4000, 0);
        return (data.result?.list || []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
      } else if (ex === "OX") {
        const url = `https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=${TF_MAP.OX[tf] || "1H"}&limit=${limit}`;
        const data = await apiFetch(url, 4000, 0);
        return (data.data || []).map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
      } else if (ex === "HL") {
        const data = await apiFetch("https://api.hyperliquid.xyz/info", 4000, 0, "POST", { type: "candleSnapshot", req: { coin: sym, interval: tf.toLowerCase(), startTime: Date.now() - (limit * 60000), endTime: Date.now() } });
        return (Array.isArray(data) ? data : []).map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
      }
      const url = getKlinesUrl(ex, sym, tf, limit);
      if (!url) return [];
      const data = await apiFetch(url, 4000, 0);
      return parseKlines(ex, data);
    } catch (e) { return []; }
  }

  let all = [];
  let before = Date.now();
  for (let p = 0; p < maxP; p++) {
    try {
      let data, batch;
      if (fetchEx === "HL") {
        data = await apiFetch("https://api.hyperliquid.xyz/info", 5000, 0, "POST", { type: "candleSnapshot", req: { coin: fetchSym, interval: tf.toLowerCase(), startTime: before - (limit * 60000), endTime: before } });
        batch = (Array.isArray(data) ? data : []).map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
      } else {
        const url = getKlinesUrl(fetchEx, fetchSym, tf, limit, before);
        if (!url) break;
        data = await apiFetch(url, 5000, 0);
        batch = parseKlines(fetchEx, data);
      }
      if (!batch || !batch.length) break;
      all = [...batch, ...all];
      before = batch[0].t;
      if (batch.length < limit * 0.8) break;
    } catch (e) { break; }
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; }).sort((a,b) => a.t - b.t);
}

const klinesCache = new Map();
const klinesInFlight = new Map();

// ─── Go Scanner Proxy ──────────────────────────────────────────────────────
const GO_SCANNER_URL = "http://127.0.0.1:8082";

app.get("/api/go-status", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const r = await fetch(`${GO_SCANNER_URL}/api/klines?ex=BN&sym=BTCUSDT&tf=1m&limit=1`);
    if (r.ok) {
      res.json({ status: "online" });
    } else {
      res.json({ status: "error", code: r.status });
    }
  } catch (e) {
    res.json({ status: "offline", error: e.message });
  }
});

app.get("/api/go-klines", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { ex = "BN", sym = "BTCUSDT", tf = "1h", limit = "200" } = req.query;
  try {
    const goUrl = `${GO_SCANNER_URL}/api/klines?ex=${ex}&sym=${sym}&tf=${tf}&limit=${limit}`;
    const r = await fetch(goUrl);
    if (!r.ok) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }
    const data = await r.json();
    // Go returns [{t,o,h,l,c,v}] — convert to flat array for frontend compatibility
    const flat = [];
    for (const c of data) flat.push(c.t, c.o, c.h, c.l, c.c, c.v);
    res.json(flat);
  } catch (e) {
    res.status(503).json({ error: "Go scanner offline: " + e.message });
  }
});
// ──────────────────────────────────────────────────────────────────────────

function cacheKey(ex, sym, tf, lite) {
  return `${ex}|${sym}|${tf}|${lite ? "1" : "0"}`;
}

app.get("/api/klines", async (req, res) => {
  const { ex = "BN", sym = "BTCUSDT", tf = "4h", lite = "0" } = req.query;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30");
  
  const useLite = lite === "1";
  const key = cacheKey(ex, sym, tf, useLite);
  const now = Date.now();
  
  const cached = klinesCache.get(key);
  // TTL: 10s for lite charts, 60s for full
  const ttl = useLite ? 10000 : 60000;
  
  if (cached && now - cached.at < ttl) {
    return res.json(cached.data);
  }

  try {
    let pending = klinesInFlight.get(key);
    if (!pending) {
      pending = fetchFullHistory(ex, sym, tf, useLite).finally(() => klinesInFlight.delete(key));
      klinesInFlight.set(key, pending);
    }
    const candles = await pending;
    if (!candles || candles.length === 0) throw new Error("No data");

    const flat = [];
    for (const c of candles) flat.push(c.t, c.o, c.h, c.l, c.c, c.v);
    klinesCache.set(key, { at: now, data: flat });
    res.json(flat);
  } catch (e) {
    console.error(`[KLINES ERROR] ${ex} ${sym} ${tf}:`, e.message);
    // Fallback to cache if available, even if stale
    if (cached) return res.json(cached.data);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/walls", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");
  res.json(currentWallsCache);
});

app.get("/api/tickers", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");
  const flat = [];
  for (const t of tickers.values()) flat.push(t.key, t.p, t.chg, t.v, t.h, t.l, t.o, t.funding || 0, t.nextFunding || 0, t.oi || 0, t.trades || 0);
  res.json(flat);
});
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", tickers: tickers.size, clients: clients.size, dirty: dirtyKeys.size, exchanges: Object.fromEntries(exStatus) });
});

app.get("/api/patterns", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");

  let result = [...patternsCache];
  const { tf, type, dir, limit = "100" } = req.query;

  if (tf) {
    const tfs = tf.split(",");
    result = result.filter(p => tfs.includes(p.tf));
  }
  if (type) {
    const types = type.split(",");
    result = result.filter(p => types.includes(p.type));
  }
  if (dir) {
    const dirs = dir.split(",");
    result = result.filter(p => dirs.includes(p.direction));
  }

  const lim = parseInt(limit, 10) || 100;
  res.json(result.slice(0, lim));
});

app.get("/api/kucoin-token", async (req, res) => {
  const tk = await getKuCoinToken();
  if (tk) res.json(tk);
  else res.status(500).json({ error: "Failed to get token" });
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: 0, etag: false }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ─── Exchange Modules ───────────────────────────────────────────────────────
const exchanges = {
  BN: require("./exchanges/binance"),
  BB: require("./exchanges/bybit"),
  OX: require("./exchanges/okx"),
  BG: require("./exchanges/bitget"),
  GT: require("./exchanges/gate"),
  MX: require("./exchanges/mexc"),
  KC: require("./exchanges/kucoin"),
  BX: require("./exchanges/bingx"),
  HT: require("./exchanges/htx"),
  HL: require("./exchanges/hyperliquid"),
  AD: require("./exchanges/asterdex"),
};

// ─── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║  CryptoScreen Pro  →  port ${PORT}                      ║`);
  console.log(`║  Exchanges: ${Object.keys(exchanges).length} modules (parallel init)            ║`);
  console.log(`║  Protocol: Flat Array (ultra-fast)                      ║`);
  console.log(`║  Broadcast: 8ms (125fps)                                ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  
  // Parallel init — all exchanges start simultaneously
  for (const name in exchanges) {
    try {
      console.log(`[INIT] Starting exchange: ${name}`);
      const instance = exchanges[name](tickers, dirtyKeys, mkExWs, apiFetch, updateExStatus);
      instance.init();
      exchanges[name] = instance;
    } catch (e) {
      console.error(`[INIT] Failed to start ${name}:`, e.message);
    }
  }
  
  // Start Wall Scanner Engine
  wallScanner.startScanning(tickers, apiFetch, (walls) => {
    currentWallsCache = walls;
    const msg = JSON.stringify({ type: "walls", data: walls });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch (e) {}
      }
    }
  });

  // ─── Pattern Scanner Engine ───────────────────────────────────────────────
  let isScanningPatterns = false;
  async function scanAllPatterns() {
    if (isScanningPatterns) return;
    isScanningPatterns = true;
    console.log(`[PATTERNS] Starting pattern detection scan...`);
    const startTime = Date.now();

    try {
      const list = Array.from(tickers.values())
        .filter(t => t.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 50); // Scan top 50

      const timeframes = ["15m", "1h", "4h", "1d"];
      let newSignalsCount = 0;

      for (const t of list) {
        const colonIdx = t.key.indexOf(':');
        if (colonIdx <= 0) continue;
        const ex = t.key.substring(0, colonIdx);
        const sym = t.key.substring(colonIdx + 1);
        const base = t.base || sym.replace(/[-_]?(USDT|USDTM|USDC|BUSD|DAI|USD).*$/i, '') || sym;

        for (const tf of timeframes) {
          try {
            const candles = await fetchFullHistory(ex, sym, tf, true);
            if (!candles || candles.length < 30) continue;

            const meta = { ex, sym, base, tf };
            const signals = patternDetector.scanCandles(meta, candles);

            for (const sig of signals) {
              const existingIdx = patternsCache.findIndex(p =>
                p.ex === sig.ex &&
                p.sym === sig.sym &&
                p.tf === sig.tf &&
                p.type === sig.type &&
                p.direction === sig.direction &&
                Math.abs(p.price - sig.price) / sig.price < 0.005
              );

              if (existingIdx >= 0) {
                patternsCache[existingIdx].ts = sig.ts;
                patternsCache[existingIdx].meta = sig.meta;
                patternsCache[existingIdx].confidence = sig.confidence;
              } else {
                patternsCache.push(sig);
                newSignalsCount++;
              }
            }
          } catch (e) {}
          await new Promise(r => setTimeout(r, 80));
        }
      }

      patternsCache.sort((a, b) => b.ts - a.ts);
      if (patternsCache.length > 1000) {
        patternsCache = patternsCache.slice(0, 1000);
      }

      console.log(`[PATTERNS] Scan completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Found ${newSignalsCount} new signals. Total cached: ${patternsCache.length}`);
    } catch (err) {
      console.error("[PATTERNS] Error during scan:", err);
    } finally {
      isScanningPatterns = false;
    }
  }

  // Initial trigger after 8 seconds, then every 5 minutes
  setTimeout(() => {
    scanAllPatterns();
    setInterval(scanAllPatterns, 5 * 60 * 1000);
  }, 8000);
  
  // Periodic snapshots as data arrives
  let snapCount = 0;
  const snapTimer = setInterval(() => {
    if (tickers.size > 0 && clients.size > 0) {
      broadcastSnapshot();
      snapCount++;
    }
    if (snapCount >= 5) clearInterval(snapTimer);
  }, 2000);
});
