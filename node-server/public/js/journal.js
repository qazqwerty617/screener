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

  // ── EQUITY CURVE CANVAS RENDERER ─────────────────────────────────────────────
  function drawEquityChart() {
    const canvas = document.getElementById("journal-equity-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * (window.devicePixelRatio || 1) || 800;
    canvas.height = rect.height * (window.devicePixelRatio || 1) || 200;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    const tradeList = getFilteredTrades();
    if (tradeList.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "12px Inter";
      ctx.textAlign = "center";
      ctx.fillText("Недостаточно сделок для построения графика доходности", W / 2, H / 2);
      return;
    }

    const sorted = [...tradeList].sort((a, b) => new Date(a.date) - new Date(b.date));

    let cumPnl = 0;
    const points = [{ x: 0, pnl: 0 }];
    sorted.forEach((t, i) => {
      cumPnl += t.pnl;
      points.push({ x: i + 1, pnl: cumPnl, date: t.date, sym: t.symbol, tradePnl: t.pnl });
    });

    const minPnl = Math.min(0, ...points.map(p => p.pnl));
    const maxPnl = Math.max(100, ...points.map(p => p.pnl));
    const range = maxPnl - minPnl || 1;

    const padL = 50, padR = 20, padT = 20, padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const getX = (i) => padL + (i / (points.length - 1)) * plotW;
    const getY = (val) => padT + plotH - ((val - minPnl) / range) * plotH;

    const zeroY = getY(0);

    // Zero line
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(W - padR, zeroY);
    ctx.stroke();

    // Gradient fill
    const isProfitable = cumPnl >= 0;
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    if (isProfitable) {
      grad.addColorStop(0, "rgba(38, 201, 122, 0.35)");
      grad.addColorStop(1, "rgba(38, 201, 122, 0.0)");
    } else {
      grad.addColorStop(0, "rgba(255, 69, 96, 0.35)");
      grad.addColorStop(1, "rgba(255, 69, 96, 0.0)");
    }

    ctx.beginPath();
    ctx.moveTo(getX(0), zeroY);
    points.forEach((p, i) => {
      ctx.lineTo(getX(i), getY(p.pnl));
    });
    ctx.lineTo(getX(points.length - 1), zeroY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Equity Line
    ctx.beginPath();
    ctx.strokeStyle = isProfitable ? "#26c97a" : "#ff4560";
    ctx.lineWidth = 2.5;
    points.forEach((p, i) => {
      const x = getX(i);
      const y = getY(p.pnl);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Points
    points.forEach((p, i) => {
      const x = getX(i);
      const y = getY(p.pnl);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = p.pnl >= 0 ? "#26c97a" : "#ff4560";
      ctx.fill();
      ctx.strokeStyle = "#12131e";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Y Axis Labels
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "10px Inter";
    ctx.textAlign = "right";
    ctx.fillText(`+$${maxPnl.toFixed(0)}`, padL - 6, padT + 8);
    ctx.fillText(`$${minPnl.toFixed(0)}`, padL - 6, H - padB);
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
    if (!modal || !canvas) return;

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

    // ── DRAW TMM-STYLE EXECUTIONS & PRICE LINES ───────────────────────────────
    if (trade) {
      const isWin = trade.pnl >= 0;
      const executions = chartState.executions || [];
      const avgEntry = chartState.avgEntry || trade.entry || 0;
      const exitPrice = trade.exit || 0;
      const avgEntryY = getY(avgEntry);
      const exitY = exitPrice > 0 ? getY(exitPrice) : 0;

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

      // Helper: draw TMM outlined hollow chevron arrow
      //   dir = 1 (up/buy) or -1 (down/sell)
      //   color = stroke color
      function drawChevronArrow(cx, cy, dir, color) {
        const size = 8;
        const strokeW = 2.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = strokeW;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        if (dir === 1) {
          // ▲ upward chevron (buy)
          ctx.moveTo(cx - size, cy + size * 0.6);
          ctx.lineTo(cx, cy - size * 0.4);
          ctx.lineTo(cx + size, cy + size * 0.6);
        } else {
          // ▼ downward chevron (sell)
          ctx.moveTo(cx - size, cy - size * 0.6);
          ctx.lineTo(cx, cy + size * 0.4);
          ctx.lineTo(cx + size, cy - size * 0.6);
        }
        ctx.stroke();
      }

      // ── GREEN DASHED LINE — Average Entry Price (ТВХ) ──────────────────
      if (avgEntry > 0) {
        ctx.strokeStyle = "#26c97a";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, avgEntryY);
        ctx.lineTo(CHART_W, avgEntryY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── RED DASHED LINE — Exit Price ──────────────────────────────────────
      if (exitPrice > 0 && Math.abs(exitPrice - avgEntry) > 0.00001) {
        ctx.strokeStyle = "#ff4560";
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, exitY);
        ctx.lineTo(CHART_W, exitY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── DRAW CHEVRON ARROWS FOR EACH EXECUTION ─────────────────────────
      let fallbackOffset = 0;
      executions.forEach(exec => {
        const isBuy = exec.side === "LONG" || exec.side === "BUY";
        let idx = findCandleIdx(exec.date);

        // Fallback: if all execs map to same candle, offset them
        if (idx < 0) {
          idx = Math.floor(candles.length * 0.3) + fallbackOffset;
          fallbackOffset += 3;
        }

        idx = Math.max(0, Math.min(candles.length - 1, idx));
        const x = idx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        if (x < -30 || x > CHART_W + 30) return;

        const c = candles[idx];
        if (isBuy) {
          // Place arrow below the candle low
          const arrowY = getY(c.l) + 14;
          drawChevronArrow(x, arrowY, 1, "#26c97a");
        } else {
          // Place arrow above the candle high
          const arrowY = getY(c.h) - 14;
          drawChevronArrow(x, arrowY, -1, "#ff4560");
        }
      });

      // If no sell executions found but we have an exit price, draw one sell arrow
      if (executions.every(e => e.side === "LONG" || e.side === "BUY") && exitPrice > 0) {
        // Find last buy execution index and place sell a few candles later
        let lastBuyIdx = -1;
        executions.forEach(exec => {
          const idx = findCandleIdx(exec.date);
          if (idx > lastBuyIdx) lastBuyIdx = idx;
        });
        if (lastBuyIdx < 0) lastBuyIdx = Math.floor(candles.length * 0.5);
        const sellIdx = Math.min(candles.length - 1, lastBuyIdx + Math.max(3, Math.floor(candles.length * 0.05)));
        const sellX = sellIdx * chartState.candleWidth - chartState.scrollOffset + chartState.candleWidth / 2;
        if (sellX >= -30 && sellX <= CHART_W + 30) {
          const c = candles[sellIdx];
          drawChevronArrow(sellX, getY(c.h) - 14, -1, "#ff4560");
        }
      }

      // ── PnL % BADGE on Right Price Axis ─────────────────────────────────
      const badgeRefY = exitPrice > 0 ? exitY : avgEntryY;
      const clampedBadgeY = Math.max(20, Math.min(H - BOTTOM_MARGIN - 20, badgeRefY));
      const pnlSign = isWin ? "+" : "";
      const pnlText = `${pnlSign}${trade.pnlPercent}%`;

      ctx.fillStyle = isWin ? "#26c97a" : "#ff4560";
      ctx.beginPath();
      ctx.roundRect(CHART_W + 6, clampedBadgeY - 10, 62, 20, 3);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px Inter";
      ctx.textAlign = "center";
      ctx.fillText(pnlText, CHART_W + 37, clampedBadgeY + 4);
    }

    // Watermark Top Right
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.font = "bold 16px Inter";
    ctx.textAlign = "right";
    ctx.fillText("TMM VISUALIZER", CHART_W - 15, 30);

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

    modal.style.display = "flex";
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
    const secJournal = document.getElementById("j-sec-journal");
    const secApi = document.getElementById("j-sec-apikeys");

    if (secOverview) secOverview.style.display = tabId === "overview" ? "flex" : "none";
    if (secTrades) secTrades.style.display = tabId === "trades" ? "flex" : "none";
    if (secJournal) secJournal.style.display = tabId === "journal" ? "flex" : "none";
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
    } else if (currentTab === "journal") {
      renderMonthlyJournalView();
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
