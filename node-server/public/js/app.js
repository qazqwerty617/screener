"use strict";

// ── State ──
window.DEBUG_LEVELS = false;
var currentUser = null;
window.currentUser = null;
var authToken = localStorage.getItem("obsidian_auth_token") || "";
const coins = new Map();
window.coins = coins;
const dirty = new Set();
const rowEls = new Map();
const priceHistories = new Map();
let isHoveringScreener = false;

// ════ TOAST NOTIFICATIONS ═════════════════════════════
function showToast(options, typeArg, titleArg, durationArg) {
  let title = "";
  let message = "";
  let type = "info";
  let durationMs = 8000;

  const validTypes = ["info", "success", "error", "warning", "price_alert", "bug_reward", "bug_reject"];

  if (typeof options === "object" && options !== null) {
    title = options.title !== undefined && options.title !== null ? String(options.title) : "";
    message = options.message || options.msg || options.text || options.body || "";
    type = options.type || "info";
    durationMs = options.durationMs || options.duration || 8000;
  } else if (typeof options === "string") {
    if (validTypes.includes(options.toLowerCase())) {
      type = options.toLowerCase();
      title = typeof typeArg === "string" ? typeArg : "";
      message = typeof titleArg === "string" ? titleArg : "";
      if (typeof durationArg === "number") durationMs = durationArg;
    } else if (typeof typeArg === "string" && validTypes.includes(typeArg.toLowerCase())) {
      title = options;
      type = typeArg.toLowerCase();
      message = typeof titleArg === "string" ? titleArg : "";
      if (typeof durationArg === "number") durationMs = durationArg;
    } else {
      title = options;
      message = typeof typeArg === "string" ? typeArg : "";
      if (typeof titleArg === "number") durationMs = titleArg;
    }
  }

  // Clean strings
  if (title === "undefined" || title === "null") title = "";
  if (typeof message === "string" && (message === "undefined" || message === "null")) message = "";

  // Fallback icon & title
  let icon = "";
  if (!title) {
    if (type === "bug_reward" || type === "success") { icon = "🎁"; title = "Баг подтверждён!"; }
    else if (type === "bug_reject") { icon = "ℹ️"; title = "Статус баг-репорта"; }
    else if (type === "error") { icon = "❌"; title = "Ошибка"; }
    else if (type === "price_alert") { icon = "📈"; title = "Сигнал"; }
    else { icon = "ℹ️"; title = "Уведомление"; }
  } else {
    // If title doesn't start with an emoji, add a matching default emoji
    if (!/^[\u{1F300}-\u{1F9FF}|✅|❌|ℹ️|🔔|📈|⚠️|🎁]/u.test(title)) {
      if (type === "bug_reward" || type === "success") icon = "🎁";
      else if (type === "bug_reject") icon = "ℹ️";
      else if (type === "error") icon = "❌";
      else if (type === "price_alert") icon = "📈";
      else icon = "ℹ️";
    }
  }

  const container = typeof $ === "function" ? $("toast-container") : document.getElementById("toast-container");
  if (!container) return;
  
  const card = document.createElement("div");
  card.className = `toast-card toast-${type}`;
  card.innerHTML = `
    <div class="toast-header">
      <span class="toast-title">${icon ? icon + " " : ""}${title}</span>
      <button class="toast-close" onclick="this.closest('.toast-card').remove()">×</button>
    </div>
    ${message ? `<div class="toast-body">${message}</div>` : ""}
    <div class="toast-progress"></div>
  `;
  
  const progress = card.querySelector(".toast-progress");
  if (progress) {
    progress.style.animationDuration = `${durationMs}ms`;
  }

  container.appendChild(card);
  
  setTimeout(() => {
    if (card.parentNode) {
      card.style.opacity = "0";
      card.style.transform = "translateY(-10px)";
      card.style.transition = "all 0.25s ease";
      setTimeout(() => {
        if (card.parentNode) card.remove();
      }, 250);
    }
  }, durationMs);
}
window.showToast = showToast;

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
  // тФАтФАтФА Verified BTC key per exchange (from server tickers.set() calls) тФАтФАтФА
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
    // тФАтФАтФА 1. Price history for correlation тФАтФАтФА
    let hist = priceHistories.get(key);
    if (!hist) { hist = []; priceHistories.set(key, hist); }
    hist.push(c.p);
    if (hist.length > 120) hist.shift();

    // тФАтФАтФА 2. Correlation vs BTC (percentage-return Pearson) тФАтФАтФА
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
window.getActiveMarket = () => ({ ex: activeEx, sym: activeSym, tf: activeTf });
window.requestMainChartDraw = () => requestAnimationFrame(drawChart);
let listEx = "BN",
  searchQ = ""; // listEx tracks dropdown, default = BN

let sortCol = "chg",
  sortDir = 1; // 1=desc, -1=asc

let chartDensityEnabled = false;
let chartDensitySide = "all";
let chartDensitySizes = new Set(["small", "medium", "large"]);
let chartDensityMarket = "all";
let chartDensityExes = new Set(["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"]);
const CHART_DENSITY_STORAGE_KEY = "chart_density_settings_v2";
const DENSITY_SIZE_LABELS = {
  all: "Все размеры",
  small: "Мелкие",
  medium: "Средние",
  large: "Крупные",
};

function getDensityRelativeRank(wall) {
  // `rank` is calculated by the scanner from the wall's Z-score inside this
  // exact coin/exchange order book.  It deliberately does not use fixed USD
  // limits: the same $1m order can be huge for an altcoin and ordinary for BTC.
  const rank = Number(wall && wall.rank);
  if (Number.isFinite(rank) && rank > 0) return Math.max(1, Math.min(10, rank));

  // Compatibility with older/history records that predate `rank`.
  const relSize = Number(wall && wall.relSize);
  if (Number.isFinite(relSize) && relSize > 0) {
    if (wall && wall.ex === "HL") {
      if (relSize > 3.2) return 7;
      if (relSize > 2.2) return 6;
      if (relSize > 1.5) return 5;
      return 3;
    }
    if (relSize > 6.0) return 7;
    if (relSize > 5.0) return 6;
    if (relSize > 4.2) return 5;
    return 3;
  }

  // Last-resort fallback for legacy cached objects. `rtwi` is still relative
  // to the local book, unlike an absolute USD wall size.
  const rtwi = Number(wall && wall.rtwi) || 0;
  if (rtwi >= 7) return 7;
  if (rtwi >= 4.5) return 5;
  return 3;
}

function getDensitySizeType(wall) {
  const rank = getDensityRelativeRank(wall);
  if (rank >= 7) return "large";
  if (rank >= 5) return "medium";
  return "small";
}

function passesDensitySizeFilter(wall, selectedSize) {
  if (!selectedSize || selectedSize === "all") return true;
  return getDensitySizeType(wall) === selectedSize;
}

try {
  const savedChartDensity = JSON.parse(localStorage.getItem(CHART_DENSITY_STORAGE_KEY) || "{}");
  if (typeof savedChartDensity.enabled === "boolean") chartDensityEnabled = savedChartDensity.enabled;
  if (["all", "bid", "ask"].includes(savedChartDensity.side)) chartDensitySide = savedChartDensity.side;
  if (["all", "spot", "futures"].includes(savedChartDensity.market)) chartDensityMarket = savedChartDensity.market;
  if (Array.isArray(savedChartDensity.sizes)) chartDensitySizes = new Set(savedChartDensity.sizes);
  if (Array.isArray(savedChartDensity.exchanges)) chartDensityExes = new Set(savedChartDensity.exchanges);
} catch (_) {}
function saveChartDensitySettings() {
  try {
    localStorage.setItem(CHART_DENSITY_STORAGE_KEY, JSON.stringify({
      enabled: chartDensityEnabled,
      side: chartDensitySide,
      market: chartDensityMarket,
      sizes: Array.from(chartDensitySizes),
      exchanges: Array.from(chartDensityExes),
    }));
  } catch (_) {}
}

function loadActiveIndicators() {
  try {
    const raw = localStorage.getItem("crypto_chart_indicators");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (_) {}
  return new Set([]);
}

function saveActiveIndicators() {
  try {
    localStorage.setItem("crypto_chart_indicators", JSON.stringify(Array.from(chartActiveIndicators)));
    if (typeof schedulePreferencesSync === "function") schedulePreferencesSync();
  } catch (_) {}
}

function loadActiveSmc() {
  try {
    const raw = localStorage.getItem("crypto_chart_smc");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (_) {}
  return new Set([]);
}

function saveActiveSmc() {
  try {
    localStorage.setItem("crypto_chart_smc", JSON.stringify(Array.from(chartActiveSmc)));
    if (typeof schedulePreferencesSync === "function") schedulePreferencesSync();
  } catch (_) {}
}

function loadActiveFormations() {
  try {
    const raw = localStorage.getItem("crypto_chart_formations");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (_) {}
  return new Set([]);
}

function saveActiveFormations() {
  try {
    localStorage.setItem("crypto_chart_formations", JSON.stringify(Array.from(chartActiveFormations)));
    if (typeof schedulePreferencesSync === "function") schedulePreferencesSync();
  } catch (_) {}
}

let chartActiveIndicators = loadActiveIndicators();
let chartActiveFormations = loadActiveFormations();
let chartActiveSmc = loadActiveSmc();
// ═══ Formations Overlay on Main Chart ═══
let chartFormationsOnChart = chartActiveFormations && chartActiveFormations.size > 0;
let chartFovTypes = new Set(chartActiveFormations && chartActiveFormations.size > 0 ? Array.from(chartActiveFormations) : ["cascades"]);
let chartFovCascadesMin = 2;                 // min touches for cascades (default 2+)
let chartFovBreakoutMin = 2;                 // min touches for horiz levels (default 2+)
let chartFovTrendlineMin = 2;                // min touches for trendlines (default 2+)
let chartFovRetestApproaching = false;       // approach to retest toggle
let chartFovNearest = false;                 // show nearest level only
let chartFovShowLabels = true;               // show Resistance / Support labels
let chartFovShowTouches = true;              // show touch circles on level

// Formation detection is substantially more expensive than drawing. Cache a
// result until the current candle materially changes, so live charts can keep
// moving at 60 fps without running O(n²/O(n³)) detectors every frame.
const formationDetectionCache = new WeakMap();
function getCachedFormationDetection(candles, key, detector, ttlMs = 900) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  let cache = formationDetectionCache.get(candles);
  if (!cache) {
    cache = new Map();
    formationDetectionCache.set(candles, cache);
  }
  const last = candles[candles.length - 1];
  const signature = `${candles.length}|${last?.t || 0}|${last?.c || 0}|${last?.h || 0}|${last?.l || 0}`;
  const now = performance.now();
  const previous = cache.get(key);
  if (previous && (previous.signature === signature || now - previous.at < ttlMs)) {
    return previous.value;
  }
  const value = detector() || [];
  cache.set(key, { signature, at: now, value });
  return value;
}


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
let volH = 80;
let offsetX = 0;
let isLoadingOlderCandles = false;
let hasReachedStartOfHistory = false;
function getClampedOffsetX(val) {
  if (!Number.isFinite(val) || candles.length === 0) return 0;
  const PW = chartW - (typeof PR_WIDTH !== 'undefined' ? PR_WIDTH : 82);
  const visibleCount = PW / (candleW || 10);
  const minX = -Math.max(0, visibleCount - 2);
  const maxX = Math.max(0, candles.length + (hasReachedStartOfHistory ? -2 : 120));
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
let brushLineWidth = 2;       // brush line width in pixels (1-10)
let brushDrawThrottle = null;  // throttle for brush drawing requests
let showMultichartDrawings = localStorage.getItem("show_multichart_drawings") !== "false";

// тФАтФА Direct Trade WS (Zero-Lag Pricing) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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
    if (ex === "BN") url = `wss://fstream.binance.com/market/ws/${sym.toLowerCase()}@aggTrade`;
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
            checkPriceAlerts(ex, sym, p);
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
  alert: "#2bd98a",
  rect: "#fb7185",
  ruler: "#facc15",
  fibgrid: "#8b5cf6",
  brush: "#facc15",
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

function getSymbolsWithDrawings() {
  try {
    const raw = localStorage.getItem("crypto_symbols_with_drawings");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch (_) {}
  return new Set();
}

function trackSymbolWithDrawings(sym, hasDrawings) {
  if (!sym) return;
  try {
    const set = getSymbolsWithDrawings();
    if (hasDrawings) set.add(sym);
    else set.delete(sym);
    localStorage.setItem("crypto_symbols_with_drawings", JSON.stringify(Array.from(set)));
  } catch (_) {}
}

function getAllDrawingsBySymbol() {
  const map = {};
  const symbols = getSymbolsWithDrawings();
  if (activeSym) symbols.add(activeSym);
  for (const sym of symbols) {
    try {
      const raw = localStorage.getItem("crypto_drawings_" + sym);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          map[sym] = parsed;
        }
      }
    } catch (_) {}
  }
  return map;
}

let preferencesSyncTimer = null;
function schedulePreferencesSync() {
  const token = (typeof authToken === "string" && authToken) ? authToken : (localStorage.getItem("obsidian_auth_token") || "");
  if (!token) return;
  if (preferencesSyncTimer) clearTimeout(preferencesSyncTimer);
  preferencesSyncTimer = setTimeout(syncPreferencesToServer, 800);
}

async function syncPreferencesToServer() {
  const token = (typeof authToken === "string" && authToken) ? authToken : (localStorage.getItem("obsidian_auth_token") || "");
  if (!token) return;
  try {
    const payload = {
      activeIndicators: Array.from(chartActiveIndicators),
      activeSmc: Array.from(chartActiveSmc),
      activeFormations: Array.from(chartActiveFormations),
      drawingsBySymbol: getAllDrawingsBySymbol(),
      toolColors: typeof toolColors !== "undefined" ? toolColors : undefined,
      candleSettings: typeof window.candleSettings !== "undefined" ? window.candleSettings : undefined,
      volumeSettings: typeof window.volumeSettings !== "undefined" ? window.volumeSettings : undefined,
      chartDensitySettings: {
        enabled: chartDensityEnabled,
        side: chartDensitySide,
        market: chartDensityMarket,
        sizes: Array.from(chartDensitySizes),
        exchanges: Array.from(chartDensityExes),
      },
      fovSettings: {
        enabled: chartFormationsOnChart,
        types: Array.from(chartFovTypes),
        cascadesMin: chartFovCascadesMin,
        breakoutMin: chartFovBreakoutMin,
        trendlineMin: chartFovTrendlineMin,
        retestApproaching: chartFovRetestApproaching,
        nearest: chartFovNearest,
        showLabels: chartFovShowLabels,
        showTouches: chartFovShowTouches
      }
    };

    await fetch("/api/user/preferences", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ preferences: payload })
    });
  } catch (err) {
    console.warn("[Prefs] Sync error:", err);
  }
}

function applyAccountPreferences(prefs) {
  if (!prefs || typeof prefs !== "object") return;

  let needChartRedraw = false;

  if (Array.isArray(prefs.activeIndicators)) {
    chartActiveIndicators = new Set(prefs.activeIndicators);
    localStorage.setItem("crypto_chart_indicators", JSON.stringify(prefs.activeIndicators));
    needChartRedraw = true;
  }

  if (Array.isArray(prefs.activeSmc)) {
    chartActiveSmc = new Set(prefs.activeSmc);
    localStorage.setItem("crypto_chart_smc", JSON.stringify(prefs.activeSmc));
    needChartRedraw = true;
  }

  if (Array.isArray(prefs.activeFormations)) {
    chartActiveFormations = new Set(prefs.activeFormations);
    localStorage.setItem("crypto_chart_formations", JSON.stringify(prefs.activeFormations));
    needChartRedraw = true;
  }

  if (prefs.drawingsBySymbol && typeof prefs.drawingsBySymbol === "object") {
    for (const [sym, drawings] of Object.entries(prefs.drawingsBySymbol)) {
      if (Array.isArray(drawings) && drawings.length > 0) {
        localStorage.setItem("crypto_drawings_" + sym, JSON.stringify(drawings));
        trackSymbolWithDrawings(sym, true);
      }
    }
    loadDrawings();
    needChartRedraw = true;
  }

  if (prefs.toolColors && typeof prefs.toolColors === "object") {
    toolColors = { ...DEFAULT_TOOL_COLORS, ...prefs.toolColors };
    localStorage.setItem("crypto_tool_colors", JSON.stringify(toolColors));
    if (typeof applyToolButtonColors === "function") applyToolButtonColors();
  }

  if (prefs.candleSettings && typeof prefs.candleSettings === "object") {
    if (window.candleSettings) Object.assign(window.candleSettings, prefs.candleSettings);
    localStorage.setItem("screener-candle-settings", JSON.stringify(prefs.candleSettings));
  }
  if (prefs.volumeSettings && typeof prefs.volumeSettings === "object") {
    if (window.volumeSettings) Object.assign(window.volumeSettings, prefs.volumeSettings);
    localStorage.setItem("screener-volume-settings", JSON.stringify(prefs.volumeSettings));
  }

  if (typeof syncIndicatorButtonsUI === "function") {
    syncIndicatorButtonsUI();
  }

  if (needChartRedraw) {
    if (typeof requestDraw === "function") requestDraw();
    if (typeof drawChart === "function") requestAnimationFrame(drawChart);
  }
}

window.applyAccountPreferences = applyAccountPreferences;
window.syncPreferencesToServer = syncPreferencesToServer;

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
  if (chartDrawings.length > 0) {
    localStorage.setItem(
      "crypto_drawings_" + activeSym,
      JSON.stringify(chartDrawings),
    );
    trackSymbolWithDrawings(activeSym, true);
  } else {
    localStorage.removeItem("crypto_drawings_" + activeSym);
    trackSymbolWithDrawings(activeSym, false);
  }
  if (typeof chartInstances !== "undefined" && Array.isArray(chartInstances)) {
    chartInstances.forEach(inst => { if (inst && inst.sym === activeSym) inst.draw(true); });
  }
  schedulePreferencesSync();
};
const saveToolColors = () => {
  localStorage.setItem("crypto_tool_colors", JSON.stringify(toolColors));
  schedulePreferencesSync();
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
const KLINES_CACHE_TTL_MS = 300000;
const KLINES_CACHE = new Map();
let klFetchToken = 0;
const marketListeners = new Map();
let mainMarketUnsubscribe = null;
let mainMarketKey = null;
let lastMarketEventAt = 0;
let lastLatencyPaintAt = 0;

function marketKey(ex, sym, tf) { return `${ex}|${sym}|${tf}`; }

function sendMarketSubscription(type, ex, sym, tf) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({ type, ex, sym, tf })); } catch (_) {}
}

function subscribeMarketData({ ex, sym, tf, onKline, onTick, onStatus }) {
  const key = marketKey(ex, sym, tf);
  let listeners = marketListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    marketListeners.set(key, listeners);
    sendMarketSubscription("subscribe_kline", ex, sym, tf);
  }
  const listener = { onKline, onTick, onStatus };
  listeners.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = marketListeners.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      marketListeners.delete(key);
      sendMarketSubscription("unsubscribe_kline", ex, sym, tf);
    }
  };
}

function dispatchMarketMessage(msg) {
  const listeners = marketListeners.get(marketKey(msg.ex, msg.sym, msg.tf));
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      if (msg.type === "kline") listener.onKline?.(msg.data, msg);
      else if (msg.type === "market_tick") listener.onTick?.(msg.data, msg);
      else if (msg.type === "market_status") listener.onStatus?.(msg.status, msg);
    } catch (_) {}
  }
}

function hasMainMarketStream() {
  return mainMarketKey === marketKey(activeEx, activeSym, activeTf) && marketListeners.has(mainMarketKey);
}

window.MarketData = { subscribe: subscribeMarketData };

// тХРтХРтХР 240fps Engine via MessageChannel тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
// MessageChannel posts fire faster than setTimeout(0) and are not throttled
// by the browser's 60fps rAF budget тАФ giving us ~240fps logic ticks.
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

// тФАтФА Clean V-Sync Aligned High-Fidelity Lerp Interpolator ( Butter-Smooth Price Motion ) тФАтФА
function processTickData(dt) {
  const clampedDt = Math.min(dt, 0.05);

  // 1. Interpolate all active coin prices with smooth exponential lerp (no teleportation)
  if (interpActive.size > 0) {
    const keysToRemove = [];
    for (const [key, info] of interpActive) {
      const c = coins.get(key);
      if (!c) { keysToRemove.push(key); continue; }
      if (!c.displayP) { c.displayP = c.p; keysToRemove.push(key); continue; }
      checkPriceAlerts(c.ex, c.sym, c.p);

      const diff = c.p - c.displayP;
      const absDiff = Math.abs(diff);

      if (absDiff < 1e-9) {
        c.displayP = c.p;
        keysToRemove.push(key);
      } else {
        // Ultra-responsive smooth exponential lerp (fast & buttery smooth 120 FPS Glide)
        const factor = 1 - Math.exp(-35 * clampedDt);
        c.displayP += diff * factor;
        dirty.add(key);
      }
    }
    keysToRemove.forEach(k => interpActive.delete(k));
  }

  // 2. DOM updates for dirty rows
  if (dirty.size > 0 || needRebuild) {
    const now2 = performance.now();
    if ((needRebuild || now2 - lastSort > 1000) && (lastSort === 0 || now2 - lastSort > 1000)) {
      rebuildList();
      lastSort = now2;
      needRebuild = false;
    } else {
      let processed = 0;
      for (const key of dirty) {
        updateRow(key);
        dirty.delete(key);
        processed++;
        if (processed >= 40) break;
      }
    }
    if (needRebuild) dirty.clear();
    lastRender = now2;
  }

  // 3. Update main chart active coin OHLC in REAL TIME using smooth displayP
  const activeKey = `${activeEx}:${activeSym}`;
  const ac = coins.get(activeKey);
  if (ac && candles.length > 0) {
    const last = candles[candles.length - 1];
    const tfMs = TF_MS[activeTf] || 60000;
    const now = Date.now();
    const expectedCandleStart = Math.floor(now / tfMs) * tfMs;

    // Check if we passed a timeframe boundary and need to spawn a new candle instantly
    if (expectedCandleStart > last.t && !hasMainMarketStream()) {
      const newCandle = {
        t: expectedCandleStart,
        o: last.c,
        h: last.c,
        l: last.c,
        c: last.c,
        v: 0
      };
      candles.push(newCandle);
      if (candles.length > 1500) candles.shift();
      clearCandleCaches(candles);
      if (offsetX > 0) offsetX++;
      chartNeedsDraw = true;
    }

    const curLast = candles[candles.length - 1];
    if (!hasMainMarketStream()) {
      const liveP = getDisplayP(ac);
      if (liveP > 0 && curLast) {
        // Price scale sanity check: ensure liveP is on same price scale as curLast (ratio 0.4 to 2.5)
        const ratio = curLast.c > 0 ? liveP / curLast.c : 1;
        if (ratio > 0.4 && ratio < 2.5) {
          if (curLast.c !== liveP) {
            curLast.c = liveP;
            if (liveP > curLast.h) curLast.h = liveP;
            if (liveP < curLast.l) last.l = liveP;
            chartNeedsDraw = true;
          }

          const oc = document.getElementById("oc");
          if (oc) {
            const pStr = fP(liveP);
            if (oc._lastPStr !== pStr) {
              oc.textContent = pStr;
              oc._lastPStr = pStr;
            }
          }
        }
      }
    }
  }

  if (screenerView === "multichart" || activeView === "formations") {
    if (typeof chartInstances !== "undefined" && Array.isArray(chartInstances) && chartInstances.length > 0) {
      for (let i = 0; i < chartInstances.length; i++) {
        const inst = chartInstances[i];
        if (inst && inst.key) {
          const c = coins.get(inst.key);
          if (c && c.p > 0) inst.update(c);
        } else if (inst && inst.candles && inst.candles.length > 0) {
          inst.draw();
        }
      }
    }
  }
}

function startMcLoop() {
  // Deprecated: Tick processing now cleanly integrated into rAF loop
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

// тХРтХРтХР Utils тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
window.onerror = (m, s, l, c, e) => {
  console.error("Global error:", m, "at", s, ":", l);
  if (document.getElementById("lt")) {
    document.getElementById("lt").textContent = "Ошибка: " + m;
  }
};

const $ = (id) => document.getElementById(id);

const fP = (n) => {
  if (n === 0) return "0.00";
  if (n == null || isNaN(n)) return "–";
  const absN = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  if (absN >= 1000) {
    return sign + absN.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Dynamic precision based on absolute value to avoid huge jumps and clean negative diffs
  let p = 2;
  if (absN < 0.00001) p = 8;
  else if (absN < 0.001) p = 7;
  else if (absN < 0.1) p = 6;
  else if (absN < 1) p = 5;
  else if (absN < 10) p = 4;
  else if (absN < 100) p = 3;
  else p = 2;

  return sign + absN.toFixed(p);
};

const fV = (n) => {
  if (!n || isNaN(n)) return "тАУ";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return n.toFixed(0);
};

const fC = (n) => {
  if (n == null || isNaN(n)) return "тАУ";
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
};

const fT = (v) => {
  if (!v || isNaN(v)) return "0";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return Math.round(v).toString();
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function getClampedOffsetX(val) {
  if (!candles || !candles.length) return -6;
  const PW = (chartW || 1000) - (typeof PR_WIDTH !== 'undefined' ? PR_WIDTH : 82);
  const n = Math.max(1, PW / (candleW || 10));
  const minOff = -(n - 5);
  const maxOff = Math.max(0, candles.length - 2);
  return Math.max(minOff, Math.min(maxOff, val));
}

function getOiRawPct(c) {
  if (!c) return 0;
  if (Number.isFinite(c.oiPct)) return clamp(c.oiPct, 1, 100);

  // Оборачиваемость ОИ (" -честному"): 
  // Чтобы   было такого, что 30% монет бьются в потолок 100%, мы сильно ужесточаем фильтр.
  // Теперь проверяется оборачиваемость ОИ   1 час (c.v / 24) вместо 4 часов.
  // Чтобы выбить 100% метрики, монета   проторговать ВЕСЬ свой открытый интерес в течение ОДНОГО часа!
  // Это оставит   100% только единичные, самые мощно пампящиеся монеты.
  if (Number.isFinite(c.oi) && c.oi > 0 && c.v > 0) return clamp(((c.v / 24) / c.oi) * 100, 1, 100);

  return 0;
}

function getOiPct(c) {
  if (!c) return 0;

  if (c.oi && c.oi > 0) return getOiRawPct(c);

  // Универсальный прокси ОИ для бирж   нативных данных (Asterdex, Binance, BingX и т.д.)
  // Используем усреднение   топовым биржам, которые отдают ОИ   сокетам
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

// тХРтХРтХР Chart тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
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

// тФАтФАтФА Chart draw helpers тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

// тФАтФА Indicator Calculations (Memoized for max 120fps smooth performance) тФАтФА
function clearCandleCaches(data) {
  if (data && data._cache) delete data._cache;
}

function calcEMA(data, period) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = `ema_${period}`;
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  const k = 2 / (period + 1);
  let ema = new Array(data.length);
  ema[0] = data[0].c;
  for (let i = 1; i < data.length; i++) {
    ema[i] = data[i].c * k + ema[i - 1] * (1 - k);
  }
  ema._len = data.length;
  ema._lastC = lastC;
  ema._lastT = lastT;
  data._cache[key] = ema;
  return ema;
}

function calcBB(data, period = 20, stdDevMult = 2) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = `bb_${period}_${stdDevMult}`;
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  let bb = new Array(data.length);
  if (data.length < period) {
    for (let i = 0; i < data.length; i++) bb[i] = { middle: 0, upper: 0, lower: 0 };
  } else {
    for (let i = 0; i < period - 1; i++) bb[i] = { middle: 0, upper: 0, lower: 0 };
    for (let i = period - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += data[j].c;
      const mean = sum / period;
      let varianceSum = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const diff = data[j].c - mean;
        varianceSum += diff * diff;
      }
      const stdDev = Math.sqrt(varianceSum / period);
      bb[i] = {
        middle: mean,
        upper: mean + stdDevMult * stdDev,
        lower: mean - stdDevMult * stdDev
      };
    }
  }
  bb._len = data.length;
  bb._lastC = lastC;
  bb._lastT = lastT;
  data._cache[key] = bb;
  return bb;
}

function calcVWAP(data) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = "vwap";
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  let vwap = new Array(data.length);
  let sumPV = 0, sumV = 0;
  for (let i = 0; i < data.length; i++) {
    const tp = (data[i].h + data[i].l + data[i].c) / 3;
    sumPV += tp * data[i].v;
    sumV += data[i].v;
    vwap[i] = sumV > 0 ? sumPV / sumV : tp;
  }
  vwap._len = data.length;
  vwap._lastC = lastC;
  vwap._lastT = lastT;
  data._cache[key] = vwap;
  return vwap;
}

function calcVolumeSMA(data, period = 20) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastV = data[data.length - 1].v || 0;
  const lastT = data[data.length - 1].t;
  const key = `vol_sma_${period}`;
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastV === lastV && data._cache[key]._lastT === lastT) {
    return data._cache[key];
  }

  const sma = new Array(data.length);
  let runningSum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i].v) || 0;
    runningSum += v;
    if (i >= period) {
      runningSum -= (Number(data[i - period].v) || 0);
      sma[i] = runningSum / period;
    } else {
      sma[i] = runningSum / (i + 1);
    }
  }
  sma._len = data.length;
  sma._lastV = lastV;
  sma._lastT = lastT;
  data._cache[key] = sma;
  return sma;
}

function calcRSI(data, period = 14) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = `rsi_${period}`;
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  let rsi = new Array(data.length).fill(50);
  if (data.length > period) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = data[i].c - data[i - 1].c;
      if (diff > 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < data.length; i++) {
      const diff = data[i].c - data[i - 1].c;
      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
      rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
  }
  rsi._len = data.length;
  rsi._lastC = lastC;
  rsi._lastT = lastT;
  data._cache[key] = rsi;
  return rsi;
}

function calcATR(data, period = 14) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = `atr_${period}`;
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  let atr = new Array(data.length).fill(0);
  if (data.length > 0) {
    let trSum = 0;
    for (let i = 1; i < data.length; i++) {
      const h = data[i].h, l = data[i].l, pc = data[i - 1].c;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      if (i <= period) {
        trSum += tr;
        if (i === period) atr[i] = trSum / period;
      } else {
        atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
      }
    }
  }
  atr._len = data.length;
  atr._lastC = lastC;
  atr._lastT = lastT;
  data._cache[key] = atr;
  return atr;
}

function calcMACD(data, shortP = 12, longP = 26, signalP = 9) {
  if (!data || data.length === 0) return { macd: [], signal: [], hist: [] };
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = `macd_${shortP}_${longP}_${signalP}`;
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  const emaS = calcEMA(data, shortP);
  const emaL = calcEMA(data, longP);
  let macd = new Array(data.length).fill(0);
  for (let i = 0; i < data.length; i++) macd[i] = emaS[i] - emaL[i];

  const k = 2 / (signalP + 1);
  let signal = new Array(data.length).fill(0);
  signal[0] = macd[0];
  for (let i = 1; i < data.length; i++) signal[i] = macd[i] * k + signal[i - 1] * (1 - k);

  let hist = new Array(data.length).fill(0);
  for (let i = 0; i < data.length; i++) hist[i] = macd[i] - signal[i];

  const res = { macd, signal, hist, _len: data.length, _lastC: lastC, _lastT: lastT };
  data._cache[key] = res;
  return res;
}

function calcCVD(data) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = "cvd";
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  let cvd = new Array(data.length).fill(0);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const range = Math.max(1e-8, c.h - c.l);
    const buyR = (c.c - c.l) / range;
    const sellR = (c.h - c.c) / range;
    const netVol = (c.v || 0) * (buyR - sellR);
    sum += netVol;
    cvd[i] = sum;
  }
  cvd._len = data.length;
  cvd._lastC = lastC;
  cvd._lastT = lastT;
  data._cache[key] = cvd;
  return cvd;
}

function calcOI(data) {
  if (!data || data.length === 0) return [];
  if (!data._cache) data._cache = {};
  const lastC = data[data.length - 1].c;
  const lastT = data[data.length - 1].t;
  const key = `oi_${data.length}`;
  if (data._cache[key] && data._cache[key]._len === data.length && data._cache[key]._lastC === lastC && data._cache[key]._lastT === lastT) return data._cache[key];

  const oi = new Array(data.length);
  const ticker = (typeof activeEx !== "undefined" && typeof activeSym !== "undefined" && typeof coins !== "undefined")
    ? coins.get(activeEx + ":" + activeSym) : null;

  let hasExplicitOI = false;
  for (let i = 0; i < data.length; i++) {
    if (typeof data[i].oi === "number" && Number.isFinite(data[i].oi) && data[i].oi > 0) {
      hasExplicitOI = true;
      oi[i] = data[i].oi;
    }
  }

  if (!hasExplicitOI) {
    const currentOI = (ticker && ticker.oi && ticker.oi > 0) ? ticker.oi : (ticker && ticker.v ? ticker.v * 0.22 : 12500000);
    
    let meanVol = 0;
    for (let i = 0; i < data.length; i++) meanVol += (data[i].v || 0);
    meanVol = (meanVol / data.length) || 1;

    const deltaOI = new Array(data.length).fill(0);
    for (let i = 1; i < data.length; i++) {
      const c = data[i];
      const prev = data[i - 1];
      const ret = prev.c > 0 ? (c.c - prev.c) / prev.c : 0;
      const relVol = Math.min(4, Math.max(0.2, (c.v || 0) / meanVol));
      const range = Math.max(1e-8, c.h - c.l);
      const buyRatio = (c.c - c.l) / range;
      const sellRatio = (c.h - c.c) / range;
      const netFlow = buyRatio - sellRatio;

      const change = (netFlow * 0.007 + ret * 0.014) * relVol;
      deltaOI[i] = change;
    }

    oi[data.length - 1] = currentOI;
    for (let i = data.length - 2; i >= 0; i--) {
      const nextVal = oi[i + 1];
      const factor = 1 + deltaOI[i + 1];
      oi[i] = Math.max(currentOI * 0.2, nextVal / Math.max(0.85, Math.min(1.15, factor)));
    }

    const smooth = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(data.length - 1, i + 1); j++) {
        sum += oi[j];
        count++;
      }
      smooth[i] = sum / count;
    }
    for (let i = 0; i < data.length; i++) oi[i] = smooth[i];
  }

  oi._len = data.length;
  oi._lastC = lastC;
  oi._lastT = lastT;
  data._cache[key] = oi;
  return oi;
}

function getSmcData(candles) {
  if (!candles || candles.length < 20) return null;
  const lastT = candles[candles.length - 1].t;
  const key = `smc_${candles.length}_${lastT}`;
  if (candles._smcCache && candles._smcCache.key === key) {
    return candles._smcCache.data;
  }

  const numCandles = candles.length;
  // Deep scan of history (up to 800 candles) for comprehensive structural perspective
  const startVisIdx = Math.max(0, numCandles - 800);

  // ATR array for precision normalization
  const atrArr = new Array(numCandles).fill(0);
  {
    let trSum = 0;
    for (let i = 1; i < numCandles; i++) {
      const pc = candles[i - 1].c;
      const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc));
      trSum += tr;
      atrArr[i] = i <= 14 ? trSum / i : (atrArr[i - 1] * 13 + tr) / 14;
    }
  }
  const atrAt = i => atrArr[Math.min(numCandles - 1, Math.max(1, i))] || (candles[i]?.c ? candles[i].c * 0.005 : 1e-9);

  // 1. Dual-Scale Swing Fractals (W=3 for responsive structure, W=5 for major macro points)
  const swings = [];
  for (let i = Math.max(3, startVisIdx); i < numCandles - 3; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) swings.push({ idx: i, price: candles[i].h, type: "high" });
    if (isLow)  swings.push({ idx: i, price: candles[i].l, type: "low" });
  }

  // 2. Textbook Market Structure Shifts (MSS / CHoCH) & Break of Structure (BOS)
  const structureBreaks = [];
  let currentTrend = null;
  let lastMajorHigh = null;
  let lastMajorLow = null;

  for (let i = Math.max(0, startVisIdx); i < numCandles; i++) {
    const c = candles[i];

    if (lastMajorHigh && c.c > lastMajorHigh.price) {
      const isChoch = currentTrend === 'bear';
      structureBreaks.push({
        type: isChoch ? "CHoCH ▲" : "BOS ▲",
        startIdx: lastMajorHigh.idx,
        breakIdx: i,
        price: lastMajorHigh.price,
        isBull: true
      });
      currentTrend = 'bull';
      lastMajorHigh = null;
    } else if (lastMajorLow && c.c < lastMajorLow.price) {
      const isChoch = currentTrend === 'bull';
      structureBreaks.push({
        type: isChoch ? "CHoCH ▼" : "BOS ▼",
        startIdx: lastMajorLow.idx,
        breakIdx: i,
        price: lastMajorLow.price,
        isBull: false
      });
      currentTrend = 'bear';
      lastMajorLow = null;
    }

    const foundSwing = swings.find(s => s.idx === i - 3);
    if (foundSwing) {
      if (foundSwing.type === 'high') lastMajorHigh = foundSwing;
      if (foundSwing.type === 'low') lastMajorLow = foundSwing;
    }
  }

  // 3. TEXTBOOK ICT / SMC ORDER BLOCKS (Hardcore Institutional Quality)
  const orderBlocks = [];
  const processedOrigins = new Set();

  for (const sb of structureBreaks) {
    const breakIdx = sb.breakIdx;
    const isBull = sb.isBull;

    // A. Find the authoritative textbook Origin Candle at the crest/trough of the swing
    let obCandleIdx = -1;
    let extremePrice = isBull ? Infinity : -Infinity;

    for (let k = breakIdx - 1; k >= Math.max(0, breakIdx - 25); k--) {
      const c = candles[k];
      if (isBull) {
        if (c.l <= extremePrice) {
          extremePrice = c.l;
          obCandleIdx = k;
        }
      } else {
        if (c.h >= extremePrice) {
          extremePrice = c.h;
          obCandleIdx = k;
        }
      }
    }

    if (obCandleIdx === -1) obCandleIdx = Math.max(0, breakIdx - 1);
    
    // Cluster suppression: never create multiple OBs for the same swing origin cluster
    let duplicateCluster = false;
    for (const origin of processedOrigins) {
      if (Math.abs(origin - obCandleIdx) <= 12) {
        duplicateCluster = true;
        break;
      }
    }
    if (duplicateCluster) continue;
    processedOrigins.add(obCandleIdx);

    const obC = candles[obCandleIdx];
    const zoneH = obC.h - obC.l || 1e-9;
    const atr = atrAt(obCandleIdx);
    const mt = (obC.h + obC.l) / 2; // Mean Threshold (50% equilibrium)

    // B. Displacement Engine: Hardcore institutional impulse requirement
    const legEnd = Math.min(numCandles, obCandleIdx + 7);
    const leg = candles.slice(obCandleIdx + 1, legEnd);
    if (leg.length < 2) continue;

    const legHigh = Math.max(...leg.map(c => c.h));
    const legLow = Math.min(...leg.map(c => c.l));
    const impulseATR = isBull ? (legHigh - obC.h) / atr : (obC.l - legLow) / atr;
    
    // Hardcore filter: must have decisive institutional displacement (>= 1.0 ATR)
    if (impulseATR < 1.0) continue;

    const path = leg.reduce((a, c) => a + (c.h - c.l), 0) || 1e-9;
    const efficiency = Math.abs(leg[leg.length - 1].c - leg[0].o) / path;
    const lastLeg = leg[leg.length - 1];
    const clv = isBull
      ? (lastLeg.c - legLow) / (legHigh - legLow || 1e-9)
      : (legHigh - lastLeg.c) / (legHigh - legLow || 1e-9);

    let dispScore = 0;
    dispScore += impulseATR >= 2.5 ? 20 : impulseATR >= 1.5 ? 15 : 10;
    dispScore += efficiency >= 0.65 ? 12 : efficiency >= 0.45 ? 7 : 3;
    dispScore += clv >= 0.65 ? 6 : 2;

    // C. Structure & Break type
    let structScore = sb.type.includes("CHoCH") ? 16 : 10;
    const swingAge = breakIdx - sb.startIdx;
    structScore += swingAge >= 25 ? 6 : swingAge >= 10 ? 3 : 0;

    // D. Liquidity Sweep before Origin
    let sweepScore = 0;
    const lookFrom = Math.max(1, obCandleIdx - 14);
    for (const sw of swings) {
      if (sw.idx >= obCandleIdx || sw.idx < lookFrom - 3) continue;
      if (isBull && sw.type !== "low") continue;
      if (!isBull && sw.type !== "high") continue;
      for (let k = Math.max(sw.idx + 1, lookFrom); k <= obCandleIdx; k++) {
        const c = candles[k];
        const pierced = isBull ? c.l < sw.price : c.h > sw.price;
        const reclaimed = isBull ? c.c > sw.price : c.c < sw.price;
        if (pierced && reclaimed) { sweepScore = 15; break; }
      }
      if (sweepScore) break;
    }

    // E. FVG / Imbalance Confluence (Mandatory for Grade-A ICT Order Blocks)
    const hasFvg = candles.slice(obCandleIdx + 1, Math.min(numCandles - 1, obCandleIdx + 5)).some((c, idx) => {
      const cIdx = obCandleIdx + 1 + idx;
      if (cIdx < 2 || cIdx >= numCandles) return false;
      return isBull ? (candles[cIdx].l > candles[cIdx - 2].h) : (candles[cIdx].h < candles[cIdx - 2].l);
    });
    const fvgScore = hasFvg ? 15 : 0;

    // F. Volume Confirmation
    const avgVol = candles.slice(Math.max(0, obCandleIdx - 10), obCandleIdx).reduce((a, b) => a + (b.v || 0), 0) / 10;
    const volScore = (obC.v && avgVol && obC.v > avgVol * 1.2) ? 8 : 0;

    // G. Strict Mitigation Tracking (Mean Threshold 50% & Invalidation)
    let touchEpisodes = 0;
    let inZone = false;
    let alive = true;
    for (let k = breakIdx + 1; k < numCandles; k++) {
      const c = candles[k];
      const isTouching = isBull ? c.l <= obC.h && c.h >= obC.l : c.h >= obC.l && c.l <= obC.h;
      if (isTouching && !inZone) touchEpisodes++;
      inZone = isTouching;

      // Invalidation: Real candle body closes beyond Mean Threshold (50%) or wicks through extreme
      if (isBull) {
        if (c.c < mt || c.l < obC.l - (0.10 * atr)) { alive = false; break; }
      } else {
        if (c.c > mt || c.h > obC.h + (0.10 * atr)) { alive = false; break; }
      }
    }
    if (!alive || touchEpisodes >= 3) continue;
    const freshScore = Math.max(0, 15 - touchEpisodes * 5);

    // H. Quality Penalties
    let penalty = 0;
    if (zoneH > 2.0 * atr) penalty += 12;

    const score = Math.max(1, Math.min(100, Math.round(
      dispScore + structScore + sweepScore + fvgScore + freshScore + volScore - penalty
    )));

    // Only high quality setups
    if (score < 45) continue;

    orderBlocks.push({
      type: isBull ? "bull" : "bear",
      startIdx: obCandleIdx,
      endIdx: numCandles - 1 + 12,
      high: obC.h,
      low: obC.l,
      mt,
      score
    });
  }

  // 4. TEXTBOOK ICT / SMC FAIR VALUE GAPS (FVG - Hardcore Quality)
  const fvgs = [];

  for (let i = Math.max(2, startVisIdx); i < numCandles; i++) {
    const c1 = candles[i - 2];
    const c2 = candles[i - 1]; // Central displacement candle
    const c3 = candles[i];
    const atr = atrAt(i);
    const c2Range = c2.h - c2.l || 1e-9;
    const c2Body = Math.abs(c2.c - c2.o);

    // Bullish FVG (SIBI - Sell-Side Imbalance Buy-Side Inefficiency):
    // 1. Structural gap: c3.l > c1.h
    // 2. Middle candle MUST be a strong expansive bull candle (body >= 48% of its range and range >= 0.75 * ATR)
    if (c3.l > c1.h && c2.c > c2.o && (c2Body / c2Range >= 0.48) && (c2Range >= 0.75 * atr)) {
      const gap = c3.l - c1.h;
      const minGap = Math.max(candles[i].c * 0.0010, 0.25 * atr);
      if (gap >= minGap) {
        const topPrice = c3.l;
        const botPrice = c1.h;
        const ce = (topPrice + botPrice) / 2; // Consequent Encroachment (50% midpoint)

        // Mitigation check: if price wicks below botPrice or closes body below CE, it's invalidated
        let filled = false;
        for (let k = i + 1; k < numCandles; k++) {
          const ck = candles[k];
          if (ck.l <= botPrice || ck.c < ce) {
            filled = true;
            break;
          }
        }
        if (!filled) {
          const dispRatio = c2Body / atr;
          const score = Math.min(100, Math.round(dispRatio * 35 + (gap / atr) * 30 + 35));

          fvgs.push({
            type: "bull",
            startIdx: i - 2,
            endIdx: numCandles - 1 + 12,
            topPrice,
            botPrice,
            ce,
            score
          });
        }
      }
    }

    // Bearish FVG (BISI - Buy-Side Imbalance Sell-Side Inefficiency):
    // 1. Structural gap: c3.h < c1.l
    // 2. Middle candle MUST be a strong expansive bear candle (body >= 48% of its range and range >= 0.75 * ATR)
    if (c3.h < c1.l && c2.c < c2.o && (c2Body / c2Range >= 0.48) && (c2Range >= 0.75 * atr)) {
      const gap = c1.l - c3.h;
      const minGap = Math.max(candles[i].c * 0.0010, 0.25 * atr);
      if (gap >= minGap) {
        const topPrice = c1.l;
        const botPrice = c3.h;
        const ce = (topPrice + botPrice) / 2; // Consequent Encroachment (50% midpoint)

        let filled = false;
        for (let k = i + 1; k < numCandles; k++) {
          const ck = candles[k];
          if (ck.h >= topPrice || ck.c > ce) {
            filled = true;
            break;
          }
        }
        if (!filled) {
          const dispRatio = c2Body / atr;
          const score = Math.min(100, Math.round(dispRatio * 35 + (gap / atr) * 30 + 35));

          fvgs.push({
            type: "bear",
            startIdx: i - 2,
            endIdx: numCandles - 1 + 12,
            topPrice,
            botPrice,
            ce,
            score
          });
        }
      }
    }
  }

  // 5. Liquidity Pools (Unswept EQH / EQL)
  const liquidityPools = [];
  const majorHighs = swings.filter(s => s.type === 'high');
  const majorLows = swings.filter(s => s.type === 'low');

  for (let i = 0; i < majorHighs.length; i++) {
    for (let j = i + 1; j < majorHighs.length; j++) {
      const h1 = majorHighs[i];
      const h2 = majorHighs[j];
      if (Math.abs(h1.price - h2.price) / h1.price <= 0.0015) {
        const poolPrice = Math.max(h1.price, h2.price);
        let swept = false;
        for (let k = h2.idx + 1; k < numCandles; k++) {
          if (candles[k].h > poolPrice) { swept = true; break; }
        }
        if (!swept) {
          liquidityPools.push({ type: "EQH", idx1: h1.idx, idx2: h2.idx, price: poolPrice });
          break;
        }
      }
    }
  }

  for (let i = 0; i < majorLows.length; i++) {
    for (let j = i + 1; j < majorLows.length; j++) {
      const l1 = majorLows[i];
      const l2 = majorLows[j];
      if (Math.abs(l1.price - l2.price) / l1.price <= 0.0015) {
        const poolPrice = Math.min(l1.price, l2.price);
        let swept = false;
        for (let k = l2.idx + 1; k < numCandles; k++) {
          if (candles[k].l < poolPrice) { swept = true; break; }
        }
        if (!swept) {
          liquidityPools.push({ type: "EQL", idx1: l1.idx, idx2: l2.idx, price: poolPrice });
          break;
        }
      }
    }
  }

  const res = { orderBlocks, fvgs, structureBreaks, liquidityPools };
  candles._smcCache = { key, data: res };
  return res;
}

function renderSmartMoneyConcepts(ctx, candles, s, vis, candleW, futureGap, toY, PW, PH, TOP, viewStart) {
  if (!candles || candles.length === 0 || !chartActiveSmc || chartActiveSmc.size === 0) return;

  const smcData = getSmcData(candles);
  if (!smcData) return;

  const lastPrice = candles[candles.length - 1].c;

  const getCandleX = (idx) => {
    return Math.round((idx - viewStart) * candleW + candleW / 2);
  };

  const drawSmcPill = (text, cx, cy, bg, border, textCol) => {
    ctx.save();
    ctx.font = "bold 10px Inter, sans-serif";
    const tw = ctx.measureText(text).width;
    const paddingX = 7;
    const paddingY = 3;
    const w = tw + paddingX * 2;
    const h = 18;
    const bx = Math.max(5, Math.min(PW - w - 5, cx - w / 2));
    const by = Math.max(TOP + 5, Math.min(TOP + PH - h - 5, cy - h / 2));

    ctx.beginPath();
    ctx.roundRect(bx, by, w, h, 4);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = textCol;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + w / 2, by + h / 2);
    ctx.restore();
  };

  // Spatial Non-Maximum Suppression (NMS) – completely eliminates overlapping duplicate OBs
  function deduplicateOBs(list, maxCount = 2) {
    const sorted = list.slice().sort((a, b) => b.score - a.score || b.startIdx - a.startIdx);
    const selected = [];

    for (const ob of sorted) {
      let isOverlap = false;
      for (const existing of selected) {
        // Vertical price overlap check
        const overlapTop = Math.min(ob.high, existing.high);
        const overlapBot = Math.max(ob.low, existing.low);
        if (overlapTop > overlapBot) {
          const overlapH = overlapTop - overlapBot;
          const h1 = ob.high - ob.low || 1e-9;
          const h2 = existing.high - existing.low || 1e-9;
          // If zones overlap by > 12% vertically, reject duplicate
          if (overlapH / h1 > 0.12 || overlapH / h2 > 0.12) {
            isOverlap = true;
            break;
          }
        }
        // Time proximity check: same swing origin within 16 candles
        if (Math.abs(ob.startIdx - existing.startIdx) <= 16) {
          isOverlap = true;
          break;
        }
      }
      if (!isOverlap) {
        selected.push(ob);
        if (selected.length >= maxCount) break;
      }
    }
    return selected;
  }

  function deduplicateFVGs(list, maxCount = 2) {
    const sorted = list.slice().sort((a, b) => (b.score || 0) - (a.score || 0) || b.startIdx - a.startIdx);
    const selected = [];

    for (const fvg of sorted) {
      let isOverlap = false;
      for (const existing of selected) {
        const overlapTop = Math.min(fvg.topPrice, existing.topPrice);
        const overlapBot = Math.max(fvg.botPrice, existing.botPrice);
        if (overlapTop > overlapBot) {
          const overlapH = overlapTop - overlapBot;
          const h1 = fvg.topPrice - fvg.botPrice || 1e-9;
          const h2 = existing.topPrice - existing.botPrice || 1e-9;
          if (overlapH / h1 > 0.15 || overlapH / h2 > 0.15) {
            isOverlap = true;
            break;
          }
        }
        if (Math.abs(fvg.startIdx - existing.startIdx) <= 10) {
          isOverlap = true;
          break;
        }
      }
      if (!isOverlap) {
        selected.push(fvg);
        if (selected.length >= maxCount) break;
      }
    }
    return selected;
  }

  // 1. UNMITIGATED ORDER BLOCKS (OB) - Deduped & Clean
  // Always projected 12 candles forward ahead of the chart right edge
  // Label: strictly "OB"
  if (chartActiveSmc.has("ob") && smcData.orderBlocks.length > 0) {
    const bullOBs = deduplicateOBs(
      smcData.orderBlocks.filter(ob => ob.type === "bull" && ob.high <= lastPrice),
      2
    );

    const bearOBs = deduplicateOBs(
      smcData.orderBlocks.filter(ob => ob.type === "bear" && ob.low >= lastPrice),
      2
    );

    const activeOBs = [...bullOBs, ...bearOBs];

    for (const ob of activeOBs) {
      const rawX1 = getCandleX(ob.startIdx);
      const targetEndIdx = ob.endIdx != null ? Math.max(ob.endIdx, candles.length - 1 + 12) : (candles.length - 1 + 12);
      const rawX2 = getCandleX(targetEndIdx);
      const x1 = Math.max(0, rawX1);
      const x2 = Math.min(PW, rawX2);
      if (x2 <= 0 || x1 >= PW) continue;
      const boxW = Math.max(15, x2 - x1);
      const yTop = toY(ob.high);
      const yBot = toY(ob.low);
      const h = Math.max(4, yBot - yTop);

      if (yBot < TOP || yTop > TOP + PH) continue;

      ctx.save();
      if (ob.type === "bull") {
        ctx.fillStyle = "rgba(38, 201, 122, 0.14)";
        ctx.fillRect(x1, yTop, boxW, h);
        ctx.strokeStyle = "rgba(38, 201, 122, 0.75)";
        ctx.strokeRect(x1, yTop, boxW, h);
        drawSmcPill("OB", x1 + 25, yTop + h / 2, "#14532d", "#22c55e", "#4ade80");
      } else {
        ctx.fillStyle = "rgba(255, 69, 96, 0.14)";
        ctx.fillRect(x1, yTop, boxW, h);
        ctx.strokeStyle = "rgba(255, 69, 96, 0.75)";
        ctx.strokeRect(x1, yTop, boxW, h);
        drawSmcPill("OB", x1 + 25, yTop + h / 2, "#7f1d1d", "#ef4444", "#fca5a5");
      }
      ctx.restore();
    }
  }

  // 2. UNFILLED FAIR VALUE GAPS (FVG) - Deduped & Clean
  // Always projected 12 candles forward ahead of the chart right edge
  // Label: strictly "FVG"
  if (chartActiveSmc.has("fvg") && smcData.fvgs.length > 0) {
    const bullFVGs = deduplicateFVGs(
      smcData.fvgs.filter(fvg => fvg.type === "bull" && fvg.topPrice <= lastPrice),
      2
    );

    const bearFVGs = deduplicateFVGs(
      smcData.fvgs.filter(fvg => fvg.type === "bear" && fvg.botPrice >= lastPrice),
      2
    );

    const activeFVGs = [...bullFVGs, ...bearFVGs];

    for (const fvg of activeFVGs) {
      const rawX1 = getCandleX(fvg.startIdx);
      const targetEndIdx = fvg.endIdx != null ? Math.max(fvg.endIdx, candles.length - 1 + 12) : (candles.length - 1 + 12);
      const rawX2 = getCandleX(targetEndIdx);
      const x1 = Math.max(0, rawX1);
      const x2 = Math.min(PW, rawX2);
      if (x2 <= 0 || x1 >= PW) continue;
      const boxW = Math.max(15, x2 - x1);
      const yTop = toY(fvg.topPrice);
      const yBot = toY(fvg.botPrice);
      const h = Math.max(3, yBot - yTop);

      if (yBot < TOP || yTop > TOP + PH) continue;

      ctx.save();
      if (fvg.type === "bull") {
        ctx.fillStyle = "rgba(6, 182, 212, 0.14)";
        ctx.fillRect(x1, yTop, boxW, h);
        ctx.strokeStyle = "rgba(6, 182, 212, 0.65)";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x1, yTop, boxW, h);
        drawSmcPill("FVG", x1 + 25, yTop + h / 2, "#164e63", "#06b6d4", "#67e8f9");
      } else {
        ctx.fillStyle = "rgba(168, 85, 247, 0.14)";
        ctx.fillRect(x1, yTop, boxW, h);
        ctx.strokeStyle = "rgba(168, 85, 247, 0.65)";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x1, yTop, boxW, h);
        drawSmcPill("FVG", x1 + 25, yTop + h / 2, "#581c87", "#a855f7", "#e9d5ff");
      }
      ctx.restore();
    }
  }
}

function getLiqMapData(candles) {
  if (!candles || candles.length < 20) return null;
  const lastC = candles[candles.length - 1].c;
  const lastT = candles[candles.length - 1].t;
  const key = `liq_${candles.length}_${lastT}_${lastC}`;
  if (candles._liqCache && candles._liqCache.key === key) {
    return candles._liqCache.data;
  }

  const numCandles = candles.length;
  const startScan = Math.max(0, numCandles - 250);
  const pivots = [];

  for (let i = startScan + 2; i < numCandles - 2; i++) {
    const isHigh = candles[i].h > candles[i - 1].h && candles[i].h > candles[i - 2].h &&
                   candles[i].h > candles[i + 1].h && candles[i].h > candles[i + 2].h;
    const isLow  = candles[i].l < candles[i - 1].l && candles[i].l < candles[i - 2].l &&
                   candles[i].l < candles[i + 1].l && candles[i].l < candles[i + 2].l;
    if (isHigh) pivots.push({ idx: i, price: candles[i].h, type: "high", vol: candles[i].v });
    if (isLow)  pivots.push({ idx: i, price: candles[i].l, type: "low", vol: candles[i].v });
  }

  const LEVERAGES = [
    { lev: "100x", offsetLong: 0.009, offsetShort: 0.009, weight: 1.0 },
    { lev: "50x",  offsetLong: 0.018, offsetShort: 0.018, weight: 0.85 },
    { lev: "25x",  offsetLong: 0.037, offsetShort: 0.037, weight: 0.65 },
  ];

  const liqLevels = [];

  for (const p of pivots) {
    for (const levInfo of LEVERAGES) {
      if (p.type === "high") {
        const liqPrice = p.price * (1 + levInfo.offsetShort);
        let swept = false;
        for (let k = p.idx + 1; k < numCandles; k++) {
          if (candles[k].h >= liqPrice) {
            swept = true;
            break;
          }
        }
        if (!swept) {
          liqLevels.push({
            type: "short",
            lev: levInfo.lev,
            price: liqPrice,
            startIdx: p.idx,
            estVolK: Math.round((p.vol || 500) * levInfo.weight)
          });
        }
      } else {
        const liqPrice = p.price * (1 - levInfo.offsetLong);
        let swept = false;
        for (let k = p.idx + 1; k < numCandles; k++) {
          if (candles[k].l <= liqPrice) {
            swept = true;
            break;
          }
        }
        if (!swept) {
          liqLevels.push({
            type: "long",
            lev: levInfo.lev,
            price: liqPrice,
            startIdx: p.idx,
            estVolK: Math.round((p.vol || 500) * levInfo.weight)
          });
        }
      }
    }
  }

  const clusters = [];
  for (const item of liqLevels) {
    const existing = clusters.find(c => c.type === item.type && Math.abs(c.price - item.price) / item.price < 0.0025);
    if (existing) {
      existing.volK += item.estVolK;
      existing.count += 1;
      if (item.lev === "100x" || existing.topLev === "100x") existing.topLev = "100x";
    } else {
      clusters.push({
        type: item.type,
        price: item.price,
        startIdx: item.startIdx,
        volK: item.estVolK,
        topLev: item.lev,
        count: 1
      });
    }
  }

  candles._liqCache = { key, data: clusters };
  return clusters;
}

function renderLiquidationHeatmap(ctx, candles, s, vis, candleW, futureGap, toY, PW, PH, TOP, viewStart) {
  if (!candles || candles.length < 20) return;

  const clusters = getLiqMapData(candles);
  if (!clusters || !clusters.length) return;

  const getCandleX = (idx) => (idx - viewStart) * candleW + candleW / 2;
  const lastPrice = candles[candles.length - 1].c;

  const maxVol = Math.max(...clusters.map(c => c.volK), 1);
  const activeClusters = clusters
    .map(c => ({ ...c, dist: Math.abs(lastPrice - c.price) / lastPrice }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, TOP, PW, PH);
  ctx.clip();

  for (const cl of activeClusters) {
    const y = toY(cl.price);
    if (y < TOP || y > TOP + PH) continue;

    const x1 = Math.max(0, getCandleX(cl.startIdx));
    const x2 = PW;
    const intensity = Math.min(1.0, cl.volK / maxVol);

    const bandH = Math.max(4, Math.round(intensity * 14));
    const yTop = y - bandH / 2;

    let gradColorCenter, gradColorEdge, strokeColor;
    if (intensity > 0.65) {
      gradColorCenter = `rgba(250, 204, 21, ${0.25 + intensity * 0.35})`;
      gradColorEdge = "rgba(250, 204, 21, 0.02)";
      strokeColor = `rgba(250, 204, 21, ${0.7 + intensity * 0.3})`;
    } else if (intensity > 0.35) {
      gradColorCenter = `rgba(6, 182, 212, ${0.2 + intensity * 0.3})`;
      gradColorEdge = "rgba(6, 182, 212, 0.02)";
      strokeColor = `rgba(6, 182, 212, 0.65)`;
    } else {
      gradColorCenter = `rgba(168, 85, 247, ${0.15 + intensity * 0.25})`;
      gradColorEdge = "rgba(168, 85, 247, 0.02)";
      strokeColor = `rgba(168, 85, 247, 0.55)`;
    }

    const grad = ctx.createLinearGradient(0, yTop, 0, yTop + bandH);
    grad.addColorStop(0, gradColorEdge);
    grad.addColorStop(0.5, gradColorCenter);
    grad.addColorStop(1, gradColorEdge);

    ctx.fillStyle = grad;
    ctx.fillRect(x1, yTop, x2 - x1, bandH);

    ctx.beginPath();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = intensity > 0.65 ? 1.5 : 1.0;
    ctx.setLineDash(intensity > 0.65 ? [] : [4, 3]);
    ctx.moveTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.stroke();

    const volStr = cl.volK >= 1000 ? (cl.volK / 1000).toFixed(1) + "M" : cl.volK + "K";
    const badgeText = `${cl.topLev} $${volStr} Liq`;

    ctx.font = "bold 9px Inter";
    const badgeW = ctx.measureText(badgeText).width + 10;
    const badgeH = 15;
    const bx = PW - badgeW - 6;
    const by = Math.max(TOP + 2, Math.min(y - badgeH / 2, TOP + PH - badgeH - 2));

    ctx.save();
    roundRect(ctx, bx, by, badgeW, badgeH, 4);
    ctx.fillStyle = cl.type === "short" ? "rgba(127, 29, 29, 0.9)" : "rgba(20, 83, 45, 0.9)";
    ctx.fill();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();

    ctx.fillStyle = cl.type === "short" ? "#fca5a5" : "#4ade80";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(badgeText, bx + badgeW / 2, by + badgeH / 2);
    ctx.restore();
  }

  ctx.restore();
}

// ════════════════════════════════════════════════════════════
const CHART_EXCHANGE_NAMES = {
  BN: "Binance", BB: "Bybit", OX: "OKX", BG: "Bitget", GT: "Gate",
  MX: "MEXC", KC: "KuCoin", BX: "BingX", HT: "HTX", HL: "Hyperliquid", AD: "Asterdex"
};

function drawDensityTimelineOnChart(ctx, options) {
  if (!chartDensityEnabled) return [];
  const { candles: chartCandles, base, candleWidth, viewStart, toY, PW, PH, TOP = 0 } = options;
  if (!chartCandles || !chartCandles.length || !base) return [];

  const source = densityData.map(wall => ({ ...wall, active: true, endedAt: null }));
  const rangeStart = chartCandles[0].t;
  const observedTf = chartCandles.length > 1
    ? Math.max(1, chartCandles[chartCandles.length - 1].t - chartCandles[chartCandles.length - 2].t)
    : 60000;
  const rangeEnd = chartCandles[chartCandles.length - 1].t + observedTf;

  const walls = source.filter(w => {
    if (isBaseInDensityBlacklist(w.base, w.sym)) return false;
    if (w.base !== base) return false;
    if (chartDensitySide !== "all" && w.side !== chartDensitySide) return false;
    if (chartDensityMarket !== "all" && w.market !== chartDensityMarket) return false;
    if (!chartDensityExes.has(w.ex)) return false;
    const sizeType = getDensitySizeType(w);
    if (!chartDensitySizes.has(sizeType)) return false;
    const startedAt = Number(w.firstSeenAt) || Date.now();
    const endedAt = Number(w.endedAt) || rangeEnd;
    return startedAt <= rangeEnd && endedAt >= rangeStart;
  }).sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || (b.S || 0) - (a.S || 0));

  const badges = [];
  const occupiedLabelY = [];
  const visibleWalls = walls.slice(0, 80);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, TOP, PW, PH);
  ctx.clip();

  for (const wall of visibleWalls) {
    const y = toY(Number(wall.price));
    if (!Number.isFinite(y) || y < TOP || y > TOP + PH) continue;

    const startIdx = getIdxFromTime(Number(wall.firstSeenAt) || rangeStart, chartCandles);
    const endIdx = wall.active || !wall.endedAt
      ? getIdxFromTime(rangeEnd, chartCandles)
      : getIdxFromTime(Number(wall.endedAt), chartCandles);
    const rawStartX = (startIdx - viewStart) * candleWidth + candleWidth / 2;
    const rawEndX = wall.active || !wall.endedAt
      ? PW
      : (endIdx - viewStart) * candleWidth + candleWidth / 2;
    if (rawEndX < 0 || rawStartX > PW) continue;

    const startX = Math.max(0, rawStartX);
    const endX = Math.max(startX + 1, Math.min(PW, rawEndX));
    const isBid = wall.side === "bid";
    const active = wall.active !== false && !wall.endedAt;
    const rgb = isBid ? [38, 201, 122] : [255, 69, 96];

    // Clean, crisp solid line (NO gradient shimmers/fades)
    ctx.strokeStyle = active ? `rgba(${rgb.join(',')}, 0.85)` : `rgba(${rgb.join(',')}, 0.40)`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(active ? [] : [4, 4]);
    ctx.beginPath();
    ctx.moveTo(startX, Math.round(y) - 0.5);
    ctx.lineTo(endX, Math.round(y) - 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    if (active && rawStartX >= -80 && rawStartX <= PW - 30) {
      const timeText = new Date(Number(wall.firstSeenAt) || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const usd = Number(wall.S) || Number(wall.maxSizeUsd) || 0;
      const sizeText = usd >= 1000000 ? `$${(usd / 1000000).toFixed(1).replace(/\.0$/, "")}M` : `$${Math.round(usd / 1000)}K`;
      const label = `${timeText}  ${CHART_EXCHANGE_NAMES[wall.ex] || wall.ex}  ${sizeText}`;
      ctx.font = "700 9px Inter";
      const labelW = ctx.measureText(label).width + 12;
      let labelY = y - 18;
      while (occupiedLabelY.some(existing => Math.abs(existing - labelY) < 16)) labelY += 16;
      labelY = Math.max(TOP + 2, Math.min(TOP + PH - 17, labelY));
      occupiedLabelY.push(labelY);
      const labelX = Math.max(3, Math.min(PW - labelW - 3, Math.max(3, rawStartX + 5)));
      roundRect(ctx, labelX, labelY, labelW, 16, 4);
      ctx.fillStyle = "rgba(15, 18, 24, 0.95)";
      ctx.fill();
      ctx.strokeStyle = `rgba(${rgb.join(',')}, 0.65)`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = `rgb(${rgb.join(',')})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, labelX + labelW / 2, labelY + 8);
    }

    if (active) badges.push({ y, price: wall.price, isBid, baseColorArr: rgb });
  }

  ctx.restore();
  return badges;
}

// Formations Overlay – renders formation levels on main chart
// ════════════════════════════════════════════════════════════
function renderFormationsOnChart(ctx, candles, s, candleW, futureGap, toY, PW, PH, TOP, viewStart) {
  if (!chartFormationsOnChart || !candles || candles.length < 40) return [];

  const N = candles.length;
  const lastPrice = candles[N - 1].c;
  const getCandleX = (idx) => Math.round((idx - viewStart) * candleW + candleW / 2);
  const scaleBadges = [];

  const fmtColors = window.formationColorSettings || {
    cascadeUp: "#94a3b8", cascadeUpOp: 75,
    cascadeDown: "#94a3b8", cascadeDownOp: 75,
    trendlineUp: "#94a3b8", trendlineUpOp: 75,
    trendlineDown: "#94a3b8", trendlineDownOp: 75,
    level: "#94a3b8", levelOp: 75,
    retest: "#94a3b8", retestOp: 75
  };

  const getFmtColor = (hex, op = 75) => (typeof hexToRgba === "function") ? hexToRgba(hex, op) : hex;
  const getFmtDotColor = (hex, op = 75) => (typeof hexToRgba === "function") ? hexToRgba(hex, Math.min(100, (Number(op) || 75) + 15)) : hex;

  // ─── 1. CASCADES ───
  const hasCascades = chartActiveFormations.has('cascades') || chartFovTypes.has('cascades');
  if (hasCascades) {
    let levels = window.FormationEngine
      ? getCachedFormationDetection(candles, `overlay:cascades:${chartFovCascadesMin}`, () => window.FormationEngine.detectCascades(candles, chartFovCascadesMin))
      : [];

    if (chartFovNearest && levels.length > 0) {
      levels.sort((a, b) => Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice));
      levels = levels.slice(0, 6);
    }

    for (const lv of levels) {
      const y = toY(lv.price);
      if (y < TOP || y > TOP + PH) continue;

      const isUp = (lv.direction === "up" || lv.price >= lastPrice);
      const lineColor = isUp ? getFmtColor(fmtColors.cascadeUp, fmtColors.cascadeUpOp) : getFmtColor(fmtColors.cascadeDown, fmtColors.cascadeDownOp);
      const touchColor = isUp ? getFmtDotColor(fmtColors.cascadeUp, fmtColors.cascadeUpOp) : getFmtDotColor(fmtColors.cascadeDown, fmtColors.cascadeDownOp);

      const startIdx = lv.swingTime ? getIdxFromTime(lv.swingTime, candles) : ((typeof lv.swingIdx === 'number') ? lv.swingIdx : 0);
      const startX = Math.max(0, getCandleX(startIdx));

      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(PW, y);
      ctx.stroke();

      // Touch circles at touchIndices (or swingIdx)
      if (chartFovShowTouches) {
        ctx.fillStyle = touchColor;
        const touchesArr = Array.isArray(lv.touchIndices) ? lv.touchIndices : [lv.swingIdx];
        for (let i = 0; i < touchesArr.length; i++) {
          const origIdx = touchesArr[i];
          const time = lv.touchTimes ? lv.touchTimes[i] : null;
          const ti = time ? getIdxFromTime(time, candles) : origIdx;
          if (typeof ti !== 'number') continue;
          const tx = getCandleX(ti);
          if (tx >= 0 && tx <= PW) {
            ctx.beginPath();
            ctx.arc(tx, y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();

      scaleBadges.push({ price: lv.price, y, color: lineColor });
    }
  }

  // ─── 2. HORIZONTAL LEVELS ───
  const hasLevels = chartActiveFormations.has('levels') || chartFovTypes.has('levels');
  if (hasLevels) {
    let levels = window.FormationEngine
      ? getCachedFormationDetection(candles, `overlay:levels:${chartFovCascadesMin}`, () => window.FormationEngine.detectHorizontals(candles, chartFovCascadesMin))
      : [];

    const minTouches = Math.max(1, chartFovCascadesMin || 1);
    levels = levels.filter(lv => (lv.touches || 1) >= minTouches);

    if (chartFovNearest && levels.length > 0) {
      levels.sort((a, b) => Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice));
      levels = levels.slice(0, 4);
    }

    const lineColor = getFmtColor(fmtColors.level, fmtColors.levelOp);
    const touchColor = getFmtDotColor(fmtColors.level, fmtColors.levelOp);

    for (const lv of levels) {
      const y = toY(lv.price);
      if (y < TOP || y > TOP + PH) continue;

      const startIdx = lv.swingTime ? getIdxFromTime(lv.swingTime, candles) : ((typeof lv.swingIdx === 'number') ? lv.swingIdx : 0);
      const startX = Math.max(0, getCandleX(startIdx));

      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(PW, y);
      ctx.stroke();

      if (chartFovShowTouches) {
        ctx.fillStyle = touchColor;
        const touchesArr = Array.isArray(lv.touchIndices) ? lv.touchIndices : [lv.swingIdx];
        for (let i = 0; i < touchesArr.length; i++) {
          const origIdx = touchesArr[i];
          const time = lv.touchTimes ? lv.touchTimes[i] : null;
          const ti = time ? getIdxFromTime(time, candles) : origIdx;
          if (typeof ti !== 'number') continue;
          const tx = getCandleX(ti);
          if (tx >= 0 && tx <= PW) {
            ctx.beginPath();
            ctx.arc(tx, y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();

      scaleBadges.push({ price: lv.price, y, color: lineColor });
    }
  }

  // ─── 3. TRENDLINES ───
  const hasTrendlines = chartActiveFormations.has('trendlines') || chartFovTypes.has('trendlines');
  if (hasTrendlines) {
    let trendlines = window.FormationEngine
      ? getCachedFormationDetection(candles, `overlay:trendline:${chartFovCascadesMin}`, () => window.FormationEngine.detectTrendlines(candles, chartFovCascadesMin))
      : [];
    const minTouches = Math.max(1, chartFovCascadesMin || 2);
    trendlines = trendlines.filter(tl => (tl.touches || 1) >= minTouches);

    for (const tl of trendlines) {
      const isUp = (tl.direction === "up");
      const lineColor = isUp ? getFmtColor(fmtColors.trendlineUp, fmtColors.trendlineUpOp) : getFmtColor(fmtColors.trendlineDown, fmtColors.trendlineDownOp);
      const touchColor = isUp ? getFmtDotColor(fmtColors.trendlineUp, fmtColors.trendlineUpOp) : getFmtDotColor(fmtColors.trendlineDown, fmtColors.trendlineDownOp);

      const idx1 = tl.p1.t ? getIdxFromTime(tl.p1.t, candles) : tl.p1.idx;
      const extIdx = N - 1 + 8;
      const x1 = getCandleX(idx1);
      const x2 = Math.min(PW, getCandleX(extIdx));
      const y1 = toY(tl.p1.price);
      const y2 = toY(tl.p1.price + tl.slope * (extIdx - idx1));
      if ((x1 < 0 && x2 < 0) || (x1 > PW && x2 > PW)) continue;
      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (chartFovShowTouches && tl.swingIndices) {
        ctx.fillStyle = touchColor;
        for (let i = 0; i < tl.swingIndices.length; i++) {
          const origIdx = tl.swingIndices[i];
          const time = tl.touchTimes ? tl.touchTimes[i] : null;
          const ti = time ? getIdxFromTime(time, candles) : origIdx;
          const tx = getCandleX(ti);
          const ty = toY(tl.p1.price + tl.slope * (ti - idx1));
          if (tx < 0 || tx > PW) continue;
          ctx.beginPath();
          ctx.arc(tx, ty, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      if (typeof tl.endPrice === 'number' && Number.isFinite(tl.endPrice)) {
        const currentY = toY(tl.endPrice);
        scaleBadges.push({ price: tl.endPrice, y: currentY, color: lineColor });
      }
    }
  }

  // ─── 4. RETESTS ───
  const hasRetests = chartActiveFormations.has('retests') || chartFovTypes.has('retests');
  if (hasRetests) {
    let retests = [];
    if (window.FormationEngine) {
      retests = getCachedFormationDetection(candles, 'overlay:retest', () => window.FormationEngine.detectRetests(candles));
    }

    if (chartFovNearest && retests.length > 0) {
      retests.sort((a, b) => Math.abs(a.price - lastPrice) - Math.abs(b.price - lastPrice));
      retests = retests.slice(0, 2);
    }

    const lineColor = getFmtColor(fmtColors.retest, fmtColors.retestOp);
    const touchColor = getFmtDotColor(fmtColors.retest, fmtColors.retestOp);

    for (const rt of retests) {
      const y = toY(rt.price);
      if (y < TOP || y > TOP + PH) continue;

      const startIdx = rt.swingTime ? getIdxFromTime(rt.swingTime, candles) : ((typeof rt.swingIdx === 'number') ? rt.swingIdx : 0);
      const startX = Math.max(0, getCandleX(startIdx));

      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1.35;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(PW, y);
      ctx.stroke();

      if (chartFovShowTouches) {
        ctx.fillStyle = touchColor;
        const touchesArr = Array.isArray(rt.touchIndices) ? rt.touchIndices : [rt.swingIdx, rt.touchIdx];
        for (let i = 0; i < touchesArr.length; i++) {
          const origIdx = touchesArr[i];
          if (typeof origIdx !== 'number') continue;
          const time = rt.touchTimes ? rt.touchTimes[i] : null;
          const ti = time ? getIdxFromTime(time, candles) : origIdx;
          const tx = getCandleX(ti);
          if (tx >= 0 && tx <= PW) {
            ctx.beginPath();
            ctx.arc(tx, y, 2.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();

      scaleBadges.push({ price: rt.price, y, color: lineColor });
    }
  }

  return scaleBadges;
}


function drawChart() {
  if (!candles.length || !chartW || !chartH) return;


  // Calculate active indicators first to determine volH
  const activeIndicators = [];
  if (chartActiveIndicators.has("RSI")) activeIndicators.push("RSI");
  if (chartActiveIndicators.has("MACD")) activeIndicators.push("MACD");
  if (chartActiveIndicators.has("CVD")) activeIndicators.push("CVD");
  if (chartActiveIndicators.has("ATR")) activeIndicators.push("ATR");
  if (chartActiveIndicators.has("OI")) activeIndicators.push("OI");

  // Volume takes 75px, indicators take 80px each for clean professional charts
  const fixedVolumeHeight = 75;
  const indicatorHeightPer = 80;
  const newVolH = fixedVolumeHeight + (activeIndicators.length * indicatorHeightPer);

  // Update volH if needed and adjust canvas
  const dpr = window.devicePixelRatio || 1;
  if (newVolH !== volH) {
    volH = newVolH;
    const volCanvas = document.getElementById('vol-canvas');
    if (volCanvas) {
      volCanvas.height = volH * dpr;
      volCanvas.style.height = volH + 'px';
      vCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  // Layout
  const PR = 82;
  const PW = chartW - PR;
  const PH = chartH - volH - 1;
  const TOP = 0;
  if (PH <= 20) return;

  // тФАтФА Background тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  ctx.clearRect(0, 0, chartW, chartH);
  ctx.fillStyle = getCanvasBgColor();
  ctx.fillRect(0, 0, chartW, chartH);
  
  vCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vCtx.clearRect(0, 0, chartW, volH);
  vCtx.fillStyle = getCanvasBgColor();
  vCtx.fillRect(0, 0, chartW, volH);

  // тФАтФА Visible candle window тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  const n = Math.max(1, PW / candleW);
  const viewStart = candles.length - n - offsetX;
  const s = Math.max(0, Math.floor(viewStart));
  const e = Math.min(candles.length, s + Math.ceil(n) + 2);
  const vis = candles.slice(s, e);
  const futureGap = viewStart < 0 ? -viewStart : 0;
  if (!vis.length && futureGap <= 0.5) return;

  // Infinite scroll: dynamically load older historical candles when approaching left edge
  if (viewStart < 80 && candles.length > 0 && !isLoadingOlderCandles && !hasReachedStartOfHistory) {
    loadOlderHistory(activeEx, activeSym, activeTf);
  }

  // тФАтФА Auto price range тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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
  const autoPad = (autoMx - autoMn) * 0.15 || autoMx * 0.01 || 0.01;
  autoMn = Math.max(0, autoMn - autoPad);
  autoMx += autoPad;
  if (viewMn == null || viewMx == null || !Number.isFinite(viewMn) || !Number.isFinite(viewMx) || autoFitY) {
    // Snap the scale instead of easing: switching coin/TF or replacing the
    // candle set must not look like the chart slowly melts into place.
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

  // тФАтФА Grid lines тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

  // тФАтФА Clipping Area (Pre-render) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PW, PH);
  ctx.clip();

  // тФАтФА Candles тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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
    const rawX = (s + i - viewStart) * candleW + candleW / 2;
    const up = c.c >= c.o;

    const yH = toY(c.h),
      yL = toY(c.l);
    const yO = toY(c.o),
      yC = toY(c.c);
    const bT = Math.min(yO, yC),
      bH = Math.max(1, Math.abs(yC - yO));

    if (cs.wick.show) {
      const wickX = (Math.floor(rawX * dpr) + 0.5) / dpr;
      const wickYH = Math.round(yH * dpr) / dpr;
      const wickYL = Math.round(yL * dpr) / dpr;
      ctx.strokeStyle = up ? upWickCol : dnWickCol;
      ctx.lineWidth = 1 / dpr;
      ctx.beginPath();
      ctx.moveTo(wickX, wickYH);
      ctx.lineTo(wickX, wickYL);
      ctx.stroke();
    }

    if (cs.body.show) {
      const leftX = Math.round((rawX - hw) * dpr);
      const rightX = Math.round((rawX + hw) * dpr);
      const topY = Math.round(bT * dpr);
      const bottomY = Math.round((bT + bH) * dpr);

      const fillX = leftX / dpr;
      const fillY = topY / dpr;
      const fillW = Math.max(1 / dpr, (rightX - leftX) / dpr);
      const fillH = Math.max(1 / dpr, (bottomY - topY) / dpr);

      ctx.fillStyle = up ? upBodyCol : dnBodyCol;
      ctx.fillRect(fillX, fillY, fillW, fillH);
    }

    if (cs.border.show && candleW > 10) {
      const strokeLeftX = (Math.floor((rawX - hw) * dpr) + 0.5) / dpr;
      const strokeTopY = (Math.floor(bT * dpr) + 0.5) / dpr;
      const strokeRightX = (Math.floor((rawX + hw) * dpr) + 0.5) / dpr;
      const strokeBottomY = (Math.floor((bT + bH) * dpr) + 0.5) / dpr;

      const strokeW = Math.max(1 / dpr, strokeRightX - strokeLeftX);
      const strokeH = Math.max(1 / dpr, strokeBottomY - strokeTopY);

      ctx.strokeStyle = up ? upBorderCol : dnBorderCol;
      ctx.lineWidth = 1 / dpr;
      ctx.strokeRect(strokeLeftX, strokeTopY, strokeW, strokeH);
    }
  });

  // тФАтФА Draw Overlay Indicators on Chart тФАтФА
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, TOP, PW, PH);
  ctx.clip();

  // 1. Volume Profile (VP) with POC
  if (chartActiveIndicators.has("VP")) {
    const bins = {};
    let maxBinVol = 0;
    let pocPrice = 0;
    const binSize = pr * 0.025 || 0.1;
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      const bin = Math.floor(c.c / binSize) * binSize;
      bins[bin] = (bins[bin] || 0) + c.v;
      if (bins[bin] > maxBinVol) {
        maxBinVol = bins[bin];
        pocPrice = bin + binSize / 2;
      }
    }

    // Draw Profile Bins on the RIGHT
    for (const bin in bins) {
      const p = parseFloat(bin);
      const y = toY(p);
      const yBottom = toY(p + binSize);
      const height = Math.abs(yBottom - y);
      const width = (bins[bin] / maxBinVol) * (PW * 0.20); // Max 20% width
      const isPOC = Math.abs(p + binSize / 2 - pocPrice) < binSize * 0.1;
      ctx.fillStyle = isPOC ? "rgba(255, 69, 96, 0.5)" : "rgba(108, 93, 211, 0.15)";
      ctx.fillRect(PW - width, yBottom, width, height - 1);
    }

    // Draw Point of Control (POC) Label ONLY (no long line)
    if (pocPrice > 0) {
      const pocY = toY(pocPrice);
      const pocWidth = (maxBinVol / maxBinVol) * (PW * 0.20);
      // Label POC centered on the red bin
      ctx.fillStyle = "#ff4560";
      ctx.font = "bold 10px Inter";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("POC " + fP(pocPrice), PW - pocWidth / 2, pocY);
    }
  }

  // 2. Bollinger Bands (BB)
  if (chartActiveIndicators.has("BB")) {
    const bb = calcBB(candles);

    // Draw Upper Band
    ctx.beginPath();
    ctx.strokeStyle = "rgba(167, 139, 250, 0.5)";
    ctx.lineWidth = 1.2;
    for (let i = 0; i < vis.length; i++) {
      const val = bb[s + i];
      if (val && val.upper) {
        const x = (s + i - viewStart) * candleW + candleW / 2;
        const y = toY(val.upper);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Draw Lower Band
    ctx.beginPath();
    for (let i = 0; i < vis.length; i++) {
      const val = bb[s + i];
      if (val && val.lower) {
        const x = (s + i - viewStart) * candleW + candleW / 2;
        const y = toY(val.lower);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // 3. EMA 20
  if (chartActiveIndicators.has("EMA 20")) {
    const ema20 = calcEMA(candles, 20);
    ctx.beginPath();
    ctx.strokeStyle = "#4ade80"; // Bright Green
    ctx.lineWidth = 1.5;
    for (let i = 0; i < vis.length; i++) {
      const val = ema20[s + i];
      if (val) {
        const x = (s + i - viewStart) * candleW + candleW / 2;
        const y = toY(val);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // 4. EMA 50
  if (chartActiveIndicators.has("EMA 50")) {
    const ema50 = calcEMA(candles, 50);
    ctx.beginPath();
    ctx.strokeStyle = "#facc15"; // Bright Yellow
    ctx.lineWidth = 1.5;
    for (let i = 0; i < vis.length; i++) {
      const val = ema50[s + i];
      if (val) {
        const x = (s + i - viewStart) * candleW + candleW / 2;
        const y = toY(val);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // 5. EMA 200
  if (chartActiveIndicators.has("EMA 200")) {
    const ema200 = calcEMA(candles, 200);
    ctx.beginPath();
    ctx.strokeStyle = "#f87171"; // Bright Red
    ctx.lineWidth = 1.8;
    for (let i = 0; i < vis.length; i++) {
      const val = ema200[s + i];
      if (val) {
        const x = (s + i - viewStart) * candleW + candleW / 2;
        const y = toY(val);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // 6. VWAP
  if (chartActiveIndicators.has("VWAP")) {
    const vwap = calcVWAP(candles);
    ctx.beginPath();
    ctx.strokeStyle = "#38bdf8"; // Sky Blue
    ctx.lineWidth = 1.5;
    for (let i = 0; i < vis.length; i++) {
      const val = vwap[s + i];
      if (val) {
        const x = (s + i - viewStart) * candleW + candleW / 2;
        const y = toY(val);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  // тФАтФА Smart Money Concepts (SMC) Overlay тФАтФА
  renderSmartMoneyConcepts(ctx, candles, s, vis, candleW, futureGap, toY, PW, PH, TOP, viewStart);

  // тФАтФА Liquidation Heatmap Overlay тФАтФА
  if (chartActiveIndicators.has("LIQMAP")) {
    renderLiquidationHeatmap(ctx, candles, s, vis, candleW, futureGap, toY, PW, PH, TOP, viewStart);
  }

  // Formations Overlay
  const formationScaleBadges = renderFormationsOnChart(ctx, candles, s, candleW, futureGap, toY, PW, PH, TOP, viewStart) || [];

  ctx.restore();


  // тФАтФА Draw Sub-indicators / Oscillators in separated rows of Volume Pane тФАтФА
  // activeIndicators is already calculated above!

  // Fixed heights (already defined above, reuse variables)
  const volumeHeight = fixedVolumeHeight;
  const indicatorsHeight = activeIndicators.length === 0 ? 0 : (activeIndicators.length * indicatorHeightPer);

  // Draw indicators first (top part)
  if (activeIndicators.length > 0) {
    const indicatorSubH = indicatorsHeight / activeIndicators.length;
    activeIndicators.forEach((subType, subIdx) => {
      const yStart = subIdx * indicatorSubH;

      vCtx.save();
      vCtx.beginPath();
      vCtx.rect(0, yStart, PW, indicatorSubH);
      vCtx.clip();

      // Fill background for this sub-panel
      vCtx.fillStyle = getCanvasBgColor();
      vCtx.fillRect(0, yStart, PW, indicatorSubH);

      // Draw sub-panel border/divider
      vCtx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      vCtx.lineWidth = 1;
      vCtx.beginPath();
      vCtx.moveTo(0, yStart);
      vCtx.lineTo(PW, yStart);
      vCtx.stroke();

      if (subType === "RSI") {
        const rsi = calcRSI(candles, 14);
        const lastVal = rsi[rsi.length - 1];

        const padTop = 22;
        const padBot = 10;
        const plotH = indicatorSubH - padTop - padBot;

        const y70 = yStart + padTop + plotH * (1 - 70 / 100);
        const y50 = yStart + padTop + plotH * (1 - 50 / 100);
        const y30 = yStart + padTop + plotH * (1 - 30 / 100);

        // Fill 30-70 channel
        vCtx.fillStyle = "rgba(139, 92, 246, 0.08)";
        vCtx.fillRect(0, y70, PW, y30 - y70);

        // Dash lines
        vCtx.strokeStyle = "rgba(255, 255, 255, 0.18)";
        vCtx.setLineDash([4, 4]);
        vCtx.lineWidth = 1;

        vCtx.beginPath();
        vCtx.moveTo(0, y30); vCtx.lineTo(PW, y30);
        vCtx.moveTo(0, y50); vCtx.lineTo(PW, y50);
        vCtx.moveTo(0, y70); vCtx.lineTo(PW, y70);
        vCtx.stroke();
        vCtx.setLineDash([]);

        // Draw levels labels on the right
        vCtx.fillStyle = "rgba(255, 255, 255, 0.45)";
        vCtx.font = "bold 9px Inter";
        vCtx.textAlign = "right";
        vCtx.fillText("70", PW - 6, y70 - 2);
        vCtx.fillText("50", PW - 6, y50 - 2);
        vCtx.fillText("30", PW - 6, y30 - 2);

        // Draw RSI Curve
        vCtx.beginPath();
        vCtx.strokeStyle = "#a78bfa";
        vCtx.lineWidth = 2;
        for (let i = 0; i < vis.length; i++) {
          const val = rsi[s + i];
          if (val != null) {
            const x = (s + i - viewStart) * candleW + candleW / 2;
            const y = yStart + padTop + plotH * (1 - Math.max(0, Math.min(100, val)) / 100);
            if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
          }
        }
        vCtx.stroke();

        // Big clear label
        const rsiColor = lastVal >= 70 ? "#22c55e" : lastVal <= 30 ? "#ef4444" : "#a78bfa";
        vCtx.fillStyle = rsiColor;
        vCtx.font = "bold 11px Inter";
        vCtx.textAlign = "left";
        vCtx.textBaseline = "top";
        vCtx.fillText(`RSI (14): ${lastVal != null ? lastVal.toFixed(2) : "N/A"}`, 10, yStart + 6);
        vCtx.textAlign = "right";
        vCtx.fillText(`RSI: ${lastVal != null ? lastVal.toFixed(2) : "N/A"}`, PW - 6, yStart + 6);

      } else if (subType === "ATR") {
        const atr = calcATR(candles, 14);
        const lastVal = atr[atr.length - 1];
        let maxAtr = 0.00001;
        for (let i = 0; i < vis.length; i++) {
          if (atr[s + i] > maxAtr) maxAtr = atr[s + i];
        }

        const padTop = 22;
        const padBot = 8;
        const plotH = indicatorSubH - padTop - padBot;

        // Area fill
        vCtx.beginPath();
        let firstX = 0, lastX = 0;
        for (let i = 0; i < vis.length; i++) {
          const val = atr[s + i];
          const x = (s + i - viewStart) * candleW + candleW / 2;
          const y = yStart + padTop + plotH * (1 - Math.min(1, Math.max(0, (val || 0) / maxAtr)));
          if (i === 0) { firstX = x; vCtx.moveTo(x, yStart + indicatorSubH); vCtx.lineTo(x, y); }
          else vCtx.lineTo(x, y);
          lastX = x;
        }
        vCtx.lineTo(lastX, yStart + indicatorSubH);
        vCtx.closePath();
        vCtx.fillStyle = "rgba(251, 146, 60, 0.08)";
        vCtx.fill();

        // Stroke
        vCtx.beginPath();
        vCtx.strokeStyle = "#fb923c"; // ATR Orange
        vCtx.lineWidth = 2;
        for (let i = 0; i < vis.length; i++) {
          const val = atr[s + i];
          const x = (s + i - viewStart) * candleW + candleW / 2;
          const y = yStart + padTop + plotH * (1 - Math.min(1, Math.max(0, (val || 0) / maxAtr)));
          if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
        }
        vCtx.stroke();

        vCtx.fillStyle = "#fb923c";
        vCtx.font = "bold 11px Inter";
        vCtx.textAlign = "left";
        vCtx.textBaseline = "top";
        vCtx.fillText(`ATR (14): ${lastVal != null ? fP(lastVal) : "N/A"}`, 10, yStart + 6);
        vCtx.textAlign = "right";
        vCtx.fillText(`ATR: ${lastVal != null ? fP(lastVal) : "N/A"}`, PW - 6, yStart + 6);

      } else if (subType === "MACD") {
        const macdData = calcMACD(candles);
        const lastM = macdData.macd[macdData.macd.length - 1];
        const lastS = macdData.signal[macdData.signal.length - 1];
        const lastH = macdData.hist[macdData.hist.length - 1];

        let maxMacd = 0.00001;
        for (let i = 0; i < vis.length; i++) {
          const idx = s + i;
          const mVal = Math.max(Math.abs(macdData.macd[idx] || 0), Math.abs(macdData.signal[idx] || 0), Math.abs(macdData.hist[idx] || 0));
          if (mVal > maxMacd) maxMacd = mVal;
        }

        const padTop = 22;
        const padBot = 8;
        const plotH = indicatorSubH - padTop - padBot;
        const yZero = yStart + padTop + plotH / 2;

        // Zero line
        vCtx.strokeStyle = "rgba(255, 255, 255, 0.2)";
        vCtx.lineWidth = 1;
        vCtx.beginPath();
        vCtx.moveTo(0, yZero);
        vCtx.lineTo(PW, yZero);
        vCtx.stroke();

        // Hist bars
        const barW = Math.max(2, candleW - 2);
        for (let i = 0; i < vis.length; i++) {
          const val = macdData.hist[s + i] || 0;
          const x = (s + i - viewStart) * candleW + candleW / 2;
          const yVal = yZero - (val / maxMacd) * (plotH / 2);
          vCtx.fillStyle = val >= 0 ? "rgba(34, 197, 94, 0.8)" : "rgba(239, 68, 68, 0.8)";
          vCtx.fillRect(x - barW / 2, Math.min(yZero, yVal), barW, Math.max(1, Math.abs(yZero - yVal)));
        }

        // MACD Line (Blue)
        vCtx.beginPath();
        vCtx.strokeStyle = "#38bdf8";
        vCtx.lineWidth = 2;
        for (let i = 0; i < vis.length; i++) {
          const val = macdData.macd[s + i] || 0;
          const x = (s + i - viewStart) * candleW + candleW / 2;
          const y = yZero - (val / maxMacd) * (plotH / 2);
          if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
        }
        vCtx.stroke();

        // Signal Line (Orange)
        vCtx.beginPath();
        vCtx.strokeStyle = "#f59e0b";
        vCtx.lineWidth = 2;
        for (let i = 0; i < vis.length; i++) {
          const val = macdData.signal[s + i] || 0;
          const x = (s + i - viewStart) * candleW + candleW / 2;
          const y = yZero - (val / maxMacd) * (plotH / 2);
          if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
        }
        vCtx.stroke();

        vCtx.font = "bold 11px Inter";
        vCtx.textAlign = "left";
        vCtx.textBaseline = "top";
        vCtx.fillStyle = "#38bdf8";
        vCtx.fillText(`MACD: ${lastM != null ? lastM.toFixed(4) : "0"}`, 10, yStart + 6);
        vCtx.fillStyle = "#f59e0b";
        vCtx.fillText(`Signal: ${lastS != null ? lastS.toFixed(4) : "0"}`, 120, yStart + 6);
        vCtx.fillStyle = lastH >= 0 ? "#22c55e" : "#ef4444";
        vCtx.fillText(`Hist: ${lastH != null ? (lastH >= 0 ? "+" : "") + lastH.toFixed(4) : "0"}`, 230, yStart + 6);

        vCtx.textAlign = "right";
        vCtx.fillStyle = "#38bdf8";
        vCtx.fillText(`MACD: ${lastM != null ? lastM.toFixed(4) : "0"}`, PW - 6, yStart + 6);

      } else if (subType === "CVD") {
        const cvd = calcCVD(candles);
        const lastVal = cvd[cvd.length - 1];
        let minCvd = Infinity, maxCvd = -Infinity;
        for (let i = 0; i < vis.length; i++) {
          const val = cvd[s + i];
          if (val != null) {
            if (val < minCvd) minCvd = val;
            if (val > maxCvd) maxCvd = val;
          }
        }
        if (!Number.isFinite(minCvd)) { minCvd = -100; maxCvd = 100; }
        const pad = Math.max(10, (maxCvd - minCvd) * 0.1);
        minCvd -= pad;
        maxCvd += pad;
        const cvdRange = maxCvd - minCvd || 1;

        const padTop = 22;
        const padBot = 8;
        const plotH = indicatorSubH - padTop - padBot;
        const yZero = yStart + padTop + plotH * (1 - (0 - minCvd) / cvdRange);

        // Zero reference line
        vCtx.strokeStyle = "rgba(255, 255, 255, 0.2)";
        vCtx.setLineDash([3, 3]);
        vCtx.lineWidth = 1;
        vCtx.beginPath();
        vCtx.moveTo(0, yZero);
        vCtx.lineTo(PW, yZero);
        vCtx.stroke();
        vCtx.setLineDash([]);

        // Area fill
        vCtx.beginPath();
        let firstX = 0, lastX = 0;
        for (let i = 0; i < vis.length; i++) {
          const val = cvd[s + i];
          const x = (s + i - viewStart) * candleW + candleW / 2;
          const y = yStart + padTop + plotH * (1 - (val - minCvd) / cvdRange);
          if (i === 0) { firstX = x; vCtx.moveTo(x, yZero); vCtx.lineTo(x, y); }
          else vCtx.lineTo(x, y);
          lastX = x;
        }
        vCtx.lineTo(lastX, yZero);
        vCtx.closePath();
        vCtx.fillStyle = lastVal >= 0 ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)";
        vCtx.fill();

        // Stroke line
        vCtx.beginPath();
        vCtx.strokeStyle = "#ec4899"; // CVD Pink
        vCtx.lineWidth = 2;
        for (let i = 0; i < vis.length; i++) {
          const val = cvd[s + i];
          if (val != null) {
            const x = (s + i - viewStart) * candleW + candleW / 2;
            const y = yStart + padTop + plotH * (1 - (val - minCvd) / cvdRange);
            if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
          }
        }
        vCtx.stroke();

        vCtx.fillStyle = "#ec4899";
        vCtx.font = "bold 11px Inter";
        vCtx.textAlign = "left";
        vCtx.textBaseline = "top";
        const sign = lastVal >= 0 ? "+" : "";
        vCtx.fillText(`CVD (Volume Delta): ${sign}${fV(lastVal)}`, 10, yStart + 6);
        vCtx.textAlign = "right";
        vCtx.fillText(`CVD: ${sign}${fV(lastVal)}`, PW - 6, yStart + 6);

      } else if (subType === "OI") {
        const oiData = calcOI(candles);
        const lastVal = oiData[oiData.length - 1];
        let minOi = Infinity, maxOi = -Infinity;
        for (let i = 0; i < vis.length; i++) {
          const val = oiData[s + i];
          if (val != null && Number.isFinite(val)) {
            if (val < minOi) minOi = val;
            if (val > maxOi) maxOi = val;
          }
        }
        if (!Number.isFinite(minOi) || minOi === maxOi) { minOi = 0; maxOi = 100; }
        const pad = Math.max(1, (maxOi - minOi) * 0.1);
        minOi -= pad;
        maxOi += pad;
        const oiRange = maxOi - minOi || 1;

        const padTop = 22;
        const padBot = 8;
        const plotH = indicatorSubH - padTop - padBot;

        // Area gradient fill under OI curve
        vCtx.beginPath();
        let firstX = 0, lastX = 0;
        for (let i = 0; i < vis.length; i++) {
          const val = oiData[s + i];
          const x = (s + i - viewStart) * candleW + candleW / 2;
          const y = yStart + padTop + plotH * (1 - (val - minOi) / oiRange);
          if (i === 0) { firstX = x; vCtx.moveTo(x, yStart + indicatorSubH); vCtx.lineTo(x, y); }
          else vCtx.lineTo(x, y);
          lastX = x;
        }
        vCtx.lineTo(lastX, yStart + indicatorSubH);
        vCtx.closePath();
        const oiGrad = vCtx.createLinearGradient(0, yStart + padTop, 0, yStart + indicatorSubH);
        oiGrad.addColorStop(0, "rgba(56, 189, 248, 0.22)");
        oiGrad.addColorStop(1, "rgba(56, 189, 248, 0.01)");
        vCtx.fillStyle = oiGrad;
        vCtx.fill();

        // Stroke line
        vCtx.beginPath();
        vCtx.strokeStyle = "#38bdf8"; // Sky blue
        vCtx.lineWidth = 2;
        for (let i = 0; i < vis.length; i++) {
          const val = oiData[s + i];
          if (val != null) {
            const x = (s + i - viewStart) * candleW + candleW / 2;
            const y = yStart + padTop + plotH * (1 - (val - minOi) / oiRange);
            if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
          }
        }
        vCtx.stroke();

        vCtx.fillStyle = "#38bdf8";
        vCtx.font = "bold 11px Inter";
        vCtx.textAlign = "left";
        vCtx.textBaseline = "top";
        const dispVal = lastVal != null ? (lastVal >= 1000 ? "$" + fV(lastVal) : lastVal.toFixed(2) + "%") : "N/A";
        vCtx.fillText(`OI (Open Interest): ${dispVal}`, 10, yStart + 6);
        vCtx.textAlign = "right";
        vCtx.fillText(`OI: ${dispVal}`, PW - 6, yStart + 6);
      }

      vCtx.restore(); // Important: Restore state after clipping!
    });
  }

  // Draw Volume (Clean Histogram, Project Colors, Linear Proportional Scaling, Subpixel Aligned)
  const volumeYStart = indicatorsHeight;
  vCtx.save();
  vCtx.beginPath();
  vCtx.rect(0, volumeYStart, PW, volumeHeight);
  vCtx.clip();

  // Fill background for volume panel
  vCtx.fillStyle = getCanvasBgColor();
  vCtx.fillRect(0, volumeYStart, PW, volumeHeight);

  // Subtle top border divider
  vCtx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  vCtx.lineWidth = 1;
  vCtx.beginPath();
  vCtx.moveTo(0, volumeYStart);
  vCtx.lineTo(PW, volumeYStart);
  vCtx.stroke();

  const vs = window.volumeSettings || {
    show: true,
    up: "#26c97a",
    upOp: 75,
    down: "#ff4560",
    downOp: 75
  };
  const upVolCol = hexToRgba(vs.up || "#26c97a", vs.upOp ?? 75);
  const dnVolCol = hexToRgba(vs.down || "#ff4560", vs.downOp ?? 75);

  if (vs.show && vis.length > 0) {
    let maxV = 0;
    for (let i = 0; i < vis.length; i++) {
      const v = Number(vis[i]?.v) || 0;
      if (v > maxV) maxV = v;
    }

    if (maxV > 0) {
      const scaleCeiling = maxV * 1.15;
      const usableHeight = volumeHeight - 6;

      for (let i = 0; i < vis.length; i++) {
        const c = vis[i];
        const val = Number(c.v) || 0;
        if (val <= 0) continue;

        const rawX = (s + i - viewStart) * candleW + candleW / 2;
        const leftX = Math.round((rawX - hw) * dpr);
        const rightX = Math.round((rawX + hw) * dpr);
        const fillX = leftX / dpr;
        const fillW = Math.max(1 / dpr, (rightX - leftX) / dpr);

        const vRatio = Math.min(1.0, val / scaleCeiling);
        const vh = Math.max(1.5, vRatio * usableHeight);
        const fillY = volumeYStart + volumeHeight - vh;

        const up = c.c >= c.o;
        vCtx.fillStyle = up ? upVolCol : dnVolCol;
        vCtx.fillRect(fillX, fillY, fillW, vh);
      }
    }
  }
  vCtx.restore();

  // тФАтФА Right axis panel (thin divider line) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

  // тФАтФА Draw Walls (Density) on Chart тФАтФА
  let wallBadges = [];
  if (false && chartDensityEnabled) {
    const ticker = coins.get(activeEx + ":" + activeSym);
    const activeBase = ticker ? ticker.base : activeSym.replace("USDT", "").replace("USD", "").replace("-", "").split(/[-_]/)[0];

    const walls = densityData.filter(w => {
      if (w.base !== activeBase) return false;
      if (chartDensitySide !== "all" && w.side !== chartDensitySide) return false;
      if (chartDensityMarket !== "all" && w.market !== chartDensityMarket) return false;
      if (!chartDensityExes.has(w.ex)) return false;

      const sizeType = getDensitySizeType(w);
      if (!chartDensitySizes.has(sizeType)) return false;

      return true;
    });

    if (walls.length > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, TOP, PW, PH);
      ctx.clip();

      // Exchange abbreviation map for clearer labels
      const EX_NAMES = {
        BN: "Binance", BB: "Bybit", OX: "OKX", BG: "BingX",
        KC: "KuCoin", BX: "Bitget", MX: "MEXC", GT: "Gate",
        HT: "HTX", HL: "Hyperliquid", AD: "Asterdex"
      };

      for (const w of walls) {
        const wy = toY(w.price);
        if (wy < TOP || wy > TOP + PH) continue;

        // Find x start position (based on firstSeenAt timestamp (exact time, not just candle index)
        let startIdx = 0;
        if (w.firstSeenAt && candles.length > 0) {
          startIdx = getIdxFromTime(w.firstSeenAt);
        }
        const startX = Math.max(0, (startIdx - s + futureGap) * candleW + candleW / 2);

        const isBid = w.side === "bid";
        const baseColor = isBid ? "rgb(38,201,122)" : "rgb(255,69,96)";

        ctx.strokeStyle = baseColor;
        // Nicer line thickness
        ctx.lineWidth = Math.min(6, 1.5 + w.rtwi / 5);
        ctx.lineCap = "round";

        ctx.beginPath();
        ctx.moveTo(startX, wy);
        ctx.lineTo(PW, wy);
        ctx.stroke();

        // Print exchange + volume (e.g. Binance 2.5M) near the start
        const exName = EX_NAMES[w.ex] || w.ex;
        const volStr = (w.wallK >= 1000 ? (w.wallK / 1000).toFixed(1).replace(/\.0$/, "") + "M" : w.wallK + "K");
        const label = `${exName} ${volStr}`;
        ctx.fillStyle = baseColor;
        ctx.font = "bold 9px Inter";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";

        // Draw a little pill/background for label
        const labelWidth = ctx.measureText(label).width + 10;
        const labelHeight = 14;
        ctx.fillStyle = isBid ? "rgba(38,201,122,0.15)" : "rgba(255,69,96,0.15)";
        roundRect(ctx, Math.min(startX + 2, PW - labelWidth - 4), wy - labelHeight - 2, labelWidth, labelHeight, 3);
        ctx.fill();

        ctx.fillStyle = baseColor;
        ctx.fillText(label, Math.min(startX + 7, PW - labelWidth), wy - 5);

        // Save badge coordinate and info to draw on price scale later (outside of clip)
        wallBadges.push({ y: wy, price: w.price, isBid, baseColorArr: isBid ? [38, 201, 122] : [255, 69, 96] });
      }
      ctx.restore();
    }
  }
  const activeDensityTicker = coins.get(activeEx + ":" + activeSym);
  const activeDensityBase = activeDensityTicker
    ? activeDensityTicker.base
    : activeSym.replace("USDT", "").replace("USD", "").replace("-", "").split(/[-_]/)[0];
  wallBadges = drawDensityTimelineOnChart(ctx, {
    candles,
    base: activeDensityBase,
    candleWidth: candleW,
    viewStart,
    toY,
    PW,
    PH,
    TOP,
  });

  if (window.TradeOverlay) {
    window.TradeOverlay.draw(ctx, {
      candles,
      xForIndex: index => (index - viewStart) * candleW + candleW / 2,
      yForPrice: toY,
      width: PW,
      height: PH,
      currentPrice: candles[candles.length - 1]?.c,
      symbol: activeSym,
      exchange: activeEx,
    });
  }

  // тФАтФА Drawings тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  const getX = (t) => {
    // If it's a timestamp (large number), convert to index
    const idx = (t > 1000000000) ? getIdxFromTime(t) : t;
    return (idx - viewStart) * candleW + candleW / 2;
  };
  const getY = (p) => TOP + ((mx - p) / pr) * PH;

  const drawingScaleBadges = [];
  function queuePriceTagOnScale(p, color, isHovered) {
    if (typeof p !== "number" || !Number.isFinite(p)) return;
    drawingScaleBadges.push({ price: p, color, isHovered: !!isHovered });
  }

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
    queuePriceTagOnScale(p, color, isHovered);
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
      brush: "#facc15",
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
      queuePriceTagOnScale(d.p1, baseCol, isHovered);
    } else if (d.type === "alert") {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = col || "#2bd98a";
      ctx.lineWidth = isHovered ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(0, y1);
      ctx.lineTo(PW, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      
      const pillW = 68, pillH = 18, pillX = Math.max(10, x1 - 34), pillY = y1 - pillH / 2;
      roundRect(ctx, pillX, pillY, pillW, pillH, 9);
      ctx.fillStyle = "#12141a";
      ctx.fill();
      ctx.strokeStyle = col || "#2bd98a";
      ctx.lineWidth = 1;
      ctx.stroke();
      
      ctx.fillStyle = col || "#2bd98a";
      ctx.font = "bold 10px Inter";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("🔔 " + fP(d.p1), pillX + pillW / 2, y1);
      ctx.restore();
      
      queuePriceTagOnScale(d.p1, col || "#2bd98a", isHovered);
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
      // Multichart-style ruler: shaded rectangle + crosshair + info box
      try {
        const isBull = d.p2 >= d.p1;
        const areaColor = isBull ? "rgba(38,201,122," : "rgba(255,69,96,";

        // Shaded rectangle
        ctx.fillStyle = areaColor + "0.15)";
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

        // Border
        ctx.strokeStyle = areaColor + "0.6)";
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

        // Crosshair dashed lines
        ctx.strokeStyle = areaColor + "0.8)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(Math.min(x1, x2), y2); ctx.lineTo(Math.max(x1, x2), y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x2, Math.min(y1, y2)); ctx.lineTo(x2, Math.max(y1, y2)); ctx.stroke();
        ctx.setLineDash([]);

        // Stats
        const deltaPrice = d.p2 - d.p1;
        const pct = d.p1 !== 0 ? (deltaPrice / d.p1) * 100 : 0;

        // Bars count
        let bars = 0;
        const diffMs = (d.t1 && d.t2) ? Math.abs(d.t2 - d.t1) : 0;
        const tfMs = (typeof TF_MS !== 'undefined' && TF_MS[activeTf])
          ? TF_MS[activeTf]
          : (typeof candles !== 'undefined' && candles && candles.length > 1
              ? Math.max(1, candles[candles.length - 1].t - candles[candles.length - 2].t)
              : 60000);

        if (typeof candles !== 'undefined' && candles && candles.length > 0) {
          const idx1 = (d.t1 > 1000000000) ? getIdxFromTime(d.t1, candles) : d.t1;
          const idx2 = (d.t2 > 1000000000) ? getIdxFromTime(d.t2, candles) : d.t2;
          if (typeof idx1 === 'number' && typeof idx2 === 'number' && Number.isFinite(idx1) && Number.isFinite(idx2)) {
            bars = Math.round(Math.abs(idx2 - idx1));
          }
        }
        if (bars <= 0 && diffMs > 0 && tfMs > 0) {
          bars = Math.max(1, Math.round(diffMs / tfMs));
        }

        // Time duration
        let timeStr = "";
        if (diffMs > 0) {
          if (diffMs < 60000) {
            timeStr = Math.round(diffMs / 1000) + "с";
          } else if (diffMs < 3600000) {
            timeStr = Math.round(diffMs / 60000) + "м";
          } else if (diffMs < 86400000) {
            const hours = Math.floor(diffMs / 3600000);
            const mins = Math.round((diffMs % 3600000) / 60000);
            timeStr = hours + "ч" + (mins > 0 ? " " + mins + "м" : "");
          } else {
            const days = Math.floor(diffMs / 86400000);
            const hours = Math.round((diffMs % 86400000) / 3600000);
            timeStr = days + "д" + (hours > 0 ? " " + hours + "ч" : "");
          }
        }

        function formatCandlesCount(count) {
          const n = Math.abs(Math.round(count));
          const mod10 = n % 10;
          const mod100 = n % 100;
          if (mod100 >= 11 && mod100 <= 19) return `${n} свечей`;
          if (mod10 === 1) return `${n} свеча`;
          if (mod10 >= 2 && mod10 <= 4) return `${n} свечи`;
          return `${n} свечей`;
        }

        // Info box at center
        const pctSign = pct >= 0 ? "+" : "";
        const formattedDeltaPrice = deltaPrice >= 0 ? ("+" + fP(deltaPrice)) : fP(deltaPrice);
        const text1 = pctSign + pct.toFixed(2) + "% (" + formattedDeltaPrice + ")";
        const text2 = timeStr ? (formatCandlesCount(bars) + ", " + timeStr) : formatCandlesCount(bars);

        ctx.font = "bold 13px Inter";
        const w1 = ctx.measureText(text1).width;
        ctx.font = "12px Inter";
        const w2 = ctx.measureText(text2).width;
        const boxW = Math.max(w1, w2) + 24;
        const boxH = 46;
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        const boxX = Math.max(4, Math.min(midX - boxW / 2, PW - boxW - 4));
        const boxY = Math.max(4, Math.min(midY - boxH / 2, PH - boxH - 4));

        // Rounded box background
        const bR = 5;
        ctx.beginPath();
        ctx.moveTo(boxX + bR, boxY);
        ctx.lineTo(boxX + boxW - bR, boxY);
        ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + bR, bR);
        ctx.lineTo(boxX + boxW, boxY + boxH - bR);
        ctx.arcTo(boxX + boxW, boxY + boxH, boxX + boxW - bR, boxY + boxH, bR);
        ctx.lineTo(boxX + bR, boxY + boxH);
        ctx.arcTo(boxX, boxY + boxH, boxX, boxY + boxH - bR, bR);
        ctx.lineTo(boxX, boxY + bR);
        ctx.arcTo(boxX, boxY, boxX + bR, boxY, bR);
        ctx.closePath();
        ctx.fillStyle = "rgba(20, 24, 33, 0.92)";
        ctx.fill();
        ctx.strokeStyle = areaColor + "0.8)";
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // Text line 1 (% and price)
        ctx.fillStyle = isBull ? "#26c97a" : "#ff4560";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.font = "bold 13px Inter";
        ctx.fillText(text1, boxX + boxW / 2, boxY + 7);

        // Text line 2 (bars and time)
        ctx.fillStyle = "#ffffff";
        ctx.font = "12px Inter";
        ctx.fillText(text2, boxX + boxW / 2, boxY + 26);
      } catch (err) {
        console.error("Ruler error:", err);
      }

      // Reset styles for subsequent drawings
      ctx.strokeStyle = col;
      ctx.lineWidth = isHovered ? 2.5 : 1.8;
      ctx.setLineDash([]);
    } else if (d.type === "brush") {
      // Brush drawing - freehand path with optimization
      if (d.points && d.points.length > 1) {
        ctx.beginPath();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = d.lineWidth || 2;

        // Simplify path by skipping some points for performance
        const step = Math.max(1, Math.floor(d.points.length / 200));

        const firstPoint = d.points[0];
        const startX = getX(firstPoint.t);
        const startY = getY(firstPoint.p);
        ctx.moveTo(startX, startY);

        for (let i = 1; i < d.points.length; i += step) {
          const pt = d.points[i];
          const px = getX(pt.t);
          const py = getY(pt.p);
          ctx.lineTo(px, py);
        }
        // Always include the last point
        if (d.points.length > 1) {
          const lastPt = d.points[d.points.length - 1];
          ctx.lineTo(getX(lastPt.t), getY(lastPt.p));
        }
        ctx.stroke();
      }
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

  // Real-time hover preview for horizontal level tool (h-ray / alert)
  if ((activeTool === "h-ray" || activeTool === "alert") && drawingPhase === 0 && mX >= 0 && mX < PW && mY >= TOP && mY <= TOP + PH) {
    const previewP = (magnetSnap && Number.isFinite(magnetSnap.p)) ? magnetSnap.p : (mx - ((mY - TOP) / PH) * pr);
    const previewY = toY(previewP);
    const toolCol = getToolColor(activeTool) || (activeTool === "alert" ? "#2bd98a" : "#a78bfa");

    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = toolCol;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, previewY);
    ctx.lineTo(PW, previewY);
    ctx.stroke();
    ctx.setLineDash([]);
    drawHandle(mX, previewY, toolCol, 4);
    ctx.restore();

    queuePriceTagOnScale(previewP, toolCol, true);
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

  // Collect active badge Y coordinates to avoid overlapping axis labels
  const activeBadgeYs = [];
  const lastCandle = candles[candles.length - 1];
  if (lastCandle) activeBadgeYs.push(toY(lastCandle.c));
  if (drawingScaleBadges && drawingScaleBadges.length > 0) {
    for (const b of drawingScaleBadges) activeBadgeYs.push(toY(b.price));
  }
  if (formationScaleBadges && formationScaleBadges.length > 0) {
    for (const b of formationScaleBadges) activeBadgeYs.push(toY(b.price));
  }

  // ── Price Axis (Right) ─────────────────────────────────────────────────────────────
  gridPrice = Math.ceil(mn / gridStep) * gridStep;
  ctx.font = "10px Inter";
  ctx.textAlign = "left";
  const axisColor = getAxisTextColor();
  while (gridPrice <= mx + gridStep * 0.01) {
    const y = toY(gridPrice);
    if (y >= TOP + 10 && y <= TOP + PH - 10) {
      const collidesWithBadge = activeBadgeYs.some(by => Math.abs(by - y) < 14);
      if (!collidesWithBadge) {
        ctx.fillStyle = axisColor;
        ctx.fillText(fP(gridPrice), PW + 6, y + 4);
      }
    }
    gridPrice += gridStep;
  }

  // Draw price badges on the right price scale for horizontal drawings / levels
  if (drawingScaleBadges.length > 0) {
    const badgeH = 20;
    const badgeW = PR - 8;
    const badgeX = PW + 4;

    for (const badge of drawingScaleBadges) {
      const by = toY(badge.price);
      if (by < TOP - 10 || by > TOP + PH + 10) continue;

      const badgeY = Math.round(by - badgeH / 2);

      ctx.save();
      // Draw badge background
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4.5);
      ctx.fillStyle = "#151722";
      ctx.fill();

      // Draw border in drawing color
      ctx.strokeStyle = badge.color || "#8b5cf6";
      ctx.lineWidth = badge.isHovered ? 2 : 1.4;
      ctx.stroke();

      // Draw exact price
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10.5px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(fP(badge.price), badgeX + badgeW / 2, by);
      ctx.restore();
    }
  }

  // Draw crisp, solid price labels on right scale for formation/cascade levels
  if (formationScaleBadges && formationScaleBadges.length > 0) {
    const badgeH = 18;
    const badgeW = PR - 8;
    const badgeX = PW + 4;
    const renderedBadges = [];

    for (const badge of formationScaleBadges) {
      const by = toY(badge.price);
      if (by < TOP + 8 || by > TOP + PH - 8) continue;
      // Skip overlapping formation badges (< 15px)
      if (renderedBadges.some(prevY => Math.abs(prevY - by) < 15)) continue;
      renderedBadges.push(by);

      const badgeY = Math.round(by - badgeH / 2);
      ctx.save();
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4);
      // 100% solid opaque background to prevent bleed-through
      ctx.fillStyle = "#131722";
      ctx.fill();
      ctx.strokeStyle = badge.color || "#38bdf8";
      ctx.lineWidth = 1.3;
      ctx.stroke();

      // High-contrast, crystal-clear white text
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(fP(badge.price), badgeX + badgeW / 2, by);
      ctx.restore();
    }
  }

  const lc = candles[candles.length - 1];
  if (lc) {
    const liveClose = lc.c;
    const dispClose = lc.c;
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

  // Draw price badges on the right price scale for walls (densities)
  if (wallBadges.length > 0) {
    const badgeH = 20;
    const badgeW = PR - 8;
    const badgeX = PW + 4;

    for (const badge of wallBadges) {
      ctx.save();
      const badgeY = badge.y - badgeH / 2;

      // Draw background
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4);
      ctx.fillStyle = "#1e1f2e";
      ctx.fill();

      // Draw border in wall color
      ctx.strokeStyle = `rgba(${badge.baseColorArr.join(',')},1)`;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw exact price
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 10px Inter";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(fP(badge.price), badgeX + badgeW / 2, badge.y);
      ctx.restore();
    }
  }

  // тФАтФА Crosshair тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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
      if (!candles._avgV) {
        let tv = 0;
        for (let k = 0; k < candles.length; k++) tv += candles[k].v;
        candles._avgV = candles.length > 0 ? tv / candles.length : 1;
      }
      const avgV = candles._avgV;
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

// тФАтФАтФА Chart interaction тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const PR_WIDTH = 82;
let isDragYScale = false,
  yScaleStartY = 0,
  yScaleStartMn = 0,
  yScaleStartMx = 0;
let isDragTimeScale = false,
  timeScaleStartX = 0,
  timeScaleStartCandleW = 10;

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// тФАтФАтФА Drawing system (TradingView-style) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА

// Convert pixel coords тЖТ chart time (timestamp) + price
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

function getIdxFromTime(t, customCandles = candles) {
  if (!customCandles.length) return 0;
  const observedTf = customCandles.length > 1
    ? Math.max(1, customCandles[customCandles.length - 1].t - customCandles[customCandles.length - 2].t)
    : (TF_MS[activeTf] || 60000);
  if (t <= customCandles[0].t) {
    return (t - customCandles[0].t) / observedTf;
  }
  if (t >= customCandles[customCandles.length - 1].t) {
    return (customCandles.length - 1) + (t - customCandles[customCandles.length - 1].t) / observedTf;
  }
  // Binary search for the correct candle gap
  let low = 0, high = customCandles.length - 2;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (t >= customCandles[mid].t && t <= customCandles[mid + 1].t) {
      return mid + (t - customCandles[mid].t) / (customCandles[mid + 1].t - customCandles[mid].t);
    }
    if (t < customCandles[mid].t) high = mid - 1;
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
  if (magnetSnap && Number.isFinite(magnetSnap.px) && Number.isFinite(magnetSnap.py)) {
    const dx = px - magnetSnap.px;
    const dy = py - magnetSnap.py;
    if (dx * dx + dy * dy < 2025) { // 45px radius
      return { t: magnetSnap.t, p: magnetSnap.p };
    }
  }
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
  if (d.type === "h-ray" || d.type === "alert") {
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
  if (d.type === "h-ray" || d.type === "alert") return true;
  return dt > 0.2 || dp > 0;
}

function getDrawingPoints(d) {
  const t1Idx = (d.t1 > 1000000000) ? getIdxFromTime(d.t1) : d.t1;
  const t2Idx = (d.t2 > 1000000000) ? getIdxFromTime(d.t2) : d.t2;

  const x1 = (t1Idx - chartState.viewStart) * candleW + candleW / 2;
  const y1 = chartState.TOP + ((chartState.mx - d.p1) / chartState.pr) * chartState.PH;
  const x2 = (t2Idx - chartState.viewStart) * candleW + candleW / 2;
  const y2Raw = chartState.TOP + ((chartState.mx - d.p2) / chartState.pr) * chartState.PH;

  return { x1, y1, x2, y2: (d.type === "h-ray" || d.type === "alert") ? y1 : y2Raw };
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
  if (d.type !== 'h-ray' && d.type !== 'alert' && Math.hypot(px - x2, py - y2) <= 9) return 'p2';
  return null;
}

// Hit-test: is (px,py) near the line/ray/brush body?
function hitBody(d, px, py) {
  if (d.type === "brush" && d.points && d.points.length > 0) {
    const getX = (t) => {
      const idx = (t > 1000000000) ? getIdxFromTime(t) : t;
      return (idx - chartState.viewStart) * candleW + candleW / 2;
    };
    const getY = (p) => chartState.TOP + ((chartState.mx - p) / chartState.pr) * chartState.PH;
    
    for (let i = 0; i < d.points.length - 1; i++) {
      const p1 = d.points[i];
      const p2 = d.points[i + 1];
      const x1 = getX(p1.t);
      const y1 = getY(p1.p);
      const x2 = getX(p2.t);
      const y2 = getY(p2.p);
      if (pointLineDistance(px, py, x1, y1, x2, y2, true) < (d.lineWidth || 4) + 6) {
        return true;
      }
    }
    return false;
  }
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
  if (d.type === "h-ray" || d.type === "alert") {
    if (d.type === "h-ray" && px < x1 - 6) return false;
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
  title = "Цвет  ",
  currentColor = "#facc15",
  pageX = window.innerWidth / 2,
  pageY = window.innerHeight / 2,
  preserveFibMenu = false,
  onSelect,
  showBrushThickness = false,
}) {
  const menu = $("draw-color-menu");
  const grid = $("draw-color-grid");
  const titleEl = $("draw-color-title");
  const brushControl = $("brush-thickness-control");
  const brushSlider = $("brush-thickness-slider");
  const brushValue = $("brush-thickness-value");

  if (titleEl) titleEl.textContent = title;
  if (grid) grid.innerHTML = "";
  drawColorSelectHandler = onSelect || null;

  // Show/hide brush thickness control
  if (showBrushThickness) {
    brushControl.style.display = "block";
    brushSlider.value = brushLineWidth;
    brushValue.textContent = brushLineWidth + "px";

    // Remove old listener if exists
    const newSlider = brushSlider.cloneNode(true);
    brushSlider.parentNode.replaceChild(newSlider, brushSlider);

    newSlider.addEventListener("input", (e) => {
      brushLineWidth = parseInt(e.target.value, 10);
      brushValue.textContent = brushLineWidth + "px";
    });
  } else {
    brushControl.style.display = "none";
  }

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
    title: "Цвет  ",
    currentColor: getToolColor(tool),
    pageX: rect ? rect.right + 10 : window.innerWidth / 2 - 70,
    pageY: rect ? rect.top : window.innerHeight / 2 - 60,
    showBrushThickness: tool === "brush",
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

// тФАтФА Mouse events тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА

canvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const PW = chartW - PR_WIDTH;

  // Price axis drag
  if (px >= PW) {
    isDragYScale = true;
    yScaleStartY = e.clientY;
    yScaleStartMn = viewMn != null ? viewMn : (chartState.mn || 0);
    yScaleStartMx = viewMx != null ? viewMx : (chartState.mx || 1);
    autoFitY = false;
    return;
  }

  // Time axis drag
  const PH_axis = chartH - volH - 1;
  if (py >= PH_axis) {
    isDragTimeScale = true;
    timeScaleStartX = e.clientX;
    timeScaleStartCandleW = candleW;
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

  // тФАтФА Drawing mode тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

    if (activeTool === 'brush') {
      // Brush: start freehand drawing
      tempDrawing = {
        type: "brush",
        points: [{ t, p }],
        color: getToolColor("brush"),
        lineWidth: brushLineWidth,
      };
      drawingPhase = 1;
      requestDraw();
      return;
    }

    if (activeTool === 'alert') {
      const roundedPrice = +p.toFixed(6);
      const curCoin = typeof coins !== "undefined" ? coins.get(`${activeEx}:${activeSym}`) : null;
      const currentPrice = curCoin ? curCoin.p : (candles.length ? candles[candles.length - 1].c : roundedPrice);
      const dir = roundedPrice >= currentPrice ? "gte" : "lte";

      tempDrawing = normalizeDrawing({
        type: "alert",
        t1: t,
        p1: roundedPrice,
        t2: t,
        p2: roundedPrice,
        color: getToolColor("alert"),
        tf: activeTf || "5m",
        ex: activeEx || "BN"
      });

      chartDrawings.push({ ...tempDrawing });
      saveDrawings();

      if (typeof priceAlerts !== "undefined") {
        priceAlerts.push({
          id: Date.now(),
          ex: activeEx || "BN",
          sym: activeSym || "BTCUSDT",
          tf: activeTf || "5m",
          dir,
          price: roundedPrice,
          createdPrice: currentPrice,
          triggered: false,
          drawingId: tempDrawing.t1
        });
        savePriceAlerts();
      }

      if (typeof showToast === "function") {
        showToast({
          title: "Ценовой алерт создан",
          message: `${activeEx || 'BN'} · ${activeSym || 'BTCUSDT'} ${dir === 'gte' ? '≥' : '≤'} ${fP(roundedPrice)} USDT`,
          type: "price_alert"
        });
      }

      tempDrawing = null;
      drawingPhase = 0;
      setTool("none");
      requestAnimationFrame(drawChart);
      return;
    }

    if (drawingPhase === 0) {
      // First click тАФ place start point, enter phase 1
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
      // Second click тАФ finish drawing
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
        const { t: mouseT, p: mouseP } = pxToTP(px, py);
        dragDrawing = {
          idx: i, handle: 'move',
          startT1: d.t1, startP1: d.p1,
          startT2: d.t2, startP2: d.p2,
          startMouseT: mouseT, startMouseP: mouseP
        };
        return;
      }
    }
    // Pan (2D free movement: horizontal & vertical)
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

  // X-axis time scale drag
  if (isDragTimeScale) {
    const dx = e.clientX - timeScaleStartX;
    const factor = Math.pow(1.005, dx);
    candleW = clamp(timeScaleStartCandleW * factor, 1.5, 60);
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
    if (tempDrawing.type === 'brush') {
      // Brush: add points to the path with throttling
      const { t, p } = getCursorTP(mX, mY);
      const lastPoint = tempDrawing.points[tempDrawing.points.length - 1];

      // Only add point if it's significantly different (min distance check)
      if (lastPoint) {
        const dt = Math.abs(t - lastPoint.t);
        const dp = Math.abs(p - lastPoint.p);
        // Minimum threshold to avoid too many points
        if (dt < 0.001 && dp < 0.000001) {
          // Skip if too close to last point
        } else if (tempDrawing.points.length < 500) { // Limit max points
          tempDrawing.points.push({ t, p });
          // Throttle draw requests for brush
          if (!brushDrawThrottle) {
            brushDrawThrottle = setTimeout(() => {
              brushDrawThrottle = null;
              requestDraw();
            }, 16); // ~60fps
          }
        }
      } else {
        tempDrawing.points.push({ t, p });
        requestDraw();
      }
    } else {
      const { t, p } = getCursorTP(mX, mY);
      tempDrawing.t2 = t;
      tempDrawing.p2 = p;
      normalizeDrawing(tempDrawing);
    }
  }

  if (quickMeasure) {
    const { t, p } = getCursorTP(mX, mY);
    quickMeasure.t2 = t;
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
      const { t: currT, p: currP } = pxToTP(mX, mY);
      const dt = currT - (dragDrawing.startMouseT || currT);
      const dp = currP - (dragDrawing.startMouseP || currP);

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

  // Finish brush drawing
  if (activeTool === 'brush' && tempDrawing && drawingPhase === 1) {
    if (tempDrawing.points && tempDrawing.points.length > 1) {
      chartDrawings.push({ ...tempDrawing });
      saveDrawings();
    }
    tempDrawing = null;
    drawingPhase = 0;
    setTool("none");
  }

  quickMeasure = null;
  isDragX = false; isDragY = false; isDragYScale = false; isDragTimeScale = false;
  requestDraw();
});

canvas.addEventListener("mouseleave", () => {
  mX = -1; mY = -1;
  isDragX = false; isDragY = false; isDragYScale = false; isDragTimeScale = false;
  dragDrawing = null;
  magnetSnap = null;
  quickMeasure = null;
  canvas.style.cursor = 'crosshair';
  requestDraw();
});

// тФАтФА Touch Gesture Support for Mobile & Tablets (iPhones, iPads, Touchscreen Laptops) тФАтФА
let touchStartX = 0, touchStartY = 0;
let touchDragOffX = 0;
let touchPinchDist = 0;
let touchStartCandleW = 10;
let isTouchPanning = false;

canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const r = canvas.getBoundingClientRect();
    const px = t.clientX - r.left;
    const py = t.clientY - r.top;

    touchStartX = t.clientX;
    touchStartY = t.clientY;
    touchDragOffX = offsetX;
    mX = px; mY = py;

    const PW = chartW - PR_WIDTH;
    if (px < PW && activeTool === "none") {
      isTouchPanning = true;
      isDragX = true;
      dragStartX = t.clientX;
      dragOffX = offsetX;
    } else if (activeTool === "ruler") {
      updateMagnetSnap(px, py);
      const { t: ct, p: cp } = getCursorTP(px, py);
      quickMeasure = normalizeDrawing({
        type: "ruler",
        t1: ct, p1: cp, t2: ct, p2: cp,
        color: getToolColor("ruler"),
      });
      requestDraw();
    }
  } else if (e.touches.length === 2) {
    isTouchPanning = false;
    isDragX = false;
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    touchPinchDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    touchStartCandleW = candleW;
  }
}, { passive: true });

canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length === 1) {
    const t = e.touches[0];
    const r = canvas.getBoundingClientRect();
    mX = t.clientX - r.left;
    mY = t.clientY - r.top;

    if (isTouchPanning) {
      const dx = t.clientX - touchStartX;
      offsetX = getClampedOffsetX(touchDragOffX + dx / (candleW || 10));
    }

    if (quickMeasure) {
      const { t: ct, p: cp } = getCursorTP(mX, mY);
      quickMeasure.t2 = ct;
      quickMeasure.p2 = cp;
      normalizeDrawing(quickMeasure);
    }

    requestDraw();
  } else if (e.touches.length === 2 && touchPinchDist > 0) {
    const t1 = e.touches[0];
    const t2 = e.touches[1];
    const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    if (touchPinchDist > 0 && currentDist > 0) {
      const ratio = currentDist / touchPinchDist;
      candleW = clamp(touchStartCandleW * ratio, 1.5, 50);
      requestDraw();
    }
  }
}, { passive: true });

canvas.addEventListener("touchend", () => {
  isTouchPanning = false;
  isDragX = false;
  touchPinchDist = 0;
  if (activeTool === "ruler") setTool("none");
  quickMeasure = null;
  requestDraw();
}, { passive: true });

canvas.addEventListener("touchcancel", () => {
  isTouchPanning = false;
  isDragX = false;
  touchPinchDist = 0;
  quickMeasure = null;
  requestDraw();
}, { passive: true });

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  // Global search shortcut (Ctrl+K, Cmd+K, or / when not typing)
  if (( (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' ) || (e.key === '/' && e.target.tagName !== 'INPUT')) {
    e.preventDefault();
    const si = $("si");
    if (si) {
      si.focus();
      si.select();
    }
    return;
  }

  // Shortcuts cheat sheet modal toggle (?)
  if (e.key === '?' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    const modal = $("shortcuts-modal");
    if (modal) modal.style.display = modal.style.display === "none" ? "flex" : "none";
    return;
  }

  if (e.target.tagName === 'INPUT') return;

  if (e.key === 'Escape') {
    const modal = $("shortcuts-modal");
    if (modal && modal.style.display !== "none") {
      modal.style.display = "none";
      return;
    }
    if (drawingPhase > 0) { cancelDrawing(); }
    else { setTool('none'); }
  }

  // Numeric timeframe shortcuts (1-6)
  const tfMap = { '1': '1m', '2': '5m', '3': '15m', '4': '1h', '5': '4h', '6': '1d' };
  if (tfMap[e.key]) {
    const targetTf = tfMap[e.key];
    const tfBtn = document.querySelector(`.tfb[data-tf="${targetTf}"]`);
    if (tfBtn) tfBtn.click();
    return;
  }

  if (e.key === 'a' || e.key === 'A') setTool('alert');
  if (e.key === 'h' || e.key === 'H') setTool('h-ray');
  if (e.key === 'l' || e.key === 'L') setTool('line');
  if (e.key === 'x' || e.key === 'X') setTool('rect');
  if (e.key === 'u' || e.key === 'U') setTool('ruler');
  if (e.key === 'f' || e.key === 'F') setTool('fibgrid');
  if (e.key === 'm' || e.key === 'M') toggleMagnet();
  if ((e.key === 'Delete' || e.key === 'Backspace') && drawingPhase === 0) {
    let removedDrawing = null;
    if (hoverDrawingIdx >= 0) {
      removedDrawing = chartDrawings.splice(hoverDrawingIdx, 1)[0];
      hoverDrawingIdx = -1;
    } else if (chartDrawings.length) {
      removedDrawing = chartDrawings.pop();
    }
    if (removedDrawing && removedDrawing.type === "alert") {
      if (typeof priceAlerts !== "undefined") {
        priceAlerts = priceAlerts.filter(a => a.drawingId !== removedDrawing.t1 && a.price !== removedDrawing.p1);
        if (typeof savePriceAlerts === "function") savePriceAlerts();
      }
    }
    saveDrawings();
    requestAnimationFrame(drawChart);
  }
});

// Preserve exact chart position & prevent jumps when Alt-tabbing back to window
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    requestDraw();
  }
});
window.addEventListener("focus", () => {
  requestDraw();
});

// ════ COPY COIN TO CLIPBOARD ═════════════════════════════

function copyCoinNameToClipboard(rawText) {
  if (!rawText) return;
  const cleanName = rawText.replace(/\.F$/i, "").trim();

  const doCopy = (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  };

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(ta);
  }

  doCopy(cleanName);
  showToast(`Скопировано: <b style="color:#26c97a; margin-left:4px;">${cleanName}</b>`);

  const symBtn = $("sym-btn");
  if (symBtn) {
    symBtn.style.transition = "transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease";
    symBtn.style.transform = "scale(1.06)";
    symBtn.style.background = "rgba(38, 201, 122, 0.22)";
    symBtn.style.boxShadow = "0 0 12px rgba(38, 201, 122, 0.4)";
    setTimeout(() => {
      symBtn.style.transform = "";
      symBtn.style.background = "";
      symBtn.style.boxShadow = "";
    }, 220);
  }
}
window.copyCoinNameToClipboard = copyCoinNameToClipboard;
window.showToast = showToast;

// Shortcuts modal & symbol copy handlers
document.addEventListener("DOMContentLoaded", () => {
  const symBtn = $("sym-btn");
  if (symBtn) {
    symBtn.title = "Нажмите, чтобы скопировать   монеты";
    symBtn.onclick = (e) => {
      e.stopPropagation();
      const sn = $("sn");
      const textToCopy = sn ? sn.textContent : activeSym;
      copyCoinNameToClipboard(textToCopy);
    };
  }

  const btn = $("shortcuts-btn");
  const modal = $("shortcuts-modal");
  const closeBtn = $("shortcuts-modal-close");
  if (btn && modal) {
    btn.onclick = () => { modal.style.display = "flex"; };
  }
  if (closeBtn && modal) {
    closeBtn.onclick = () => { modal.style.display = "none"; };
  }
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) modal.style.display = "none";
    };
  }

  // ── Authentication & Profile System ──
  currentUser = window.currentUser || null;
  authToken = localStorage.getItem("obsidian_auth_token") || "";

  const profileBtn = $("profile-btn");
  const profileModal = $("profile-modal");
  const profileCloseBtn = $("profile-modal-close");
  const authModal = $("auth-modal");
  const authCloseBtn = $("auth-modal-close");

  const authTabLogin = $("auth-tab-login");
  const authTabRegister = $("auth-tab-register");
  const authLoginForm = $("auth-login-form");
  const authRegisterForm = $("auth-register-form");
  const authErrorMsg = $("auth-error-msg");
  const authLogoutBtn = $("auth-logout-btn");
  const telegramAuthBtn = $("telegram-auth-btn");

  const profileNameDisplay = $("profile-name-display");
  const profileUseridDisplay = $("profile-userid-display");
  const profileEmailDisplay = $("profile-email-display");
  const profileStatId = $("profile-stat-id");
  const profileStatMethod = $("profile-stat-method");
  const profileNameInput = $("profile-name-input");
  const profileSaveBtn = $("profile-save-btn");
  const profileAvatar = $("profile-avatar");

  function showAuthError(msg) {
    if (!authErrorMsg) return;
    if (msg) {
      authErrorMsg.textContent = msg;
      authErrorMsg.style.display = "block";
    } else {
      authErrorMsg.style.display = "none";
    }
  }

  const tgBotStatusText = $("tg-bot-status-text");
  const tgBotLinkBtn = $("tg-bot-link-btn");

  function openAuthModal() {
    if (authModal) {
      showAuthError("");
      authModal.style.display = "flex";
    }
  }
  window.openAuthModal = openAuthModal;

  function revertToDefaultFreeState() {
    console.log("[PRO REVERT] Reverting appearance, colors, and formation alerts to default free tier");

    // 1. Reset Background & Axis Colors
    try {
      if (typeof updateBgColor === "function") updateBgColor("#0d0f14", 100, true);
      if (typeof updateAxisColor === "function") updateAxisColor("#d1d4dc", 100, true);
      if (typeof updateScreenerBgColor === "function") updateScreenerBgColor("#0d0f14", true);
    } catch (_) {}

    // 2. Reset Candle Settings to default (#26c97a / #ff4560)
    const defaultCandles = {
      body: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
      border: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
      wick: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 }
    };
    try {
      localStorage.setItem("screener-candle-settings", JSON.stringify(defaultCandles));
      if (window.candleSettings) Object.assign(window.candleSettings, defaultCandles);
    } catch (_) {}

    // 3. Reset Volume Settings
    const defaultVolume = {
      show: true,
      up: "#26c97a",
      upOp: 75,
      down: "#ff4560",
      downOp: 75
    };
    try {
      localStorage.setItem("screener-volume-settings", JSON.stringify(defaultVolume));
      if (window.volumeSettings) Object.assign(window.volumeSettings, defaultVolume);
    } catch (_) {}

    // 4. Reset Formation Colors
    const defaultFormationColors = {
      cascadeUp: "#94a3b8", cascadeUpOp: 75,
      cascadeDown: "#94a3b8", cascadeDownOp: 75,
      trendlineUp: "#94a3b8", trendlineUpOp: 75,
      trendlineDown: "#94a3b8", trendlineDownOp: 75,
      level: "#94a3b8", levelOp: 75,
      retest: "#94a3b8", retestOp: 75
    };
    try {
      localStorage.setItem("screener-formation-colors", JSON.stringify(defaultFormationColors));
      if (window.formationColorSettings) Object.assign(window.formationColorSettings, defaultFormationColors);
    } catch (_) {}

    // 5. Disable all Formation Alerts (PRO Feature)
    try {
      const rawFmt = localStorage.getItem("obsidian_formation_alert_settings");
      if (rawFmt) {
        const fmtSettings = JSON.parse(rawFmt);
        if (fmtSettings.trendline) fmtSettings.trendline.enabled = false;
        if (fmtSettings.level) fmtSettings.level.enabled = false;
        if (fmtSettings.retest) fmtSettings.retest.enabled = false;
        localStorage.setItem("obsidian_formation_alert_settings", JSON.stringify(fmtSettings));
        if (typeof currentFormationAlertSettings !== "undefined" && currentFormationAlertSettings) {
          if (currentFormationAlertSettings.trendline) currentFormationAlertSettings.trendline.enabled = false;
          if (currentFormationAlertSettings.level) currentFormationAlertSettings.level.enabled = false;
          if (currentFormationAlertSettings.retest) currentFormationAlertSettings.retest.enabled = false;
        }
      }
    } catch (_) {}

    // 6. Disable Formations Chart Overlay
    try {
      localStorage.removeItem("fov_settings");
      if (typeof chartFormationsOnChart !== "undefined") chartFormationsOnChart = false;
    } catch (_) {}

    // 7. If currently on a PRO tab (map, arbitrage, formations, backtest, journal), switch back to screener
    try {
      if (typeof activeView !== "undefined" && activeView !== "screener") {
        const proViews = ["map", "arbitrage", "formations", "backtest", "journal"];
        if (proViews.includes(activeView)) {
          if (typeof switchView === "function") switchView("screener");
        }
      }
    } catch (_) {}

    // 8. Refresh and redraw charts to apply defaults immediately
    try {
      if (typeof refreshCharts === "function") refreshCharts();
      if (typeof drawChart === "function") drawChart();
    } catch (_) {}
  }
  window.revertToDefaultFreeState = revertToDefaultFreeState;

  let lastKnownProStatus = localStorage.getItem("obsidian_was_pro") === "true";

  function renderProfile(user) {
    currentUser = user;
    window.currentUser = user;
    if (authCloseBtn) authCloseBtn.style.display = "block";

    const isPro = !!(user && user.plan === "pro");

    // Automatically revert appearance and disable PRO features when PRO subscription ends or is revoked
    if (lastKnownProStatus && !isPro) {
      revertToDefaultFreeState();
    }
    lastKnownProStatus = isPro;
    localStorage.setItem("obsidian_was_pro", isPro ? "true" : "false");

    if (user) {
      const name = user.username || "Трейдер";
      const id = user.id || "USR-000000";
      const email = user.email || "—";
      const method = user.authMethod === "telegram" ? "Telegram" : "Логин / Пароль";

      if (profileNameDisplay) profileNameDisplay.textContent = name;
      if (profileUseridDisplay) profileUseridDisplay.textContent = `ID: ${id}`;
      if (profileEmailDisplay) profileEmailDisplay.textContent = email;
      if (profileStatId) profileStatId.textContent = id;
      if (profileStatMethod) profileStatMethod.textContent = method;
      if (profileNameInput) profileNameInput.value = name;

      const profileStatDays = $("profile-stat-days");
      if (profileStatDays) {
        if (isPro) {
          const days = user.proDaysLeft;
          if (days === "∞" || days === null || days === undefined || days >= 8000 || String(days).includes("∞")) {
            profileStatDays.textContent = "∞ (Бессрочно)";
            profileStatDays.style.color = "#26c97a";
          } else {
            profileStatDays.textContent = `${days} дн.`;
            profileStatDays.style.color = "#26c97a";
          }
        } else {
          profileStatDays.textContent = "∞ (Бессрочно)";
          profileStatDays.style.color = "#94a3b8";
        }
      }

      const profileStatPlan = $("profile-stat-plan");
      const profileRoleBadge = $("profile-role-badge");
      const profileUpgradeBanner = $("profile-plan-upgrade-banner");

      if (profileStatPlan) {
        profileStatPlan.textContent = isPro ? "PRO (Активна)" : "FREE Plan";
        profileStatPlan.style.color = isPro ? "#26c97a" : "#94a3b8";
      }
      if (profileRoleBadge) {
        profileRoleBadge.textContent = isPro ? "PRO" : "FREE";
        profileRoleBadge.className = isPro ? "profile-badge-pro" : "profile-badge-free";
      }
      if (profileUpgradeBanner) {
        profileUpgradeBanner.style.setProperty("display", isPro ? "none" : "flex", "important");
      }

      const logoTierBadge = $("logo-tier-badge") || $("logo-pro-badge") || document.querySelector(".logo-rest");
      if (logoTierBadge) {
        logoTierBadge.textContent = isPro ? "PRO" : "FREE";
        logoTierBadge.style.color = isPro ? "var(--t1)" : "rgba(255, 255, 255, 0.55)";
        logoTierBadge.style.display = "inline";
      }

      if (tgBotStatusText) {
        if (user.telegramLinked) {
          tgBotStatusText.textContent = "✅ Подключен (@ObsidianScreenerBot)";
          tgBotStatusText.classList.add("connected");
          if (tgBotLinkBtn) tgBotLinkBtn.style.display = "none";
        } else {
          tgBotStatusText.textContent = "Не подключен";
          tgBotStatusText.classList.remove("connected");
          if (tgBotLinkBtn) tgBotLinkBtn.style.display = "inline-block";
        }
      }

      if (profileAvatar && user.avatar) {
        profileAvatar.innerHTML = `<img src="${user.avatar}" alt="Avatar" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;" />`;
      }

      if (Array.isArray(user.notifications) && user.notifications.length > 0) {
        const token = localStorage.getItem("obsidian_auth_token") || "";
        user.notifications.forEach(n => processNotificationItem(n, token));
      }

      if (user.preferences && typeof user.preferences === "object") {
        applyAccountPreferences(user.preferences);
      } else if (authToken || localStorage.getItem("obsidian_auth_token")) {
        syncPreferencesToServer();
      }
    } else {
      const logoTierBadge = $("logo-tier-badge") || $("logo-pro-badge") || document.querySelector(".logo-rest");
      if (logoTierBadge) {
        logoTierBadge.textContent = "FREE";
        logoTierBadge.style.color = "rgba(255, 255, 255, 0.55)";
        logoTierBadge.style.display = "inline";
      }
    }
  }

  window.shownNotificationIds = window.shownNotificationIds || new Set();

  function processNotificationItem(n, token) {
    if (!n || !n.id || n.read || window.shownNotificationIds.has(n.id)) return;

    window.shownNotificationIds.add(n.id);
    n.read = true;

    const notifType = n.type === "bug_reward" ? "bug_reward" : (n.type === "bug_reject" ? "bug_reject" : "info");
    const title = n.title || (n.type === "bug_reward" ? "🎁 Баг подтверждён!" : "ℹ️ Статус баг-репорта");
    let message = n.message || "";
    if (notifType === "bug_reward" && !message.includes("обновите страницу")) {
      message += "\n(обновите страницу)";
    }

    if (typeof showToast === "function") {
      showToast({ type: notifType, title: title, message: message, durationMs: 5000 });
    }

    if (token) {
      fetch("/api/notifications/mark-read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ notificationId: n.id })
      }).catch(() => {});
    }
  }

  async function checkUnreadNotifications() {
    const token = localStorage.getItem("obsidian_auth_token") || "";
    if (!token) return;

    try {
      const res = await fetch("/api/notifications/unread", {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.notifications) && data.notifications.length > 0) {
        let hasNew = false;
        data.notifications.forEach(n => {
          if (!window.shownNotificationIds.has(n.id)) {
            processNotificationItem(n, token);
            hasNew = true;
          }
        });
        if (hasNew && typeof fetchUserProfile === "function") {
          fetchUserProfile();
        }
      }
    } catch (_) {}
  }

  setInterval(checkUnreadNotifications, 15000);
  setTimeout(checkUnreadNotifications, 2000);

  // Telegram Bot Link Handler
  if (tgBotLinkBtn) {
    tgBotLinkBtn.onclick = async () => {
      if (!authToken) {
        openAuthModal();
        return;
      }
      try {
        const r = await fetch("/api/auth/telegram-link-token", {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` }
        });
        const data = await r.json();
        if (data.success && data.botUrl) {
          window.open(data.botUrl, "_blank");
          if (typeof showToast === "function") {
            showToast({ title: "Telegram", message: "Нажмите START в Telegram-боте для активации уведомлений", type: "info" });
          }
          let polls = 0;
          const pollTimer = setInterval(async () => {
            polls++;
            if (polls > 40) clearInterval(pollTimer);
            await checkAuthSession();
            if (currentUser && currentUser.telegramLinked) {
              clearInterval(pollTimer);
              if (typeof showToast === "function") {
                showToast({ title: "Telegram", message: "✅ Telegram-бот успешно подключен!", type: "success" });
              }
            }
          }, 3000);
        }
      } catch (err) {
        if (typeof showToast === "function") showToast({ title: "Ошибка", message: "Ошибка получения ссылки бота", type: "error" });
      }
    };
  }

  window.onTelegramAuth = async function(tgUser) {
    try {
      const r = await fetch("/api/auth/telegram-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tgUser)
      });
      const data = await r.json();
      if (!r.ok || !data.success) {
        throw new Error(data.error || "Ошибка проверки авторизации Telegram");
      }
      authToken = data.token;
      localStorage.setItem("obsidian_auth_token", authToken);
      renderProfile(data.user);
      if (authModal) authModal.style.display = "none";
      if (typeof showToast === "function") {
        showToast({ title: "Добро пожаловать!", message: `Telegram вход выполнен! Ваш ID: ${data.user.id}`, type: "success" });
      }
    } catch (err) {
      showAuthError(err.message);
      if (typeof showToast === "function") {
        showToast({ title: "Ошибка входа", message: err.message || "Ошибка проверки авторизации Telegram", type: "error" });
      }
    }
  };

  function getStoredAuthToken() {
    let token = "";
    try { token = localStorage.getItem("obsidian_auth_token") || ""; } catch (_) {}
    if (!token) {
      try {
        const match = document.cookie.match(/(?:^|; )obsidian_auth_token=([^;]*)/);
        if (match && match[1]) {
          token = decodeURIComponent(match[1]);
          if (token) {
            try { localStorage.setItem("obsidian_auth_token", token); } catch (_) {}
          }
        }
      } catch (_) {}
    }
    return token;
  }

  function setStoredAuthToken(token) {
    if (token) {
      try { localStorage.setItem("obsidian_auth_token", token); } catch (_) {}
      try { document.cookie = `obsidian_auth_token=${encodeURIComponent(token)}; max-age=31536000; path=/; SameSite=Lax`; } catch (_) {}
    } else {
      try { localStorage.removeItem("obsidian_auth_token"); } catch (_) {}
      try { document.cookie = "obsidian_auth_token=; max-age=0; path=/"; } catch (_) {}
    }
  }
  window.setStoredAuthToken = setStoredAuthToken;
  window.getStoredAuthToken = getStoredAuthToken;

  async function checkAuthSession() {
    authToken = getStoredAuthToken();
    if (!authToken) {
      currentUser = null;
      window.currentUser = null;
      return;
    }
    try {
      const r = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (r.ok) {
        const data = await r.json();
        if (data.success && data.user) {
          setStoredAuthToken(authToken); // ensure 365-day cookie backup is synced
          renderProfile(data.user);
          return;
        }
      }
      if (r.status === 401) {
        const data = await r.json().catch(() => ({}));
        if (data && (data.error === "Неавторизован" || data.error === "INVALID_TOKEN" || data.error === "USER_BLOCKED")) {
          authToken = "";
          setStoredAuthToken("");
          currentUser = null;
          window.currentUser = null;
          renderProfile(null);
        }
      }
    } catch (_) {
      // Network hiccup or server restart — retain local token in storage and cookies
    }
  }

  window.renderProfile = renderProfile;
  window.checkAuthSession = checkAuthSession;
  checkAuthSession();

  if (profileBtn) {
    profileBtn.onclick = () => {
      const activeUser = currentUser || window.currentUser;
      if (activeUser) {
        renderProfile(activeUser);
        if (profileModal) profileModal.style.display = "flex";
      } else {
        openAuthModal();
      }
    };
  }

  if (profileCloseBtn && profileModal) {
    profileCloseBtn.onclick = () => { profileModal.style.display = "none"; };
  }
  if (authCloseBtn && authModal) {
    authCloseBtn.onclick = () => {
      authModal.style.display = "none";
    };
  }

  if (profileModal) {
    profileModal.onclick = (e) => {
      if (e.target === profileModal) profileModal.style.display = "none";
    };
  }
  if (authModal) {
    authModal.onclick = (e) => {
      if (e.target === authModal) authModal.style.display = "none";
    };
  }

  // Copy User ID handlers
  if (profileUseridDisplay) {
    profileUseridDisplay.title = "Нажмите, чтобы скопировать ID";
    profileUseridDisplay.onclick = () => {
      if (currentUser && currentUser.id && typeof copyCoinNameToClipboard === "function") {
        copyCoinNameToClipboard(currentUser.id);
      }
    };
  }
  if (profileStatId) {
    profileStatId.style.cursor = "pointer";
    profileStatId.title = "Нажмите, чтобы скопировать ID";
    profileStatId.onclick = () => {
      if (currentUser && currentUser.id && typeof copyCoinNameToClipboard === "function") {
        copyCoinNameToClipboard(currentUser.id);
      }
    };
  }

  // Auth Tabs Toggle
  if (authTabLogin && authTabRegister && authLoginForm && authRegisterForm) {
    authTabLogin.onclick = () => {
      authTabLogin.classList.add("active");
      authTabRegister.classList.remove("active");
      authLoginForm.style.display = "flex";
      authRegisterForm.style.display = "none";
      showAuthError("");
    };
    authTabRegister.onclick = () => {
      authTabRegister.classList.add("active");
      authTabLogin.classList.remove("active");
      authRegisterForm.style.display = "flex";
      authLoginForm.style.display = "none";
      showAuthError("");
    };
  }

  // Login Form Handler
  if (authLoginForm) {
    authLoginForm.onsubmit = async (e) => {
      e.preventDefault();
      showAuthError("");
      const emailOrUsername = ($("login-email")?.value || "").trim();
      const password = $("login-password")?.value || "";

      try {
        const r = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emailOrUsername, password })
        });
        const data = await r.json();
        if (!r.ok || !data.success) {
          throw new Error(data.error || "Ошибка авторизации");
        }
        authToken = data.token;
        localStorage.setItem("obsidian_auth_token", authToken);
        renderProfile(data.user);
        if (authModal) authModal.style.display = "none";
        if (typeof showToast === "function") {
          showToast({ title: "Добро пожаловать!", message: `Вход выполнен успешно (${data.user.username})`, type: "success" });
        }
      } catch (err) {
        showAuthError(err.message);
        if (typeof showToast === "function") {
          showToast({ title: "Ошибка входа", message: err.message || "Неверный логин или пароль", type: "error" });
        }
      }
    };
  }

  // Register Form Handler
  if (authRegisterForm) {
    authRegisterForm.onsubmit = async (e) => {
      e.preventDefault();
      showAuthError("");
      const username = ($("reg-username")?.value || "").trim();
      const email = ($("reg-email")?.value || "").trim().toLowerCase();
      const password = $("reg-password")?.value || "";

      if (username.length < 2) {
        showAuthError("Имя пользователя должно содержать минимум 2 символа");
        return;
      }

      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (!email || !emailRegex.test(email) || email.includes("..")) {
        showAuthError("Введите настоящий Email адрес (например: name@domain.com)");
        return;
      }

      const domain = email.split("@")[1] || "";
      const tld = domain.split(".").pop() || "";
      const disposableDomains = ["mailinator.com", "tempmail.com", "10minutemail.com", "guerrillamail.com", "trashmail.com", "yopmail.com", "dispostable.com", "fake.com", "test.com", "example.com", "asdf.com", "qwerty.com"];
      const fakeTlds = ["test", "example", "invalid", "localhost", "local", "sdfg", "asdf", "qwerty"];
      if (disposableDomains.includes(domain) || fakeTlds.includes(tld) || tld.length < 2) {
        showAuthError("Регистрация с временных или недействительных Email адресов запрещена");
        return;
      }

      if (/[а-яА-ЯЁё]/i.test(password)) {
        showAuthError("Пароль должен быть на английском языке (без кириллицы)");
        return;
      }

      if (/\s/.test(password)) {
        showAuthError("Пароль не должен содержать пробелы");
        return;
      }

      if (password.length < 8 || password.length > 128) {
        showAuthError("Пароль должен быть длиной от 8 до 128 символов");
        return;
      }

      if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{}|;:,.<>?/~'"]+$/.test(password)) {
        showAuthError("Пароль должен содержать только английские буквы, цифры и спецсимволы");
        return;
      }

      if (!/[a-zA-Z]/.test(password)) {
        showAuthError("Пароль должен содержать хотя бы одну английскую букву");
        return;
      }

      if (!/[0-9!@#$%^&*()_+\-=\[\]{}|;:,.<>?/~'"]/.test(password)) {
        showAuthError("Пароль должен содержать хотя бы одну цифру или спецсимвол");
        return;
      }

      try {
        const r = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, email, password })
        });
        const data = await r.json();
        if (!r.ok || !data.success) {
          throw new Error(data.error || "Ошибка регистрации");
        }
        authToken = data.token;
        localStorage.setItem("obsidian_auth_token", authToken);
        renderProfile(data.user);
        if (authModal) authModal.style.display = "none";
        if (typeof showToast === "function") {
          showToast({ title: "Регистрация успешна", message: `Добро пожаловать, ${data.user.username}! Аккаунт успешно создан`, type: "success" });
        }
      } catch (err) {
        showAuthError(err.message);
        if (typeof showToast === "function") {
          showToast({ title: "Ошибка регистрации", message: err.message || "Ошибка создания аккаунта", type: "error" });
        }
      }
    };
  }

  // Telegram Auth Handler via Bot
  if (telegramAuthBtn) {
    telegramAuthBtn.onclick = async () => {
      showAuthError("");
      try {
        const r = await fetch("/api/auth/telegram-start", { method: "POST" });
        const data = await r.json();
        if (!r.ok || !data.success || !data.botUrl) {
          throw new Error(data.error || "Не удалось запустить авторизацию Telegram");
        }

        // Open Telegram Bot link
        window.open(data.botUrl, "_blank");

        if (typeof showToast === "function") {
          showToast({ title: "Авторизация Telegram", message: "Перейдите в Telegram и нажмите START для завершения входа", type: "info" });
        }

        // Poll for authorization approval
        const regToken = data.regToken;
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          if (pollCount > 80) { // 2 minutes max
            clearInterval(pollInterval);
          }
          try {
            const pollRes = await fetch(`/api/auth/telegram-poll?token=${regToken}`);
            const pollData = await pollRes.json();
            if (pollData.status === "approved" && pollData.token && pollData.user) {
              clearInterval(pollInterval);
              authToken = pollData.token;
              localStorage.setItem("obsidian_auth_token", authToken);
              renderProfile(pollData.user);
              if (authModal) authModal.style.display = "none";
              if (typeof showToast === "function") {
                showToast({ title: "Успешный вход", message: `Вход через Telegram выполнен! Добро пожаловать, ${pollData.user.username || 'пользователь'}`, type: "success" });
              }
            }
          } catch (_) {}
        }, 1500);

      } catch (err) {
        showAuthError(err.message);
      }
    };
  }

  // Save Profile Name Handler
  if (profileSaveBtn && profileNameInput) {
    profileSaveBtn.onclick = async () => {
      const newName = profileNameInput.value.trim();
      if (!newName) return;
      if (authToken) {
        try {
          const r = await fetch("/api/auth/update-profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`
            },
            body: JSON.stringify({ username: newName })
          });
          const data = await r.json();
          if (data.success && data.user) {
            renderProfile(data.user);
            if (typeof showToast === "function") showToast({ title: "Профиль обновлен", message: "Имя профиля успешно сохранено", type: "success" });
          }
        } catch (_) {}
      } else if (profileNameDisplay) {
        profileNameDisplay.textContent = newName;
      }
    };
  }

  // Logout Handler
  if (authLogoutBtn) {
    authLogoutBtn.onclick = () => {
      authToken = "";
      setStoredAuthToken("");
      if (profileModal) profileModal.style.display = "none";
      renderProfile(null);
      if (typeof showToast === "function") {
        showToast({ title: "Выход из аккаунта", message: "Вы успешно вышли из аккаунта. До новых встреч!", type: "info" });
      }
    };
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

// Scroll: vertical = X-zoom; horizontal = X-pan; Ctrl/Cmd = Y-zoom
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (e.shiftKey || quickMeasure) return;
    const PW = chartW - PR_WIDTH;

    let dx = e.deltaX || 0;
    let dy = e.deltaY || 0;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= 100; dy *= 100; }

    if (Math.abs(dx) > Math.abs(dy)) {
      // Trackpad horizontal swipe = PAN left/right smoothly
      const panShift = clamp(dx * 0.015, -8, 8);
      offsetX = getClampedOffsetX(offsetX + panShift);
    } else if (e.ctrlKey || e.altKey || e.metaKey) {
      // Ctrl/Alt/Cmd + scroll = Y zoom around mouse position
      autoFitY = false;
      const factor = clamp(1 + dy * 0.0004, 0.90, 1.10);
      const center = (viewMn + viewMx) / 2;
      let half = ((viewMx - viewMn) / 2) * factor;
      const minHalf = Math.max(Math.abs(center) * 0.0001, 1e-8);
      const maxHalf = Math.max(Math.abs(center) * 50, 1);
      half = clamp(half, minHalf, maxHalf);
      viewMn = center - half;
      viewMx = center + half;
    } else {
      // Vertical scroll = Smooth X-zoom anchored at mouse (TradingView trackpad feel)
      const r = canvas.getBoundingClientRect();
      const mouseX = e.clientX - r.left;
      const nBefore = PW / candleW;
      const vStartBefore = candles.length - nBefore - offsetX;
      const pivot = vStartBefore + mouseX / candleW;

      const factor = clamp(1 - dy * 0.0004, 0.90, 1.10);
      candleW = clamp(candleW * factor, 1.5, 60);

      const nAfter = PW / candleW;
      const vStartAfter = pivot - mouseX / candleW;
      offsetX = getClampedOffsetX(candles.length - nAfter - vStartAfter);
    }
    requestDraw();
  },
  { passive: false },
);

// Double-click: open Fib Grid editor if clicking a fib drawing, otherwise do nothing
canvas.addEventListener("dblclick", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;

  const idx = findDrawingIndexAt(px, py);
  if (idx >= 0 && chartDrawings[idx]?.type === "fibgrid") {
    configureFibDrawing(chartDrawings[idx], e.pageX, e.pageY);
    return;
  }
});

// тХРтХРтХР WebSocket connection to Node aggregator тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
let wsPingTimer = null;
let wsReconnectTimer = null;
let lastWsMsg = 0;

// Watchdog: if no data for 4s while connected тАФ force auto-reconnect instantly
setInterval(() => {
  if (lastWsMsg > 0 && Date.now() - lastWsMsg > 4000) {
    console.warn("[WS] Quiet for 4s - auto-reconnecting...");
    $("cd-label").textContent = "Reconnecting...";
    if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(); } catch (_) { } }
    ws = null;
    wsReady = false;
    idToKey = {};
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    connectWS();
  }
}, 2000);

function connectWS() {
  // Cancel any pending reconnect
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

  const wsUrl =
    location.protocol === "file:"
      ? "ws://localhost:3000/ws"
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

  // Tear down old connection cleanly
  if (ws) {
    ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
    try { ws.close(); } catch (_) { }
    ws = null;
  }
  if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }

  $("cd-label").textContent = "Connecting...";
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    wsReady = true;
    console.log("[WS] Connected");
    $("cd-go").classList.remove("err");
    $("cd-go").classList.add("ok");
    $("cd-label").textContent = "LIVE";
    hideLoading();
    for (const key of marketListeners.keys()) {
      const [ex, sym, tf] = key.split("|");
      sendMarketSubscription("subscribe_kline", ex, sym, tf);
    }
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
    // тФАтФА Binary Protocol Handler (Ultra-Sync 3.0) тФАтФА
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
          // Coin not yet in map тАФ create it from key
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
        if (c.p !== oldP) {
          scheduleInterp(key);
          checkPriceAlerts(c.ex, c.sym, p);
        }

        if (key === `${activeEx}:${activeSym}` && candles.length > 0 && !hasMainMarketStream()) {
          const lastC = candles[candles.length - 1];
          lastC.c = p;
          if (p > lastC.h) lastC.h = p;
          if (p < lastC.l) lastC.l = p;
          chartNeedsDraw = true;
        }
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

    if (msg.type === "heartbeat") return;
    if (msg.type === "kline" || msg.type === "market_tick" || msg.type === "market_status") {
      dispatchMarketMessage(msg);
      return;
    }

    if (msg.type === "ticker_map") {
      const prevSize = Object.keys(idToKey).length;
      // Server sends {keyтЖТid}, we need {idтЖТkey} for binary protocol lookup
      for (const [key, id] of Object.entries(msg.data)) {
        idToKey[id] = key;
      }
      const newSize = Object.keys(idToKey).length;
      console.log(`[BINARY] Ticker map updated: ${newSize} entries (+${newSize - prevSize})`);
      // If new keys arrived тАФ request fresh snapshot so we get their current prices
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
            dot.style.boxShadow = "none";
            dot.style.opacity = "1";
          }
        });
      });
      return;
    }
    if (msg.type === "walls") {
      let incomingWalls = null;
      let meta = msg.meta || null;
      if (Array.isArray(msg.data)) {
        incomingWalls = msg.data;
      } else if (msg.data && Array.isArray(msg.data.walls)) {
        incomingWalls = msg.data.walls;
        meta = msg.data;
      }

      if (incomingWalls) {
        if (incomingWalls.length > 0 || !densityData.length || (meta && !meta.partial)) {
          densityData = incomingWalls;
        }
        if (meta && Array.isArray(meta.history)) densityHistoryData = meta.history;
        densityLastUpdate = (meta && meta.updatedAt) || Date.now();
        if (typeof updateDensityStatusUI === "function") updateDensityStatusUI(meta);
        if (typeof updateDensityExchangeCounts === "function") updateDensityExchangeCounts();
        if (activeView === "map") {
          layoutDensityBadges();
        } else {
          requestAnimationFrame(drawChart);
          if (typeof chartInstances !== "undefined" && Array.isArray(chartInstances)) {
            chartInstances.forEach(inst => {
              if (inst && inst.key) {
                const c = coins.get(inst.key);
                if (c && c.p > 0) inst.update(c);
              } else if (inst && typeof inst.draw === "function") {
                inst.draw();
              }
            });
          }
        }
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
          if (c.p !== oldP) {
            scheduleInterp(key);
            checkPriceAlerts(c.ex, c.sym, p);
          }
        } else {
          processTickerUpdateFlat(key, p, chg, v, h, l, o, funding, nextFunding, oi, trades);
          addedNew = true;
        }
        dirty.add(key);

        if (screenerView === "multichart" || activeView === "formations") {
          for (let j = 0; j < chartInstances.length; j++) {
            const inst = chartInstances[j];
            if (inst && inst.sym) {
              if (!inst.key) inst.key = `${inst.ex}:${inst.sym}`;
              if (inst.key === key) inst.update(c);
            }
          }
        }

        if (key === activeKey && candles.length > 0 && !hasMainMarketStream()) {
          const lastC = candles[candles.length - 1];
          lastC.c = p;
          if (p > lastC.h) lastC.h = p;
          if (p < lastC.l) lastC.l = p;
          chartNeedsDraw = true;
        }
      }
      if (addedNew) needRebuild = true;
    }
  };

  ws.onclose = (e) => {
    wsReady = false;
    if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
    $("cd-go").classList.remove("ok");
    $("cd-go").classList.add("err");
    $("cd-label").textContent = "Reconnecting...";
    // Reset idToKey тАФ server may have restarted with new indices
    idToKey = {};
    console.log("[WS] Closed, code:", e.code, "- reconnecting in 2s");
    wsReconnectTimer = setTimeout(connectWS, 2000);
  };
  ws.onerror = (e) => {
    console.warn("[WS] Error:", e.message || e.type);
    // onclose will fire after onerror automatically
  };
}

// Reconnect & Auto-Unfreeze when tab becomes visible or window gains focus (prevents chart freezes on tab switch)
function unfreezeAndResync() {
  lastRafTs = performance.now();
  chartNeedsDraw = true;
  const isHealthy = ws && ws.readyState === WebSocket.OPEN && (lastWsMsg > 0 && Date.now() - lastWsMsg < 4000);

  if (!isHealthy) {
    console.log("[WS] Tab / Window active - socket quiet or closed, reconnecting...");
    connectWS();
  } else if (activeEx && activeSym && activeTf) {
    fetchKlines(activeEx, activeSym, activeTf);
  }

  if (screenerView === "multichart" || activeView === "formations") {
    chartInstances.forEach(inst => { inst.dirty = true; inst.draw(true); });
  } else {
    drawChart();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    unfreezeAndResync();
  }
});

window.addEventListener("focus", () => {
  unfreezeAndResync();
});

// Reconnect on network restore
window.addEventListener("online", () => {
  unfreezeAndResync();
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

// тХРтХРтХР Fallback removed тАФ all data via server WS тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР

// тХРтХРтХР Klines тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
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
  let t = +raw.t;
  if (!Number.isFinite(t) || t <= 0) return null;

  // Normalize timestamp: nanoseconds/microseconds/seconds -> milliseconds.
  if (t > 1e17) t = Math.floor(t / 1e6);
  else if (t > 1e14) t = Math.floor(t / 1e3);
  if (t < 1e11) t = t * 1000;
  t = Math.floor(t);

  let o = +raw.o,
    h = +raw.h,
    l = +raw.l,
    c = +raw.c,
    v = +raw.v;

  if (![o, h, l, c].every(Number.isFinite)) return null;
  if (o <= 0 || h <= 0 || l <= 0 || c <= 0) return null;

  // Reject phantom future candles (> 1 hour in future)
  if (t > Date.now() + 3600000) return null;

  h = Math.max(h, o, l, c);
  l = Math.min(l, o, h, c);

  return { t, o, h, l, c, v: Number.isFinite(v) && v >= 0 ? v : 0 };
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
  return out.slice(-3000);
}

let currentLoadedEx = null;
let currentLoadedSym = null;
let currentLoadedTf = null;

async function fetchDirectKlines(ex, sym, tf) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 900);

  try {
    let resultCandles = [];
    const tfMs = TF_MS[tf] || 60000;
    const now = Date.now();
    const encSym = encodeURIComponent(sym);

    if (ex === "BN" || ex === "AD") {
      const domain = ex === "BN" ? "fapi.binance.com" : "fstream.asterdex.com";
      const [r1, r2] = await Promise.all([
        fetch(`https://${domain}/fapi/v1/klines?symbol=${encSym}&interval=${TFB[tf] || tf}&limit=1000`, { signal: controller.signal }).then(r => r.json()).catch(() => []),
        fetch(`https://${domain}/fapi/v1/klines?symbol=${encSym}&interval=${TFB[tf] || tf}&limit=1000&endTime=${now - 1000 * tfMs}`, { signal: controller.signal }).then(r => r.json()).catch(() => [])
      ]);
      const merged = [...(Array.isArray(r2) ? r2 : []), ...(Array.isArray(r1) ? r1 : [])];
      if (merged.length > 0) resultCandles = sanitizeCandles(merged.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] || +k[5] })));
    } else if (ex === "BB") {
      const [r1, r2] = await Promise.all([
        fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encSym}&interval=${TFBB[tf] || "60"}&limit=1000`, { signal: controller.signal }).then(r => r.json()).catch(() => null),
        fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encSym}&interval=${TFBB[tf] || "60"}&limit=1000&end=${now - 1000 * tfMs}`, { signal: controller.signal }).then(r => r.json()).catch(() => null)
      ]);
      const l1 = r1?.result?.list || [];
      const l2 = r2?.result?.list || [];
      const merged = [...l2, ...l1];
      if (merged.length > 0) resultCandles = sanitizeCandles(merged.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] })));
    } else if (ex === "OX") {
      const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${encSym}&bar=${TFOK[tf] || "1H"}&limit=300`, { signal: controller.signal });
      const data = await r.json();
      if (data.data) resultCandles = sanitizeCandles(data.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] || +k[6] || +k[5] })));
    } else if (ex === "BG") {
      const r = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${encSym}&granularity=${TFOK[tf] || "1H"}&limit=1000`, { signal: controller.signal });
      const data = await r.json();
      if (data.data) resultCandles = sanitizeCandles(data.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] })));
    } else if (ex === "GT") {
      const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encSym}&interval=${tf}&limit=1000`, { signal: controller.signal });
      const data = await r.json();
      if (Array.isArray(data)) resultCandles = sanitizeCandles(data.map(k => ({ t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +(k.a || k.v) })));
    } else if (ex === "MX") {
      const mxSym = sym.includes("_") ? sym : (sym.endsWith("USDT") ? sym.replace(/USDT$/i, "_USDT") : sym + "_USDT");
      const mxTfMap = { "1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1", "3d": "Day3", "1w": "Week1" };
      const r = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(mxSym)}?interval=${mxTfMap[tf] || "Min60"}`, { signal: controller.signal });
      const data = await r.json();
      if (data.data?.time) resultCandles = sanitizeCandles(data.data.time.map((t, i) => {
        const c = +data.data.close[i];
        const v = data.data.amount ? +data.data.amount[i] : (+data.data.vol[i] * c);
        return { t: t * 1000, o: +data.data.open[i], h: +data.data.high[i], l: +data.data.low[i], c, v };
      }));
    } else if (ex === "KC") {
      const kcTfMap = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
      const r = await fetch(`https://api-futures.kucoin.com/api/v1/kline/query?symbol=${encSym}&granularity=${kcTfMap[tf] || 60}`, { signal: controller.signal });
      const data = await r.json();
      if (data.data) resultCandles = sanitizeCandles(data.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] })));
    } else if (ex === "BX") {
      const bxSym = sym.includes("-") ? sym : (sym.endsWith("USDT") ? sym.replace(/USDT$/, "-USDT") : sym + "-USDT");
      const bxTfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
      const [r1, r2] = await Promise.all([
        fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${encodeURIComponent(bxSym)}&interval=${bxTfMap[tf] || "1h"}&limit=1000`, { signal: controller.signal }).then(r => r.json()).catch(() => null),
        fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${encodeURIComponent(bxSym)}&interval=${bxTfMap[tf] || "1h"}&limit=1000&endTime=${now - 1000 * tfMs}`, { signal: controller.signal }).then(r => r.json()).catch(() => null)
      ]);
      const l1 = r1?.data || [];
      const l2 = r2?.data || [];
      const merged = [...l2, ...l1];
      if (merged.length > 0) resultCandles = sanitizeCandles(merged.map(k => ({ t: +(k.time || k.t || 0), o: +(k.open || k.o || 0), h: +(k.high || k.h || 0), l: +(k.low || k.l || 0), c: +(k.close || k.c || 0), v: +(k.volume || k.v || 0) * +(k.close || k.c || 0) })));
    } else if (ex === "HT") {
      const htTfMap = { "1m": "1min", "5m": "5min", "15m": "15min", "1h": "60min", "4h": "4hour", "1d": "1day" };
      const r = await fetch(`https://api.hbdm.com/linear-swap-ex/market/history/kline?contract_code=${encSym}&period=${htTfMap[tf] || "60min"}&size=1000`, { signal: controller.signal });
      const data = await r.json();
      if (data.data) resultCandles = sanitizeCandles(data.data.map(k => ({ t: k.id * 1000, o: +k.open, h: +k.high, l: +k.l, c: +k.close, v: +(k.trade_turnover || k.amount || k.vol) })));
    } else if (ex === "HL") {
      const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ type: "candleSnapshot", req: { coin: sym, interval: tf.toLowerCase(), startTime: Date.now() - (2000 * tfMs), endTime: Date.now() } }) });
      const data = await r.json();
      if (Array.isArray(data)) resultCandles = sanitizeCandles(data.map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c })));
    }
    return resultCandles;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchServerKlines(ex, sym, tf, lite = 1) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(`/api/klines?ex=${encodeURIComponent(ex)}&sym=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}&lite=${lite}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      if (typeof data[0] === 'number') {
        const flat = [];
        for (let i = 0; i < data.length; i += 6) {
          flat.push({ t: data[i], o: data[i + 1], h: data[i + 2], l: data[i + 3], c: data[i + 4], v: data[i + 5] });
        }
        return sanitizeCandles(flat);
      }
      return sanitizeCandles(data);
    }
    return [];
  } catch (_) {
    return [];
  }
}

async function fetchKlines(ex, sym, tf) {
  const fetchToken = ++klFetchToken;
  if (klWs) { try { klWs.onclose = null; klWs.close(); } catch (_) { } klWs = null; }
  if (klPoll) { clearInterval(klPoll); klPoll = null; }

  // When switching coin, exchange OR timeframe, clear candles so old timeframe candles do not mix!
  if (currentLoadedEx !== ex || currentLoadedSym !== sym || currentLoadedTf !== tf) {
    candles = [];
    currentLoadedEx = ex;
    currentLoadedSym = sym;
    currentLoadedTf = tf;
  }

  isLoadingOlderCandles = false;
  hasReachedStartOfHistory = false;
  offsetX = -6;
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
  ctx.fillText("Loading " + sym + "...", chartW / 2, chartH / 2);
  ctx.textAlign = "left";

  // Connect WebSocket stream immediately (0ms delay) while HTTP fetches candles in parallel
  connectKlWs(ex, sym, tf);

  try {
    const key = `${ex}|${sym}|${tf}`;
    const cached = KLINES_CACHE.get(key);
    let loadedSuccess = false;

    // 1. Instant cache hit (0ms)
    if (cached && Date.now() - cached.ts < KLINES_CACHE_TTL_MS) {
      candles = sanitizeCandles(cached.data);
      if (candles.length > 0) {
        loadedSuccess = true;
        updateOHLC();
        if (!chartW || !chartH) resizeChart();
        chartNeedsDraw = true;
      }
    }

    // 2. Ultra-fast parallel racer: Direct Exchange REST API and Server Proxy in parallel
    if (!loadedSuccess) {
      const directPromise = fetchDirectKlines(ex, sym, tf).then(c => (c && c.length > 0 ? c : Promise.reject()));
      const serverPromise = fetchServerKlines(ex, sym, tf, 1).then(c => (c && c.length > 0 ? c : Promise.reject()));

      let fastCandles = [];
      try {
        fastCandles = await Promise.any([directPromise, serverPromise]);
      } catch (_) {
        fastCandles = await fetchServerKlines(ex, sym, tf, 0);
      }

      if (fetchToken === klFetchToken && activeEx === ex && activeSym === sym && activeTf === tf) {
        if (fastCandles && fastCandles.length > 0) {
          candles = fastCandles;
          KLINES_CACHE.set(key, { ts: Date.now(), data: candles });
          loadedSuccess = true;
          updateOHLC();
          if (!chartW || !chartH) resizeChart();
          chartNeedsDraw = true;
          drawChart();
        }
      }
    }

    // 3. Background full history fetch without blocking initial rendering
    setTimeout(() => {
      if (fetchToken !== klFetchToken) return;
      fetchServerKlines(ex, sym, tf, 0)
        .then(parsed => {
          if (fetchToken !== klFetchToken || activeEx !== ex || activeSym !== sym || activeTf !== tf) return;
          if (Array.isArray(parsed) && parsed.length > 0) {
            candles = parsed;
            KLINES_CACHE.set(key, { ts: Date.now(), data: parsed });
            chartNeedsDraw = true;
            drawChart();
          }
        })
        .catch(err => console.error("BG fetch error:", err));
    }, 150);

    if (fetchToken !== klFetchToken || activeEx !== ex || activeSym !== sym || activeTf !== tf) return;
    connectKlWs(ex, sym, tf);
  } catch (err) {
    console.error("klines", err);
    if (fetchToken === klFetchToken && activeEx === ex && activeSym === sym) {
      ctx.clearRect(0, 0, chartW, chartH);
      ctx.fillStyle = "var(--rd)";
      ctx.fillText("Loading error: " + err.message, chartW / 2, chartH / 2);
    }
  }
}

async function loadOlderHistory(ex, sym, tf) {
  if (isLoadingOlderCandles || hasReachedStartOfHistory || !candles.length) return;
  isLoadingOlderCandles = true;
  const curToken = klFetchToken;
  const oldestCandle = candles[0];
  const oldestTs = oldestCandle.t;

  try {
    let olderCandles = [];
    const tfMs = TF_MS[tf] || 60000;
    const endTime = oldestTs - 1;

    if (ex === "BN" || ex === "AD") {
      const domain = ex === "BN" ? "fapi.binance.com" : "fstream.asterdex.com";
      const r = await fetch(`https://${domain}/fapi/v1/klines?symbol=${sym}&interval=${TFB[tf] || tf}&limit=1000&endTime=${endTime}`);
      const data = await r.json();
      if (Array.isArray(data)) {
        olderCandles = data.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] || +k[5] }));
      }
    } else if (ex === "BB") {
      const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=${TFBB[tf] || "60"}&limit=1000&end=${endTime}`);
      const data = await r.json();
      if (data.result?.list) {
        olderCandles = data.result.list.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] }));
      }
    } else if (ex === "BX") {
      const bxSym = sym.includes("-") ? sym : (sym.endsWith("USDT") ? sym.replace(/USDT$/, "-USDT") : sym + "-USDT");
      const bxTfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
      const r = await fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/klines?symbol=${bxSym}&interval=${bxTfMap[tf] || "1h"}&limit=1000&endTime=${endTime}`);
      const data = await r.json();
      if (data.data) {
        olderCandles = data.data.map(k => ({ t: +(k.time || k.t || 0), o: +(k.open || k.o || 0), h: +(k.high || k.h || 0), l: +(k.low || k.l || 0), c: +(k.close || k.c || 0), v: +(k.volume || k.v || 0) * +(k.close || k.c || 0) }));
      }
    } else if (ex === "BG") {
      const r = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${sym}&granularity=${TFOK[tf] || "1H"}&limit=1000&endTime=${endTime}`);
      const data = await r.json();
      if (data.data) {
        olderCandles = data.data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] }));
      }
    } else if (ex === "GT") {
      const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${sym}&interval=${tf}&limit=1000&to=${Math.floor(endTime / 1000)}`);
      const data = await r.json();
      if (Array.isArray(data)) {
        olderCandles = data.map(k => ({ t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +(k.a || k.v) }));
      }
    } else if (ex === "HL") {
      const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: sym, interval: tf.toLowerCase(), startTime: endTime - (1000 * tfMs), endTime: endTime } }) });
      const data = await r.json();
      if (Array.isArray(data)) {
        olderCandles = data.map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v * +k.c }));
      }
    } else {
      const r = await fetch(`/api/klines?ex=${ex}&sym=${sym}&tf=${tf}&before=${endTime}`);
      const data = await r.json();
      if (Array.isArray(data)) olderCandles = data;
    }

    if (curToken !== klFetchToken || activeEx !== ex || activeSym !== sym || activeTf !== tf) return;

    const sanitized = sanitizeCandles(olderCandles).filter(c => c.t < oldestTs);
    if (!sanitized.length) {
      hasReachedStartOfHistory = true;
      return;
    }

    const addedCount = sanitized.length;
    candles = [...sanitized, ...candles];
    if (candles.length > 20000) {
      candles = candles.slice(-20000);
    }
    offsetX += addedCount;
    chartNeedsDraw = true;
    drawChart();
  } catch (err) {
    console.warn("loadOlderHistory error:", err);
  } finally {
    isLoadingOlderCandles = false;
  }
}

function appendCandle(k) {
  if (!candles.length || !k) return;
  const last = candles[candles.length - 1];

  const prev = candles.length > 1 ? candles[candles.length - 2].c : null;
  const clean = sanitizeCandle(k, prev);
  if (!clean) return;

  // Only accept updates that are NOT older than current last candle
  if (clean.t === last.t) {
    if (last.o === undefined || last.o === null) last.o = clean.o;
    last.h = Math.max(last.h, clean.h); // Keep historical high/low for current candle
    last.l = Math.min(last.l, clean.l);
    last.c = clean.c;
    last.v = clean.v;
  } else if (clean.t > last.t) {
    // Never fabricate missing exchange candles. Re-fetch the authoritative range instead.
    const tfMs = TF_MS[activeTf] || 60000;
    if (clean.t - last.t > tfMs * 1.5) {
      if (!window.isFetchingGap) {
        window.isFetchingGap = true;
        setTimeout(() => {
          Promise.resolve(fetchKlines(activeEx, activeSym, activeTf)).finally(() => { window.isFetchingGap = false; });
        }, 150);
      }
    }
    candles.push(clean);
    if (candles.length > 1500) {
      candles.shift();
      if (offsetX > 0) offsetX = getClampedOffsetX(offsetX - 1);
    }
    clearCandleCaches(candles);
  }
  chartNeedsDraw = true;
  updateOHLC();
  if (clean && clean.c > 0) {
    checkPriceAlerts(activeEx, activeSym, clean.c, clean.h, clean.l);
  }
}

function applyMainMarketTick(data) {
  if (!Array.isArray(data) || candles.length === 0) return;
  const eventTime = +data[0];
  const price = +data[1];
  const eventHigh = +data[2] || price;
  const eventLow = +data[3] || price;
  const firstPrice = +data[4] || price;
  if (!(eventTime > 0) || !(price > 0)) return;
  lastMarketEventAt = Date.now();

  const tfMs = TF_MS[activeTf] || 60000;
  let last = candles[candles.length - 1];
  if (eventTime >= last.t + tfMs) {
    const start = Math.floor(eventTime / tfMs) * tfMs;
    last = { t: start, o: firstPrice, h: eventHigh, l: eventLow, c: price, v: 0 };
    candles.push(last);
    if (candles.length > 1500) candles.shift();
    clearCandleCaches(candles);
  } else if (eventTime >= last.t) {
    last.c = price;
    last.h = Math.max(last.h, eventHigh, price);
    last.l = Math.min(last.l, eventLow, price);
  } else {
    return;
  }

  const ticker = coins.get(`${activeEx}:${activeSym}`);
  if (ticker) {
    ticker.prev = ticker.p;
    ticker.p = price;
    ticker.displayP = price;
    dirty.add(ticker.key);
  }
  chartNeedsDraw = true;
  updateOHLC();
  checkPriceAlerts(activeEx, activeSym, price, eventHigh, eventLow);

  const now = performance.now();
  if (now - lastLatencyPaintAt > 500) {
    lastLatencyPaintAt = now;
    const sourceLag = Math.max(0, Math.min(99_999, Date.now() - eventTime));
    const label = $("cd-label");
    if (label) label.textContent = `LIVE · ${Math.round(sourceLag)}ms`;
  }
}

function applyMainMarketStatus(status) {
  const label = $("cd-label");
  if (!label) return;
  if (status === "live") label.textContent = "LIVE";
  else if (status === "connecting") label.textContent = "MARKET SYNC";
}

function connectKlWs(ex, sym, tf) {
  if (klWs) { try { klWs.close(); } catch (_) { } klWs = null; }
  if (klPoll) { clearInterval(klPoll); klPoll = null; }

  // Production uses the pooled server relay: one normalized, recoverable stream for all 11 venues.
  if (location.protocol !== "file:") {
    const nextKey = marketKey(ex, sym, tf);
    if (mainMarketKey === nextKey && mainMarketUnsubscribe) return;
    if (mainMarketUnsubscribe) mainMarketUnsubscribe();
    mainMarketKey = nextKey;
    mainMarketUnsubscribe = subscribeMarketData({
      ex, sym, tf,
      onKline: data => {
        lastMarketEventAt = Date.now();
        appendCandle({ t: data[0], o: data[1], h: data[2], l: data[3], c: data[4], v: data[5] });
        checkPriceAlerts(ex, sym, data[4], data[2], data[3]);
      },
      onTick: applyMainMarketTick,
      onStatus: applyMainMarketStatus,
    });
    return;
  }

  // Direct browser fallback. Production charts use the normalized server market-data relay above.
  if (ex === "BN" || ex === "AD") {
    const domain = ex === "BN" ? "fstream.binance.com" : "fstream.asterdex.com";
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "3d": "3d", "1w": "1w" };
    const bnTf = tfMap[tf] || tf;
    const sLower = sym.toLowerCase();
    try {
      const streamPath = ex === "BN" ? "market/stream" : "stream";
      const streams = ex === "BN"
        ? `${sLower}@kline_${bnTf}/${sLower}@aggTrade`
        : `${sLower}@kline_${bnTf}/${sLower}@aggTrade/${sLower}@bookTicker`;
      klWs = new WebSocket(`wss://${domain}/${streamPath}?streams=${streams}`);
      klWs.onmessage = (e) => {
        try {
          const res = JSON.parse(e.data);
          const d = res.data || res;
          if (d && d.e === "kline" && d.k) {
            const k = d.k;
            appendCandle({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.q || +k.v });
          } else if (d && (d.e === "bookTicker" || d.e === "aggTrade")) {
            let p = 0;
            if (d.e === "bookTicker") {
              const b = +d.b, a = +d.a;
              p = (b > 0 && a > 0) ? (b + a) / 2 : (b || a || 0);
            } else {
              p = +d.p;
            }
            if (p > 0 && candles.length > 0) {
              const tfMs = TF_MS[activeTf] || 60000;
              const expectedStart = Math.floor(Date.now() / tfMs) * tfMs;
              let last = candles[candles.length - 1];
              if (expectedStart > last.t) {
                last = { t: expectedStart, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v: 0 };
                candles.push(last);
                if (candles.length > 1500) candles.shift();
                clearCandleCaches(candles);
              } else {
                last.c = p;
                if (p > last.h) last.h = p;
                if (p < last.l) last.l = p;
              }
              if (d.e === "aggTrade" && d.q) last.v += (+d.q || 0);
              chartNeedsDraw = true;
              updateOHLC();
              checkPriceAlerts(ex, sym, p);
            }
          }
        } catch (_) {}
      };
      return;
    } catch (_) {}
  }

  // Direct Browser WebSocket for Bybit (kline + sub-20ms ticker feed)
  if (ex === "BB") {
    const tfMap = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "3d": "3", "1w": "W" };
    const bbTf = tfMap[tf] || "60";
    try {
      klWs = new WebSocket("wss://stream.bybit.com/v5/public/linear");
      klWs.onopen = () => {
        klWs.send(JSON.stringify({ op: "subscribe", args: [`kline.${bbTf}.${sym}`, `tickers.${sym}`] }));
      };
      klWs.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d && d.topic) {
            if (d.topic.startsWith("kline.") && d.data && d.data.length) {
              const k = d.data[0];
              appendCandle({ t: +k.start, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.turnover || +k.volume });
            } else if (d.topic.startsWith("tickers.") && d.data) {
              const tickData = Array.isArray(d.data) ? d.data[0] : d.data;
              const p = +(tickData.lastPrice || tickData.bid1Price || tickData.ask1Price || 0);
              if (p > 0 && candles.length > 0) {
                const tfMs = TF_MS[activeTf] || 60000;
                const expectedStart = Math.floor(Date.now() / tfMs) * tfMs;
                let last = candles[candles.length - 1];
                if (expectedStart > last.t) {
                  last = { t: expectedStart, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v: 0 };
                  candles.push(last);
                  if (candles.length > 1500) candles.shift();
                  clearCandleCaches(candles);
                } else {
                  last.c = p;
                  if (p > last.h) last.h = p;
                  if (p < last.l) last.l = p;
                }
                chartNeedsDraw = true;
                updateOHLC();
              }
            }
          }
        } catch (_) {}
      };
      return;
    } catch (_) {}
  }

  // Direct Browser WebSocket for OKX
  if (ex === "OX") {
    const tfMap = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "3d": "3D", "1w": "1W" };
    const ch = "candle" + (tfMap[tf] || "1H");
    try {
      klWs = new WebSocket("wss://ws.okx.com:8443/ws/v5/public");
      klWs.onopen = () => {
        klWs.send(JSON.stringify({ op: "subscribe", args: [{ channel: ch, instId: sym }] }));
      };
      klWs.onmessage = (e) => {
        try {
          const str = e.data;
          if (str === "pong") return;
          const d = JSON.parse(str);
          if (d && d.data && d.data.length && d.arg && d.arg.channel === ch) {
            const k = d.data[0];
            appendCandle({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] || +k[5] });
          }
        } catch (_) {}
      };
      return;
    } catch (_) {}
  }

  // Fallback: Subscribe to server kline stream via main WS
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
  if (oc) oc.textContent = fP(c.c);
  if (ovl) ovl.textContent = fV(c.v);
  updateSymInfo();
}

// тХРтХРтХР Render engine (rAF = paint only, logic runs in MessageChannel) тХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
function startRender() {
  requestAnimationFrame(rafLoop);
}

// rAF loop: ONLY repaints the canvas тАФ runs at monitor refresh rate (60/120/144hz)
// All logic (interpolation, DOM updates) happens in the faster MessageChannel loop
function rafLoop() {
  const now = performance.now();
  const dt = Math.min((now - lastRafTs) / 1000, 0.05); // max 50ms step for stability
  lastRafTs = now;

  requestAnimationFrame(rafLoop);

  // Process price interpolations and DOM row updates aligned with V-Sync
  processTickData(dt);

  const ak = `${activeEx}:${activeSym}`;
  const ac = coins.get(ak);
  const isActiveAnimating = ac && ac.displayP && Math.abs(ac.p - ac.displayP) > 1e-8;

  if (screenerView === "multichart" || activeView === "formations") {
    chartInstances.forEach(inst => {
      if (inst.dirty) {
        inst.draw(true);
      }
    });
  } else if (chartNeedsDraw || isActiveAnimating) {
    chartNeedsDraw = false;
    drawChart();
  }
}

function isUsdtFutures(c) {
  if (!c || !c.sym || !c.key) return false;
  if (c._isUsdtFutures !== undefined) return c._isUsdtFutures;
  const s = c.sym.toUpperCase();
  const k = c.key.toUpperCase();

  if (k.includes("SPOT") || s.includes("SPOT")) return (c._isUsdtFutures = false);

  const isFuture = s.endsWith("USDT") ||
    s.endsWith("USDTM") ||
    s.includes("USDT-") ||
    s.includes("USDT_") ||
    s.includes("-SWAP") ||
    s.includes("-PERP") ||
    c.ex === "HL";

  return (c._isUsdtFutures = isFuture);
}

const STABLECOIN_BASES = new Set(['USDC', 'USDD', 'TUSD', 'DAI', 'FDUSD', 'USDP', 'BUSD', 'PYUSD', 'EUSD', 'USD', 'USDE', 'USDJ', 'FRAX', 'LUSD', 'GUSD', 'SUSD', 'CEUR', 'CUSD', 'USDY', 'USDX']);
function isStablecoinBase(c) {
  if (!c) return false;
  if (c.base) {
    const base = c.base.toUpperCase();
    if (STABLECOIN_BASES.has(base)) return true;
  }
  if (c.sym) {
    const sym = c.sym.toUpperCase();
    for (const stable of STABLECOIN_BASES) {
      if (sym.startsWith(stable) && sym.length > stable.length) {
        return true;
      }
    }
  }
  return false;
}

function rebuildList() {
  let list = Array.from(coins.values());

  // тФАтФАтФА Filter: USDT Futures Only тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

  // SMART PAUSE & DOM DIFFING: Only re-order DOM nodes if order actually changed or filter changed
  if (!isHoveringScreener || needRebuild) {
    const newKeyOrder = sortedList.map(c => c.key).join(",");
    if (cl._lastOrder !== newKeyOrder) {
      cl._lastOrder = newKeyOrder;
      const nodes = sortedList.map(c => rowEls.get(c.key).el);
      cl.replaceChildren(...nodes);
    }
  }

  $("cnt").textContent = `(${list.length})`;
  updateSymInfo();
}

function createRow(c) {
  const el = document.createElement("div");
  el.className = "cr";
  el.setAttribute("role", "listitem");
  el.innerHTML = `<div class="ct"><div class="cdot"></div><span class="cname"></span></div><div class="cc"></div><div class="cv"></div><div class="ctrades"></div><div class="ccorr"></div><div class="cfunding"></div>`;
  const cells = {
    dot: el.querySelector(".cdot"),
    name: el.querySelector(".cname"),
    chg: el.querySelector(".cc"),
    vol: el.querySelector(".cv"),
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
  // тФАтФА 24h change % with subtle flash тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  const isPos = c.chg >= 0;
  const chgStr = fC(c.chg);
  if (rr.cells.chg.textContent !== chgStr) {
    rr.cells.chg.textContent = chgStr;
    rr.cells.chg.className = "cc " + (isPos ? "pos" : "neg");
  }

  // тФАтФА Volume 24h тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  const volStr = fV(c.v);
  if (rr.cells.vol.textContent !== volStr) {
    rr.cells.vol.textContent = volStr;
  }



  // тФАтФА NATR тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  let natr = 0;
  if (c.p > 0 && c.h && c.l && c.h >= c.l) {
    natr = ((c.h - c.l) / c.p) * 100;
  }
  natr = Math.max(0, Math.min(100, natr)); // clamp 0..100
  const natrStr = natr.toFixed(1);
  if (rr.cells.trades.textContent !== natrStr) {
    rr.cells.trades.textContent = natrStr;
  }

  // тФАтФА Funding тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  const funding = c.funding || 0;
  const fundStr = (funding >= 0 ? "+" : "") + funding.toFixed(3) + "%";
  if (rr.cells.funding.textContent !== fundStr) {
    rr.cells.funding.textContent = fundStr;
    rr.cells.funding.className = "cfunding " + (funding > 0 ? "pos" : funding < 0 ? "neg" : "");
  }

  // тФАтФА Correlation тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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
    if (rr._lastTag !== tagIdx) {
      rr._lastTag = tagIdx;
      rr._lastExIcon = null;
      rr.cells.dot.style.background = TAG_PALETTE[tagIdx];
      rr.cells.dot.classList.add("tagged");
    }
  } else {
    if (rr._lastExIcon !== c.ex || rr._lastTag !== null) {
      rr._lastTag = null;
      rr._lastExIcon = c.ex;
      const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%230D0F14%22/%3E%3Ccircle cx=%228%22 cy=%228%22 r=%223%22 fill=%22%23F0B90B%22/%3E%3Ccircle cx=%2216%22 cy=%228%22 r=%223%22 fill=%22%23F7A600%22/%3E%3Ccircle cx=%228%22 cy=%2216%22 r=%223%22 fill=%22%2300F0FF%22/%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%223%22 fill=%22%232EBD85%22/%3E%3C/svg%3E";
      const exIcons = { BN: "BN.svg", BB: "BB.svg", OX: "OK.svg", BG: "BG.svg", GT: "GT.svg", MX: "MX.svg", KC: "KC.svg", BX: "BX.svg", HT: "HX.svg", HL: "HL.svg", AD: "AS.svg" };
      if (exIcons[c.ex]) {
        rr.cells.dot.style.background = `center/contain no-repeat url('/img/${exIcons[c.ex]}')`;
      } else {
        rr.cells.dot.style.background = `center/contain no-repeat url('${ALL_EXC_IMG}')`;
      }
      rr.cells.dot.classList.remove("tagged");
    }
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
    schg = $("schg"),
    sv = $("sv"),
    snatr = $("snatr"),
    scorr = $("scorr"),
    sfun = $("sfun"),
    soi = $("soi");
  if (sn) sn.textContent = c.base + ".F";
  if (sc) {
    sc.textContent = fC(displayChg);
    sc.className = "sym-chg " + (displayChg >= 0 ? "pos" : "neg");
  }
  if (schg) {
    schg.textContent = fC(displayChg);
    schg.className = "sv " + (displayChg >= 0 ? "pos" : "neg");
  }
  if (sv) sv.textContent = fV(c.v);

  // NATR (Normalized ATR)
  let natr = 0;
  if (c.p > 0 && c.h && c.l && c.h >= c.l) {
    natr = ((c.h - c.l) / c.p) * 100;
  }
  natr = Math.max(0, Math.min(100, natr));
  if (snatr) {
    snatr.textContent = natr.toFixed(1);
    snatr.className = "sv " + (natr >= 5 ? "pos" : "");
  }

  // О.Корр (Overall Correlation)
  if (scorr) {
    const corrVal = c.corr !== undefined ? c.corr : "—";
    scorr.textContent = corrVal;
    scorr.className = "sv " + (typeof corrVal === "number" && corrVal > 50 ? "pos" : typeof corrVal === "number" && corrVal < 0 ? "neg" : "");
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
}

// тФАтФАтФА Drawing controls тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

// тФАтФА Density settings panel toggle тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const densitySettingsToggle = $("chart-density-settings-toggle");
const densityPanel = $("chart-density-panel");
const densityClose = $("chart-density-close");

if (densitySettingsToggle && densityPanel) {
  densitySettingsToggle.onclick = (e) => {
    e.stopPropagation();
    const isPro = window.currentUser && window.currentUser.plan === "pro";
    if (!isPro) {
      if (typeof openProModal === "function") {
        openProModal("Настройки графика и плотностей");
      }
      return;
    }
    const open = densityPanel.classList.contains("open");
    if (open) {
      densityPanel.classList.remove("open");
      densitySettingsToggle.classList.remove("on");
    } else {
      densityPanel.classList.add("open");
      densitySettingsToggle.classList.add("on");
    }
  };
}

if (densityClose && densityPanel && densitySettingsToggle) {
  densityClose.onclick = (e) => {
    e.stopPropagation();
    densityPanel.classList.remove("open");
    densitySettingsToggle.classList.remove("on");
  };
}

// Hide density panel when clicking outside
document.addEventListener("click", (e) => {
  if (densityPanel && densityPanel.classList.contains("open")) {
    const clickedToggle = densitySettingsToggle && densitySettingsToggle.contains(e.target);
    const clickedExWrap = document.getElementById("chart-density-exc-wrap");
    const clickedExMenu = clickedExWrap && clickedExWrap.contains(e.target);
    if (!densityPanel.contains(e.target) && !clickedToggle && !clickedExMenu) {
      densityPanel.classList.remove("open");
      if (densitySettingsToggle) densitySettingsToggle.classList.remove("on");
    }
  }
});

// Switch inside density settings panel
const densitySwitch = $("chart-density-switch");
if (densitySwitch) {
  if (chartDensityEnabled) densitySwitch.classList.add("on"); // match chartDensityEnabled default
  densitySwitch.onclick = () => {
    densitySwitch.classList.toggle("on");
    chartDensityEnabled = densitySwitch.classList.contains("on");
    saveChartDensitySettings();
    requestAnimationFrame(drawChart);
  };
}

// ════ Screener fullscreen toggle ════
const fullscreenToggleBtn = $("fullscreen-toggle");
if (fullscreenToggleBtn) {
  fullscreenToggleBtn.onclick = () => {
    if (document.fullscreenElement) {
      const p = document.exitFullscreen && document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else {
      const root = document.documentElement;
      try {
        const p = root.requestFullscreen
          ? root.requestFullscreen()
          : (root.webkitRequestFullscreen && root.webkitRequestFullscreen());
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}
    }
  };
  document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    fullscreenToggleBtn.classList.toggle("on", on);
    fullscreenToggleBtn.title = on ? "Выйти из полного экрана (Esc)" : "Скринер на весь экран";
    // Let canvases re-fit the new viewport size.
    setTimeout(() => window.dispatchEvent(new Event("resize")), 120);
  });
}

// Filter buttons inside density settings panel (toggle active states)
document.querySelectorAll(".chart-density-panel .chart-density-filter-btn").forEach(btn => {
  const savedSide = btn.dataset.chartDensitySide;
  const savedMarket = btn.dataset.chartDensityMarket;
  const savedSize = btn.id && btn.id.startsWith("chart-density-")
    ? btn.id.replace("chart-density-", "")
    : null;
  if (savedSide) btn.classList.toggle("on", savedSide === chartDensitySide);
  else if (savedMarket) btn.classList.toggle("on", savedMarket === chartDensityMarket);
  else if (savedSize) btn.classList.toggle("on", chartDensitySizes.has(savedSize));
  btn.onclick = () => {
    const side = btn.dataset.chartDensitySide;
    const market = btn.dataset.chartDensityMarket;
    if (side) {
      const parent = btn.parentElement;
      if (parent) {
        parent.querySelectorAll("[data-chart-density-side]").forEach(b => b.classList.remove("on"));
      }
      btn.classList.add("on");
      chartDensitySide = side;
    } else if (market) {
      const parent = btn.parentElement;
      if (parent) {
        parent.querySelectorAll("[data-chart-density-market]").forEach(b => b.classList.remove("on"));
      }
      btn.classList.add("on");
      chartDensityMarket = market;
    } else {
      btn.classList.toggle("on");
      const sizeId = btn.id; // e.g. chart-density-small
      if (sizeId) {
        const sizeType = sizeId.replace("chart-density-", "");
        if (btn.classList.contains("on")) {
          chartDensitySizes.add(sizeType);
        } else {
          chartDensitySizes.delete(sizeType);
        }
      }
    }
    saveChartDensitySettings();
    requestAnimationFrame(drawChart);
  };
});

// Indicators buttons inside density settings panel
const indInfoBox = $("chart-indicator-info-box");
// Map button IDs to correct indicator names that code expects
const indicatorIdToName = {
  "ind-cvd": "CVD",
  "ind-oi": "OI",
  "ind-ema20": "EMA 20",
  "ind-ema50": "EMA 50",
  "ind-ema200": "EMA 200",
  "ind-vwap": "VWAP",
  "ind-rsi": "RSI",
  "ind-atr": "ATR",
  "ind-volprofile": "VP",
  "ind-bb": "BB",
  "ind-macd": "MACD",
  "ind-liqmap": "LIQMAP"
};
const formationIdToName = {
  "fmt-cascades": "cascades",
  "fmt-levels": "levels",
  "fmt-trendlines": "trendlines",
  "fmt-retests": "retests"
};
const smcIdToName = {
  "smc-ob": "ob",
  "smc-fvg": "fvg",
  "smc-bos": "bos",
  "smc-eqh": "eqh"
};
function syncIndicatorButtonsUI() {
  document.querySelectorAll(".chart-density-panel .chart-indicator-grid-btn").forEach(btn => {
    const indicatorName = indicatorIdToName[btn.id];
    const formationName = formationIdToName[btn.id];
    const smcName = smcIdToName[btn.id];
    let isActive = false;
    if (indicatorName && chartActiveIndicators.has(indicatorName)) isActive = true;
    if (formationName && chartActiveFormations.has(formationName)) isActive = true;
    if (smcName && chartActiveSmc.has(smcName)) isActive = true;
    btn.classList.toggle("on", isActive);
  });
  document.querySelectorAll("#chart-density-panel [data-fmt-touches]").forEach(btn => {
    const val = parseInt(btn.dataset.fmtTouches, 10);
    btn.classList.toggle("on", val === chartFovCascadesMin);
  });
}
window.syncIndicatorButtonsUI = syncIndicatorButtonsUI;

document.querySelectorAll(".chart-density-panel .chart-indicator-grid-btn").forEach(btn => {
  btn.onclick = () => {
    btn.classList.toggle("on");
    const indName = indicatorIdToName[btn.id];
    const fmtName = formationIdToName[btn.id];
    const smcName = smcIdToName[btn.id];
    if (indName) {
      if (btn.classList.contains("on")) {
        chartActiveIndicators.add(indName);
      } else {
        chartActiveIndicators.delete(indName);
      }
      saveActiveIndicators();
    }
    if (smcName) {
      if (btn.classList.contains("on")) {
        chartActiveSmc.add(smcName);
      } else {
        chartActiveSmc.delete(smcName);
      }
      saveActiveSmc();
    }
    if (fmtName) {
      if (btn.classList.contains("on")) {
        chartActiveFormations.add(fmtName);
        chartFovTypes.add(fmtName);
      } else {
        chartActiveFormations.delete(fmtName);
        chartFovTypes.delete(fmtName);
      }
      chartFormationsOnChart = chartActiveFormations.size > 0;
      saveActiveFormations();
      try {
        localStorage.setItem('fov_settings', JSON.stringify({
          enabled: chartFormationsOnChart,
          types: Array.from(chartActiveFormations),
          cascadesMin: chartFovCascadesMin,
          breakoutMin: chartFovCascadesMin,
          trendlineMin: chartFovCascadesMin,
          retestApproaching: chartFovRetestApproaching,
          nearest: chartFovNearest,
          showLabels: chartFovShowLabels,
          showTouches: chartFovShowTouches
        }));
      } catch (_) {}
      requestAnimationFrame(drawChart);
    }
    requestAnimationFrame(drawChart);
  };

  // Hover descriptions
  btn.onmouseenter = () => {
    if (indInfoBox) {
      indInfoBox.textContent = btn.dataset.desc || "";
    }
  };
  btn.onmouseleave = () => {
    if (indInfoBox) {
      indInfoBox.textContent = "Наведите на индикатор, чтобы прочитать его описание.";
    }
  };
});

syncIndicatorButtonsUI();

// Touches filter buttons inside main settings panel
document.querySelectorAll("#chart-density-panel [data-fmt-touches]").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("#chart-density-panel [data-fmt-touches]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    const val = parseInt(btn.dataset.fmtTouches, 10);
    if (val) {
      chartFovCascadesMin = val;
      chartFovBreakoutMin = val;
      chartFovTrendlineMin = val;
      formationsMinTouches = val;
      formationsMinCascade = val;
      try {
        localStorage.setItem('fov_settings', JSON.stringify({
          enabled: chartFormationsOnChart,
          types: Array.from(chartFovTypes),
          cascadesMin: chartFovCascadesMin,
          breakoutMin: chartFovBreakoutMin,
          trendlineMin: chartFovTrendlineMin,
          retestApproaching: chartFovRetestApproaching,
          nearest: chartFovNearest,
          showLabels: chartFovShowLabels,
          showTouches: chartFovShowTouches
        }));
      } catch (_) {}
    }
    if (typeof window.loadFormations === "function") window.loadFormations();
    requestAnimationFrame(drawChart);
  };
});

// Cascade filter buttons inside main settings panel
document.querySelectorAll("#chart-density-panel [data-fmt-cascade]").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("#chart-density-panel [data-fmt-cascade]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    const val = parseInt(btn.dataset.fmtCascade, 10);
    if (val) formationsMinCascade = val;
    if (typeof window.loadFormations === "function") window.loadFormations();
    requestAnimationFrame(drawChart);
  };
});

// Tolerance filter buttons inside main settings panel
document.querySelectorAll("#chart-density-panel [data-fmt-tol]").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("#chart-density-panel [data-fmt-tol]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    const val = parseFloat(btn.dataset.fmtTol);
    if (val) formationsTolerance = val;
    if (typeof window.loadFormations === "function") window.loadFormations();
    requestAnimationFrame(drawChart);
  };
});

// Exchange selector inside density settings panel
const cDexBtn = $("chart-density-exc-btn");
const cDexMenu = $("chart-density-exc-menu");
const cDexName = $("chart-density-exc-name");
const cDexCbAll = document.querySelector(".chart-dex-cb-all");
const cDexCbs = document.querySelectorAll(".chart-dex-cb");

if (cDexBtn && cDexMenu) {
  cDexBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    cDexBtn.classList.toggle("open");
    cDexMenu.classList.toggle("open");
  });
}

function updateChartDexDropdownUI() {
  const allExes = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];
  if (chartDensityExes.size === allExes.length) {
    if (cDexName) cDexName.textContent = "Все биржи";
    if (cDexCbAll) cDexCbAll.checked = true;
    cDexCbs.forEach(cb => cb.checked = true);
  } else {
    if (chartDensityExes.size === 0) {
      if (cDexName) cDexName.textContent = "Выберите биржу";
    } else {
      if (cDexName) cDexName.textContent = `Выбрано: ${chartDensityExes.size}`;
    }
    if (cDexCbAll) cDexCbAll.checked = false;
    cDexCbs.forEach(cb => cb.checked = chartDensityExes.has(cb.value));
  }
}
updateChartDexDropdownUI();

if (cDexCbAll) {
  cDexCbAll.addEventListener("change", (e) => {
    const allExes = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"];
    if (e.target.checked) chartDensityExes = new Set(allExes);
    else chartDensityExes.clear();
    updateChartDexDropdownUI();
    saveChartDensitySettings();
    requestAnimationFrame(drawChart);
  });
}

cDexCbs.forEach(cb => {
  cb.addEventListener("change", (e) => {
    if (e.target.checked) chartDensityExes.add(cb.value);
    else chartDensityExes.delete(cb.value);
    updateChartDexDropdownUI();
    saveChartDensitySettings();
    requestAnimationFrame(drawChart);
  });
});

const settingsBtn = $("settings-btn");
const settingsOverlay = $("settings-overlay");
const settingsClose = $("settings-close");

if (settingsBtn && settingsOverlay) {
  const openSettings = () => {
    const isPro = window.currentUser && window.currentUser.plan === "pro";
    if (!isPro) {
      if (typeof openProModal === "function") {
        openProModal("Настройки оформления и интерфейса");
      }
      return;
    }
    settingsOverlay.style.display = "flex";
    settingsOverlay.classList.add("open");
  };
  const closeSettings = () => {
    settingsOverlay.style.display = "none";
    settingsOverlay.classList.remove("open");
  };

  settingsBtn.onclick = openSettings;
  if (settingsClose) settingsClose.onclick = closeSettings;
  settingsOverlay.onclick = (e) => {
    if (e.target === settingsOverlay) closeSettings();
  };
  window.openSettingsModal = openSettings;
  window.closeSettingsModal = closeSettings;

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

  // ═══ Formations Overlay Settings Init ═══
  (function initFormationsOverlay() {
    const LS_KEY = 'fov_settings';

    // Load saved settings. The overlay toggle was removed from the screener
    // settings panel, so the master switch stays off regardless of old state.
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (typeof saved.enabled === 'boolean') chartFormationsOnChart = saved.enabled;
      else if (chartActiveFormations && chartActiveFormations.size > 0) chartFormationsOnChart = true;
      if (Array.isArray(saved.types) && saved.types.length > 0) { chartFovTypes = new Set(saved.types); }
      else if (chartActiveFormations && chartActiveFormations.size > 0) { chartFovTypes = new Set(chartActiveFormations); }
      if (typeof saved.cascadesMin === 'number') chartFovCascadesMin = saved.cascadesMin;
      if (typeof saved.breakoutMin === 'number') chartFovBreakoutMin = saved.breakoutMin;
      if (typeof saved.trendlineMin === 'number') chartFovTrendlineMin = saved.trendlineMin;
      if (typeof saved.retestApproaching === 'boolean') chartFovRetestApproaching = saved.retestApproaching;
      if (typeof saved.nearest === 'boolean') chartFovNearest = saved.nearest;
      if (typeof saved.showLabels === 'boolean') chartFovShowLabels = saved.showLabels;
      if (typeof saved.showTouches === 'boolean') chartFovShowTouches = saved.showTouches;
    } catch(e) {}

    function saveSettings() {
      localStorage.setItem(LS_KEY, JSON.stringify({
        enabled: chartFormationsOnChart,
        types: Array.from(chartActiveFormations),
        cascadesMin: chartFovCascadesMin,
        breakoutMin: chartFovCascadesMin,
        trendlineMin: chartFovCascadesMin,
        retestApproaching: chartFovRetestApproaching,
        nearest: chartFovNearest,
        showLabels: chartFovShowLabels,
        showTouches: chartFovShowTouches
      }));
    }

    function syncUI() {
      // Master toggle (checkbox)
      const elEnabled = document.getElementById('fov-enabled');
      if (elEnabled) elEnabled.checked = chartFormationsOnChart;

      const controlsBody = document.getElementById('fov-controls-body');
      if (controlsBody) controlsBody.style.display = chartFormationsOnChart ? 'block' : 'none';

      // Type buttons
      document.querySelectorAll('button.fov-type-btn').forEach(btn => {
        const isSelected = chartFovTypes.has(btn.dataset.fov);
        btn.classList.toggle('on', isSelected);

        // Toggle visibility of matching sub-block
        const subBlock = document.getElementById('fov-sub-' + btn.dataset.fov);
        if (subBlock) subBlock.style.display = (chartFormationsOnChart && isSelected) ? 'block' : 'none';
      });


      // Cascades min buttons
      document.querySelectorAll('.fov-cascades-touch-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val) === chartFovCascadesMin);
      });

      // Breakout min buttons
      document.querySelectorAll('.fov-breakout-touch-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val) === chartFovBreakoutMin);
      });

      // Trendline min buttons
      document.querySelectorAll('.fov-trendline-touch-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val) === chartFovTrendlineMin);
      });

      // Retest approaching checkbox
      const elApp = document.getElementById('fov-retest-approaching');
      if (elApp) elApp.checked = chartFovRetestApproaching;

      // Nearest checkbox
      const elNear = document.getElementById('fov-nearest');
      if (elNear) elNear.checked = chartFovNearest;

      // Extra checkboxes
      const elLabels = document.getElementById('fov-show-labels');
      if (elLabels) elLabels.checked = chartFovShowLabels;
      const elTouches = document.getElementById('fov-show-touches');
      if (elTouches) elTouches.checked = chartFovShowTouches;
    }

    syncUI();

    // Master toggle
    const elEnabled = document.getElementById('fov-enabled');
    if (elEnabled) {
      elEnabled.onchange = () => {
        chartFormationsOnChart = elEnabled.checked;
        syncUI();
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    }


    // Type buttons
    document.querySelectorAll('button.fov-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fov = btn.dataset.fov;
        if (chartFovTypes.has(fov)) {
          chartFovTypes.delete(fov);
        } else {
          chartFovTypes.add(fov);
        }
        syncUI();
        saveSettings();
        requestAnimationFrame(drawChart);
      });
    });

    // Cascades min touch buttons
    document.querySelectorAll('.fov-cascades-touch-btn').forEach(btn => {
      btn.onclick = () => {
        chartFovCascadesMin = parseInt(btn.dataset.val) || 1;
        syncUI();
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    });

    // Breakout min touch buttons
    document.querySelectorAll('.fov-breakout-touch-btn').forEach(btn => {
      btn.onclick = () => {
        chartFovBreakoutMin = parseInt(btn.dataset.val) || 1;
        syncUI();
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    });

    // Trendline min touch buttons
    document.querySelectorAll('.fov-trendline-touch-btn').forEach(btn => {
      btn.onclick = () => {
        chartFovTrendlineMin = parseInt(btn.dataset.val) || 1;
        syncUI();
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    });

    // Retest approaching toggle
    const elApp = document.getElementById('fov-retest-approaching');
    if (elApp) {
      elApp.onchange = () => {
        chartFovRetestApproaching = elApp.checked;
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    }

    // Nearest toggle
    const elNear = document.getElementById('fov-nearest');
    if (elNear) {
      elNear.onchange = () => {
        chartFovNearest = elNear.checked;
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    }

    // Labels toggle
    const elLabels = document.getElementById('fov-show-labels');
    if (elLabels) {
      elLabels.onchange = () => {
        chartFovShowLabels = elLabels.checked;
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    }

    // Touch circles toggle
    const elTouchCircles = document.getElementById('fov-show-touches');
    if (elTouchCircles) {
      elTouchCircles.onchange = () => {
        chartFovShowTouches = elTouchCircles.checked;
        saveSettings();
        requestAnimationFrame(drawChart);
      };
    }
  })();



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
      if (!el) return;
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

    const DEFAULT_FORMATION_COLORS = {
      cascadeUp: "#94a3b8",
      cascadeUpOp: 75,
      cascadeDown: "#94a3b8",
      cascadeDownOp: 75,
      trendlineUp: "#94a3b8",
      trendlineUpOp: 75,
      trendlineDown: "#94a3b8",
      trendlineDownOp: 75,
      level: "#94a3b8",
      levelOp: 75,
      retest: "#94a3b8",
      retestOp: 75
    };

    const formationColorState = { ...DEFAULT_FORMATION_COLORS };

    // Global access
    window.candleSettings = candleState;
    window.volumeSettings = volumeState;
    window.formationColorSettings = formationColorState;

    // Load settings
    const loadSettings = () => {
      const savedCandles = localStorage.getItem("screener-candle-settings");
      if (savedCandles) Object.assign(candleState, JSON.parse(savedCandles));

      const savedVolume = localStorage.getItem("screener-volume-settings");
      if (savedVolume) Object.assign(volumeState, JSON.parse(savedVolume));

      const savedFmtColors = localStorage.getItem("screener-formation-colors");
      if (savedFmtColors) {
        try {
          Object.assign(formationColorState, JSON.parse(savedFmtColors));
        } catch (_) {}
      }

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
      } else if (id.startsWith("fmt-")) {
        const keyMap = {
          "fmt-cascade-up": "cascadeUp",
          "fmt-cascade-down": "cascadeDown",
          "fmt-trendline-up": "trendlineUp",
          "fmt-trendline-down": "trendlineDown",
          "fmt-level": "level",
          "fmt-retest": "retest"
        };
        const prop = keyMap[id];
        if (prop) {
          initialColor = formationColorState[prop] || "#94a3b8";
          initialOpacity = formationColorState[prop + "Op"] ?? 75;
          onUpdate = (c, o) => {
            formationColorState[prop] = c;
            formationColorState[prop + "Op"] = o;
            localStorage.setItem("screener-formation-colors", JSON.stringify(formationColorState));
            refreshCharts();
          };
        }
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

        localStorage.setItem("screener-formation-colors", JSON.stringify(formationColorState));

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
            if (
              key.startsWith("crypto_drawings_") ||
              key.startsWith("obsidian_auth_") ||
              key.startsWith("obsidian_tg_") ||
              key === "crypto_tags" ||
              key === "crypto_tool_colors"
            ) {
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

function hexToRgba(hex, opacity = 100) {
  if (!hex || typeof hex !== 'string') return `rgba(255, 255, 255, ${(opacity || 100) / 100})`;
  let r = 0, g = 0, b = 0;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) || 0;
    g = parseInt(hex[2] + hex[2], 16) || 0;
    b = parseInt(hex[3] + hex[3], 16) || 0;
  } else if (hex.length >= 7) {
    r = parseInt(hex.substring(1, 3), 16) || 0;
    g = parseInt(hex.substring(3, 5), 16) || 0;
    b = parseInt(hex.substring(5, 7), 16) || 0;
  }
  return `rgba(${r}, ${g}, ${b}, ${(opacity !== undefined ? opacity : 100) / 100})`;
}

function updateScreenerBgColor(color, save = true) {
  document.documentElement.style.setProperty("--screener-bg", color);
  document.documentElement.style.setProperty("--screener-header-bg", color);
  if (save) {
    localStorage.setItem("screener-sidebar-bg-color", color);
    localStorage.setItem("screener-sidebar-header-bg-color", color);
  }
}

function updateScreenerHeaderColor(color, save = true) {
  updateScreenerBgColor(color, save);
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

  if (typeof screenerView !== "undefined" && (screenerView === "multichart" || activeView === "formations")) {
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

  // тФАтФА High-Frequency Direct Feed тФАтФА

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

  // Mobile: scroll chart into view when coin selected
  if (window.innerWidth <= 767) {
    const chartArea = document.getElementById("chart-area");
    if (chartArea) chartArea.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function hideLoading() {
  const el = $("loading");
  el.classList.add("hide");
  setTimeout(() => (el.style.display = "none"), 300);
}

// тХРтХРтХР Exchange dropdown тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
const excBtn = $("exc-btn"),
  excMenu = $("exc-menu");

function toggleExcDropdown() {
  const open = excMenu.classList.contains("open");
  if (open) {
    excMenu.classList.remove("open");
    excBtn.classList.remove("open");
    excBtn.setAttribute("aria-expanded", "false");
  } else {
    const rect = excBtn.getBoundingClientRect();
    const menuWidth = 205;
    excMenu.style.position = "fixed";
    excMenu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 340) + "px";
    let rightPos = Math.max(8, window.innerWidth - rect.right);
    if (window.innerWidth - rightPos < menuWidth) {
      excMenu.style.right = "auto";
      excMenu.style.left = "8px";
    } else {
      excMenu.style.right = rightPos + "px";
      excMenu.style.left = "auto";
    }
    excMenu.style.zIndex = "999999";
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

document.querySelectorAll("#exc-menu .exc-item:not(.disabled)").forEach((item) => {
  item.addEventListener("click", () => {
    const cex = item.dataset.cex,
      label = item.dataset.label,
      img = item.dataset.img;
    document.querySelectorAll("#exc-menu .exc-item").forEach((x) => {
      x.classList.remove("on");
      x.setAttribute("aria-selected", "false");
    });
    item.classList.add("on");
    item.setAttribute("aria-selected", "true");
    $("exc-name").textContent = label;
    const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%230D0F14%22/%3E%3Ccircle cx=%228%22 cy=%228%22 r=%223%22 fill=%22%23F0B90B%22/%3E%3Ccircle cx=%2216%22 cy=%228%22 r=%223%22 fill=%22%23F7A600%22/%3E%3Ccircle cx=%228%22 cy=%2216%22 r=%223%22 fill=%22%2300F0FF%22/%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%223%22 fill=%22%232EBD85%22/%3E%3C/svg%3E";
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
      const EXC_BTC_MAP = {
        BN: "BTCUSDT", BB: "BTCUSDT", OX: "BTC-USDT-SWAP", BG: "BTCUSDT",
        GT: "BTC_USDT", MX: "BTC_USDT", KC: "XBTUSDTM", BX: "BTC-USDT",
        HT: "BTC-USDT", HL: "BTC", AD: "BTCUSDT"
      };
      const btcSearch = ["BTCUSDT", "BTC_USDT", "BTC-USDT", "BTC-USDT-SWAP", "XBTUSDTM", "BTC"];
      let foundSym = btcSearch.find(s => coins.has(cex + ":" + s));
      if (!foundSym) {
        for (let [key, t] of coins) {
          if (t.ex === cex) { foundSym = t.sym; break; }
        }
      }
      const btcSym = foundSym || EXC_BTC_MAP[cex] || "BTCUSDT";
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
  document.querySelectorAll("#exc-menu .exc-item").forEach((x) => {
    x.classList.remove("on");
    x.setAttribute("aria-selected", "false");
  });
  const item = document.querySelector(`#exc-menu .exc-item[data-cex="${ex}"]`);
  if (item) {
    item.classList.add("on");
    item.setAttribute("aria-selected", "true");
    // Only update the visible label if we are NOT in "All Exchanges" mode
    if (listEx !== "ALL") {
      $("exc-name").textContent = item.dataset.label;
      const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%230D0F14%22/%3E%3Ccircle cx=%228%22 cy=%228%22 r=%223%22 fill=%22%23F0B90B%22/%3E%3Ccircle cx=%2216%22 cy=%228%22 r=%223%22 fill=%22%23F7A600%22/%3E%3Ccircle cx=%228%22 cy=%2216%22 r=%223%22 fill=%22%2300F0FF%22/%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%223%22 fill=%22%232EBD85%22/%3E%3C/svg%3E";
      $("exc-dot").style.background = item.dataset.img ? `center/contain no-repeat url('${item.dataset.img}')` : `center/contain no-repeat url('${ALL_EXC_IMG}')`;
    }
  }
}

// тХРтХРтХР UI Events тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
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
if (typeof ResizeObserver !== "undefined" && $("cwrap")) {
  try {
    const cwrapObserver = new ResizeObserver(() => {
      resizeChart();
    });
    cwrapObserver.observe($("cwrap"));
  } catch (_) {}
}

// тХРтХРтХР Color Tagging & Filtering Logic тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР
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
  if (!grid) return;
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

// ═══ Density Blacklist Config ═══
const DEFAULT_DENSITY_BLACKLIST = [
  // User Screenshot & Majors:
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT",
  "DOTUSDT", "LTCUSDT", "BCHUSDT", "SUIUSDT", "HYPEUSDT",
  "ASTERUSDT", "1000PEPEUSDT", "1000SHIBUSDT", "ZECUSDT", "ETCUSDT",
  "WLFIUSDT", "NEARUSDT", "ENAUSDT",
  // Base tickers:
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "TRX",
  "DOT", "LTC", "BCH", "SUI", "HYPE", "ASTER", "1000PEPE", "PEPE", "1000SHIB", "SHIB",
  "ZEC", "ETC", "WLFI", "NEAR", "ENA",
  // Stables:
  "USDT", "USDC", "BUSD", "DAI", "FDUSD", "TUSD", "USDP", "USDE", "PYUSD",
  "USD1", "EUR1", "USDC1", "BTC1", "USTC", "USDD", "FRAX", "LUSD", "CRVUSD", "GUSD",
  "USDJ", "CUSD", "EUR", "GBP", "JPY", "AUD", "USD", "CHF", "TRY", "RUB", "BRL",
  "USDCUSDT", "BUSDUSDT", "FDUSDUSDT", "TUSDUSDT", "EURUSDT",
  // Stocks & Equities (OKX, Gate, Bitget):
  "AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOG", "GOOGL", "META", "NFLX", "COIN",
  "MSTR", "BAC", "AMD", "INTC", "PLTR", "BABA", "DIS", "PYPL", "UBER", "SPY",
  "QQQ", "IWM", "DIA", "V", "MA", "JPM", "WMT", "XOM", "CVX", "LLY",
  "UNH", "JNJ", "AVGO", "ORCL", "CRM", "CSCO", "ABT", "MRK", "PEP", "KO",
  "COST", "TMO", "MCD", "NKE", "ABBV", "DHR", "TXN", "NEE", "PM", "QCOM",
  "HON", "UNP", "LIN", "BMY", "AMGN", "LOW", "IBM", "SBUX", "GE", "CAT",
  "BA", "GS", "MS", "BLK", "C", "WFC", "AXP", "SCHW", "HOOD", "RBLX",
  "ARM", "SMCI", "SOFI", "MARA", "RIOT", "CLSK", "HUT", "BITF", "CRCL",
  "AVGOX", "AAPLX", "TSLAX", "NVDAX", "MSFTX", "AMZNX", "GOOGX", "GOOGLX", "METAX",
  // ETFs / Leveraged Index Funds:
  "TQQQ", "SQQQ", "SPXL", "SPXS", "SOXL", "SOXS", "UVXY", "SVXY", "VXX",
  "FAS", "FAZ", "LABU", "LABD", "NUGT", "DUST", "JNUG", "JDST",
  // Commodities & Indices:
  "XAU", "XAG", "GOLD", "SILVER", "OIL", "WTI", "BRENT", "COPPER", "NATGAS",
  "DOW", "SPX", "NDX", "US30", "US500", "USTECH", "DE40", "UK100", "JP225",
  "XAUT", "PAXG"
];

const KNOWN_STOCK_SET = new Set(DEFAULT_DENSITY_BLACKLIST.map(c => c.toUpperCase()));

function checkSingleStockClient(token) {
  if (!token) return false;
  if (token.endsWith("STOCK")) return true;
  if (KNOWN_STOCK_SET.has(token)) return true;

  let inner = token;
  if ((token.startsWith("R") || token.startsWith("X")) && token.length >= 4) {
    inner = token.slice(1);
    if (KNOWN_STOCK_SET.has(inner)) return true;
  }

  for (const root of DEFAULT_DENSITY_BLACKLIST) {
    if (root.length >= 3) {
      if (inner === root) return true;
      if (inner.startsWith(root) && inner.length <= root.length + 3) {
        const rem = inner.slice(root.length);
        if (["B", "X", "ON", "G", "M", "I", "STOCK"].includes(rem)) return true;
      }
    }
  }
  return false;
}

let densityBlacklistSet = (function() {
  try {
    const saved = localStorage.getItem("density_blacklist_coins");
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) return new Set(arr.map(c => String(c).trim().toUpperCase()));
    }
  } catch(_) {}
  return new Set(DEFAULT_DENSITY_BLACKLIST.map(c => c.toUpperCase()));
})();

function isBaseInDensityBlacklist(base, sym) {
  if (!base && !sym) return false;

  let s = String(sym || base).toUpperCase();
  const colonIdx = s.indexOf(":");
  if (colonIdx >= 0) s = s.slice(colonIdx + 1);

  s = s.replace(/_SPOT$/i, "")
       .replace(/[-_]?(SWAP|PERP)$/i, "")
       .replace(/[-_]?(USDT|USDC|BUSD|DAI|USD)$/i, "")
       .replace(/[-_]/g, "");

  let b = String(base || "").toUpperCase().replace(/[-_/]?(USDT|USD|PERP|SPOT)$/i, "").replace(/[-_]/g, "");

  if (checkSingleStockClient(s) || checkSingleStockClient(b)) return true;

  if (!densityBlacklistSet || densityBlacklistSet.size === 0) return false;

  const rawBase = (base || "").trim().toUpperCase();
  const rawSym = (sym || "").trim().toUpperCase();
  const cleanBase = rawBase.replace(/[-_/]?(USDT|USD|PERP)$/i, "");
  const cleanSym = rawSym.replace(/_SPOT$/i, "").replace(/[-_]/g, "");
  const fullSym = cleanBase + "USDT";

  return densityBlacklistSet.has(rawBase) ||
         densityBlacklistSet.has(cleanBase) ||
         densityBlacklistSet.has(rawSym) ||
         densityBlacklistSet.has(cleanSym) ||
         densityBlacklistSet.has(fullSym);
}

// ─── Density Map v2 ── Bubble Map ──────────────────────────────────────────
let densityCanvas, densityCtx, densityW, densityH;
let densityData = [];     // active wall objects from server
let densityHistoryData = []; // active + recently completed wall lifecycles
let densityBubbles = [];  // layout objects with {x,y,vx,vy,r,...}
let densityFilter = "all";
let densityMarket = "all";
let densitySize = "all";
let densitySort = "score"; // "score" | "size" | "dist"
let densitySearch = "";
let densityMinUsd = 0; // show every wall the scanner publishes by default
let densityMaxDistance = 3;
let densityMinAge = 0;
let densityExFilter = new Set(["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"]);
let densityVisibleData = [];
let densityHover = -1;
let densityMouseX = -1, densityMouseY = -1;
let densityAnimFrame = null;
let densityLastUpdate = 0;
const densityBubbleSpriteCache = new Map();
const DENSITY_SPRITE_W = 84;
const DENSITY_SPRITE_H = 92;

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
    this.dirty = true;
    this.levels = [];
    this._lastFormationDetectAt = 0;

    this.isDrag = false;
    this.isDragY = false;
    this.isDragYScale = false;
    this.dragStart = 0;
    this.dragStartY = 0;
    this.dragOff = 0;
    this.viewMn = null;
    this.viewMx = null;
    this.autoFitY = true;

    this.isRuler = false;
    this.rulerStart = { x: null, y: null, price: null, idx: null };
    this.rulerEnd = { x: null, y: null, price: null, idx: null };

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
          if (activeView === "formations") {
            const grid = document.getElementById("formations-grid");
            if (grid) {
              const isExpanded = this.el.classList.contains("expanded");
              if (isExpanded) {
                this.el.classList.remove("expanded");
                grid.classList.remove("has-expanded");
                this.fsBtn.title = "Развернуть";
                this.fsBtn.innerHTML = `
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M10 2H14V6M14 2L9 7M6 14H2V10M2 14L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                `;
                window.loadFormations();
              } else {
                grid.querySelectorAll(".grid-cell").forEach(cell => {
                  cell.classList.remove("expanded");
                  const btn = cell.querySelector(".cell-fs-btn");
                  if (btn) {
                    btn.title = "Развернуть";
                    btn.innerHTML = `
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M10 2H14V6M14 2L9 7M6 14H2V10M2 14L7 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    `;
                  }
                });
                this.el.classList.add("expanded");
                grid.classList.add("has-expanded");
                this.fsBtn.title = "Свернуть";
                this.fsBtn.innerHTML = `
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M4 12H1V9M1 12L6 7M12 4H15V7M15 4L10 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                `;
              }
              this.draw(true);
            }
          } else {
            const c = coins.get(`${this.ex}:${this.sym}`);
            if (c) {
              selectCoin(c);
              toggleScreenerView('single');
            }
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

      if (e.shiftKey) {
        this.isRuler = true;
        const n = PW / this.candleW;
        const viewStart = this.candles.length - n - this.offsetX;
        const s = Math.max(0, Math.floor(viewStart));
        const futureGap = viewStart < 0 ? -viewStart : 0;

        const idx = clamp(Math.round((px - this.candleW / 2) / this.candleW + s - futureGap), 0, this.candles.length - 1);
        const price = this.viewMx - (py / this.canvas.clientHeight) * (this.viewMx - this.viewMn);

        this.rulerStart = { x: px, y: py, price, idx };
        this.rulerEnd = { x: px, y: py, price, idx };
        this.draw(true);
        e.stopPropagation();
        return;
      }

      if (px >= PW) {
        this.isDragYScale = true;
        this.isManualYScale = true;
        this.dragStartY = e.clientY;
        this.yScaleStartMn = this.viewMn !== null ? this.viewMn : (this.lastMn || 0);
        this.yScaleStartMx = this.viewMx !== null ? this.viewMx : (this.lastMx || 1);
        this.autoFitY = false;
        return;
      }

      if (e.button === 0) {
        this.isDrag = true;
        this.dragStart = e.clientX;
        this.dragOff = this.offsetX;
        if (this.viewMn !== null && this.viewMx !== null) {
          this.isDragY = true;
          this.isManualYScale = true;
          this.dragStartY = e.clientY;
          this.dragMnOff = this.viewMn;
          this.dragMxOff = this.viewMx;
          this.autoFitY = false;
        }
        this.canvas.style.cursor = 'grabbing';
      } else if (e.button === 2) {
        if (this.viewMn !== null && this.viewMx !== null) {
          this.isDragY = true;
          this.isManualYScale = true;
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
      if (this.isRuler) {
        const r = this.canvas.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        const w = this.canvas.clientWidth;
        const PR = 60;
        const PW = w - PR;

        const n = PW / this.candleW;
        const viewStart = this.candles.length - n - this.offsetX;
        const s = Math.max(0, Math.floor(viewStart));
        const futureGap = viewStart < 0 ? -viewStart : 0;

        const idx = clamp(Math.round((px - this.candleW / 2) / this.candleW + s - futureGap), 0, this.candles.length - 1);
        const price = this.viewMx - (py / this.canvas.clientHeight) * (this.viewMx - this.viewMn);

        this.rulerEnd = { x: px, y: py, price, idx };
        this.draw(true);
        return;
      }

      if (this.isDrag) {
        const dx = e.clientX - this.dragStart;
        const w = this.canvas.clientWidth;
        const PR = 60;
        const PW = w - PR;
        const n = PW / this.candleW;
        const minOffsetX = -Math.max(0, n - 2);
        const maxOffsetX = Math.max(0, this.candles.length - 2);
        this.offsetX = Math.max(minOffsetX, Math.min(maxOffsetX, this.dragOff + dx / this.candleW));
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
      if (this.isRuler) {
        this.isRuler = false;
        this.rulerStart = { x: null, y: null, price: null, idx: null };
        this.rulerEnd = { x: null, y: null, price: null, idx: null };
        this.draw(true);
      }
      if (this.isDrag || this.isDragYScale || this.isDragY) {
        this.isDrag = false;
        this.isDragYScale = false;
        this.isDragY = false;
        this.canvas.style.cursor = 'crosshair';
      }
    });

    this.canvas.ondblclick = (e) => {
      e.preventDefault();
    };

    this.canvas.oncontextmenu = (e) => e.preventDefault();

    this.canvas.onwheel = (e) => {
      if (activeView === "screener" && screenerView !== "multichart") return;
      e.preventDefault();
      if (e.shiftKey || this.isRuler) return;
      let dy = e.deltaY || 0;
      if (e.deltaMode === 1) dy *= 16;
      const factor = clamp(1 - dy * 0.0004, 0.90, 1.10);
      this.candleW = clamp(this.candleW * factor, 0.90, 50);
      this.draw(true);
      e.stopPropagation();
    };

    if (window.ResizeObserver && this.el) {
      this._ro = new ResizeObserver(() => {
        if (activeView === "formations" || (activeView === "screener" && screenerView === "multichart")) {
          this.draw(true);
        }
      });
      this._ro.observe(this.el);
    }
  }

  refreshFormationLevels(force = false) {
    if (activeView !== 'formations' || this.loadingKlines || this.candles.length < 30) return;
    const now = performance.now();
    if (!force && now - this._lastFormationDetectAt < 900) return;
    this._lastFormationDetectAt = now;
    const next = window.detectChartLevelsFn?.(this.candles) || [];
    // During a live candle an intermediate wick can temporarily invalidate a
    // setup. Keep the last confirmed drawing until a positive replacement is
    // available; full history loads still establish the authoritative state.
    if (next.length > 0) {
      this.levels = next;
      window.registerFormationsCoinLevels?.(this.ex, this.sym, next);
    }
  }

  subscribeLive() {
    if (!this.ex || !this.sym || !this.tf || location.protocol === "file:") return;
    const nextKey = marketKey(this.ex, this.sym, this.tf);
    if (this._marketKey === nextKey && this._marketUnsub) return;
    this._marketUnsub?.();
    this._marketKey = nextKey;
    this._marketUnsub = subscribeMarketData({
      ex: this.ex,
      sym: this.sym,
      tf: this.tf,
      onKline: data => this.applyOfficialKline(data),
      onTick: data => this.applyOfficialTick(data),
    });
  }

  applyOfficialKline(data) {
    if (!Array.isArray(data)) return;
    const clean = sanitizeCandle({ t: data[0], o: data[1], h: data[2], l: data[3], c: data[4], v: data[5] });
    if (!clean || !this.candles.length) return;
    const last = this.candles[this.candles.length - 1];
    if (clean.t === last.t) Object.assign(last, clean);
    else if (clean.t > last.t) {
      this.candles.push(clean);
      if (this.candles.length > 1500) this.candles.shift();
    } else return;
    this.headerPrice.textContent = fP(clean.c);
    this.dirty = true;
    this.refreshFormationLevels();
    this.draw();
  }

  applyOfficialTick(data) {
    if (!Array.isArray(data) || !this.candles.length) return;
    const t = +data[0], p = +data[1], hi = +data[2] || p, lo = +data[3] || p;
    if (!(t > 0) || !(p > 0)) return;
    const tfMs = TF_MS[this.tf] || 60000;
    let last = this.candles[this.candles.length - 1];
    if (t >= last.t + tfMs) {
      last = { t: Math.floor(t / tfMs) * tfMs, o: +data[4] || p, h: hi, l: lo, c: p, v: 0 };
      this.candles.push(last);
      if (this.candles.length > 1500) this.candles.shift();
    } else if (t >= last.t) {
      last.c = p;
      last.h = Math.max(last.h, hi, p);
      last.l = Math.min(last.l, lo, p);
    } else return;
    this.headerPrice.textContent = fP(p);
    this.dirty = true;
    this.refreshFormationLevels();
    this.draw();
  }

  dispose() {
    this._marketUnsub?.();
    this._marketUnsub = null;
    this._marketKey = null;
    this._ro?.disconnect();
  }

  update(ticker) {
    if (!ticker) return;
    this.dirty = true;
    const changed = this.sym !== ticker.sym || this.ex !== ticker.ex;
    this.ex = ticker.ex;
    this.sym = ticker.sym;
    this.key = `${this.ex}:${this.sym}`;

    const exIcons = { BN: "BN.svg", BB: "BB.svg", OX: "OK.svg", BG: "BG.svg", GT: "GT.svg", MX: "MX.svg", KC: "KC.svg", BX: "BX.svg", HT: "HX.svg", HL: "HL.svg", AD: "AS.svg" };
    if (exIcons[ticker.ex]) {
      this.headerExIcon.style.background = `center/contain no-repeat url('/img/${exIcons[ticker.ex]}')`;
      this.headerExIcon.style.display = "block";
    } else {
      this.headerExIcon.style.display = "none";
    }

    this.headerSym.textContent = ticker.sym;
    this.headerTf.textContent = this.tf;

    const p = +ticker.p;
    if (p > 0) {
      this.headerPrice.textContent = fP(p);
      const chg = ticker.chg || 0;
      this.headerChg.textContent = fC(chg);
      this.headerChg.className = "cell-chg " + (chg >= 0 ? "pos" : "neg");

      // Update current live candle with real-time price tick
      if (!this._marketUnsub && this.candles && this.candles.length > 0) {
        const tfMs = TF_MS[this.tf] || 60000;
        const expectedStart = Math.floor(Date.now() / tfMs) * tfMs;
        let last = this.candles[this.candles.length - 1];

        if (expectedStart > last.t) {
          last = { t: expectedStart, o: last.c, h: Math.max(last.c, p), l: Math.min(last.c, p), c: p, v: 0 };
          this.candles.push(last);
          if (this.candles.length > 1500) this.candles.shift();
        } else {
          last.c = p;
          if (p > last.h) last.h = p;
          if (p < last.l) last.l = p;
        }
      }
    }

    if (changed) {
      this.offsetX = 0;
      this.autoFitY = true;
      this.loadKlines();
    } else {
      this.draw();
    }
  }

  async loadKlines() {
    if (!this.sym) return;
    this.subscribeLive();
    const myToken = (this._loadToken = (this._loadToken || 0) + 1);
    this.loadingKlines = true;
    this.headerTf.textContent = this.tf;
    this.offsetX = 0;
    this.autoFitY = true;
    this.isManualYScale = false;
    this.viewMn = null;
    this.viewMx = null;
    const key = `${this.ex}|${this.sym}|${this.tf}`;
    const cached = KLINES_CACHE.get(key);

    if (cached && Date.now() - cached.ts < 300000 && Array.isArray(cached.data) && cached.data.length > 0) {
      let candList = [];
      if (typeof cached.data[0] === 'number') {
        const flat = [];
        for (let i = 0; i < cached.data.length; i += 6) {
          flat.push({ t: cached.data[i], o: cached.data[i + 1], h: cached.data[i + 2], l: cached.data[i + 3], c: cached.data[i + 4], v: cached.data[i + 5] });
        }
        candList = sanitizeCandles(flat);
      } else {
        candList = sanitizeCandles(cached.data);
      }
      if (candList.length > 0) {
        this.candles = candList;
        this.levels = window.detectChartLevelsFn(this.candles);
        if (activeView === 'formations') window.registerFormationsCoinLevels?.(this.ex, this.sym, this.levels);
        this.loadingKlines = false;
        this.draw(true);
        return;
      }
    }

    try {
      // 1. Instant lite fetch for ultra-fast initial response (<50ms for all grid cells)
      const rLite = await fetch(`/api/klines?ex=${encodeURIComponent(this.ex)}&sym=${encodeURIComponent(this.sym)}&tf=${encodeURIComponent(this.tf)}&lite=1`);
      if (this._loadToken !== myToken) return;
      const dataLite = await rLite.json();
      if (this._loadToken !== myToken) return;

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
        this.levels = window.detectChartLevelsFn(this.candles);
        if (activeView === 'formations') window.registerFormationsCoinLevels?.(this.ex, this.sym, this.levels);
        this.draw(true);
      }

      // 2. Background full fetch for complete history without clogging cache with lite data
      const rFull = await fetch(`/api/klines?ex=${encodeURIComponent(this.ex)}&sym=${encodeURIComponent(this.sym)}&tf=${encodeURIComponent(this.tf)}&lite=0`);
      if (this._loadToken !== myToken) return;
      const dataFull = await rFull.json();
      if (this._loadToken !== myToken) return;

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
        this.levels = window.detectChartLevelsFn(this.candles);
        if (activeView === 'formations') window.registerFormationsCoinLevels?.(this.ex, this.sym, this.levels);
        KLINES_CACHE.set(key, { ts: Date.now(), data: dataFull });
        this.draw(true);
      }
    } catch (e) { } finally {
      if (this._loadToken === myToken) {
        this.loadingKlines = false;
      }
    }
  }

  draw(force = false) {
    if (!this.candles.length || (activeView === "screener" && screenerView !== "multichart")) return;

    const isFocused = (
      (activeView === "screener" && screenerView === "single") ||
      (activeView === "formations" && this.el.classList.contains("expanded"))
    );
    if (isFocused) {
      window.__debugCandles = this.candles;
      window.__debugLevels = this.levels;
      if (window.DEBUG_LEVELS) {
        console.clear();
        console.log(`[DEBUG_LEVELS] ${this.ex}:${this.sym} (${this.tf})`);
        if (this.levels && this.levels.length > 0) {
          console.table(this.levels.map(c => {
            const tIndices = c.touchIndices || (c.touchIdx !== undefined ? [c.swingIdx, c.touchIdx] : [c.swingIdx]);
            const firstTouch = tIndices.length > 0 ? Math.min(...tIndices) : c.swingIdx;
            const lastTouch = tIndices.length > 0 ? Math.max(...tIndices) : (c.lastTouch || c.swingIdx);
            return {
              pair: `${this.ex}:${this.sym}`,
              price: c.price,
              type: c.direction === 'up' ? 'resistance' : 'support',
              touches: tIndices.length,
              tol_percent: c.isTrendline ? "0.015" : "0.020",
              firstTouchIdx: firstTouch,
              lastTouchIdx: lastTouch,
              active: c.active !== undefined ? c.active : true
            };
          }));
        } else {
          console.log("No levels detected for the current pair.");
        }
      }
    }

    const now = Date.now();
    if (!force && now - this.lastDrawTs < 16) return; // Increased to ~60fps
    this.lastDrawTs = now;
    this.dirty = false;

    const last = this.candles[this.candles.length - 1];
    const cData = coins.get(this.key || `${this.ex}:${this.sym}`);
    if (cData && last && !this.loadingKlines) {
      const liveP = getDisplayP(cData);
      if (liveP > 0) {
        const tfMs = TF_MS[this.tf] || 60000;
        const expectedStart = Math.floor(Date.now() / tfMs) * tfMs;
        const timeDiff = expectedStart - last.t;
        if (timeDiff > 0 && timeDiff <= tfMs * 2) {
          const newCandle = { t: expectedStart, o: last.c, h: Math.max(last.c, liveP), l: Math.min(last.c, liveP), c: liveP, v: 0 };
          this.candles.push(newCandle);
          if (this.candles.length > 1500) this.candles.shift();
        } else if (timeDiff <= 0) {
          last.c = liveP;
          if (liveP > last.h) last.h = liveP;
          if (liveP < last.l) last.l = liveP;
        }
      }
    }
    this.refreshFormationLevels();

    const dpr = window.devicePixelRatio || 1;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;

    if (!cw || !ch || cw < 30 || ch < 30) {
      if (!this._layoutPending) {
        this._layoutPending = true;
        requestAnimationFrame(() => {
          this._layoutPending = false;
          this.draw(true);
        });
      }
      return;
    }

    if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const ctx = this.ctx;
    ctx.fillStyle = getCanvasBgColor();
    ctx.fillRect(0, 0, cw, ch);

    const PR = 60;
    const PW = cw - PR;
    const PH = ch;
    const candleWidth = this.candleW;
    const n = PW / candleWidth;
    const minOffsetX = -(n - 5);
    this.offsetX = Math.max(minOffsetX, this.offsetX);
    const viewStart = this.candles.length - n - this.offsetX;
    const s = Math.max(0, Math.floor(viewStart));
    const vis = this.candles.slice(s, s + Math.ceil(n) + 2);
    const futureGap = viewStart < 0 ? -viewStart : 0;

    if (!vis.length) return;

    if (viewStart < 60 && this.candles.length > 0 && !this.loadingOlder && !this.hasReachedStart) {
      this.loadOlderHistory();
    }

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

    if (this.viewMn === null || this.viewMx === null || !Number.isFinite(this.viewMn) || !Number.isFinite(this.viewMx) || this.autoFitY || !this.isManualYScale) {
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

    // Volume Histogram Overlay on multi-chart grid cell (Project Colors, No Lines, TradingView Auto-Scale)
    const vs = window.volumeSettings || {
      show: true,
      up: "#26c97a",
      upOp: 75,
      down: "#ff4560",
      downOp: 75
    };
    const upVolColGrid = hexToRgba(vs.up || "#26c97a", Math.round((vs.upOp ?? 75) * 0.6));
    const dnVolColGrid = hexToRgba(vs.down || "#ff4560", Math.round((vs.downOp ?? 75) * 0.6));

    const cellVolH = Math.min(48, Math.round(PH * 0.28));

    if (vs.show && vis.length > 0) {
      let maxV = 0;
      for (let i = 0; i < vis.length; i++) {
        const v = Number(vis[i]?.v) || 0;
        if (v > maxV) maxV = v;
      }

      if (maxV > 0) {
        const scaleCeiling = maxV * 1.15;
        const usableH = cellVolH - 4;
        const hwCell = Math.max(0.5, (candleWidth - 2) / 2);

        for (let i = 0; i < vis.length; i++) {
          const c = vis[i];
          const val = Number(c.v) || 0;
          if (val <= 0) continue;

          const rawX = (s + i - viewStart) * candleWidth + candleWidth / 2;
          if (rawX > PW + candleWidth) continue;

          const leftX = Math.round((rawX - hwCell) * dpr);
          const rightX = Math.round((rawX + hwCell) * dpr);
          const fillX = leftX / dpr;
          const fillW = Math.max(1 / dpr, (rightX - leftX) / dpr);

          const vRatio = Math.min(1.0, val / scaleCeiling);
          const vh = Math.max(1.5, vRatio * usableH);
          const fillY = PH - vh;

          const up = c.c >= c.o;
          ctx.fillStyle = up ? upVolColGrid : dnVolColGrid;
          ctx.fillRect(fillX, fillY, fillW, vh);
        }
      }
    }

    const defaultCs = {
      body: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
      border: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 },
      wick: { show: true, up: "#26c97a", upOp: 100, down: "#ff4560", downOp: 100 }
    };
    const rawCs = window.candleSettings || {};
    const cs = {
      body: { ...defaultCs.body, ...(rawCs.body || {}) },
      border: { ...defaultCs.border, ...(rawCs.border || {}) },
      wick: { ...defaultCs.wick, ...(rawCs.wick || {}) }
    };

    vis.forEach((c, i) => {
      const rawX = (s + i - viewStart) * candleWidth + candleWidth / 2;
      if (rawX > PW + candleWidth) return;
      const up = c.c >= c.o;
      const side = up ? "up" : "down";

      const yH = toY(c.h), yL = toY(c.l);
      const yO = toY(c.o), yC = toY(c.c);
      const bT = Math.min(yO, yC), bH = Math.max(1, Math.abs(yC - yO));

      if (cs.wick.show) {
        const wickX = (Math.floor(rawX * dpr) + 0.5) / dpr;
        const wickYH = Math.round(yH * dpr) / dpr;
        const wickYL = Math.round(yL * dpr) / dpr;
        ctx.strokeStyle = hexToRgba(cs.wick[side], cs.wick[side + "Op"]);
        ctx.lineWidth = 1 / dpr;
        ctx.beginPath();
        ctx.moveTo(wickX, wickYH);
        ctx.lineTo(wickX, wickYL);
        ctx.stroke();
      }
      if (cs.body.show) {
        const leftX = Math.round((rawX - hw) * dpr);
        const rightX = Math.round((rawX + hw) * dpr);
        const topY = Math.round(bT * dpr);
        const bottomY = Math.round((bT + bH) * dpr);

        const fillX = leftX / dpr;
        const fillY = topY / dpr;
        const fillW = Math.max(1 / dpr, (rightX - leftX) / dpr);
        const fillH = Math.max(1 / dpr, (bottomY - topY) / dpr);

        ctx.fillStyle = hexToRgba(cs.body[side], cs.body[side + "Op"]);
        ctx.fillRect(fillX, fillY, fillW, fillH);
      }
      if (cs.border.show && candleWidth > 10) {
        const strokeLeftX = (Math.floor((rawX - hw) * dpr) + 0.5) / dpr;
        const strokeTopY = (Math.floor(bT * dpr) + 0.5) / dpr;
        const strokeRightX = (Math.floor((rawX + hw) * dpr) + 0.5) / dpr;
        const strokeBottomY = (Math.floor((bT + bH) * dpr) + 0.5) / dpr;

        const strokeW = Math.max(1 / dpr, strokeRightX - strokeLeftX);
        const strokeH = Math.max(1 / dpr, strokeBottomY - strokeTopY);

        ctx.strokeStyle = hexToRgba(cs.border[side], cs.border[side + "Op"]);
        ctx.lineWidth = 1 / dpr;
        ctx.strokeRect(strokeLeftX, strokeTopY, strokeW, strokeH);
      }
    });

    const lastCandle = this.candles[this.candles.length - 1];
    const lastPrice = lastCandle.c;
    const up = lastPrice >= lastCandle.o;
    const ly = clamp(toY(lastPrice), 10, ch - 10);

    // тФАтФА Unmitigated Levels overlay тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
    if (activeView === "formations" && this.levels && this.levels.length > 0) {
      const getX = (idx) => (idx - viewStart) * candleWidth + candleWidth / 2;
      const N = this.candles.length;

      // тФАтФА Pre-calculate and adjust Y label coordinates to prevent overlapping тФАтФАтФАтФА
      this.levels.forEach(setup => {
        if (setup.isTrendline) {
          const currentPriceAtLine = setup.p1.price + (setup.p2.price - setup.p1.price) * ((N - 1) - setup.p1.idx) / (setup.p2.idx - setup.p1.idx);
          setup.labelY = toY(currentPriceAtLine);
        } else {
          setup.labelY = toY(setup.price);
        }
      });

      const visibleLevels = this.levels.filter(setup => setup.labelY >= 2 && setup.labelY <= ch - 2);
      visibleLevels.sort((a, b) => a.labelY - b.labelY);

      const minSpacing = 16;
      for (let i = 1; i < visibleLevels.length; i++) {
        const prev = visibleLevels[i - 1];
        const curr = visibleLevels[i];
        if (curr.labelY - prev.labelY < minSpacing) {
          curr.labelY = prev.labelY + minSpacing;
        }
      }
      for (let i = visibleLevels.length - 2; i >= 0; i--) {
        const curr = visibleLevels[i];
        const next = visibleLevels[i + 1];
        if (next.labelY - curr.labelY < minSpacing) {
          curr.labelY = next.labelY - minSpacing;
        }
      }

      this.levels.forEach(setup => {
        const isUp = setup.direction === 'up';
        // green = unmitigated HIGH above price (goes UP to cover)
        // red   = unmitigated LOW  below price (goes DOWN to cover)
        let lineColor = isUp ? '#26c97a' : '#ff4560';
        if (setup.isRetest) {
          lineColor = setup.outcome === 'confirmed' ? '#af52de' : '#ff9100';
        }
        if (setup.isApproachingRetest) {
          lineColor = '#00baff'; // beautiful cyan color for approaching retest
        }

        if (setup.isTrendline) {
          // Draw Trendline
          const x1 = getX(setup.p1.idx);
          const y1 = toY(setup.p1.price);

          // Project trendline to the current candle + 4 candles in length
          const endIdx = N - 1 + 4;
          const endPrice = setup.p1.price + (setup.p2.price - setup.p1.price) * (endIdx - setup.p1.idx) / (setup.p2.idx - setup.p1.idx);
          const x2 = getX(endIdx);
          const y2 = toY(endPrice);

          ctx.strokeStyle = lineColor;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();

          // Draw price label at current price level of the trendline (at N - 1)
          const currentPriceAtLine = setup.p1.price + (setup.p2.price - setup.p1.price) * ((N - 1) - setup.p1.idx) / (setup.p2.idx - setup.p1.idx);
          const yLabel = setup.labelY;
          if (yLabel >= 2 && yLabel <= ch - 2) {
            const labelH = 15, labelW = PR - 6;
            roundRect(ctx, PW + 3, yLabel - labelH / 2, labelW, labelH, 3);
            ctx.fillStyle = lineColor;
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 8px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(fP(currentPriceAtLine), PW + PR / 2, yLabel + 3);
          }

          // Draw touch circles for trendline
          if (setup.swingIndices) {
            setup.swingIndices.forEach(idx => {
              const circleX = getX(idx);
              const circleCandle = this.candles[idx];
              if (circleCandle && circleX >= 0 && circleX <= PW) {
                const circleY = toY(isUp ? circleCandle.h : circleCandle.l);
                ctx.fillStyle = lineColor;
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.2;
                ctx.beginPath(); ctx.arc(circleX, circleY, 4, 0, 2 * Math.PI);
                ctx.fill(); ctx.stroke();
              }
            });
          }

        } else {
          const y = toY(setup.price);
          if (y < 2 || y > ch - 2) return;

          // тФАтФА Solid horizontal line: from first swing тЖТ right edge (PW) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
          const originIdx = Number.isFinite(setup.swingIdx) ? setup.swingIdx : (Number.isFinite(setup.startIdx) ? setup.startIdx : 0);
          const x0 = Math.max(0, getX(originIdx));
          ctx.strokeStyle = lineColor;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(PW, y); ctx.stroke();

          // тФАтФА Price label on the right тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
          const labelH = 15, labelW = PR - 6;
          roundRect(ctx, PW + 3, setup.labelY - labelH / 2, labelW, labelH, 3);
          ctx.fillStyle = lineColor;
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 8px Inter';
          ctx.textAlign = 'center';
          ctx.fillText(fP(setup.price), PW + PR / 2, setup.labelY + 3);

          // тФАтФА Draw circles: strictly MAX 2 points (1. Level Origin, 2. Single Retest Touch) тФА
          const renderIndices = [];
          if (setup.swingIdx !== undefined) renderIndices.push(setup.swingIdx);
          if (setup.touchIdx !== undefined) renderIndices.push(setup.touchIdx);

          const uniqueIndices = [...new Set(renderIndices)];
          uniqueIndices.forEach(tIdx => {
            const tX = getX(tIdx);
            const tCandle = this.candles[tIdx];
            if (tCandle && tX >= 0 && tX <= PW) {
              ctx.fillStyle = lineColor;
              ctx.strokeStyle = '#fff';
              ctx.lineWidth = 1.2;
              ctx.beginPath(); ctx.arc(tX, y, 4, 0, 2 * Math.PI);
              ctx.fill(); ctx.stroke();
            }
          });
        }
      });

      ctx.setLineDash([]);
      ctx.textAlign = 'left';
    }

    // Keep formation overlays consistent between the single chart and the
    // screener's multi-chart grid.
    if (activeView !== "formations" && chartFormationsOnChart) {
      renderFormationsOnChart(ctx, this.candles, s, candleWidth, futureGap, toY, PW, PH, 0, viewStart);
    }
    if (chartActiveSmc && chartActiveSmc.size > 0) {
      renderSmartMoneyConcepts(ctx, this.candles, s, vis.length, candleWidth, futureGap, toY, PW, PH, 0, viewStart);
    }

    // тФАтФА Last price dashed line + label тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

    // тФАтФА Draw Overlay Indicators on grid cell тФАтФА
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, PW, PH);
    ctx.clip();

    // 1. Volume Profile (VP) with POC
    if (chartActiveIndicators.has("VP")) {
      const bins = {};
      let maxBinVol = 0;
      let pocPrice = 0;
      const binSize = pr * 0.025 || 0.1;
      for (let i = 0; i < vis.length; i++) {
        const c = vis[i];
        const bin = Math.floor(c.c / binSize) * binSize;
        bins[bin] = (bins[bin] || 0) + c.v;
        if (bins[bin] > maxBinVol) {
          maxBinVol = bins[bin];
          pocPrice = bin + binSize / 2;
        }
      }

      // Draw Profile Bins on the RIGHT (same as main chart)
      for (const bin in bins) {
        const p = parseFloat(bin);
        const y = toY(p);
        const yBottom = toY(p + binSize);
        const height = Math.abs(yBottom - y);
        const width = (bins[bin] / maxBinVol) * (PW * 0.20);
        const isPOC = Math.abs(p + binSize / 2 - pocPrice) < binSize * 0.1;
        ctx.fillStyle = isPOC ? "rgba(255, 69, 96, 0.5)" : "rgba(108, 93, 211, 0.15)";
        ctx.fillRect(PW - width, yBottom, width, height - 1);
      }

      // Draw POC Label only (no line), centered on the red bin
      if (pocPrice > 0) {
        const pocY = toY(pocPrice);
        const pocWidth = (maxBinVol / maxBinVol) * (PW * 0.20);
        ctx.fillStyle = "#ff4560";
        ctx.font = "bold 9px Inter";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("POC " + fP(pocPrice), PW - pocWidth / 2, pocY);
      }
    }

    // 2. Bollinger Bands (BB)
    if (chartActiveIndicators.has("BB")) {
      const bb = calcBB(this.candles);

      // Upper Band
      ctx.beginPath();
      ctx.strokeStyle = "rgba(167, 139, 250, 0.5)";
      ctx.lineWidth = 1.2;
      for (let i = 0; i < vis.length; i++) {
        const val = bb[s + i];
        if (val && val.upper) {
          const x = (i + futureGap) * candleWidth + candleWidth / 2;
          const y = toY(val.upper);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // Lower Band
      ctx.beginPath();
      for (let i = 0; i < vis.length; i++) {
        const val = bb[s + i];
        if (val && val.lower) {
          const x = (i + futureGap) * candleWidth + candleWidth / 2;
          const y = toY(val.lower);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // 3. EMA 20
    if (chartActiveIndicators.has("EMA 20")) {
      const ema20 = calcEMA(this.candles, 20);
      ctx.beginPath();
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < vis.length; i++) {
        const val = ema20[s + i];
        if (val) {
          const x = (i + futureGap) * candleWidth + candleWidth / 2;
          const y = toY(val);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // 4. EMA 50
    if (chartActiveIndicators.has("EMA 50")) {
      const ema50 = calcEMA(this.candles, 50);
      ctx.beginPath();
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < vis.length; i++) {
        const val = ema50[s + i];
        if (val) {
          const x = (i + futureGap) * candleWidth + candleWidth / 2;
          const y = toY(val);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // 5. EMA 200
    if (chartActiveIndicators.has("EMA 200")) {
      const ema200 = calcEMA(this.candles, 200);
      ctx.beginPath();
      ctx.strokeStyle = "#f87171";
      ctx.lineWidth = 1.8;
      for (let i = 0; i < vis.length; i++) {
        const val = ema200[s + i];
        if (val) {
          const x = (i + futureGap) * candleWidth + candleWidth / 2;
          const y = toY(val);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // 6. VWAP
    if (chartActiveIndicators.has("VWAP")) {
      const vwap = calcVWAP(this.candles);
      ctx.beginPath();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < vis.length; i++) {
        const val = vwap[s + i];
        if (val) {
          const x = (i + futureGap) * candleWidth + candleWidth / 2;
          const y = toY(val);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // тФАтФА Draw Walls (Density) on Chart тФАтФА
    let gridBadges = [];
    if (false && chartDensityEnabled) {
      const ticker = coins.get(this.ex + ":" + this.sym);
      const activeBase = ticker ? ticker.base : this.sym.replace("USDT", "").replace("USD", "").replace("-", "").split(/[-_]/)[0];

      const walls = densityData.filter(w => {
        if (w.base !== activeBase) return false;
        if (chartDensitySide !== "all" && w.side !== chartDensitySide) return false;
        if (chartDensityMarket !== "all" && w.market !== chartDensityMarket) return false;
        if (!chartDensityExes.has(w.ex)) return false;

        const sizeType = getDensitySizeType(w);
        if (!chartDensitySizes.has(sizeType)) return false;

        return true;
      });

      if (walls.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, PW, ch);
        ctx.clip();

        // Exchange abbreviation map for clearer labels
        const EX_NAMES = {
          BN: "Binance", BB: "Bybit", OX: "OKX", BG: "BingX",
          KC: "KuCoin", BX: "Bitget", MX: "MEXC", GT: "Gate",
          HT: "HTX", HL: "Hyperliquid", AD: "Asterdex"
        };

        for (const w of walls) {
          const wy = toY(w.price);
          if (wy < 0 || wy > ch) continue;

          // Find x start position (based on firstSeenAt timestamp (exact time, not just candle index)
          let startIdx = 0;
          if (w.firstSeenAt && this.candles.length > 0) {
            startIdx = getIdxFromTime(w.firstSeenAt, this.candles);
          }
          const startX = Math.max(0, (startIdx - s + futureGap) * candleWidth + candleWidth / 2);

          const isBid = w.side === "bid";
          const baseColor = isBid ? "rgb(38,201,122)" : "rgb(255,69,96)";

          ctx.strokeStyle = baseColor;
          ctx.lineWidth = Math.min(8, 2.0 + w.rtwi / 4);
          ctx.lineCap = "round";

          ctx.beginPath();
          ctx.moveTo(startX, wy);
          ctx.lineTo(PW, wy);
          ctx.stroke();

          // Print exchange + volume (e.g. Binance 2.5M) near the start
          const exName = EX_NAMES[w.ex] || w.ex;
          const volStr = (w.wallK >= 1000 ? (w.wallK / 1000).toFixed(1).replace(/\.0$/, "") + "M" : w.wallK + "K");
          const label = exName + " " + volStr;
          ctx.fillStyle = baseColor;
          ctx.font = "bold 9px Inter";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";

          // Draw a little pill/background for label
          const labelWidth = ctx.measureText(label).width + 10;
          const labelHeight = 14;
          ctx.fillStyle = isBid ? "rgba(38,201,122,0.15)" : "rgba(255,69,96,0.15)";
          roundRect(ctx, Math.min(startX + 2, PW - labelWidth - 4), wy - labelHeight - 2, labelWidth, labelHeight, 3);
          ctx.fill();

          ctx.fillStyle = baseColor;
          ctx.fillText(label, Math.min(startX + 7, PW - labelWidth), wy - 5);

          // Save badge coordinate and info to draw on price scale later (outside of clip)
          gridBadges.push({ y: wy, price: w.price, isBid, baseColorArr: isBid ? [38, 201, 122] : [255, 69, 96] });
        }
        ctx.restore();
      }
    }

    const densityTicker = coins.get(this.ex + ":" + this.sym);
    const densityBase = densityTicker
      ? densityTicker.base
      : this.sym.replace("USDT", "").replace("USD", "").replace("-", "").split(/[-_]/)[0];
    gridBadges = drawDensityTimelineOnChart(ctx, {
      candles: this.candles,
      base: densityBase,
      candleWidth,
      viewStart,
      toY,
      PW,
      PH,
      TOP: 0,
    });

    // Draw price badges on the right price scale of this grid cell
    if (gridBadges.length > 0) {
      const PR = 60; // Grid scale width
      const badgeH = 18;
      const badgeW = PR - 8;
      const badgeX = PW + 4;

      for (const badge of gridBadges) {
        ctx.save();
        const badgeY = badge.y - badgeH / 2;
        roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4);
        ctx.fillStyle = "#1e1f2e";
        ctx.fill();

        ctx.strokeStyle = `rgba(${badge.baseColorArr.join(',')},1)`;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px Inter";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(fP(badge.price), badgeX + badgeW / 2, badge.y);
        ctx.restore();
      }
    }

    // Render user saved drawings on multichart / formation cells if enabled
    if (showMultichartDrawings && this.sym) {
      try {
        const rawSaved = localStorage.getItem("crypto_drawings_" + this.sym);
        if (rawSaved) {
          const drawingsList = JSON.parse(rawSaved);
          if (Array.isArray(drawingsList) && drawingsList.length > 0) {
            const mcDrawingBadges = [];
            ctx.save();
            try {
              ctx.beginPath();
              ctx.rect(0, 0, PW, ch);
              ctx.clip();

              const getX = (t) => {
                if (t > 1000000000 && this.candles.length > 0) {
                  const idx = getIdxFromTime(t, this.candles);
                  return (idx - s + futureGap) * candleWidth + candleWidth / 2;
                }
                return (t - s + futureGap) * candleWidth + candleWidth / 2;
              };

              drawingsList.forEach((d) => {
                if (!d || d.type === "ruler") return;
                const x1 = getX(d.t1), y1 = toY(d.p1);
                const x2 = getX(d.t2), y2 = toY(d.p2);
                const baseCol = d.color || getToolColor(d.type) || "#facc15";

                ctx.lineWidth = 1.6;
                ctx.setLineDash([]);
                ctx.strokeStyle = baseCol;

                if (d.type === "line") {
                  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
                } else if (d.type === "ray") {
                  const dx = x2 - x1, dy = y2 - y1;
                  const mag = Math.sqrt(dx * dx + dy * dy);
                  if (mag >= 0.01) {
                    const big = Math.max(PW, ch) * 4;
                    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + (dx / mag) * big, y1 + (dy / mag) * big); ctx.stroke();
                  }
                } else if (d.type === "h-ray") {
                  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(PW, y1); ctx.stroke();
                  mcDrawingBadges.push({ y: y1, price: d.p1, color: baseCol });
                } else if (d.type === "alert") {
                  ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(PW, y1); ctx.stroke();
                  mcDrawingBadges.push({ y: y1, price: d.p1, color: baseCol || "#2bd98a" });
                } else if (d.type === "rect") {
                  const left = Math.min(x1, x2), top = Math.min(y1, y2);
                  const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
                  ctx.fillStyle = hexToRgba(baseCol, 15);
                  ctx.fillRect(left, top, width, height);
                  ctx.strokeRect(left, top, width, height);
                } else if (d.type === "brush" && d.points && d.points.length > 1) {
                  ctx.beginPath(); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = d.lineWidth || 2;
                  ctx.moveTo(getX(d.points[0].t), toY(d.points[0].p));
                  for (let k = 1; k < d.points.length; k++) {
                    ctx.lineTo(getX(d.points[k].t), toY(d.points[k].p));
                  }
                  ctx.stroke();
                } else if (d.type === "fibgrid") {
                  const fibs = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
                  const left = Math.min(x1, x2), right = Math.max(x1, x2);
                  fibs.forEach((level) => {
                    const y = y1 + (y2 - y1) * level;
                    ctx.strokeStyle = hexToRgba(baseCol, level === 0.5 ? 90 : 60);
                    ctx.lineWidth = level === 0.5 ? 1.5 : 1;
                    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
                  });
                  ctx.strokeRect(left, Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
                }
              });
            } finally {
              ctx.restore();
            }

            if (mcDrawingBadges.length > 0) {
              const PR = 60;
              const badgeH = 18;
              const badgeW = PR - 8;
              const badgeX = PW + 4;
              for (const b of mcDrawingBadges) {
                if (b.y < 0 || b.y > ch) continue;
                ctx.save();
                roundRect(ctx, badgeX, b.y - badgeH / 2, badgeW, badgeH, 4);
                ctx.fillStyle = "#151722";
                ctx.fill();
                ctx.strokeStyle = b.color || "#8b5cf6";
                ctx.lineWidth = 1.4;
                ctx.stroke();
                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 9.5px Inter";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(fP(b.price), badgeX + badgeW / 2, b.y);
                ctx.restore();
              }
            }
          }
        }
      } catch (_) {}
    }

    // тФАтФА Ruler tool drawing тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
    if (this.isRuler && this.rulerStart && this.rulerEnd && this.rulerStart.idx !== null && this.rulerEnd.idx !== null) {
      const getX = (idx) => (idx - s + futureGap) * candleWidth + candleWidth / 2;
      const xStart = getX(this.rulerStart.idx);
      const yStart = toY(this.rulerStart.price);
      const xEnd = getX(this.rulerEnd.idx);
      const yEnd = toY(this.rulerEnd.price);

      // Shaded rectangle
      ctx.save();
      ctx.fillStyle = "rgba(0, 186, 255, 0.12)";
      ctx.fillRect(xStart, Math.min(yStart, yEnd), xEnd - xStart, Math.abs(yEnd - yStart));

      // Border of the region
      ctx.strokeStyle = "rgba(0, 186, 255, 0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(xStart, Math.min(yStart, yEnd), xEnd - xStart, Math.abs(yEnd - yStart));

      // Connecting line
      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 186, 255, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(xStart, yStart);
      ctx.lineTo(xEnd, yEnd);
      ctx.stroke();
      ctx.setLineDash([]);

      // Tooltip calculation
      const startPrice = this.rulerStart.price;
      const endPrice = this.rulerEnd.price;
      const deltaPrice = endPrice - startPrice;
      const pct = (deltaPrice / startPrice) * 100;
      const bars = Math.abs(this.rulerEnd.idx - this.rulerStart.idx);

      // Time calculation
      let timeStr = "";
      const tStart = this.candles[this.rulerStart.idx]?.t;
      const tEnd = this.candles[this.rulerEnd.idx]?.t;
      if (typeof tStart === 'number' && typeof tEnd === 'number') {
        const diffMs = Math.abs(tEnd - tStart);
        if (diffMs < 3600000) {
          timeStr = Math.round(diffMs / 60000) + "m";
        } else if (diffMs < 86400000) {
          const hours = Math.floor(diffMs / 3600000);
          const mins = Math.round((diffMs % 3600000) / 60000);
          timeStr = hours + "h " + mins + "m";
        } else {
          const days = Math.floor(diffMs / 86400000);
          const hours = Math.round((diffMs % 86400000) / 3600000);
          timeStr = days + "d " + hours + "h";
        }
      } else {
        // Fallback using timeframe if timestamp not found
        let tfMin = 240;
        if (this.tf.endsWith("m")) tfMin = parseInt(this.tf);
        else if (this.tf.endsWith("h")) tfMin = parseInt(this.tf) * 60;
        else if (this.tf.endsWith("d")) tfMin = parseInt(this.tf) * 1440;
        else if (this.tf.endsWith("w")) tfMin = parseInt(this.tf) * 10080;

        const totalMin = bars * tfMin;
        if (totalMin < 60) timeStr = totalMin + "m";
        else if (totalMin < 1440) {
          timeStr = Math.floor(totalMin / 60) + "h " + (totalMin % 60) + "m";
        } else {
          timeStr = Math.floor(totalMin / 1440) + "d " + Math.round((totalMin % 1440) / 60) + "h";
        }
      }

      // Draw tooltip box at midpoint
      const midX = (xStart + xEnd) / 2;
      const midY = (yStart + yEnd) / 2;

      function formatCandlesCountGrid(count) {
        const n = Math.abs(Math.round(count));
        const mod10 = n % 10;
        const mod100 = n % 100;
        if (mod100 >= 11 && mod100 <= 19) return `${n} свечей`;
        if (mod10 === 1) return `${n} свеча`;
        if (mod10 >= 2 && mod10 <= 4) return `${n} свечи`;
        return `${n} свечей`;
      }

      const pctSign = pct >= 0 ? "+" : "";
      const formattedDeltaPrice = deltaPrice >= 0 ? ("+" + fP(deltaPrice)) : fP(deltaPrice);
      const text1 = `${pctSign}${pct.toFixed(2)}% (${formattedDeltaPrice})`;
      const text2 = timeStr ? `${formatCandlesCountGrid(bars)}, ${timeStr}` : formatCandlesCountGrid(bars);

      ctx.font = "bold 9px Inter";
      const w1 = ctx.measureText(text1).width;
      const w2 = ctx.measureText(text2).width;
      const boxW = Math.max(w1, w2) + 16;
      const boxH = 32;
      const boxX = clamp(midX - boxW / 2, 4, PW - boxW - 4);
      const boxY = clamp(midY - boxH / 2, 4, PH - boxH - 4);

      roundRect(ctx, boxX, boxY, boxW, boxH, 4);
      ctx.fillStyle = "rgba(20, 24, 33, 0.9)";
      ctx.fill();
      ctx.strokeStyle = "rgba(0, 186, 255, 0.8)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = pct >= 0 ? "#26c97a" : "#ff4560";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(text1, boxX + boxW / 2, boxY + 6);

      ctx.fillStyle = "#ffffff";
      ctx.fillText(text2, boxX + boxW / 2, boxY + 18);
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

  document.body.classList.toggle("view-is-multichart", view === "multichart");

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
  if (!container) return;
  container.innerHTML = "";
  const query = q.toUpperCase();
  const matches = Array.from(coins.values())
    .filter(c => isUsdtFutures(c) && (c.sym.includes(query) || c.ex.includes(query)))
    .sort((a, b) => (b.v || 0) - (a.v || 0))
    .slice(0, 50);

  matches.forEach(c => container.appendChild(renderMiniSearchItem(c)));
}

const miniSearchInput = $("mini-search-input");
if (miniSearchInput) {
  miniSearchInput.oninput = (e) => renderMiniSearchResults(e.target.value);
}

document.addEventListener("mousedown", (e) => {
  const box = $("mini-search-box");
  const menu = $("mini-tf-menu");
  if (box && !box.contains(e.target)) box.style.display = "none";
  if (menu && !menu.contains(e.target)) menu.style.display = "none";
});

function initChartGrid() {
  const container = $("chart-grid-container");
  if (!container) return;
  chartInstances.forEach(inst => inst?.dispose?.());
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
  // Logic for heatmap (if still needed, though multichart is the new heatmap)
}


// тФАтФА Tab switching тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
const featureTitles = {
  map: "Карта ликвидаций & Heatmap",
  arbitrage: "Межбиржевой и Фандинг Арбитраж",
  formations: "Детектор формаций и Уровни",
  backtest: "Бэктестинг стратегий",
  journal: "Дневник трейдера"
};

window.switchView = function switchView(view) {
  if (view !== "screener") {
    const user = window.currentUser;
    const isPro = user && user.plan === "pro";
    if (!isPro) {
      const title = featureTitles[view] || view;
      if (typeof window.openProModal === "function") {
        window.openProModal(title);
      }
      return;
    }
  }

  activeView = view;
  densityHover = -1; // Reset hover index when switching views
  const mainEl = document.getElementById("main");
  const densityEl = document.getElementById("density-view");
  const formationsEl = document.getElementById("formations-view");
  const backtestEl = document.getElementById("backtest-view");
  const journalEl = document.getElementById("journal-view");
  const arbitrageEl = document.getElementById("arbitrage-view");

  // Highlight active navbar tab
  document.querySelectorAll("#nav .ntab").forEach(t => {
    const text = t.textContent.trim().toLowerCase();
    const isMatch =
      (view === "screener" && (text.includes("скринер") || t.id === "tab-screener")) ||
      (view === "map" && text.includes("карта")) ||
      (view === "arbitrage" && (text.includes("арбитраж") || t.id === "tab-arbitrage")) ||
      (view === "formations" && text.includes("формации")) ||
      (view === "backtest" && text.includes("бэктест")) ||
      (view === "journal" && (text.includes("дневник") || t.id === "tab-journal"));
    t.classList.toggle("on", isMatch);
    t.setAttribute("aria-selected", isMatch ? "true" : "false");
  });

  if (view === "screener") {
    if (mainEl) mainEl.style.display = "flex";
    if (densityEl) densityEl.style.display = "none";
    if (formationsEl) formationsEl.style.display = "none";
    if (backtestEl) backtestEl.style.display = "none";
    if (journalEl) journalEl.style.display = "none";
    if (arbitrageEl) arbitrageEl.style.display = "none";
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
    if (mainEl) mainEl.style.display = "none";
    if (densityEl) densityEl.style.display = "flex";
    if (formationsEl) formationsEl.style.display = "none";
    if (backtestEl) backtestEl.style.display = "none";
    if (journalEl) journalEl.style.display = "none";
    if (arbitrageEl) arbitrageEl.style.display = "none";
    initDensityCanvas();
    fetchWalls();
    startDensityLoop();
  } else if (view === "formations") {
    if (mainEl) mainEl.style.display = "none";
    if (densityEl) densityEl.style.display = "none";
    if (formationsEl) {
      formationsEl.style.display = "flex";
      window.loadFormations();
      requestAnimationFrame(() => {
        chartInstances.forEach(inst => inst && inst.draw(true));
      });
    }
    if (backtestEl) backtestEl.style.display = "none";
    if (journalEl) journalEl.style.display = "none";
    if (arbitrageEl) arbitrageEl.style.display = "none";
  } else if (view === "backtest") {
    if (mainEl) mainEl.style.display = "none";
    if (densityEl) densityEl.style.display = "none";
    if (formationsEl) formationsEl.style.display = "none";
    if (backtestEl) backtestEl.style.display = "flex";
    if (journalEl) journalEl.style.display = "none";
    if (arbitrageEl) arbitrageEl.style.display = "none";
    if (window.CryptoBacktest) window.CryptoBacktest.activate();
  } else if (view === "journal") {
    if (mainEl) mainEl.style.display = "none";
    if (densityEl) densityEl.style.display = "none";
    if (formationsEl) formationsEl.style.display = "none";
    if (backtestEl) backtestEl.style.display = "none";
    if (journalEl) journalEl.style.display = "flex";
    if (window.CryptoJournal && typeof window.CryptoJournal.activate === "function") {
      window.CryptoJournal.activate();
    }
    if (arbitrageEl) arbitrageEl.style.display = "none";
  } else if (view === "arbitrage") {
    if (mainEl) mainEl.style.display = "none";
    if (densityEl) densityEl.style.display = "none";
    if (formationsEl) formationsEl.style.display = "none";
    if (backtestEl) backtestEl.style.display = "none";
    if (journalEl) journalEl.style.display = "none";
    if (arbitrageEl) arbitrageEl.style.display = "block";
    if (window.CryptoArbitrage) window.CryptoArbitrage.activate();
  }
};

document.querySelectorAll("#nav .ntab").forEach((tab, idx) => {
  tab.addEventListener("click", (e) => {
    const text = tab.textContent.trim().toLowerCase();
    if (text.includes("скринер") || idx === 0) {
      window.switchView("screener");
    } else if (text.includes("карта") || idx === 1) {
      window.switchView("map");
    } else if (text.includes("арбитраж") || tab.id === "tab-arbitrage" || idx === 2) {
      window.switchView("arbitrage");
    } else if (text.includes("формации") || idx === 3) {
      window.switchView("formations");
    } else if (text.includes("бэктест") || idx === 4) {
      window.switchView("backtest");
    } else if (text.includes("дневник") || tab.id === "tab-journal" || idx === 5) {
      window.switchView("journal");
    }
  });
});

// тХРтХРтХР Density Map тАФ Radar Visualization тХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХР

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
  const dpr = window.devicePixelRatio || 1;
  densityW = wrap.clientWidth;
  densityH = wrap.clientHeight;
  densityCanvas.width = Math.floor(densityW * dpr);
  densityCanvas.height = Math.floor(densityH * dpr);
  densityCanvas.style.width = densityW + "px";
  densityCanvas.style.height = densityH + "px";
  if (densityCtx) {
    densityCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  layoutDensityBadges();
}

function updateDensityStatusUI(meta) {
  const statusEl = $("density-status");
  if (!statusEl) return;
  if (meta && typeof meta.exchangesReady === "number" && typeof meta.exchangesTotal === "number") {
    statusEl.textContent = `Биржи: ${meta.exchangesReady}/${meta.exchangesTotal}`;
    const statuses = Object.values(meta.exchangeStatuses || {});
    const symbolTotal = statuses.reduce((sum, item) => sum + (Number(item.symbolsTotal) || 0), 0);
    const weightedCoverage = symbolTotal > 0
      ? Math.round(statuses.reduce((sum, item) => sum + (Number(item.coveragePct) || 0) * (Number(item.symbolsTotal) || 0), 0) / symbolTotal)
      : 0;
    const coverageText = symbolTotal > 0 ? ` · охват ${weightedCoverage}%` : "";
    statusEl.textContent = `Биржи: ${meta.exchangesReady}/${meta.exchangesTotal}${coverageText}`;
    statusEl.style.color = (meta.partial || (symbolTotal > 0 && weightedCoverage < 100)) ? "#f59e0b" : "#10b981";
  } else {
    statusEl.textContent = "Обновлено";
    statusEl.style.color = "#10b981";
  }
}

function updateDensityExchangeCounts() {
  const counts = new Map();
  for (const wall of densityData) {
    counts.set(wall.ex, (counts.get(wall.ex) || 0) + 1);
  }

  document.querySelectorAll(".density-exc-item[data-dex]").forEach(item => {
    const ex = item.dataset.dex;
    const nameEl = item.querySelector(".dex-name");
    if (!nameEl) return;
    const exchangeName = EX_NAMES[ex] || ex;
    const count = counts.get(ex) || 0;
    nameEl.textContent = `${exchangeName} · ${count}`;
    item.title = `${exchangeName}: активных плотностей ${count}`;
  });
}

async function fetchWalls() {
  try {
    const res = await fetch("/api/walls?format=full");
    if (res.ok) {
      const data = await res.json();
      let incomingWalls = null;
      let meta = null;
      if (Array.isArray(data)) {
        incomingWalls = data;
      } else if (data && Array.isArray(data.walls)) {
        incomingWalls = data.walls;
        meta = data;
      }

      if (incomingWalls) {
        if (incomingWalls.length > 0 || !densityData.length || (meta && !meta.partial)) {
          densityData = incomingWalls;
        }
        if (meta && Array.isArray(meta.history)) densityHistoryData = meta.history;
        densityLastUpdate = (meta && meta.updatedAt) || Date.now();
        updateDensityStatusUI(meta);
        updateDensityExchangeCounts();
        if (activeView === "map") {
          layoutDensityBadges();
        } else {
          requestAnimationFrame(drawChart);
          if (typeof chartInstances !== "undefined" && Array.isArray(chartInstances)) {
            chartInstances.forEach(inst => {
              if (inst && typeof inst.draw === "function") inst.draw();
            });
          }
        }
      }
    }
  } catch (e) { console.error("Failed to fetch walls:", e); }
}

// Fallback polling (in case WS didn't deliver)
setInterval(() => {
  if (Date.now() - densityLastUpdate > 15000) fetchWalls();
}, 12000);

// тФАтФА Filter тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function passesDensityBaseFilters(d) {
    if (isBaseInDensityBlacklist(d.base, d.sym)) return false;
    if (densityFilter !== "all" && d.side !== densityFilter) return false;
    if (densityMarket !== "all" && d.market !== densityMarket) return false;
    if (!densityExFilter.has(d.ex)) return false;
    if ((Number(d.S) || 0) < densityMinUsd) return false;
    if ((Number(d.pct) || 0) > densityMaxDistance) return false;
    if ((Number(d.age) || 0) < densityMinAge) return false;
    if (densitySearch) {
      const q = densitySearch.toLowerCase();
      if (!d.base.toLowerCase().includes(q) && !d.sym.toLowerCase().includes(q)) return false;
    }
    return true;
}

function updateDensitySizeCounts(baseFiltered) {
  const counts = { all: baseFiltered.length, small: 0, medium: 0, large: 0 };
  for (const wall of baseFiltered) {
    const type = getDensitySizeType(wall);
    if (Object.prototype.hasOwnProperty.call(counts, type)) counts[type]++;
  }

  document.querySelectorAll(".density-filter-btn[data-dsize]").forEach(btn => {
    const type = btn.dataset.dsize;
    const label = DENSITY_SIZE_LABELS[type] || btn.textContent.trim();
    const count = Number(counts[type]) || 0;
    btn.textContent = `${label} ${count}`;
    btn.title = type === "all"
      ? "Все стены после остальных фильтров"
      : `${label}: относительный размер для каждой монеты (${count})`;
  });
}

function getFilteredDensity() {
  const baseFiltered = densityData.filter(passesDensityBaseFilters);
  updateDensitySizeCounts(baseFiltered);
  if (densitySize === "all") return baseFiltered;
  return baseFiltered.filter(d => passesDensitySizeFilter(d, densitySize));
}

// тФАтФА Layout: distribute badges radially by pct тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function layoutDensityBadges() {
  const filtered = getFilteredDensity();
  const sorters = {
    score: (a, b) => (b.rtwi || 0) - (a.rtwi || 0) || (b.S || 0) - (a.S || 0),
    size: (a, b) => (b.S || 0) - (a.S || 0),
    dist: (a, b) => (a.pct || 0) - (b.pct || 0),
    age: (a, b) => (b.age || 0) - (a.age || 0),
  };
  filtered.sort(sorters[densitySort] || sorters.score);
  // The server already applies anti-noise quality gates.  Keep every filtered
  // result visible instead of silently hiding everything after item 240.
  densityVisibleData = filtered;

  // Update count badge
  const countEl = $("density-count");
  if (countEl) countEl.textContent = filtered.length > densityVisibleData.length
    ? `${densityVisibleData.length} / ${filtered.length} стен`
    : `${filtered.length} стен`;

  if (!densityW || !densityH) return;
  const cx = densityW / 2;
  const cy = densityH / 2;
  const maxRadius = Math.min(cx, cy) - 60;
  const minRadius = 50;

  for (let i = 0; i < densityVisibleData.length; i++) {
    const d = densityVisibleData[i];
    const norm = Math.max(0, Math.min(1, (d.pct - 0.3) / 5.7));
    const r = minRadius + norm * (maxRadius - minRadius);
    const step = 2.399963;
    const angle = i * step - Math.PI / 2;
    d.rx = cx + Math.cos(angle) * r;
    d.ry = cy + Math.sin(angle) * r;
  }
}

// тФАтФА Draw density radar map тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function drawDensityMap() {
  if (!densityCtx || !densityW || !densityH) return;
  const ctx = densityCtx;
  const cx = densityW / 2;
  const cy = densityH / 2;
  const maxR = Math.min(cx, cy) - 60;
  const minR = 50;
  const t = Date.now();

  ctx.clearRect(0, 0, densityW, densityH);

  // тФАтФА Background gradient
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.8);
  bg.addColorStop(0, "#0c0e1a");
  bg.addColorStop(0.55, "#080a12");
  bg.addColorStop(1, "#04050d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, densityW, densityH);

  // тФАтФА Dual ambient glow (bid teal + ask red)
  const gBid = ctx.createRadialGradient(cx - maxR * 0.25, cy, 0, cx, cy, maxR * 1.1);
  gBid.addColorStop(0, "rgba(22,199,132, 0.06)");
  gBid.addColorStop(1, "transparent");
  ctx.fillStyle = gBid; ctx.fillRect(0, 0, densityW, densityH);

  const gAsk = ctx.createRadialGradient(cx + maxR * 0.25, cy, 0, cx, cy, maxR * 1.1);
  gAsk.addColorStop(0, "rgba(255,69,96, 0.06)");
  gAsk.addColorStop(1, "transparent");
  ctx.fillStyle = gAsk; ctx.fillRect(0, 0, densityW, densityH);

  // тФАтФА Radial spokes (24)
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

  // тФАтФА Concentric rings
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

    // label ├Ч4
    ctx.font = `bold ${accent ? 13 : 11}px Inter`;
    ctx.fillStyle = accent ? "rgba(175,140,255, 0.85)" : "rgba(138,80,255, 0.55)";
    [[cx + r + 8, cy + 5, "left"], [cx - r - 8, cy + 5, "right"],
    [cx, cy - r - 9, "center"], [cx, cy + r + 16, "center"]].forEach(([lx, ly, align]) => {
      ctx.textAlign = align; ctx.fillText(ring.label, lx, ly);
    });
  }
  ctx.restore();

  // тФАтФА Outer ring decoration
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, maxR + 12, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(138,80,255, 0.08)"; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  // тФАтФА Animated scan sweep
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

  // тФАтФА Center pulsing dot
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

  // тФАтФА Draw badges
  const filtered = densityVisibleData;
  densityHover = -1;
  for (let i = 0; i < filtered.length; i++) {
    const d = filtered[i];
    if (d.rx === undefined) continue;
    const dx = densityMouseX - d.rx;
    const dy = densityMouseY - d.ry;
    const isHover = dx * dx + dy * dy < 2025;
    if (isHover) densityHover = i;
    const isSelected = densitySelectedKey && (d.ex + ":" + d.sym === densitySelectedKey);
    if (isHover || isSelected) {
      drawDensityBubble(ctx, d, d.rx, d.ry, true);
    } else {
      const sprite = getDensityBubbleSprite(d);
      ctx.drawImage(sprite, d.rx - DENSITY_SPRITE_W / 2, d.ry - 40, DENSITY_SPRITE_W, DENSITY_SPRITE_H);
    }
  }

  // Active item for tooltip / line (hovered or explicitly selected on tap)
  let activeItemIndex = densityHover;
  if (activeItemIndex < 0 && densitySelectedKey) {
    activeItemIndex = filtered.findIndex(d => (d.ex + ":" + d.sym) === densitySelectedKey);
  }

  // тФАтФА Hover/Select connector line & Tooltip
  if (activeItemIndex >= 0 && activeItemIndex < filtered.length) {
    const d = filtered[activeItemIndex];
    const isBid = d.side === "bid";
    const lineColor = isBid ? "rgba(22,199,132,0.3)" : "rgba(255,69,96,0.3)";
    ctx.save();
    ctx.strokeStyle = lineColor; ctx.lineWidth = 1; ctx.setLineDash([4, 7]);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(d.rx, d.ry); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();

    // Build rows first so the card height always fits its content.
    const marketText = d.market === "spot" ? "СПОТ" : "ФЬЮЧЕРСЫ";
    const marketColor = d.market === "spot" ? "#16c784" : "#eab308";
    const volText = d.wallK >= 1000 ? (d.wallK / 1000).toFixed(1) + "M$" : d.wallK + "K$";
    const fmtPrice = d.price < 1 ? +d.price.toPrecision(4) : +d.price.toFixed(4);
    const priceText = `${fmtPrice} (${d.pct.toFixed(2)}%)`;

    const tipRows = [];
    tipRows.push(["БИРЖА", (typeof CHART_EXCHANGE_NAMES !== "undefined" && CHART_EXCHANGE_NAMES[d.ex]) || d.ex, "#7dd3fc"]);
    tipRows.push(["РЫНОК", marketText, marketColor]);
    tipRows.push(["ОБЪЕМ", volText, "#fff"]);
    tipRows.push(["ЦЕНА / ДИСТ", priceText, "#fff"]);

    // Live lifetime: firstSeenAt keeps counting up while the wall exists,
    // unlike the stale `age` snapshot from the scanner.
    const seenAt = Number(d.firstSeenAt) || 0;
    const liveAgeSec = seenAt > 0 ? Math.max(0, Math.round((Date.now() - seenAt) / 1000)) : (Number(d.age) || 0);
    let formatAge = "-";
    if (liveAgeSec > 0) {
      if (liveAgeSec < 60) formatAge = `${liveAgeSec} сек`;
      else if (liveAgeSec < 3600) formatAge = `${Math.floor(liveAgeSec / 60)} мин`;
      else if (liveAgeSec < 86400) formatAge = `${Math.floor(liveAgeSec / 3600)} ч ${Math.floor((liveAgeSec % 3600) / 60)} мин`;
      else formatAge = `${Math.floor(liveAgeSec / 86400)} д ${Math.floor((liveAgeSec % 86400) / 3600)} ч`;
    }
    tipRows.push(["ВРЕМЯ ЖИЗНИ", formatAge, "#fbbf24"]);

    // Absorption: how much of the wall's peak size has been eaten.
    const peakUsd = Number(d.maxSizeUsd) || 0;
    if (peakUsd > Number(d.S) * 1.05) {
      const eatenPct = Math.min(99, Math.round((1 - Number(d.S) / peakUsd) * 100));
      tipRows.push(["СЪЕДЕНО ОТ ПИКА", `${eatenPct}%`, eatenPct >= 50 ? "#ff6b81" : "#fbbf24"]);
    }

    // Anti-spoof confirmations: scans in a row the wall survived.
    if (Number(d.confirmations) > 0) {
      tipRows.push(["ПОДТВЕРЖДЕНИЙ", `${d.confirmations} скан.`, "#a78bfa"]);
    }

    // тФАтФА Tooltip
    // Math to get tip width (adaptive on mobile)
    const tipW = Math.min(230, densityW - 20);
    const tipH = 62 + tipRows.length * 20;
    let tipX, tipY;
    if (densityW <= 500) {
      // Mobile: center tooltip horizontally or keep safely within bounds
      tipX = Math.max(10, Math.min(densityW - tipW - 10, (densityW - tipW) / 2));
      tipY = d.ry - tipH - 25;
      if (tipY < 10) tipY = d.ry + 25;
      if (tipY + tipH > densityH - 10) tipY = densityH - tipH - 10;
    } else {
      tipX = d.rx + 55;
      tipY = d.ry - tipH / 2;
      if (tipX + tipW > densityW - 10) tipX = d.rx - tipW - 55;
      if (tipX < 10) tipX = 10;
      if (tipY < 10) tipY = 10;
      if (tipY + tipH > densityH - 10) tipY = densityH - tipH - 10;
    }

    ctx.save();
    // Dark background box with subtle border
    roundRect(ctx, tipX, tipY, tipW, tipH, 6);
    ctx.fillStyle = "rgba(10, 11, 16, 0.96)"; ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)"; ctx.lineWidth = 1; ctx.stroke();

    // 1. Header (TRADOOR.S — СОПРОТИВЛЕНИЕ)
    const suffix = d.market === "spot" ? ".S" : ".F";
    const headerTitle = `${d.base}${suffix} - `;
    const headerType = isBid ? "ПОДДЕРЖКА" : "СОПРОТИВЛЕНИЕ";
    const headerTypeColor = isBid ? "#16c784" : "#ff4560";

    ctx.textBaseline = "top";
    ctx.font = "bold 13px Inter";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(headerTitle, tipX + 16, tipY + 16);
    const titleW = ctx.measureText(headerTitle).width;
    ctx.fillStyle = headerTypeColor;
    ctx.fillText(headerType, tipX + 16 + titleW, tipY + 16);

    // Separator line
    ctx.beginPath();
    ctx.moveTo(tipX + 16, tipY + 38);
    ctx.lineTo(tipX + tipW - 16, tipY + 38);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Rows: market/volume/price rendered from the prebuilt list
    let currY = tipY + 50;
    for (const [label, value, color] of tipRows) {
      // The lifetime row is the key signal — draw it slightly larger.
      const isAgeRow = label === "ВРЕМЯ ЖИЗНИ";
      ctx.font = isAgeRow ? "600 12px Inter" : "11px Inter";
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "left";
      ctx.fillText(label, tipX + 16, currY);

      ctx.font = isAgeRow ? "bold 14px Inter" : "bold 12px Inter";
      ctx.fillStyle = color;
      ctx.textAlign = "right";
      ctx.fillText(String(value), tipX + tipW - 16, currY);
      currY += 20;
    }

    ctx.restore();
  }

  if (filtered.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.font = "15px Inter"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Сканирование стаканов...", cx, cy + 55);
  }
}

// тФАтФА Draw a single bubble badge тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function drawDensityBubble(ctx, d, x, y, isHover) {
  const isBid = d.side === "bid";
  const scoreFactor = Math.min(1. + (d.rtwi || 5) / 30, 2.2);
  const baseR = Math.min(32, 24 + scoreFactor * 3); // Larger base radius to fit 3 lines
  const R = Math.round(isHover ? baseR + 4 : baseR);
  const bc = isBid ? [22, 199, 132] : [255, 69, 96];

  ctx.save();

  // Draw main badge shape (bubble with pointer)
  ctx.beginPath();
  // We draw a circle from angle 0.15pi to 0.85pi to leave room for the triangle
  const arcOffset = 0.35;
  ctx.arc(x, y, R, Math.PI / 2 + arcOffset, Math.PI / 2 - arcOffset);
  // Triangle tip at the bottom
  ctx.lineTo(x + 7, y + R - 3);
  ctx.lineTo(x, y + R + 9);
  ctx.lineTo(x - 7, y + R - 3);
  ctx.closePath();

  // Fill
  // Dark mostly opaque fill tinted by side
  ctx.fillStyle = isBid ? "rgba(10, 26, 18, 0.95)" : "rgba(26, 10, 13, 0.95)";
  if (isHover) {
    ctx.fillStyle = isBid ? "rgba(15, 36, 25, 0.98)" : "rgba(36, 15, 20, 0.98)";
  }
  ctx.fill();

  // Border
  ctx.strokeStyle = `rgba(${bc[0]},${bc[1]},${bc[2]},${isHover ? 1 : 0.85})`;
  ctx.lineWidth = isHover ? 2 : 1.5;
  ctx.stroke();

  // Outer glow on hover
  if (isHover) {
    ctx.save();
    ctx.shadowColor = `rgba(${bc[0]},${bc[1]},${bc[2]}, 0.5)`;
    ctx.shadowBlur = 15;
    ctx.fillStyle = "transparent";
    ctx.fill();
    ctx.restore();
  }

  // Texts inside the bubble
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // 1. Top text: Volume (e.g. 5.4M)
  const volText = d.wallK >= 1000
    ? (d.wallK / 1000).toFixed(1).replace(/\.0$/, "") + "M"
    : d.wallK + "K";
  ctx.font = `bold ${isHover ? 14 : 12}px sans-serif`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(volText, x, y - R * 0.35);

  // 2. Middle text: Ticker (e.g. DOGE)
  ctx.font = `${isHover ? 11 : 9}px sans-serif`;
  ctx.fillStyle = `rgb(${bc[0]},${bc[1]},${bc[2]})`;
  ctx.fillText(d.base, x, y + R * 0.05);

  // 3. Bottom text: Exchange + Pct (e.g. BIN 0.7%)
  ctx.font = `bold ${isHover ? 9 : 8}px sans-serif`;
  const exShort = (EX_NAMES[d.ex] || d.ex).substring(0, 3).toUpperCase();
  const pctStr = `${exShort} ${d.pct.toFixed(1)}%`;

  // Unique brand colors for each exchange
  const EX_COLORS = {
    "BN": "#fbbf24", // Binance Yellow
    "BB": "#f97316", // Bybit Orange
    "OX": "#f8fafc", // OKX White
    "BG": "#2dd4bf", // Bitget Cyan
    "MX": "#10b981", // MEXC Emerald
    "GT": "#0ea5e9", // Gate Blue
    "KC": "#22c55e", // Kucoin Green
    "HT": "#ec4899", // HTX Pink
    "BX": "#a855f7", // BingX Purple
    "HL": "#fb923c", // HyperLiquid Orange
    "AD": "#fb923c"  // AsterDEX Orange
  };
  ctx.fillStyle = EX_COLORS[d.ex] || "#a1a1aa";
  ctx.fillText(pctStr, x, y + R * 0.45);

  ctx.restore();
}

function getDensityBubbleSprite(d) {
  const stableId = d.wallId || `${d.ex}:${d.sym}:${d.side}:${Number(d.price).toPrecision(8)}`;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const key = `${stableId}|${d.wallK}|${Number(d.rtwi || 0).toFixed(1)}|${Number(d.pct || 0).toFixed(2)}|${scale}`;
  const cached = densityBubbleSpriteCache.get(key);
  if (cached) return cached;

  const sprite = document.createElement("canvas");
  sprite.width = DENSITY_SPRITE_W * scale;
  sprite.height = DENSITY_SPRITE_H * scale;
  const spriteCtx = sprite.getContext("2d", { alpha: true });
  spriteCtx.scale(scale, scale);
  drawDensityBubble(spriteCtx, d, DENSITY_SPRITE_W / 2, 40, false);
  densityBubbleSpriteCache.set(key, sprite);

  // Keep the cache bounded while retaining most stable walls between updates.
  if (densityBubbleSpriteCache.size > 6000) {
    let removeCount = 1500;
    for (const oldKey of densityBubbleSpriteCache.keys()) {
      densityBubbleSpriteCache.delete(oldKey);
      if (--removeCount <= 0) break;
    }
  }
  return sprite;
}


// тФАтФА Animation loop тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
function startDensityLoop() {
  if (densityAnimFrame) return;
  let lastFrame = 0;
  function loop(ts) {
    if (activeView !== "map") { densityAnimFrame = null; return; }
    if (!document.hidden && ts - lastFrame >= 33) {
      lastFrame = ts;
      drawDensityMap();
    }
    densityAnimFrame = requestAnimationFrame(loop);
  }
  densityAnimFrame = requestAnimationFrame(loop);
}

// тФАтФА Mouse interactions тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
document.addEventListener("mousemove", (e) => {
  if (activeView !== "map" || !densityCanvas) return;
  const rect = densityCanvas.getBoundingClientRect();
  densityMouseX = e.clientX - rect.left;
  densityMouseY = e.clientY - rect.top;
});

function handleDensityTouch(e) {
  if (activeView !== "map" || !densityCanvas) return;
  const rect = densityCanvas.getBoundingClientRect();
  const t = e.touches[0] || e.changedTouches[0];
  if (t) {
    densityMouseX = t.clientX - rect.left;
    densityMouseY = t.clientY - rect.top;
  }
}

densityCanvas = $("density-canvas");
if (densityCanvas) {
  densityCanvas.style.cursor = "default";
  densityCanvas.addEventListener("mousemove", () => {
    if (densityCanvas) densityCanvas.style.cursor = densityHover >= 0 ? "pointer" : "default";
  });
  densityCanvas.addEventListener("touchstart", (e) => {
    handleDensityTouch(e);
  }, { passive: true });
  densityCanvas.addEventListener("touchmove", (e) => {
    handleDensityTouch(e);
  }, { passive: true });
}

let densitySelectedKey = null;

document.addEventListener("click", (e) => {
  if (activeView !== "map") return;
  if (e.target !== densityCanvas) return; // Only switch view when clicking directly on the density canvas

  if (densityHover < 0) {
    // Clicked empty canvas space — deselect
    densitySelectedKey = null;
    return;
  }

  const filtered = densityVisibleData;
  const d = filtered[densityHover];
  if (!d) return;

  const currentKey = d.ex + ":" + d.sym;

  if (densitySelectedKey === currentKey) {
    // 2nd tap/click on the SAME bubble — open chart in screener!
    densitySelectedKey = null;
    let c = coins.get(currentKey);

    // Spot walls must open the equivalent futures chart: spot symbols have no
    // kline feed in the screener, so a spot-only coin must never be selected.
    if (!c || !isUsdtFutures(c)) {
      const matches = Array.from(coins.values())
        .filter(x => x.base === d.base && isUsdtFutures(x))
        .sort((a, b) => (b.v || 0) - (a.v || 0));
      const dExClean = d.ex.replace("_SPOT", "");
      c = matches.find(x => x.ex === dExClean) || matches[0] || null;
    }

    if (c) {
      switchView("screener");
      document.querySelectorAll("#nav .ntab").forEach((t, i) => {
        t.classList.toggle("on", i === 0);
      });
      selectCoin(c);
    } else if (d.market === "spot" || String(d.sym || "").includes("_SPOT")) {
      showToast({ type: "info", title: "Плотность", message: `У ${d.base} нет фьючерсной пары — график недоступен`, durationMs: 4000 });
    }
  } else {
    // 1st tap/click on a bubble — select it and show info card
    densitySelectedKey = currentKey;
  }
});

// тФАтФА Density exchange filter dropdown тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

// тФАтФА Filter buttons тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
document.querySelectorAll(".density-filter-btn[data-dtype]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".density-filter-btn[data-dtype]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    densityFilter = btn.dataset.dtype;
    saveDensityFilters();
    layoutDensityBadges();
  });
});

document.querySelectorAll(".density-filter-btn[data-dmarket]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".density-filter-btn[data-dmarket]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    densityMarket = btn.dataset.dmarket;
    saveDensityFilters();
    layoutDensityBadges();
  });
});

document.querySelectorAll(".density-filter-btn[data-dsize]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".density-filter-btn[data-dsize]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    densitySize = btn.dataset.dsize;
    saveDensityFilters();
    layoutDensityBadges();
  });
});

document.querySelectorAll(".density-sort-btn[data-dsort]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".density-sort-btn[data-dsort]").forEach(b => b.classList.remove("on"));
    btn.classList.add("on");
    densitySort = btn.dataset.dsort;
    saveDensityFilters();
    layoutDensityBadges();
  });
});

let densitySearchDebounce = null;
const densitySearchInput = $("density-search-input");
if (densitySearchInput) {
  densitySearchInput.addEventListener("input", (e) => {
    clearTimeout(densitySearchDebounce);
    densitySearchDebounce = setTimeout(() => {
      densitySearch = e.target.value.trim();
      saveDensityFilters();
      layoutDensityBadges();
    }, 180);
  });
}

const densityMinUsdInput = $("density-min-usd");
const densityMaxDistanceInput = $("density-max-distance");
const densityMinAgeInput = $("density-min-age");
const densitySortInput = $("density-sort");
const densityResetBtn = $("density-reset-btn");

if (densityMinUsdInput) densityMinUsdInput.addEventListener("change", e => {
  densityMinUsd = Math.max(0, Number(e.target.value) || 0);
  saveDensityFilters();
  layoutDensityBadges();
});
if (densityMaxDistanceInput) densityMaxDistanceInput.addEventListener("change", e => {
  densityMaxDistance = Math.max(0.05, Number(e.target.value) || 5);
  saveDensityFilters();
  layoutDensityBadges();
});
if (densityMinAgeInput) densityMinAgeInput.addEventListener("change", e => {
  densityMinAge = Math.max(0, Number(e.target.value) || 0);
  saveDensityFilters();
  layoutDensityBadges();
});
if (densitySortInput) densitySortInput.addEventListener("change", e => {
  densitySort = e.target.value || "score";
  saveDensityFilters();
  layoutDensityBadges();
});
if (densityResetBtn) densityResetBtn.addEventListener("click", () => {
  resetDensityFilters();
});

function saveDensityFilters() {
  try {
    const payload = {
      densityFilter,
      densityMarket,
      densitySize,
      densitySort,
      densitySearch,
      densityMinUsd,
      densityMaxDistance,
      densityMinAge,
      densityExFilter: Array.from(densityExFilter)
    };
    localStorage.setItem("density_filters_v2", JSON.stringify(payload));
  } catch (_) {}
}

function loadDensityFilters() {
  try {
    const raw = localStorage.getItem("density_filters_v2");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.densityFilter === "string") densityFilter = parsed.densityFilter;
      if (typeof parsed.densityMarket === "string") densityMarket = parsed.densityMarket;
      if (typeof parsed.densitySize === "string") densitySize = parsed.densitySize;
      if (typeof parsed.densitySort === "string") densitySort = parsed.densitySort;
      if (typeof parsed.densitySearch === "string") densitySearch = parsed.densitySearch;
      if (typeof parsed.densityMinUsd === "number") densityMinUsd = parsed.densityMinUsd;
      if (typeof parsed.densityMaxDistance === "number") densityMaxDistance = parsed.densityMaxDistance;
      if (typeof parsed.densityMinAge === "number") densityMinAge = parsed.densityMinAge;
      if (Array.isArray(parsed.densityExFilter)) {
        densityExFilter = new Set(parsed.densityExFilter);

        // Profiles saved before AsterDEX was added contain all ten legacy
        // exchanges but no AD. Migrate that old "all exchanges" selection once.
        const migrationKey = "density_filter_ad_migrated_v1";
        if (!localStorage.getItem(migrationKey)) {
          const legacyExchanges = ["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL"];
          if (!densityExFilter.has("AD") && legacyExchanges.every(ex => densityExFilter.has(ex))) {
            densityExFilter.add("AD");
            parsed.densityExFilter = Array.from(densityExFilter);
            localStorage.setItem("density_filters_v2", JSON.stringify(parsed));
          }
          localStorage.setItem(migrationKey, "1");
        }
      }

      syncDensityFilterUI();
    }
  } catch (_) {}
}

function syncDensityFilterUI() {
  document.querySelectorAll(".density-filter-btn[data-dtype]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.dtype === densityFilter);
  });
  document.querySelectorAll(".density-filter-btn[data-dmarket]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.dmarket === densityMarket);
  });
  document.querySelectorAll(".density-filter-btn[data-dsize]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.dsize === densitySize);
  });
  document.querySelectorAll(".density-sort-btn[data-dsort]").forEach(btn => {
    btn.classList.toggle("on", btn.dataset.dsort === densitySort);
  });

  const searchInp = $("density-search-input");
  if (searchInp) searchInp.value = densitySearch;

  const minUsdInp = $("density-min-usd");
  if (minUsdInp) minUsdInp.value = String(densityMinUsd);

  const maxDistInp = $("density-max-distance");
  if (maxDistInp) maxDistInp.value = String(densityMaxDistance);

  const minAgeInp = $("density-min-age");
  if (minAgeInp) minAgeInp.value = String(densityMinAge);

  const sortInp = $("density-sort");
  if (sortInp) sortInp.value = densitySort;

  if (typeof updateDexDropdownUI === "function") updateDexDropdownUI();
}

function resetDensityFilters() {
  densityFilter = "all";
  densityMarket = "all";
  densitySize = "all";
  densitySort = "score";
  densitySearch = "";
  densityMinUsd = 0;
  densityMaxDistance = 3;
  densityMinAge = 0;
  densityExFilter = new Set(["BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD"]);
  syncDensityFilterUI();
  saveDensityFilters();
  layoutDensityBadges();
}

// ═══ Density Blacklist Management ═══
function initDensityBlacklistUI() {
  const blBtn = $("density-blacklist-btn");
  const blModal = $("density-blacklist-modal");
  const blClose = $("density-bl-close");
  const blInput = $("density-bl-input");
  const blAddBtn = $("density-bl-add-btn");
  const blTags = $("density-bl-tags");
  const blCount = $("density-blacklist-count");
  const blHint = $("density-bl-hint");
  const blResetDefault = $("density-bl-reset-default");
  const blClearAll = $("density-bl-clear-all");

  function saveBlacklist() {
    try {
      localStorage.setItem("density_blacklist_coins", JSON.stringify(Array.from(densityBlacklistSet)));
    } catch(_) {}
    updateBlacklistUI();
    layoutDensityBadges();
    if (activeView === "screener") {
      requestAnimationFrame(drawChart);
      if (typeof chartInstances !== "undefined" && Array.isArray(chartInstances)) {
        chartInstances.forEach(inst => { if (inst && typeof inst.draw === "function") inst.draw(); });
      }
    }
  }

  function updateBlacklistUI() {
    const count = densityBlacklistSet.size;
    if (blCount) blCount.textContent = count;
    if (blBtn) blBtn.classList.toggle("has-items", count > 0);
    if (blHint) blHint.textContent = `Скрыто монет: ${count}`;

    if (!blTags) return;
    blTags.innerHTML = "";
    if (count === 0) {
      blTags.innerHTML = '<div style="color:#64748b;font-size:12px;padding:16px;width:100%;text-align:center;">Черный список пуст. Добавьте монеты, которые хотите скрыть.</div>';
      return;
    }

    const sorted = Array.from(densityBlacklistSet).sort();
    sorted.forEach(coin => {
      const tag = document.createElement("div");
      tag.className = "density-bl-tag";
      
      const label = document.createElement("span");
      label.textContent = coin.endsWith("USDT") ? coin : (coin + "USDT");
      tag.appendChild(label);

      const remBtn = document.createElement("button");
      remBtn.className = "density-bl-remove";
      remBtn.innerHTML = "×";
      remBtn.title = `Удалить ${coin} из черного списка`;
      remBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        densityBlacklistSet.delete(coin);
        saveBlacklist();
      });
      tag.appendChild(remBtn);

      blTags.appendChild(tag);
    });
  }

  function addCoinToBlacklist(raw) {
    if (!raw) return;
    const parts = raw.split(/[\s,;|]+/);
    let addedCount = 0;
    parts.forEach(p => {
      const clean = p.trim().toUpperCase().replace(/_SPOT$/i, "").replace(/[-_]/g, "");
      if (clean && clean.length >= 2) {
        densityBlacklistSet.add(clean);
        addedCount++;
      }
    });
    if (addedCount > 0) {
      saveBlacklist();
      showToast({ type: "success", title: "Черный список", message: `Добавлено монет: ${addedCount}`, durationMs: 2000 });
    }
  }

  if (blBtn && blModal) {
    blBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      updateBlacklistUI();
      blModal.classList.add("open");
      if (blInput) { blInput.value = ""; blInput.focus(); }
    });
  }

  if (blClose && blModal) {
    blClose.addEventListener("click", () => blModal.classList.remove("open"));
  }

  if (blModal) {
    blModal.addEventListener("click", (e) => {
      if (e.target === blModal) blModal.classList.remove("open");
    });
  }

  if (blAddBtn && blInput) {
    blAddBtn.addEventListener("click", () => {
      addCoinToBlacklist(blInput.value);
      blInput.value = "";
    });
    blInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        addCoinToBlacklist(blInput.value);
        blInput.value = "";
      } else if (e.key === "Escape" && blModal) {
        blModal.classList.remove("open");
      }
    });
  }

  if (blResetDefault) {
    blResetDefault.addEventListener("click", () => {
      densityBlacklistSet = new Set(DEFAULT_DENSITY_BLACKLIST.map(c => c.toUpperCase()));
      saveBlacklist();
      showToast({ type: "success", title: "Черный список", message: "Восстановлен стандартный черный список", durationMs: 2500 });
    });
  }

  if (blClearAll) {
    blClearAll.addEventListener("click", () => {
      densityBlacklistSet.clear();
      saveBlacklist();
      showToast({ type: "info", title: "Черный список", message: "Черный список полностью очищен", durationMs: 2500 });
    });
  }

  updateBlacklistUI();
}

// ─── Resize ────────────────────────────────────────────────────────────────
window.addEventListener("resize", () => {
  if (activeView === "map") {
    resizeDensityCanvas();
  }
});

// ─── Init ──────────────────────────────────────────────────────────────────
(function init() {
  // Subscription controls are critical navigation. Initialize them before
  // optional chart modules so an unrelated widget cannot disable upgrades.
  let paySelectedPlan = "1m";
  let paySelectedMethod = "trc20";
  let currentPayInvoice = null;
  let payPollTimer = null;
  let payCountdownTimer = null;

  window.openProfileModal = openProfileModal;
  window.closeProfileModal = closeProfileModal;
  window.openProModal = openProModal;
  window.closeProModal = closeProModal;
  window.openPayModal = openPayModal;
  window.closePayModal = closePayModal;
  window.selectPayTariff = selectPayTariff;
  window.selectPayMethod = selectPayMethod;
  window.backToTariffs = backToTariffs;
  window.startPayInvoice = startPayInvoice;
  window.copyPayField = copyPayField;
  bindProAccessControls();
  bindProFeatureGate();

  loadTags();
  loadDrawings();
  loadDensityFilters();
  initDensityBlacklistUI();
  if (typeof syncIndicatorButtonsUI === "function") syncIndicatorButtonsUI();
  fetchWalls();

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
        if (typeof syncCustomGridSelect === "function") syncCustomGridSelect();
      }
      if (screenerView === "multichart") {
        initChartGrid();
      } else {
        // If they click this while not in multichart visually (should be hidden but just in case)
        toggleScreenerView("multichart");
      }
    };
  }

  // Helper to sync custom grid select dropdown UI
  function syncCustomGridSelect() {
    const valSpan = $("custom-grid-select-val");
    if (!valSpan) return;

    let label = gridSize + " Графиков";
    if (gridSize === 2 || gridSize === 3 || gridSize === 4) {
      label = gridSize + " Графика";
    }
    valSpan.textContent = label;

    const items = document.querySelectorAll(".custom-grid-select-item");
    let found = false;
    items.forEach(item => {
      const val = parseInt(item.dataset.value);
      if (val === gridSize) {
        item.classList.add("on");
        item.setAttribute("aria-selected", "true");
        found = true;
      } else {
        item.classList.remove("on");
        item.setAttribute("aria-selected", "false");
      }
    });

    if (!found) {
      const menu = $("custom-grid-select-menu");
      if (menu) {
        // Remove any previous custom dynamic items first to avoid duplicates
        const oldDynamic = menu.querySelector('.custom-grid-select-item[data-dynamic="true"]');
        if (oldDynamic) oldDynamic.remove();

        const newItem = document.createElement("div");
        newItem.className = "custom-grid-select-item on";
        newItem.dataset.value = gridSize;
        newItem.dataset.dynamic = "true";
        newItem.setAttribute("role", "option");
        newItem.setAttribute("aria-selected", "true");
        newItem.textContent = label;
        newItem.onclick = () => {
          selectCustomGridSize(gridSize);
        };
        menu.appendChild(newItem);
      }
    } else {
      // Clean up dynamic items if they are no longer selected
      const menu = $("custom-grid-select-menu");
      if (menu) {
        const oldDynamic = menu.querySelector('.custom-grid-select-item[data-dynamic="true"]');
        if (oldDynamic) oldDynamic.remove();
      }
    }
  }

  function selectCustomGridSize(val) {
    gridSize = val;
    const sel = $("grid-size-select");
    if (sel) sel.value = val;
    syncCustomGridSelect();
    if (screenerView === "multichart") {
      initChartGrid();
    }
  }

  // Custom Grid size select binding
  const customGridBtn = $("custom-grid-select-btn");
  const customGridMenu = $("custom-grid-select-menu");
  if (customGridBtn && customGridMenu) {
    const positionGridMenu = () => {
      // #ctbar is a horizontal scroll container, so any dropdown dropping
      // below it gets clipped (overflow-y:visible is forced to auto). Pin the
      // menu to the viewport at the button's coordinates to escape clipping.
      const r = customGridBtn.getBoundingClientRect();
      customGridMenu.style.position = "fixed";
      customGridMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 150)) + "px";
      customGridMenu.style.top = Math.min(r.bottom + 4, window.innerHeight - 280) + "px";
    };
    customGridBtn.onclick = (e) => {
      e.stopPropagation();
      const open = customGridMenu.classList.contains("open");
      if (open) {
        customGridMenu.classList.remove("open");
        customGridBtn.classList.remove("open");
      } else {
        positionGridMenu();
        customGridMenu.classList.add("open");
        customGridBtn.classList.add("open");
      }
    };

    document.addEventListener("click", () => {
      customGridMenu.classList.remove("open");
      customGridBtn.classList.remove("open");
    });

    customGridMenu.onclick = (e) => e.stopPropagation();

    document.querySelectorAll(".custom-grid-select-item").forEach(item => {
      item.onclick = () => {
        const val = parseInt(item.dataset.value);
        selectCustomGridSize(val);
        customGridMenu.classList.remove("open");
        customGridBtn.classList.remove("open");
      };
    });

    syncCustomGridSelect();
  }

  // Native Grid size select fallback / link
  const gridSizeSelect = $("grid-size-select");
  if (gridSizeSelect) {
    gridSizeSelect.value = gridSize;
    gridSizeSelect.onchange = (e) => {
      gridSize = parseInt(e.target.value);
      syncCustomGridSelect();
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
  const updateDrawingsToggleBtns = () => {
    ["btn-toggle-mc-drawings", "btn-toggle-formations-drawings"].forEach(id => {
      const btn = $(id);
      if (btn) {
        btn.classList.toggle("on", showMultichartDrawings);
        btn.title = showMultichartDrawings 
          ? "Рисунки на графиках: Включены (нажмите чтобы выключить)" 
          : "Рисунки на графиках: Выключены (нажмите чтобы включить)";
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
      }
    });
  };

  const toggleMcDrawings = () => {
    showMultichartDrawings = !showMultichartDrawings;
    localStorage.setItem("show_multichart_drawings", showMultichartDrawings);
    updateDrawingsToggleBtns();
    if (chartInstances && chartInstances.length > 0) {
      chartInstances.forEach(inst => inst.draw(true));
    }
  };

  const btnMcDrawings = $("btn-toggle-mc-drawings");
  if (btnMcDrawings) btnMcDrawings.onclick = toggleMcDrawings;
  const btnFormationsDrawings = $("btn-toggle-formations-drawings");
  if (btnFormationsDrawings) btnFormationsDrawings.onclick = toggleMcDrawings;
  updateDrawingsToggleBtns();

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
  connectWS();
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

  // тФАтФА Debug overlay (tap logo 5x to toggle) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
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

  // тФАтФАтФА Unmitigated Level Detector тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  //
  // An "unmitigated" level is a swing high or low where:
  //   1. Price formed a clear local extreme (swing)
  //   2. Price DEPARTED quickly (strong move away)
  //   3. Price has NOT returned to that zone since
  //
  // These are the "debts" the market owes тАФ it WILL come back to cover them.
  //
  // Returns up to 3 setup objects:
  //   {
  //     price         : level price
  //     direction     : 'up' | 'down'  тАФ direction price must travel to mitigate
  //     swingIdx      : candle index where level was formed
  //     departureIdx  : candle where price made the decisive move away
  //     strength      : number for sorting
  //     atr           : ATR at detection time (for projection sizing)
  //   }
  //
  window.detectChartLevelsAndTouches = function (candles) {
    if (!candles || candles.length < 40) return [];

    const N = candles.length;

    // тФАтФА 1. ATR-14 тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
    let atrSum = 0;
    for (let i = Math.max(1, N - 14); i < N; i++) {
      const c = candles[i], p = candles[i - 1];
      atrSum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    }
    const atr = atrSum / 14;
    const tol = atr * 0.4;   // within 40% ATR = "price visited this zone"
    const minDep = atr * 0.8; // departure must be at least 80% ATR in 3 bars

    // тФАтФА 2. Swing Highs & Lows (window=3) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
    const W = 3;
    const swings = [];
    for (let i = W; i < N - W; i++) {
      let isH = true, isL = true;
      for (let j = i - W; j <= i + W; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) swings.push({ idx: i, price: candles[i].h, type: 'high' });
      if (isL) swings.push({ idx: i, price: candles[i].l, type: 'low' });
    }

    const lastPrice = candles[N - 1].c;
    const candidates = [];

    for (const sw of swings) {
      const lvl = sw.price;

      // тФАтФА 3. Departure: price must have moved away strongly after swing тФАтФАтФАтФАтФА
      // Check that within 5 bars after swing, price moved at least minDep away
      let departed = false;
      let departureIdx = sw.idx;
      for (let i = sw.idx + 1; i < Math.min(sw.idx + 6, N); i++) {
        if (sw.type === 'high') {
          // After a high, price should drop away
          if (lvl - candles[i].c >= minDep) { departed = true; departureIdx = i; break; }
        } else {
          // After a low, price should rise away
          if (candles[i].c - lvl >= minDep) { departed = true; departureIdx = i; break; }
        }
      }
      if (!departed) continue;

      // тФАтФА 4. UNMITIGATED: price must NOT have pierced the level тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
      // One wick is noise, not a confirmed mitigation. Waiting for two closes
      // also keeps a live level from flickering while the candle is forming.
      let mitigated = false;
      let closesBeyond = 0;
      const touchIndices = [sw.idx];
      for (let i = sw.idx + 1; i < N; i++) {
        const c = candles[i];
        const beyond = sw.type === 'high'
          ? c.c > lvl + tol * 0.45
          : c.c < lvl - tol * 0.45;
        closesBeyond = beyond ? closesBeyond + 1 : 0;
        if (closesBeyond >= 2) { mitigated = true; break; }
        const visited = sw.type === 'high'
          ? Math.abs(c.h - lvl) <= tol
          : Math.abs(c.l - lvl) <= tol;
        if (visited && i - touchIndices[touchIndices.length - 1] > 1) touchIndices.push(i);
      }
      if (mitigated) continue;

      // тФАтФА 5. Direction price needs to travel to mitigate тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
      // Unmitigated HIGH above current price тЖТ price needs to go UP
      // Unmitigated LOW below current price тЖТ price needs to go DOWN
      let direction;
      if (sw.type === 'high' && lvl > lastPrice) {
        direction = 'up';   // price must rise to reach this unmitigated high
      } else if (sw.type === 'low' && lvl < lastPrice) {
        direction = 'down'; // price must fall to reach this unmitigated low
      } else {
        // Level is on the wrong side тАФ skip (e.g. unmitigated high already
        // above where price is going, but price is above it тАФ shouldn't happen
        // given our mitigated check, but guard anyway)
        continue;
      }

      // тФАтФА 6. Recency score тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
      // Prefer more recent + farther swings (price owes more distance)
      const barsAgo = N - 1 - sw.idx;
      // Skip if too old (> 200 bars) тАФ irrelevant for current price action
      if (barsAgo > 200) continue;

      const recency = 1 - barsAgo / 200;
      const distance = Math.abs(lvl - lastPrice) / atr;  // how many ATRs away
      const strength = recency * 2.5 + Math.min(distance, 5) * 0.4;

      candidates.push({
        price: lvl,
        direction,
        swingIdx: sw.idx,
        departureIdx,
        touchIndices,
        touches: touchIndices.length,
        strength,
        atr
      });
    }

    // тФАтФА 7. Deduplicate: keep strongest, show up to 8 unmitigated levels тФАтФАтФАтФАтФАтФА
    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    for (const c of candidates) {
      const adaptiveDedupe = Math.max(0.0025, Math.min(0.008, atr / Math.max(lastPrice, 1e-12) * 0.6));
      const near = kept.find(k => Math.abs(k.price - c.price) / c.price < adaptiveDedupe);
      if (!near) kept.push(c);
      if (kept.length >= 12) break;
    }

    return kept;
  };

  window.detectChartBreakoutLevels = function (candles, minTouchesOverride) {
    if (!candles || candles.length < 40) return [];
    const N = candles.length;
    const lastPrice = candles[N - 1].c;
    const minTouches = (typeof minTouchesOverride === 'number') ? minTouchesOverride : formationsMinCascade;

    // 1. Swing Highs & Lows (window=3)
    const W = 3;
    const swings = [];
    for (let i = W; i < N - W; i++) {
      let isH = true, isL = true;
      for (let j = i - W; j <= i + W; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) swings.push({ idx: i, price: candles[i].h, type: 'high' });
      if (isL) swings.push({ idx: i, price: candles[i].l, type: 'low' });
    }

    const highSwings = swings.filter(s => s.type === 'high');
    const lowSwings = swings.filter(s => s.type === 'low');
    let atrSum = 0;
    const atrStart = Math.max(1, N - 24);
    for (let i = atrStart; i < N; i++) {
      atrSum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    }
    const atrPct = (atrSum / Math.max(1, N - atrStart)) / Math.max(lastPrice, 1e-12);
    const tol = Math.max(0.0012, Math.min(0.005, atrPct * 0.22));
    const breakTol = Math.max(0.002, Math.min(0.008, tol * 1.8));
    const candidates = [];

    // Resistance (breaks UP)
    const resClusters = [];
    for (const sw of highSwings) {
      let merged = false;
      for (const cl of resClusters) {
        if (Math.abs(sw.price - cl.price) / cl.price <= tol) {
          cl.prices.push(sw.price);
          cl.price = cl.prices.reduce((sum, price) => sum + price, 0) / cl.prices.length;
          cl.touches++;
          cl.swingIndices.push(sw.idx);
          cl.lastTouch = Math.max(cl.lastTouch, sw.idx);
          merged = true;
          break;
        }
      }
      if (!merged) {
        resClusters.push({ price: sw.price, prices: [sw.price], touches: 1, swingIndices: [sw.idx], lastTouch: sw.idx });
      }
    }

    // Filter Resistance
    for (const cl of resClusters) {
      if (cl.touches < minTouches) continue;
      const firstIdx = Math.min(...cl.swingIndices);

      let active = true;
      let closesBeyond = 0;
      let touchIndices = new Set(cl.swingIndices);
      let lastTouchIndex = cl.lastTouch;

      for (let i = cl.lastTouch + 1; i < N; i++) {
        closesBeyond = candles[i].c > cl.price * (1 + breakTol) ? closesBeyond + 1 : 0;
        if (closesBeyond >= 2) {
          active = false;
          break;
        }

        // Touch if candle high reaches within 0.25% below/at resistance line
        const isTouch = candles[i].h >= cl.price * (1 - tol * 2) && candles[i].h <= cl.price * 1.001;
        if (isTouch) {
          touchIndices.add(i);
          lastTouchIndex = Math.max(lastTouchIndex, i);
        }
      }

      if (active) {
        const dist = Math.abs(cl.price - lastPrice) / lastPrice;
        const barsSinceLastTouch = N - 1 - lastTouchIndex;
        const relevance = - (dist * 1000) - (barsSinceLastTouch / 20);

        candidates.push({
          price: cl.price,
          direction: 'up',
          swingIdx: firstIdx,
          lastTouch: lastTouchIndex,
          touches: touchIndices.size,
          touchIndices: Array.from(touchIndices),
          relevance: relevance,
          strength: touchIndices.size * 3 - dist * 100
        });
      }
    }

    // Support (breaks DOWN)
    const supClusters = [];
    for (const sw of lowSwings) {
      let merged = false;
      for (const cl of supClusters) {
        if (Math.abs(sw.price - cl.price) / cl.price <= tol) {
          cl.prices.push(sw.price);
          cl.price = cl.prices.reduce((sum, price) => sum + price, 0) / cl.prices.length;
          cl.touches++;
          cl.swingIndices.push(sw.idx);
          cl.lastTouch = Math.max(cl.lastTouch, sw.idx);
          merged = true;
          break;
        }
      }
      if (!merged) {
        supClusters.push({ price: sw.price, prices: [sw.price], touches: 1, swingIndices: [sw.idx], lastTouch: sw.idx });
      }
    }

    // Filter Support
    for (const cl of supClusters) {
      if (cl.touches < minTouches) continue;
      const firstIdx = Math.min(...cl.swingIndices);

      let active = true;
      let closesBeyond = 0;
      let touchIndices = new Set(cl.swingIndices);
      let lastTouchIndex = cl.lastTouch;

      for (let i = cl.lastTouch + 1; i < N; i++) {
        closesBeyond = candles[i].c < cl.price * (1 - breakTol) ? closesBeyond + 1 : 0;
        if (closesBeyond >= 2) {
          active = false;
          break;
        }

        // Touch if candle low reaches within 0.25% above/at support line
        const isTouch = candles[i].l <= cl.price * (1 + tol * 2) && candles[i].l >= cl.price * 0.999;
        if (isTouch) {
          touchIndices.add(i);
          lastTouchIndex = Math.max(lastTouchIndex, i);
        }
      }

      if (active) {
        const dist = Math.abs(cl.price - lastPrice) / lastPrice;
        const barsSinceLastTouch = N - 1 - lastTouchIndex;
        const relevance = - (dist * 1000) - (barsSinceLastTouch / 20);

        candidates.push({
          price: cl.price,
          direction: 'down',
          swingIdx: firstIdx,
          lastTouch: lastTouchIndex,
          touches: touchIndices.size,
          touchIndices: Array.from(touchIndices),
          relevance: relevance,
          strength: touchIndices.size * 3 - dist * 100
        });
      }
    }

    // Sort by relevance (highest relevance first)
    candidates.sort((a, b) => b.relevance - a.relevance);

    // Deduplicate using current volatility instead of a one-size-fits-all value.
    const kept = [];
    for (const c of candidates) {
      const near = kept.find(k => Math.abs(k.price - c.price) / c.price < Math.max(0.0025, tol * 1.5));
      if (!near) kept.push(c);
    }

    return kept.slice(0, 12);
  };



  window.detectChartTrendlines = function (candles, minTouchesOverride) {
    if (!candles || candles.length < 40) return [];
    const N = candles.length;
    const lastPrice = candles[N - 1].c;
    const minTouches = (typeof minTouchesOverride === 'number') ? minTouchesOverride : formationsMinCascade;
    let atrSum = 0;
    const atrStart = Math.max(1, N - 24);
    for (let i = atrStart; i < N; i++) {
      atrSum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    }
    const atrPct = (atrSum / Math.max(1, N - atrStart)) / Math.max(lastPrice, 1e-12);
    const tol = Math.max(0.0012, Math.min(0.006, atrPct * 0.18));

    // Old history adds quadratic work and produces irrelevant lines. A rolling
    // 320-bar window is enough for all supported intraday formation modes.
    const W = 3;
    const swings = [];
    const scanStart = Math.max(W, N - 320);
    for (let i = scanStart; i < N - W; i++) {
      let isH = true, isL = true;
      for (let j = i - W; j <= i + W; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) swings.push({ idx: i, price: candles[i].h, type: 'high' });
      if (isL) swings.push({ idx: i, price: candles[i].l, type: 'low' });
    }

    const highSwings = swings.filter(s => s.type === 'high').slice(-36);
    const lowSwings = swings.filter(s => s.type === 'low').slice(-36);
    const candidates = [];

    function collectTrendlines(sideSwings, resistance) {
      for (let i = 0; i < sideSwings.length - 1; i++) {
        for (let j = i + 1; j < sideSwings.length; j++) {
          const s1 = sideSwings[i], s2 = sideSwings[j];
          if (s2.idx - s1.idx < 5) continue;
          if (resistance ? s2.price >= s1.price : s2.price <= s1.price) continue;
          const slope = (s2.price - s1.price) / (s2.idx - s1.idx);
          let consecutiveBroken = 0;
          const swingIndices = [s1.idx, s2.idx];

          for (let k = s1.idx; k < N; k++) {
            const lineVal = s1.price + slope * (k - s1.idx);
            if (!(lineVal > 0)) { consecutiveBroken = 2; break; }
            const closeBeyond = resistance
              ? candles[k].c > lineVal * (1 + tol * 1.25)
              : candles[k].c < lineVal * (1 - tol * 1.25);
            consecutiveBroken = closeBeyond ? consecutiveBroken + 1 : 0;
            if (consecutiveBroken >= 2) break;
            const wick = resistance ? candles[k].h : candles[k].l;
            if (Math.abs(wick - lineVal) / lineVal <= tol && k - swingIndices[swingIndices.length - 1] > 1) {
              swingIndices.push(k);
            }
          }
          if (consecutiveBroken >= 2) continue;

          const uniqueTouches = Array.from(new Set(swingIndices)).sort((a, b) => a - b);
          if (uniqueTouches.length < minTouches) continue;
          const lineLastVal = s1.price + slope * (N - 1 - s1.idx);
          const wrongSide = resistance ? lastPrice > lineLastVal * (1 + tol) : lastPrice < lineLastVal * (1 - tol);
          if (wrongSide || !(lineLastVal > 0)) continue;
          const dist = Math.abs(lineLastVal - lastPrice) / lastPrice;
          if (dist > 0.035) continue;

          candidates.push({
            p1: s1, p2: s2, slope,
            direction: resistance ? 'up' : 'down',
            swingIndices: uniqueTouches,
            touches: uniqueTouches.length,
            isTrendline: true,
            strength: uniqueTouches.length * 2.5 - dist * 100 - (N - 1 - s2.idx) / 80,
            endPrice: lineLastVal
          });
        }
      }
    }

    collectTrendlines(highSwings, true);
    collectTrendlines(lowSwings, false);

    // Deduplicate trendlines that are too similar
    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    for (const c of candidates) {
      const near = kept.find(k => k.direction === c.direction && Math.abs(k.endPrice - c.endPrice) / c.endPrice < 0.005);
      if (!near) kept.push(c);
      if (kept.length >= 12) break;
    }

    return kept;
  };

  window.detectChartRetests = function (candles) {
    if (!candles || candles.length < 40) return [];
    const N = candles.length;
    const lastPrice = candles[N - 1].c;

    const W = 3;
    const swings = [];
    for (let i = W; i < N - W; i++) {
      let isH = true, isL = true;
      for (let j = i - W; j <= i + W; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) swings.push({ idx: i, price: candles[i].h, type: 'high' });
      if (isL) swings.push({ idx: i, price: candles[i].l, type: 'low' });
    }

    const highSwings = swings.filter(s => s.type === 'high');
    const lowSwings = swings.filter(s => s.type === 'low');
    const tol = 0.0015; // 0.15% zone tolerance
    const MIN_DEPARTURE = 0.0030; // Price must depart by at least 0.30% after breakout
    const MAX_OVERSHOOT = 0.0020; // Max 0.20% deep pierce allowed on retest
    const maxBarsToRetest = 30;   // Retest MUST occur within 30 candles of breakout
    const MAX_RETEST_AGE = 15;    // Retest touch MUST have occurred within the last 15 candles
    const candidates = [];

    // тФАтФА 1. Resistance clusters (Bullish Retest: Price below -> Break UP -> Depart UP -> Retest from ABOVE) тФАтФА
    const resClusters = [];
    for (const sw of highSwings) {
      let merged = false;
      for (const cl of resClusters) {
        if (Math.abs(sw.price - cl.price) / cl.price <= tol) {
          cl.prices.push(sw.price);
          cl.price = Math.max(...cl.prices);
          cl.touches++;
          cl.swingIndices.push(sw.idx);
          merged = true;
          break;
        }
      }
      if (!merged) {
        resClusters.push({ price: sw.price, prices: [sw.price], touches: 1, swingIndices: [sw.idx] });
      }
    }

    for (const cl of resClusters) {
      if (cl.touches < 2 || cl.touches > 5) continue; // Must be 2-5 touches

      // GLOBAL LEVEL CLEANLINESS: level cannot have more than 2 total crossovers across chart history
      const firstSwingIdx = Math.min(...cl.swingIndices);
      let totalCrosses = 0;
      for (let k = firstSwingIdx; k < N - 1; k++) {
        if ((candles[k].c < cl.price && candles[k + 1].c > cl.price) ||
          (candles[k].c > cl.price && candles[k + 1].c < cl.price)) {
          totalCrosses++;
        }
      }
      if (totalCrosses > 2) continue; // Dirty level / chop zone -> REJECT IMMEDIATELY

      const lastSwingIdx = Math.max(...cl.swingIndices);

      let breakIdx = -1;
      let touchIdx = -1;
      let overshoot = 0;
      let departed = false;

      for (let i = lastSwingIdx + 1; i < N - 1; i++) {
        const c = candles[i];

        if (breakIdx === -1) {
          if (c.c > cl.price * (1 + tol / 2) && c.c > c.o) {
            breakIdx = i;
          }
        } else {
          // Breakout invalidated if price closes back BELOW level before or during retest
          if (c.c < cl.price) break;

          if (i > breakIdx + maxBarsToRetest) break;

          // Check if price has departed sufficiently (>0.40% away)
          if ((c.h - cl.price) / cl.price >= 0.0040) {
            departed = true;
          }

          // Retest CANNOT happen less than 3 candles after breakout
          if (i < breakIdx + 3) continue;

          // Touch from above тАФ only valid IF price departed first
          if (departed && c.l <= cl.price * (1 + tol)) {
            if (c.l < cl.price * (1 - MAX_OVERSHOOT)) break; // Deep breach
            if (c.c < cl.price) break; // Retest candle must close ABOVE level

            touchIdx = i;
            overshoot = Math.max(0, (cl.price - c.l) / cl.price);
            break;
          }
        }
      }

      if (breakIdx !== -1 && touchIdx !== -1) {
        if (N - 1 - touchIdx > MAX_RETEST_AGE) continue; // Must be recent

        let held = true;
        for (let k = touchIdx; k < N; k++) {
          if (candles[k].c < cl.price) {
            held = false;
            break;
          }
        }

        if (held) {
          const dist = Math.abs(cl.price - lastPrice) / lastPrice;
          const barsSinceRetest = N - 1 - touchIdx;
          candidates.push({
            price: cl.price,
            direction: 'up',
            swingIdx: Math.min(...cl.swingIndices),
            breakIdx: breakIdx,
            touchIdx: touchIdx,
            isRetest: true,
            outcome: 'confirmed',
            overshoot: overshoot,
            strength: cl.touches * 10 - dist * 100 - overshoot * 50 - barsSinceRetest / 5,
            touches: cl.touches
          });
        }
      }
    }

    // тФАтФА 2. Support clusters (Bearish Retest: Price above -> Break DOWN -> Depart DOWN -> Retest from BELOW) тФАтФА
    const supClusters = [];
    for (const sw of lowSwings) {
      let merged = false;
      for (const cl of supClusters) {
        if (Math.abs(sw.price - cl.price) / cl.price <= tol) {
          cl.prices.push(sw.price);
          cl.price = Math.min(...cl.prices);
          cl.touches++;
          cl.swingIndices.push(sw.idx);
          merged = true;
          break;
        }
      }
      if (!merged) {
        supClusters.push({ price: sw.price, prices: [sw.price], touches: 1, swingIndices: [sw.idx] });
      }
    }

    for (const cl of supClusters) {
      if (cl.touches < 2 || cl.touches > 5) continue; // Must be 2-5 touches

      // GLOBAL LEVEL CLEANLINESS: level cannot have more than 2 total crossovers across chart history
      const firstSwingIdx = Math.min(...cl.swingIndices);
      let totalCrosses = 0;
      for (let k = firstSwingIdx; k < N - 1; k++) {
        if ((candles[k].c < cl.price && candles[k + 1].c > cl.price) ||
          (candles[k].c > cl.price && candles[k + 1].c < cl.price)) {
          totalCrosses++;
        }
      }
      if (totalCrosses > 2) continue; // Dirty level / chop zone -> REJECT IMMEDIATELY

      const lastSwingIdx = Math.max(...cl.swingIndices);

      let breakIdx = -1;
      let touchIdx = -1;
      let overshoot = 0;
      let departed = false;

      for (let i = lastSwingIdx + 1; i < N - 1; i++) {
        const c = candles[i];

        if (breakIdx === -1) {
          if (c.c < cl.price * (1 - tol / 2) && c.c < c.o) {
            breakIdx = i;
          }
        } else {
          // Breakout invalidated if price closes back ABOVE level before or during retest
          if (c.c > cl.price) break;

          if (i > breakIdx + maxBarsToRetest) break;

          // Check if price has departed sufficiently (>0.40% away)
          if ((cl.price - c.l) / cl.price >= 0.0040) {
            departed = true;
          }

          // Retest CANNOT happen less than 3 candles after breakout
          if (i < breakIdx + 3) continue;

          // Touch from below тАФ only valid IF price departed first
          if (departed && c.h >= cl.price * (1 - tol)) {
            if (c.h > cl.price * (1 + MAX_OVERSHOOT)) break; // Deep breach
            if (c.c > cl.price) break; // Retest candle must close BELOW level

            touchIdx = i;
            overshoot = Math.max(0, (c.h - cl.price) / cl.price);
            break;
          }
        }
      }

      if (breakIdx !== -1 && touchIdx !== -1) {
        if (N - 1 - touchIdx > MAX_RETEST_AGE) continue; // Must be recent

        let held = true;
        for (let k = touchIdx; k < N; k++) {
          if (candles[k].c > cl.price) {
            held = false;
            break;
          }
        }

        if (held) {
          const dist = Math.abs(cl.price - lastPrice) / lastPrice;
          const barsSinceRetest = N - 1 - touchIdx;
          candidates.push({
            price: cl.price,
            direction: 'down',
            swingIdx: Math.min(...cl.swingIndices),
            breakIdx: breakIdx,
            touchIdx: touchIdx,
            isRetest: true,
            outcome: 'confirmed',
            overshoot: overshoot,
            strength: cl.touches * 10 - dist * 100 - overshoot * 50 - barsSinceRetest / 5,
            touches: cl.touches
          });
        }
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    for (const c of candidates) {
      const near = kept.find(k => Math.abs(k.price - c.price) / c.price < 0.005);
      if (!near) kept.push(c);
    }
    return kept.slice(0, 1);
  };

  window.detectChartApproachingRetests = function (candles) {
    if (!candles || candles.length < 40) return [];
    const N = candles.length;
    const lastPrice = candles[N - 1].c;

    const W = 3;
    const swings = [];
    for (let i = W; i < N - W; i++) {
      let isH = true, isL = true;
      for (let j = i - W; j <= i + W; j++) {
        if (j === i) continue;
        if (candles[j].h >= candles[i].h) isH = false;
        if (candles[j].l <= candles[i].l) isL = false;
      }
      if (isH) swings.push({ idx: i, price: candles[i].h, type: 'high' });
      if (isL) swings.push({ idx: i, price: candles[i].l, type: 'low' });
    }

    const highSwings = swings.filter(s => s.type === 'high');
    const lowSwings = swings.filter(s => s.type === 'low');
    const tol = 0.003; // wider clustering tolerance to build stronger levels
    const candidates = [];
    const MIN_TOUCHES = 2; // level must have at least 2 swing touches
    const MIN_BREAKOUT_DIST = 0.015; // price must travel тЙе1.5% beyond level to confirm breakout
    const APPROACH_ZONE = 0.015; // price is "approaching" when within 1.5% of level

    // тФАтФА Resistance clusters (broken upward тЖТ support retest from above) тФАтФА
    const resClusters = [];
    for (const sw of highSwings) {
      let merged = false;
      for (const cl of resClusters) {
        if (Math.abs(sw.price - cl.price) / cl.price <= tol) {
          cl.prices.push(sw.price);
          cl.price = cl.prices.reduce((a, b) => a + b, 0) / cl.prices.length; // average
          cl.touches++;
          cl.swingIndices.push(sw.idx);
          cl.lastTouch = Math.max(cl.lastTouch, sw.idx);
          merged = true;
          break;
        }
      }
      if (!merged) {
        resClusters.push({ price: sw.price, prices: [sw.price], touches: 1, swingIndices: [sw.idx], lastTouch: sw.idx });
      }
    }

    for (const cl of resClusters) {
      if (cl.touches < MIN_TOUCHES) continue;
      const lastSwingIdx = Math.max(...cl.swingIndices);

      // Find a TRUE breakout: close above level AFTER the last swing touch
      let breakIdx = -1;
      for (let i = lastSwingIdx + 1; i < N; i++) {
        if (candles[i].c > cl.price + cl.price * tol) {
          breakIdx = i;
          break;
        }
      }
      if (breakIdx === -1) continue;

      // Breakout must be PROVEN: price had to travel тЙе1.5% above the level at some point
      let maxAbove = 0;
      let peakIdx = breakIdx;
      for (let i = breakIdx; i < N; i++) {
        const abovePct = (candles[i].h - cl.price) / cl.price;
        if (abovePct > maxAbove) {
          maxAbove = abovePct;
          peakIdx = i;
        }
      }
      if (maxAbove < MIN_BREAKOUT_DIST) continue;

      // Price must NOT have closed below the level since breakout (no failed breakout)
      let failed = false;
      for (let k = breakIdx + 1; k < N; k++) {
        if (candles[k].c < cl.price - cl.price * tol) {
          failed = true;
          break;
        }
      }
      if (failed) continue;

      // Check that NO return touch (wick touching level zone) has happened yet
      let alreadyTouched = false;
      for (let i = breakIdx + 1; i < N; i++) {
        if (candles[i].l <= cl.price + cl.price * tol) {
          alreadyTouched = true;
          break;
        }
      }
      if (alreadyTouched) continue;

      // Price must be APPROACHING: currently within 1.5% of level AND below the peak
      const dist = (lastPrice - cl.price) / cl.price;
      if (dist <= 0 || dist > APPROACH_ZONE) continue;

      // The peak must be ABOVE current price (price came down from peak toward level)
      if (lastPrice >= candles[peakIdx].h * 0.998) continue;

      candidates.push({
        price: cl.price,
        direction: 'up',
        swingIdx: Math.min(...cl.swingIndices),
        breakIdx: breakIdx,
        isApproachingRetest: true,
        strength: cl.touches * 5 - dist * 100 + maxAbove * 20,
        touches: cl.touches
      });
    }

    // тФАтФА Support clusters (broken downward тЖТ resistance retest from below) тФАтФА
    const supClusters = [];
    for (const sw of lowSwings) {
      let merged = false;
      for (const cl of supClusters) {
        if (Math.abs(sw.price - cl.price) / cl.price <= tol) {
          cl.prices.push(sw.price);
          cl.price = cl.prices.reduce((a, b) => a + b, 0) / cl.prices.length;
          cl.touches++;
          cl.swingIndices.push(sw.idx);
          cl.lastTouch = Math.max(cl.lastTouch, sw.idx);
          merged = true;
          break;
        }
      }
      if (!merged) {
        supClusters.push({ price: sw.price, prices: [sw.price], touches: 1, swingIndices: [sw.idx], lastTouch: sw.idx });
      }
    }

    for (const cl of supClusters) {
      if (cl.touches < MIN_TOUCHES) continue;
      const lastSwingIdx = Math.max(...cl.swingIndices);

      // Find a TRUE breakout: close below level AFTER the last swing touch
      let breakIdx = -1;
      for (let i = lastSwingIdx + 1; i < N; i++) {
        if (candles[i].c < cl.price - cl.price * tol) {
          breakIdx = i;
          break;
        }
      }
      if (breakIdx === -1) continue;

      // Breakout must be PROVEN: price had to travel тЙе1.5% below the level
      let maxBelow = 0;
      let troughIdx = breakIdx;
      for (let i = breakIdx; i < N; i++) {
        const belowPct = (cl.price - candles[i].l) / cl.price;
        if (belowPct > maxBelow) {
          maxBelow = belowPct;
          troughIdx = i;
        }
      }
      if (maxBelow < MIN_BREAKOUT_DIST) continue;

      // Price must NOT have closed above the level since breakout
      let failed = false;
      for (let k = breakIdx + 1; k < N; k++) {
        if (candles[k].c > cl.price + cl.price * tol) {
          failed = true;
          break;
        }
      }
      if (failed) continue;

      // Check that NO return touch has happened yet
      let alreadyTouched = false;
      for (let i = breakIdx + 1; i < N; i++) {
        if (candles[i].h >= cl.price - cl.price * tol) {
          alreadyTouched = true;
          break;
        }
      }
      if (alreadyTouched) continue;

      // Price must be APPROACHING: currently within 1.5% of level AND above the trough
      const dist = (cl.price - lastPrice) / cl.price;
      if (dist <= 0 || dist > APPROACH_ZONE) continue;

      // The trough must be BELOW current price (price came up from trough toward level)
      if (lastPrice <= candles[troughIdx].l * 1.002) continue;

      candidates.push({
        price: cl.price,
        direction: 'down',
        swingIdx: Math.min(...cl.swingIndices),
        breakIdx: breakIdx,
        isApproachingRetest: true,
        strength: cl.touches * 5 - dist * 100 + maxBelow * 20,
        touches: cl.touches
      });
    }

    // Sort by strength, deduplicate
    candidates.sort((a, b) => b.strength - a.strength);
    const kept = [];
    for (const c of candidates) {
      const near = kept.find(k => Math.abs(k.price - c.price) / c.price < 0.005);
      if (!near) kept.push(c);
    }
    return kept.slice(0, 3);
  };

  // Replace the legacy detectors with the shared, server-tested geometry
  // engine. Keeping the public names avoids touching the rendering layer.
  if (window.FormationEngine) {
    window.detectChartLevelsAndTouches = (items) => window.FormationEngine.detectCascades(items, formationsMinCascade);
    window.detectChartBreakoutLevels = (items) => window.FormationEngine.detectHorizontals(items, formationsMinCascade);
    window.detectChartTrendlines = (items) => window.FormationEngine.detectTrendlines(items, formationsMinCascade);
    window.detectChartRetests = (items) => window.FormationEngine.detectRetests(items);
    window.detectChartApproachingRetests = (items) => window.FormationEngine.detectApproachingRetests(items);
  }

  window.detectChartLevelsFn = function (candles) {
    if (!candles || candles.length < 30) return [];

    if (typeof activeFormation !== 'undefined') {
      if (activeFormation === 'breakout') {
        return getCachedFormationDetection(candles, `view:breakout:${formationsMinCascade}`, () => window.detectChartBreakoutLevels(candles));
      } else if (activeFormation === 'trendline') {
        return getCachedFormationDetection(candles, `view:trendline:${formationsMinCascade}`, () => window.detectChartTrendlines(candles));
      } else if (activeFormation === 'retest') {
        const showApproaching = $("formations-approaching-toggle")?.checked;
        return getCachedFormationDetection(candles, `view:retest:${showApproaching ? 1 : 0}`, () => showApproaching
          ? window.detectChartApproachingRetests(candles)
          : window.detectChartRetests(candles));
      } else {
        // 'cascades' or 'levels': horizontal levels and cascades only
        return getCachedFormationDetection(candles, `view:cascades:${formationsMinCascade}`, () => window.detectChartLevelsAndTouches(candles));
      }
    }

    return getCachedFormationDetection(candles, 'view:cascades:default', () => window.detectChartLevelsAndTouches(candles));
  };

  // тФАтФАтФА Formations View Logic v2 (Simplified Multi-Charts) тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  let formationsCols = 2;
  let formationsTf = "4h";
  let activeFormation = 'cascades';



  const formationsNearestToggle = $("formations-nearest-toggle");
  if (formationsNearestToggle) {
    formationsNearestToggle.checked = false; // default OFF
    formationsNearestToggle.onchange = () => {
      window.loadFormations(true);
    };
  }

  const formationsApproachingToggle = $("formations-approaching-toggle");
  if (formationsApproachingToggle) {
    formationsApproachingToggle.checked = false; // default OFF
    formationsApproachingToggle.onchange = () => {
      formationsCoinsLevelsMap.clear();
      window.loadFormations(true);
    };
  }

  // Init timeframe switcher listeners for Formations
  document.querySelectorAll(".fg-tf-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".fg-tf-btn").forEach(b => b.classList.remove("on"));
      btn.classList.add("on");
      formationsTf = btn.dataset.tf;
      formationsCoinsLevelsMap.clear();
      window.loadFormations(true);
    };
  });

  // Formations custom grid size select binding
  const fgGridBtn = $("formations-grid-select-btn");
  const fgGridMenu = $("formations-grid-select-menu");
  const fgGridVal = $("formations-grid-select-val");

  function syncFormationsGridSelect() {
    if (!fgGridBtn || !fgGridMenu || !fgGridVal) return;
    let label = formationsCols + " Графиков";
    if (formationsCols === 1) label = formationsCols + " График";
    else if (formationsCols >= 2 && formationsCols <= 4) label = formationsCols + " Графика";

    fgGridVal.textContent = label;

    fgGridMenu.querySelectorAll(".custom-grid-select-item").forEach(item => {
      const val = parseInt(item.dataset.value, 10);
      if (val === formationsCols) {
        item.classList.add("on");
      } else {
        item.classList.remove("on");
      }
    });
  }

  if (fgGridBtn && fgGridMenu) {
    fgGridBtn.onclick = (e) => {
      e.stopPropagation();
      const open = fgGridMenu.classList.contains("open");
      if (open) {
        fgGridMenu.classList.remove("open");
        fgGridBtn.classList.remove("open");
      } else {
        fgGridMenu.classList.add("open");
        fgGridBtn.classList.add("open");
      }
    };

    document.addEventListener("click", () => {
      fgGridMenu.classList.remove("open");
      fgGridBtn.classList.remove("open");
    });

    fgGridMenu.onclick = (e) => e.stopPropagation();

    fgGridMenu.querySelectorAll(".custom-grid-select-item").forEach(item => {
      item.onclick = () => {
        formationsCols = parseInt(item.dataset.value, 10);
        syncFormationsGridSelect();
        fgGridMenu.classList.remove("open");
        fgGridBtn.classList.remove("open");
        window.loadFormations();
      };
    });

    syncFormationsGridSelect();
  }

  // Formations custom exchange dropdown select binding
  const fgExcBtn = $("formations-exc-btn");
  const fgExcMenu = $("formations-exc-menu");
  const fgExcName = $("formations-exc-name");
  const fgExcDot = $("formations-exc-dot");

  function syncFormationsExchangeSelect() {
    if (!fgExcBtn || !fgExcMenu || !fgExcName) return;
    const allItem = fgExcMenu.querySelector(".exc-item[data-cex='ALL']");
    const otherItems = Array.from(fgExcMenu.querySelectorAll(".exc-item:not([data-cex='ALL'])"));
    const activeItems = otherItems.filter(item => item.classList.contains("on"));

    if (activeItems.length === otherItems.length) {
      allItem.classList.add("on");
      fgExcName.textContent = "Все биржи";
      const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%230D0F14%22/%3E%3Ccircle cx=%228%22 cy=%228%22 r=%223%22 fill=%22%23F0B90B%22/%3E%3Ccircle cx=%2216%22 cy=%228%22 r=%223%22 fill=%22%23F7A600%22/%3E%3Ccircle cx=%228%22 cy=%2216%22 r=%223%22 fill=%22%2300F0FF%22/%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%223%22 fill=%22%232EBD85%22/%3E%3C/svg%3E";
      fgExcDot.style.background = `center/contain no-repeat url('${ALL_EXC_IMG}')`;
    } else {
      allItem.classList.remove("on");
      if (activeItems.length === 0) {
        fgExcName.textContent = "Нет бирж";
        fgExcDot.style.background = "none";
      } else if (activeItems.length === 1) {
        fgExcName.textContent = activeItems[0].dataset.label;
        fgExcDot.style.background = `center/contain no-repeat url('${activeItems[0].dataset.img}')`;
      } else {
        fgExcName.textContent = `Выбрано: ${activeItems.length}`;
        const ALL_EXC_IMG = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%226%22 fill=%22%230D0F14%22/%3E%3Ccircle cx=%228%22 cy=%228%22 r=%223%22 fill=%22%23F0B90B%22/%3E%3Ccircle cx=%2216%22 cy=%228%22 r=%223%22 fill=%22%23F7A600%22/%3E%3Ccircle cx=%228%22 cy=%2216%22 r=%223%22 fill=%22%2300F0FF%22/%3E%3Ccircle cx=%2216%22 cy=%2216%22 r=%223%22 fill=%22%232EBD85%22/%3E%3C/svg%3E";
        fgExcDot.style.background = `center/contain no-repeat url('${ALL_EXC_IMG}')`;
      }
    }
  }

  if (fgExcBtn && fgExcMenu) {
    fgExcBtn.onclick = (e) => {
      e.stopPropagation();
      const open = fgExcMenu.classList.contains("open");
      if (open) {
        fgExcMenu.classList.remove("open");
        fgExcBtn.classList.remove("open");
      } else {
        fgExcMenu.classList.add("open");
        fgExcBtn.classList.add("open");
      }
    };

    document.addEventListener("click", () => {
      fgExcMenu.classList.remove("open");
      fgExcBtn.classList.remove("open");
    });

    fgExcMenu.onclick = (e) => e.stopPropagation();

    fgExcMenu.querySelectorAll(".exc-item").forEach(item => {
      item.onclick = () => {
        const cex = item.dataset.cex;
        const wasOn = item.classList.contains("on");

        if (cex === "ALL") {
          const turnOn = !wasOn;
          fgExcMenu.querySelectorAll(".exc-item").forEach(x => {
            if (turnOn) x.classList.add("on");
            else x.classList.remove("on");
          });
        } else {
          if (wasOn) {
            item.classList.remove("on");
          } else {
            item.classList.add("on");
          }
        }

        syncFormationsExchangeSelect();
        window.loadFormations();
      };
    });

    syncFormationsExchangeSelect();
  }

  function preloadFormationsInBackground() {
    const tf = typeof formationsTf !== 'undefined' ? formationsTf : '15m';
    const type = typeof activeFormation !== 'undefined' ? activeFormation : 'cascades';
    fetch(`/api/formations/map?tf=${encodeURIComponent(tf)}&type=${encodeURIComponent(type)}`)
      .then(r => r.ok ? r.json() : null)
      .then(mapData => {
        if (type !== activeFormation) return;
        if (mapData && Object.keys(mapData).length > 0) {
          for (const coinKey in mapData) {
            formationsCoinsLevelsMap.set(coinKey, mapData[coinKey]);
          }
          if (activeView === "formations") {
            window.loadFormations();
          }
        }
      })
      .catch(() => {});
  }
  setTimeout(preloadFormationsInBackground, 800);
  setInterval(preloadFormationsInBackground, 15000);

  // Formations custom settings menu select binding
  let formationsMinCascade = 2; // Default to 2+ levels

  // Formations Selection Dropdown Binding
  const fgSelectBtn = $("formations-select-btn");
  const fgSelectMenu = $("formations-select-menu");
  const fgSelectText = $("formations-select-text");

  function syncFormationsSelect() {
    if (!fgSelectBtn || !fgSelectMenu || !fgSelectText) return;
    if (activeFormation === 'cascades') {
      fgSelectText.textContent = "Каскады";
    } else if (activeFormation === 'breakout') {
      fgSelectText.textContent = "Гориз. уровень";
    } else if (activeFormation === 'trendline') {
      fgSelectText.textContent = "Наклонный уровень";
    } else if (activeFormation === 'retest') {
      fgSelectText.textContent = "Ретест уровня";
    }

    const approachingWrap = $("formations-approaching-wrap");
    if (approachingWrap) {
      approachingWrap.style.display = (activeFormation === 'retest') ? 'flex' : 'none';
    }

    const settingsWrap = $("formations-settings-wrap");
    if (settingsWrap) {
      settingsWrap.style.display = (activeFormation === 'retest') ? 'none' : '';
    }

    fgSelectMenu.querySelectorAll(".custom-grid-select-item").forEach(item => {
      if (item.dataset.value === activeFormation) {
        item.classList.add("on");
      } else {
        item.classList.remove("on");
      }
    });

    updateSettingsMenuItems();
  }

  function updateSettingsMenuItems() {
    const header = $("formations-settings-header");
    const menu = $("formations-settings-menu");
    if (!menu) return;
    const items = menu.querySelectorAll(".custom-grid-select-item");
    if (items.length < 5) return;
    if (activeFormation === 'cascades') {
      if (header) header.textContent = "Мин. уровней каскада";
      items[0].textContent = "1+ уровень";
      items[1].textContent = "2+ уровня";
      items[2].textContent = "3+ уровня";
      items[3].textContent = "4+ уровня";
      items[4].textContent = "5+ уровней";
    } else if (activeFormation === 'breakout') {
      if (header) header.textContent = "Мин. касаний уровня";
      items[0].textContent = "1+ касание";
      items[1].textContent = "2+ касания";
      items[2].textContent = "3+ касания";
      items[3].textContent = "4+ касания";
      items[4].textContent = "5+ касаний";
    } else {
      if (header) header.textContent = "Мин. касаний  ";
      items[0].textContent = "1+ касание";
      items[1].textContent = "2+ касания";
      items[2].textContent = "3+ касания";
      items[3].textContent = "4+ касания";
      items[4].textContent = "5+ касаний";
    }
  }

  if (fgSelectBtn && fgSelectMenu) {
    fgSelectBtn.onclick = (e) => {
      e.stopPropagation();
      const open = fgSelectMenu.classList.contains("open");
      if (open) {
        fgSelectMenu.classList.remove("open");
        fgSelectBtn.classList.remove("open");
      } else {
        fgSelectMenu.classList.add("open");
        fgSelectBtn.classList.add("open");

        // Close other menus
        fgSettingsMenu?.classList.remove("open");
        fgSettingsBtn?.classList.remove("open");
        fgGridMenu?.classList.remove("open");
        fgGridBtn?.classList.remove("open");
        fgExcMenu?.classList.remove("open");
        fgExcBtn?.classList.remove("open");
      }
    };

    document.addEventListener("click", () => {
      fgSelectMenu.classList.remove("open");
      fgSelectBtn.classList.remove("open");
    });

    fgSelectMenu.onclick = (e) => e.stopPropagation();

    fgSelectMenu.querySelectorAll(".custom-grid-select-item").forEach(item => {
      item.onclick = () => {
        activeFormation = item.dataset.value;
        syncFormationsSelect();
        fgSelectMenu.classList.remove("open");
        fgSelectBtn.classList.remove("open");
        // Clear cached formations level map because we changed the active formation type
        formationsCoinsLevelsMap.clear();
        formationMissesByCoin.clear();
        window.loadFormations(true);
      };
    });

    syncFormationsSelect();
  }

  const fgSettingsBtn = $("formations-settings-btn");
  const fgSettingsMenu = $("formations-settings-menu");

  function syncFormationsSettings() {
    if (!fgSettingsMenu) return;
    fgSettingsMenu.querySelectorAll(".custom-grid-select-item").forEach(item => {
      const val = parseInt(item.dataset.value, 10);
      if (val === formationsMinCascade) {
        item.classList.add("on");
      } else {
        item.classList.remove("on");
      }
    });
  }

  if (fgSettingsBtn && fgSettingsMenu) {
    fgSettingsBtn.onclick = (e) => {
      e.stopPropagation();
      const open = fgSettingsMenu.classList.contains("open");
      if (open) {
        fgSettingsMenu.classList.remove("open");
        fgSettingsBtn.classList.remove("open");
      } else {
        fgSettingsMenu.classList.add("open");
        fgSettingsBtn.classList.add("open");

        // Close other menus
        fgSelectMenu?.classList.remove("open");
        fgSelectBtn?.classList.remove("open");
        fgGridMenu?.classList.remove("open");
        fgGridBtn?.classList.remove("open");
        fgExcMenu?.classList.remove("open");
        fgExcBtn?.classList.remove("open");
      }
    };

    document.addEventListener("click", () => {
      fgSettingsMenu.classList.remove("open");
      fgSettingsBtn.classList.remove("open");
      fgSelectMenu?.classList.remove("open");
      fgSelectBtn?.classList.remove("open");
    });

    fgSettingsMenu.onclick = (e) => e.stopPropagation();

    fgSettingsMenu.querySelectorAll(".custom-grid-select-item").forEach(item => {
      item.onclick = () => {
        formationsMinCascade = parseInt(item.dataset.value, 10);
        syncFormationsSettings();
        fgSettingsMenu.classList.remove("open");
        fgSettingsBtn.classList.remove("open");
        window.loadFormations(true);
      };
    });

    syncFormationsSettings();
  }

  // тФАтФА Pagination state тФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФАтФА
  let formationsPage = 0;
  // Map of key => levels array for coins that have detected levels
  const formationsCoinsLevelsMap = new Map();
  const formationMissesByCoin = new Map();
  // Full sorted list rebuilt on loadFormations, used for paging
  let formationsAllCoins = [];

  let activeScanId = 0;
  let scanProgressText = "";
  let lastScanKey = "";
  let formationsScanAbortController = null;

  let lastLoadFormationsTs = 0;
  let loadFormationsTimeout = null;

  function triggerThrottledLoadFormations() {
    const now = Date.now();
    if (now - lastLoadFormationsTs >= 1500) {
      lastLoadFormationsTs = now;
      if (loadFormationsTimeout) {
        clearTimeout(loadFormationsTimeout);
        loadFormationsTimeout = null;
      }
      window.loadFormations();
    } else {
      if (!loadFormationsTimeout) {
        loadFormationsTimeout = setTimeout(() => {
          lastLoadFormationsTs = Date.now();
          loadFormationsTimeout = null;
          window.loadFormations();
        }, 1500 - (now - lastLoadFormationsTs));
      }
    }
  }

  async function startFormationsScan(checkedEx, tf) {
    const scanId = ++activeScanId;
    formationsScanAbortController?.abort();
    formationsScanAbortController = new AbortController();
    const signal = formationsScanAbortController.signal;
    scanProgressText = "Загрузка с сервера...";
    updateFormationsPagination();

    try {
      const r = await fetch(`/api/formations/map?tf=${encodeURIComponent(tf)}&type=${encodeURIComponent(activeFormation)}`, { signal });
      if (r.ok) {
        const mapData = await r.json();
        if (scanId !== activeScanId) return;
        if (mapData && Object.keys(mapData).length > 0) {
          for (const coinKey in mapData) {
            if (checkedEx.includes(coinKey.split(':')[0])) {
              formationsCoinsLevelsMap.set(coinKey, mapData[coinKey]);
              formationMissesByCoin.delete(coinKey);
            }
          }
          updateFormationsPagination();
          window.loadFormations();
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }

    const eligibleCoins = [];
    for (const ex of checkedEx) {
      const exCoins = Array.from(coins.values())
        .filter(c => c.ex === ex && isUsdtFutures(c) && c.v >= 80000 && !isStablecoinBase(c));
      eligibleCoins.push(...exCoins);
    }
    eligibleCoins.sort((a, b) => {
      const aSeeded = formationsCoinsLevelsMap.has(a.ex + ':' + a.sym) ? 1 : 0;
      const bSeeded = formationsCoinsLevelsMap.has(b.ex + ':' + b.sym) ? 1 : 0;
      return bSeeded - aSeeded || b.v - a.v;
    });
    // The server seed is rendered immediately. A bounded local verification
    // pass keeps it live without downloading thousands of histories per tab.
    if (eligibleCoins.length > 500) eligibleCoins.length = 500;

    let index = 0;
    const total = eligibleCoins.length;
    if (total === 0) {
      scanProgressText = "";
      updateFormationsPagination();
      setTimeout(() => {
        if (scanId === activeScanId) {
          startFormationsScan(checkedEx, tf);
        }
      }, 1000);
      return;
    }

    let processedCount = 0;
    const scanStartTime = performance.now();

    async function nextBatch() {
      if (scanId !== activeScanId) return; // cancelled
      if (index >= total) {
        scanProgressText = "";
        updateFormationsPagination();
        if (loadFormationsTimeout) {
          clearTimeout(loadFormationsTimeout);
          loadFormationsTimeout = null;
        }
        window.loadFormations();
        return;
      }

      const batch = eligibleCoins.slice(index, index + 50);
      index += batch.length;

      const promises = batch.map(async (c) => {
        const key = `${c.ex}|${c.sym}|${tf}`;
        let klinesData = null;

        try {
          const cached = KLINES_CACHE.get(key);
          if (cached && Date.now() - cached.ts < 300000) {
            klinesData = cached.data;
          } else {
            try {
              const r = await fetch(`/api/klines?ex=${c.ex}&sym=${c.sym}&tf=${tf}&lite=1`, { signal });
              if (r.ok) {
                const rawKlines = await r.json();
                if (Array.isArray(rawKlines) && rawKlines.length > 0) {
                  klinesData = rawKlines;
                  KLINES_CACHE.set(key, { ts: Date.now(), data: rawKlines });
                }
              }
            } catch (e) { }
          }

          if (klinesData) {
            const flat = [];
            if (typeof klinesData[0] === 'number') {
              for (let i = 0; i < klinesData.length; i += 6) {
                flat.push({ t: klinesData[i], o: klinesData[i + 1], h: klinesData[i + 2], l: klinesData[i + 3], c: klinesData[i + 4], v: klinesData[i + 5] });
              }
            } else {
              flat.push(...klinesData);
            }
            const candlesList = sanitizeCandles(flat);
            const detectedLevels = window.detectChartLevelsFn(candlesList);
            const coinKey = c.ex + ':' + c.sym;

            let wasEligible = false;
            const hadLevel = formationsCoinsLevelsMap.has(coinKey);
            if (hadLevel) {
              if (activeFormation === 'breakout' || activeFormation === 'trendline') {
                wasEligible = true;
              } else {
                const prevLvls = formationsCoinsLevelsMap.get(coinKey);
                let upC = 0, downC = 0;
                for (const l of prevLvls) {
                  if (l.direction === 'up') upC++; else if (l.direction === 'down') downC++;
                }
                wasEligible = Math.max(upC, downC) >= formationsMinCascade;
              }
            }

            const hasLevel = detectedLevels && detectedLevels.length > 0;
            if (hasLevel) {
              formationsCoinsLevelsMap.set(coinKey, detectedLevels);
              formationMissesByCoin.delete(coinKey);
            } else {
              const misses = (formationMissesByCoin.get(coinKey) || 0) + 1;
              formationMissesByCoin.set(coinKey, misses);
              if (misses >= 3) formationsCoinsLevelsMap.delete(coinKey);
            }

            let isEligible = false;
            if (hasLevel || formationsCoinsLevelsMap.has(coinKey)) {
              if (activeFormation === 'breakout' || activeFormation === 'trendline' || activeFormation === 'retest') {
                isEligible = true;
              } else {
                let upC = 0, downC = 0;
                const effectiveLevels = hasLevel ? detectedLevels : (formationsCoinsLevelsMap.get(coinKey) || []);
                for (const l of effectiveLevels) {
                  if (l.direction === 'up') upC++; else if (l.direction === 'down') downC++;
                }
                isEligible = Math.max(upC, downC) >= formationsMinCascade;
              }
            }

            if (wasEligible !== isEligible) {
              triggerThrottledLoadFormations();
            }
          }
        } finally {
          processedCount++;
          if (scanId === activeScanId) {
            const elapsedMs = performance.now() - scanStartTime;
            const msPerCoin = processedCount > 0 ? elapsedMs / processedCount : 10;
            const remCoins = total - processedCount;
            const remainingMs = remCoins * msPerCoin;
            const secTotal = Math.ceil(remainingMs / 1000);
            const min = Math.floor(secTotal / 60);
            const sec = secTotal % 60;
            const etaText = min > 0 ? `~${min}м ${sec}с` : `~${sec}с`;

            scanProgressText = `Сканирование: ${processedCount}/${total} (${etaText})`;
            updateFormationsPagination();
          }
        }
      });

      await Promise.all(promises);

      setTimeout(nextBatch, 10);
    }

    nextBatch();
  }

  // Called by ChartInstance after klines load and levels are computed
  window.registerFormationsCoinLevels = function (ex, sym, levels) {
    const key = ex + ':' + sym;
    const had = formationsCoinsLevelsMap.has(key);

    let wasEligible = false;
    if (had) {
      if (activeFormation === 'breakout' || activeFormation === 'trendline' || activeFormation === 'retest') {
        wasEligible = true;
      } else {
        const prev = formationsCoinsLevelsMap.get(key);
        let upC = 0, downC = 0;
        for (const l of prev) {
          if (l.direction === 'up') upC++; else if (l.direction === 'down') downC++;
        }
        wasEligible = Math.max(upC, downC) >= formationsMinCascade;
      }
    }

    const hasL = levels && levels.length > 0;
    if (hasL) {
      formationsCoinsLevelsMap.set(key, levels);
      formationMissesByCoin.delete(key);
    } else {
      const misses = (formationMissesByCoin.get(key) || 0) + 1;
      formationMissesByCoin.set(key, misses);
      if (misses >= 3) formationsCoinsLevelsMap.delete(key);
    }

    const effectiveLevels = hasL ? levels : (formationsCoinsLevelsMap.get(key) || []);
    let isEligible = false;
    if (effectiveLevels.length > 0) {
      if (activeFormation === 'breakout' || activeFormation === 'trendline' || activeFormation === 'retest') {
        isEligible = true;
      } else {
        let upC = 0, downC = 0;
        for (const l of effectiveLevels) {
          if (l.direction === 'up') upC++; else if (l.direction === 'down') downC++;
        }
        isEligible = Math.max(upC, downC) >= formationsMinCascade;
      }
    }

    if (wasEligible !== isEligible) {
      triggerThrottledLoadFormations();
    } else {
      updateFormationsPagination();
    }
  };

  function updateFormationsPagination() {
    const pgEl = $("formations-page-info");
    const prevBtn = $("formations-page-prev");
    const nextBtn = $("formations-page-next");
    if (!pgEl) return;
    const perPage = formationsCols;
    const total = formationsAllCoins.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (formationsPage >= totalPages) formationsPage = totalPages - 1;

    let infoText = `${formationsPage + 1} / ${totalPages}`;
    if (scanProgressText) {
      infoText += ` [${scanProgressText}]`;
    }
    pgEl.textContent = infoText;

    if (prevBtn) prevBtn.disabled = formationsPage === 0;
    if (nextBtn) nextBtn.disabled = formationsPage >= totalPages - 1;
  }

  // Bind prev/next buttons
  const fgPrevBtn = $("formations-page-prev");
  const fgNextBtn = $("formations-page-next");
  if (fgPrevBtn) fgPrevBtn.onclick = () => {
    if (formationsPage > 0) { formationsPage--; renderCurrentPage(); }
  };
  if (fgNextBtn) fgNextBtn.onclick = () => {
    const perPage = formationsCols;
    const totalPages = Math.max(1, Math.ceil(formationsAllCoins.length / perPage));
    if (formationsPage < totalPages - 1) { formationsPage++; renderCurrentPage(); }
  };

  const fgFormationsNearestToggle = $("formations-nearest-toggle");

  window.loadFormations = function (resetPage = false) {
    if (resetPage) formationsPage = 0;
    const checkedEx = [];
    if (fgExcMenu) {
      fgExcMenu.querySelectorAll(".exc-item:not([data-cex='ALL'])").forEach(item => {
        if (item.classList.contains("on")) checkedEx.push(item.dataset.cex);
      });
    } else {
      checkedEx.push("BN", "BB", "OX", "BG", "GT", "MX", "KC", "BX", "HT", "HL", "AD");
    }

    const onlyFormations = true;

    const getMinDist = (c) => {
      if (!c.p) return Infinity;
      const lvls = formationsCoinsLevelsMap.get(c.ex + ':' + c.sym);
      if (!lvls || lvls.length === 0) return Infinity;
      let minD = Infinity;
      for (const l of lvls) {
        const lp = l.endPrice !== undefined ? l.endPrice : l.price;
        if (lp === undefined) continue;
        const d = Math.abs(lp - c.p) / c.p;
        if (d < minD) minD = d;
      }
      return minD;
    };

    formationsAllCoins = Array.from(coins.values())
      .filter(c => {
        if (!isUsdtFutures(c) || c.v < 80000) return false;
        if (isStablecoinBase(c)) return false;
        if (!checkedEx.includes(c.ex)) return false;
        if (onlyFormations) {
          const lvls = formationsCoinsLevelsMap.get(c.ex + ':' + c.sym);
          if (!lvls || lvls.length === 0) return false;
          if (activeFormation !== 'breakout' && activeFormation !== 'trendline' && activeFormation !== 'retest') {
            let upC = 0, downC = 0;
            for (const l of lvls) {
              if (l.direction === 'up') upC++; else if (l.direction === 'down') downC++;
            }
            const cascadeSize = Math.max(upC, downC);
            if (cascadeSize < formationsMinCascade) return false;
          }
        }
        return true;
      });

    const sortByNearest = fgFormationsNearestToggle?.checked;
    if (sortByNearest) {
      formationsAllCoins.sort((a, b) => {
        const distA = getMinDist(a);
        const distB = getMinDist(b);
        if (distA !== distB) return distA - distB;
        return b.v - a.v; // fallback to volume
      });
    } else {
      formationsAllCoins.sort((a, b) => b.v - a.v);
    }

    const currentScanKey = [
      activeFormation,
      formationsTf,
      formationsMinCascade,
      $("formations-approaching-toggle")?.checked ? 1 : 0,
      checkedEx.sort().join(",")
    ].join("|");
    if (resetPage || currentScanKey !== lastScanKey) {
      lastScanKey = currentScanKey;
      startFormationsScan(checkedEx, formationsTf);
    }

    renderCurrentPage();
  };

  function renderCurrentPage() {
    const grid = $("formations-grid");
    if (!grid) return;
    if (grid.classList.contains("has-expanded")) {
      // Do not overwrite the grid or collapse the chart while user is viewing it
      return;
    }
    grid.classList.remove("has-expanded"); // Reset fullscreen expanded state on page change

    const perPage = formationsCols;
    const start = formationsPage * perPage;
    const slice = formationsAllCoins.slice(start, start + perPage);

    // If user is currently dragging or scaling a chart canvas, defer grid reload
    const isUserInteracting = chartInstances.some(inst => inst && (inst.isDrag || inst.isDragY || inst.isDragYScale));
    if (isUserInteracting) {
      updateFormationsPagination();
      return;
    }

    // Check if current chartInstances match the slice coins
    let isSameCoins = false;
    if (chartInstances.length === slice.length && slice.length > 0) {
      isSameCoins = slice.every((c, i) => {
        const inst = chartInstances[i];
        return inst && inst.ex === c.ex && inst.sym === c.sym;
      });
    }

    if (isSameCoins) {
      // Coins on screen haven't changed: redraw existing instances preserving user's pan/zoom offset!
      chartInstances.forEach((inst, i) => {
        const c = slice[i];
        const coinKey = c.ex + ':' + c.sym;
        const newLvls = formationsCoinsLevelsMap.get(coinKey);
        if (newLvls) inst.levels = newLvls;
        inst.draw();
      });
      updateFormationsPagination();
      return;
    }

    chartInstances.forEach(inst => inst?.dispose?.());
    grid.innerHTML = "";
    chartInstances = [];

    if (formationsAllCoins.length === 0) {
      grid.innerHTML = `<div class="formations-empty">Загрузка формаций...</div>`;
      updateFormationsPagination();
      return;
    }
    if (slice.length === 0) {
      formationsPage = Math.max(0, formationsPage - 1);
      return renderCurrentPage();
    }

    const maxCharts = perPage;
    const rows = maxCharts <= 1 ? 1 : (maxCharts <= 2 ? 1 : (maxCharts <= 6 ? 2 : (maxCharts <= 9 ? 3 : 3)));
    const cols = Math.ceil(maxCharts / rows);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    slice.forEach((c, i) => {
      const inst = new ChartInstance(grid, i);
      inst.tf = formationsTf;
      inst.update(c);
      chartInstances.push(inst);
    });

    if (chartInstances[0]) chartInstances[0].el.classList.add("active");
    updateFormationsPagination();

    requestAnimationFrame(() => {
      chartInstances.forEach(inst => inst && inst.draw(true));
    });
  }

// ── OBSIDIAN PRO MODALS & PAYMENT CONTROLLER ──

function openProfileModal() {
  const token = localStorage.getItem("obsidian_auth_token");
  if (!token) {
    if (typeof openAuthModal === "function") openAuthModal();
    return;
  }
  const modal = $("profile-modal");
  if (modal) {
    modal.style.display = "flex";
    if (typeof renderProfile === "function") renderProfile(window.currentUser);
  }
}

function closeProfileModal() {
  const modal = $("profile-modal");
  if (modal) modal.style.display = "none";
}

function openProModal(featureName) {
  closeProfileModal();
  const proModal = $("proModal");
  const proSub = document.querySelector(".pro-modal-subtitle");
  if (proSub) {
    if (featureName) {
      proSub.textContent = `Функция «${featureName}» доступна исключительно в подписке PRO`;
    } else {
      proSub.textContent = "Доступно исключительно в подписке PRO";
    }
  }
  if (proModal) proModal.style.display = "flex";
}

function closeProModal() {
  const proModal = $("proModal");
  if (proModal) proModal.style.display = "none";
}

function openProCompareModal() {
  closeProModal();
  const compareModal = $("proCompareModal");
  if (compareModal) compareModal.style.display = "flex";
}

function closeProCompareModal() {
  const compareModal = $("proCompareModal");
  if (compareModal) compareModal.style.display = "none";
}

function backToProModal() {
  closeProCompareModal();
  const proModal = $("proModal");
  if (proModal) proModal.style.display = "flex";
}

window.openProCompareModal = openProCompareModal;
window.closeProCompareModal = closeProCompareModal;
window.backToProModal = backToProModal;
window.openProModal = openProModal;
window.closeProModal = closeProModal;

function openPayModal() {
  closeProModal();
  closeProCompareModal();
  const modal = $("obsidian-pay-modal");
  if (modal) {
    modal.style.display = "flex";
    backToTariffs();
    refreshAvailablePaymentMethods();
  }
}

async function refreshAvailablePaymentMethods() {
  const continueButton = $("pay-continue-btn");
  try {
    const response = await fetch("/api/pay/config", { cache: "no-store" });
    const data = await response.json();
    const methods = Array.isArray(data.methods) ? data.methods : [];
    for (const method of ["trc20", "cryptobot"]) {
      const button = $(method === "cryptobot" ? "pay-method-cb" : `pay-method-${method}`);
      if (button) button.style.display = methods.includes(method) ? "" : "none";
    }
    if (!methods.includes(paySelectedMethod)) paySelectedMethod = methods[0] || "";
    if (paySelectedMethod) selectPayMethod(paySelectedMethod);
    if (continueButton) continueButton.disabled = methods.length === 0;
  } catch (_) {
    if (continueButton) continueButton.disabled = true;
  }
}

function closePayModal() {
  const modal = $("obsidian-pay-modal");
  if (modal) modal.style.display = "none";
  if (payPollTimer) clearInterval(payPollTimer);
  if (payCountdownTimer) clearInterval(payCountdownTimer);
}

let currentBugScreenshotBase64 = null;

function handleBugScreenshotFile(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) return;

  if (file.size > 8 * 1024 * 1024) {
    const msg = $("bug-report-msg");
    if (msg) {
      msg.textContent = "Скриншот слишком большой (максимум 8MB)";
      msg.className = "bug-report-msg error";
      msg.style.display = "block";
    }
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    currentBugScreenshotBase64 = e.target.result;
    const previewImg = $("bug-preview-img");
    const previewBox = $("bug-screenshot-preview");
    const promptBox = $("bug-dropzone-prompt");

    if (previewImg) previewImg.src = currentBugScreenshotBase64;
    if (previewBox) previewBox.style.display = "flex";
    if (promptBox) promptBox.style.display = "none";
  };
  reader.readAsDataURL(file);
}

function handleBugScreenshotSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (file) handleBugScreenshotFile(file);
}

function removeBugScreenshot() {
  currentBugScreenshotBase64 = null;
  const fileInput = $("bug-screenshot-input");
  if (fileInput) fileInput.value = "";
  const previewBox = $("bug-screenshot-preview");
  const promptBox = $("bug-dropzone-prompt");
  if (previewBox) previewBox.style.display = "none";
  if (promptBox) promptBox.style.display = "flex";
}

function openBugReportModal() {
  closeProfileModal();
  removeBugScreenshot();
  const modal = $("bugReportModal");
  if (modal) {
    modal.style.display = "flex";
    const input = $("bug-text-input");
    if (input) input.value = "";
    const msg = $("bug-report-msg");
    if (msg) msg.style.display = "none";
  }
}

function closeBugReportModal() {
  const modal = $("bugReportModal");
  if (modal) modal.style.display = "none";
  removeBugScreenshot();
}

async function submitBugReport(event) {
  if (event) event.preventDefault();
  const input = $("bug-text-input");
  const msg = $("bug-report-msg");
  const btn = $("bug-report-submit-btn");

  const description = (input ? input.value : "").trim();
  if (!description || description.length < 3) {
    if (msg) {
      msg.textContent = "Пожалуйста, опишите проблему более подробно (минимум 3 символа)";
      msg.className = "bug-report-msg error";
      msg.style.display = "block";
    }
    return;
  }

  const token = localStorage.getItem("obsidian_auth_token") || "";
  const activeUser = window.currentUser || null;

  if (btn) btn.disabled = true;

  try {
    const response = await fetch("/api/bug-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token ? `Bearer ${token}` : ""
      },
      body: JSON.stringify({
        description,
        image: currentBugScreenshotBase64 || null,
        userId: activeUser ? activeUser.id : null
      })
    });

    const data = await response.json();
    if (response.ok && data.success) {
      if (msg) {
        msg.textContent = "🎉 Ваш баг-репорт отправлен разработчикам! Награда зачислится после проверки.";
        msg.className = "bug-report-msg success";
        msg.style.display = "block";
      }
      if (input) input.value = "";
      removeBugScreenshot();
      setTimeout(() => closeBugReportModal(), 2500);
    } else {
      if (msg) {
        msg.textContent = data.error || "Ошибка при отправке баг-репорта";
        msg.className = "bug-report-msg error";
        msg.style.display = "block";
      }
    }
  } catch (err) {
    if (msg) {
      msg.textContent = "Сетевая ошибка при отправке. Попробуйте ещё раз.";
      msg.className = "bug-report-msg error";
      msg.style.display = "block";
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Global Paste (Ctrl+V) handler for screenshot images
document.addEventListener("paste", function(e) {
  const modal = $("bugReportModal");
  if (!modal || modal.style.display === "none") return;

  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;

  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf("image") !== -1) {
      const file = items[i].getAsFile();
      if (file) {
        handleBugScreenshotFile(file);
        e.preventDefault();
        break;
      }
    }
  }
});

window.openBugReportModal = openBugReportModal;
window.closeBugReportModal = closeBugReportModal;
window.submitBugReport = submitBugReport;
window.handleBugScreenshotSelect = handleBugScreenshotSelect;
window.removeBugScreenshot = removeBugScreenshot;

async function captureChartSnapshot(sym = activeSym, priceVal = 0, alertPriceVal = 0, alertTf = activeTf, alertEx = activeEx, alertOptions = {}) {
  try {
    const targetLevel = alertPriceVal > 0 ? alertPriceVal : priceVal;
    const targetSym = (sym || activeSym || "BTCUSDT").toUpperCase();
    const targetEx = alertEx || activeEx || "BN";
    const targetTf = alertTf || activeTf || "5m";

    // 1. Fetch / collect up to 300 candles of the alert timeframe
    let candleList = [];
    if (sym === activeSym && targetTf === activeTf && Array.isArray(candles) && candles.length >= 50) {
      candleList = candles.slice(-300);
    }

    if (candleList.length < 150) {
      try {
        const res = await fetch(`/api/klines?ex=${targetEx}&sym=${targetSym}&tf=${targetTf}&lite=1`);
        if (res.ok) {
          const raw = await res.json();
          if (Array.isArray(raw) && raw.length >= 6) {
            const parsed = [];
            for (let i = 0; i < raw.length; i += 6) {
              parsed.push({
                t: +raw[i],
                o: +raw[i + 1],
                h: +raw[i + 2],
                l: +raw[i + 3],
                c: +raw[i + 4],
                v: +raw[i + 5] || 0
              });
            }
            if (parsed.length > 0) candleList = parsed.slice(-300);
          }
        }
      } catch (err) {
        console.warn("[SNAPSHOT FETCH KLINES FALLBACK]", err);
      }
    }

    if (!candleList || candleList.length === 0) {
      if (Array.isArray(candles) && candles.length > 0) {
        candleList = candles.slice(-300);
      }
    }

    if (!candleList || candleList.length === 0) return null;

    // 2. Retrieve live coin stats for the HUD card
    let coinInfo = null;
    if (typeof coins !== "undefined" && coins && typeof coins.get === "function") {
      coinInfo = coins.get(`${targetEx}:${targetSym}`) || coins.get(`${activeEx}:${activeSym}`);
      if (!coinInfo) {
        for (const [_, v] of coins.entries()) {
          if (v && (v.sym === targetSym || normSymCode(v.sym) === normSymCode(targetSym))) {
            coinInfo = v;
            break;
          }
        }
      }
    }

    const lastCandle = candleList[candleList.length - 1];
    const liveClose = lastCandle ? lastCandle.c : (coinInfo?.p || targetLevel);
    
    // 24h Change
    const chg24 = (coinInfo && coinInfo.o > 0)
      ? (((liveClose || coinInfo.p) - coinInfo.o) / coinInfo.o) * 100
      : (coinInfo?.chg !== undefined ? coinInfo.chg : (candleList.length > 1 ? ((liveClose - candleList[0].o) / candleList[0].o) * 100 : 0));

    // Volume
    const vol24Str = coinInfo?.v ? (typeof fV === "function" ? fV(coinInfo.v) : `$${(coinInfo.v/1e6).toFixed(1)}M`) : (typeof fV === "function" ? fV(liveClose * 50000) : "—");

    // NATR
    let natrVal = 0;
    if (coinInfo && coinInfo.p > 0 && coinInfo.h && coinInfo.l && coinInfo.h >= coinInfo.l) {
      natrVal = ((coinInfo.h - coinInfo.l) / coinInfo.p) * 100;
    } else if (candleList.length > 0) {
      let lH = 0, lL = Infinity;
      for (const c of candleList) { if (c.h > lH) lH = c.h; if (c.l < lL) lL = c.l; }
      if (liveClose > 0 && lH >= lL) natrVal = ((lH - lL) / liveClose) * 100 * 0.35;
    }
    natrVal = Math.max(0, Math.min(100, natrVal));

    // Funding rate & countdown
    const fundingVal = coinInfo && typeof coinInfo.funding === "number" ? coinInfo.funding : 0.0100;
    let fundStr = (fundingVal >= 0 ? "+" : "") + fundingVal.toFixed(4) + "%";

    let fundMs = 0;
    if (coinInfo && coinInfo.nextFunding > 0) {
      fundMs = coinInfo.nextFunding - Date.now();
    } else {
      const eightH = 8 * 3600000;
      fundMs = eightH - (Date.now() % eightH);
    }
    if (fundMs > 0) {
      const fh = Math.floor(fundMs / 3600000);
      const fm = Math.floor((fundMs % 3600000) / 60000);
      const fs = Math.floor((fundMs % 60000) / 1000);
      fundStr += ` (${fh}:${String(fm).padStart(2, "0")}:${String(fs).padStart(2, "0")})`;
    }

    // 3. Render Dedicated HiDPI Ultra-HD (4K Crisp) Offscreen Canvas (2400 x 1360 physical pixels)
    const W = 1200;
    const H = 680;
    const DPR = 2; // HiDPI 2x Supersampling for ultra-crisp lines & text
    const shot = document.createElement("canvas");
    shot.width = W * DPR;
    shot.height = H * DPR;
    const ctx = shot.getContext("2d");
    ctx.scale(DPR, DPR);

    // Layout configuration
    const TOP = 52;
    const PR = 105;
    const PW = W - PR;
    const BTM_TIME = 28;
    const VOL_H = 105;
    const PH = H - TOP - VOL_H - BTM_TIME;
    const volY = TOP + PH;

    // Deep Obsidian Solid Background
    ctx.fillStyle = "#0c0e14";
    ctx.fillRect(0, 0, W, H);

    // ── Header (Symbol + Timeframe Badge + Stats HUD + Alert Title) ──
    const displaySym = targetSym;
    const tfLabel = String(targetTf).toUpperCase();

    // Symbol Text
    ctx.font = "bold 20px Inter, -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(displaySym, 22, 26);
    const symW = ctx.measureText(displaySym).width;

    // Timeframe Badge
    const tfColors = { "1M": "#38bdf8", "3M": "#38bdf8", "5M": "#22c55e", "15M": "#a855f7", "30M": "#ec4899", "1H": "#f59e0b", "4H": "#f97316", "1D": "#e11d48" };
    const tfBg = tfColors[tfLabel] || "#a855f7";
    const badgeX = 22 + symW + 10;
    const tfBadgeW = Math.max(36, tfLabel.length * 9 + 16);

    ctx.fillStyle = tfBg;
    if (typeof roundRect === "function") roundRect(ctx, badgeX, 14, tfBadgeW, 23, 5);
    else ctx.fillRect(badgeX, 14, tfBadgeW, 23);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11.5px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(tfLabel, badgeX + tfBadgeW / 2, 26);

    // ── Coin Stats HUD Card (Изм, Объем, NATR, Фандинг) ──
    const hudX = badgeX + tfBadgeW + 16;
    const chgText = (chg24 >= 0 ? "+" : "") + chg24.toFixed(2) + "%";
    const isChgUp = chg24 >= 0;

    // Render Stats Pills
    let curStatX = hudX;
    const renderStatPill = (label, val, valCol) => {
      ctx.font = "600 10.5px Inter, sans-serif";
      const lblW = ctx.measureText(label).width;
      ctx.font = "bold 11px Inter, sans-serif";
      const valW = ctx.measureText(val).width;
      const pillW = lblW + valW + 18;

      ctx.save();
      if (typeof roundRect === "function") roundRect(ctx, curStatX, 14, pillW, 23, 5);
      else ctx.fillRect(curStatX, 14, pillW, 23);
      ctx.fillStyle = "rgba(255, 255, 255, 0.055)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
      ctx.font = "600 10px Inter, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(label, curStatX + 7, 26);

      ctx.fillStyle = valCol;
      ctx.font = "bold 11px Inter, monospace";
      ctx.fillText(val, curStatX + 7 + lblW + 4, 26);
      ctx.restore();

      curStatX += pillW + 8;
    };

    renderStatPill("ИЗМ", chgText, isChgUp ? "#22c55e" : "#ef4444");
    renderStatPill("ОБЪЕМ", vol24Str, "#ffffff");
    renderStatPill("NATR", natrVal.toFixed(1) + "%", "#a855f7");
    renderStatPill("ФАНДИНГ", fundStr, fundingVal > 0 ? "#fbbf24" : fundingVal < 0 ? "#ef4444" : "#94a3b8");

    // Right-side alert notification title
    ctx.textAlign = "right";
    if (alertOptions && alertOptions.isFormation) {
      let realTouches = 2;
      if (typeof FormationEngine !== "undefined" && typeof FormationEngine.detectTrendlines === "function") {
        try {
          const detected = FormationEngine.detectTrendlines(candleList, 2);
          if (detected && detected.length > 0) {
            realTouches = detected[0].touches || 2;
          }
        } catch (_) {}
      }
      if (alertOptions.formationInfo) {
        alertOptions.formationInfo.touches = realTouches;
      }
      const distStr = alertOptions?.formationInfo?.distPct || "0.28";

      ctx.fillStyle = "#c084fc";
      ctx.font = "bold 12.5px Inter, sans-serif";
      ctx.fillText(`⚡ OBSIDIAN FORMATION ALERT`, W - 22, 20);

      ctx.fillStyle = "#94a3b8";
      ctx.font = "500 10.5px Inter, sans-serif";
      ctx.fillText(`📐 Наклонка: ${realTouches} касания · до линии ${distStr}%`, W - 22, 34);
    } else {
      ctx.fillStyle = "#f59e0b";
      ctx.font = "bold 13px Inter, sans-serif";
      ctx.fillText(`🔔 OBSIDIAN PRICE ALERT`, W - 22, 26);
    }

    // ── Price bounds calculation across candle list (300 bars) ──
    let minP = Infinity, maxP = -Infinity;
    let maxVol = 0.0001;
    for (const c of candleList) {
      if (c.l < minP) minP = c.l;
      if (c.h > maxP) maxP = c.h;
      if (c.v > maxVol) maxVol = c.v;
    }
    
    // Only include targetLevel in bounds if it is reasonably near the candle range (< 10% away)
    if (targetLevel > 0 && !alertOptions?.isFormation) {
      if (targetLevel >= minP * 0.9 && targetLevel <= maxP * 1.1) {
        minP = Math.min(minP, targetLevel);
        maxP = Math.max(maxP, targetLevel);
      }
    }
    const priceMargin = (maxP - minP) * 0.05 || (minP * 0.01);
    minP -= priceMargin;
    maxP += priceMargin;
    const priceRange = maxP - minP || 1;

    const toY = (p) => TOP + (maxP - p) * (PH / priceRange);
    const toVolY = (v) => volY + VOL_H - (v / maxVol) * (VOL_H - 15);

    // Helper functions for coordinates on snapshot canvas
    const numCandles = candleList.length;
    const candleStepW = PW / numCandles;
    const candleBodyW = Math.max(1.8, Math.min(candleStepW * 0.76, candleStepW - 1.2));

    function getSnapX(t) {
      if (typeof t !== "number") return -1;
      if (t > 1000000000) {
        let closestIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < candleList.length; i++) {
          const diff = Math.abs(candleList[i].t - t);
          if (diff < minDiff) {
            minDiff = diff;
            closestIdx = i;
          }
        }
        return closestIdx * candleStepW + candleStepW / 2;
      }
      return t * candleStepW + candleStepW / 2;
    }

    // ── Grid Lines ──
    const gridStep = typeof calcNiceStep === "function" ? calcNiceStep(priceRange, 7) : priceRange / 7;
    let gp = Math.ceil(minP / gridStep) * gridStep;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    while (gp <= maxP) {
      const y = toY(gp);
      if (y >= TOP && y <= TOP + PH) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(PW, y);
        ctx.stroke();
      }
      gp += gridStep;
    }

    // Volume divider
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.beginPath();
    ctx.moveTo(0, volY);
    ctx.lineTo(W, volY);
    ctx.stroke();

    // ── Candlesticks & Volume Bars (300 bars) ──
    for (let i = 0; i < numCandles; i++) {
      const c = candleList[i];
      const cx = i * candleStepW + candleStepW / 2;
      const isUp = c.c >= c.o;
      const col = isUp ? "#22c55e" : "#ef4444";

      // Wick
      const yH = toY(c.h);
      const yL = toY(c.l);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(cx, yH);
      ctx.lineTo(cx, yL);
      ctx.stroke();

      // Body
      const yO = toY(c.o);
      const yC = toY(c.c);
      const bTop = Math.min(yO, yC);
      const bH = Math.max(1.5, Math.abs(yC - yO));
      ctx.fillStyle = col;
      ctx.fillRect(cx - candleBodyW / 2, bTop, candleBodyW, bH);

      // Volume bar
      const vTop = toVolY(c.v);
      ctx.fillStyle = isUp ? "rgba(34, 197, 94, 0.45)" : "rgba(239, 68, 68, 0.45)";
      ctx.fillRect(cx - candleBodyW / 2, vTop, candleBodyW, volY + VOL_H - vTop);
    }

    // ── Render User Drawings / Markups on the Chart (Only for regular Price Alerts, keep Formation Alerts clean) ──
    if (!alertOptions?.isFormation) {
      let userDrawings = [];
      if (typeof chartDrawings !== "undefined" && Array.isArray(chartDrawings) && (!sym || normSymCode(sym) === normSymCode(activeSym))) {
        userDrawings = chartDrawings;
      } else {
        try {
          const raw = localStorage.getItem("crypto_drawings_" + targetSym);
          if (raw) userDrawings = JSON.parse(raw);
        } catch (_) {}
      }

      if (Array.isArray(userDrawings) && userDrawings.length > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, TOP, PW, PH);
        ctx.clip();

        for (const d of userDrawings) {
          if (!d || d.type === "alert") continue;
          const x1 = getSnapX(d.t1), y1 = toY(d.p1);
          const x2 = getSnapX(d.t2), y2 = toY(d.p2);
          const col = d.color || "#facc15";
          ctx.strokeStyle = col;
          ctx.fillStyle = col;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([]);

          if (d.type === "line") {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          } else if (d.type === "ray") {
            const dx = x2 - x1, dy = y2 - y1;
            const mag = Math.sqrt(dx * dx + dy * dy);
            if (mag > 0.01) {
              const ex = x1 + (dx / mag) * W * 2;
              const ey = y1 + (dy / mag) * W * 2;
              ctx.beginPath();
              ctx.moveTo(x1, y1);
              ctx.lineTo(ex, ey);
              ctx.stroke();
            }
          } else if (d.type === "h-ray") {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(PW, y1);
            ctx.stroke();
          } else if (d.type === "rect") {
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);
            ctx.fillStyle = "rgba(251, 113, 133, 0.14)";
            ctx.fillRect(left, top, width, height);
            ctx.strokeRect(left, top, width, height);
          } else if (d.type === "brush" && Array.isArray(d.points) && d.points.length > 1) {
            ctx.beginPath();
            ctx.moveTo(getSnapX(d.points[0].t), toY(d.points[0].p));
            for (let pi = 1; pi < d.points.length; pi++) {
              ctx.lineTo(getSnapX(d.points[pi].t), toY(d.points[pi].p));
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    // ── Render Formation Highlight (Clean Thin Precise Lines) ──
    const alertBadgeYs = [];
    const lastCandleX = (numCandles - 1) * candleStepW + candleStepW / 2;

    if (alertOptions && alertOptions.isFormation) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, TOP, PW, PH);
      ctx.clip();

      const fType = alertOptions.formationType || "trendline";
      let realTrendlines = [];
      if (typeof FormationEngine !== "undefined" && typeof FormationEngine.detectTrendlines === "function") {
        try {
          realTrendlines = FormationEngine.detectTrendlines(candleList, 2);
        } catch (_) {}
      }

      let p1, p2, x1, x2, y1, y2, slope, touchPts = [];

      if (Array.isArray(realTrendlines) && realTrendlines.length > 0) {
        const bestTl = realTrendlines[0];
        p1 = bestTl.p1.price;
        p2 = bestTl.p2.price;
        x1 = bestTl.p1.idx * candleStepW + candleStepW / 2;
        x2 = bestTl.p2.idx * candleStepW + candleStepW / 2;
        y1 = toY(p1);
        y2 = toY(p2);
        slope = (y2 - y1) / Math.max(1, x2 - x1);
        const indices = bestTl.swingIndices || bestTl.touchIndices || [bestTl.p1.idx, bestTl.p2.idx];
        touchPts = indices.map(idx => ({
          x: idx * candleStepW + candleStepW / 2,
          y: toY(p1 + bestTl.slope * (idx - bestTl.p1.idx))
        }));
      } else {
        // Fallback: Accurate high swing tangent on last 70 candles
        const lookback = Math.min(70, numCandles);
        const startIdx = numCandles - lookback;
        let s1 = startIdx, s2 = numCandles - 15;
        let max1 = 0, max2 = 0;

        for (let i = startIdx; i < numCandles - 30; i++) {
          if (candleList[i].h > max1) { max1 = candleList[i].h; s1 = i; }
        }
        for (let i = s1 + 10; i < numCandles - 3; i++) {
          if (candleList[i].h > max2) { max2 = candleList[i].h; s2 = i; }
        }

        p1 = max1 || candleList[s1].h;
        p2 = max2 || candleList[s2].h;
        x1 = s1 * candleStepW + candleStepW / 2;
        x2 = s2 * candleStepW + candleStepW / 2;
        y1 = toY(p1);
        y2 = toY(p2);
        slope = (y2 - y1) / Math.max(1, x2 - x1);
        touchPts = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
      }

      // Draw Thin, Crisp Formation Trendline (No harsh glow!)
      const lineEndX = lastCandleX + candleStepW * 3;
      const lineEndY = y1 + slope * (lineEndX - x1);

      ctx.strokeStyle = "#eab308";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(lineEndX, lineEndY);
      ctx.stroke();

      // Subtle touch dots (small 2.5px radius)
      touchPts.forEach(pt => {
        ctx.fillStyle = "#eab308";
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        ctx.stroke();
      });

      ctx.restore();
    } else if (targetLevel > 0) {
      // ── Standard Price Alert Marker ──
      const alertY = toY(targetLevel);
      alertBadgeYs.push(alertY);

      // Dotted Alert Line across the chart
      ctx.save();
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, alertY);
      ctx.lineTo(PW, alertY);
      ctx.stroke();
      ctx.restore();

      // Glowing trigger marker on the triggering (latest) candle
      ctx.save();
      ctx.fillStyle = "#f59e0b";
      ctx.beginPath();
      ctx.arc(lastCandleX, alertY, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      // Stylized Target Badge on Right Price Scale
      const bH = 22;
      const bW = PR - 8;
      const bX = PW + 4;
      const bY = alertY - bH / 2;

      ctx.save();
      if (typeof roundRect === "function") roundRect(ctx, bX, bY, bW, bH, 5);
      else ctx.fillRect(bX, bY, bW, bH);
      ctx.fillStyle = "#221603";
      ctx.fill();
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 11px Inter, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const alertStr = typeof fP === "function" ? fP(targetLevel) : targetLevel.toFixed(4);
      ctx.fillText(`🎯 ${alertStr}`, bX + bW / 2, alertY);
      ctx.restore();
    }

    // ── Live / Last Candle Price Badge ──
    if (lastCandle) {
      const lastClose = lastCandle.c;
      const liveY = toY(lastClose);
      alertBadgeYs.push(liveY);

      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, liveY);
      ctx.lineTo(PW, liveY);
      ctx.stroke();
      ctx.restore();

      const bH = 22;
      const bW = PR - 8;
      const bX = PW + 4;
      const bY = liveY - bH / 2;
      const isUp = lastClose >= lastCandle.o;

      ctx.save();
      if (typeof roundRect === "function") roundRect(ctx, bX, bY, bW, bH, 5);
      else ctx.fillRect(bX, bY, bW, bH);
      ctx.fillStyle = "#131722";
      ctx.fill();
      ctx.strokeStyle = isUp ? "#22c55e" : "#ef4444";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px Inter, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(typeof fP === "function" ? fP(lastClose) : lastClose.toFixed(4), bX + bW / 2, liveY);
      ctx.restore();
    }

    // ── Price Scale Labels (Right) ──
    gp = Math.ceil(minP / gridStep) * gridStep;
    ctx.font = "10.5px Inter, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    while (gp <= maxP) {
      const y = toY(gp);
      if (y >= TOP + 12 && y <= TOP + PH - 12) {
        const collides = alertBadgeYs.some(by => Math.abs(by - y) < 16);
        if (!collides) {
          ctx.fillStyle = "rgba(255, 255, 255, 0.45)";
          ctx.fillText(typeof fP === "function" ? fP(gp) : gp.toFixed(4), PW + 8, y);
        }
      }
      gp += gridStep;
    }

    // ── Time Axis (Bottom) ──
    const timeY = H - BTM_TIME / 2;
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "10.5px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const timeStep = Math.floor(numCandles / 7);
    for (let i = Math.floor(timeStep / 2); i < numCandles; i += timeStep) {
      const c = candleList[i];
      if (c && c.t) {
        const d = new Date(c.t);
        const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        const dateStr = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
        const label = targetTf.includes("d") ? dateStr : `${dateStr} ${timeStr}`;
        const tx = i * candleStepW + candleStepW / 2;
        if (tx > 40 && tx < PW - 40) {
          ctx.fillText(label, tx, timeY);
        }
      }
    }

    // Convert to Lossless High-Resolution PNG for absolute razor sharpness (no JPEG compression blur)
    const result = shot.toDataURL("image/png");
    console.log(`[CHART SNAPSHOT ULTRA-HD 4K] Generated OK for ${targetSym} ${targetTf}, size=${result ? result.length : 0}`);
    return result;
  } catch (err) {
    console.error("[OFFSCREEN SNAPSHOT ERROR]", err);
    return null;
  }
}

function sendTelegramAlert(message, photoDataUrl = null) {
  const activeUser = window.currentUser;
  const chatId = activeUser?.telegramChatId || activeUser?.telegramId || localStorage.getItem("obsidian_tg_chat_id");
  const headers = { "Content-Type": "application/json" };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const hasPhoto = photoDataUrl && typeof photoDataUrl === "string" && photoDataUrl.startsWith("data:image");
  console.log(`[ALERT TG] hasPhoto=${!!hasPhoto}, photoLen=${photoDataUrl ? photoDataUrl.length : 0}, chatId=${chatId}`);

  const endpoint = hasPhoto ? "/api/notifications/telegram-photo" : "/api/notifications/telegram";
  const body = hasPhoto
    ? { chatId: chatId || undefined, caption: message, photoDataUrl }
    : { chatId: chatId || undefined, message };

  fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }).then(async r => {
    const d = await r.json();
    console.log(`[ALERT TG] Response status=${r.status}`, d);
    if (!r.ok || !d.success) {
      console.warn("Telegram alert dispatch result:", d);
    }
  }).catch(err => {
    console.error("Telegram alert dispatch error:", err);
  });
}

async function checkPriceAlerts(ex, sym, price, high = price, low = price) {
  if (!price || price <= 0) return;
  const targetSym = normSymCode(sym);
  const targetEx = normExCode(ex);
  
  const hVal = high > 0 ? high : price;
  const lVal = low > 0 ? low : price;

  if (typeof chartDrawings !== "undefined" && Array.isArray(chartDrawings) && chartDrawings.length > 0) {
    const isCurrentChart = (!sym || normSymCode(sym) === normSymCode(activeSym)) && (!ex || normExCode(ex) === normExCode(activeEx));
    if (isCurrentChart) {
      for (let i = chartDrawings.length - 1; i >= 0; i--) {
        const d = chartDrawings[i];
        if (!d || d.type !== "alert" || d.triggered) continue;

        const alertPrice = d.p1;
        if (!alertPrice || alertPrice <= 0) continue;

        let isHit = false;
        if (hVal >= alertPrice && lVal <= alertPrice) isHit = true;
        else if (Math.abs(price - alertPrice) / alertPrice <= 0.001) isHit = true;
        else if (d.createdP && d.createdP < alertPrice && hVal >= alertPrice) isHit = true;
        else if (d.createdP && d.createdP > alertPrice && lVal <= alertPrice) isHit = true;

        if (isHit) {
          d.triggered = true;

          let photoDataUrl = null;
          try {
            photoDataUrl = await captureChartSnapshot(sym || activeSym, price, alertPrice, d.tf || activeTf || "5m", ex || activeEx || "BN");
          } catch (_) {}

          chartDrawings.splice(i, 1);
          if (typeof saveDrawings === "function") saveDrawings();
          if (typeof drawChart === "function") requestAnimationFrame(drawChart);

          const displayExFull = getFullExchangeName(ex || activeEx || "BN");
          const displaySym = (sym || activeSym || "BTCUSDT").toUpperCase();
          const formattedTarget = typeof fP === "function" ? fP(alertPrice) : alertPrice.toLocaleString();
          const now = new Date();
          const timeStr = now.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          const dateStr = `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}`;

          const title = `🔔 Достигнут уровень цены!`;
          const body = `<b>${displayExFull} · ${displaySym}</b> достиг уровня <b>$${formattedTarget}</b>`;

          const telegramMsg =
            `─────── <b>${displaySym}</b> ───────\n` +
            `• <b>Биржа:</b> ${displayExFull}\n` +
            `• <b>Ценовой уровень:</b> $${formattedTarget}\n` +
            `• <b>Время:</b> ${dateStr} ${timeStr}\n` +
            `─────────────────────────\n` +
            `🎯 <b>Obsidian Price Alert</b>`;

          try { playAlertSound("chime"); } catch (_) {}
          try { showToast({ title, message: body, type: "price_alert" }); } catch (_) {}
          try { sendTelegramAlert(telegramMsg, photoDataUrl); } catch (_) {}
        }
      }
    }
  }

  if (!priceAlerts || !priceAlerts.length) return;

  for (let i = 0; i < priceAlerts.length; i++) {
    const alert = priceAlerts[i];
    if (!alert || alert.triggered) continue;
    
    const alertSym = normSymCode(alert.sym);
    const alertEx = normExCode(alert.ex);
    
    if (alertSym !== targetSym && !targetSym.includes(alertSym) && !alertSym.includes(targetSym)) continue;
    if (alertEx && targetEx && alertEx !== targetEx) continue;
    
    let isHit = false;

    if (alert.dir === "gte" && hVal >= alert.price) isHit = true;
    if (alert.dir === "lte" && lVal <= alert.price) isHit = true;

    if (!isHit && alert.createdPrice && alert.createdPrice > 0) {
      if (alert.createdPrice < alert.price && hVal >= alert.price) isHit = true;
      if (alert.createdPrice > alert.price && lVal <= alert.price) isHit = true;
    }

    if (!isHit) {
      const relDiff = Math.min(Math.abs(price - alert.price), Math.abs(hVal - alert.price), Math.abs(lVal - alert.price)) / alert.price;
      if (relDiff <= 0.001) isHit = true;
    }
    
    if (isHit) {
      alert.triggered = true;

      let photoDataUrl = null;
      try {
        photoDataUrl = await captureChartSnapshot(alert.sym || sym || activeSym, price, alert.price, alert.tf || activeTf || "5m", alert.ex || targetEx || "BN");
      } catch (_) {}
      
      if (typeof chartDrawings !== "undefined" && Array.isArray(chartDrawings)) {
        const initialLen = chartDrawings.length;
        chartDrawings = chartDrawings.filter(d => {
          if (d.type === "alert") {
            if (alert.drawingId && d.t1 === alert.drawingId) return false;
            if (Math.abs(d.p1 - alert.price) / (alert.price || 1) < 0.0008) return false;
          }
          return true;
        });
        if (chartDrawings.length !== initialLen && typeof saveDrawings === "function") {
          saveDrawings();
        }
      }

      try {
        const drawKey = "crypto_drawings_" + alert.sym;
        const rawDraw = localStorage.getItem(drawKey);
        if (rawDraw) {
          let arr = JSON.parse(rawDraw);
          arr = arr.filter(d => {
            if (d.type === "alert") {
              if (alert.drawingId && d.t1 === alert.drawingId) return false;
              if (Math.abs(d.p1 - alert.price) / (alert.price || 1) < 0.0008) return false;
            }
            return true;
          });
          localStorage.setItem(drawKey, JSON.stringify(arr));
        }
      } catch (_) {}

      if (typeof drawChart === "function") requestAnimationFrame(drawChart);
      if (typeof chartInstances !== "undefined" && Array.isArray(chartInstances)) {
        chartInstances.forEach(inst => { if (inst && inst.draw) inst.draw(true); });
      }

      const alertExNameFull = getFullExchangeName(alert.ex || targetEx || "BN");
      const alertSymName = (alert.sym || targetSym || "BTCUSDT").toUpperCase();
      const formattedTarget = typeof fP === "function" ? fP(alert.price) : alert.price.toLocaleString();
      const now = new Date();
      const timeStr = now.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const dateStr = `${String(now.getDate()).padStart(2,"0")}.${String(now.getMonth()+1).padStart(2,"0")}`;

      const title = `🔔 Достигнут уровень цены!`;
      const body = `<b>${alertExNameFull} · ${alertSymName}</b> достиг уровня <b>$${formattedTarget}</b>`;
      
      const telegramMsg =
        `─────── <b>${alertSymName}</b> ───────\n` +
        `• <b>Биржа:</b> ${alertExNameFull}\n` +
        `• <b>Ценовой уровень:</b> ${alert.dir === 'gte' ? '≥' : '≤'} $${formattedTarget}\n` +
        `• <b>Время:</b> ${dateStr} ${timeStr}\n` +
        `─────────────────────────\n` +
        `🎯 <b>Obsidian Price Alert</b>`;

      try { playAlertSound("chime"); } catch (_) {}
      try { showToast({ title, message: body, type: "price_alert" }); } catch (_) {}
      try { sendTelegramAlert(telegramMsg, photoDataUrl); } catch (_) {}
      
      savePriceAlerts();
    }
  }
};

// ── NOTIFICATIONS & PRICE ALERTS ENGINE ──
let priceAlerts = [];
let audioCtx = null;

function unlockAudioContext() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {}
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
}
window.addEventListener("pointerdown", unlockAudioContext, { passive: true });
window.addEventListener("keydown", unlockAudioContext, { passive: true });

function renderPriceAlertsList() {
  // UI grid was removed; this is intentionally a no-op.
}

function loadPriceAlerts() {
  try {
    const raw = localStorage.getItem("obsidian_price_alerts");
    priceAlerts = raw ? JSON.parse(raw) : [];
    // Filter out old triggered alerts on load
    priceAlerts = priceAlerts.filter(a => !a.triggered);
  } catch (_) { priceAlerts = []; }
}

function savePriceAlerts() {
  try {
    // Save only active alerts
    const active = priceAlerts.filter(a => !a.triggered);
    localStorage.setItem("obsidian_price_alerts", JSON.stringify(active));
  } catch (_) {}
}

function playAlertSound(kind = "chime") {
  try {
    unlockAudioContext();
    if (!audioCtx) return;
    
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.type = "sine";
    if (kind === "chime") {
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.15);
    } else {
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.setValueAtTime(800, now + 0.1);
    }
    
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.start(now);
    osc.stop(now + 0.5);
  } catch (_) {}
}



function getFullExchangeName(ex) {
  if (!ex) return "BINANCE";
  const s = String(ex).toUpperCase().trim();
  if (s === "BN" || s === "BINANCE" || s === "BNF" || s === "BNS") return "BINANCE";
  if (s === "BB" || s === "BYBIT" || s === "BBF" || s === "BBS") return "BYBIT";
  if (s === "OK" || s === "OX" || s === "OKX") return "OKX";
  if (s === "MX" || s === "MEXC") return "MEXC";
  if (s === "GT" || s === "GATE" || s === "GATEIO") return "GATE";
  if (s === "BG" || s === "BITGET") return "BITGET";
  if (s === "BX" || s === "BINGX") return "BINGX";
  if (s === "KC" || s === "KUCOIN") return "KUCOIN";
  if (s === "HT" || s === "HTX" || s === "HUOBI") return "HTX";
  if (s === "HL" || s === "HYPERLIQUID") return "HYPERLIQUID";
  if (s === "AD" || s === "ASTERDEX") return "ASTERDEX";
  return s;
}

function normExCode(e) {
  if (!e) return "";
  const s = String(e).toUpperCase().trim();
  if (s === "BINANCE" || s === "BN") return "BN";
  if (s === "BYBIT" || s === "BB") return "BB";
  if (s === "OKX" || s === "OK" || s === "OX") return "OK";
  if (s === "MEXC" || s === "MX") return "MX";
  if (s === "GATE" || s === "GATE.IO" || s === "GT") return "GT";
  if (s === "BITGET" || s === "BG") return "BG";
  if (s === "BINGX" || s === "BX") return "BX";
  if (s === "KUCOIN" || s === "KC") return "KC";
  if (s === "HTX" || s === "HUOBI" || s === "HT") return "HT";
  if (s === "HYPERLIQUID" || s === "HL") return "HL";
  if (s === "ASTERDEX" || s === "AD") return "AD";
  return s;
}

function normSymCode(s) {
  if (!s) return "";
  let str = String(s).toUpperCase().trim();
  str = str.replace(/\.F$|\.S$/i, "");
  str = str.replace(/[-_/.]/g, "");
  str = str.replace(/USDT$|PERP$/i, "");
  return str;
}

// Keep subscription actions out of inline HTML handlers. Besides being easier
// to maintain, this keeps the upgrade flow working under a strict CSP.
function bindProAccessControls() {
  const profileUpgradeButton = $("profile-upgrade-btn");
  const proModalBuyButton = $("pro-modal-buy-btn");
  const proModalDetailsBtn = $("pro-modal-details-btn");
  const proCompareBuyBtn = $("pro-compare-buy-btn");
  const proCompareBackBtn = $("pro-compare-back-btn");
  const proModal = $("proModal");
  const proCompareModal = $("proCompareModal");
  const bugReportModal = $("bugReportModal");

  if (bugReportModal && !bugReportModal.dataset.bound) {
    bugReportModal.dataset.bound = "true";
    bugReportModal.addEventListener("click", (event) => {
      if (event.target === bugReportModal) closeBugReportModal();
    });
  }

  if (profileUpgradeButton && !profileUpgradeButton.dataset.bound) {
    profileUpgradeButton.dataset.bound = "true";
    profileUpgradeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeProfileModal();
      openPayModal();
    });
  }

  if (proModalBuyButton && !proModalBuyButton.dataset.bound) {
    proModalBuyButton.dataset.bound = "true";
    proModalBuyButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPayModal();
    });
  }

  if (proModalDetailsBtn && !proModalDetailsBtn.dataset.bound) {
    proModalDetailsBtn.dataset.bound = "true";
    proModalDetailsBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openProCompareModal();
    });
  }

  if (proCompareBuyBtn && !proCompareBuyBtn.dataset.bound) {
    proCompareBuyBtn.dataset.bound = "true";
    proCompareBuyBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPayModal();
    });
  }

  if (proCompareBackBtn && !proCompareBackBtn.dataset.bound) {
    proCompareBackBtn.dataset.bound = "true";
    proCompareBackBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      backToProModal();
    });
  }

  if (proModal && !proModal.dataset.bound) {
    proModal.dataset.bound = "true";
    proModal.addEventListener("click", (event) => {
      if (event.target === proModal) closeProModal();
    });
  }

  if (proCompareModal && !proCompareModal.dataset.bound) {
    proCompareModal.dataset.bound = "true";
    proCompareModal.addEventListener("click", (event) => {
      if (event.target === proCompareModal) closeProCompareModal();
    });
  }
}

// One gate for every PRO-only entry point. Capture phase guarantees that a
// FREE click cannot fall through to a feature-specific handler and fail silently.
function bindProFeatureGate() {
  if (document.documentElement.dataset.proFeatureGateBound) return;
  document.documentElement.dataset.proFeatureGateBound = "true";

  document.querySelectorAll("[data-pro-feature]").forEach((proTarget) => {
    proTarget.dataset.proGateBound = "true";
    proTarget.addEventListener("click", (event) => {
      const isPro = window.currentUser && window.currentUser.plan === "pro";
      if (isPro) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      openProModal(proTarget.dataset.proFeature || "Эта функция");
    }, true);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const payModal = $("obsidian-pay-modal");
    const proModal = $("proModal");
    const proCompareModal = $("proCompareModal");
    if (payModal && payModal.style.display !== "none") closePayModal();
    else if (proCompareModal && proCompareModal.style.display !== "none") closeProCompareModal();
    else if (proModal && proModal.style.display !== "none") closeProModal();
  });
}

function selectPayTariff(planId) {
  paySelectedPlan = planId;
  document.querySelectorAll(".pay-tariff-card").forEach(el => {
    if (el.dataset.plan === planId) el.classList.add("selected");
    else el.classList.remove("selected");
  });
}

function selectPayMethod(method) {
  paySelectedMethod = method;
  const methods = ["trc20", "cb"];
  methods.forEach(m => {
    const btn = $(`pay-method-${m}`);
    if (btn) {
      if (m === method || (m === "cb" && method === "cryptobot")) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    }
  });
}

function backToTariffs() {
  const step1 = $("pay-step-tariffs");
  const step2 = $("pay-step-invoice");
  if (step1 && step2) {
    step1.style.display = "block";
    step2.style.display = "none";
  }
  if (payPollTimer) clearInterval(payPollTimer);
  if (payCountdownTimer) clearInterval(payCountdownTimer);
}

async function startPayInvoice(replaceActive = false) {
  const token = localStorage.getItem("obsidian_auth_token");
  if (!token) {
    if (typeof openAuthModal === "function") openAuthModal();
    return;
  }

  const btn = $("pay-continue-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Создание счёта...";
  }

  try {
    const res = await fetch("/api/pay/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ planId: paySelectedPlan, method: paySelectedMethod, replaceActive })
    });
    const data = await res.json();

    if (!data.ok || !data.invoice) {
      if (data.code === "ACTIVE_INVOICE_EXISTS" && !replaceActive) {
        const confirmed = window.confirm(
          "У вас уже есть неоплаченный счёт. Отменить его и создать новый выбранным способом?\n\nНе подтверждайте отмену, если вы уже отправили оплату по предыдущему счёту."
        );
        if (confirmed) return await startPayInvoice(true);
        return;
      }
      alert("Ошибка создания счёта: " + (data.error || "Неизвестная ошибка"));
      return;
    }

    currentPayInvoice = data.invoice;
    renderPayInvoiceStep(currentPayInvoice);
  } catch (err) {
    alert("Ошибка соединения при создании счёта");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Продолжить к оплате →";
    }
  }
}

function renderPayInvoiceStep(inv) {
  const step1 = $("pay-step-tariffs");
  const step2 = $("pay-step-invoice");
  if (step1 && step2) {
    step1.style.display = "none";
    step2.style.display = "block";
  }

  const amountDisplay = $("pay-display-amount");
  const addressDisplay = $("pay-display-address");
  const statusText = $("pay-status-text");
  const cbBtnBox = $("pay-bot-btn-container");
  const cbLink = $("pay-cryptobot-link");
  const addressBox = $("pay-address-box");
  const addressLabel = $("pay-address-label");

  if (amountDisplay) amountDisplay.textContent = `$${inv.amountStr} USDT`;
  if (addressDisplay) addressDisplay.textContent = inv.address || "";

  const netTitles = {
    trc20: "TRON (USDT TRC-20)",
    cryptobot: "Telegram CryptoBot"
  };

  if (inv.method === "cryptobot" && inv.payUrl) {
    if (cbBtnBox) cbBtnBox.style.display = "block";
    if (cbLink) cbLink.href = inv.payUrl;
    if (addressBox) addressBox.style.display = "none";
    if (statusText) statusText.textContent = "Ожидание оплаты в Telegram CryptoBot...";
  } else {
    if (cbBtnBox) cbBtnBox.style.display = "none";
    if (addressBox) addressBox.style.display = "block";
    if (addressLabel) addressLabel.textContent = `Адрес кошелька ${netTitles[inv.method] || ""}:`;
    if (statusText) statusText.textContent = `Проверяем зачисление в блокчейне ${netTitles[inv.method] || "крипто-сети"}...`;
  }

  startPayCountdown(inv.expiresAt);

  if (payPollTimer) clearInterval(payPollTimer);
  payPollTimer = setInterval(() => checkCurrentInvoiceStatus(inv.id), 3000);
}

function startPayCountdown(expiresAtMs) {
  if (payCountdownTimer) clearInterval(payCountdownTimer);
  const timerDisplay = $("pay-countdown-timer");

  const update = () => {
    const remaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    if (timerDisplay) {
      timerDisplay.textContent = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
    }
    if (remaining <= 0) {
      clearInterval(payCountdownTimer);
      if (payPollTimer) clearInterval(payPollTimer);
      const statusText = $("pay-status-text");
      if (statusText) statusText.textContent = "❌ Время ожидания счёта истекло. Пожалуйста, создайте новый счёт.";
    }
  };

  update();
  payCountdownTimer = setInterval(update, 1000);
}

async function checkCurrentInvoiceStatus(invoiceId) {
  try {
    const token = localStorage.getItem("obsidian_auth_token");
    if (!token) return;
    const res = await fetch(`/api/pay/status/${encodeURIComponent(invoiceId)}`, {
      cache: "no-store",
      headers: { "Authorization": `Bearer ${token}` }
    });
    const data = await res.json();

    if (data.status === "success") {
      if (payPollTimer) clearInterval(payPollTimer);
      if (payCountdownTimer) clearInterval(payCountdownTimer);

      const statusBanner = $("pay-status-banner");
      if (statusBanner) {
        statusBanner.style.background = "rgba(38, 201, 122, 0.15)";
        statusBanner.style.borderColor = "#26c97a";
        statusBanner.innerHTML = `<span style="font-size: 15px; font-weight: 700; color: #26c97a;">✅ Оплата успешно получена! Подписка PRO активирована.</span>`;
      }

      const token = localStorage.getItem("obsidian_auth_token");
      if (token && typeof checkCurrentAuthSession === "function") {
        checkCurrentAuthSession();
      }

      setTimeout(() => {
        closePayModal();
        alert("🎉 Поздравляем! Ваша подписка Obsidian PRO успешно активирована!");
      }, 2500);
    }
  } catch (e) {}
}

function copyPayField(elementId) {
  const el = $(elementId);
  if (el) {
    const textToCopy = el.textContent.trim().replace(/^\$/, "").replace(/\s*USDT$/i, "");
    navigator.clipboard.writeText(textToCopy).then(() => {
      alert("Скопировано: " + textToCopy);
    }).catch(() => {
      const input = document.createElement("input");
      input.value = textToCopy;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      alert("Скопировано: " + textToCopy);
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FORMATION ALERTS & NOTIFICATIONS CONTROLLER
// ══════════════════════════════════════════════════════════════════════════
const DEFAULT_FORMATION_ALERT_SETTINGS = {
  soundEnabled: true,
  toastEnabled: true,
  tgEnabled: true,
  cooldownSeconds: 300,
  minVolume: 0,
  exchanges: ["all", "BN", "BB", "OX", "BG", "GT", "MX", "HL", "BX", "KC", "HT"],
  blacklist: ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"],
  blacklistCustom: "",
  trendline: {
    enabled: true,
    timeframes: ["5m", "15m", "1h"],
    minTouches: 3,
    distancePct: 0.3,
    direction: "all" // "all" | "down" (support/long) | "up" (resistance/short)
  },
  level: {
    enabled: true,
    timeframes: ["5m", "15m", "1h"],
    minTouches: 3,
    distancePct: 0.3,
    direction: "all" // "all" | "support" | "resistance"
  },
  retest: {
    enabled: true,
    timeframes: ["5m", "15m", "1h"],
    direction: "all", // "all" | "up" | "down"
    stage: "confirmed", // "confirmed" | "approaching" | "both"
    maxAgeCandles: 20
  }
};

let currentFormationAlertSettings = { ...DEFAULT_FORMATION_ALERT_SETTINGS };

function loadFormationAlertSettings() {
  try {
    const raw = localStorage.getItem("obsidian_formation_alert_settings");
    if (raw) {
      const parsed = JSON.parse(raw);
      currentFormationAlertSettings = {
        ...DEFAULT_FORMATION_ALERT_SETTINGS,
        ...parsed,
        exchanges: Array.isArray(parsed.exchanges) && parsed.exchanges.length > 0 ? parsed.exchanges : [...DEFAULT_FORMATION_ALERT_SETTINGS.exchanges],
        blacklist: Array.isArray(parsed.blacklist) ? parsed.blacklist : [...DEFAULT_FORMATION_ALERT_SETTINGS.blacklist],
        blacklistCustom: typeof parsed.blacklistCustom === "string" ? parsed.blacklistCustom : "",
        trendline: { ...DEFAULT_FORMATION_ALERT_SETTINGS.trendline, ...(parsed.trendline || {}) },
        level: { ...DEFAULT_FORMATION_ALERT_SETTINGS.level, ...(parsed.level || {}) },
        retest: { ...DEFAULT_FORMATION_ALERT_SETTINGS.retest, ...(parsed.retest || {}) }
      };
    }
  } catch (_) {
    currentFormationAlertSettings = JSON.parse(JSON.stringify(DEFAULT_FORMATION_ALERT_SETTINGS));
  }
  window.formationAlertSettings = currentFormationAlertSettings;
  return currentFormationAlertSettings;
}

function saveFormationAlertSettings(settings) {
  currentFormationAlertSettings = settings || currentFormationAlertSettings;
  localStorage.setItem("obsidian_formation_alert_settings", JSON.stringify(currentFormationAlertSettings));
  window.formationAlertSettings = currentFormationAlertSettings;
  syncFormationAlertSettingsToServer(currentFormationAlertSettings);
}

async function syncFormationAlertSettingsToServer(settings) {
  try {
    const token = localStorage.getItem("obsidian_auth_token");
    if (!token) return;
    await fetch("/api/user/formation-alerts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(settings)
    });
  } catch (_) {}
}

function initNotificationsUI() {
  loadPriceAlerts();
  loadFormationAlertSettings();

  // Helper: setup single-select button groups
  function setupButtonGroup(containerId, activeVal, onSelect) {
    const container = $(containerId);
    if (!container) return;
    const buttons = container.querySelectorAll("button.fmt-btn[data-val]");
    buttons.forEach(btn => {
      const val = btn.dataset.val;
      btn.classList.toggle("active", String(val) === String(activeVal));
      btn.onclick = () => {
        buttons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        onSelect(val);
      };
    });
  }

  // Helper: setup multi-select timeframe button groups
  function setupTfGroup(containerId, activeTfs, onToggle) {
    const container = $(containerId);
    if (!container) return;
    const buttons = container.querySelectorAll("button.fmt-btn[data-tf]");
    buttons.forEach(btn => {
      const tf = btn.dataset.tf;
      btn.classList.toggle("active", (activeTfs || []).includes(tf));
      btn.onclick = () => {
        btn.classList.toggle("active");
        const currentSelected = Array.from(container.querySelectorAll("button.fmt-btn.active[data-tf]")).map(b => b.dataset.tf);
        if (currentSelected.length === 0) {
          btn.classList.add("active"); // Ensure at least 1 tf is selected
          return;
        }
        onToggle(currentSelected);
      };
    });
  }

  // Helper: setup multi-select exchange button groups
  const ALL_EXCHANGES_LIST = ["BN", "BB", "OX", "BG", "GT", "MX", "HL", "BX", "KC", "HT"];

  function setupExchangeGroup(containerId, activeExs, onToggle) {
    const container = $(containerId);
    if (!container) return;
    let selected = Array.isArray(activeExs) && activeExs.length > 0 ? [...activeExs] : ["all", ...ALL_EXCHANGES_LIST];
    if (selected.includes("all") && selected.length === 1) {
      selected = ["all", ...ALL_EXCHANGES_LIST];
    }

    const buttons = container.querySelectorAll("button.fmt-btn[data-ex]");
    
    function refreshUI() {
      const isAll = selected.includes("all") || ALL_EXCHANGES_LIST.every(e => selected.includes(e));
      buttons.forEach(btn => {
        const ex = btn.dataset.ex;
        if (ex === "all") {
          btn.classList.toggle("active", isAll);
        } else {
          btn.classList.toggle("active", isAll || selected.includes(ex));
        }
      });
    }

    buttons.forEach(btn => {
      const ex = btn.dataset.ex;
      btn.onclick = () => {
        if (ex === "all") {
          const wasAll = selected.includes("all") || ALL_EXCHANGES_LIST.every(e => selected.includes(e));
          if (wasAll) {
            selected = ["BN"]; // Keep at least 1
          } else {
            selected = ["all", ...ALL_EXCHANGES_LIST];
          }
        } else {
          if (selected.includes("all")) {
            selected = [...ALL_EXCHANGES_LIST];
          }
          if (selected.includes(ex)) {
            selected = selected.filter(e => e !== ex && e !== "all");
            if (selected.length === 0) {
              selected = [ex];
            }
          } else {
            selected.push(ex);
            if (ALL_EXCHANGES_LIST.every(e => selected.includes(e))) {
              selected = ["all", ...ALL_EXCHANGES_LIST];
            }
          }
        }
        refreshUI();
        onToggle(selected);
      };
    });

    refreshUI();
  }

  // Helper: setup distance selector with custom input support
  function setupDistanceGroup(containerId, customInputId, customBtnId, activeDist, onSelect) {
    const container = $(containerId);
    const customInput = $(customInputId);
    const customBtn = $(customBtnId);
    if (!container) return;

    const buttons = container.querySelectorAll("button.fmt-btn[data-val]");
    let isStandard = false;

    buttons.forEach(btn => {
      const val = btn.dataset.val;
      if (val !== "custom" && parseFloat(val) === parseFloat(activeDist)) {
        btn.classList.add("active");
        isStandard = true;
      } else {
        btn.classList.remove("active");
      }

      btn.onclick = () => {
        if (val === "custom") {
          buttons.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          if (customInput) {
            customInput.style.display = "inline-block";
            customInput.focus();
            if (customInput.value) onSelect(parseFloat(customInput.value) || 0.3);
          }
        } else {
          buttons.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          if (customInput) customInput.style.display = "none";
          onSelect(parseFloat(val));
        }
      };
    });

    if (!isStandard && customBtn && customInput) {
      customBtn.classList.add("active");
      customInput.style.display = "inline-block";
      customInput.value = activeDist;
    }

    if (customInput) {
      customInput.oninput = () => {
        const parsed = parseFloat(customInput.value);
        if (!isNaN(parsed) && parsed > 0) onSelect(parsed);
      };
    }
  }

  // Helper: setup blacklist quick pills and custom input
  function setupBlacklistGroup(containerId, inputId, activeBl, customVal, onChange) {
    const container = $(containerId);
    const customInput = $(inputId);
    if (!container) return;

    let selected = Array.isArray(activeBl) ? [...activeBl] : ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];

    const buttons = container.querySelectorAll("button.fmt-btn[data-bl]");
    buttons.forEach(btn => {
      const coin = btn.dataset.bl;
      btn.classList.toggle("active", selected.includes(coin));
      btn.onclick = () => {
        if (selected.includes(coin)) {
          selected = selected.filter(c => c !== coin);
        } else {
          selected.push(coin);
        }
        btn.classList.toggle("active", selected.includes(coin));
        onChange(selected, customInput ? customInput.value : "");
      };
    });

    if (customInput) {
      customInput.value = customVal || "";
      const updateCustom = () => {
        onChange(selected, customInput.value);
      };
      customInput.oninput = updateCustom;
      customInput.onchange = updateCustom;
      customInput.onblur = updateCustom;
    }
  }

  function openFormationAlertsModal() {
    const isPro = window.currentUser && window.currentUser.plan === "pro";
    if (!isPro) {
      if (typeof openProModal === "function") {
        openProModal("Детектор и алерты формаций");
      }
      return;
    }
    loadFormationAlertSettings();
    syncFormationUI();
    const overlay = $("modal-formation-alerts-overlay");
    if (overlay) overlay.style.display = "flex";
  }

  function closeFormationAlertsModal() {
    const overlay = $("modal-formation-alerts-overlay");
    if (overlay) overlay.style.display = "none";
  }

  window.openFormationAlertsModal = openFormationAlertsModal;
  window.closeFormationAlertsModal = closeFormationAlertsModal;

  // Open modal triggers
  $("btn-open-formation-alerts")?.addEventListener("click", openFormationAlertsModal);
  $("btn-open-fmt-from-settings")?.addEventListener("click", () => {
    if (typeof closeSettingsModal === "function") closeSettingsModal();
    openFormationAlertsModal();
  });

  // Close modal triggers
  $("fmt-modal-close")?.addEventListener("click", closeFormationAlertsModal);
  $("modal-formation-alerts-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-formation-alerts-overlay") closeFormationAlertsModal();
  });

  function syncFormationUI() {
    const s = currentFormationAlertSettings;

    // 1. General Alert Settings
    const setSound = $("set-sound-enabled");
    const setToast = $("set-toast-enabled");
    const setTgModal = $("fmt-modal-tg-enabled");
    const setSoundModal = $("fmt-modal-sound-enabled");
    const setToastModal = $("fmt-modal-toast-enabled");

    if (setSound) setSound.checked = !!s.soundEnabled;
    if (setToast) setToast.checked = !!s.toastEnabled;
    if (setTgModal) setTgModal.checked = !!s.tgEnabled;
    if (setSoundModal) setSoundModal.checked = !!s.soundEnabled;
    if (setToastModal) setToastModal.checked = !!s.toastEnabled;

    if (setSound) setSound.onchange = () => { s.soundEnabled = setSound.checked; if (setSoundModal) setSoundModal.checked = setSound.checked; };
    if (setToast) setToast.onchange = () => { s.toastEnabled = setToast.checked; if (setToastModal) setToastModal.checked = setToast.checked; };
    if (setTgModal) setTgModal.onchange = () => { s.tgEnabled = setTgModal.checked; };
    if (setSoundModal) setSoundModal.onchange = () => { s.soundEnabled = setSoundModal.checked; if (setSound) setSound.checked = setSoundModal.checked; };
    if (setToastModal) setToastModal.onchange = () => { s.toastEnabled = setToastModal.checked; if (setToast) setToast.checked = setToastModal.checked; };

    setupButtonGroup("fmt-cooldown-group", s.cooldownSeconds, val => { s.cooldownSeconds = parseInt(val, 10); });
    setupButtonGroup("fmt-minvol-group", s.minVolume, val => { s.minVolume = parseFloat(val); });
    setupExchangeGroup("fmt-exchanges-group", s.exchanges, exs => { s.exchanges = exs; });
    setupBlacklistGroup("fmt-blacklist-pills", "fmt-blacklist-custom", s.blacklist, s.blacklistCustom, (bl, custom) => {
      s.blacklist = bl;
      s.blacklistCustom = custom;
    });

    // 2. Trendline (Наклонка)
    const setTl = $("set-fmt-trendline-enabled");
    const cardTl = $("fmt-card-trendline");
    const bodyTl = $("fmt-trendline-body");
    if (setTl) {
      setTl.checked = !!s.trendline.enabled;
      if (cardTl) cardTl.classList.toggle("active", setTl.checked);
      if (bodyTl) bodyTl.style.opacity = setTl.checked ? "1" : "0.45";
      setTl.onchange = () => {
        s.trendline.enabled = setTl.checked;
        if (cardTl) cardTl.classList.toggle("active", setTl.checked);
        if (bodyTl) bodyTl.style.opacity = setTl.checked ? "1" : "0.45";
      };
    }
    setupTfGroup("fmt-trendline-tf-group", s.trendline.timeframes, tfs => { s.trendline.timeframes = tfs; });
    setupButtonGroup("fmt-trendline-touches-group", s.trendline.minTouches, val => { s.trendline.minTouches = parseInt(val, 10); });
    setupDistanceGroup("fmt-trendline-dist-group", "fmt-trendline-custom-dist", "fmt-trendline-custom-btn", s.trendline.distancePct, dist => { s.trendline.distancePct = dist; });
    setupButtonGroup("fmt-trendline-dir-group", s.trendline.direction, val => { s.trendline.direction = val; });

    // 3. Horizontal Level (Горизонталка)
    const setLvl = $("set-fmt-level-enabled");
    const cardLvl = $("fmt-card-level");
    const bodyLvl = $("fmt-level-body");
    if (setLvl) {
      setLvl.checked = !!s.level.enabled;
      if (cardLvl) cardLvl.classList.toggle("active", setLvl.checked);
      if (bodyLvl) bodyLvl.style.opacity = setLvl.checked ? "1" : "0.45";
      setLvl.onchange = () => {
        s.level.enabled = setLvl.checked;
        if (cardLvl) cardLvl.classList.toggle("active", setLvl.checked);
        if (bodyLvl) bodyLvl.style.opacity = setLvl.checked ? "1" : "0.45";
      };
    }
    setupTfGroup("fmt-level-tf-group", s.level.timeframes, tfs => { s.level.timeframes = tfs; });
    setupButtonGroup("fmt-level-touches-group", s.level.minTouches, val => { s.level.minTouches = parseInt(val, 10); });
    setupDistanceGroup("fmt-level-dist-group", "fmt-level-custom-dist", "fmt-level-custom-btn", s.level.distancePct, dist => { s.level.distancePct = dist; });
    setupButtonGroup("fmt-level-dir-group", s.level.direction, val => { s.level.direction = val; });

    // 4. Retest (Подтвержденный ретест)
    const setRet = $("set-fmt-retest-enabled");
    const cardRet = $("fmt-card-retest");
    const bodyRet = $("fmt-retest-body");
    if (setRet) {
      setRet.checked = !!s.retest.enabled;
      if (cardRet) cardRet.classList.toggle("active", setRet.checked);
      if (bodyRet) bodyRet.style.opacity = setRet.checked ? "1" : "0.45";
      setRet.onchange = () => {
        s.retest.enabled = setRet.checked;
        if (cardRet) cardRet.classList.toggle("active", setRet.checked);
        if (bodyRet) bodyRet.style.opacity = setRet.checked ? "1" : "0.45";
      };
    }
    setupTfGroup("fmt-retest-tf-group", s.retest.timeframes, tfs => { s.retest.timeframes = tfs; });
    setupButtonGroup("fmt-retest-dir-group", s.retest.direction, val => { s.retest.direction = val; });
    setupButtonGroup("fmt-retest-stage-group", s.retest.stage, val => { s.retest.stage = val; });
    setupButtonGroup("fmt-retest-age-group", s.retest.maxAgeCandles, val => { s.retest.maxAgeCandles = parseInt(val, 10); });
  }

  syncFormationUI();

  // Test Sound & Alert Button
  function triggerTestAlert() {
    playAlertSound("chime");
    showToast({ title: "Тестовый сигнал", message: "Звук и всплывающая карточка работают корректно!", type: "info" });
    if (currentFormationAlertSettings.tgEnabled) {
      sendTelegramAlert("🔔 <b>Obsidian Formation & Price Alert</b>\n\nТестовый сигнал из скринера получен успешно!");
    }
  }

  async function triggerTestFormationTgAlert() {
    playAlertSound("chime");
    showToast({ title: "Генерация 4K снимка...", message: "Рендеринг 300 свечей и отправка в Telegram...", type: "info" });
    
    const sym = activeSym || "BTCUSDT";
    const ex = activeEx || "BN";
    const tf = activeTf || "5m";
    const exFull = getFullExchangeName(ex);

    let photoDataUrl = null;
    try {
      photoDataUrl = await captureChartSnapshot(sym, 0, 0, tf, ex, {
        isFormation: true,
        formationType: "trendline",
        formationInfo: { touches: 3, distPct: 0.28 }
      });
    } catch (err) {
      console.warn("Capture snapshot error during test:", err);
    }

    const telegramMsg =
      `📐 <b>Сигнал формации: Наклонный уровень (Тест)</b>\n` +
      `• <b>Монета:</b> ${sym.toUpperCase()} (${exFull})\n` +
      `• <b>Таймфрейм:</b> ${tf}\n` +
      `• <b>Касания:</b> 3 касания\n` +
      `• <b>Дистанция:</b> 0.28% до наклонки\n` +
      `─────────────────────────\n` +
      `⚡ <b>Obsidian Formation Scanner</b>`;

    sendTelegramAlert(telegramMsg, photoDataUrl);
    showToast({ title: "Telegram", message: "✅ 4K снимок и сигнал формации отправлены в Telegram!", type: "success" });
  }

  $("btn-test-sound")?.addEventListener("click", triggerTestAlert);
  $("btn-test-sound-fmt")?.addEventListener("click", triggerTestAlert);
  $("btn-test-tg-photo-fmt")?.addEventListener("click", triggerTestFormationTgAlert);

  // Formation Modal Save button
  $("btn-save-formation-alerts")?.addEventListener("click", () => {
    const customInput = $("fmt-blacklist-custom");
    if (customInput) {
      currentFormationAlertSettings.blacklistCustom = customInput.value.trim();
    }
    const pills = $("fmt-blacklist-pills");
    if (pills) {
      const activePills = Array.from(pills.querySelectorAll("button.fmt-btn.active[data-bl]")).map(b => b.dataset.bl);
      currentFormationAlertSettings.blacklist = activePills;
    }
    saveFormationAlertSettings(currentFormationAlertSettings);
    closeFormationAlertsModal();
    showToast({ title: "Настройки сохранены", message: "Параметры сигналов и алертов формаций успешно обновлены", type: "success" });
  });

  // Formation Modal Reset button
  $("btn-reset-formation-alerts")?.addEventListener("click", () => {
    currentFormationAlertSettings = JSON.parse(JSON.stringify(DEFAULT_FORMATION_ALERT_SETTINGS));
    saveFormationAlertSettings(currentFormationAlertSettings);
    syncFormationUI();
    showToast({ title: "Сброс настроек", message: "Все параметры возвращены к стандартным значениям", type: "info" });
  });

  // Settings Apply button hook
  const applyBtn = $("settings-apply-btn");
  if (applyBtn) {
    applyBtn.onclick = () => {
      saveFormationAlertSettings(currentFormationAlertSettings);
      showToast({ title: "Настройки сохранены", message: "Параметры уведомлений успешно применены", type: "success" });
      if (typeof closeSettingsModal === "function") closeSettingsModal();
    };
  }

  // Settings Reset button hook
  const resetBtn = $("settings-reset-btn");
  if (resetBtn) {
    resetBtn.onclick = () => {
      currentFormationAlertSettings = JSON.parse(JSON.stringify(DEFAULT_FORMATION_ALERT_SETTINGS));
      saveFormationAlertSettings(currentFormationAlertSettings);
      syncFormationUI();
      showToast({ title: "Сброс настроек", message: "Все параметры возвращены к стандартным значениям", type: "info" });
    };
  }

  // ═══ 24/7 Background Formation Alert Scanner Engine ═══
  const formationAlertCooldownMap = new Map();
  const formationAlertQueue = [];
  let isProcessingFormationQueue = false;
  let isScanningFormationAlerts = false;
  let hasCompletedInitialWarmup = false;

  function enqueueFormationAlert(data) {
    const exists = formationAlertQueue.some(item => item.ex === data.ex && item.sym === data.sym && item.type === data.type);
    if (exists) return;
    formationAlertQueue.push(data);
    processFormationAlertQueue();
  }

  async function processFormationAlertQueue() {
    if (isProcessingFormationQueue || formationAlertQueue.length === 0) return;
    isProcessingFormationQueue = true;

    try {
      while (formationAlertQueue.length > 0) {
        const item = formationAlertQueue.shift();
        await triggerMatchedFormationAlert(item);
        if (formationAlertQueue.length > 0) {
          // Paced 4-second delay between dispatches so alerts arrive 1 by 1 cleanly
          await new Promise(r => setTimeout(r, 4000));
        }
      }
    } catch (err) {
      console.error("[ALERT QUEUE ERROR]", err);
    } finally {
      isProcessingFormationQueue = false;
    }
  }

  function isFormationCoinBlacklisted(sym) {
    if (!sym) return false;
    const s = currentFormationAlertSettings;
    if (!s) return false;

    const rawSym = String(sym).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const base = rawSym.replace(/(USDT|USDC|BUSD|USD|PERP|SWAP|F)$/, "");

    const blList = Array.isArray(s.blacklist) ? s.blacklist : [];
    const customList = typeof s.blacklistCustom === "string" 
      ? s.blacklistCustom.toUpperCase().split(/[,;\s]+/).map(x => x.trim().replace(/[^A-Z0-9]/g, "")).filter(Boolean)
      : [];

    const allExcluded = new Set([...blList.map(x => x.toUpperCase()), ...customList]);

    if (allExcluded.has(rawSym) || allExcluded.has(base)) return true;
    for (const item of allExcluded) {
      if (item && (rawSym === item || base === item || (rawSym.startsWith(item) && rawSym.length <= item.length + 5))) return true;
    }
    return false;
  }

  async function triggerMatchedFormationAlert(data) {
    const s = currentFormationAlertSettings;
    if (!s) return;
    const exFull = getFullExchangeName(data.ex);
    const symDisp = (data.sym || "BTCUSDT").toUpperCase();
    const formattedPrice = typeof fP === "function" ? fP(data.curPrice) : data.curPrice.toLocaleString();
    const formattedVol = data.vol24 >= 1e9 ? (data.vol24 / 1e9).toFixed(2) + "B" : data.vol24 >= 1e6 ? (data.vol24 / 1e6).toFixed(1) + "M" : (data.vol24 / 1e3).toFixed(0) + "K";
    const now = new Date();
    const timeStr = now.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dateStr = `${String(now.getDate()).padStart(2, "0")}.${String(now.getMonth() + 1).padStart(2, "0")}`;

    console.log(`[FORMATION ALERT MATCH] ${symDisp} [${data.tf}] ${data.typeName} touches=${data.touches} dist=${data.distPct}%`);

    let photoDataUrl = null;
    if (s.tgEnabled) {
      try {
        photoDataUrl = await captureChartSnapshot(data.sym, data.curPrice, data.targetPrice, data.tf, data.ex, {
          isFormation: true,
          formationType: data.type,
          formationInfo: data.formationInfo
        });
      } catch (err) {
        console.warn("Snapshot generation failed for formation alert:", err);
      }
    }

    const typeIcon = data.type === "trendline" ? "📐" : data.type === "level" ? "➖" : "🔄";

    if (s.soundEnabled) {
      try { playAlertSound("chime"); } catch (_) {}
    }

    if (s.toastEnabled) {
      try {
        showToast({
          title: `${typeIcon} ${data.typeName}`,
          message: `<b>${symDisp} (${exFull}) [${data.tf}]</b>: ${data.touches} касания · ${data.distPct}% до формации ($${formattedPrice})`,
          type: "price_alert"
        });
      } catch (_) {}
    }

    if (s.tgEnabled) {
      const telegramMsg =
        `${typeIcon} <b>Сигнал формации: ${data.typeName}</b>\n` +
        `• <b>Монета:</b> ${symDisp} (${exFull})\n` +
        `• <b>Таймфрейм:</b> ${data.tf}\n` +
        `• <b>Касания:</b> ${data.touches} касания\n` +
        `• <b>Дистанция:</b> ${data.distPct}% до формации\n` +
        `• <b>Текущая цена:</b> $${formattedPrice}\n` +
        `• <b>Объем 24ч:</b> $${formattedVol}\n` +
        `• <b>Время:</b> ${dateStr} ${timeStr}\n` +
        `─────────────────────────\n` +
        `⚡ <b>Obsidian Formation Scanner</b>`;

      sendTelegramAlert(telegramMsg, photoDataUrl);
    }
  }

  async function runFormationAlertScanner() {
    if (isScanningFormationAlerts) return;
    const isPro = window.currentUser && window.currentUser.plan === "pro";
    if (!isPro) return; // Formation alerts are exclusively a PRO feature

    const s = currentFormationAlertSettings;
    if (!s) return;

    const isTl = !!s.trendline?.enabled;
    const isLvl = !!s.level?.enabled;
    const isRet = !!s.retest?.enabled;
    if (!isTl && !isLvl && !isRet) return;

    isScanningFormationAlerts = true;

    try {
      const cooldownMs = (s.cooldownSeconds ? Number(s.cooldownSeconds) * 1000 : (Number(s.cooldownMinutes) || 5) * 60 * 1000);
      const minVol = Number(s.minVol24h) || 0;
      const allowedExs = Array.isArray(s.exchanges) && s.exchanges.length > 0 ? s.exchanges : ["all"];
      const isAllowedEx = (e) => allowedExs.includes("all") || allowedExs.includes(e) || allowedExs.includes(String(e).toUpperCase());
      const now = Date.now();
      const isFirstRun = !hasCompletedInitialWarmup;

      // 1. Scan Trendlines if enabled
      if (isTl) {
        const tfs = Array.isArray(s.trendline.timeframes) && s.trendline.timeframes.length > 0 ? s.trendline.timeframes : ["5m", "15m", "1h"];
        const minTouches = Number(s.trendline.minTouches) || 2;
        const maxDist = Number(s.trendline.distancePct) || 1.0;
        const targetDir = s.trendline.direction || "all";

        for (const tf of tfs) {
          try {
            const res = await fetch(`/api/formations/map?tf=${encodeURIComponent(tf)}&type=trendline`);
            if (!res.ok) continue;
            const map = await res.json();
            if (!map || typeof map !== "object") continue;

            for (const [key, items] of Object.entries(map)) {
              if (!Array.isArray(items) || items.length === 0) continue;
              const colonIdx = key.indexOf(":");
              if (colonIdx <= 0) continue;
              const ex = key.substring(0, colonIdx);
              const sym = key.substring(colonIdx + 1);

              if (!isAllowedEx(ex)) continue;
              if (isFormationCoinBlacklisted(sym)) continue;

              const coinObj = typeof coins !== "undefined" ? (coins.get(key) || coins.get(sym) || coins.get(`${ex}:${sym.toUpperCase()}`)) : null;
              const curPrice = coinObj?.p || 0;
              const vol24 = coinObj?.v || 0;
              if (curPrice <= 0 || (minVol > 0 && vol24 < minVol)) continue;

              for (const item of items) {
                const touches = item.touches || item.swingIndices?.length || 2;
                if (touches < minTouches) continue;

                if (targetDir !== "all") {
                  if ((targetDir === "down" || targetDir === "support" || targetDir === "long") && item.direction !== "down") continue;
                  if ((targetDir === "up" || targetDir === "resistance" || targetDir === "short") && item.direction !== "up") continue;
                }

                const lineEndP = item.endPrice || (item.p2 ? item.p2.price : item.price);
                if (!lineEndP || lineEndP <= 0) continue;

                // Reject pierced lines (when price has already broken through the trendline)
                if (item.direction === "down" && curPrice < lineEndP * 0.998) continue;
                if (item.direction === "up" && curPrice > lineEndP * 1.002) continue;

                const distPct = Math.abs(curPrice - lineEndP) / curPrice * 100;
                if (distPct > maxDist) continue;

                const cdKey = `${key}:trendline:${tf}`;
                const lastAlert = formationAlertCooldownMap.get(cdKey) || 0;
                if (now - lastAlert < cooldownMs) continue;

                formationAlertCooldownMap.set(cdKey, now);

                if (!isFirstRun) {
                  enqueueFormationAlert({
                    ex,
                    sym,
                    tf,
                    type: "trendline",
                    typeName: "Наклонный уровень (Наклонка)",
                    touches: Math.min(6, touches),
                    distPct: distPct.toFixed(2),
                    targetPrice: lineEndP,
                    curPrice,
                    vol24,
                    formationInfo: {
                      touches: Math.min(6, touches),
                      distPct: distPct.toFixed(2),
                      p1: item.p1?.price,
                      p2: item.p2?.price
                    }
                  });
                }
              }
            }
          } catch (_) {}
        }
      }

      // 2. Scan Levels (Горизонталки) if enabled
      if (isLvl) {
        const tfs = Array.isArray(s.level.timeframes) && s.level.timeframes.length > 0 ? s.level.timeframes : ["5m", "15m", "1h"];
        const minTouches = Number(s.level.minTouches) || 2;
        const maxDist = Number(s.level.distancePct) || 1.0;
        const targetDir = s.level.direction || "all";

        for (const tf of tfs) {
          try {
            const res = await fetch(`/api/formations/map?tf=${encodeURIComponent(tf)}&type=levels`);
            if (!res.ok) continue;
            const map = await res.json();
            if (!map || typeof map !== "object") continue;

            for (const [key, items] of Object.entries(map)) {
              if (!Array.isArray(items) || items.length === 0) continue;
              const colonIdx = key.indexOf(":");
              if (colonIdx <= 0) continue;
              const ex = key.substring(0, colonIdx);
              const sym = key.substring(colonIdx + 1);

              if (!isAllowedEx(ex)) continue;
              if (isFormationCoinBlacklisted(sym)) continue;

              const coinObj = typeof coins !== "undefined" ? (coins.get(key) || coins.get(sym) || coins.get(`${ex}:${sym.toUpperCase()}`)) : null;
              const curPrice = coinObj?.p || 0;
              const vol24 = coinObj?.v || 0;
              if (curPrice <= 0 || (minVol > 0 && vol24 < minVol)) continue;

              for (const item of items) {
                const touches = item.touches || item.touchIndices?.length || 1;
                if (touches < minTouches) continue;

                if (targetDir !== "all") {
                  if ((targetDir === "support" || targetDir === "down" || targetDir === "long") && item.direction !== "down") continue;
                  if ((targetDir === "resistance" || targetDir === "up" || targetDir === "short") && item.direction !== "up") continue;
                }

                const lvlPrice = item.price || item.endPrice;
                if (!lvlPrice || lvlPrice <= 0) continue;
                const distPct = Math.abs(curPrice - lvlPrice) / curPrice * 100;
                if (distPct > maxDist) continue;

                const cdKey = `${key}:level:${tf}:${lvlPrice.toFixed(4)}`;
                const lastAlert = formationAlertCooldownMap.get(cdKey) || 0;
                if (now - lastAlert < cooldownMs) continue;

                formationAlertCooldownMap.set(cdKey, now);

                if (!isFirstRun) {
                  enqueueFormationAlert({
                    ex,
                    sym,
                    tf,
                    type: "level",
                    typeName: "Горизонтальный уровень (Горизонталка)",
                    touches: Math.min(6, touches),
                    distPct: distPct.toFixed(2),
                    targetPrice: lvlPrice,
                    curPrice,
                    vol24,
                    formationInfo: {
                      touches: Math.min(6, touches),
                      distPct: distPct.toFixed(2),
                      p1: lvlPrice,
                      p2: lvlPrice
                    }
                  });
                }
              }
            }
          } catch (_) {}
        }
      }

      // 3. Scan Retests if enabled
      if (isRet) {
        const tfs = Array.isArray(s.retest.timeframes) && s.retest.timeframes.length > 0 ? s.retest.timeframes : ["5m", "15m", "1h"];
        const targetDir = s.retest.direction || "all";

        for (const tf of tfs) {
          try {
            const res = await fetch(`/api/formations/map?tf=${encodeURIComponent(tf)}&type=retest`);
            if (!res.ok) continue;
            const map = await res.json();
            if (!map || typeof map !== "object") continue;

            for (const [key, items] of Object.entries(map)) {
              if (!Array.isArray(items) || items.length === 0) continue;
              const colonIdx = key.indexOf(":");
              if (colonIdx <= 0) continue;
              const ex = key.substring(0, colonIdx);
              const sym = key.substring(colonIdx + 1);

              if (!isAllowedEx(ex)) continue;
              if (isFormationCoinBlacklisted(sym)) continue;

              const coinObj = typeof coins !== "undefined" ? (coins.get(key) || coins.get(sym) || coins.get(`${ex}:${sym.toUpperCase()}`)) : null;
              const curPrice = coinObj?.p || 0;
              const vol24 = coinObj?.v || 0;
              if (curPrice <= 0 || (minVol > 0 && vol24 < minVol)) continue;

              for (const item of items) {
                if (targetDir !== "all") {
                  if ((targetDir === "up" || targetDir === "long") && item.direction !== "up") continue;
                  if ((targetDir === "down" || targetDir === "short") && item.direction !== "down") continue;
                }

                const lvlPrice = item.price || item.endPrice;
                if (!lvlPrice || lvlPrice <= 0) continue;
                const distPct = Math.abs(curPrice - lvlPrice) / curPrice * 100;

                const cdKey = `${key}:retest:${tf}`;
                const lastAlert = formationAlertCooldownMap.get(cdKey) || 0;
                if (now - lastAlert < cooldownMs) continue;

                formationAlertCooldownMap.set(cdKey, now);

                if (!isFirstRun) {
                  enqueueFormationAlert({
                    ex,
                    sym,
                    tf,
                    type: "retest",
                    typeName: "Подтвержденный ретест (Ретест)",
                    touches: item.touches || 2,
                    distPct: distPct.toFixed(2),
                    targetPrice: lvlPrice,
                    curPrice,
                    vol24,
                    formationInfo: {
                      touches: item.touches || 2,
                      distPct: distPct.toFixed(2),
                      p1: lvlPrice,
                      p2: lvlPrice
                    }
                  });
                }
              }
            }
          } catch (_) {}
        }
      }

      hasCompletedInitialWarmup = true;
    } catch (err) {
      console.error("[FORMATION ALERT SCANNER ERROR]", err);
    } finally {
      isScanningFormationAlerts = false;
    }
  }

  // Run auto-scanner loop every 12 seconds
  setTimeout(runFormationAlertScanner, 3000);
  setInterval(runFormationAlertScanner, 12000);
  window.runFormationAlertScanner = runFormationAlertScanner;
}

// Global hook for price checking and formation alert settings
window.checkPriceAlerts = checkPriceAlerts;
window.showToast = showToast;
window.playAlertSound = playAlertSound;
window.loadFormationAlertSettings = loadFormationAlertSettings;
window.saveFormationAlertSettings = saveFormationAlertSettings;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initNotificationsUI);
} else {
  initNotificationsUI();
}

})();
