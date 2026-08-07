/**
 * CryptoScreen Pro — Traders Journal Module (TraderMakeMoney style)
 * Advanced Trading Analysis, Exchange API Sync, PnL Charts & Visualizer
 */

(function () {
  const STORAGE_KEY = "cryptoscreen_journal_trades_v3";
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
      const raw = localStorage.getItem(STORAGE_KEY);
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
      localStorage.setItem(API_KEYS_KEY, JSON.stringify(apiKeys));
    } catch (e) {}
  }

  function getFilteredTrades() {
    let list = [...trades];

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
            <div style="color:var(--t2); font-size:10px;">${t.date}</div>
            <div style="font-family:monospace; font-weight:600;">$${t.entry}</div>
          </td>
          <td style="font-size:11px;">
            <div style="color:var(--t2); font-size:10px;">${t.date}</div>
            <div style="font-family:monospace; font-weight:600;">$${t.exit}</div>
          </td>
          <td style="font-size:11px; color:var(--t2);">15м 30с</td>
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
    dragStartOffset: 0,
    mouseX: -1,
    mouseY: -1,
    canvas: null
  };

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

    // ── FIND ALL RELATED EXECUTIONS for the same symbol (±4 hours) ────────
    const tradeTs = trade.date ? new Date(trade.date.replace(" ", "T") + ":00Z").getTime() : 0;
    const WINDOW = 4 * 60 * 60 * 1000; // 4 hours

    const relatedExecs = trades.filter(t => {
      if (t.symbol !== trade.symbol || t.exchange !== trade.exchange) return false;
      if (!t.date) return t.id === trade.id;
      const ts = new Date(t.date.replace(" ", "T") + ":00Z").getTime();
      return Math.abs(ts - tradeTs) <= WINDOW;
    });

    // Separate buys and sells
    const buys = relatedExecs.filter(t => t.side === "LONG" || t.side === "BUY");
    const sells = relatedExecs.filter(t => t.side === "SHORT" || t.side === "SELL");

    // If no separation found, use the primary trade
    if (buys.length === 0 && sells.length === 0) {
      buys.push(trade);
    }

    // Compute weighted average entry
    let totalQty = 0, totalCost = 0;
    buys.forEach(b => {
      const qty = parseFloat(b.size) || 0;
      const px = parseFloat(b.entry) || 0;
      totalQty += qty;
      totalCost += qty * px;
    });
    const avgEntry = totalQty > 0 ? totalCost / totalQty : (trade.entry || 0);

    // Total PnL
    let totalPnl = 0;
    relatedExecs.forEach(t => totalPnl += (t.pnl || 0));

    // Store executions for chart rendering
    chartState.executions = relatedExecs.map(t => ({
      side: t.side,
      price: t.side === "LONG" || t.side === "BUY" ? t.entry : t.exit,
      size: t.size,
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

    modal.style.display = "flex";
    setupTradeChartEvents(canvas);

    try {
      const exCode = trade.exchange === "Binance" ? "BN" : (trade.exchange === "Bybit" ? "BB" : "OX");
      const res = await fetch(`/api/klines?ex=${exCode}&sym=${trade.symbol}&tf=15m&lite=1`);
      if (res.ok) {
        const flatKlines = await res.json();
        const candles = [];
        for (let i = 0; i < flatKlines.length; i += 6) {
          candles.push({ t: flatKlines[i], o: flatKlines[i+1], h: flatKlines[i+2], l: flatKlines[i+3], c: flatKlines[i+4], v: flatKlines[i+5] });
        }
        chartState.candles = candles;
        resetChartViewState(canvas);
        renderInteractiveChart(canvas);
      }
    } catch (e) {
      console.warn("Failed to load trade candles:", e);
    }
  }

  function setupTradeChartEvents(canvas) {
    if (canvas._hasInteractiveEvents) return;
    canvas._hasInteractiveEvents = true;

    canvas.addEventListener("mousedown", (e) => {
      chartState.isDragging = true;
      chartState.dragStartX = e.clientX;
      chartState.dragStartOffset = chartState.scrollOffset;
      canvas.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      chartState.mouseX = e.clientX - rect.left;
      chartState.mouseY = e.clientY - rect.top;

      if (chartState.isDragging) {
        const dx = e.clientX - chartState.dragStartX;
        chartState.scrollOffset = chartState.dragStartOffset - dx;
        renderInteractiveChart(canvas);
      } else if (chartState.mouseX >= 0 && chartState.mouseX <= rect.width && chartState.mouseY >= 0 && chartState.mouseY <= rect.height) {
        renderInteractiveChart(canvas);
      }
    });

    window.addEventListener("mouseup", () => {
      if (chartState.isDragging) {
        chartState.isDragging = false;
        canvas.style.cursor = "crosshair";
      }
    });

    canvas.addEventListener("mouseleave", () => {
      chartState.mouseX = -1;
      chartState.mouseY = -1;
      renderInteractiveChart(canvas);
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.2 : 0.8;
      const newWidth = Math.max(4, Math.min(60, chartState.candleWidth * zoomFactor));
      
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
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
    const rect = canvas.getBoundingClientRect();
    const chartW = (rect.width || 800) - 80;

    // Find trade candle index by timestamp and center on it
    let centerIdx = candles.length - 1; // default: latest
    if (trade && trade.date) {
      const tradeTs = new Date(trade.date.replace(" ", "T") + ":00Z").getTime();
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

    let minP = Math.min(...visibleCandles.map(c => c.l));
    let maxP = Math.max(...visibleCandles.map(c => c.h));
    if (trade) {
      minP = Math.min(minP, trade.entry * 0.995, trade.exit * 0.995);
      maxP = Math.max(maxP, trade.entry * 1.005, trade.exit * 1.005);
    }
    const maxVol = Math.max(...visibleCandles.map(c => c.v || 0), 1);
    const pRange = maxP - minP || 1;

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
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CHART_W, y);
      ctx.stroke();

      // Right Axis Price Label
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(p.toFixed(p > 10 ? 2 : 4), CHART_W + 8, y + 3);
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
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "10px monospace";
      ctx.textAlign = "left";
      ctx.fillText(p.toFixed(p > 10 ? 2 : 4), CHART_W + 8, y + 3);
    }

    // ── DRAW TMM-STYLE EXECUTIONS & PRICE LINES (FULL TMM CLONE) ──────────────
    if (trade) {
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

      // Hovered Candle Info Top Left
      const hoveredCandleIdx = Math.floor((mX + chartState.scrollOffset) / chartState.candleWidth);
      const hoveredCandle = candles[hoveredCandleIdx];

      if (hoveredCandle) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = "11px Inter";
        ctx.textAlign = "left";
        ctx.fillText(`O: $${hoveredCandle.o}  H: $${hoveredCandle.h}  L: $${hoveredCandle.l}  C: $${hoveredCandle.c}`, 15, TOP_MARGIN + 15);
      }
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
    logoImg.src = "/img/logo.png";
  }

  // ── API SYNC CALLER & AUTOMATIC BACKGROUND REFRESH ───────────────────────
  let autoSyncInterval = null;

  async function syncExchangeApi(silent = false, targetEx = null) {
    const btnSync = document.getElementById("journal-btn-api");
    if (btnSync && !silent) btnSync.textContent = "Синхронизация...";

    const targetKeys = targetEx ? [targetEx] : Object.keys(apiKeys);
    if (!targetKeys.length && !silent) {
      alert("Пожалуйста, сначала сохраните API Key в разделе 'API Интеграция'");
      switchTab("apikeys");
      if (btnSync) btnSync.textContent = "Синхронизация API";
      return;
    }

    let totalAdded = 0;

    for (const ex of targetKeys) {
      const keys = apiKeys[ex];
      if (!keys || !keys.key) continue;

      const statusEl = document.getElementById(`j-api-status-${ex}`);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);

        const res = await fetch("/api/journal/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            exchange: ex,
            apiKey: keys.key,
            apiSecret: keys.secret,
            passphrase: keys.passphrase
          })
        });
        clearTimeout(timer);

        const data = await res.json();
        if (data.success && Array.isArray(data.trades)) {
          let addedCount = 0;
          data.trades.forEach(newTrade => {
            if (!trades.some(t => t.id === newTrade.id)) {
              trades.unshift(newTrade);
              addedCount++;
            }
          });
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

    if (totalAdded > 0) {
      saveTrades();
      updateUI();
      if (!silent) {
        alert(`Авто-синхронизация завершена! Добавлено новых сделок: ${totalAdded}`);
      }
    } else if (!silent && targetKeys.length > 0) {
      alert("Ключи успешно сохранены локально в браузере.");
    }

    if (btnSync) btnSync.textContent = "Синхронизация API";
  }

  function startAutoSyncTimer() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    autoSyncInterval = setInterval(() => {
      if (Object.keys(apiKeys).length > 0) {
        syncExchangeApi(true);
      }
    }, 60000);
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
    updateUI();
  }

  function startAutoSyncTimer() {
    if (autoSyncInterval) clearInterval(autoSyncInterval);
    // Real-time background sync every 10 seconds
    autoSyncInterval = setInterval(() => {
      if (Object.keys(apiKeys).length > 0) {
        syncExchangeApi(true);
      }
    }, 10000);
  }

  function saveApiKey(ex) {
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

    apiKeys[ex] = {
      exchange: ex,
      key: kVal,
      secret: sVal,
      passphrase: pVal
    };
    saveApiKeys();

    const statusEl = document.getElementById(`j-api-status-${ex}`);
    if (statusEl) {
      statusEl.textContent = "Соединение...";
      statusEl.className = "j-api-status connected";
    }

    syncExchangeApi(false, ex);
  }

  window.switchJournalTab = switchTab;

  window.CryptoJournal = {
    init: initJournal,
    switchTab: switchTab,
    saveApiKey: saveApiKey,
    syncApi: () => syncExchangeApi(false),
    exportCsv: exportCSV,
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
      syncExchangeApi(true);
      setTimeout(drawEquityChart, 60);
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    initJournal();
    // Immediate background sync when window regains focus after trading
    window.addEventListener("focus", () => {
      if (Object.keys(apiKeys).length > 0) {
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
