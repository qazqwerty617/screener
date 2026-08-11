'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const pro = {
    row: null, isFunding: false, tf: '5m', mode: 'best', depth: null, klines: null,
    depthLoading: false, requestId: 0, initialized: false, unsubs: [], drawQueued: false,
    livePoints: [], liveTimer: null, lastBuyPrice: 0, lastSellPrice: 0
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

  function recordLiveTick() {
    const r = pro.row; if (!r) return;
    const l = legs(r);
    const coins = window.coins;
    let bPrice = pro.lastBuyPrice || l.buyPrice;
    let sPrice = pro.lastSellPrice || l.sellPrice;

    if (coins) {
      const bCoin = coins.get(`${l.buyEx}:${l.buySymbol}`);
      if (bCoin && bCoin.p > 0) bPrice = bCoin.p;
      const sCoin = coins.get(`${l.sellEx}:${l.sellSymbol}`);
      if (sCoin && sCoin.p > 0) sPrice = sCoin.p;
    }

    if (bPrice > 0 && sPrice > 0) {
      let spread = ((sPrice - bPrice) / bPrice) * 100 - (pro.isFunding ? 0 : (r.fees || 0));
      if (pro.mode === 'volume' && pro.depth && !pro.isFunding) {
        const offset = pro.depth.netPct - r.net;
        spread += offset;
      }
      pro.livePoints.push({ t: Date.now(), buyP: bPrice, sellP: sPrice, spread: spread });
      if (pro.livePoints.length > 300) pro.livePoints.shift();
      if (pro.tf === 'live') scheduleCharts();
    }
  }

  function open(row, isFunding) {
    init(); pro.row = row; pro.isFunding = isFunding; pro.depth = null; pro.klines = null; pro.mode = 'best'; pro.requestId++;
    pro.livePoints = []; pro.lastBuyPrice = 0; pro.lastSellPrice = 0;
    if (pro.liveTimer) clearInterval(pro.liveTimer);
    pro.liveTimer = setInterval(recordLiveTick, 1000);

    $('arb-drawer').scrollTop = 0;
    $('arb-execution').style.display = isFunding ? 'none' : 'block';
    document.querySelectorAll('[data-spread-mode]').forEach(x => x.classList.toggle('on', x.dataset.spreadMode === 'best'));
    const l = legs(row);
    $('arb-buy-chart-title').textContent = `${l.buyName} · ${row.base}`; $('arb-sell-chart-title').textContent = `${l.sellName} · ${row.base}`;
    $('arb-buy-chart-price').textContent = price(l.buyPrice); $('arb-sell-chart-price').textContent = price(l.sellPrice);
    $('arb-chart-current').textContent = pct(isFunding ? row.basis : row.net); $('arb-chart-funding').textContent = pct(fundingDaily(row), 4);
    $('arb-chart-empty').textContent = 'Загружаем данные обеих бирж…'; $('arb-chart-empty').hidden = false;

    if ($('arb-chart-buy-label')) $('arb-chart-buy-label').textContent = l.buyName;
    if ($('arb-chart-sell-label')) $('arb-chart-sell-label').textContent = l.sellName;

    const titleEl = $('arb-chart-title');
    if (titleEl) titleEl.textContent = pro.tf === 'live' ? 'Спред в реальном времени (Live ⚡)' : 'Исторический спред';

    loadCharts(); if (!isFunding) loadDepth();
  }

  function closeStreams() {
    pro.unsubs.splice(0).forEach(fn => { try { fn(); } catch (_) { } });
    if (pro.liveTimer) { clearInterval(pro.liveTimer); pro.liveTimer = null; }
  }
  function close() { closeStreams(); pro.row = null; pro.depth = null; pro.klines = null; pro.livePoints = []; pro.requestId++; }

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
    if (pro.row) pro.liveTimer = setInterval(recordLiveTick, 1000);
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
    try {
      const [br, sr] = await Promise.all([
        fetch(`/api/klines?ex=${encodeURIComponent(l.buyEx)}&sym=${encodeURIComponent(l.buySymbol)}&tf=${encodeURIComponent(fetchTf)}&lite=1`, { cache: 'no-store' }),
        fetch(`/api/klines?ex=${encodeURIComponent(l.sellEx)}&sym=${encodeURIComponent(l.sellSymbol)}&tf=${encodeURIComponent(fetchTf)}&lite=1`, { cache: 'no-store' })
      ]);
      if (!br.ok || !sr.ok) throw new Error('klines');
      const [bf, sf] = await Promise.all([br.json(), sr.json()]);
      if (pro.requestId !== requestId || pro.tf !== tf) return;
      pro.klines = { buy: flatCandles(bf), sell: flatCandles(sf) };
      $('arb-chart-empty').hidden = pro.klines.buy.length > 1 && pro.klines.sell.length > 1;

      // Seed live points from 1m klines if switching to Live mode
      if (tf === 'live' && pro.klines.buy.length > 0 && pro.klines.sell.length > 0) {
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
    }
    catch (_) {
      if (pro.requestId === requestId) {
        $('arb-chart-empty').textContent = 'Данные одной из бирж временно недоступны';
        $('arb-chart-empty').hidden = false;
      }
    }
  }

  function renderCharts() {
    const r = pro.row, k = pro.klines; if (!r || !k) return;
    let points = [];
    if (pro.tf === 'live') {
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
    drawCandles($('arb-buy-chart'), k.buy, '#2bd98a');
    drawCandles($('arb-sell-chart'), k.sell, '#ef647a');
  }

  function fit(canvas, height) {
    const dpr = Math.min(2, devicePixelRatio || 1), w = Math.max(260, canvas.clientWidth || 500);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(height * dpr);
    return { ctx: canvas.getContext('2d'), w: canvas.width, h: canvas.height, dpr };
  }

  function drawSpread(canvas, points, funding, isLive = false, row = null) {
    const { ctx, w, h, dpr } = fit(canvas, 220); ctx.clearRect(0, 0, w, h);
    if (!points || points.length < 2) return;
    points = points.slice(-180);

    const firstBuy = points[0].buyP || 1;
    const firstSell = points[0].sellP || 1;

    const buyPct = points.map(p => ((p.buyP - firstBuy) / firstBuy) * 100);
    const sellPct = points.map(p => ((p.sellP - firstSell) / firstSell) * 100);
    const spreadPct = points.map(p => p.spread);

    const allVals = [...buyPct, ...sellPct, ...spreadPct, 0];
    const mn = Math.min(...allVals);
    const mx = Math.max(...allVals);
    const range = (mx - mn) || 0.01;

    const pad = { l: 48 * dpr, r: 16 * dpr, t: 18 * dpr, b: 24 * dpr };
    const x = i => pad.l + i * (w - pad.l - pad.r) / (points.length - 1);
    const y = v => pad.t + (mx - v) * (h - pad.t - pad.b) / range;

    // Grid & Axis
    ctx.font = `${8 * dpr}px Inter`; ctx.strokeStyle = '#202632'; ctx.fillStyle = '#697382'; ctx.lineWidth = dpr;
    for (let i = 0; i < 5; i++) {
      const v = mx - range * i / 4, yy = y(v);
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillText(`${v.toFixed(2)}%`, 3 * dpr, yy + 3 * dpr);
    }
    const zy = y(0); ctx.strokeStyle = '#586171'; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(pad.l, zy); ctx.lineTo(w - pad.r, zy); ctx.stroke(); ctx.setLineDash([]);

    // 1. Buy Exchange Price % Curve (Green)
    ctx.beginPath();
    points.forEach((_, i) => i ? ctx.lineTo(x(i), y(buyPct[i])) : ctx.moveTo(x(i), y(buyPct[i])));
    ctx.strokeStyle = '#2bd98a'; ctx.lineWidth = 1.8 * dpr; ctx.stroke();

    // 2. Sell Exchange Price % Curve (Red)
    ctx.beginPath();
    points.forEach((_, i) => i ? ctx.lineTo(x(i), y(sellPct[i])) : ctx.moveTo(x(i), y(sellPct[i])));
    ctx.strokeStyle = '#ef647a'; ctx.lineWidth = 1.8 * dpr; ctx.stroke();

    // 3. Spread Curve (Gray / Light Purple)
    ctx.beginPath();
    points.forEach((_, i) => i ? ctx.lineTo(x(i), y(spreadPct[i])) : ctx.moveTo(x(i), y(spreadPct[i])));
    ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2.4 * dpr; ctx.stroke();

    // Fill under spread curve
    ctx.lineTo(x(points.length - 1), h - pad.b);
    ctx.lineTo(x(0), h - pad.b);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    fill.addColorStop(0, 'rgba(203, 213, 225, 0.15)'); fill.addColorStop(1, 'rgba(203, 213, 225, 0)');
    ctx.fillStyle = fill; ctx.fill();

    // Time labels on X axis
    ctx.fillStyle = '#677181';
    const timeFmt = isLive ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
    [0, Math.floor(points.length / 2), points.length - 1].forEach(i => {
      ctx.fillText(new Date(points[i].t).toLocaleTimeString('ru-RU', timeFmt), x(i) - 18 * dpr, h - 6 * dpr);
    });

    // Pulse live dot indicators on latest points
    if (isLive) {
      const lastIdx = points.length - 1;
      const lastX = x(lastIdx);

      // Buy tip dot
      ctx.beginPath(); ctx.arc(lastX, y(buyPct[lastIdx]), 3 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = '#2bd98a'; ctx.fill();

      // Sell tip dot
      ctx.beginPath(); ctx.arc(lastX, y(sellPct[lastIdx]), 3 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = '#ef647a'; ctx.fill();

      // Spread tip dot
      ctx.beginPath(); ctx.arc(lastX, y(spreadPct[lastIdx]), 6 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(203, 213, 225, 0.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(lastX, y(spreadPct[lastIdx]), 3 * dpr, 0, 2 * Math.PI);
      ctx.fillStyle = '#cbd5e1'; ctx.fill();
    }

    // Legend updates
    const l = row ? legs(row) : null;
    if (l) {
      if ($('arb-chart-buy-label')) $('arb-chart-buy-label').textContent = `${l.buyName} (${pct(buyPct.at(-1), 2)})`;
      if ($('arb-chart-sell-label')) $('arb-chart-sell-label').textContent = `${l.sellName} (${pct(sellPct.at(-1), 2)})`;
    }
    $('arb-chart-current').textContent = (isLive ? 'LIVE ⚡ ' : '') + pct(spreadPct.at(-1));
    $('arb-chart-funding').textContent = pct(funding, 4);
  }

  function drawCandles(canvas, candles, accent) {
    const { ctx, w, h, dpr } = fit(canvas, 130); ctx.clearRect(0, 0, w, h);
    const list = candles.slice(-70); if (list.length < 2) return;
    const mn = Math.min(...list.map(c => c.l)), mx = Math.max(...list.map(c => c.h)), range = mx - mn || 1, pad = 8 * dpr,
      cw = (w - pad * 2) / list.length, y = v => pad + (mx - v) * (h - pad * 2) / range;
    ctx.strokeStyle = '#1d2330';
    for (let i = 1; i < 4; i++) { const yy = h * i / 4; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke(); }
    list.forEach((c, i) => {
      const xx = pad + i * cw + cw / 2, up = c.c >= c.o, col = up ? '#2bd98a' : '#ef647a';
      ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(xx, y(c.h)); ctx.lineTo(xx, y(c.l)); ctx.stroke();
      ctx.fillStyle = col; const top = Math.min(y(c.o), y(c.c)), bh = Math.max(1.5 * dpr, Math.abs(y(c.o) - y(c.c)));
      ctx.fillRect(xx - Math.max(1, cw * .3), top, Math.max(2, cw * .6), bh);
    });
    ctx.fillStyle = accent; ctx.fillRect(w - 3 * dpr, 0, 3 * dpr, h);
  }

  window.ArbitragePro = { open, close };
})();
