"use strict";

// ═══ State ═══════════════════════════════════════════════════════════════════
const coins = new Map();
const dirty = new Set();
const rowEls = new Map();
const priceHistories = new Map();
let isHoveringScreener = false;

function pearsonCorrelationAbs(x, y) {
  let n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  // Use absolute prices directly for true correlation (professional standard)
  let rx = x.slice(-n);
  let ry = y.slice(-n);

  let meanX = 0, meanY = 0;
  for (let i = 0; i < n; i++) {
    meanX += rx[i];
    meanY += ry[i];
  }
  meanX /= n;
  meanY /= n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - meanX;
    const dy = ry[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

function updatePriceHistory() {
  // ─── Verified BTC key per exchange (from server tickers.set() calls) ───
  const BTC_KEY = {
    BN: "BN:BTCUSDT",
    BB: "BB:BTCUSDT",
    OX: "OX:BTC-USDT-SWAP",
    BG: "BG:BTCUSDT",
    GT: "GT:BTC_USDT",
    MX: "MX:BTC_USDT",
    KC: "KC:XBTUSDTM",
    BX: "BX:BTC-USDT",
    HT: "HT:BTC-USDT",
    HL: "HL:BTC",
    AD: "AD:BTCUSDT",
  };

  for (const [key, c] of coins.entries()) {
    // ─── 1. Price history for correlation ───
    let hist = priceHistories.get(key);
    if (!hist) { hist = []; priceHistories.set(key, hist); }
    hist.push(c.p);
    if (hist.length > 120) hist.shift();

    // ─── 2. Correlation vs BTC (percentage-return Pearson) ───
    // Try exchange-native BTC first, fall back to Binance BTC
    const btcKey = BTC_KEY[c.ex];
    let btcHist = (btcKey && btcKey !== key) ? priceHistories.get(btcKey) : null;
    if ((!btcHist || btcHist.length < 10) && c.ex !== "BN") {
      btcHist = priceHistories.get("BN:BTCUSDT"); // universal fallback
    }
    if (btcHist && btcHist.length >= 10 && hist.length >= 10 && btcKey !== key) {
      c.corr = Math.round(pearsonCorrelationAbs(hist, btcHist) * 100);
    } else {
      c.corr = undefined;
    }
  }
  needRebuild = true;
}
setInterval(updatePriceHistory, 5000);


let activeEx = "BN",
  activeSym = "BTCUSDT",
  activeTf = "4h";
let listEx = "BN",
  searchQ = ""; // listEx tracks dropdown, default = BN

let sortCol = "chg",
  sortDir = 1; // 1=desc, -1=asc
const TAG_PALETTE = [
  "#ff4560",
  "#26c97a",
  "#7c3aed",
  "#00baff",
  "#f97316",
  "#eab308",
  "#ec4899",
  "#10b981",
  "#6366f1",
  "#a855f7",
  "#f43f5e",
  "#06b6d4",
  "#84cc16",
  "#f59e0b",
  "#475569",
];
let coinTags = {};
let idToKey = {}; // Binary Protocol: ID -> TickerKey mapping
let activeColorFilters = new Set();
const defaultCols = { chg: true, v: true, oi: true, funding: true, corr: true };
let visibleCols = { ...defaultCols };

function updateTableGrid() {
  const SIZES = {
    chg: "52px",
    v: "46px",
    trades: "44px",
    oi: "36px",
    corr: "36px",
    funding: "42px"
  };

  let gridStr = "minmax(66px, 1.5fr)";
  let minContentWidth = 90;
  for (const [key, size] of Object.entries(SIZES)) {
    const cb = document.getElementById(`col-${key}`);
    const isVisible = visibleCols[key] !== false;
    if (isVisible) {
      gridStr += ` ${size}`;
      minContentWidth += parseInt(size, 10) + 4;
      document.body.classList.remove(`hide-col-${key}`);
      if (cb) cb.checked = true;
    } else {
      document.body.classList.add(`hide-col-${key}`);
      if (cb) cb.checked = false;
    }
  }

  document.documentElement.style.setProperty("--table-grid", gridStr);

  const rp = $("rp");
  if (rp) {
    const currentWidth = parseInt(rp.style.width || "0", 10);
    if (currentWidth > minContentWidth + 100 || currentWidth < minContentWidth) {
      rp.style.width = Math.max(minContentWidth, 120) + "px";
      rp.style.minWidth = Math.max(minContentWidth, 120) + "px";
    }
  }

  localStorage.setItem("tableCols", JSON.stringify(visibleCols));
}

function loadFilterSettings() {
  try {
    const saved = localStorage.getItem("tableCols");
    if (saved) visibleCols = { ...defaultCols, ...JSON.parse(saved) };
  } catch (e) { }
  updateTableGrid();
}

function bindFilterListeners() {
  Object.keys(defaultCols).forEach(key => {
    const cb = document.getElementById(`col-${key}`);
    if (cb) {
      cb.addEventListener("change", (e) => {
        visibleCols[key] = e.target.checked;
        updateTableGrid();
      });
    }
  });
}

const loadTags = () => {
  try {
    coinTags = JSON.parse(localStorage.getItem("crypto_tags") || "{}");
  } catch {
    coinTags = {};
  }
};
const saveTags = () => {
  localStorage.setItem("crypto_tags", JSON.stringify(coinTags));
};

let candles = [],
  chartW = 0,
  chartH = 0;
const volH = 100;
let offsetX = 0;
function getClampedOffsetX(val) {
  if (candles.length === 0) return 0;
  const PW = chartW - (typeof PR_WIDTH !== 'undefined' ? PR_WIDTH : 82);
  const visibleCount = PW / candleW;
  // Limit how much "future" space is allowed (right edge margin)
  // -visibleCount * 0.8 means we can push the last candle only 80% out of view to the left?
  // Wait, offsetX < 0 means candles move left (leaving space on right).
  // Let's cap right-side empty space to 80% of the screen.
  const minX = -visibleCount * 0.8;
  // Cap left-side scroll so we don't go past the first candle
  const maxX = candles.length - 1;
  return Math.max(minX, Math.min(maxX, val));
}
let candleW = 10;

let chartDrawings = []; // { type, t1, p1, t2, p2 }
let activeTool = "none";
let tempDrawing = null;       // drawing in progress
let drawingPhase = 0;         // 0=idle, 1=placed first point waiting for second
let magnetMode = false;       // snap cursor to nearest candle OHLC point
let magnetSnap = null;        // { t, p } current snap point or null
let dragDrawing = null;       // { idx, handle:'p1'|'p2'|'move', ... }
let hoverDrawingIdx = -1;     // index of drawing under cursor (-1 = none)
let quickMeasure = null;
let editingFibDrawing = null;

// ── Direct Trade WS (Zero-Lag Pricing) ───────────────────────────────────────
let activeTradeWs = null;
function updateActiveTradeStream(ex, sym) {
  try {
    if (activeTradeWs) {
      activeTradeWs.onclose = null;
      try { activeTradeWs.close(); } catch (_) { }
      activeTradeWs = null;
    }

    if (ex === "KC") {
      fetch("/api/kucoin-token").then(r => r.json()).then(tk => {
        if (!tk || !tk.token) return;
        const url = `${tk.endpoint}?token=${tk.token}`;
        const ws = new WebSocket(url);
        activeTradeWs = ws;
        ws.onopen = () => {
          ws.send(JSON.stringify({ id: Date.now(), type: "subscribe", topic: `/contractMarket/execution:${sym}`, privateChannel: false, response: true }));
          const ping = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: Date.now(), type: "ping" })); else clearInterval(ping); }, 18000);
        };
        ws.onmessage = (e) => {
          try {
            const d = JSON.parse(e.data);
            if ((d.subject === "ticker" || d.subject === "match.update") && d.data) {
              const p = +(d.data.price || d.data.lastTradePrice || 0);
              const c = coins.get(`KC:${sym}`);
              if (p > 0 && c) {
                c.p = p;
                dirty.add(c.key);
              }
            }
          } catch (_) { }
        };
      }).catch(e => console.warn("KuCoin Direct WS failed:", e));
      return;
    }

    let url = "";
    if (ex === "BN") url = `wss://fstream.binance.com/ws/${sym.toLowerCase()}@aggTrade`;
    else if (ex === "AD") url = `wss://fstream.asterdex.com/ws/${sym.toLowerCase()}@aggTrade`;
    else if (ex === "BB") url = `wss://stream.bybit.com/v5/public/linear`;
    else if (ex === "OX") url = `wss://ws.okx.com:8443/ws/v5/public`;
    else if (ex === "BX") url = `wss://open-api.bingx.com/openApi/swap/v2/quote/stream`;
    else if (ex === "MX") url = `wss://contract.mexc.com/edge`;
    else if (ex === "HL") url = `wss://api.hyperliquid.xyz/ws`;
    else if (ex === "BG") url = `wss://ws.bitget.com/v2/ws/public`;
    else if (ex === "GT") url = `wss://fx-ws.gateio.ws/v4/ws/usdt`;
    else if (ex === "HT") url = `wss://api.hbdm.vn/linear-swap-ws`;

    if (!url) return;

    const ws = new WebSocket(url);
    activeTradeWs = ws;
    ws.onopen = () => {
      try {
        if (ex === "BB") ws.send(JSON.stringify({ op: "subscribe", args: [`publicTrade.${sym}`] }));
        else if (ex === "OX") ws.send(JSON.stringify({ op: "subscribe", args: [{ channel: "trades", instId: sym }] }));
        else if (ex === "BX") ws.send(JSON.stringify({ method: "SUBSCRIBE", params: [`${sym.toLowerCase()}@trade`], id: 1 }));
        else if (ex === "MX") {
          ws.send(JSON.stringify({ method: "sub.deal", param: { symbol: sym } }));
          ws.send(JSON.stringify({ method: "sub.ticker", param: { symbol: sym } }));
        }
        else if (ex === "HL") ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: sym } }));
        else if (ex === "BG") ws.send(JSON.stringify({ op: "subscribe", args: [{ instType: "USDT-FUTURES", channel: "trade", instId: sym }] }));
        else if (ex === "GT") ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "futures.trades", event: "subscribe", payload: [sym] }));
        else if (ex === "HT") ws.send(JSON.stringify({ sub: `market.${sym}.trade.detail`, id: "active_trade" }));
      } catch (e) { }
    };
    ws.onmessage = (e) => {
      try {
        if (ex === "HT") return;
        const d = JSON.parse(e.data);
        let p = 0;
        if ((ex === "BN" || ex === "AD") && d.p) p = +d.p;
        else if (ex === "BB" && d.data) p = +d.data[0].p;
        else if (ex === "OX" && d.data) p = +d.data[0].fillP;
        else if (ex === "BX" && d.data) {
          const ticks = Array.isArray(d.data) ? d.data : [d.data];
          p = +ticks[0].p;
        }
        else if (ex === "MX") {
          const tick = Array.isArray(d.data) ? d.data[0] : d.data;
          const lp = +(tick.p || tick.lastPrice || 0);
          if (lp > 0) {
            const c = coins.get(`${ex}:${sym}`);
            if (c) {
              // Priority: Deals always update. Tickers only if no deal for 250ms or price is same.
              const now = Date.now();
              if (d.channel === "push.deal") {
                c.p = lp; c.lastDeal = now; dirty.add(c.key);
              } else if (d.channel === "push.ticker") {
                if (!c.lastDeal || (now - c.lastDeal) > 250) {
                  c.p = lp; dirty.add(c.key);
                }
              }
            }
          }
          return; // skip general p > 0 block below
        }
        else if (ex === "HL" && d.channel === "trades") p = +d.data[0].p;
        else if (ex === "BG" && d.data) p = +d.data[0].lastPr;
        else if (ex === "GT" && d.channel === "futures.trades") p = +d.result[0].price;

        if (p > 0) {
          const c = coins.get(`${ex}:${sym}`);
          if (c) {
            c.p = p;
            dirty.add(c.key);
          }
        }
      } catch (_) { }
    };
    ws.onerror = () => { };
  } catch (err) {
    console.warn("Direct WS error:", err);
  }
}

const DEFAULT_TOOL_COLORS = {
  ray: "#facc15",
  line: "#facc15",
  "h-ray": "#a78bfa",
  rect: "#fb7185",
  ruler: "#facc15",
  fibgrid: "#8b5cf6",
};
const DRAW_COLOR_PALETTE = [
  "#ff4d7a",
  "#34d399",
  "#7c3aed",
  "#38bdf8",
  "#fb923c",
  "#facc15",
  "#ec4899",
  "#22c55e",
  "#818cf8",
  "#a855f7",
  "#f87171",
  "#06b6d4",
  "#84cc16",
  "#f59e0b",
  "#64748b",
];
const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const DEFAULT_FIB_VERTICALS = [];
const DEFAULT_FIB_LEVEL_ROWS = DEFAULT_FIB_LEVELS.map((value) => ({
  value,
  enabled: true,
  color: DEFAULT_TOOL_COLORS.fibgrid,
}));
let toolColors = (() => {
  try {
    return {
      ...DEFAULT_TOOL_COLORS,
      ...JSON.parse(localStorage.getItem("crypto_tool_colors") || "{}"),
    };
  } catch {
    return { ...DEFAULT_TOOL_COLORS };
  }
})();
let pendingToolClick = null;
const loadDrawings = () => {
  try {
    chartDrawings = JSON.parse(
      localStorage.getItem("crypto_drawings_" + activeSym) || "[]",
    )
      .map((d) => normalizeDrawing(d))
      .filter((d) => d.type !== "ruler"); // Never load persistent rulers
  } catch {
    chartDrawings = [];
  }
};
const saveDrawings = () => {
  localStorage.setItem(
    "crypto_drawings_" + activeSym,
    JSON.stringify(chartDrawings),
  );
};
const saveToolColors = () => {
  localStorage.setItem("crypto_tool_colors", JSON.stringify(toolColors));
};

// Y-axis: price-unit view range (null = auto-fit)
let viewMn = null,
  viewMx = null;
let autoFitY = true; // true = fit to visible candles each frame
let curPH = 600; // chart draw height, updated each frame
let chartState = { mx: 0, mn: 0, pr: 0, PW: 0, PH: 0, TOP: 0, viewStart: 0 };

let isDragX = false,
  dragStartX = 0,
  dragOffX = 0;
let isDragY = false,
  dragStartY = 0,
  dragMnOff = 0,
  dragMxOff = 0;
let mX = -1,
  mY = -1;
let needRebuild = false,
  lastSort = 0,
  lastRender = 0,
  sortedList = [];
let ws = null,
  wsReady = false;
let chartNeedsDraw = false; // set true when live candle updated
const MAX_DIRTY_ROWS_PER_TICK = 1000;
const KLINES_CACHE_TTL_MS = 15000;
const KLINES_CACHE = new Map();
let klFetchToken = 0;

// ═══ 240fps Engine via MessageChannel ════════════════════════════════════════
// MessageChannel posts fire faster than setTimeout(0) and are not throttled
// by the browser's 60fps rAF budget — giving us ~240fps logic ticks.
let INTERP_SPEED = 100.0; // catch-up speed per second (100.0 = Cinematic)
const DEFAULT_INTERP_SPEED = 30.0;
const INTERP_SMOOTH_FACTOR = 0.85; // exponential smoothing for ultra-smooth price movement
const SNAP_THRESHOLD = 0.01; // 1% difference triggers instant snap (cinematic mode)
const interpActive = new Map(); // key => { target, lastUpdate }
let lastRafTs = performance.now();
const INTERP_PERIOD = 0.07; // Snappier smoothing window (seconds)
let lastTickTs = 0;
let mcRunning = false;
let lastVltRankTs = 0;

// High-frequency tick channel (logic + DOM, not paint)
const _mc = new MessageChannel();
_mc.port2.onmessage = () => {
  const now = performance.now();
  const dt = Math.min((now - lastTickTs) / 1000, 0.05); // max 50ms step
  lastTickTs = now;

  // ── Interpolate all active coins ─────────────────────────────────────────
  if (interpActive.size > 0) {
    const keysToRemove = [];
    for (const [key, info] of interpActive) {
      const c = coins.get(key);
      if (!c) { keysToRemove.push(key); continue; }
      if (!c.displayP) { c.displayP = c.p; keysToRemove.push(key); continue; }

      // Update target if price changed
      if (c.p !== info.target) { info.target = c.p; info.lastUpdate = now; }

      // Exponential smoothing for ultra-smooth price movement
      const diff = c.p - c.displayP;
      const absDiff = Math.abs(diff);

      // SNAP logic: if difference is too large (>0.005%) OR it is the active coin, just jump instantly
      const pDiffPct = absDiff / c.p;
      const isActive = (c.ex === activeEx && c.sym === activeSym);
      if (pDiffPct > SNAP_THRESHOLD) {
        c.displayP = c.p;
        keysToRemove.push(key);
        dirty.add(key);
        continue;
      }

      if (absDiff < 1e-10) {
        c.displayP = c.p;
        keysToRemove.push(key);
      } else {
        // SKIP active coin in MessageChannel loop - it's handled in Ultra-Flow rAF for perfect sync
        if (isActive) continue;

        // Adaptive: faster for big jumps, smoother for small
        const adaptiveFactor = Math.min(1, INTERP_SPEED * dt * (1 + pDiffPct * 20));
        c.displayP += diff * adaptiveFactor;
        dirty.add(key);
      }
    }
    keysToRemove.forEach(k => interpActive.delete(k));
  }

  // ── DOM: update dirty rows ────────────────────────────────────────────────
  if (dirty.size > 0 || needRebuild) {
    const now2 = performance.now();
    // Only rebuild every 1000ms even if needRebuild is set (unless it's initial)
    if ((needRebuild || now2 - lastSort > 500) && (lastSort === 0 || now2 - lastSort > 500)) {
      rebuildList();
      lastSort = now2;
      needRebuild = false;
    } else {
      let processed = 0;
      for (const key of dirty) {
        updateRow(key);
        dirty.delete(key);
        processed++;
        if (processed >= MAX_DIRTY_ROWS_PER_TICK) break;
      }
    }
    if (needRebuild) dirty.clear();
    lastRender = now2;
  }

  // ── Chart: update last candle with interpolated price ────────────────────
  const activeKey = `${activeEx}:${activeSym}`;
  const ac = coins.get(activeKey);
  if (
    (chartNeedsDraw || interpActive.has(activeKey)) &&
    ac &&
    candles.length > 0
  ) {
    const last = candles[candles.length - 1];
    const dp = getDisplayP(ac);
    // Only apply displayP if it's close to the candle price (within 20%)
    // This prevents the giant candle bug when switching symbols
    const ratio = last.c > 0 ? dp / last.c : 0;
    if (dp > 0 && ratio > 0.8 && ratio < 1.2) {
      last.c = dp;
      if (dp > last.h) last.h = dp;
      if (dp < last.l) last.l = dp;

      // Fast DOM update for main chart close price
      const oc = document.getElementById("oc");
      if (oc) {
        const pStr = fP(dp);
        if (oc._lastPStr !== pStr) {
          oc.textContent = pStr;
          oc._lastPStr = pStr;
        }
      }
    }
    chartNeedsDraw = true; // signal rAF to repaint
  }

  if (chartNeedsDraw) {
    requestDraw();
  }

  // schedule next tick immediately
  if (mcRunning) _mc.port1.postMessage(0);
};

function startMcLoop() {
  if (mcRunning) return;
  mcRunning = true;
  lastTickTs = performance.now();
  _mc.port1.postMessage(0);
}

function scheduleInterp(key) {
  const c = coins.get(key);
  if (!c) return;
  interpActive.set(key, { target: c.p, lastUpdate: performance.now() });
}

// Use displayP for rendering, real p for logic
const getDisplayP = (c) => c.displayP || c.p;
const TF_MS = {
  "1m": 60000,
  "5m": 300000,
  "15m": 900000,
  "1h": 3600000,
  "4h": 14400000,
  "1d": 86400000,
  "3d": 259200000,
  "1w": 604800000,
};

// ═══ Utils ════════════════════════════════════════════════════════════════════
window.onerror = (m, s, l, c, e) => {
  console.error("Global error:", m, "at", s, ":", l);
  if (document.getElementById("lt")) {
    document.getElementById("lt").textContent = "Ошибка: " + m;
  }
};

const $ = (id) => document.getElementById(id);

const fP = (n) => {
  if (!n || isNaN(n)) return "–";
  if (n >= 1000) {
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Dynamic precision based on value to avoid huge jumps
  let p = 2;
  if (n < 0.00001) p = 9;
  else if (n < 0.001) p = 7;
  else if (n < 0.1) p = 6;
  else if (n < 1) p = 5;
  else if (n < 10) p = 4;
  else if (n < 100) p = 3;

  // Do NOT strip trailing zeros. Traders want uniform length on the axis grids.
  return n.toFixed(p);
};

const fV = (n) => {
  if (!n || isNaN(n)) return "–";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return n.toFixed(0);
};

const fC = (n) => {
  if (n == null || isNaN(n)) return "–";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
};

const fT = (v) => {
  if (!v || isNaN(v)) return "0";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return Math.round(v).toString();
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function getOiRawPct(c) {
  if (!c) return 0;
  if (Number.isFinite(c.oiPct)) return clamp(c.oiPct, 1, 100);

  // Оборачиваемость ОИ ("по-честному"): 
  // Чтобы не было такого, что 30% монет бьются в потолок 100%, мы сильно ужесточаем фильтр.
  // Теперь проверяется оборачиваемость ОИ за 1 час (c.v / 24) вместо 4 часов.
  // Чтобы выбить 100% метрики, монета должна проторговать ВЕСЬ свой открытый интерес в течение ОДНОГО часа!
  // Это оставит на 100% только единичные, самые мощно пампящиеся монеты.
  if (Number.isFinite(c.oi) && c.oi > 0 && c.v > 0) return clamp(((c.v / 24) / c.oi) * 100, 1, 100);

  return 0;
}

function getOiPct(c) {
  if (!c) return 0;

  if (c.oi && c.oi > 0) return getOiRawPct(c);

  // Универсальный прокси ОИ для бирж без нативных данных (Asterdex, Binance, BingX и т.д.)
  // Используем усреднение по топовым биржам, которые отдают ОИ по сокетам
  const bbCoin = coins.get("BB:" + c.base + "USDT");
  const mxCoin = coins.get("MX:" + c.base + "_USDT");
  const gtCoin = coins.get("GT:" + c.base + "_USDT");
  const bgCoin = coins.get("BG:" + c.base + "USDT");

  let sum = 0, count = 0;
  if (bbCoin && bbCoin.oi > 0) { sum += getOiRawPct(bbCoin); count++; }
  if (mxCoin && mxCoin.oi > 0) { sum += getOiRawPct(mxCoin); count++; }
  if (gtCoin && gtCoin.oi > 0) { sum += getOiRawPct(gtCoin); count++; }
  if (bgCoin && bgCoin.oi > 0) { sum += getOiRawPct(bgCoin); count++; }

  if (count > 0) return clamp(sum / count, 1, 100);

  return getOiRawPct(c);
}

function getOiTone(oiPct) {
  if (oiPct >= 22) return "high";
  if (oiPct <= 10) return "low";
  return "mid";
}

// ═══ Chart ════════════════════════════════════════════════════════════════════
const canvas = $("chart-canvas"),
  ctx = canvas.getContext("2d");
const volCv = $("vol-canvas"),
  vCtx = volCv.getContext("2d");

function resizeChart() {
  const w = $("cwrap");
  chartW = w.clientWidth;
  chartH = w.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = chartW * dpr;
  canvas.height = chartH * dpr;
  canvas.style.width = chartW + "px";
  canvas.style.height = chartH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  volCv.width = chartW * dpr;
  volCv.height = volH * dpr;
  volCv.style.width = chartW + "px";
  volCv.style.height = volH + "px";
  vCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (candles.length && chartW) requestDraw();
}

function fTime(ts) {
  const d = new Date(ts);
  if (activeTf === "1d" || activeTf === "3d" || activeTf === "1w")
    return d.toLocaleDateString("ru", { day: "2-digit", month: "2-digit" });
  const h = String(d.getHours()).padStart(2, "0"),
    m = String(d.getMinutes()).padStart(2, "0");
  return h + ":" + m;
}

// ─── Chart draw helpers ──────────────────────────────────────────────────────
function calcNiceStep(range, targetCount) {
  const rough = range / Math.max(targetCount, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3.5) step = 2;
  else if (norm < 7.5) step = 5;
  else step = 10;
  return step * mag;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function requestDraw() {
  chartNeedsDraw = true;
}

function drawChart() {
  if (!candles.length || !chartW || !chartH) return;

  // Layout
  const PR = 82;
  const PW = chartW - PR;
  const PH = chartH - volH - 1;
  const TOP = 0;
  if (PH <= 20) return;

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, chartW, chartH);
  ctx.fillStyle = getCanvasBgColor();
  ctx.fillRect(0, 0, chartW, chartH);
  vCtx.clearRect(0, 0, chartW, volH);

  // ── Visible candle window ──────────────────────────────────────────────────
  const n = Math.max(1, PW / candleW);
  const viewStart = candles.length - n - offsetX;
  const s = Math.max(0, Math.floor(viewStart));
  const e = Math.min(candles.length, s + Math.ceil(n) + 2);
  const vis = candles.slice(s, e);
  const futureGap = viewStart < 0 ? -viewStart : 0;
  if (!vis.length && futureGap <= 0.5) return;

  // ── Auto price range ───────────────────────────────────────────────────────
  let autoMn = Infinity,
    autoMx = -Infinity,
    mv = 0,
    min_v = Infinity;

  if (vis.length) {
    vis.forEach((c) => {
      if (c.l < autoMn) autoMn = c.l;
      if (c.h > autoMx) autoMx = c.h;
      if (c.v > mv) mv = c.v;
      if (c.v < min_v) min_v = c.v;
    });

    window._rawMv = mv; // Store true absolute max volume for later checks

  } else {
    const lc = candles[candles.length - 1];
    if (lc) {
      autoMn = lc.l * 0.98;
      autoMx = lc.h * 1.02;
    } else return;
  }
  const autoPad = (autoMx - autoMn) * 0.07 || autoMx * 0.005 || 0.01;
  autoMn = Math.max(0, autoMn - autoPad);
  autoMx += autoPad;
  if (autoFitY || viewMn == null) {
    viewMn = autoMn;
    viewMx = autoMx;
  }
  curPH = PH;

  const mn = viewMn,
    mx = viewMx,
    pr = mx - mn || 1;
  const toYMult = PH / pr;
  const toY = (p) => TOP + (mx - p) * toYMult;
  Object.assign(chartState, { mx, mn, pr, PW, PH, TOP, viewStart });

  // ── Grid lines ─────────────────────────────────────────────────────────────
  const gridStep = calcNiceStep(pr, Math.max(4, Math.floor(PH / 70)));
  let gridPrice = Math.ceil(mn / gridStep) * gridStep;
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,255,255,.045)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  while (gridPrice <= mx + gridStep * 0.01) {
    const y = toY(gridPrice);
    if (y >= TOP && y <= TOP + PH) {
      ctx.moveTo(0, y);
      ctx.lineTo(PW, y);
    }
    gridPrice += gridStep;
  }
  ctx.stroke();

  // ── Clipping Area (Pre-render) ─────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PW, chartH);
  ctx.clip();

  // ── Candles ────────────────────────────────────────────────────────────────
  const hw = Math.max(0.5, (candleW - 2) / 2);
  const cs = window.candleSettings || {
    body: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
    border: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
    wick: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 }
  };

  const upWickCol = hexToRgba(cs.wick.up, cs.wick.upOp);
  const dnWickCol = hexToRgba(cs.wick.down, cs.wick.downOp);
  const upBodyCol = hexToRgba(cs.body.up, cs.body.upOp);
  const dnBodyCol = hexToRgba(cs.body.down, cs.body.downOp);
  const upBorderCol = hexToRgba(cs.border.up, cs.border.upOp);
  const dnBorderCol = hexToRgba(cs.border.down, cs.border.downOp);

  vis.forEach((c, i) => {
    const x = Math.round((i + futureGap) * candleW + candleW / 2);
    const up = c.c >= c.o;

    const yH = toY(c.h),
      yL = toY(c.l);
    const yO = toY(c.o),
      yC = toY(c.c);
    const bT = Math.min(yO, yC),
      bH = Math.max(1, Math.abs(yC - yO));

    if (cs.wick.show) {
      ctx.strokeStyle = up ? upWickCol : dnWickCol;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.stroke();
    }

    if (cs.body.show) {
      ctx.fillStyle = up ? upBodyCol : dnBodyCol;
      ctx.fillRect(x - hw, bT, hw * 2, bH);
    }

    if (cs.border.show) {
      ctx.strokeStyle = up ? upBorderCol : dnBorderCol;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - hw, bT, hw * 2, bH);
    }
  });

  // ── Volume pane ────────────────────────────────────────────────────────────
  if (mv > 0) {
    vCtx.save();
    vCtx.beginPath();
    vCtx.rect(0, 0, PW, volH);
    vCtx.clip();

    // 1. Infallible Cumulative Detecor (The Golden Bullet)
    // Interval volume constantly spikes and then collapses. It routinely drops >50% from the previous candle.
    // 24H rolling volume is a massive sum. It almost NEVER drops by >50% in a single minute.
    let massiveDrops = 0;
    for (let i = 1; i < vis.length; i++) {
      if (vis[i - 1].v > 0 && vis[i].v < vis[i - 1].v * 0.5) {
        massiveDrops++;
      }
    }
    const isCumulativeBug = vis.length > 20 && (massiveDrops < vis.length * 0.05);

    // 2. Map volumes mathematically
    let renderVols = new Array(vis.length);
    let trueMv = 0;

    for (let i = 0; i < vis.length; i++) {
      if (isCumulativeBug) {
        let prevV = i > 0 ? vis[i - 1].v : (vis[i].v);
        // If API dropped to zero internally, ignore the chaotic negative/positive bounce
        if (vis[i].v === 0) {
          renderVols[i] = 0;
        } else if (prevV === 0 && vis[i].v > 0) {
          renderVols[i] = 0; // The recovery jump is fake
        } else {
          // True interval volume is roughly the positive delta of the rolling sum
          renderVols[i] = Math.max(0, vis[i].v - prevV);
        }
      } else {
        renderVols[i] = vis[i].v;
      }
      if (renderVols[i] > trueMv) {
        trueMv = renderVols[i];
      }
    }

    const volW = Math.max(1, candleW > 3 ? candleW - 1 : candleW);

    // 3. Draw
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      const x = Math.round((i + futureGap) * candleW + candleW / 2);
      const up = c.c >= c.o;

      const vRatio = trueMv > 0 ? (renderVols[i] / trueMv) : 0;
      const vh = Math.max(2, Math.min(1, vRatio) * (volH - 6));

      vCtx.fillStyle = up ? "rgba(38,201,122,.75)" : "rgba(255,69,96,.75)";
      vCtx.fillRect(x - Math.floor(volW / 2), volH - vh, volW, vh);
    }

    vCtx.restore();
  }

  // ── Right axis panel (thin divider line) ─────────────────
  // Note: Background is already filled once at the start of drawChart
  // ctx.fillStyle = getCanvasBgColor();
  // ctx.fillRect(PW, 0, PR, chartH);
  // vCtx.fillStyle = getCanvasBgColor();
  // vCtx.fillRect(PW, 0, PR, volH);

  // Thin 1px divider
  ctx.strokeStyle = "rgba(255,255,255,.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PW, 0);
  ctx.lineTo(PW, chartH);
  ctx.stroke();

  // ── Drawings ───────────────────────────────────────────────────────────────
  const getX = (t) => {
    // If it's a timestamp (large number), convert to index
    const idx = (t > 1000000000) ? getIdxFromTime(t) : t;
    return Math.round((idx - s + futureGap) * candleW + candleW / 2);
  };
  const getY = (p) => TOP + ((mx - p) / pr) * PH;

  function drawHandle(x, y, col, r = 4) {
    ctx.beginPath();
    ctx.fillStyle = getCanvasBgColor();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col;
    ctx.stroke();
  }

  function drawPriceTagOnScale(p, color, isHovered) {
    const y = getY(p);
    if (y < TOP || y > TOP + PH) return;
    const tH = 20,
      tW = PR - 8,
      tX = PW + 4,
      tY = y - tH / 2;
    ctx.save();
    roundRect(ctx, tX, tY, tW, tH, 4);
    ctx.fillStyle = "#1e1f2e";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = isHovered ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px Inter";
    ctx.textAlign = "center";
    ctx.fillText(fP(p), PW + PR / 2, y + 4);
    ctx.restore();
  }

  function drawPill(text, x, y, col) {
    ctx.font = "11px Inter";
    const padX = 8;
    const width = ctx.measureText(text).width + padX * 2;
    const height = 21;
    const bx = clamp(x - width / 2, 10, PW - width - 10);
    const by = clamp(y - height / 2, 8, PH - height - 8);
    roundRect(ctx, bx, by, width, height, 6);
    ctx.fillStyle = getCanvasBgColor();
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#eef2ff";
    ctx.textAlign = "center";
    ctx.fillText(text, bx + width / 2, by + 14);
  }

  function rgba(hex, alpha) {
    if (!hex || typeof hex !== "string" || !hex.startsWith("#")) {
      return `rgba(250,204,21,${alpha})`;
    }
    const raw = hex.slice(1);
    const full =
      raw.length === 3
        ? raw
          .split("")
          .map((ch) => ch + ch)
          .join("")
        : raw.padEnd(6, "0").slice(0, 6);
    const num = parseInt(full, 16);
    return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`;
  }

  // Helper: draw one complete drawing object
  function drawOne(d, isHovered, isTmp) {
    const x1 = getX(d.t1), y1 = getY(d.p1);
    const x2 = getX(d.t2), y2 = getY(d.p2);
    const palette = {
      line: "#facc15",
      ray: "#facc15",
      "h-ray": "#a78bfa",
      rect: "#fb7185",
      ruler: "#22d3ee",
      fibgrid: "#8b5cf6",
    };
    const baseCol = d.color || getToolColor(d.type) || palette[d.type] || "#facc15";
    const col = isHovered ? "#ffffff" : baseCol;
    ctx.lineWidth = isHovered ? 2.5 : 1.8;
    ctx.setLineDash([]);
    ctx.strokeStyle = col;

    if (d.type === "line") {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      drawHandle(x1, y1, col, 4);
      drawHandle(x2, y2, col, 4);
    } else if (d.type === "ray") {
      const dx = x2 - x1,
        dy = y2 - y1;
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag < 0.01) return;
      const big = Math.sqrt(chartW * chartW + chartH * chartH) * 3;
      const ex = x1 + (dx / mag) * big;
      const ey = y1 + (dy / mag) * big;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      drawHandle(x1, y1, col, 4);
      drawHandle(x2, y2, col, 3);
    } else if (d.type === "h-ray") {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(PW, y1);
      ctx.stroke();
      drawHandle(x1, y1, col, 4);
      drawPriceTagOnScale(d.p1, col, isHovered);
    } else if (d.type === "rect") {
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      ctx.fillStyle = isHovered ? rgba(baseCol, 0.18) : rgba(baseCol, 0.11);
      ctx.fillRect(left, top, width, height);
      ctx.strokeRect(left, top, width, height);
      drawHandle(x1, y1, col, 4);
      drawHandle(x2, y2, col, 4);
    } else if (d.type === "ruler") {
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
      drawHandle(x1, y1, col, 4);
      drawHandle(x2, y2, col, 4);

      const pct = ((d.p2 - d.p1) / d.p1) * 100;
      const sign = pct > 0 ? "+" : "";
      const label = sign + pct.toFixed(2) + "%";
      drawPill(label, (x1 + x2) / 2, (y1 + y2) / 2 - 20, col);
    } else if (d.type === "fibgrid") {
      const fibRows = getActiveFibLevelRows(d);
      const fibs = fibRows.map((row) => row.value);
      const fibX = d.verticals || DEFAULT_FIB_VERTICALS;
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      const top = Math.min(y1, y2);
      const bottom = Math.max(y1, y2);
      const width = right - left;
      const height = bottom - top;
      const grad = ctx.createLinearGradient(left, top, right, bottom);
      grad.addColorStop(0, rgba(baseCol, 0.16));
      grad.addColorStop(0.5, rgba(baseCol, 0.09));
      grad.addColorStop(1, rgba(baseCol, 0.04));
      ctx.fillStyle = grad;
      ctx.fillRect(left, top, width, height);
      fibRows.forEach((row, idx) => {
        const level = row.value;
        const y = y1 + (y2 - y1) * level;
        if (idx < fibs.length - 1) {
          const yNext = y1 + (y2 - y1) * fibs[idx + 1];
          ctx.fillStyle =
            idx % 2 === 0
              ? "rgba(255,255,255,0.035)"
              : rgba(baseCol, 0.09);
          ctx.fillRect(left, Math.min(y, yNext), width, Math.abs(yNext - y));
        }
        const levelColor =
          d.useSingleColor !== false ? baseCol : row.color || baseCol;
        ctx.strokeStyle =
          level === 0.5 ? "rgba(255,255,255,0.55)" : rgba(levelColor, 0.92);
        ctx.lineWidth = level === 0.5 ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillStyle = d.useSingleColor !== false ? "#f5f3ff" : levelColor;
        ctx.font = "10px Inter";
        ctx.textAlign = "left";
        ctx.fillText(level.toFixed(3), left + 6, y - 4);
      });
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.8;
      ctx.strokeRect(left, top, width, height);
      drawHandle(x1, y1, col, 4);
      drawHandle(x2, y2, col, 4);
    }

    if (isTmp && magnetSnap) {
      const sx = magnetSnap.px, sy = magnetSnap.py;
      ctx.strokeStyle = "rgba(0,186,255,0.95)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,186,255,0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sx - 10, sy);
      ctx.lineTo(sx + 10, sy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx, sy - 10);
      ctx.lineTo(sx, sy + 10);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Draw saved drawings
  chartDrawings.forEach((d, idx) => {
    const isHovered = (dragDrawing?.idx === idx || hoverDrawingIdx === idx);
    drawOne(d, isHovered, false);
  });

  // Draw temp (in-progress) drawing
  if (tempDrawing) {
    ctx.globalAlpha = 0.75;
    drawOne(tempDrawing, false, true);
    ctx.globalAlpha = 1;
  }

  if (quickMeasure) {
    ctx.globalAlpha = 0.9;
    drawOne(quickMeasure, false, false);
    ctx.globalAlpha = 1;
  }

  // Restore clipping for candles and drawings area before rendering Price Axis labels
  ctx.restore();

  // ── Price Axis (Right) ───────────────────────────────────────────────────────
  gridPrice = Math.ceil(mn / gridStep) * gridStep;
  ctx.font = "10px Inter";
  ctx.textAlign = "left";
  const axisColor = getAxisTextColor();
  while (gridPrice <= mx + gridStep * 0.01) {
    const y = toY(gridPrice);
    if (y >= TOP + 10 && y <= TOP + PH - 10) {
      ctx.fillStyle = axisColor;
      ctx.fillText(fP(gridPrice), PW + 6, y + 4);
    }
    gridPrice += gridStep;
  }

  const lc = candles[candles.length - 1];
  if (lc) {
    // Use interpolated display price for active symbol so pill moves smoothly
    const acTicker = coins.get(`${activeEx}:${activeSym}`);
    const liveClose = acTicker ? getDisplayP(acTicker) : lc.c;
    const dispClose = liveClose > 0 ? liveClose : lc.c;
    const ly = toY(dispClose);
    const up = dispClose >= lc.o;
    const ly2 = clamp(ly, TOP + 10, TOP + PH - 10);
    ctx.strokeStyle = "rgba(255,255,255,.15)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ly2);
    ctx.lineTo(PW, ly2);
    ctx.stroke();
    ctx.setLineDash([]);
    const tH = 22,
      tW = PR - 8,
      tX = PW + 4,
      tY = ly2 - tH / 2;
    roundRect(ctx, tX, tY, tW, tH, 6);
    ctx.fillStyle = getCanvasBgColor();
    ctx.fill();
    ctx.strokeStyle = up ? "#26c97a" : "#ff4560";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px Inter";
    ctx.textAlign = "center";
    ctx.fillText(fP(dispClose), PW + PR / 2, ly2 + 4);

    // Candle close countdown (Wall-clock based for stability)
    const tfMs = TF_MS[activeTf] || 60000;
    const now = Date.now();
    const nextClose = (Math.floor(now / tfMs) + 1) * tfMs;
    const diff = nextClose - now;
    if (diff > 0) {
      const s = Math.floor(diff / 1000) % 60;
      const m = Math.floor(diff / 60000) % 60;
      const h = Math.floor(diff / 3600000);
      let timeStr =
        String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
      if (h > 0) timeStr = h + ":" + timeStr;

      const cH = 13,
        cW = tW - 32,
        cX = tX + (tW - cW) / 2,
        cY = ly2 + 18;
      roundRect(ctx, cX, cY, cW, cH, 3);
      ctx.fillStyle = getCanvasBgColor();
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
      ctx.stroke();

      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.font = "bold 9px Inter";
      ctx.fillText(timeStr, PW + PR / 2, cY + 10);
    }
  }

  // ── Crosshair ──────────────────────────────────────────────────────────────
  if (mX >= 0 && mX < PW && mY >= TOP && mY <= TOP + PH) {
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(mX, TOP);
    ctx.lineTo(mX, TOP + PH);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, mY);
    ctx.lineTo(PW, mY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Hover price pill
    const hoverPrice = mx - ((mY - TOP) / PH) * pr;
    const hH = 20,
      hW = PR - 8,
      hX = PW + 4,
      hY = mY - hH / 2;
    roundRect(ctx, hX, hY, hW, hH, 4);
    ctx.fillStyle = "#1e1f2e";
    ctx.fill();
    ctx.strokeStyle = "rgba(124,58,237,.4)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = axisColor;
    ctx.font = "bold 10px Inter";
    ctx.textAlign = "center";
    ctx.fillText(fP(hoverPrice), PW + PR / 2, mY + 4);

    // compute average volume across loaded timeframe candles
    const visIdx = Math.round(mX / candleW - futureGap);
    const ci = clamp(visIdx, 0, vis.length - 1);
    if (vis[ci]) {
      const c = vis[ci];
      let tv = 0;
      for (const cv of candles) tv += cv.v;
      const avgV = candles.length > 0 ? tv / candles.length : 1;
      const mult = (c.v / avgV).toFixed(1);

      // Draw fixed volume box at top-left
      ctx.font = "11px Inter";
      const ttW = 136,
        ttH = 64;
      let ttX = 12,
        ttY = 12; // Static top-left position

      roundRect(ctx, ttX, ttY, ttW, ttH, 6);
      ctx.fillStyle = "rgba(13, 15, 20, 0.85)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.stroke();

      // Date/Time line
      const dt = new Date(c.t);
      const dateStr =
        String(dt.getDate()).padStart(2, "0") +
        "." +
        String(dt.getMonth() + 1).padStart(2, "0") +
        " " +
        String(dt.getHours()).padStart(2, "0") +
        ":" +
        String(dt.getMinutes()).padStart(2, "0");
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "center";
      ctx.fillText(dateStr, ttX + ttW / 2, ttY + 16);

      // Line divider
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(ttX + 10, ttY + 22);
      ctx.lineTo(ttX + ttW - 10, ttY + 22);
      ctx.stroke();

      ctx.fillStyle = "#6b7080";
      ctx.textAlign = "left";
      ctx.fillText("Объём:", ttX + 8, ttY + 38);
      ctx.fillText("Средний:", ttX + 8, ttY + 55);

      ctx.fillStyle = "#d1d4dc";
      ctx.textAlign = "right";
      ctx.fillText(fV(c.v), ttX + ttW - 8, ttY + 38);

      const mc = mult >= 2 ? "#26c97a" : mult >= 1 ? "#d1d4dc" : "#ff4560";
      ctx.fillStyle = mc;
      ctx.font = "bold 11px Inter";
      ctx.fillText(fV(avgV) + " (" + mult + "x)", ttX + ttW - 8, ttY + 55);
    }
  }
}

// ─── Chart interaction ────────────────────────────────────────────────────────
const PR_WIDTH = 82;
let isDragYScale = false,
  yScaleStartY = 0,
  yScaleStartMn = 0,
  yScaleStartMx = 0;

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ─── Drawing system (TradingView-style) ──────────────────────────────────────

// Convert pixel coords → chart time (timestamp) + price
function pxToTP(px, py) {
  const tIdx = px / candleW + chartState.viewStart;
  const t = getTimeFromIdx(tIdx);
  const p = chartState.mx - ((py - chartState.TOP) * chartState.pr) / chartState.PH;
  return { t, p };
}

function getTimeFromIdx(idx) {
  if (!candles.length) return Date.now();
  const i = Math.floor(idx);
  const frac = idx - i;
  if (i < 0) {
    const first = candles[0].t;
    const tf = TF_MS[activeTf] || 60000;
    return first + idx * tf;
  }
  if (i >= candles.length - 1) {
    const last = candles[candles.length - 1].t;
    const tf = TF_MS[activeTf] || 60000;
    return last + (idx - (candles.length - 1)) * tf;
  }
  return candles[i].t + (candles[i + 1].t - candles[i].t) * frac;
}

function getIdxFromTime(t) {
  if (!candles.length) return 0;
  if (t <= candles[0].t) {
    const tf = TF_MS[activeTf] || 60000;
    return (t - candles[0].t) / tf;
  }
  if (t >= candles[candles.length - 1].t) {
    const tf = TF_MS[activeTf] || 60000;
    return (candles.length - 1) + (t - candles[candles.length - 1].t) / tf;
  }
  // Binary search for the correct candle gap
  let low = 0, high = candles.length - 2;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (t >= candles[mid].t && t <= candles[mid + 1].t) {
      return mid + (t - candles[mid].t) / (candles[mid + 1].t - candles[mid].t);
    }
    if (t < candles[mid].t) high = mid - 1;
    else low = mid + 1;
  }
  return 0;
}

// Magnet: find nearest candle OHLC within snapRadius px, update magnetSnap
function updateMagnetSnap(px, py) {
  magnetSnap = null;
  if (!magnetMode || !candles.length || !chartState.PW) return;

  const snapRadius = 40;
  let bestD2 = snapRadius * snapRadius;

  const viewStart = chartState.viewStart;
  const PW = chartW - PR_WIDTH;
  const n = Math.max(1, PW / candleW);

  const s = Math.max(0, Math.floor(viewStart));
  const e2 = Math.min(candles.length, s + Math.ceil(n) + 2);
  const futureGap = viewStart < 0 ? -viewStart : 0;

  for (let i = s; i < e2; i++) {
    const c = candles[i];
    if (!c) continue;

    const cx = Math.round((i - s + futureGap) * candleW + candleW / 2);

    const points = [
      { p: c.h, weight: 0.8 },
      { p: c.l, weight: 0.8 },
      { p: c.o, weight: 1.0 },
      { p: c.c, weight: 1.0 }
    ];

    for (const pt of points) {
      const cy = chartState.TOP + ((chartState.mx - pt.p) / chartState.pr) * chartState.PH;
      const dx = px - cx;
      const dy = py - cy;
      const d2 = (dx * dx + dy * dy) * pt.weight;

      if (d2 < bestD2) {
        bestD2 = d2;
        magnetSnap = { t: c.t, p: pt.p, px: cx, py: cy };
      }
    }
  }
}

// Get effective cursor t,p (with magnet applied)
function getCursorTP(px, py) {
  if (magnetSnap) return { t: magnetSnap.t, p: magnetSnap.p };
  return pxToTP(px, py);
}

function getToolColor(tool) {
  return toolColors[tool] || DEFAULT_TOOL_COLORS[tool] || "#facc15";
}

function sanitizeLevelList(list, fallback) {
  const clean = (Array.isArray(list) ? list : [])
    .map((v) => +v)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  return clean.length ? [...new Set(clean)] : [...fallback];
}

function normalizeFibLevelRows(rows, fallback = DEFAULT_FIB_LEVEL_ROWS, baseColor = DEFAULT_TOOL_COLORS.fibgrid) {
  const source = Array.isArray(rows) && rows.length ? rows : fallback;
  const out = source
    .map((row) => {
      if (typeof row === "number") {
        return { value: row, enabled: true, color: baseColor };
      }
      const value = typeof row?.value === "number" ? row.value : +row?.value;
      if (!Number.isFinite(value)) return null;
      return {
        value,
        enabled: row?.enabled !== false,
        color: row?.color || baseColor,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value);

  if (!out.length) {
    return fallback.map((row) => ({ ...row, color: row.color || baseColor }));
  }

  const seen = new Set();
  return out.filter((row) => {
    const key = row.value.toFixed(6);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getActiveFibLevelRows(d) {
  return normalizeFibLevelRows(
    d.levelRows || d.levels,
    DEFAULT_FIB_LEVEL_ROWS,
    d.color || getToolColor("fibgrid"),
  ).filter((row) => row.enabled !== false);
}

function normalizeDrawing(d) {
  if (!d) return d;
  if (!d.color && d.type) d.color = getToolColor(d.type);
  if (d.type === "h-ray") {
    d.p2 = d.p1;
    if (!(d.t2 > d.t1)) d.t2 = d.t1 + 0.25;
  }
  if (d.type === "fibgrid") {
    d.levelRows = normalizeFibLevelRows(
      d.levelRows || d.levels,
      DEFAULT_FIB_LEVEL_ROWS,
      d.color || getToolColor("fibgrid"),
    );
    d.levels = d.levelRows.map((row) => row.value);
    d.verticals = sanitizeLevelList(d.verticals, DEFAULT_FIB_VERTICALS);
    d.useSingleColor = d.useSingleColor !== false;
  }
  return d;
}

function isDrawingValid(d) {
  const dt = Math.abs(d.t2 - d.t1);
  const dp = Math.abs(d.p2 - d.p1);
  if (d.type === "rect" || d.type === "fibgrid") return dt > 0.2 && dp > 0;
  if (d.type === "ruler") return dp > 0;
  if (d.type === "h-ray") return dt > 0.2;
  return dt > 0.2 || dp > 0;
}

function getDrawingPoints(d) {
  const t1Idx = (d.t1 > 1000000000) ? getIdxFromTime(d.t1) : d.t1;
  const t2Idx = (d.t2 > 1000000000) ? getIdxFromTime(d.t2) : d.t2;

  const x1 = (t1Idx - chartState.viewStart) * candleW + candleW / 2;
  const y1 = chartState.TOP + ((chartState.mx - d.p1) / chartState.pr) * chartState.PH;
  const x2 = (t2Idx - chartState.viewStart) * candleW + candleW / 2;
  const y2Raw = chartState.TOP + ((chartState.mx - d.p2) / chartState.pr) * chartState.PH;

  return { x1, y1, x2, y2: d.type === "h-ray" ? y1 : y2Raw };
}

function pointLineDistance(px, py, x1, y1, x2, y2, clampSeg = true) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  if (clampSeg) t = Math.max(0, Math.min(1, t));
  return Math.hypot(x1 + t * dx - px, y1 + t * dy - py);
}

// Hit-test: is (px,py) within R px of a drawing handle?
// Returns 'p1', 'p2', or null
function hitHandle(d, px, py) {
  const { x1, y1, x2, y2 } = getDrawingPoints(d);
  if (Math.hypot(px - x1, py - y1) <= 9) return 'p1';
  if (d.type !== 'h-ray' && Math.hypot(px - x2, py - y2) <= 9) return 'p2';
  return null;
}

// Hit-test: is (px,py) near the line/ray body?
function hitBody(d, px, py) {
  const { x1, y1, x2, y2 } = getDrawingPoints(d);
  if (d.type === "line" || d.type === "ruler") {
    return pointLineDistance(px, py, x1, y1, x2, y2, true) < 7;
  }
  if (d.type === "ray") {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1) return false;
    const t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    if (t < 0) return false;
    return pointLineDistance(px, py, x1, y1, x1 + dx * Math.max(1, t), y1 + dy * Math.max(1, t), false) < 7;
  }
  if (d.type === "h-ray") {
    if (px < x1 - 6) return false;
    return Math.abs(py - y1) < 7;
  }
  if (d.type === "rect" || d.type === "fibgrid") {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    const inside = px >= left && px <= right && py >= top && py <= bottom;
    if (inside) return true;
    const nearLeft = Math.abs(px - left) < 7 && py >= top - 7 && py <= bottom + 7;
    const nearRight = Math.abs(px - right) < 7 && py >= top - 7 && py <= bottom + 7;
    const nearTop = Math.abs(py - top) < 7 && px >= left - 7 && px <= right + 7;
    const nearBottom = Math.abs(py - bottom) < 7 && px >= left - 7 && px <= right + 7;
    return nearLeft || nearRight || nearTop || nearBottom;
  }
  return false;
}

function findDrawingIndexAt(px, py) {
  for (let i = chartDrawings.length - 1; i >= 0; i--) {
    if (hitHandle(chartDrawings[i], px, py) || hitBody(chartDrawings[i], px, py)) {
      return i;
    }
  }
  return -1;
}

let drawColorSelectHandler = null;

function openDrawColorMenu({
  title = "Цвет линии",
  currentColor = "#facc15",
  pageX = window.innerWidth / 2,
  pageY = window.innerHeight / 2,
  preserveFibMenu = false,
  onSelect,
}) {
  const menu = $("draw-color-menu");
  const grid = $("draw-color-grid");
  const titleEl = $("draw-color-title");
  titleEl.textContent = title;
  grid.innerHTML = "";
  drawColorSelectHandler = onSelect || null;
  DRAW_COLOR_PALETTE.forEach((clr) => {
    const b = document.createElement("div");
    b.className = "tag-btn" + (currentColor === clr ? " on" : "");
    b.style.background = clr;
    b.onclick = (e) => {
      e.stopPropagation();
      if (drawColorSelectHandler) drawColorSelectHandler(clr);
      closeMenus();
    };
    grid.appendChild(b);
  });
  tagMenu.style.display = "none";
  filterMenu.style.display = "none";
  menu.style.display = "none";
  if (!preserveFibMenu) {
    if (fibSettingsMenu) fibSettingsMenu.style.display = "none";
    editingFibDrawing = null;
  }
  menu.style.left = Math.min(pageX, window.innerWidth - 160) + "px";
  menu.style.top = Math.min(pageY, window.innerHeight - 140) + "px";
  menu.style.display = "block";
}

function pickToolColor(tool) {
  if (!tool || tool === "none") return;
  const btn = document.querySelector(`.dt-btn[data-tool="${tool}"]`);
  const rect = btn ? btn.getBoundingClientRect() : null;
  openDrawColorMenu({
    title: "Цвет линии",
    currentColor: getToolColor(tool),
    pageX: rect ? rect.right + 10 : window.innerWidth / 2 - 70,
    pageY: rect ? rect.top : window.innerHeight / 2 - 60,
    onSelect: (clr) => {
      toolColors[tool] = clr;
      saveToolColors();
      applyToolButtonColors();
      requestAnimationFrame(drawChart);
    },
  });
}

function renderFibLevelEditor() {
  const list = $("fib-level-list");
  const singleColor = $("fib-use-single-color");
  const masterColor = $("fib-master-color");
  if (!editingFibDrawing || !list) return;
  list.innerHTML = "";
  const rows = editingFibDrawing.levelRows || [];
  rows.forEach((row, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "fib-level-row" + (row.enabled === false ? " disabled" : "");

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "fib-level-toggle";
    toggle.checked = row.enabled !== false;
    toggle.onchange = () => {
      row.enabled = toggle.checked;
      wrap.classList.toggle("disabled", !toggle.checked);
      requestAnimationFrame(drawChart);
    };

    const input = document.createElement("input");
    input.type = "text";
    input.className = "fib-level-value";
    input.value = String(row.value);
    input.oninput = () => {
      const value = +String(input.value).replace(",", ".");
      if (!Number.isFinite(value)) return;
      row.value = value;
      requestAnimationFrame(drawChart);
    };

    const colorBtn = document.createElement("button");
    colorBtn.type = "button";
    colorBtn.className = "fib-level-color";
    colorBtn.style.background = row.color || editingFibDrawing.color;
    colorBtn.disabled = editingFibDrawing.useSingleColor !== false;
    colorBtn.onclick = (e) => {
      e.stopPropagation();
      const rect = colorBtn.getBoundingClientRect();
      openDrawColorMenu({
        title: "Цвет уровня",
        currentColor: row.color || editingFibDrawing.color,
        pageX: rect.right + 8,
        pageY: rect.top,
        preserveFibMenu: true,
        onSelect: (clr) => {
          row.color = clr;
          colorBtn.style.background = clr;
          requestAnimationFrame(drawChart);
        },
      });
    };

    wrap.append(toggle, input, colorBtn);
    list.appendChild(wrap);
  });
  singleColor.checked = editingFibDrawing.useSingleColor !== false;
  masterColor.style.background = editingFibDrawing.color || getToolColor("fibgrid");
  list.querySelectorAll(".fib-level-color").forEach((btn) => {
    btn.style.opacity = editingFibDrawing.useSingleColor !== false ? "0.45" : "1";
    btn.style.pointerEvents = editingFibDrawing.useSingleColor !== false ? "none" : "auto";
  });
}

function configureFibDrawing(d, pageX = window.innerWidth / 2, pageY = window.innerHeight / 2) {
  if (!d || d.type !== "fibgrid") return;
  closeMenus();
  editingFibDrawing = d;
  editingFibDrawing.levelRows = normalizeFibLevelRows(
    editingFibDrawing.levelRows || editingFibDrawing.levels,
    DEFAULT_FIB_LEVEL_ROWS,
    editingFibDrawing.color || getToolColor("fibgrid"),
  );
  const menu = $("fib-settings-menu");
  renderFibLevelEditor();
  menu.style.left = Math.min(pageX, window.innerWidth - 470) + "px";
  menu.style.top = Math.min(pageY, window.innerHeight - 560) + "px";
  menu.style.display = "block";
}

function applyToolButtonColors() {
  document.querySelectorAll(".dt-btn[data-tool]").forEach((btn) => {
    const tool = btn.dataset.tool;
    if (tool === "none") btn.style.removeProperty("--tool-accent");
    else btn.style.setProperty("--tool-accent", getToolColor(tool));
  });
}

// Cancel any in-progress drawing
function cancelDrawing() {
  tempDrawing = null;
  drawingPhase = 0;
  requestAnimationFrame(drawChart);
}

// ── Mouse events ─────────────────────────────────────────────────────────────

canvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const PW = chartW - PR_WIDTH;

  // Price axis drag
  if (px >= PW) {
    if (viewMn != null && viewMx != null) {
      isDragYScale = true;
      yScaleStartY = e.clientY;
      yScaleStartMn = viewMn;
      yScaleStartMx = viewMx;
      autoFitY = false;
    }
    return;
  }

  if (e.shiftKey && e.button === 0) {
    updateMagnetSnap(px, py);
    const { t, p } = getCursorTP(px, py);
    quickMeasure = normalizeDrawing({
      type: "ruler",
      t1: t,
      p1: p,
      t2: t,
      p2: p,
      color: getToolColor("ruler"),
    });
    requestDraw();
    return;
  }

  // ── Drawing mode ────────────────────────────────────────────────────────────
  if (activeTool !== 'none' && e.button === 0) {
    updateMagnetSnap(px, py);
    const { t, p } = getCursorTP(px, py);

    if (activeTool === 'ruler') {
      quickMeasure = normalizeDrawing({
        type: "ruler",
        t1: t, p1: p, t2: t, p2: p,
        color: getToolColor("ruler"),
      });
      requestDraw();
      return;
    }

    if (drawingPhase === 0) {
      // First click — place start point, enter phase 1
      tempDrawing = normalizeDrawing({
        type: activeTool,
        t1: t,
        p1: p,
        t2: t,
        p2: p,
      });
      if (activeTool === 'h-ray') {
        // Horizontal ray only needs one click
        if (isDrawingValid(tempDrawing)) {
          chartDrawings.push({ ...tempDrawing });
          saveDrawings();
        }
        tempDrawing = null;
        drawingPhase = 0;
        setTool("none");
      } else {
        drawingPhase = 1;
      }
    } else {
      // Second click — finish drawing
      tempDrawing.t2 = t;
      tempDrawing.p2 = p;
      normalizeDrawing(tempDrawing);
      if (isDrawingValid(tempDrawing)) {
        chartDrawings.push({ ...tempDrawing });
        saveDrawings();
      }
      tempDrawing = null;
      drawingPhase = 0;
      setTool("none");
    }
    requestAnimationFrame(drawChart);
    return;
  }

  // Right-click: cancel drawing in progress OR delete hovered drawing
  if (e.button === 2) {
    if (drawingPhase > 0) {
      cancelDrawing();
      return;
    }
    for (let i = chartDrawings.length - 1; i >= 0; i--) {
      if (hitHandle(chartDrawings[i], px, py) || hitBody(chartDrawings[i], px, py)) {
        chartDrawings.splice(i, 1);
        saveDrawings();
        requestAnimationFrame(drawChart);
        return;
      }
    }
    if (viewMn != null && viewMx != null) {
      isDragY = true; dragStartY = e.clientY; autoFitY = false;
      dragMnOff = viewMn; dragMxOff = viewMx;
    }
    return;
  }

  if (e.button === 0) {
    // Check handle drag on existing drawings
    for (let i = chartDrawings.length - 1; i >= 0; i--) {
      const d = chartDrawings[i];
      const handle = hitHandle(d, px, py);
      if (handle) {
        dragDrawing = { idx: i, handle };
        return;
      }
      if (hitBody(d, px, py)) {
        dragDrawing = {
          idx: i, handle: 'move',
          startT1: d.t1, startP1: d.p1,
          startT2: d.t2, startP2: d.p2,
          startPX: px, startPY: py
        };
        return;
      }
    }
    // Pan
    isDragX = true; dragStartX = e.clientX; dragOffX = offsetX;
    if (viewMn != null && viewMx != null) {
      isDragY = true; dragStartY = e.clientY; autoFitY = false;
      dragMnOff = viewMn; dragMxOff = viewMx;
    }
  }
});

canvas.addEventListener("mousemove", (e) => {
  const r = canvas.getBoundingClientRect();
  mX = e.clientX - r.left;
  mY = e.clientY - r.top;
  const PW2 = chartW - PR_WIDTH;

  // Update magnet snap every move
  if (magnetMode && (activeTool !== 'none' || dragDrawing || quickMeasure)) {
    updateMagnetSnap(mX, mY);
  } else {
    magnetSnap = null;
  }

  // Cursor style
  if (mX >= PW2) {
    canvas.style.cursor = 'ns-resize';
  } else if (dragDrawing) {
    canvas.style.cursor = 'grabbing';
  } else if (activeTool !== 'none') {
    canvas.style.cursor = 'crosshair';
  } else if (isDragX || isDragY) {
    canvas.style.cursor = 'grabbing';
  } else {
    hoverDrawingIdx = -1;
    for (let i = chartDrawings.length - 1; i >= 0; i--) {
      if (hitHandle(chartDrawings[i], mX, mY) || hitBody(chartDrawings[i], mX, mY)) {
        hoverDrawingIdx = i;
        break;
      }
    }
    canvas.style.cursor = hoverDrawingIdx >= 0 ? 'pointer' : 'crosshair';
  }

  // Y-axis scale drag
  if (isDragYScale && curPH > 0) {
    const dy = e.clientY - yScaleStartY;
    const center = (yScaleStartMn + yScaleStartMx) / 2;
    let half = (yScaleStartMx - yScaleStartMn) / 2 * Math.pow(1.005, dy);
    half = clamp(half, Math.max(Math.abs(center) * 0.0001, 1e-8), Math.max(Math.abs(center) * 50, 1));
    viewMn = center - half; viewMx = center + half;
  }

  if (isDragX) {
    offsetX = getClampedOffsetX(dragOffX + (e.clientX - dragStartX) / candleW);
  }

  if (isDragY && curPH > 0 && dragMxOff - dragMnOff > 0) {
    const shift = (e.clientY - dragStartY) * (dragMxOff - dragMnOff) / curPH;
    viewMn = dragMnOff + shift; viewMx = dragMxOff + shift;
  }

  // Update temp drawing second point (phase 1)
  if (tempDrawing && drawingPhase === 1) {
    const { t, p } = getCursorTP(mX, mY);
    tempDrawing.t2 = t;
    tempDrawing.p2 = p;
    normalizeDrawing(tempDrawing);
  }

  if (quickMeasure) {
    const { t, p } = getCursorTP(mX, mY);
    quickMeasure.t2 = quickMeasure.t1; // Lock X to start position
    quickMeasure.p2 = p;
    normalizeDrawing(quickMeasure);
  }

  // Drag existing drawing handle or body
  if (dragDrawing) {
    const d = chartDrawings[dragDrawing.idx];
    const { t, p } = getCursorTP(mX, mY);
    if (dragDrawing.handle === 'p1') {
      d.t1 = t; d.p1 = p;
    } else if (dragDrawing.handle === 'p2') {
      d.t2 = t; d.p2 = p;
    } else if (dragDrawing.handle === 'move') {
      const { t: currT, p: currP } = getCursorTP(mX, mY);
      const { t: startT, p: startP } = getCursorTP(dragDrawing.startPX, dragDrawing.startPY);

      const dt = currT - startT;
      const dp = currP - startP;

      d.t1 = dragDrawing.startT1 + dt;
      d.t2 = dragDrawing.startT2 + dt;
      d.p1 = dragDrawing.startP1 + dp;
      d.p2 = dragDrawing.startP2 + dp;
    }
    normalizeDrawing(d);
  }

  requestDraw();
});

canvas.addEventListener("mouseup", () => {
  if (dragDrawing) { saveDrawings(); dragDrawing = null; }
  if (activeTool === 'ruler') setTool('none');
  quickMeasure = null;
  isDragX = false; isDragY = false; isDragYScale = false;
  requestDraw();
});

canvas.addEventListener("mouseleave", () => {
  mX = -1; mY = -1;
  isDragX = false; isDragY = false; isDragYScale = false;
  dragDrawing = null;
  magnetSnap = null;
  quickMeasure = null;
  canvas.style.cursor = 'crosshair';
  requestDraw();
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    if (drawingPhase > 0) { cancelDrawing(); }
    else { setTool('none'); }
  }
  if (e.key === 'h' || e.key === 'H') setTool('h-ray');
  if (e.key === 'l' || e.key === 'L') setTool('line');
  if (e.key === 'x' || e.key === 'X') setTool('rect');
  if (e.key === 'u' || e.key === 'U') setTool('ruler');
  if (e.key === 'f' || e.key === 'F') setTool('fibgrid');
  if (e.key === 'm' || e.key === 'M') toggleMagnet();
  if ((e.key === 'Delete' || e.key === 'Backspace') && drawingPhase === 0) {
    if (hoverDrawingIdx >= 0) {
      chartDrawings.splice(hoverDrawingIdx, 1);
      hoverDrawingIdx = -1;
    } else if (chartDrawings.length) {
      chartDrawings.pop();
    }
    saveDrawings();
    requestAnimationFrame(drawChart);
  }
});

function setTool(tool) {
  if (tool === activeTool && tool !== "none") tool = "none";
  activeTool = tool;
  cancelDrawing();
  document.querySelectorAll('.dt-btn[data-tool]').forEach(b => {
    b.classList.toggle('on', b.dataset.tool === tool);
  });
}

function toggleMagnet() {
  magnetMode = !magnetMode;
  magnetSnap = null;
  const btn = $('magnet-btn');
  if (btn) btn.classList.toggle('magnet-on', magnetMode);
}

// Scroll: vertical = X-zoom; horizontal = X-pan; Ctrl = Y-zoom
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const PW = chartW - PR_WIDTH;

    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Trackpad horizontal swipe = PAN left/right
      offsetX = getClampedOffsetX(offsetX + e.deltaX / candleW);
    } else if (e.ctrlKey || e.altKey) {
      // Ctrl/Alt + scroll = Y zoom around mouse position
      autoFitY = false;
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      const center = (viewMn + viewMx) / 2;
      let half = ((viewMx - viewMn) / 2) * factor;
      // Clamp: prevent zoom-in so far that range becomes ~0 (disappearing bug)
      const minHalf = Math.max(Math.abs(center) * 0.0001, 1e-8);
      // Clamp: prevent zoom-out so extreme that scale is meaningless
      const maxHalf = Math.max(Math.abs(center) * 50, 1);
      half = clamp(half, minHalf, maxHalf);
      viewMn = center - half;
      viewMx = center + half;
    } else {
      // Vertical scroll = X-zoom anchored at mouse (fully free-floating)
      const r = canvas.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const nBefore = PW / candleW;
      const vStartBefore = candles.length - nBefore - offsetX;
      const pivot = vStartBefore + mouseX / candleW;

      const factor = e.deltaY > 0 ? 0.88 : 1.14;
      candleW = clamp(candleW * factor, 2, 60);

      const nAfter = PW / candleW;
      const vStartAfter = pivot - mouseX / candleW;
      offsetX = getClampedOffsetX(candles.length - nAfter - vStartAfter);
    }
    requestDraw();
  },
  { passive: false },
);

// Double-click: reset Y to auto-fit
canvas.addEventListener("dblclick", (e) => {
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const idx = findDrawingIndexAt(px, py);
  if (idx >= 0 && chartDrawings[idx]?.type === "fibgrid") {
    configureFibDrawing(chartDrawings[idx], e.pageX, e.pageY);
    return;
  }
  autoFitY = true;
  viewMn = null;
  viewMx = null;
  requestDraw();
});

// ═══ WebSocket connection to Node aggregator ══════════════════════════════════
let wsPingTimer = null;
let wsReconnectTimer = null;
let lastWsMsg = 0;

// Watchdog: if no data for 10s while connected — force reconnect
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && wsReady) {
    if (lastWsMsg > 0 && Date.now() - lastWsMsg > 10000) {
      console.warn("[WS] No data for 10s — forcing reconnect");
      $("cd-label").textContent = "Переподключение...";
      ws.onclose = null; ws.onerror = null;
      try { ws.close(); } catch (_) { }
      ws = null;
      wsReady = false;
      idToKey = {};
      if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
      connectWS();
    }
  }
}, 5000);

function connectWS() {
  // Cancel any pending reconnect
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

  const wsUrl =
    location.protocol === "file:"
      ? null
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

  if (!wsUrl) {
    loadFallback();
    return;
  }

  // Tear down old connection cleanly
  if (ws) {
    ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
    try { ws.close(); } catch (_) { }
    ws = null;
  }
  if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }

  $("cd-label").textContent = "Подключение...";
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    wsReady = true;
    console.log("[WS] Connected");
    $("cd-go").classList.remove("err");
    $("cd-go").classList.add("ok");
    $("cd-label").textContent = "Live";
    hideLoading();
    fetchKlines(activeEx, activeSym, activeTf);

    // Ping every 20s to keep connection alive through proxies/nginx
    wsPingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch (_) { }
      }
    }, 20000);
  };

  ws.onmessage = (e) => {
    lastWsMsg = Date.now();
    // Flash the live indicator on every binary packet
    if (e.data instanceof ArrayBuffer) {
      const dot = $("cd-go");
      if (dot) { dot.style.opacity = "0.3"; clearTimeout(dot._ft); dot._ft = setTimeout(() => dot.style.opacity = "", 80); }
    }
    // ── Binary Protocol Handler (Ultra-Sync 3.0) ──
    if (e.data instanceof ArrayBuffer) {
      const floatData = new Float64Array(e.data);
      for (let i = 0; i < floatData.length; i += 11) {
        const id = Math.round(floatData[i]);
        const key = idToKey[id];
        if (!key) continue;

        const p = floatData[i + 1], chg = floatData[i + 2], v = floatData[i + 3], h = floatData[i + 4],
          l = floatData[i + 5], o = floatData[i + 6], funding = floatData[i + 7],
          nextFunding = floatData[i + 8], oi = floatData[i + 9], trades = floatData[i + 10];

        let c = coins.get(key);
        if (!c) {
          // Coin not yet in map — create it from key
          processTickerUpdateFlat(key, p, chg, v, h, l, o, funding, nextFunding, oi, trades);
          needRebuild = true;
          continue;
        }
        c.prev = c.p;
        if (!c.displayP) c.displayP = c.p;
        const oldP = c.p;
        c.p = p; c.chg = chg; c.v = v; c.h = h; c.l = l; c.o = o;
        c.funding = funding; c.nextFunding = nextFunding; c.oi = oi; c.trades = trades;
        dirty.add(key);
        if (c.p !== oldP) scheduleInterp(key);
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      console.error("WS Parse error:", err);
      return;
    }

    if (msg.type === "ticker_map") {
      const prevSize = Object.keys(idToKey).length;
      // Server sends {key→id}, we need {id→key} for binary protocol lookup
      for (const [key, id] of Object.entries(msg.data)) {
        idToKey[id] = key;
      }
      const newSize = Object.keys(idToKey).length;
      console.log(`[BINARY] Ticker map updated: ${newSize} entries (+${newSize - prevSize})`);
      // If new keys arrived — request fresh snapshot so we get their current prices
      if (newSize > prevSize && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "get_snapshot" }));
      }
      return;
    }
    if (msg.type === "ex_status") {
      Object.entries(msg.data).forEach(([ex, info]) => {
        const items = document.querySelectorAll(`.exc-item[data-cex="${ex}"]`);
        items.forEach(item => {
          const dot = item.querySelector('.exc-dot');
          if (dot) {
            if (info.status === 'online') {
              dot.style.boxShadow = "none";
              dot.style.opacity = "1";
            } else if (info.status === 'connecting') {
              dot.style.boxShadow = "none";
              dot.style.opacity = "0.7";
            } else {
              dot.style.boxShadow = "none";
              dot.style.opacity = "0.4";
            }
          }
        });
      });
      return;
    }
    if (msg.type === "walls") {
      if (Array.isArray(msg.data)) {
        densityData = msg.data;
        densityLastUpdate = Date.now();
        if (activeView === "map") layoutDensityBadges();
      }
      return;
    }
    if (msg.type === "snapshot") {
      const flat = msg.data;
      const start = flat[0] === "s" ? 1 : 0;
      const count = (flat.length - start) / 11;
      console.log(`[SNAPSHOT] Received ${count} tickers, flat.length=${flat.length}`);
      for (let i = start; i < flat.length; i += 11) {
        processTickerUpdateFlat(flat[i], flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4], flat[i + 5], flat[i + 6], flat[i + 7], flat[i + 8], flat[i + 9], flat[i + 10]);
      }
      console.log(`[SNAPSHOT] coins.size=${coins.size}`);
      needRebuild = true;
      hideLoading();
    } else if (msg.type === "diff") {
      const activeKey = `${activeEx}:${activeSym}`;
      const flat = msg.data;
      const start = flat[0] === "d" ? 1 : 0;
      let addedNew = false;
      for (let i = start; i < flat.length; i += 11) {
        const key = flat[i];
        const p = flat[i + 1], chg = flat[i + 2], v = flat[i + 3], h = flat[i + 4], l = flat[i + 5], o = flat[i + 6], funding = flat[i + 7], nextFunding = flat[i + 8], oi = flat[i + 9], trades = flat[i + 10];
        const c = coins.get(key);
        if (c) {
          c.prev = c.p;
          if (!c.displayP) c.displayP = c.p;
          const oldP = c.p;
          c.p = p; c.chg = chg; c.v = v; c.h = h; c.l = l; c.o = o;
          if (funding !== undefined) c.funding = funding;
          if (nextFunding !== undefined) c.nextFunding = nextFunding;
          if (oi !== undefined) c.oi = oi;
          if (trades !== undefined) c.trades = trades;
          if (c.p !== oldP) scheduleInterp(key);
        } else {
          processTickerUpdateFlat(key, p, chg, v, h, l, o, funding, nextFunding, oi, trades);
          addedNew = true;
        }
        dirty.add(key);

        if (screenerView === "multichart") {
          chartInstances.forEach(inst => {
            if (inst.sym && `${inst.ex}:${inst.sym}` === key) {
              inst.update(c);
            }
          });
        }

        if (key === activeKey && candles.length > 0) {
          chartNeedsDraw = true;
        }
      }
      if (addedNew) needRebuild = true;
    } else if (msg.type === "kline") {
      if (msg.ex === activeEx && msg.sym === activeSym && msg.tf === activeTf) {
        const k = msg.data;
        appendCandle({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] });
      }
    }
  };

  ws.onclose = (e) => {
    wsReady = false;
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    $("cd-go").classList.remove("ok");
    $("cd-go").classList.add("err");
    $("cd-label").textContent = "Переподключение...";
    // Reset idToKey — server may have restarted with new indices
    idToKey = {};
    console.log("[WS] Closed, code:", e.code, "— reconnecting in 2s");
    wsReconnectTimer = setTimeout(connectWS, 2000);
  };
  ws.onerror = (e) => {
    console.warn("[WS] Error:", e.message || e.type);
    // onclose will fire after onerror automatically
  };
}

// Reconnect when tab becomes visible (browser may freeze WS in background)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log("[WS] Tab visible, reconnecting...");
      connectWS();
    }
  }
});

// Reconnect on network restore
window.addEventListener("online", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log("[WS] Network online, reconnecting...");
    connectWS();
  }
});

function processTickerUpdate(t) {
  const existing = coins.get(t.key);
  const base = existing || { prev: t.p, displayP: t.p };
  if (!base.displayP) base.displayP = t.p;
  coins.set(t.key, Object.assign(base, t));
}

function processTickerUpdateFlat(key, p, chg, v, h, l, o, funding, nextFunding, oi, trades) {
  const existing = coins.get(key);
  if (existing) {
    existing.prev = existing.p;
    if (!existing.displayP) existing.displayP = existing.p;
    existing.p = p; existing.chg = chg; existing.v = v; existing.h = h; existing.l = l; existing.o = o;
    if (funding !== undefined) existing.funding = funding;
    if (nextFunding !== undefined) existing.nextFunding = nextFunding;
    if (oi !== undefined) existing.oi = oi;
    if (trades !== undefined) existing.trades = trades;
  } else {
    const colonIdx = key.indexOf(':');
    const ex = colonIdx > 0 ? key.substring(0, colonIdx) : '';
    const sym = colonIdx > 0 ? key.substring(colonIdx + 1) : key;
    const base = sym.replace(/[-_]?(USDT|USDTM|USDC|BUSD|DAI|USD).*$/i, '');
    coins.set(key, { key, ex, sym, base, prev: p, displayP: p, p, chg, v, h, l, o, funding: funding || 0, nextFunding: nextFunding || 0, oi: oi || 0, trades: trades || 0 });
  }
}

// ═══ Fallback removed — all data via server WS ════════════════════════════════

// ═══ Klines ═══════════════════════════════════════════════════════════════════
const TFB = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "3d": "3d",
  "1w": "1w",
};
const TFBB = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "3d": "3",
  "1w": "W",
};
const TFOK = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
  "3d": "3D",
  "1w": "1W",
};

let klWs = null;
let klPoll = null;

function sanitizeCandle(raw, prevClose = null) {
  if (!raw) return null;
  const t = +raw.t;
  let o = +raw.o,
    h = +raw.h,
    l = +raw.l,
    c = +raw.c,
    v = +raw.v;
  if (![t, o, h, l, c].every(Number.isFinite)) return null;
  if (t <= 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;
  h = Math.max(h, o, l, c);
  l = Math.min(l, o, h, c);
  if (prevClose && prevClose > 0) {
    const hiRatio = Math.max(o, h, l, c) / prevClose;
    const loRatio = Math.min(o, h, l, c) / prevClose;
    if (hiRatio > 20 || loRatio < 0.05) return null;
  }
  return { t, o, h, l, c, v: Number.isFinite(v) ? v : 0 };
}

function sanitizeCandles(list) {
  if (!Array.isArray(list)) return [];
  const sorted = list
    .map((k) => ({
      t: +k.t,
      o: +k.o,
      h: +k.h,
      l: +k.l,
      c: +k.c,
      v: +k.v,
    }))
    .filter((k) => Number.isFinite(k.t))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const k of sorted) {
    const clean = sanitizeCandle(k, out.length ? out[out.length - 1].c : null);
    if (!clean) continue;
    if (out.length && out[out.length - 1].t === clean.t) out[out.length - 1] = clean;
    else out.push(clean);
  }
  return out.slice(-1500);
}

async function fetchKlines(ex, sym, tf) {
  const fetchToken = ++klFetchToken;
  if (klWs) { try { klWs.onclose = null; klWs.close(); } catch (_) { } klWs = null; }
  if (klPoll) { clearInterval(klPoll); klPoll = null; }

  candles = [];
  offsetX = 0;
  chartNeedsDraw = false;
  viewMn = null;
  viewMx = null;
  autoFitY = true;

  const _t = coins.get(`${ex}:${sym}`);
  if (_t) {
    _t.displayP = _t.p;
    interpActive.delete(`${ex}:${sym}`);
  }

  ctx.clearRect(0, 0, chartW, chartH);
  vCtx.clearRect(0, 0, chartW, volH);
  ctx.fillStyle = "rgba(107,114,128,.4)";
  ctx.font = "12px Inter";
  ctx.textAlign = "center";
  ctx.fillText("Загрузка " + sym + "...", chartW / 2, chartH / 2);
  ctx.textAlign = "left";

  try {
    const key = `${ex}|${sym}|${tf}`;
    const cached = KLINES_CACHE.get(key);
    if (cached && Date.now() - cached.ts < KLINES_CACHE_TTL_MS) {
      candles = sanitizeCandles(cached.data);
      if (candles.length > 0) {
        updateOHLC();
        if (!chartW || !chartH) resizeChart();
        chartNeedsDraw = true;
      }
    }
    const useProxy = !location.href.startsWith("file:");
    if (useProxy) {
      // 1. Fetch Lite history (300 candles) - Priority Fast Path
      const rLite = await fetch(`/api/klines?ex=${ex}&sym=${sym}&tf=${tf}&lite=1`);
      const dataLite = await rLite.json();

      if (fetchToken === klFetchToken && activeEx === ex && activeSym === sym) {
        if (Array.isArray(dataLite) && dataLite.length > 0) {
          // Handle both object format and flat array format
          if (typeof dataLite[0] === 'number') {
            const flat = [];
            for (let i = 0; i < dataLite.length; i += 6) {
              flat.push({ t: dataLite[i], o: dataLite[i + 1], h: dataLite[i + 2], l: dataLite[i + 3], c: dataLite[i + 4], v: dataLite[i + 5] });
            }
            candles = sanitizeCandles(flat);
          } else {
            candles = sanitizeCandles(dataLite);
          }
          updateOHLC();
          if (!chartW || !chartH) resizeChart();
          chartNeedsDraw = true;
        }
      }

      // 2. Fetch Full history (3000-5000 candles) in background
      setTimeout(() => {
        if (fetchToken !== klFetchToken) return;
        fetch(`/api/klines?ex=${ex}&sym=${sym}&tf=${tf}&lite=0`)
          .then(res => res.json())
          .then(dataFull => {
            if (fetchToken !== klFetchToken || activeEx !== ex || activeSym !== sym) return;
            if (Array.isArray(dataFull) && dataFull.length > 0) {
              if (typeof dataFull[0] === 'number') {
                const flat = [];
                for (let i = 0; i < dataFull.length; i += 6) {
                  flat.push({ t: dataFull[i], o: dataFull[i + 1], h: dataFull[i + 2], l: dataFull[i + 3], c: dataFull[i + 4], v: dataFull[i + 5] });
                }
                candles = sanitizeCandles(flat);
              } else {
                candles = sanitizeCandles(dataFull);
              }
              KLINES_CACHE.set(key, { ts: Date.now(), data: candles });
              chartNeedsDraw = true;
            }
          })
          .catch(err => console.error("BG fetch error:", err));
      }, 400);

    } else {
      let data;
      if (ex === "BN") {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${TFB[tf]}&limit=300`);
        data = await r.json();
        if (Array.isArray(data)) candles = sanitizeCandles(data.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })));
      } else if (ex === "BB") {
        const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${TFBB[tf]}&limit=300`);
        data = await r.json();
        if (data.result?.list) candles = sanitizeCandles(data.result.list.slice().reverse().map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })));
      } else if (ex === "OX") {
        const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=${TFOK[tf]}&limit=300`);
        data = await r.json();
        if (data.data) candles = sanitizeCandles(data.data.slice().reverse().map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })));
      }
      if (candles.length > 0) KLINES_CACHE.set(key, { ts: Date.now(), data: candles.slice(-1200) });
    }
    if (fetchToken !== klFetchToken || activeEx !== ex || activeSym !== sym || activeTf !== tf) return;
    ctx.clearRect(0, 0, chartW, chartH);
    if (candles.length === 0) {
      ctx.fillStyle = "rgba(107,114,128,.4)";
      ctx.fillText("Нет данных для " + sym, chartW / 2, chartH / 2);
    } else {
      updateOHLC();
      if (!chartW || !chartH) resizeChart();
      chartNeedsDraw = true;
    }
  } catch (err) {
    console.error("klines", err);
    if (fetchToken === klFetchToken && activeEx === ex && activeSym === sym) {
      ctx.clearRect(0, 0, chartW, chartH);
      ctx.fillStyle = "var(--rd)";
      ctx.fillText("Ошибка загрузки: " + err.message, chartW / 2, chartH / 2);
    }
  }
  if (fetchToken !== klFetchToken || activeEx !== ex || activeSym !== sym || activeTf !== tf) return;
  connectKlWs(ex, sym, tf);
}

function appendCandle(k) {
  if (!candles.length) return;
  const last = candles[candles.length - 1];

  // Only accept updates that are NOT older than current last candle
  if (k.t === last.t) {
    const prev = candles.length > 1 ? candles[candles.length - 2].c : null;
    const clean = sanitizeCandle(k, prev);
    if (!clean) return;
    last.o = clean.o;
    last.h = Math.max(last.h, clean.h); // Keep historical high/low for current candle
    last.l = Math.min(last.l, clean.l);
    last.c = clean.c;
    last.v = clean.v;
  } else if (k.t > last.t) {
    // Check if there's a gap (more than one TF)
    const tfMs = TF_MS[activeTf] || 60000;
    if (k.t - last.t > tfMs * 1.5) {
      console.warn("Gap detected in live stream, fetching full history to patch:", k.t - last.t);
      if (!window.isFetchingGap) {
        window.isFetchingGap = true;
        setTimeout(() => {
          fetchKlines(activeEx, activeSym, activeTf);
          window.isFetchingGap = false;
        }, 100);
      }
      return;
    }
    const clean = sanitizeCandle(k, last.c);
    if (!clean) return;
    candles.push(clean);
    if (candles.length > 1500) candles.shift(); // Keep buffer small
  }
  chartNeedsDraw = true;
  updateOHLC();
}

function connectKlWs(ex, sym, tf) {
  if (klWs) { try { klWs.close(); } catch (_) { } klWs = null; }
  if (klPoll) { clearInterval(klPoll); klPoll = null; }

  // Subscribe to server kline stream via main WS
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "subscribe_kline", ex, sym, tf }));
  }
}

function updateOHLC() {
  if (!candles.length) return;
  const c = candles[candles.length - 1];
  const oo = $("oo"),
    oh = $("oh"),
    ol = $("ol_"),
    oc = $("oc"),
    ovl = $("ovl");
  if (oo) oo.textContent = fP(c.o);
  if (oh) oh.textContent = fP(c.h);
  if (ol) ol.textContent = fP(c.l);
  // Show interpolated close price for live feel
  const ac = coins.get(`${activeEx}:${activeSym}`);
  if (oc) oc.textContent = fP(ac ? getDisplayP(ac) : c.c);
  if (ovl) ovl.textContent = fV(c.v);
  updateSymInfo();
}

// ═══ Render engine (rAF = paint only, logic runs in MessageChannel) ══════════
function startRender() {
  requestAnimationFrame(rafLoop);
}

// rAF loop: ONLY repaints the canvas — runs at monitor refresh rate (60/120/144hz)
// All logic (interpolation, DOM updates) happens in the faster MessageChannel loop
function rafLoop() {
  const now = performance.now();
  const dt = Math.min((now - lastRafTs) / 1000, 0.05); // max 50ms step for stability
  lastRafTs = now;

  requestAnimationFrame(rafLoop);

  // ── Ultra-Flow: Sync active coin interpolation with V-Sync ────────────────
  const ak = `${activeEx}:${activeSym}`;
  const ac = coins.get(ak);
  let isActiveAnimating = false;
  if (ac && ac.displayP && ac.p !== ac.displayP) {
    const diff = ac.p - ac.displayP;
    const absDiff = Math.abs(diff);
    const pDiffPct = absDiff / ac.p;

    if (pDiffPct > SNAP_THRESHOLD || absDiff < 1e-10) {
      ac.displayP = ac.p;
    } else {
      // High-Fidelity Exponential Smoothing (independent of monitor Hz)
      const factor = 1 - Math.pow(0.001, dt / INTERP_PERIOD);
      ac.displayP += diff * factor;
      isActiveAnimating = true;
    }
    dirty.add(ak);
  }

  if (screenerView === "multichart") {
    chartInstances.forEach(inst => inst.draw());
  } else if (chartNeedsDraw || isActiveAnimating) {
    chartNeedsDraw = false;
    drawChart();
  }
}

function isUsdtFutures(c) {
  if (!c || !c.sym || !c.key) return false;
  const s = c.sym.toUpperCase();
  const k = c.key.toUpperCase();

  // Aggressive SPOT filtering
  if (k.includes("SPOT") || s.includes("SPOT")) return false;

  // Binance/Bybit/Kucoin/OKX etc. futures patterns
  const isFuture = s.endsWith("USDT") ||
    s.endsWith("USDTM") || // KuCoin Futures
    s.includes("USDT-") ||
    s.includes("USDT_") ||
    s.includes("-SWAP") ||
    s.includes("-PERP") ||
    c.ex === "HL"; // Hyperliquid

  return isFuture;
}

function rebuildList() {
  let list = Array.from(coins.values());

  // ─── Filter: USDT Futures Only ──────────────────────────────────────────────
  list = list.filter(isUsdtFutures);

  if (listEx !== "ALL") list = list.filter((c) => c.ex === listEx);
  if (searchQ) {
    const q = searchQ.toLowerCase();
    list = list.filter((c) => c.base.toLowerCase().includes(q));
  }
  if (activeColorFilters.size > 0) {
    list = list.filter((c) => activeColorFilters.has(coinTags[c.key]));
  }

  // Sort
  const dir = sortDir === -1 ? -1 : 1;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const cmp = (a, b) => {
    if (sortCol === "v") return (num(b.v) - num(a.v)) * dir;
    if (sortCol === "oi") return (num(getOiPct(b)) - num(getOiPct(a))) * dir;
    if (sortCol === "trades") {
      const natrA = (a.p > 0 && a.h >= a.l) ? ((a.h - a.l) / a.p) * 100 : 0;
      const natrB = (b.p > 0 && b.h >= b.l) ? ((b.h - b.l) / b.p) * 100 : 0;
      return (natrB - natrA) * dir;
    }
    if (sortCol === "funding") return (num(b.funding) - num(a.funding)) * dir;
    if (sortCol === "corr") return (num(b.corr) - num(a.corr)) * dir;
    return (num(b.chg) - num(a.chg)) * dir;
  };
  list.sort((a, b) => {
    const d = cmp(a, b);
    if (d !== 0) return d;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  sortedList = list.slice(0, 300);
  const cl = $("coin-list");

  // Ensure all row elements exist and are filled
  for (const c of sortedList) {
    let rr = rowEls.get(c.key);
    if (!rr) {
      rr = createRow(c);
      rowEls.set(c.key, rr);
    }
    fillRow(c, rr);
  }

  // Use replaceChildren every time rebuildList is called to ensure DOM is fresh and filtered
  // SMART PAUSE: Do not re-order if mouse is hovering over the list (prevents click misses)
  if (!isHoveringScreener || needRebuild) {
    const nodes = sortedList.map(c => rowEls.get(c.key).el);
    cl.replaceChildren(...nodes);
  }

  $("cnt").textContent = `(${list.length})`;
  updateSymInfo();
}

function createRow(c) {
  const el = document.createElement("div");
  el.className = "cr";
  el.setAttribute("role", "listitem");
  el.innerHTML = `<div class="ct"><div class="cdot"></div><span class="cname"></span></div><div class="cc"></div><div class="cv"></div><div class="ctrades"></div><div class="coi"></div><div class="ccorr"></div><div class="cfunding"></div>`;
  const cells = {
    dot: el.querySelector(".cdot"),
    name: el.querySelector(".cname"),
    chg: el.querySelector(".cc"),
    vol: el.querySelector(".cv"),
    oi: el.querySelector(".coi"),
    trades: el.querySelector(".ctrades"),
    funding: el.querySelector(".cfunding"),
    corr: el.querySelector(".ccorr"),
  };
  cells.name.textContent = c.base;
  const tagIdx = coinTags[c.key];
  if (tagIdx !== undefined && TAG_PALETTE[tagIdx]) {
    cells.dot.style.background = TAG_PALETTE[tagIdx];
    cells.dot.classList.add("tagged");
  } else {
    const exCols = { BN: "var(--bn)", BB: "var(--bb)", OX: "var(--ox)", BG: "#22d3ee", GT: "#f43f5e", MX: "#10b981", KC: "#22c55e", BX: "#3b82f6", HT: "#ec4899", HL: "#a855f7", AD: "#fb923c" };
    cells.dot.style.background = exCols[c.ex] || "#6b7280";
    cells.dot.classList.remove("tagged");
  }
  el.addEventListener("click", () => selectCoin(c));
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showColorPicker(e, c);
  });
  return { el, cells };
}

function fillRow(c, rr) {
  // ── 24h change % with subtle flash ─────────────────────────────────────────
  const isPos = c.chg >= 0;
  const chgStr = fC(c.chg);
  if (rr.cells.chg.textContent !== chgStr) {
    rr.cells.chg.textContent = chgStr;
    rr.cells.chg.className = "cc " + (isPos ? "pos" : "neg");
  }

  // ── Volume 24h ─────────────────────────────────────────────────────────────
  const volStr = fV(c.v);
  if (rr.cells.vol.textContent !== volStr) {
    rr.cells.vol.textContent = volStr;
  }

  // ── OI ─────────────────────────────────────────────────────────────────────
  const oiPct = getOiPct(c);
  const oiStr = oiPct.toFixed(1) + "%";
  if (rr.cells.oi.textContent !== oiStr) {
    rr.cells.oi.textContent = oiStr;
  }
  rr.cells.oi.className = "coi " + getOiTone(oiPct);

  // ── NATR ────────────────────────────────────────────────────────────
  let natr = 0;
  if (c.p > 0 && c.h && c.l && c.h >= c.l) {
    natr = ((c.h - c.l) / c.p) * 100;
  }
  natr = Math.max(0, Math.min(100, natr)); // clamp 0..100
  const natrStr = natr.toFixed(1);
  if (rr.cells.trades.textContent !== natrStr) {
    rr.cells.trades.textContent = natrStr;
  }

  // ── Funding ────────────────────────────────────────────────────────────────
  const funding = c.funding || 0;
  const fundStr = (funding >= 0 ? "+" : "") + funding.toFixed(3) + "%";
  if (rr.cells.funding.textContent !== fundStr) {
    rr.cells.funding.textContent = fundStr;
    rr.cells.funding.className = "cfunding " + (funding > 0 ? "pos" : funding < 0 ? "neg" : "");
  }

  // ── Correlation ────────────────────────────────────────────────────────────
  if (c.corr !== undefined) {
    const corrStr = String(c.corr);
    if (rr.cells.corr.textContent !== corrStr) {
      rr.cells.corr.textContent = corrStr;

      rr.cells.corr.style.color = "var(--t1)";
      rr.cells.corr.style.fontWeight = "400";
    }
  } else {
    if (rr.cells.corr.textContent !== "...") {
      rr.cells.corr.textContent = "...";
      rr.cells.corr.style.color = "var(--t3)";
      rr.cells.corr.style.fontWeight = "400";
    }
  }

  const ak = `${activeEx}:${activeSym}`;
  rr.el.classList.toggle("sel", c.key === ak);

  const tagIdx = coinTags[c.key];
  if (tagIdx !== undefined && TAG_PALETTE[tagIdx]) {
    rr.cells.dot.style.background = TAG_PALETTE[tagIdx];
    rr.cells.dot.classList.add("tagged");
  } else {
    const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect x=%223%22 y=%2210%22 width=%225%22 height=%228%22 rx=%221.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%225%22 y=%226%22 width=%221%22 height=%2214%22 rx=%220.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%229.5%22 y=%224%22 width=%225%22 height=%2212%22 rx=%221.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2211.5%22 y=%222%22 width=%221%22 height=%2218%22 rx=%220.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2216%22 y=%2212%22 width=%225%22 height=%226%22 rx=%221.5%22 fill=%22%23ff4560%22/%3E%3Crect x=%2218%22 y=%228%22 width=%221%22 height=%2212%22 rx=%220.5%22 fill=%22%23ff4560%22/%3E%3C/svg%3E";
    const exIcons = { BN: "BN.png", BB: "BB.png", OX: "OK.png", BG: "BG.png", GT: "GT.png", MX: "MX.png", KC: "KC.png", BX: "BX.png", HT: "HX.png", HL: "HL.png", AD: "AS.png" };
    if (exIcons[c.ex]) {
      rr.cells.dot.style.background = `center/contain no-repeat url('/img/${exIcons[c.ex]}')`;
    } else {
      rr.cells.dot.style.background = `center/contain no-repeat url('${ALL_EXC_IMG}')`;
    }
    rr.cells.dot.classList.remove("tagged");
  }
}

function updateRow(key) {
  const c = coins.get(key),
    rr = rowEls.get(key);
  if (!c || !rr) return;
  fillRow(c, rr);
  // Row background flash on real price change (not interpolated)
  if (c.p !== c.prev) {
    const fc = c.p > c.prev ? "fu" : "fd";
    if (fc === "fu") rr.el.classList.remove("fd");
    else rr.el.classList.remove("fu");
    rr.el.classList.add(fc);
    rr.el._flashTimer && clearTimeout(rr.el._flashTimer);
    rr.el._flashTimer = setTimeout(() => rr.el.classList.remove(fc), 350);
  }
  if (key === `${activeEx}:${activeSym}`) updateSymInfoInterp(c);
}

function updateSymInfoInterp(c) {
  if (!c) return;
  const dp = getDisplayP(c);
  const displayChg = c.o > 0 ? ((dp - c.o) / c.o) * 100 : c.chg;
  const sn = $("sn"),
    sc = $("sc"),
    sv = $("sv"),
    srsi = $("srsi"),
    sfun = $("sfun"),
    soi = $("soi");
  if (sn) sn.textContent = c.base + ".F";
  if (sc) {
    sc.textContent = fC(displayChg);
    sc.className = "sym-chg " + (displayChg >= 0 ? "pos" : "neg");
  }
  if (sv) sv.textContent = fV(c.v);
  const rsi = clamp(35 + Math.abs(displayChg) * 2, 20, 80).toFixed(1);
  if (srsi) {
    srsi.textContent = rsi;
    srsi.className = "sv " + (+rsi > 60 ? "pos" : +rsi < 40 ? "neg" : "");
  }

  // Funding in % and countdown
  const funding = c.funding || 0;
  let fundStr = (funding >= 0 ? "+" : "") + funding.toFixed(4) + "%";

  // Calculate exact time to next funding, with 8-hour UTC fallback for MEXC/Bitget
  let ms = 0;
  if (c.nextFunding > 0) {
    ms = c.nextFunding - Date.now();
  } else if (funding !== 0) {
    const eightH = 8 * 3600000;
    ms = eightH - (Date.now() % eightH);
  }

  if (ms > 0) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    fundStr += ` (${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")})`;
  }

  if (sfun) {
    sfun.textContent = fundStr;
    sfun.className = "sv " + (funding > 0 ? "pos" : funding < 0 ? "neg" : "");
  }

  // OI in % of volume (simplified estimation or as provided)
  const oiPct = getOiPct(c);
  if (soi) {
    soi.textContent = oiPct.toFixed(1) + "%";
    soi.className = "sv " + (oiPct >= 22 ? "pos" : oiPct <= 10 ? "neg" : "");
  }
}

// ─── Drawing controls ────────────────────────────────────────────────────────
document.querySelectorAll(".dt-btn[data-tool]").forEach((btn) => {
  btn.onclick = () => {
    if (pendingToolClick) clearTimeout(pendingToolClick);
    pendingToolClick = setTimeout(() => {
      setTool(btn.dataset.tool);
      pendingToolClick = null;
    }, 180);
  };
  btn.ondblclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pendingToolClick) {
      clearTimeout(pendingToolClick);
      pendingToolClick = null;
    }
    pickToolColor(btn.dataset.tool);
  };
});
$("clear-draw").onclick = () => {
  if (!chartDrawings.length) return;
  if (confirm("Очистить все рисунки?")) {
    chartDrawings = [];
    saveDrawings();
    requestAnimationFrame(drawChart);
  }
};
const _magnetBtn = $("magnet-btn");
if (_magnetBtn) _magnetBtn.onclick = toggleMagnet;
applyToolButtonColors();

const settingsBtn = $("settings-btn");
const settingsOverlay = $("settings-overlay");
const settingsClose = $("settings-close");

if (settingsBtn && settingsOverlay && settingsClose) {
  settingsBtn.onclick = () => {
    settingsOverlay.classList.add("open");
  };
  settingsClose.onclick = () => {
    settingsOverlay.classList.remove("open");
  };
  settingsOverlay.onclick = (e) => {
    if (e.target === settingsOverlay) settingsOverlay.classList.remove("open");
  };

  // Tabs switching
  document.querySelectorAll(".settings-tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const targetId = "tab-" + tab.dataset.tab;
      document.querySelectorAll(".settings-pane").forEach(p => {
        p.classList.toggle("active", p.id === targetId);
      });
    };
  });

  // Theme switching placeholder
  document.querySelectorAll(".theme-opt").forEach(opt => {
    opt.onclick = () => {
      document.querySelectorAll(".theme-opt").forEach(o => o.classList.remove("active"));
      opt.classList.add("active");
      const theme = opt.dataset.theme;
      if (theme === "dark") updateBgColor("#0d0f14");
      if (theme === "black") updateBgColor("#000000");
      if (theme === "blue") updateBgColor("#0a0c1a");
    };
  });

  // Background color custom picker logic
  const bgPreview = $("bg-color-preview");
  const bgDropdown = $("bg-color-dropdown");
  const hiddenBgPicker = $("hidden-bg-picker");
  const addCustomBg = $("add-custom-bg");
  const applyBtn = $("settings-apply-btn");
  const opacitySlider = $("set-bg-opacity");
  const opacityVal = $("opacity-val");

  let pendingBg = localStorage.getItem("screener-bg-color") || "#0d0f14";
  let pendingOpacity = localStorage.getItem("screener-bg-opacity") || "100";

  if (bgPreview && bgDropdown) {
    // Open/Close dropdown
    bgPreview.onclick = (e) => {
      e.stopPropagation();
      bgDropdown.classList.toggle("open");
    };

    // Close on click outside
    document.addEventListener("click", (e) => {
      if (!bgDropdown.contains(e.target) && e.target !== bgPreview) {
        bgDropdown.classList.remove("open");
      }
    });

    // Swatches selection
    bgDropdown.querySelectorAll(".c-swatch").forEach(swatch => {
      swatch.onclick = () => {
        pendingBg = swatch.dataset.color;
        bgPreview.style.backgroundColor = pendingBg;
        updateBgColor(pendingBg, pendingOpacity, false);
        bgDropdown.classList.remove("open");
      };
    });

    // Plus button logic
    if (addCustomBg && hiddenBgPicker) {
      addCustomBg.onclick = () => hiddenBgPicker.click();
      hiddenBgPicker.oninput = (e) => {
        pendingBg = e.target.value;
        bgPreview.style.backgroundColor = pendingBg;
        updateBgColor(pendingBg, pendingOpacity, false);
      };
    }

    // Opacity slider
    if (opacitySlider && opacityVal) {
      opacitySlider.oninput = (e) => {
        pendingOpacity = e.target.value;
        opacityVal.textContent = pendingOpacity + "%";
        updateBgColor(pendingBg, pendingOpacity, false);
      };
    }

    // Axis Text Color and Opacity
    const axisPreview = $("axis-color-preview");
    const axisDropdown = $("axis-color-dropdown");
    const hiddenAxisPicker = $("hidden-axis-picker");
    const addCustomAxis = $("add-custom-axis");
    const axisOpacitySlider = $("set-axis-opacity");
    const axisOpacityVal = $("axis-opacity-val");

    let pendingAxisColor = localStorage.getItem("screener-axis-color") || "#d1d4dc";
    let pendingAxisOpacity = localStorage.getItem("screener-axis-opacity") || "100";

    // Reusable Color Picker Logic
    const createColorPicker = (el, initialColor, initialOpacity, onUpdate) => {
      el.innerHTML = `
        <div class="color-preview" style="background-color: ${hexToRgba(initialColor, initialOpacity)}"></div>
        <div class="color-dropdown">
          <div class="color-grid">
            ${["#ffffff", "#e0e0e0", "#bdbdbd", "#9e9e9e", "#757575", "#616161", "#424242", "#212121", "#13151e", "#0d0f14", "#000000",
          "#ff5252", "#ff4081", "#e040fb", "#7c4dff", "#536dfe", "#448aff", "#40c4ff", "#18ffff", "#64ffda", "#69f0ae", "#b2ff59",
          "#ef5350", "#ec407a", "#ab47bc", "#7e57c2", "#5c6bc0", "#42a5f5", "#29b6f6", "#26c6da", "#26a69a", "#66bb6a", "#9ccc65",
          "#c62828", "#ad1457", "#6a1b9a", "#4527a0", "#283593", "#1565c0", "#0277bd", "#00838f", "#00695c", "#2e7d32", "#558b2f"
        ].map(c => `<div class="c-swatch" style="background:${c}" data-color="${c}"></div>`).join("")}
          </div>
          <div class="color-footer">
            <button class="add-custom-color">+</button>
            <input type="color" style="display:none">
          </div>
          <div class="s-row" style="margin-top:8px; padding:0; border:none">
            <span style="font-size:10px">Прозрачность</span>
            <div class="opacity-control">
              <input type="range" class="p-opacity-slider" min="0" max="100" value="${initialOpacity}">
              <span class="p-opacity-val" style="font-size:10px; min-width:25px">${initialOpacity}%</span>
            </div>
          </div>
        </div>
      `;

      const preview = el.querySelector(".color-preview");
      const dropdown = el.querySelector(".color-dropdown");
      const swatches = el.querySelectorAll(".c-swatch");
      const plusBtn = el.querySelector(".add-custom-color");
      const hiddenInput = el.querySelector('input[type="color"]');
      const opacitySlider = el.querySelector(".p-opacity-slider");
      const opacityVal = el.querySelector(".p-opacity-val");

      let curColor = initialColor;
      let curOpacity = initialOpacity;

      preview.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll(".color-dropdown").forEach(d => {
          if (d !== dropdown) d.classList.remove("open");
        });
        dropdown.classList.toggle("open");
      };

      swatches.forEach(s => {
        s.onclick = () => {
          curColor = s.dataset.color;
          preview.style.backgroundColor = hexToRgba(curColor, curOpacity);
          onUpdate(curColor, curOpacity);
          dropdown.classList.remove("open");
        };
      });

      plusBtn.onclick = () => hiddenInput.click();
      hiddenInput.oninput = (e) => {
        curColor = e.target.value;
        preview.style.backgroundColor = hexToRgba(curColor, curOpacity);
        onUpdate(curColor, curOpacity);
      };

      opacitySlider.oninput = (e) => {
        curOpacity = e.target.value;
        opacityVal.textContent = curOpacity + "%";
        preview.style.backgroundColor = hexToRgba(curColor, curOpacity);
        onUpdate(curColor, curOpacity);
      };

      return {
        setColor: (c, o) => {
          curColor = c; curOpacity = o;
          preview.style.backgroundColor = hexToRgba(c, o);
          opacitySlider.value = o;
          opacityVal.textContent = o + "%";
        },
        getColor: () => curColor,
        getOpacity: () => curOpacity
      };
    };

    // State for all candle settings
    const candleState = {
      body: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
      border: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
      wick: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 }
    };

    const volumeState = {
      show: true,
      up: "#26c97a",
      upOp: 75,
      down: "#ff4560",
      downOp: 75
    };

    // Global access
    window.candleSettings = candleState;
    window.volumeSettings = volumeState;

    // Load settings
    const loadSettings = () => {
      const savedCandles = localStorage.getItem("screener-candle-settings");
      if (savedCandles) Object.assign(candleState, JSON.parse(savedCandles));

      const savedVolume = localStorage.getItem("screener-volume-settings");
      if (savedVolume) Object.assign(volumeState, JSON.parse(savedVolume));

      $("set-candle-body").checked = candleState.body.show;
      $("set-candle-border").checked = candleState.border.show;
      $("set-candle-wick").checked = candleState.wick.show;
      $("set-show-volume").checked = volumeState.show;

      const compact = localStorage.getItem("screener-compact-list") === "true";
      const compactEl = $("set-compact-list");
      if (compactEl) compactEl.checked = compact;
      if (compact) $("coin-list").classList.add("compact");

      const anim = localStorage.getItem("screener-chart-anim") !== "false";
      const animEl = $("set-chart-anim");
      if (animEl) animEl.checked = anim;
      INTERP_SPEED = anim ? DEFAULT_INTERP_SPEED : 999.0;

      const sBg = localStorage.getItem("screener-sidebar-bg-color");
      if (sBg) updateScreenerBgColor(sBg, false);

      const sHBg = localStorage.getItem("screener-sidebar-header-bg-color");
      if (sHBg) updateScreenerHeaderColor(sHBg, false);
    };
    loadSettings();
    loadFilterSettings();
    bindFilterListeners();

    const pickers = {};
    document.querySelectorAll(".custom-color-picker[data-picker-id]").forEach(el => {
      const id = el.dataset.pickerId;
      let initialColor, initialOpacity, onUpdate;

      if (id.startsWith("candle-")) {
        const parts = id.split("-");
        const type = parts[2];
        const side = parts[1];
        initialColor = candleState[type][side];
        initialOpacity = candleState[type][side + "Op"];
        onUpdate = (c, o) => {
          candleState[type][side] = c;
          candleState[type][side + "Op"] = o;
          refreshCharts();
        };
      } else if (id.startsWith("volume-")) {
        const side = id.split("-")[1]; // up/down
        initialColor = volumeState[side];
        initialOpacity = volumeState[side + "Op"];
        onUpdate = (c, o) => {
          volumeState[side] = c;
          volumeState[side + "Op"] = o;
          refreshCharts();
        };
      } else if (id === "screener-bg") {
        initialColor = localStorage.getItem("screener-sidebar-bg-color") || "#0d0f14";
        initialOpacity = 100;
        onUpdate = (c, o) => {
          updateScreenerBgColor(c, true);
        };
      } else if (id === "screener-header") {
        initialColor = localStorage.getItem("screener-sidebar-header-bg-color") || "transparent";
        initialOpacity = 100;
        onUpdate = (c, o) => {
          updateScreenerHeaderColor(c, true);
        };
      }

      pickers[id] = createColorPicker(el, initialColor, initialOpacity, onUpdate);
    });

    function refreshCharts() {
      if (typeof drawChart === "function") drawChart();
      if (typeof chartInstances !== "undefined") chartInstances.forEach(inst => inst.draw());
    }

    if (axisPreview && axisDropdown) {
      axisPreview.onclick = (e) => {
        e.stopPropagation();
        axisDropdown.classList.toggle("open");
      };

      document.addEventListener("click", (e) => {
        if (!axisDropdown.contains(e.target) && !e.target.closest(".custom-color-picker") && e.target !== axisPreview) {
          axisDropdown.classList.remove("open");
          document.querySelectorAll(".color-dropdown").forEach(d => d.classList.remove("open"));
        }
      });

      axisDropdown.querySelectorAll(".c-swatch").forEach(swatch => {
        swatch.onclick = () => {
          pendingAxisColor = swatch.dataset.color;
          axisPreview.style.backgroundColor = pendingAxisColor;
          updateAxisColor(pendingAxisColor, pendingAxisOpacity, false);
          axisDropdown.classList.remove("open");
        };
      });

      if (addCustomAxis && hiddenAxisPicker) {
        addCustomAxis.onclick = () => hiddenAxisPicker.click();
        hiddenAxisPicker.oninput = (e) => {
          pendingAxisColor = e.target.value;
          axisPreview.style.backgroundColor = pendingAxisColor;
          updateAxisColor(pendingAxisColor, pendingAxisOpacity, false);
        };
      }

      if (axisOpacitySlider && axisOpacityVal) {
        axisOpacitySlider.oninput = (e) => {
          pendingAxisOpacity = e.target.value;
          axisOpacityVal.textContent = pendingAxisOpacity + "%";
          updateAxisColor(pendingAxisColor, pendingAxisOpacity, false);
        };
      }
    }

    // Apply button
    if (applyBtn) {
      applyBtn.onclick = () => {
        updateBgColor(pendingBg, pendingOpacity, true);
        updateAxisColor(pendingAxisColor, pendingAxisOpacity, true);

        candleState.body.show = $("set-candle-body").checked;
        candleState.border.show = $("set-candle-border").checked;
        candleState.wick.show = $("set-candle-wick").checked;
        localStorage.setItem("screener-candle-settings", JSON.stringify(candleState));

        const compact = $("set-compact-list").checked;
        localStorage.setItem("screener-compact-list", compact);
        $("coin-list").classList.toggle("compact", compact);

        const anim = $("set-chart-anim").checked;
        localStorage.setItem("screener-chart-anim", anim);
        INTERP_SPEED = anim ? DEFAULT_INTERP_SPEED : 999.0;

        volumeState.show = $("set-show-volume").checked;
        localStorage.setItem("screener-volume-settings", JSON.stringify(volumeState));

        refreshCharts();
        if (settingsOverlay) settingsOverlay.classList.remove("open");
      };
    }

    // Reset button
    const resetBtn = $("settings-reset-btn");
    if (resetBtn) {
      resetBtn.onclick = () => {
        if (confirm("Вы уверены, что хотите сбросить все настройки к начальным?")) {
          // Clear settings but keep drawings
          const keysToKeep = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith("crypto_drawings_")) {
              keysToKeep.push({ key, val: localStorage.getItem(key) });
            }
          }
          localStorage.clear();
          keysToKeep.forEach(item => localStorage.setItem(item.key, item.val));
          location.reload();
        }
      };
    }

    // Initial load
    setTimeout(() => {
      opacitySlider.value = pendingOpacity;
      opacityVal.textContent = pendingOpacity + "%";
      updateBgColor(pendingBg, pendingOpacity, false);
      bgPreview.style.backgroundColor = pendingBg;

      if (axisOpacitySlider) {
        axisOpacitySlider.value = pendingAxisOpacity;
        axisOpacityVal.textContent = pendingAxisOpacity + "%";
        updateAxisColor(pendingAxisColor, pendingAxisOpacity, false);
        axisPreview.style.backgroundColor = pendingAxisColor;
      }
    }, 100);
  }
}

function updateAxisColor(color, opacity = 100, save = true) {
  const rgba = hexToRgba(color, opacity);
  if (save) {
    localStorage.setItem("screener-axis-color", color);
    localStorage.setItem("screener-axis-opacity", opacity);
  }
  // Force redraw all charts to apply text color
  if (typeof drawChart === "function") drawChart();
}

function getAxisTextColor() {
  const color = localStorage.getItem("screener-axis-color") || "#d1d4dc";
  const opacity = localStorage.getItem("screener-axis-opacity") || "100";
  return hexToRgba(color, opacity);
}

function hexToRgba(hex, opacity) {
  let r = 0, g = 0, b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 7) {
    r = parseInt(hex.substring(1, 3), 16);
    g = parseInt(hex.substring(3, 5), 16);
    b = parseInt(hex.substring(5, 7), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
}

function updateScreenerBgColor(color, save = true) {
  document.documentElement.style.setProperty("--screener-bg", color);
  if (save) localStorage.setItem("screener-sidebar-bg-color", color);
}

function updateScreenerHeaderColor(color, save = true) {
  document.documentElement.style.setProperty("--screener-header-bg", color);
  if (save) localStorage.setItem("screener-sidebar-header-bg-color", color);
}

function updateBgColor(color, opacity = 100, save = true) {
  const rgba = hexToRgba(color, opacity);
  document.documentElement.style.setProperty("--bg", rgba);
  document.documentElement.style.setProperty("--bg2", rgba);

  if (save) {
    localStorage.setItem("screener-bg-color", color);
    localStorage.setItem("screener-bg-opacity", opacity);
  }

  // Force redraw all charts if initialized
  if (typeof drawChart === "function") drawChart();

  if (typeof screenerView !== "undefined" && screenerView === "multichart") {
    // Redraw all ChartInstances
    if (typeof chartInstances !== "undefined") {
      chartInstances.forEach(inst => inst.draw());
    }
  }
}

function getCanvasBgColor() {
  const color = localStorage.getItem("screener-bg-color") || "#0d0f14";
  const opacity = localStorage.getItem("screener-bg-opacity") || "100";
  return hexToRgba(color, opacity);
}

function updateSymInfo() {
  const key = `${activeEx}:${activeSym}`;
  const c = coins.get(key);
  if (!c) return;
  updateSymInfoInterp(c);
}

function selectCoin(c) {
  const ok = rowEls.get(`${activeEx}:${activeSym}`);
  if (ok) ok.el.classList.remove("sel");
  activeEx = c.ex;
  activeSym = c.sym;
  offsetX = 0;

  // ── High-Frequency Direct Feed ──
  updateActiveTradeStream(c.ex, c.sym);

  // Reset displayP to actual price so interpolator doesn't carry over
  const ticker = coins.get(c.key);
  if (ticker) {
    ticker.displayP = ticker.p;
    interpActive.delete(c.key);
  }
  const rr = rowEls.get(c.key);
  if (rr) rr.el.classList.add("sel");
  syncExcDropdown(c.ex);
  loadDrawings();
  updateSymInfo();
  fetchKlines(c.ex, c.sym, activeTf);
}

function hideLoading() {
  const el = $("loading");
  el.classList.add("hide");
  setTimeout(() => (el.style.display = "none"), 300);
}

// ═══ Exchange dropdown ════════════════════════════════════════════════════════
const excBtn = $("exc-btn"),
  excMenu = $("exc-menu");

function toggleExcDropdown() {
  const open = excMenu.classList.contains("open");
  if (open) {
    excMenu.classList.remove("open");
    excBtn.classList.remove("open");
    excBtn.setAttribute("aria-expanded", "false");
  } else {
    excMenu.classList.add("open");
    excBtn.classList.add("open");
    excBtn.setAttribute("aria-expanded", "true");
  }
}

excBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleExcDropdown();
});
document.addEventListener("click", () => {
  excMenu.classList.remove("open");
  excBtn.classList.remove("open");
  excBtn.setAttribute("aria-expanded", "false");
});
excMenu.addEventListener("click", (e) => e.stopPropagation());

document.querySelectorAll(".exc-item:not(.disabled)").forEach((item) => {
  item.addEventListener("click", () => {
    const cex = item.dataset.cex,
      label = item.dataset.label,
      img = item.dataset.img;
    document.querySelectorAll(".exc-item").forEach((x) => {
      x.classList.remove("on");
      x.setAttribute("aria-selected", "false");
    });
    item.classList.add("on");
    item.setAttribute("aria-selected", "true");
    $("exc-name").textContent = label;
    const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect x=%223%22 y=%2210%22 width=%225%22 height=%228%22 rx=%221.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%225%22 y=%226%22 width=%221%22 height=%2214%22 rx=%220.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%229.5%22 y=%224%22 width=%225%22 height=%2212%22 rx=%221.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2211.5%22 y=%222%22 width=%221%22 height=%2218%22 rx=%220.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2216%22 y=%2212%22 width=%225%22 height=%226%22 rx=%221.5%22 fill=%22%23ff4560%22/%3E%3Crect x=%2218%22 y=%228%22 width=%221%22 height=%2212%22 rx=%220.5%22 fill=%22%23ff4560%22/%3E%3C/svg%3E";
    $("exc-dot").style.background = img ? `center/contain no-repeat url('${img}')` : `center/contain no-repeat url('${ALL_EXC_IMG}')`;
    excMenu.classList.remove("open");
    excBtn.classList.remove("open");
    listEx = cex || "ALL";
    needRebuild = true;
    if (screenerView === "multichart") {
      gridPage = 0;
      initChartGrid();
    }
    if (cex) {
      activeEx = cex;
      const btcSearch = ["BTCUSDT", "BTC_USDT", "BTC-USDT", "BTC-USDT-SWAP", "XBTUSDTM", "BTC"];
      let foundSym = btcSearch.find(s => coins.has(cex + ":" + s));
      if (!foundSym) {
        for (let [key, t] of coins) {
          if (t.ex === cex) { foundSym = t.sym; break; }
        }
      }
      const btcSym = foundSym || (cex === "OX" ? "BTC-USDT-SWAP" : "BTCUSDT");
      activeSym = btcSym;
      const newTicker = coins.get(cex + ":" + btcSym);
      if (newTicker) {
        newTicker.displayP = newTicker.p;
        interpActive.delete(cex + ":" + btcSym);
      }
      updateSymInfo();
      fetchKlines(cex, btcSym, activeTf);
    }
  });
});

function syncExcDropdown(ex) {
  document.querySelectorAll(".exc-item").forEach((x) => {
    x.classList.remove("on");
    x.setAttribute("aria-selected", "false");
  });
  const item = document.querySelector(`.exc-item[data-cex="${ex}"]`);
  if (item) {
    item.classList.add("on");
    item.setAttribute("aria-selected", "true");
    // Only update the visible label if we are NOT in "All Exchanges" mode
    if (listEx !== "ALL") {
      $("exc-name").textContent = item.dataset.label;
      const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect x=%223%22 y=%2210%22 width=%225%22 height=%228%22 rx=%221.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%225%22 y=%226%22 width=%221%22 height=%2214%22 rx=%220.5%22 fill=%22%2326c97a%22/%3E%3Crect x=%229.5%22 y=%224%22 width=%225%22 height=%2212%22 rx=%221.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2211.5%22 y=%222%22 width=%221%22 height=%2218%22 rx=%220.5%22 fill=%22%23f59e0b%22/%3E%3Crect x=%2216%22 y=%2212%22 width=%225%22 height=%226%22 rx=%221.5%22 fill=%22%23ff4560%22/%3E%3Crect x=%2218%22 y=%228%22 width=%221%22 height=%2212%22 rx=%220.5%22 fill=%22%23ff4560%22/%3E%3C/svg%3E";
      $("exc-dot").style.background = item.dataset.img ? `center/contain no-repeat url('${item.dataset.img}')` : `center/contain no-repeat url('${ALL_EXC_IMG}')`;
    }
  }
}

// ═══ UI Events ════════════════════════════════════════════════════════════════
document.querySelectorAll(".tfb").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tfb").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    activeTf = b.dataset.tf;

    // If in multichart mode, sync the grid timeframe
    if (screenerView === "multichart") {
      // Update all chart instances to the new timeframe
      chartInstances.forEach(inst => {
        inst.tf = activeTf;
        inst.loadKlines();
      });
    } else {
      fetchKlines(activeEx, activeSym, activeTf);
    }
  });
});

document.querySelectorAll(".sh").forEach((h) => {
  h.addEventListener("click", () => {
    const col = h.dataset.col;
    if (sortCol !== col) {
      sortCol = col;
      sortDir = 1;
    } else {
      sortDir = sortDir === 1 ? -1 : 1;
    }
    document.querySelectorAll(".sh").forEach((x) => {
      x.classList.remove("asc", "desc");
      x.style.color = "";
    });
    h.classList.add(sortDir === 1 ? "desc" : "asc");
    h.style.color = "var(--ac)";
    // Force vltRank recompute on next rebuild when sorting by vlt
    if (col === "vlt") lastVltRankTs = 0;
    needRebuild = true;
    if (screenerView === "multichart") {
      gridPage = 0;
      initChartGrid();
    }
  });
});

$("si").addEventListener("input", (e) => {
  searchQ = e.target.value.trim();
  needRebuild = true;
  if (screenerView === "multichart") {
    gridPage = 0;
    initChartGrid();
  }
});
window.addEventListener("resize", resizeChart);

// ═══ Color Tagging & Filtering Logic ═════════════════════════════════════════
const tagMenu = $("tag-menu"),
  filterMenu = $("filter-menu"),
  drawColorMenu = $("draw-color-menu"),
  fibSettingsMenu = $("fib-settings-menu");
let rClickCoin = null;

function showColorPicker(e, c) {
  rClickCoin = c;
  const grid = $("tag-picker-grid");
  if (!grid.children.length) {
    TAG_PALETTE.forEach((clr, i) => {
      const b = document.createElement("div");
      b.className = "tag-btn";
      b.style.background = clr;
      b.onclick = () => {
        coinTags[rClickCoin.key] = i;
        saveTags();
        rebuildList();
        closeMenus();
      };
      grid.appendChild(b);
    });
  }
  closeMenus();
  tagMenu.style.left = Math.min(e.pageX, window.innerWidth - 160) + "px";
  tagMenu.style.top = Math.min(e.pageY, window.innerHeight - 140) + "px";
  tagMenu.style.display = "block";
}

function showFilterMenu(e) {
  const grid = $("filter-grid");
  grid.innerHTML = "";
  TAG_PALETTE.forEach((clr, i) => {
    const hasTag = Array.from(Object.values(coinTags)).includes(i);
    if (!hasTag) return; // Only show colors that are actually used
    const b = document.createElement("div");
    b.className = "tag-btn" + (activeColorFilters.has(i) ? " on" : "");
    b.style.background = clr;
    b.onclick = (ev) => {
      ev.stopPropagation();
      if (activeColorFilters.has(i)) activeColorFilters.delete(i);
      else activeColorFilters.add(i);
      b.classList.toggle("on");
      $("sh-base").classList.toggle(
        "active-filter",
        activeColorFilters.size > 0,
      );
      needRebuild = true;
      if (screenerView === "multichart") {
        gridPage = 0;
        initChartGrid();
      }
    };
    grid.appendChild(b);
  });
  if (!grid.children.length) {
    const empty = document.createElement("div");
    empty.style.fontSize = "10px";
    empty.style.color = "var(--t3)";
    empty.textContent = "Нет меток";
    grid.appendChild(empty);
  }
  closeMenus();
  const rect = $("sh-base").getBoundingClientRect();
  filterMenu.style.left = rect.left + "px";
  filterMenu.style.top = rect.bottom + 5 + "px";
  filterMenu.style.display = "block";
}

function closeMenus() {
  tagMenu.style.display = "none";
  filterMenu.style.display = "none";
  if (drawColorMenu) drawColorMenu.style.display = "none";
  if (fibSettingsMenu) fibSettingsMenu.style.display = "none";
  drawColorSelectHandler = null;
  editingFibDrawing = null;
}

$("tag-clear-btn").onclick = () => {
  if (rClickCoin) {
    delete coinTags[rClickCoin.key];
    saveTags();
    rebuildList();
    closeMenus();
  }
};
$("filter-reset-btn").onclick = () => {
  activeColorFilters.clear();
  $("sh-base").classList.remove("active-filter");
  needRebuild = true;
  closeMenus();
};
$("draw-color-close").onclick = () => {
  if (drawColorMenu) drawColorMenu.style.display = "none";
  drawColorSelectHandler = null;
};
$("fib-settings-close").onclick = () => closeMenus();
$("fib-settings-reset").onclick = () => {
  if (!editingFibDrawing) return;
  editingFibDrawing.color = getToolColor("fibgrid");
  editingFibDrawing.levelRows = DEFAULT_FIB_LEVEL_ROWS.map((row) => ({ ...row }));
  editingFibDrawing.levels = [...DEFAULT_FIB_LEVELS];
  editingFibDrawing.verticals = [];
  editingFibDrawing.useSingleColor = true;
  renderFibLevelEditor();
  requestAnimationFrame(drawChart);
};
$("fib-settings-apply").onclick = () => {
  if (!editingFibDrawing) return;
  editingFibDrawing.levelRows = normalizeFibLevelRows(
    editingFibDrawing.levelRows,
    DEFAULT_FIB_LEVEL_ROWS,
    editingFibDrawing.color || getToolColor("fibgrid"),
  );
  editingFibDrawing.levels = editingFibDrawing.levelRows.map((row) => row.value);
  normalizeDrawing(editingFibDrawing);
  saveDrawings();
  requestAnimationFrame(drawChart);
  closeMenus();
};
$("fib-add-level-btn").onclick = () => {
  if (!editingFibDrawing) return;
  editingFibDrawing.levelRows.push({
    value: 0.5,
    enabled: true,
    color: editingFibDrawing.color || getToolColor("fibgrid"),
  });
  editingFibDrawing.levelRows.sort((a, b) => a.value - b.value);
  renderFibLevelEditor();
};
$("fib-use-single-color").onchange = (e) => {
  if (!editingFibDrawing) return;
  editingFibDrawing.useSingleColor = e.target.checked;
  renderFibLevelEditor();
  requestAnimationFrame(drawChart);
};
$("fib-master-color").onclick = (e) => {
  if (!editingFibDrawing) return;
  const rect = e.currentTarget.getBoundingClientRect();
  openDrawColorMenu({
    title: "Основной цвет Fib",
    currentColor: editingFibDrawing.color || getToolColor("fibgrid"),
    pageX: rect.right + 8,
    pageY: rect.top,
    preserveFibMenu: true,
    onSelect: (clr) => {
      editingFibDrawing.color = clr;
      if (editingFibDrawing.useSingleColor !== false) {
        editingFibDrawing.levelRows.forEach((row) => {
          row.color = clr;
        });
      }
      renderFibLevelEditor();
      requestAnimationFrame(drawChart);
    },
  });
};
$("sh-base").onclick = (e) => {
  e.stopPropagation();
  showFilterMenu(e);
};

document.addEventListener("click", (e) => {
  if (
    !tagMenu.contains(e.target) &&
    !filterMenu.contains(e.target) &&
    !drawColorMenu.contains(e.target) &&
    !fibSettingsMenu.contains(e.target)
  )
    closeMenus();
});
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".cr")) closeMenus();
});

// ═══ Density Map v2 — Bubble Map ═════════════════════════════════════════════
let densityCanvas, densityCtx, densityW, densityH;
let densityData = [];     // raw wall objects from server
let densityBubbles = [];  // layout objects with {x,y,vx,vy,r,...}
let densityFilter = "all";
let densityMarket = "all";
let densitySort = "score"; // "score" | "size" | "dist"
let densitySearch = "";
let densityExFilter = new Set(["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"]);
let densityHover = -1;
let densityMouseX = -1, densityMouseY = -1;
let densityAnimFrame = null;
let densityLastUpdate = 0;

const EX_COLORS = {
  BN: "#f59e0b", BB: "#6366f1", OX: "#94a3b8", BG: "#22d3ee",
  GT: "#f43f5e", MX: "#10b981", KC: "#22c55e", BX: "#3b82f6",
  HT: "#ec4899", HL: "#a855f7", AD: "#fb923c"
};
const EX_NAMES = {
  BN: "Binance", BB: "Bybit", OX: "OKX", BG: "Bitget",
  GT: "Gate", MX: "MEXC", KC: "KuCoin", BX: "BingX",
  HT: "HTX", HL: "HyperL", AD: "Asterdex"
};

let activeView = "screener"; // "screener" | "map"
let screenerView = "chart"; // "chart" | "multichart"
let heatmapSort = "v";
let gridSize = 4; // Min 2, changed from 1
let gridPage = 0;
let chartInstances = [];
let manualGridCoins = new Map(); // index -> {ex, sym}

class ChartInstance {
  constructor(container, index) {
    this.index = index;
    this.ex = activeEx;
    this.sym = "";
    this.tf = activeTf;
    this.candles = [];
    this.offsetX = 0;
    this.candleW = 8;
    this.lastDrawTs = 0;

    this.isDrag = false;
    this.isDragY = false;
    this.isDragYScale = false;
    this.dragStart = 0;
    this.dragStartY = 0;
    this.dragOff = 0;
    this.viewMn = null;
    this.viewMx = null;
    this.autoFitY = true;
    this.rulerStart = null;
    this.rulerCurrent = null;

    this.yScaleStartMn = 0;
    this.yScaleStartMx = 0;
    this.dragMnOff = 0;
    this.dragMxOff = 0;

    this.el = document.createElement("div");
    this.el.className = "grid-cell";
    this.el.innerHTML = `
      <div class="cell-header">
        <div class="cell-header-left">
          <div class="cell-ex-icon" style="display:none"></div>
          <span class="cell-sym" title="Кликните для смены тикера">...</span>
          <span class="cell-tf" title="Таймфрейм">--</span>
          <span class="cell-chg">--</span>
        </div>
        <div class="cell-header-right">
          <span class="cell-price">--</span>
          <div class="cell-fs-btn" title="Развернуть">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M10 2H14V6M14 2L9 7M6 14H2V10M2 14L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
      </div>
      <div class="cell-canvas-wrap">
        <canvas class="cell-canvas" style="cursor: crosshair;"></canvas>
      </div>
    `;
    container.appendChild(this.el);

    this.canvas = this.el.querySelector(".cell-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.headerExIcon = this.el.querySelector(".cell-ex-icon");
    this.headerSym = this.el.querySelector(".cell-sym");
    this.headerTf = this.el.querySelector(".cell-tf");
    this.headerChg = this.el.querySelector(".cell-chg");
    this.headerPrice = this.el.querySelector(".cell-price");
    this.fsBtn = this.el.querySelector(".cell-fs-btn");

    this.headerSym.onclick = (e) => {
      e.stopPropagation();
      showMiniSearch(this.index, e);
    };

    this.headerTf.onclick = (e) => {
      e.stopPropagation();
      showMiniTfMenu(this.index, e);
    };

    this.el.onclick = (e) => {
      if (e.target.closest('.cell-fs-btn')) {
        if (this.sym) {
          const c = coins.get(`${this.ex}:${this.sym}`);
          if (c) {
            selectCoin(c);
            toggleScreenerView('single');
          }
        }
        return;
      }
      document.querySelectorAll(".grid-cell").forEach(c => c.classList.remove("active"));
      this.el.classList.add("active");
      if (this.sym) {
        const c = coins.get(`${this.ex}:${this.sym}`);
        if (c) selectCoin(c);
      }
    };

    // Interactivity
    this.canvas.onmousedown = (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const w = this.canvas.clientWidth;
      const PR = 60;
      const PW = w - PR;

      if (e.shiftKey && e.button === 0) {
        this.rulerStart = { x: px, y: py };
        this.rulerCurrent = { x: px, y: py };
        return;
      }

      if (px >= PW) {
        if (this.viewMn !== null && this.viewMx !== null) {
          this.isDragYScale = true;
          this.dragStartY = e.clientY;
          this.yScaleStartMn = this.viewMn;
          this.yScaleStartMx = this.viewMx;
          this.autoFitY = false;
        }
        return;
      }

      if (e.button === 0) {
        this.isDrag = true;
        this.dragStart = e.clientX;
        this.dragOff = this.offsetX;

        // Vertical drag initialization
        if (this.viewMn !== null && this.viewMx !== null) {
          this.isDragY = true;
          this.dragStartY = e.clientY;
          this.dragMnOff = this.viewMn;
          this.dragMxOff = this.viewMx;
          this.autoFitY = false;
        }

        this.canvas.style.cursor = 'grabbing';
      } else if (e.button === 2) {
        if (this.viewMn !== null && this.viewMx !== null) {
          this.isDragY = true;
          this.dragStartY = e.clientY;
          this.autoFitY = false;
          this.dragMnOff = this.viewMn;
          this.dragMxOff = this.viewMx;
          this.canvas.style.cursor = 'ns-resize';
        }
      }
      e.stopPropagation();
    };

    window.addEventListener('mousemove', (e) => {
      if (this.rulerStart) {
        const r = this.canvas.getBoundingClientRect();
        this.rulerCurrent = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.draw(true);
        return;
      }

      if (this.isDrag) {
        const dx = e.clientX - this.dragStart;
        this.offsetX = this.dragOff + dx / this.candleW;
        this.draw(true);
      }

      if (this.isDragYScale) {
        const dy = e.clientY - this.dragStartY;
        const center = (this.yScaleStartMn + this.yScaleStartMx) / 2;
        let half = (this.yScaleStartMx - this.yScaleStartMn) / 2 * Math.pow(1.005, dy);
        half = clamp(half, Math.max(Math.abs(center) * 0.0001, 1e-8), Math.max(Math.abs(center) * 50, 1));
        this.viewMn = center - half;
        this.viewMx = center + half;
        this.draw(true);
      }

      if (this.isDragY) {
        const h = this.canvas.height;
        if (h > 0) {
          const pr = this.dragMxOff - this.dragMnOff;
          const shift = (e.clientY - this.dragStartY) * (pr / h);
          this.viewMn = this.dragMnOff + shift;
          this.viewMx = this.dragMxOff + shift;
          this.draw(true);
        }
      }
    }, { passive: false });

    window.addEventListener('mouseup', () => {
      if (this.isDrag || this.isDragYScale || this.isDragY || this.rulerStart) {
        this.isDrag = false;
        this.isDragYScale = false;
        this.isDragY = false;
        this.rulerStart = null;
        this.rulerCurrent = null;
        this.canvas.style.cursor = 'crosshair';
        this.draw(true);
      }
    });

    // Double-click to reset vertical view
    this.canvas.ondblclick = (e) => {
      e.preventDefault();
      this.autoFitY = true;
      this.draw(true);
    };

    this.canvas.oncontextmenu = (e) => e.preventDefault();

    this.canvas.onwheel = (e) => {
      if (screenerView !== "multichart") return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      this.candleW = clamp(this.candleW * (1 + dir * 0.15), 1.5, 50);
      this.draw(true);
      e.stopPropagation();
    };
  }

  update(ticker) {
    if (!ticker) return;
    const changed = this.sym !== ticker.sym || this.ex !== ticker.ex;
    this.ex = ticker.ex;
    this.sym = ticker.sym;

    const exIcons = { BN: "BN.png", BB: "BB.png", OX: "OK.png", BG: "BG.png", GT: "GT.png", MX: "MX.png", KC: "KC.png", BX: "BX.png", HT: "HX.png", HL: "HL.png", AD: "AS.png" };
    if (exIcons[ticker.ex]) {
      this.headerExIcon.style.background = `center/contain no-repeat url('/img/${exIcons[ticker.ex]}')`;
      this.headerExIcon.style.display = "block";
    } else {
      this.headerExIcon.style.display = "none";
    }

    this.headerSym.textContent = ticker.sym;
    this.headerTf.textContent = this.tf;
    this.headerPrice.textContent = fP(ticker.p);
    const chg = ticker.chg || 0;
    this.headerChg.textContent = fC(chg);
    this.headerChg.className = "cell-chg " + (chg >= 0 ? "pos" : "neg");

    if (changed) {
      this.offsetX = 0;
      this.loadKlines();
    }
    // No direct draw call here, the global loop will handle it
  }

  async loadKlines() {
    if (!this.sym) return;
    this.headerTf.textContent = this.tf;
    const key = `${this.ex}|${this.sym}|${this.tf}`;
    const cached = KLINES_CACHE.get(key);

    if (cached && Date.now() - cached.ts < 300000) {
      if (typeof cached.data[0] === 'number') {
        const flat = [];
        for (let i = 0; i < cached.data.length; i += 6) {
          flat.push({ t: cached.data[i], o: cached.data[i + 1], h: cached.data[i + 2], l: cached.data[i + 3], c: cached.data[i + 4], v: cached.data[i + 5] });
        }
        this.candles = sanitizeCandles(flat);
      } else {
        this.candles = sanitizeCandles(cached.data);
      }
      this.draw(true);
      return;
    }

    try {
      // 1. Lite fetch
      const rLite = await fetch(`/api/klines?ex=${this.ex}&sym=${this.sym}&tf=${this.tf}&lite=1`);
      const dataLite = await rLite.json();
      if (Array.isArray(dataLite) && dataLite.length > 0) {
        const flat = [];
        if (typeof dataLite[0] === 'number') {
          for (let i = 0; i < dataLite.length; i += 6) {
            flat.push({ t: dataLite[i], o: dataLite[i + 1], h: dataLite[i + 2], l: dataLite[i + 3], c: dataLite[i + 4], v: dataLite[i + 5] });
          }
          this.candles = sanitizeCandles(flat);
        } else {
          this.candles = sanitizeCandles(dataLite);
        }
        this.draw(true);
      }

      // 2. Full fetch
      const rFull = await fetch(`/api/klines?ex=${this.ex}&sym=${this.sym}&tf=${this.tf}&lite=0`);
      const dataFull = await rFull.json();
      if (Array.isArray(dataFull) && dataFull.length > 0) {
        const flat = [];
        if (typeof dataFull[0] === 'number') {
          for (let i = 0; i < dataFull.length; i += 6) {
            flat.push({ t: dataFull[i], o: dataFull[i + 1], h: dataFull[i + 2], l: dataFull[i + 3], c: dataFull[i + 4], v: dataFull[i + 5] });
          }
          this.candles = sanitizeCandles(flat);
        } else {
          this.candles = sanitizeCandles(dataFull);
        }
        KLINES_CACHE.set(key, { ts: Date.now(), data: dataFull });
        this.draw(true);
      }
    } catch (e) { }
  }

  draw(force = false) {
    if (!this.candles.length || screenerView !== "multichart") return;

    const now = Date.now();
    if (!force && now - this.lastDrawTs < 16) return; // Increased to ~60fps
    this.lastDrawTs = now;

    // Apply smooth price to last candle
    const last = this.candles[this.candles.length - 1];
    const cData = coins.get(`${this.ex}:${this.sym}`);
    if (cData) {
      const dp = getDisplayP(cData);
      if (dp > 0) {
        last.c = dp;
        if (dp > last.h) last.h = dp;
        if (dp < last.l) last.l = dp;
      }
    }

    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (!cw || !ch) return;

    const ctx = this.ctx;
    ctx.fillStyle = getCanvasBgColor();
    ctx.fillRect(0, 0, cw, ch);

    const PR = 60;
    const PW = cw - PR;
    const PH = ch;
    const candleWidth = this.candleW;
    const n = PW / candleWidth;
    const viewStart = this.candles.length - n - this.offsetX;
    const s = Math.max(0, Math.floor(viewStart));
    const vis = this.candles.slice(s, s + Math.ceil(n) + 2);
    const futureGap = viewStart < 0 ? -viewStart : 0;

    if (!vis.length) return;

    // Fast DOM text update for multichart (since binary protocol bypasses update())
    if (cData) {
      const dp = getDisplayP(cData);

      const pStr = fP(dp);
      if (this._lastPStr !== pStr) {
        this.headerPrice.textContent = pStr;
        this._lastPStr = pStr;
      }

      const cStr = fC(cData.chg);
      if (this._lastCStr !== cStr) {
        this.headerChg.textContent = cStr;
        this.headerChg.className = "cell-chg " + (cData.chg >= 0 ? "pos" : "neg");
        this._lastCStr = cStr;
      }
    }

    let autoMn = Infinity, autoMx = -Infinity;
    vis.forEach(c => { if (c.l < autoMn) autoMn = c.l; if (c.h > autoMx) autoMx = c.h; });
    const autoPad = (autoMx - autoMn) * 0.15 || autoMx * 0.01;
    autoMn = Math.max(0, autoMn - autoPad);
    autoMx += autoPad;

    if (this.autoFitY || this.viewMn === null || this.viewMx === null) {
      this.viewMn = autoMn;
      this.viewMx = autoMx;
    }

    const mn = this.viewMn,
      mx = this.viewMx,
      pr = mx - mn || 1;

    const toY = (p) => ((mx - p) / pr) * PH;
    const hw = Math.max(0.5, (candleWidth - 2) / 2);

    const gridStep = calcNiceStep(pr, Math.max(3, Math.floor(PH / 40)));
    let gridPrice = Math.ceil(mn / gridStep) * gridStep;
    ctx.setLineDash([]);
    ctx.font = "9px Inter";
    ctx.textAlign = "left";
    const axisColor = getAxisTextColor();
    while (gridPrice <= mx + gridStep * 0.01) {
      const y = toY(gridPrice);
      if (y >= 8 && y <= ch - 8) {
        ctx.strokeStyle = "rgba(255,255,255,0.045)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(PW, y); ctx.stroke();

        ctx.fillStyle = axisColor;
        ctx.fillText(fP(gridPrice), PW + 6, y + 3.5);
      }
      gridPrice += gridStep;
    }

    vis.forEach((c, i) => {
      const x = (i + futureGap) * candleWidth + candleWidth / 2;
      if (x > PW + candleWidth) return;
      const up = c.c >= c.o;
      const side = up ? "up" : "down";
      const cs = window.candleSettings || {
        body: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
        border: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
        wick: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 }
      };

      const yH = toY(c.h), yL = toY(c.l);
      const yO = toY(c.o), yC = toY(c.c);
      const bT = Math.min(yO, yC), bH = Math.max(1, Math.abs(yC - yO));

      if (cs.wick.show) {
        ctx.strokeStyle = hexToRgba(cs.wick[side], cs.wick[side + "Op"]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
      }
      if (cs.body.show) {
        ctx.fillStyle = hexToRgba(cs.body[side], cs.body[side + "Op"]);
        ctx.fillRect(x - hw, bT, hw * 2, bH);
      }
      if (cs.border.show) {
        ctx.strokeStyle = hexToRgba(cs.border[side], cs.border[side + "Op"]);
        ctx.lineWidth = 1;
        ctx.strokeRect(x - hw, bT, hw * 2, bH);
      }
    });

    const lastCandle = this.candles[this.candles.length - 1];
    const lastPrice = lastCandle.c;
    const up = lastPrice >= lastCandle.o;
    const ly = clamp(toY(lastPrice), 10, ch - 10);

    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(PW, ly); ctx.stroke();
    ctx.setLineDash([]);

    const tH = 18, tW = PR - 8, tX = PW + 4, tY = ly - tH / 2;
    roundRect(ctx, tX, tY, tW, tH, 4);
    ctx.fillStyle = getCanvasBgColor();
    ctx.fill();
    ctx.strokeStyle = up ? "#26c97a" : "#ff4560";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = "bold 10px Inter";
    ctx.textAlign = "center";
    ctx.fillText(fP(lastPrice), PW + PR / 2, ly + 4);

    // ── Draw Walls (Density) on Chart ──
    const walls = densityData.filter(w => w.ex === this.ex && w.base === this.sym.replace("USDT", "").replace("-USDT", ""));
    if (walls.length > 0) {
      ctx.save();
      for (const w of walls) {
        const wy = toY(w.price);
        if (wy < 0 || wy > PH) continue;

        const isBid = w.side === "bid";
        const alpha = Math.min(0.6, (w.rtwi / 25) * 0.8);
        ctx.strokeStyle = isBid ? `rgba(38,201,122,${alpha})` : `rgba(255,69,96,${alpha})`;
        ctx.lineWidth = Math.min(4, 1 + w.rtwi / 8);
        
        ctx.beginPath();
        ctx.moveTo(0, wy);
        ctx.lineTo(PW, wy);
        ctx.stroke();

        if (candleWidth > 15) {
          ctx.fillStyle = isBid ? "rgba(38,201,122,0.8)" : "rgba(255,69,96,0.8)";
          ctx.font = "bold 9px Inter";
          ctx.textAlign = "right";
          ctx.fillText(w.wallK + "K", PW - 4, wy - 4);
        }
      }
      ctx.restore();
    }

    // ── Draw Ruler ──
    if (this.rulerStart && this.rulerCurrent) {
        const s = this.rulerStart;
        const c = this.rulerCurrent;
        
        const pr_val = mx - mn || 1;
        const fromY = (y) => mx - (y / PH) * pr_val;
        const p1 = fromY(s.y);
        const p2 = fromY(c.y);
        const diffP = p2 - p1;
        const chgP = (diffP / p1) * 100;
        
        const nBars = Math.round((c.x - s.x) / candleWidth);
        
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.8)";
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
        
        // Info box
        const boxW = 80, boxH = 40;
        const bx = c.x + 10, by = c.y - boxH / 2;
        ctx.fillStyle = "rgba(20,24,35,0.85)";
        ctx.strokeStyle = chgP >= 0 ? "#26c97a" : "#ff4560";
        roundRect(ctx, bx, by, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();
        
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px Inter";
        ctx.textAlign = "center";
        ctx.fillText((chgP >= 0 ? "+" : "") + chgP.toFixed(2) + "%", bx + boxW / 2, by + 14);
        ctx.font = "9px Inter";
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText(fP(Math.abs(diffP)), bx + boxW / 2, by + 25);
        ctx.fillText(Math.abs(nBars) + " баров", bx + boxW / 2, by + 35);
        ctx.restore();
    }
  }
}

function toggleScreenerView(view) {
  screenerView = view;
  const gridContainer = $("chart-grid-container");
  const chartCanvas = $("chart-canvas");
  const volCanvas = $("vol-canvas");
  const drawTools = $("draw-tools");
  const gridConfig = $("grid-config");
  const backBtn = $("chart-back-btn");

  document.querySelectorAll(".vt-btn").forEach(b => {
    b.classList.toggle("on", b.dataset.view === view);
  });

  if (view === "multichart") {
    gridContainer.style.display = "grid";
    gridConfig.style.display = "flex";
    chartCanvas.style.visibility = "hidden";
    volCanvas.style.visibility = "hidden";
    drawTools.style.display = "none";
    if (backBtn) backBtn.style.display = "none";
    // Keep current gridPage when switching back to multichart
    initChartGrid();
  } else {
    gridContainer.style.display = "none";
    gridConfig.style.display = "none";
    chartCanvas.style.visibility = "visible";
    volCanvas.style.visibility = "visible";
    drawTools.style.display = "flex";
    if (backBtn) backBtn.style.display = "flex";
    requestAnimationFrame(drawChart);
  }
}

// Back button event listener
const chartBackBtn = $("chart-back-btn");
if (chartBackBtn) {
  chartBackBtn.onclick = () => {
    toggleScreenerView("multichart");
  };
}

let miniSearchActiveIndex = -1;
function showMiniSearch(idx, e) {
  miniSearchActiveIndex = idx;
  const box = $("mini-search-box");
  const input = $("mini-search-input");
  const results = $("mini-search-results");

  box.style.display = "flex";
  box.style.left = Math.min(e.pageX, window.innerWidth - 230) + "px";
  box.style.top = Math.min(e.pageY, window.innerHeight - 300) + "px";
  input.value = "";
  input.focus();
  renderMiniSearchResults("");
}

function renderMiniSearchItem(c) {
  const div = document.createElement("div");
  div.className = "mini-search-item";
  const fullName = EX_NAMES[c.ex] || c.ex;
  div.innerHTML = `<span>${c.sym}</span><span class="msi-ex">${fullName}</span>`;
  div.onclick = () => {
    manualGridCoins.set(miniSearchActiveIndex, { ex: c.ex, sym: c.sym });
    const inst = chartInstances[miniSearchActiveIndex];
    if (inst) inst.update(c);
    $("mini-search-box").style.display = "none";
  };
  return div;
}

let miniTfActiveIndex = -1;
function showMiniTfMenu(idx, e) {
  miniTfActiveIndex = idx;
  const menu = $("mini-tf-menu");
  const inst = chartInstances[idx];
  if (!inst) return;

  const tfs = ["1m", "5m", "15m", "1h", "4h", "1d"];
  menu.innerHTML = tfs.map(tf => `
    <div class="mini-tf-item ${inst.tf === tf ? 'on' : ''}" data-tf="${tf}">${tf}</div>
  `).join("");

  menu.style.display = "flex";
  menu.style.left = Math.min(e.pageX, window.innerWidth - 100) + "px";
  menu.style.top = Math.min(e.pageY, window.innerHeight - 200) + "px";

  menu.querySelectorAll(".mini-tf-item").forEach(item => {
    item.onclick = () => {
      const newTf = item.dataset.tf;
      inst.tf = newTf;
      inst.headerTf.textContent = newTf;
      inst.loadKlines();
      menu.style.display = "none";
    };
  });
}

function renderMiniSearchResults(q) {
  const container = $("mini-search-results");
  container.innerHTML = "";
  const query = q.toUpperCase();
  const matches = Array.from(coins.values())
    .filter(c => isUsdtFutures(c) && (c.sym.includes(query) || c.ex.includes(query)))
    .sort((a, b) => (b.v || 0) - (a.v || 0))
    .slice(0, 50);

  matches.forEach(c => container.appendChild(renderMiniSearchItem(c)));
}

$("mini-search-input").oninput = (e) => renderMiniSearchResults(e.target.value);
document.addEventListener("mousedown", (e) => {
  if (!$("mini-search-box").contains(e.target)) $("mini-search-box").style.display = "none";
  if (!$("mini-tf-menu").contains(e.target)) $("mini-tf-menu").style.display = "none";
});

function initChartGrid() {
  const container = $("chart-grid-container");
  container.innerHTML = "";
  chartInstances = [];

  const rows = gridSize <= 3 ? 1 : (gridSize <= 6 ? 2 : (gridSize <= 9 ? 3 : 4));
  const cols = Math.ceil(gridSize / rows);
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  // Sort ALL coins based on the CURRENT sorting state of the main list
  const sortedCoins = Array.from(coins.values())
    .filter(c => {
      if (!isUsdtFutures(c)) return false;
      // Exchange filter
      if (listEx !== "ALL" && c.ex !== listEx) return false;
      // Search filter
      if (searchQ && !(c.sym.toUpperCase().includes(searchQ.toUpperCase()) || c.ex.toUpperCase().includes(searchQ.toUpperCase()))) return false;
      // Color tag filters
      if (activeColorFilters.size > 0) {
        const tag = coinTags[c.key];
        if (tag === undefined || !activeColorFilters.has(tag)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      let valA, valB;
      const dir = sortDir === 1 ? 1 : -1;

      if (sortCol === "chg") { valA = a.chg; valB = b.chg; }
      else if (sortCol === "v") { valA = a.v; valB = b.v; }
      else if (sortCol === "vlt") { valA = a.vltRank || 0; valB = b.vltRank || 0; }
      else if (sortCol === "oi") { valA = getOiPct(a); valB = getOiPct(b); }
      else if (sortCol === "trades") {
        valA = (a.p > 0 && a.h >= a.l) ? ((a.h - a.l) / a.p) * 100 : 0;
        valB = (b.p > 0 && b.h >= b.l) ? ((b.h - b.l) / b.p) * 100 : 0;
      }
      else if (sortCol === "funding") { valA = a.funding; valB = b.funding; }
      else { valA = a.sym; valB = b.sym; return valA.localeCompare(valB) * (dir === 1 ? 1 : -1); }

      if (valA === undefined) valA = 0;
      if (valB === undefined) valB = 0;
      return (valB - valA) * dir;
    });

  const startIdx = gridPage * gridSize;
  const pageCoins = sortedCoins.slice(startIdx, startIdx + gridSize);

  $("grid-page-label").textContent = `Стр. ${gridPage + 1}`;

  for (let i = 0; i < gridSize; i++) {
    const inst = new ChartInstance(container, i);
    // If we have a manually selected coin for this slot, use it. 
    // Otherwise, use the one from the sorted page.
    const manual = manualGridCoins.get(i);
    let targetCoin = null;
    if (manual) {
      const c = coins.get(`${manual.ex}:${manual.sym}`);
      if (c && isUsdtFutures(c)) {
        targetCoin = c;
      } else {
        // If it was manual but now is spot/offline, clear it
        manualGridCoins.delete(i);
      }
    }
    if (!targetCoin) targetCoin = pageCoins[i];

    if (targetCoin) inst.update(targetCoin);
    chartInstances.push(inst);
  }
  if (chartInstances[0]) chartInstances[0].el.classList.add("active");
}


function renderScreenerHeatmap() {
  const container = $("sh-grid");
  if (!container) return;
  
  const sorted = Array.from(coins.values())
    .filter(c => isUsdtFutures(c))
    .sort((a, b) => {
      const dir = 1; // can be extended with sortDir if needed
      if (heatmapSort === "v") return (b.v - a.v) * dir;
      if (heatmapSort === "chg") return (Math.abs(b.chg) - Math.abs(a.chg)) * dir;
      return 0;
    })
    .slice(0, 200);

  container.innerHTML = sorted.map(c => {
    const chg = c.chg || 0;
    // Color logic: Intensity based on change %
    const opacity = Math.min(0.9, 0.2 + Math.abs(chg) / 10);
    const bg = chg >= 0 ? `rgba(38,166,154,${opacity})` : `rgba(239,83,80,${opacity})`;
    
    return `
      <div class="sh-item" style="background:${bg};" onclick="selectCoinByKey('${c.key}')">
        <div style="font-size:12px; font-weight:800; color:#fff; text-shadow: 0 1px 2px rgba(0,0,0,0.4);">${c.sym.replace("USDT", "")}</div>
        <div style="font-size:11px; font-weight:600; color:rgba(255,255,255,0.9); margin-top:2px;">${fC(chg)}</div>
        <div style="font-size:9px; color:rgba(255,255,255,0.6); margin-top:1px;">${fV(c.v)}</div>
      </div>
    `;
  }).join("");
}

function selectCoinByKey(key) {
  const c = coins.get(key);
  if (c) {
    selectCoin(c);
    toggleScreenerView('single');
  }
}


// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll("#nav .ntab").forEach((tab, idx) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("#nav .ntab").forEach(t => t.classList.remove("on"));
    tab.classList.add("on");
    if (idx === 0) {
      switchView("screener");
    } else if (idx === 1) {
      switchView("map");
    }
  });
});

function switchView(view) {
  activeView = view;
  const mainEl = $("main");
  const densityEl = $("density-view");
  if (view === "screener") {
    mainEl.style.display = "flex";
    densityEl.style.display = "none";
    if (densityAnimFrame) { cancelAnimationFrame(densityAnimFrame); densityAnimFrame = null; }
    document.querySelectorAll(".vt-btn").forEach(btn => {
      btn.onclick = () => toggleScreenerView(btn.dataset.view);
    });
    document.querySelectorAll(".sh-sort-btn").forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll(".sh-sort-btn").forEach(b => b.classList.remove("on"));
        btn.classList.add("on");
        heatmapSort = btn.dataset.sort;
        renderScreenerHeatmap();
      };
    });
    setInterval(() => {
      if (activeView === "screener" && screenerView === "heatmap") renderScreenerHeatmap();
    }, 3000);
    resizeChart();
  } else if (view === "map") {
    mainEl.style.display = "none";
    densityEl.style.display = "flex";
    initDensityCanvas();
    fetchWalls();
    startDensityLoop();
  }
}

// ═══ Density Map — Radar Visualization ════════════════════════════════════════

function initDensityCanvas() {
  densityCanvas = $("density-canvas");
  if (!densityCanvas) return;
  densityCtx = densityCanvas.getContext("2d");
  resizeDensityCanvas();
}

function resizeDensityCanvas() {
  if (!densityCanvas) return;
  const wrap = $("density-canvas-wrap");
  if (!wrap) return;
  densityW = wrap.clientWidth;
  densityH = wrap.clientHeight;
  densityCanvas.width = densityW;
  densityCanvas.height = densityH;
  layoutDensityBadges();
}

// ── Fetch walls (fallback if WS hasn't sent yet) ─────────────────────────────
async function fetchWalls() {
  if (activeView !== "map") return;
  try {
    const res = await fetch("/api/walls");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        densityData = data;
        layoutDensityBadges();
      }
    }
  } catch (e) { console.error("Failed to fetch walls:", e); }
}

// Fallback polling (in case WS didn't deliver)
setInterval(() => {
  if (activeView === "map" && Date.now() - densityLastUpdate > 15000) fetchWalls();
}, 12000);

// ── Filter ────────────────────────────────────────────────────────────────────
function getFilteredDensity() {
  return densityData.filter(d => {
    if (densityFilter !== "all" && d.side !== densityFilter) return false;
    if (densityMarket !== "all" && d.market !== densityMarket) return false;
    if (!densityExFilter.has(d.ex)) return false;
    if (densitySearch) {
      const q = densitySearch.toLowerCase();
      if (!d.base.toLowerCase().includes(q) && !d.sym.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

// ── Layout: collision-aware spiral with score-based sizing ─────────────────────
function layoutDensityBadges() {
  const filtered = getFilteredDensity();

  // Update count badge
  const countEl = $("density-count");
  if (countEl) countEl.textContent = filtered.length + " стен";

  if (!densityW || !densityH) return;
  const cx = densityW / 2;
  const cy = densityH / 2;
  const maxRadius = Math.min(cx, cy) - 60;
  const minRadius = 55;

  // Sort by score DESC so strongest walls get priority placement
  filtered.sort((a, b) => b.rtwi - a.rtwi || b.S - a.S);

  // Calculate bubble radius per wall (based on score)
  for (const d of filtered) {
    const scoreFactor = Math.min(1 + (d.rtwi || 1) / 15, 2.5);
    d._bubbleR = Math.min(36, 22 + scoreFactor * 4);
  }

  const placed = [];
  const GOLDEN_ANGLE = 2.399963;
  const PAD = 6; // minimum gap between bubbles

  for (let i = 0; i < filtered.length; i++) {
    const d = filtered[i];
    // Distance from price → radial position
    const norm = Math.max(0, Math.min(1, (d.pct - 0.05) / 5.0));
    const targetR = minRadius + norm * (maxRadius - minRadius);
    const baseAngle = i * GOLDEN_ANGLE - Math.PI / 2;

    // Try to place without collision, nudging angle if needed
    let bestX = cx + Math.cos(baseAngle) * targetR;
    let bestY = cy + Math.sin(baseAngle) * targetR;
    let collides = true;

    for (let attempt = 0; attempt < 12 && collides; attempt++) {
      const angle = baseAngle + attempt * 0.35;
      const r = targetR + attempt * 8;
      bestX = cx + Math.cos(angle) * Math.min(r, maxRadius + 20);
      bestY = cy + Math.sin(angle) * Math.min(r, maxRadius + 20);

      collides = false;
      for (const p of placed) {
        const dx = bestX - p.x;
        const dy = bestY - p.y;
        const minDist = (d._bubbleR + p.r) + PAD;
        if (dx * dx + dy * dy < minDist * minDist) {
          collides = true;
          break;
        }
      }
    }

    // Clamp to canvas bounds
    const bR = d._bubbleR + 10;
    bestX = Math.max(bR, Math.min(densityW - bR, bestX));
    bestY = Math.max(bR, Math.min(densityH - bR, bestY));

    d.rx = bestX;
    d.ry = bestY;
    placed.push({ x: bestX, y: bestY, r: d._bubbleR });
  }
}

// ── Draw density radar map ────────────────────────────────────────────────────
function drawDensityMap() {
  if (!densityCtx || !densityW || !densityH) return;
  const ctx = densityCtx;
  const cx = densityW / 2;
  const cy = densityH / 2;
  const maxR = Math.min(cx, cy) - 60;
  const minR = 50;
  const t = Date.now();

  ctx.clearRect(0, 0, densityW, densityH);

  // ── Background gradient
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.8);
  bg.addColorStop(0, "#0c0e1a");
  bg.addColorStop(0.55, "#080a12");
  bg.addColorStop(1, "#04050d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, densityW, densityH);

  // ── Dual ambient glow (bid teal + ask red)
  const gBid = ctx.createRadialGradient(cx - maxR * 0.25, cy, 0, cx, cy, maxR * 1.1);
  gBid.addColorStop(0, "rgba(22,199,132, 0.06)");
  gBid.addColorStop(1, "transparent");
  ctx.fillStyle = gBid; ctx.fillRect(0, 0, densityW, densityH);

  const gAsk = ctx.createRadialGradient(cx + maxR * 0.25, cy, 0, cx, cy, maxR * 1.1);
  gAsk.addColorStop(0, "rgba(255,69,96, 0.06)");
  gAsk.addColorStop(1, "transparent");
  ctx.fillStyle = gAsk; ctx.fillRect(0, 0, densityW, densityH);

  // ── Radial spokes (24)
  ctx.save();
  for (let a = 0; a < 24; a++) {
    const angle = (a / 24) * Math.PI * 2 - Math.PI / 2;
    const alpha = a % 6 === 0 ? 0.12 : 0.05;
    ctx.strokeStyle = `rgba(138,80,255, ${alpha})`;
    ctx.lineWidth = a % 6 === 0 ? 1.2 : 0.7;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * 28, cy + Math.sin(angle) * 28);
    ctx.lineTo(cx + Math.cos(angle) * (maxR + 24), cy + Math.sin(angle) * (maxR + 24));
    ctx.stroke();
  }
  ctx.restore();

  // ── Concentric rings
  const rings = [
    { pct: 1, label: "1%" },
    { pct: 2, label: "2%" },
    { pct: 3, label: "3%" },
    { pct: 4, label: "4%" },
    { pct: 5, label: "5%" },
  ];
  ctx.save();
  for (const ring of rings) {
    const norm = (ring.pct - 0.3) / 5.7;
    const r = minR + norm * (maxR - minR);
    const accent = ring.pct === 3;
    // coloured ring fill
    const ringFill = ctx.createRadialGradient(cx, cy, r - 1, cx, cy, r + 1);
    ringFill.addColorStop(0, "transparent");
    ringFill.addColorStop(1, "transparent");

    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = accent ? "rgba(138,80,255, 0.4)" : "rgba(138,80,255, 0.13)";
    ctx.lineWidth = accent ? 1.8 : 1;
    if (!accent) ctx.setLineDash([4, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // label ×4
    ctx.font = `bold ${accent ? 13 : 11}px Inter`;
    ctx.fillStyle = accent ? "rgba(175,140,255, 0.85)" : "rgba(138,80,255, 0.55)";
    [[cx + r + 8, cy + 5, "left"], [cx - r - 8, cy + 5, "right"],
    [cx, cy - r - 9, "center"], [cx, cy + r + 16, "center"]].forEach(([lx, ly, align]) => {
      ctx.textAlign = align; ctx.fillText(ring.label, lx, ly);
    });
  }
  ctx.restore();

  // ── Outer ring decoration
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, maxR + 12, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(138,80,255, 0.08)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  // ── Animated scan sweep
  const sweepAngle = ((t % 6000) / 6000) * Math.PI * 2 - Math.PI / 2;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  // Made the cone much wider (0.8 radians instead of 0.35)
  ctx.arc(cx, cy, maxR + 10, sweepAngle - 0.8, sweepAngle);
  ctx.closePath();
  const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR + 10);
  sweepGrad.addColorStop(0, "transparent");
  // Made the cone much more transparent
  sweepGrad.addColorStop(0.4, "rgba(138,80,255, 0.02)");
  sweepGrad.addColorStop(1, "rgba(138,80,255, 0.05)");
  ctx.fillStyle = sweepGrad; ctx.fill();
  // sweep leading line
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepAngle) * (maxR + 12), cy + Math.sin(sweepAngle) * (maxR + 12));
  ctx.strokeStyle = "rgba(138,80,255, 0.35)"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();

  // ── Center pulsing dot
  const pulse = 0.5 + Math.sin(t / 700) * 0.3;
  ctx.save();
  // outer glow ring
  const cGlow2 = ctx.createRadialGradient(cx, cy, 0, cx, cy, 60);
  cGlow2.addColorStop(0, `rgba(138,80,255, ${0.15 * pulse})`);
  cGlow2.addColorStop(1, "transparent");
  ctx.fillStyle = cGlow2; ctx.beginPath(); ctx.arc(cx, cy, 60, 0, Math.PI * 2); ctx.fill();
  // inner glow
  const cGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22);
  cGlow.addColorStop(0, `rgba(168,110,255, ${0.7 * pulse})`);
  cGlow.addColorStop(1, "transparent");
  ctx.fillStyle = cGlow; ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2); ctx.fill();
  // dot
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#c084fc"; ctx.fill();
  ctx.strokeStyle = "rgba(200,200,255, 0.6)"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = "rgba(220, 200, 255, 0.8)";
  ctx.font = "bold 10px Inter"; ctx.textAlign = "center";
  ctx.fillText("PRICE", cx, cy + 22);
  ctx.restore();

  // ── Draw badges
  const filtered = getFilteredDensity();
  densityHover = -1;
  for (let i = 0; i < filtered.length; i++) {
    const d = filtered[i];
    if (d.rx === undefined) continue;
    const dx = densityMouseX - d.rx;
    const dy = densityMouseY - d.ry;
    const isHover = Math.sqrt(dx * dx + dy * dy) < 45;
    if (isHover) densityHover = i;
    drawDensityBubble(ctx, d, d.rx, d.ry, isHover);
  }

  // ── Hover connector line
  if (densityHover >= 0) {
    const d = filtered[densityHover];
    const isBid = d.side === "bid";
    const lineColor = isBid ? "rgba(22,199,132,0.3)" : "rgba(255,69,96,0.3)";
    ctx.save();
    ctx.strokeStyle = lineColor; ctx.lineWidth = 1; ctx.setLineDash([4, 7]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(d.rx, d.ry); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();

    // ── Tooltip
    const tipW = 245;
    const tipH = 160 + (d.count > 1 ? 20 : 0);
    let tipX = d.rx + 55, tipY = d.ry - tipH / 2;
    if (tipX + tipW > densityW - 10) tipX = d.rx - tipW - 55;
    if (tipY < 10) tipY = 10;
    if (tipY + tipH > densityH - 10) tipY = densityH - tipH - 10;

    ctx.save();
    roundRect(ctx, tipX, tipY, tipW, tipH, 6);
    ctx.fillStyle = "rgba(10, 11, 16, 0.96)"; ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)"; ctx.lineWidth = 1; ctx.stroke();

    // Header
    const suffix = d.market === "spot" ? ".S" : ".F";
    const headerTitle = `${d.base}${suffix} — `;
    const headerType = isBid ? "ПОДДЕРЖКА" : "СОПРОТИВЛЕНИЕ";
    const headerTypeColor = isBid ? "#16c784" : "#ff4560";

    ctx.textBaseline = "top";
    ctx.font = "bold 13px Inter";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(headerTitle, tipX + 16, tipY + 14);
    const titleW = ctx.measureText(headerTitle).width;
    ctx.fillStyle = headerTypeColor;
    ctx.fillText(headerType, tipX + 16 + titleW, tipY + 14);

    // Separator
    ctx.beginPath();
    ctx.moveTo(tipX + 16, tipY + 36);
    ctx.lineTo(tipX + tipW - 16, tipY + 36);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.setLineDash([]); ctx.lineWidth = 1; ctx.stroke();

    let currY = tipY + 48;
    const drawRow = (leftText, rightText, rightColor = "#fff") => {
      ctx.font = "11px Inter";
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "left";
      ctx.fillText(leftText, tipX + 16, currY);
      ctx.font = "bold 12px Inter";
      ctx.fillStyle = rightColor;
      ctx.textAlign = "right";
      ctx.fillText(rightText, tipX + tipW - 16, currY);
      currY += 19;
    };

    // Рынок
    const marketText = d.market === "spot" ? "СПОТ" : "ФЬЮЧЕРСЫ";
    const marketColor = d.market === "spot" ? "#16c784" : "#eab308";
    drawRow("РЫНОК", marketText, marketColor);

    // Объём
    const volText = d.wallK >= 1000 ? (d.wallK / 1000).toFixed(1) + "M$" : d.wallK + "K$";
    drawRow("ОБЪЁМ", volText);

    // Цена / Дист
    const fmtPrice = d.price < 1 ? +d.price.toPrecision(4) : +d.price.toFixed(4);
    drawRow("ЦЕНА / ДИСТ", `${fmtPrice} (${d.pct.toFixed(2)}%)` );

    // Z-Score (quality)
    const zStr = (d.relSize || 0).toFixed(1);
    let zColor = "#64748b";
    if (d.relSize >= 8) zColor = "#fbbf24";
    else if (d.relSize >= 6) zColor = "#a78bfa";
    else if (d.relSize >= 4) zColor = "#38bdf8";
    drawRow("Z-SCORE", zStr, zColor);

    // Ордера
    drawRow("ОРДЕРА", `${d.count || 1}`, "#94a3b8");

    // Separator
    currY += 2;
    ctx.beginPath();
    ctx.moveTo(tipX + 16, currY);
    ctx.lineTo(tipX + tipW - 16, currY);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.setLineDash([3, 4]); ctx.stroke();
    ctx.setLineDash([]); currY += 10;

    // Кластер
    if (d.count > 1) {
      drawRow("КЛАСТЕР", `${d.count} ур.`, "#a78bfa");
    }

    ctx.restore();
  }

  if (filtered.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.font = "15px Inter"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Сканирование стаканов...", cx, cy + 55);
  }
}

// ── Draw a single bubble badge (score-aware) ─────────────────────────────────
function drawDensityBubble(ctx, d, x, y, isHover) {
  const isBid = d.side === "bid";
  const R = Math.round(isHover ? (d._bubbleR || 28) + 5 : (d._bubbleR || 28));
  const bc = isBid ? [22, 199, 132] : [255, 69, 96];

  ctx.save();

  // Draw main badge shape (bubble with pointer)
  ctx.beginPath();
  const arcOffset = 0.35;
  ctx.arc(x, y, R, Math.PI / 2 + arcOffset, Math.PI / 2 - arcOffset);
  ctx.lineTo(x + 7, y + R - 3);
  ctx.lineTo(x, y + R + 9);
  ctx.lineTo(x - 7, y + R - 3);
  ctx.closePath();

  // Fill — dark with side tint
  ctx.fillStyle = isBid ? "rgba(10, 26, 18, 0.95)" : "rgba(26, 10, 13, 0.95)";
  if (isHover) {
    ctx.fillStyle = isBid ? "rgba(15, 36, 25, 0.98)" : "rgba(36, 15, 20, 0.98)";
  }
  ctx.fill();

  // Border
  ctx.strokeStyle = `rgba(${bc[0]},${bc[1]},${bc[2]},${isHover ? 1 : 0.85})`;
  ctx.lineWidth = isHover ? 2.2 : 1.5;
  ctx.stroke();

  // Outer glow on hover
  if (isHover) {
    ctx.save();
    ctx.shadowColor = `rgba(${bc[0]},${bc[1]},${bc[2]}, 0.5)`;
    ctx.shadowBlur = 18;
    ctx.fillStyle = "transparent";
    ctx.fill();
    ctx.restore();
  }

  // Texts inside the bubble
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 1. Volume (e.g. 5.4M)
  const volText = d.wallK >= 1000
    ? (d.wallK / 1000).toFixed(1).replace(/\.0$/, "") + "M"
    : d.wallK + "K";
  const fsBig = Math.max(10, Math.min(14, R * 0.45));
  ctx.font = `bold ${isHover ? fsBig + 2 : fsBig}px Inter`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(volText, x, y - R * 0.32);

  // 2. Ticker
  const fsMid = Math.max(8, Math.min(11, R * 0.35));
  ctx.font = `${isHover ? fsMid + 1 : fsMid}px Inter`;
  ctx.fillStyle = `rgb(${bc[0]},${bc[1]},${bc[2]})`;
  ctx.fillText(d.base, x, y + R * 0.08);

  // 3. Exchange + Pct
  const fsSmall = Math.max(7, Math.min(9, R * 0.28));
  ctx.font = `bold ${fsSmall}px Inter`;
  const exShort = (EX_NAMES[d.ex] || d.ex).substring(0, 3).toUpperCase();
  const pctStr = `${exShort} ${d.pct.toFixed(1)}%`;

  const EX_BUBBLE_COLORS = {
    "BN": "#fbbf24", "BB": "#f97316", "OX": "#f8fafc", "BG": "#2dd4bf",
    "MX": "#10b981", "GT": "#0ea5e9", "KC": "#22c55e", "HT": "#ec4899",
    "BX": "#a855f7", "HL": "#fb923c", "AD": "#f59e0b"
  };
  ctx.fillStyle = EX_BUBBLE_COLORS[d.ex] || "#a1a1aa";
  ctx.fillText(pctStr, x, y + R * 0.46);

  // 4. Quality dot — top-right corner (Z-score indicator)
  const zScore = d.relSize || 0;
  let dotColor;
  if (zScore >= 8) dotColor = "#fbbf24";      // Gold = ultra strong
  else if (zScore >= 6) dotColor = "#a78bfa";  // Purple = very strong
  else dotColor = "#64748b";                    // Gray = moderate
  
  if (zScore >= 6 || isHover) {
    ctx.beginPath();
    ctx.arc(x + R * 0.6, y - R * 0.6, isHover ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = dotColor;
    ctx.fill();
  }

  ctx.restore();
}


// ── Animation loop ────────────────────────────────────────────────────────────
function startDensityLoop() {
  if (densityAnimFrame) return;
  function loop() {
    if (activeView !== "map") { densityAnimFrame = null; return; }
    drawDensityMap();
    densityAnimFrame = requestAnimationFrame(loop);
  }
  densityAnimFrame = requestAnimationFrame(loop);
}

// ── Mouse interactions ────────────────────────────────────────────────────────
document.addEventListener("mousemove", (e) => {
  if (activeView !== "map" || !densityCanvas) return;
  const rect = densityCanvas.getBoundingClientRect();
  densityMouseX = e.clientX - rect.left;
  densityMouseY = e.clientY - rect.top;
});

densityCanvas = $("density-canvas");
if (densityCanvas) {
  densityCanvas.style.cursor = "default";
  densityCanvas.addEventListener("mousemove", () => {
    if (densityCanvas) densityCanvas.style.cursor = densityHover >= 0 ? "pointer" : "default";
  });
}

document.addEventListener("click", (e) => {
  if (activeView !== "map" || densityHover < 0) return;
  const filtered = getFilteredDensity();
  const d = filtered[densityHover];
  if (d) {
    const coinKey = d.ex + ":" + d.sym;
    const c = coins.get(coinKey);
    if (c) {
      switchView("screener");
      document.querySelectorAll("#nav .ntab").forEach((t, i) => {
        t.classList.toggle("on", i === 0);
      });
      selectCoin(c);
    }
  }
});

// ── Density exchange filter dropdown ──────────────────────────────────────────
const dexBtn = $("density-exc-btn");
const dexMenu = $("density-exc-menu");
const dexName = $("density-exc-name");
const dexCbAll = document.querySelector(".dex-cb-all");
const dexCbs = document.querySelectorAll(".dex-cb");

if (dexBtn && dexMenu) {
  dexBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dexBtn.classList.toggle("open");
    dexMenu.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (dexMenu.classList.contains("open") && !dexMenu.contains(e.target) && !dexBtn.contains(e.target)) {
      dexBtn.classList.remove("open");
      dexMenu.classList.remove("open");
    }
  });
}

function updateDexDropdownUI() {
  const allExes = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];
  if (densityExFilter.size === allExes.length) {
    if (dexName) dexName.textContent = "Все биржи";
    if (dexCbAll) dexCbAll.checked = true;
    dexCbs.forEach(cb => cb.checked = true);
  } else {
    if (densityExFilter.size === 0) {
      if (dexName) dexName.textContent = "Выберите биржу";
    } else {
      if (dexName) dexName.textContent = `Выбрано: ${densityExFilter.size}`;
    }
    if (dexCbAll) dexCbAll.checked = false;
    dexCbs.forEach(cb => cb.checked = densityExFilter.has(cb.value));
  }
}

if (dexCbAll) {
  dexCbAll.addEventListener("change", (e) => {
    const allExes = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];
    if (e.target.checked) densityExFilter = new Set(allExes);
    else densityExFilter.clear();
    updateDexDropdownUI();
    layoutDensityBadges();
  });
}

dexCbs.forEach(cb => {
  cb.addEventListener("change", (e) => {
    if (e.target.checked) densityExFilter.add(cb.value);
    else densityExFilter.delete(cb.value);
    updateDexDropdownUI();
    layoutDensityBadges();
  });
});

// ── Filter buttons ────────────────────────────────────────────────────────────
document.querySelectorAll(".density-filter-btn[data-dtype]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".density-filter-btn[data-dtype]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    densityFilter = btn.dataset.dtype;
    layoutDensityBadges();
  });
});

document.querySelectorAll(".density-filter-btn[data-dmarket]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".density-filter-btn[data-dmarket]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    densityMarket = btn.dataset.dmarket;
    layoutDensityBadges();
  });
});

// ── Sort buttons ──────────────────────────────────────────────────────────────
document.querySelectorAll(".density-sort-btn[data-dsort]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".density-sort-btn[data-dsort]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    densitySort = btn.dataset.dsort;
    layoutDensityBadges();
  });
});

// ── Search input ──────────────────────────────────────────────────────────────
const densitySearchInput = $("density-search-input");
if (densitySearchInput) {
  densitySearchInput.addEventListener("input", (e) => {
    densitySearch = e.target.value.trim();
    layoutDensityBadges();
  });
}

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener("resize", () => {
  if (activeView === "map") {
    resizeDensityCanvas();
  }
});

// ═══ Init ═════════════════════════════════════════════════════════════════════
(function init() {
  loadTags();
  loadDrawings();

  // Safety timeout: hide loading after 8s if still visible
  setTimeout(hideLoading, 8000);

  // View toggle in Screener
  document.querySelectorAll(".vt-btn").forEach(btn => {
    btn.onclick = () => toggleScreenerView(btn.dataset.view);
  });

  const btnSyncAllEx = $("btn-sync-all-ex");
  if (btnSyncAllEx) {
    btnSyncAllEx.onclick = (e) => {
      e.stopPropagation();
      const c = coins.get(`${activeEx}:${activeSym}`);
      if (!c) {
        console.warn("btnSyncAllEx: Active coin not found", activeEx, activeSym);
        return;
      }

      const baseToMatch = c.base;
      // Gather all USDT futures with the same base, keeping the top volume coin per exchange.
      const bestPerEx = new Map();
      for (const x of coins.values()) {
        if (x.base === baseToMatch && isUsdtFutures(x)) {
          const existing = bestPerEx.get(x.ex);
          if (!existing || x.v > existing.v) {
            bestPerEx.set(x.ex, x);
          }
        }
      }
      const matches = Array.from(bestPerEx.values());
      matches.sort((a, b) => b.v - a.v); // Heighest volume first

      if (matches.length === 0) return;

      manualGridCoins.clear();
      let slot = 0;
      for (const m of matches) {
        manualGridCoins.set(slot++, { ex: m.ex, sym: m.sym });
      }

      gridPage = 0;
      if (gridSize < slot) {
        const validSizes = [2, 3, 4, 6, 9, 12, 16];
        const nextFit = validSizes.find(s => s >= slot) || 16;
        gridSize = Math.max(gridSize, nextFit);
        const sel = $("grid-size-select");
        if (sel) {
          // ensure backend option exists just in case
          let optionExists = Array.from(sel.options).some(opt => parseInt(opt.value) === gridSize);
          if (!optionExists) {
            const opt = document.createElement("option");
            opt.value = gridSize;
            opt.text = gridSize + " Графиков";
            sel.appendChild(opt);
          }
          sel.value = gridSize;
        }
      }
      if (screenerView === "multichart") {
        initChartGrid();
      } else {
        // If they click this while not in multichart visually (should be hidden but just in case)
        toggleScreenerView("multichart");
      }
    };
  }

  // Grid size select
  const gridSizeSelect = $("grid-size-select");
  if (gridSizeSelect) {
    gridSizeSelect.value = gridSize;
    gridSizeSelect.onchange = (e) => {
      gridSize = parseInt(e.target.value);
      if (screenerView === "multichart") {
        initChartGrid();
      }
    };
  }

  // Grid Pagination
  $("grid-prev").onclick = () => {
    if (gridPage > 0) {
      gridPage--;
      initChartGrid();
    }
  };
  $("grid-next").onclick = () => {
    gridPage++;
    initChartGrid();
  };

  // Heatmap sorting in Screener
  document.querySelectorAll(".sh-sort-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".sh-sort-btn").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      heatmapSort = btn.dataset.sort;
      renderScreenerHeatmap();
    };
  });

  // Periodic update for screener heatmap
  setInterval(() => {
    if (activeView === "screener") {
      if (screenerView === "heatmap") {
        renderScreenerHeatmap();
      } else if (screenerView === "multichart") {
        chartInstances.forEach(inst => inst.draw());
      }
    }
  }, 3000);

  // Resizer logic
  const resizer = $("rp-resizer");
  const rp = $("rp");
  const main = $("main");
  const rpToggle = $("rp-toggle");
  const RP_MIN_WIDTH = 120;
  const RP_MAX_WIDTH = 1100;
  const RP_DEFAULT_WIDTH = 320;
  let isDragging = false;
  let startX, startWidth;

  resizer.onmousedown = (e) => {
    if (e.target === rpToggle) return;
    isDragging = true;
    startX = e.clientX;
    startWidth = rp.offsetWidth;
    resizer.classList.add("dragging");
    rp.classList.add("no-transition");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  window.onmousemove = (e) => {
    if (!isDragging) return;
    const dx = startX - e.clientX;
    let newWidth = startWidth + dx;

    if (newWidth < 50) {
      main.classList.add("rp-collapsed");
      newWidth = 0;
    } else {
      main.classList.remove("rp-collapsed");
      newWidth = Math.min(Math.max(newWidth, RP_MIN_WIDTH), RP_MAX_WIDTH);
    }

    rp.style.width = newWidth + "px";
    resizeChart();
  };

  window.onmouseup = () => {
    if (isDragging) {
      isDragging = false;
      resizer.classList.remove("dragging");
      rp.classList.remove("no-transition");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("rp_width", rp.style.width);
      localStorage.setItem("rp_collapsed", main.classList.contains("rp-collapsed"));
    }
  };

  rpToggle.onclick = () => {
    const isCollapsed = main.classList.toggle("rp-collapsed");
    if (isCollapsed) {
      rp.style.width = "0px";
    } else {
      const savedWidth = parseInt(localStorage.getItem("rp_width") || "", 10);
      const nextWidth = Number.isFinite(savedWidth)
        ? Math.min(Math.max(savedWidth, RP_MIN_WIDTH), RP_MAX_WIDTH)
        : RP_DEFAULT_WIDTH;
      rp.style.width = nextWidth + "px";
    }
    localStorage.setItem("rp_collapsed", isCollapsed);
    resizeChart();
  };

  // Restore state
  const savedWidth = parseInt(localStorage.getItem("rp_width") || "", 10);
  const savedCollapsed = localStorage.getItem("rp_collapsed") === "true";
  if (savedCollapsed) {
    main.classList.add("rp-collapsed");
    rp.style.width = "0px";
  } else {
    const nextWidth = Number.isFinite(savedWidth)
      ? Math.min(Math.max(savedWidth, RP_MIN_WIDTH), RP_MAX_WIDTH)
      : RP_DEFAULT_WIDTH;
    rp.style.width = nextWidth + "px";
  }

  resizeChart();
  setTimeout(resizeChart, 100);
  startRender();
  startMcLoop(); // start 240fps logic loop
  if (location.href.startsWith("file:")) {
    $("cd-label").textContent = "Прямое подключение";
    loadFallback();
  } else {
    connectWS();
  }
  setTimeout(() => fetchKlines(activeEx, activeSym, activeTf), 200);
  // Periodic safety redraw (catches edge cases)
  setInterval(() => {
    if (candles.length) {
      chartNeedsDraw = true;
    }
  }, 500);

  // Force list refresh every 2s regardless of dirty state
  setInterval(() => {
    needRebuild = true;
  }, 2000);

  // ── Debug overlay (tap logo 5x to toggle) ──────────────────────────────────
  (function () {
    const dbg = document.createElement("div");
    dbg.id = "dbg-overlay";
    dbg.style.cssText = "display:none;position:fixed;bottom:10px;left:10px;z-index:99999;background:rgba(0,0,0,0.85);color:#0f0;font:11px/1.6 monospace;padding:8px 12px;border-radius:6px;pointer-events:none;min-width:220px";
    document.body.appendChild(dbg);

    let tapCount = 0, tapTimer = null;
    document.querySelector(".logo")?.addEventListener("click", () => {
      tapCount++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapCount = 0; }, 1000);
      if (tapCount >= 5) {
        tapCount = 0;
        dbg.style.display = dbg.style.display === "none" ? "block" : "none";
      }
    });

    let msgCount = 0, binCount = 0;
    const origOnMsg = (e) => {
      msgCount++;
      if (e.data instanceof ArrayBuffer) binCount++;
    };
    // Patch ws after connect
    const origConnect = connectWS;
    setInterval(() => {
      if (!ws) return;
      const wsStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
      dbg.innerHTML =
        "WS: " + (wsStates[ws.readyState] || ws.readyState) +
        "<br>idToKey: " + Object.keys(idToKey).length +
        "<br>coins: " + coins.size +
        "<br>dirty: " + dirty.size +
        "<br>msgs/s: " + msgCount +
        "<br>binary/s: " + binCount +
        "<br>lastMsg: " + (lastWsMsg ? ((Date.now() - lastWsMsg) / 1000).toFixed(1) + "s ago" : "never");
      msgCount = 0; binCount = 0;
    }, 1000);
  })();

  const coinListEl = $("coin-list");
  if (coinListEl) {
    coinListEl.addEventListener("mouseenter", () => { isHoveringScreener = true; });
    coinListEl.addEventListener("mouseleave", () => { isHoveringScreener = false; });
  }

})();
