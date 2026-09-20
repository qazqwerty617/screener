"use strict";

(() => {
  const VENUES = [
    ["BN", "Binance"], ["BB", "Bybit"], ["OX", "OKX"], ["BG", "Bitget"],
    ["GT", "Gate.io"], ["MX", "MEXC"], ["KC", "KuCoin"], ["BX", "BingX"],
    ["HT", "HTX"], ["HL", "Hyperliquid"], ["AD", "Aster"]
  ];
  const byId = id => document.getElementById(id);
  const VENUE_ICONS = { BN: "BN", BB: "BB", OX: "OK", BG: "BG", GT: "GT", MX: "MX",
    KC: "KC", BX: "BX", HT: "HX", HL: "HL", AD: "AS" };
  const MARKET_OPTIONS = [["all", "Спот и фьючерсы", "◈"], ["spot", "Спот", "●"], ["futures", "Фьючерсы", "◆"]];
  let data = null;
  let selectedTab = "news";
  let selectedExchange = "all";
  let selectedMarket = "all";
  let lastRequest = 0;
  let inFlight = null;
  let refreshPending = false;
  let wired = false;
  let refreshTimer = null;
  let stream = null;
  const dateTime = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString("ru-RU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  }) : "Время неизвестно";

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }

  function clearWithEmpty(target, message) {
    target.replaceChildren(node("div", "events-empty", message));
  }

  function closePickers() {
    document.querySelectorAll(".events-picker.open").forEach(picker => {
      picker.classList.remove("open");
      picker.querySelector(".events-picker-btn").setAttribute("aria-expanded", "false");
    });
  }

  function wirePicker(kind, options) {
    const picker = document.querySelector(`.events-picker[data-picker="${kind}"]`);
    const button = picker.querySelector(".events-picker-btn");
    const menu = picker.querySelector(".events-picker-menu");
    const select = value => {
      if (kind === "exchange") selectedExchange = value;
      else selectedMarket = value;
      const chosen = options.find(option => option[0] === value);
      const icon = kind === "exchange" ? node("img", "") : node("span", "events-market-icon", chosen[2]);
      if (kind === "exchange") { icon.src = `/img/${chosen[2]}.svg`; icon.alt = ""; }
      button.replaceChildren(icon, node("span", "", chosen[1]), node("span", "events-picker-arrow", "⌄"));
      menu.querySelectorAll("button").forEach(item => {
        const active = item.dataset.value === value;
        item.classList.toggle("on", active);
        item.setAttribute("aria-selected", String(active));
      });
      closePickers(); renderListings();
    };
    for (const [value, label, glyph] of options) {
      const item = node("button", "events-picker-option");
      item.type = "button"; item.dataset.value = value; item.setAttribute("role", "option");
      const icon = kind === "exchange" ? node("img", "") : node("span", "events-market-icon", glyph);
      if (kind === "exchange") { icon.src = `/img/${glyph}.svg`; icon.alt = ""; }
      item.append(icon, node("span", "", label));
      item.addEventListener("click", () => select(value));
      menu.append(item);
    }
    menu.querySelector(`[data-value="all"]`).classList.add("on");
    menu.querySelector(`[data-value="all"]`).setAttribute("aria-selected", "true");
    button.addEventListener("click", () => {
      const open = !picker.classList.contains("open"); closePickers();
      picker.classList.toggle("open", open);
      button.setAttribute("aria-expanded", String(open));
    });
    button.addEventListener("keydown", event => {
      if (event.key === "Escape") closePickers();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!picker.classList.contains("open")) button.click();
        menu.querySelector("button.on")?.focus();
      }
    });
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") { closePickers(); button.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...menu.querySelectorAll("button")];
        items[(items.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    });
  }

  function cardTop(card, label, time, tone = "") {
    const top = node("div", "events-card-top");
    top.append(node("span", `events-pill ${tone}`, label), node("time", "", dateTime(time)));
    card.append(top);
  }

  function renderNews() {
    const urgentBox = byId("events-urgent-list");
    const newsBox = byId("events-news-list");
    if (!urgentBox || !newsBox) return;
    urgentBox.replaceChildren(); newsBox.replaceChildren();
    const rows = Array.isArray(data?.news) ? data.news : [];
    const urgent = rows.filter(item => item.priority === "urgent").slice(0, 3);
    const rest = rows.filter(item => !urgent.includes(item)).slice(0, 40);
    function appendItem(container, item) {
      let url;
      try { url = new URL(item.url); } catch (_) { return; }
      if (url.protocol !== "https:") return;
      const link = node("a", `events-card ${item.priority === "urgent" ? "urgent" : ""}`);
      link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      cardTop(link, item.priority === "urgent" ? "⚡ Срочно" : item.priority === "important" ? "● Важно" : "Новость",
        item.publishedAt, item.priority === "urgent" ? "red" : "");
      link.append(node("h3", "", item.titleRu || item.title));
      if (item.titleRu) link.append(node("p", "events-original", item.title));
      link.append(node("small", "", item.source + (item.titleRu ? " · перевод · " : /[а-яё]/i.test(item.title) ? " · оригинал · " : " · оригинал EN · ") + "открыть источник ↗"));
      container.append(link);
    }
    urgent.forEach(item => appendItem(urgentBox, item));
    rest.forEach(item => appendItem(newsBox, item));
    if (!urgentBox.children.length) clearWithEmpty(urgentBox, "Срочных публикаций в свежей ленте нет.");
    if (!newsBox.children.length) clearWithEmpty(newsBox, "Новости загружаются. Обновление происходит автоматически.");
  }

  function renderListings() {
    const upcomingBox = byId("events-upcoming");
    const pastBox = byId("events-past");
    if (!upcomingBox || !pastBox) return;
    upcomingBox.replaceChildren(); pastBox.replaceChildren();
    const exchange = selectedExchange;
    const market = selectedMarket;
    const now = Date.now();
    const rows = (Array.isArray(data?.listings) ? data.listings : [])
      .filter(item => (exchange === "all" || item.exchange === exchange) && (market === "all" || item.type === market));
    const upcoming = rows.filter(item => Number(item.launchAt) > now).sort((a, b) => a.launchAt - b.launchAt).slice(0, 40);
    const past = rows.filter(item => !(Number(item.launchAt) > now))
      .sort((a, b) => (b.launchAt || b.detectedAt) - (a.launchAt || a.detectedAt)).slice(0, 80);
    function appendItem(container, item, future) {
      const card = node("article", `events-card ${future ? "scheduled" : ""}`);
      const venue = VENUES.find(([code]) => code === item.exchange)?.[1] || item.exchange;
      cardTop(card, `${venue} · ${item.type === "spot" ? "Спот" : "Фьючерсы"}`,
        item.launchAt || item.detectedAt, future ? "green" : "");
      card.append(node("h3", "", item.symbol), node("small", "",
        item.launchAt ? "Время из каталога биржи; пара подтверждена двумя сканированиями" : "Новая пара подтверждена двумя сканированиями; время запуска не опубликовано"));
      container.append(card);
    }
    upcoming.forEach(item => appendItem(upcomingBox, item, true));
    past.forEach(item => appendItem(pastBox, item, false));
    if (!upcomingBox.children.length) clearWithEmpty(upcomingBox, "Подтверждённых предстоящих USDT листингов пока нет.");
    if (!pastBox.children.length) clearWithEmpty(pastBox, "Новых USDT пар пока не обнаружено. Существующие рынки не выдаются за листинги.");
    const ready = Object.values(data?.venues || {}).filter(item => item?.status === "ok").length;
    const coverage = byId("events-coverage");
    if (coverage) {
      const selected = exchange === "all" ? Object.values(data?.venues || {}) : [data?.venues?.[exchange]];
      const spot = selected.reduce((sum, venue) => sum + (venue?.status === "ok" ? Number(venue.spot) || 0 : 0), 0);
      const futures = selected.reduce((sum, venue) => sum + (venue?.status === "ok" ? Number(venue.futures) || 0 : 0), 0);
      coverage.textContent = `Каталоги: ${ready}/11 · USDT спот: ${spot} · фьючерсы: ${futures}`;
    }
  }

  function render() {
    const updated = byId("events-updated");
    if (updated) updated.textContent = data?.marketUpdatedAt || data?.newsUpdatedAt
      ? `Новости ${dateTime(data.newsUpdatedAt)} · рынки ${dateTime(data.marketUpdatedAt)}`
      : "Получаем данные бирж и новостей…";
    renderNews(); renderListings();
  }

  function setTab(tab) {
    selectedTab = tab;
    byId("events-news-panel").hidden = tab !== "news";
    byId("events-listings-panel").hidden = tab !== "listings";
    for (const key of ["news", "listings"]) {
      const button = byId(`events-tab-${key}`);
      button.classList.toggle("on", key === tab);
      button.setAttribute("aria-selected", String(key === tab));
    }
  }

  async function refresh() {
    if (inFlight) { refreshPending = true; return inFlight; }
    inFlight = (async () => {
      try {
        const response = await fetch("/api/events", { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
        lastRequest = Date.now();
        render();
      } catch (_) {
        const updated = byId("events-updated");
        if (updated) updated.textContent = "Нет связи · показываем последние данные";
      } finally {
        inFlight = null;
        if (refreshPending) { refreshPending = false; void refresh(); }
      }
    })();
    return inFlight;
  }

  function activate() {
    if (!wired) {
      wired = true;
      wirePicker("exchange", [["all", "Все 11 бирж", "ALL"], ...VENUES.map(([code, name]) => [code, name, VENUE_ICONS[code]])]);
      wirePicker("market", MARKET_OPTIONS);
      document.addEventListener("click", event => { if (!event.target.closest(".events-picker")) closePickers(); });
      byId("events-tab-news").addEventListener("click", () => setTab("news"));
      byId("events-tab-listings").addEventListener("click", () => setTab("listings"));
      setTab(selectedTab);
      refreshTimer = window.setInterval(() => {
        if (byId("events-view")?.style.display === "block") void refresh();
      }, 30000);
    }
    if (!stream && typeof window.EventSource === "function") {
      stream = new window.EventSource("/api/events/stream");
      stream.addEventListener("update", () => { void refresh(); });
    }
    if (!data || Date.now() - lastRequest > 60000) void refresh();
    else render();
  }

  function deactivate() { stream?.close(); stream = null; }
  window.ObsidianEvents = { activate, deactivate };
})();
