"use strict";

const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");

const VENUES = Object.freeze([
  ["BN", "Binance", "binance"], ["BB", "Bybit", "bybit"],
  ["OX", "OKX", "okx"], ["BG", "Bitget", "bitget"],
  ["GT", "Gate.io", "gate"], ["MX", "MEXC", "mexc"],
  ["KC", "KuCoin", "kucoin"], ["BX", "BingX", "bingx"],
  ["HT", "HTX", "htx"], ["HL", "Hyperliquid", "hyperliquid"],
  ["AD", "Aster", "aster"]
]);
const FEEDS = Object.freeze([
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["The Block", "https://www.theblock.co/rss.xml"]
]);
const URGENT = /\b(hack(?:ed)?|exploit|breach|stolen|drain(?:ed)?|attack|liquidat(?:ed|ion)|insolvenc[ey]|bankrupt|emergency|security incident|outage|trump|tariffs?|fed(?:eral)? reserve|rate (?:cut|hike)|sanctions?)\b/i;
const IMPORTANT = /\b(SEC|ETF|fed(?:eral)? reserve|interest rate|regulat(?:ion|or)|lawsuit|listing|delisting|approval|hack|exploit|breach|bitcoin|ethereum)\b/i;
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
    rows.push({ id: `${source}:${url.pathname}`, title, url: url.href, source,
      publishedAt, priority: URGENT.test(title) ? "urgent" : IMPORTANT.test(title) ? "important" : "regular" });
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
    priority: URGENT.test(title) ? "urgent" : IMPORTANT.test(title) ? "important" : "regular" };
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

function launchTime(info, now = Date.now()) {
  const keys = ["listingTime", "onboardDate", "launchTime", "launchDate", "openTime", "listTime"];
  for (const key of keys) {
    const raw = info?.[key];
    if (raw == null || raw === "") continue;
    const n = Number(raw);
    const time = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(String(raw));
    if (Number.isFinite(time) && time > now - MAX_EVENT_AGE_MS && time < now + 60 * 86400000) return time;
  }
  return null;
}

function normalizeMarkets(markets, venue, now = Date.now()) {
  const rows = new Map();
  for (const market of Object.values(markets || {})) {
    if (!market || !(market.spot || market.swap || market.future) || !market.symbol || !market.base) continue;
    const type = market.spot ? "spot" : "futures";
    const symbol = String(market.symbol).slice(0, 80);
    const key = `${venue}:${type}:${symbol}`;
    rows.set(key, { key, exchange: venue, type, symbol,
      base: String(market.base).slice(0, 40), launchAt: launchTime(market.info, now) });
  }
  return [...rows.values()];
}

function createEventsHub({ filePath = path.join(__dirname, "events_hub.json"),
  fetchMarkets = async exchangeId => {
    const ccxt = require("ccxt");
    const client = new ccxt[exchangeId]({ enableRateLimit: true, timeout: 12000 });
    try { return await client.loadMarkets(); } finally { await client.close?.(); }
  }, fetchFeed = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "ObsidianScreener/1.0" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (length > 2_000_000) throw new Error("Feed too large");
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error("Feed too large");
    return body;
  }, now = () => Date.now(), translate = translateTitle,
  streamFactory = url => new WebSocket(url, { perMessageDeflate: false }),
  streamKey = process.env.TREE_NEWS_API_KEY || "" } = {}) {
  let state = { known: {}, listings: [], news: [], venues: {}, marketUpdatedAt: null, newsUpdatedAt: null };
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (saved && typeof saved === "object") state = { ...state, ...saved };
  } catch (_) {}
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

  function emit() { for (const listener of listeners) { try { listener(); } catch (_) {} } }

  function drainTranslations() {
    while (translating < 2 && translationQueue.length && now() >= translationPauseUntil) {
      const item = translationQueue.shift();
      translating++;
      Promise.resolve().then(() => translate(item.title)).then(translated => {
        if (translated && translated.trim() && translated !== item.title) {
          item.titleRu = translated.trim().slice(0, 500);
          persist(); emit();
        }
      }).catch(() => { translationPauseUntil = now() + 60000; }).finally(() => {
        translating--; queued.delete(item.url);
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
      if (byUrl.has(row.url)) continue;
      byUrl.set(row.url, row); changed = true;
      if (!queued.has(row.url) && /[a-z]{3}/i.test(row.title) && !/[а-яё]/i.test(row.title)) {
        queued.add(row.url);
        if (row.priority === "urgent") translationQueue.unshift(row);
        else translationQueue.push(row);
      }
    }
    if (changed) {
      state.news = [...byUrl.values()].filter(item => item.publishedAt > now() - 7 * 86400000)
        .sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 120);
      state.newsUpdatedAt = now(); persist(); emit(); drainTranslations();
    }
  }

  function connectStream() {
    if (stopped) return;
    try {
      const ws = stream = streamFactory("wss://news.treeofalpha.com/ws");
      ws.on("open", () => { if (streamKey) ws.send(`login ${streamKey}`); });
      ws.on("message", raw => {
        const item = parseStreamNews(raw, now());
        if (item && item.priority !== "regular") mergeNews([item]);
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        if (stream !== ws || stopped) return;
        stream = null;
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
      for (let i = 0; i < VENUES.length; i += 2) {
        await Promise.all(VENUES.slice(i, i + 2).map(async ([code, name, exchangeId]) => {
          try {
            const rows = normalizeMarkets(await fetchMarkets(exchangeId), code, now());
            if (!rows.length) throw new Error("Empty market catalog");
            const prior = Array.isArray(state.known[code]) ? new Set(state.known[code]) : null;
            if (prior && prior.size > 100 && rows.length < prior.size * 0.8) {
              throw new Error("Incomplete market catalog");
            }
            const known = new Set(rows.map(row => row.key));
            // Initial discovery is a baseline, never an invented listing event.
            for (const row of rows) {
              const scheduled = row.launchAt && row.launchAt >= now() - 7 * 86400000;
              if ((prior && !prior.has(row.key)) || scheduled) {
                const event = { ...row, id: row.key, detectedAt: now(),
                  timing: row.launchAt ? "exchange" : "detected" };
                const existing = existingById.get(event.id);
                if (existing) {
                  if (event.launchAt) { existing.launchAt = event.launchAt; existing.timing = "exchange"; }
                } else { state.listings.push(event); existingById.set(event.id, event); }
              }
            }
            state.known[code] = [...known];
            state.venues[code] = { name, status: "ok", spot: rows.filter(row => row.type === "spot").length,
              futures: rows.filter(row => row.type === "futures").length, updatedAt: now() };
          } catch (error) {
            state.venues[code] = { ...state.venues[code], name, status: "error",
              error: String(error.message || error).slice(0, 120), updatedAt: state.venues[code]?.updatedAt || null };
          }
        }));
      }
      state.listings = state.listings.filter(row => (row.launchAt || row.detectedAt) > now() - MAX_EVENT_AGE_MS)
        .sort((a, b) => (b.launchAt || b.detectedAt) - (a.launchAt || a.detectedAt)).slice(0, 3000);
      state.marketUpdatedAt = now();
      persist();
    } finally { marketsRunning = false; }
  }

  async function refreshNews() {
    if (newsRunning) return;
    newsRunning = true;
    try {
      const responses = await Promise.allSettled(FEEDS.map(async ([source, url]) => parseNews(await fetchFeed(url), source, now())));
      const rows = responses.filter(result => result.status === "fulfilled").flatMap(result => result.value);
      if (rows.length) mergeNews(rows);
    } finally { newsRunning = false; }
  }

  function snapshot() {
    return { listings: state.listings, news: state.news, venues: state.venues,
      marketUpdatedAt: state.marketUpdatedAt, newsUpdatedAt: state.newsUpdatedAt,
      sourceNames: ["Tree News", ...FEEDS.map(([name]) => name)] };
  }

  function start() {
    if (marketTimer) return;
    stopped = false;
    for (const item of state.news.slice(0, 30)) {
      if (!item.titleRu && item.publishedAt > now() - 86400000 && !queued.has(item.url) &&
        /[a-z]{3}/i.test(item.title) && !/[а-яё]/i.test(item.title)) {
        queued.add(item.url); translationQueue.push(item);
      }
    }
    drainTranslations();
    void Promise.allSettled([refreshMarkets(), refreshNews()]);
    connectStream();
    marketTimer = setInterval(() => { void refreshMarkets(); }, 15 * 60000);
    newsTimer = setInterval(() => { void refreshNews(); }, 60000);
    marketTimer.unref?.(); newsTimer.unref?.();
  }
  function stop() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stream?.close(); stream = null;
    if (marketTimer) clearInterval(marketTimer);
    if (newsTimer) clearInterval(newsTimer);
    marketTimer = null; newsTimer = null;
  }
  return { snapshot, refreshMarkets, refreshNews, start, stop, ingestNews: mergeNews,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { VENUES, FEEDS, parseNews, parseStreamNews, translateTitle, launchTime, normalizeMarkets, createEventsHub };
