/**
 * CryptoScreen Pro — Traders Journal Module (TraderMakeMoney style)
 * Advanced Trading Analysis, Exchange API Sync, PnL Charts & Visualizer
 */

(function () {
  const STORAGE_KEY = "cryptoscreen_journal_trades_v4";
  const LEGACY_STORAGE_KEY = "cryptoscreen_journal_trades_v3";
  const API_KEYS_KEY = "cryptoscreen_journal_apikeys_v2";

  const MISTAKE_TAGS = [
    { id: "По системе", label: "По системе", color: "#26c97a" },
    { id: "Ордер Блок / FVG", label: "Ордер Блок / FVG", color: "#10b981" },
    { id: "Пробой уровня", label: "Пробой уровня", color: "#3b82f6" },
    { id: "FOMO", label: "FOMO", color: "#f97316" },
    { id: "Тильт", label: "Тильт", color: "#ff4560" },
    { id: "Ранний выход", label: "Ранний выход", color: "#eab308" },
    { id: "Нарушение риска", label: "Нарушение риска", color: "#ec4899" },
    { id: "Без стоп-лосса", label: "Без стоп-лосса", color: "#ef4444" }
  ];

  let trades = [];
  let apiKeys = {};
  let configuredExchanges = new Set();
  let currentTab = "overview";
  let dateRange = "ALL";
  let filterSearch = "";
  let filterSide = "ALL";
  let filterOutcome = "ALL";
  let filterTag = "ALL";
  let calendarMonth = new Date();
  let currentViewingTrade = null;

  function loadStorage() {
    try {
      // Purge any old v2 demo trades from localStorage
      localStorage.removeItem("cryptoscreen_journal_trades_v2");
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
        trades = Array.isArray(legacy) ? legacy.filter(t => {
          const tags = Array.isArray(t.tags) ? t.tags.join(" ") : "";
          const note = String(t.note || "");
          return !/API/i.test(tags) && !/Binance Futures PnL|OKX fill|Ордер\s*#/i.test(note);
        }) : [];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
        raw = localStorage.getItem(STORAGE_KEY);
      }
      if (raw) {
        trades = JSON.parse(raw);
      } else {
        trades = [];
      }
      const rawKeys = localStorage.getItem(API_KEYS_KEY);
      if (rawKeys) apiKeys = JSON.parse(rawKeys);
    } catch (e) {
      trades = [];
    }
  }

  function saveTrades() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
    } catch (e) {}
  }

  function saveApiKeys() {
    try {
      if (Object.keys(apiKeys).length) localStorage.setItem(API_KEYS_KEY, JSON.stringify(apiKeys));
      else localStorage.removeItem(API_KEYS_KEY);
    } catch (e) {}
  }

  function journalAuthHeaders(json = false) {
    const token = localStorage.getItem("obsidian_auth_token") || "";
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  // ── EXCHANGE SETTINGS (Отображение на графике & Ведение в дневнике) ──────────
  const EXCHANGE_SETTINGS_KEY = "obsidian_exchange_settings_v1";

  function normalizeExchangeCode(ex) {
    const s = String(ex || "").toUpperCase().trim();
    if (s === "BINANCE" || s === "BN") return "BN";
    if (s === "BYBIT" || s === "BB") return "BB";
    if (s === "OKX" || s === "OX") return "OX";
    if (s === "BITGET" || s === "BG") return "BG";
    return s;
  }

  function loadExchangeSettings() {
    const defaults = {
      BN: { showOnChart: true, trackInJournal: true },
      BB: { showOnChart: true, trackInJournal: true },
      OX: { showOnChart: true, trackInJournal: true },
      BG: { showOnChart: true, trackInJournal: true }
    };
    try {
      const raw = localStorage.getItem(EXCHANGE_SETTINGS_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return {
        BN: { ...defaults.BN, ...(parsed.BN || {}) },
        BB: { ...defaults.BB, ...(parsed.BB || {}) },
        OX: { ...defaults.OX, ...(parsed.OX || {}) },
        BG: { ...defaults.BG, ...(parsed.BG || {}) }
      };
    } catch (_) {
      return defaults;
    }
  }

  let exchangeSettings = loadExchangeSettings();

  function saveExchangeSettings() {
    try {
      localStorage.setItem(EXCHANGE_SETTINGS_KEY, JSON.stringify(exchangeSettings));
    } catch (_) {}
  }

  function isExchangeChartEnabled(ex) {
    const code = normalizeExchangeCode(ex);
    const s = exchangeSettings[code];
    return s ? s.showOnChart !== false : true;
  }

  function isExchangeJournalEnabled(ex) {
    const code = normalizeExchangeCode(ex);
    const s = exchangeSettings[code];
    return s ? s.trackInJournal !== false : true;
  }

  function updateSwitchInputs(ex) {
    const code = normalizeExchangeCode(ex);
    const s = exchangeSettings[code] || { showOnChart: true, trackInJournal: true };
    const chartEl = document.getElementById(`j-setting-chart-${code}`);
    const journalEl = document.getElementById(`j-setting-journal-${code}`);
    if (chartEl) chartEl.checked = s.showOnChart !== false;
    if (journalEl) journalEl.checked = s.trackInJournal !== false;
  }

  function markApiConnected(ex) {
    const code = normalizeExchangeCode(ex);
    const statusEl = document.getElementById(`j-api-status-${code}`);
    if (statusEl) {
      statusEl.textContent = "Подключено";
      statusEl.className = "j-api-status connected";
    }
    const gearBtn = document.getElementById(`j-api-gear-${code}`);
    if (gearBtn) {
      gearBtn.style.display = "inline-flex";
    }
    updateSwitchInputs(code);
  }

  function toggleExchangeSettings(ex) {
    const code = normalizeExchangeCode(ex);
    const panel = document.getElementById(`j-api-settings-${code}`);
    const gearBtn = document.getElementById(`j-api-gear-${code}`);
    if (!panel) return;
    const isShown = panel.style.display !== "none";
    panel.style.display = isShown ? "none" : "flex";
    if (gearBtn) gearBtn.classList.toggle("active", !isShown);
  }

  function updateExchangeSetting(ex, key, val) {
    const code = normalizeExchangeCode(ex);
    if (!exchangeSettings[code]) {
      exchangeSettings[code] = { showOnChart: true, trackInJournal: true };
    }
    exchangeSettings[code][key] = !!val;
    saveExchangeSettings();

    if (key === "showOnChart") {
      window.TradeOverlay?.refresh(true);
      window.requestMainChartDraw?.();
      if (typeof window.showToast === "function") {
        window.showToast({
          message: val ? `Сделки ${code} включены на графике` : `Сделки ${code} скрыты с графика`,
          type: "info",
          durationMs: 2000
        });
      }
    } else if (key === "trackInJournal") {
      updateUI();
      if (typeof window.showToast === "function") {
        window.showToast({
          message: val ? `Сделки ${code} включены в дневник` : `Сделки ${code} исключены из дневника`,
          type: "info",
          durationMs: 2000
        });
      }
    }
  }

  async function hydrateServerCredentials() {
    if (!localStorage.getItem("obsidian_auth_token")) return;
    try {
      const response = await fetch("/api/journal/credentials", { cache: "no-store", headers: journalAuthHeaders() });
      if (!response.ok) return;
      const data = await response.json();
      configuredExchanges = new Set((data.exchanges || []).map(item => item.exchange));
      configuredExchanges.forEach(markApiConnected);

      for (const [ex, keys] of Object.entries(apiKeys)) {
        if (!keys?.key || configuredExchanges.has(ex)) continue;
        const migration = await fetch(`/api/journal/credentials/${encodeURIComponent(ex)}`, {
          method: "PUT", headers: journalAuthHeaders(true),
          body: JSON.stringify({ apiKey: keys.key, apiSecret: keys.secret, passphrase: keys.passphrase || "" })
        });
        if (migration.ok) { configuredExchanges.add(ex); delete apiKeys[ex]; markApiConnected(ex); }
      }
      for (const ex of configuredExchanges) delete apiKeys[ex];
      saveApiKeys();
    } catch (_) {}
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}ч ${minutes}м`;
    return `${minutes}м ${seconds}с`;
  }

  function getFilteredTrades() {
    let list = [...trades];

    // Filter out trades from exchanges where "trackInJournal" is disabled
    list = list.filter(t => isExchangeJournalEnabled(t.exchange));

    // Date range filter
    if (dateRange !== "ALL") {
      const now = new Date();
      list = list.filter(t => {
        const d = new Date(t.date);
        if (dateRange === "TODAY") {
          return d.toDateString() === now.toDateString();
        } else if (dateRange === "7D") {
          return (now - d) <= (7 * 24 * 3600 * 1000);
        } else if (dateRange === "30D") {
          return (now - d) <= (30 * 24 * 3600 * 1000);
        } else if (dateRange === "MONTH") {
          return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        }
        return true;
      });
    }

    // Text & Side & Outcome & Tag filters
    return list.filter(t => {
      if (filterSearch) {
        const q = filterSearch.toLowerCase();
        const matchSym = t.symbol.toLowerCase().includes(q);
        const matchEx = t.exchange.toLowerCase().includes(q);
        const matchNote = (t.note || "").toLowerCase().includes(q);
        if (!matchSym && !matchEx && !matchNote) return false;
      }
      if (filterSide !== "ALL" && t.side !== filterSide) return false;
      if (filterOutcome === "WIN" && t.pnl < 0) return false;
      if (filterOutcome === "LOSS" && t.pnl >= 0) return false;
      if (filterTag !== "ALL" && !(t.tags || []).includes(filterTag)) return false;
      return true;
    });
  }

  // ── TMM STATS CALCULATION ──────────────────────────────────────────────────
  function calculateStats(tradeList) {
    if (!tradeList.length) {
      return {
        total: 0,
        winrate: "0.0",
        netPnl: 0,
        netPnlPercent: "0.00",
        profitFactor: "0.00",
        expectancy: "0.00",
        avgWin: 0,
        avgLoss: 0,
        rrRatio: "0.0",
        longs: 0,
        shorts: 0,
        wins: 0,
        losses: 0,
        totalFees: 0
      };
    }

    let wins = 0, losses = 0;
    let sumWinPnl = 0, sumLossPnl = 0;
    let totalPnl = 0;
    let longs = 0, shorts = 0;
    let totalFees = 0;

    tradeList.forEach(t => {
      totalPnl += t.pnl;
      totalFees += t.fee || 0;
      if (t.side === "LONG") longs++; else shorts++;

      if (t.pnl >= 0) {
        wins++;
        sumWinPnl += t.pnl;
      } else {
        losses++;
        sumLossPnl += Math.abs(t.pnl);
      }
    });

    const winrate = (wins / tradeList.length) * 100;
    const profitFactor = sumLossPnl === 0 ? sumWinPnl : (sumWinPnl / sumLossPnl);
    const avgWin = wins > 0 ? (sumWinPnl / wins) : 0;
    const avgLoss = losses > 0 ? (sumLossPnl / losses) : 0;
    const expectancy = (wins / tradeList.length) * avgWin - (losses / tradeList.length) * avgLoss;
    const rrRatio = avgLoss > 0 ? (avgWin / avgLoss) : 0;

    return {
      total: tradeList.length,
      winrate: winrate.toFixed(1),
      netPnl: totalPnl,
      netPnlPercent: (totalPnl >= 0 ? "+" : "") + ((totalPnl / 1000) * 100).toFixed(2),
      profitFactor: profitFactor.toFixed(2),
      expectancy: expectancy.toFixed(2),
      avgWin: Math.round(avgWin),
      avgLoss: Math.round(avgLoss),
      rrRatio: rrRatio.toFixed(1),
      longs,
      shorts,
      wins,
      losses,
      totalFees: totalFees.toFixed(2)
    };
  }

  // ── EQUITY CURVE CANVAS RENDERER (SMOOTH & INTERACTIVE) ────────────────────
  let equityHoverIndex = -1;
  let equityListenersAttached = false;

  function attachEquityCanvasListeners(canvas) {
    if (equityListenersAttached || !canvas) return;
    equityListenersAttached = true;

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const pts = canvas._equityPoints;
      if (!pts || pts.length === 0) return;

      let minDist = Infinity;
      let nearestIdx = -1;
      pts.forEach((pt, i) => {
        const dist = Math.abs(pt.screenX - mouseX);
        if (dist < minDist) {
          minDist = dist;
          nearestIdx = i;
        }
      });

      if (nearestIdx !== equityHoverIndex) {
        equityHoverIndex = nearestIdx;
        drawEquityChart();
      }
    });

    canvas.addEventListener("mouseleave", () => {
      if (equityHoverIndex !== -1) {
        equityHoverIndex = -1;
        drawEquityChart();
      }
    });
  }

  function drawSmoothPath(ctx, pts) {
    if (pts.length < 2) return;
    ctx.moveTo(pts[0].screenX, pts[0].screenY);
    if (pts.length === 2) {
      ctx.lineTo(pts[1].screenX, pts[1].screenY);
      return;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 >= pts.length ? pts.length - 1 : i + 2];

      const cp1x = p1.screenX + (p2.screenX - p0.screenX) * 0.18;
      const cp1y = p1.screenY + (p2.screenY - p0.screenY) * 0.18;
      const cp2x = p2.screenX - (p3.screenX - p1.screenX) * 0.18;
      const cp2y = p2.screenY - (p3.screenY - p1.screenY) * 0.18;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.screenX, p2.screenY);
    }
  }

  function drawEquityChart() {
    const canvas = document.getElementById("journal-equity-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();

    const dpr = window.devicePixelRatio || 1;
    const W = rect.width || 600;
    const H = rect.height || 240;

    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);
    attachEquityCanvasListeners(canvas);

    const tradeList = getFilteredTrades();
    const sorted = [...tradeList].sort((a, b) => new Date(a.date) - new Date(b.date));

    let cumPnl = 0;
    const points = [{ x: 0, pnl: 0, date: "Старт", sym: "—", tradePnl: 0, side: "—" }];
    sorted.forEach((t, i) => {
      cumPnl += t.pnl;
      points.push({
        x: i + 1,
        pnl: cumPnl,
        date: t.date,
        sym: t.symbol,
        tradePnl: t.pnl,
        side: t.side,
        pnlPercent: t.pnlPercent
      });
    });

    const padL = 60, padR = 20, padT = 25, padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // Smart Auto-Scaling
    const allPnls = points.map(p => p.pnl);
    let realMin = Math.min(...allPnls);
    let realMax = Math.max(...allPnls);

    let rawRange = realMax - realMin;
    if (rawRange === 0) rawRange = Math.abs(realMax) || 10;

    const margin = Math.max(rawRange * 0.2, 1);
    let minPnl = realMin - margin;
    let maxPnl = realMax + margin;

    // Zero alignment
    if (minPnl > 0) minPnl = 0;
    if (maxPnl < 0) maxPnl = 0;

    const range = maxPnl - minPnl || 1;

    const getX = (i) => padL + (i / Math.max(1, points.length - 1)) * plotW;
    const getY = (val) => padT + plotH - ((val - minPnl) / range) * plotH;

    const zeroY = getY(0);

    points.forEach((p, i) => {
      p.screenX = getX(i);
      p.screenY = getY(p.pnl);
    });
    canvas._equityPoints = points;

    // ── 1. Background Grid & Axis Lines ──
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    const gridSteps = 4;
    for (let g = 0; g <= gridSteps; g++) {
      const gVal = minPnl + (g / gridSteps) * (maxPnl - minPnl);
      const gY = getY(gVal);

      ctx.beginPath();
      ctx.moveTo(padL, gY);
      ctx.lineTo(W - padR, gY);
      ctx.stroke();

      // Y-axis Label
      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "500 10px Inter, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const sign = gVal > 0 ? "+" : "";
      ctx.fillText(`${sign}$${gVal.toFixed(2)}`, padL - 8, gY);
    }
    ctx.setLineDash([]);

    // ── 2. Zero Level Baseline ──
    if (zeroY >= padT && zeroY <= H - padB) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, zeroY);
      ctx.lineTo(W - padR, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 3. Gradient Area Fill ──
    const lastPnl = points[points.length - 1].pnl;
    const isOverallWin = lastPnl >= 0;

    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    if (isOverallWin) {
      grad.addColorStop(0, "rgba(38, 201, 122, 0.32)");
      grad.addColorStop(0.6, "rgba(38, 201, 122, 0.08)");
      grad.addColorStop(1, "rgba(38, 201, 122, 0.0)");
    } else {
      grad.addColorStop(0, "rgba(255, 69, 96, 0.32)");
      grad.addColorStop(0.6, "rgba(255, 69, 96, 0.08)");
      grad.addColorStop(1, "rgba(255, 69, 96, 0.0)");
    }

    ctx.beginPath();
    ctx.moveTo(points[0].screenX, zeroY);
    ctx.lineTo(points[0].screenX, points[0].screenY);
    drawSmoothPath(ctx, points);
    ctx.lineTo(points[points.length - 1].screenX, zeroY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // ── 4. Glowing Smooth Line ──
    ctx.save();
    ctx.beginPath();
    drawSmoothPath(ctx, points);
    ctx.strokeStyle = isOverallWin ? "#26c97a" : "#ff4560";
    ctx.lineWidth = 3.5;
    ctx.shadowColor = isOverallWin ? "rgba(38, 201, 122, 0.75)" : "rgba(255, 69, 96, 0.75)";
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();

    // Crisp stroke layer
    ctx.beginPath();
    drawSmoothPath(ctx, points);
    ctx.strokeStyle = isOverallWin ? "#26c97a" : "#ff4560";
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // ── 5. Vertices & Glowing Rings ──
    points.forEach((p, i) => {
      const isWin = p.tradePnl >= 0;
      const color = i === 0 ? "#7c3aed" : (isWin ? "#26c97a" : "#ff4560");

      ctx.beginPath();
      ctx.arc(p.screenX, p.screenY, 5, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? "rgba(124, 58, 237, 0.2)" : (isWin ? "rgba(38, 201, 122, 0.2)" : "rgba(255, 69, 96, 0.2)");
      ctx.fill();

      ctx.beginPath();
      ctx.arc(p.screenX, p.screenY, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#12131e";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // ── 6. Hover Crosshair & Glassmorphism Tooltip ──
    if (equityHoverIndex >= 0 && equityHoverIndex < points.length) {
      const hp = points[equityHoverIndex];

      // Vertical crosshair line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hp.screenX, padT);
      ctx.lineTo(hp.screenX, H - padB);
      ctx.stroke();

      // Horizontal crosshair line
      ctx.beginPath();
      ctx.moveTo(padL, hp.screenY);
      ctx.lineTo(W - padR, hp.screenY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Glowing active vertex target ring
      ctx.beginPath();
      ctx.arc(hp.screenX, hp.screenY, 8, 0, Math.PI * 2);
      ctx.fillStyle = hp.pnl >= 0 ? "rgba(38, 201, 122, 0.35)" : "rgba(255, 69, 96, 0.35)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(hp.screenX, hp.screenY, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = hp.pnl >= 0 ? "#26c97a" : "#ff4560";
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Tooltip Card Box
      const boxW = 160;
      const boxH = hp.sym !== "—" ? 64 : 42;
      let boxX = hp.screenX + 12;
      let boxY = hp.screenY - 32;

      if (boxX + boxW > W - padR) boxX = hp.screenX - boxW - 12;
      if (boxY < padT) boxY = padT + 4;
      if (boxY + boxH > H - padB) boxY = H - padB - boxH - 4;

      ctx.fillStyle = "rgba(18, 19, 30, 0.94)";
      ctx.strokeStyle = hp.pnl >= 0 ? "rgba(38, 201, 122, 0.4)" : "rgba(255, 69, 96, 0.4)";
      ctx.lineWidth = 1.2;

      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 8);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeRect(boxX, boxY, boxW, boxH);
      }

      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.font = "600 10px Inter, system-ui, sans-serif";
      const headerText = hp.sym !== "—" ? `${hp.sym} • ${hp.date.slice(0, 16)}` : `${hp.date}`;
      ctx.fillText(headerText, boxX + 10, boxY + 8);

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 12px Inter, system-ui, sans-serif";
      const cumSign = hp.pnl >= 0 ? "+" : "";
      ctx.fillText(`Equity: ${cumSign}$${hp.pnl.toFixed(2)}`, boxX + 10, boxY + 22);

      if (hp.sym !== "—") {
        ctx.font = "500 10px Inter, system-ui, sans-serif";
        const trSign = hp.tradePnl >= 0 ? "+" : "";
        const trColor = hp.tradePnl >= 0 ? "#26c97a" : "#ff4560";
        ctx.fillStyle = trColor;
        const pctStr = hp.pnlPercent !== undefined ? ` (${trSign}${hp.pnlPercent}%)` : "";
        ctx.fillText(`Сделка: ${trSign}$${hp.tradePnl.toFixed(2)}${pctStr}`, boxX + 10, boxY + 42);
      }
    }
  }

  // ── RENDER TRADES TABLE (MATCHING TMM COLUMNS) ───────────────────────────
  function renderTradesTable() {
    const tbody = document.getElementById("journal-table-body");
    if (!tbody) return;

    let filtered = getFilteredTrades();
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:40px; color:var(--t2);">История сделок пуста. Подключите API биржи в разделе 'API Интеграция' для авто-синхронизации.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(t => {
      const isWin = t.pnl >= 0;
      const pnlClass = isWin ? "j-pnl-win" : "j-pnl-loss";
      const sideClass = t.side === "LONG" ? "j-side-long" : "j-side-short";
      const pnlSign = isWin ? "+" : "";

      const tagsHtml = (t.tags || []).map(tagId => {
        const tInfo = MISTAKE_TAGS.find(m => m.id === tagId) || { label: tagId, color: "#7c3aed" };
        return `<span class="j-tag-pill" style="background:${tInfo.color}22; color:${tInfo.color}; border:1px solid ${tInfo.color}44;">${tInfo.label}</span>`;
      }).join(" ");

      return `
        <tr data-trade-id="${t.id}">
          <td style="font-weight:700; color:#fff;">${t.symbol}</td>
          <td style="font-size:11px; color:var(--t3);">${t.exchange}</td>
          <td style="font-size:11px;">
            <div style="color:var(--t2); font-size:10px;">${t.entryTime ? new Date(t.entryTime).toISOString().slice(0, 16).replace("T", " ") : t.date}</div>
            <div style="font-family:monospace; font-weight:600;">$${t.entry}</div>
          </td>
          <td style="font-size:11px;">
            <div style="color:var(--t2); font-size:10px;">${t.exitTime ? new Date(t.exitTime).toISOString().slice(0, 16).replace("T", " ") : t.date}</div>
            <div style="font-family:monospace; font-weight:600;">$${t.exit}</div>
          </td>
          <td style="font-size:11px; color:var(--t2);">${formatDuration(t.durationMs)}</td>
          <td><span class="j-side-badge ${sideClass}">${t.side}</span></td>
          <td class="${pnlClass}" style="font-family:monospace; font-weight:700;">
            ${pnlSign}${t.pnlPercent}%
          </td>
          <td class="${pnlClass}" style="font-family:monospace; font-weight:700;">
            ${pnlSign}$${t.pnl.toFixed(2)}
          </td>
          <td><div class="j-tags-cell">${tagsHtml || '<span style="color:var(--t3); font-size:11px;">—</span>'}</div></td>
          <td style="font-size:11px; color:var(--t2); max-width:180px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            ${t.note || "—"}
          </td>
          <td style="text-align:right;">
            <button class="j-act-btn j-view-chart-btn" data-id="${t.id}" title="График сделки">График</button>
            <button class="j-act-btn j-edit-btn" data-id="${t.id}" title="Редактировать">Изменить</button>
            <button class="j-act-btn j-del-btn" data-id="${t.id}" title="Удалить">Удалить</button>
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll(".j-view-chart-btn").forEach(btn => {
      btn.onclick = () => openTradeChartModal(btn.dataset.id);
    });
    tbody.querySelectorAll(".j-edit-btn").forEach(btn => {
      btn.onclick = () => openEditModal(btn.dataset.id);
    });
    tbody.querySelectorAll(".j-del-btn").forEach(btn => {
      btn.onclick = () => deleteTrade(btn.dataset.id);
    });
  }

  // ── MONTHLY / WEEKLY JOURNAL BREAKDOWN VIEW ──────────────────────────────
  function renderMonthlyJournalView() {
    const container = document.getElementById("journal-monthly-container");
    if (!container) return;

    if (!trades.length) {
      container.innerHTML = `<div style="color:var(--t2); font-size:13px;">Нет записей для формирования журнала. Подключите API биржи в разделе 'API Интеграция' для авто-синхронизации.</div>`;
      return;
    }

    // Group trades by Month (e.g., "Август 2026")
    const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    const groups = {};

    trades.forEach(t => {
      const d = new Date(t.date);
      const mKey = `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
      if (!groups[mKey]) groups[mKey] = [];
      groups[mKey].push(t);
    });

    let html = "";
    Object.keys(groups).forEach(mKey => {
      const mTrades = groups[mKey];
      let monthPnl = 0;
      let monthVolume = 0;
      let wins = 0;

      mTrades.forEach(t => {
        monthPnl += t.pnl;
        monthVolume += (t.entry * t.size);
        if (t.pnl >= 0) wins++;
      });

      const winrate = mTrades.length > 0 ? ((wins / mTrades.length) * 100).toFixed(0) : 0;
      const isWin = monthPnl >= 0;

      html += `
        <div class="j-card">
          <div style="font-size:16px; font-weight:800; color:#fff; margin-bottom:12px;">${mKey}</div>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; background:var(--bg3); padding:16px; border-radius:8px; border:1px solid var(--bd2);">
            <div>
              <div style="font-size:11px; color:var(--t2);">Чистая прибыль</div>
              <div style="font-size:18px; font-weight:800; color:${isWin ? 'var(--gr)' : 'var(--rd)'};">${isWin ? '+' : ''}$${monthPnl.toFixed(2)}</div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--t2);">Сделок</div>
              <div style="font-size:18px; font-weight:800; color:#fff;">${mTrades.length}</div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--t2);">Объем ($)</div>
              <div style="font-size:18px; font-weight:800; color:#fff;">$${Math.round(monthVolume)}</div>
            </div>
            <div>
              <div style="font-size:11px; color:var(--t2);">Процент побед (Win Rate)</div>
              <div style="font-size:18px; font-weight:800; color:var(--ac);">${winrate}%</div>
            </div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // ── CALENDAR HEATMAP RENDERER ─────────────────────────────────────────────
  function renderCalendarView() {
    const calendarBody = document.getElementById("j-calendar-body");
    const monthNameEl = document.getElementById("j-cal-month-name");
    if (!calendarBody || !monthNameEl) return;

    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();

    const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
    monthNameEl.textContent = `${monthNames[month]} ${year}`;

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    let startingDay = firstDay.getDay() - 1; // 0 = Mon
    if (startingDay < 0) startingDay = 6;

    const totalDays = lastDay.getDate();

    let html = "";

    // Empty lead slots
    for (let i = 0; i < startingDay; i++) {
      html += `<div class="j-cal-day-cell" style="opacity:0.2; pointer-events:none;"></div>`;
    }

    // Days of month
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const dayTrades = trades.filter(t => t.date.startsWith(dateStr));

      let dayPnl = 0;
      dayTrades.forEach(t => dayPnl += t.pnl);

      let cellClass = "";
      if (dayTrades.length > 0) {
        cellClass = dayPnl >= 0 ? "j-cal-win" : "j-cal-loss";
      }

      const pnlDisplay = dayTrades.length > 0 ? `${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(0)}` : "";
      const pnlColor = dayPnl >= 0 ? "var(--gr)" : "var(--rd)";

      html += `
        <div class="j-cal-day-cell ${cellClass}" data-date="${dateStr}">
          <div class="j-cal-day-num">${day}</div>
          <div class="j-cal-day-pnl" style="color:${pnlColor};">${pnlDisplay}</div>
          <div class="j-cal-day-count">${dayTrades.length > 0 ? dayTrades.length + ' сдел.' : ''}</div>
        </div>
      `;
    }

    calendarBody.innerHTML = html;

    calendarBody.querySelectorAll(".j-cal-day-cell[data-date]").forEach(cell => {
      cell.onclick = () => {
        const d = cell.dataset.date;
        filterSearch = d;
        const searchInput = document.getElementById("journal-search-input");
        if (searchInput) searchInput.value = d;
        switchTab("trades");
      };
    });
  }

  // ── HOURLY & DAILY ANALYTICS RENDERERS ────────────────────────────────────
  function renderAnalyticsView() {
    drawHourlyChart();
    drawDailyChart();
    renderCoinsBreakdown();
    renderTagsBreakdown();
  }

  function drawHourlyChart() {
    const canvas = document.getElementById("journal-hourly-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1) || 400;
    canvas.height = rect.height * (window.devicePixelRatio || 1) || 200;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const hours = new Array(24).fill(0);
    trades.forEach(t => {
      const h = parseInt(t.date.slice(11, 13), 10);
      if (!isNaN(h) && h >= 0 && h < 24) {
        hours[h] += t.pnl;
      }
    });

    const maxVal = Math.max(10, ...hours.map(v => Math.abs(v)));
    const barW = (W - 40) / 24;

    hours.forEach((val, h) => {
      const x = 30 + h * barW;
      const barH = (Math.abs(val) / maxVal) * (H - 40);
      const y = val >= 0 ? (H - 25 - barH) : (H - 25);
      ctx.fillStyle = val >= 0 ? "rgba(38, 201, 122, 0.7)" : "rgba(255, 69, 96, 0.7)";
      ctx.fillRect(x, y, barW - 2, Math.max(2, barH));

      if (h % 3 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "9px Inter";
        ctx.textAlign = "center";
        ctx.fillText(`${h}h`, x + barW / 2, H - 8);
      }
    });
  }

  function drawDailyChart() {
    const canvas = document.getElementById("journal-daily-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1) || 400;
    canvas.height = rect.height * (window.devicePixelRatio || 1) || 200;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const days = [0, 0, 0, 0, 0, 0, 0];
    const dayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

    trades.forEach(t => {
      const d = new Date(t.date).getDay();
      const idx = d === 0 ? 6 : d - 1;
      days[idx] += t.pnl;
    });

    const maxVal = Math.max(10, ...days.map(v => Math.abs(v)));
    const barW = (W - 50) / 7;

    days.forEach((val, i) => {
      const x = 35 + i * barW;
      const barH = (Math.abs(val) / maxVal) * (H - 50);
      const y = val >= 0 ? (H - 30 - barH) : (H - 30);
      ctx.fillStyle = val >= 0 ? "#26c97a" : "#ff4560";
      ctx.fillRect(x + 6, y, barW - 12, Math.max(2, barH));

      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px Inter";
      ctx.textAlign = "center";
      ctx.fillText(dayNames[i], x + barW / 2, H - 10);
    });
  }

  function renderCoinsBreakdown() {
    const el = document.getElementById("journal-coins-breakdown");
    if (!el) return;

    const coinMap = {};
    trades.forEach(t => {
      if (!coinMap[t.symbol]) coinMap[t.symbol] = { pnl: 0, wins: 0, total: 0 };
      coinMap[t.symbol].pnl += t.pnl;
      coinMap[t.symbol].total++;
      if (t.pnl >= 0) coinMap[t.symbol].wins++;
    });

    const sorted = Object.entries(coinMap).sort((a, b) => b[1].pnl - a[1].pnl);

    if (!sorted.length) {
      el.innerHTML = `<div style="color:var(--t3); font-size:12px;">Нет данных</div>`;
      return;
    }

    el.innerHTML = sorted.map(([sym, stat]) => {
      const isWin = stat.pnl >= 0;
      const wr = ((stat.wins / stat.total) * 100).toFixed(0);
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:var(--bg3); border-radius:6px; font-size:12px;">
          <span style="font-weight:700; color:#fff;">${sym} <span style="font-size:10px; color:var(--t2); font-weight:normal;">(${stat.total} сдел., WR ${wr}%)</span></span>
          <span style="font-weight:700; color:${isWin ? 'var(--gr)' : 'var(--rd)'};">${isWin ? '+' : ''}$${stat.pnl.toFixed(2)}</span>
        </div>
      `;
    }).join("");
  }

  function renderTagsBreakdown() {
    const el = document.getElementById("journal-tags-breakdown");
    if (!el) return;

    const tagMap = {};
    trades.forEach(t => {
      (t.tags || []).forEach(tag => {
        if (!tagMap[tag]) tagMap[tag] = { pnl: 0, wins: 0, total: 0 };
        tagMap[tag].pnl += t.pnl;
        tagMap[tag].total++;
        if (t.pnl >= 0) tagMap[tag].wins++;
      });
    });

    const sorted = Object.entries(tagMap).sort((a, b) => b[1].pnl - a[1].pnl);

    if (!sorted.length) {
      el.innerHTML = `<div style="color:var(--t3); font-size:12px;">Нет данных по категориям</div>`;
      return;
    }

    el.innerHTML = sorted.map(([tag, stat]) => {
      const tInfo = MISTAKE_TAGS.find(m => m.id === tag) || { label: tag, color: "#7c3aed" };
      const isWin = stat.pnl >= 0;
      const wr = ((stat.wins / stat.total) * 100).toFixed(0);
      return `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:var(--bg3); border-radius:6px; font-size:12px;">
          <span class="j-tag-pill" style="background:${tInfo.color}22; color:${tInfo.color}; border:1px solid ${tInfo.color}44;">${tInfo.label} (${stat.total})</span>
          <span style="font-weight:700; color:${isWin ? 'var(--gr)' : 'var(--rd)'};">${isWin ? '+' : ''}$${stat.pnl.toFixed(2)} (WR ${wr}%)</span>
        </div>
      `;
    }).join("");
  }

  // ── TRADER MAKE MONEY STYLE INTERACTIVE CHART VISUALIZER ──────────────────
  if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      this.rect(x, y, w, h);
    };
  }

  let chartState = {
    candles: [],
    trade: null,
    scrollOffset: 0,
    candleWidth: 12,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartOffset: 0,
    dragStartMinP: 0,
    dragStartMaxP: 0,
    isDraggingYScale: false,
    yScaleStartY: 0,
    yScaleStartMinP: 0,
    yScaleStartMaxP: 0,
    customMinP: null,
    customMaxP: null,
    currentMinP: 0,
    currentMaxP: 0,
    mouseX: -1,
    mouseY: -1,
    canvas: null,
    tool: "none",
    drawings: [],
    draft: null,
    drawingPhase: 0,
    dragDrawing: null,
    hoverDrawingIdx: -1,
    brushWidth: 2,
    toolColors: {
      "h-ray": "#a78bfa",
      "line": "#38bdf8",
      "rect": "#facc15",
      "brush": "#4ade80",
      "ruler": "#fb923c",
      "fibgrid": "#f472b6"
    }
  };

  function loadJournalDrawings(tradeId) {
    if (!tradeId) return [];
    try {
      const raw = localStorage.getItem("crypto_j_drawings_" + tradeId);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveJournalDrawings(tradeId, drawings) {
    if (!tradeId) return;
    try {
      if (drawings && drawings.length) {
        localStorage.setItem("crypto_j_drawings_" + tradeId, JSON.stringify(drawings));
      } else {
        localStorage.removeItem("crypto_j_drawings_" + tradeId);
      }
    } catch {}
  }

  function setJournalTool(tool) {
    if (tool === chartState.tool && tool !== "none") tool = "none";
    chartState.tool = tool;
    chartState.draft = null;
    chartState.drawingPhase = 0;
    document.querySelectorAll(".j-dt-btn[data-j-tool]").forEach(b => {
      b.classList.toggle("on", b.dataset.jTool === tool);
    });
    if (chartState.canvas) {
      renderInteractiveChart(chartState.canvas);
    }
  }

  function jScreenFromPoint(pt, candles, state, minP, pRange, PRICE_H, TOP_MARGIN) {
    if (!pt) return { x: 0, y: 0 };
    let idx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < candles.length; i++) {
      const d = Math.abs(candles[i].t - pt.t);
      if (d < bestDist) {
        bestDist = d;
        idx = i;
      }
    }
    if (idx < 0) idx = 0;
    const x = idx * state.candleWidth - state.scrollOffset + state.candleWidth / 2;
    const y = TOP_MARGIN + (1 - (pt.p - minP) / pRange) * PRICE_H;
    return { x, y };
  }

  function jPointFromMouse(e, canvas, rect, candles, state, minP, pRange, PRICE_H, TOP_MARGIN) {
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const p = state.currentMaxP - ((mouseY - TOP_MARGIN) / PRICE_H) * pRange;
    const candleIdx = Math.max(0, Math.min(candles.length - 1, Math.round((mouseX + state.scrollOffset - state.candleWidth / 2) / state.candleWidth)));
    const t = candles[candleIdx]?.t || 0;
    return { t, p: +p.toFixed(6) };
  }

  function jHitDrawing(drawing, px, py, candles, state, minP, pRange, PRICE_H, TOP_MARGIN) {
    if (!drawing?.a) return null;
    const p1 = jScreenFromPoint(drawing.a, candles, state, minP, pRange, PRICE_H, TOP_MARGIN);
    if (Math.hypot(px - p1.x, py - p1.y) <= 10) return "p1";
    if (drawing.type === "h-ray") {
      if (px >= p1.x && Math.abs(py - p1.y) <= 8) return "move";
      return null;
    }
    if (drawing.b) {
      const p2 = jScreenFromPoint(drawing.b, candles, state, minP, pRange, PRICE_H, TOP_MARGIN);
      if (Math.hypot(px - p2.x, py - p2.y) <= 10) return "p2";
      if (drawing.type === "line" || drawing.type === "ruler") {
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = dx * dx + dy * dy;
        const dist = len === 0 ? Math.hypot(px - p1.x, py - p1.y) :
          Math.hypot(px - (p1.x + Math.max(0, Math.min(1, ((px - p1.x) * dx + (py - p1.y) * dy) / len)) * dx),
                     py - (p1.y + Math.max(0, Math.min(1, ((px - p1.x) * dx + (py - p1.y) * dy) / len)) * dy));
        if (dist <= 8) return "move";
      } else if (drawing.type === "rect") {
        const rx = Math.min(p1.x, p2.x), ry = Math.min(p1.y, p2.y);
        const rw = Math.abs(p2.x - p1.x), rh = Math.abs(p2.y - p1.y);
        if (px >= rx - 4 && px <= rx + rw + 4 && py >= ry - 4 && py <= ry + rh + 4) return "move";
      } else if (drawing.type === "fibgrid") {
        const rx = Math.min(p1.x, p2.x), rw = Math.abs(p2.x - p1.x);
        if (px >= rx - 8 && px <= rx + rw + 16) {
          for (const lev of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
            const ly = p1.y + (p2.y - p1.y) * lev;
            if (Math.abs(py - ly) <= 6) return "move";
          }
        }
      }
    }
    if (drawing.type === "brush" && drawing.points?.length) {
      for (let i = 0; i < drawing.points.length; i++) {
        const pt = jScreenFromPoint(drawing.points[i], candles, state, minP, pRange, PRICE_H, TOP_MARGIN);
        if (Math.hypot(px - pt.x, py - pt.y) <= 8) return "move";
      }
    }
    return null;
  }

  function drawJournalDrawings(ctx, drawings, candles, state, minP, pRange, PRICE_H, TOP_MARGIN, CHART_W, formatAxisP) {
    if (!drawings || !drawings.length) return;
    drawings.forEach(d => {
      if (!d || !d.a) return;
      ctx.save();
      const col = d.color || "#38bdf8";
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.4;

      const p1 = jScreenFromPoint(d.a, candles, state, minP, pRange, PRICE_H, TOP_MARGIN);

      if (d.type === "h-ray") {
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(CHART_W, p1.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 3.5, 0, Math.PI * 2);
        ctx.fill();

        // Right axis price badge
        ctx.save();
        const tagH = 16, tagW = 66;
        const tagX = CHART_W + 4, tagY = p1.y - tagH / 2;
        ctx.fillStyle = "#151722";
        ctx.fillRect(tagX, tagY, tagW, tagH);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(tagX, tagY, tagW, tagH);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 9px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(formatAxisP(d.a.p), tagX + tagW / 2, p1.y);
        ctx.restore();
      } else if (d.type === "brush" && d.points?.length) {
        ctx.lineWidth = d.lineWidth || 2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        d.points.forEach((pt, i) => {
          const s = jScreenFromPoint(pt, candles, state, minP, pRange, PRICE_H, TOP_MARGIN);
          if (i === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.stroke();
      } else if (d.b) {
        const p2 = jScreenFromPoint(d.b, candles, state, minP, pRange, PRICE_H, TOP_MARGIN);
        if (d.type === "line") {
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(p1.x, p1.y, 3.5, 0, Math.PI * 2);
          ctx.arc(p2.x, p2.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (d.type === "rect") {
          const rx = Math.min(p1.x, p2.x);
          const ry = Math.min(p1.y, p2.y);
          const rw = Math.abs(p2.x - p1.x);
          const rh = Math.abs(p2.y - p1.y);
          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.fillRect(rx, ry, rw, rh);
          ctx.globalAlpha = 0.85;
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.restore();
        } else if (d.type === "ruler") {
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          const change = d.a.p > 0 ? ((d.b.p - d.a.p) / d.a.p * 100) : 0;
          const bars = Math.round(Math.abs(p2.x - p1.x) / state.candleWidth);
          const label = `${change >= 0 ? "+" : ""}${change.toFixed(2)}% · ${bars} св.`;
          ctx.font = "bold 9.5px Inter";
          const tw = ctx.measureText(label).width;
          const midX = (p1.x + p2.x) / 2;
          const midY = (p1.y + p2.y) / 2;
          ctx.save();
          ctx.fillStyle = "rgba(18, 20, 30, 0.94)";
          ctx.fillRect(midX - tw / 2 - 6, midY - 18, tw + 12, 18);
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.strokeRect(midX - tw / 2 - 6, midY - 18, tw + 12, 18);
          ctx.fillStyle = col;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, midX, midY - 9);
          ctx.restore();
        } else if (d.type === "fibgrid") {
          const xMin = Math.min(p1.x, p2.x);
          const xMax = Math.max(p1.x, p2.x);
          const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          levels.forEach(lev => {
            const ly = p1.y + (p2.y - p1.y) * lev;
            ctx.save();
            ctx.globalAlpha = lev === 0 || lev === 1 ? 0.9 : 0.5;
            ctx.setLineDash(lev === 0 || lev === 1 ? [] : [3, 3]);
            ctx.beginPath();
            ctx.moveTo(xMin, ly);
            ctx.lineTo(xMax, ly);
            ctx.stroke();
            ctx.font = "8.5px Inter";
            ctx.textAlign = "left";
            ctx.fillText(String(lev), xMax + 4, ly + 3);
            ctx.restore();
          });
        }
      }
      ctx.restore();
    });
  }

  function applyJournalToolButtonColors() {
    document.querySelectorAll(".j-dt-btn[data-j-tool]").forEach(btn => {
      const tool = btn.dataset.jTool;
      if (tool === "none") btn.style.removeProperty("--tool-accent");
      else btn.style.setProperty("--tool-accent", chartState.toolColors[tool] || "#38bdf8");
    });
  }

  function setupJournalDrawToolbar() {
    applyJournalToolButtonColors();
    document.querySelectorAll(".j-dt-btn[data-j-tool]").forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        setJournalTool(btn.dataset.jTool);
      };
    });
    const clearBtn = document.getElementById("j-clear-draw");
    if (clearBtn) {
      clearBtn.onclick = (e) => {
        e.stopPropagation();
        if (!chartState.drawings.length) return;
        if (confirm("Очистить все рисунки на этом графике?")) {
          chartState.drawings = [];
          if (chartState.trade) {
            saveJournalDrawings(chartState.trade.id, []);
          }
          renderInteractiveChart(chartState.canvas);
        }
      };
    }
  }

  async function openTradeChartModal(tradeId) {
    const trade = trades.find(t => t.id === tradeId);
    if (!trade) return;
    currentViewingTrade = trade;

    const modal = document.getElementById("journal-chart-modal");
    const titleEl = document.getElementById("j-chart-modal-title");
    const detailsEl = document.getElementById("j-chart-modal-details");
    const canvas = document.getElementById("journal-trade-candle-canvas");
    if (!modal || !canvas || !titleEl || !detailsEl) return;

    chartState.canvas = canvas;
    chartState.trade = trade;
    chartState.drawings = loadJournalDrawings(trade.id);
    chartState.draft = null;
    chartState.drawingPhase = 0;
    chartState.dragDrawing = null;
    setJournalTool("none");
    applyJournalToolButtonColors();

    // Executions are attached to one round trip by the server aggregator.
    const relatedExecs = (Array.isArray(trade.executions) ? trade.executions : []).map(item => ({
      ...item,
      side: String(item.side || "").toUpperCase(),
      entry: Number(item.price) || 0,
      exit: Number(item.price) || 0,
      size: Number(item.qty || item.size) || 0,
      date: item.date || new Date(Number(item.time) || Date.now()).toISOString().slice(0, 16).replace("T", " "),
      pnl: Number(item.pnl) || 0,
      fee: Number(item.fee) || 0,
    }));
    if (!relatedExecs.length) {
      const openingSide = trade.side === "SHORT" ? "SELL" : "BUY";
      const closingSide = openingSide === "BUY" ? "SELL" : "BUY";
      relatedExecs.push(
        { side: openingSide, entry: +trade.entry, exit: +trade.entry, size: +trade.size, date: trade.date, pnl: 0, fee: 0 },
        { side: closingSide, entry: +trade.exit, exit: +trade.exit, size: +trade.size, date: trade.date, pnl: +trade.pnl || 0, fee: +trade.fee || 0 }
      );
    }

    // Separate buys and sells
    const buys = relatedExecs.filter(t => t.side === "BUY");
    const sells = relatedExecs.filter(t => t.side === "SELL");

    // If no separation found, use the primary trade
    if (buys.length === 0 && sells.length === 0) {
      buys.push(trade);
    }

    // Compute weighted average entry
    const totalQty = Number(trade.size) || 0;
    const avgEntry = Number(trade.entry) || 0;

    // Total PnL
    const totalPnl = Number(trade.pnl) || 0;

    // Store executions for chart rendering
    chartState.executions = relatedExecs.map(t => ({
      side: t.side,
      positionSide: t.positionSide || trade.side || "BOTH",
      price: t.entry || t.exit,
      size: t.size,
      qty: t.size,
      time: Number(t.time) || Date.parse(String(t.date || "").replace(" ", "T") + ":00Z"),
      date: t.date,
      pnl: t.pnl,
      fee: t.fee
    }));
    chartState.avgEntry = avgEntry;

    const isWin = totalPnl >= 0;

    titleEl.textContent = `${trade.symbol} (${trade.exchange})`;

    // Populate PnL summary grid
    detailsEl.innerHTML = `
      <div><span style="color:rgba(255,255,255,0.45)">Направление</span><br><span class="${trade.side === 'LONG' ? 'j-pnl-win' : 'j-pnl-loss'}" style="font-weight:700;">${trade.side}</span></div>
      <div><span style="color:rgba(255,255,255,0.45)">PnL</span><br><span class="${isWin ? 'j-pnl-win' : 'j-pnl-loss'}" style="font-weight:700;">${isWin ? '+' : ''}$${totalPnl.toFixed(2)} (${trade.pnlPercent}%)</span></div>
      <div><span style="color:rgba(255,255,255,0.45)">Вход (Avg)</span><br><span style="color:#fff; font-weight:600;">$${avgEntry.toFixed(avgEntry > 10 ? 2 : 5)}</span></div>
      <div><span style="color:rgba(255,255,255,0.45)">Выход</span><br><span style="color:#fff; font-weight:600;">$${trade.exit}</span></div>
      <div><span style="color:rgba(255,255,255,0.45)">Объем</span><br><span style="color:#fff;">${totalQty || trade.size}</span></div>
      <div><span style="color:rgba(255,255,255,0.45)">Комиссия</span><br><span style="color:#fff;">$${(relatedExecs.reduce((s, t) => s + (t.fee || 0), 0)).toFixed(2)}</span></div>
    `;

    // Populate execution table with ALL fills (TMM style)
    const tbody = document.getElementById("j-chart-exec-tbody");
    if (tbody) {
      let rows = "";
      // Show all buys
      buys.forEach(b => {
        const t = b.date || "";
        const time = t.includes(" ") ? t.split(" ")[1] : t;
        const vol = ((parseFloat(b.entry) || 0) * (parseFloat(b.size) || 0)).toFixed(2);
        rows += `<tr style="color:#fff; border-bottom:1px solid rgba(255,255,255,0.04);">
          <td style="padding:5px 2px;"><span style="color:#26c97a;">↑ BUY</span> <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff4560;margin-left:2px;"></span></td>
          <td style="padding:5px 2px;">${time || "—"}</td>
          <td style="padding:5px 2px;">$${b.entry}</td>
          <td style="padding:5px 2px;">${vol}</td>
          <td style="padding:5px 2px;">0</td>
        </tr>`;
      });
      // Show all sells
      sells.forEach(s => {
        const t = s.date || "";
        const time = t.includes(" ") ? t.split(" ")[1] : t;
        const vol = ((parseFloat(s.exit) || parseFloat(s.entry) || 0) * (parseFloat(s.size) || 0)).toFixed(2);
        const pnlVal = s.pnl || 0;
        rows += `<tr style="color:#fff; border-bottom:1px solid rgba(255,255,255,0.04);">
          <td style="padding:5px 2px;"><span style="color:#ff4560;">↓ SELL</span> <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff4560;margin-left:2px;"></span></td>
          <td style="padding:5px 2px;">${time || "—"}</td>
          <td style="padding:5px 2px;">$${s.exit || s.entry}</td>
          <td style="padding:5px 2px;">${vol}</td>
          <td style="padding:5px 2px;"><span class="${pnlVal >= 0 ? 'j-pnl-win' : 'j-pnl-loss'}">${pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(2)}&nbsp;$</span></td>
        </tr>`;
      });
      // If no separate sells found, add one from primary trade
      if (sells.length === 0 && trade.exit > 0) {
        const t = trade.date || "";
        const time = t.includes(" ") ? t.split(" ")[1] : t;
        const vol = ((trade.exit || 0) * (totalQty || trade.size || 0)).toFixed(2);
        rows += `<tr style="color:#fff; border-bottom:1px solid rgba(255,255,255,0.04);">
          <td style="padding:5px 2px;"><span style="color:#ff4560;">↓ SELL</span> <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ff4560;margin-left:2px;"></span></td>
          <td style="padding:5px 2px;">${time || "—"}</td>
          <td style="padding:5px 2px;">$${trade.exit}</td>
          <td style="padding:5px 2px;">${vol}</td>
          <td style="padding:5px 2px;"><span class="${totalPnl >= 0 ? 'j-pnl-win' : 'j-pnl-loss'}">${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}&nbsp;$</span></td>
        </tr>`;
      }
      tbody.innerHTML = rows;
    }

    // Populate description/conclusion
    const descEl = document.getElementById("j-chart-description");
    const concEl = document.getElementById("j-chart-conclusion");
    if (descEl) descEl.value = trade.note || "";
    if (concEl) concEl.value = "";

    // 1. Draw smooth dark loading state on canvas
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = (rect.width || 900) * dpr;
    canvas.height = (rect.height || 460) * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, rect.width || 900, rect.height || 460);
    ctx.fillStyle = "rgba(107,114,128,0.75)";
    ctx.font = "13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Загрузка графика " + (trade.symbol || "") + "...", (rect.width || 900) / 2, (rect.height || 460) / 2);

    modal.style.display = "flex";
    setupTradeChartEvents(canvas);
    setupJournalTfButtons();

    const duration = Math.max(0, Number(trade.durationMs) || ((Number(trade.exitTime) || 0) - (Number(trade.entryTime) || 0)));
    const initialTf = duration <= 20 * 60_000 ? "1m" : duration <= 2 * 3600_000 ? "5m" : duration <= 12 * 3600_000 ? "15m" : "1h";
    await loadJournalTradeCandles(trade, initialTf);
  }

  const journalCandlesCache = new Map();

  async function loadJournalTradeCandles(trade, tf = "1m") {
    if (!trade) return;
    const canvas = document.getElementById("journal-trade-candle-canvas");
    if (!canvas) return;

    chartState.tf = tf;
    updateJournalTfButtons(tf);

    const cacheKey = `${trade.id}:${tf}`;
    if (journalCandlesCache.has(cacheKey)) {
      const cached = journalCandlesCache.get(cacheKey);
      if (cached && cached.length > 0) {
        chartState.candles = cached;
        resetChartViewState(canvas);
        renderInteractiveChart(canvas);
        return;
      }
    }

    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    if (chartState.candles && chartState.candles.length > 0) {
      // Draw lightweight semi-transparent loader over existing candles
      ctx.save();
      ctx.fillStyle = "rgba(11, 14, 20, 0.65)";
      ctx.fillRect(0, 0, rect.width || 900, rect.height || 460);
      ctx.fillStyle = "#8b5cf6";
      ctx.font = "600 13px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Загрузка " + tf + "...", (rect.width || 900) / 2, (rect.height || 460) / 2);
      ctx.restore();
    }

    try {
      const exMap = {
        Binance: "BN", Bybit: "BB", OKX: "OX", Bitget: "BG", Gate: "GT", "Gate.io": "GT",
        MEXC: "MX", KuCoin: "KC", BingX: "BX", Hyperliquid: "HL", HTX: "HT",
        BN: "BN", BB: "BB", OX: "OX", BG: "BG", GT: "GT", MX: "MX", KC: "KC", BX: "BX", HL: "HL", HT: "HT"
      };
      const exCode = exMap[trade.exchange] || "BN";

      const tfMsMap = {
        "1s": 1000, "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000
      };
      const tfMs = tfMsMap[tf] || 60000;

      // Determine trade timestamp for historical centering
      let tradeTs = Number(trade.exitTime) || Number(trade.entryTime) || 0;
      if (!tradeTs && trade.date) {
        tradeTs = new Date(trade.date.replace(" ", "T") + (trade.date.includes("Z") ? "" : "Z")).getTime();
        if (isNaN(tradeTs)) tradeTs = new Date(trade.date).getTime();
      }

      // If trade is older than 6 hours, calculate before timestamp to capture historical trade
      const isPast = tradeTs > 0 && (Date.now() - tradeTs > 6 * 3600000);
      const beforeTs = isPast ? tradeTs + 150 * tfMs : null;

      // Fast parallel racer: Direct Exchange API (sub-40ms) vs Server Proxy
      const directPromise = fetchDirectJournalKlines(exCode, trade.symbol, tf, beforeTs).then(c => (c && c.length > 0 ? c : Promise.reject()));
      const serverUrl = `/api/klines?ex=${exCode}&sym=${encodeURIComponent(trade.symbol)}&tf=${tf === "1s" ? "1m" : tf}&lite=1${beforeTs ? `&before=${beforeTs}` : ""}`;
      const serverPromise = fetch(serverUrl).then(r => r.json()).then(rawKlines => {
        const parsed = [];
        if (Array.isArray(rawKlines) && rawKlines.length > 0) {
          if (typeof rawKlines[0] === "object" && rawKlines[0] !== null && "t" in rawKlines[0]) {
            parsed.push(...rawKlines);
          } else {
            for (let i = 0; i < rawKlines.length; i += 6) {
              parsed.push({
                t: Number(rawKlines[i]),
                o: Number(rawKlines[i+1]),
                h: Number(rawKlines[i+2]),
                l: Number(rawKlines[i+3]),
                c: Number(rawKlines[i+4]),
                v: Number(rawKlines[i+5]) || 0
              });
            }
          }
        }
        return parsed.length > 0 ? parsed : Promise.reject();
      });

      let candles = [];
      try {
        candles = await Promise.any([directPromise, serverPromise]);
      } catch (_) {
        try {
          candles = await fetchDirectJournalKlines(exCode, trade.symbol, tf, null);
        } catch (__) {
          candles = [];
        }
      }

      if (candles && candles.length > 0) {
        journalCandlesCache.set(cacheKey, candles);
        chartState.candles = candles;
        resetChartViewState(canvas);
        renderInteractiveChart(canvas);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#0b0e14";
        ctx.fillRect(0, 0, rect.width || 900, rect.height || 460);
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "13px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Нет данных графика для " + tf, (rect.width || 900) / 2, (rect.height || 460) / 2);
      }
    } catch (e) {
      console.warn("Failed to load trade candles:", e);
    }
  }

  function updateJournalTfButtons(activeTf) {
    const btns = document.querySelectorAll("#j-chart-tf-group .j-tf-btn");
    btns.forEach(btn => {
      if (btn.dataset.tf === activeTf) {
        btn.classList.add("on");
      } else {
        btn.classList.remove("on");
      }
    });
  }

  function setupJournalTfButtons() {
    const group = document.getElementById("j-chart-tf-group");
    if (!group || group._hasEvents) return;
    group._hasEvents = true;
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".j-tf-btn");
      if (!btn || !btn.dataset.tf || !currentViewingTrade) return;
      loadJournalTradeCandles(currentViewingTrade, btn.dataset.tf);
    });
  }

  async function fetchDirectJournalKlines(ex, sym, tf, beforeTs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    try {
      let resultCandles = [];
      const cleanSym = String(sym || "").replace(/_SPOT$/i, "").toUpperCase();
      const encSym = encodeURIComponent(cleanSym);
      const tfMs = tf === "1s" ? 1000 : (tf === "1m" ? 60000 : tf === "5m" ? 300000 : tf === "15m" ? 900000 : tf === "1h" ? 3600000 : tf === "4h" ? 14400000 : 86400000);
      const endTs = beforeTs && Number.isFinite(beforeTs) && beforeTs > 0 ? beforeTs : Date.now();

      if (ex === "BN" || ex === "AD") {
        const endParam = beforeTs ? `&endTime=${endTs}` : "";
        const tfParam = tf === "1s" ? "1s" : tf;
        // 1. Ultra-fast Binance Vision Public API (CORS enabled everywhere, sub-30ms)
        let r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${encSym}&interval=${tfParam}&limit=1000${endParam}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        if (!Array.isArray(r) || r.length === 0) {
          r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${encSym}&interval=${tfParam === "1s" ? "1m" : tfParam}&limit=1000${endParam}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        }
        if (!Array.isArray(r) || r.length === 0) {
          r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${encSym}&interval=${tfParam}&limit=1000${endParam}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        }
        if (Array.isArray(r) && r.length > 0) {
          resultCandles = r.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] || +k[5] || 0 }));
        }
      } else if (ex === "BB") {
        const bbTfMap = { "1s": "1", "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
        const endParam = beforeTs ? `&end=${endTs}` : "";
        const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encSym}&interval=${bbTfMap[tf] || "1"}&limit=1000${endParam}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        const list = r?.result?.list || [];
        if (Array.isArray(list) && list.length > 0) {
          resultCandles = list.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] || 0 })).reverse();
        }
      } else if (ex === "OX") {
        const oxTfMap = { "1s": "1m", "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
        const afterParam = beforeTs ? `&after=${endTs}` : "";
        const oxSym = cleanSym.includes("-") ? cleanSym : `${cleanSym.replace(/USDT$/, "")}-USDT-SWAP`;
        const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(oxSym)}&bar=${oxTfMap[tf] || "1m"}&limit=300${afterParam}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        const data = r?.data || [];
        if (Array.isArray(data) && data.length > 0) {
          resultCandles = data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] || +k[6] || +k[5] || 0 })).reverse();
        }
      } else if (ex === "BG") {
        const bgTfMap = { "1s": "1m", "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
        const endParam = beforeTs ? `&endTime=${endTs}` : "";
        const bgSym = cleanSym.endsWith("USDT") ? `${cleanSym}_UMCBL` : cleanSym;
        const r = await fetch(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${encodeURIComponent(bgSym)}&granularity=${bgTfMap[tf] || "1m"}&limit=1000${endParam}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        const data = r?.data || [];
        if (Array.isArray(data) && data.length > 0) {
          resultCandles = data.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] || +k[5] || 0 })).reverse();
        }
      } else if (ex === "GT") {
        const endParam = beforeTs ? `&to=${Math.floor(endTs / 1000)}` : "";
        const gtTfMap = { "1s": "1m", "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
        const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encSym}&interval=${gtTfMap[tf] || "1m"}&limit=1000${endParam}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        if (Array.isArray(r) && r.length > 0) {
          resultCandles = r.map(k => ({ t: +k.t * 1000, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +(k.a || k.v) || 0 }));
        }
      } else if (ex === "MX") {
        const mxSym = cleanSym.includes("_") ? cleanSym : (cleanSym.endsWith("USDT") ? cleanSym.replace(/USDT$/i, "_USDT") : cleanSym + "_USDT");
        const mxTfMap = { "1s": "Min1", "1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1" };
        const startSec = Math.floor((endTs - 1000 * tfMs) / 1000);
        const endSec = Math.floor(endTs / 1000);
        const r = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${encodeURIComponent(mxSym)}?interval=${mxTfMap[tf] || "Min1"}&start=${startSec}&end=${endSec}`, { signal: controller.signal }).then(res => res.json()).catch(() => null);
        if (r?.data?.time) {
          resultCandles = r.data.time.map((t, i) => ({ t: t * 1000, o: +r.data.open[i], h: +r.data.high[i], l: +r.data.low[i], c: +r.data.close[i], v: +(r.data.amount?.[i] || r.data.vol?.[i] || 0) }));
        }
      }
      return resultCandles.filter(c => c && Number.isFinite(c.t) && c.o > 0 && c.c > 0);
    } catch (_) {
      return [];
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function setupTradeChartEvents(canvas) {

    if (canvas._hasInteractiveEvents) return;
    canvas._hasInteractiveEvents = true;

    setupJournalDrawToolbar();

    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const RIGHT_MARGIN = 75;
      const CHART_W = rect.width - RIGHT_MARGIN;
      const H = rect.height;
      const BOTTOM_MARGIN = 30, TOP_MARGIN = 15;
      const PRICE_H = (H - BOTTOM_MARGIN - TOP_MARGIN) * 0.82;
      const candles = chartState.candles || [];
      const minP = chartState.currentMinP;
      const pRange = (chartState.currentMaxP - minP) || 1;

      // If drafting a drawing -> cancel draft
      if (chartState.drawingPhase > 0 || chartState.draft) {
        chartState.draft = null;
        chartState.drawingPhase = 0;
        setJournalTool("none");
        renderInteractiveChart(canvas);
        return;
      }

      // Check if right-clicking an existing drawing -> delete it
      if (mouseX < CHART_W) {
        for (let i = chartState.drawings.length - 1; i >= 0; i--) {
          const hit = jHitDrawing(chartState.drawings[i], mouseX, mouseY, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN);
          if (hit) {
            chartState.drawings.splice(i, 1);
            if (chartState.trade) saveJournalDrawings(chartState.trade.id, chartState.drawings);
            renderInteractiveChart(canvas);
            return;
          }
        }
      }
    });

    canvas.addEventListener("mousedown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const RIGHT_MARGIN = 75;
      const CHART_W = rect.width - RIGHT_MARGIN;
      const H = rect.height;
      const BOTTOM_MARGIN = 30, TOP_MARGIN = 15;
      const PRICE_H = (H - BOTTOM_MARGIN - TOP_MARGIN) * 0.82;
      const candles = chartState.candles || [];
      const minP = chartState.currentMinP;
      const pRange = (chartState.currentMaxP - minP) || 1;

      if (e.button !== 0) return;

      // ── DRAWING TOOLS ACTIVE ──────────────────────────────────────────────
      if (chartState.tool && chartState.tool !== "none" && mouseX < CHART_W) {
        const pt = jPointFromMouse(e, canvas, rect, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN);
        const tool = chartState.tool;

        if (tool === "h-ray") {
          chartState.drawings.push({
            type: "h-ray",
            color: chartState.toolColors["h-ray"],
            a: pt,
            b: { ...pt }
          });
          if (chartState.trade) saveJournalDrawings(chartState.trade.id, chartState.drawings);
          setJournalTool("none");
          renderInteractiveChart(canvas);
          return;
        }

        if (tool === "brush") {
          chartState.draft = {
            type: "brush",
            color: chartState.toolColors["brush"],
            lineWidth: chartState.brushWidth || 2,
            a: pt,
            points: [pt]
          };
          chartState.drawingPhase = 1;
          renderInteractiveChart(canvas);
          return;
        }

        if (tool === "ruler") {
          chartState.draft = {
            type: "ruler",
            color: chartState.toolColors["ruler"],
            a: pt,
            b: { ...pt }
          };
          chartState.drawingPhase = 1;
          renderInteractiveChart(canvas);
          return;
        }

        // 2-point tools: line, rect, fibgrid
        if (chartState.drawingPhase === 0) {
          chartState.draft = {
            type: tool,
            color: chartState.toolColors[tool],
            a: pt,
            b: { ...pt }
          };
          chartState.drawingPhase = 1;
          renderInteractiveChart(canvas);
          return;
        } else {
          chartState.draft.b = pt;
          chartState.drawings.push({ ...chartState.draft });
          if (chartState.trade) saveJournalDrawings(chartState.trade.id, chartState.drawings);
          chartState.draft = null;
          chartState.drawingPhase = 0;
          setJournalTool("none");
          renderInteractiveChart(canvas);
          return;
        }
      }

      // ── CURSOR MODE (tool === "none") ─────────────────────────────────────
      // Check if clicking on an existing drawing handle or body to drag/move it
      if (chartState.tool === "none" && mouseX < CHART_W) {
        for (let i = chartState.drawings.length - 1; i >= 0; i--) {
          const hit = jHitDrawing(chartState.drawings[i], mouseX, mouseY, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN);
          if (hit) {
            const d = chartState.drawings[i];
            const pt = jPointFromMouse(e, canvas, rect, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN);
            chartState.dragDrawing = {
              idx: i,
              handle: hit,
              startPoint: pt,
              a: { ...d.a },
              b: d.b ? { ...d.b } : null,
              points: d.points ? d.points.map(p => ({ ...p })) : null
            };
            canvas.style.cursor = "grabbing";
            return;
          }
        }
      }

      // Click on Price Scale -> drag to expand / compress vertically
      if (mouseX >= CHART_W) {
        chartState.isDraggingYScale = true;
        chartState.yScaleStartY = e.clientY;
        chartState.yScaleStartMinP = chartState.currentMinP;
        chartState.yScaleStartMaxP = chartState.currentMaxP;
        canvas.style.cursor = "ns-resize";
        return;
      }

      chartState.isDragging = true;
      chartState.dragStartX = e.clientX;
      chartState.dragStartY = e.clientY;
      chartState.dragStartOffset = chartState.scrollOffset;
      chartState.dragStartMinP = chartState.currentMinP;
      chartState.dragStartMaxP = chartState.currentMaxP;
      canvas.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      chartState.mouseX = e.clientX - rect.left;
      chartState.mouseY = e.clientY - rect.top;
      const RIGHT_MARGIN = 75;
      const CHART_W = rect.width - RIGHT_MARGIN;
      const H = rect.height;
      const BOTTOM_MARGIN = 30, TOP_MARGIN = 15;
      const PRICE_H = (H - BOTTOM_MARGIN - TOP_MARGIN) * 0.82;
      const candles = chartState.candles || [];
      const minP = chartState.currentMinP;
      const pRange = (chartState.currentMaxP - minP) || 1;

      // Dragging an existing drawing
      if (chartState.dragDrawing) {
        const drag = chartState.dragDrawing;
        const d = chartState.drawings[drag.idx];
        const pt = jPointFromMouse(e, canvas, rect, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN);
        if (drag.handle === "p1") {
          d.a = pt;
        } else if (drag.handle === "p2") {
          d.b = pt;
        } else {
          const dt = pt.t - drag.startPoint.t;
          const dp = pt.p - drag.startPoint.p;
          d.a = { ...drag.a, t: drag.a.t + dt, p: drag.a.p + dp };
          if (d.b) d.b = { ...drag.b, t: drag.b.t + dt, p: drag.b.p + dp };
          if (d.points) d.points = drag.points.map(p => ({ ...p, t: p.t + dt, p: p.p + dp }));
        }
        canvas.style.cursor = "grabbing";
        renderInteractiveChart(canvas);
        return;
      }

      // In progress drawing draft
      if (chartState.draft) {
        const pt = jPointFromMouse(e, canvas, rect, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN);
        if (chartState.draft.type === "brush") {
          const last = chartState.draft.points[chartState.draft.points.length - 1];
          if (!last || last.t !== pt.t || Math.abs(last.p - pt.p) > 1e-6) {
            chartState.draft.points.push(pt);
          }
        } else {
          chartState.draft.b = pt;
        }
        renderInteractiveChart(canvas);
        return;
      }

      if (chartState.isDraggingYScale) {
        const dy = e.clientY - chartState.yScaleStartY;
        const center = (chartState.yScaleStartMinP + chartState.yScaleStartMaxP) / 2;
        const baseSpan = (chartState.yScaleStartMaxP - chartState.yScaleStartMinP) / 2;
        let half = baseSpan * Math.pow(1.006, dy);
        half = Math.max(Math.abs(center) * 0.0001, Math.min(Math.abs(center) * 50, half));
        chartState.customMinP = center - half;
        chartState.customMaxP = center + half;
        renderInteractiveChart(canvas);
        return;
      }

      if (chartState.isDragging) {
        const dx = e.clientX - chartState.dragStartX;
        const dy = e.clientY - chartState.dragStartY;
        chartState.scrollOffset = chartState.dragStartOffset - dx;

        // 2D chart movement — move chart freely vertically up & down
        const pSpan = chartState.dragStartMaxP - chartState.dragStartMinP;
        if (pSpan > 0 && PRICE_H > 0) {
          const dPrice = (dy / PRICE_H) * pSpan;
          chartState.customMinP = chartState.dragStartMinP + dPrice;
          chartState.customMaxP = chartState.dragStartMaxP + dPrice;
        }
        renderInteractiveChart(canvas);
      } else {
        // Cursor appearance
        if (chartState.tool && chartState.tool !== "none") {
          canvas.style.cursor = "crosshair";
        } else if (chartState.mouseX >= CHART_W) {
          canvas.style.cursor = "ns-resize";
        } else {
          let isOverDrawing = false;
          for (let i = chartState.drawings.length - 1; i >= 0; i--) {
            if (jHitDrawing(chartState.drawings[i], chartState.mouseX, chartState.mouseY, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN)) {
              isOverDrawing = true;
              break;
            }
          }
          canvas.style.cursor = isOverDrawing ? "pointer" : "crosshair";
        }
        if (chartState.mouseX >= 0 && chartState.mouseX <= rect.width && chartState.mouseY >= 0 && chartState.mouseY <= rect.height) {
          renderInteractiveChart(canvas);
        }
      }
    });

    window.addEventListener("mouseup", () => {
      if (chartState.dragDrawing) {
        if (chartState.trade) saveJournalDrawings(chartState.trade.id, chartState.drawings);
        chartState.dragDrawing = null;
      }

      if (chartState.tool === "brush" && chartState.draft) {
        if (chartState.draft.points && chartState.draft.points.length > 1) {
          chartState.drawings.push({ ...chartState.draft });
          if (chartState.trade) saveJournalDrawings(chartState.trade.id, chartState.drawings);
        }
        chartState.draft = null;
        chartState.drawingPhase = 0;
        setJournalTool("none");
      }

      if (chartState.isDragging || chartState.isDraggingYScale) {
        chartState.isDragging = false;
        chartState.isDraggingYScale = false;
        const rect = canvas.getBoundingClientRect();
        if (chartState.mouseX >= rect.width - 75) {
          canvas.style.cursor = "ns-resize";
        } else {
          canvas.style.cursor = "crosshair";
        }
      }
      renderInteractiveChart(canvas);
    });

    canvas.addEventListener("mouseleave", () => {
      chartState.mouseX = -1;
      chartState.mouseY = -1;
      renderInteractiveChart(canvas);
    });

    canvas.addEventListener("dblclick", () => {
      chartState.customMinP = null;
      chartState.customMaxP = null;
      renderInteractiveChart(canvas);
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const RIGHT_MARGIN = 75;
      const CHART_W = rect.width - RIGHT_MARGIN;

      // Wheel on Price Scale -> Zoom Y scale
      if (mouseX >= CHART_W) {
        const zoomFactor = e.deltaY < 0 ? 0.88 : 1.14;
        const curMin = chartState.currentMinP;
        const curMax = chartState.currentMaxP;
        const center = (curMin + curMax) / 2;
        let half = ((curMax - curMin) / 2) * zoomFactor;
        half = Math.max(Math.abs(center) * 0.0001, Math.min(Math.abs(center) * 50, half));
        chartState.customMinP = center - half;
        chartState.customMaxP = center + half;
        renderInteractiveChart(canvas);
        return;
      }

      const zoomFactor = e.deltaY < 0 ? 1.2 : 0.8;
      const newWidth = Math.max(4, Math.min(60, chartState.candleWidth * zoomFactor));
      const candleUnderMouse = (chartState.scrollOffset + mouseX) / chartState.candleWidth;
      
      chartState.candleWidth = newWidth;
      chartState.scrollOffset = (candleUnderMouse * newWidth) - mouseX;
      renderInteractiveChart(canvas);
    }, { passive: false });

    const resetBtn = document.getElementById("j-chart-reset-btn");
    const zoomInBtn = document.getElementById("j-chart-zoomin-btn");
    const zoomOutBtn = document.getElementById("j-chart-zoomout-btn");

    if (resetBtn) {
      resetBtn.onclick = () => {
        chartState.customMinP = null;
        chartState.customMaxP = null;
        resetChartViewState(canvas);
        renderInteractiveChart(canvas);
      };
    }
    if (zoomInBtn) {
      zoomInBtn.onclick = () => {
        chartState.candleWidth = Math.min(60, chartState.candleWidth * 1.25);
        renderInteractiveChart(canvas);
      };
    }
    if (zoomOutBtn) {
      zoomOutBtn.onclick = () => {
        chartState.candleWidth = Math.max(4, chartState.candleWidth * 0.8);
        renderInteractiveChart(canvas);
      };
    }
  }

  function resetChartViewState(canvas) {
    const candles = chartState.candles;
    const trade = chartState.trade;
    if (!candles.length) return;
    chartState.candleWidth = 12;
    chartState.customMinP = null;
    chartState.customMaxP = null;
    chartState.isDraggingYScale = false;
    const rect = canvas.getBoundingClientRect();
    const chartW = (rect.width || 800) - 80;

    // Find trade candle index by timestamp and center on it
    let centerIdx = candles.length - 1; // default: latest
    let tradeTs = Number(trade?.entryTime) || Number(trade?.exitTime) || 0;
    if (!tradeTs && trade && trade.date) {
      tradeTs = new Date(trade.date.replace(" ", "T") + (trade.date.includes("Z") ? "" : "Z")).getTime();
      if (isNaN(tradeTs)) tradeTs = new Date(trade.date).getTime();
    }

    if (tradeTs > 0) {
      let bestDist = Infinity;
      for (let i = 0; i < candles.length; i++) {
        const dist = Math.abs(candles[i].t - tradeTs);
        if (dist < bestDist) {
          bestDist = dist;
          centerIdx = i;
        }
      }
    }


    // Center the chart on the trade candle
    const centerX = centerIdx * chartState.candleWidth + chartState.candleWidth / 2;
    chartState.scrollOffset = Math.max(0, centerX - chartW / 2);
  }

  function renderInteractiveChart(canvas = chartState.canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr || 900 * dpr;
    canvas.height = rect.height * dpr || 460 * dpr;
    ctx.scale(dpr, dpr);

    const W = rect.width;
    const H = rect.height;
    const RIGHT_MARGIN = 75;
    const BOTTOM_MARGIN = 30;
    const TOP_MARGIN = 15;
    const CHART_W = W - RIGHT_MARGIN;
    const CHART_H = H - BOTTOM_MARGIN - TOP_MARGIN;
    const VOL_H = CHART_H * 0.18;
    const PRICE_H = CHART_H * 0.82;

    ctx.clearRect(0, 0, W, H);

    // Background fill
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(0, 0, W, H);

    const candles = chartState.candles;
    const trade = chartState.trade;
    if (!candles || !candles.length) return;

    // Clamp scroll offset
    const totalW = candles.length * chartState.candleWidth;
    chartState.scrollOffset = Math.max(0, Math.min(totalW - CHART_W / 2, chartState.scrollOffset));

    const visibleCount = Math.ceil(CHART_W / chartState.candleWidth);
    const startIndex = Math.max(0, Math.floor(chartState.scrollOffset / chartState.candleWidth));
    const endIndex = Math.min(candles.length, startIndex + visibleCount + 2);
    const visibleCandles = candles.slice(startIndex, endIndex);

    if (!visibleCandles.length) return;

    let autoMinP = Math.min(...visibleCandles.map(c => c.l));
    let autoMaxP = Math.max(...visibleCandles.map(c => c.h));
    if (trade) {
      autoMinP = Math.min(autoMinP, trade.entry * 0.995, trade.exit * 0.995);
      autoMaxP = Math.max(autoMaxP, trade.entry * 1.005, trade.exit * 1.005);
    }
    const pPad = (autoMaxP - autoMinP) * 0.08 || autoMaxP * 0.01;
    autoMinP -= pPad;
    autoMaxP += pPad;

    const minP = chartState.customMinP != null ? chartState.customMinP : autoMinP;
    const maxP = chartState.customMaxP != null ? chartState.customMaxP : autoMaxP;
    chartState.currentMinP = minP;
    chartState.currentMaxP = maxP;
    const pRange = maxP - minP || 1;
    const maxVol = Math.max(...visibleCandles.map(c => c.v || 0), 1);

    function formatAxisP(p) {
      if (p >= 1000) return p.toFixed(2);
      if (p >= 1) return p.toFixed(3);
      if (p >= 0.01) return p.toFixed(5);
      return p.toPrecision(5);
    }

    const getY = (p) => TOP_MARGIN + (1 - (p - minP) / pRange) * PRICE_H;
    const getVolY = (v) => (TOP_MARGIN + PRICE_H + VOL_H) - (v / maxVol) * VOL_H;

    // ── DRAW GRID ───────────────────────────────────────────────────────────
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);

    // Horizontal Price Grid
    const priceSteps = 6;
    for (let i = 0; i <= priceSteps; i++) {
      const p = minP + (pRange * i) / priceSteps;
      const y = getY(p);
      if (y < TOP_MARGIN - 2 || y > H - BOTTOM_MARGIN + 2) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CHART_W, y);
      ctx.stroke();

      // Right Axis Price Label
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(formatAxisP(p), CHART_W + 8, y + 3);
    }

    // Vertical Time Grid & Candles
    ctx.setLineDash([]);
    candles.forEach((c, i) => {
      const x = i * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
      if (x < -20 || x > CHART_W + 20) return;

      const isUp = c.c >= c.o;
      const color = isUp ? "#26c97a" : "#ff4560";

      // Vertical Time Line & Text (every ~10 candles)
      if (i % 10 === 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x, TOP_MARGIN);
        ctx.lineTo(x, H - BOTTOM_MARGIN);
        ctx.stroke();
        ctx.setLineDash([]);

        const dateObj = new Date(c.t);
        const timeStr = `${String(dateObj.getHours()).padStart(2,'0')}:${String(dateObj.getMinutes()).padStart(2,'0')}`;
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "10px Inter";
        ctx.textAlign = "center";
        ctx.fillText(timeStr, x, H - 10);
      }

      // Volume Bar
      const vY = getVolY(c.v || 0);
      const vH = (TOP_MARGIN + PRICE_H + VOL_H) - vY;
      ctx.fillStyle = isUp ? "rgba(38, 201, 122, 0.25)" : "rgba(255, 69, 96, 0.25)";
      ctx.fillRect(x - chartState.candleWidth * 0.35, vY, chartState.candleWidth * 0.7, Math.max(1, vH));

      // Wick
      const yH = getY(c.h);
      const yL = getY(c.l);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.stroke();

      // Body
      const yO = getY(c.o);
      const yC = getY(c.c);
      ctx.fillStyle = color;
      const bodyH = Math.max(2, Math.abs(yO - yC));
      const bodyY = Math.min(yO, yC);
      ctx.fillRect(x - chartState.candleWidth * 0.38, bodyY, chartState.candleWidth * 0.76, bodyH);
    });

    // Right Axis & Bottom Axis Container Borders
    ctx.fillStyle = "#111622";
    ctx.fillRect(CHART_W, 0, RIGHT_MARGIN, H);
    ctx.fillRect(0, H - BOTTOM_MARGIN, W, BOTTOM_MARGIN);

    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.beginPath();
    ctx.moveTo(CHART_W, 0); ctx.lineTo(CHART_W, H);
    ctx.moveTo(0, H - BOTTOM_MARGIN); ctx.lineTo(W, H - BOTTOM_MARGIN);
    ctx.stroke();

    // Redraw Right Axis Labels on top of sidebar background
    for (let i = 0; i <= priceSteps; i++) {
      const p = minP + (pRange * i) / priceSteps;
      const y = getY(p);
      if (y < TOP_MARGIN - 2 || y > H - BOTTOM_MARGIN + 2) continue;
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(formatAxisP(p), CHART_W + 8, y + 3);
    }

    // ── DRAW TMM-STYLE EXECUTIONS & PRICE LINES (FULL TMM CLONE) ──────────────
    if (trade && !window.TradeOverlay) {
      const isWin = trade.pnl >= 0;
      const executions = chartState.executions || [];
      const avgEntry = chartState.avgEntry || trade.entry || 0;
      const exitPrice = trade.exit || 0;
      const avgEntryY = getY(avgEntry);
      const exitY = exitPrice > 0 ? getY(exitPrice) : 0;
      const isLong = trade.side === "LONG" || trade.side === "BUY";
      const fmtP = (p) => p > 10 ? p.toFixed(2) : p.toFixed(4);

      // Helper: find candle index by timestamp string
      function findCandleIdx(dateStr) {
        if (!dateStr) return -1;
        const ts = new Date(dateStr.replace(" ", "T") + ":00Z").getTime();
        if (!ts || isNaN(ts)) return -1;
        let best = -1, bestDist = Infinity;
        for (let i = 0; i < candles.length; i++) {
          const d = Math.abs(candles[i].t - ts);
          if (d < bestDist) { bestDist = d; best = i; }
        }
        return best;
      }

      // Helper: draw filled arrow marker (TMM style - solid triangle)
      function drawArrowMarker(cx, cy, dir, color, size) {
        size = size || 10;
        ctx.fillStyle = color;
        ctx.beginPath();
        if (dir === 1) {
          // ▲ upward (buy)
          ctx.moveTo(cx, cy - size);
          ctx.lineTo(cx - size * 0.7, cy + size * 0.4);
          ctx.lineTo(cx + size * 0.7, cy + size * 0.4);
        } else {
          // ▼ downward (sell)
          ctx.moveTo(cx, cy + size);
          ctx.lineTo(cx - size * 0.7, cy - size * 0.4);
          ctx.lineTo(cx + size * 0.7, cy - size * 0.4);
        }
        ctx.closePath();
        ctx.fill();
        // White outline
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Helper: draw price label bubble attached to marker
      function drawPriceLabel(cx, cy, text, bgColor, dir) {
        ctx.font = "bold 10px Inter";
        const tw = ctx.measureText(text).width;
        const padX = 5, padY = 3;
        const bw = tw + padX * 2;
        const bh = 16;
        const offsetY = dir === 1 ? 8 : -(bh + 8);
        const bx = cx - bw / 2;
        const by = cy + offsetY;
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 3);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText(text, cx, by + bh - padY);
      }

      // ── RESOLVE EXECUTION CANDLE INDICES ─────────────────────────────────
      const buyExecs = [];
      const sellExecs = [];
      let fallbackOffset = 0;

      executions.forEach(exec => {
        const isBuy = exec.side === "LONG" || exec.side === "BUY";
        let idx = findCandleIdx(exec.date);
        if (idx < 0) {
          idx = Math.floor(candles.length * 0.3) + fallbackOffset;
          fallbackOffset += 3;
        }
        idx = Math.max(0, Math.min(candles.length - 1, idx));
        const resolved = { ...exec, candleIdx: idx, price: parseFloat(exec.price) || 0, qty: parseFloat(exec.size) || 0 };
        if (isBuy) buyExecs.push(resolved);
        else sellExecs.push(resolved);
      });

      // Sort buys by candle index (chronological)
      buyExecs.sort((a, b) => a.candleIdx - b.candleIdx);

      // ── COMPUTE PROGRESSIVE AVERAGE ENTRY (ТВХ) ──────────────────────────
      // Each buy shifts the average — we track it as a stepped line
      const tvxSteps = []; // { fromIdx, toIdx, avgPrice }
      let runQty = 0, runCost = 0;
      buyExecs.forEach((b, i) => {
        const prevIdx = i === 0 ? 0 : buyExecs[i - 1].candleIdx;
        runQty += b.qty || 1;
        runCost += (b.qty || 1) * (b.price || avgEntry);
        const curAvg = runQty > 0 ? runCost / runQty : avgEntry;
        const nextIdx = i < buyExecs.length - 1 ? buyExecs[i + 1].candleIdx : candles.length - 1;
        tvxSteps.push({ fromIdx: b.candleIdx, toIdx: nextIdx, avgPrice: curAvg });
      });

      // Fallback: if no buy execs resolved, just use avgEntry as flat line
      if (tvxSteps.length === 0 && avgEntry > 0) {
        tvxSteps.push({ fromIdx: 0, toIdx: candles.length - 1, avgPrice: avgEntry });
      }

      // Determine sell index
      let sellCandleIdx = -1;
      if (sellExecs.length > 0) {
        sellCandleIdx = sellExecs[sellExecs.length - 1].candleIdx;
      } else if (exitPrice > 0 && buyExecs.length > 0) {
        const lastBuyIdx = buyExecs[buyExecs.length - 1].candleIdx;
        sellCandleIdx = Math.min(candles.length - 1, lastBuyIdx + Math.max(4, Math.floor(candles.length * 0.06)));
      }

      // ── FILLED ZONE BETWEEN ТВХ AND EXIT ───────────────────────────────
      if (exitPrice > 0 && tvxSteps.length > 0 && sellCandleIdx >= 0) {
        const firstBuyIdx = tvxSteps[0].fromIdx;
        const zoneColor = isWin ? "rgba(38, 201, 122, 0.08)" : "rgba(255, 69, 96, 0.08)";
        ctx.fillStyle = zoneColor;
        ctx.beginPath();
        // Top path: along ТВХ stepped line
        let started = false;
        tvxSteps.forEach(step => {
          const fromI = Math.max(step.fromIdx, firstBuyIdx);
          const toI = Math.min(step.toIdx, sellCandleIdx);
          if (fromI > toI) return;
          const fromX = fromI * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
          const toX = toI * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
          const y = getY(step.avgPrice);
          if (!started) { ctx.moveTo(fromX, y); started = true; }
          else { ctx.lineTo(fromX, y); }
          ctx.lineTo(toX, y);
        });
        // Bottom path: along exit price back
        if (started) {
          const sellX = sellCandleIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
          const firstX = firstBuyIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
          ctx.lineTo(sellX, exitY);
          ctx.lineTo(firstX, exitY);
          ctx.closePath();
          ctx.fill();
        }
      }

      // ── STEPPED ТВХ LINE (green dashed, steps at each add) ──────────────
      if (tvxSteps.length > 0) {
        ctx.strokeStyle = "#26c97a";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 4]);
        ctx.beginPath();
        let moveStarted = false;
        tvxSteps.forEach(step => {
          const fromX = step.fromIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
          const toIdx = sellCandleIdx >= 0 ? Math.min(step.toIdx, sellCandleIdx) : step.toIdx;
          const toX = toIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
          const y = getY(step.avgPrice);
          if (!moveStarted) { ctx.moveTo(fromX, y); moveStarted = true; }
          else { ctx.lineTo(fromX, y); }
          ctx.lineTo(toX, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);

        // ТВХ label on the right axis for final average
        const finalAvg = tvxSteps[tvxSteps.length - 1].avgPrice;
        const finalAvgY = getY(finalAvg);
        const clampedAvgY = Math.max(14, Math.min(H - BOTTOM_MARGIN - 14, finalAvgY));
        ctx.fillStyle = "#26c97a";
        ctx.beginPath();
        ctx.roundRect(CHART_W + 4, clampedAvgY - 9, 68, 18, 3);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px Inter";
        ctx.textAlign = "center";
        ctx.fillText("ТВХ " + fmtP(finalAvg), CHART_W + 38, clampedAvgY + 4);
      }

      // ── EXIT DASHED LINE ───────────────────────────────────────────────────
      if (exitPrice > 0) {
        const exitLineColor = isWin ? "#26c97a" : "#ff4560";
        ctx.strokeStyle = exitLineColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        // Draw exit line only from first buy to sell candle
        const lineStart = buyExecs.length > 0 ? buyExecs[0].candleIdx : 0;
        const lineEnd = sellCandleIdx >= 0 ? sellCandleIdx : candles.length - 1;
        const lsx = lineStart * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        const lex = lineEnd * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        ctx.moveTo(lsx, exitY);
        ctx.lineTo(lex, exitY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Exit price badge on right axis
        const clampedExitY = Math.max(14, Math.min(H - BOTTOM_MARGIN - 14, exitY));
        // Don't overlap with ТВХ badge
        let exitBadgeY = clampedExitY;
        if (tvxSteps.length > 0) {
          const tvxBadgeY = Math.max(14, Math.min(H - BOTTOM_MARGIN - 14, getY(tvxSteps[tvxSteps.length - 1].avgPrice)));
          if (Math.abs(exitBadgeY - tvxBadgeY) < 22) {
            exitBadgeY = exitBadgeY > tvxBadgeY ? tvxBadgeY + 22 : tvxBadgeY - 22;
          }
        }
        ctx.fillStyle = isWin ? "rgba(38,201,122,0.15)" : "rgba(255,69,96,0.15)";
        ctx.strokeStyle = exitLineColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(CHART_W + 4, exitBadgeY - 9, 68, 18, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = exitLineColor;
        ctx.font = "bold 10px Inter";
        ctx.textAlign = "center";
        ctx.fillText("Exit " + fmtP(exitPrice), CHART_W + 38, exitBadgeY + 4);
      }

      // ── DRAW BUY MARKERS WITH LABELS ────────────────────────────────────
      let progressiveQty = 0, progressiveCost = 0;
      buyExecs.forEach((b, i) => {
        const x = b.candleIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        if (x < -40 || x > CHART_W + 40) return;

        const c = candles[b.candleIdx];
        const arrowY = getY(c.l) + 18;
        drawArrowMarker(x, arrowY, 1, "#26c97a", 11);

        // Compute progressive average
        progressiveQty += b.qty || 1;
        progressiveCost += (b.qty || 1) * (b.price || avgEntry);
        const curAvg = progressiveQty > 0 ? progressiveCost / progressiveQty : avgEntry;

        // Label: "BUY $price" or "ADD $price" for subsequent buys
        const labelText = i === 0 ? `Вход $${fmtP(b.price || avgEntry)}` : `Докуп $${fmtP(b.price || avgEntry)}`;
        drawPriceLabel(x, arrowY + 6, labelText, "rgba(38,201,122,0.85)", 1);

        // If this is an add (not first buy), show how ТВХ changed
        if (i > 0) {
          const prevAvg = (progressiveCost - (b.qty || 1) * (b.price || avgEntry)) / (progressiveQty - (b.qty || 1));
          const tvxChangeText = `ТВХ: ${fmtP(prevAvg)} → ${fmtP(curAvg)}`;
          ctx.font = "9px Inter";
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.textAlign = "center";
          ctx.fillText(tvxChangeText, x, arrowY + 40);
        }

        // Vertical dotted connector from arrow to candle
        ctx.strokeStyle = "rgba(38,201,122,0.3)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(x, getY(c.l));
        ctx.lineTo(x, arrowY - 10);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      // ── DRAW SELL MARKERS WITH LABELS ───────────────────────────────────
      sellExecs.forEach(s => {
        const x = s.candleIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        if (x < -40 || x > CHART_W + 40) return;

        const c = candles[s.candleIdx];
        const arrowY = getY(c.h) - 18;
        drawArrowMarker(x, arrowY, -1, "#ff4560", 11);

        const labelText = `Выход $${fmtP(s.price || exitPrice)}`;
        drawPriceLabel(x, arrowY - 6, labelText, "rgba(255,69,96,0.85)", -1);

        // Vertical dotted connector from arrow to candle
        ctx.strokeStyle = "rgba(255,69,96,0.3)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(x, getY(c.h));
        ctx.lineTo(x, arrowY + 10);
        ctx.stroke();
        ctx.setLineDash([]);
      });

      // If no sell execs but we have exit price, draw synthetic sell marker
      if (sellExecs.length === 0 && exitPrice > 0 && sellCandleIdx >= 0) {
        const x = sellCandleIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        if (x >= -40 && x <= CHART_W + 40) {
          const c = candles[sellCandleIdx];
          const arrowY = getY(c.h) - 18;
          drawArrowMarker(x, arrowY, -1, "#ff4560", 11);
          drawPriceLabel(x, arrowY - 6, `Выход $${fmtP(exitPrice)}`, "rgba(255,69,96,0.85)", -1);

          ctx.strokeStyle = "rgba(255,69,96,0.3)";
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(x, getY(c.h));
          ctx.lineTo(x, arrowY + 10);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // ── PnL % BADGE AT EXIT POINT (on chart, not just axis) ─────────────
      if (exitPrice > 0 && sellCandleIdx >= 0) {
        const sellX = sellCandleIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        if (sellX >= -40 && sellX <= CHART_W + 40) {
          const pnlSign = isWin ? "+" : "";
          const pnlText = `${pnlSign}${trade.pnlPercent}%`;
          const pnlColor = isWin ? "#26c97a" : "#ff4560";

          // Large PnL badge on chart near exit
          ctx.font = "bold 13px Inter";
          const tw = ctx.measureText(pnlText).width;
          const bw = tw + 16;
          const bh = 24;
          const bx = sellX - bw / 2;
          const c = candles[sellCandleIdx];
          const by = getY(c.h) - 52;

          // Glow effect
          ctx.shadowColor = pnlColor;
          ctx.shadowBlur = 12;
          ctx.fillStyle = pnlColor;
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, 5);
          ctx.fill();
          ctx.shadowBlur = 0;

          ctx.fillStyle = "#fff";
          ctx.font = "bold 13px Inter";
          ctx.textAlign = "center";
          ctx.fillText(pnlText, sellX, by + bh - 7);
        }
      }

      // ── PnL % BADGE on Right Price Axis ─────────────────────────────────
      if (exitPrice > 0) {
        const clampedBadgeY = Math.max(20, Math.min(H - BOTTOM_MARGIN - 20, exitY));
        const pnlSign2 = isWin ? "+" : "";
        const pnlAxisText = `${pnlSign2}${trade.pnlPercent}%`;
        // Find a Y that doesn't overlap with exit/tvx badges
        let pnlBadgeY = clampedBadgeY;
        if (tvxSteps.length > 0) {
          const tvxY = Math.max(14, Math.min(H - BOTTOM_MARGIN - 14, getY(tvxSteps[tvxSteps.length - 1].avgPrice)));
          if (Math.abs(pnlBadgeY - tvxY) < 24) pnlBadgeY = tvxY > H / 2 ? tvxY - 24 : tvxY + 24;
        }
        // Only show axis PnL badge if it's far enough from other badges
        const exitBY = Math.max(14, Math.min(H - BOTTOM_MARGIN - 14, exitY));
        if (Math.abs(pnlBadgeY - exitBY) < 24) pnlBadgeY = exitBY > H / 2 ? exitBY - 24 : exitBY + 24;
      }
    }

    if (trade && window.TradeOverlay) {
      window.TradeOverlay.draw(ctx, {
        executions: chartState.executions || [],
        candles,
        xForIndex: index => index * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2,
        yForPrice: getY,
        width: CHART_W,
        height: H - BOTTOM_MARGIN,
        currentPrice: candles[candles.length - 1]?.c,
      });
    }

    // ── RENDER JOURNAL DRAWING TOOLS (lines, rays, rect, brush, ruler, fib) ──
    const allDrawings = [...(chartState.drawings || [])];
    if (chartState.draft) allDrawings.push(chartState.draft);
    drawJournalDrawings(ctx, allDrawings, candles, chartState, minP, pRange, PRICE_H, TOP_MARGIN, CHART_W, formatAxisP);

    // Watermark Top Right
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.font = "bold 14px Inter";
    ctx.textAlign = "right";
    ctx.fillText("OBSIDIAN PRO", CHART_W - 15, 28);

    // ── CROSSHAIR & HOVER TOOLTIP ───────────────────────────────────────────
    if (chartState.mouseX >= 0 && chartState.mouseX <= CHART_W && chartState.mouseY >= TOP_MARGIN && chartState.mouseY <= H - BOTTOM_MARGIN) {
      const mX = chartState.mouseX;
      const mY = chartState.mouseY;

      // Dashed Crosshair Lines
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);

      ctx.beginPath();
      ctx.moveTo(mX, 0); ctx.lineTo(mX, H - BOTTOM_MARGIN);
      ctx.moveTo(0, mY); ctx.lineTo(CHART_W, mY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Hover Price Label on Right Margin
      const hoverP = maxP - ((mY - TOP_MARGIN) / PRICE_H) * pRange;
      ctx.fillStyle = "#3b82f6";
      ctx.beginPath();
      ctx.roundRect(CHART_W + 4, mY - 10, 64, 20, 4);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText(hoverP.toFixed(hoverP > 10 ? 2 : 4), CHART_W + 36, mY + 4);
    }
  }

  // ── PNL SHARE CARD GENERATOR ──────────────────────────────────────────────
  function openPnlShareCard(trade) {
    if (!trade) return;
    const modal = document.getElementById("journal-pnl-card-modal");
    if (!modal) return;

    const symEl = document.getElementById("j-card-sym");
    const pctEl = document.getElementById("j-card-pct");
    const valEl = document.getElementById("j-card-pnl-val");
    const entryEl = document.getElementById("j-card-entry");
    const exitEl = document.getElementById("j-card-exit");
    const sideBadge = document.getElementById("j-card-side-badge");

    const isWin = trade.pnl >= 0;
    const pnlSign = isWin ? "+" : "";

    if (symEl) symEl.textContent = `${trade.symbol} (${trade.exchange})`;
    if (pctEl) {
      pctEl.textContent = `${pnlSign}${trade.pnlPercent}%`;
      pctEl.className = `j-pnl-card-pct ${isWin ? 'j-pnl-win' : 'j-pnl-loss'}`;
    }
    if (valEl) {
      valEl.textContent = `${pnlSign}$${trade.pnl.toFixed(2)}`;
      valEl.style.color = isWin ? "var(--gr)" : "var(--rd)";
    }
    if (entryEl) entryEl.textContent = `$${trade.entry}`;
    if (exitEl) exitEl.textContent = `$${trade.exit}`;
    if (sideBadge) {
      sideBadge.textContent = trade.side;
      sideBadge.className = `j-side-badge ${trade.side === 'LONG' ? 'j-side-long' : 'j-side-short'}`;
    }

    const btnDownload = document.getElementById("j-btn-download-card");
    if (btnDownload) {
      btnDownload.onclick = downloadPnlCardPng;
    }

    modal.style.display = "flex";
  }

  function downloadPnlCardPng() {
    const symText = document.getElementById("j-card-sym")?.textContent || "BTCUSDT";
    const pctText = document.getElementById("j-card-pct")?.textContent || "+0.00%";
    const pnlText = document.getElementById("j-card-pnl-val")?.textContent || "$0.00";
    const entryText = document.getElementById("j-card-entry")?.textContent || "$0";
    const exitText = document.getElementById("j-card-exit")?.textContent || "$0";
    const sideBadge = document.getElementById("j-card-side-badge");
    const sideText = sideBadge?.textContent || "LONG";
    const isWin = !pctText.includes("-");

    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 675;
    const ctx = canvas.getContext("2d");

    // Dark Obsidian Card Background Gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 1200, 675);
    bgGrad.addColorStop(0, "#0c0d12");
    bgGrad.addColorStop(0.5, "#12141d");
    bgGrad.addColorStop(1, isWin ? "#0d201a" : "#241017");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, 1200, 675);

    // Subtle Glowing Border
    ctx.strokeStyle = isWin ? "rgba(38, 201, 122, 0.3)" : "rgba(255, 69, 96, 0.3)";
    ctx.lineWidth = 4;
    ctx.strokeRect(10, 10, 1180, 655);

    // Logo Image
    const logoImg = new Image();
    logoImg.crossOrigin = "anonymous";
    logoImg.onload = () => {
      ctx.drawImage(logoImg, 60, 60, 48, 48);

      // Brand Title Text
      ctx.font = "bold 28px Inter, sans-serif";
      ctx.fillStyle = "#ab47bc";
      ctx.fillText("OBSIDIAN ", 120, 94);
      const obsW = ctx.measureText("OBSIDIAN ").width;
      ctx.fillStyle = "#ffffff";
      ctx.fillText("PRO", 120 + obsW, 94);

      // Side Badge (LONG / SHORT)
      const badgeColor = sideText === "LONG" ? "#26c97a" : "#ff4560";
      ctx.fillStyle = badgeColor;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(1020, 60, 120, 44, 8);
      else ctx.rect(1020, 60, 120, 44);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(sideText, 1080, 89);

      // Symbol
      ctx.textAlign = "center";
      ctx.font = "bold 52px Inter, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(symText, 600, 240);

      // PnL %
      ctx.font = "bold 96px Inter, sans-serif";
      ctx.fillStyle = isWin ? "#26c97a" : "#ff4560";
      ctx.fillText(pctText, 600, 365);

      // PnL $
      ctx.font = "bold 44px Inter, sans-serif";
      ctx.fillStyle = isWin ? "#26c97a" : "#ff4560";
      ctx.fillText(pnlText, 600, 440);

      // Footer Entry / Exit Line
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(100, 520);
      ctx.lineTo(1100, 520);
      ctx.stroke();

      ctx.font = "24px Inter, sans-serif";
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.textAlign = "left";
      ctx.fillText("Вход: ", 120, 570);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(entryText, 185, 570);

      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
      ctx.fillText("Выход: ", 1020, 570);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(exitText, 1080, 570);

      // Trigger Download
      const link = document.createElement("a");
      link.download = `Obsidian_PnL_${symText.replace(/[^a-zA-Z0-9]/g, "_")}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    };
    logoImg.src = "/img/logo.svg";
  }

  // ── API SYNC CALLER & AUTOMATIC BACKGROUND REFRESH ───────────────────────
  let autoSyncInterval = null;

  async function syncExchangeApi(silent = false, targetEx = null) {
    const btnSync = document.getElementById("journal-btn-api");
    if (btnSync && !silent) btnSync.textContent = "Синхронизация...";

    const available = new Set([...configuredExchanges, ...Object.keys(apiKeys)]);
    const targetKeys = targetEx ? [targetEx] : [...available];
    if (!targetKeys.length && !silent) {
      alert("Пожалуйста, сначала сохраните API Key в разделе 'API Интеграция'");
      switchTab("apikeys");
      if (btnSync) btnSync.textContent = "Синхронизация API";
      return;
    }

    let totalAdded = 0;

    for (const ex of targetKeys) {
      const keys = apiKeys[ex];
      if (!configuredExchanges.has(ex) && (!keys || !keys.key)) continue;

      const statusEl = document.getElementById(`j-api-status-${ex}`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 45000);

        const res = await fetch("/api/journal/sync", {
          method: "POST",
          headers: journalAuthHeaders(true),
          signal: controller.signal,
          body: JSON.stringify({
            exchange: ex,
            ...(configuredExchanges.has(ex) ? {} : { apiKey: keys.key, apiSecret: keys.secret, passphrase: keys.passphrase })
          })
        });
        clearTimeout(timer);

        const data = await res.json();
        if (data.success && Array.isArray(data.trades)) {
          configuredExchanges.add(ex);
          if (apiKeys[ex]) { delete apiKeys[ex]; saveApiKeys(); }
          const exchangeName = ex === "BN" ? "Binance" : ex === "BB" ? "Bybit" : ex === "OX" ? "OKX" : ex;
          const existingById = new Map(trades.map(t => [t.id, t]));
          trades = trades.filter(t => !(t.source === "api" && t.exchange === exchangeName));
          const fresh = data.trades.map(newTrade => {
            const previous = existingById.get(newTrade.id);
            return previous ? { ...newTrade, note: previous.note || newTrade.note, tags: previous.tags || newTrade.tags } : newTrade;
          });
          trades.unshift(...fresh);
          const addedCount = fresh.length;
          totalAdded += addedCount;

          if (statusEl) {
            statusEl.textContent = "Подключено";
            statusEl.className = "j-api-status connected";
          }
        } else {
          if (statusEl) {
            statusEl.textContent = "Ошибка API";
            statusEl.className = "j-api-status disconnected";
          }
          if (!silent) {
            alert(`Ошибка API [${ex}]: ${data.error || 'Проверьте API Key и Secret'}`);
          }
        }
      } catch (e) {
        if (statusEl) {
          statusEl.textContent = "Сохранено";
          statusEl.className = "j-api-status connected";
        }
        if (!silent) {
          alert(`Ключи сохранены! (Примечание по синхронизации [${ex}]: ${e.name === 'AbortError' ? 'Таймаут ответа биржи' : e.message})`);
        }
      }
    }

    if (targetKeys.length > 0) {
      saveTrades();
      updateUI();
      if (!silent && totalAdded > 0) {
        alert(`Авто-синхронизация завершена! Добавлено новых сделок: ${totalAdded}`);
      }
    } else if (!silent && targetKeys.length > 0) {
      alert("Ключи успешно сохранены локально в браузере.");
    }

    if (btnSync) btnSync.textContent = "Синхронизация API";
  }

  // ── CSV EXPORT & IMPORT ───────────────────────────────────────────────────
  function exportCSV() {
    if (!trades.length) return alert("Нет сделок для экспорта!");

    let csv = "ID,Date,Symbol,Exchange,Side,Entry,Exit,Size,PnL,PnLPercent,Fee,Tags,Note\n";
    trades.forEach(t => {
      const tagsStr = (t.tags || []).join(";");
      const noteStr = (t.note || "").replace(/"/g, '""');
      csv += `"${t.id}","${t.date}","${t.symbol}","${t.exchange}","${t.side}",${t.entry},${t.exit},${t.size},${t.pnl},${t.pnlPercent},${t.fee || 0},"${tagsStr}","${noteStr}"\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `CryptoScreen_Journal_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ── TAB SWITCHER & UI UPDATER ──────────────────────────────────────────────
  function switchTab(tabId) {
    currentTab = tabId;

    document.querySelectorAll(".j-sub-tab").forEach(tab => {
      tab.classList.toggle("on", tab.dataset.jtab === tabId);
    });

    const secOverview = document.getElementById("j-sec-overview");
    const secTrades = document.getElementById("j-sec-trades");
    const secApi = document.getElementById("j-sec-apikeys");

    if (secOverview) secOverview.style.display = tabId === "overview" ? "flex" : "none";
    if (secTrades) secTrades.style.display = tabId === "trades" ? "flex" : "none";
    if (secApi) secApi.style.display = tabId === "apikeys" ? "flex" : "none";

    updateUI();
  }

  function updateUI() {
    const filteredTrades = getFilteredTrades();
    const stats = calculateStats(filteredTrades);

    // Update Header Widgets
    const elWr = document.getElementById("j-stat-winrate");
    const elPnl = document.getElementById("j-stat-pnl");
    const elPnlPct = document.getElementById("j-stat-pnl-pct");
    const elPf = document.getElementById("j-stat-pf");
    const elExp = document.getElementById("j-stat-expectancy");
    const elAvg = document.getElementById("j-stat-avg");
    const elRr = document.getElementById("j-stat-rr-ratio");
    const elTrades = document.getElementById("j-stat-trades");
    const elFees = document.getElementById("j-stat-fees");
    const elWinCounts = document.getElementById("j-stat-win-counts");

    if (elWr) elWr.textContent = `${stats.winrate}%`;
    if (elWinCounts) elWinCounts.textContent = `${stats.wins} приб. / ${stats.losses} убыт.`;
    if (elPnl) {
      const sign = stats.netPnl >= 0 ? "+" : "";
      elPnl.textContent = `${sign}$${stats.netPnl.toFixed(2)}`;
      elPnl.style.color = stats.netPnl >= 0 ? "var(--gr)" : "var(--rd)";
    }
    if (elPnlPct) elPnlPct.textContent = `${stats.netPnlPercent}% за период`;
    if (elPf) elPf.textContent = stats.profitFactor;
    if (elExp) elExp.textContent = `Мат. ожидание: $${stats.expectancy}`;
    if (elAvg) elAvg.textContent = `+$${stats.avgWin} / -$${stats.avgLoss}`;
    if (elRr) elRr.textContent = `R:R 1 : ${stats.rrRatio}`;
    if (elTrades) elTrades.textContent = `${stats.total} (${stats.longs}L / ${stats.shorts}S)`;
    if (elFees) elFees.textContent = `Комиссии: $${stats.totalFees}`;

    if (currentTab === "overview") {
      drawEquityChart();
      renderCalendarView();
    } else if (currentTab === "trades") {
      renderTradesTable();
    }
  }

  function openTradeModal(tradeData = null) {
    const modal = document.getElementById("journal-trade-modal");
    if (!modal) return;

    const fId = document.getElementById("j-input-id");
    const fDate = document.getElementById("j-input-date");
    const fSym = document.getElementById("j-input-sym");
    const fEx = document.getElementById("j-input-ex");
    const fSide = document.getElementById("j-input-side");
    const fEntry = document.getElementById("j-input-entry");
    const fExit = document.getElementById("j-input-exit");
    const fSize = document.getElementById("j-input-size");
    const fPnl = document.getElementById("j-input-pnl");
    const fNote = document.getElementById("j-input-note");
    const tagsBox = document.getElementById("j-input-tags-box");

    const nowStr = new Date().toISOString().slice(0, 16).replace("T", " ");

    if (tradeData) {
      if (fId) fId.value = tradeData.id;
      if (fDate) fDate.value = tradeData.date;
      if (fSym) fSym.value = tradeData.symbol;
      if (fEx) fEx.value = tradeData.exchange;
      if (fSide) fSide.value = tradeData.side;
      if (fEntry) fEntry.value = tradeData.entry;
      if (fExit) fExit.value = tradeData.exit;
      if (fSize) fSize.value = tradeData.size;
      if (fPnl) fPnl.value = tradeData.pnl;
      if (fNote) fNote.value = tradeData.note || "";
    } else {
      if (fId) fId.value = "";
      if (fDate) fDate.value = nowStr;
      if (fSym) fSym.value = "BTCUSDT";
      if (fEx) fEx.value = "Binance";
      if (fSide) fSide.value = "LONG";
      if (fEntry) fEntry.value = "";
      if (fExit) fExit.value = "";
      if (fSize) fSize.value = "";
      if (fPnl) fPnl.value = "";
      if (fNote) fNote.value = "";
    }

    if (tagsBox) {
      const activeTags = tradeData ? (tradeData.tags || []) : [];
      tagsBox.innerHTML = MISTAKE_TAGS.map(t => {
        const checked = activeTags.includes(t.id) ? "checked" : "";
        return `
          <label style="display:inline-flex; align-items:center; gap:6px; background:var(--bg3); padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">
            <input type="checkbox" value="${t.id}" ${checked} class="j-tag-checkbox">
            <span style="color:${t.color}">${t.label}</span>
          </label>
        `;
      }).join("");
    }

    modal.style.display = "flex";
  }

  function saveTradeFromModal() {
    const fId = document.getElementById("j-input-id").value;
    const date = document.getElementById("j-input-date").value;
    const symbol = document.getElementById("j-input-sym").value.trim().toUpperCase();
    const exchange = document.getElementById("j-input-ex").value;
    const side = document.getElementById("j-input-side").value;
    const entry = parseFloat(document.getElementById("j-input-entry").value) || 0;
    const exit = parseFloat(document.getElementById("j-input-exit").value) || 0;
    const size = parseFloat(document.getElementById("j-input-size").value) || 0;
    const pnl = parseFloat(document.getElementById("j-input-pnl").value) || 0;
    const note = document.getElementById("j-input-note").value.trim();

    const selectedTags = [];
    document.querySelectorAll(".j-tag-checkbox:checked").forEach(cb => {
      selectedTags.push(cb.value);
    });

    if (!symbol || !entry || !exit) {
      return alert("Заполните обязательные поля: Инструмент, Вход и Выход.");
    }

    const pnlPercent = entry > 0 ? parseFloat((((exit - entry) / entry) * 100 * (side === "LONG" ? 1 : -1)).toFixed(2)) : 0;

    if (fId) {
      const idx = trades.findIndex(t => t.id === fId);
      if (idx !== -1) {
        trades[idx] = { ...trades[idx], date, symbol, exchange, side, entry, exit, size, pnl, pnlPercent, tags: selectedTags, note };
      }
    } else {
      const newTrade = {
        id: "tr_" + Date.now(),
        date,
        symbol,
        exchange,
        side,
        entry,
        exit,
        size,
        pnl,
        pnlPercent,
        fee: parseFloat((size * entry * 0.0005).toFixed(2)),
        tags: selectedTags,
        note
      };
      trades.unshift(newTrade);
    }

    saveTrades();
    closeTradeModal();
    updateUI();
  }

  function closeTradeModal() {
    const modal = document.getElementById("journal-trade-modal");
    if (modal) modal.style.display = "none";
  }

  function openEditModal(tradeId) {
    const trade = trades.find(t => t.id === tradeId);
    if (trade) openTradeModal(trade);
  }

  function deleteTrade(tradeId) {
    if (!confirm("Вы действительно хотите удалить эту сделку из дневника?")) return;
    trades = trades.filter(t => t.id !== tradeId);
    saveTrades();
    updateUI();
  }

  function initJournal() {
    loadStorage();

    Object.keys(apiKeys).forEach(ex => {
      const keys = apiKeys[ex];
      const keyEl = document.getElementById(`j-api-key-${ex}`);
      const secretEl = document.getElementById(`j-api-secret-${ex}`);
      const passEl = document.getElementById(`j-api-pass-${ex}`);
      const statusEl = document.getElementById(`j-api-status-${ex}`);

      if (keyEl && keys.key) keyEl.value = keys.key;
      if (secretEl && keys.secret) secretEl.value = keys.secret;
      if (passEl && keys.passphrase) passEl.value = keys.passphrase;

      if (statusEl && keys.key) {
        statusEl.textContent = "Подключено";
        statusEl.className = "j-api-status connected";
      }
    });

    document.querySelectorAll(".j-sub-tab").forEach(tab => {
      tab.onclick = () => switchTab(tab.dataset.jtab);
    });

    const selectRange = document.getElementById("j-date-range");
    if (selectRange) {
      selectRange.onchange = (e) => {
        dateRange = e.target.value;
        updateUI();
      };
    }

    const btnCalPrev = document.getElementById("j-cal-prev");
    const btnCalNext = document.getElementById("j-cal-next");
    if (btnCalPrev) btnCalPrev.onclick = () => {
      calendarMonth.setMonth(calendarMonth.getMonth() - 1);
      renderCalendarView();
    };
    if (btnCalNext) btnCalNext.onclick = () => {
      calendarMonth.setMonth(calendarMonth.getMonth() + 1);
      renderCalendarView();
    };

    const btnApi = document.getElementById("journal-btn-api");
    if (btnApi) btnApi.onclick = () => syncExchangeApi(false);

    const btnExport = document.getElementById("journal-btn-export");
    if (btnExport) btnExport.onclick = exportCSV;

    const btnShareCard = document.getElementById("j-btn-share-card");
    if (btnShareCard) btnShareCard.onclick = () => openPnlShareCard(currentViewingTrade);

    const inputSearch = document.getElementById("journal-search-input");
    if (inputSearch) {
      inputSearch.oninput = (e) => {
        filterSearch = e.target.value;
        updateUI();
      };
    }

    const selectSide = document.getElementById("journal-filter-side");
    if (selectSide) {
      selectSide.onchange = (e) => {
        filterSide = e.target.value;
        updateUI();
      };
    }

    const selectOutcome = document.getElementById("journal-filter-outcome");
    if (selectOutcome) {
      selectOutcome.onchange = (e) => {
        filterOutcome = e.target.value;
        updateUI();
      };
    }

    const selectTag = document.getElementById("journal-filter-tag");
    if (selectTag) {
      selectTag.onchange = (e) => {
        filterTag = e.target.value;
        updateUI();
      };
    }

    // Save API key buttons
    document.querySelectorAll(".j-save-api-btn").forEach(btn => {
      btn.onclick = () => {
        saveApiKey(btn.dataset.ex);
      };
    });

    startAutoSyncTimer();
    hydrateServerCredentials().then(() => syncExchangeApi(true));
    updateUI();
  }

  function startAutoSyncTimer() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    // Real-time background sync every 10 seconds
    autoSyncInterval = setInterval(() => {
      if (configuredExchanges.size > 0 || Object.keys(apiKeys).length > 0) {
        syncExchangeApi(true);
      }
    }, 10000);
  }

  async function saveApiKey(ex) {
    const keyEl = document.getElementById(`j-api-key-${ex}`);
    const secretEl = document.getElementById(`j-api-secret-${ex}`);
    const passEl = document.getElementById(`j-api-pass-${ex}`);

    if (!keyEl || !secretEl) return;
    const kVal = keyEl.value.trim();
    const sVal = secretEl.value.trim();
    const pVal = passEl ? passEl.value.trim() : "";

    if (!kVal || !sVal) {
      return alert("Пожалуйста, заполните API Key и API Secret");
    }

    const connectingStatus = document.getElementById(`j-api-status-${ex}`);
    if (connectingStatus) { connectingStatus.textContent = "Проверка..."; connectingStatus.className = "j-api-status connected"; }
    try {
      const response = await fetch(`/api/journal/credentials/${encodeURIComponent(ex)}`, {
        method: "PUT", headers: journalAuthHeaders(true),
        body: JSON.stringify({ apiKey: kVal, apiSecret: sVal, passphrase: pVal })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      configuredExchanges.add(ex);
      delete apiKeys[ex]; saveApiKeys(); markApiConnected(ex);
      keyEl.value = ""; secretEl.value = ""; if (passEl) passEl.value = "";
      toggleExchangeSettings(ex);
      await syncExchangeApi(true, ex);
      window.TradeOverlay?.refresh(true);
      alert("API-ключи проверены и защищённо сохранены на сервере.");
      return;
    } catch (error) {
      if (connectingStatus) { connectingStatus.textContent = "Ошибка API"; connectingStatus.className = "j-api-status disconnected"; }
      const gearBtn = document.getElementById(`j-api-gear-${ex}`);
      if (gearBtn) gearBtn.style.display = "none";
      const panel = document.getElementById(`j-api-settings-${ex}`);
      if (panel) panel.style.display = "none";
      alert(`Не удалось подключить API: ${error.message}`);
      return;
    }

  }

  window.switchJournalTab = switchTab;

  window.CryptoJournal = {
    init: initJournal,
    switchTab: switchTab,
    saveApiKey: saveApiKey,
    syncApi: () => syncExchangeApi(false),
    exportCsv: exportCSV,
    isExchangeChartEnabled: isExchangeChartEnabled,
    isExchangeJournalEnabled: isExchangeJournalEnabled,
    updateExchangeSetting: updateExchangeSetting,
    toggleExchangeSettings: toggleExchangeSettings,
    activate: () => {
      const mainEl = document.getElementById("main");
      const densityEl = document.getElementById("density-view");
      const formationsEl = document.getElementById("formations-view");
      const backtestEl = document.getElementById("backtest-view");
      const journalEl = document.getElementById("journal-view");

      if (mainEl) mainEl.style.display = "none";
      if (densityEl) densityEl.style.display = "none";
      if (formationsEl) formationsEl.style.display = "none";
      if (backtestEl) backtestEl.style.display = "none";
      if (journalEl) journalEl.style.display = "flex";

      initJournal();
      // Immediate background sync on activate
      hydrateServerCredentials().then(() => syncExchangeApi(true));
      setTimeout(drawEquityChart, 60);
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    initJournal();
    // Immediate background sync when window regains focus after trading
    window.addEventListener("focus", () => {
      if (configuredExchanges.size > 0 || Object.keys(apiKeys).length > 0) {
        syncExchangeApi(true);
      }
    });

    const btnJournal = document.getElementById("tab-journal");
    if (btnJournal) {
      btnJournal.addEventListener("click", () => {
        if (window.switchView) window.switchView("journal");
        else window.CryptoJournal.activate();
      });
    }
  });
})();
