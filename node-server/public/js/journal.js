/**
 * CryptoScreen Pro — Traders Journal Module (TraderMakeMoney style)
 */

(function () {
  const STORAGE_KEY = "cryptoscreen_journal_trades_v1";
  const API_KEYS_KEY = "cryptoscreen_journal_apikeys_v1";

  // Pre-populated demo trades if storage is empty
  const DEMO_TRADES = [
    {
      id: "tr_101",
      date: "2026-08-06 11:30",
      symbol: "BTCUSDT",
      exchange: "Binance",
      side: "LONG",
      entry: 64120.0,
      exit: 65450.0,
      size: 0.5,
      pnl: 665.0,
      pnlPercent: 2.07,
      tags: ["По плану", "Идеальный сетап"],
      note: "Отличный отскок от бычьего Ордер Блока 4H. Тейк взят по лимитке."
    },
    {
      id: "tr_102",
      date: "2026-08-06 09:15",
      symbol: "ETHUSDT",
      exchange: "Bybit",
      side: "SHORT",
      entry: 3480.0,
      exit: 3410.0,
      size: 4.0,
      pnl: 280.0,
      pnlPercent: 2.01,
      tags: ["По плану"],
      note: "Пробой локального уровня поддержки с подтверждением по CVD."
    },
    {
      id: "tr_103",
      date: "2026-08-05 21:40",
      symbol: "SOLUSDT",
      exchange: "OKX",
      side: "LONG",
      entry: 144.5,
      exit: 141.2,
      size: 20.0,
      pnl: -66.0,
      pnlPercent: -2.28,
      tags: ["FOMO", "Завышенный риск"],
      note: "Зашел на хаях импульса без подтверждения. Стоп сработал четко."
    },
    {
      id: "tr_104",
      date: "2026-08-05 18:10",
      symbol: "SUIUSDT",
      exchange: "Binance",
      side: "LONG",
      entry: 1.82,
      exit: 1.95,
      size: 2000.0,
      pnl: 260.0,
      pnlPercent: 7.14,
      tags: ["По плану"],
      note: "Снятие ликвидности EQL на 15m. Вход на развороте."
    },
    {
      id: "tr_105",
      date: "2026-08-05 14:05",
      symbol: "DOGEUSDT",
      exchange: "Bitget",
      side: "SHORT",
      entry: 0.125,
      exit: 0.1285,
      size: 15000.0,
      pnl: -52.5,
      pnlPercent: -2.8,
      tags: ["Тильт", "Реванш-трейд"],
      note: "Пытался отбить предыдущий убыток. Вход против сильного тренда."
    },
    {
      id: "tr_106",
      date: "2026-08-04 22:15",
      symbol: "XRPUSDT",
      exchange: "Bybit",
      side: "LONG",
      entry: 0.562,
      exit: 0.589,
      size: 5000.0,
      pnl: 135.0,
      pnlPercent: 4.8,
      tags: ["Ранний выход"],
      note: "Вышел раньше времени, хотя цена пошла дальше до основного TP."
    },
    {
      id: "tr_107",
      date: "2026-08-04 16:50",
      symbol: "PEPEUSDT",
      exchange: "Binance",
      side: "LONG",
      entry: 0.0000082,
      exit: 0.0000089,
      size: 50000000.0,
      pnl: 350.0,
      pnlPercent: 8.53,
      tags: ["По плану", "Идеальный сетап"],
      note: "Пробой наклонного уровня с объемом."
    }
  ];

  const MISTAKE_TAGS = [
    { id: "По плану", label: "По плану", color: "#26c97a", isGood: true },
    { id: "Идеальный сетап", label: "Идеальный сетап", color: "#10b981", isGood: true },
    { id: "FOMO", label: "FOMO", color: "#f97316", isGood: false },
    { id: "Тильт", label: "Тильт", color: "#ff4560", isGood: false },
    { id: "Ранний выход", label: "Ранний выход", color: "#eab308", isGood: false },
    { id: "Завышенный риск", label: "Завышенный риск", color: "#ec4899", isGood: false },
    { id: "Реванш-трейд", label: "Реванш-трейд", color: "#a855f7", isGood: false },
    { id: "Без стопа", label: "Без стопа", color: "#ef4444", isGood: false }
  ];

  let trades = [];
  let apiKeys = {};
  let filterSearch = "";
  let filterSide = "ALL";
  let filterOutcome = "ALL";
  let filterTag = "ALL";

  function loadStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        trades = JSON.parse(raw);
      } else {
        trades = [...DEMO_TRADES];
        saveTrades();
      }
      const rawKeys = localStorage.getItem(API_KEYS_KEY);
      if (rawKeys) apiKeys = JSON.parse(rawKeys);
    } catch (e) {
      trades = [...DEMO_TRADES];
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

  // ── STATS CALCULATION ────────────────────────────────────────────────────────
  function calculateStats() {
    if (!trades.length) {
      return {
        total: 0,
        winrate: 0,
        netPnl: 0,
        profitFactor: 0,
        avgWin: 0,
        avgLoss: 0,
        longs: 0,
        shorts: 0,
        wins: 0,
        losses: 0
      };
    }

    let wins = 0, losses = 0;
    let sumWinPnl = 0, sumLossPnl = 0;
    let totalPnl = 0;
    let longs = 0, shorts = 0;

    trades.forEach(t => {
      totalPnl += t.pnl;
      if (t.side === "LONG") longs++; else shorts++;

      if (t.pnl >= 0) {
        wins++;
        sumWinPnl += t.pnl;
      } else {
        losses++;
        sumLossPnl += Math.abs(t.pnl);
      }
    });

    const winrate = (wins / trades.length) * 100;
    const profitFactor = sumLossPnl === 0 ? sumWinPnl : (sumWinPnl / sumLossPnl);
    const avgWin = wins > 0 ? (sumWinPnl / wins) : 0;
    const avgLoss = losses > 0 ? (sumLossPnl / losses) : 0;

    return {
      total: trades.length,
      winrate: winrate.toFixed(1),
      netPnl: totalPnl,
      profitFactor: profitFactor.toFixed(2),
      avgWin: Math.round(avgWin),
      avgLoss: Math.round(avgLoss),
      longs,
      shorts,
      wins,
      losses
    };
  }

  // ── EQUITY CURVE CANVAS RENDERER ─────────────────────────────────────────────
  function drawEquityChart() {
    const canvas = document.getElementById("journal-equity-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();

    canvas.width = rect.width * window.devicePixelRatio || 800;
    canvas.height = rect.height * window.devicePixelRatio || 220;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    if (trades.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "12px Inter";
      ctx.textAlign = "center";
      ctx.fillText("Недостаточно сделок для построения графика доходности", W / 2, H / 2);
      return;
    }

    const sorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));

    let cumPnl = 0;
    const points = [{ x: 0, pnl: 0 }];
    sorted.forEach((t, i) => {
      cumPnl += t.pnl;
      points.push({ x: i + 1, pnl: cumPnl });
    });

    const minPnl = Math.min(0, ...points.map(p => p.pnl));
    const maxPnl = Math.max(100, ...points.map(p => p.pnl));
    const range = maxPnl - minPnl || 1;

    const padL = 45, padR = 20, padT = 20, padB = 25;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const getX = (i) => padL + (i / (points.length - 1)) * plotW;
    const getY = (val) => padT + plotH - ((val - minPnl) / range) * plotH;

    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const zeroY = getY(0);
    ctx.moveTo(padL, zeroY);
    ctx.lineTo(W - padR, zeroY);
    ctx.stroke();

    const isProfitable = cumPnl >= 0;
    const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
    if (isProfitable) {
      grad.addColorStop(0, "rgba(38, 201, 122, 0.28)");
      grad.addColorStop(1, "rgba(38, 201, 122, 0.0)");
    } else {
      grad.addColorStop(0, "rgba(255, 69, 96, 0.28)");
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

    ctx.beginPath();
    ctx.strokeStyle = isProfitable ? "#26c97a" : "#ff4560";
    ctx.lineWidth = 2.5;
    points.forEach((p, i) => {
      const x = getX(i);
      const y = getY(p.pnl);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

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

    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "10px Inter";
    ctx.textAlign = "right";
    ctx.fillText(`+$${maxPnl.toFixed(0)}`, padL - 6, padT + 8);
    ctx.fillText(`$${minPnl.toFixed(0)}`, padL - 6, H - padB);
  }

  // ── RENDER TRADES TABLE & FILTERS ───────────────────────────────────────────
  function renderTradesTable() {
    const tbody = document.getElementById("journal-table-body");
    if (!tbody) return;

    let filtered = trades.filter(t => {
      if (filterSearch) {
        const q = filterSearch.toLowerCase();
        const matchSym = t.symbol.toLowerCase().includes(q);
        const matchEx = t.exchange.toLowerCase().includes(q);
        const matchNotes = (t.note || "").toLowerCase().includes(q);
        if (!matchSym && !matchEx && !matchNotes) return false;
      }
      if (filterSide !== "ALL" && t.side !== filterSide) return false;
      if (filterOutcome === "WIN" && t.pnl < 0) return false;
      if (filterOutcome === "LOSS" && t.pnl >= 0) return false;
      if (filterTag !== "ALL" && !(t.tags || []).includes(filterTag)) return false;
      return true;
    });

    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--t3);">Сделок по выбранным фильтрам не найдено</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(t => {
      const isWin = t.pnl >= 0;
      const pnlClass = isWin ? "j-pnl-win" : "j-pnl-loss";
      const sideClass = t.side === "LONG" ? "j-side-long" : "j-side-short";
      const pnlSign = isWin ? "+" : "";

      const tagsHtml = (t.tags || []).map(tagId => {
        const tInfo = MISTAKE_TAGS.find(m => m.id === tagId) || { label: tagId, color: "#6366f1" };
        return `<span class="j-tag-pill" style="background:${tInfo.color}22; color:${tInfo.color}; border:1px solid ${tInfo.color}44;">${tInfo.label}</span>`;
      }).join(" ");

      return `
        <tr data-trade-id="${t.id}">
          <td style="white-space:nowrap; font-size:11px; color:var(--t3);">${t.date}</td>
          <td>
            <div style="font-weight:700; color:#fff;">${t.symbol}</div>
            <span style="font-size:10px; color:var(--t3);">${t.exchange}</span>
          </td>
          <td><span class="j-side-badge ${sideClass}">${t.side}</span></td>
          <td style="font-family:monospace; font-size:11px;">$${t.entry} → $${t.exit}</td>
          <td style="font-family:monospace; font-size:11px;">${t.size}</td>
          <td class="${pnlClass}" style="font-family:monospace; font-weight:700;">
            ${pnlSign}$${t.pnl.toFixed(2)} (${pnlSign}${t.pnlPercent}%)
          </td>
          <td><div class="j-tags-cell">${tagsHtml || '<span style="color:var(--t3); font-size:11px;">—</span>'}</div></td>
          <td style="font-size:11px; color:var(--t2); max-width:200px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
            ${t.note || "—"}
          </td>
          <td style="text-align:right;">
            <button class="j-act-btn j-edit-btn" data-id="${t.id}" title="Редактировать">✏️</button>
            <button class="j-act-btn j-del-btn" data-id="${t.id}" title="Удалить">🗑</button>
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll(".j-edit-btn").forEach(btn => {
      btn.onclick = () => openEditModal(btn.dataset.id);
    });
    tbody.querySelectorAll(".j-del-btn").forEach(btn => {
      btn.onclick = () => deleteTrade(btn.dataset.id);
    });
  }

  function updateUI() {
    const stats = calculateStats();

    const elWr = document.getElementById("j-stat-winrate");
    const elPnl = document.getElementById("j-stat-pnl");
    const elPf = document.getElementById("j-stat-pf");
    const elAvg = document.getElementById("j-stat-avg");
    const elTrades = document.getElementById("j-stat-trades");

    if (elWr) elWr.textContent = `${stats.winrate}%`;
    if (elPnl) {
      const sign = stats.netPnl >= 0 ? "+" : "";
      elPnl.textContent = `${sign}$${stats.netPnl.toFixed(2)}`;
      elPnl.style.color = stats.netPnl >= 0 ? "#26c97a" : "#ff4560";
    }
    if (elPf) elPf.textContent = stats.profitFactor;
    if (elAvg) elAvg.textContent = `+$${stats.avgWin} / -$${stats.avgLoss}`;
    if (elTrades) elTrades.textContent = `${stats.total} (${stats.longs}L / ${stats.shorts}S)`;

    drawEquityChart();
    renderTradesTable();
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
      fId.value = tradeData.id;
      fDate.value = tradeData.date;
      fSym.value = tradeData.symbol;
      fEx.value = tradeData.exchange;
      fSide.value = tradeData.side;
      fEntry.value = tradeData.entry;
      fExit.value = tradeData.exit;
      fSize.value = tradeData.size;
      fPnl.value = tradeData.pnl;
      fNote.value = tradeData.note || "";
    } else {
      fId.value = "";
      fDate.value = nowStr;
      fSym.value = "BTCUSDT";
      fEx.value = "Binance";
      fSide.value = "LONG";
      fEntry.value = "";
      fExit.value = "";
      fSize.value = "";
      fPnl.value = "";
      fNote.value = "";
    }

    const activeTags = new Set(tradeData ? tradeData.tags || [] : ["По плану"]);
    tagsBox.innerHTML = MISTAKE_TAGS.map(t => {
      const checked = activeTags.has(t.id) ? "checked" : "";
      return `
        <label class="j-modal-tag-item">
          <input type="checkbox" value="${t.id}" ${checked}>
          <span style="color:${t.color}">${t.label}</span>
        </label>
      `;
    }).join("");

    modal.style.display = "flex";
  }

  function saveTradeFromModal() {
    const fId = document.getElementById("j-input-id").value;
    const fDate = document.getElementById("j-input-date").value;
    const fSym = document.getElementById("j-input-sym").value.trim().toUpperCase() || "BTCUSDT";
    const fEx = document.getElementById("j-input-ex").value;
    const fSide = document.getElementById("j-input-side").value;
    const fEntry = parseFloat(document.getElementById("j-input-entry").value) || 0;
    const fExit = parseFloat(document.getElementById("j-input-exit").value) || 0;
    const fSize = parseFloat(document.getElementById("j-input-size").value) || 1;
    let fPnl = parseFloat(document.getElementById("j-input-pnl").value);
    const fNote = document.getElementById("j-input-note").value.trim();

    if (isNaN(fPnl) || fPnl === 0) {
      const diff = fSide === "LONG" ? (fExit - fEntry) : (fEntry - fExit);
      fPnl = diff * fSize;
    }

    const pnlPercent = fEntry > 0 ? parseFloat((((fExit - fEntry) / fEntry) * 100 * (fSide === "LONG" ? 1 : -1)).toFixed(2)) : 0;

    const selectedTags = [];
    document.querySelectorAll("#j-input-tags-box input:checked").forEach(cb => {
      selectedTags.push(cb.value);
    });

    if (fId) {
      const idx = trades.findIndex(t => t.id === fId);
      if (idx !== -1) {
        trades[idx] = {
          id: fId,
          date: fDate,
          symbol: fSym,
          exchange: fEx,
          side: fSide,
          entry: fEntry,
          exit: fExit,
          size: fSize,
          pnl: fPnl,
          pnlPercent,
          tags: selectedTags,
          note: fNote
        };
      }
    } else {
      const newTrade = {
        id: "tr_" + Date.now(),
        date: fDate,
        symbol: fSym,
        exchange: fEx,
        side: fSide,
        entry: fEntry,
        exit: fExit,
        size: fSize,
        pnl: fPnl,
        pnlPercent,
        tags: selectedTags,
        note: fNote
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
    const target = trades.find(t => t.id === tradeId);
    if (target) openTradeModal(target);
  }

  function deleteTrade(tradeId) {
    if (confirm("Удалить сделку из дневника?")) {
      trades = trades.filter(t => t.id !== tradeId);
      saveTrades();
      updateUI();
    }
  }

  function initJournal() {
    loadStorage();

    const btnAdd = document.getElementById("journal-btn-add");
    if (btnAdd) btnAdd.onclick = () => openTradeModal();

    const btnApi = document.getElementById("journal-btn-api");
    if (btnApi) {
      btnApi.onclick = () => {
        const modal = document.getElementById("journal-api-modal");
        if (modal) modal.style.display = "flex";
      };
    }

    const btnSaveTrade = document.getElementById("journal-save-trade");
    if (btnSaveTrade) btnSaveTrade.onclick = saveTradeFromModal;

    const btnCloseTrade = document.getElementById("journal-close-trade");
    if (btnCloseTrade) btnCloseTrade.onclick = closeTradeModal;

    const btnCloseApi = document.getElementById("journal-close-api");
    if (btnCloseApi) {
      btnCloseApi.onclick = () => {
        const modal = document.getElementById("journal-api-modal");
        if (modal) modal.style.display = "none";
      };
    }

    const inputSearch = document.getElementById("journal-search-input");
    if (inputSearch) {
      inputSearch.oninput = (e) => {
        filterSearch = e.target.value;
        renderTradesTable();
      };
    }

    const selectSide = document.getElementById("journal-filter-side");
    if (selectSide) {
      selectSide.onchange = (e) => {
        filterSide = e.target.value;
        renderTradesTable();
      };
    }

    const selectOutcome = document.getElementById("journal-filter-outcome");
    if (selectOutcome) {
      selectOutcome.onchange = (e) => {
        filterOutcome = e.target.value;
        renderTradesTable();
      };
    }

    const selectTag = document.getElementById("journal-filter-tag");
    if (selectTag) {
      selectTag.onchange = (e) => {
        filterTag = e.target.value;
        renderTradesTable();
      };
    }

    const btnDemoReset = document.getElementById("journal-btn-reset-demo");
    if (btnDemoReset) {
      btnDemoReset.onclick = () => {
        trades = [...DEMO_TRADES];
        saveTrades();
        updateUI();
      };
    }

    updateUI();
  }

  window.CryptoJournal = {
    init: initJournal,
    activate: () => {
      initJournal();
      setTimeout(drawEquityChart, 50);
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    initJournal();
  });
})();
