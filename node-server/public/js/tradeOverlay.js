"use strict";

(function () {
  const DISMISSED_STORAGE_KEY = "obsidian_dismissed_trades_v1";

  function loadDismissedStorage() {
    try {
      const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw);
      const map = new Map();
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) map.set(k.toUpperCase(), new Set(v));
      }
      return map;
    } catch (_) {
      return new Map();
    }
  }

  function saveDismissedStorage() {
    try {
      const obj = {};
      for (const [k, v] of state.dismissedBySymbol.entries()) {
        if (v && v.size > 0) {
          obj[k] = Array.from(v).slice(-2000);
        }
      }
      localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  const state = {
    executions: [],
    exchange: "",
    symbol: "",
    loading: false,
    lastFetchAt: 0,
    timer: null,
    hidden: false,
    dismissedBySymbol: loadDismissedStorage(), // symbol -> Set<cycleKey> (persists across F5/reloads)
    hitRegions: [] // populated during draw()
  };

  function currentToken() {
    return (typeof window.getStoredAuthToken === "function" ? window.getStoredAuthToken() : localStorage.getItem("obsidian_auth_token")) || "";
  }

  function syncIdentity() {
    const token = currentToken();
    const market = window.getActiveMarket?.();
    const identity = `${token}|${market?.ex || ''}|${market?.sym || ''}`;
    if (state.identity !== identity) {
      state.identity = identity;
      state.requestController?.abort();
      state.requestController = null;
      state.loading = false;
      state.executions = [];
      state.hitRegions = [];
      state.lastFetchAt = 0;
      state.exchange = market?.ex || '';
      state.symbol = market?.sym || '';
      window.requestMainChartDraw?.();
    }
    return { token, market, identity };
  }

  const EXCHANGE_NAMES = { BN: "BINANCE", BB: "BYBIT", OX: "OKX", BG: "BITGET" };

  function number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function executionTime(item) {
    if (number(item.time) > 0) return number(item.time);
    const text = String(item.date || "").trim();
    if (!text) return 0;
    return Date.parse(text.includes("T") ? text : `${text.replace(" ", "T")}:00Z`) || 0;
  }

  function getDismissedSet(symbol) {
    const s = String(symbol || state.symbol || "").toUpperCase();
    if (!state.dismissedBySymbol.has(s)) {
      state.dismissedBySymbol.set(s, new Set());
    }
    return state.dismissedBySymbol.get(s);
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
    const classified = items.map(item => {
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

    const cycleEntries = new Map();
    classified.forEach(it => {
      if (!cycleEntries.has(it.cycle)) cycleEntries.set(it.cycle, it);
    });

    return classified.map(it => {
      const first = cycleEntries.get(it.cycle);
      const cycleKey = first ? `${first.time}_${first.price}` : `cycle_${it.cycle}`;
      const itemKey = it.id || it.orderId || `${it.time}_${it.price}_${it.qty}_${it.side}`;
      return { ...it, cycleKey, itemKey };
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

  function formatMoney(value, includeSign = false) {
    const n = number(value);
    const sign = includeSign ? (n >= 0 ? "+" : "-") : (n < 0 ? "-" : "");
    const abs = Math.abs(n);
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
    return `${sign}$${abs.toFixed(2)}`;
  }

  function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function pill(ctx, x, y, text, color, above, minWidth = 0, bgColor = "rgba(10, 13, 20, 0.94)") {
    ctx.save();
    ctx.font = "600 10px Inter, -apple-system, sans-serif";
    const textWidth = ctx.measureText(text).width;
    const width = Math.max(minWidth, textWidth + 14);
    const height = 19;
    const bx = Math.max(4, Math.min(x - width / 2, ctx.canvas.width - width - 4));
    const by = above ? y - height - 7 : y + 7;

    ctx.fillStyle = bgColor;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, width, height, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + width / 2, by + height / 2);
    ctx.restore();

    return { bx, by, width, height };
  }

  function rightScalePill(ctx, x, y, text, color, bgColor = "rgba(12, 16, 26, 0.95)", fontSize = 11, height = 20) {
    if (!ctx || !text) return { bx: 0, by: 0, width: 68, height };
    ctx.save();
    ctx.font = `600 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    const textWidth = ctx.measureText ? (ctx.measureText(text)?.width || 56) : 56;
    const width = Math.max(64, textWidth + 12);
    // Pinned near the price scale (inside the chart area just to the left of the scale line)
    // Never cut off by canvas border, and leaves price axis numbers fully legible!
    const bx = Math.max(4, x - width - 6);
    const by = Math.round(y - height / 2);

    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = 4;
    ctx.fillStyle = bgColor;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    roundRect(ctx, bx, by, width, height, 4);
    ctx.fill();
    ctx.stroke();

    // Small connector tick pointing right to the scale line
    ctx.shadowColor = "transparent";
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.moveTo(bx + width, y);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, bx + width / 2, by + height / 2);
    ctx.restore();

    return { bx, by, width, height };
  }

  function drawTradeArrow(ctx, px, py, isBuy, color, isHovered = false) {
    ctx.save();
    // For Buy: arrow points UP (tip at py, body below py)
    // For Sell: arrow points DOWN (tip at py, body above py)
    const dir = isBuy ? 1 : -1;
    const arrowLen = isHovered ? 15 : 12;
    const arrowW = isHovered ? 12 : 9.5;
    const stemW = isHovered ? 4.5 : 3.5;
    const wingY = py + dir * (arrowLen * 0.58);
    const baseY = py + dir * arrowLen;

    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = isHovered ? 6 : 3;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;

    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(10, 14, 22, 0.95)";
    ctx.lineWidth = 1.2;

    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px - arrowW / 2, wingY);
    ctx.lineTo(px - stemW / 2, wingY);
    ctx.lineTo(px - stemW / 2, baseY);
    ctx.lineTo(px + stemW / 2, baseY);
    ctx.lineTo(px + stemW / 2, wingY);
    ctx.lineTo(px + arrowW / 2, wingY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Precision dot centered exactly at the execution price (px, py)
    ctx.shadowColor = "transparent";
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, isHovered ? 3.2 : 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(10, 14, 22, 0.95)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  function drawTooltip(ctx, px, py, item, width, height) {
    const isBuy = item.side === "BUY";
    const sideColor = isBuy ? "#26c97a" : "#ff4560";
    const actionNames = {
      entry: "Вход",
      add: "Добор",
      partial_exit: "Част. выход",
      exit: "Выход",
      reverse: "Разворот"
    };
    const actionStr = `${actionNames[item.action] || "Сделка"} (${item.side})`;
    const priceStr = `Цена: $${formatPrice(item.price)}`;
    const qtyStr = item.qty > 0 ? `Объем: ${item.qty} (${formatMoney(item.price * item.qty, false)})` : "";
    const timeStr = item.time > 0 ? new Date(item.time).toLocaleTimeString() : "";

    const lines = [actionStr, priceStr];
    if (qtyStr) lines.push(qtyStr);
    if (timeStr) lines.push(`Время: ${timeStr}`);

    ctx.save();
    ctx.font = "600 10.5px Inter, -apple-system, sans-serif";
    let maxW = 0;
    lines.forEach(l => {
      const w = ctx.measureText(l).width;
      if (w > maxW) maxW = w;
    });

    const pad = 8;
    const boxW = maxW + pad * 2;
    const lineH = 15;
    const boxH = lines.length * lineH + pad * 2;

    let bx = Math.max(8, Math.min(width - boxW - 8, px - boxW / 2));
    let by = py > boxH + 20 ? py - boxH - 12 : py + 16;

    ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
    ctx.shadowBlur = 8;
    ctx.fillStyle = "rgba(12, 16, 26, 0.96)";
    ctx.strokeStyle = sideColor;
    ctx.lineWidth = 1.2;
    roundRect(ctx, bx, by, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = "transparent";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((l, idx) => {
      ctx.fillStyle = idx === 0 ? sideColor : "rgba(255, 255, 255, 0.85)";
      ctx.fillText(l, bx + pad, by + pad + idx * lineH);
    });
    ctx.restore();
  }

  function draw(ctx, options) {
    const session = syncIdentity();
    if (!session.token) return;
    if (state.hidden) {
      state.hitRegions = [];
      return;
    }

    const ex = options?.exchange || state.exchange || window.getActiveMarket?.()?.ex || "";
    if (typeof window.CryptoJournal?.isExchangeChartEnabled === "function") {
      if (!window.CryptoJournal.isExchangeChartEnabled(ex)) {
        state.hitRegions = [];
        return;
      }
    }

    const candles = options.candles || [];
    const sym = options.symbol || state.symbol || "";
    const dismissed = getDismissedSet(sym);

    const allItems = classify(options.executions || state.executions);
    // Filter out dismissed trades
    const items = allItems.filter(item => !dismissed.has(item.cycleKey));

    state.hitRegions = [];
    if (!ctx || !candles.length || !items.length) return;

    const xForIndex = options.xForIndex;
    const yForPrice = options.yForPrice;
    const width = options.width;
    const height = options.height;
    if (typeof xForIndex !== "function" || typeof yForPrice !== "function") return;

    const resolved = items.map(item => ({ ...item, index: closestIndex(candles, item.time) }));
    const cycles = new Map();
    resolved.forEach(item => {
      if (!cycles.has(item.cycleKey)) cycles.set(item.cycleKey, []);
      cycles.get(item.cycleKey).push(item);
    });

    const openCycles = new Map();
    for (const [cycleKey, cycleItems] of cycles.entries()) {
      const lastExecution = cycleItems.at(-1);
      const openQty = Math.abs(lastExecution?.positionAfter || 0);
      openCycles.set(cycleKey, openQty > 1e-8);
    }

    const chartWidth = options.chartWidth || (width + 90);
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(0, 0, chartWidth, height);
      ctx.clip();

      // ── 1. DRAW TRADE ZONES: BACKGROUND FILL, TRAJECTORY AND LIVE PNL ──
      for (const [cycleKey, cycleItems] of cycles.entries()) {
        const entries = cycleItems.filter(item => item.action === "entry" || item.action === "add");
        const exits = cycleItems.filter(item => item.action === "partial_exit" || item.action === "exit" || item.action === "reverse");
        if (!entries.length) continue;

        const isOpen = !!openCycles.get(cycleKey);
        const firstEntry = entries[0];
        const entryAverage = entries.at(-1).average || firstEntry.price;
        const livePrice = number(options.currentPrice || candles.at(-1)?.c);
        const lastExit = exits.at(-1) || cycleItems.at(-1);
        const markPrice = isOpen ? livePrice : (lastExit?.price || livePrice);
        const longSide = firstEntry.side === "BUY";

        const pnlPct = entryAverage > 0
          ? (longSide ? (markPrice - entryAverage) : (entryAverage - markPrice)) / entryAverage * 100
          : 0;

        const positionQty = isOpen
          ? Math.abs(cycleItems.at(-1)?.positionAfter || 0)
          : exits.reduce((acc, x) => acc + x.qty, 0) || entries.reduce((acc, x) => acc + x.qty, 0);
        const dollarPnl = (longSide ? (markPrice - entryAverage) : (entryAverage - markPrice)) * positionQty;
        const isProfit = pnlPct >= 0;
        const pnlColor = isProfit ? "#26c97a" : "#ff4560";
        const zoneFillColor = isProfit ? "rgba(38, 201, 122, 0.14)" : "rgba(255, 69, 96, 0.14)";
        const zoneBorderColor = isProfit ? "rgba(38, 201, 122, 0.55)" : "rgba(255, 69, 96, 0.55)";

        const yEntry = yForPrice(entryAverage);
        const yMark = yForPrice(markPrice);
        const xStart = Math.max(0, xForIndex(firstEntry.index));
        const currentCandleIdx = candles.length - 1;
        const xEnd = isOpen
          ? Math.max(xStart + 16, xForIndex(currentCandleIdx))
          : Math.max(xStart + 16, xForIndex(lastExit.index));
        const zoneLeft = xStart;
        const zoneRight = width;
        const zoneTop = Math.min(yEntry, yMark);
        const zoneBottom = Math.max(yEntry, yMark);
        const zoneW = Math.max(16, zoneRight - zoneLeft);
        const zoneH = Math.max(4, zoneBottom - zoneTop);

        // ── 1.1 FILLED TRADE ZONE (Во всю длину направо до ценовой шкалы) ──
        ctx.save();
        ctx.fillStyle = zoneFillColor;
        ctx.fillRect(zoneLeft, zoneTop, zoneW, zoneH);

        // Пунктирные линии только сверху и снизу (боковые вертикальные пунктиры убраны)
        ctx.strokeStyle = zoneBorderColor;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(zoneLeft, zoneTop);
        ctx.lineTo(zoneRight, zoneTop);
        ctx.moveTo(zoneLeft, zoneBottom);
        ctx.lineTo(zoneRight, zoneBottom);
        ctx.stroke();
        ctx.restore();

        // Hit region for trade zone
        state.hitRegions.push({
          type: "zone",
          cycleKey,
          isOpen,
          x: zoneLeft,
          y: zoneTop,
          width: zoneW,
          height: zoneH,
          label: `Сделка ${isProfit ? "+" : ""}${pnlPct.toFixed(2)}%`
        });

        // ── 1.2 TRAJECTORY CONNECTING LINE (От входа до выхода/текущей цены) ──
        ctx.save();
        ctx.strokeStyle = pnlColor;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xStart, yEntry);
        ctx.lineTo(xEnd, yMark);
        ctx.stroke();
        ctx.restore();

        state.hitRegions.push({
          type: "line",
          cycleKey,
          isOpen,
          xStart: Math.max(0, xStart - 10),
          xEnd: width + 85,
          y: yEntry,
          tolerance: 10,
          label: `ТВХ ${formatPrice(entryAverage)}`
        });

        // ── 1.4 MARK/EXIT GUIDELINE TO PRICE SCALE ──
        ctx.save();
        ctx.strokeStyle = isProfit ? "rgba(38, 201, 122, 0.45)" : "rgba(255, 69, 96, 0.45)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(xEnd, yMark);
        ctx.lineTo(width, yMark);
        ctx.stroke();
        ctx.restore();

        state.hitRegions.push({
          type: "line",
          cycleKey,
          isOpen,
          xStart: Math.max(0, xEnd - 10),
          xEnd: width + 85,
          y: yMark,
          tolerance: 10,
          label: `PnL ${formatPrice(markPrice)}`
        });

        // ── 1.5 PNL & TVH RIGHT SCALE PILLS (1 плашка PnL и 1 плашка ТВХ) ──
        const sign = pnlPct >= 0 ? "+" : "";
        let pnlText = `${sign}${pnlPct.toFixed(2)}%`;
        if (dollarPnl !== 0 && Number.isFinite(dollarPnl)) {
          pnlText += ` · ${formatMoney(dollarPnl, true)}`;
        }

        const tvhBox = rightScalePill(ctx, width, yEntry, `ТВХ: ${formatPrice(entryAverage)}`, "#38bdf8", "rgba(10, 24, 40, 0.95)", 10, 18);
        state.hitRegions.push({
          type: "rect",
          cycleKey,
          isOpen,
          x: tvhBox.bx - 6,
          y: tvhBox.by - 6,
          width: tvhBox.width + 12,
          height: tvhBox.height + 12,
          label: `ТВХ ${formatPrice(entryAverage)}`
        });

        let yPnlBadge = yMark;
        if (Math.abs(yPnlBadge - yEntry) < 22) {
          yPnlBadge = yEntry + (yPnlBadge >= yEntry ? 22 : -22);
        }
        const pnlBg = isProfit ? "rgba(10, 30, 20, 0.95)" : "rgba(34, 12, 18, 0.95)";
        const pnlBox = rightScalePill(ctx, width, yPnlBadge, pnlText, pnlColor, pnlBg, 11, 20);
        state.hitRegions.push({
          type: "rect",
          cycleKey,
          isOpen,
          x: pnlBox.bx - 6,
          y: pnlBox.by - 6,
          width: pnlBox.width + 12,
          height: pnlBox.height + 12,
          label: pnlText
        });
      }

      // ── 2. EXECUTION ARROWS ON EXACT CANDLE PRICES (NO TEXT WORDS) ──
      let hoveredItem = null;
      let hoveredItemPos = null;

      resolved.forEach(item => {
        const candle = candles[item.index];
        if (!candle) return;
        const px = xForIndex(item.index);
        if (px < -50 || px > width + 50) return;
        const py = yForPrice(item.price);
        const isBuy = item.side === "BUY";
        const color = isBuy ? "#26c97a" : "#ff4560";

        // Check if mouse is hovering over this execution arrow / point
        const dist = Math.hypot((state.mouseX || -999) - px, (state.mouseY || -999) - py);
        const isHovered = (state.mouseX >= 0 && state.mouseY >= 0 && dist < 14);

        if (isHovered && !hoveredItem) {
          hoveredItem = item;
          hoveredItemPos = { x: px, y: py };
        }

        drawTradeArrow(ctx, px, py, isBuy, color, isHovered);

        const itemIsOpen = !!openCycles.get(item.cycleKey);
        state.hitRegions.push({
          type: "marker",
          cycleKey: item.cycleKey,
          itemKey: item.itemKey,
          isOpen: itemIsOpen,
          x: px - 12,
          y: isBuy ? py : py - 16,
          width: 24,
          height: 18,
          label: `${item.side} ${formatPrice(item.price)}`
        });
      });

      // ── 3. HOVER TOOLTIP (Отображается только при наведении мыши на стрелку) ──
      if (hoveredItem && hoveredItemPos) {
        drawTooltip(ctx, hoveredItemPos.x, hoveredItemPos.y, hoveredItem, width, height);
      }
    } catch (err) {
      console.error("TradeOverlay draw error:", err);
    } finally {
      ctx.restore();
    }
  }

  function dismissCycle(symbol, cycleKey, label = "", isOpen = false) {
    if (isOpen) {
      if (typeof window.showToast === "function") {
        window.showToast({ message: "Текущая открытая сделка не может быть удалена с графика", type: "warning", durationMs: 2500 });
      }
      return;
    }
    const sym = symbol || state.symbol;
    const dismissed = getDismissedSet(sym);
    dismissed.add(cycleKey);
    // Также сохраняем все itemKey из этого цикла, чтобы сделка гарантированно не всплыла
    state.executions.filter(it => it.cycleKey === cycleKey).forEach(it => {
      if (it.itemKey) dismissed.add(it.itemKey);
    });
    saveDismissedStorage();

    // Удаляем из локального состояния навсегда
    state.executions = state.executions.filter(it => it.cycleKey !== cycleKey);

    if (typeof window.showToast === "function") {
      const cleanLabel = label ? ` (${label})` : "";
      window.showToast({ message: `Сделка удалена навсегда${cleanLabel}`, type: "info", durationMs: 2200 });
    }
    window.requestMainChartDraw?.();
  }

  function deleteAt(mouseX, mouseY, symbol) {
    if (!state.hitRegions.length) return false;
    const sym = symbol || state.symbol;

    for (let i = state.hitRegions.length - 1; i >= 0; i--) {
      const reg = state.hitRegions[i];
      let hit = false;
      if (reg.type === "marker" || reg.type === "rect" || reg.type === "zone") {
        hit = (mouseX >= reg.x && mouseX <= reg.x + reg.width &&
               mouseY >= reg.y && mouseY <= reg.y + reg.height);
      } else if (reg.type === "line") {
        hit = (mouseX >= reg.xStart && mouseX <= reg.xEnd &&
               Math.abs(mouseY - reg.y) <= reg.tolerance);
      }
      if (hit) {
        if (reg.isOpen) {
          if (typeof window.showToast === "function") {
            window.showToast({
              message: "Текущая открытая сделка не может быть удалена с графика",
              type: "warning",
              durationMs: 2500
            });
          }
          return true; // Click intercepted on active trade, prevented from deleting!
        }
        dismissCycle(sym, reg.cycleKey, reg.label);
        return true;
      }
    }

    return false;
  }

  function handleRightClick(mouseX, mouseY) {
    const sym = state.symbol || window.getActiveMarket?.()?.sym || "";
    // Удаляем сделку только при клике по ней (маркер, плашка, линия ТВХ/цены).
    // Сделки удаляются раз и навсегда — клик в пустоту больше НЕ восстанавливает их.
    return deleteAt(mouseX, mouseY, sym);
  }

  async function refresh(force) {
    const { market, token, identity } = syncIdentity();
    if (!market || !token || !EXCHANGE_NAMES[market.ex] || state.loading) return;

    const isSameSymbol = market.ex === state.exchange && market.sym === state.symbol;
    if (!force && isSameSymbol && Date.now() - state.lastFetchAt < 2000) return;

    if (!isSameSymbol) {
      state.executions = [];
      window.requestMainChartDraw?.();
    }

    state.loading = true;
    const controller = new AbortController();
    state.requestController = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    const isCurrent = () => currentToken() === token && state.identity === identity && window.getActiveMarket?.()?.ex === market.ex && window.getActiveMarket?.()?.sym === market.sym;
    try {
      const query = new URLSearchParams({ exchange: market.ex, symbol: market.sym });
      const response = await fetch(`/api/journal/live?${query}`, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!isCurrent()) return;
      if ([401, 403, 404].includes(response.status)) {
        state.executions = [];
        state.hitRegions = [];
        window.requestMainChartDraw?.();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!isCurrent()) return;
      const raw = Array.isArray(data.executions) ? data.executions : [];
      const classified = classify(raw);
      const dismissed = getDismissedSet(market.sym);

      // Навсегда фильтруем удаленные сделки
      state.executions = classified.filter(item => !dismissed.has(item.cycleKey) && !dismissed.has(item.itemKey));
      state.exchange = market.ex;
      state.symbol = market.sym;
      state.lastFetchAt = Date.now();
      window.requestMainChartDraw?.();
    } catch (_) {
      if (isCurrent() && force) state.executions = [];
    } finally {
      clearTimeout(timeout);
      if (state.requestController === controller) {
        state.loading = false;
        state.requestController = null;
      }
    }
  }

  function toggleVisibility() {
    state.hidden = !state.hidden;
    if (typeof window.showToast === "function") {
      if (state.hidden) {
        window.showToast({ message: "Сделки скрыты с графика", type: "info", durationMs: 2000 });
      } else {
        window.showToast({ message: "Сделки отображены на графике", type: "info", durationMs: 2000 });
      }
    }
    window.requestMainChartDraw?.();
    return !state.hidden;
  }

  function clearCurrent() {
    const sym = state.symbol;
    const dismissed = getDismissedSet(sym);
    if (dismissed && Array.isArray(state.executions)) {
      for (const it of state.executions) {
        if (it.cycleKey) dismissed.add(it.cycleKey);
        if (it.itemKey) dismissed.add(it.itemKey);
      }
      saveDismissedStorage();
    }
    state.executions = [];
    state.hidden = false;
    if (typeof window.showToast === "function") {
      window.showToast({ message: "Сделки удалены навсегда", type: "info", durationMs: 2500 });
    }
    window.requestMainChartDraw?.();
  }

  function hookCanvasMouse() {
    const canvas = document.getElementById("chart-canvas");
    if (!canvas || canvas._tradeOverlayHooked) return;
    canvas._tradeOverlayHooked = true;
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const newX = e.clientX - rect.left;
      const newY = e.clientY - rect.top;
      const prevX = state.mouseX || -999;
      const prevY = state.mouseY || -999;
      state.mouseX = newX;
      state.mouseY = newY;
      // If mouse is near any execution marker, request chart redraw for smooth tooltip
      const isNearMarker = state.hitRegions.some(reg => {
        return reg.type === "marker" && Math.hypot(newX - (reg.x + reg.width / 2), newY - (reg.y + reg.height / 2)) < 24;
      });
      const wasNearMarker = state.hitRegions.some(reg => {
        return reg.type === "marker" && Math.hypot(prevX - (reg.x + reg.width / 2), prevY - (reg.y + reg.height / 2)) < 24;
      });
      if (isNearMarker || wasNearMarker) {
        window.requestMainChartDraw?.();
      }
    });
    canvas.addEventListener("mouseleave", () => {
      state.mouseX = -1;
      state.mouseY = -1;
      window.requestMainChartDraw?.();
    });
  }

  function start() {
    hookCanvasMouse();
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh(false);
      hookCanvasMouse();
    }, 2500);
    refresh(true);
  }

  window.TradeOverlay = {
    classify,
    draw,
    refresh,
    start,
    toggleVisibility,
    clearCurrent,
    deleteAt,
    handleRightClick,
    hasExecutions() {
      if (!syncIdentity().token) return false;
      const activeEx = state.exchange || window.getActiveMarket?.()?.ex || "";
      if (typeof window.CryptoJournal?.isExchangeChartEnabled === "function") {
        if (!window.CryptoJournal.isExchangeChartEnabled(activeEx)) return false;
      }
      const dismissed = getDismissedSet(state.symbol);
      return state.executions.some(it => !dismissed.has(it.cycleKey) && !dismissed.has(it.itemKey));
    },
    isHidden() {
      return state.hidden;
    },
    setExecutions(items) {
      if (!syncIdentity().token) return;
      state.executions = Array.isArray(items) ? items : [];
    }
  };

  document.addEventListener("DOMContentLoaded", start);
})();
