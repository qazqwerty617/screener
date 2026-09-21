"use strict";

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { publisher, canonicalUrl, assessNews, sameClaim, isPublished } = require("./newsVerification");
const { createSourceReader, parseArticle, telegramLead } = require("./newsSources");

const VENUES = Object.freeze([
  ["BN", "Binance", "binance"], ["BB", "Bybit", "bybit"],
  ["OX", "OKX", "okx"], ["BG", "Bitget", "bitget"],
  ["GT", "Gate.io", "gate"], ["MX", "MEXC", "mexc"],
  ["KC", "KuCoin", "kucoin"], ["BX", "BingX", "bingx"],
  ["HT", "HTX", "htx"], ["HL", "Hyperliquid", "hyperliquid"],
  ["AD", "Aster", "aster"]
]);
const FEEDS = Object.freeze([
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss"],
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["The Block", "https://www.theblock.co/rss.xml"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["Federal Reserve", "https://www.federalreserve.gov/feeds/press_monetary.xml"],
  ["White House", "https://www.whitehouse.gov/presidential-actions/feed/"]
]);
const URGENT = /\b(hack(?:ed)?|exploit|breach|stolen|drain(?:ed)?|attack|liquidat(?:ed|ion)|insolvenc[ey]|bankrupt|emergency|security incident|outage|trump|tariffs?|fed(?:eral)? reserve|rate (?:cut|hike)|sanctions?)\b/i;
const IMPORTANT = /\b(SEC|ETF|fed(?:eral)? reserve|interest rate|regulat(?:ion|or)|lawsuit|listing|delisting|approval|hack|exploit|breach|bitcoin|ethereum)\b/i;
function alertKind(title) {
  if (/\b(FOMC statement|Federal Reserve (?:issues|lowers|raises))\b/i.test(title)) return "macro";
  if (/\b(hack(?:ed)?|exploit(?:ed)?|security breach|funds? (?:stolen|drained)|wallets? drained|cyberattack)\b/i.test(title)) return "security";
  if (/\b(insolvenc[ey]|bankrupt(?:cy)?|withdrawals? (?:halted|suspended|frozen)|major (?:exchange |network )?outage)\b/i.test(title)) return "risk";
  if (/\b(trump|fed(?:eral)? reserve)\b/i.test(title) && /\b(announc(?:es?|ed)|signs?|imposes?|emergency|rate (?:cut|hike)|tariffs?|sanctions?)\b/i.test(title)
    && /\b(crypto|bitcoin|btc|tariffs?|sanctions?|interest|rates?|fed(?:eral)? reserve)\b/i.test(title)) return "macro";
  return null;
}
const MAX_EVENT_AGE_MS = 90 * 86400000;

function decodeXml(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code) => {
      const number = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return Number.isFinite(number) && number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").trim();
}

function rssField(item, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(item);
  return decodeXml(match?.[1]);
}

function parseNews(xml, source, now = Date.now()) {
  const rows = [];
  for (const match of String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const title = rssField(match[1], "title").slice(0, 250);
    const link = rssField(match[1], "link");
    const publishedAt = Date.parse(rssField(match[1], "pubDate"));
    if (!title || !Number.isFinite(publishedAt) || publishedAt > now + 3600000 || now - publishedAt > 7 * 86400000) continue;
    let url;
    try { url = new URL(link); } catch (_) { continue; }
    if (url.protocol !== "https:") continue;
    rows.push({ id: `${source}:${url.pathname}`, title, url: canonicalUrl(url.href), source,
      context: rssField(match[1], "description").slice(0, 1200), originVerified: publisher(url.href)?.[2] === source,
      publishedAt, priority: alertKind(title) || URGENT.test(title) ? "urgent" : IMPORTANT.test(title) ? "important" : "regular" });
  }
  return rows;
}

function parseStreamNews(raw, now = Date.now()) {
  let message;
  try { message = JSON.parse(String(raw)); } catch (_) { return null; }
  const title = String(message.body || message.title || "").replace(/<[^>]*>/g, " ").trim().slice(0, 300);
  const source = String(message.source || "Tree News").slice(0, 70);
  const rawTime = Number(message.time);
  const publishedAt = Number.isFinite(rawTime) && rawTime > 0
    ? (rawTime < 1e11 ? rawTime * 1000 : rawTime) : Date.parse(message.time);
  let url;
  try { url = new URL(message.link); } catch (_) { return null; }
  if (!title || title.length < 12 || url.protocol !== "https:" || !Number.isFinite(publishedAt) ||
    publishedAt > now + 3600000 || now - publishedAt > 7 * 86400000) return null;
  // Stream includes social posts. Keep an explicit link to the original and never infer verification.
  return { id: `tree:${String(message._id || url.href).slice(0, 300)}`, title, url: url.href,
    source, publishedAt, receivedAt: now,
    priority: alertKind(title) || URGENT.test(title) ? "urgent" : IMPORTANT.test(title) ? "important" : "regular" };
}

async function translateTitle(title, key = process.env.DEEPL_API_KEY || "") {
  const deepl = key.trim();
  const endpoint = deepl.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
  if (deepl) {
    const response = await fetch(endpoint, { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `DeepL-Auth-Key ${deepl}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: [title], target_lang: "RU" }) });
    if (!response.ok) throw new Error(`DeepL HTTP ${response.status}`);
    return (await response.json()).translations?.[0]?.text || null;
  }
  const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(title.slice(0, 350))}&langpair=en%7Cru`,
    { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);
  const result = await response.json();
  if (result.responseStatus !== 200) throw new Error("Translation unavailable");
  return result.responseData?.translatedText || null;
}

function launchTime(info, now = Date.now(), venue = "") {
  const keys = { BN: ["onboardDate"], BB: ["launchTime"], OX: ["contTdSwTime", "listTime"], BX: ["launchTime"],
    AD: ["onboardDate"] }[venue] || [];
  for (const key of keys) {
    const raw = info?.[key];
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    const time = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(String(raw));
    if (Number.isFinite(time) && time > now - MAX_EVENT_AGE_MS && time < now + 60 * 86400000) return time;
  }
  return null;
}

function delistField(market, venue) {
  return venue === "OX" ? "expTime" : venue === "BB" && market.swap ? "deliveryTime"
    : venue === "GT" && market.spot ? "delisting_time" : null;
}
function delistTime(market, venue, now) {
  const key = delistField(market, venue);
  const raw = key ? Number(market.info?.[key]) : 0;
  const time = raw && raw < 1e11 ? raw * 1000 : raw;
  return time > now - MAX_EVENT_AGE_MS && time < now + 60 * 86400000 ? time : null;
}

function normalizeMarkets(markets, venue, now = Date.now()) {
  const rows = new Map();
  for (const market of Object.values(markets || {})) {
    if (!market || !(market.spot || market.swap) || !market.symbol || !market.base ||
      market.quote !== "USDT" || market.swap && market.settle && market.settle !== "USDT") continue;
    const launchAt = launchTime(market.info, now, venue);
    const delistAt = delistTime(market, venue, now);
    if (market.active === false && !(launchAt > now) && !delistAt) continue;
    const type = market.spot ? "spot" : "futures";
    const symbol = String(market.symbol).slice(0, 80);
    const key = `${venue}:${type}:${symbol}`;
    rows.set(key, { key, exchange: venue, type, symbol,
      base: String(market.base).slice(0, 40), launchAt, delistAt,
      delistScheduleKnown: !!delistField(market, venue) && Object.hasOwn(market.info || {}, delistField(market, venue)) });
  }
  return [...rows.values()];
}

function createMarketFetcher(createClient = exchangeId => {
  const ccxt = require("ccxt");
  const client = new ccxt[exchangeId]({ enableRateLimit: true, timeout: 12000 });
  if (exchangeId === "gate") {
    client.options.fetchMarkets = { types: ["spot", "swap"] };
    client.options.swap = { fetchMarkets: { settlementCurrencies: ["usdt"] } };
    client.has.fetchCurrencies = false;
  }
  return client;
}, deadlineMs = 30000) {
  const clients = new Map();
  const loaded = new Set();
  const pending = new Map();
  const timedOut = new Set();
  const lateResults = new Map();
  const load = async exchangeId => {
    const late = lateResults.get(exchangeId);
    lateResults.delete(exchangeId);
    if (late && Date.now() - late.receivedAt < 90000) return late.markets;
    let client = clients.get(exchangeId);
    if (!client) { client = createClient(exchangeId); clients.set(exchangeId, client); }
    let operation = pending.get(exchangeId);
    if (!operation) {
      operation = Promise.resolve().then(() => client.loadMarkets(loaded.has(exchangeId))).then(markets => {
        if (timedOut.has(exchangeId)) lateResults.set(exchangeId, { markets, receivedAt: Date.now() });
        loaded.add(exchangeId); return markets;
      }).finally(() => { pending.delete(exchangeId); timedOut.delete(exchangeId); });
      pending.set(exchangeId, operation);
    }
    let timer;
    try {
      const markets = await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut.add(exchangeId); reject(new Error("Market catalog deadline exceeded")); }, deadlineMs);
      })]);
      lateResults.delete(exchangeId);
      return markets;
    } finally { clearTimeout(timer); }
  };
  const fetchMarkets = async exchangeId => {
    // CCXT exposes KuCoin derivatives through a separate exchange client.
    if (exchangeId === "kucoin") {
      const [spot, futures] = await Promise.all([load("kucoin"), load("kucoinfutures")]);
      return { ...spot, ...futures };
    }
    return load(exchangeId);
  };
  fetchMarkets.close = async () => {
    await Promise.allSettled([...clients.values()].map(client => client.close?.()));
    clients.clear(); loaded.clear(); lateResults.clear();
  };
  return fetchMarkets;
}

function createEventsHub({ filePath = path.join(__dirname, "events_hub.json"),
  fetchMarkets = null, fetchFeed = createSourceReader(), now = () => Date.now(), translate = translateTitle,
  streamFactory = url => new WebSocket(url, { perMessageDeflate: false }),
  streamKey = process.env.TREE_NEWS_API_KEY || "",
  telegramChannelIds = (process.env.NEWS_TELEGRAM_CHANNEL_IDS || "").split(",").map(value => value.trim()).filter(Boolean) } = {}) {
  const marketFetcher = fetchMarkets || createMarketFetcher();
  let state = { marketVersion: 2, known: {}, active: {}, missing: {}, historySeeded: {}, candidates: {}, listings: [], news: [], venues: {}, marketUpdatedAt: null, newsUpdatedAt: null };
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (saved && typeof saved === "object") state = { ...state, ...saved, marketVersion: saved.marketVersion || 1 };
  } catch (_) {}
  if (state.marketVersion !== 2) {
    state = { ...state, marketVersion: 2, known: {}, active: {}, missing: {}, historySeeded: {}, candidates: {}, listings: [], venues: {}, marketUpdatedAt: null };
  }
  state.active ||= {};
  state.missing ||= {};
  state.historySeeded ||= {};
  state.candidates ||= {};
  let marketsRunning = false;
  let newsRunning = false;
  let marketTimer = null;
  let newsTimer = null;
  let stream = null;
  let reconnectTimer = null;
  let stopped = false;
  const listeners = new Set();
  const translationQueue = [];
  const queued = new Set();
  let translating = 0;
  let translationPauseUntil = 0;
  let lastConfirmationFetch = 0;
  let leadWorkers = 0;
  const leadQueue = new Map();
  const sourceHealth = {};

  function emit(event) { for (const listener of listeners) { try { listener(event); } catch (_) {} } }

  function drainTranslations() {
    while (translating < 2 && translationQueue.length && now() >= translationPauseUntil) {
      const item = translationQueue.shift();
      if (!state.news.some(current => current.url === item.url && current.title === item.title && isPublished(current))) { queued.delete(item.url); continue; }
      translating++;
      Promise.resolve().then(() => translate(item.title)).then(translated => {
        const current = state.news.find(row => row.url === item.url && row.title === item.title);
        if (current && isPublished(current) && translated && translated.trim() && translated !== item.title) {
          current.titleRu = translated.trim().slice(0, 500);
          persist(); emit({ type: "translation", item: current });
        }
      }).catch(() => { translationPauseUntil = now() + 60000; }).finally(() => {
        translating--; queued.delete(item.url);
        const current = state.news.find(row => row.url === item.url);
        if (current && isPublished(current) && !current.titleRu && current.title !== item.title) {
          queued.add(current.url); translationQueue.unshift(current);
        }
        if (translationQueue.length && now() < translationPauseUntil) {
          const timer = setTimeout(drainTranslations, Math.max(1000, translationPauseUntil - now())); timer.unref?.();
        } else drainTranslations();
      });
    }
  }

  function mergeNews(rows) {
    const byUrl = new Map(state.news.map(item => [item.url, item]));
    let changed = false;
    for (const row of rows) {
      row.url = canonicalUrl(row.url);
      if (!row.url || !row.title || !Number.isFinite(row.publishedAt) || row.publishedAt < now() - 7 * 86400000 || row.publishedAt > now() + 60000) continue;
      const previous = byUrl.get(row.url);
      if (previous && (!row.originVerified || previous.originVerified && previous.title === row.title && previous.context === row.context)) continue;
      if (previous) {
        row.alertedAt = previous.alertedAt;
        row.verification = previous.verification;
        if (previous.title === row.title) row.titleRu = previous.titleRu;
      }
      row.alertKind = alertKind(row.title);
      row.receivedAt ||= now();
      row.priority ||= row.alertKind || URGENT.test(row.title) ? "urgent" : IMPORTANT.test(row.title) ? "important" : "regular";
      byUrl.set(row.url, row); changed = true;
    }
    if (changed) {
      state.news = [...byUrl.values()].filter(item => item.publishedAt > now() - 7 * 86400000)
        .sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 240);
      const notifications = [];
      for (const item of state.news) {
        const wasPublished = isPublished(item);
        item.verification = assessNews(item, state.news);
        if (wasPublished && !isPublished(item)) notifications.push({ type: "retract", item });
        if (!isPublished(item)) continue;
        if (!item.titleRu && !queued.has(item.url) && /[a-z]{3}/i.test(item.title) && !/[а-яё]/i.test(item.title)) {
          queued.add(item.url);
          if (item.alertKind) translationQueue.unshift(item); else translationQueue.push(item);
        }
        if (item.alertKind && !item.alertedAt && now() - item.publishedAt <= 15 * 60000) {
          const alreadyAlerted = state.news.some(other => other.alertedAt && Math.abs(other.publishedAt - item.publishedAt) < 2 * 3600000 && sameClaim(item, other));
          item.alertedAt = now();
          if (!alreadyAlerted) notifications.push({ type: "urgent", item });
        }
      }
      state.newsUpdatedAt = now(); persist(); emit();
      for (const event of notifications) emit(event);
      drainTranslations();
    }
  }

  function ingestLead(item) {
    if (!item) return;
    mergeNews([{ ...item, originVerified: false }]);
    if (publisher(item.url) && !leadQueue.has(item.url) && leadQueue.size < 30) leadQueue.set(item.url, item);
    void drainLeads();
    if (alertKind(item.title) && now() - lastConfirmationFetch >= 10000) {
      lastConfirmationFetch = now(); void refreshNews();
    }
  }

  async function drainLeads() {
    if (leadWorkers >= 3) return;
    while (leadQueue.size) {
      const [url] = leadQueue.keys(); leadQueue.delete(url); leadWorkers++;
      try {
        const article = parseArticle(await fetchFeed(url), url, decodeXml, now());
        if (article) mergeNews([article]);
      } catch (_) { /* Unreadable sources stay pending; never trust the supplied headline. */ }
      finally { leadWorkers--; }
    }
  }

  function connectStream() {
    if (stopped) return;
    try {
      const ws = stream = streamFactory("wss://news.treeofalpha.com/ws");
      ws.on("open", () => { sourceHealth["Tree News"] = { status: "connected", updatedAt: now() }; if (streamKey) ws.send(`login ${streamKey}`); });
      ws.on("message", raw => {
        const item = parseStreamNews(raw, now());
        if (item && item.priority !== "regular") ingestLead(item);
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        if (stream !== ws || stopped) return;
        stream = null;
        sourceHealth["Tree News"] = { status: "reconnecting", updatedAt: now() };
        reconnectTimer = setTimeout(connectStream, 5000 + Math.random() * 5000);
        reconnectTimer.unref?.();
      });
    } catch (_) {
      reconnectTimer = setTimeout(connectStream, 10000); reconnectTimer.unref?.();
    }
  }

  function persist() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, filePath);
  }

  async function refreshMarkets() {
    if (marketsRunning) return;
    marketsRunning = true;
    try {
      const existingById = new Map(state.listings.map(item => [item.id, item]));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(6, VENUES.length) }, async () => {
        while (cursor < VENUES.length) {
          const [code, name, exchangeId] = VENUES[cursor++];
          try {
            let changed = false;
            const rows = normalizeMarkets(await marketFetcher(exchangeId), code, now());
            if (!rows.length) throw new Error("Empty market catalog");
            const prior = Array.isArray(state.known[code]) ? new Set(state.known[code]) : null;
            const spotCount = rows.filter(row => row.type === "spot").length;
            const futuresCount = rows.length - spotCount;
            const priorSpot = prior ? [...prior].filter(key => key.startsWith(`${code}:spot:`)).length : 0;
            const priorFutures = prior ? prior.size - priorSpot : 0;
            const lastSpot = state.venues[code]?.spot ?? priorSpot;
            const lastFutures = state.venues[code]?.futures ?? priorFutures;
            if (prior && ((lastSpot && spotCount < lastSpot * 0.8) ||
              (lastFutures && futuresCount < lastFutures * 0.8))) {
              throw new Error("Incomplete market catalog");
            }
            const known = new Set(prior || []);
            const current = new Map(rows.map(row => [row.key, row]));
            const priorActive = state.active[code];
            const missing = state.missing[code] || {};
            const nextMissing = {};
            if (Array.isArray(priorActive)) {
              for (const key of new Set([...priorActive, ...Object.keys(missing)])) {
                if (current.has(key)) continue;
                const count = (missing[key] || 0) + 1;
                nextMissing[key] = count;
                if (count !== 3 || existingById.has(`scheduled-delist:${key}`)) continue;
                const [, type, ...symbolParts] = key.split(":");
                const event = { id: `delist:${key}`, kind: "delisting", exchange: code, type,
                  symbol: symbolParts.join(":"), launchAt: null, detectedAt: now(), timing: "detected" };
                if (!existingById.has(event.id)) { state.listings.push(event); existingById.set(event.id, event); changed = true; }
              }
            }
            const candidates = state.candidates[code] || {};
            const nextCandidates = {};
            // A new market must survive a second scan; one incomplete catalog is not a listing.
            for (const row of rows) {
              const scheduledId = `scheduled-delist:${row.key}`;
              const scheduled = existingById.get(scheduledId);
              if (row.delistAt && (!scheduled || scheduled.delistAt !== row.delistAt)) {
                const event = { ...row, id: scheduledId, kind: "delisting", detectedAt: now(), timing: "exchange" };
                if (scheduled) Object.assign(scheduled, event);
                else { state.listings.push(event); existingById.set(scheduledId, event); }
                changed = true;
              } else if (!row.delistAt && row.delistScheduleKnown && scheduled?.delistAt > now()) {
                state.listings = state.listings.filter(event => event.id !== scheduledId);
                existingById.delete(scheduledId); changed = true;
              }
              if (existingById.has(`delist:${row.key}`)) {
                state.listings = state.listings.filter(event => event.id !== `delist:${row.key}`);
                existingById.delete(`delist:${row.key}`);
                changed = true;
              }
              if ((state.historySeeded[code] !== 2 && ["BN", "BB", "OX"].includes(code) || row.launchAt > now()) && row.launchAt &&
                row.launchAt >= now() - 30 * 86400000 && row.launchAt <= now() + 30 * 86400000 &&
                !existingById.has(row.key)) {
                const event = { ...row, id: row.key, kind: "listing", historical: true,
                  detectedAt: now(), timing: "exchange" };
                state.listings.push(event); existingById.set(event.id, event); changed = true;
              }
              const recorded = existingById.get(row.key);
              if (recorded && row.launchAt && recorded.launchAt !== row.launchAt) {
                recorded.launchAt = row.launchAt; recorded.timing = "exchange"; changed = true;
              }
              const firstTypeScan = row.type === "spot" ? priorSpot === 0 : priorFutures === 0;
              if (!prior || firstTypeScan) { known.add(row.key); continue; }
              if (prior && !prior.has(row.key) && !candidates[row.key]) {
                nextCandidates[row.key] = now();
              }
              if (prior && !prior.has(row.key) && candidates[row.key]) {
                known.add(row.key);
                const event = { ...row, id: row.key, detectedAt: now(),
                  timing: row.launchAt ? "exchange" : "detected" };
                const existing = existingById.get(event.id);
                if (existing) {
                  if (event.launchAt && existing.launchAt !== event.launchAt) {
                    existing.launchAt = event.launchAt; existing.timing = "exchange"; changed = true;
                  }
                } else { state.listings.push(event); existingById.set(event.id, event); changed = true; }
              }
            }
            state.candidates[code] = nextCandidates;
            state.historySeeded[code] = 2;
            state.missing[code] = nextMissing;
            state.active[code] = [...current.keys()];
            state.known[code] = [...known];
            state.venues[code] = { name, status: "ok", spot: spotCount,
              futures: futuresCount, updatedAt: now() };
            if (changed) { state.marketUpdatedAt = now(); persist(); emit(); }
          } catch (error) {
            // Keep the missing keys so the next healthy scan can restart confirmation.
            state.missing[code] = Object.fromEntries(Object.keys(state.missing[code] || {}).map(key => [key, 0]));
            state.candidates[code] = {};
            state.venues[code] = { ...state.venues[code], name, status: "error",
              error: String(error.message || error).slice(0, 120), updatedAt: state.venues[code]?.updatedAt || null };
          }
        }
      }));
      const eventTime = row => row.kind === "delisting" ? row.delistAt || row.detectedAt : row.launchAt || row.detectedAt;
      state.listings = state.listings.filter(row => eventTime(row) > now() - MAX_EVENT_AGE_MS)
        .sort((a, b) => eventTime(b) - eventTime(a)).slice(0, 3000);
      state.marketUpdatedAt = now();
      persist(); emit();
    } finally { marketsRunning = false; }
  }

  async function refreshNews() {
    if (newsRunning) return;
    newsRunning = true;
    try {
      await Promise.allSettled(FEEDS.map(async ([source, url]) => {
        try {
          const rows = parseNews(await fetchFeed(url), source, now()).filter(item => source !== "White House" || item.priority !== "regular");
          sourceHealth[source] = { status: "ok", checkedAt: now(), latestAt: Math.max(0, ...rows.map(row => row.publishedAt)) || null };
          if (rows.length) mergeNews(rows);
        } catch (_) { sourceHealth[source] = { ...sourceHealth[source], status: "error", checkedAt: now() }; }
      }));
    } finally { newsRunning = false; }
  }

  function snapshot() {
    const news = [];
    for (const item of state.news.filter(isPublished)) {
      if (news.some(other => Math.abs(other.publishedAt - item.publishedAt) <= 2 * 3600000 && sameClaim(item, other))) continue;
      const { context, originVerified, ...publicItem } = item;
      news.push(publicItem);
    }
    return { listings: state.listings, news, venues: state.venues, sources: sourceHealth,
      marketUpdatedAt: state.marketUpdatedAt, newsUpdatedAt: state.newsUpdatedAt,
      sourceNames: ["Tree News", ...FEEDS.map(([name]) => name)] };
  }

  function start() {
    if (marketTimer) return;
    stopped = false;
    for (const item of state.news.slice(0, 30)) {
      if (isPublished(item) && !item.titleRu && item.publishedAt > now() - 86400000 && !queued.has(item.url) &&
        /[a-z]{3}/i.test(item.title) && !/[а-яё]/i.test(item.title)) {
        queued.add(item.url); translationQueue.push(item);
      }
    }
    drainTranslations();
    void Promise.allSettled([refreshMarkets(), refreshNews()]);
    connectStream();
    marketTimer = setInterval(() => { void refreshMarkets(); }, 90 * 1000);
    newsTimer = setInterval(() => { void refreshNews(); }, 20000);
    marketTimer.unref?.(); newsTimer.unref?.();
  }
  function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stream?.close(); stream = null;
    void marketFetcher.close?.();
    if (marketTimer) clearInterval(marketTimer);
    if (newsTimer) clearInterval(newsTimer);
    marketTimer = null; newsTimer = null;
  }
  return { snapshot, refreshMarkets, refreshNews, start, stop, ingestNews: mergeNews,
    ingestTelegram(message) { ingestLead(telegramLead(message, telegramChannelIds, now())); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { VENUES, FEEDS, parseNews, parseStreamNews, translateTitle, launchTime, normalizeMarkets, createMarketFetcher, createEventsHub, alertKind };
