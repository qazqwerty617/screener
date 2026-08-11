"use strict";

(function () {
  const EX = {
    BN: ["Binance", "BN.svg"], BB: ["Bybit", "BB.svg"], OX: ["OKX", "OK.svg"],
    BG: ["Bitget", "BG.svg"], GT: ["Gate.io", "GT.svg"], MX: ["MEXC", "MX.svg"],
    KC: ["KuCoin", "KC.svg"], BX: ["BingX", "BX.svg"], HT: ["HTX", "HX.svg"],
    HL: ["Hyperliquid", "HL.svg"], AD: ["Asterdex", "AS.svg"],
  };
  const $ = id => document.getElementById(id);
  const state = {
    active: false, initialized: false, loading: false, mode: "spreads", data: null,
    selectedExchanges: new Set(Object.keys(EX)), favorites: new Set(JSON.parse(localStorage.getItem("arbFavorites") || "[]")),
    trail: new Map(), timer: null, detailKey: null, detailRow: null, detailTf: "5m",
    detailKlines: null, depth: null, depthLoading: false, spreadMode: "best",
  };

  function esc(value) {
    return String(value ?? "").replace(/[&<>'"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch]);
  }
  function icon(ex) { return `/img/${EX[ex]?.[1] || "logo.svg"}`; }
  function money(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  }
  function price(n) {
    n = Number(n) || 0;
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return n.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "");
  }
  function pct(n, digits = 3) { return `${Number(n) >= 0 ? "+" : ""}${Number(n || 0).toFixed(digits)}%`; }
  function countdown(ts) {
    const ms = Math.max(0, Number(ts || 0) - Date.now());
    if (!ms) return "—";
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return `${h}ч ${String(m).padStart(2, "0")}м`;
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    const exWrap = $("arb-exchanges");
    exWrap.innerHTML = Object.entries(EX).map(([code, [name]]) => `<button class="arb-exchange" data-ex="${code}"><img src="${icon(code)}" alt=""><span>${esc(name)}</span><i></i></button>`).join("");
    exWrap.addEventListener("click", e => {
      const btn = e.target.closest(".arb-exchange"); if (!btn) return;
      const code = btn.dataset.ex;
      state.selectedExchanges.has(code) ? state.selectedExchanges.delete(code) : state.selectedExchanges.add(code);
      btn.classList.toggle("off", !state.selectedExchanges.has(code)); fetchData(true);
    });
    document.querySelectorAll("[data-arb-mode]").forEach(btn => btn.addEventListener("click", () => setMode(btn.dataset.arbMode)));
    ["arb-search", "arb-min-net"].forEach(id => $(id).addEventListener("input", debounce(() => fetchData(true), 250)));
    $("arb-min-volume").addEventListener("change", () => fetchData(true));
    $("arb-sort").addEventListener("change", render);
    $("arb-bbo-only").addEventListener("change", render);
    $("arb-favorites-only").addEventListener("change", render);
    $("arb-refresh").addEventListener("click", () => fetchData(true));
    $("arb-all-exchanges").addEventListener("click", () => { state.selectedExchanges = new Set(Object.keys(EX)); document.querySelectorAll(".arb-exchange").forEach(x => x.classList.remove("off")); fetchData(true); });
    $("arb-reset").addEventListener("click", reset);
    $("arb-spreads-body").addEventListener("click", tableClick);
    $("arb-funding-body").addEventListener("click", tableClick);
    $("arb-detail-close").addEventListener("click", closeDetail);
    $("arb-drawer-backdrop").addEventListener("click", closeDetail);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.detailKey) closeDetail(); });
  }

  function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }
  function reset() {
    $("arb-search").value = ""; $("arb-min-net").value = "0"; $("arb-min-volume").value = "100000";
    $("arb-bbo-only").checked = false; $("arb-favorites-only").checked = false; $("arb-sort").value = "net";
    state.selectedExchanges = new Set(Object.keys(EX)); document.querySelectorAll(".arb-exchange").forEach(x => x.classList.remove("off")); fetchData(true);
  }
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll("[data-arb-mode]").forEach(x => x.classList.toggle("on", x.dataset.arbMode === mode));
    $("arb-spreads-table").hidden = mode !== "spreads"; $("arb-funding-table").hidden = mode !== "funding";
    $("arb-result-title").textContent = mode === "spreads" ? "Все фьючерсные спреды" : "Дельта-нейтральный фандинг";
    $("arb-result-sub").textContent = mode === "spreads" ? "Покупка ask → продажа bid → комиссии" : "Ставки приведены к часу для корректного сравнения";
    render();
  }

  async function fetchData(force) {
    if (!state.active || state.loading) return;
    state.loading = true; $("arb-update-text").textContent = "Синхронизация…";
    try {
      const q = new URLSearchParams({ search: $("arb-search").value, minNet: $("arb-min-net").value, minVolume: $("arb-min-volume").value, exchanges: [...state.selectedExchanges].join(","), limit: "500" });
      if (force) q.set("_", Date.now());
      const res = await fetch(`/api/arbitrage/snapshot?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      updateTrails(state.data.spreads, "net"); updateTrails(state.data.funding, "daily");
      render();
      $("arb-update-text").textContent = "Потоки синхронизированы";
    } catch (err) {
      $("arb-update-text").textContent = "Ошибка потока · повторяем";
      console.warn("[Arbitrage]", err.message);
    } finally { state.loading = false; }
  }
  function updateTrails(rows, field) {
    const now = Date.now();
    (rows || []).forEach(row => {
      const points = state.trail.get(row.key) || [];
      points.push([now, Number(row[field]) || 0]);
      if (points.length > 40) points.shift();
      state.trail.set(row.key, points);
    });
  }

  function render() {
    if (!state.data) return;
    const data = state.data, online = Object.values(data.exchanges || {}).filter(x => x.status === "online").length;
    $("arb-online").textContent = `${online} / ${data.exchangeCount || 11}`; $("arb-markets").textContent = Number(data.marketCount || 0).toLocaleString("ru-RU");
    $("arb-latency").textContent = `${Math.max(0, Date.now() - data.generatedAt)} мс`;
    const positive = (data.spreads || []).filter(x => x.net > 0);
    $("arb-kpi-count").textContent = positive.length.toLocaleString("ru-RU");
    const best = positive[0]; $("arb-kpi-net").textContent = best ? pct(best.net) : "—"; $("arb-kpi-route").textContent = best ? `${best.base} · ${best.buyName} → ${best.sellName}` : "рынок эффективен";
    const bestFunding = (data.funding || [])[0]; $("arb-kpi-funding").textContent = bestFunding ? pct(bestFunding.daily) : "—";
    $("arb-spread-badge").textContent = data.totals?.spreads ?? data.spreads.length; $("arb-funding-badge").textContent = data.totals?.funding ?? data.funding.length;
    const rows = filteredRows();
    if (state.mode === "spreads") renderSpreads(rows); else renderFunding(rows);
    $("arb-empty").hidden = rows.length > 0; $("arb-shown").textContent = `Показано ${rows.length} из ${state.mode === "spreads" ? data.totals?.spreads : data.totals?.funding}`;
  }
  function filteredRows() {
    let rows = [...(state.mode === "spreads" ? state.data.spreads : state.data.funding)];
    if ($("arb-bbo-only").checked) rows = rows.filter(x => x.quality === "bbo");
    if ($("arb-favorites-only").checked) rows = rows.filter(x => state.favorites.has(x.base));
    const sort = $("arb-sort").value;
    rows.sort((a, b) => sort === "freshness" ? a.ageMs - b.ageMs : (b[sort] || (sort === "net" ? b.daily : 0)) - (a[sort] || (sort === "net" ? a.daily : 0)));
    return rows.slice(0, 300);
  }
  function pairCell(r) { return `<div class="arb-pair"><span class="arb-coin">${esc(r.base.slice(0, 4))}</span><div><strong>${esc(r.base)}/USDT</strong><small>PERPETUAL</small></div></div>`; }
  function legCell(ex, name, value, sub) { return `<div class="arb-leg"><img src="${icon(ex)}" alt=""><div><strong>${esc(name)}</strong><span>${esc(value)} · ${esc(sub)}</span></div></div>`; }
  function scoreCell(r) { return `<div class="arb-score"><span class="arb-score-ring" style="--score:${Math.max(0, Math.min(100, r.score))}"><b>${Math.round(r.score)}</b></span><span class="arb-quality ${r.quality}">${r.quality}</span></div>`; }
  function sparkCell(r, field) { return `<canvas class="arb-spark" width="152" height="50" data-spark="${esc(r.key)}" data-field="${field}"></canvas>`; }
  function renderSpreads(rows) {
    $("arb-spreads-body").innerHTML = rows.map(r => `<tr data-key="${esc(r.key)}"><td><button class="arb-star ${state.favorites.has(r.base) ? "on" : ""}" data-fav="${esc(r.base)}">★</button></td><td>${pairCell(r)}</td><td>${legCell(r.buyEx,r.buyName,price(r.buyAsk),"ASK")}</td><td>${legCell(r.sellEx,r.sellName,price(r.sellBid),"BID")}</td><td class="arb-num">${pct(r.gross)}</td><td class="arb-num arb-cost">−${Number(r.fees).toFixed(3)}%</td><td class="arb-num arb-net">${pct(r.net)}</td><td class="arb-num">${money(r.liquidity)}</td><td>${sparkCell(r,"net")}</td><td>${scoreCell(r)}</td></tr>`).join("");
    requestAnimationFrame(drawSparks);
  }
  function renderFunding(rows) {
    $("arb-funding-body").innerHTML = rows.map(r => `<tr data-key="${esc(r.key)}"><td><button class="arb-star ${state.favorites.has(r.base) ? "on" : ""}" data-fav="${esc(r.base)}">★</button></td><td>${pairCell(r)}</td><td>${legCell(r.longEx,r.longName,pct(r.longFunding,4),`${r.longInterval}ч`)}</td><td>${legCell(r.shortEx,r.shortName,pct(r.shortFunding,4),`${r.shortInterval}ч`)}</td><td class="arb-num arb-net">${pct(r.daily)}</td><td class="arb-num">${pct(r.monthly,2)}</td><td class="arb-num">${pct(r.apr,1)}</td><td class="arb-num ${Math.abs(r.basis)>1?"arb-cost":"arb-muted"}">${pct(r.basis)}</td><td class="arb-countdown" data-until="${r.nextFunding || 0}">${countdown(r.nextFunding)}</td><td>${scoreCell(r)}</td></tr>`).join("");
  }
  function tableClick(e) {
    const fav = e.target.closest("[data-fav]");
    if (fav) { e.stopPropagation(); const base = fav.dataset.fav; state.favorites.has(base) ? state.favorites.delete(base) : state.favorites.add(base); localStorage.setItem("arbFavorites", JSON.stringify([...state.favorites])); render(); return; }
    const row = e.target.closest("tr[data-key]"); if (row) openDetail(row.dataset.key);
  }

  function drawSparks() {
    document.querySelectorAll("canvas[data-spark]").forEach(canvas => drawLine(canvas, (state.trail.get(canvas.dataset.spark) || []).map(x => x[1]), false));
  }
  function drawLine(canvas, values, large) {
    const ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height; ctx.clearRect(0,0,w,h);
    if (values.length < 2) return;
    const min = Math.min(...values), max = Math.max(...values), range = max-min || .01, pad = large ? 18 : 5;
    const pts = values.map((v,i) => [pad + i*(w-pad*2)/(values.length-1), h-pad-(v-min)*(h-pad*2)/range]);
    const grad = ctx.createLinearGradient(0,0,w,0); grad.addColorStop(0,"#7550df"); grad.addColorStop(1,"#2bd987");
    ctx.beginPath(); pts.forEach((p,i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p)); ctx.strokeStyle=grad; ctx.lineWidth=large?3:2; ctx.stroke();
    if (large) { ctx.lineTo(pts.at(-1)[0],h-pad); ctx.lineTo(pts[0][0],h-pad); ctx.closePath(); const fill=ctx.createLinearGradient(0,0,0,h); fill.addColorStop(0,"rgba(124,92,246,.22)"); fill.addColorStop(1,"rgba(43,217,135,0)"); ctx.fillStyle=fill; ctx.fill(); }
  }

  async function openDetail(key) {
    const all = [...(state.data.spreads || []), ...(state.data.funding || [])], r = all.find(x => x.key === key); if (!r) return;
    state.detailKey = key; const isFunding = key.startsWith("funding:");
    $("arb-detail-kind").textContent = isFunding ? "FUNDING ARBITRAGE" : "FUTURES SPREAD"; $("arb-detail-title").textContent = `${r.base}/USDT`;
    $("arb-detail-score").textContent = Math.round(r.score);
    $("arb-detail-summary").textContent = isFunding ? `LONG ${r.longName} и SHORT ${r.shortName}: оценка ${pct(r.daily)} в сутки при текущих ставках.` : `Купить на ${r.buyName} и продать на ${r.sellName}: чистый спред ${pct(r.net)} после комиссий.`;
    $("arb-detail-legs").innerHTML = isFunding ? detailLeg("LONG",r.longName,pct(r.longFunding,4),"long")+detailLeg("SHORT",r.shortName,pct(r.shortFunding,4),"short") : detailLeg("КУПИТЬ LONG",r.buyName,price(r.buyAsk),"long")+detailLeg("ПРОДАТЬ SHORT",r.sellName,price(r.sellBid),"short");
    $("arb-detail-breakdown").innerHTML = isFunding ? breakdown([["Ставка в сутки",pct(r.daily)],["Оценка за 30 дней",pct(r.monthly,2)],["APR без реинвестирования",pct(r.apr,1)],["Ценовой базис",pct(r.basis)],["Ликвидность 24ч",money(r.liquidity)]]) : breakdown([["Валовый спред",pct(r.gross)],["Taker-комиссии",`−${r.fees.toFixed(3)}%`],["Чистый спред",pct(r.net)],["Ликвидность 24ч",money(r.liquidity)],["Качество котировки",r.quality.toUpperCase()]]);
    const urls = isFunding ? [[r.longUrl,`Открыть LONG · ${r.longName}`],[r.shortUrl,`Открыть SHORT · ${r.shortName}`]] : [[r.buyUrl,`Купить · ${r.buyName}`],[r.sellUrl,`Продать · ${r.sellName}`]];
    $("arb-detail-actions").innerHTML = urls.map(([url,label]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`).join("");
    $("arb-drawer-backdrop").hidden=false; $("arb-drawer").classList.add("open"); $("arb-drawer").setAttribute("aria-hidden","false");
    if (window.ArbitragePro) window.ArbitragePro.open(r, isFunding);
    if (!window.ArbitragePro) try { const res=await fetch(`/api/arbitrage/history?key=${encodeURIComponent(key)}`,{cache:"no-store"}); const data=await res.json(); const values=(data.points||[]).map(x=>x[1]); $("arb-chart-empty").hidden=values.length>=2; const c=$("arb-detail-canvas"), dpr=Math.min(2,devicePixelRatio||1); c.width=Math.max(400,c.clientWidth*dpr); c.height=170*dpr; drawLine(c,values,true); } catch (_) {}
  }
  function detailLeg(label,name,value,kind){return `<article class="arb-detail-leg ${kind}"><span>${esc(label)}</span><strong>${esc(name)}</strong><b>${esc(value)}</b></article>`;}
  function breakdown(rows){return rows.map(([a,b])=>`<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join("");}
  function closeDetail(){state.detailKey=null;if(window.ArbitragePro)window.ArbitragePro.close();$("arb-drawer").classList.remove("open");$("arb-drawer").setAttribute("aria-hidden","true");setTimeout(()=>$("arb-drawer-backdrop").hidden=true,250);}

  function activate() {
    init(); state.active = true; fetchData(true);
    clearInterval(state.timer); state.timer = setInterval(() => { if (document.visibilityState === "visible" && $("arbitrage-view")?.style.display !== "none") fetchData(false); }, 2000);
  }
  window.CryptoArbitrage = { activate, refresh: () => fetchData(true) };
})();
