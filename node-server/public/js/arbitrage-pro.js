'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const pro = {
    row: null, isFunding: false, isDex: false, tf: 'live', mode: 'best', view: 'spread', depth: null,
    depthLoading: false, requestId: 0, historySeq: 0, initialized: false,
    drawQueued: false, history: [], historyTimer: null, hoverX: -1,
  };

  function pct(n, digits = 3) {
    const value = Number(n);
    return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%` : '—';
  }
  function price(n) {
    n = Number(n) || 0;
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (n < 0.0001 && n > 0) return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    return n ? n.toPrecision(6).replace(/0+$/, '').replace(/\.$/, '') : '—';
  }
  function money(n) {
    n = Number(n) || 0;
    if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  }
  function debounce(fn, wait) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
  }
  function fundingHourly(row) {
    if (pro.isDex) return 0;
    if (pro.isFunding) return Number(row.hourly) || 0;
    return ((Number(row.sellFunding) || 0) / (Number(row.sellInterval) || 8)
      - (Number(row.buyFunding) || 0) / (Number(row.buyInterval) || 8));
  }
  function legs(row) {
    if (pro.isDex) {
      return row.direction === 'cex_to_dex'
        ? { buyName: row.cexName, buyPrice: row.cexPrice, sellName: row.dexName, sellPrice: row.dexPrice }
        : { buyName: row.dexName, buyPrice: row.dexPrice, sellName: row.cexName, sellPrice: row.cexPrice };
    }
    return pro.isFunding
      ? { buyName: row.longName, buyPrice: row.longPrice || 0, sellName: row.shortName, sellPrice: row.shortPrice || 0 }
      : { buyName: row.buyName, buyPrice: row.buyAsk, sellName: row.sellName, sellPrice: row.sellBid };
  }
  function snapshotPoint(row) {
    const l = legs(row);
    return {
      t: Number(row.generatedAt) || Date.now(),
      spread: Number(pro.isDex ? row.netPct : (pro.isFunding ? row.hourly : row.net)) || 0,
      buyP: Number(l.buyPrice) || 0,
      sellP: Number(l.sellPrice) || 0,
      gross: Number(pro.isDex ? row.grossPct : (pro.isFunding ? row.basis : row.gross)),
      exit: pro.isFunding || pro.isDex ? NaN : Number(row.exitNet),
      buyExit: Number(row.buyBid) || Number(l.buyPrice) || 0,
      sellExit: Number(row.sellAsk) || Number(l.sellPrice) || 0,
    };
  }

  function init() {
    if (pro.initialized) return;
    pro.initialized = true;
    const notional = $('arb-notional');
    if (notional) notional.addEventListener('input', debounce(loadDepth, 300));
    if ($('arb-impact-limit')) $('arb-impact-limit').addEventListener('change', renderDepth);
    document.querySelectorAll('[data-arb-size]').forEach(btn => btn.addEventListener('click', () => {
      if (notional) notional.value = btn.dataset.arbSize;
      document.querySelectorAll('[data-arb-size]').forEach(x => x.classList.toggle('on', x === btn));
      loadDepth();
    }));
    document.querySelectorAll('[data-arb-tf]').forEach(btn => btn.addEventListener('click', () => {
      pro.tf = btn.dataset.arbTf;
      document.querySelectorAll('[data-arb-tf]').forEach(x => x.classList.toggle('on', x === btn));
      renderCharts();
    }));
    document.querySelectorAll('[data-arb-chart-view]').forEach(btn => btn.addEventListener('click', () => {
      pro.view = btn.dataset.arbChartView;
      document.querySelectorAll('[data-arb-chart-view]').forEach(x => x.classList.toggle('on', x === btn));
      renderCharts();
    }));
    document.querySelectorAll('[data-spread-mode]').forEach(btn => btn.addEventListener('click', () => {
      if (btn.disabled) return;
      pro.mode = btn.dataset.spreadMode;
      document.querySelectorAll('[data-spread-mode]').forEach(x => x.classList.toggle('on', x === btn));
      renderCharts();
    }));
    const canvas = $('arb-detail-canvas');
    if (canvas) {
      canvas.addEventListener('mousemove', event => {
        const rect = canvas.getBoundingClientRect();
        pro.hoverX = event.clientX - rect.left;
        scheduleCharts();
      });
      canvas.addEventListener('mouseleave', () => { pro.hoverX = -1; scheduleCharts(); });
    }
    window.addEventListener('resize', debounce(scheduleCharts, 100));
  }

  function openRoute(row, isFunding, isDex) {
    init();
    pro.row = row;
    pro.isFunding = Boolean(isFunding);
    pro.isDex = Boolean(isDex);
    pro.depth = null;
    pro.mode = 'best';
    pro.view = 'spread';
    pro.tf = 'live';
    pro.requestId++;
    pro.historySeq++;
    pro.history = [snapshotPoint(row)].filter(point => point.buyP > 0 && point.sellP > 0);
    pro.hoverX = -1;
    if ($('arb-drawer')) $('arb-drawer').scrollTop = 0;
    if ($('arb-execution')) $('arb-execution').style.display = isFunding || isDex ? 'none' : 'block';
    if ($('arb-transfer-card')) $('arb-transfer-card').hidden = Boolean(isDex);
    if ($('arb-chart-funding-item')) $('arb-chart-funding-item').hidden = Boolean(isDex);
    document.querySelectorAll('[data-spread-mode]').forEach(btn => {
      btn.classList.toggle('on', btn.dataset.spreadMode === 'best');
      if (btn.dataset.spreadMode === 'volume') btn.disabled = true;
    });
    document.querySelectorAll('[data-arb-tf]').forEach(btn => btn.classList.toggle('on', btn.dataset.arbTf === 'live'));
    document.querySelectorAll('[data-arb-chart-view]').forEach(btn => btn.classList.toggle('on', btn.dataset.arbChartView === 'spread'));
    if ($('arb-chart-empty')) {
      $('arb-chart-empty').textContent = 'Собираем историю выбранной связки…';
      $('arb-chart-empty').hidden = pro.history.length > 0;
    }
    updateChartLabels();
    renderCharts();
    if (isDex) loadDexHistory(row.key); else loadServerHistory(row.key);
    if (pro.historyTimer) clearInterval(pro.historyTimer);
    pro.historyTimer = setInterval(() => {
      if (!pro.row) return;
      if (pro.isDex) loadDexHistory(pro.row.key); else loadServerHistory(pro.row.key);
    }, isDex ? 10_000 : 2_000);
    if (!isFunding && !isDex) loadDepth();
  }

  function open(row, isFunding) {
    openRoute(row, isFunding, false);
  }

  async function openDex(row) {
    openRoute(row, false, true);
  }

  function close() {
    if (pro.historyTimer) { clearInterval(pro.historyTimer); pro.historyTimer = null; }
    pro.row = null;
    pro.isDex = false;
    pro.depth = null;
    pro.history = [];
    pro.requestId++;
    pro.historySeq++;
  }

  function updateChartLabels() {
    const row = pro.row;
    if (!row) return;
    const l = legs(row);
    const isBbo = !pro.isFunding && !pro.isDex && row.quality === 'bbo';
    const quality = $('arb-chart-quality');
    if (quality) {
      quality.textContent = pro.isDex ? 'CONTRACT EXACT' : (pro.isFunding ? 'FUNDING' : (isBbo ? 'BBO' : 'MID'));
      quality.classList.toggle('indicative', !isBbo);
    }
    if ($('arb-chart-kicker')) $('arb-chart-kicker').textContent = pro.view === 'index' ? 'СИНХРОННОЕ ДВИЖЕНИЕ ЦЕН' : (pro.isDex ? 'ИСТОРИЯ CEX ↔ DEX' : 'ИСТОРИЯ СВЯЗКИ');
    if ($('arb-chart-title')) {
      $('arb-chart-title').textContent = pro.view === 'index'
        ? `${l.buyName} / ${l.sellName} · индекс 100`
        : pro.isDex ? 'Индикативный edge и валовая разница' : pro.isFunding ? 'Текущая разница ставок / час' : `${isBbo ? 'Исполнимый' : 'Ориентировочный'} спред · ${isBbo ? 'BBO' : 'Mid'}`;
    }
    const modes = document.querySelector('.arb-chart-modes');
    if (modes) modes.hidden = pro.isFunding || pro.isDex || pro.view === 'index';
  }

  async function loadServerHistory(key) {
    const requestId = pro.requestId;
    const sequence = ++pro.historySeq;
    try {
      const response = await fetch(`/api/arbitrage/history?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (!response.ok || requestId !== pro.requestId || sequence !== pro.historySeq) return;
      const data = await response.json();
      const byTime = new Map();
      for (const raw of data.points || []) {
        const point = {
          t: Number(raw[0]) || 0, spread: Number(raw[1]), buyP: Number(raw[2]) || 0,
          sellP: Number(raw[3]) || 0, gross: Number(raw[4]),
          exit: pro.isFunding ? NaN : Number(raw[5]), buyExit: Number(raw[6]) || 0,
          sellExit: Number(raw[7]) || 0,
        };
        if (point.t > 0 && Number.isFinite(point.spread) && point.buyP > 0 && point.sellP > 0) byTime.set(point.t, point);
      }
      const points = [...byTime.values()].sort((a, b) => a.t - b.t).slice(-2160);
      if (!points.length) return;
      pro.history = points;
      if ($('arb-chart-empty')) $('arb-chart-empty').hidden = true;
      renderCharts();
    } catch (_) {
      if (!pro.history.length && $('arb-chart-empty')) {
        $('arb-chart-empty').hidden = false;
        $('arb-chart-empty').textContent = 'История временно недоступна';
      }
    }
  }

  async function loadDexHistory(key) {
    const requestId = pro.requestId;
    const sequence = ++pro.historySeq;
    try {
      const response = await fetch(`/api/arbitrage/dex/history?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (!response.ok || requestId !== pro.requestId || sequence !== pro.historySeq) return;
      const data = await response.json();
      const byTime = new Map();
      for (const raw of data.points || []) {
        const cexPrice = Number(raw[2]) || 0;
        const dexPrice = Number(raw[3]) || 0;
        const point = {
          t: Number(raw[0]) || 0, spread: Number(raw[1]), gross: Number(raw[4]), exit: NaN,
          buyP: pro.row?.direction === 'cex_to_dex' ? cexPrice : dexPrice,
          sellP: pro.row?.direction === 'cex_to_dex' ? dexPrice : cexPrice,
          buyExit: 0, sellExit: 0,
        };
        if (point.t > 0 && Number.isFinite(point.spread) && point.buyP > 0 && point.sellP > 0) byTime.set(point.t, point);
      }
      const points = [...byTime.values()].sort((a, b) => a.t - b.t).slice(-2160);
      if (!points.length) return;
      pro.history = points;
      if ($('arb-chart-empty')) $('arb-chart-empty').hidden = true;
      renderCharts();
    } catch (_) {
      if (!pro.history.length && $('arb-chart-empty')) {
        $('arb-chart-empty').hidden = false;
        $('arb-chart-empty').textContent = 'История DEX-маршрута временно недоступна';
      }
    }
  }

  async function loadDepth() {
    const row = pro.row;
    if (!row || pro.isFunding || pro.depthLoading) return;
    const requestId = pro.requestId;
    const notional = Math.max(10, Math.min(1000000, Number($('arb-notional')?.value) || 500));
    pro.depthLoading = true;
    if ($('arb-depth-state')) { $('arb-depth-state').textContent = 'СТАКАНЫ…'; $('arb-depth-state').className = ''; }
    try {
      const response = await fetch(`/api/arbitrage/depth?key=${encodeURIComponent(row.key)}&notional=${encodeURIComponent(notional)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
      if (pro.requestId !== requestId) return;
      pro.depth = data;
      renderDepth();
      if ($('arb-depth-state')) {
        $('arb-depth-state').textContent = data.complete ? 'ИСПОЛНИМО' : 'НЕПОЛНЫЙ ОБЪЁМ';
        $('arb-depth-state').className = data.complete ? 'ready' : 'error';
      }
    } catch (_) {
      if (pro.requestId !== requestId) return;
      pro.depth = null;
      renderDepth();
      if ($('arb-depth-state')) { $('arb-depth-state').textContent = 'СТАКАН НЕДОСТУПЕН'; $('arb-depth-state').className = 'error'; }
    } finally { pro.depthLoading = false; }
  }

  function renderDepth() {
    const data = pro.depth;
    const volumeButton = document.querySelector('[data-spread-mode="volume"]');
    if (volumeButton) volumeButton.disabled = !data;
    if (!data) {
      ['arb-safe-volume', 'arb-depth-buy', 'arb-depth-sell', 'arb-depth-net', 'arb-depth-funded', 'arb-depth-pnl'].forEach(id => { if ($(id)) $(id).textContent = '—'; });
      if ($('arb-depth-fill')) $('arb-depth-fill').style.width = '0';
      if ($('arb-depth-marker')) $('arb-depth-marker').style.left = '0';
      return;
    }
    const impact = Number($('arb-impact-limit')?.value) || 0.1;
    const band = data.bands.find(item => Number(item.impact) === impact) || data.bands[1];
    const safe = Number(band?.notional) || 0;
    const requested = Number(data.requestedNotional) || 0;
    if ($('arb-safe-volume')) $('arb-safe-volume').textContent = money(safe);
    if ($('arb-depth-buy')) $('arb-depth-buy').textContent = price(data.buy.average);
    if ($('arb-depth-buy-impact')) $('arb-depth-buy-impact').textContent = `проскальзывание ${pct(data.buy.impactPct, 4)}`;
    if ($('arb-depth-sell')) $('arb-depth-sell').textContent = price(data.sell.average);
    if ($('arb-depth-sell-impact')) $('arb-depth-sell-impact').textContent = `проскальзывание ${pct(data.sell.impactPct, 4)}`;
    if ($('arb-depth-net')) $('arb-depth-net').textContent = pct(data.netPct);
    if ($('arb-depth-funded')) $('arb-depth-funded').textContent = pct(data.netAfterFundingHourPct);
    if ($('arb-depth-pnl')) $('arb-depth-pnl').textContent = `${data.complete ? '≈' : 'до'} ${money(data.estimatedPnlAfterFundingHour)} PnL · текущая ставка`;
    const ratio = safe > 0 ? Math.min(1, requested / safe) : 1;
    if ($('arb-depth-fill')) $('arb-depth-fill').style.width = `${ratio * 100}%`;
    if ($('arb-depth-marker')) $('arb-depth-marker').style.left = `${Math.min(99, ratio * 100)}%`;
    renderCharts();
  }

  function scheduleCharts() {
    if (pro.drawQueued) return;
    pro.drawQueued = true;
    requestAnimationFrame(() => { pro.drawQueued = false; renderCharts(); });
  }
  function visiblePoints() {
    if (!pro.history.length) return [];
    const windowMs = { live: 5 * 60000, '5m': 5 * 60000, '15m': 15 * 60000, '1h': 3600000, '4h': 4 * 3600000 }[pro.tf] || 5 * 60000;
    const latest = pro.history.at(-1).t;
    const points = pro.history.filter(point => point.t >= latest - windowMs);
    return points.length ? points : pro.history.slice(-1);
  }

  function renderCharts() {
    const row = pro.row;
    if (!row) return;
    updateChartLabels();
    let points = visiblePoints();
    if (pro.mode === 'volume' && pro.depth && !pro.isFunding) {
      const offset = Number(pro.depth.netPct) - Number(row.net);
      points = points.map(point => ({ ...point, spread: point.spread + offset }));
    }
    const l = legs(row);
    let series;
    let percentAxis = true;
    if (pro.view === 'index') {
      const baseBuy = points.find(point => point.buyP > 0)?.buyP || 1;
      const baseSell = points.find(point => point.sellP > 0)?.sellP || 1;
      points = points.map(point => ({ ...point, buyIndex: point.buyP / baseBuy * 100, sellIndex: point.sellP / baseSell * 100 }));
      percentAxis = false;
      series = [
        { key: 'buyIndex', label: l.buyName, color: '#2bd98a', width: 2 },
        { key: 'sellIndex', label: l.sellName, color: '#ef647a', width: 2 },
      ];
    } else if (pro.isDex) {
      series = [
        { key: 'spread', label: 'Net', color: '#2bd98a', width: 2.2, fill: true },
        { key: 'gross', label: 'Gross', color: '#9b82e7', width: 1.5, dash: [4, 4] },
      ];
    } else if (pro.isFunding) {
      series = [
        { key: 'spread', label: 'Funding/ч', color: '#2bd98a', width: 2.2, fill: true },
        { key: 'gross', label: 'Базис', color: '#9b82e7', width: 1.5, dash: [4, 4] },
      ];
    } else {
      series = [
        { key: 'spread', label: 'Вход', color: '#2bd98a', width: 2.2, fill: true },
        { key: 'exit', label: 'Выход', color: '#ef647a', width: 1.45 },
      ];
    }
    drawMarketChart($('arb-detail-canvas'), points, series, percentAxis);
    updateChartStats(points, series[0].key, percentAxis);
    const last = points.at(-1);
    if ($('arb-chart-buy-label')) {
      $('arb-chart-buy-label').textContent = `${series[0].label} ${formatChartValue(last?.[series[0].key], percentAxis)}`;
      if ($('arb-chart-buy-label').previousElementSibling) $('arb-chart-buy-label').previousElementSibling.style.background = series[0].color;
    }
    if ($('arb-chart-sell-label')) {
      $('arb-chart-sell-label').textContent = `${series[1].label} ${formatChartValue(last?.[series[1].key], percentAxis)}`;
      if ($('arb-chart-sell-label').previousElementSibling) $('arb-chart-sell-label').previousElementSibling.style.background = series[1].color;
    }
    if ($('arb-chart-current')) $('arb-chart-current').textContent = formatChartValue(last?.[series[0].key], percentAxis);
    if ($('arb-chart-funding')) $('arb-chart-funding').textContent = pct(fundingHourly(row), 5);
    if ($('arb-chart-empty')) $('arb-chart-empty').hidden = points.length > 0;
  }

  function updateChartStats(points, key, percentAxis) {
    const values = points.map(point => Number(point[key])).filter(Number.isFinite);
    const min = values.length ? Math.min(...values) : NaN;
    const max = values.length ? Math.max(...values) : NaN;
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
    if ($('arb-chart-min')) $('arb-chart-min').textContent = formatChartValue(min, percentAxis);
    if ($('arb-chart-avg')) $('arb-chart-avg').textContent = formatChartValue(avg, percentAxis);
    if ($('arb-chart-max')) $('arb-chart-max').textContent = formatChartValue(max, percentAxis);
    if ($('arb-chart-positive')) {
      const positive = percentAxis && values.length ? values.filter(value => value > 0).length / values.length * 100 : NaN;
      $('arb-chart-positive').textContent = Number.isFinite(positive) ? `${positive.toFixed(0)}%` : '—';
    }
    if ($('arb-chart-age')) {
      const ageMs = points.length ? Math.max(0, Date.now() - Number(points.at(-1).t || 0)) : NaN;
      $('arb-chart-age').textContent = Number.isFinite(ageMs) ? (ageMs < 1000 ? '<1с' : `${Math.round(ageMs / 1000)}с`) : '—';
    }
    if ($('arb-chart-samples')) $('arb-chart-samples').textContent = String(values.length);
  }
  function formatChartValue(value, percentAxis) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return percentAxis ? pct(n, 3) : n.toFixed(3);
  }
  function fit(canvas, cssHeight) {
    if (!canvas) return { ctx: null, w: 0, h: 0, dpr: 1 };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssWidth = Math.max(280, canvas.clientWidth || 600);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    return { ctx: canvas.getContext('2d'), w: canvas.width, h: canvas.height, dpr };
  }
  function downsample(points, key, limit = 700) {
    if (points.length <= limit) return points;
    const output = [points[0]];
    const bucketSize = (points.length - 2) / (limit / 2 - 1);
    for (let start = 1; start < points.length - 1; start += bucketSize) {
      const from = Math.floor(start);
      const to = Math.min(points.length - 1, Math.max(from + 1, Math.floor(start + bucketSize)));
      const bucket = points.slice(from, to);
      let min = bucket[0], max = bucket[0];
      for (const point of bucket) {
        if (Number(point[key]) < Number(min[key])) min = point;
        if (Number(point[key]) > Number(max[key])) max = point;
      }
      if (min.t <= max.t) output.push(min, max); else output.push(max, min);
    }
    output.push(points.at(-1));
    return output;
  }

  function drawMarketChart(canvas, rawPoints, series, percentAxis) {
    if (!canvas) return;
    const { ctx, w, h, dpr } = fit(canvas, 286);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!rawPoints.length) return;
    const points = downsample(rawPoints, series[0].key);
    const values = [];
    for (const point of points) for (const item of series) {
      const value = Number(point[item.key]);
      if (Number.isFinite(value)) values.push(value);
    }
    if (!values.length) return;
    if (percentAxis) values.push(0);
    let min = Math.min(...values), max = Math.max(...values);
    const rawSpan = max - min;
    const fallback = percentAxis ? Math.max(Math.abs(max) * 0.04, 0.04) : Math.max(Math.abs(max) * 0.0004, 0.04);
    const padding = (rawSpan || fallback) * 0.16;
    min -= padding; max += padding;
    const range = max - min || 1;
    const pad = { l: 16 * dpr, r: 72 * dpr, t: 14 * dpr, b: 30 * dpr };
    const firstTime = points[0].t, lastTime = points.at(-1).t;
    const timeRange = Math.max(5000, lastTime - firstTime);
    const x = time => pad.l + (time - firstTime) * (w - pad.l - pad.r) / timeRange;
    const y = value => pad.t + (max - value) * (h - pad.t - pad.b) / range;

    if (percentAxis) {
      const zeroY = y(0);
      const plotRight = w - pad.r;
      ctx.fillStyle = 'rgba(43,217,138,.035)';
      ctx.fillRect(pad.l, pad.t, plotRight - pad.l, Math.max(0, zeroY - pad.t));
      ctx.fillStyle = 'rgba(239,100,122,.035)';
      ctx.fillRect(pad.l, zeroY, plotRight - pad.l, Math.max(0, h - pad.b - zeroY));
    }

    ctx.font = `${8 * dpr}px Inter, sans-serif`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const value = max - range * i / 4, yy = y(value);
      ctx.strokeStyle = '#1d2430'; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillStyle = '#697385';
      ctx.fillText(percentAxis ? `${value.toFixed(2)}%` : value.toFixed(2), w - 7 * dpr, yy + 3 * dpr);
    }
    if (percentAxis) {
      const zeroY = y(0);
      ctx.strokeStyle = '#465064'; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(pad.l, zeroY); ctx.lineTo(w - pad.r, zeroY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#8a94a6'; ctx.textAlign = 'left'; ctx.font = `700 ${7 * dpr}px Inter, sans-serif`;
      ctx.fillText('0 · БЕЗУБЫТОК', pad.l + 5 * dpr, zeroY - 5 * dpr);
    }
    function pathFor(item) {
      let started = false;
      ctx.beginPath();
      for (const point of points) {
        const value = Number(point[item.key]);
        if (!Number.isFinite(value)) continue;
        if (started) ctx.lineTo(x(point.t), y(value)); else { ctx.moveTo(x(point.t), y(value)); started = true; }
      }
      return started;
    }
    const primary = series[0];
    if (primary.fill && pathFor(primary)) {
      const firstValid = points.find(point => Number.isFinite(Number(point[primary.key])));
      const lastValid = [...points].reverse().find(point => Number.isFinite(Number(point[primary.key])));
      const baseline = percentAxis && min <= 0 && max >= 0 ? y(0) : h - pad.b;
      ctx.lineTo(x(lastValid.t), baseline); ctx.lineTo(x(firstValid.t), baseline); ctx.closePath();
      const gradient = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      gradient.addColorStop(0, 'rgba(43,217,138,.16)'); gradient.addColorStop(1, 'rgba(43,217,138,0)');
      ctx.fillStyle = gradient; ctx.fill();
    }
    for (const item of [...series].reverse()) {
      if (!pathFor(item)) continue;
      ctx.strokeStyle = item.color; ctx.lineWidth = item.width * dpr; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.setLineDash((item.dash || []).map(value => value * dpr)); ctx.stroke(); ctx.setLineDash([]);
    }
    const timeOptions = pro.tf === 'live' ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
    ctx.font = `${8 * dpr}px Inter, sans-serif`; ctx.fillStyle = '#626c7d';
    [0, 0.5, 1].forEach((ratio, index) => {
      const time = firstTime + timeRange * ratio;
      ctx.textAlign = index === 0 ? 'left' : index === 2 ? 'right' : 'center';
      ctx.fillText(new Date(time).toLocaleTimeString('ru-RU', timeOptions), pad.l + ratio * (w - pad.l - pad.r), h - 8 * dpr);
    });
    const lastPoint = points.at(-1);
    const badges = series.map(item => ({ item, value: Number(lastPoint[item.key]) })).filter(item => Number.isFinite(item.value));
    let previousY = -Infinity;
    for (const badge of badges) {
      const actualY = y(badge.value);
      let badgeY = actualY;
      if (Math.abs(badgeY - previousY) < 17 * dpr) badgeY = previousY + 17 * dpr;
      badgeY = Math.max(8 * dpr, Math.min(h - pad.b - 8 * dpr, badgeY));
      previousY = badgeY;
      ctx.beginPath(); ctx.arc(x(lastPoint.t), actualY, 3 * dpr, 0, Math.PI * 2); ctx.fillStyle = badge.item.color; ctx.fill();
      const label = formatChartValue(badge.value, percentAxis);
      ctx.font = `700 ${8 * dpr}px Inter, sans-serif`; ctx.textAlign = 'left';
      const width = ctx.measureText(label).width + 10 * dpr;
      ctx.fillStyle = badge.item.color; ctx.fillRect(w - pad.r + 5 * dpr, badgeY - 7 * dpr, width, 14 * dpr);
      ctx.fillStyle = '#07100c'; ctx.fillText(label, w - pad.r + 10 * dpr, badgeY + 2.5 * dpr);
    }
    if (pro.hoverX >= 0) {
      const target = firstTime + (pro.hoverX * dpr - pad.l) / (w - pad.l - pad.r) * timeRange;
      let closest = points[0];
      for (const point of points) if (Math.abs(point.t - target) < Math.abs(closest.t - target)) closest = point;
      const hx = x(closest.t);
      ctx.strokeStyle = 'rgba(207,214,226,.42)'; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke(); ctx.setLineDash([]);
      const parts = series.map(item => `${item.label} ${formatChartValue(closest[item.key], percentAxis)}`);
      const time = new Date(closest.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const label = `${time}  ·  ${parts.join('  ·  ')}`;
      ctx.font = `600 ${8.5 * dpr}px Inter, sans-serif`;
      const width = ctx.measureText(label).width + 16 * dpr;
      let tx = Math.max(pad.l, Math.min(w - pad.r - width, hx - width / 2));
      ctx.fillStyle = 'rgba(15,20,29,.96)'; ctx.strokeStyle = '#7050c8'; ctx.lineWidth = dpr;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(tx, 8 * dpr, width, 20 * dpr, 6 * dpr); else ctx.rect(tx, 8 * dpr, width, 20 * dpr);
      ctx.fill(); ctx.stroke(); ctx.fillStyle = '#eef1f6'; ctx.textAlign = 'left'; ctx.fillText(label, tx + 8 * dpr, 21.5 * dpr);
    }
  }

  window.ArbitragePro = { open, openDex, close };
})();
