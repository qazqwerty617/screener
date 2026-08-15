'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const pro = {
    row: null, isFunding: false, tf: 'live', mode: 'best', depth: null, klines: null,
    depthLoading: false, requestId: 0, initialized: false, unsubs: [], drawQueued: false,
    livePoints: [], liveTimer: null, historyTimer: null, lastBuyPrice: 0, lastSellPrice: 0
  };

  function pct(n, d = 3) { return `${Number(n) >= 0 ? '+' : ''}${Number(n || 0).toFixed(d)}%`; }
  function price(n) {
    n = Number(n) || 0;
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
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
      ? { buyEx: r.longEx, buyName: r.longName, buySymbol: r.longSymbol, buyPrice: r.longPrice || 0, sellEx: r.shortEx, sellName: r.shortName, sellSymbol: r.shortSymbol, sellPrice: r.shortPrice || 0 }
      : { buyEx: r.buyEx, buyName: r.buyName, buySymbol: r.buySymbol, buyPrice: r.buyAsk, sellEx: r.sellEx, sellName: r.sellName, sellSymbol: r.sellSymbol, sellPrice: r.sellBid };
  }

  function init() {
    if (pro.initialized) return; pro.initialized = true;
    $('arb-notional').addEventListener('input', debounce(loadDepth, 300));
    $('arb-impact-limit').addEventListener('change', renderDepth);
    document.querySelectorAll('[data-arb-size]').forEach(btn => btn.addEventListener('click', () => {
      $('arb-notional').value = btn.dataset.arbSize;
      document.querySelectorAll('[data-arb-size]').forEach(x => x.classList.toggle('on', x === btn));
      loadDepth();
    }));
    document.querySelectorAll('[data-arb-tf]').forEach(btn => btn.addEventListener('click', () => {
      pro.tf = btn.dataset.arbTf;
      document.querySelectorAll('[data-arb-tf]').forEach(x => x.classList.toggle('on', x === btn));
      const titleEl = $('arb-chart-title');
      if (titleEl) titleEl.textContent = pro.tf === 'live' ? 'Спред в реальном времени (Live ⚡)' : 'Исторический спред';
      loadCharts();
    }));
    document.querySelectorAll('[data-spread-mode]').forEach(btn => btn.addEventListener('click', () => {
      pro.mode = btn.dataset.spreadMode;
      document.querySelectorAll('[data-spread-mode]').forEach(x => x.classList.toggle('on', x === btn));
      renderCharts();
    }));
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
      let spread = ((sPrice - bPrice) / bPrice) * 100 - (pro.isFunding ? 0 : (r.fees || 0));
      if (pro.mode === 'volume' && pro.depth && !pro.isFunding) {
        const offset = pro.depth.netPct - r.net;
        spread += offset;
      }
      const last = pro.livePoints.at(-1);
      // Avoid pushing duplicate points unless price moved or 5 seconds passed
      if (!last || last.buyP !== bPrice || last.sellP !== sPrice || (t - last.t >= 5000)) {
        pro.livePoints.push({ t, buyP: bPrice, sellP: sPrice, spread: spread });
        if (pro.livePoints.length > 500) pro.livePoints.shift();
        if (pro.tf === 'live') scheduleCharts();
      }
    }
  }

  function open(row, isFunding) {
    init(); pro.row = row; pro.isFunding = isFunding; pro.depth = null; pro.klines = null; pro.mode = 'best'; pro.tf = 'live'; pro.requestId++;
    pro.livePoints = []; pro.lastBuyPrice = 0; pro.lastSellPrice = 0;
    if (pro.liveTimer) clearInterval(pro.liveTimer);
    pro.liveTimer = setInterval(() => recordLivePoint(Date.now()), 1000);

    $('arb-drawer').scrollTop = 0;
    $('arb-execution').style.display = isFunding ? 'none' : 'block';
    document.querySelectorAll('[data-spread-mode]').forEach(x => x.classList.toggle('on', x.dataset.spreadMode === 'best'));
    document.querySelectorAll('[data-arb-tf]').forEach(x => x.classList.toggle('on', x.dataset.arbTf === 'live'));
    const l = legs(row);
    $('arb-buy-chart-title').textContent = `${l.buyName} · ${row.base}`; $('arb-sell-chart-title').textContent = `${l.sellName} · ${row.base}`;
    $('arb-buy-chart-price').textContent = price(l.buyPrice); $('arb-sell-chart-price').textContent = price(l.sellPrice);
    $('arb-chart-current').textContent = pct(isFunding ? row.basis : row.net); $('arb-chart-funding').textContent = pct(fundingDaily(row), 4);
    $('arb-chart-empty').textContent = 'Загружаем данные обеих бирж…'; $('arb-chart-empty').hidden = false;

    if ($('arb-chart-buy-label')) $('arb-chart-buy-label').textContent = l.buyName;
    if ($('arb-chart-sell-label')) $('arb-chart-sell-label').textContent = l.sellName;

    const titleEl = $('arb-chart-title');
    if (titleEl) titleEl.textContent = pro.tf === 'live' ? 'Спред в реальном времени (Live ⚡)' : 'Исторический спред';

    loadServerHistory(row.key);
    if (pro.historyTimer) clearInterval(pro.historyTimer);
    pro.historyTimer = setInterval(() => { if (pro.row) loadServerHistory(pro.row.key); }, 2000);
    loadCharts(); if (!isFunding) loadDepth();
  }

  async function loadServerHistory(key) {
    const requestId = pro.requestId;
    try {
      const response = await fetch(`/api/arbitrage/history?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || requestId !== pro.requestId) return;
      const points = (data.points || []).map(point => ({
        t: Number(point[0]) || 0, spread: Number(point[1]) || 0,
        buyP: Number(point[2]) || 0, sellP: Number(point[3]) || 0
      })).filter(point => point.t > 0 && point.buyP > 0 && point.sellP > 0);
      if (points.length) pro.livePoints = points.slice(-500);
      if (pro.livePoints.length > 1) { $('arb-chart-empty').hidden = true; renderCharts(); }
    } catch (_) {}
  }

  function closeStreams() {
    pro.unsubs.splice(0).forEach(fn => { try { fn(); } catch (_) { } });
    if (pro.liveTimer) { clearInterval(pro.liveTimer); pro.liveTimer = null; }
  }
  function close() {
    closeStreams();
    if (pro.historyTimer) { clearInterval(pro.historyTimer); pro.historyTimer = null; }
    pro.row = null; pro.depth = null; pro.klines = null; pro.livePoints = []; pro.requestId++;
  }

  async function loadDepth() {
    const r = pro.row; if (!r || pro.isFunding || pro.depthLoading) return; const requestId = pro.requestId;
    const notional = Math.max(10, Math.min(1000000, Number($('arb-notional').value) || 500));
    pro.depthLoading = true; $('arb-depth-state').textContent = 'СТАКАНЫ…'; $('arb-depth-state').className = '';
    try {
      const res = await fetch(`/api/arbitrage/depth?key=${encodeURIComponent(r.key)}&notional=${encodeURIComponent(notional)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      if (pro.requestId !== requestId) return;
      pro.depth = data; renderDepth();
      $('arb-depth-state').textContent = data.complete ? 'ИСПОЛНИМО' : 'НЕПОЛНЫЙ ОБЪЁМ';
      $('arb-depth-state').className = data.complete ? 'ready' : 'error';
    }
    catch (_) {
      if (pro.requestId !== requestId) return;
      pro.depth = null; renderDepth();
      $('arb-depth-state').textContent = 'СТАКАН НЕДОСТУПЕН';
      $('arb-depth-state').className = 'error';
    }
    finally { pro.depthLoading = false; }
  }

  function renderDepth() {
    const d = pro.depth; if (!d) { ['arb-safe-volume', 'arb-depth-buy', 'arb-depth-sell', 'arb-depth-net', 'arb-depth-funded', 'arb-depth-pnl'].forEach(id => $(id).textContent = '—'); $('arb-depth-fill').style.width = '0'; $('arb-depth-marker').style.left = '0'; return; }
    const impact = Number($('arb-impact-limit').value) || .1, band = d.bands.find(x => Number(x.impact) === impact) || d.bands[1], safe = Number(band?.notional) || 0, requested = Number(d.requestedNotional) || 0;
    $('arb-safe-volume').textContent = money(safe); $('arb-depth-buy').textContent = price(d.buy.average); $('arb-depth-buy-impact').textContent = `проскальзывание ${pct(d.buy.impactPct, 4)}`;
    $('arb-depth-sell').textContent = price(d.sell.average); $('arb-depth-sell-impact').textContent = `проскальзывание ${pct(d.sell.impactPct, 4)}`;
    $('arb-depth-net').textContent = pct(d.netPct); $('arb-depth-funded').textContent = pct(d.netAfterFundingDayPct); $('arb-depth-pnl').textContent = `${d.complete ? '≈' : 'до'} ${money(d.estimatedPnlAfterFundingDay)} PnL`;
    const ratio = safe > 0 ? Math.min(1, requested / safe) : 1; $('arb-depth-fill').style.width = `${ratio * 100}%`; $('arb-depth-marker').style.left = `${Math.min(99, ratio * 100)}%`; renderCharts();
  }

  function flatCandles(flat) { const out = []; for (let i = 0; Array.isArray(flat) && i + 5 < flat.length; i += 6) { const c = { t: +flat[i], o: +flat[i + 1], h: +flat[i + 2], l: +flat[i + 3], c: +flat[i + 4], v: +flat[i + 5] }; if (c.t && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0) out.push(c); } return out; }
  function scheduleCharts() { if (pro.drawQueued) return; pro.drawQueued = true; requestAnimationFrame(() => { pro.drawQueued = false; renderCharts(); }); }

  function updateLeg(side, data, isTick) {
    const list = pro.klines?.[side]; if (!list?.length || !Array.isArray(data)) return;
    if (!isTick) {
      const c = { t: +data[0], o: +data[1], h: +data[2], l: +data[3], c: +data[4], v: +data[5] };
      if (!(c.t && c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)) return;
      const last = list.at(-1);
      if (c.t === last.t) Object.assign(last, c);
      else if (c.t > last.t) { list.push(c); if (list.length > 500) list.shift(); }
    } else {
      const t = +data[0], p = +data[1], hi = +data[2] || p, lo = +data[3] || p;
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
    $(side === 'buy' ? 'arb-buy-chart-price' : 'arb-sell-chart-price').textContent = price(list.at(-1).c);
    scheduleCharts();
  }

  function subscribeCharts(l, tf) {
    closeStreams();
    if (pro.row) pro.liveTimer = setInterval(() => recordLivePoint(Date.now()), 1000);
    if (!window.MarketData?.subscribe) return;
    const subTf = tf === 'live' ? '1m' : tf;
    [['buy', l.buyEx, l.buySymbol], ['sell', l.sellEx, l.sellSymbol]].forEach(([side, ex, sym]) => {
      pro.unsubs.push(window.MarketData.subscribe({ ex, sym, tf: subTf, onKline: data => updateLeg(side, data, false), onTick: data => updateLeg(side, data, true) }));
    });
  }

  async function loadCharts() {
    closeStreams();
    const r = pro.row; if (!r) return; const requestId = pro.requestId, tf = pro.tf, l = legs(r);
    $('arb-chart-empty').hidden = false; $('arb-chart-empty').textContent = 'Загружаем данные обеих бирж…';
    const fetchTf = tf === 'live' ? '1m' : tf;
    // Legs load independently: some venues (e.g. Hyperliquid perps without
    // candle history) must not blank out the whole drawer.
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

    // Seed live points from 1m klines only while the server spread history
    // has not delivered richer 2s-resolution points yet.
    if (tf === 'live' && haveBoth && pro.livePoints.length < 2) {
      const sm = new Map(pro.klines.sell.map(c => [c.t, c]));
      const seeded = pro.klines.buy.map(b => {
        const s = sm.get(b.t);
        if (!s || b.c <= 0 || s.c <= 0) return null;
        return { t: b.t, buyP: b.c, sellP: s.c, spread: ((s.c - b.c) / b.c) * 100 - (pro.isFunding ? 0 : r.fees) };
      }).filter(Boolean);
      pro.livePoints = seeded.slice(-180);
    }

    subscribeCharts(l, tf);
    renderCharts();
    const hasData = haveBoth || pro.livePoints.length > 1;
    $('arb-chart-empty').hidden = hasData;
    if (!hasData) $('arb-chart-empty').textContent = 'Данные одной из бирж временно недоступны';
  }

  function renderCharts() {
    const r = pro.row, k = pro.klines; if (!r) return;
    let points = [];
    if (pro.tf === 'live' || !k) {
      points = pro.livePoints.slice(-200);
    } else {
      const sm = new Map(k.sell.map(c => [c.t, c]));
      points = k.buy.map(b => {
        const s = sm.get(b.t);
        if (!s || b.c <= 0 || s.c <= 0) return null;
        let spread = ((s.c - b.c) / b.c) * 100 - (pro.isFunding ? 0 : r.fees);
        if (pro.mode === 'volume' && pro.depth && !pro.isFunding) {
          const offset = pro.depth.netPct - r.net;
          spread += offset;
        }
        return { t: b.t, buyP: b.c, sellP: s.c, spread: spread };
      }).filter(Boolean);
    }

    drawSpread($('arb-detail-canvas'), points, fundingDaily(r), pro.tf === 'live', r);

    // Per-leg rendering: real candles when the venue has them, otherwise the
    // live price line recorded from the server spread history.
    const drawLeg = (canvas, side, accent, priceKey) => {
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
    const dpr = Math.min(2, devicePixelRatio || 1), w = Math.max(260, canvas.clientWidth || 500);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(height * dpr);
    return { ctx: canvas.getContext('2d'), w: canvas.width, h: canvas.height, dpr };
  }

  // Spread-first chart: bright spread curve with trend pill and break-even
  // line; leg price curves stay as dim background context.
  function drawSpread(canvas, points, funding, isLive = false, row = null) {
    const { ctx, w, h, dpr } = fit(canvas, 220); ctx.clearRect(0, 0, w, h);
    if (!points || points.length < 2) return;
    points = points.slice(-180);

    const firstBuy = points[0].buyP || 1;
    const firstSell = points[0].sellP || 1;
    const buyPct = points.map(p => ((p.buyP - firstBuy) / firstBuy) * 100);
    const sellPct = points.map(p => ((p.sellP - firstSell) / firstSell) * 100);
    const spreadVal = points.map(p => p.spread);

    // Padded spread scale so a quiet spread does not collapse to a razor line.
    let sMn = Math.min(...spreadVal), sMx = Math.max(...spreadVal);
    const span = (sMx - sMn) || Math.max(Math.abs(sMx) * 0.002, 0.05);
    sMn -= span * 0.3; sMx += span * 0.3;
    const sRange = sMx - sMn;

    let pMn = Math.min(...buyPct, ...sellPct, 0), pMx = Math.max(...buyPct, ...sellPct, 0);
    const pPad = (pMx - pMn) * 0.1 || 0.05;
    pMn -= pPad; pMx += pPad;

    const pad = { l: 8 * dpr, r: 58 * dpr, t: 18 * dpr, b: 24 * dpr };
    const tMin = points[0].t;
    const tMax = isLive ? Math.max(Date.now(), points.at(-1).t) : points.at(-1).t;
    const tRange = Math.max(5000, tMax - tMin);
    const x = time => pad.l + (time - tMin) * (w - pad.l - pad.r) / tRange;
    const ySpread = v => pad.t + (sMx - v) * (h - pad.t - pad.b) / sRange;
    const yPrice = v => pad.t + (pMx - v) * (h - pad.t - pad.b) / (pMx - pMn);

    ctx.font = `${8 * dpr}px Inter`;
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

    ctx.lineWidth = dpr;
    ctx.globalAlpha = 0.3;
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(x(p.t), yPrice(buyPct[i])) : ctx.moveTo(x(p.t), yPrice(buyPct[i]))); if (isLive) ctx.lineTo(x(tMax), yPrice(buyPct.at(-1))); ctx.strokeStyle = '#2bd98a'; ctx.stroke();
    ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(x(p.t), yPrice(sellPct[i])) : ctx.moveTo(x(p.t), yPrice(sellPct[i]))); if (isLive) ctx.lineTo(x(tMax), yPrice(sellPct.at(-1))); ctx.strokeStyle = '#ef647a'; ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(x(p.t), ySpread(spreadVal[i])) : ctx.moveTo(x(p.t), ySpread(spreadVal[i])));
    if (isLive) ctx.lineTo(x(tMax), ySpread(spreadVal.at(-1)));
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2.6 * dpr; ctx.stroke();
    ctx.lineTo(x(tMax), h - pad.b); ctx.lineTo(x(tMin), h - pad.b); ctx.closePath();
    const fill = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    fill.addColorStop(0, 'rgba(167, 139, 250, 0.25)'); fill.addColorStop(1, 'rgba(167, 139, 250, 0)');
    ctx.fillStyle = fill; ctx.fill();

    // Trend: last point vs the mean of the preceding window.
    const trendWin = spreadVal.slice(0, -1).slice(-40);
    const trend = trendWin.length ? spreadVal.at(-1) - trendWin.reduce((a, b) => a + b, 0) / trendWin.length : 0;
    const eps = span * 0.02;
    const trendTxt = trend > eps ? '▲ расширяется' : trend < -eps ? '▼ сужается' : '→ стабилен';
    const trendCol = trend > eps ? '#2bd98a' : trend < -eps ? '#ef647a' : '#8b93a5';
    const label = `${trendTxt}  ${trend >= 0 ? '+' : ''}${trend.toFixed(3)}%`;
    ctx.font = `700 ${10 * dpr}px Inter`; ctx.textAlign = 'left';
    const lw = ctx.measureText(label).width + 14 * dpr;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(8 * dpr, 6 * dpr, lw, 18 * dpr, 9 * dpr); else ctx.rect(8 * dpr, 6 * dpr, lw, 18 * dpr);
    ctx.fillStyle = 'rgba(10,13,18,.85)'; ctx.fill();
    ctx.strokeStyle = trendCol; ctx.lineWidth = dpr; ctx.stroke();
    ctx.fillStyle = trendCol; ctx.fillText(label, 15 * dpr, 17.5 * dpr);

    ctx.font = `${8 * dpr}px Inter`; ctx.fillStyle = '#677181';
    const timeFmt = isLive ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
    [tMin, tMin + tRange / 2, tMax].forEach((tVal, idx) => {
      ctx.fillText(new Date(tVal).toLocaleTimeString('ru-RU', timeFmt), pad.l + (idx / 2) * (w - pad.l - pad.r) - 18 * dpr, h - 6 * dpr);
    });

    if (isLive) {
      const lastX = x(tMax), lastY = ySpread(spreadVal.at(-1));
      ctx.beginPath(); ctx.arc(lastX, lastY, 6.5 * dpr, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(226,232,240,.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(lastX, lastY, 3.5 * dpr, 0, 2 * Math.PI); ctx.fillStyle = '#e2e8f0'; ctx.fill();
    }

    const l = row ? legs(row) : null;
    if (l) {
      if ($('arb-chart-buy-label')) $('arb-chart-buy-label').textContent = `${l.buyName} (${pct(buyPct.at(-1), 2)})`;
      if ($('arb-chart-sell-label')) $('arb-chart-sell-label').textContent = `${l.sellName} (${pct(sellPct.at(-1), 2)})`;
    }
    $('arb-chart-current').textContent = (isLive ? 'LIVE ⚡ ' : '') + pct(spreadVal.at(-1));
    $('arb-chart-funding').textContent = pct(funding, 4);
  }

  function drawLiveLegChart(canvas, ticks, accent) {
    const { ctx, w, h, dpr } = fit(canvas, 130); ctx.clearRect(0, 0, w, h);
    const list = ticks.slice(-100); if (list.length < 2) return;
    const vals = list.map(c => c.c);
    let mn = Math.min(...vals), mx = Math.max(...vals);
    // A frozen price line sits mid-chart instead of hugging the edge.
    if (mx === mn) { const bump = Math.abs(mx) * 0.001 || 0.5; mx += bump; mn -= bump; }
    const range = (mx - mn) || 1;
    const pad = 10 * dpr;

    const tMin = list[0].t;
    const tMax = Math.max(Date.now(), list.at(-1).t);
    const tRange = Math.max(5000, tMax - tMin);
    const x = time => pad + (time - tMin) * (w - pad * 2) / tRange;
    const y = v => pad + (mx - v) * (h - pad * 2) / range;

    ctx.strokeStyle = '#1d2330'; ctx.lineWidth = dpr;
    for (let i = 1; i < 4; i++) { const yy = h * i / 4; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke(); }

    ctx.beginPath();
    list.forEach((c, i) => i ? ctx.lineTo(x(c.t), y(c.c)) : ctx.moveTo(x(c.t), y(c.c)));
    ctx.lineTo(x(tMax), y(vals.at(-1)));
    ctx.strokeStyle = accent; ctx.lineWidth = 2 * dpr; ctx.stroke();

    ctx.lineTo(x(tMax), h - pad);
    ctx.lineTo(x(tMin), h - pad);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, pad, 0, h - pad);
    fill.addColorStop(0, accent === '#2bd98a' ? 'rgba(43, 217, 138, 0.22)' : 'rgba(239, 100, 122, 0.22)');
    fill.addColorStop(1, 'transparent');
    ctx.fillStyle = fill; ctx.fill();

    // Last price marker + readable price scale
    const lastY = y(vals.at(-1));
    ctx.strokeStyle = accent; ctx.globalAlpha = .45; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(pad, lastY); ctx.lineTo(w - pad, lastY); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.font = `${8 * dpr}px Inter`;
    ctx.fillStyle = 'rgba(200,208,220,.5)'; ctx.textAlign = 'left';
    ctx.fillText(price(mx), 4 * dpr, 12 * dpr);
    ctx.fillText(price(mn), 4 * dpr, h - 4 * dpr);
    ctx.fillStyle = accent; ctx.textAlign = 'right';
    ctx.fillText(price(vals.at(-1)), w - 6 * dpr, lastY - 4 * dpr);

    // Pulsing tip dot at tMax
    const lastX = x(tMax);
    ctx.beginPath(); ctx.arc(lastX, lastY, 6 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = accent === '#2bd98a' ? 'rgba(43, 217, 138, 0.35)' : 'rgba(239, 100, 122, 0.35)'; ctx.fill();
    ctx.beginPath(); ctx.arc(lastX, lastY, 3 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = accent; ctx.fill();
  }

  function drawCandles(canvas, candles, accent) {
    const { ctx, w, h, dpr } = fit(canvas, 130); ctx.clearRect(0, 0, w, h);
    const list = candles.slice(-70); if (list.length < 2) return;
    let mn = Math.min(...list.map(c => c.l)), mx = Math.max(...list.map(c => c.h));
    if (mx === mn) { const bump = Math.abs(mx) * 0.001 || 0.5; mx += bump; mn -= bump; }
    const range = mx - mn, pad = 8 * dpr,
      cw = (w - pad * 2) / list.length, y = v => pad + (mx - v) * (h - pad * 2) / range;
    ctx.strokeStyle = '#1d2330'; ctx.lineWidth = dpr;
    for (let i = 1; i < 4; i++) { const yy = h * i / 4; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke(); }
    list.forEach((c, i) => {
      const xx = pad + i * cw + cw / 2, up = c.c >= c.o, col = up ? '#2bd98a' : '#ef647a';
      ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(xx, y(c.h)); ctx.lineTo(xx, y(c.l)); ctx.stroke();
      ctx.fillStyle = col; const top = Math.min(y(c.o), y(c.c)), bh = Math.max(1.5 * dpr, Math.abs(y(c.o) - y(c.c)));
      ctx.fillRect(xx - Math.max(1, cw * .3), top, Math.max(2, cw * .6), bh);
    });
    // Price scale labels + last close marker
    const last = list.at(-1), lastY = y(last.c);
    ctx.strokeStyle = accent; ctx.globalAlpha = .45; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(pad, lastY); ctx.lineTo(w - pad, lastY); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.font = `${8 * dpr}px Inter`;
    ctx.fillStyle = 'rgba(200,208,220,.5)'; ctx.textAlign = 'left';
    ctx.fillText(price(mx), 4 * dpr, 12 * dpr);
    ctx.fillText(price(mn), 4 * dpr, h - 4 * dpr);
    ctx.fillStyle = accent; ctx.textAlign = 'right';
    ctx.fillText(price(last.c), w - 6 * dpr, lastY - 4 * dpr);
    ctx.fillStyle = accent; ctx.fillRect(w - 3 * dpr, 0, 3 * dpr, h);
  }

  window.ArbitragePro = { open, close };
})();
