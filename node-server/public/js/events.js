"use strict";

(() => {
  const VENUES = [
    ["BN", "Binance"], ["BB", "Bybit"], ["OX", "OKX"], ["BG", "Bitget"],
    ["GT", "Gate.io"], ["MX", "MEXC"], ["KC", "KuCoin"], ["BX", "BingX"],
    ["HT", "HTX"], ["HL", "Hyperliquid"], ["AD", "Aster"]
  ];
  const byId = id => document.getElementById(id);
  let data = null;
  let selectedTab = "news";
  let lastRequest = 0;
  let inFlight = null;
  let wired = false;
  let refreshTimer = null;
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
      link.append(node("h3", "", item.title), node("small", "", item.source + " · открыть источник ↗"));
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
    const exchange = byId("events-exchange")?.value || "all";
    const market = byId("events-market")?.value || "all";
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
        item.launchAt ? "Время запуска указано биржей" : "Новая пара обнаружена сканером; точное время запуска не опубликовано"));
      container.append(card);
    }
    upcoming.forEach(item => appendItem(upcomingBox, item, true));
    past.forEach(item => appendItem(pastBox, item, false));
    if (!upcomingBox.children.length) clearWithEmpty(upcomingBox, "Биржи пока не опубликовали время будущих запусков для выбранного рынка.");
    if (!pastBox.children.length) clearWithEmpty(pastBox, "История появится после обнаружения новых пар. Первое сканирование создаёт исходный список рынка.");
    const ready = Object.values(data?.venues || {}).filter(item => item?.status === "ok").length;
    const coverage = byId("events-coverage");
    if (coverage) coverage.textContent = `Каталоги бирж: ${ready}/11 доступны`;
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
    if (inFlight) return inFlight;
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
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  function activate() {
    if (!wired) {
      wired = true;
      const select = byId("events-exchange");
      for (const [code, name] of VENUES) {
        const option = node("option", "", name); option.value = code; select.append(option);
      }
      byId("events-tab-news").addEventListener("click", () => setTab("news"));
      byId("events-tab-listings").addEventListener("click", () => setTab("listings"));
      select.addEventListener("change", renderListings);
      byId("events-market").addEventListener("change", renderListings);
      setTab(selectedTab);
      refreshTimer = window.setInterval(() => {
        if (byId("events-view")?.style.display === "block") void refresh();
      }, 60000);
    }
    if (!data || Date.now() - lastRequest > 60000) void refresh();
    else render();
  }

  window.ObsidianEvents = { activate };
})();
