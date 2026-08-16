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
    trail: new Map(), timer: null, detailKey: null, detailRow: null,
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
    if (n < 0.0001 && n > 0) return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
    return n ? n.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "") : "0.00";
  }
  function pct(n, digits = 3) {
    const val = Number(n || 0);
    return `${val >= 0 ? "+" : ""}${val.toFixed(digits)}%`;
  }
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
    if (exWrap) {
      exWrap.innerHTML = Object.entries(EX).map(([code, [name]]) => `<button class="arb-exchange" data-ex="${code}"><img src="${icon(code)}" alt=""><span>${esc(name)}</span><i></i></button>`).join("");
      exWrap.addEventListener("click", e => {
        const btn = e.target.closest(".arb-exchange"); if (!btn) return;
        const code = btn.dataset.ex;
        state.selectedExchanges.has(code) ? state.selectedExchanges.delete(code) : state.selectedExchanges.add(code);
        btn.classList.toggle("off", !state.selectedExchanges.has(code));
        fetchData(true);
      });
    }

    document.querySelectorAll("[data-arb-mode]").forEach(btn => btn.addEventListener("click", () => setMode(btn.dataset.arbMode)));
    ["arb-search", "arb-min-net"].forEach(id => { const el = $(id); if (el) el.addEventListener("input", debounce(() => fetchData(true), 250)); });
    const minVol = $("arb-min-volume"); if (minVol) minVol.addEventListener("change", () => fetchData(true));
    const sortEl = $("arb-sort"); if (sortEl) sortEl.addEventListener("change", render);
    const bboEl = $("arb-bbo-only"); if (bboEl) bboEl.addEventListener("change", render);
    const favEl = $("arb-favorites-only"); if (favEl) favEl.addEventListener("change", render);
    const refreshBtn = $("arb-refresh"); if (refreshBtn) refreshBtn.addEventListener("click", () => fetchData(true));
    const allExBtn = $("arb-all-exchanges"); if (allExBtn) allExBtn.addEventListener("click", () => {
      state.selectedExchanges = new Set(Object.keys(EX));
      document.querySelectorAll(".arb-exchange").forEach(x => x.classList.remove("off"));
      fetchData(true);
    });
    const resetBtn = $("arb-reset"); if (resetBtn) resetBtn.addEventListener("click", reset);
    const spreadsBody = $("arb-spreads-body"); if (spreadsBody) spreadsBody.addEventListener("click", tableClick);
    const fundingBody = $("arb-funding-body"); if (fundingBody) fundingBody.addEventListener("click", tableClick);
    const closeBtn = $("arb-detail-close"); if (closeBtn) closeBtn.addEventListener("click", closeDetail);
    const backdrop = $("arb-drawer-backdrop"); if (backdrop) backdrop.addEventListener("click", closeDetail);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && state.detailKey) closeDetail(); });
  }

  function debounce(fn, wait) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); }; }

  function reset() {
    if ($("arb-search")) $("arb-search").value = "";
    if ($("arb-min-net")) $("arb-min-net").value = "0";
    if ($("arb-min-volume")) $("arb-min-volume").value = "0";
    if ($("arb-bbo-only")) $("arb-bbo-only").checked = false;
    if ($("arb-favorites-only")) $("arb-favorites-only").checked = false;
    if ($("arb-sort")) $("arb-sort").value = "score";
    state.selectedExchanges = new Set(Object.keys(EX));
    document.querySelectorAll(".arb-exchange").forEach(x => x.classList.remove("off"));
    fetchData(true);
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll("[data-arb-mode]").forEach(x => x.classList.toggle("on", x.dataset.arbMode === mode));
    if ($("arb-spreads-table")) $("arb-spreads-table").hidden = mode !== "spreads";
    if ($("arb-funding-table")) $("arb-funding-table").hidden = mode !== "funding";
    if ($("arb-result-title")) $("arb-result-title").textContent = mode === "spreads" ? "Все фьючерсные спреды" : "Дельта-нейтральный фандинг";
    if ($("arb-result-sub")) $("arb-result-sub").textContent = mode === "spreads" ? "Покупка ask → продажа bid → комиссии" : "Ставки приведены к часу для корректного сравнения";
    render();
  }

  async function fetchData(force) {
    if (!state.active || state.loading) return;
    state.loading = true;
    try {
      const q = new URLSearchParams({
        search: $("arb-search")?.value || "",
        minNet: $("arb-min-net")?.value || "0",
        minVolume: $("arb-min-volume")?.value || "0",
        exchanges: [...state.selectedExchanges].join(","),
        limit: "600"
      });
      if (force) q.set("_", Date.now());
      const res = await fetch(`/api/arbitrage/snapshot?${q}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      updateTrails(state.data.spreads, "net");
      updateTrails(state.data.funding, "daily");
      render();
    } catch (err) {
      console.warn("[Arbitrage]", err.message);
    } finally {
      state.loading = false;
    }
  }

  function updateTrails(rows, field) {
    const now = Date.now();
    (rows || []).forEach(row => {
      let points = state.trail.get(row.key);
      if (!points) {
        // Pre-seed from server history if available
        if (Array.isArray(row.history) && row.history.length > 0) {
          const step = 2000;
          points = row.history.map((val, idx) => [now - (row.history.length - idx) * step, Number(val) || 0]);
        } else {
          points = [];
        }
      }
      points.push([now, Number(row[field]) || 0]);
      if (points.length > 50) points.shift();
      state.trail.set(row.key, points);
    });
  }

  function render() {
    if (!state.data) return;
    const data = state.data;
    const positive = (data.spreads || []).filter(x => x.net > 0);
    if ($("arb-kpi-count")) $("arb-kpi-count").textContent = positive.length.toLocaleString("ru-RU");
    const best = positive[0];
    if ($("arb-kpi-net")) $("arb-kpi-net").textContent = best ? pct(best.net) : "—";
    if ($("arb-kpi-route")) $("arb-kpi-route").textContent = best ? `${best.base} · ${best.buyName} → ${best.sellName}` : "рынок эффективен";
    const bestFunding = (data.funding || [])[0];
    if ($("arb-kpi-funding")) $("arb-kpi-funding").textContent = bestFunding ? pct(bestFunding.daily) : "—";
    if ($("arb-spread-badge")) $("arb-spread-badge").textContent = data.totals?.spreads ?? data.spreads.length;
    if ($("arb-funding-badge")) $("arb-funding-badge").textContent = data.totals?.funding ?? data.funding.length;

    const rows = filteredRows();
    if (state.mode === "spreads") renderSpreads(rows); else renderFunding(rows);
    if ($("arb-empty")) $("arb-empty").hidden = rows.length > 0;
    if ($("arb-shown")) $("arb-shown").textContent = `Показано ${rows.length} из ${state.mode === "spreads" ? (data.totals?.spreads ?? data.spreads.length) : (data.totals?.funding ?? data.funding.length)}`;
  }

  function filteredRows() {
    let rows = [...(state.mode === "spreads" ? state.data.spreads : state.data.funding)];
    if ($("arb-bbo-only")?.checked) rows = rows.filter(x => x.quality === "bbo");
    if ($("arb-favorites-only")?.checked) rows = rows.filter(x => state.favorites.has(x.base));

    const sort = $("arb-sort")?.value || "score";
    if (sort === "freshness") {
      rows.sort((a, b) => a.ageMs - b.ageMs);
    } else if (sort === "net") {
      rows.sort((a, b) => (state.mode === "spreads" ? b.net - a.net : b.daily - a.daily));
    } else if (sort === "gross") {
      rows.sort((a, b) => (state.mode === "spreads" ? b.gross - a.gross : b.basis - a.basis));
    } else if (sort === "liquidity") {
      rows.sort((a, b) => b.liquidity - a.liquidity);
    } else {
      rows.sort((a, b) => b.score - a.score || b.net - a.net);
    }
    return rows.slice(0, 400);
  }

  function pairCell(r) {
    const isMemeOrStock = r.base.length > 6 || r.buyMultiplier > 1;
    const subLabel = r.buyMultiplier > 1 ? `x${r.buyMultiplier.toLocaleString()}` : "PERPETUAL";
    return `<div class="arb-pair"><span class="arb-coin">${esc(r.base.slice(0, 4))}</span><div><strong>${esc(r.base)}/USDT</strong><small>${esc(subLabel)}</small></div></div>`;
  }
  function legCell(ex, name, value, sub) {
    return `<div class="arb-leg"><img src="${icon(ex)}" alt=""><div><strong>${esc(name)}</strong><span>${esc(value)} · ${esc(sub)}</span></div></div>`;
  }
  function scoreCell(r) {
    const scoreVal = Math.max(0, Math.min(100, r.score || 0));
    return `<div class="arb-score"><span class="arb-score-ring" style="--score:${scoreVal}"><b>${Math.round(scoreVal)}</b></span><span class="arb-quality ${r.quality}">${r.quality}</span></div>`;
  }
  function sparkCell(r, field) {
    return `<canvas class="arb-spark" width="152" height="50" data-spark="${esc(r.key)}" data-field="${field}"></canvas>`;
  }

  function renderSpreads(rows) {
    const body = $("arb-spreads-body");
    if (!body) return;
    body.innerHTML = rows.map(r => `
      <tr data-key="${esc(r.key)}">
        <td><button class="arb-star ${state.favorites.has(r.base) ? "on" : ""}" data-fav="${esc(r.base)}">★</button></td>
        <td>${pairCell(r)}</td>
        <td>${legCell(r.buyEx, r.buyName, price(r.buyAsk), "ASK")}</td>
        <td>${legCell(r.sellEx, r.sellName, price(r.sellBid), "BID")}</td>
        <td class="arb-num">${pct(r.gross)}</td>
        <td class="arb-num arb-cost">−${Number(r.fees).toFixed(3)}%</td>
        <td class="arb-num arb-net">${pct(r.net)}</td>
        <td class="arb-num">${money(r.liquidity)}</td>
        <td>${sparkCell(r, "net")}</td>
        <td>${scoreCell(r)}</td>
      </tr>`).join("");
    requestAnimationFrame(drawSparks);
  }

  function renderFunding(rows) {
    const body = $("arb-funding-body");
    if (!body) return;
    body.innerHTML = rows.map(r => `
      <tr data-key="${esc(r.key)}">
        <td><button class="arb-star ${state.favorites.has(r.base) ? "on" : ""}" data-fav="${esc(r.base)}">★</button></td>
        <td>${pairCell(r)}</td>
        <td>${legCell(r.longEx, r.longName, pct(r.longFunding, 4), `${r.longInterval}ч`)}</td>
        <td>${legCell(r.shortEx, r.shortName, pct(r.shortFunding, 4), `${r.shortInterval}ч`)}</td>
        <td class="arb-num arb-net">${pct(r.daily)}</td>
        <td class="arb-num">${pct(r.monthly, 2)}</td>
        <td class="arb-num">${pct(r.apr, 1)}</td>
        <td class="arb-num ${Math.abs(r.basis) > 1 ? "arb-cost" : "arb-muted"}">${pct(r.basis)}</td>
        <td class="arb-countdown" data-until="${r.nextFunding || 0}">${countdown(r.nextFunding)}</td>
        <td>${scoreCell(r)}</td>
      </tr>`).join("");
  }

  function tableClick(e) {
    const fav = e.target.closest("[data-fav]");
    if (fav) {
      e.stopPropagation();
      const base = fav.dataset.fav;
      state.favorites.has(base) ? state.favorites.delete(base) : state.favorites.add(base);
      localStorage.setItem("arbFavorites", JSON.stringify([...state.favorites]));
      render();
      return;
    }
    const row = e.target.closest("tr[data-key]");
    if (row) openDetail(row.dataset.key);
  }

  function drawSparks() {
    document.querySelectorAll("canvas[data-spark]").forEach(canvas => {
      const key = canvas.dataset.spark;
      const pts = state.trail.get(key) || [];
      const values = pts.map(x => x[1]);
      drawLine(canvas, values, false);
    });
  }

  function drawLine(canvas, values, large) {
    const ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!values || values.length === 0) return;

    if (values.length === 1) {
      ctx.strokeStyle = "#a78bfa"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(4, h / 2); ctx.lineTo(w - 4, h / 2); ctx.stroke();
      return;
    }

    const min = Math.min(...values), max = Math.max(...values), range = (max - min) || 0.02, pad = large ? 18 : 6;
    const pts = values.map((v, i) => [pad + i * (w - pad * 2) / (values.length - 1), h - pad - (v - min) * (h - pad * 2) / range]);
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#7550df");
    grad.addColorStop(1, "#2bd987");

    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(...p) : ctx.moveTo(...p));
    ctx.strokeStyle = grad; ctx.lineWidth = large ? 3 : 2; ctx.stroke();

    if (large) {
      ctx.lineTo(pts.at(-1)[0], h - pad); ctx.lineTo(pts[0][0], h - pad); ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, h);
      fill.addColorStop(0, "rgba(124,92,246,.25)");
      fill.addColorStop(1, "rgba(43,217,135,0)");
      ctx.fillStyle = fill; ctx.fill();
    }
  }

  async function openDetail(key) {
    if (!state.data) return;
    const all = [...(state.data.spreads || []), ...(state.data.funding || [])];
    const r = all.find(x => x.key === key);
    if (!r) return;
    state.detailKey = key;
    const isFunding = key.startsWith("funding:");

    if ($("arb-detail-kind")) $("arb-detail-kind").textContent = isFunding ? "FUNDING ARBITRAGE" : "FUTURES SPREAD";
    if ($("arb-detail-title")) $("arb-detail-title").textContent = `${r.base}/USDT`;
    if ($("arb-detail-score")) $("arb-detail-score").textContent = Math.round(r.score);
    if ($("arb-detail-summary")) {
      $("arb-detail-summary").textContent = isFunding
        ? `LONG ${r.longName} и SHORT ${r.shortName}: оценка ${pct(r.daily)} в сутки при текущих ставках.`
        : `Купить на ${r.buyName} и продать на ${r.sellName}: чистый спред ${pct(r.net)} после комиссий.`;
    }
    if ($("arb-detail-legs")) {
      $("arb-detail-legs").innerHTML = isFunding
        ? detailLeg("LONG", r.longName, pct(r.longFunding, 4), "long") + detailLeg("SHORT", r.shortName, pct(r.shortFunding, 4), "short")
        : detailLeg("КУПИТЬ LONG", r.buyName, price(r.buyAsk), "long") + detailLeg("ПРОДАТЬ SHORT", r.sellName, price(r.sellBid), "short");
    }
    if ($("arb-detail-breakdown")) {
      $("arb-detail-breakdown").innerHTML = isFunding
        ? breakdown([["Ставка в сутки", pct(r.daily)], ["Оценка за 30 дней", pct(r.monthly, 2)], ["APR без реинвестирования", pct(r.apr, 1)], ["Ценовой базис", pct(r.basis)], ["Ликвидность 24ч", money(r.liquidity)]])
        : breakdown([["Валовый спред", pct(r.gross)], ["Taker-комиссии", `−${r.fees.toFixed(3)}%`], ["Чистый спред", pct(r.net)], ["Ликвидность 24ч", money(r.liquidity)], ["Качество котировки", r.quality.toUpperCase()]]);
    }
    const urls = isFunding
      ? [[r.longUrl, `Открыть LONG · ${r.longName}`], [r.shortUrl, `Открыть SHORT · ${r.shortName}`]]
      : [[r.buyUrl, `Купить · ${r.buyName}`], [r.sellUrl, `Продать · ${r.sellName}`]];
    if ($("arb-detail-actions")) {
      $("arb-detail-actions").innerHTML = urls.map(([url, label]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`).join("");
    }
    if ($("arb-drawer-backdrop")) $("arb-drawer-backdrop").hidden = false;
    if ($("arb-drawer")) {
      $("arb-drawer").classList.add("open");
      $("arb-drawer").setAttribute("aria-hidden", "false");
    }

    if (window.ArbitragePro) window.ArbitragePro.open(r, isFunding);
  }

  function detailLeg(label, name, value, kind) {
    return `<article class="arb-detail-leg ${kind}"><span>${esc(label)}</span><strong>${esc(name)}</strong><b>${esc(value)}</b></article>`;
  }
  function breakdown(rows) {
    return rows.map(([a, b]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join("");
  }
  function closeDetail() {
    state.detailKey = null;
    if (window.ArbitragePro) window.ArbitragePro.close();
    if ($("arb-drawer")) {
      $("arb-drawer").classList.remove("open");
      $("arb-drawer").setAttribute("aria-hidden", "true");
    }
    setTimeout(() => { if ($("arb-drawer-backdrop")) $("arb-drawer-backdrop").hidden = true; }, 250);
  }

  function activate() {
    init();
    state.active = true;
    fetchData(true);
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (document.visibilityState === "visible" && $("arbitrage-view")?.style.display !== "none") {
        fetchData(false);
      }
    }, 2000);
  }

  window.CryptoArbitrage = { activate, refresh: () => fetchData(true) };
})();
