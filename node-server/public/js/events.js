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
  let selectedKind = "all";
  let selectedPhase = "all";
  let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let selectedDay;
  let lastRequest = 0;
  let inFlight = null;
  let refreshPending = false;
  let wired = false;
  let refreshTimer = null;
  let stream = null;
  const seenKey = "obsidian-urgent-news-seen-v1";
  const visibleAlerts = new Map();
  let seenAlerts = [];
  try { seenAlerts = JSON.parse(window.sessionStorage.getItem(seenKey)) || []; } catch (_) {}
  if (!Array.isArray(seenAlerts)) seenAlerts = [];
  const dateTime = value => Number.isFinite(Number(value)) ? new Date(Number(value)).toLocaleString("ru-RU", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  }) : "Время неизвестно";
  const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  selectedDay = dayKey(new Date());

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }

  function clearWithEmpty(target, message) {
    target.replaceChildren(node("div", "events-empty", message));
  }

  function urgentText(item) {
    const russianTitle = item.titleRu || (/[а-яё]/i.test(item.title || "") ? item.title : "");
    if (russianTitle) return russianTitle.length > 150 ? `${russianTitle.slice(0, 147)}…` : russianTitle;
    return { security: "Сообщают о возможном взломе. Подробности в источнике.",
      risk: "Сообщают о серьёзном сбое или риске. Подробности в источнике.",
      macro: "Важное заявление, которое может повлиять на рынок. Подробности в источнике." }[item.alertKind];
  }

  function alertItem(raw) {
    try {
      const item = JSON.parse(raw);
      const url = new URL(item.url);
      if (url.protocol !== "https:" || !["security", "risk", "macro"].includes(item.alertKind)) return null;
      const age = Date.now() - Number(item.publishedAt);
      if (!Number.isFinite(age) || age < -60000 || age > 15 * 60000) return null;
      return item;
    } catch (_) { return null; }
  }

  function showUrgentAlert(event) {
    const item = alertItem(event.data);
    if (!item || seenAlerts.includes(item.url)) return;
    const container = byId("toast-container");
    if (!container) return;
    seenAlerts.push(item.url);
    seenAlerts = seenAlerts.slice(-100);
    try { window.sessionStorage.setItem(seenKey, JSON.stringify(seenAlerts)); } catch (_) {}
    const card = node("div", `toast-card toast-urgent-news toast-urgent-${item.alertKind}`);
    card.setAttribute("role", "alert");
    const header = node("div", "toast-header");
    const label = { security: "Возможный взлом", risk: "Срочное событие", macro: "Важное заявление" }[item.alertKind];
    const close = node("button", "toast-close", "×");
    close.type = "button"; close.setAttribute("aria-label", "Закрыть уведомление");
    header.append(node("span", "", `✦ ${label}`), close);
    const body = node("div", "toast-body", urgentText(item));
    const footer = node("div", "toast-urgent-footer");
    const source = node("span", "", String(item.source || "Источник").slice(0, 50));
    const link = node("a", "", "Открыть источник ↗");
    link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
    footer.append(source, link); card.append(header, body, footer);
    const remove = () => { visibleAlerts.delete(item.url); card.remove(); };
    close.addEventListener("click", remove);
    container.append(card);
    visibleAlerts.set(item.url, body);
    while (container.querySelectorAll(".toast-urgent-news").length > 2) {
      const oldest = container.querySelector(".toast-urgent-news");
      for (const [url, element] of visibleAlerts) if (element.parentElement === oldest) visibleAlerts.delete(url);
      oldest.remove();
    }
    window.setTimeout(remove, 18000);
  }

  function updateUrgentAlert(event) {
    const item = alertItem(event.data);
    const body = item && visibleAlerts.get(item.url);
    if (body && item.titleRu) body.textContent = urgentText(item);
  }

  function initAlerts() {
    if (stream || typeof window.EventSource !== "function") return;
    stream = new window.EventSource("/api/events/stream");
    stream.addEventListener("urgent", showUrgentAlert);
    stream.addEventListener("translation", updateUrgentAlert);
    stream.addEventListener("update", () => { if (byId("events-view")?.style.display === "block") void refresh(); });
    stream.addEventListener("open", () => { if (byId("events-view")?.style.display === "block") void refresh(); });
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
    const calendar = byId("events-calendar");
    const dayList = byId("events-day-list");
    if (!calendar || !dayList) return;
    const exchange = selectedExchange;
    const market = selectedMarket;
    const now = Date.now();
    const query = byId("events-search")?.value.trim().toLowerCase() || "";
    const rows = (Array.isArray(data?.listings) ? data.listings : [])
      .filter(item => {
        const time = Number(item.kind === "delisting" ? item.detectedAt : item.launchAt || item.detectedAt);
        return Number.isFinite(time) && time > 0 &&
          (exchange === "all" || item.exchange === exchange) && (market === "all" || item.type === market) &&
          (selectedKind === "all" || (item.kind || "listing") === selectedKind) &&
          (selectedPhase === "all" || (selectedPhase === "upcoming" ? time > now : time <= now)) &&
          (!query || String(item.symbol || "").toLowerCase().includes(query));
      });
    const byDay = new Map();
    for (const item of rows) {
      const time = item.kind === "delisting" ? item.detectedAt : item.launchAt || item.detectedAt;
      const key = dayKey(new Date(Number(time)));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(item);
    }
    calendar.replaceChildren();
    for (const label of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) calendar.append(node("span", "events-weekday", label));
    const year = month.getFullYear(), monthIndex = month.getMonth();
    const label = byId("events-month-label");
    if (label) label.textContent = month.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
    const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) calendar.append(node("div", "events-day-spacer"));
    const days = new Date(year, monthIndex + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const date = new Date(year, monthIndex, day);
      const key = dayKey(date);
      const items = byDay.get(key) || [];
      const cell = node("button", "events-calendar-day");
      cell.type = "button"; cell.dataset.date = key;
      cell.setAttribute("aria-label", `${date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}, событий: ${items.length}`);
      if (key === selectedDay) cell.classList.add("selected");
      if (key === dayKey(new Date())) cell.classList.add("today");
      const head = node("span", "events-calendar-day-head");
      head.append(node("strong", "", day));
      if (items.length) head.append(node("b", "", items.length));
      cell.append(head);
      for (const item of items.slice(0, 2)) {
        const ticker = String(item.symbol || "").split("/")[0];
        const entry = node("span", `events-calendar-entry ${item.kind === "delisting" ? "removed" : ""}`);
        entry.append(node("i", ""), node("span", "", ticker), node("small", "", item.exchange));
        cell.append(entry);
      }
      if (items.length > 2) cell.append(node("span", "events-more", `+${items.length - 2}`));
      cell.addEventListener("click", () => { selectedDay = key; renderListings(); });
      calendar.append(cell);
    }
    const selectedDate = new Date(`${selectedDay}T12:00:00`);
    byId("events-day-label").textContent = selectedDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    const selectedItems = (byDay.get(selectedDay) || []).sort((a, b) =>
      Number(a.launchAt || a.detectedAt) - Number(b.launchAt || b.detectedAt));
    byId("events-day-count").textContent = selectedItems.length ? `${selectedItems.length} событий` : "";
    dayList.replaceChildren();
    for (const item of selectedItems.slice(0, 100)) {
      const removed = item.kind === "delisting";
      const card = node("article", `events-agenda-item ${removed ? "removed" : ""}`);
      const icon = node("img", ""); icon.src = `/img/${VENUE_ICONS[item.exchange] || "ALL"}.svg`; icon.alt = "";
      const text = node("div", "events-agenda-text");
      const venue = VENUES.find(([code]) => code === item.exchange)?.[1] || item.exchange;
      text.append(node("strong", "", item.symbol), node("small", "", `${venue} · ${item.type === "spot" ? "Спот" : "Фьючерсы"} · ${removed ? "исчезла из каталога" : item.launchAt ? "дата из каталога" : "обнаружено"}`));
      const time = item.kind === "delisting" ? item.detectedAt : item.launchAt || item.detectedAt;
      card.append(icon, text, node("time", "", new Date(Number(time)).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })));
      dayList.append(card);
    }
    if (!selectedItems.length) clearWithEmpty(dayList, "На эту дату событий нет");
    if (selectedItems.length > 100) dayList.append(node("div", "events-more", `Ещё ${selectedItems.length - 100} событий`));
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
      byId("events-search").addEventListener("input", renderListings);
      for (const [attribute, update] of [["kind", value => { selectedKind = value; }],
        ["phase", value => { selectedPhase = value; }]]) {
        document.querySelectorAll(`.events-segment [data-${attribute}]`).forEach(button => button.addEventListener("click", () => {
          update(button.dataset[attribute]);
          button.parentElement.querySelectorAll("button").forEach(item => item.classList.toggle("on", item === button));
          renderListings();
        }));
      }
      for (const [id, offset] of [["events-prev-month", -1], ["events-next-month", 1]]) {
        byId(id).addEventListener("click", () => {
          month = new Date(month.getFullYear(), month.getMonth() + offset, 1);
          selectedDay = dayKey(month);
          renderListings();
        });
      }
      byId("events-today").addEventListener("click", () => {
        const today = new Date();
        month = new Date(today.getFullYear(), today.getMonth(), 1);
        selectedDay = dayKey(today); renderListings();
      });
      setTab(selectedTab);
      refreshTimer = window.setInterval(() => {
        const connected = stream?.readyState === 1;
        if (byId("events-view")?.style.display === "block" &&
          Date.now() - lastRequest > (connected ? 120000 : 30000)) void refresh();
      }, 15000);
    }
    initAlerts();
    render();
    if (!data || Date.now() - lastRequest > 60000) void refresh();
  }

  function deactivate() { closePickers(); }
  function stopAlerts() { stream?.close(); stream = null; if (refreshTimer) window.clearInterval(refreshTimer); }
  window.ObsidianEvents = { activate, deactivate, stopAlerts };
  initAlerts();
})();
