"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const DEFAULT_TOOL_COLORS = { line: "#facc15", "h-ray": "#a78bfa", rect: "#fb7185", ruler: "#facc15", fibgrid: "#8b5cf6", brush: "#facc15" };
  const DRAW_COLOR_PALETTE = ["#ff4d7a", "#34d399", "#7c3aed", "#38bdf8", "#fb923c", "#facc15", "#ec4899", "#22c55e", "#818cf8", "#a855f7", "#f87171", "#06b6d4", "#84cc16", "#f59e0b", "#64748b"];
  const loadToolColors = () => {
    try { return { ...DEFAULT_TOOL_COLORS, ...JSON.parse(localStorage.getItem("crypto_tool_colors") || "{}") }; }
    catch (_) { return { ...DEFAULT_TOOL_COLORS }; }
  };
  const state = {
    tf: "5m",
    exchange: "BB",
    session: null,
    requestSeq: 0,
    candles: [],
    stepBuffer: [],
    fetchingBuffer: false,
    serverDone: false,
    initialCount: 0,
    initialPrice: 0,
    speed: 450,
    playing: false,
    stepping: false,
    activated: false,
    done: false,
    revealQueue: [],
    indicators: new Set(["volume"]),
    tool: "none",
    toolColors: loadToolColors(),
    drawingPhase: 0,
    brushWidth: 2,
    drawings: [],
    draft: null,
    hoverDrawingIdx: -1,
    dragDrawing: null,
    hover: null,
    viewBars: 170,
    panBars: 0,
    priceOffset: 0,
    priceZoom: 1,
    panning: null,
    magnet: false,
    plannedDirection: null,
    levelModes: { sl: "percent", tp: "percent" },
    balance: 10000,
    position: null,
    trades: [],
    caseTradeStart: 0,
  };

  const canvas = $("bt-canvas");
  const volCv = $("bt-vol-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const vCtx = volCv ? volCv.getContext("2d") : null;
  const wrap = $("bt-canvas-wrap");

  const parseCandle = row => ({ t: +row[0], o: +row[1], h: +row[2], l: +row[3], c: +row[4], v: +row[5] });
  const money = value => `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pct = value => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  const price = value => {
    if (!Number.isFinite(value)) return "—";
    if (value >= 1000) return value.toFixed(2);
    if (value >= 1) return value.toFixed(4);
    if (value >= .01) return value.toFixed(6);
    return value.toPrecision(6);
  };
  const dateLabel = timestamp => new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC"
  }).format(new Date(timestamp)) + " UTC";

  function setLoading(on, message) {
    const loader = $("bt-loader");
    loader.hidden = !on;
    if (message) loader.querySelector("span").textContent = message;
  }

  function showResult(title, text, kind = "") {
    const el = $("bt-result");
    el.className = `bt-result ${kind}`;
    el.innerHTML = `<strong>${title}</strong><span>${text}</span>`;
    el.hidden = false;
  }

  function hideResult() { $("bt-result").hidden = true; }

  function updateControls() {
    const ready = Boolean(state.session);
    $("bt-step").disabled = !ready || state.done || state.playing || state.stepping || state.revealQueue.length > 0;
    $("bt-play").disabled = !ready || state.done || state.stepping || state.revealQueue.length > 0;
    $("bt-reveal").disabled = !ready || state.done || state.playing || state.stepping;
    $("bt-play").textContent = state.playing ? "❚❚ Пауза" : "▶ Запустить";
    $("bt-play").classList.toggle("playing", state.playing);
    updateProgressUI();
  }

  function updateProgressUI() {
    const revealed = Math.max(0, state.candles.length - state.initialCount);
    const total = state.session?.futureCount || 0;
    $("bt-progress-fill").style.width = total ? `${Math.min(100, revealed / total * 100)}%` : "0%";
    $("bt-remaining").textContent = state.done ? "Исход раскрыт" : total ? `${Math.max(0, total - revealed)} свечей скрыто` : "Будущее скрыто";
  }

  function resetCase() {
    stopPlaying();
    state.session = null;
    state.candles = [];
    state.stepBuffer = [];
    state.fetchingBuffer = false;
    state.serverDone = false;
    state.initialCount = 0;
    state.initialPrice = 0;
    state.done = false;
    state.drawings = [];
    state.draft = null;
    state.hoverDrawingIdx = -1;
    state.dragDrawing = null;
    state.drawingPhase = 0;
    state.tool = "none";
    document.querySelectorAll("[data-bt-tool]").forEach(button => button.classList.toggle("on", button.dataset.btTool === "none"));
    state.hover = null;
    state.revealQueue = [];
    state.position = null;
    state.panBars = 0;
    state.priceOffset = 0;
    state.priceZoom = 1;
    state.panning = null;
    state.plannedDirection = null;
    state.caseTradeStart = state.trades.length;
    $("bt-long").classList.remove("on");
    $("bt-short").classList.remove("on");
    $("bt-commit-plan").disabled = true;
    $("bt-plan-state").textContent = "АНАЛИЗ";
    document.querySelectorAll(".bt-stage-row span").forEach((el, index) => el.classList.toggle("on", index === 0));
    if ($("bt-thesis")) $("bt-thesis").value = "";
    renderPosition();
    hideResult();
    updateControls();
    draw();
  }

  async function fetchStepBuffer(count = 50) {
    if (!state.session || state.serverDone || state.fetchingBuffer) return;
    state.fetchingBuffer = true;
    try {
      const response = await fetch(`/api/backtest/${state.session.id}/step?count=${count}`, { method: "POST", cache: "no-store" });
      const data = await response.json();
      if (response.ok && data.candles) {
        for (const row of data.candles) state.stepBuffer.push(parseCandle(row));
        if (data.done) state.serverDone = true;
      }
    } catch (_) {
    } finally {
      state.fetchingBuffer = false;
    }
  }

  async function newCase() {
    const requestSeq = ++state.requestSeq;
    resetCase();
    setLoading(true, "Подбираем активный сетап…");
    $("bt-new").disabled = true;
    try {
      const response = await fetch(`/api/backtest/new?tf=${encodeURIComponent(state.tf)}&ex=${encodeURIComponent(state.exchange)}`, { cache: "no-store" });
      const data = await response.json();
      if (requestSeq !== state.requestSeq) return;
      if (!response.ok) throw new Error(data.error || "Не удалось создать бэктест");
      state.session = data;
      state.candles = data.candles.map(parseCandle);
      state.initialCount = state.candles.length;
      state.initialPrice = state.candles[state.candles.length - 1].c;
      $("bt-symbol").textContent = data.sym;
      $("bt-exchange").textContent = data.exchange;
      $("bt-watermark").textContent = `${data.sym} · ${data.tf}`;
      $("bt-date").textContent = `Анализ на ${dateLabel(data.cutoffTime)}`;
      $("bt-pool").textContent = `Трендовый топ · ${data.universeSize} монет`;
      setLoading(false);
      updateControls();
      draw();
      // Pre-buffer first batch of candles in background
      fetchStepBuffer(50);
    } catch (error) {
      if (requestSeq === state.requestSeq) setLoading(true, error.message || "Ошибка загрузки. Попробуйте ещё раз.");
    } finally {
      if (requestSeq === state.requestSeq) $("bt-new").disabled = false;
    }
  }

  async function step() {
    if (!state.session || state.done || state.stepping || state.playing || state.revealQueue.length) return false;
    state.stepping = true;
    updateControls();
    try {
      if (!state.stepBuffer.length && !state.serverDone) {
        await fetchStepBuffer(20);
      }
      if (state.stepBuffer.length > 0) {
        const c = state.stepBuffer.shift();
        appendCandle(c);
        if (state.stepBuffer.length < 15 && !state.serverDone) fetchStepBuffer(50);
        if (!state.stepBuffer.length && state.serverDone) finishCase();
        return true;
      } else if (state.serverDone) {
        finishCase();
        return false;
      }
      return false;
    } finally {
      state.stepping = false;
      updateControls();
    }
  }

  function stopPlaying() {
    state.playing = false;
    if (state.playTimer) {
      clearTimeout(state.playTimer);
      state.playTimer = null;
    }
    updateControls();
  }

  function togglePlay() {
    if (state.playing) return stopPlaying();
    if (!state.session || state.done) return;
    state.playing = true;
    updateControls();

    if (state.stepBuffer.length < 25 && !state.serverDone) {
      fetchStepBuffer(50);
    }

    const playTick = async () => {
      if (!state.playing || state.done) return;

      if (state.stepBuffer.length > 0) {
        const candle = state.stepBuffer.shift();
        appendCandle(candle);

        if (state.stepBuffer.length < 15 && !state.serverDone && !state.fetchingBuffer) {
          fetchStepBuffer(50);
        }
      } else if (state.serverDone) {
        finishCase();
        return stopPlaying();
      } else if (!state.fetchingBuffer) {
        await fetchStepBuffer(30);
        if (state.stepBuffer.length > 0) {
          const candle = state.stepBuffer.shift();
          appendCandle(candle);
        }
      }

      if (state.playing && !state.done) {
        state.playTimer = setTimeout(playTick, state.speed);
      } else {
        stopPlaying();
      }
    };

    playTick();
  }

  async function reveal() {
    if (!state.session || state.done || state.stepping) return;
    stopPlaying();
    state.stepping = true;
    updateControls();
    try {
      const response = await fetch(`/api/backtest/${state.session.id}/reveal`, { method: "POST", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Ошибка раскрытия");
      const revealCandles = (data.candles || []).map(parseCandle);
      state.revealQueue = [...state.stepBuffer, ...revealCandles];
      state.stepBuffer = [];
      state.stepping = false;
      animateReveal();
    } catch (error) {
      state.stepping = false;
      showResult("Не удалось показать исход", error.message, "bad");
      updateControls();
    }
  }

  function animateReveal() {
    if (!state.revealQueue.length) {
      finishCase();
      return;
    }
    appendCandle(state.revealQueue.shift());
    state.playTimer = setTimeout(animateReveal, Math.max(25, Math.min(80, state.speed / 4)));
  }

  function appendCandle(candle) {
    if (!candle) return;
    if (state.panBars > 0) state.panBars++;
    state.candles.push(candle);
    updateTrade(candle);
    updateProgressUI();
    draw();
  }

  function selectDirection(direction) {
    if (state.position || state.done) return;
    state.plannedDirection = direction;
    $("bt-long").classList.toggle("on", direction === "long");
    $("bt-short").classList.toggle("on", direction === "short");
    $("bt-commit-plan").disabled = false;
    $("bt-plan-state").textContent = "РЕШЕНИЕ";
    document.querySelectorAll(".bt-stage-row span").forEach((el, index) => el.classList.toggle("on", index === 1));
    draw();
  }

  function getPlannedLevels() {
    const entry = state.candles[state.candles.length - 1]?.c || 0;
    const direction = state.plannedDirection || state.position?.direction;
    if (!entry || !direction) return { entry, sl: 0, tp: 0 };
    const sign = direction === "long" ? 1 : -1;
    const parseLevel = value => Math.max(0, Number(String(value || "").trim().replace(",", ".")) || 0);
    const slRaw = parseLevel($("bt-sl").value);
    const tpRaw = parseLevel($("bt-tp").value);
    return {
      entry,
      sl: state.levelModes.sl === "price" ? slRaw : (slRaw ? entry * (1 - sign * slRaw / 100) : 0),
      tp: state.levelModes.tp === "price" ? tpRaw : (tpRaw ? entry * (1 + sign * tpRaw / 100) : 0),
    };
  }

  function openPosition(direction = state.plannedDirection) {
    if (!state.session || state.position || state.done || !state.candles.length) return;
    if (!direction) return;
    const entry = state.candles[state.candles.length - 1].c;
    const size = Math.max(10, +$("bt-size").value || 1000);
    const levels = getPlannedLevels();
    state.position = {
      direction, entry, size, qty: size / entry,
      sl: levels.sl,
      tp: levels.tp,
      openedAt: state.candles[state.candles.length - 1].t,
      unrealized: 0,
    };
    $("bt-commit-plan").disabled = true;
    renderPosition();
    draw();
  }

  function updateTrade(candle) {
    const p = state.position;
    if (!p) { $("bt-position").innerHTML = ""; return; }
    const isLong = p.direction === "long";
    // Conservative handling when SL and TP are touched in the same candle: SL first.
    if (p.sl && (isLong ? candle.l <= p.sl : candle.h >= p.sl)) return closePosition(p.sl, "Стоп-лосс");
    if (p.tp && (isLong ? candle.h >= p.tp : candle.l <= p.tp)) return closePosition(p.tp, "Тейк-профит");
    p.unrealized = (candle.c - p.entry) * p.qty * (isLong ? 1 : -1);
    renderPosition();
  }

  function closePosition(exitPrice, reason = "Закрыто вручную") {
    const p = state.position;
    if (!p) return;
    const last = state.candles[state.candles.length - 1];
    const pnl = (exitPrice - p.entry) * p.qty * (p.direction === "long" ? 1 : -1);
    const trade = { ...p, exit: exitPrice, pnl, reason, closedAt: last?.t || Date.now() };
    state.balance += pnl;
    state.trades.push(trade);
    state.position = null;
    state.plannedDirection = null;
    $("bt-long").classList.remove("on");
    $("bt-short").classList.remove("on");
    renderPosition();
    renderStats();
    draw();
  }

  function renderPosition() {
    const p = state.position;
    const posEmpty = $("bt-position-empty");
    const posEl = $("bt-position");
    const closeBtn = $("bt-close-position");
    const balEl = $("bt-balance");
    const pnlEl = $("bt-pnl");

    if (posEmpty) posEmpty.hidden = Boolean(p);
    if (posEl) posEl.hidden = !p;
    if (closeBtn) closeBtn.disabled = !p;
    if (balEl) balEl.textContent = money(state.balance);
    if (pnlEl) {
      pnlEl.textContent = money(p?.unrealized || 0);
      pnlEl.style.color = !p ? "" : p.unrealized >= 0 ? "var(--gr)" : "var(--rd)";
    }
    if (!p || !posEl) return;
    posEl.innerHTML = `
      <span>Направление<b style="color:${p.direction === "long" ? "var(--gr)" : "var(--rd)"}">${p.direction.toUpperCase()}</b></span>
      <span>Вход<b>${price(p.entry)}</b></span>
      <span>Стоп<b>${p.sl ? price(p.sl) : "—"}</b></span>
      <span>Тейк<b>${p.tp ? price(p.tp) : "—"}</b></span>`;
  }

  function renderStats() {
    const statsEl = $("bt-session-stats");
    if (!statsEl) return;
    const wins = state.trades.filter(t => t.pnl > 0).length;
    const totalPnl = state.trades.reduce((sum, t) => sum + t.pnl, 0);
    statsEl.innerHTML = `<span>Сделок <b>${state.trades.length}</b></span><span>Win rate <b>${state.trades.length ? Math.round(wins / state.trades.length * 100) + "%" : "—"}</b></span><span>Результат <b style="color:${totalPnl >= 0 ? "var(--gr)" : "var(--rd)"}">${money(totalPnl)}</b></span>`;
  }

  function finishCase() {
    if (state.done) return;
    state.done = true;
    $("bt-plan-state").textContent = "РАЗБОР";
    document.querySelectorAll(".bt-stage-row span").forEach((el, index) => el.classList.toggle("on", index === 2));
    state.revealQueue = [];
    stopPlaying();
    if (state.position && state.candles.length) closePosition(state.candles[state.candles.length - 1].c, "Конец сценария");
    const lastTrade = state.trades.length > state.caseTradeStart ? state.trades[state.trades.length - 1] : null;
    const marketMove = state.initialPrice ? (state.candles[state.candles.length - 1].c / state.initialPrice - 1) * 100 : 0;
    if (lastTrade && lastTrade.closedAt >= state.candles[state.initialCount]?.t) {
      showResult(lastTrade.pnl >= 0 ? "Сценарий отработан в плюс" : "Сценарий закрылся в минус", `${lastTrade.reason} · ${money(lastTrade.pnl)} · рынок ${pct(marketMove)}`, lastTrade.pnl >= 0 ? "good" : "bad");
    } else {
      showResult("Исход раскрыт", `От точки анализа рынок прошёл ${pct(marketMove)}. Сделка не открывалась.`);
    }
    updateControls();
    draw();
  }

  function ema(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
    return out;
  }

  function sma(values, period) {
    const out = new Array(values.length).fill(NaN); let sum = 0;
    for (let i = 0; i < values.length; i++) { sum += values[i]; if (i >= period) sum -= values[i-period]; if (i >= period-1) out[i] = sum / period; }
    return out;
  }

  function rsiValues(values, period = 14) {
    const out = new Array(values.length).fill(NaN); let gains = 0, losses = 0;
    for (let i = 1; i < values.length; i++) {
      const change = values[i] - values[i-1]; gains += Math.max(0,change); losses += Math.max(0,-change);
      if (i > period) { const old = values[i-period] - values[i-period-1]; gains -= Math.max(0,old); losses -= Math.max(0,-old); }
      if (i >= period) out[i] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
    }
    return out;
  }

  function atrValues(candles, period = 14) {
    const tr = candles.map((c,i) => i ? Math.max(c.h-c.l,Math.abs(c.h-candles[i-1].c),Math.abs(c.l-candles[i-1].c)) : c.h-c.l);
    return sma(tr,period);
  }

  function cvdValues(candles) {
    let total = 0;
    return candles.map(c => { total += (c.c >= c.o ? 1 : -1) * (c.v || 0); return total; });
  }

  function bollingerValues(values, period = 20, deviation = 2) {
    const middle = sma(values, period);
    const upper = new Array(values.length).fill(NaN);
    const lower = new Array(values.length).fill(NaN);
    for (let i = period - 1; i < values.length; i++) {
      const mean = middle[i];
      let variance = 0;
      for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mean) ** 2;
      const sigma = Math.sqrt(variance / period) * deviation;
      upper[i] = mean + sigma;
      lower[i] = mean - sigma;
    }
    return { middle, upper, lower };
  }

  function drawSeries(m, values, color, yForValue = m.yForPrice, lineWidth = 1.2) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let started = false;
    m.data.forEach((_, i) => {
      const value = values[m.start + i];
      if (!Number.isFinite(value)) { started = false; return; }
      const x = m.xForIndex(i), y = yForValue(value);
      if (!Number.isFinite(y)) { started = false; return; }
      if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
    });
    ctx.stroke();
    ctx.restore();
  }

  function drawVolumeProfile(m) {
    if (!state.indicators.has("vp") || !m.data.length) return;
    const bins = 28;
    const volumes = new Array(bins).fill(0);
    const span = Math.max(1e-12, m.max - m.min);
    m.data.forEach(c => {
      const typical = (c.h + c.l + c.c) / 3;
      const bin = Math.max(0, Math.min(bins - 1, Math.floor((typical - m.min) / span * bins)));
      volumes[bin] += Math.max(0, c.v || 0);
    });
    const maxVolume = Math.max(1, ...volumes);
    const maxWidth = Math.min(180, m.plot.w * .2);
    ctx.save();
    volumes.forEach((volume, index) => {
      if (!volume) return;
      const yTop = m.plot.priceH - (index + 1) / bins * m.plot.priceH;
      const height = Math.max(1, m.plot.priceH / bins - 1);
      const width = volume / maxVolume * maxWidth;
      ctx.fillStyle = index >= bins / 2 ? "rgba(139,92,246,.16)" : "rgba(56,189,248,.13)";
      ctx.fillRect(m.plot.w - width, yTop, width, height);
    });
    ctx.fillStyle = "rgba(167,139,250,.72)";
    ctx.font = "700 8px Inter, sans-serif";
    ctx.fillText("VP", m.plot.w - maxWidth, 12);
    ctx.restore();
  }

  function drawSubIndicators(m, allClose) {
    if (!m.subKeys.length || !vCtx) return;
    const all = state.candles;
    const cache = {};
    m.subKeys.forEach((key, panelIndex) => {
      const top = panelIndex * m.subPanelH;
      const height = m.subPanelH;
      vCtx.save();
      vCtx.beginPath();
      vCtx.rect(0, top, m.plot.w, height);
      vCtx.clip();

      vCtx.fillStyle = "rgba(13, 15, 20, 0.95)";
      vCtx.fillRect(0, top, m.plot.w, height);
      vCtx.strokeStyle = "rgba(255,255,255,.06)";
      vCtx.lineWidth = 1;
      vCtx.beginPath(); vCtx.moveTo(0, top + .5); vCtx.lineTo(m.plot.w, top + .5); vCtx.stroke();

      let values;
      let label = key.toUpperCase();
      let color = "#a78bfa";
      let min = 0, max = 1;
      if (key === "rsi") {
        values = cache.rsi || (cache.rsi = rsiValues(allClose));
        min = 0; max = 100; color = "#a78bfa"; label = "RSI 14";
      } else if (key === "atr") {
        values = cache.atr || (cache.atr = atrValues(all));
        const visible = values.slice(m.start, m.end).filter(Number.isFinite);
        min = 0; max = Math.max(...visible, 1e-12); color = "#fb923c"; label = "ATR 14";
      } else if (key === "cvd") {
        values = cache.cvd || (cache.cvd = cvdValues(all));
        const visible = values.slice(m.start, m.end).filter(Number.isFinite);
        min = Math.min(...visible, 0); max = Math.max(...visible, 1); color = "#ec4899"; label = "CVD";
      } else if (key === "macd") {
        const fast = cache.fast12 || (cache.fast12 = ema(allClose, 12));
        const slow = cache.slow26 || (cache.slow26 = ema(allClose, 26));
        values = fast.map((value, i) => value - slow[i]);
        const signal = ema(values, 9);
        const histogram = values.map((value, i) => value - signal[i]);
        const visible = [...values.slice(m.start, m.end), ...signal.slice(m.start, m.end), ...histogram.slice(m.start, m.end)].filter(Number.isFinite);
        const bound = Math.max(...visible.map(Math.abs), 1e-12);
        min = -bound; max = bound; color = "#3b82f6"; label = "MACD 12 26 9";
        const yFor = value => top + 4 + (max - value) / (max - min) * (height - 8);
        const zeroY = yFor(0);
        histogram.slice(m.start, m.end).forEach((value, i) => {
          if (!Number.isFinite(value)) return;
          const y = yFor(value);
          vCtx.fillStyle = value >= 0 ? "rgba(34,197,94,.7)" : "rgba(239,68,68,.7)";
          vCtx.fillRect(m.xForIndex(i) - Math.max(.5, m.stepX * .27), Math.min(y, zeroY), Math.max(1, m.stepX * .54), Math.max(1, Math.abs(zeroY - y)));
        });
        vCtx.beginPath();
        vCtx.strokeStyle = "#f43f5e";
        vCtx.lineWidth = 1.2;
        signal.slice(m.start, m.end).forEach((value, i) => {
          if (!Number.isFinite(value)) return;
          const x = m.xForIndex(i);
          const y = yFor(value);
          if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
        });
        vCtx.stroke();
      }

      const yFor = value => top + 4 + (max - value) / Math.max(1e-12, max - min) * (height - 8);
      if (key === "rsi") {
        [30, 70].forEach(level => {
          const y = yFor(level); vCtx.setLineDash([3, 4]); vCtx.strokeStyle = "rgba(255,255,255,.15)";
          vCtx.beginPath(); vCtx.moveTo(0, y); vCtx.lineTo(m.plot.w, y); vCtx.stroke(); vCtx.setLineDash([]);
        });
      }
      if (key === "macd") {
        const zeroY = yFor(0); vCtx.strokeStyle = "rgba(255,255,255,.12)"; vCtx.beginPath(); vCtx.moveTo(0, zeroY); vCtx.lineTo(m.plot.w, zeroY); vCtx.stroke();
      }

      vCtx.beginPath();
      vCtx.strokeStyle = color;
      vCtx.lineWidth = 1.5;
      values.slice(m.start, m.end).forEach((value, i) => {
        if (!Number.isFinite(value)) return;
        const x = m.xForIndex(i);
        const y = yFor(value);
        if (i === 0) vCtx.moveTo(x, y); else vCtx.lineTo(x, y);
      });
      vCtx.stroke();

      const lastValue = values?.[values.length - 1];
      // Rounded dark glass pill badge for indicator label
      vCtx.fillStyle = "rgba(18, 20, 29, 0.85)";
      vCtx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      vCtx.lineWidth = 1;
      const textStr = `${label}${Number.isFinite(lastValue) ? `  ${price(lastValue)}` : ""}`;
      vCtx.font = "bold 9px Inter, sans-serif";
      const tw = vCtx.measureText(textStr).width;
      vCtx.fillRect(6, top + 4, tw + 10, 15);
      vCtx.strokeRect(6, top + 4, tw + 10, 15);
      vCtx.fillStyle = color;
      vCtx.fillText(textStr, 11, top + 15);
      vCtx.restore();
    });
  }

  function metrics() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const right = 82, bottom = 23;
    const subKeys = ["rsi", "atr", "macd", "cvd"].filter(key => state.indicators.has(key));
    const subPanelH = Math.min(54, Math.max(38, (h - bottom) * .10));
    const subTotalH = subKeys.length * subPanelH;
    const volumeH = state.indicators.has("volume") ? Math.min(70, h * .13) : 0;
    const volTotalH = volumeH + subTotalH;

    if (volCv && vCtx) {
      if (volCv.width !== Math.round(w * dpr) || volCv.height !== Math.round(volTotalH * dpr)) {
        volCv.width = Math.round(w * dpr); volCv.height = Math.round(volTotalH * dpr);
        volCv.style.width = `${w}px`; volCv.style.height = `${volTotalH}px`;
      }
      vCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const plot = { x: 0, y: 0, w: Math.max(20, w - right), h: Math.max(40, h - bottom), priceH: Math.max(90, h - bottom - volumeH - subTotalH) };
    const count = Math.min(state.viewBars, state.candles.length);
    const minPan = -Math.floor(count * .45);
    const futureGap = Math.max(0, -state.panBars);
    const visibleCapacity = Math.max(10, count - futureGap);
    const maxPan = Math.max(0, state.candles.length - visibleCapacity);
    state.panBars = Math.max(minPan, Math.min(maxPan, state.panBars));
    const actualGap = Math.max(0, -state.panBars);
    const actualCapacity = Math.max(10, count - actualGap);
    const end = Math.max(actualCapacity, state.candles.length - Math.max(0, state.panBars));
    const start = Math.max(0, end - actualCapacity);
    const data = state.candles.slice(start, end);
    let min = Math.min(...data.map(c => c.l));
    let max = Math.max(...data.map(c => c.h));
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    const naturalRange = Math.max(max - min, max * .002);
    const center = (max + min) / 2 + state.priceOffset;
    const range = naturalRange * 1.18 * state.priceZoom;
    min = center - range / 2; max = center + range / 2;
    const stepX = plot.w / Math.max(1, count);
    const xForIndex = i => plot.x + (i + .5) * stepX;
    const yForPrice = p => plot.y + (max - p) / Math.max(1e-12, max - min) * plot.priceH;
    return { w, h, plot, data, start, end, min, max, stepX, xForIndex, yForPrice, volumeH, range, subKeys, subPanelH, subTotalH, volTotalH, futureGap: actualGap };
  }

  function draw() {
    const m = metrics();
    ctx.clearRect(0, 0, m.w, m.h);
    ctx.fillStyle = "#0d0f14"; ctx.fillRect(0, 0, m.w, m.h);
    ctx.lineWidth = 1;
    ctx.font = "9px Inter, sans-serif";

    if (volCv && vCtx) {
      vCtx.clearRect(0, 0, m.w, m.volTotalH);
    }

    // Dynamic price scale grid using calcNiceStep (matching Screener 1:1)
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const pr = m.max - m.min || 1;
    const gridStep = typeof calcNiceStep === "function" ? calcNiceStep(pr, Math.max(4, Math.floor(m.plot.priceH / 70))) : pr / 5;
    let gridPrice = Math.ceil(m.min / gridStep) * gridStep;
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(255,255,255,.045)";
    ctx.lineWidth = 1;
    ctx.font = "10px Inter, sans-serif";
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "left";
    while (gridPrice <= m.max + gridStep * 0.01) {
      const y = m.yForPrice(gridPrice);
      if (y >= 0 && y <= m.plot.priceH) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(m.plot.w, y); ctx.stroke();
        ctx.fillText(price(gridPrice), m.plot.w + 6, y + 4);
      }
      gridPrice += gridStep;
    }

    // Time grid lines
    for (let i = 0; i <= 6; i++) {
      const x = m.plot.w * i / 6 + .5;
      ctx.strokeStyle = "rgba(255,255,255,.035)"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, m.plot.h); ctx.stroke();
      const c = m.data[Math.min(m.data.length - 1, Math.floor(m.data.length * i / 6))];
      if (c) { ctx.fillStyle = "#596071"; ctx.fillText(new Date(c.t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }), Math.min(x + 3, m.plot.w - 38), m.h - 7); }
    }

    if (state.session && m.data.length) {
      ctx.save(); ctx.globalAlpha = .04; ctx.fillStyle = "#d1d4dc"; ctx.font = `700 ${Math.min(52, m.plot.w / 10)}px Inter`; ctx.textAlign = "center";
      ctx.fillText(state.session.sym, m.plot.w / 2, m.plot.priceH / 2); ctx.restore();
    }

    drawVolumeProfile(m);

    // Volume on vCtx
    if (m.volumeH && m.data.length && vCtx) {
      const visibleVols = m.data.map(c => Number.isFinite(c.v) && c.v > 0 ? c.v : 0);
      const sortedVols = visibleVols.filter(v => v > 0).sort((a, b) => a - b);
      const absoluteMax = sortedVols[sortedVols.length - 1] || 0;
      const p97 = sortedVols[Math.floor((sortedVols.length - 1) * .97)] || absoluteMax;
      const maxVol = Math.max(1, Math.min(absoluteMax, p97 * 1.2));
      const volumeTop = m.subTotalH;

      vCtx.save();
      vCtx.beginPath();
      vCtx.rect(0, volumeTop, m.plot.w, m.volumeH);
      vCtx.clip();

      const volW = Math.max(1, m.stepX > 3 ? m.stepX - 2 : m.stepX);
      m.data.forEach((c, i) => {
        const vh = Math.min(1, visibleVols[i] / maxVol) * (m.volumeH - 8);
        vCtx.fillStyle = c.c >= c.o ? "rgba(38,201,122,.85)" : "rgba(255,69,96,.85)";
        if (vh > 0) vCtx.fillRect(m.xForIndex(i) - volW / 2, volumeTop + m.volumeH - Math.max(1, vh), volW, Math.max(1, vh));
      });

      vCtx.fillStyle = "rgba(18, 20, 29, 0.85)";
      vCtx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      vCtx.fillRect(6, volumeTop + 4, 38, 15);
      vCtx.strokeRect(6, volumeTop + 4, 38, 15);
      vCtx.fillStyle = "rgba(255,255,255,.6)"; vCtx.font = "bold 9px Inter, sans-serif"; vCtx.fillText("VOL", 11, volumeTop + 15);
      vCtx.restore();
    }

    // Clip main price chart area so candles & overlay indicators never bleed into volume/sub-indicators
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, m.plot.w, m.plot.priceH);
    ctx.clip();

    // Indicators
    const allClose = state.candles.map(c => c.c);
    if (state.indicators.has("ema20")) drawSeries(m, ema(allClose, 20), "#f59e0b");
    if (state.indicators.has("ema50")) drawSeries(m, ema(allClose, 50), "#3b82f6");
    if (state.indicators.has("ema200")) drawSeries(m, ema(allClose, 200), "#ec4899", m.yForPrice, 1.35);
    if (state.indicators.has("vwap")) {
      let pv = 0, volume = 0;
      const values = state.candles.map(c => { pv += ((c.h + c.l + c.c) / 3) * Math.max(0, c.v); volume += Math.max(0, c.v); return volume ? pv / volume : c.c; });
      drawSeries(m, values, "#a78bfa", m.yForPrice, 1.35);
    }
    if (state.indicators.has("bb")) {
      const bands = bollingerValues(allClose);
      drawSeries(m, bands.upper, "rgba(56,189,248,.8)");
      drawSeries(m, bands.middle, "rgba(148,163,184,.52)", m.yForPrice, 1);
      drawSeries(m, bands.lower, "rgba(56,189,248,.8)");
    }

    // Smart Money Concepts & Liquidation Heatmap
    if (typeof renderSmartMoneyConcepts === "function") {
      window.chartActiveSmc = state.indicators;
      renderSmartMoneyConcepts(ctx, state.candles, m.start, m.data.length, m.stepX, m.futureGap || 0, m.yForPrice, m.plot.w, m.plot.priceH, 0, m.start);
    }
    if (state.indicators.has("liqmap") && typeof renderLiquidationHeatmap === "function") {
      renderLiquidationHeatmap(ctx, state.candles, m.start, m.data.length, m.stepX, m.futureGap || 0, m.yForPrice, m.plot.w, m.plot.priceH, 0, m.start);
    }

    // Pixel-perfect Sub-pixel Candles matching main Screener 1:1
    const hw = Math.max(0.5, (m.stepX - 2) / 2);
    m.data.forEach((c, i) => {
      const rawX = m.xForIndex(i);
      const up = c.c >= c.o;
      const yH = m.yForPrice(c.h), yL = m.yForPrice(c.l);
      const yO = m.yForPrice(c.o), yC = m.yForPrice(c.c);
      const bT = Math.min(yO, yC), bH = Math.max(1, Math.abs(yC - yO));

      // 1px wicks aligned on DPR grid
      const wickX = (Math.floor(rawX * dpr) + 0.5) / dpr;
      const wickYH = Math.round(yH * dpr) / dpr;
      const wickYL = Math.round(yL * dpr) / dpr;
      ctx.strokeStyle = up ? "#26c97a" : "#ff4560";
      ctx.lineWidth = 1 / dpr;
      ctx.beginPath();
      ctx.moveTo(wickX, wickYH);
      ctx.lineTo(wickX, wickYL);
      ctx.stroke();

      // Solid filled candle body
      const leftX = Math.round((rawX - hw) * dpr);
      const rightX = Math.round((rawX + hw) * dpr);
      const topY = Math.round(bT * dpr);
      const bottomY = Math.round((bT + bH) * dpr);

      const fillX = leftX / dpr;
      const fillY = topY / dpr;
      const fillW = Math.max(1 / dpr, (rightX - leftX) / dpr);
      const fillH = Math.max(1 / dpr, (bottomY - topY) / dpr);

      ctx.fillStyle = up ? "#26c97a" : "#ff4560";
      ctx.fillRect(fillX, fillY, fillW, fillH);
    });

    ctx.restore();

    drawSubIndicators(m, allClose);

    // Replay start boundary
    const firstFutureIndex = state.initialCount - m.start;
    if (firstFutureIndex >= 0 && firstFutureIndex < m.data.length) {
      const x = m.xForIndex(firstFutureIndex) - m.stepX / 2;
      ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(139,92,246,.8)"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, m.plot.h); ctx.stroke(); ctx.restore();
      ctx.fillStyle = "#8b5cf6"; ctx.fillText("REPLAY", x + 5, 13);
    }

    drawUserObjects(m);
    drawPositionLines(m);

    // Right axis thin divider
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m.plot.w, 0);
    ctx.lineTo(m.plot.w, m.h);
    ctx.stroke();

    // Last price line & rounded badge (matching Screener 1:1)
    const last = m.data[m.data.length - 1];
    if (last) {
      const ly = m.yForPrice(last.c);
      const up = last.c >= last.o;
      const ly2 = Math.max(10, Math.min(m.plot.priceH - 10, ly));
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,.15)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, ly2);
      ctx.lineTo(m.plot.w, ly2);
      ctx.stroke();
      ctx.setLineDash([]);

      const tH = 22, tW = 74, tX = m.plot.w + 4, tY = ly2 - tH / 2;
      if (typeof roundRect === "function") roundRect(ctx, tX, tY, tW, tH, 6);
      else ctx.rect(tX, tY, tW, tH);
      ctx.fillStyle = "#0d0f14";
      ctx.fill();
      ctx.strokeStyle = up ? "#26c97a" : "#ff4560";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(price(last.c), m.plot.w + 41, ly2 + 4);
      ctx.restore();
    }

    if (state.hover && state.tool === "none") drawCrosshair(m);
  }

  function drawPositionLines(m) {
    const position = state.position;
    const planned = !position && state.plannedDirection ? { ...getPlannedLevels(), direction: state.plannedDirection } : null;
    const p = position || planned;
    if (!p) return;
    const isPreview = !position;
    [[p.entry, p.direction === "long" ? "#26c97a" : "#ff4560", isPreview ? "ПЛАН" : "ENTRY"], [p.sl, "#ff4560", "SL"], [p.tp, "#26c97a", "TP"]].forEach(([value, color, label]) => {
      if (!value || value < m.min || value > m.max) return;
      const y = m.yForPrice(value); ctx.save(); ctx.globalAlpha = isPreview ? .68 : 1; ctx.setLineDash(isPreview ? [3, 4] : [5, 3]); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(m.plot.w, y); ctx.stroke(); ctx.restore();
      ctx.fillStyle = color; ctx.fillText(`${label} ${price(value)}`, 6, y - 4);
    });
  }

  function drawingPointFromMouse(event) {
    const m = metrics();
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(m.plot.w, event.clientX - rect.left));
    const y = Math.max(0, Math.min(m.plot.priceH, event.clientY - rect.top));
    const local = Math.max(0, Math.min(m.data.length - 1, Math.floor(x / Math.max(1, m.stepX))));
    const candle = m.data[local];
    let p = m.max - y / m.plot.priceH * (m.max - m.min);
    if (state.magnet && candle) {
      p = [candle.o, candle.h, candle.l, candle.c].reduce((best, value) => Math.abs(value - p) < Math.abs(best - p) ? value : best, candle.c);
    }
    return { t: candle?.t || Date.now(), p, x, y };
  }

  function drawUserObjects(m) {
    const objects = state.draft ? [...state.drawings, state.draft] : state.drawings;
    const timeToX = t => {
      const index = m.data.findIndex(c => c.t === t);
      if (index >= 0) return m.xForIndex(index);
      if (!m.data.length) return -999;
      return (t - m.data[0].t) / Math.max(1, m.data[m.data.length - 1].t - m.data[0].t) * (m.plot.w - m.stepX) + m.stepX / 2;
    };
    objects.forEach(o => {
      ctx.save(); ctx.strokeStyle = o.color; ctx.fillStyle = o.color; ctx.lineWidth = 1.4;
      const x1 = timeToX(o.a.t), y1 = m.yForPrice(o.a.p);
      if (o.type === "h-ray") {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(m.plot.w, y1); ctx.stroke();
        ctx.beginPath(); ctx.arc(x1, y1, 3.5, 0, Math.PI * 2); ctx.fill();
        const badgeW = m.axisR.w - 6;
        const badgeH = 18;
        const badgeX = m.plot.w + 3;
        const badgeY = y1 - badgeH / 2;
        ctx.save();
        ctx.fillStyle = "#151722";
        ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
        ctx.strokeStyle = o.color || "#a78bfa";
        ctx.lineWidth = 1.4;
        ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 9px Inter";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(formatPrice(o.a.p), badgeX + badgeW / 2, y1);
        ctx.restore();
      } else if (o.type === "brush" && o.points?.length) {
        ctx.lineWidth = o.lineWidth || 2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath();
        o.points.forEach((point, index) => { const x = timeToX(point.t), y = m.yForPrice(point.p); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      } else if (o.b) {
        const x2 = timeToX(o.b.t), y2 = m.yForPrice(o.b.p);
        if (o.type === "line") { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.beginPath(); ctx.arc(x1,y1,3.5,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(x2,y2,3.5,0,Math.PI*2); ctx.fill(); }
        if (o.type === "rect") { ctx.globalAlpha = .12; ctx.fillRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1)); ctx.globalAlpha = .8; ctx.strokeRect(Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1)); }
        if (o.type === "ruler") {
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          const change = (o.b.p / o.a.p - 1) * 100;
          const bars = Math.max(0, Math.round(Math.abs(x2 - x1) / Math.max(1, m.stepX)));
          const label = `${change >= 0 ? "+" : ""}${change.toFixed(2)}% · ${bars} свеч.`;
          ctx.font = "700 9px Inter"; const tw = ctx.measureText(label).width;
          ctx.globalAlpha = .92; ctx.fillStyle = "#181b26"; ctx.fillRect((x1+x2)/2-tw/2-5,(y1+y2)/2-16,tw+10,16);
          ctx.fillStyle = o.color; ctx.fillText(label,(x1+x2)/2-tw/2,(y1+y2)/2-5);
        }
        if (o.type === "fibgrid") {
          [0,.236,.382,.5,.618,.786,1].forEach(level => {
            const yp = y1 + (y2-y1) * level;
            ctx.globalAlpha = level === 0 || level === 1 ? .9 : .55;
            ctx.beginPath(); ctx.moveTo(Math.min(x1,x2),yp); ctx.lineTo(Math.max(x1,x2),yp); ctx.stroke();
            ctx.font = "8px Inter"; ctx.fillText(String(level),Math.max(x1,x2)+4,yp+3);
          });
        }
      }
      ctx.restore();
    });
  }

  function drawCrosshair(m) {
    const x = state.hover.x, y = state.hover.y;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(209,212,220,.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, m.plot.h);
    ctx.moveTo(0, y); ctx.lineTo(m.plot.w, y);
    ctx.stroke();
    ctx.restore();

    if (y >= 0 && y <= m.plot.priceH) {
      const hoverPrice = m.max - (y / m.plot.priceH) * (m.max - m.min);
      const tH = 20, tW = 74, tX = m.plot.w + 4, tY = y - tH / 2;
      ctx.save();
      if (typeof roundRect === "function") roundRect(ctx, tX, tY, tW, tH, 4);
      else ctx.rect(tX, tY, tW, tH);
      ctx.fillStyle = "#1e1f2e";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(price(hoverPrice), m.plot.w + 41, y + 4);
      ctx.restore();
    }
  }

  function drawingScreenPoints(drawing, m) {
    const timeToX = t => {
      const index = m.data.findIndex(c => c.t === t);
      if (index >= 0) return m.xForIndex(index);
      if (!m.data.length) return -999;
      return (t - m.data[0].t) / Math.max(1, m.data[m.data.length - 1].t - m.data[0].t) * (m.plot.w - m.stepX) + m.stepX / 2;
    };
    return {
      x1: timeToX(drawing.a.t), y1: m.yForPrice(drawing.a.p),
      x2: drawing.b ? timeToX(drawing.b.t) : 0, y2: drawing.b ? m.yForPrice(drawing.b.p) : 0,
      timeToX,
    };
  }

  function pointSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = dx * dx + dy * dy;
    if (!len) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hitDrawing(drawing, px, py, m) {
    const points = drawingScreenPoints(drawing, m);
    const { x1, y1, x2, y2 } = points;
    if (Math.hypot(px - x1, py - y1) <= 9) return "p1";
    if (drawing.type !== "h-ray" && drawing.b && Math.hypot(px - x2, py - y2) <= 9) return "p2";
    if (drawing.type === "line" || drawing.type === "ruler") return pointSegmentDistance(px, py, x1, y1, x2, y2) < 7 ? "move" : null;
    if (drawing.type === "h-ray") return px >= x1 - 6 && Math.abs(py - y1) < 7 ? "move" : null;
    if (drawing.type === "rect" || drawing.type === "fibgrid") {
      const left = Math.min(x1,x2), right = Math.max(x1,x2), top = Math.min(y1,y2), bottom = Math.max(y1,y2);
      return px >= left - 6 && px <= right + 6 && py >= top - 6 && py <= bottom + 6 ? "move" : null;
    }
    if (drawing.type === "brush" && drawing.points?.length > 1) {
      for (let i = 1; i < drawing.points.length; i++) {
        const ax = points.timeToX(drawing.points[i-1].t), ay = m.yForPrice(drawing.points[i-1].p);
        const bx = points.timeToX(drawing.points[i].t), by = m.yForPrice(drawing.points[i].p);
        if (pointSegmentDistance(px,py,ax,ay,bx,by) < 7) return "move";
      }
    }
    return null;
  }

  function findDrawingAt(px, py, m) {
    for (let i = state.drawings.length - 1; i >= 0; i--) {
      const hit = hitDrawing(state.drawings[i], px, py, m);
      if (hit) return { idx: i, hit };
    }
    return null;
  }

  function getToolColor(tool) { return state.toolColors[tool] || DEFAULT_TOOL_COLORS[tool] || "#facc15"; }

  function applyToolButtonColors() {
    document.querySelectorAll("[data-bt-tool]").forEach(button => {
      const tool = button.dataset.btTool;
      if (tool === "none") button.style.removeProperty("--tool-accent");
      else button.style.setProperty("--tool-accent", getToolColor(tool));
    });
  }

  function setBtTool(tool) {
    if (tool === state.tool && tool !== "none") tool = "none";
    state.tool = tool;
    state.draft = null;
    state.drawingPhase = 0;
    document.querySelectorAll("[data-bt-tool]").forEach(button => button.classList.toggle("on", button.dataset.btTool === tool));
    canvas.style.cursor = tool === "none" ? "crosshair" : "crosshair";
    draw();
  }

  function openBtToolColorMenu(tool, button) {
    if (!tool || tool === "none") return;
    const menu = $("draw-color-menu");
    const grid = $("draw-color-grid");
    const title = $("draw-color-title");
    const brushControl = $("brush-thickness-control");
    const slider = $("brush-thickness-slider");
    const value = $("brush-thickness-value");
    title.textContent = tool === "brush" ? "Цвет и толщина кисти" : "Цвет линии";
    grid.innerHTML = "";
    brushControl.style.display = tool === "brush" ? "block" : "none";
    if (tool === "brush") {
      slider.value = state.brushWidth;
      value.textContent = `${state.brushWidth}px`;
      slider.oninput = event => { state.brushWidth = +event.target.value; value.textContent = `${state.brushWidth}px`; };
    }
    DRAW_COLOR_PALETTE.forEach(color => {
      const swatch = document.createElement("div");
      swatch.className = "tag-btn" + (getToolColor(tool) === color ? " on" : "");
      swatch.style.background = color;
      swatch.onclick = event => {
        event.stopPropagation();
        state.toolColors[tool] = color;
        localStorage.setItem("crypto_tool_colors", JSON.stringify(state.toolColors));
        applyToolButtonColors();
        menu.style.display = "none";
        draw();
      };
      grid.appendChild(swatch);
    });
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.min(rect.right + 10, window.innerWidth - 170)}px`;
    menu.style.top = `${Math.min(rect.top, window.innerHeight - (tool === "brush" ? 210 : 150))}px`;
    menu.style.display = "block";
  }

  function drawingIsValid(drawing) {
    if (!drawing?.a) return false;
    if (drawing.type === "h-ray") return true;
    if (!drawing.b) return false;
    const dt = Math.abs(drawing.b.t - drawing.a.t);
    const dp = Math.abs(drawing.b.p - drawing.a.p);
    if (drawing.type === "rect" || drawing.type === "fibgrid") return dt > 0 && dp > 0;
    return dt > 0 || dp > 0;
  }

  canvas.addEventListener("mousedown", event => {
    if (!state.session) return;
    event.preventDefault();

    if (event.button === 2) {
      if (state.drawingPhase > 0) { state.draft = null; state.drawingPhase = 0; draw(); }
      else {
        const m = metrics();
        const rect = canvas.getBoundingClientRect();
        const found = findDrawingAt(event.clientX - rect.left, event.clientY - rect.top, m);
        if (found) state.drawings.splice(found.idx, 1);
      }
      draw();
      return;
    }
    if (event.button !== 0) return;

    if (state.tool === "none") {
      const m = metrics();
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const found = findDrawingAt(x, y, m);
      if (found) {
        const drawing = state.drawings[found.idx];
        state.dragDrawing = {
          idx: found.idx, handle: found.hit,
          startPoint: drawingPointFromMouse(event),
          a: { ...drawing.a }, b: drawing.b ? { ...drawing.b } : null,
          points: drawing.points ? drawing.points.map(point => ({ ...point })) : null,
        };
        canvas.style.cursor = "grabbing";
        return;
      }
      state.panning = {
        mode: x >= m.plot.w ? "yscale" : "chart",
        x: event.clientX, y: event.clientY,
        panBars: state.panBars, priceOffset: state.priceOffset, priceZoom: state.priceZoom,
        stepX: m.stepX, range: m.range, priceH: m.plot.priceH,
      };
      canvas.style.cursor = "grabbing";
      return;
    }

    const point = drawingPointFromMouse(event);
    if (state.tool === "h-ray") {
      state.drawings.push({ type: "h-ray", color: getToolColor("h-ray"), a: point, b: { ...point } });
      setBtTool("none");
      return;
    }
    if (state.tool === "brush") {
      state.draft = { type: "brush", color: getToolColor("brush"), lineWidth: state.brushWidth, a: point, points: [point] };
      state.drawingPhase = 1;
      return;
    }
    if (state.tool === "ruler") {
      state.draft = { type: "ruler", color: getToolColor("ruler"), a: point, b: { ...point } };
      state.drawingPhase = 1;
      return;
    }
    if (state.drawingPhase === 0) {
      state.draft = { type: state.tool, color: getToolColor(state.tool), a: point, b: { ...point } };
      state.drawingPhase = 1;
    } else {
      state.draft.b = point;
      if (drawingIsValid(state.draft)) state.drawings.push({ ...state.draft });
      setBtTool("none");
    }
    draw();
  });
  canvas.addEventListener("mousemove", event => {
    const rect = canvas.getBoundingClientRect();
    state.hover = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (state.dragDrawing) {
      const drag = state.dragDrawing;
      const drawing = state.drawings[drag.idx];
      const point = drawingPointFromMouse(event);
      if (drag.handle === "p1") drawing.a = point;
      else if (drag.handle === "p2") drawing.b = point;
      else {
        const dt = point.t - drag.startPoint.t;
        const dp = point.p - drag.startPoint.p;
        drawing.a = { ...drag.a, t: drag.a.t + dt, p: drag.a.p + dp };
        if (drag.b) drawing.b = { ...drag.b, t: drag.b.t + dt, p: drag.b.p + dp };
        if (drag.points) drawing.points = drag.points.map(item => ({ ...item, t: item.t + dt, p: item.p + dp }));
      }
      canvas.style.cursor = "grabbing";
    } else if (state.panning) {
      const dx = event.clientX - state.panning.x;
      const dy = event.clientY - state.panning.y;
      if (state.panning.mode === "chart") {
        const count = Math.min(state.viewBars, state.candles.length);
        const minPan = -Math.floor(count * .45);
        const maxPan = Math.max(0, state.candles.length - count);
        state.panBars = Math.max(minPan, Math.min(maxPan, state.panning.panBars + Math.round(dx / Math.max(1, state.panning.stepX))));
        state.priceOffset = state.panning.priceOffset + dy / Math.max(1, state.panning.priceH) * state.panning.range;
      } else {
        state.priceZoom = Math.max(.3, Math.min(4, state.panning.priceZoom * Math.exp(dy / 160)));
      }
    } else if (state.draft?.type === "brush") {
      const point = drawingPointFromMouse(event);
      const last = state.draft.points[state.draft.points.length - 1];
      if (!last || last.t !== point.t || Math.abs(last.p - point.p) > 1e-12) state.draft.points.push(point);
    } else if (state.draft) {
      const point = drawingPointFromMouse(event);
      state.draft.b = state.draft.type === "ruler" ? { ...point, t: state.draft.a.t } : point;
    } else if (state.tool === "none") {
      const found = findDrawingAt(state.hover.x, state.hover.y, metrics());
      state.hoverDrawingIdx = found ? found.idx : -1;
      canvas.style.cursor = found ? "pointer" : "crosshair";
    }
    draw();
  });
  canvas.addEventListener("mouseup", () => {
    state.panning = null;
    state.dragDrawing = null;
    if (state.tool === "brush" && state.draft) {
      if (state.draft.points?.length > 1) state.drawings.push({ ...state.draft });
      setBtTool("none");
    } else if (state.tool === "ruler") {
      state.draft = null;
      state.drawingPhase = 0;
      setBtTool("none");
    }
    canvas.style.cursor = "crosshair";
    draw();
  });
  canvas.addEventListener("mouseleave", () => { state.hover = null; state.panning = null; state.dragDrawing = null; canvas.style.cursor = "crosshair"; draw(); });
  canvas.addEventListener("contextmenu", event => event.preventDefault());
  canvas.addEventListener("wheel", event => {
    event.preventDefault();
    let dy = event.deltaY || 0;
    if (event.deltaMode === 1) dy *= 16;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.max(0.90, Math.min(1.10, 1 + dy * 0.0004));
      state.priceZoom = Math.max(.3, Math.min(4, state.priceZoom * factor));
    } else {
      const barShift = Math.round(dy * 0.04);
      state.viewBars = Math.max(45, Math.min(280, state.viewBars + barShift));
    }
    draw();
  }, { passive: false });
  canvas.addEventListener("dblclick", () => { state.panBars = 0; state.priceOffset = 0; state.priceZoom = 1; state.viewBars = 170; draw(); });

  // Touch event handlers for Backtest canvas
  function handleBtTouch(e) {
    if (!state.session || !e.touches.length) return;
    const t = e.touches[0];
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, t.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, t.clientY - rect.top));
    state.hover = { x, y };
  }

  canvas.addEventListener("touchstart", (e) => {
    if (!state.session) return;
    handleBtTouch(e);
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const m = metrics();
      state.panning = {
        mode: "chart",
        x: t.clientX, y: t.clientY,
        panBars: state.panBars, priceOffset: state.priceOffset, priceZoom: state.priceZoom,
        stepX: m.stepX, range: m.range, priceH: m.plot.priceH,
      };
    }
  }, { passive: true });

  canvas.addEventListener("touchmove", (e) => {
    if (!state.session) return;
    handleBtTouch(e);
    if (e.touches.length === 1 && state.panning) {
      const t = e.touches[0];
      const dx = t.clientX - state.panning.x;
      const dy = t.clientY - state.panning.y;
      const count = Math.min(state.viewBars, state.candles.length);
      const minPan = -Math.floor(count * .45);
      const maxPan = Math.max(0, state.candles.length - count);
      state.panBars = Math.max(minPan, Math.min(maxPan, state.panning.panBars + Math.round(dx / Math.max(1, state.panning.stepX))));
      state.priceOffset = state.panning.priceOffset + dy / Math.max(1, state.panning.priceH) * state.panning.range;
      draw();
    }
  }, { passive: true });

  canvas.addEventListener("touchend", () => {
    state.panning = null;
    draw();
  }, { passive: true });

  function syncIndicatorButtons(id) {
    document.querySelectorAll(`[data-bt-indicator="${id}"]`).forEach(button => button.classList.toggle("on", state.indicators.has(id)));
  }

  function toggleLevelMode(kind) {
    const input = $(kind === "sl" ? "bt-sl" : "bt-tp");
    const button = $(kind === "sl" ? "bt-sl-mode" : "bt-tp-mode");
    const previousLevels = getPlannedLevels();
    const hadValue = (+input.value || 0) > 0;
    const nextMode = state.levelModes[kind] === "percent" ? "price" : "percent";
    state.levelModes[kind] = nextMode;
    button.dataset.mode = nextMode;
    button.textContent = nextMode === "price" ? "Цена" : "%";
    button.classList.toggle("price-mode", nextMode === "price");
    input.step = nextMode === "price" ? "any" : "0.1";
    input.placeholder = nextMode === "price" ? "Цена уровня" : (kind === "sl" ? "1.0" : "3.0");
    if (hadValue && previousLevels.entry && state.plannedDirection) {
      if (nextMode === "price") input.value = price(previousLevels[kind]);
      else input.value = (Math.abs(previousLevels[kind] / previousLevels.entry - 1) * 100).toFixed(2);
    }
    draw();
  }

  document.querySelectorAll("[data-bt-tf]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-bt-tf]").forEach(b => b.classList.remove("on")); button.classList.add("on"); state.tf = button.dataset.btTf; newCase();
  }));
  document.querySelectorAll("[data-bt-indicator]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.btIndicator;
    state.indicators.has(id) ? state.indicators.delete(id) : state.indicators.add(id);
    syncIndicatorButtons(id);
    draw();
  }));
  document.querySelectorAll("[data-bt-tool]").forEach(button => {
    button.addEventListener("click", () => setBtTool(button.dataset.btTool));
    button.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); openBtToolColorMenu(button.dataset.btTool, button); });
  });
  $("bt-magnet").addEventListener("click", () => {
    state.magnet = !state.magnet;
    $("bt-magnet").classList.toggle("magnet-on", state.magnet);
  });
  document.querySelectorAll("[data-bt-speed]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-bt-speed]").forEach(b => b.classList.remove("on")); button.classList.add("on"); state.speed = +button.dataset.btSpeed;
  }));

  $("bt-new").addEventListener("click", newCase);

  const btExcWrap = $("bt-exc-wrap");
  const btExcBtn = $("bt-exc-btn");
  const btExcMenu = $("bt-exc-menu");
  const btExcDot = $("bt-exc-dot");
  const btExcName = $("bt-exc-name");

  if (btExcBtn && btExcMenu) {
    btExcBtn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const open = btExcBtn.classList.toggle("open");
      btExcMenu.classList.toggle("open", open);
      btExcBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });

    btExcMenu.querySelectorAll(".exc-item").forEach(item => {
      item.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        const cex = item.dataset.cex;
        const label = item.dataset.label;
        const img = item.dataset.img;
        state.exchange = cex;
        if (btExcDot) btExcDot.style.background = `center/contain no-repeat url('${img}')`;
        if (btExcName) btExcName.textContent = label;
        btExcMenu.querySelectorAll(".exc-item").forEach(i => i.classList.toggle("on", i.dataset.cex === cex));
        btExcBtn.classList.remove("open");
        btExcMenu.classList.remove("open");
        btExcBtn.setAttribute("aria-expanded", "false");
        newCase();
      });
    });

    document.addEventListener("click", event => {
      if (!event.target.closest("#bt-exc-wrap")) {
        btExcBtn.classList.remove("open");
        btExcMenu.classList.remove("open");
        btExcBtn.setAttribute("aria-expanded", "false");
      }
    });
  }
  const addEvt = (id, event, fn) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
  };

  addEvt("bt-indicators-btn", "click", event => {
    event.preventDefault(); event.stopPropagation();
    const menu = $("bt-indicators-menu");
    if (menu) {
      menu.hidden = !menu.hidden;
      const btn = $("bt-indicators-btn");
      if (btn) btn.classList.toggle("open", !menu.hidden);
    }
  });
  addEvt("bt-indicators-menu", "click", event => event.stopPropagation());
  document.addEventListener("click", event => {
    if (!event.target.closest(".bt-indicator-settings")) {
      const menu = $("bt-indicators-menu");
      const btn = $("bt-indicators-btn");
      if (menu) menu.hidden = true;
      if (btn) btn.classList.remove("open");
    }
  });
  addEvt("bt-step", "click", step);
  addEvt("bt-play", "click", togglePlay);
  addEvt("bt-reveal", "click", reveal);
  addEvt("bt-long", "click", () => selectDirection("long"));
  addEvt("bt-short", "click", () => selectDirection("short"));
  addEvt("bt-commit-plan", "click", () => openPosition());
  addEvt("bt-close-position", "click", () => state.position && closePosition(state.candles[state.candles.length - 1].c));
  addEvt("bt-undo", "click", () => { state.drawings.pop(); draw(); });
  addEvt("bt-clear", "click", () => { state.drawings = []; draw(); });
  addEvt("bt-sl-mode", "click", () => toggleLevelMode("sl"));
  addEvt("bt-tp-mode", "click", () => toggleLevelMode("tp"));
  addEvt("bt-sl", "input", draw);
  addEvt("bt-tp", "input", draw);

  document.addEventListener("keydown", event => {
    const btView = $("backtest-view");
    if ((btView && btView.style.display === "none") || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (event.code === "Space") { event.preventDefault(); togglePlay(); }
    if (event.code === "ArrowRight") { event.preventDefault(); step(); }
    const key = event.key.toLowerCase();
    if (event.key === "Escape") { if (state.drawingPhase) { state.draft = null; state.drawingPhase = 0; draw(); } else setBtTool("none"); }
    if (key === "v") setBtTool("none");
    if (key === "h") setBtTool("h-ray");
    if (key === "l") setBtTool("line");
    if (key === "x") setBtTool("rect");
    if (key === "b") setBtTool("brush");
    if (key === "u") setBtTool("ruler");
    if (key === "f") setBtTool("fibgrid");
    if (key === "m") {
      state.magnet = !state.magnet;
      const magBtn = $("bt-magnet");
      if (magBtn) magBtn.classList.toggle("magnet-on", state.magnet);
    }
    if ((event.key === "Delete" || event.key === "Backspace") && !state.drawingPhase && state.drawings.length) { state.drawings.pop(); draw(); }
  });

  if (wrap) new ResizeObserver(draw).observe(wrap);
  renderStats();
  renderPosition();
  applyToolButtonColors();
  ["volume", "vp", "vwap", "ema20", "ema50", "ema200", "rsi", "atr", "bb", "macd", "cvd"].forEach(syncIndicatorButtons);
  if (canvas) canvas.style.cursor = "crosshair";
  updateControls();
  draw();

  window.CryptoBacktest = {
    activate() {
      draw();
      if (!state.activated) { state.activated = true; newCase(); }
    },
    viewState() {
      return { panBars: state.panBars, viewBars: state.viewBars, indicators: Array.from(state.indicators), exchange: state.exchange, tf: state.tf };
    },
  };
})();
