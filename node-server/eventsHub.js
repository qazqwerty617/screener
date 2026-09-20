"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
const URGENT = /\b(hack(?:ed)?|exploit|breach|stolen|drain(?:ed)?|attack|liquidat(?:ed|ion)|insolvenc[ey]|bankrupt|emergency|security incident|outage)\b/i;
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
  }, now = () => Date.now() } = {}) {
  let state = { known: {}, listings: [], news: [], venues: {}, marketUpdatedAt: null, newsUpdatedAt: null };
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (saved && typeof saved === "object") state = { ...state, ...saved };
  } catch (_) {}
  let marketsRunning = false;
  let newsRunning = false;
  let marketTimer = null;
  let newsTimer = null;

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
      if (rows.length) {
        const seen = new Set();
        state.news = rows.sort((a, b) => b.publishedAt - a.publishedAt).filter(row => {
          if (seen.has(row.url)) return false;
          seen.add(row.url); return true;
        }).slice(0, 120);
        state.newsUpdatedAt = now();
        persist();
      }
    } finally { newsRunning = false; }
  }

  function snapshot() {
    return { listings: state.listings, news: state.news, venues: state.venues,
      marketUpdatedAt: state.marketUpdatedAt, newsUpdatedAt: state.newsUpdatedAt,
      sourceNames: FEEDS.map(([name]) => name) };
  }

  function start() {
    if (marketTimer) return;
    void Promise.allSettled([refreshMarkets(), refreshNews()]);
    marketTimer = setInterval(() => { void refreshMarkets(); }, 15 * 60000);
    newsTimer = setInterval(() => { void refreshNews(); }, 5 * 60000);
    marketTimer.unref?.(); newsTimer.unref?.();
  }
  function stop() {
    if (marketTimer) clearInterval(marketTimer);
    if (newsTimer) clearInterval(newsTimer);
    marketTimer = null; newsTimer = null;
  }
  return { snapshot, refreshMarkets, refreshNews, start, stop };
}

module.exports = { VENUES, FEEDS, parseNews, launchTime, normalizeMarkets, createEventsHub };
