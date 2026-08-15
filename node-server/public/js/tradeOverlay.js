"use strict";

(function () {
  const state = { executions: [], exchange: "", symbol: "", loading: false, lastFetchAt: 0, timer: null };
  const EXCHANGE_NAMES = { BN: "BINANCE", BB: "BYBIT", OX: "OKX" };

  function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  function normalizedSymbol(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/SWAP$/, ""); }
  function executionTime(item) {
    if (number(item.time) > 0) return number(item.time);
    const text = String(item.date || "").trim();
    if (!text) return 0;
    return Date.parse(text.includes("T") ? text : `${text.replace(" ", "T")}:00Z`) || 0;
  }

  function classify(rawItems) {
    const items = (Array.isArray(rawItems) ? rawItems : []).map(item => ({
      ...item,
      side: String(item.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY",
      positionSide: String(item.positionSide || "BOTH").toUpperCase(),
      price: number(item.price),
      qty: Math.abs(number(item.qty || item.size)),
      time: executionTime(item),
    })).filter(item => item.price > 0 && item.qty > 0 && item.time > 0).sort((a, b) => a.time - b.time);

    let position = 0, average = 0, cycle = 0;
    return items.map(item => {
      let signed = item.side === "BUY" ? item.qty : -item.qty;
      if (item.positionSide === "SHORT") signed = item.side === "SELL" ? -item.qty : item.qty;
      if (item.positionSide === "LONG") signed = item.side === "BUY" ? item.qty : -item.qty;
      const before = position;
      let action = "entry";
      if (Math.abs(before) < 1e-12) {
        cycle++;
        average = item.price;
      } else if (Math.sign(before) === Math.sign(signed)) {
        action = "add";
        average = (average * Math.abs(before) + item.price * item.qty) / (Math.abs(before) + item.qty);
      } else {
        action = item.qty + 1e-12 < Math.abs(before) ? "partial_exit" : "exit";
      }
      position = before + signed;
      if (Math.abs(position) < 1e-12) position = 0;
      const result = { ...item, action, cycle, positionBefore: before, positionAfter: position, average };
      if (before && position && Math.sign(before) !== Math.sign(position)) {
        result.action = "reverse";
        average = item.price;
        cycle++;
      }
      return result;
    });
  }

  function closestIndex(candles, timestamp) {
    if (!candles.length) return -1;
    let lo = 0, hi = candles.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (number(candles[mid].t) < timestamp) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(number(candles[lo - 1].t) - timestamp) <= Math.abs(number(candles[lo].t) - timestamp)) return lo - 1;
    return lo;
  }

  function formatPrice(value) {
    const n = number(value);
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return n.toPrecision(5).replace(/0+$/, "").replace(/\.$/, "");
  }

  function pill(ctx, x, y, text, color, above, maxWidth) {
    ctx.save();
    ctx.font = "600 10px Inter, sans-serif";
    const width = Math.min(maxWidth || 130, ctx.measureText(text).width + 12);
    const bx = Math.max(2, Math.min(x - width / 2, (maxWidth ? Infinity : ctx.canvas.width) - width - 2));
    const by = above ? y - 31 : y + 13;
    ctx.fillStyle = "rgba(8,11,18,.94)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(bx, by, width, 19, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, bx + width / 2, by + 10, width - 8);
    ctx.restore();
  }

  function arrow(ctx, x, y, isBuy, color) {
    const dir = isBuy ? -1 : 1;
    ctx.save(); ctx.fillStyle = color; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + dir * 9); ctx.lineTo(x - 7, y - dir * 2); ctx.lineTo(x - 3, y - dir * 2);
    ctx.lineTo(x - 3, y - dir * 8); ctx.lineTo(x + 3, y - dir * 8); ctx.lineTo(x + 3, y - dir * 2); ctx.lineTo(x + 7, y - dir * 2);
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  }

  function draw(ctx, options) {
    const candles = options.candles || [];
    const items = classify(options.executions || state.executions);
    if (!ctx || !candles.length || !items.length) return;
    const xForIndex = options.xForIndex;
    const yForPrice = options.yForPrice;
    const width = options.width;
    const height = options.height;
    if (typeof xForIndex !== "function" || typeof yForPrice !== "function") return;

    const resolved = items.map(item => ({ ...item, index: closestIndex(candles, item.time) }));
    const cycles = new Map();
    resolved.forEach(item => { if (!cycles.has(item.cycle)) cycles.set(item.cycle, []); cycles.get(item.cycle).push(item); });

    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
    for (const cycleItems of cycles.values()) {
      const entries = cycleItems.filter(item => item.action === "entry" || item.action === "add");
      const exits = cycleItems.filter(item => item.action === "partial_exit" || item.action === "exit" || item.action === "reverse");
      if (!entries.length) continue;
      const endIndex = exits.length ? exits.at(-1).index : candles.length - 1;
      ctx.strokeStyle = "#8b5cf6"; ctx.lineWidth = 1.4; ctx.setLineDash([7, 4]); ctx.beginPath();
      entries.forEach((entry, index) => {
        const x1 = xForIndex(entry.index), x2 = xForIndex(index + 1 < entries.length ? entries[index + 1].index : endIndex);
        const y = yForPrice(entry.average);
        if (!index) ctx.moveTo(x1, y); else ctx.lineTo(x1, y);
        ctx.lineTo(Math.max(x1, x2), y);
      });
      ctx.stroke(); ctx.setLineDash([]);

      const last = cycleItems.at(-1);
      const entryAverage = entries.at(-1).average;
      const markPrice = exits.length ? exits.at(-1).price : number(options.currentPrice || candles.at(-1).c);
      const longSide = entries[0].side === "BUY";
      const pnlPct = entryAverage > 0 ? (longSide ? (markPrice - entryAverage) : (entryAverage - markPrice)) / entryAverage * 100 : 0;
      const pnlColor = pnlPct >= 0 ? "#26c97a" : "#ff4560";
      const yMark = yForPrice(markPrice);
      ctx.strokeStyle = pnlColor; ctx.globalAlpha = .7; ctx.setLineDash([5, 4]); ctx.beginPath();
      ctx.moveTo(xForIndex(entries[0].index), yMark); ctx.lineTo(width, yMark); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      const badge = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;
      pill(ctx, Math.max(38, width - 42), Math.max(32, Math.min(height - 50, yMark)), badge, pnlColor, true, 76);
      void last;
    }

    resolved.forEach(item => {
      const candle = candles[item.index]; if (!candle) return;
      const x = xForIndex(item.index); if (x < -50 || x > width + 50) return;
      const isBuy = item.side === "BUY";
      const color = isBuy ? "#26c97a" : "#ff4560";
      const y = yForPrice(isBuy ? candle.l : candle.h) + (isBuy ? 17 : -17);
      arrow(ctx, x, y, isBuy, color);
      const labels = { entry: "Вход", add: "Докуп", partial_exit: "Частичный выход", exit: "Выход", reverse: "Разворот" };
      pill(ctx, x, y, `${labels[item.action] || "Сделка"} · ${formatPrice(item.price)}`, color, !isBuy, 128);
    });
    ctx.restore();
  }

  async function refresh(force) {
    const market = window.getActiveMarket?.();
    const token = localStorage.getItem("obsidian_auth_token") || "";
    if (!market || !token || !EXCHANGE_NAMES[market.ex] || state.loading) return;
    if (!force && Date.now() - state.lastFetchAt < 4500 && market.ex === state.exchange && market.sym === state.symbol) return;
    state.loading = true;
    try {
      const query = new URLSearchParams({ exchange: market.ex, symbol: market.sym });
      const response = await fetch(`/api/journal/live?${query}`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 404) { state.executions = []; return; }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.executions = Array.isArray(data.executions) ? data.executions : [];
      state.exchange = market.ex; state.symbol = market.sym; state.lastFetchAt = Date.now();
      window.requestMainChartDraw?.();
    } catch (_) {
      if (force) state.executions = [];
    } finally { state.loading = false; }
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, 5000);
    refresh(true);
  }

  window.TradeOverlay = { classify, draw, refresh, start, setExecutions(items) { state.executions = Array.isArray(items) ? items : []; } };
  document.addEventListener("DOMContentLoaded", start);
})();
