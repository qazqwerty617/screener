'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const pro = {
    row: null, isFunding: false, tf: 'live', mode: 'best', depth: null, klines: null,
    depthLoading: false, requestId: 0, initialized: false, unsubs: [], drawQueued: false,
    livePoints: [], liveTimer: null, historyTimer: null, lastBuyPrice: 0, lastSellPrice: 0,
    hoverX: -1, hoverPoint: null
  };

  function pct(n, d = 3) { return `${Number(n) >= 0 ? '+' : ''}${Number(n || 0).toFixed(d)}%`; }
  function price(n) {
    n = Number(n) || 0;
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (n < 0.0001 && n > 0) return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    return n ? n.toPrecision(6).replace(/0+$/, '').replace(/\.$/, '') : '—';
  }
  function money(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  }
  function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }
  function fundingDaily(r) {
    if (pro.isFunding) return Number(r.daily) || 0;
    return ((Number(r.sellFunding) || 0) / (Number(r.sellInterval) || 8) - (Number(r.buyFunding) || 0) / (Number(r.buyInterval) || 8)) * 24;
  }
  function legs(r) {
    return pro.isFunding
      ? { buyEx: r.longEx, buyName: r.longName, buySymbol: r.longSymbol, buyPrice: r.longPrice || 0, buyMult: r.longMultiplier || 1, sellEx: r.shortEx, sellName: r.shortName, sellSymbol: r.shortSymbol, sellPrice: r.shortPrice || 0, sellMult: r.shortMultiplier || 1 }
      : { buyEx: r.buyEx, buyName: r.buyName, buySymbol: r.buySymbol, buyPrice: r.buyAsk, buyMult: r.buyMultiplier || 1, sellEx: r.sellEx, sellName: r.sellName, sellSymbol: r.sellSymbol, sellPrice: r.sellBid, sellMult: r.sellMultiplier || 1 };
  }

  function init() {
    if (pro.initialized) return;
    pro.initialized = true;

    const notionalEl = $('arb-notional');
    if (notionalEl) notionalEl.addEventListener('input', debounce(loadDepth, 300));
    const impactEl = $('arb-impact-limit');
    if (impactEl) impactEl.addEventListener('change', renderDepth);

    document.querySelectorAll('[data-arb-size]').forEach(btn => btn.addEventListener('click', () => {
      if (notionalEl) notionalEl.value = btn.dataset.arbSize;
      document.querySelectorAll('[data-arb-size]').forEach(x => x.classList.toggle('on', x === btn));
      loadDepth();
    }));

    document.querySelectorAll('[data-arb-tf]').forEach(btn => btn.addEventListener('click', () => {
      pro.tf = btn.dataset.arbTf;
      document.querySelectorAll('[data-arb-tf]').forEach(x => x.classList.toggle('on', x === btn));
      const titleEl = $('arb-chart-title');
      if (titleEl) titleEl.textContent = pro.tf === 'live' ? 'Спред в реальном времени (Live ⚡)' : `Исторический спред (${pro.tf})`;
      loadCharts();
    }));

    document.querySelectorAll('[data-spread-mode]').forEach(btn => btn.addEventListener('click', () => {
      pro.mode = btn.dataset.spreadMode;
      document.querySelectorAll('[data-spread-mode]').forEach(x => x.classList.toggle('on', x === btn));
      renderCharts();
    }));

    const detailCanvas = $('arb-detail-canvas');
    if (detailCanvas) {
      detailCanvas.addEventListener('mousemove', e => {
        const rect = detailCanvas.getBoundingClientRect();
        pro.hoverX = e.clientX - rect.left;
        scheduleCharts();
      });
      detailCanvas.addEventListener('mouseleave', () => {
        pro.hoverX = -1;
        pro.hoverPoint = null;
        scheduleCharts();
      });
    }
  }

  function recordLivePoint(t, bPrice, sPrice) {
    const r = pro.row; if (!r) return;
    const l = legs(r);
    const coins = window.coins;

    if (!bPrice || !sPrice) {
      bPrice = pro.lastBuyPrice || l.buyPrice;
      sPrice = pro.lastSellPrice || l.sellPrice;
      if (coins) {
        const bCoin = coins.get(`${l.buyEx}:${l.buySymbol}`);
        if (bCoin && (bCoin.ask > 0 || bCoin.p > 0)) bPrice = bCoin.ask || bCoin.p;
        const sCoin = coins.get(`${l.sellEx}:${l.sellSymbol}`);
        if (sCoin && (sCoin.bid > 0 || sCoin.p > 0)) sPrice = sCoin.bid || sCoin.p;
      }
    }

    if (bPrice > 0 && sPrice > 0) {
      const bNorm = bPrice / (l.buyMult || 1);
      const sNorm = sPrice / (l.sellMult || 1);
      let spread = ((sNorm - bNorm) / bNorm) * 100 - (pro.isFunding ? 0 : (r.fees || 0));
      if (pro.mode === 'volume' && pro.depth && !pro.isFunding) {
        const offset = pro.depth.netPct - r.net;
        spread += offset;
      }
      const last = pro.livePoints.at(-1);
      if (!last || last.buyP !== bPrice || last.sellP !== sPrice || (t - last.t >= 2000)) {
        pro.livePoints.push({ t, buyP: bPrice, sellP: sPrice, spread: spread });
        if (pro.livePoints.length > 600) pro.livePoints.shift();
        if (pro.tf === 'live') scheduleCharts();
      }
    }
  }

  function open(row, isFunding) {
    init();
    pro.row = row;
    pro.isFunding = isFunding;
    pro.depth = null;
    pro.klines = null;
    pro.mode = 'best';
    pro.tf = 'live';
    pro.requestId++;
    pro.livePoints = [];
    pro.lastBuyPrice = 0;
    pro.lastSellPrice = 0;
    pro.hoverX = -1;
    pro.hoverPoint = null;

    if (pro.liveTimer) clearInterval(pro.liveTimer);
    pro.liveTimer = setInterval(() => recordLivePoint(Date.now()), 1000);

    const drawer = $('arb-drawer');
    if (drawer) drawer.scrollTop = 0;
    const execEl = $('arb-execution');
    if (execEl) execEl.style.display = isFunding ? 'none' : 'block';

    document.querySelectorAll('[data-spread-mode]').forEach(x => x.classList.toggle('on', x.dataset.spreadMode === 'best'));
    document.querySelectorAll('[data-arb-tf]').forEach(x => x.classList.toggle('on', x.dataset.arbTf === 'live'));

    const l = legs(row);
    if ($('arb-buy-chart-title')) $('arb-buy-chart-title').textContent = `${l.buyName} · ${row.base}`;
    if ($('arb-sell-chart-title')) $('arb-sell-chart-title').textContent = `${l.sellName} · ${row.base}`;
    if ($('arb-buy-chart-price')) $('arb-buy-chart-price').textContent = price(l.buyPrice);
    if ($('arb-sell-chart-price')) $('arb-sell-chart-price').textContent = price(l.sellPrice);
    if ($('arb-chart-current')) $('arb-chart-current').textContent = pct(isFunding ? row.basis : row.net);
    if ($('arb-chart-funding')) $('arb-chart-funding').textContent = pct(fundingDaily(row), 4);
    if ($('arb-chart-empty')) {
      $('arb-chart-empty').textContent = 'Загружаем котировки и графики обеих бирж…';
      $('arb-chart-empty').hidden = false;
    }

    if ($('arb-chart-buy-label')) $('arb-chart-buy-label').textContent = l.buyName;
    if ($('arb-chart-sell-label')) $('arb-chart-sell-label').textContent = l.sellName;

    const titleEl = $('arb-chart-title');
    if (titleEl) titleEl.textContent = 'Спред в реальном времени (Live ⚡)';

    loadServerHistory(row.key);
    if (pro.historyTimer) clearInterval(pro.historyTimer);
    pro.historyTimer = setInterval(() => { if (pro.row) loadServerHistory(pro.row.key); }, 2000);

    loadCharts();
    if (!isFunding) loadDepth();
  }

  async function loadServerHistory(key) {
    const requestId = pro.requestId;
    try {
      const response = await fetch(`/api/arbitrage/history?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
      if (!response.ok || requestId !== pro.requestId) return;
      const data = await response.json();
      const points = (data.points || []).map(point => ({
        t: Number(point[0]) || 0,
        spread: Number(point[1]) || 0,
        buyP: Number(point[2]) || 0,
        sellP: Number(point[3]) || 0
      })).filter(point => point.t > 0 && point.buyP > 0 && point.sellP > 0);

      if (points.length >= 2) {
        pro.livePoints = points.slice(-500);
        if ($('arb-chart-empty')) $('arb-chart-empty').hidden = true;
        renderCharts();
      }
    } catch (_) {}
  }

  function closeStreams() {
    pro.unsubs.splice(0).forEach(fn => { try { fn(); } catch (_) { } });
    if (pro.liveTimer) { clearInterval(pro.liveTimer); pro.liveTimer = null; }
  }

  function close() {
    closeStreams();
    if (pro.historyTimer) { clearInterval(pro.historyTimer); pro.historyTimer = null; }
    pro.row = null;
    pro.depth = null;
    pro.klines = null;
    pro.livePoints = [];
    pro.requestId++;
  }

  async function loadDepth() {
    const r = pro.row; if (!r || pro.isFunding || pro.depthLoading) return;
    const requestId = pro.requestId;
    const notional = Math.max(10, Math.min(1000000, Number($('arb-notional')?.value) || 500));
    pro.depthLoading = true;
    if ($('arb-depth-state')) {
      $('arb-depth-state').textContent = 'СТАКАНЫ…';
      $('arb-depth-state').className = '';
    }
    try {
      const res = await fetch(`/api/arbitrage/depth?key=${encodeURIComponent(r.key)}&notional=${encodeURIComponent(notional)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
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
      if ($('arb-depth-state')) {
        $('arb-depth-state').textContent = 'СТАКАН НЕДОСТУПЕН';
        $('arb-depth-state').className = 'error';
      }
    } finally {
      pro.depthLoading = false;
    }
  }

  function renderDepth() {
    const d = pro.depth;
    if (!d) {
      ['arb-safe-volume', 'arb-depth-buy', 'arb-depth-sell', 'arb-depth-net', 'arb-depth-funded', 'arb-depth-pnl'].forEach(id => {
        if ($(id)) $(id).textContent = '—';
      });
      if ($('arb-depth-fill')) $('arb-depth-fill').style.width = '0';
      if ($('arb-depth-marker')) $('arb-depth-marker').style.left = '0';
      return;
    }
    const impact = Number($('arb-impact-limit')?.value) || 0.1;
    const band = d.bands.find(x => Number(x.impact) === impact) || d.bands[1];
    const safe = Number(band?.notional) || 0;
    const requested = Number(d.requestedNotional) || 0;

    if ($('arb-safe-volume')) $('arb-safe-volume').textContent = money(safe);
    if ($('arb-depth-buy')) $('arb-depth-buy').textContent = price(d.buy.average);
    if ($('arb-depth-buy-impact')) $('arb-depth-buy-impact').textContent = `проскальзывание ${pct(d.buy.impactPct, 4)}`;
    if ($('arb-depth-sell')) $('arb-depth-sell').textContent = price(d.sell.average);
    if ($('arb-depth-sell-impact')) $('arb-depth-sell-impact').textContent = `проскальзывание ${pct(d.sell.impactPct, 4)}`;
    if ($('arb-depth-net')) $('arb-depth-net').textContent = pct(d.netPct);
    if ($('arb-depth-funded')) $('arb-depth-funded').textContent = pct(d.netAfterFundingDayPct);
    if ($('arb-depth-pnl')) $('arb-depth-pnl').textContent = `${d.complete ? '≈' : 'до'} ${money(d.estimatedPnlAfterFundingDay)} PnL`;

    const ratio = safe > 0 ? Math.min(1, requested / safe) : 1;
    if ($('arb-depth-fill')) $('arb-depth-fill').style.width = `${ratio * 100}%`;
    if ($('arb-depth-marker')) $('arb-depth-marker').style.left = `${Math.min(99, ratio * 100)}%`;
    renderCharts();
  }

  function flatCandles(flat) {
    const out = [];
    for (let i = 0; Array.isArray(flat) && i + 5 < flat.length; i += 6) {
      let t = +flat[i];
      if (t < 1e11) t *= 1000;
      const c = { t, o: +flat[i + 1], h: +flat[i + 2], l: +flat[i + 3], c: +flat[i + 4], v: +flat[i + 5] };
      if (c.t && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0) out.push(c);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  function scheduleCharts() {
    if (pro.drawQueued) return;
    pro.drawQueued = true;
    requestAnimationFrame(() => { pro.drawQueued = false; renderCharts(); });
  }

  function updateLeg(side, data, isTick) {
    const list = pro.klines?.[side];
    if (!list?.length || !Array.isArray(data)) return;
    if (!isTick) {
      let t = +data[0];
      if (t < 1e11) t *= 1000;
      const c = { t, o: +data[1], h: +data[2], l: +data[3], c: +data[4], v: +data[5] };
      if (!(c.t && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)) return;
      const last = list.at(-1);
      if (c.t === last.t) Object.assign(last, c);
      else if (c.t > last.t) { list.push(c); if (list.length > 500) list.shift(); }
    } else {
      let t = +data[0];
      if (t < 1e11) t *= 1000;
      const p = +data[1], hi = +data[2] || p, lo = +data[3] || p;
      if (!(t > 0 && p > 0)) return;
      if (side === 'buy') pro.lastBuyPrice = p;
      if (side === 'sell') pro.lastSellPrice = p;

      recordLivePoint(t, pro.lastBuyPrice, pro.lastSellPrice);

      const tfMs = ({ "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 })[pro.tf] || 300000;
      let last = list.at(-1);
      if (t >= last.t + tfMs) {
        last = { t: Math.floor(t / tfMs) * tfMs, o: +data[4] || p, h: hi, l: lo, c: p, v: 0 };
        list.push(last); if (list.length > 500) list.shift();
      } else if (t >= last.t) {
        last.c = p; last.h = Math.max(last.h, hi, p); last.l = Math.min(last.l, lo, p);
      } else return;
    }
    const priceEl = $(side === 'buy' ? 'arb-buy-chart-price' : 'arb-sell-chart-price');
    if (priceEl && list.at(-1)) priceEl.textContent = price(list.at(-1).c);
    scheduleCharts();
  }

  function subscribeCharts(l, tf) {
    closeStreams();
    if (pro.row) pro.liveTimer = setInterval(() => recordLivePoint(Date.now()), 1000);
    if (!window.MarketData?.subscribe) return;
    const subTf = tf === 'live' ? '1m' : tf;
    [['buy', l.buyEx, l.buySymbol], ['sell', l.sellEx, l.sellSymbol]].forEach(([side, ex, sym]) => {
      pro.unsubs.push(window.MarketData.subscribe({
        ex, sym, tf: subTf,
        onKline: data => updateLeg(side, data, false),
        onTick: data => updateLeg(side, data, true)
      }));
    });
  }

  async function loadCharts() {
    closeStreams();
    const r = pro.row; if (!r) return;
    const requestId = pro.requestId, tf = pro.tf, l = legs(r);
    if ($('arb-chart-empty')) {
      $('arb-chart-empty').hidden = false;
      $('arb-chart-empty').textContent = 'Загружаем данные графиков…';
    }

    const fetchTf = tf === 'live' ? '1m' : tf;
    const fetchLeg = (ex, sym) => fetch(`/api/klines?ex=${encodeURIComponent(ex)}&sym=${encodeURIComponent(sym)}&tf=${encodeURIComponent(fetchTf)}&lite=1`, { cache: 'no-store' })
      .then(res => { if (!res.ok) throw new Error('klines'); return res.json(); });

    const [br, sr] = await Promise.allSettled([fetchLeg(l.buyEx, l.buySymbol), fetchLeg(l.sellEx, l.sellSymbol)]);
    if (pro.requestId !== requestId || pro.tf !== tf) return;

    const prev = pro.klines;
    const pick = (res, side) => {
      const candles = res.status === 'fulfilled' ? flatCandles(res.value) : [];
      if (candles.length > 1) return candles;
      return prev && prev[side] && prev[side].length > 1 ? prev[side] : candles;
    };

    pro.klines = { buy: pick(br, 'buy'), sell: pick(sr, 'sell') };
    const haveBoth = pro.klines.buy.length > 1 && pro.klines.sell.length > 1;

    // Seed continuous live points from 1m klines
    if (tf === 'live' && haveBoth && pro.livePoints.length < 5) {
      const seeded = [];
      const buyCandles = pro.klines.buy;
      const sellMap = new Map(pro.klines.sell.map(c => [c.t, c]));
      let lastKnownSell = pro.klines.sell[0]?.c || 0;

      for (const b of buyCandles) {
        const s = sellMap.get(b.t);
        if (s && s.c > 0) lastKnownSell = s.c;
        if (b.c > 0 && lastKnownSell > 0) {
          const bNorm = b.c / (l.buyMult || 1);
          const sNorm = lastKnownSell / (l.sellMult || 1);
          const spread = ((sNorm - bNorm) / bNorm) * 100 - (pro.isFunding ? 0 : r.fees);
          seeded.push({ t: b.t, buyP: b.c, sellP: lastKnownSell, spread });
        }
      }
      if (seeded.length > 2) pro.livePoints = seeded.slice(-200);
    }

    subscribeCharts(l, tf);
    renderCharts();
    const hasData = haveBoth || pro.livePoints.length > 1;
    if ($('arb-chart-empty')) {
      $('arb-chart-empty').hidden = hasData;
      if (!hasData) $('arb-chart-empty').textContent = 'Данные одной из бирж временно недоступны';
    }
  }

  function renderCharts() {
    const r = pro.row, k = pro.klines; if (!r) return;
    const l = legs(r);
    let points = [];

    if (pro.tf === 'live' || !k || !k.buy.length || !k.sell.length) {
      points = pro.livePoints.slice(-200);
    } else {
      // Robust historical timeframe timeline merger with forward-fill
      const buyList = k.buy;
      const sellList = k.sell;
      const sellMap = new Map(sellList.map(c => [c.t, c]));
      let lastKnownSell = sellList[0]?.c || 0;

      points = buyList.map(b => {
        const s = sellMap.get(b.t);
        if (s && s.c > 0) lastKnownSell = s.c;
        if (b.c <= 0 || lastKnownSell <= 0) return null;

        const bNorm = b.c / (l.buyMult || 1);
        const sNorm = lastKnownSell / (l.sellMult || 1);
        let spread = ((sNorm - bNorm) / bNorm) * 100 - (pro.isFunding ? 0 : r.fees);
        if (pro.mode === 'volume' && pro.depth && !pro.isFunding) {
          const offset = pro.depth.netPct - r.net;
          spread += offset;
        }
        return { t: b.t, buyP: b.c, sellP: lastKnownSell, spread };
      }).filter(Boolean);
    }

    drawSpread($('arb-detail-canvas'), points, fundingDaily(r), pro.tf === 'live', r);

    const drawLeg = (canvas, side, accent, priceKey) => {
      if (!canvas) return;
      const candles = k && k[side];
      const liveLine = () => drawLiveLegChart(canvas, pro.livePoints.map(p => ({ t: p.t, c: p[priceKey] })), accent);
      if (pro.tf === 'live') {
        if (pro.livePoints.length > 1) liveLine();
        else if (candles && candles.length > 1) drawCandles(canvas, candles, accent);
      } else if (candles && candles.length > 1) {
        drawCandles(canvas, candles, accent);
      } else {
        liveLine();
      }
    };
    drawLeg($('arb-buy-chart'), 'buy', '#2bd98a', 'buyP');
    drawLeg($('arb-sell-chart'), 'sell', '#ef647a', 'sellP');
  }

  function fit(canvas, height) {
    if (!canvas) return { ctx: null, w: 0, h: 0, dpr: 1 };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(260, canvas.clientWidth || 500);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    return { ctx: canvas.getContext('2d'), w: canvas.width, h: canvas.height, dpr };
  }

  function drawSpread(canvas, points, funding, isLive = false, row = null) {
    if (!canvas) return;
    const { ctx, w, h, dpr } = fit(canvas, 230);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!points || points.length < 2) return;
    points = points.slice(-200);

    const firstBuy = points[0].buyP || 1;
    const firstSell = points[0].sellP || 1;
    const buyPct = points.map(p => ((p.buyP - firstBuy) / firstBuy) * 100);
    const sellPct = points.map(p => ((p.sellP - firstSell) / firstSell) * 100);
    const spreadVal = points.map(p => p.spread);

    let sMn = Math.min(...spreadVal), sMx = Math.max(...spreadVal);
    const span = (sMx - sMn) || Math.max(Math.abs(sMx) * 0.005, 0.1);
    sMn -= span * 0.25; sMx += span * 0.25;
    const sRange = sMx - sMn;

    let pMn = Math.min(...buyPct, ...sellPct, 0), pMx = Math.max(...buyPct, ...sellPct, 0);
    const pPad = (pMx - pMn) * 0.15 || 0.1;
    pMn -= pPad; pMx += pPad;

    const pad = { l: 12 * dpr, r: 60 * dpr, t: 20 * dpr, b: 24 * dpr };
    const tMin = points[0].t;
    const tMax = isLive ? Math.max(Date.now(), points.at(-1).t) : points.at(-1).t;
    const tRange = Math.max(5000, tMax - tMin);
    const x = time => pad.l + (time - tMin) * (w - pad.l - pad.r) / tRange;
    const ySpread = v => pad.t + (sMx - v) * (h - pad.t - pad.b) / sRange;
    const yPrice = v => pad.t + (pMx - v) * (h - pad.t - pad.b) / (pMx - pMn);

    // Horizontal grid lines & percentage labels
    ctx.font = `${8.5 * dpr}px Inter, sans-serif`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = sMx - sRange * i / 4, yy = ySpread(v);
      ctx.strokeStyle = '#1e2430'; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillStyle = '#a78bfa'; ctx.fillText(`${v.toFixed(2)}%`, w - 6 * dpr, yy + 3 * dpr);
    }

    if (sMn < 0 && sMx > 0) {
      const zy = ySpread(0);
      ctx.strokeStyle = '#4b5566'; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(pad.l, zy); ctx.lineTo(w - pad.r, zy); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#6b7686'; ctx.fillText('0%', w - 6 * dpr, zy - 4 * dpr);
    }

    // Background Leg percentage curves
    ctx.lineWidth = dpr;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(x(p.t), yPrice(buyPct[i])) : ctx.moveTo(x(p.t), yPrice(buyPct[i])));
    if (isLive) ctx.lineTo(x(tMax), yPrice(buyPct.at(-1)));
    ctx.strokeStyle = '#2bd98a'; ctx.stroke();

    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(x(p.t), yPrice(sellPct[i])) : ctx.moveTo(x(p.t), yPrice(sellPct[i])));
    if (isLive) ctx.lineTo(x(tMax), yPrice(sellPct.at(-1)));
    ctx.strokeStyle = '#ef647a'; ctx.stroke();
    ctx.globalAlpha = 1;

    // Main Spread Curve
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(x(p.t), ySpread(spreadVal[i])) : ctx.moveTo(x(p.t), ySpread(spreadVal[i])));
    if (isLive) ctx.lineTo(x(tMax), ySpread(spreadVal.at(-1)));
    ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 2.6 * dpr; ctx.stroke();

    ctx.lineTo(x(tMax), h - pad.b);
    ctx.lineTo(x(tMin), h - pad.b);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    fill.addColorStop(0, 'rgba(167, 139, 250, 0.28)');
    fill.addColorStop(1, 'rgba(167, 139, 250, 0)');
    ctx.fillStyle = fill; ctx.fill();

    // Dynamic Trend Badge
    const trendWin = spreadVal.slice(0, -1).slice(-30);
    const trend = trendWin.length ? spreadVal.at(-1) - trendWin.reduce((a, b) => a + b, 0) / trendWin.length : 0;
    const eps = span * 0.015;
    const trendTxt = trend > eps ? '▲ расширяется' : trend < -eps ? '▼ сужается' : '→ стабилен';
    const trendCol = trend > eps ? '#2bd98a' : trend < -eps ? '#ef647a' : '#8b93a5';
    const label = `${trendTxt}  ${trend >= 0 ? '+' : ''}${trend.toFixed(3)}%`;

    ctx.font = `700 ${9.5 * dpr}px Inter, sans-serif`; ctx.textAlign = 'left';
    const lw = ctx.measureText(label).width + 16 * dpr;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(10 * dpr, 6 * dpr, lw, 20 * dpr, 10 * dpr);
    else ctx.rect(10 * dpr, 6 * dpr, lw, 20 * dpr);
    ctx.fillStyle = 'rgba(10, 13, 18, 0.88)'; ctx.fill();
    ctx.strokeStyle = trendCol; ctx.lineWidth = dpr; ctx.stroke();
    ctx.fillStyle = trendCol; ctx.fillText(label, 18 * dpr, 19.5 * dpr);

    // Time Axis Labels
    ctx.font = `${8 * dpr}px Inter, sans-serif`; ctx.fillStyle = '#677181';
    const timeFmt = isLive ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
    [tMin, tMin + tRange / 2, tMax].forEach((tVal, idx) => {
      ctx.fillText(new Date(tVal).toLocaleTimeString('ru-RU', timeFmt), pad.l + (idx / 2) * (w - pad.l - pad.r) - 20 * dpr, h - 6 * dpr);
    });

    // Pulsing Tip Indicator in Live Mode
    if (isLive) {
      const lastX = x(tMax), lastY = ySpread(spreadVal.at(-1));
      ctx.beginPath(); ctx.arc(lastX, lastY, 7 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(167, 139, 250, 0.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(lastX, lastY, 3.5 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = '#e2e8f0'; ctx.fill();
    }

    // Interactive Hover Crosshair & Floating Tooltip
    if (pro.hoverX > 0) {
      const targetTime = tMin + ((pro.hoverX * dpr - pad.l) / (w - pad.l - pad.r)) * tRange;
      let closest = points[0], minDiff = Infinity;
      for (const pt of points) {
        const diff = Math.abs(pt.t - targetTime);
        if (diff < minDiff) { minDiff = diff; closest = pt; }
      }
      if (closest) {
        const hx = x(closest.t), hy = ySpread(closest.spread);
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
        ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath(); ctx.arc(hx, hy, 5 * dpr, 0, 2 * Math.PI);
        ctx.fillStyle = '#a78bfa'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * dpr; ctx.stroke();

        // Tooltip badge
        const ttDate = new Date(closest.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const ttText = `${ttDate}  Спред: ${pct(closest.spread, 3)}`;
        ctx.font = `600 ${9 * dpr}px Inter, sans-serif`;
        const tw = ctx.measureText(ttText).width + 16 * dpr;
        let tx = hx - tw / 2;
        if (tx < pad.l) tx = pad.l;
        if (tx + tw > w - pad.r) tx = w - pad.r - tw;

        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(tx, 30 * dpr, tw, 18 * dpr, 6 * dpr);
        else ctx.rect(tx, 30 * dpr, tw, 18 * dpr);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)'; ctx.fill();
        ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = dpr; ctx.stroke();
        ctx.fillStyle = '#f8fafc'; ctx.fillText(ttText, tx + 8 * dpr, 42.5 * dpr);
      }
    }

    const l = row ? legs(row) : null;
    if (l) {
      if ($('arb-chart-buy-label')) $('arb-chart-buy-label').textContent = `${l.buyName} (${pct(buyPct.at(-1), 2)})`;
      if ($('arb-chart-sell-label')) $('arb-chart-sell-label').textContent = `${l.sellName} (${pct(sellPct.at(-1), 2)})`;
    }
    if ($('arb-chart-current')) $('arb-chart-current').textContent = (isLive ? 'LIVE ⚡ ' : '') + pct(spreadVal.at(-1));
    if ($('arb-chart-funding')) $('arb-chart-funding').textContent = pct(funding, 4);
  }

  function drawLiveLegChart(canvas, ticks, accent) {
    if (!canvas) return;
    const { ctx, w, h, dpr } = fit(canvas, 135);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const list = (ticks || []).slice(-120);
    if (list.length < 2) return;
    const vals = list.map(c => c.c);
    let mn = Math.min(...vals), mx = Math.max(...vals);
    if (mx === mn) { const bump = Math.abs(mx) * 0.001 || 0.5; mx += bump; mn -= bump; }
    const range = (mx - mn) || 1;
    const pad = 10 * dpr;

    const tMin = list[0].t;
    const tMax = Math.max(Date.now(), list.at(-1).t);
    const tRange = Math.max(5000, tMax - tMin);
    const x = time => pad + (time - tMin) * (w - pad * 2) / tRange;
    const y = v => pad + (mx - v) * (h - pad * 2) / range;

    ctx.strokeStyle = '#1d2330'; ctx.lineWidth = dpr;
    for (let i = 1; i < 4; i++) {
      const yy = h * i / 4;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
    }

    ctx.beginPath();
    list.forEach((c, i) => i ? ctx.lineTo(x(c.t), y(c.c)) : ctx.moveTo(x(c.t), y(c.c)));
    ctx.lineTo(x(tMax), y(vals.at(-1)));
    ctx.strokeStyle = accent; ctx.lineWidth = 2 * dpr; ctx.stroke();

    ctx.lineTo(x(tMax), h - pad);
    ctx.lineTo(x(tMin), h - pad);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
    fill.addColorStop(0, accent === '#2bd98a' ? 'rgba(43, 217, 138, 0.25)' : 'rgba(239, 100, 122, 0.25)');
    fill.addColorStop(1, 'transparent');
    ctx.fillStyle = fill; ctx.fill();

    const lastY = y(vals.at(-1));
    ctx.strokeStyle = accent; ctx.globalAlpha = 0.45; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(pad, lastY); ctx.lineTo(w - pad, lastY); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;

    ctx.font = `${8 * dpr}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(200, 208, 220, 0.6)'; ctx.textAlign = 'left';
    ctx.fillText(price(mx), 4 * dpr, 12 * dpr);
    ctx.fillText(price(mn), 4 * dpr, h - 4 * dpr);
    ctx.fillStyle = accent; ctx.textAlign = 'right';
    ctx.fillText(price(vals.at(-1)), w - 6 * dpr, lastY - 4 * dpr);

    const lastX = x(tMax);
    ctx.beginPath(); ctx.arc(lastX, lastY, 6 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = accent === '#2bd98a' ? 'rgba(43, 217, 138, 0.35)' : 'rgba(239, 100, 122, 0.35)'; ctx.fill();
    ctx.beginPath(); ctx.arc(lastX, lastY, 3 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = accent; ctx.fill();
  }

  function drawCandles(canvas, candles, accent) {
    if (!canvas) return;
    const { ctx, w, h, dpr } = fit(canvas, 135);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const list = (candles || []).slice(-80);
    if (list.length < 2) return;
    let mn = Math.min(...list.map(c => c.l)), mx = Math.max(...list.map(c => c.h));
    if (mx === mn) { const bump = Math.abs(mx) * 0.001 || 0.5; mx += bump; mn -= bump; }
    const range = mx - mn, pad = 8 * dpr;
    const cw = (w - pad * 2) / list.length;
    const y = v => pad + (mx - v) * (h - pad * 2) / range;

    ctx.strokeStyle = '#1d2330'; ctx.lineWidth = dpr;
    for (let i = 1; i < 4; i++) {
      const yy = h * i / 4;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
    }

    list.forEach((c, i) => {
      const xx = pad + i * cw + cw / 2, up = c.c >= c.o, col = up ? '#2bd98a' : '#ef647a';
      ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(xx, y(c.h)); ctx.lineTo(xx, y(c.l)); ctx.stroke();
      ctx.fillStyle = col;
      const top = Math.min(y(c.o), y(c.c)), bh = Math.max(1.5 * dpr, Math.abs(y(c.o) - y(c.c)));
      ctx.fillRect(xx - Math.max(1, cw * 0.3), top, Math.max(2, cw * 0.6), bh);
    });

    const last = list.at(-1), lastY = y(last.c);
    ctx.strokeStyle = accent; ctx.globalAlpha = 0.45; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(pad, lastY); ctx.lineTo(w - pad, lastY); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.font = `${8 * dpr}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(200, 208, 220, 0.6)'; ctx.textAlign = 'left';
    ctx.fillText(price(mx), 4 * dpr, 12 * dpr);
    ctx.fillText(price(mn), 4 * dpr, h - 4 * dpr);
    ctx.fillStyle = accent; ctx.textAlign = 'right';
    ctx.fillText(price(last.c), w - 6 * dpr, lastY - 4 * dpr);
    ctx.fillStyle = accent; ctx.fillRect(w - 3 * dpr, 0, 3 * dpr, h);
  }

  window.ArbitragePro = { open, close };
})();
