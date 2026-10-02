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
  let connectionError = false;
  let wired = false;
  let refreshTimer = null;
  let stream = null;
  let updateTimer = null;
  let searchFrame = null;
  let unlockMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  let unlockSelectedDay;
  let unlockPage = 0, unlockWindowPage = 0;
  let unlockType = "all", unlockSource = "primary";
  let newsKind = "all", newsLimit = 40;
  let socialPlatform = "all", socialTopic = "all", socialPage = 0, socialSourcePage = 0;
  let socialData = null, socialRequestKey = "", socialSequence = 0, socialAbort = null, socialSearchTimer = null;
  const seenKey = "obsidian-urgent-news-seen-v1";
  const visibleAlerts = new Map();
  let seenAlerts = [];
  try { seenAlerts = JSON.parse(window.sessionStorage.getItem(seenKey)) || []; } catch (_) {}
  if (!Array.isArray(seenAlerts)) seenAlerts = [];
  const dateStyles = {
    news: { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' },
    month: { month: 'long', year: 'numeric' }, day: { day: 'numeric', month: 'long' },
    fullDay: { day: 'numeric', month: 'long', year: 'numeric' }, time: { hour: '2-digit', minute: '2-digit' },
    utcMonth: { timeZone: 'UTC', month: 'long', year: 'numeric' }, utcDay: { timeZone: 'UTC', day: 'numeric', month: 'long' },
    utcFullDay: { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' },
    utcTime: { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }
  };
  let formatLocale, dateFormats = {}, amountFormat;
  function formatDate(value, style) {
    const locale = window.ObsidianI18n?.locale || 'ru-RU';
    if (locale !== formatLocale) { formatLocale = locale; dateFormats = {}; amountFormat = null; }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Invalid Date';
    const format = dateFormats[style] || (dateFormats[style] = new Intl.DateTimeFormat(locale, dateStyles[style]));
    return format.format(date);
  }
  function formatAmount(value) {
    const locale = window.ObsidianI18n?.locale || 'ru-RU';
    if (locale !== formatLocale) { formatLocale = locale; dateFormats = {}; amountFormat = null; }
    if (!amountFormat) amountFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    return amountFormat.format(Number(value));
  }
  const dateTime = value => value != null && Number.isFinite(Number(value)) ? formatDate(Number(value), 'news') : 'Время неизвестно';
  const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  selectedDay = dayKey(new Date());
  const utcDayKey = date => date.toISOString().slice(0, 10);
  unlockSelectedDay = utcDayKey(new Date());

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = String(value);
    return element;
  }

  function clearWithEmpty(target, message) {
    target.replaceChildren(node("div", "events-empty", message));
  }

  function publicationTitle(item) {
    return window.ObsidianI18n?.language === 'en' ? (item.title || item.titleRu) : (item.titleRu || item.title);
  }
  function evidenceCount(item) {
    return Math.max(2,new Set((item.verification?.sources||[]).map(source=>source.publisher||source.name)).size);
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
      if (!["official", "corroborated"].includes(item.verification?.status)) return null;
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
    const source = node("span", "", item.verification.status === "official" ? `${item.source} · официально` : `${item.source} · ${evidenceCount(item)} источников`);
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
    stream.addEventListener("retract", event => {
      try {
        const item = JSON.parse(event.data);
        visibleAlerts.get(item.url)?.closest(".toast-urgent-news")?.remove();
        visibleAlerts.delete(item.url);
      } catch (_) {}
    });
    stream.addEventListener("update", () => {
      if (updateTimer || document.hidden || byId("events-view")?.style.display !== "block") return;
      updateTimer = window.setTimeout(() => { updateTimer = null; void refresh(); }, 500);
    });
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
      else if (kind === "market") selectedMarket = value;
      else if (kind === "unlock-type") unlockType = value;
      else if (kind === "unlock-source") unlockSource = value;
      const chosen = options.find(option => option[0] === value);
      const icon = kind === "exchange" ? node("img", "") : node("span", "events-market-icon", chosen[2]);
      if (kind === "exchange") { icon.src = `/img/${chosen[2]}.svg`; icon.alt = ""; }
      button.replaceChildren(icon, node("span", "", chosen[1]), node("span", "events-picker-arrow", "⌄"));
      menu.querySelectorAll("button").forEach(item => {
        const active = item.dataset.value === value;
        item.classList.toggle("on", active);
        item.setAttribute("aria-selected", String(active));
      });
      closePickers();
      if (kind.startsWith("unlock-")) { unlockPage = unlockWindowPage = 0; renderUnlocks(); } else renderListings();
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
    const initial = kind === "unlock-source" ? unlockSource : "all";
    menu.querySelector(`[data-value="${initial}"]`).classList.add("on");
    menu.querySelector(`[data-value="${initial}"]`).setAttribute("aria-selected", "true");
    if (initial !== "all") {
      const chosen = options.find(option => option[0] === initial);
      button.replaceChildren(node("span", "events-market-icon", chosen[2]), node("span", "", chosen[1]), node("span", "events-picker-arrow", "⌄"));
    }
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
    const query = byId("events-news-search")?.value.trim().toLowerCase() || "";
    const matches = item => (!query || `${item.title} ${item.titleRu || ""} ${item.source}`.toLowerCase().includes(query)) &&
      (newsKind === "all" || (newsKind === "official" ? item.verification?.status === "official" : item.alertKind === newsKind));
    const rows = (Array.isArray(data?.news) ? data.news : []).filter(item => matches(item) && ["official", "corroborated", "reported"].includes(item.verification?.status));
    const urgent = rows.filter(item => item.priority === "urgent" && ["official", "corroborated"].includes(item.verification.status)).slice(0, 3);
    const otherRows = rows.filter(item => !urgent.includes(item));
    const rest = otherRows.slice(0, newsLimit);
    if (byId("events-news-more")) byId("events-news-more").hidden = otherRows.length <= newsLimit;
    function appendItem(container, item) {
      let url;
      try { url = new URL(item.url); } catch (_) { return; }
      if (url.protocol !== "https:") return;
      const confirmedUrgent = item.priority === "urgent" && ["official", "corroborated"].includes(item.verification.status);
      const link = node("article", `events-card ${confirmedUrgent ? "urgent" : ""}`);
      cardTop(link, confirmedUrgent ? "⚡ Срочно" : item.priority !== "regular" ? "● Важно" : "Новость",
        item.publishedAt, confirmedUrgent ? "red" : "");
      const heading = node("h3", "");
      const primary = node("a", "events-source-link", publicationTitle(item));
      primary.setAttribute('translate', 'no');
      primary.href = url.href; primary.target = "_blank"; primary.rel = "noopener noreferrer";
      heading.append(primary); link.append(heading);
      const sources = node("div", "events-news-sources");
      sources.append(node("small", "", item.verification.status === "official" ? "Официальный источник"
        : item.verification.status === "corroborated" ? `Сверено по ${evidenceCount(item)} источникам` : "Сообщает источник"));
      for (const evidence of item.verification.sources || []) {
        try { if (new URL(evidence.url).protocol !== "https:") continue; } catch (_) { continue; }
        const source = node("a", "events-source-link", `${evidence.name} ↗`);
        source.href = evidence.url; source.target = "_blank"; source.rel = "noopener noreferrer";
        sources.append(source);
      }
      link.append(sources);
      container.append(link);
    }
    urgent.forEach(item => appendItem(urgentBox, item));
    rest.forEach(item => appendItem(newsBox, item));
    if (!urgentBox.children.length) clearWithEmpty(urgentBox, "Срочных публикаций в свежей ленте нет.");
    if (!newsBox.children.length) clearWithEmpty(newsBox, "Ждём публикации с подтверждением источников.");
    const developingBox = byId("events-developing-list");
    if (developingBox) {
      developingBox.replaceChildren();
      for (const item of data?.developing || []) {
        if (item.verification?.status !== "pending" || !matches(item)) continue;
        let url;
        try { url = new URL(item.url); } catch (_) { continue; }
        if (url.protocol !== "https:") continue;
        const card = node("article", "events-card");
        cardTop(card, "Один источник · требует подтверждения", item.publishedAt);
        const heading = node("h3", "");
        const link = node("a", "events-source-link", publicationTitle(item));
        link.setAttribute('translate', 'no');
        link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
        heading.append(link);
        card.append(heading);
        const sources = node("div", "events-news-sources");
        sources.append(node("small", "", "Сообщает источник"));
        if (item.source) {
          const source = node("a", "events-source-link", `${item.source} ↗`);
          source.href = url.href; source.target = "_blank"; source.rel = "noopener noreferrer";
          sources.append(source);
        }
        card.append(sources);
        developingBox.append(card);
      }
      if (!developingBox.children.length) clearWithEmpty(developingBox, "Неподтверждённых сообщений от подключённых изданий нет.");
    }
  }

  function socialLink(label, value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return node("span", "", label);
      const link = node("a", "events-source-link", label);
      link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      return link;
    } catch (_) { return node("span", "", label); }
  }

  function socialPagination(id, total, page, size, change) {
    const box = byId(id); box.replaceChildren();
    if (total <= size) return;
    const prev = node("button", "", "Назад"), next = node("button", "", "Далее");
    prev.type = next.type = "button"; prev.disabled = page === 0; next.disabled = (page + 1) * size >= total;
    prev.addEventListener("click", () => { change(page - 1); void loadSocial(); });
    next.addEventListener("click", () => { change(page + 1); void loadSocial(); });
    box.append(prev, node("span", "", `${page * size + 1}–${Math.min(total, (page + 1) * size)} из ${total}`), next);
  }

  function renderSocial() {
    const box = byId("events-social-list"), coverage = byId("events-social-coverage");
    if (!box || !coverage) return;
    if (!socialData) { coverage.textContent = "Проверяем доступность официальных источников…"; void loadSocial(); return; }
    const c = socialData.coverage || {}, platforms = socialData.platforms || {};
    coverage.replaceChildren(node("p", "", `Кандидатов: ${c.candidates || 0} · сайтов проверено: ${c.checked || 0} · проектов со ссылками на аккаунты: ${c.verifiedProjects || 0} · источников успешно прочитано за 10 минут: ${c.reading || 0}.`),
      node("p", "", `${platforms.x === "configured" ? "X: API настроен" : "X: нужен доступ к API"}. ${platforms.discord === "configured" ? "Discord: доступ настроен" : "Discord: нужен бот с доступом к каналу объявлений"}. Telegram: публичные веб-каналы. Сайты: официальные RSS. Обновлено: ${dateTime(socialData.updatedAt)}.`));
    if (socialData.catalog?.status === "error") coverage.append(node("p", "", "Каталог проектов временно недоступен; продолжаем проверять сохранённый реестр."));
    if (c.unavailableWebsites) coverage.append(node("p", "", `Не удалось проверить сайтов: ${c.unavailableWebsites}. Аккаунты без действующего подтверждения не читаются.`));
    if (socialData.catalog?.partial) coverage.append(node("p", "", "Каталог превышает текущий предел реестра; охват неполный."));
    if (socialData.persistenceError) coverage.append(node("p", "", "Ошибка сохранения истории на сервере."));
    if (socialData.retention?.limitedAt) coverage.append(node("p", "", "Лента ограничена последними 7 днями, 2000 объявлениями и 100 записями на источник."));
    box.replaceChildren();
    for (const item of socialData.posts || []) {
      const card = node("article", "events-card");
      cardTop(card, `${item.project} · ${item.platform}`, item.publishedAt);
      const title = node("h3", ""); title.setAttribute('translate', 'no'); title.append(socialLink(item.title, item.url)); card.append(title);
      const details = node("details", "events-social-text"), summary = node("summary", "", "Текст публикации");
      const publication = node("p", "", item.text); publication.setAttribute('translate', 'no');
      details.append(summary, publication); card.append(details);
      const evidence = node("div", "events-news-sources");
      evidence.append(node("small", "", "Аккаунт указан на сайте проекта"), socialLink("Проверить источник ↗", item.evidenceUrl));
      card.append(evidence);
      if (item.topic === "unlock") card.append(node("small", "", "Объявление о разлоке: дату, объём и изменения расписания нужно сверить. Автоматически в календарь не добавляется."));
      box.append(card);
    }
    if (!box.children.length) clearWithEmpty(box, "Подходящих объявлений пока нет. Доступность подключений показана в реестре ниже.");
    socialPagination("events-social-pages", socialData.postTotal, socialData.page, 40, p => { socialPage = p; });
    const sources = byId("events-social-sources"); sources.replaceChildren();
    const statuses = { pending: "Ожидает чтения", ok: "Прочитан", no_relevant_posts: "Прочитан, подходящих объявлений нет", catching_up: "Восстанавливаем пропущенные страницы",
      requires_api_token: "Нет ключа X API", requires_bot_access: "Не подключён бот / канал Discord", verification_expired: "Проверка официальности устарела",
      rate_limited: "Лимит провайдера, повтор позже", access_denied: "Провайдер отказал в доступе", error: "Не удалось прочитать источник",
      stale: "Данные старше 10 минут, ждём повторного чтения", empty_or_restricted: "История пуста или Discord ограничил доступ" };
    for (const source of socialData.sources || []) {
      const row = node("div", "events-social-source");
      row.append(socialLink(`${source.project} · ${source.platform} ↗`, source.url), node("span", "", statuses[source.status] || "Ожидает проверки"), socialLink("Ссылка с сайта ↗", source.evidenceUrl));
      row.append(node("small", "", `Проверка ссылки: ${dateTime(source.verifiedAt)} · последнее чтение: ${dateTime(source.lastSuccessAt)}${source.historyLimited ? " · история ограничена провайдером или глубиной первого опроса" : ""}`));
      if (source.error) row.title = source.error;
      sources.append(row);
    }
    if (!sources.children.length) clearWithEmpty(sources, "Проверенных аккаунтов по этому фильтру пока нет. Проверка сайтов продолжается в фоне.");
    socialPagination("events-social-source-pages", socialData.sourceTotal, socialData.sourcePage, 50, p => { socialSourcePage = p; });
    void loadSocial();
  }

  async function loadSocial() {
    if (selectedTab !== "social") return;
    const params = new URLSearchParams({ search: byId("events-social-search")?.value.trim() || "", platform: socialPlatform,
      topic: socialTopic, page: String(socialPage), sourcePage: String(socialSourcePage) });
    const key = `${params}:${data?.social?.updatedAt || 0}`;
    if (key === socialRequestKey) return;
    socialRequestKey = key;
    const sequence = ++socialSequence;
    socialAbort?.abort(); socialAbort = new AbortController();
    try {
      const response = await fetch(`/api/events/social?${params}`, { signal: AbortSignal.any([socialAbort.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error("Social request failed");
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.posts) || !Array.isArray(payload.sources)) throw new Error("Invalid social response");
      if (sequence !== socialSequence) return;
      socialData = payload;
      if (selectedTab === "social") renderSocial();
    } catch (_) {
      if (sequence !== socialSequence) return;
      socialRequestKey = "";
      byId("events-social-coverage").textContent = "Не удалось обновить официальные каналы. Последние загруженные данные сохранены; повторим при следующем обновлении.";
    }
  }

  function renderListings() {
    const calendar = byId("events-calendar");
    const dayList = byId("events-day-list");
    if (!calendar || !dayList) return;
    const exchange = selectedExchange;
    const market = selectedMarket;
    const now = Date.now();
    const query = byId("events-search")?.value.trim().toLowerCase() || "";
    const eventTime = item => item.kind === "delisting" ? item.delistAt || item.detectedAt : item.launchAt || item.detectedAt;
    const rows = (Array.isArray(data?.listings) ? data.listings : [])
      .filter(item => {
        const time = Number(eventTime(item));
        return Number.isFinite(time) && time > 0 &&
          (exchange === "all" || item.exchange === exchange) && (market === "all" || item.type === market) &&
          (selectedKind === "all" || (item.kind || "listing") === selectedKind) &&
          (selectedPhase === "all" || (selectedPhase === "upcoming" ? time > now : time <= now)) &&
          (!query || String(item.symbol || "").toLowerCase().includes(query));
      });
    const byDay = new Map();
    for (const item of rows) {
      const time = eventTime(item);
      const key = dayKey(new Date(Number(time)));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(item);
    }
    calendar.replaceChildren();
    for (const label of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) calendar.append(node("span", "events-weekday", label));
    const year = month.getFullYear(), monthIndex = month.getMonth();
    const label = byId("events-month-label");
    if (label) label.textContent = formatDate(month, 'month');
    const offset = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) calendar.append(node("div", "events-day-spacer"));
    const days = new Date(year, monthIndex + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const date = new Date(year, monthIndex, day);
      const key = dayKey(date);
      const items = byDay.get(key) || [];
      const cell = node("button", "events-calendar-day");
      cell.type = "button"; cell.dataset.date = key;
      cell.setAttribute("aria-label", `${formatDate(date, 'day')}, событий: ${items.length}`);
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
    byId("events-day-label").textContent = formatDate(selectedDate, 'fullDay');
    const selectedItems = (byDay.get(selectedDay) || []).sort((a, b) =>
      Number(eventTime(a)) - Number(eventTime(b)));
    byId("events-day-count").textContent = selectedItems.length ? `${selectedItems.length} событий` : "";
    dayList.replaceChildren();
    for (const item of selectedItems.slice(0, 100)) {
      const removed = item.kind === "delisting";
      const card = node("article", `events-agenda-item ${removed ? "removed" : ""}`);
      const icon = node("img", ""); icon.src = `/img/${VENUE_ICONS[item.exchange] || "ALL"}.svg`; icon.alt = "";
      const text = node("div", "events-agenda-text");
      const venue = VENUES.find(([code]) => code === item.exchange)?.[1] || item.exchange;
      text.append(node("strong", "", item.symbol), node("small", "", `${venue} · ${item.type === "spot" ? "Спот" : "Фьючерсы"} · ${removed ? item.delistAt ? "делистинг · дата биржи" : "исчезла из каталога" : item.launchAt ? "дата из каталога" : "обнаружено"}`));
      const time = eventTime(item);
      card.append(icon, text, node("time", "", formatDate(Number(time), 'time')));
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
      coverage.title = VENUES.map(([code, name]) => {
        const venue = data?.venues?.[code];
        return `${name}: ${venue?.status === "ok" ? `${venue.spot} спот / ${venue.futures} фьючерсы` : "нет свежих данных"}`;
      }).join("\n");
    }
  }

  function renderUnlocks() {
    const list = byId("events-unlocks-list"), status = byId("events-unlocks-status"), calendar = byId("events-unlocks-calendar");
    if (!list || !status || !calendar) return;
    const payload = data?.unlocks;
    const primary = payload?.sources?.primary;
    const aggregator = payload?.sources?.defillama;
    const plans=payload?.sources?.projectPlans;
    const en=window.ObsidianI18n?.language==='en';
    const health = source => source?.expired ? "кэш истёк, события скрыты" : source?.status === "error"
      ? (source.updatedAt ? "источник недоступен, показан кэш" : "источник недоступен")
      : source?.stale ? "данные устарели" : source?.status === "empty" ? "нет датированных событий в доступном календаре" : source?.status === "ok" ? `обновлено ${dateTime(source.updatedAt)}` : "загрузка";
    const planStatus=plans?.expiredDocuments&& !plans.documentedTokens?(en?'cached plans expired and were hidden':'кэш планов истёк и скрыт')
      :plans?.status==='cached'?(en?'saved snapshot; rechecking':'сохранённый снимок; проверяем обновления')
      :plans?.status==='rate_limited'?(en?'provider rate limit; retry scheduled':'источник ограничил запросы; повтор запланирован')
      :plans?.status==='error'?(en?'provider unavailable':'источник недоступен'):plans?.partial?(en?'scan in progress / incomplete':'обход продолжается / есть пропуски'):(en?'catalog checked':'каталог проверен');
    const planWarnings=plans?(en?`${plans.errors?` · ${plans.errors} request failures`:''}${plans.superseded?` · superseded plans excluded: ${plans.superseded}`:''}${plans.reviewRequired?` · plans pending review: ${plans.reviewRequired}`:''}${plans.staleDocuments?` · ${plans.staleDocuments} documents need rechecking`:''}${plans.expiredDocuments?` · ${plans.expiredDocuments} expired documents hidden`:''}`
      :`${plans.errors?` · ${plans.errors} ошибок запросов`:''}${plans.superseded?` · устаревших планов исключено: ${plans.superseded}`:''}${plans.reviewRequired?` · планов на повторной проверке: ${plans.reviewRequired}`:''}${plans.staleDocuments?` · ${plans.staleDocuments} документов требуют повторной проверки`:''}${plans.expiredDocuments?` · ${plans.expiredDocuments} истёкших документов скрыто`:''}`):'';
    const warnings=byId('events-unlocks-plan-warnings');
    if(warnings){
      warnings.replaceChildren();
      for(const plan of plans?.excludedPlans||[]){
        const text=plan.status==='review_required'?(en?'old forecast hidden pending review of newer team terms':'старый прогноз скрыт до проверки новых условий команды'):(en?'old forecast superseded by newer official terms':'старый прогноз исключён после официального пересмотра');
        const line=node('p','',`${plan.symbol}: ${text} · `);
        line.append(socialLink(en?'Official update ↗':'Официальное обновление ↗',plan.url));warnings.append(line);
      }
      warnings.hidden=!warnings.children.length;
    }
    status.textContent = (Number.isFinite(primary?.totalOfficialTokens)?(en?`Official-source coverage: ${primary.totalOfficialTokens} distinct projects with future entries. `:`Охват официальных источников: ${primary.totalOfficialTokens} уникальных проектов с будущими записями. `):'') +
      (en?`Schedules modeled from project documentation: ${primary?.tokens||0} projects. `:`Расписания по документации проектов: ${primary?.tokens || 0} проектов. `) +
      (plans?(en?`Team plans published by Upbit: ${plans.documentedTokens||0} documents, ${plans.tokens||0} projects with future monthly forecasts; checked ${plans.scannedTokens||0}/${plans.availableTokens??'?'} assets · ${planStatus}${plans.unsupported?` · ${plans.unsupported} unsupported documents`:''}${plans.notPublished?` · ${plans.notPublished} without a published plan`:''}${planWarnings}. `
        :`Планы команд, опубликованные Upbit: ${plans.documentedTokens||0} документов, ${plans.tokens||0} проектов с будущими месячными прогнозами; проверено ${plans.scannedTokens||0}/${plans.availableTokens??'?'} активов · ${planStatus}${plans.unsupported?` · ${plans.unsupported} документов не удалось разобрать`:''}${plans.notPublished?` · ${plans.notPublished} без опубликованного плана`:''}${planWarnings}. `):'') +
      [["dropstab", "DropsTab"], ["coinmarketcap", "CoinMarketCap"], ["tokenomist", "Tokenomist"]].map(([key, name]) => {
        const source = payload?.sources?.[key];
        return source ? `${name}: ${source.tokens || 0} проектов с событиями${source.inactiveTokens ? ` (из них ${source.inactiveTokens} помечены неактивными)` : ""} · получено ${source.scannedTokens || 0}/${source.availableTokens ?? "?"} записей каталога · ${health(source)}${source.partial ? " · часть каталога недоступна" : ""}. ` : "";
      }).join("") +
      (aggregator?.status === "not_configured" ? "" : `DefiLlama: ${health(aggregator)}. `) +
      (en?"Coverage depends on available sources. Projects and entries overlap and their counts are not additive. Public calendars usually provide upcoming portions, not complete annual schedules. Team plans forecast monthly circulating supply; they are not exact unlocks."
        :"Охват ограничен доступными источниками. Проекты и события у поставщиков пересекаются; количества не суммируются. Публичные календари показывают ближайшие порции, а не полное расписание на год. Планы команд прогнозируют обращение за месяц, а не точный разлок.");
    const query = byId("events-unlocks-search").value.trim().toLowerCase();
    const kind = unlockType, provider = unlockSource;
    const rows = (payload?.rows || []).filter(item => {
      const at = Number(item.at);
      return Number.isFinite(at) && (item.amount > 0 || item.amount===null&&item.confidence==='schedule') &&
        (!byId("events-unlocks-hide-inactive").checked || item.marketStatus !== "inactive") &&
        (kind === "all" || item.unlockType === kind) &&
        (provider === "all" || (provider === "primary" ? ['schedule','project_plan'].includes(item.confidence) : ['schedule','project_plan'].includes(provider)?item.confidence===provider:item.provider === provider)) &&
        (!query || `${item.symbol || ""} ${item.name}`.toLowerCase().includes(query));
    }).sort((a, b) => a.at - b.at);

    const byDay = new Map();
    for (const item of rows) {
      if (["month", "week","period"].includes(item.precision)) continue;
      const key = utcDayKey(new Date(Number(item.at)));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(item);
    }
    // Compare the same denominator; token counts of different assets are not comparable.
    const impact = item => Number.isFinite(item.percentSupply) ? item.percentSupply : -1;
    for (const items of byDay.values()) items.sort((a, b) => impact(b) - impact(a) || a.at - b.at || String(a.id).localeCompare(String(b.id)));

    calendar.replaceChildren();
    for (const weekday of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) calendar.append(node("span", "events-weekday", weekday));
    const year = unlockMonth.getUTCFullYear(), monthIndex = unlockMonth.getUTCMonth();
    byId("events-unlocks-month-label").textContent = formatDate(unlockMonth, 'utcMonth');
    const offset = (unlockMonth.getUTCDay() + 6) % 7;
    for (let i = 0; i < offset; i++) calendar.append(node("div", "events-day-spacer"));
    const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    let monthEvents = 0;
    for (let day = 1; day <= days; day++) {
      const date = new Date(Date.UTC(year, monthIndex, day)), key = utcDayKey(date), items = byDay.get(key) || [];
      monthEvents += items.length;
      const cell = node("button", "events-calendar-day unlock-calendar-day");
      cell.type = "button"; cell.dataset.unlockDate = key;
      cell.setAttribute("aria-label", `${formatDate(date, 'utcDay')} UTC, записей: ${items.length}`);
      if (key === unlockSelectedDay) cell.classList.add("selected");
      if (key === utcDayKey(new Date())) cell.classList.add("today");
      const head = node("span", "events-calendar-day-head");
      head.append(node("strong", "", day));
      if (items.length) head.append(node("b", "", items.length));
      cell.append(head);
      for (const item of items.slice(0, 3)) {
        const uncertain = ["month", "week"].includes(item.precision);
        const style = uncertain ? "uncertain" : ["cliff", "linear", "scheduled"].includes(item.unlockType) ? item.unlockType : "unknown";
        const entry = node("span", `events-calendar-entry unlock-entry ${style}`);
        const ticker = `${uncertain ? "≈ " : ""}${item.symbol || item.name || "?"}`;
        const pct = Number.isFinite(item.percentSupply) ? `${item.percentSupply < 0.01 ? "<0.01" : item.percentSupply.toFixed(2)}%` : "";
        entry.append(node("i", ""), node("span", "", ticker));
        if (pct) entry.append(node("small", "", pct));
        cell.append(entry);
      }
      if (items.length > 3) cell.append(node("span", "events-more", `+${items.length - 3}`));
      cell.addEventListener("click", () => { unlockSelectedDay = key; unlockPage = 0; renderUnlocks(); });
      calendar.append(cell);
    }

    const count = byId("events-unlocks-count");
    const monthStart = unlockMonth.getTime(), monthEnd = Date.UTC(year, monthIndex + 1, 1);
    const windows = rows.filter(item => ["month", "week","period"].includes(item.precision) &&
      Number(item.windowStart) < monthEnd && Number(item.windowEnd) >= monthStart);
    if (count) count.textContent = en?`UTC calendar · this month: ${monthEvents} dated entries + ${windows.length} periods/windows · matching filters: ${rows.length}. Percentages use each source's supply basis.`
      :`Календарь UTC · в месяце: ${monthEvents} записей с датой + ${windows.length} периодов и окон · всего по фильтрам: ${rows.length}. База процента указана в источнике.`;
    const selectedDate = new Date(`${unlockSelectedDay}T12:00:00Z`);
    byId("events-unlocks-day-label").textContent = formatDate(selectedDate, 'utcFullDay') + " · UTC";
    const selectedItems = byDay.get(unlockSelectedDay) || [];
    byId("events-unlocks-day-count").textContent = selectedItems.length ? `${selectedItems.length} записей` : "";

    renderUnlockCards(list, selectedItems, unlockPage, page => { unlockPage = page; renderUnlocks(); });
    if (!selectedItems.length) clearWithEmpty(list, rows.length ? "На эту дату разлоков нет. Периоды и окна указаны отдельно ниже." : "Разлоков по выбранным фильтрам нет. Проверьте охват источников выше.");
    const windowList = byId("events-unlocks-windows");
    byId("events-unlocks-windows-section").hidden = !windows.length;
    renderUnlockCards(windowList, windows, unlockWindowPage, page => { unlockWindowPage = page; renderUnlocks(); });
    const signals = byId("events-unlocks-signals");
    if (signals) {
      const cards = (payload?.signals || []).filter(item => !query || `${item.title} ${item.titleRu || ""}`.toLowerCase().includes(query)).map(item => {
        const card = node("article", "events-card"), link = node("a", "events-source-link", publicationTitle(item));
        link.setAttribute('translate', 'no');
        try { const url = new URL(item.url); if (url.protocol !== "https:") return null; link.href = url.href; } catch (_) { return null; }
        link.target = "_blank"; link.rel = "noopener noreferrer";
        card.append(link, node("small", "", `${item.source} · опубликовано ${dateTime(item.publishedAt)} · расписание требует проверки`)); return card;
      }).filter(Boolean);
      signals.replaceChildren(...cards);
      if (!cards.length) clearWithEmpty(signals, "Свежих публикаций по этому запросу нет.");
    }
  }

  function renderUnlockCards(list, items, requestedPage, onPage) {
    const en=window.ObsidianI18n?.language==='en';
    const page = Math.min(requestedPage, Math.max(0, Math.ceil(items.length / 100) - 1));
    const fragment = document.createDocumentFragment();
    for (const item of items.slice(page * 100, (page + 1) * 100)) {
      const card = node("article", "events-card");
      const at = new Date(item.at);
      const formatDay = date => formatDate(date, 'utcFullDay');
      const dateLabel = item.precision === "month" ? formatDate(at, 'utcMonth')
        : ['week','period'].includes(item.precision) ? `${formatDay(item.windowStart)} — ${formatDay(item.windowEnd)}` : formatDay(item.at);
      card.append(node("h3", "", `${item.symbol || item.name} · ${dateLabel}`));
      const types = { cliff: "Разовый разлок (cliff)", linear: "Линейный вестинг · ближайшая порция по источнику", scheduled: "Расчёт по официальному расписанию",circulation:en?'Team plan · monthly circulating-supply change':"План команды · изменение обращения за месяц", tge: "Первичный выпуск (TGE)", inflationary: "Возрастающая эмиссия", deflationary: "Убывающая эмиссия", "non-linear": "Нелинейный выпуск", unknown: "Тип выпуска не уточнён" };
      card.append(node("p", "", `${item.name} · ${item.precision==='period'?(en?'Continuous vesting over the period':'Непрерывный вестинг за период'):types[item.unlockType] || types.unknown}`));
      const amount = formatAmount(item.amount);
      const share = Number.isFinite(item.percentSupply) ? ` · ${item.percentSupply > 0 && item.percentSupply < 0.01 ? "<0.01" : item.percentSupply.toFixed(2)}% ${en?'of stated total supply':'от указанного общего предложения'}` : "";
      card.append(node("p", "", item.amount===null?(en?'Stage amount not specified':'Объём этапа не указан'):`${item.upperBound?(en?'Up to ':'До '):''}${amount} ${en?'tokens':'токенов'}${share}`));
      const utcTime = value => formatDate(Number(value), 'utcTime') + " UTC";
      const precisionLabel = { month: en?'Monthly period · exact release date not provided':"Месячный период · точная дата выпуска не указана",period:en?'Continuous vesting over the period · not a single cliff':"Непрерывный вестинг за период · не разовый cliff", week: "приблизительное окно ±3 дня", day: "точное время неизвестно · дата UTC", hour: `${utcTime(item.windowStart ?? item.at)} · в пределах этого часа`, block: `${utcTime(item.at)} · оценка времени блока` }[item.precision];
      card.append(node("small", "", `${item.provider} · ${precisionLabel || utcTime(item.at)}${item.stale ? " · УСТАРЕВШИЕ ДАННЫЕ" : ""}`));
      if (item.marketStatus === "inactive") card.append(node("small", "", "Источник пометил проект неактивным; доступность торгов не подтверждена."));
      if (item.allocationMismatch) card.append(node("small", "", "Сумма распределений источника расходится с итогом. Показан итог без разбивки."));
      if(item.documentDate)card.append(node('small','',`${en?'Document dated':'Документ от'} ${item.documentDate}${item.checkedAt?` · ${en?'checked':'проверен'} ${dateTime(item.checkedAt)}`:''}`));
      if(item.note){const note=node('small','',en&&item.noteEn?item.noteEn:item.note);note.style.display='block';card.append(note);}
      for (const allocation of item.allocations || []) if(allocation.amount!==null)card.append(node("div", "", `${allocation.label}: ${formatAmount(allocation.amount)}`));
      const sources = node("div", "events-news-sources");
      for (const url of item.sources || []) {
        let parsed; try { parsed = new URL(url); if (parsed.protocol !== "https:") continue; } catch (_) { continue; }
        const link = node("a", "events-source-link", `${parsed.hostname} ↗`);
        link.href = parsed.href; link.target = "_blank"; link.rel = "noopener noreferrer"; sources.append(link);
      }
      card.append(sources); fragment.append(card);
    }
    list.replaceChildren(fragment);
    if (items.length > 100) {
      const nav = node("div", "events-calendar-bar unlock-pagination");
      const prev = node("button", "", "Предыдущие"), next = node("button", "", "Следующие");
      prev.type = next.type = "button"; prev.disabled = page === 0; next.disabled = (page + 1) * 100 >= items.length;
      prev.addEventListener("click", () => onPage(page - 1)); next.addEventListener("click", () => onPage(page + 1));
      nav.append(prev, node("span", "", `${page * 100 + 1}–${Math.min((page + 1) * 100, items.length)} из ${items.length}`), next);
      list.append(nav);
    }
  }

  function render() {
    const updated = byId("events-updated");
    if (updated) updated.textContent = connectionError ? "Нет связи · показываем последние данные" : data?.marketUpdatedAt || data?.newsUpdatedAt
      ? `Новости ${dateTime(data.newsUpdatedAt)} · рынки ${dateTime(data.marketUpdatedAt)}`
      : "Получаем данные бирж и новостей…";
    if (updated) updated.title = Object.entries(data?.sources || {}).map(([name, source]) =>
      `${name}: ${source.status === "ok" || source.status === "connected" ? "доступен" : source.status === "no_recent_items" ? "нет публикаций за 7 дней" : "нет связи"}`).join("\n");
    if (selectedTab === "news") renderNews();
    else if (selectedTab === "social") renderSocial();
    else if (selectedTab === "listings") renderListings();
    else renderUnlocks();
  }

  function queueSearchRender() {
    if (searchFrame !== null) return;
    const tab = selectedTab;
    searchFrame = window.requestAnimationFrame(() => {
      searchFrame = null;
      if (!document.hidden && selectedTab === tab && byId('events-view')?.style.display === 'block') render();
    });
  }

  function setTab(tab) {
    selectedTab = tab;
    byId("events-news-panel").hidden = tab !== "news";
    byId("events-listings-panel").hidden = tab !== "listings";
    byId("events-unlocks-panel").hidden = tab !== "unlocks";
    byId("events-social-panel").hidden = tab !== "social";
    for (const key of ["news", "listings", "unlocks", "social"]) {
      const button = byId(`events-tab-${key}`);
      button.classList.toggle("on", key === tab);
      button.setAttribute("aria-selected", String(key === tab));
    }
    render();
  }

  async function refresh() {
    if (inFlight) { refreshPending = true; return inFlight; }
    inFlight = (async () => {
      try {
        const response = await fetch("/api/events", { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          ["news", "listings", "developing", "announcements"].some(key => payload[key] != null && !Array.isArray(payload[key]))) throw new Error("Invalid events response");
        data = payload;
        connectionError = false;
        lastRequest = Date.now();
        render();
      } catch (_) {
        connectionError = true;
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
      wirePicker("unlock-type", [["all", "Все типы", "◈"], ["cliff", "Разовые (cliff)", "◆"], ["linear", "Линейный вестинг", "↗"], ["scheduled", "Официальное расписание", "✓"],["circulation","Планы обращения","◷"], ["tge", "Первичный выпуск (TGE)", "●"], ["inflationary", "Возрастающая эмиссия", "↗"], ["deflationary", "Убывающая эмиссия", "↘"], ["non-linear", "Нелинейный выпуск", "≈"], ["unknown", "Тип не уточнён", "?"]]);
      wirePicker("unlock-source", [["all", "Все источники", "◈"], ["primary", "Официальные источники", "✓"],["schedule","Документация проектов","✓"],["project_plan","Планы команд · Upbit","◷"], ["DropsTab", "DropsTab", "D"], ["CoinMarketCap", "CoinMarketCap", "C"], ["Tokenomist", "Tokenomist", "T"], ["DefiLlama", "DefiLlama", "L"]]);
      document.addEventListener("click", event => { if (!event.target.closest(".events-picker")) closePickers(); });
      byId("events-tab-news").addEventListener("click", () => setTab("news"));
      byId("events-news-search").addEventListener("input", () => { newsLimit = 40; queueSearchRender(); });
      byId("events-news-more").addEventListener("click", () => { newsLimit += 40; renderNews(); });
      document.querySelectorAll("[data-news-kind]").forEach(button => button.addEventListener("click", () => {
        newsKind = button.dataset.newsKind; newsLimit = 40;
        button.parentElement.querySelectorAll("button").forEach(item => item.classList.toggle("on", item === button));
        renderNews();
      }));
      byId("events-tab-listings").addEventListener("click", () => setTab("listings"));
      byId("events-tab-unlocks").addEventListener("click", () => setTab("unlocks"));
      byId("events-tab-social").addEventListener("click", () => setTab("social"));
      byId("events-social-search").addEventListener("input", () => {
        clearTimeout(socialSearchTimer);
        socialSearchTimer = setTimeout(() => { socialPage = socialSourcePage = 0; void loadSocial(); }, 250);
      });
      for (const kind of ["platform", "topic"]) for (const button of document.querySelectorAll(`[data-social-${kind}]`)) {
        button.addEventListener("click", () => {
          if (kind === "platform") socialPlatform = button.dataset.socialPlatform; else socialTopic = button.dataset.socialTopic;
          button.parentElement.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === button));
          socialPage = socialSourcePage = 0; void loadSocial();
        });
      }
      byId("events-unlocks-search").addEventListener("input", () => { unlockPage = unlockWindowPage = 0; queueSearchRender(); });
      byId("events-unlocks-hide-inactive").addEventListener("change", () => { unlockPage = unlockWindowPage = 0; renderUnlocks(); });
      for (const [id, offset] of [["events-unlocks-prev-month", -1], ["events-unlocks-next-month", 1]]) {
        byId(id).addEventListener("click", () => {
          unlockMonth = new Date(Date.UTC(unlockMonth.getUTCFullYear(), unlockMonth.getUTCMonth() + offset, 1));
          unlockSelectedDay = utcDayKey(unlockMonth);
          unlockPage = unlockWindowPage = 0;
          renderUnlocks();
        });
      }
      byId("events-unlocks-today").addEventListener("click", () => {
        const today = new Date();
        unlockMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        unlockSelectedDay = utcDayKey(today); unlockPage = unlockWindowPage = 0; renderUnlocks();
      });
      byId("events-search").addEventListener("input", queueSearchRender);
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
    }
    if (!refreshTimer) {
      refreshTimer = window.setInterval(() => {
        const connected = stream?.readyState === 1;
        if (!document.hidden && byId("events-view")?.style.display === "block" &&
          Date.now() - lastRequest > (connected ? 120000 : 30000)) void refresh();
      }, 15000);
    }
    initAlerts();
    render();
    if (!data || Date.now() - lastRequest > 60000) void refresh();
  }

  function deactivate() {
    closePickers();
    if (searchFrame !== null) window.cancelAnimationFrame(searchFrame);
    searchFrame = null;
  }
  function stopAlerts() {
    socialAbort?.abort(); socialSequence++; socialRequestKey = "";
    if (socialSearchTimer) window.clearTimeout(socialSearchTimer);
    stream?.close(); stream = null;
    if (refreshTimer) window.clearInterval(refreshTimer);
    if (updateTimer) window.clearTimeout(updateTimer);
    refreshTimer = null; updateTimer = null;
  }
  window.ObsidianEvents = { activate, deactivate, stopAlerts };
  window.addEventListener('obsidian:languagechange', () => { if (data) render(); });
  initAlerts();
})();
