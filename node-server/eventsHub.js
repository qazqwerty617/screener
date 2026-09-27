"use strict";

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { publisher, canonicalUrl, assessNews, sameClaim, isPublished } = require("./newsVerification");
const { createSourceReader, parseArticle, telegramLead } = require("./newsSources");
const { ANNOUNCEMENT_FEEDS, parseAnnouncements, listingAnnouncements } = require("./exchangeAnnouncements");
const { createUnlockService } = require("./unlockService");

const VENUES = Object.freeze([
  ["GT", "Gate.io", "gate"], ["MX", "MEXC", "mexc"],
  ["AD", "Aster", "aster"], ["HL", "Hyperliquid", "hyperliquid"],
  ["BN", "Binance", "binance"], ["BB", "Bybit", "bybit"],
  ["OX", "OKX", "okx"], ["BG", "Bitget", "bitget"],
  ["KC", "KuCoin", "kucoin"], ["BX", "BingX", "bingx"],
  ["HT", "HTX", "htx"]
]);
const PRIORITY_VENUES = Object.freeze(["GT", "MX", "AD", "HL"]);
const FEEDS = Object.freeze([
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss"],
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["The Block", "https://www.theblock.co/rss.xml"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["DL News", "https://www.dlnews.com/arc/outboundfeeds/rss/"],
  ["Blockworks", "https://blockworks.com/feed"],
  ["Federal Reserve", "https://www.federalreserve.gov/feeds/press_monetary.xml"],
  ["White House", "https://www.whitehouse.gov/presidential-actions/feed/"]
]);
const GATE_ANNOUNCEMENTS_URL = "https://api.gateio.ws/api/v4/ann/list_article";
const URGENT = /\b(hack(?:ed)?|exploit|breach|stolen|drain(?:ed)?|attack|liquidat(?:ed|ion)|insolvenc[ey]|bankrupt|emergency|security incident|outage|trump|tariffs?|fed(?:eral)? reserve|rate (?:cut|hike)|sanctions?)\b/i;
const IMPORTANT = /\b(SEC|ETF|fed(?:eral)? reserve|interest rate|regulat(?:ion|or)|lawsuit|listing|delisting|approval|hack|exploit|breach|bitcoin|ethereum)\b/i;
function alertKind(title) {
  if (/\bHack VC\b/i.test(title) && !/\b(exploit|breach|stolen|hacked)\b/i.test(title)) return null;
  if (/\b(FOMC statement|Federal Reserve (?:issues|lowers|raises))\b/i.test(title)) return "macro";
  if (/\b(hack(?:ed|ers?)?|exploit(?:ed)?|security (?:breach|incident)|(?:crypto |exchange )?heist|funds? (?:stolen|drained)|wallets? drained|cyberattack)\b/i.test(title)) return "security";
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

function relevantNews(title, context = "") {
  return !/\b(AI|ChatGPT|OpenAI|Google|iPhone|Hollywood|movie|Hack VC)\b/i.test(title) ||
    /\b(crypto|bitcoin|ethereum|blockchain|tokens?|stablecoins?|wallets?|DeFi|NFTs?|BTC|ETH|XRP|Solana|exchange)\b/i.test(`${title} ${context}`);
}

function parseNews(xml, source, now = Date.now()) {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(String(xml))) throw new Error("Invalid news feed");
  const rows = [];
  for (const match of String(xml).matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)) {
    const title = rssField(match[1], "title").slice(0, 250);
    const atomLink = [...match[1].matchAll(/<link\b[^>]*>/gi)].find(([tag]) => !/rel=["'](?:self|enclosure)["']/i.test(tag));
    const link = rssField(match[1], "link") || decodeXml(/href=["']([^"']+)["']/i.exec(atomLink?.[0] || "")?.[1]);
    const publishedAt = Date.parse(rssField(match[1], "pubDate") || rssField(match[1], "published") || rssField(match[1], "updated"));
    if (!title || !Number.isFinite(publishedAt) || publishedAt > now + 3600000 || now - publishedAt > 7 * 86400000) continue;
    let url;
    try { url = new URL(link); } catch (_) { continue; }
    if (url.protocol !== "https:") continue;
    const context = (rssField(match[1], "description") || rssField(match[1], "summary")).slice(0, 1200);
    // Broad publishers also cover unrelated AI/entertainment; keep their crypto
    // coverage without turning the screener into a general technology feed.
    if (!relevantNews(title, context)) continue;
    rows.push({ id: `${source}:${url.pathname}`, title, url: canonicalUrl(url.href), source,
      context, originVerified: publisher(url.href)?.[2] === source,
      publishedAt, priority: alertKind(title) || URGENT.test(title) ? "urgent" : IMPORTANT.test(title) ? "important" : "regular" });
  }
  return rows;
}

function parseGateAnnouncements(payload, now = Date.now()) {
  const english = payload?.english || payload;
  if (english?.code !== 0 || !Array.isArray(english.data?.list)) throw new Error("Gate announcements unavailable");
  const russianById = new Map((payload?.russian?.code === 0 ? payload.russian.data?.list || [] : [])
    .filter(article => /[а-яё]/i.test(String(article.title || "")))
    .map(article => [String(article.id), String(article.title).trim().slice(0, 500)]));
  return english.data.list.flatMap(article => {
    const title = String(article.title || "").trim().slice(0, 250);
    const publishedAt = Number(article.release_timestamp) * 1000;
    let url;
    try { url = new URL(article.url, "https://www.gate.com").href; } catch (_) { return []; }
    if (!title || !publisher(url) || !Number.isFinite(publishedAt) ||
      publishedAt > now + 60000 || now - publishedAt > 7 * 86400000 ||
      !(alertKind(title) || IMPORTANT.test(title) || /\b(list|launch|delist|suspend|outage|maintenance)\b/i.test(title))) return [];
    return [{ id: `gate:${article.id}`, title, titleRu: russianById.get(String(article.id)), url, source: "Gate.io", publishedAt,
      originVerified: true, priority: alertKind(title) ? "urgent" : "important" }];
  }).sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 30);
}

async function readGateAnnouncements() {
  const read = async lang => {
    const response = await fetch(GATE_ANNOUNCEMENTS_URL, { method: "POST", signal: AbortSignal.timeout(7000),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ page: "1", size: "50", lang }) });
    if (!response.ok) throw new Error(`Gate announcements HTTP ${response.status}`);
    return response.json();
  };
  const [english, russian] = await Promise.all([read("en"), read("ru").catch(() => null)]);
  return { english, russian };
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

async function translateTitle(title, key = process.env.DEEPL_API_KEY || "", request = fetch) {
  const deepl = key.trim();
  const endpoint = deepl.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
  if (deepl) {
    const response = await request(endpoint, { method: "POST", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `DeepL-Auth-Key ${deepl}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: [title], target_lang: "RU" }) });
    if (!response.ok) throw new Error(`DeepL HTTP ${response.status}`);
    return (await response.json()).translations?.[0]?.text || null;
  }
  const params = new URLSearchParams({ q: title.slice(0, 350), langpair: "en|ru" });
  if (process.env.MYMEMORY_CONTACT_EMAIL) params.set("de", process.env.MYMEMORY_CONTACT_EMAIL);
  const response = await request(`https://api.mymemory.translated.net/get?${params}`,
    { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    const error = new Error(`MyMemory HTTP ${response.status}`);
    if (response.status === 429) error.retryAfterMs = 3600000;
    throw error;
  }
  const result = await response.json();
  if (result.quotaFinished || /quota|free translations for today/i.test(String(result.responseData?.translatedText || result.responseDetails || ""))) {
    const error = new Error("MyMemory daily quota exhausted");
    error.retryAfterMs = 24 * 3600000;
    throw error;
  }
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
  fetchMarkets = null, fetchFeed = createSourceReader(), fetchGateAnnouncements = readGateAnnouncements,
  now = () => Date.now(), translate = translateTitle, unlockService = createUnlockService(),
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
  // Reassess persisted records with the current classifier; an old "reported"
  // label must not let a newly recognized security incident bypass verification.
  state.news = (Array.isArray(state.news) ? state.news : []).filter(item => item?.title && item.url &&
    Number.isFinite(item.publishedAt) && item.publishedAt > now() - 7 * 86400000 && item.publishedAt <= now() + 60000 && relevantNews(item.title, item.context))
    .slice(0, 320).map(item => ({ ...item, alertKind: alertKind(item.title) }));
  for (const item of state.news) item.verification = assessNews(item, state.news);
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
  const translationRetryAt = new Map();
  let translating = 0;
  let translationPauseUntil = 0;
  let translationLastError = null;
  let lastConfirmationFetch = 0;
  let leadWorkers = 0;
  const leadQueue = new Map();
  const sourceHealth = {};
  let publicCache = null, publicCacheAt = 0;
  let persistTimer = null, persistRunning = null, persistDirty = false;
  let translationTimer = null;

  function emit(event) { publicCache = null; for (const listener of listeners) { try { listener(event); } catch (_) {} } }
  const isDeveloping = item => Boolean(item && item.alertKind && item.originVerified &&
    item.verification?.status === "pending" && item.verification?.sources?.length);
  const isTranslatable = item => Boolean(item && (isPublished(item) || isDeveloping(item)));
  function prioritizeTranslations() {
    const rank = item => item.alertKind ? 2 : item.priority === "urgent" ? 1 : 0;
    translationQueue.sort((a, b) => rank(b) - rank(a) || b.publishedAt - a.publishedAt);
  }
  function queueTranslation(item) {
    if (item.titleRu || queued.has(item.url) || (translationRetryAt.get(item.url) || 0) > now() ||
      !/[a-z]{3}/i.test(item.title) || /[а-яё]/i.test(item.title)) return;
    queued.add(item.url);
    translationQueue.push(item);
    prioritizeTranslations();
    drainTranslations();
  }

  function drainTranslations() {
    while (!stopped && translating < 2 && translationQueue.length && now() >= translationPauseUntil) {
      const item = translationQueue.shift();
      if (!state.news.some(current => current.url === item.url && current.title === item.title && isTranslatable(current))) { queued.delete(item.url); continue; }
      translating++;
      Promise.resolve().then(() => translate(item.title)).then(translated => {
        const current = state.news.find(row => row.url === item.url && row.title === item.title);
        if (!stopped && current && isTranslatable(current) && translated && /[а-яё]/i.test(translated) && translated !== item.title) {
          current.titleRu = translated.trim().slice(0, 500);
          translationRetryAt.delete(item.url);
          translationLastError = null;
          persist(); emit({ type: "translation", item: current });
        } else if (current && isTranslatable(current)) {
          translationRetryAt.set(item.url, now() + 60000);
        }
      }).catch(error => {
        translationRetryAt.set(item.url, now() + 60000);
        translationPauseUntil = Math.max(translationPauseUntil, now() + (error.retryAfterMs || 60000));
        translationLastError = { message: error.message, at: now() };
      }).finally(() => {
        translating--; queued.delete(item.url);
        const current = state.news.find(row => row.url === item.url);
        if (current && isTranslatable(current) && !current.titleRu && current.title !== item.title) {
          queued.add(current.url); translationQueue.push(current); prioritizeTranslations();
        }
        if (!stopped && translationQueue.length && now() < translationPauseUntil) {
          if (!translationTimer) {
            translationTimer = setTimeout(() => { translationTimer = null; drainTranslations(); }, Math.max(1000, translationPauseUntil - now()));
            translationTimer.unref?.();
          }
        } else drainTranslations();
      });
    }
  }

  function mergeNews(rows) {
    const byUrl = new Map(state.news.map(item => [item.url, item]));
    let changed = false;
    for (const row of rows) {
      row.url = canonicalUrl(row.url);
      if (!row.url || !row.title || !relevantNews(row.title, row.context) || !Number.isFinite(row.publishedAt) || row.publishedAt < now() - 7 * 86400000 || row.publishedAt > now() + 60000) continue;
      const previous = byUrl.get(row.url);
      if (previous && (!row.originVerified || previous.originVerified && previous.title === row.title && previous.context === row.context)) {
        if (row.titleRu && /[а-яё]/i.test(row.titleRu) && row.titleRu !== previous.titleRu && row.title === previous.title) {
          previous.titleRu = row.titleRu;
          persist(); emit({ type: "translation", item: previous });
        }
        if (isTranslatable(previous)) queueTranslation(previous);
        continue;
      }
      if (previous) {
        row.alertedAt = previous.alertedAt;
        row.verification = previous.verification;
        if (previous.title === row.title) row.titleRu = previous.titleRu;
        else translationRetryAt.delete(row.url);
      }
      row.alertKind = alertKind(row.title);
      row.receivedAt ||= now();
      row.priority ||= row.alertKind || URGENT.test(row.title) ? "urgent" : IMPORTANT.test(row.title) ? "important" : "regular";
      byUrl.set(row.url, row); changed = true;
    }
    if (changed) {
      const ordered = [...byUrl.values()].filter(item => item.publishedAt > now() - 7 * 86400000)
        .sort((a, b) => b.publishedAt - a.publishedAt);
      const sourced = ordered.filter(item => item.originVerified && publisher(item.url)).slice(0, 240);
      const leads = ordered.filter(item => !item.originVerified || !publisher(item.url)).slice(0, 80);
      state.news = [...sourced, ...leads].sort((a, b) => b.publishedAt - a.publishedAt);
      const retainedUrls = new Set(state.news.map(item => item.url));
      for (const url of translationRetryAt.keys()) if (!retainedUrls.has(url)) translationRetryAt.delete(url);
      const notifications = [];
      for (const item of state.news) {
        const wasPublished = isPublished(item);
        item.verification = assessNews(item, state.news);
        if (wasPublished && !isPublished(item)) notifications.push({ type: "retract", item });
        if (isTranslatable(item)) queueTranslation(item);
        if (!isPublished(item)) continue;
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
    while (!stopped && leadQueue.size) {
      const [url] = leadQueue.keys(); leadQueue.delete(url); leadWorkers++;
      try {
        const article = parseArticle(await fetchFeed(url), url, decodeXml, now());
        if (!stopped && article) mergeNews([article]);
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
    if (stopped) return;
    persistDirty = true;
    if (persistTimer || persistRunning) return;
    persistTimer = setTimeout(() => { persistTimer = null; void flush(); }, 250);
    persistTimer.unref?.();
  }

  async function flush() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    if (persistRunning) { await persistRunning; if (persistDirty) return flush(); return; }
    if (!persistDirty) return;
    persistDirty = false;
    const content = JSON.stringify(state);
    persistRunning = (async () => {
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(`${filePath}.tmp`, content);
        await fs.promises.rename(`${filePath}.tmp`, filePath);
      } catch (_) {
        sourceHealth.storage = { status: "error", checkedAt: now() };
      }
    })().finally(() => { persistRunning = null; });
    await persistRunning;
    if (persistDirty) return flush();
  }

  async function refreshMarkets(selectedCodes = null) {
    if (marketsRunning || stopped) return;
    marketsRunning = true;
    try {
      const venues = selectedCodes ? VENUES.filter(([code]) => selectedCodes.includes(code)) : VENUES;
      const existingById = new Map(state.listings.map(item => [item.id, item]));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(6, venues.length) }, async () => {
        while (!stopped && cursor < venues.length) {
          const [code, name, exchangeId] = venues[cursor++];
          try {
            let changed = false;
            const rows = normalizeMarkets(await marketFetcher(exchangeId), code, now());
            if (stopped) return;
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
      if (stopped) return;
      const eventTime = row => row.kind === "delisting" ? row.delistAt || row.detectedAt : row.launchAt || row.detectedAt;
      state.listings = state.listings.filter(row => eventTime(row) > now() - MAX_EVENT_AGE_MS)
        .sort((a, b) => eventTime(b) - eventTime(a)).slice(0, 3000);
      state.marketUpdatedAt = now();
      persist(); emit();
    } finally { marketsRunning = false; }
  }

  async function refreshNews() {
    if (newsRunning || stopped) return;
    newsRunning = true;
    try {
      await Promise.allSettled([unlockService.refresh(), ...FEEDS.map(async ([source, url]) => {
        try {
          const rows = parseNews(await fetchFeed(url), source, now()).filter(item => source !== "White House" || item.priority !== "regular");
          sourceHealth[source] = { status: rows.length ? "ok" : "no_recent_items", checkedAt: now(), latestAt: Math.max(0, ...rows.map(row => row.publishedAt)) || null };
          if (!stopped && rows.length) mergeNews(rows);
        } catch (_) { sourceHealth[source] = { ...sourceHealth[source], status: "error", checkedAt: now() }; }
      }), ...ANNOUNCEMENT_FEEDS.map(async ([source, url]) => {
        const healthKey = `${source} · ${new URL(url).searchParams.get("catalogId") || new URL(url).searchParams.get("annType") || new URL(url).searchParams.get("type")}`;
        try {
          const rows = parseAnnouncements(JSON.parse(await fetchFeed(url)), source, now());
          sourceHealth[healthKey] = { status: "ok", checkedAt: now(), latestAt: Math.max(0, ...rows.map(row => row.publishedAt)) || null };
          if (!stopped && rows.length) mergeNews(rows);
        } catch (_) { sourceHealth[healthKey] = { ...sourceHealth[healthKey], status: "error", checkedAt: now() }; }
      }), (async () => {
        try {
          const rows = parseGateAnnouncements(await fetchGateAnnouncements(), now());
          sourceHealth["Gate.io"] = { status: "ok", checkedAt: now(), latestAt: rows[0]?.publishedAt || null };
          if (!stopped && rows.length) mergeNews(rows);
        } catch (_) { sourceHealth["Gate.io"] = { ...sourceHealth["Gate.io"], status: "error", checkedAt: now() }; }
      })()]);
    } finally { newsRunning = false; publicCache = null; }
  }

  function snapshot() {
    if (publicCache && now() - publicCacheAt < 1000) return publicCache;
    const news = [];
    for (const item of state.news.filter(item => isPublished(item) && item.publishedAt > now() - 7 * 86400000)) {
      if (news.some(other => Math.abs(other.publishedAt - item.publishedAt) <= 2 * 3600000 && sameClaim(item, other))) continue;
      const { context, originVerified, ...publicItem } = item;
      news.push(publicItem);
    }
    // Sourced security leads remain visible for investigation without being
    // promoted to confirmed facts or generating urgent push notifications.
    const developing = state.news.filter(item => item.alertKind && item.originVerified &&
      item.verification?.status === "pending" && item.verification.sources.length && item.publishedAt > now() - 7 * 86400000)
      .slice(0, 30).map(({ context, originVerified, ...item }) => item);
    publicCacheAt = now();
    return publicCache = { listings: state.listings, announcements: listingAnnouncements(state.news), unlocks: unlockService.snapshot(), news, developing, venues: state.venues, sources: sourceHealth,
      translation: { provider: process.env.DEEPL_API_KEY ? "DeepL" : "MyMemory", pending: translationQueue.length + translating,
        untranslated: [...news, ...developing].filter(item => !item.titleRu && /[a-z]{3}/i.test(item.title) && !/[а-яё]/i.test(item.title)).length,
        pausedUntil: translationPauseUntil || null, lastError: translationLastError },
      marketUpdatedAt: state.marketUpdatedAt, newsUpdatedAt: state.newsUpdatedAt,
      sourceNames: ["Tree News", "Gate.io", "Binance", "Bybit", "Bitget", ...FEEDS.map(([name]) => name)] };
  }

  function start() {
    if (marketTimer) return;
    stopped = false;
    for (const item of state.news) if (isTranslatable(item)) queueTranslation(item);
    drainTranslations();
    void Promise.allSettled([refreshMarkets(), refreshNews()]);
    connectStream();
    let marketCycle = 0;
    marketTimer = setInterval(() => {
      marketCycle++;
      void refreshMarkets(marketCycle % 3 === 0 ? null : PRIORITY_VENUES);
    }, 30 * 1000);
    newsTimer = setInterval(() => { void refreshNews(); }, 20000);
    marketTimer.unref?.(); newsTimer.unref?.();
  }
  function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (translationTimer) clearTimeout(translationTimer);
    if (persistTimer) clearTimeout(persistTimer);
    translationTimer = null; persistTimer = null;
    translationQueue.length = 0; leadQueue.clear(); queued.clear();
    stream?.close(); stream = null;
    void marketFetcher.close?.();
    if (marketTimer) clearInterval(marketTimer);
    if (newsTimer) clearInterval(newsTimer);
    marketTimer = null; newsTimer = null;
  }
  return { snapshot, refreshMarkets, refreshNews, start, stop, flush, ingestNews: mergeNews,
    ingestTelegram(message) { ingestLead(telegramLead(message, telegramChannelIds, now())); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { VENUES, FEEDS, parseNews, parseGateAnnouncements, parseStreamNews, translateTitle, launchTime, normalizeMarkets, createMarketFetcher, createEventsHub, alertKind };
