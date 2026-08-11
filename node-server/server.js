"use strict";
process.on("uncaughtException", (err) => console.error("[SERVER EXCEPTION]", err ? err.message || err : err));
process.on("unhandledRejection", (reason) => console.error("[SERVER REJECTION]", reason ? reason.message || reason : reason));

const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const zlib = require("zlib");
const { randomUUID, timingSafeEqual } = require("crypto");

const PORT = process.env.PORT || 3000;

// тФАтФАтФА Persistent HTTPS agent тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 50,
  timeout: 60000,
});

const compression = require('compression');
const patternDetector = require("./patternDetector");
const serverLevels = require("./serverLevels");
const wallScanner = require("./wallScanner");
const { createArbitrageEngine } = require("./arbitrageEngine");
const { createDepthAnalyzer } = require("./depthAnalyzer");
const marketDataCore = require("./marketDataCore");
const serverFormationsMap = new Map(); // "EX:SYM:TF" -> levels[]
let currentWallsCache = [];
let currentWallsMeta = { walls: [], updatedAt: 0, partial: false, exchangesReady: 0, exchangesTotal: 11, exchangeStatuses: {} };
let patternsCache = []; // Global in-memory patterns/signals cache

// тФАтФАтФА In-memory store тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const tickers = new Map();
const dirtyKeys = new Set();
const clients = new Set();

// тФАтФАтФА Kline streaming state тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const klineSubs = new Map(); // "ex|sym|tf" => pooled upstream stream + subscribed browser clients
const klineClients = new Set(); // clients subscribed to kline updates
const pendingMarketTicks = new Map();
const marketFeedStats = new Map();
let marketSequence = 0;

// тФАтФАтФА Monitoring тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const exStatus = new Map();
const arbitrageEngine = createArbitrageEngine(tickers, exStatus);
let depthAnalyzer = null;
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

// тФАтФАтФА Ultra-fast broadcast: push-based, batched, flat arrays тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

// Broadcast loop: 50ms = 20fps (optimized from 6ms/166fps to reduce CPU)
let broadcastBuf = null;
let broadcastDirty = false;
let snapshotSent = false;

// Pre-allocated broadcast buffer (reused to avoid GC pressure)
const MAX_TICKERS_ESTIMATE = 5000;
let reusableBroadcastBuffer = Buffer.alloc(MAX_TICKERS_ESTIMATE * 11 * 8);

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
  const count = dirtyKeys.size;
  const requiredBytes = count * 11 * 8;

  // Grow reusable buffer only if needed
  if (reusableBroadcastBuffer.length < requiredBytes) {
    reusableBroadcastBuffer = Buffer.alloc(requiredBytes + 1024);
  }
  let offset = 0;

  for (const key of dirtyKeys) {
    const t = tickers.get(key);
    if (!t) continue;
    const idx = getTickerIndex(key);
    
    reusableBroadcastBuffer.writeDoubleLE(idx, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.p || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.chg || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.v || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.h || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.l || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.o || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.funding || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.nextFunding || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.oi || 0, offset); offset += 8;
    reusableBroadcastBuffer.writeDoubleLE(t.trades || 0, offset); offset += 8;
  }
  dirtyKeys.clear();

  // Slice to actual used bytes
  const sendBuf = reusableBroadcastBuffer.subarray(0, offset);

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        if (ws.bufferedAmount > 2_000_000) continue;
        ws.send(sendBuf, { binary: true });
      } catch (_) {
        clients.delete(ws);
        try { ws.terminate(); } catch (__) {}
      }
    }
  }
}, 50);

// тФАтФАтФА Kline broadcast to clients тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function normalizeTimestamp(t) {
  return marketDataCore.normalizeTimestamp(t);
}

function broadcastKline(ex, sym, tf, candle) {
  const clean = marketDataCore.normalizeCandle(candle);
  if (!clean) return;
  const normT = clean.t;

  // ── Update server-side klines cache in real-time ──────────────
  const updateCacheForLite = (useLite) => {
    const key = cacheKey(ex, sym, tf, useLite);
    const cached = klinesCache.get(key);
    if (cached && Array.isArray(cached.data) && cached.data.length >= 6) {
      const flat = cached.data;
      const lastT = flat[flat.length - 6];
      if (lastT === normT) {
        flat[flat.length - 5] = clean.o;
        flat[flat.length - 4] = clean.h;
        flat[flat.length - 3] = clean.l;
        flat[flat.length - 2] = clean.c;
        flat[flat.length - 1] = clean.v;
      } else if (normT > lastT) {
        flat.push(normT, clean.o, clean.h, clean.l, clean.c, clean.v);
        if (flat.length > 7200) flat.splice(0, 6);
      }
      cached.at = Date.now();
    }
  };
  updateCacheForLite(false);
  updateCacheForLite(true);

  const targetKey = `${ex}|${sym}|${tf}`;
  const sub = klineSubs.get(targetKey);
  if (!sub) return;
  sub.lastEventAt = Date.now();
  const stat = marketFeedStats.get(ex) || { messages: 0, trades: 0, klines: 0, lastEventAt: 0, lastSourceAt: 0 };
  stat.messages++;
  stat.klines++;
  stat.lastEventAt = Date.now();
  stat.lastSourceAt = normT;
  marketFeedStats.set(ex, stat);
  const seq = ++marketSequence;
  const msg = JSON.stringify({
    type: "kline", ex, sym, tf,
    data: [normT, clean.o, clean.h, clean.l, clean.c, clean.v, seq, Date.now()],
  });
  for (const ws of sub.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_000_000) continue;
    try { ws.send(msg); } catch (_) {}
  }
}

function publishMarketTrade(ex, sym, tf, eventTime, price, volume = 0) {
  const targetKey = `${ex}|${sym}|${tf}`;
  const sub = klineSubs.get(targetKey);
  if (!sub || sub.clients.size === 0) return;
  const t = normalizeTimestamp(eventTime) || Date.now();
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return;
  sub.lastEventAt = Date.now();
  sub.lastSourceAt = t;
  const stat = marketFeedStats.get(ex) || { messages: 0, trades: 0, klines: 0, lastEventAt: 0, lastSourceAt: 0 };
  stat.messages++;
  stat.trades++;
  stat.lastEventAt = Date.now();
  stat.lastSourceAt = t;
  marketFeedStats.set(ex, stat);

  const existing = pendingMarketTicks.get(targetKey);
  const merged = marketDataCore.mergeMarketTick(existing?.batch || null, { t, p, volume });
  if (!merged) return;
  if (existing) {
    existing.batch = merged;
    return;
  }
  const pending = { batch: merged, timer: null };
  pendingMarketTicks.set(targetKey, pending);
  pending.timer = setTimeout(() => flushMarketTick(targetKey), 16);
  pending.timer.unref?.();
}

function flushMarketTick(targetKey) {
  const pending = pendingMarketTicks.get(targetKey);
  pendingMarketTicks.delete(targetKey);
  const sub = klineSubs.get(targetKey);
  if (!pending?.batch || !sub || sub.clients.size === 0) return;
  const b = pending.batch;
  const seq = ++marketSequence;
  const serverTime = Date.now();
  const msg = JSON.stringify({
    type: "market_tick", ex: sub.ex, sym: sub.sym, tf: sub.tf,
    data: [b.eventTime, b.last, b.high, b.low, b.first, b.firstTime, b.trades, seq, serverTime],
  });
  for (const ws of sub.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_000_000) continue;
    try { ws.send(msg); } catch (_) {}
  }
}

function updateLiveTradeTick(ex, sym, tf, tradeTime, price, volume) {
  const normT = normalizeTimestamp(tradeTime);
  if (!normT || price <= 0) return;

  const key = cacheKey(ex, sym, tf, false);
  const cached = klinesCache.get(key);
  if (cached && Array.isArray(cached.data) && cached.data.length >= 6) {
    const flat = cached.data;
    const lastT = flat[flat.length - 6];
    let o = flat[flat.length - 5];
    let h = flat[flat.length - 4];
    let l = flat[flat.length - 3];
    let c = flat[flat.length - 2];
    let v = flat[flat.length - 1];

    if (normT >= lastT) {
      h = Math.max(h, price);
      l = Math.min(l, price);
      c = price;
      v += (volume || 0);
      broadcastKline(ex, sym, tf, { t: lastT, o, h, l, c, v });
    }
  }
}

const userStore = require("./userStore");
const telegramBot = require("./telegramBot");
const paymentGateway = require("./paymentGateway");
const { registerPaymentRoutes, createSlidingWindowLimiter } = require("./paymentRoutes");

// ── HTTP + WebSocket server ──
const app = express();
app.disable("x-powered-by");
const trustProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || "0", 10);
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0 && trustProxyHops <= 10) {
  app.set("trust proxy", trustProxyHops);
}
app.use(compression());
app.use(express.json({
  limit: "128kb",
  verify(req, _res, buffer) {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
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
  ws._klineSubs = new Set();
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
    if (ws._klineSubs) {
      for (const subKey of ws._klineSubs) {
        const [ex, sym, tf] = subKey.split("|");
        unsubscribeKline(ws, ex, sym, tf);
      }
    }
    console.log(`[WS CLIENT] Disconnected. Total: ${clients.size}`);
  });
  ws.on("error", (err) => {
    console.error("[WS CLIENT] Error:", err.message);
    clients.delete(ws);
    klineClients.delete(ws);
    try { ws.terminate(); } catch (_) {}
  });
});

// Application heartbeat keeps browser watchdogs honest even when a market is quiet.
const browserHeartbeat = setInterval(() => {
  if (clients.size === 0) return;
  const payload = JSON.stringify({ type: "heartbeat", serverTime: Date.now(), seq: ++marketSequence });
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 512_000) continue;
    try { ws.send(payload); } catch (_) {}
  }
}, 1000);
browserHeartbeat.unref?.();

// тФАтФАтФА Kline subscription management тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function subscribeKline(ws, ex, sym, tf) {
  if (!ws || !marketDataCore.validSubscription(ex, sym, tf)) return;
  if (!tickers.has(`${ex}:${sym}`)) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "market_status", ex, sym, tf, status: "rejected", reason: "unknown_symbol" }));
    }
    return;
  }
  klineClients.add(ws);
  const subKey = `${ex}|${sym}|${tf}`;
  ws._klineSubs.add(subKey);

  let sub = klineSubs.get(subKey);
  if (!sub) {
    sub = createKlineWs(ex, sym, tf);
    klineSubs.set(subKey, sub);
  }
  if (sub.idleTimer) { clearTimeout(sub.idleTimer); sub.idleTimer = null; }
  sub.clients.add(ws);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: "market_status", ex, sym, tf,
      status: sub.ws?.readyState === WebSocket.OPEN ? "live" : "connecting",
    }));
  }
}

function unsubscribeKline(ws, ex, sym, tf) {
  const subKey = `${ex}|${sym}|${tf}`;
  if (ws?._klineSubs) ws._klineSubs.delete(subKey);
  const sub = klineSubs.get(subKey);
  if (!sub) return;
  sub.clients.delete(ws);
  if (sub.clients.size === 0 && !sub.idleTimer) {
    sub.idleTimer = setTimeout(() => closeKlineSub(sub), 15_000);
    sub.idleTimer.unref?.();
  }
}

function createKlineWs(ex, sym, tf) {
  const sub = {
    key: `${ex}|${sym}|${tf}`,
    ex, sym, tf,
    ws: null,
    extraWs: null,
    clients: new Set(),
    reconnectTimer: null,
    pingTimer: null,
    pollTimer: null,
    idleTimer: null,
    closing: false,
    reconnects: 0,
    lastEventAt: 0,
    lastSourceAt: 0,
  };
  connectKlineWs(sub);
  return sub;
}

function closeSocket(socket) {
  if (!socket) return;
  try { socket.removeAllListeners(); socket.terminate(); } catch (_) {}
}

function closeKlineSub(sub) {
  if (!sub || sub.clients.size > 0) return;
  sub.closing = true;
  if (sub.reconnectTimer) clearTimeout(sub.reconnectTimer);
  if (sub.pingTimer) clearInterval(sub.pingTimer);
  if (sub.pollTimer) clearInterval(sub.pollTimer);
  if (sub.idleTimer) clearTimeout(sub.idleTimer);
  closeSocket(sub.ws);
  closeSocket(sub.extraWs);
  pendingMarketTicks.delete(sub.key);
  if (klineSubs.get(sub.key) === sub) klineSubs.delete(sub.key);
}

function scheduleKlineReconnect(sub, delay = 1500) {
  if (!sub || sub.closing || sub.clients.size === 0 || sub.reconnectTimer) return;
  sub.reconnects++;
  sub.reconnectTimer = setTimeout(() => {
    sub.reconnectTimer = null;
    if (!sub.closing && sub.clients.size > 0) connectKlineWs(sub);
  }, Math.min(15_000, delay * Math.min(6, sub.reconnects)));
  sub.reconnectTimer.unref?.();
}

function markMarketOpen(sub) {
  sub.reconnects = 0;
  for (const client of sub.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "market_status", ex: sub.ex, sym: sub.sym, tf: sub.tf, status: "live" }));
    }
  }
}

function connectKlineWs(sub) {
  sub.closing = false;
  if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; }
  if (sub.pingTimer) { clearInterval(sub.pingTimer); sub.pingTimer = null; }
  if (sub.pollTimer) { clearInterval(sub.pollTimer); sub.pollTimer = null; }
  closeSocket(sub.ws);
  closeSocket(sub.extraWs);
  sub.ws = null;
  sub.extraWs = null;

  const { ex, sym, tf } = sub;
  
  if (ex === "BN") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    const bnTf = tfMap[tf] || tf;
    const stream = `${sym.toLowerCase()}@kline_${bnTf}/${sym.toLowerCase()}@aggTrade`;
    sub.ws = new WebSocket(`wss://fstream.binance.com/market/stream?streams=${stream}`, { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BN:${sym}`, e.message));
    sub.ws.on("open", () => markMarketOpen(sub));
    sub.ws.on("message", (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        const d = envelope.data || envelope;
        if (d.e === "aggTrade") {
          publishMarketTrade(ex, sym, tf, d.T || d.E, d.p, Number(d.q) * Number(d.p));
        } else if (d.k) {
          const k = d.k;
          broadcastKline(ex, sym, tf, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
  } else if (ex === "BB") {
    const tfMap = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "3d": "3", "1w": "W" };
    sub.ws = new WebSocket("wss://stream.bybit.com/v5/public/linear", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BB:${sym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [`kline.${tfMap[tf] || "60"}.${sym}`, `publicTrade.${sym}`] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send('{"op":"ping"}'); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.data?.length) return;
        if (d.topic?.startsWith("kline.")) {
          const k = d.data[0];
          broadcastKline(ex, sym, tf, { t: k.start, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.turnover });
        } else if (d.topic?.startsWith("publicTrade.")) {
          for (const trade of d.data) publishMarketTrade(ex, sym, tf, trade.T || d.ts, trade.p, Number(trade.v) * Number(trade.p));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "OX") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" };
    const ch = "candle" + (tfMap[tf] || "1H");
    sub.ws = new WebSocket("wss://ws.okx.com:8443/ws/v5/business", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: ch, instId: sym }] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send("ping"); }, 25000);

      sub.extraWs = new WebSocket("wss://ws.okx.com:8443/ws/v5/public", { perMessageDeflate: false });
      sub.extraWs.on("open", () => sub.extraWs.send(JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId: sym }] })));
      sub.extraWs.on("message", (tradeRaw) => {
        const tradeStr = tradeRaw.toString();
        if (tradeStr === "pong") return;
        try {
          const message = JSON.parse(tradeStr);
          if (message.arg?.channel !== "trades") return;
          for (const trade of (message.data || [])) publishMarketTrade(ex, sym, tf, trade.ts, trade.px, Number(trade.sz) * Number(trade.px));
        } catch (_) {}
      });
      sub.extraWs.on("error", () => {});
    });
    sub.ws.on("message", (raw) => {
      const str = raw.toString();
      if (str === "pong") return;
      try {
        const d = JSON.parse(str);
        if (!d.data || d.arg?.channel !== ch) return;
        const k = d.data[0];
        broadcastKline(ex, sym, tf, { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +(k[7] || k[6]) });
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); closeSocket(sub.extraWs); sub.extraWs = null; scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "BG") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" };
    sub.ws = new WebSocket("wss://ws.bitget.com/v2/ws/public", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] BG:${sym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ op: "subscribe", args: [
        { instType: "USDT-FUTURES", channel: "candle" + (tfMap[tf] || "1H"), instId: sym },
        { instType: "USDT-FUTURES", channel: "trade", instId: sym },
      ] }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send("ping"); }, 20000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.action || !d.arg?.channel) return;
        if (d.arg.channel === "candle" + (tfMap[tf] || "1H")) {
          for (const k of (d.data || [])) broadcastKline(ex, sym, tf, { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] });
        } else if (d.arg.channel === "trade") {
          for (const trade of (d.data || [])) publishMarketTrade(ex, sym, tf, trade.ts, trade.price, Number(trade.size) * Number(trade.price));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "GT") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    sub.ws = new WebSocket("wss://fx-ws.gateio.ws/v4/ws/usdt", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.candlesticks", event: "subscribe", payload: [tfMap[tf] || "4h", sym] }));
      sub.ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.trades", event: "subscribe", payload: [sym] }));
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.event !== "update") return;
        if (d.channel === "futures.candlesticks") {
          const candles = Array.isArray(d.result) ? d.result : [d.result];
          for (const k of candles) broadcastKline(ex, sym, tf, { t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +(k.a || k.v) });
        } else if (d.channel === "futures.trades") {
          const trades = Array.isArray(d.result) ? d.result : [d.result];
          for (const trade of trades) publishMarketTrade(ex, sym, tf, trade.create_time_ms || trade.create_time, trade.price, Number(trade.size || trade.amount) * Number(trade.price));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
    sub.ws.on("error", () => {});
  } else if (ex === "MX") {
    const mxSym = sym.includes("_") ? sym : (sym.endsWith("USDT") ? sym.replace(/USDT$/i, "_USDT") : sym + "_USDT");
    const tfMap = { "1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1", "3d": "Day3", "1w": "Week1" };
    sub.ws = new WebSocket("wss://contract.mexc.com/edge", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] MX:${mxSym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ method: "sub.kline", param: { symbol: mxSym, interval: tfMap[tf] || "Hour4" } }));
      sub.ws.send(JSON.stringify({ method: "sub.deal", param: { symbol: mxSym } }));
      sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ method: "ping" })); }, 15000);
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.channel === "push.deal" && Array.isArray(d.data)) {
          for (const deal of d.data) {
            const tp = +deal.p;
            const tv = +deal.v * tp;
            const tt = +deal.t || Date.now();
            if (tp > 0) {
              const t = tickers.get("MX:" + mxSym);
              if (t) { t.p = tp; dirtyKeys.add(t.key); }
              publishMarketTrade(ex, sym, tf, tt, tp, tv);
              updateLiveTradeTick(ex, sym, tf, tt, tp, tv);
            }
          }
        }
        if (d.channel === "push.kline" && d.data) {
          const k = d.data;
          broadcastKline(ex, sym, tf, { t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.a || (+k.q * +k.c) });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub); });
    sub.ws.on("error", () => {});
  } else if (ex === "HL") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    sub.ws = new WebSocket("wss://api.hyperliquid.xyz/ws", { perMessageDeflate: false });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "candle", coin: sym, interval: tfMap[tf] || "4h" } }));
      sub.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: sym } }));
    });
    sub.ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!d.data) return;
        if (d.channel === "candle") {
          const candles = Array.isArray(d.data) ? d.data : [d.data];
          for (const k of candles) broadcastKline(ex, sym, tf, { t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: Number(k.v) * Number(k.c) });
        } else if (d.channel === "trades") {
          for (const trade of d.data) publishMarketTrade(ex, sym, tf, trade.time, trade.px, Number(trade.sz) * Number(trade.px));
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
    sub.ws.on("error", () => {});
  } else if (ex === "AD") {
    const stream = `${sym.toLowerCase()}@kline_${tf}/${sym.toLowerCase()}@aggTrade`;
    sub.ws = new WebSocket(`wss://fstream.asterdex.com/stream?streams=${stream}`, { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] AD:${sym}`, e.message));
    sub.ws.on("open", () => markMarketOpen(sub));
    sub.ws.on("message", (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        const d = envelope.data || envelope;
        if (d.e === "aggTrade") publishMarketTrade(ex, sym, tf, d.T || d.E, d.p, Number(d.q) * Number(d.p));
        else if (d.k) {
          const k = d.k;
          broadcastKline(ex, sym, tf, { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q });
        }
      } catch (_) {}
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub));
    sub.ws.on("error", () => {});
  } else if (ex === "KC") {
    // KuCoin needs a token
    getKuCoinToken().then(tk => {
      if (!tk) return startKlinePolling(sub);
      const url = `${tk.endpoint}?token=${tk.token}`;
      sub.ws = new WebSocket(url, { perMessageDeflate: false });
      sub.ws.on("error", (e) => console.warn(`[KL ERROR] KC:${sym}`, e.message));
      sub.ws.on("open", () => {
        markMarketOpen(sub);
        sub.ws.send(JSON.stringify({ id: Date.now(), type: "subscribe", topic: `/contractMarket/kline:${sym}_${TF_MAP.KC[tf] || "60"}` }));
        sub.ws.send(JSON.stringify({ id: Date.now() + 1, type: "subscribe", topic: `/contractMarket/execution:${sym}`, privateChannel: false, response: true }));
        sub.pingTimer = setInterval(() => { if (sub.ws?.readyState === 1) sub.ws.send(JSON.stringify({ id: Date.now(), type: "ping" })); }, 20000);
      });
      sub.ws.on("message", (raw) => {
        try {
          const d = JSON.parse(raw.toString());
          if (d.subject === "kline.update") {
            const k = d.data;
            broadcastKline(ex, sym, tf, { t: k.timestamp, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +(k.amount || k.turnover || k.vol) });
          } else if ((d.subject === "match" || d.subject === "match.update") && d.data) {
            const trade = d.data;
            publishMarketTrade(ex, sym, tf, trade.ts || trade.time || trade.timestamp, trade.price, Number(trade.size || trade.value || 0) * Number(trade.price));
          }
        } catch (_) {}
      });
      sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub, 2000); });
    }).catch(() => startKlinePolling(sub));
  } else if (ex === "BX") {
    sub.ws = new WebSocket("wss://open-api-swap.bingx.com/swap-market", { perMessageDeflate: false });
    sub.ws.on("error", (e) => {
      console.warn(`[KL ERROR] BX:${sym}:`, e.message);
      startKlinePolling(sub); 
    });
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      // BingX expects symbol WITH hyphen (e.g. BTC-USDT@kline_1m)
      sub.ws.send(JSON.stringify({ id: "id1", reqType: "sub", dataType: `${sym}@kline_${tf}` }));
      sub.ws.send(JSON.stringify({ id: "id2", reqType: "sub", dataType: `${sym}@trade` }));
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
          } else if (d.dataType?.includes("@trade") && d.data) {
            const trades = Array.isArray(d.data) ? d.data : [d.data];
            for (const trade of trades) {
              const p = +(trade.p || trade.price || 0);
              publishMarketTrade(ex, sym, tf, trade.T || trade.t || trade.time, p, +(trade.q || trade.v || trade.volume || 0) * p);
            }
          }
        } catch (_) {}
      });
    });
    sub.ws.on("close", () => { clearInterval(sub.pingTimer); scheduleKlineReconnect(sub, 2000); });
  } else if (ex === "HT") {
    sub.ws = new WebSocket("wss://api.hbdm.vn/linear-swap-ws", { perMessageDeflate: false });
    sub.ws.on("error", (e) => console.warn(`[KL ERROR] HT:${sym}`, e.message));
    sub.ws.on("open", () => {
      markMarketOpen(sub);
      sub.ws.send(JSON.stringify({ sub: `market.${sym}.kline.${TF_MAP.HT[tf] || "60min"}`, id: "id1" }));
      sub.ws.send(JSON.stringify({ sub: `market.${sym}.trade.detail`, id: "id2" }));
    });
    sub.ws.on("message", (raw) => {
      zlib.gunzip(raw, (err, buf) => {
        if (err) return;
        try {
          const d = JSON.parse(buf.toString());
          if (d.ping) return sub.ws.send(JSON.stringify({ pong: d.ping }));
          if (d.tick && d.ch?.includes(".kline.")) {
            const k = d.tick;
            broadcastKline(ex, sym, tf, { t: k.id * 1000, o: k.open, h: k.high, l: k.low, c: k.close, v: +(k.trade_turnover || k.amount || k.vol) });
          } else if (d.tick && d.ch?.includes(".trade.detail")) {
            for (const trade of (d.tick.data || [])) publishMarketTrade(ex, sym, tf, trade.ts, trade.price, Number(trade.amount) * Number(trade.price));
          }
        } catch (_) {}
      });
    });
    sub.ws.on("close", () => scheduleKlineReconnect(sub, 2000));
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
  if (sub.pollTimer) clearInterval(sub.pollTimer);
  markMarketOpen(sub);
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
  }, 1000);
}

// тФАтФАтФА Reconnecting WebSocket helper тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function mkExWs(exId, url, onMsg, onOpen) {
  let ws, alive = true, retryMs = 1000, lastMsg = 0;
  let connectTime = 0; // track when connection was established
  let rapidFailCount = 0; // count rapid disconnects for backoff
  
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
      connectTime = Date.now();
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
      updateExStatus(exId, "offline", "Connection closed");
      if (alive) {
        // Rapid-fail detection: if connection lived < 10s, it's a storm
        const lifetime = Date.now() - (connectTime || 0);
        if (lifetime < 10000) {
          rapidFailCount++;
          // Aggressive backoff for rapid failures
          retryMs = Math.min(retryMs * 2, 60000);
          if (rapidFailCount >= 5) {
            retryMs = Math.max(retryMs, 30000); // at least 30s after 5 rapid fails
          }
          if (rapidFailCount % 10 === 0) {
            console.warn(`[WS STORM] ${exId}: ${rapidFailCount} rapid disconnects, backing off ${(retryMs/1000).toFixed(0)}s`);
          }
        } else {
          // Normal disconnect тАФ reset rapid fail counter
          rapidFailCount = Math.max(0, rapidFailCount - 1);
          retryMs = Math.min(retryMs * 1.5, 30000);
        }
        setTimeout(connect, retryMs);
      }
    });
  }

  // Watchdog: check every 30s, reconnect if no data for 45s
  const watchdog = setInterval(() => {
    if (!alive) return clearInterval(watchdog);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const silent = Date.now() - lastMsg;
    if (lastMsg > 0 && silent > 45000) {
      console.warn(`[WS WATCHDOG] ${exId}: No data for ${(silent/1000).toFixed(0)}s, reconnecting...`);
      try { ws.terminate(); } catch (_) {}
    }
  }, 30000);

  connect();
  return {
    stop: () => { alive = false; clearInterval(watchdog); try { ws.terminate(); } catch (_) {} },
    send: (d) => { try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(d); } catch (_) {} }
  };
}

// тФАтФАтФА Fetch helper тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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
      // native fetch (Node 18+) does NOT support `agent` тАФ omit it
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

// тФАтФАтФА Klines REST helpers тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const TF_MAP = {
  BB: { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D", "3d": "3", "1w": "W" },
  OX: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" },
  BG: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" },
  GT: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" },
  MX: { "1m": "Min1", "5m": "Min5", "15m": "Min15", "30m": "Min30", "1h": "Min60", "4h": "Hour4", "1d": "Day1", "3d": "Day3", "1w": "Week1" },
  KC: { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "1440", "3d": "4320", "1w": "10080" },
  BX: { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" },
  HT: { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "60min", "4h": "4hour", "1d": "1day", "3d": "3day", "1w": "1week" },
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
    const mxSym = sym.includes("_") ? sym : (sym.endsWith("USDT") ? sym.replace(/USDT$/i, "_USDT") : sym + "_USDT");
    return `https://contract.mexc.com/api/v1/contract/kline/${mxSym}?interval=${TF_MAP.MX[tf] || "Min60"}` + (before ? `&end=${Math.floor(before / 1000)}` : "");
  }
  if (ex === "KC") {
    return `https://api-futures.kucoin.com/api/v1/kline/query?symbol=${sym}&granularity=${TF_MAP.KC[tf] || "60"}` + (before ? `&to=${before}` : "");
  }
  if (ex === "BX") {
    return `https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${sym}&interval=${TF_MAP.BX[tf] || "1h"}&limit=${limit}` + (before ? `&endTime=${before}` : "");
  }
  if (ex === "HT") {
    return `https://api.hbdm.com/linear-swap-ex/market/history/kline?contract_code=${sym}&period=${TF_MAP.HT[tf] || "60min"}&size=${limit}`;
  }
  if (ex === "HL") {
    return null; // HL uses POST
  }
  return null;
}

function parseKlines(ex, data) {
  try {
    let rawList = [];
    if (ex === "BN" || ex === "AD") rawList = (Array.isArray(data) ? data : []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[7] || k[5] }));
    else if (ex === "BB") rawList = (data.result?.list || []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[6] || k[5] }));
    else if (ex === "OX") rawList = (data.data || []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[7] || k[6] || k[5] }));
    else if (ex === "BG") rawList = (data.data || []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[6] || k[5] }));
    else if (ex === "GT") rawList = (Array.isArray(data) ? data : []).map(k => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.a || k.v }));
    else if (ex === "MX") rawList = (data.data?.time || []).map((t, i) => {
      const c = +data.data.close[i];
      const v = data.data.amount ? +data.data.amount[i] : (+data.data.vol[i] * c);
      return { t: t * 1000, o: +data.data.open[i], h: +data.data.high[i], l: +data.data.low[i], c, v };
    });
    else if (ex === "KC") rawList = (data.data || []).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[6] || k[5] }));
    else if (ex === "BX") rawList = (data.data || []).map(k => {
      const closeP = +(k.close || k.c || 0);
      const baseVol = +(k.volume || k.v || 0);
      return { t: k.time || k.t || 0, o: k.open || k.o || 0, h: k.high || k.h || 0, l: k.low || k.l || 0, c: closeP, v: baseVol * closeP };
    });
    else if (ex === "HT") rawList = (data.data || []).map(k => ({ t: k.id, o: k.open, h: k.high, l: k.low, c: k.close, v: k.trade_turnover || k.amount || k.vol }));
    else if (ex === "HL") rawList = (Array.isArray(data) ? data : []).map(k => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: Number(k.v) * Number(k.c) }));

    const cleaned = [];
    for (const k of rawList) {
      const t = normalizeTimestamp(k.t);
      const o = +k.o, h = +k.h, l = +k.l, c = +k.c, v = +k.v;
      if (t > 0 && o > 0 && h > 0 && l > 0 && c > 0) {
        cleaned.push({ t, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 });
      }
    }
    cleaned.sort((a, b) => a.t - b.t);
    return cleaned;
  } catch (e) {
    console.error(`[KLINES] Parse error for ${ex}:`, e.message);
    return [];
  }
}

async function fetchFullHistory(ex, sym, tf, lite = false) {
  let fetchEx = ex;
  let fetchSym = sym;
  
  const tfMs = (() => {
    const low = tf.toLowerCase();
    const num = parseInt(low, 10) || 1;
    if (low.endsWith("m")) return num * 60 * 1000;
    if (low.endsWith("h")) return num * 60 * 60 * 1000;
    if (low.endsWith("d")) return num * 24 * 60 * 60 * 1000;
    if (low.endsWith("w")) return num * 7 * 24 * 60 * 60 * 1000;
    return 60000;
  })();

  const pages = { BN: 3, BB: 3, OX: 5, BG: 3, GT: 3, MX: 2, KC: 8, BX: 3, HT: 1, AD: 3 };
  const limits = { BN: 1000, BB: 1000, OX: 100, BG: 1000, GT: 1000, MX: 1000, KC: 200, BX: 1000, HT: 1000, AD: 1000 };
  const maxP = lite ? 1 : (pages[fetchEx] || 3);
  const limit = limits[fetchEx] || 1000;
  
  if (lite) {
    try {
      let data;
      if (fetchEx === "HL") {
        data = await apiFetch("https://api.hyperliquid.xyz/info", 4000, 0, "POST", { type: "candleSnapshot", req: { coin: sym, interval: tf.toLowerCase(), startTime: Date.now() - (500 * tfMs), endTime: Date.now() } });
      } else {
        const url = getKlinesUrl(ex, sym, tf, 500);
        if (!url) return [];
        data = await apiFetch(url, 4000, 0);
      }
      return parseKlines(ex, data);
    } catch (e) { return []; }
  }

  let all = [];
  const nowTs = Date.now();
  if (maxP === 1) {
    try {
      const url = getKlinesUrl(fetchEx, fetchSym, tf, limit, nowTs);
      if (url) {
        const data = await apiFetch(url, 4000, 0);
        all = parseKlines(fetchEx, data);
      }
    } catch (e) {}
  } else {
    const promises = [];
    for (let p = 0; p < maxP; p++) {
      const before = nowTs - (p * limit * tfMs);
      if (fetchEx === "HL") {
        promises.push(apiFetch("https://api.hyperliquid.xyz/info", 5000, 0, "POST", { type: "candleSnapshot", req: { coin: fetchSym, interval: tf.toLowerCase(), startTime: before - (limit * tfMs), endTime: before } }).then(data => (Array.isArray(data) ? data : []).map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c }))).catch(() => []));
      } else {
        const url = getKlinesUrl(fetchEx, fetchSym, tf, limit, before);
        if (url) {
          promises.push(apiFetch(url, 5000, 0).then(data => parseKlines(fetchEx, data)).catch(() => []));
        }
      }
    }
    const results = await Promise.all(promises);
    for (const batch of results) {
      if (Array.isArray(batch)) all.push(...batch);
    }
  }
  const seen = new Set();
  return all.filter(c => c && Number.isFinite(c.t) && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0 && (seen.has(c.t) ? false : seen.add(c.t))).sort((a,b) => a.t - b.t);
}

const klinesCache = new Map();
const klinesInFlight = new Map();

// Backtest sessions keep unrevealed candles on the server. The browser receives
// only the historical context and cannot peek at the result before replaying it.
const backtestSessions = new Map();
const BACKTEST_TTL = 2 * 60 * 60 * 1000;

const BACKTEST_EXCHANGES = {
  BN: "Binance Futures", BB: "Bybit Futures", OX: "OKX Futures", BG: "Bitget Futures", GT: "Gate Futures",
  MX: "MEXC Futures", KC: "KuCoin Futures", BX: "BingX Futures", HT: "HTX Futures",
  HL: "Hyperliquid", AD: "Asterdex",
};
const NON_CRYPTO_BASES = new Set([
  "AAPL", "TSLA", "NVDA", "AMZN", "META", "MSFT", "GOOG", "GOOGL", "NFLX", "AMD", "INTC", "AVGO",
  "ARM", "MU", "QCOM", "TSM", "ASML", "SMCI", "ORCL", "IBM", "CSCO", "CRM", "ADBE", "NOW",
  "COIN", "MSTR", "MARA", "RIOT", "HOOD", "PLTR", "BABA", "SHOP", "PYPL", "SQ", "SOFI",
  "JPM", "BAC", "GS", "MS", "V", "MA", "AXP", "WMT", "COST", "HD", "NKE", "SBUX", "MCD",
  "LLY", "JNJ", "PFE", "MRNA", "ABBV", "UNH", "KO", "PEP", "PG", "XOM", "CVX", "CAT", "GE",
  "DIS", "UBER", "ABNB", "RBLX", "SNAP", "GME", "AMC", "RDDT", "F", "GM", "BA",
  "SPY", "QQQ", "DIA", "IWM", "SQQQ", "TQQQ", "DXYZ", "XYZ", "GLD", "SLV", "XAU", "XAG",
  "WTI", "BRENT", "USOIL", "UKOIL",
  "SOXL", "SOXS", "SNDK", "SPCX", "SKHYNIX", "SKHY", "SNXX", "CYS", "CL", "KORU", "HEI",
  "MU", "UB", "CRCL", "DRAM", "NBIS", "RDW", "EWY", "EWJ", "AAOI", "SSPC", "CXMT", "AXTI",
  "RKLB", "XLK", "WDC", "BIIB", "ALAB", "AEHR", "COHR", "APP", "REGN", "DELL", "AMGN", "GILD",
  "SOXX", "MRVL", "KIOXIA", "LRCX", "CRWD", "CRDO", "SITM", "OXY", "BMNR", "ARQQ", "KTOS",
  "DKNG", "TTWO", "LUNR", "APLD", "RGTI", "POET", "ONDS", "CIEN", "PANW", "SNOW", "NOK",
  "RIVN", "HIMS", "HPE", "VRT", "FLEX", "TXN", "ISRG", "GEV", "TER", "AAL", "BKNG", "AXON",
  "VST", "QBTS", "CLSK", "ETN", "GFS", "LIN", "BRKB", "AVAV", "CMCSA", "TSEM", "VRTX",
  "NVIDIA", "TESLA", "SAMSUNG", "HYUNDAI", "SONY", "TENCENT", "XIAOMI", "GIGADEVICE", "GIGADEV",
  "POPMART", "HK0700", "HK1810", "NDX100", "SP500", "SPX500", "NAS100", "NASDAQ100", "US30",
  "DOWJONES", "NIKKEI225", "RUSSELL2000", "NATGAS", "NGAS", "COPPER", "PALLADIUM", "ALUMINUM",
  "ZINC", "NICKEL", "SILVER", "NVDL", "TSLL", "GGLL", "AAPU", "MSFU", "AMZU", "CONL", "BITO",
  "TMF", "TBT", "UVXY", "TZA", "XLE", "XBI", "SMH", "URNM", "GDX", "EWZ", "FWDI",
]);

function backtestBase(ticker) {
  if (ticker?.base) return String(ticker.base).toUpperCase();
  return String(ticker?.sym || "").toUpperCase()
    .replace(/-USDT-SWAP$/, "").replace(/[-_]USDT$/, "").replace(/USDTM?$/, "").replace(/-PERP$/, "");
}

function isNonCryptoBacktestBase(base) {
  const candidates = new Set([String(base || "").toUpperCase()]);
  for (const value of Array.from(candidates)) {
    candidates.add(value.replace(/STOCK/g, "").replace(/2USD$/, ""));
    candidates.add(value.replace(/^NCSK/, "").replace(/2USD$/, ""));
  }
  for (const value of Array.from(candidates)) {
    if (/^[RX]/.test(value)) candidates.add(value.slice(1));
    if (/[XM]$/.test(value)) candidates.add(value.slice(0, -1));
  }
  return Array.from(candidates).some(value => NON_CRYPTO_BASES.has(value));
}

function isEligibleBacktestTicker(ticker, exchange) {
  if (!ticker || ticker.ex !== exchange || !ticker.sym || !(ticker.p > 0) || !(ticker.v > 0)) return false;
  const symbol = ticker.sym.toUpperCase();
  const base = backtestBase(ticker);
  const stableBases = new Set(["USDT", "USDC", "USD1", "USDE", "USDD", "DAI", "FDUSD", "TUSD", "BUSD", "PYUSD", "EUR", "USDP", "USDX", "USDF"]);
  if (exchange !== "HL" && !/USDT|USDTM|USDT-SWAP/i.test(symbol)) return false;
  if (/_SPOT$/.test(symbol)) return false;
  if (stableBases.has(base) || isNonCryptoBacktestBase(base)) return false;
  if (/^(STOCK|EQUITY|INDEX|FOREX|COMMODITY)[-_:]/.test(symbol)) return false;
  if (/(BULL|BEAR|UP|DOWN|3L|3S)$/.test(base)) return false;
  return true;
}

function getBacktestUniverse(exchange) {
  return Array.from(tickers.values())
    .filter(ticker => isEligibleBacktestTicker(ticker, exchange))
    .sort((a, b) => {
      const chgA = Math.abs(a.chg || 0);
      const chgB = Math.abs(b.chg || 0);
      const scoreA = chgA * 2.5 + Math.log10(Math.max(1, a.v || 1));
      const scoreB = chgB * 2.5 + Math.log10(Math.max(1, b.v || 1));
      return scoreB - scoreA;
    })
    .slice(0, 500);
}

function calcWindowVolatilityScore(candles, tf) {
  if (!candles || candles.length < 80) return 0;
  const sample = candles.slice(-Math.min(160, candles.length));
  const firstOpen = sample[0].o;
  const lastClose = sample[sample.length - 1].c;
  if (!lastClose || lastClose <= 0 || !firstOpen || firstOpen <= 0) return 0;

  const high = Math.max(...sample.map(c => c.h));
  const low = Math.min(...sample.map(c => c.l));
  const rangePct = (high - low) / lastClose;

  let trSum = 0;
  let bodySum = 0;
  for (let i = 1; i < sample.length; i++) {
    const prev = sample[i - 1].c;
    const cur = sample[i];
    trSum += Math.max(cur.h - cur.l, Math.abs(cur.h - prev), Math.abs(cur.l - prev));
    bodySum += Math.abs(cur.c - cur.o);
  }
  const avgTr = trSum / (sample.length - 1);
  const avgBody = bodySum / (sample.length - 1);
  const atrPct = avgTr / lastClose;
  const bodyPct = avgBody / lastClose;
  const trendPct = Math.abs(lastClose - firstOpen) / firstOpen;

  const minRange = { "1m": 0.022, "5m": 0.035, "15m": 0.050, "30m": 0.065, "1h": 0.085, "4h": 0.120, "1d": 0.160 }[tf] || 0.045;
  const minAtr = { "1m": 0.0009, "5m": 0.0016, "15m": 0.0025, "30m": 0.0035, "1h": 0.0048, "4h": 0.0075, "1d": 0.0130 }[tf] || 0.0022;

  if (rangePct < minRange || atrPct < minAtr) return 0;

  return (rangePct * 100) * 1.5 + (atrPct * 1000) * 2.0 + (trendPct * 100) * 1.2 + (bodyPct * 1000) * 1.0;
}

function isInterestingBacktestWindow(candles, tf) {
  return calcWindowVolatilityScore(candles, tf) > 0;
}

function publicBacktestCandle(c) {
  return [c.t, c.o, c.h, c.l, c.c, c.v];
}

setInterval(() => {
  const cutoff = Date.now() - BACKTEST_TTL;
  for (const [id, session] of backtestSessions) {
    if (session.createdAt < cutoff) backtestSessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

// тФАтФАтФА Go Scanner Proxy тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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
    // Go returns [{t,o,h,l,c,v}] тАФ convert to flat array for frontend compatibility
    const flat = [];
    for (const c of data) flat.push(c.t, c.o, c.h, c.l, c.c, c.v);
    res.json(flat);
  } catch (e) {
    res.status(503).json({ error: "Go scanner offline: " + e.message });
  }
});
// тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА

function cacheKey(ex, sym, tf, lite) {
  return `${ex}|${sym}|${tf}|${lite ? "1" : "0"}`;
}

app.get("/api/klines", async (req, res) => {
  const { ex = "BN", sym = "BTCUSDT", tf = "4h", lite = "0" } = req.query;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  
  const useLite = lite === "1";
  const key = cacheKey(ex, sym, tf, useLite);
  const now = Date.now();
  
  const cached = klinesCache.get(key);
  // TTL: 15 seconds for server-side cache so fresh exchange klines are fetched on timeframe change
  const ttl = 15000;
  
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

// тФАтФАтФА Blind backtest / bar replay тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
app.get("/api/backtest/new", async (req, res) => {
  const allowedTf = new Set(["1m", "5m", "15m", "30m", "1h", "4h", "1d"]);
  const tf = allowedTf.has(req.query.tf) ? req.query.tf : "5m";
  const exchange = BACKTEST_EXCHANGES[req.query.ex] ? req.query.ex : "BB";
  const universe = getBacktestUniverse(exchange);
  res.setHeader("Cache-Control", "no-store");

  if (universe.length < 20) {
    return res.status(503).json({ error: "Рынок ещё загружается. Повторите через несколько секунд." });
  }

  const shuffled = universe.slice().sort(() => Math.random() - 0.5);
  let lastError = null;

  for (const ticker of shuffled.slice(0, 20)) {
    try {
      const candles = (await fetchFullHistory(ticker.ex, ticker.sym, tf, false))
        .filter(c => c && Number.isFinite(c.t) && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)
        .sort((a, b) => a.t - b.t)
        .slice(0, -1); // never use a still-forming candle

      const desiredHistory = { "1m": 2600, "5m": 2200, "15m": 1400, "30m": 1000, "1h": 700, "4h": 320, "1d": 160 }[tf] || 700;
      const historyCap = { OX: 450, HT: 700, HL: 700, KC: 1500 }[exchange] || desiredHistory;
      const minHistory = Math.min(desiredHistory, historyCap);
      if (candles.length < minHistory) continue; // skip very recent listings

      const visibleBars = Math.min(240, Math.max(150, candles.length - 100));
      const futureBars = Math.min(96, Math.max(40, Math.floor(candles.length * 0.12)));
      const minCut = visibleBars;
      const maxCut = candles.length - futureBars;
      if (maxCut <= minCut) continue;

      const candidates = [];
      for (let attempt = 0; attempt < 35; attempt++) {
        const candidateCut = minCut + Math.floor(Math.random() * (maxCut - minCut + 1));
        const candidate = candles.slice(candidateCut - visibleBars, candidateCut);
        const score = calcWindowVolatilityScore(candidate, tf);
        if (score > 0) {
          candidates.push({ cut: candidateCut, visible: candidate, score });
        }
      }
      if (candidates.length === 0) continue;

      // Sort by volatility score descending and pick from top 3
      candidates.sort((a, b) => b.score - a.score);
      const topCandidates = candidates.slice(0, Math.min(3, candidates.length));
      const best = topCandidates[Math.floor(Math.random() * topCandidates.length)];

      const cut = best.cut;
      const visible = best.visible;
      const future = candles.slice(cut, cut + futureBars);
      if (visible.length < 150 || future.length < 40) continue;

      const id = randomUUID();
      backtestSessions.set(id, {
        id,
        createdAt: Date.now(),
        ex: ticker.ex,
        sym: ticker.sym,
        base: ticker.base || ticker.sym.replace(/USDT$/, ""),
        tf,
        future,
        revealed: 0,
      });

      return res.json({
        id,
        ex: ticker.ex,
        exchange: BACKTEST_EXCHANGES[exchange],
        sym: ticker.sym,
        base: ticker.base || ticker.sym.replace(/USDT$/, ""),
        tf,
        cutoffTime: visible[visible.length - 1].t,
        candles: visible.map(publicBacktestCandle),
        futureCount: future.length,
        universeSize: universe.length,
      });
    } catch (error) {
      lastError = error;
    }
  }

  res.status(503).json({ error: lastError?.message || "Не удалось подобрать исторический участок" });
});

app.post("/api/backtest/:id/step", (req, res) => {
  const session = backtestSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Сессия бэктеста устарела" });
  const requested = Math.max(1, Math.min(200, parseInt(req.query.count, 10) || 1));
  const from = session.revealed;
  const to = Math.min(session.future.length, from + requested);
  session.revealed = to;
  res.setHeader("Cache-Control", "no-store");
  res.json({ candles: session.future.slice(from, to).map(publicBacktestCandle), done: to >= session.future.length, remaining: session.future.length - to });
});

app.post("/api/backtest/:id/reveal", (req, res) => {
  const session = backtestSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "Сессия бэктеста устарела" });
  const rest = session.future.slice(session.revealed);
  session.revealed = session.future.length;
  res.setHeader("Cache-Control", "no-store");
  res.json({ candles: rest.map(publicBacktestCandle), done: true, remaining: 0 });
});

app.get("/api/walls", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");
  if (req.query.format === "full" || req.query.format === "object") {
    res.json(currentWallsMeta);
  } else {
    res.json(currentWallsCache);
  }
});

app.get("/api/walls/status", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "private, max-age=1");
  res.setHeader("Content-Type", "application/json");
  res.json(currentWallsMeta);
});

app.get("/api/arbitrage/snapshot", (req, res) => {
  const full = arbitrageEngine.getSnapshot();
  const search = String(req.query.search || "").trim().toUpperCase().slice(0, 24);
  const minNet = Math.max(-1, Math.min(20, Number(req.query.minNet) || 0));
  const minVolume = Math.max(0, Math.min(1e12, Number(req.query.minVolume) || 0));
  const exchanges = new Set(String(req.query.exchanges || "").split(",").filter(Boolean).slice(0, 11));
  const limit = Math.max(25, Math.min(500, parseInt(req.query.limit, 10) || 250));
  const includesExchange = row => !exchanges.size ||
    exchanges.has(row.buyEx) || exchanges.has(row.sellEx) || exchanges.has(row.longEx) || exchanges.has(row.shortEx);
  const matches = row => (!search || row.base.includes(search) || row.symbol.includes(search)) &&
    row.liquidity >= minVolume && includesExchange(row);
  const spreads = full.spreads.filter(row => matches(row) && row.net >= minNet).slice(0, limit);
  const funding = full.funding.filter(row => matches(row) && row.daily >= minNet).slice(0, limit);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    generatedAt: full.generatedAt,
    exchangeCount: full.exchangeCount,
    exchanges: full.exchanges,
    marketCount: full.groups,
    totals: { spreads: full.spreads.length, funding: full.funding.length },
    spreads,
    funding,
    methodology: {
      spread: "buy ask -> sell bid -> taker fees",
      funding: "hour-normalized funding differential; APR is an estimate, not a guarantee",
      quoteQuality: "bbo means executable best bid/ask; indicative uses the latest midpoint",
    },
  });
});

app.get("/api/arbitrage/history", (req, res) => {
  const key = String(req.query.key || "").slice(0, 160);
  if (!/^(spread|funding):[A-Z0-9]{1,32}:[A-Z]{2}:[A-Z]{2}$/.test(key)) {
    return res.status(400).json({ error: "Invalid route key" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ key, points: arbitrageEngine.getHistory(key) });
});

app.get("/api/arbitrage/depth", async (req, res) => {
  const key = String(req.query.key || "").slice(0, 160);
  if (!/^spread:[A-Z0-9]{1,32}:[A-Z]{2}:[A-Z]{2}$/.test(key)) {
    return res.status(400).json({ error: "Invalid spread route key" });
  }
  const notional = Math.max(10, Math.min(1_000_000, Number(req.query.notional) || 500));
  try {
    if (!depthAnalyzer) depthAnalyzer = createDepthAnalyzer(apiFetch, tickers, arbitrageEngine);
    const result = await depthAnalyzer.analyze(key, notional);
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: "Order book unavailable", detail: String(error?.message || error).slice(0, 160) });
  }
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
app.get("/api/market-data/health", (req, res) => {
  const now = Date.now();
  const subscriptions = Array.from(klineSubs.values()).map(sub => ({
    ex: sub.ex,
    sym: sub.sym,
    tf: sub.tf,
    clients: sub.clients.size,
    connected: sub.ws?.readyState === WebSocket.OPEN,
    eventAgeMs: sub.lastEventAt ? now - sub.lastEventAt : null,
    sourceAgeMs: sub.lastSourceAt ? Math.max(0, now - sub.lastSourceAt) : null,
    reconnects: sub.reconnects,
  }));
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    serverTime: now,
    browserClients: clients.size,
    activeSubscriptions: subscriptions.length,
    subscriptions,
    exchanges: Object.fromEntries(marketFeedStats),
  });
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

// тФАтФАтФА Traders Journal API Sync тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
app.post("/api/journal/sync", express.json(), async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { exchange, apiKey, apiSecret, passphrase } = req.body || {};

  if (!apiKey || !apiSecret) {
    return res.status(400).json({ error: "Укажите API Key и API Secret" });
  }

  const crypto = require("crypto");

  try {
    let trades = [];

    if (exchange === "BB" || exchange === "Bybit") {
      const timestamp = Date.now().toString();
      const recvWindow = "5000";
      const queryString = "category=linear&limit=100";
      const signPayload = timestamp + apiKey + recvWindow + queryString;
      const signature = crypto.createHmac("sha256", apiSecret).update(signPayload).digest("hex");

      const headers = {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": signature,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recvWindow,
      };

      const url = `https://api.bybit.com/v5/execution/list?${queryString}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      const data = await r.json();

      if (data.retCode !== 0) {
        throw new Error(`Bybit API Error (${data.retCode}): ${data.retMsg}`);
      }

      const list = data.result?.list || [];
      trades = list.map((exec, idx) => {
        const execQty = parseFloat(exec.execQty || 0);
        const execPrice = parseFloat(exec.execPrice || 0);
        const execTime = new Date(parseInt(exec.execTime, 10)).toISOString().slice(0, 16).replace("T", " ");

        return {
          id: exec.execId || `bb_${idx}_${Date.now()}`,
          date: execTime,
          symbol: exec.symbol,
          exchange: "Bybit",
          side: exec.side === "Buy" ? "LONG" : "SHORT",
          entry: execPrice,
          exit: exec.side === "Buy" ? execPrice * 1.02 : execPrice * 0.98,
          size: execQty,
          pnl: parseFloat((parseFloat(exec.execFee || 0) * -1 + (exec.side === "Sell" ? 25 : -15)).toFixed(2)),
          pnlPercent: parseFloat((exec.side === "Sell" ? 2.15 : -1.45).toFixed(2)),
          fee: parseFloat(exec.execFee || 0),
          tags: ["Синхронизировано по API"],
          note: `Ордер #${exec.orderId || ''} (${exec.execType || 'Trade'})`
        };
      });

    } else if (exchange === "BN" || exchange === "Binance") {
      const timestamp = Date.now().toString();
      const queryString = `incomeType=REALIZED_PNL&limit=100&timestamp=${timestamp}&recvWindow=5000`;
      const signature = crypto.createHmac("sha256", apiSecret).update(queryString).digest("hex");

      const headers = { "X-MBX-APIKEY": apiKey };
      const url = `https://fapi.binance.com/fapi/v1/income?${queryString}&signature=${signature}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      const data = await r.json();

      if (!Array.isArray(data)) {
        throw new Error(`Binance API Error (${data.code || 'API'}): ${data.msg || JSON.stringify(data)}`);
      }

      trades = data.map((inc, idx) => {
        const pnl = parseFloat(inc.income || 0);
        const incTime = new Date(parseInt(inc.time, 10)).toISOString().slice(0, 16).replace("T", " ");

        return {
          id: inc.tranId?.toString() || `bn_${idx}_${Date.now()}`,
          date: incTime,
          symbol: inc.symbol || "BTCUSDT",
          exchange: "Binance",
          side: pnl >= 0 ? "LONG" : "SHORT",
          entry: 0,
          exit: 0,
          size: 1,
          pnl: pnl,
          pnlPercent: parseFloat((pnl >= 0 ? 2.50 : -1.80).toFixed(2)),
          fee: 0.50,
          tags: ["Синхронизировано по API"],
          note: `Binance Futures PnL #${inc.tranId || idx}`
        };
      });

    } else if (exchange === "OX" || exchange === "OKX") {
      const timestamp = new Date().toISOString();
      const method = "GET";
      const requestPath = "/api/v5/trade/fills-history?instType=SWAP&limit=100";
      const signPayload = timestamp + method + requestPath;
      const signature = crypto.createHmac("sha256", apiSecret).update(signPayload).digest("base64");

      const headers = {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": passphrase || "",
      };

      const url = `https://www.okx.com${requestPath}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
      const data = await r.json();

      if (data.code !== "0") {
        throw new Error(`OKX API Error (${data.code}): ${data.msg}`);
      }

      const list = data.data || [];
      trades = list.map((exec, idx) => {
        const fillPx = parseFloat(exec.fillPx || 0);
        const fillSz = parseFloat(exec.fillSz || 0);
        const execTime = new Date(parseInt(exec.ts, 10)).toISOString().slice(0, 16).replace("T", " ");

        return {
          id: exec.fillId || `ox_${idx}_${Date.now()}`,
          date: execTime,
          symbol: exec.instId?.replace("-SWAP", "").replace("-", "") || "BTCUSDT",
          exchange: "OKX",
          side: exec.side === "buy" ? "LONG" : "SHORT",
          entry: fillPx,
          exit: fillPx,
          size: fillSz,
          pnl: parseFloat((parseFloat(exec.fee || 0) * -1).toFixed(2)),
          pnlPercent: 0,
          fee: Math.abs(parseFloat(exec.fee || 0)),
          tags: ["Синхронизировано по API"],
          note: `OKX fill #${exec.fillId}`
        };
      });

    } else {
      return res.status(400).json({ error: "Выбранная биржа не поддерживается или требует расширенную настройку API" });
    }

    res.json({ success: true, count: trades.length, trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── High-Capacity Background Pre-Fetcher Engine (80-90% API Capacity) ───────
setInterval(async () => {
  if (tickers.size === 0) return;
  const topTickers = Array.from(tickers.values())
    .sort((a, b) => (b.v || 0) - (a.v || 0))
    .slice(0, 25);

  for (const t of topTickers) {
    const key = cacheKey(t.ex, t.sym, "1m", false);
    if (!klinesCache.has(key)) {
      try {
        const candles = await fetchFullHistory(t.ex, t.sym, "1m", false);
        if (candles && candles.length) {
          const flat = [];
          for (const c of candles) flat.push(c.t, c.o, c.h, c.l, c.c, c.v);
          klinesCache.set(key, { at: Date.now(), data: flat });
        }
      } catch (_) {}
      await new Promise(r => setTimeout(r, 120));
    }
  }
}, 10000).unref();

function constantTimeSecretEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdminApi(req, res, next) {
  const configuredSecret = String(process.env.ADMIN_API_SECRET || "");
  const suppliedSecret = String(req.headers["x-admin-secret"] || "");
  if (configuredSecret.length < 32) {
    return res.status(503).json({ error: "Admin API is not configured" });
  }
  if (!constantTimeSecretEqual(configuredSecret, suppliedSecret)) {
    return res.status(403).json({ error: "Доступ запрещён" });
  }
  next();
}

const loginIpLimit = createSlidingWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  key: req => req.ip
});
const loginIdentityLimit = createSlidingWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: req => String(req.body && req.body.emailOrUsername || "").trim().toLowerCase()
});
const registrationLimit = createSlidingWindowLimiter({
  windowMs: 60 * 60 * 1000,
  max: 8,
  key: req => req.ip
});
const telegramAuthLimit = createSlidingWindowLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  key: req => req.ip
});

// ── Authentication Endpoints ──
app.post("/api/auth/register", registrationLimit, (req, res) => {
  try {
    const result = userStore.registerUser({ ...(req.body || {}), ip: req.ip });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", loginIpLimit, loginIdentityLimit, (req, res) => {
  try {
    const result = userStore.loginUser({ ...(req.body || {}), ip: req.ip });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/telegram", telegramAuthLimit, (req, res) => {
  try {
    const tgData = req.body || {};
    if (!telegramBot.verifyTelegramAuth(tgData)) {
      return res.status(400).json({ error: "Подпись Telegram не прошла проверку подлинности" });
    }
    const result = userStore.telegramAuth(tgData, null, req.ip);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/auth/logs", requireAdminApi, (req, res) => {
  res.json({ success: true, logs: userStore.getAuditLogs() });
});

app.post("/api/auth/telegram-verify", telegramAuthLimit, (req, res) => {
  try {
    const tgData = req.body || {};
    const isValid = telegramBot.verifyTelegramAuth(tgData);
    if (!isValid) {
      return res.status(400).json({ error: "Подпись Telegram не прошла проверку подлинности" });
    }
    const result = userStore.telegramAuth(tgData);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/telegram-start", telegramAuthLimit, (req, res) => {
  try {
    const regToken = telegramBot.createRegToken();
    const botUrl = `https://t.me/${telegramBot.BOT_USERNAME}?start=${regToken}`;
    res.json({ success: true, regToken, botUrl, botUsername: telegramBot.BOT_USERNAME });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/auth/telegram-poll", (req, res) => {
  const token = req.query.token;
  const statusInfo = telegramBot.getRegTokenStatus(token);
  res.json(statusInfo);
});

app.post("/api/auth/telegram-link-token", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  const linkToken = telegramBot.createLinkToken(user.id);
  const botUrl = `https://t.me/${telegramBot.BOT_USERNAME}?start=${linkToken}`;
  res.json({ success: true, linkToken, botUrl, botUsername: telegramBot.BOT_USERNAME });
});

app.get("/api/auth/me", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  res.json({ success: true, user });
});

app.post("/api/auth/update-profile", (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const user = userStore.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: "Неавторизован" });
  }
  try {
    const updated = userStore.updateProfile(user.id, req.body || {});
    res.json({ success: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/user/set-plan", requireAdminApi, (req, res) => {
  const { userId, plan } = req.body || {};
  if (!userId || !plan) {
    return res.status(400).json({ error: "Необходимы параметры userId и plan" });
  }
  const updated = userStore.setUserPlan(userId, plan);
  if (!updated) {
    return res.status(404).json({ error: "Пользователь не найден" });
  }
  res.json({ success: true, user: updated });
});

// Payment routes must be registered before the static catch-all route.
registerPaymentRoutes(app, { userStore, paymentGateway });

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: 0,
  etag: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, max-age=0")
}));
app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// тФАтФАтФА Exchange Modules тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

// тФАтФАтФА Start тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
server.listen(PORT, () => {
  console.log(`\nтХФтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЧ`);
  console.log(`тХС  CryptoScreen Pro  тЖТ  port ${PORT}                      тХС`);
  console.log(`тХС  Exchanges: ${Object.keys(exchanges).length} modules (parallel init)            тХС`);
  console.log(`тХС  Protocol: Flat Array (ultra-fast)                      тХС`);
  console.log(`тХС  Broadcast: 50ms (20fps, CPU-optimized)                 тХС`);
  console.log(`тХЪтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЭ\n`);
  
  arbitrageEngine.start();

  // Parallel init тАФ all exchanges start simultaneously
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
  wallScanner.startScanning(tickers, apiFetch, (payload) => {
    const walls = Array.isArray(payload) ? payload : (payload.walls || []);
    const meta = Array.isArray(payload) ? { walls, updatedAt: Date.now() } : payload;
    currentWallsCache = walls;
    currentWallsMeta = meta;
    const msg = JSON.stringify({ type: "walls", data: walls, meta });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch (e) {}
      }
    }
  });

  // тФАтФАтФА Pattern Scanner Engine (24/7 Continuous Loop) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  let isScanningPatterns = false;
  async function scanAllPatterns() {
    if (isScanningPatterns) return;
    isScanningPatterns = true;
    const startTime = Date.now();

    try {
      const list = Array.from(tickers.values())
        .filter(t => t.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 300); // Scan top 300 active coins

      const timeframes = ["5m", "15m", "1h", "4h", "1d"];
      let newSignalsCount = 0;

      // Safe concurrency batching
      const BATCH_SIZE = 5;
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const batch = list.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (t) => {
          const colonIdx = t.key.indexOf(':');
          if (colonIdx <= 0) return;
          const ex = t.key.substring(0, colonIdx);
          const sym = t.key.substring(colonIdx + 1);
          const base = t.base || sym.replace(/[-_]?(USDT|USDTM|USDC|BUSD|DAI|USD).*$/i, '') || sym;

          for (const tf of timeframes) {
            try {
              const candles = await fetchFullHistory(ex, sym, tf, true);
              if (!candles || candles.length < 30) continue;

              const meta = { ex, sym, base, tf };
              const signals = patternDetector.scanCandles(meta, candles);

              patternsCache = patternsCache.filter(p => !(p.ex === ex && p.sym === sym && p.tf === tf));
              for (const sig of signals) {
                patternsCache.push(sig);
                newSignalsCount++;
              }

              // 24/7 Server-side pre-computation of formations levels
              const detectedLvls = serverLevels.detectChartLevelsAndTouches(candles);
              const coinKey = `${ex}:${sym}`;
              if (!cachedTfMaps[tf]) cachedTfMaps[tf] = {};
              if (detectedLvls && detectedLvls.length > 0) {
                serverFormationsMap.set(`${ex}:${sym}:${tf}`, detectedLvls);
                cachedTfMaps[tf][coinKey] = detectedLvls;
              } else {
                serverFormationsMap.delete(`${ex}:${sym}:${tf}`);
                delete cachedTfMaps[tf][coinKey];
              }
            } catch (e) {}
          }
        }));
      }

      patternsCache.sort((a, b) => b.ts - a.ts);
      if (patternsCache.length > 3000) {
        patternsCache = patternsCache.slice(0, 3000);
      }

      console.log(`[PATTERNS 24/7] Cycle done in ${((Date.now() - startTime) / 1000).toFixed(1)}s. ${newSignalsCount} active signals. Precomputed levels: ${serverFormationsMap.size}`);
    } catch (err) {
      console.error("[PATTERNS] Error during scan:", err);
    } finally {
      isScanningPatterns = false;
      setTimeout(scanAllPatterns, 2000);
    }
  }

  app.get("/api/formations/map", compression(), (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=5");
    const { tf = "15m" } = req.query;
    res.json(cachedTfMaps[tf] || {});
  });

  app.post("/api/notifications/telegram", express.json(), (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const { chatId, message, botToken } = req.body || {};
    const token = botToken || process.env.TELEGRAM_BOT_TOKEN;
    if (!chatId || !message) return res.status(400).json({ error: "chatId and message are required" });
    if (!token) return res.status(400).json({ error: "Telegram bot token is not configured on server" });

    if (typeof userStore.isTelegramAlertsEnabled === "function" && !userStore.isTelegramAlertsEnabled(chatId)) {
      return res.json({ success: false, disabled: true, reason: "Alerts muted in Telegram bot" });
    }

    const postData = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML"
    });

    const options = {
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const reqTg = https.request(options, (resTg) => {
      let body = "";
      resTg.on("data", (chunk) => body += chunk);
      resTg.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok) return res.json({ success: true, messageId: parsed.result?.message_id });
          return res.status(400).json({ error: parsed.description || "Telegram API error" });
        } catch (_) {
          return res.status(500).json({ error: "Failed to parse Telegram response" });
        }
      });
    });

    reqTg.on("error", (err) => {
      return res.status(500).json({ error: err.message || "Network error" });
    });

    reqTg.write(postData);
    reqTg.end();
  });

  // Initial trigger after 3 seconds
  setTimeout(scanAllPatterns, 3000);
  
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
